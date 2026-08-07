import { describe, it, expect, vi } from 'vitest'
import { makeCitePreviewCache, citeNode, citeTipPos } from './chatCitationTip'

describe('citeTipPos (P1-2)', () => {
  const vp = { width: 1280, height: 800 }

  it('anchors below the chip with the default gap', () => {
    expect(citeTipPos({ left: 200, bottom: 300 }, vp)).toEqual({ x: 200, y: 306 })
  })

  it('clamps x when the chip sits near the right edge', () => {
    const pos = citeTipPos({ left: 1200, bottom: 300 }, vp)
    expect(pos.x).toBeLessThanOrEqual(vp.width - 280)
    expect(pos.y).toBe(306)
  })

  it('clamps y when the chip sits near the bottom edge', () => {
    const pos = citeTipPos({ left: 100, bottom: 790 }, vp)
    expect(pos.y).toBeLessThanOrEqual(vp.height - 220)
  })

  it('never returns negative coordinates for off-screen chips', () => {
    const pos = citeTipPos({ left: -50, bottom: -20 }, vp)
    expect(pos.x).toBeGreaterThanOrEqual(0)
    expect(pos.y).toBeGreaterThanOrEqual(0)
  })
})

describe('makeCitePreviewCache (P1-2)', () => {
  it('reads through the injected source and returns a plain-text preview', async () => {
    const read = vi.fn(async () => ({ content: '# Judul\n\nIni **isi** catatan.\n\nBaris kedua.' }))
    const cache = makeCitePreviewCache(read)
    const text = await cache.get(citeNode('/v/A.md'))
    expect(text).toContain('Judul')
    expect(text).toContain('Ini isi catatan.')
    expect(text).toContain('Baris kedua.')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('caches per path: a second hover does not re-read the note', async () => {
    const read = vi.fn(async () => ({ content: '# A\n\nisi' }))
    const cache = makeCitePreviewCache(read)
    await cache.get(citeNode('/v/A.md'))
    await cache.get(citeNode('/v/A.md'))
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('returns null for a failed read (missing note / no vault)', async () => {
    const read = vi.fn(async () => null)
    const cache = makeCitePreviewCache(read)
    expect(await cache.get(citeNode('/v/missing.md'))).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })
})
