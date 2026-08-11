/**
 * Template System (Phase 4 / blueprint 15)
 * Built-in + vault Templates/*.md ; variables {{date}} {{title}} etc.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

/** "Project" == "project" == "Project.md" == "Daily Note" == "Daily-Note" */
function normalizeTemplateName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

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

/** WB-11: frontmatter `type:` values → template kind (person normalizes to people). */
const INFER_KIND_BY_TYPE: Record<string, TemplateKind> = {
  project: 'project',
  task: 'task',
  people: 'people',
  person: 'people',
  daily: 'daily',
  sop: 'sop',
  document: 'document',
  knowledge: 'knowledge',
  meeting: 'meeting'
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
  /**
   * WB-6: per-workspace cache of the user-template scan. Keyed by a signature
   * of dir file names + mtimes + sizes, so editing/adding/removing a template
   * file invalidates it, while repeated calls (list, renderById, AI context)
   * skip the directory read + full file reads.
   */
  private userTemplateCache = new Map<string, { sig: string; list: TemplateDef[] }>()

  getBuiltinTemplates(): TemplateDef[] {
    return BUILTIN.map((t) => ({ ...t, builtin: true }))
  }

  /** List builtin + user templates from Templates/*.md */
  listTemplates(workspaceRoot: string | null): TemplateDef[] {
    const list = this.getBuiltinTemplates()
    if (!workspaceRoot) {
      this.userTemplateCache.clear()
      return list
    }

    const dir = path.join(workspaceRoot, 'Templates')
    if (!fs.existsSync(dir)) {
      this.userTemplateCache.delete(workspaceRoot)
      return list
    }

    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.md'))
        .sort()
      let sig = `${files.length}:`
      for (const f of files) {
        const st = fs.statSync(path.join(dir, f))
        sig += `${f}|${st.mtimeMs}|${st.size};`
      }
      const cached = this.userTemplateCache.get(workspaceRoot)
      if (cached && cached.sig === sig) return cached.list

      // F-3 (testing 2026-08-11): the vault's Templates/ is SEEDED with the
      // builtin templates (WorkspaceEngine.initializeWorkspaceStructure), so
      // scanning those files as "user" templates duplicates every builtin in
      // the list (16 entries for 8 templates). A user template only counts as
      // custom when its name does NOT collide with a builtin — edited seeded
      // files keep working through their builtin entry.
      const builtinNames = new Set(
        this.getBuiltinTemplates().map((t) => normalizeTemplateName(t.name))
      )
      const user: TemplateDef[] = []
      for (const f of files) {
        const full = path.join(dir, f)
        const body = fs.readFileSync(full, 'utf-8')
        const name = path.basename(f, '.md')
        if (builtinNames.has(normalizeTemplateName(name))) continue
        const kind = this.inferKindFromName(name, body)
        user.push({
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
      const result = [...list, ...user]
      this.userTemplateCache.set(workspaceRoot, { sig, list: result })
      return result
    } catch {
      this.userTemplateCache.delete(workspaceRoot)
      return list
    }
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

  /** WB-11: the `type:` value from the YAML frontmatter block only (never prose). */
  private frontmatterType(body: string): string {
    if (!body.startsWith('---')) return ''
    const end = body.indexOf('\n---', 3)
    const fm = end === -1 ? body.slice(3) : body.slice(3, end)
    const m = fm.match(/^\s*type:\s*([a-zA-Z_-]+)/m)
    return m ? m[1].toLowerCase() : ''
  }

  /**
   * WB-11: classify from the frontmatter `type:` field first, then the file
   * NAME. Free body prose is no longer scanned — a template whose body merely
   * mentions "project" can no longer be misclassified.
   */
  private inferKindFromName(name: string, body: string): TemplateKind {
    const fromFm = INFER_KIND_BY_TYPE[this.frontmatterType(body)]
    if (fromFm) return fromFm
    const n = name.toLowerCase()
    if (/project|proyek/.test(n)) return 'project'
    if (/task|todo/.test(n)) return 'task'
    if (/person|people|kontak/.test(n)) return 'people'
    if (/daily|harian/.test(n)) return 'daily'
    if (/\bsop\b/.test(n)) return 'sop'
    if (/document|dokumen/.test(n)) return 'document'
    if (/meeting|rapat|notulen/.test(n)) return 'meeting'
    if (/knowledge|pengetahuan|catatan/.test(n)) return 'knowledge'
    return 'custom'
  }
}

export const templateEngine = new TemplateEngine()
