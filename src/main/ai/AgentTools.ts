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
import { renderPrompt } from './PromptRegistry'
import { mcpManager } from '../mcp/McpClientManager'
import type { AgentRole } from './ContextEngine'
import type { AIToolCall, ProviderTool } from './providers/BaseProvider'

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
  /** Static ToolName OR a dynamic MCP tool (`mcp__<server>__<tool>`). */
  tool: string
  args: Record<string, unknown>
}

export interface ToolResult {
  tool: string
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

// ── Per-role tool permissions (P1 — doc 20 agent capabilities) ─────────────
// Each AgentRole is a specialist with a bounded toolset; the `general` role is
// the only one with full access. Enforcement is defense-in-depth: the prompt /
// schema builders only ADVERTISE allowed tools (so the model rarely tries the
// rest), and executeTool GUARDS execution even if a denied tool slips through
// (fence path / malicious input).
const ALL_TOOLS: ToolName[] = [
  'search',
  'read_note',
  'list_dir',
  'write_note',
  'append_note',
  'create_note',
  'list_templates',
  'create_from_template'
]

/** Canonical tool order shared by the fence prompt + schema builders. */
export const TOOL_ORDER: ToolName[] = [...ALL_TOOLS]

/**
 * Tools each role may call.
 * - researcher: read-only (no writes — gathers facts for downstream stages)
 * - curator: read + create/append (can build backlinks / knowledge notes, never
 *   replace existing content wholesale — append is additive)
 * - planner: read + create (task/plan notes via templates; no append to notes)
 * - writer: full authoring set
 * - general: everything (default)
 */
export const ROLE_TOOL_PERMISSIONS: Record<AgentRole, ReadonlySet<ToolName>> = {
  general: new Set(ALL_TOOLS),
  writer: new Set(ALL_TOOLS),
  researcher: new Set(['search', 'read_note', 'list_dir', 'list_templates']),
  curator: new Set([
    'search',
    'read_note',
    'list_dir',
    'list_templates',
    'create_note',
    'append_note'
  ]),
  planner: new Set([
    'search',
    'read_note',
    'list_dir',
    'list_templates',
    'create_note',
    'create_from_template'
  ])
}

/** Is `tool` callable by `role`? Unknown roles degrade to general (allow). */
export function isToolAllowed(role: AgentRole, tool: ToolName | string): boolean {
  const allowed = ROLE_TOOL_PERMISSIONS[role] || ROLE_TOOL_PERMISSIONS.general
  return allowed.has(tool as ToolName)
}

// ── Proposal persistence (P-B2) ────────────────────────────────────────────
// Pending write proposals survive app restarts: one JSON file per proposal
// under <vault>/.workspacegraph/proposals/ (same pattern as chats). The
// in-memory cache is scoped to the CURRENT vault — switching vaults clears and
// rescans, so proposals from another vault never leak into the dock.
const proposals = new Map<string, WriteProposal>()
let cachedRoot: string | null = null

function proposalDir(root: string): string {
  const dir = path.join(root, '.workspacegraph', 'proposals')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function proposalFile(root: string, id: string): string {
  return path.join(proposalDir(root), `${id}.json`)
}

/** Reload pending proposals for the current vault — runs once per vault change. */
function ensureProposalsLoaded(): void {
  const root = workspaceEngine.getState().rootPath
  if (root === cachedRoot) return
  proposals.clear()
  cachedRoot = root
  if (!root) return
  try {
    for (const f of fs.readdirSync(proposalDir(root))) {
      if (!f.endsWith('.json')) continue
      try {
        const p = JSON.parse(
          fs.readFileSync(path.join(proposalDir(root), f), 'utf-8')
        ) as WriteProposal
        if (p && typeof p.id === 'string' && p.status === 'pending') {
          proposals.set(p.id, p)
        }
      } catch {
        /* skip corrupt proposal file */
      }
    }
  } catch {
    /* proposals dir may not exist yet */
  }
}

function persistProposal(p: WriteProposal): void {
  const root = workspaceEngine.getState().rootPath
  if (!root) return
  try {
    fs.writeFileSync(proposalFile(root, p.id), JSON.stringify(p, null, 2), 'utf-8')
  } catch (err) {
    console.error('[proposals] persist failed:', err)
  }
}

/** Remove a proposal file — a resolved (applied/rejected) proposal must not
 * resurrect on the next launch. Joins the path directly so deleting never
 * litters an empty proposals dir with a mkdir. */
function removeProposalFile(id: string): void {
  const root = workspaceEngine.getState().rootPath
  if (!root) return
  try {
    fs.rmSync(path.join(root, '.workspacegraph', 'proposals', `${id}.json`), { force: true })
  } catch {
    /* ignore */
  }
}

export function isWriteTool(name: string): boolean {
  // R0-1: MCP tools are classified by their server annotations — anything not
  // explicitly `readOnlyHint: true` is treated as a write (safe default).
  return WRITE_TOOLS.has(name as ToolName) || mcpManager.isWriteTool(name)
}

export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name as ToolName) || mcpManager.isReadTool(name)
}

