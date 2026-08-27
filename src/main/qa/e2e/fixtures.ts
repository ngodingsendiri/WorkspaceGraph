import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * Build a minimal disposable vault fixture on disk so the E2E test can open a
 * real, populated workspace without touching the user's data. Uses the standard
 * WorkspaceGraph layout (Knowledge/, Daily/, Projects/, People/) so graph + file
 * tree assertions behave like production.
 */
export function createVaultFixture(baseDir = path.join(os.tmpdir(), 'wg-e2e-vault')): string {
  const root = path.join(baseDir, `vault-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const folders = ['Knowledge', 'Daily', 'Projects', 'People', 'Templates']
  for (const f of folders) fs.mkdirSync(path.join(root, f), { recursive: true })

  const now = new Date().toISOString().split('T')[0]
  const write = (rel: string, content: string): void => {
    fs.writeFileSync(path.join(root, rel), content, 'utf-8')
  }

  write(
    'Knowledge/Alpha.md',
    `---
title: Alpha
type: knowledge
created: ${now}
tags: [alpha, e2e]
---

# Alpha

Link ke [[Beta]] dan tag #alpha.
`
  )
  write(
    'Knowledge/Beta.md',
    `---
title: Beta
type: knowledge
created: ${now}
tags: [beta, e2e]
---

# Beta

Backlink ke [[Alpha]].
`
  )
  write(
    'Daily/2026-08-27.md',
    `---
title: 2026-08-27
type: daily
date: 2026-08-27
---

# 2026-08-27

- [ ] E2E checklist
`
  )
  write(
    'Projects/Demo.md',
    `---
title: Demo
type: project
status: in_progress
created: ${now}
---

# Demo

Project node untuk E2E.
`
  )
  return root
}

export function cleanupVaultFixture(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}