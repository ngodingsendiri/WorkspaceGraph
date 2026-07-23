/**
 * AI Worker tools (Phase 3) — Law 003–007
 * Read tools execute immediately.
 * Write tools create proposals; apply only after user confirm.
 */
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { searchEngine } from '../engine/SearchEngine'
import { markdownEngine } from '../engine/MarkdownEngine'
import { templateEngine } from '../engine/TemplateEngine'
import { isPathInVault } from '../security/PathSandbox'

export type ToolName =
  | 'search'
  | 'read_note'
  | 'list_dir'
  | 'write_note'
  | 'append_note'
  | 'create_note'
  | 'create_from_template'
  | 'list_templates'

export interface ToolAction {
  tool: ToolName
  args: Record<string, unknown>
}

export interface ToolResult {
  tool: ToolName
  ok: boolean
  result?: unknown
  error?: string
  proposalId?: string
}

export interface WriteProposal {
  id: string
  tool: 'write_note' | 'append_note' | 'create_note' | 'create_from_template'
  absolutePath: string
  relativePath: string
  content: string
  mode: 'overwrite' | 'append' | 'create'
  preview: string
  status: 'pending' | 'applied' | 'rejected'
  createdAt: string
  /** Original frontmatter preserved flag for overwrite validation */
  preservesFrontmatter?: boolean
}

const WRITE_TOOLS = new Set<ToolName>([
  'write_note',
  'append_note',
  'create_note',
  'create_from_template'
])
const READ_TOOLS = new Set<ToolName>(['search', 'read_note', 'list_dir', 'list_templates'])

const proposals = new Map<string, WriteProposal>()

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name as ToolName)
}

export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name as ToolName)
}

export function getProposal(id: string): WriteProposal | undefined {
  return proposals.get(id)
}

export function listPendingProposals(): WriteProposal[] {
  return Array.from(proposals.values()).filter((p) => p.status === 'pending')
}

export function rejectProposal(id: string): boolean {
  const p = proposals.get(id)
  if (!p || p.status !== 'pending') return false
  p.status = 'rejected'
  return true
}

/** Tool instructions injected into system prompt when worker tools enabled */
export const TOOLS_SYSTEM_PROMPT = `
## Workspace Tools (AI Worker)

You MAY call tools by emitting one or more fenced blocks. Use EXACTLY this format:

\`\`\`wg-action
{"tool":"search","args":{"query":"cuti","limit":5}}
\`\`\`

Available tools:
1. search — args: { query: string, limit?: number }
2. read_note — args: { path: string }  // absolute or vault-relative path, or note title
3. list_dir — args: { path?: string }  // relative folder under vault root; default ""
4. write_note — args: { path: string, content: string }  // overwrite entire file (preserve frontmatter if present in content)
5. append_note — args: { path: string, content: string }  // append markdown section
6. create_note — args: { path: string, content: string }  // create new .md (path relative e.g. Knowledge/Foo.md)
7. list_templates — args: {}  // list built-in + vault templates
8. create_from_template — args: { templateId: string, title: string, folder?: string }  // MUST prefer this over freeform create when a template fits (project/task/people/sop/daily)

Rules:
- Prefer search + read_note before inventing vault facts (Constitution Law 006).
- For new structured notes (project, task, people, sop, daily): call list_templates then create_from_template.
- For write/create/append/create_from_template: propose once; user must confirm before disk write.
- Paths use vault-relative form when possible (Knowledge/..., Daily/...).
- After tool results arrive, continue answering. Do not invent tool results.
- When finished, write a clear user-facing summary in Markdown with [[WikiLinks]].
`.trim()

/**
 * Parse tool actions from model output.
 * Supports ```wg-action ... ``` blocks (single object or array).
 */
