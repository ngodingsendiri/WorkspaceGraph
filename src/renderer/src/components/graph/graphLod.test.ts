import { describe, it, expect } from 'vitest'
import {
  cullMargin,
  pointOnScreen,
  edgeOnScreen,
  CULL_MARGIN_LO,
  CULL_MARGIN_HI
} from './graphRenderTokens'

const W = 1600
const H = 1000

describe('cullMargin (shared frustum rule for SVG + Canvas2D)', () => {
  it('low LOD culls tighter than full/medium', () => {
    expect(cullMargin('low')).toBe(CULL_MARGIN_LO)
    expect(cullMargin('medium')).toBe(CULL_MARGIN_HI)
    expect(cullMargin('full')).toBe(CULL_MARGIN_HI)
    expect(CULL_MARGIN_LO).toBeLessThan(CULL_MARGIN_HI)
  })
})

describe('pointOnScreen', () => {
  it('accepts points inside the viewport', () => {
    expect(pointOnScreen(0, 0, W, H, 48)).toBe(true)
    expect(pointOnScreen(W, H, W, H, 48)).toBe(true)
    expect(pointOnScreen(W / 2, H / 2, W, H, 48)).toBe(true)
  })

  it('rejects points beyond any edge (margin inclusive)', () => {
    expect(pointOnScreen(-49, 0, W, H, 48)).toBe(false)
    expect(pointOnScreen(W + 49, 0, W, H, 48)).toBe(false)
    expect(pointOnScreen(0, -49, W, H, 48)).toBe(false)
    expect(pointOnScreen(0, H + 49, W, H, 48)).toBe(false)
  })

  it('accepts points exactly on the margin boundary', () => {
    expect(pointOnScreen(-48, 0, W, H, 48)).toBe(true)
    expect(pointOnScreen(W + 48, H + 48, W, H, 48)).toBe(true)
  })
})

describe('edgeOnScreen (bbox overlap)', () => {
  it('keeps edges with at least one endpoint inside', () => {
    expect(edgeOnScreen(0, 0, 200, 200, W, H, 48)).toBe(true)
    expect(edgeOnScreen(W, H, W + 900, H + 900, W, H, 48)).toBe(true)
  })

  it('culls edges fully beyond one side even when both endpoints are off-screen', () => {
    // Both endpoints far to the LEFT of the viewport → bbox disjoint → culled
    expect(edgeOnScreen(-5000, -5000, -3000, 3000, W, H, 48)).toBe(false)
    // Both far BELOW
    expect(edgeOnScreen(0, 5000, 2000, 9000, W, H, 48)).toBe(false)
  })

  it('keeps a segment that CROSSES the viewport with both endpoints outside', () => {
    // Endpoint-only checks would drop this; the bbox overlaps the viewport
    expect(edgeOnScreen(-2000, 500, 5000, 500, W, H, 48)).toBe(true)
    expect(edgeOnScreen(800, -2000, 800, 3000, W, H, 48)).toBe(true)
  })

  it('culls edges that just miss the margin', () => {
    // bbox right edge sits just outside the right margin
    expect(edgeOnScreen(W + 100, 0, W + 100, 100, W, H, 48)).toBe(false)
    // ...and keeps ones that touch it
    expect(edgeOnScreen(W + 48, 0, W + 48, 100, W, H, 48)).toBe(true)
  })
})
