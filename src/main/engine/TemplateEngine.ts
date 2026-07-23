/**
 * Template System (Phase 4 / blueprint 15)
 * Built-in + vault Templates/*.md ; variables {{date}} {{title}} etc.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export type TemplateKind =
  'knowledge' | 'project' | 'task' | 'people' | 'daily' | 'sop' | 'document' | 'meeting' | 'custom'

export interface TemplateDef {
  id: string
  name: string
  kind: TemplateKind
  description: string
  /** Folder under vault for new notes */
  defaultFolder: string
  /** Relative path if from vault Templates/ */
  sourcePath?: string
  builtin: boolean
  body: string
}

export interface TemplateVars {
  title?: string
  date?: string
  time?: string
  datetime?: string
  uuid?: string
  filename?: string
  workspace?: string
  project?: string
  owner?: string
  [key: string]: string | undefined
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function nowTime(): string {
  return new Date().toTimeString().slice(0, 5)
}

function uid(): string {
  return crypto.randomBytes(4).toString('hex')
}

const BUILTIN: Omit<TemplateDef, 'builtin'>[] = [
  {
    id: 'builtin-knowledge',
    name: 'Knowledge Note',
    kind: 'knowledge',
    description: 'Catatan pengetahuan umum',
    defaultFolder: 'Knowledge',
    body: `---
title: {{title}}
type: knowledge
status: active
created: {{date}}
updated: {{date}}
tags: []
---

# {{title}}

## Summary


## Notes


## Links

- 
`
  },
  {
    id: 'builtin-project',
    name: 'Project',
    kind: 'project',
    description: 'Proyek dengan status & milestone',
    defaultFolder: 'Projects',
    body: `---
title: {{title}}
type: project
status: planning
owner: {{owner}}
start: {{date}}
target: 
tags: []
created: {{date}}
updated: {{date}}
---

# {{title}}

## Goal


## Scope


## Status

- [ ] Planning
- [ ] Active
- [ ] On Hold
- [ ] Completed

## Related Knowledge

- 

## Related Tasks

- [ ] 

## People

- 

## Notes

`
  },
  {
    id: 'builtin-task',
    name: 'Task',
    kind: 'task',
    description: 'Unit pekerjaan dengan prioritas',
    defaultFolder: 'Tasks',
    body: `---
title: {{title}}
type: task
status: todo
priority: medium
due: 
project: {{project}}
created: {{date}}
updated: {{date}}
tags: []
---

# {{title}}

## Description


## Checklist

- [ ] 

## Related

- Project: [[{{project}}]]
- Knowledge: 

## Log

- {{date}}: created
`
  },
  {
    id: 'builtin-people',
    name: 'Person',
    kind: 'people',
    description: 'Profil orang / rekan / kontak',
    defaultFolder: 'People',
    body: `---
title: {{title}}
type: people
role: 
organization: 
tags: []
created: {{date}}
updated: {{date}}
---

# {{title}}

## Role & Org


## Contact


## Related Projects

- 

## Related Knowledge

- 

## Notes

`
  },
  {
    id: 'builtin-daily',
    name: 'Daily Note',
    kind: 'daily',
    description: 'Catatan harian',
    defaultFolder: 'Daily',
    body: `---
title: {{date}}
type: daily
date: {{date}}
tags: [daily]
---

# {{date}}

## Focus

- [ ] 

## Notes


## Tasks

- [ ] 

## Links

- 
`
  },
  {
    id: 'builtin-sop',
    name: 'SOP',
    kind: 'sop',
    description: 'Prosedur operasional standar',
    defaultFolder: 'SOP',
    body: `---
title: {{title}}
type: sop
status: draft
owner: {{owner}}
created: {{date}}
updated: {{date}}
tags: [sop]
---

# {{title}}

## Tujuan


## Ruang Lingkup


## Definisi


## Prosedur

1. 
2. 
3. 

## Dokumen Terkait

- 

## Riwayat Perubahan

| Tanggal | Perubahan | Oleh |
|---------|-----------|------|
| {{date}} | Draft |  |
`
  },
  {
    id: 'builtin-document',
    name: 'Document Index',
    kind: 'document',
    description: 'Indeks dokumen / arsip',
    defaultFolder: 'Documents',
    body: `---
title: {{title}}
type: document
status: active
created: {{date}}
updated: {{date}}
tags: []
---

# {{title}}

## Deskripsi


## Lokasi File

- Path: 

## Related People

- 

## Related Projects

- 
`
  },
  {
    id: 'builtin-meeting',
    name: 'Meeting Note',
    kind: 'meeting',
    description: 'Notulen rapat',
    defaultFolder: 'Knowledge',
    body: `---
title: {{title}}
type: knowledge
subtype: meeting
date: {{date}}
attendees: []
tags: [meeting]
created: {{date}}
updated: {{date}}
---

# {{title}}

**Date:** {{date}} · **Time:** {{time}}

## Attendees

- 

## Agenda

1. 

## Notes


## Action Items

- [ ] 

## Links

- 
`
  }
]

export class TemplateEngine {
  getBuiltinTemplates(): TemplateDef[] {
    return BUILTIN.map((t) => ({ ...t, builtin: true }))
  }