export function parseToolActions(text: string): ToolAction[] {
  const actions: ToolAction[] = []
  const re = /```wg-action\s*([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim()
    try {
      const parsed = JSON.parse(body) as ToolAction | ToolAction[]
      if (Array.isArray(parsed)) {
        for (const a of parsed) {
          if (a && typeof a.tool === 'string') actions.push(a)
        }
      } else if (parsed && typeof parsed.tool === 'string') {
        actions.push(parsed)
      }
    } catch {
      // try line-by-line JSON objects
      try {
        const lines = body.split('\n').filter((l) => l.trim().startsWith('{'))
        for (const line of lines) {
          const a = JSON.parse(line) as ToolAction
          if (a?.tool) actions.push(a)
        }
      } catch {
        /* skip bad block */
      }
    }
  }
  return actions
}

/** Strip tool fences from display text */
export function stripToolActions(text: string): string {
  return text.replace(/```wg-action\s*[\s\S]*?```/gi, '').trim()
}

function resolvePath(input: string): string | null {
  const root = workspaceEngine.getState().rootPath
  if (!root) return null
  if (!input || !String(input).trim()) return null
  let p = String(input).trim()

  // Absolute path — must stay inside vault (PathSandbox, not naive startsWith)
  // startsWith("D:\Obs\Obs") wrongly allows "D:\Obs\Obs-evil\..."
  if (path.isAbsolute(p)) {
    const normP = path.resolve(p)
    return isPathInVault(normP, root) ? normP : null
  }

  // Relative to vault
  p = p.replace(/^[/\\]+/, '')
  // Empty → vault root (list_dir default)
  const abs = path.resolve(root, p || '.')
  return isPathInVault(abs, root) ? abs : null
}

function resolveNotePath(input: string): string | null {
  const direct = resolvePath(input)
  if (direct && fs.existsSync(direct)) return direct
  if (direct && !fs.existsSync(direct) && direct.toLowerCase().endsWith('.md')) {
    return direct // may create
  }

  // Title resolve via search / graph
  const hits = searchEngine.search({ query: input, limit: 5 })
  const exact = hits.find(
    (h) =>
      h.title.toLowerCase() === input.toLowerCase() ||
      h.relativePath.toLowerCase().endsWith(`/${input.toLowerCase()}.md`) ||
      h.relativePath.toLowerCase().endsWith(`${input.toLowerCase()}.md`)
  )
  if (exact) return exact.path
  if (hits[0]) return hits[0].path

  // try basename match in memory
  const root = workspaceEngine.getState().rootPath
  if (!root) return null
  const withMd = input.endsWith('.md') ? input : `${input}.md`
  const guess = resolvePath(withMd.startsWith('Knowledge') ? withMd : `Knowledge/${withMd}`)
  return guess
}

function relativeToVault(abs: string): string {
  const root = workspaceEngine.getState().rootPath || ''
  return path.relative(root, abs).replace(/\\/g, '/')
}

function findFrontmatterClose(content: string): number {
  // Support LF and CRLF closing fences (Windows vault notes)
  const lf = content.indexOf('\n---', 3)
  const crlf = content.indexOf('\r\n---', 3)
  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

function validateMarkdownContent(content: string): {
  ok: boolean
  error?: string
  preservesFrontmatter?: boolean
} {
  if (typeof content !== 'string') return { ok: false, error: 'content must be string' }
  if (content.length > 500_000) return { ok: false, error: 'content too large (>500KB)' }
  // balanced frontmatter if starts with ---
  if (content.startsWith('---')) {
    if (findFrontmatterClose(content) === -1) {
      return { ok: false, error: 'unclosed frontmatter (---)' }
    }
    return { ok: true, preservesFrontmatter: true }
  }
  return { ok: true, preservesFrontmatter: false }
}

function createProposal(
  tool: WriteProposal['tool'],
  abs: string,
  content: string,
  mode: WriteProposal['mode']
): WriteProposal {
  // tool includes create_from_template
  const id = crypto.randomBytes(8).toString('hex')
  const validation = validateMarkdownContent(content)
  const prop: WriteProposal = {
    id,
    tool,
    absolutePath: abs,
    relativePath: relativeToVault(abs),
    content,
    mode,
    preview: content.slice(0, 400).replace(/\n/g, ' '),
    status: 'pending',
    createdAt: new Date().toISOString(),
    preservesFrontmatter: validation.preservesFrontmatter
  }
  proposals.set(id, prop)
  return prop
}

export async function executeTool(action: ToolAction): Promise<ToolResult> {
  const tool = action.tool
  const args = action.args || {}

  try {
    if (!workspaceEngine.getState().rootPath) {
      return { tool, ok: false, error: 'No workspace open' }
    }

    switch (tool) {
      case 'search': {
        const query = String(args.query || '')
        const limit = Number(args.limit) || 8
        const hits = searchEngine.search({ query, limit })
        return {
          tool,
          ok: true,
          result: hits.map((h) => ({
            title: h.title,
            path: h.relativePath,
            absolutePath: h.path,
            score: h.score,
            preview: h.preview
          }))
        }
      }

      case 'read_note': {
        const input = String(args.path || args.title || '')
        const abs = resolveNotePath(input)
        if (!abs || !fs.existsSync(abs)) {
          return { tool, ok: false, error: `Note not found: ${input}` }
        }
        const raw = workspaceEngine.readFile(abs)
        const root = workspaceEngine.getState().rootPath || ''
        const parsed = markdownEngine.parseFile(abs, raw, root)
        return {
          tool,
          ok: true,
          result: {
            path: relativeToVault(abs),
            absolutePath: abs,
            title: parsed.title,
            tags: parsed.tags,
            content: raw.slice(0, 12000)
          }
        }
      }

      case 'list_dir': {
        const rel = String(args.path || '').replace(/^[/\\]+/, '')
        const abs = resolvePath(rel || '.')
        if (!abs || !fs.existsSync(abs)) {
          return { tool, ok: false, error: `Directory not found: ${rel || '/'}` }
        }
        const entries = fs.readdirSync(abs, { withFileTypes: true })
        const items = entries
          .filter((e) => !e.name.startsWith('.'))
          .slice(0, 100)
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file',
            path: relativeToVault(path.join(abs, e.name))
          }))
        return { tool, ok: true, result: { path: relativeToVault(abs), items } }
      }

      case 'write_note': {
        const input = String(args.path || '')
        const content = String(args.content ?? '')
        const v = validateMarkdownContent(content)
        if (!v.ok) return { tool, ok: false, error: v.error }
        const abs = resolveNotePath(input) || resolvePath(input)
        if (!abs) return { tool, ok: false, error: 'Invalid path' }
        // If overwriting existing with body-only content, try preserve frontmatter
        let finalContent = content
        if (fs.existsSync(abs) && !content.startsWith('---')) {
          try {
            const existing = workspaceEngine.readFile(abs)
            if (existing.startsWith('---')) {
              const end = findFrontmatterClose(existing)
              if (end !== -1) {
                // end points at \n or \r of the closing fence line — skip past "---"
                const afterFence = existing.indexOf('---', end + 1)
                const closeEnd =
                  afterFence !== -1 ? afterFence + 3 : end + (existing[end] === '\r' ? 5 : 4)
                finalContent = existing.slice(0, closeEnd) + '\n\n' + content.trimStart()
              }
            }
          } catch {
            /* use as-is */
          }
        }
        const prop = createProposal('write_note', abs, finalContent, 'overwrite')
        return {
          tool,
          ok: true,
          proposalId: prop.id,
          result: {
            pending: true,
            proposalId: prop.id,
            path: prop.relativePath,
            message: 'Write proposal created — waiting for user confirm'
          }
        }
      }

      case 'append_note': {
        const input = String(args.path || '')
        const content = String(args.content ?? '')
        if (!content.trim()) return { tool, ok: false, error: 'empty append content' }
        const abs = resolveNotePath(input)
        if (!abs || !fs.existsSync(abs)) {
          return { tool, ok: false, error: `Note not found for append: ${input}` }
        }
        const existing = workspaceEngine.readFile(abs)
        const merged = existing.replace(/\s*$/, '') + '\n\n' + content.trim() + '\n'
        const prop = createProposal('append_note', abs, merged, 'append')
        // Store only the append slice in preview; full content is merged for apply
        prop.preview = content.slice(0, 400).replace(/\n/g, ' ')
        return {
          tool,
          ok: true,
          proposalId: prop.id,
          result: {
            pending: true,
            proposalId: prop.id,
            path: prop.relativePath,
            message: 'Append proposal created — waiting for user confirm'
          }
        }
      }

      case 'create_note': {
        const input = String(args.path || '')
        let content = String(args.content ?? '')
        const abs = resolvePath(input.endsWith('.md') ? input : `${input}.md`)
        if (!abs) return { tool, ok: false, error: 'Invalid path' }
        if (fs.existsSync(abs)) {
          return { tool, ok: false, error: `File already exists: ${relativeToVault(abs)}` }
        }
        if (!content.startsWith('---')) {
          const title = path.basename(abs, '.md') || 'Untitled'
          content = markdownEngine.createNoteTemplate(title, 'knowledge') + content
        }
        const v = validateMarkdownContent(content)
        if (!v.ok) return { tool, ok: false, error: v.error }
        const prop = createProposal('create_note', abs, content, 'create')
        return {
          tool,
          ok: true,
          proposalId: prop.id,
          result: {
            pending: true,
            proposalId: prop.id,
            path: prop.relativePath,
            message: 'Create proposal created — waiting for user confirm'
          }
        }
      }

      case 'list_templates': {
        const root = workspaceEngine.getState().rootPath
        const list = templateEngine.listTemplates(root)
        return {
          tool,
          ok: true,
          result: list.map((t) => ({
            id: t.id,
            name: t.name,
            kind: t.kind,
            defaultFolder: t.defaultFolder,
            builtin: t.builtin
          }))
        }
      }

      case 'create_from_template': {
        const templateId = String(args.templateId || args.template || '')
        const title = String(args.title || 'Untitled')
        const root = workspaceEngine.getState().rootPath
        if (!root) return { tool, ok: false, error: 'No workspace open' }
        const tpl = templateEngine.getTemplate(templateId, root)
        if (!tpl) return { tool, ok: false, error: `Template not found: ${templateId}` }
        const content = templateEngine.render(tpl.body, {
          title,
          filename: title,
          project: String(args.project || ''),
          owner: String(args.owner || ''),
          workspace: path.basename(root)
        })
        const folder = String(args.folder || tpl.defaultFolder)
        let fileName = `${title.replace(/[<>:"/\\|?*]/g, '-')}.md`
        if (tpl.kind === 'daily') {
          fileName = `${new Date().toISOString().split('T')[0]}.md`
        }
        const abs = resolvePath(path.join(folder, fileName))
        if (!abs) return { tool, ok: false, error: 'Invalid path' }
        if (fs.existsSync(abs)) {
          return { tool, ok: false, error: `File already exists: ${relativeToVault(abs)}` }
        }
        const prop = createProposal('create_from_template', abs, content, 'create')
        return {
          tool,
          ok: true,
          proposalId: prop.id,
          result: {
            pending: true,
            proposalId: prop.id,
            path: prop.relativePath,
            templateId,
            message: 'Template create proposal — waiting for user confirm'
          }
        }
      }

      default:
        return { tool: tool as ToolName, ok: false, error: `Unknown tool: ${tool}` }
    }
  } catch (err) {
    return {
      tool,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Apply a confirmed write proposal to disk.
 * Caller should re-sync graph/search after this.
 */
export function applyProposal(id: string): { ok: boolean; path?: string; error?: string } {
  const p = proposals.get(id)
  if (!p) return { ok: false, error: 'Proposal not found' }
  if (p.status !== 'pending') return { ok: false, error: `Proposal already ${p.status}` }

  try {
    const root = workspaceEngine.getState().rootPath
    if (!root) return { ok: false, error: 'No workspace open' }

    const abs = path.resolve(p.absolutePath)
    // Same sandbox as resolvePath — reject sibling prefixes e.g. vault "Obs\Obs-evil"
    if (!isPathInVault(abs, root)) {
      return { ok: false, error: 'Path outside vault rejected' }
    }

    if (p.mode === 'create' && fs.existsSync(abs)) {
      return { ok: false, error: 'File already exists' }
    }

    const dir = path.dirname(abs)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    workspaceEngine.writeFile(abs, p.content)
    p.status = 'applied'
    return { ok: true, path: abs }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function formatToolResultsForModel(results: ToolResult[]): string {
  return (
    '### Tool results (from WorkspaceGraph)\n\n' +
    results
      .map((r) => {
        if (!r.ok) return `- **${r.tool}** ERROR: ${r.error}`
        return `- **${r.tool}** OK:\n\`\`\`json\n${JSON.stringify(r.result, null, 2).slice(0, 8000)}\n\`\`\``
      })
      .join('\n\n') +
    '\n\nContinue your answer using these results. If write proposals are pending, tell the user to confirm them in the chat panel.'
  )
}
