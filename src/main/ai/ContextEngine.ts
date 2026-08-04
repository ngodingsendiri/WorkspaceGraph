import type { SearchEngine } from '../engine/SearchEngine'
import type { WorkspaceEngine } from '../engine/WorkspaceEngine'
import { graphEngine } from '../engine/GraphEngine'
import { embeddingEngine } from './EmbeddingEngine'
import { listAiMemoryPaths, AI_MEMORY_DIR } from './WorkspaceMemory'
import path from 'path'

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
  relevantFiles: { title: string; path: string; snippet: string; tier: string; score?: number }[]
  citations: { title: string; path: string }[]
  systemRules: string[]
  formattedContext: string
  tokenEstimate: number
}

/** ~4 chars ≈ 1 token (rough) */
function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4)
}

/** Slightly higher to leave room for AI Memory L1 + active note */
const DEFAULT_TOKEN_BUDGET = 3600

/**
 * Per-role context profiles: how much context each persona may pull in and how
 * it splits the budget across retrieval tiers. Researcher needs more source
 * material; writer/planner can stay lean so the model focuses on the active note.
 */
export interface RoleProfile {
  /** Total token budget for the context package */
  budget: number
  /** Max related/search docs pulled in (retrieval tiers) */
  searchFiles: number
  searchChars: number
  /** Max semantic (vector) hits + snippet length */
  semanticFiles: number
  semanticChars: number
  /** Max system folder notes (Rules/SOP/Templates) */
  systemCap: number
}

export const ROLE_PROFILES: Record<AgentRole, RoleProfile> = {
  general: { budget: 3600, searchFiles: 4, searchChars: 500, semanticFiles: 4, semanticChars: 500, systemCap: 1 },
  writer: { budget: 3400, searchFiles: 3, searchChars: 450, semanticFiles: 3, semanticChars: 450, systemCap: 2 },
  researcher: { budget: 4600, searchFiles: 6, searchChars: 550, semanticFiles: 6, semanticChars: 550, systemCap: 2 },
  curator: { budget: 4000, searchFiles: 5, searchChars: 500, semanticFiles: 5, semanticChars: 500, systemCap: 1 },
  planner: { budget: 3200, searchFiles: 3, searchChars: 450, semanticFiles: 3, semanticChars: 450, systemCap: 2 }
}

export class ContextEngine {
  constructor(
    private workspaceEngine: WorkspaceEngine,
    private searchEngine: SearchEngine
  ) {}