  /** List builtin + user templates from Templates/*.md */
  listTemplates(workspaceRoot: string | null): TemplateDef[] {
    const list = this.getBuiltinTemplates()
    if (!workspaceRoot) return list

    const dir = path.join(workspaceRoot, 'Templates')
    if (!fs.existsSync(dir)) return list

    try {
      const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
      for (const f of files) {
        const full = path.join(dir, f)
        const body = fs.readFileSync(full, 'utf-8')
        const name = path.basename(f, '.md')
        const kind = this.inferKindFromName(name, body)
        list.push({
          id: `user-${name.toLowerCase().replace(/\s+/g, '-')}`,
          name,
          kind,
          description: `User template: Templates/${f}`,
          defaultFolder: this.folderForKind(kind),
          sourcePath: `Templates/${f}`,
          builtin: false,
          body
        })
      }
    } catch {
      /* ignore */
    }
    return list
  }

  getTemplate(id: string, workspaceRoot: string | null): TemplateDef | null {
    return this.listTemplates(workspaceRoot).find((t) => t.id === id) || null
  }

  render(templateBody: string, vars: TemplateVars = {}): string {
    const defaults: TemplateVars = {
      date: today(),
      time: nowTime(),
      datetime: new Date().toISOString(),
      uuid: uid(),
      title: vars.title || 'Untitled',
      filename: vars.filename || vars.title || 'Untitled',
      workspace: vars.workspace || '',
      project: vars.project || '',
      owner: vars.owner || ''
    }
    const merged = { ...defaults, ...vars }
    let out = templateBody
    // {{var}} and {{ var }}
    out = out.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
      const v = merged[key]
      return v !== undefined && v !== null ? String(v) : ''
    })
    return out
  }

  renderById(id: string, workspaceRoot: string | null, vars: TemplateVars = {}): string | null {
    const t = this.getTemplate(id, workspaceRoot)
    if (!t) return null
    return this.render(t.body, vars)
  }

  /** Write seed templates into Templates/ if missing */
  seedBuiltinToVault(workspaceRoot: string): number {
    const dir = path.join(workspaceRoot, 'Templates')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    let n = 0
    for (const t of this.getBuiltinTemplates()) {
      const file = path.join(dir, `${t.name.replace(/\s+/g, '-')}.md`)
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, t.body, 'utf-8')
        n++
      }
    }
    return n
  }

  /** Suggest template id for AI / create when kind known */
  suggestTemplateId(kind: TemplateKind): string {
    return `builtin-${kind === 'meeting' ? 'meeting' : kind}`
  }

  folderForKind(kind: TemplateKind): string {
    switch (kind) {
      case 'project':
        return 'Projects'
      case 'task':
        return 'Tasks'
      case 'people':
        return 'People'
      case 'daily':
        return 'Daily'
      case 'sop':
        return 'SOP'
      case 'document':
        return 'Documents'
      case 'meeting':
      case 'knowledge':
      default:
        return 'Knowledge'
    }
  }

  private inferKindFromName(name: string, body: string): TemplateKind {
    const lower = (name + ' ' + body.slice(0, 200)).toLowerCase()
    if (lower.includes('type: project') || lower.includes('project')) return 'project'
    if (lower.includes('type: task') || lower.includes('task')) return 'task'
    if (lower.includes('type: people') || lower.includes('person')) return 'people'
    if (lower.includes('type: daily') || lower.includes('daily')) return 'daily'
    if (lower.includes('type: sop') || lower.includes('sop')) return 'sop'
    if (lower.includes('type: document') || lower.includes('document')) return 'document'
    if (lower.includes('meeting')) return 'meeting'
    return 'custom'
  }
}

export const templateEngine = new TemplateEngine()
