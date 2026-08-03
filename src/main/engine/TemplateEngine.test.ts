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
    } catch {}
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
