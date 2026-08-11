import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { TemplateEngine } from './TemplateEngine'

describe('TemplateEngine', () => {
  let engine: TemplateEngine
  let workspace: string

  beforeEach(() => {
    engine = new TemplateEngine()
    workspace = fs.mkdtempSync(path.join(tmpdir(), 'wg-tpl-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(workspace, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  describe('builtins', () => {
    it('provides project/task/people domain templates', () => {
      const ids = engine.getBuiltinTemplates().map((t) => t.id)
      expect(ids).toContain('builtin-project')
      expect(ids).toContain('builtin-task')
      expect(ids).toContain('builtin-people')
      expect(ids).toContain('builtin-knowledge')
      expect(ids).toContain('builtin-daily')
      expect(ids).toContain('builtin-sop')
      expect(ids).toContain('builtin-document')
      expect(ids).toContain('builtin-meeting')
    })

    it('marks builtins as builtin: true', () => {
      const t = engine.getTemplate('builtin-knowledge', null)
      expect(t?.builtin).toBe(true)
      expect(t?.kind).toBe('knowledge')
    })
  })

  describe('render variables', () => {
    it('substitutes {{title}} {{date}} and unknown vars empty', () => {
      const body = 'title: {{title}}\ndate: {{date}}\nmissing: {{nope}}'
      const out = engine.render(body, { title: 'Hello', date: '2026-07-22' })
      expect(out).toContain('title: Hello')
      expect(out).toContain('date: 2026-07-22')
      expect(out).toContain('missing: ')
    })

    it('supports spaces in braces {{ title }}', () => {
      const out = engine.render('# {{ title }}', { title: 'Spaced' })
      expect(out).toContain('# Spaced')
    })

    it('falls back to defaults for title/filename', () => {
      const out = engine.render('{{title}}|{{filename}}', {})
      expect(out).toContain('Untitled')
    })

    it('renders by id from builtin', () => {
      const out = engine.renderById('builtin-project', workspace, { title: 'Proyek X' })
      expect(out).toContain('title: Proyek X')
      expect(out).toContain('type: project')
    })

    it('returns null for unknown id', () => {
      expect(engine.renderById('nope', workspace, {})).toBeNull()
    })
  })

  describe('F-4 regression — frontmatter survives template create', () => {
    it('every builtin renders with the full frontmatter block (type/created kept)', () => {
      for (const t of engine.getBuiltinTemplates()) {
        const out = engine.renderById(t.id, workspace, { title: 'Note X', date: '2026-07-22' })
        expect(out, `${t.id} should render`).not.toBeNull()
        // File content must START with the frontmatter fence — the F-4 finding
        // claimed created files lost it (opened with bare "# Title").
        expect(out!.startsWith('---'), `${t.id} keeps leading frontmatter`).toBe(true)
        expect(out!, `${t.id} keeps type:`).toContain('type:')
        // Timestamp field is `created:` on most, `date:` on daily — either must survive
        expect(out!.match(/\n(created|date):/), `${t.id} keeps its date field`).not.toBeNull()
      }
    })

    it('create-note composition (title/filename/workspace vars) keeps frontmatter', () => {
      const content = engine.renderById('builtin-project', workspace, {
        title: 'ProyekUji',
        filename: 'ProyekUji',
        workspace: 'test-vault'
      })
      expect(content).not.toBeNull()
      expect(content!.startsWith('---')).toBe(true)
      expect(content).toContain('title: ProyekUji')
      expect(content).toContain('type: project')
      expect(content).toContain('status: planning')
      // No unrendered placeholder left in the frontmatter block
      expect(content).not.toMatch(/\{\{\s*(title|filename|date|workspace)\s*\}\}/)
    })
  })

  describe('vault templates', () => {
    it('lists user templates from Templates/*.md', () => {
      fs.mkdirSync(path.join(workspace, 'Templates'), { recursive: true })
      fs.writeFileSync(
        path.join(workspace, 'Templates', 'Custom.md'),
        '---\ntitle: {{title}}\ntype: project\n---\n# {{title}}'
      )
      const list = engine.listTemplates(workspace)
      const user = list.find((t) => t.id === 'user-custom')
      expect(user).toBeDefined()
      expect(user?.builtin).toBe(false)
      expect(user?.kind).toBe('project')
    })

    it('returns builtins only when no workspace', () => {
      const list = engine.listTemplates(null)
      expect(list.every((t) => t.builtin)).toBe(true)
    })

    it('seeds builtins into vault Templates/', () => {
      const n = engine.seedBuiltinToVault(workspace)
      expect(n).toBe(engine.getBuiltinTemplates().length)
      const dir = fs.readdirSync(path.join(workspace, 'Templates'))
      expect(dir.some((f) => f.endsWith('.md'))).toBe(true)
      // Idempotent — second seed writes nothing new
      expect(engine.seedBuiltinToVault(workspace)).toBe(0)
    })

    it('F-3: seeded builtin files do NOT duplicate the builtin list', () => {
      // openWorkspace seeds Templates/*.md named after the builtins
      engine.seedBuiltinToVault(workspace)
      const list = engine.listTemplates(workspace)
      expect(list.length).toBe(engine.getBuiltinTemplates().length)
      expect(list.filter((t) => t.builtin).length).toBe(engine.getBuiltinTemplates().length)
      // no user-* entries shadowing the seeded builtins
      expect(list.some((t) => t.id.startsWith('user-'))).toBe(false)
    })

    it('F-3: a genuinely custom template is still listed', () => {
      fs.mkdirSync(path.join(workspace, 'Templates'), { recursive: true })
      fs.writeFileSync(path.join(workspace, 'Templates', 'My-Custom.md'), '# {{title}}\n')
      const list = engine.listTemplates(workspace)
      const custom = list.find((t) => t.id === 'user-my-custom')
      expect(custom).toBeDefined()
      expect(custom?.builtin).toBe(false)
    })

    it('caches the user template list until a file changes — WB-6', () => {
      fs.mkdirSync(path.join(workspace, 'Templates'), { recursive: true })
      fs.writeFileSync(path.join(workspace, 'Templates', 'A.md'), '# A\n')
      const l1 = engine.listTemplates(workspace)
      const l2 = engine.listTemplates(workspace)
      expect(l1).toBe(l2) // cache hit — same array, no re-read of the dir/files

      // Edit in place — signature changes via mtime + size, cache rebuilt.
      fs.writeFileSync(path.join(workspace, 'Templates', 'A.md'), '# B\nchanged body\n')
      const l3 = engine.listTemplates(workspace)
      expect(l3).not.toBe(l1)
      expect(l3.find((t) => t.id === 'user-a')?.body).toContain('changed body')
    })

    it('invalidates the cache when a template file is added — WB-6', () => {
      fs.mkdirSync(path.join(workspace, 'Templates'), { recursive: true })
      fs.writeFileSync(path.join(workspace, 'Templates', 'A.md'), '# A\n')
      const l1 = engine.listTemplates(workspace)
      fs.writeFileSync(path.join(workspace, 'Templates', 'B.md'), '# B\n')
      const l2 = engine.listTemplates(workspace)
      expect(l2).not.toBe(l1)
      expect(l2.some((t) => t.id === 'user-b')).toBe(true)
    })

    it('classifies from frontmatter type + filename, never body prose — WB-11', () => {
      fs.mkdirSync(path.join(workspace, 'Templates'), { recursive: true })
      // Prose mentions "project" but neither name nor frontmatter type do.
      fs.writeFileSync(
        path.join(workspace, 'Templates', 'Generic.md'),
        '---\ntitle: {{title}}\n---\n# {{title}}\n\nProyek ini adalah project besar yang perlu dikelola.\n'
      )
      const generic = engine.listTemplates(workspace).find((t) => t.id === 'user-generic')
      expect(generic?.kind).toBe('custom') // NOT 'project' — prose is ignored

      // Frontmatter type wins over a generic filename.
      fs.writeFileSync(
        path.join(workspace, 'Templates', 'Notes.md'),
        '---\ntitle: {{title}}\ntype: task\n---\n# {{title}}\n'
      )
      const notes = engine.listTemplates(workspace).find((t) => t.id === 'user-notes')
      expect(notes?.kind).toBe('task')

      // Filename convention when there is no frontmatter type.
      fs.writeFileSync(path.join(workspace, 'Templates', 'Meeting-Notes.md'), '# {{title}}\n')
      const meeting = engine.listTemplates(workspace).find((t) => t.id === 'user-meeting-notes')
      expect(meeting?.kind).toBe('meeting')
    })
  })

  describe('helpers', () => {
    it('folderForKind maps kinds', () => {
      expect(engine.folderForKind('project')).toBe('Projects')
      expect(engine.folderForKind('task')).toBe('Tasks')
      expect(engine.folderForKind('people')).toBe('People')
      expect(engine.folderForKind('daily')).toBe('Daily')
      expect(engine.folderForKind('sop')).toBe('SOP')
      expect(engine.folderForKind('knowledge')).toBe('Knowledge')
    })

    it('suggestTemplateId maps kind to builtin id', () => {
      expect(engine.suggestTemplateId('project')).toBe('builtin-project')
      expect(engine.suggestTemplateId('meeting')).toBe('builtin-meeting')
    })
  })
})
