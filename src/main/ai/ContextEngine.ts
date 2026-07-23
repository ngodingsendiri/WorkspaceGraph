import type { SearchEngine } from '../engine/SearchEngine'
import type { WorkspaceEngine } from '../engine/WorkspaceEngine'
import { graphEngine } from '../engine/GraphEngine'
import { isKerjaVault, KERJA_CONTEXT_PRIORITY, KERJA_REL } from '../config/KerjaPaths'
import path from 'path'
import fs from 'fs'

export type AgentRole = 'general' | 'writer' | 'researcher' | 'curator' | 'planner'

export interface AgentInfo {
  id: AgentRole
  name: string
  icon: string
  systemInstruction: string
}

export const AGENT_ROLES: Record<AgentRole, AgentInfo> = {
  general: {
    id: 'general',
    name: 'General Assistant',
    icon: '🤖',
    systemInstruction:
      'You are a general AI Worker inside WorkspaceGraph. Help the user manage knowledge, answer questions, and organize workspace notes accurately.'
  },
  writer: {
    id: 'writer',
    name: 'Writing Agent',
    icon: '✍️',
    systemInstruction:
      'You are a specialized Writing Agent. Focus on drafting clear, well-structured Markdown documents, refining prose, adjusting tone, and expanding note outlines.'
  },
  researcher: {
    id: 'researcher',
    name: 'Research Agent',
    icon: '🔍',
    systemInstruction:
      'You are a specialized Research Agent. Synthesize information across workspace notes, identify key themes, create summaries, and highlight evidence.'
  },
  curator: {
    id: 'curator',
    name: 'Knowledge Curator',
    icon: '🔗',
    systemInstruction:
      'You are a specialized Knowledge Curator. Identify relationships between documents, suggest new [[WikiLinks]], detect missing connections, and structure knowledge graphs.'
  },
  planner: {
    id: 'planner',
    name: 'Task Planner',
    icon: '📋',
    systemInstruction:
      'You are a specialized Task Planner. Break down goals into actionable task checklists (- [ ]), define priorities, deadlines, and project milestones.'
  }
}

export interface ContextPackage {
  query: string
  activeFile?: { path: string; title: string; content: string }
  graphNeighbors?: { title: string; path: string; type: string }[]
  backlinks?: { title: string; path: string }[]
  relevantFiles: { title: string; path: string; snippet: string; tier: string }[]
  citations: { title: string; path: string }[]
  systemRules: string[]
  formattedContext: string
  tokenEstimate: number
}

/** ~4 chars ≈ 1 token (rough) */
function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4)
}

/** Keep modest for free-tier Gemini quotas (context burns input tokens fast) */
const DEFAULT_TOKEN_BUDGET = 2800

export class ContextEngine {
  constructor(
    private workspaceEngine: WorkspaceEngine,
    private searchEngine: SearchEngine
  ) {}

