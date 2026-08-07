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

export type PromptId = 'kernel' | 'bootstrap' | 'toolsHead' | 'toolsTail'
export type PromptCategory = 'system' | 'user'

export interface PromptEntry {
  version: number
  category: PromptCategory
  template: string
}

const nowIsoDate = (): string => new Date().toISOString().split('T')[0]

/** Shipped defaults — the single source of truth for prompt TEXT. */
export const PROMPT_DEFAULTS: Record<PromptId, PromptEntry> = {
  kernel: {
    version: 1,
    category: 'system',
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
    template: `

Memory / graph rules:
- Long-term how-to memory lives in **AI Memory/**. Read it early; update it when you learn durable patterns.
- Use [[wikilinks]] between memory + domain notes so the **graph densifies** as the workspace gets smarter.
- Prefer search + read_note before inventing vault facts (Law 006).
- Writes create proposals — user must Apply before disk write.
- Paths: vault-relative (AI Memory/..., Knowledge/..., Daily/...).
- After tool results, continue answering. Do not invent tool results.
- Finish with a clear Markdown summary + [[WikiLinks]].`
  }
}

export const PROMPT_IDS: PromptId[] = ['kernel', 'bootstrap', 'toolsHead', 'toolsTail']

export function promptsDir(root: string): string {
  return path.join(root, '.workspacegraph', 'prompts')
}

export function promptsFilePath(root: string): string {
  return path.join(promptsDir(root), 'prompts.json')
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
      // Materialize once — prompts are visible, editable assets (like AI Memory)
      fs.mkdirSync(promptsDir(root), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(PROMPT_DEFAULTS, null, 2), 'utf-8')
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
