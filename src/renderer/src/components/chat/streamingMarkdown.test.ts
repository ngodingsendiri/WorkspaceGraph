import { describe, it, expect } from 'vitest'
import { renderStreamingMarkdown } from './streamingMarkdown'

describe('renderStreamingMarkdown', () => {
  it('escapes raw HTML (untrusted AI output)', () => {
    const html = renderStreamingMarkdown('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('renders completed bold / italic / inline code', () => {
    const html = renderStreamingMarkdown('**bold** and *italic* and `code`')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<code>code</code>')
  })

  it('closes unclosed bold so progressive output renders', () => {
    const html = renderStreamingMarkdown('**bold')
    expect(html).toContain('<strong>bold</strong>')
  })

  it('closes an unclosed code fence', () => {
    const html = renderStreamingMarkdown('```js\nconst a = 1')
    expect(html).toContain('<pre><code class="language-js">')
    expect(html).toContain('const a = 1')
  })

  it('renders headings and lists', () => {
    const html = renderStreamingMarkdown('## Judul\n\n- satu\n- dua')
    expect(html).toContain('<h2>Judul</h2>')
    expect(html).toContain('<ul><li>satu</li><li>dua</li></ul>')
  })

  it('renders safe links only (http/https/mailto)', () => {
    const html = renderStreamingMarkdown('[X](https://example.com)')
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">X</a>')
    // javascript: must NOT become a link
    const evil = renderStreamingMarkdown('[x](javascript:alert(1))')
    expect(evil).not.toContain('<a ')
  })

  it('renders wikilinks as inert spans', () => {
    const html = renderStreamingMarkdown('[[Catatan Penting]]')
    expect(html).toContain('<span class="wiki-link" data-target="Catatan Penting">Catatan Penting</span>')
  })

  it('handles CRLF input', () => {
    const html = renderStreamingMarkdown('# Judul\r\n\r\nparagraf\r\n')
    expect(html).toContain('<h1>Judul</h1>')
    expect(html).toContain('<p>paragraf</p>')
  })

  it('returns empty string for blank input', () => {
    expect(renderStreamingMarkdown('')).toBe('')
    expect(renderStreamingMarkdown('\n\n  \n')).toBe('')
  })

  it('escapes attribute-breaking quotes in wikilink targets', () => {
    const html = renderStreamingMarkdown('[[a" onmouseover="x]]')
    // Quotes are escaped exactly once — attacker text cannot break out of data-target
    expect(html).not.toContain('data-target="a" onmouseover="x"')
    expect(html).toContain('data-target="a&quot; onmouseover=&quot;x"')
    expect(html).toContain('<span class="wiki-link"')
  })
})
