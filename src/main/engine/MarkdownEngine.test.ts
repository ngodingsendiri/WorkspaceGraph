import { describe, it, expect, beforeEach } from 'vitest'
import { MarkdownEngine } from './MarkdownEngine'

describe('MarkdownEngine', () => {
  let engine: MarkdownEngine

  beforeEach(() => {
    engine = new MarkdownEngine()
  })

  describe('parseFile', () => {
    it('parses frontmatter', () => {
      const content = `---\ntitle: My Note\ntags: [tag1, tag2]\n---\n\n# Content`
      const parsed = engine.parseFile('/vault/Note.md', content, '/vault')

      expect(parsed.frontmatter.title).toBe('My Note')
      expect(parsed.frontmatter.tags).toEqual(['tag1', 'tag2'])
    })

    it('extracts title from frontmatter', () => {
      const parsed = engine.parseFile(
        '/vault/Note.md',
        '---\ntitle: FM Title\n---\n# Content',
        '/vault'
      )
      expect(parsed.title).toBe('FM Title')
    })

    it('falls back to first H1 for title', () => {
      const parsed = engine.parseFile('/vault/Note.md', '# H1 Title\n\nContent', '/vault')
      expect(parsed.title).toBe('H1 Title')
    })

    it('falls back to filename for title', () => {
      const parsed = engine.parseFile('/vault/My Note.md', 'Just content', '/vault')
      expect(parsed.title).toBe('My Note')
    })

    it('extracts wiki links', () => {
      const content = `[[Link]] [[Link|Alias]] [[path/Link]] [[Link#Heading]] [[Link^block]]`
      const parsed = engine.parseFile('/vault/Note.md', content, '/vault')

      expect(parsed.wikiLinks).toHaveLength(5)
      expect(parsed.wikiLinks[0].target).toBe('Link')
      expect(parsed.wikiLinks[1].target).toBe('Link')
      expect(parsed.wikiLinks[1].alias).toBe('Alias')
      expect(parsed.wikiLinks[2].target).toBe('path/Link')
      expect(parsed.wikiLinks[3].target).toBe('Link')
      expect(parsed.wikiLinks[4].target).toBe('Link')
    })

    it('ignores wiki links in code fences', () => {
      const content = `\`\`\`\n[[NotALink]]\n\`\`\`\n\n[[RealLink]]`
      const parsed = engine.parseFile('/vault/Note.md', content, '/vault')
      expect(parsed.wikiLinks).toHaveLength(1)
      expect(parsed.wikiLinks[0].target).toBe('RealLink')
    })

    it('ignores wiki links in inline code', () => {
      const content = '`[[NotALink]]` and [[RealLink]]'
      const parsed = engine.parseFile('/vault/Note.md', content, '/vault')
      expect(parsed.wikiLinks).toHaveLength(1)
    })

    it('normalizes wiki link targets', () => {
      const parsed = engine.parseFile('/vault/Note.md', '[[Path/Link]]', '/vault')
      expect(parsed.wikiLinks[0].target).toBe('Path/Link')
    })

    it('extracts inline tags', () => {
      const content = '#tag1 #tag2/path #tag3'
      const parsed = engine.parseFile('/vault/Note.md', content, '/vault')
      expect(parsed.tags).toContain('tag1')
      expect(parsed.tags).toContain('tag2/path')
      expect(parsed.tags).toContain('tag3')
    })

    it('combines frontmatter and inline tags', () => {
      const content = `---\ntags: [fm-tag]\n---\n\n#inline-tag`
      const parsed = engine.parseFile('/vault/Note.md', content, '/vault')
      expect(parsed.tags).toContain('fm-tag')
      expect(parsed.tags).toContain('inline-tag')
    })

    it('deduplicates tags', () => {
      const content = `---\ntags: [dup]\n---\n\n#dup`
      const parsed = engine.parseFile('/vault/Note.md', content, '/vault')
      expect(parsed.tags.filter((t) => t === 'dup')).toHaveLength(1)
    })

    it('counts words', () => {
      const parsed = engine.parseFile('/vault/Note.md', 'one two three', '/vault')
      expect(parsed.wordCount).toBe(3)
    })

    it('extracts headings', () => {
      const content = `# H1\n## H2\n### H3`
      const parsed = engine.parseFile('/vault/Note.md', content, '/vault')
      expect(parsed.headings).toEqual([
        { level: 1, text: 'H1' },
        { level: 2, text: 'H2' },
        { level: 3, text: 'H3' }
      ])
    })

    it('ignores headings inside fenced code (``` and ~~~) — WA-5', () => {
      const content = `# Real\n\n\`\`\`\n# Fake in backtick fence\n\`\`\`\n\n~~~\n# Fake in tilde fence\n~~~\n\n## Real too`
      const parsed = engine.parseFile('/vault/Note.md', content, '/vault')
      expect(parsed.headings).toEqual([
        { level: 1, text: 'Real' },
        { level: 2, text: 'Real too' }
      ])
    })

    it('ignores #tags inside code (fenced + inline) — WA-4', () => {
      const content = `\`\`\`\n#ghost-tag\n\`\`\`\n\n\`#inline-ghost\`\n\n#real-tag`
      const parsed = engine.parseFile('/vault/Note.md', content, '/vault')
      expect(parsed.tags).toEqual(['real-tag'])
    })

    it('ignores #tags inside tilde fences — WA-4/WA-10', () => {
      const content = `~~~\n#tilde-ghost\n~~~\n\n#real-tag`
      const parsed = engine.parseFile('/vault/Note.md', content, '/vault')
      expect(parsed.tags).toEqual(['real-tag'])
    })

    it('normalizes CRLF line endings', () => {
      const content = '---\ntitle: Test\r\n---\r\n\r\n# Title\r\n'
      const parsed = engine.parseFile('/vault/Note.md', content, '/vault')
      expect(parsed.frontmatter.title).toBe('Test')
    })

    it('generates consistent ID from path (case-insensitive, normalized separators)', () => {
      const parsed1 = engine.parseFile('/vault/Note.md', '# Test', '/vault')
      const parsed2 = engine.parseFile('/vault/Note.md', '# Test', '/vault')
      expect(parsed1.id).toBe(parsed2.id)
      const parsed3 = engine.parseFile('C:/vault/Note.md', '# Test', 'C:/vault')
      const parsed4 = engine.parseFile('C:\\vault\\Note.md', '# Test', 'C:\\vault')
      expect(parsed3.id).toBe(parsed4.id)
    })

    it('light mode skips expensive scans', () => {
      const content = `# Title\n\n[[Link]] #tag\n\nContent`
      const parsed = engine.parseFile('/vault/Note.md', content, '/vault', { light: true })
      expect(parsed.wikiLinks).toHaveLength(0)
      expect(parsed.tags).toHaveLength(0)
      expect(parsed.wordCount).toBe(0)
      expect(parsed.headings).toHaveLength(0)
    })
  })

  describe('renderToHtml', () => {
    it('renders headings', () => {
      const html = engine.renderToHtml('# Heading')
      expect(html).toContain('<h1 id="heading">Heading</h1>')
    })

    it('renders bold and italic', () => {
      const html = engine.renderToHtml('**bold** *italic*')
      expect(html).toContain('<strong>bold</strong>')
      expect(html).toContain('<em>italic</em>')
    })

    it('renders code blocks', () => {
      const html = engine.renderToHtml('```js\nconst x = 1\n```')
      expect(html).toContain('<pre><code class="language-js">const x = 1</code></pre>')
    })

    it('renders tilde fenced code blocks — WA-10', () => {
      const html = engine.renderToHtml('~~~js\nconst x = 1\n~~~')
      expect(html).toContain('<pre><code class="language-js">const x = 1</code></pre>')
    })

    it('keeps wikilinks inside tilde fences literal — WA-10', () => {
      const html = engine.renderToHtml('~~~\n[[NotARender]]\n~~~')
      expect(html).not.toContain('wiki-link')
      expect(html).toContain('[[NotARender]]')
    })

    it('renders inline code', () => {
      const html = engine.renderToHtml('`code`')
      expect(html).toContain('<code>code</code>')
    })

    it('renders wiki links as spans', () => {
      const html = engine.renderToHtml('[[Link]]')
      expect(html).toContain('<span class="wiki-link" data-target="Link">Link</span>')
    })

    it('renders wiki links with alias', () => {
      const html = engine.renderToHtml('[[Link|Alias]]')
      expect(html).toContain('<span class="wiki-link" data-target="Link">Alias</span>')
    })

    it('renders GFM tables', () => {
      const content = `| A | B |\n|---|---|\n| 1 | 2 |`
      const html = engine.renderToHtml(content)
      expect(html).toContain('<table>')
      expect(html).toContain('<th>A</th>')
      expect(html).toContain('<td>1</td>')
    })

    it('renders task lists', () => {
      const content = '- [ ] Todo\n- [x] Done'
      const html = engine.renderToHtml(content)
      expect(html).toContain('task-list-item')
      expect(html).toContain('type="checkbox"')
      expect(html).toContain('checked')
    })

    it('renders strikethrough', () => {
      const html = engine.renderToHtml('~~strike~~')
      expect(html).toContain('<del>strike</del>')
    })

    it('renders highlights', () => {
      const html = engine.renderToHtml('==highlight==')
      expect(html).toContain('<mark>highlight</mark>')
    })

    it('renders blockquotes', () => {
      const html = engine.renderToHtml('> Quote')
      expect(html).toContain('<blockquote>')
    })

    it('renders horizontal rule', () => {
      const html = engine.renderToHtml('---')
      expect(html).toContain('<hr />')
    })

    it('renders ordered and unordered lists', () => {
      const html = engine.renderToHtml('1. One\n2. Two\n\n- A\n- B')
      expect(html).toContain('<ol>')
      expect(html).toContain('<ul>')
    })

    it('escapes HTML', () => {
      const html = engine.renderToHtml('<script>alert(1)</script>')
      expect(html).not.toContain('<script>')
    })

    it('literal §§ placeholder text never collides with slots — WA-6', () => {
      // User wrote text that looks exactly like an internal slot token
      const html = engine.renderToHtml('See §§WIKI0§§ and [[Target]]')
      expect(html).toContain('§§WIKI0§§')
      expect(html).toContain('class="wiki-link"')
      const insideCode = engine.renderToHtml('```\n§§WIKI0§§ literal inside code\n```')
      expect(insideCode).toContain('§§WIKI0§§')
    })
  })

  describe('resolveWikiLink', () => {
    it('resolves by exact title', () => {
      const map = new Map([['/vault/Note.md', 'Note Title']])
      const resolved = engine.resolveWikiLink('Note Title', map)
      expect(resolved).toBe('/vault/Note.md')
    })

    it('resolves by basename', () => {
      const map = new Map([['/vault/Folder/Note.md', 'Note Title']])
      const resolved = engine.resolveWikiLink('Note', map)
      expect(resolved).toBe('/vault/Folder/Note.md')
    })

    it('returns null for missing', () => {
      const map = new Map([['/vault/A.md', 'A']])
      const resolved = engine.resolveWikiLink('B', map)
      expect(resolved).toBeNull()
    })
  })

  describe('buildFrontmatterString', () => {
    it('builds valid YAML frontmatter', () => {
      const fm = { title: 'Test', tags: ['a', 'b'], count: 5 }
      const str = engine.buildFrontmatterString(fm)
      expect(str).toContain('title: Test')
      expect(str).toContain('- a')
      expect(str).toContain('- b')
      expect(str).toContain('count: 5')
    })
  })

  describe('createNoteTemplate', () => {
    it('creates template with frontmatter', () => {
      const template = engine.createNoteTemplate('My Note', 'project')
      expect(template).toContain('title: My Note')
      expect(template).toContain('type: project')
      expect(template).toContain('tags: []')
    })

    it('quotes titles that would corrupt YAML — WA-11', () => {
      const template = engine.createNoteTemplate('Project: Alpha', 'project')
      expect(template).toContain('title: "Project: Alpha"')
    })

    it('flattens newlines in title heading and quotes the frontmatter — WA-11', () => {
      const template = engine.createNoteTemplate('Line one\nline two')
      expect(template).toContain('title: "Line one\\nline two"')
      expect(template).toContain('# Line one line two')
      // frontmatter round-trips through gray-matter
      const matter = engine.parseFile('/vault/x.md', template.replace(/^#.*$/m, ''), '/vault')
      expect(matter.frontmatter.title).toBe('Line one\nline two')
    })
  })

  describe('buildFrontmatterString', () => {
    it('quotes dangerous scalar values — WA-11', () => {
      const str = engine.buildFrontmatterString({
        title: 'a: b',
        tags: ['x:y', 'ok'],
        note: 'c\nd'
      })
      expect(str).toContain('title: "a: b"')
      expect(str).toContain('- "x:y"')
      expect(str).toContain('- ok')
      expect(str).toContain('note: "c\\nd"')
    })
  })

  describe('createDailyNoteTemplate', () => {
    it('creates daily note with date', () => {
      const template = engine.createDailyNoteTemplate('2024-01-15')
      expect(template).toContain('date: 2024-01-15')
      expect(template).toContain('type: daily')
    })
  })
})