/**
 * R0-1 — can `role` call MCP WRITE tools? Mirrors the vault-write gate: only
 * roles whose tool permission set includes at least one write tool may touch
 * external state through MCP (researcher never does). Used BOTH by the
 * execution gate and by the schema/fence advertisers so a researcher never
 * even sees MCP write tools.
 */
export function roleCanWriteMCP(role: AgentRole): boolean {
  const allowed = ROLE_TOOL_PERMISSIONS[role] || ROLE_TOOL_PERMISSIONS.general
  return [...allowed].some((t) => WRITE_TOOLS.has(t as ToolName))
}

export function getProposal(id: string): WriteProposal | undefined {
  ensureProposalsLoaded()
  return proposals.get(id)
}

export function listPendingProposals(): WriteProposal[] {
  ensureProposalsLoaded()
  return Array.from(proposals.values()).filter((p) => p.status === 'pending')
}

export function rejectProposal(id: string): boolean {
  ensureProposalsLoaded()
  const p = proposals.get(id)
  if (!p || p.status !== 'pending') return false
  p.status = 'rejected'
  removeProposalFile(id)
  return true
}

/**
 * P2 knowledge promotion: turn a chat answer into a `create_note` proposal
 * under Knowledge/ with an automatic "Sumber" backlink section pointing at the
 * cited notes. Uses the exact same proposal lifecycle as agent writes, so the
 * dock + Apply/Reject + diff preview all work unchanged.
 */