  buildContextPackage(
    query: string,
    activeFilePath?: string,
    agentRole: AgentRole = 'general',
    tokenBudget = DEFAULT_TOKEN_BUDGET
  ): ContextPackage {
    const relevantFiles: ContextPackage['relevantFiles'] = []
    const citations: { title: string; path: string }[] = []
    const seenPaths = new Set<string>()
    let activeFile: ContextPackage['activeFile']
    let graphNeighbors: ContextPackage['graphNeighbors'] = []
    let backlinks: ContextPackage['backlinks'] = []
    let usedTokens = 0

    const addCitation = (title: string, p: string) => {
      if (!citations.some((c) => c.path === p)) citations.push({ title, path: p })
    }

    const tryAddSnippet = (
      title: string,
      filePath: string,
      tier: string,
      maxChars: number,
      minPriority: number
    ): boolean => {
      const norm = filePath.replace(/\\/g, '/')
      if (seenPaths.has(norm)) return false
      if (activeFilePath && norm === activeFilePath.replace(/\\/g, '/')) return false

      const remaining = tokenBudget - usedTokens
      if (remaining < 80) return false

      try {
        const content = this.workspaceEngine.readFile(filePath)
        const cap = Math.min(maxChars, remaining * 4)
        const snippet = content.slice(0, cap).trim()
        const cost = estimateTokens(snippet) + 20
        if (cost > remaining && minPriority > 0) return false

        seenPaths.add(norm)
        relevantFiles.push({ title, path: filePath, snippet, tier })
        addCitation(title, filePath)
        usedTokens += Math.min(cost, remaining)
        return true
      } catch {
        return false
      }
    }

    // ——— 1. Active document (highest priority) ———
    if (activeFilePath) {
      try {
        const content = this.workspaceEngine.readFile(activeFilePath)
        const title = activeFilePath.split(/[/\\]/).pop()?.replace(/\.md$/i, '') || 'Untitled'
        const activeCap = Math.min(1800, Math.floor(tokenBudget * 0.35) * 4)
        activeFile = {
          path: activeFilePath,
          title,
          content: content.slice(0, activeCap)
        }
        usedTokens += estimateTokens(activeFile.content) + 40
        addCitation(title, activeFilePath)
        seenPaths.add(activeFilePath.replace(/\\/g, '/'))

        const activeNode = graphEngine.getNodeByPath(activeFilePath)
        if (activeNode) {
          // ——— 2. Outgoing wikilinks / graph neighbors ———
          const neighbors = graphEngine.getNeighbors(activeNode.id, 1)
          graphNeighbors = neighbors.nodes
            .filter((n) => n.id !== activeNode.id)
            .map((n) => ({ title: n.title, path: n.path, type: n.type }))

          for (const n of graphNeighbors.slice(0, 5)) {
            tryAddSnippet(n.title, n.path, 'wikilink', 600, 1)
          }

          // ——— 3. Backlinks ———
          const bl = graphEngine.getBacklinks(activeNode.id)
          backlinks = bl.nodes.map((n) => ({ title: n.title, path: n.path }))
          for (const n of bl.nodes.slice(0, 4)) {
            tryAddSnippet(n.title, n.path, 'backlink', 500, 1)
          }
        }
      } catch {
        /* skip */
      }
    }

    // ——— 4. Kerja vault essentials + Rules/SOP (Law 005) ———
    const qLower = (query || '').toLowerCase()
    const roleWantsRules =
      agentRole === 'writer' ||
      agentRole === 'researcher' ||
      agentRole === 'curator' ||
      agentRole === 'planner' ||
      /sop|aturan|rules|template|prosedur|format|surat|cuti|kgb|pegawai/i.test(qLower)

    const rootEarly = this.workspaceEngine.getState().rootPath
    if (rootEarly && isKerjaVault(rootEarly)) {
      const must = [
        KERJA_REL.home,
        KERJA_REL.sidebrainIndex,
        path.join(KERJA_REL.dailyDir, new Date().toISOString().split('T')[0] + '.md')
      ]
      // Query-specific sidebrain / index boost
      if (/cuti/i.test(qLower)) {
        must.push(path.join('03 Kerjaan', 'Cuti', '00 Index Cuti.md'))
      }
      if (/kgb/i.test(qLower)) {
        must.push(path.join('03 Kerjaan', 'KGB', '00 Index KGB.md'))
      }
      if (/pegawai|asn|nip/i.test(qLower)) {
        must.push(KERJA_REL.pegawaiDb)
      }
      for (const rel of must) {
        const abs = path.join(rootEarly, rel)
        if (fs.existsSync(abs)) {
          tryAddSnippet(path.basename(rel, '.md'), abs, 'kerja', 650, 0)
        }
      }
    }

    {
      const systemNotes = this.searchEngine.getSystemFolderNotes()
      const ordered = [...systemNotes].sort(
        (a, b) => this.pathPriority(a.path) - this.pathPriority(b.path)
      )
      const cap = roleWantsRules ? 2 : 1
      for (const n of ordered.slice(0, cap)) {
        tryAddSnippet(n.title, n.path, 'system', 500, 0)
      }
    }

    // ——— 5. Search hits (FTS/hybrid) ———
    if (query.trim()) {
      const searchResults = this.searchEngine.search({ query, limit: 5 })
      let added = 0
      for (const res of searchResults) {
        const prio = this.pathPriority(res.path)
        const maxChars = prio <= 2 ? 600 : 400
        if (tryAddSnippet(res.title, res.path, 'search', maxChars, 2)) added++
        if (added >= 3 || usedTokens >= tokenBudget * 0.9) break
      }
    }

    // ——— 6. Persona rules ———
    const agent = AGENT_ROLES[agentRole] || AGENT_ROLES.general
    const root = this.workspaceEngine.getState().rootPath
    const kerja = isKerjaVault(root)
    const systemRules = [
      agent.systemInstruction,
      'Markdown First: Data is stored as Markdown. Cite with [[WikiLinks]].',
      'User Owns Data: Do not invent facts. If context is insufficient, say so.',
      'Write Back: Prefer clean GitHub-flavored Markdown ready to append to notes.',
      'Never invent names, dates, NIP, or office data not present in workspace context.'
    ]
    if (kerja) {
      systemRules.push(
        'Kerja mode (vault Obsidian Diskominfo): ikuti struktur 00 Home, 02 Harian, 03 Kerjaan, 05 Pegawai, 08 Sidebrain, 99 Templates.',
        'Untuk cuti/KGB/surat/pegawai: utamakan Sidebrain + index Kerjaan + 05 Pegawai; jangan invent data ASN.',
        'File resmi PDF/Word/Excel tetap di Z: (DATA PEGAWAI / SURAT), vault hanya note/index Markdown.',
        `Daily path: ${KERJA_REL.dailyDir}/YYYY-MM-DD.md · Pegawai DB: ${KERJA_REL.pegawaiDb}`
      )
    }

    // Assemble prompt
    const parts: string[] = []
    parts.push('=== WORKSPACE CONTEXT ===')
    parts.push(`Token budget ~${tokenBudget}; estimate used ~${usedTokens}`)
    parts.push('System Rules & Persona:')
    for (const r of systemRules) parts.push(`- ${r}`)

    if (activeFile) {
      parts.push(`\n[1 ACTIVE] "${activeFile.title}" (${activeFile.path})`)
      parts.push('--- ACTIVE NOTE START ---')
      parts.push(activeFile.content)
      parts.push('--- ACTIVE NOTE END ---')

      if (graphNeighbors && graphNeighbors.length > 0) {
        parts.push('\nOutgoing / graph neighbors:')
        for (const gn of graphNeighbors.slice(0, 12)) {
          parts.push(`- [[${gn.title}]] (${gn.type})`)
        }
      }
      if (backlinks && backlinks.length > 0) {
        parts.push('\nBacklinks:')
        for (const b of backlinks.slice(0, 12)) {
          parts.push(`- [[${b.title}]]`)
        }
      }
    }

    if (relevantFiles.length > 0) {
      parts.push('\nRelated documents (priority order):')
      for (const f of relevantFiles) {
        parts.push(`\n[${f.tier.toUpperCase()}] "${f.title}" (${f.path})`)
        parts.push(f.snippet)
      }
    }
    parts.push('=== END OF WORKSPACE CONTEXT ===\n')

    const formattedContext = parts.join('\n')
    return {
      query,
      activeFile,
      graphNeighbors,
      backlinks,
      relevantFiles,
      citations,
      systemRules,
      formattedContext,
      tokenEstimate: estimateTokens(formattedContext)
    }
  }

  private pathPriority(p: string): number {
    const lower = p.replace(/\\/g, '/').toLowerCase()
    for (let i = 0; i < KERJA_CONTEXT_PRIORITY.length; i++) {
      if (lower.includes(KERJA_CONTEXT_PRIORITY[i].replace(/\\/g, '/'))) return i
    }
    if (lower.includes('/rules/')) return 10
    if (lower.includes('/sop/')) return 11
    if (lower.includes('/templates/')) return 12
    if (lower.includes('/prompt/')) return 13
    return 20
  }
}
