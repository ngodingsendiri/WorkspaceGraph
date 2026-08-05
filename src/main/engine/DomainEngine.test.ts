import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { DomainEngine, parseCheckboxes } from './DomainEngine'
import { MarkdownEngine, type ParsedMarkdown } from './MarkdownEngine'

describe('DomainEngine', () => {
  let engine: DomainEngine
  let md: MarkdownEngine

  beforeEach(() => {
    engine = new DomainEngine()
    md = new MarkdownEngine()
  })

  const parse = (rel: string, content: string, vault: string): ParsedMarkdown => {
    return md.parseFile(path.join(vault, rel), content, vault)
  }

  describe('parseCheckboxes', () => {
    it('parses open/done/X checkboxes with line numbers', () => {
      const sample = `# Task\n\n- [ ] Open item\n- [x] Done item\n- [X] Also done\n`
      const boxes = parseCheckboxes(sample, 'T', '/t.md')
      expect(boxes).toHaveLength(3)
      expect(boxes.filter((b) => !b.done)).toHaveLength(1)
      expect(boxes.filter((b) => b.done)).toHaveLength(2)
      expect(boxes[0].text).toBe('Open item')
      expect(boxes[0].line).toBe(3)
      expect(boxes[1].done).toBe(true)
    })

    it('returns empty for no checkboxes', () => {
      expect(parseCheckboxes('plain text', 'T', '/t.md')).toHaveLength(0)
    })
  })

  describe('getOverview', () => {
    it('groups by type and counts checkboxes', () => {
      const vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-domain-'))
      try {
        const files = [
          parse(
            'Projects/P1.md',
            '---\ntype: project\nstatus: active\n---\n# P1\n- [ ] Task 1\n',
            vault
          ),
          parse(
            'Tasks/T1.md',
            '---\ntype: task\nstatus: todo\npriority: high\n---\n# T1\n- [x] done\n',
            vault
          ),
          parse('People/Orang.md', '---\ntype: people\n---\n# Orang\n', vault),
          parse('Knowledge/K1.md', '---\ntype: knowledge\n---\n# K1\n', vault)
        ]
        engine.setParsedFiles(files)
        const o = engine.getOverview()
        expect(o.projects).toHaveLength(1)
        expect(o.tasks).toHaveLength(1)
        expect(o.people).toHaveLength(1)
        expect(o.knowledge).toHaveLength(1)
        expect(o.counts.projects).toBe(1)
        expect(o.counts.tasks).toBe(1)
        expect(o.counts.openCheckboxes).toBe(1)
        expect(o.projectsByStatus['active']).toBe(1)
        expect(o.tasksByPriority['high']).toBe(1)
        expect(o.tasksByStatus['todo']).toBe(1)
      } finally {
        fs.rmSync(vault, { recursive: true, force: true })
      }
    })

    it('infers type from folder when no frontmatter type', () => {
      const vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-domain2-'))
      try {
        const files = [
          parse('Projects/XP.md', '# XP\n', vault),
          parse('Tasks/YT.md', '# YT\n', vault),
          parse('Daily/2026-07-22.md', '# Hari\n', vault)
        ]
        engine.setParsedFiles(files)
        const o = engine.getOverview()
        expect(o.projects.some((p) => p.title === 'XP')).toBe(true)
        expect(o.tasks.some((t) => t.title === 'YT')).toBe(true)
      } finally {
        fs.rmSync(vault, { recursive: true, force: true })
      }
    })

    it('listByType returns per-type items', () => {
      const vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-domain3-'))
      try {
        engine.setParsedFiles([
          parse('Projects/A.md', '# A\n', vault),
          parse('Tasks/B.md', '# B\n', vault)
        ])
        expect(engine.listByType('project')).toHaveLength(1)
        expect(engine.listByType('task')).toHaveLength(1)
        expect(engine.listByType('people')).toHaveLength(0)
      } finally {
        fs.rmSync(vault, { recursive: true, force: true })
      }
    })

    it('clear resets cache', () => {
      const vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-domain4-'))
      try {
        engine.setParsedFiles([parse('Projects/A.md', '# A\n', vault)])
        engine.clear()
        expect(engine.getOverview().projects).toHaveLength(0)
      } finally {
        fs.rmSync(vault, { recursive: true, force: true })
      }
    })
  })
})
