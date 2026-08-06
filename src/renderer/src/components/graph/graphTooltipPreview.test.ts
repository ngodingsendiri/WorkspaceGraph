import { describe, it, expect, vi } from 'vitest'
import {
  markdownToPlainText,
  previewLines,
  TooltipPreviewCache,
  PREVIEW_MAX_LINES,
  PREVIEW_MAX_CHARS
} from './graphTooltipPreview'

describe('markdownToPlainText', () => {
  it('strips headings, emphasis, and keeps the body text', () => {
    expect(markdownToPlainText('# Judul\n\nIni **bold** dan *italic* body.')).toBe(
      'Judul\n\nIni bold dan italic body.'
    )
  })

  it('keeps wiki-link display and md-link text', () => {
    expect(markdownToPlainText('Lihat [[Catatan A]] dan [link](https://x.com).')).toBe(
      'Lihat Catatan A dan link.'
    )
    expect(markdownToPlainText('Alias [[Target|alias saya]].')).toBe('Alias Target.')
  })

  it('drops images, keeps inline-code text, collapses code fences', () => {
    expect(
      markdownToPlainText('![alt](img.png) tersisa\n\n`code()` dan\n```js\nconst x = 1\n```\nend')
    ).toBe('tersisa\n\ncode() dan\nconst x = 1\n\nend')
  })

  it('strips blockquotes, HTML tags and horizontal rules', () => {
    expect(markdownToPlainText('> kutipan\n\n---\n\n<div>html</div> ok')).toBe('kutipan\n\nhtml ok')
  })
})

describe('previewLines', () => {
  it('returns the first non-empty lines, trimmed', () => {
    expect(previewLines('\n\n  Pertama  \n\nKedua\n\nKetiga\n\nKeempat')).toBe(
      'Pertama\nKedua\nKetiga'
    )
  })

  it('respects maxLines', () => {
    expect(previewLines('a\nb\nc\nd', 2)).toBe('a\nb')
  })

  it('caps total length with maxChars', () => {
    const long = 'x'.repeat(200)
    expect(previewLines(long, PREVIEW_MAX_LINES, PREVIEW_MAX_CHARS).length).toBeLessThanOrEqual(
      PREVIEW_MAX_CHARS
    )
  })

  it('returns empty string for blank input', () => {
    expect(previewLines('   \n\n  ')).toBe('')
  })
})

describe('TooltipPreviewCache', () => {
  function makeSource(contents: Record<string, string>): {
    read: (p: string) => Promise<{ content: string } | null>
    contents: Record<string, string>
  } {
    const read = vi.fn(async (p: string) => (contents[p] != null ? { content: contents[p] } : null))
    return { read, contents }
  }

  it('reads, strips markdown and caches per path', async () => {
    const { read } = makeSource({ '/a.md': '# Judul\n\nIsi **badan**.' })
    const cache = new TooltipPreviewCache({ read })
    const node = { id: 'a', path: '/a.md', type: 'note' }
    const first = await cache.get(node)
    const second = await cache.get(node)
    expect(first).toBe('Judul\nIsi badan.')
    expect(second).toBe(first)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent reads of the same path', async () => {
    const { read } = makeSource({ '/a.md': 'konten' })
    const cache = new TooltipPreviewCache({ read })
    const [r1, r2] = await Promise.all([
      cache.get({ id: 'a', path: '/a.md', type: 'note' }),
      cache.get({ id: 'a', path: '/a.md', type: 'note' })
    ])
    expect(r1).toBe('konten')
    expect(r2).toBe('konten')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('skips ghosts, tags, attachments and non-note types', async () => {
    const { read } = makeSource({})
    const cache = new TooltipPreviewCache({ read })
    const cases: Parameters<TooltipPreviewCache['get']>[0][] = [
      { id: 'g', path: '/g.md', type: 'note', isGhost: true },
      { id: 't', path: '#tag', type: 'tag', isTag: true },
      { id: 'a', path: '/a.png', type: 'attachment', isAttachment: true },
      { id: 'x', path: '/x.md', type: 'folder' }
    ]
    for (const n of cases) expect(await cache.get(n)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('evicts oldest entries past the cap', async () => {
    const { read } = makeSource({
      '/1.md': 'satu',
      '/2.md': 'dua',
      '/3.md': 'tiga'
    })
    const cache = new TooltipPreviewCache({ read }, 2)
    await cache.get({ id: '1', path: '/1.md', type: 'note' })
    await cache.get({ id: '2', path: '/2.md', type: 'note' })
    await cache.get({ id: '3', path: '/3.md', type: 'note' })
    // /1.md was evicted → re-read; /2.md and /3.md are cached
    await cache.get({ id: '1', path: '/1.md', type: 'note' })
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('invalidate drops cached previews (next hover re-reads)', async () => {
    const { read } = makeSource({ '/a.md': 'lama' })
    const cache = new TooltipPreviewCache({ read })
    await cache.get({ id: 'a', path: '/a.md', type: 'note' })
    cache.invalidate()
    await cache.get({ id: 'a', path: '/a.md', type: 'note' })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('in-flight read resolving after invalidate never re-populates stale text', async () => {
    let resolveRead: (r: { content: string } | null) => void = () => {}
    const read = vi.fn(
      () =>
        new Promise<{ content: string } | null>((resolve) => {
          resolveRead = resolve
        })
    )
    const cache = new TooltipPreviewCache({ read })
    const node = { id: 'a', path: '/a.md', type: 'note' }
    const inFlight = cache.get(node)
    // Edit + graph update while the read is still in flight
    cache.invalidate()
    resolveRead({ content: 'versi lama sebelum edit' })
    expect(await inFlight).toBeNull()
    // Next hover re-reads (fresh read; resolveRead now points at that read)
    const second = cache.get(node)
    resolveRead({ content: 'versi baru' })
    expect(await second).toBe('versi baru')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('returns null for missing files without throwing', async () => {
    const { read } = makeSource({})
    const cache = new TooltipPreviewCache({ read })
    expect(await cache.get({ id: 'a', path: '/nope.md', type: 'note' })).toBeNull()
  })
})
