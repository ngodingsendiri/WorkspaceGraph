/**
 * Workspace Memory (L1) — Markdown notes the AI grows as it learns a vault.
 * SoT = vault files under AI Memory/ (graph + search = RAG surface).
 */
import fs from 'fs'
import path from 'path'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { isPathInVault } from '../security/PathSandbox'
import { renderPrompt } from './PromptRegistry'

export const AI_MEMORY_DIR = 'AI Memory'

export const AI_MEMORY_FILES = {
  index: '00 Index.md',
  caraKerja: 'Cara Kerja.md',
  aturan: 'Aturan.md',
  pola: 'Pola & Naming.md',
  glossary: 'Glossary.md',
  logIngest: 'Log Ingest.md'
} as const

const nowIsoDate = (): string => new Date().toISOString().split('T')[0]

function memoryRoot(vaultRoot: string): string {
  return path.join(vaultRoot, AI_MEMORY_DIR)
}

function fileAbs(vaultRoot: string, name: string): string {
  return path.join(memoryRoot(vaultRoot), name)
}

export function getAiMemoryDir(vaultRoot: string | null | undefined): string | null {
  if (!vaultRoot) return null
  return memoryRoot(vaultRoot)
}

export function listAiMemoryPaths(vaultRoot: string | null | undefined): string[] {
  if (!vaultRoot) return []
  const dir = memoryRoot(vaultRoot)
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > 3) return
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.name.toLowerCase().endsWith('.md')) out.push(full)
    }
  }
  walk(dir, 0)
  // Prefer index first
  out.sort((a, b) => {
    const an = path.basename(a).startsWith('00') ? 0 : 1
    const bn = path.basename(b).startsWith('00') ? 0 : 1
    if (an !== bn) return an - bn
    return a.localeCompare(b)
  })
  return out
}

function seedIndex(): string {
  const d = nowIsoDate()
  return `---
title: AI Memory Index
type: ai-memory
created: ${d}
updated: ${d}
tags: [ai-memory, index]
---

# AI Memory — Index

Hub memori cara kerja workspace ini. AI Worker dan Context Engine memprioritaskan folder ini.

## Catatan inti

- [[AI Memory/Cara Kerja|Cara Kerja]]
- [[AI Memory/Aturan|Aturan]]
- [[AI Memory/Pola & Naming|Pola & Naming]]
- [[AI Memory/Glossary|Glossary]]
- [[AI Memory/Log Ingest|Log Ingest]]

## Domain (isi seiring belajar)

<!-- AI / user: tambah wikilink ke note domain di sini -->

## Prinsip

1. Markdown = source of truth.
2. Jangan invent data vault — catat hanya yang terverifikasi.
3. Setiap pola baru → update note memori + wikilink.
4. Graph tumbuh dari [[wikilink]] antar memori dan domain.
`
}

function seedCaraKerja(): string {
  const d = nowIsoDate()
  return `---
title: Cara Kerja
type: ai-memory
created: ${d}
updated: ${d}
tags: [ai-memory, workflow]
---

# Cara Kerja

Ringkasan alur kerja di workspace ini (diisi AI saat *Pelajari workspace* / kerja harian).

## Struktur folder

<!-- map folder penting -->

## Alur rutin

<!-- langkah berulang -->

## Preferensi user

<!-- tone, bahasa, format output -->
`
}

function seedAturan(): string {
  const d = nowIsoDate()
  return `---
title: Aturan
type: ai-memory
created: ${d}
updated: ${d}
tags: [ai-memory, rules]
---

# Aturan

Aturan keras / SOP ringkas yang AI harus patuhi di vault ini.

## Larangan

-

## Wajib

-

## Sumber

<!-- link ke Rules/, SOP/, Sidebrain bila ada -->
`
}

function seedPola(): string {
  const d = nowIsoDate()
  return `---
title: Pola & Naming
type: ai-memory
created: ${d}
updated: ${d}
tags: [ai-memory, naming]
---

# Pola & Naming

## Penamaan file

\`\`\`
[Jenis] [Nama] YYYYMMDD - YYYYMMDD.ext
\`\`\`

## Template yang dipakai

-

## Pola frontmatter

-
`
}

function seedGlossary(): string {
  const d = nowIsoDate()
  return `---
title: Glossary
type: ai-memory
created: ${d}
updated: ${d}
tags: [ai-memory, glossary]
---

# Glossary

| Istilah | Arti |
|---------|------|
| | |
`
}

function seedLog(): string {
  const d = nowIsoDate()
  return `---
title: Log Ingest
type: ai-memory
created: ${d}
updated: ${d}
tags: [ai-memory, log]
---

# Log Ingest

Catatan kapan AI mempelajari workspace / update memori.

## ${d}

- Scaffold AI Memory dibuat.
`
}

const SEEDERS: Record<string, () => string> = {
  [AI_MEMORY_FILES.index]: seedIndex,
  [AI_MEMORY_FILES.caraKerja]: seedCaraKerja,
  [AI_MEMORY_FILES.aturan]: seedAturan,
  [AI_MEMORY_FILES.pola]: seedPola,
  [AI_MEMORY_FILES.glossary]: seedGlossary,
  [AI_MEMORY_FILES.logIngest]: seedLog
}

export interface EnsureMemoryResult {
  ok: boolean
  created: string[]
  existing: string[]
  dir?: string
  error?: string
}

/**
 * Create AI Memory/ + seed notes if missing. Safe to call repeatedly.
 */
export function ensureAiMemoryScaffold(vaultRoot: string | null | undefined): EnsureMemoryResult {
  if (!vaultRoot) return { ok: false, created: [], existing: [], error: 'No workspace open' }
  try {
    const dir = memoryRoot(vaultRoot)
    if (!isPathInVault(dir, vaultRoot)) {
      return { ok: false, created: [], existing: [], error: 'Path outside vault' }
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const created: string[] = []
    const existing: string[] = []
    for (const [name, seeder] of Object.entries(SEEDERS)) {
      const abs = fileAbs(vaultRoot, name)
      if (fs.existsSync(abs)) {
        existing.push(path.relative(vaultRoot, abs).replace(/\\/g, '/'))
        continue
      }
      workspaceEngine.writeFile(abs, seeder())
      created.push(path.relative(vaultRoot, abs).replace(/\\/g, '/'))
    }
    return {
      ok: true,
      created,
      existing,
      dir: path.relative(vaultRoot, dir).replace(/\\/g, '/')
    }
  } catch (err) {
    return {
      ok: false,
      created: [],
      existing: [],
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Relative paths of core memory notes that exist */
export function getCoreMemoryRelPaths(vaultRoot: string | null | undefined): string[] {
  if (!vaultRoot) return []
  const out: string[] = []
  for (const name of Object.values(AI_MEMORY_FILES)) {
    const abs = fileAbs(vaultRoot, name)
    if (fs.existsSync(abs)) {
      out.push(path.relative(vaultRoot, abs).replace(/\\/g, '/'))
    }
  }
  return out
}

export const BOOTSTRAP_USER_PROMPT = renderPrompt('bootstrap')

// Derived from the Prompt Registry (doc 19) — the kernel is a versioned prompt
// asset, overridable per vault via .workspacegraph/prompts/prompts.json. At
// module load no vault is open, so this const carries the shipped default;
// AIMiddleware re-renders per stream (renderPrompt) so a vault override applies.
export const KERNEL_SYSTEM_PROMPT = renderPrompt('kernel')