export function promoteToKnowledge(
  content: string,
  citations: { title: string; path: string }[],
  suggestedTitle?: string
): { ok: boolean; proposal?: WriteProposal; error?: string } {
  const root = workspaceEngine.getState().rootPath
  if (!root) return { ok: false, error: 'No workspace open' }
  const body = String(content || '').trim()
  if (!body) return { ok: false, error: 'Jawaban kosong — tidak ada yang disimpan' }

  // Derive a filename from the suggestion, or the first non-fence line
  const raw = (suggestedTitle && suggestedTitle.trim()) || firstContentLine(body)
  const title =
    raw
      .replace(/^#+\s*/, '')
      .replace(/\[\[(.+?)\]\]/g, '$1')
      .replace(/[*_`>|]/g, '')
      .replace(/[:\\/"?<>|]+/g, ' ')
      .trim()
      .slice(0, 80) || 'Knowledge Note'

  // Unique path under Knowledge/ — avoid clobbering an existing note
  let abs: string | null = null
  let fileName = `${title}.md`
  let n = 2
  while (!abs || fs.existsSync(abs)) {
    abs = path.resolve(root, 'Knowledge', fileName)
    if (!fs.existsSync(abs)) break
    fileName = `${title}-${n}.md`
    n++
  }
  if (!abs || !isPathInVault(abs, root)) {
    return { ok: false, error: 'Invalid Knowledge path' }
  }

  // Backlink section: one [[wikilink]] per cited note (vault-relative alias)
  const sourceLines: string[] = []
  const seen = new Set<string>()
  for (const c of citations || []) {
    const norm = String(c.path || '').replace(/\\/g, '/')
    // Boundary check — plain startsWith would wrongly treat a sibling prefix
    // (root `C:/vault` vs citation `C:/vault-other/...`) as inside the vault
    // and slice a corrupted `-other/...` path. Fall back to path.relative.
    const rootN = root.replace(/\\/g, '/')
    const rel =
      norm === rootN || norm.startsWith(rootN + '/')
        ? norm.slice(rootN.length).replace(/^\/+/, '')
        : path.relative(root, norm).replace(/\\/g, '/')
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    const alias = (c.title || path.basename(rel, '.md')).trim()
    sourceLines.push(`- [[${rel.replace(/\.md$/i, '')}|${alias}]]`)
  }

  const noteContent = [
    `---`,
    `title: ${title}`,
    `type: knowledge`,
    `created: ${nowIsoDate()}`,
    `updated: ${nowIsoDate()}`,
    `tags: [knowledge]`,
    `---`,
    ``,
    body,
    ``,
    `## Sumber`,
    ``,
    ...(sourceLines.length > 0 ? sourceLines : ['- _(tidak ada sitasi)_'])
  ].join('\n')

  const prop = createProposal('create_note', abs, noteContent, 'create')
  return { ok: true, proposal: prop }
}

/** First meaningful line of an answer — the knowledge-note title seed. */
function firstContentLine(text: string): string {
  const line = (
    text.split('\n').find((l) => {
      const t = l.trim()
      return t && !t.startsWith('```') && !t.startsWith('---') && !/^[-*]\s*$/.test(t)
    }) || 'Knowledge Note'
  ).trim()
  return line.replace(/^#+\s*/, '').slice(0, 80)
}

function nowIsoDate(): string {
  return new Date().toISOString().split('T')[0]
}

/** One-line tool signature shown in the fence prompt (kept in sync with buildToolSchemas). */
const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  search: 'search — args: { query: string, limit?: number }',
  read_note:
    'read_note — args: { path: string }  // absolute or vault-relative path, or note title',
  list_dir: 'list_dir — args: { path?: string }  // relative folder under vault root; default ""',
  write_note:
    'write_note — args: { path: string, content: string }  // overwrite entire file (preserve frontmatter if present)',
  append_note: 'append_note — args: { path: string, content: string }  // append markdown section',
  create_note:
    'create_note — args: { path: string, content: string }  // create new .md (e.g. AI Memory/Topik.md)',
  list_templates: 'list_templates — args: {}',
  create_from_template:
    'create_from_template — args: { templateId: string, title: string, folder?: string }'
}

/**
 * Fence-protocol tool instructions for a specific role — only the tools that
 * role may call are listed (P1 capability advertisement). The head/tail prose
 * comes from the Prompt Registry (doc 19) with the role-filtered numbered
 * tool list injected into the {{tools}} placeholder — so the whole tools
 * prompt is a versioned, per-vault editable asset.
 */
export function buildToolsSystemPrompt(
  role: AgentRole = 'general',
  mcpTools: { name: string; description: string }[] = []
): string {
  const allowed = ROLE_TOOL_PERMISSIONS[role] || ROLE_TOOL_PERMISSIONS.general
  const tools = TOOL_ORDER.filter((t) => allowed.has(t))
  const lines = tools.map((t, i) => `${i + 1}. ${TOOL_DESCRIPTIONS[t]}`).join('\n')
  // R0-1: MCP tools ride the same fence protocol as a separate section (their
  // names already encode the server via the mcp__ prefix).
  const mcpSection =
    mcpTools.length > 0
      ? `\n\nMCP tools (external servers — call with the same fence format):\n${mcpTools
          .map((t, i) => `${lines ? i + tools.length + 1 : i + 1}. ${t.name} — ${t.description}`)
          .join('\n')}`
      : ''
  return (
    renderPrompt('toolsHead', { tools: lines + mcpSection }) + renderPrompt('toolsTail')
  ).trim()
}

/** Fence instructions for the full (general) toolset — kept for compatibility. */
export const TOOLS_SYSTEM_PROMPT = buildToolsSystemPrompt('general')

function pushAction(actions: ToolAction[], raw: unknown): void {
  if (!raw || typeof raw !== 'object') return
  if (Array.isArray(raw)) {
    for (const item of raw) pushAction(actions, item)
    return
  }
  const obj = raw as Record<string, unknown>
  const tool = String(obj.tool || obj.name || '').trim()
  if (!tool) return
  const args =
    obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)
      ? (obj.args as Record<string, unknown>)
      : obj.parameters && typeof obj.parameters === 'object'
        ? (obj.parameters as Record<string, unknown>)
        : (() => {
            const { tool: _t, name: _n, args: _a, parameters: _p, ...rest } = obj
            return rest
          })()
  actions.push({ tool: tool as ToolName, args })
}

/**
 * Parse tool actions from model output.
 * Supports ```wg-action, ```json with tool field, and bare JSON objects.
 */
export function parseToolActions(text: string): ToolAction[] {
  const actions: ToolAction[] = []
  if (!text) return actions

  // 1) fenced blocks: wg-action | json | javascript
  const fenceRe = /```(?:wg-action|json|javascript)?\s*([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(text)) !== null) {
    const body = m[1].trim()
    if (!body.includes('tool') && !body.includes('"name"')) continue
    try {
      pushAction(actions, JSON.parse(body))
    } catch {
      const lines = body.split('\n').filter((l) => l.trim().startsWith('{'))
      for (const line of lines) {
        try {
          pushAction(actions, JSON.parse(line))
        } catch {
          /* skip */
        }
      }
    }
  }

  // 2) bare single-line / multi-line JSON objects containing "tool"
  if (actions.length === 0) {
    const bareRe = /\{\s*"tool"\s*:\s*"[^"]+"\s*,[\s\S]*?\}/g
    let bm: RegExpExecArray | null
    while ((bm = bareRe.exec(text)) !== null) {
      try {
        pushAction(actions, JSON.parse(bm[0]))
      } catch {
        /* skip */
      }
    }
  }

  // Dedupe consecutive identical tool+args
  const seen = new Set<string>()
  return actions.filter((a) => {
    const key = `${a.tool}:${JSON.stringify(a.args || {})}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Strip tool fences from display text — removes wg-action AND generic json /
 * javascript fences that carry tool calls so raw JSON never leaks into the
 * transcript or the next round's assistant message.
 */
export function stripToolActions(text: string): string {
  const cleaned = text
    .replace(/```wg-action\s*[\s\S]*?```/gi, '')
    // json/javascript fences that contain a tool call (best-effort, keeps prose JSON)
    .replace(/```(?:json|javascript)\s*\{[\s\S]*?\}```/gi, '')
  return cleaned.trim()
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
  const hits = searchEngine.searchSync({ query: input, limit: 5 })
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
  ensureProposalsLoaded()
  proposals.set(id, prop)
  persistProposal(prop)
  return prop
}

export async function executeTool(
  action: ToolAction,
  role: AgentRole = 'general'
): Promise<ToolResult> {
  const tool = action.tool
  const args = action.args || {}

  // R0-1: MCP tools are dynamic (not in the static ToolName set) and carry
  // their own gate: role-write capability + the server's allowWriteTools
  // toggle. Read-classified MCP tools run for every role. Handled BEFORE the
  // static capability guard, which would otherwise deny every mcp__ name.
  if (mcpManager.isMcpTool(tool)) {
    return executeMcpTool(action, role)
  }

  // P1 capability guard: even if a denied tool slips past the prompt / schema
  // advertisement (fence hallucination, replayed messages), it must not run.
  if (!isToolAllowed(role, tool)) {
    return {
      tool,
      ok: false,
      error: `Tool "${tool}" tidak diizinkan untuk role "${role}"`
    }
  }

  try {
    if (!workspaceEngine.getState().rootPath) {
      return { tool, ok: false, error: 'No workspace open' }
    }

    switch (tool) {
      case 'search': {
        const query = String(args.query || '')
        const limit = Number(args.limit) || 8
        const hits = searchEngine.searchSync({ query, limit })
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
        const raw = workspaceEngine.readFile(abs).content
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
            const existing = workspaceEngine.readFile(abs).content
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
        const existing = workspaceEngine.readFile(abs).content
        const merged = existing.replace(/\s*$/, '') + '\n\n' + content.trim() + '\n'
        const prop = createProposal('append_note', abs, merged, 'append')
        // Store only the append slice in preview; full content is merged for apply
        prop.preview = content.slice(0, 400).replace(/\n/g, ' ')
        // Preview is overridden AFTER createProposal persisted — rewrite the file
        persistProposal(prop)
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
        return { tool, ok: false, error: `Unknown tool: ${tool}` }
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
 * R0-1 — route an MCP tool call through the manager with the full gate:
 * 1. write-classified tools need the role's write capability;
 * 2. write-classified tools need the server's allowWriteTools toggle;
 * 3. only then does the network call happen (timeout-bounded in the manager).
 */
async function executeMcpTool(action: ToolAction, role: AgentRole): Promise<ToolResult> {
  const tool = action.tool
  const args = action.args || {}
  try {
    if (mcpManager.isWriteTool(tool) && !roleCanWriteMCP(role)) {
      return {
        tool,
        ok: false,
        error: `MCP write tool "${tool}" tidak diizinkan untuk role "${role}"`
      }
    }
    if (mcpManager.isWriteTool(tool) && !mcpManager.isWriteAllowed(tool)) {
      return {
        tool,
        ok: false,
        error: `MCP write tool "${tool}" diblokir — aktifkan 'allow write tools' untuk server itu di Settings → MCP`
      }
    }
    const result = await mcpManager.callTool(tool, args)
    return { tool, ok: true, result }
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
export function applyProposal(
  id: string,
  contentOverride?: string
): { ok: boolean; path?: string; error?: string } {
  ensureProposalsLoaded()
  const p = proposals.get(id)
  if (!p) return { ok: false, error: 'Proposal not found' }
  if (p.status !== 'pending') return { ok: false, error: `Proposal already ${p.status}` }

  try {
    const root = workspaceEngine.getState().rootPath
    if (!root) return { ok: false, error: 'No workspace open' }

    // P2-6: the diff preview dialog lets the user edit before applying — the
    // edited content replaces the stored proposal content (still validated).
    let content = p.content
    if (contentOverride !== undefined) {
      const v = validateMarkdownContent(contentOverride)
      if (!v.ok) return { ok: false, error: v.error }
      content = contentOverride
    }

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
    workspaceEngine.writeFile(abs, content)
    p.status = 'applied'
    // Applied is terminal — remove the persisted pending proposal so a restart
    // cannot resurrect it into the dock. Order matters: the note is written
    // FIRST so a crash here loses at worst an apply (create re-apply fails
    // safe, overwrite is idempotent) rather than the proposal content itself.
    removeProposalFile(id)
    return { ok: true, path: abs }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * OpenAI-compatible tool schemas for the NATIVE function-calling path (P-A1).
 * Sent as `tools` on the request; the model calls them via structured tool_calls
 * instead of emitting wg-action fences. Keep descriptions aligned with
 * TOOLS_SYSTEM_PROMPT so both protocols teach the same tool semantics.
 */
export function buildToolSchemas(
  role: AgentRole = 'general',
  mcpTools: ProviderTool[] = []
): ProviderTool[] {
  const fn = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    required: string[] = []
  ): ProviderTool => ({
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties: parameters, required }
    }
  })
  const all: ProviderTool[] = [
    fn(
      'search',
      'Full-text search notes in the workspace vault. Returns matching notes with titles, paths, snippets and scores.',
      {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 8)' }
      },
      ['query']
    ),
    fn(
      'read_note',
      'Read a note from the vault. Path can be absolute, vault-relative, or a note title.',
      {
        path: { type: 'string', description: 'Absolute or vault-relative path, or note title' }
      },
      ['path']
    ),
    fn(
      'list_dir',
      'List files and folders under a vault-relative directory (default vault root).',
      { path: { type: 'string', description: 'Vault-relative folder; default "" (root)' } }
    ),
    fn(
      'write_note',
      'Overwrite an entire note (frontmatter preserved when present). Creates a write proposal the user must apply.',
      {
        path: { type: 'string', description: 'Absolute or vault-relative path' },
        content: { type: 'string', description: 'Full markdown content' }
      },
      ['path', 'content']
    ),
    fn(
      'append_note',
      'Append a markdown section to an existing note. Creates a write proposal the user must apply.',
      {
        path: { type: 'string', description: 'Absolute or vault-relative path' },
        content: { type: 'string', description: 'Markdown section to append' }
      },
      ['path', 'content']
    ),
    fn(
      'create_note',
      'Create a new .md note (e.g. AI Memory/Topik.md). Creates a write proposal the user must apply.',
      {
        path: { type: 'string', description: 'Vault-relative path ending in .md' },
        content: { type: 'string', description: 'Markdown content' }
      },
      ['path']
    ),
    fn('list_templates', 'List available note templates.', {}),
    fn(
      'create_from_template',
      'Create a note from a template. Creates a write proposal the user must apply.',
      {
        templateId: { type: 'string', description: 'Template id (see list_templates)' },
        title: { type: 'string', description: 'Note title' },
        folder: { type: 'string', description: 'Vault-relative destination folder (optional)' }
      },
      ['templateId', 'title']
    )
  ]
  // P1: only advertise tools the role may call (researcher sees reads only).
  const allowed = ROLE_TOOL_PERMISSIONS[role] || ROLE_TOOL_PERMISSIONS.general
  // R0-1: MCP tools are appended AFTER the static set, already filtered by the
  // manager for role capability + server allowWriteTools.
  return [...all.filter((s) => allowed.has(s.function.name as ToolName)), ...mcpTools]
}

/**
 * Convert native tool calls (OpenAI tool_calls shape) into executable actions,
 * keeping the call id so results can be zipped back into `tool` role messages.
 * Non-object / unparsable arguments degrade to {} (same as fence path).
 */
export function nativeCallsToActions(
  calls: AIToolCall[]
): { callId: string; action: ToolAction }[] {
  const out: { callId: string; action: ToolAction }[] = []
  for (const c of calls || []) {
    const name = String(c.name || '').trim()
    if (!name) continue
    let args: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(c.arguments || '{}') as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>
      }
    } catch {
      args = {}
    }
    out.push({ callId: c.id || `call_${out.length}`, action: { tool: name as ToolName, args } })
  }
  return out
}

/** Format ONE tool result — used as the content of a native `tool` role message. */
export function formatToolResultForModel(r: ToolResult): string {
  if (!r.ok) return `ERROR: ${r.error || 'tool failed'}`
  return JSON.stringify(r.result, null, 2).slice(0, 8000)
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
