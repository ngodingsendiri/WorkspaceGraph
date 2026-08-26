/**
 * Prompt Registry (doc 19 — prompt as an ASSET, not a hardcoded string).
 *
 * Every system/user prompt the AI kernel uses ships as a versioned entry
 * (PROMPT_DEFAULTS below) and is materialized into the vault on first access:
 *
 *     <vault>/.workspacegraph/prompts/prompts.json
 *
 * The file is a full snapshot users can fork and edit. Resolution rule: a file
 * entry is used only when its `version` is >= the shipped default version —
 * a stale fork (lower version) silently falls back to the updated default, so
 * the product can evolve prompts without breaking user edits forever.
 *
 * Templates support {{placeholder}} tokens filled at render time:
 *   - {{date}}      → today (YYYY-MM-DD)
 *   - {{workspace}} → vault folder name
 *   - {{tools}}     → numbered tool list (toolsHead, injected by AgentTools)
 *   - any caller-supplied var, e.g. renderPrompt('kernel', { model })
 * Unknown tokens are left intact (never silently stripped).
 */
import fs from 'fs'
import path from 'path'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { atomicWriteJson } from '../utils/quarantine'

export type PromptId = 'kernel' | 'bootstrap' | 'toolsHead' | 'toolsTail' | 'planMode' | 'subAgent'

/** M3 AI-11/14: prompt categories per spec 19 */
export type PromptCategory =
  | 'system'
  | 'user'
  | 'writing'
  | 'research'
  | 'knowledge'
  | 'project'
  | 'task'
  | 'search'
  | 'automation'
  | 'agent'

export interface PromptEntry {
  version: number
  category: PromptCategory
  template: string
  /** M3 AI-11: human-readable name */
  name?: string
  /** M3 AI-11: author of the prompt */
  author?: string
  /** M3 AI-11: what the prompt does */
  description?: string
  /** M3 AI-11/13: lifecycle status */
  status?: 'active' | 'deprecated' | 'draft'
  /** M3 AI-11: last updated ISO date */
  lastUpdated?: string
}

const nowIsoDate = (): string => new Date().toISOString().split('T')[0]

/** Shipped defaults — the single source of truth for prompt TEXT. */
export const PROMPT_DEFAULTS: Record<PromptId, PromptEntry> = {
  kernel: {
    version: 1,
    category: 'system',
    name: '',
    author: 'WorkspaceGraph',
    status: 'active' as const,
    template: `## WorkspaceGraph AI Kernel

You are the **workspace kernel assistant** — not a generic chatbot.
- Long-term memory lives in Markdown under **AI Memory/** (+ domain notes). Graph edges grow via [[wikilinks]].
- On every task: prefer reading AI Memory first, then search/graph domain notes.
- After discovering a new durable pattern, propose updating AI Memory (append/write) so future tasks get smarter.
- Never invent vault facts. If memory is empty, say so and offer bootstrap ("Pelajari workspace").
- Write tools create **proposals**; user confirms Apply before disk write.
- Output clear Markdown with [[WikiLinks]] when referencing notes.`.trim()
  },
  bootstrap: {
    version: 1,
    category: 'user',
    name: '',
    author: 'WorkspaceGraph',
    status: 'active' as const,
    template: `Mode: **PELAJARI WORKSPACE** (bootstrap memori).

Tugasmu:
1. Pakai tools: \`list_dir\` (root + folder penting), \`search\`, \`read_note\` untuk memahami struktur vault.
2. Baca dulu catatan di folder \`AI Memory/\` (index + cara kerja).
3. Isi / perbarui memori lewat **write_note** atau **append_note** (proposal — user akan Apply):
   - \`AI Memory/Cara Kerja.md\` — struktur folder, alur rutin
   - \`AI Memory/Aturan.md\` — aturan / larangan
   - \`AI Memory/Pola & Naming.md\` — naming & template
   - \`AI Memory/Glossary.md\` — istilah
   - \`AI Memory/00 Index.md\` — pastikan wikilink ke memori + domain penting
   - \`AI Memory/Log Ingest.md\` — append log tanggal {{date}}
4. Pakai **[[wikilink]]** antar note supaya graph memadat.
5. Jangan invent data yang tidak ada di vault. Jika kosong, catat "belum ada / TBD".
6. Akhiri dengan ringkasan: apa yang dipelajari + proposal apa yang dibuat.

Mulai sekarang: list_dir root, lalu baca AI Memory/00 Index.md.`
  },
  toolsHead: {
    version: 1,
    category: 'system',
    name: '',
    author: 'WorkspaceGraph',
    status: 'active' as const,
    template: `
## Workspace Tools (AI Kernel)

You MAY call tools by emitting one or more fenced blocks. Use EXACTLY this format:

\`\`\`wg-action
{"tool":"search","args":{"query":"cara kerja","limit":5}}
\`\`\`

Available tools:
{{tools}}`
  },
  toolsTail: {
    version: 1,
    category: 'system',
    name: '',
    author: 'WorkspaceGraph',
    status: 'active' as const,
    template: `

Memory / graph rules:
- Long-term how-to memory lives in **AI Memory/**. Read it early; update it when you learn durable patterns.
- Use [[wikilinks]] between memory + domain notes so the **graph densifies** as the workspace gets smarter.
- Prefer search + read_note before inventing vault facts (Law 006).
- Writes create proposals — user must Apply before disk write.
- Paths: vault-relative (AI Memory/..., Knowledge/..., Daily/...).
- After tool results, continue answering. Do not invent tool results.
- Finish with a clear Markdown summary + [[WikiLinks]].`
  },
  planMode: {
    version: 1,
    category: 'system',
    name: '',
    author: 'WorkspaceGraph',
    status: 'active' as const,
    template: `[PLAN MODE — R1-3]
Anda dalam PLAN MODE: JANGAN panggil tool tulis (write_note/append_note/create_note/create_from_template) atau MCP write.
Kerjakan: (1) ANALISIS singkat situasi, (2) daftar LANGKAH implementasi bernomor, (3) panggil create_plan {title, goal, steps} sebagai langkah TERAKHIR agar rencana menjadi proposal yang bisa ditinjau user.
Tulis seluruh analisis SEBELUM create_plan — stream berhenti setelah proposal plan dibuat.`
  },
  subAgent: {
    version: 1,
    category: 'system',
    name: '',
    author: 'WorkspaceGraph',
    status: 'active' as const,
    template: `[Sub-agent — {{role}}]
Anda adalah sub-agent dengan peran "{{role}}" yang didelegasikan oleh agent utama. Selesaikan tugas di atas menggunakan tool yang tersedia. Balas HANYA dengan hasil kerja Anda — tanpa basa-basi, tanpa mengulang isi tugas.`
  }
}