  buildContextPackage(
    query: string,
    activeFilePath?: string,
    agentRole: AgentRole = 'general',
    tokenBudget = ROLE_PROFILES[agentRole]?.budget ?? DEFAULT_TOKEN_BUDGET
  ): ContextPackage {
    const relevantFiles: ContextPackage['relevantFiles'] = []
    const citations: { title: string; path: string }[] = []
    const seenPaths = new Set<string>()
    let activeFile: ContextPackage['activeFile']
    let graphNeighbors: ContextPackage['graphNeighbors'] = []
    let backlinks: ContextPackage['backlinks'] = []
    let usedTokens = 0
    const profile = ROLE_PROFILES[agentRole] || ROLE_PROFILES.general

    const addCitation = (title: string, p: string) => {
      if (!citations.some((c) => c.path === p)) citations.push({ title, path: p })
    }

    const tryAddSnippet = (
      title: string,
      filePath: string,
      tier: string,
      maxChars: number,
      minPriority: number,
      /** Optional FTS/Fuse preview — use the matched window instead of file head */
      preview?: string,
      /** Optional retrieval score (FTS/Fuse 0..100) — used by the async rerank */
      score?: number
    ): boolean => {
      const norm = filePath.replace(/\\/g, '/')
      if (seenPaths.has(norm)) return false
      if (activeFilePath && norm === activeFilePath.replace(/\\/g, '/')) return false

      const remaining = tokenBudget - usedTokens
      if (remaining < 80) return false

      try {
        const content = this.workspaceEngine.readFile(filePath).content
        const cap = Math.min(maxChars, remaining * 4)
        const snippet = (preview && preview.trim() ? preview : content).slice(0, cap).trim()
        const cost = estimateTokens(snippet) + 20
        if (cost > remaining && minPriority > 0) return false

        seenPaths.add(norm)
        relevantFiles.push({ title, path: filePath, snippet, tier, score })
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
        const content = this.workspaceEngine.readFile(activeFilePath).content
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

    // ——— 4. AI Memory L1 (always — workspace learning / RAG hub) ———
    const rootEarly = this.workspaceEngine.getState().rootPath
    if (rootEarly) {
      const memPaths = listAiMemoryPaths(rootEarly)
      // Cap: index first, then up to profile-driven number of memory notes
      const memCap = Math.max(2, profile.searchFiles + 1)
      let memAdded = 0
      for (const abs of memPaths) {
        const base = path.basename(abs)
        const maxChars = base.startsWith('00') ? 900 : 700
        if (tryAddSnippet(path.basename(abs, '.md'), abs, 'ai-memory', maxChars, 0)) {
          memAdded++
        }
        if (memAdded >= memCap || usedTokens >= tokenBudget * 0.45) break
      }
    }

    // ——— 5. Rules/SOP (Law 005) ———
    const qLower = (query || '').toLowerCase()
    const roleWantsRules =
      agentRole === 'writer' ||
      agentRole === 'researcher' ||
      agentRole === 'curator' ||
      agentRole === 'planner' ||
      /sop|aturan|rules|template|prosedur|format|surat|cara kerja/i.test(qLower)

    {
      const systemNotes = this.searchEngine.getSystemFolderNotes()
      const ordered = [...systemNotes].sort(
        (a, b) => this.pathPriority(a.path) - this.pathPriority(b.path)
      )
      const cap = roleWantsRules ? Math.max(profile.systemCap, 2) : profile.systemCap
      for (const n of ordered.slice(0, cap)) {
        tryAddSnippet(n.title, n.path, 'system', 500, 0)
      }
    }

    // ——— 6. Semantic Search (vector embeddings — runs if EmbeddingEngine is ready) ———
    // This is async but we must keep buildContextPackage synchronous for the existing call sites.
    // We expose a companion async method buildContextPackageAsync() below for use when AI streams.
    // For now, include any pre-computed semantic hits from the sync cache.
    // (The async path in AIMiddleware calls buildContextPackageAsync instead.)

    // ——— 7. FTS / Fuse hybrid search ———
    if (query.trim()) {
      const searchResults = this.searchEngine.searchSync({ query, limit: 8 })
      let added = 0
      for (const res of searchResults) {
        const prio = this.pathPriority(res.path)
        const maxChars = prio <= 2 ? Math.max(600, profile.searchChars) : profile.searchChars
        // Use the FTS/Fuse match window as the snippet — far more useful than the file head
        if (tryAddSnippet(res.title, res.path, 'search', maxChars, 2, res.preview, res.score)) added++
        if (added >= profile.searchFiles || usedTokens >= tokenBudget * 0.9) break
      }
    }

    const agent = AGENT_ROLES[agentRole] || AGENT_ROLES.general
    const systemRules = [
      agent.systemInstruction,
      'Markdown First: Data is stored as Markdown. Cite with [[WikiLinks]].',
      'User Owns Data: Do not invent facts. If context is insufficient, say so.',
      'Write Back: Prefer clean GitHub-flavored Markdown ready to append to notes.',
      `Workspace Memory: notes under "${AI_MEMORY_DIR}/" are long-term how-to memory + RAG. Prefer them; grow them with [[wikilinks]] so the graph densifies.`,
      'If AI Memory is empty or thin, suggest bootstrap "Pelajari workspace" and use tools to fill it via write proposals.'
    ]

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
    if (lower.includes('/ai memory/') || lower.includes('\\ai memory\\')) return 0
    if (lower.includes('/rules/')) return 10
    if (lower.includes('/sop/')) return 11
    if (lower.includes('/templates/')) return 12
    if (lower.includes('/prompt/')) return 13
    return 20
  }

  /**
   * Async version of buildContextPackage.
   * Runs a semantic vector search step (EmbeddingEngine) BEFORE the FTS pass
   * to inject the most semantically relevant chunks even when keyword matching fails.
   *
   * Use this in AIMiddleware streaming path where async is available.
   */
  async buildContextPackageAsync(
    query: string,
    activeFilePath?: string,
    agentRole: AgentRole = 'general',
    tokenBudget = ROLE_PROFILES[agentRole]?.budget ?? DEFAULT_TOKEN_BUDGET
  ): Promise<ContextPackage> {
    // Build the base synchronous package first
    const pkg = this.buildContextPackage(query, activeFilePath, agentRole, tokenBudget)
    const profile = ROLE_PROFILES[agentRole] || ROLE_PROFILES.general

    // If semantic search is ready and we have budget left, augment with vector hits
    if (embeddingEngine.isReady && query.trim()) {
      try {
        const hits = await embeddingEngine.search(query, profile.semanticFiles + 2)
        const seenPaths = new Set(pkg.relevantFiles.map((f) => f.path.replace(/\\/g, '/')))
        if (activeFilePath) seenPaths.add(activeFilePath.replace(/\\/g, '/'))

        let budgetLeft = tokenBudget - pkg.tokenEstimate
        const semanticAdditions: typeof pkg.relevantFiles = []

        for (const hit of hits) {
          const norm = hit.filePath.replace(/\\/g, '/')
          if (seenPaths.has(norm)) continue
          if (budgetLeft < 80) break

          const cap = Math.min(profile.semanticChars, budgetLeft * 4)
          const snippet = hit.chunk.slice(0, cap).trim()
          const cost = Math.ceil(snippet.length / 4) + 20
          if (cost > budgetLeft) continue

          const title = hit.filePath.split(/[/\\]/).pop()?.replace(/\.md$/i, '') || 'Note'
          semanticAdditions.push({ title, path: hit.filePath, snippet, tier: 'semantic', score: hit.score })
          if (!pkg.citations.some((c) => c.path === hit.filePath)) {
            pkg.citations.push({ title, path: hit.filePath })
          }
          seenPaths.add(norm)
          budgetLeft -= cost
          if (semanticAdditions.length >= profile.semanticFiles) break
        }

        if (semanticAdditions.length > 0) {
          /**
           * Rerank: interleave semantic + FTS hits by score so the model sees
           * the most relevant material first, not just insertion order by tier.
           * Normalize both onto 0..1 (FTS score is 0..100, semantic cosine ~0..1)
           * and blend: FTS weight 0.55, semantic 0.45 — neither source dominates.
           */
          const W_FTS = 0.55
          const W_SEM = 0.45
          const searchHits = pkg.relevantFiles
            .filter((x) => x.tier === 'search')
            .map((f) => ({ f, score: (W_FTS * ((f.score ?? 50) / 100)) }))
          const merged = [
            ...searchHits,
            ...semanticAdditions.map((f) => ({ f, score: W_SEM * (f.score ?? 0.5) }))
          ]
          merged.sort((a, b) => b.score - a.score)

          // Rebuild the search+semantic slice of relevantFiles (keep graph/AI-memory tiers intact)
          const nonSearch = pkg.relevantFiles.filter((f) => f.tier !== 'search')
          const reranked = [...nonSearch, ...merged.map((m) => m.f)]

          // Rebuild formattedContext from the new order. Split on the END marker
          // (always present) so the head never carries it — avoids a duplicated
          // marker when the base package had no search tier yet.
          pkg.relevantFiles = reranked
          const head = pkg.formattedContext.split('=== END OF WORKSPACE CONTEXT ===')[0]
          const parts = [head]
          if (reranked.length > 0) {
            parts.push('\nRelated documents (priority order):')
            for (const f of reranked) {
              parts.push(`\n[${f.tier.toUpperCase()}] "${f.title}" (${f.path})`)
              parts.push(f.snippet)
            }
          }
          parts.push('=== END OF WORKSPACE CONTEXT ===\n')
          pkg.formattedContext = parts.join('\n')
          pkg.tokenEstimate = estimateTokens(pkg.formattedContext)
        }
      } catch (err) {
        console.warn('[ContextEngine] Semantic search failed, falling back to FTS only:', err)
      }
    }

    return pkg
  }
}
