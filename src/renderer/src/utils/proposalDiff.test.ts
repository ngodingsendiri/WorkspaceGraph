import { describe, it, expect } from 'vitest'
import { diffLines, diffStats } from './proposalDiff'

const kinds = (cur: string, prop: string): string[] => diffLines(cur, prop).map((l) => l.kind)

describe('diffLines (P2-6)', () => {
  it('identical content → all same', () => {
    const src = '# Judul\n\nIsi catatan.'
    const d = diffLines(src, src)
    expect(kinds(src, src).every((k) => k === 'same')).toBe(true)
    expect(d).toHaveLength(3)
  })

  it('pure append → prefix same + added lines', () => {
    const cur = '# Judul\n\ndraft\n'
    const prop = '# Judul\n\ndraft\n\n## Baru\n\nDitambahkan.\n'
    const k = kinds(cur, prop)
    expect(k.filter((x) => x === 'add').length).toBeGreaterThan(0)
    expect(k.includes('remove')).toBe(false)
    // Head stays identical — no removal churn
    expect(diffLines(cur, prop).find((l) => l.text === '# Judul')?.kind).toBe('same')
  })

  it('full rewrite → removals then additions', () => {
    const cur = 'lama satu\nlama dua\nlama tiga\n'
    const prop = 'baru satu\nbaru dua\n'
    const k = kinds(cur, prop)
    expect(k.includes('remove')).toBe(true)
    expect(k.includes('add')).toBe(true)
    const d = diffLines(cur, prop)
    expect(d.filter((l) => l.kind === 'remove').map((l) => l.text)).toContain('lama satu')
    expect(d.filter((l) => l.kind === 'add').map((l) => l.text)).toContain('baru satu')
  })

  it('create proposal (empty disk) → nothing removed, content all added', () => {
    const d = diffLines('', '# Catatan baru\n\nisi')
    // No removals — every real content line arrives as an addition (the empty
    // split line of a blank file can diff as unchanged; that's cosmetic).
    expect(d.some((l) => l.kind === 'remove')).toBe(false)
    expect(d.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['# Catatan baru', 'isi'])
  })

  it('mixed edit preserves unchanged middle lines', () => {
    const cur = 'a\nb\nc\nd\ne\n'
    const prop = 'a\nb\nX\nY\ne\n'
    const d = diffLines(cur, prop)
    // 'a', 'b', 'e' untouched; only c/d removed, X/Y added
    for (const keep of ['a', 'b', 'e']) {
      expect(d.find((l) => l.text === keep)?.kind).toBe('same')
    }
    expect(d.find((l) => l.text === 'c')?.kind).toBe('remove')
    expect(d.find((l) => l.text === 'X')?.kind).toBe('add')
  })

  it('normalizes CRLF so Windows vault notes diff cleanly', () => {
    const cur = 'a\r\nb'
    const prop = 'a\nb\nc'
    const d = diffLines(cur, prop)
    // 'a' + 'b' identical after CRLF normalization; only 'c' is new
    expect(d.filter((l) => l.kind === 'same').map((l) => l.text)).toEqual(['a', 'b'])
    expect(d.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['c'])
    expect(d.some((l) => l.kind === 'remove')).toBe(false)
  })

  it('degrades to remove-all + add-all on huge inputs (bounded cells)', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n')
    const d = diffLines(big, big + '\nextra\n')
    // No hang, and the tail is visible as additions
    expect(d.filter((l) => l.kind === 'add').map((l) => l.text)).toContain('extra')
    expect(d.some((l) => l.kind === 'same')).toBe(true) // prefix trim still works
  })
})

describe('diffStats', () => {
  it('counts added and removed lines', () => {
    const d = diffLines('a\nb\nc\n', 'a\nX\nc\nY\n')
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 })
  })

  it('zero counts for identical content', () => {
    expect(diffStats(diffLines('x\ny\n', 'x\ny\n'))).toEqual({ added: 0, removed: 0 })
  })
})