export const PROMPT_IDS: PromptId[] = [
  'kernel',
  'bootstrap',
  'toolsHead',
  'toolsTail',
  'planMode',
  'subAgent'
]

export function promptsDir(root: string): string {
  return path.join(root, '.workspacegraph', 'prompts')
}

export function promptsFilePath(root: string): string {
  return path.join(promptsDir(root), 'prompts.json')
}

/**
 * M3 AI-13: save a version snapshot before overwriting — enables rollback.
 * Snapshots stored as prompts.history.json (bounded to last 10 versions per id).
 */
export function snapshotPromptHistory(root: string, id: PromptId, entry: PromptEntry): void {
  const histFile = path.join(promptsDir(root), 'prompts.history.json')
  let history: Record<string, PromptEntry[]> = {}
  try {
    if (fs.existsSync(histFile)) {
      history = JSON.parse(fs.readFileSync(histFile, 'utf-8'))
    }
  } catch {
    /* corrupt history → fresh */
  }
  if (!history[id]) history[id] = []
  history[id].push({ ...entry, lastUpdated: new Date().toISOString() })
  // Keep last 10 versions per prompt
  if (history[id].length > 10) history[id] = history[id].slice(-10)
  try {
    atomicWriteJson(histFile, history)
  } catch {
    /* best-effort */
  }
}

/** M3 AI-13: list version snapshots for a prompt id. */
export function getPromptHistory(root: string, id: PromptId): PromptEntry[] {
  const histFile = path.join(promptsDir(root), 'prompts.history.json')
  try {
    if (!fs.existsSync(histFile)) return []
    const all = JSON.parse(fs.readFileSync(histFile, 'utf-8'))
    return all[id] || []
  } catch {
    return []
  }
}

/**
 * Resolve the effective entries for a vault. Merges the file snapshot over the
 * shipped defaults, using a file entry only when its version is >= the default.
 * Missing file → materialized from defaults. Corrupt/unreadable → defaults.
 *
 * No caching on purpose: the file is tiny, renders happen once per stream, and
 * reading every time means a user edit to prompts.json applies on the very next
 * message (no staleness, no mtime-granularity flakiness).
 */
export function loadPromptEntries(root?: string | null): Record<PromptId, PromptEntry> {
  const out: Record<PromptId, PromptEntry> = { ...PROMPT_DEFAULTS }
  if (!root) return out
  const file = promptsFilePath(root)
  try {
    if (!fs.existsSync(file)) {
      // Materialize once — prompts are visible, editable assets (like AI Memory).
      // AD-3: atomic write (same pattern as settings/recent) — a crash mid-write
      // leaves the previous file intact instead of a truncated prompts.json.
      fs.mkdirSync(promptsDir(root), { recursive: true })
      atomicWriteJson(file, PROMPT_DEFAULTS)
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<
      Record<PromptId, PromptEntry>
    >
    for (const id of PROMPT_IDS) {
      const e = parsed[id]
      if (
        e &&
        typeof e.template === 'string' &&
        typeof e.version === 'number' &&
        e.version >= PROMPT_DEFAULTS[id].version
      ) {
        out[id] = e
      }
    }
    return out
  } catch {
    return out // corrupt / unreadable → defaults, never crash a stream
  }
}

/**
 * Render a prompt template with {{placeholders}} filled at runtime.
 * `root` defaults to the current vault (null when none is open → defaults).
 */
export function renderPrompt(
  id: PromptId,
  vars: Record<string, string> = {},
  root?: string | null
): string {
  const r = root === undefined ? workspaceEngine.getState().rootPath : root
  const entry = loadPromptEntries(r)[id] || PROMPT_DEFAULTS[id]
  const builtins: Record<string, string> = {
    date: nowIsoDate(),
    workspace: r ? path.basename(r) : ''
  }
  const merged = { ...builtins, ...vars }
  return entry.template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(merged, key) ? String(merged[key]) : m
  )
}
