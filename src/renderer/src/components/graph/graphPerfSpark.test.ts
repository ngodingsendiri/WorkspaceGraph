import { describe, it, expect, vi } from 'vitest'
import { sparkLayout, drawSparkBars, SPARK_BARS, SPARK_MIN_BAR_H } from './graphPerfSpark'

function fakeCtx(): {
  calls: string[]
  ctx: {
    fillStyle: string
    clearRect: (x: number, y: number, w: number, h: number) => void
    fillRect: (x: number, y: number, w: number, h: number) => void
  }
} {
  const calls: string[] = []
  return {
    calls,
    ctx: {
      fillStyle: '',
      clearRect: vi.fn((x: number, y: number, w: number, h: number) => {
        calls.push(`clear ${x},${y},${w},${h}`)
      }),
      fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
        calls.push(`rect ${x},${y},${w},${h}`)
      })
    }
  }
}

const W = 200
const H = 30
const TARGET = 16

describe('sparkLayout', () => {
  it('empty history → no bars, scale defaults to the target', () => {
    const l = sparkLayout([], W, H, TARGET)
    expect(l.bars).toEqual([])
    expect(l.scaleMs).toBe(TARGET)
    // scale == target ⇒ target line sits at the top edge (draw skips it)
    expect(l.targetY).toBe(0)
  })

  it('caps the bars at SPARK_BARS (last N win)', () => {
    const many = Array.from({ length: 120 }, (_, i) => i + 1)
    const l = sparkLayout(many, W, H, TARGET)
    expect(l.bars.length).toBe(SPARK_BARS)
    // Last 60 values = 61..120 → last bar's commitMs is 120
    expect(l.bars[l.bars.length - 1].commitMs).toBe(120)
  })

  it('scales p95 to the chart (with ≤19 samples p95 collapses to the max)', () => {
    // n=2 → nearest-rank p95 is the max, so the tallest bar still tops out
    const l = sparkLayout([10, 50], W, H, TARGET)
    expect(l.scaleMs).toBe(50)
    const tallest = l.bars.find((b) => b.commitMs === 50)!
    expect(tallest.y + tallest.h).toBeCloseTo(H, 5)
    expect(tallest.y).toBeCloseTo(0, 5)
  })

  it('outlier spike does not flatten normal bars — p95-based scale, spike capped full-height', () => {
    // 19 typical commits at 10ms + one 500ms spike (20 samples → p95 = 10)
    const samples = [...Array(19).fill(10), 500]
    const l = sparkLayout(samples, W, H, TARGET)
    // Scale follows the typical cost (max(1, target 16, p95 10) = 16), not the spike
    expect(l.scaleMs).toBe(TARGET)
    const spike = l.bars.find((b) => b.commitMs === 500)!
    // Spike is capped at the top: full height from y=0, still visible + flagged
    expect(spike.y).toBe(0)
    expect(spike.h).toBe(H)
    expect(spike.clipped).toBe(true)
    expect(spike.over).toBe(true)
    // A normal bar keeps real height contrast against the spike (~10/16 of the chart)
    const normal = l.bars.find((b) => b.commitMs === 10)!
    expect(normal.h).toBeGreaterThan(H * 0.5)
    expect(normal.h).toBeLessThan(H)
    expect(normal.clipped).toBe(false)
    expect(normal.over).toBe(false)
  })

  it('flags bars over the target p95 as `over` (at-target is not over)', () => {
    const l = sparkLayout([5, 15, 40], W, H, TARGET)
    expect(l.bars.map((b) => b.over)).toEqual([false, false, true])
  })

  // ===== DRAW =====

  it('drawSparkBars clears, draws one rect per bar, and no target line on empty', () => {
    const { ctx, calls } = fakeCtx()
    const l = sparkLayout([], W, H, TARGET)
    drawSparkBars(ctx, l, { bar: '#111', over: '#f00', targetLine: '#f80' })
    expect(calls[0]).toBe('clear 0,0,200,30')
    // No bars → only the clear happened
    expect(calls.length).toBe(1)
  })

  it('drawSparkBars paints a target line when samples exceed the target', () => {
    const { ctx, calls } = fakeCtx()
    // [8, 40] → scale 40 > target 16, so the line sits inside the chart
    const l = sparkLayout([8, 40], W, H, TARGET)
    drawSparkBars(ctx, l, { bar: '#111', over: '#f00', targetLine: '#f80' })
    // clear + 2 bars + 1 target line
    expect(calls.length).toBe(4)
    expect(calls[3]).toContain('rect 0,')
  })
})

describe('drawSparkBars color sequencing', () => {
  it('sets fillStyle before each fillRect in bar order (bar, over, target line)', () => {
    const seq: string[] = []
    const ctx = {
      fillStyle: '',
      clearRect: vi.fn(),
      fillRect: vi.fn(() => {
        seq.push(ctx.fillStyle)
      })
    }
    const l = sparkLayout([8, 40], W, H, TARGET)
    drawSparkBars(ctx, l, { bar: '#111', over: '#f00', targetLine: '#f80' })
    expect(seq).toEqual(['#111', '#f00', '#f80'])
  })

  it('min-height floor keeps tiny commits visible', () => {
    const l = sparkLayout([0.1], W, H, TARGET)
    expect(l.bars[0].h).toBeGreaterThanOrEqual(SPARK_MIN_BAR_H)
  })

  it('over-but-not-clipped bars keep the normal tint (spike color is reserved for true spikes)', () => {
    // 17ms is over the 16ms budget but below the p95 scale (30) → not clipped
    const seq: string[] = []
    const ctx = {
      fillStyle: '',
      clearRect: vi.fn(),
      fillRect: vi.fn(() => {
        seq.push(ctx.fillStyle)
      })
    }
    const l = sparkLayout([17, 30], W, H, TARGET)
    const over17 = l.bars.find((b) => b.commitMs === 17)!
    expect(over17.over).toBe(true)
    expect(over17.clipped).toBe(false)
    drawSparkBars(ctx, l, { bar: '#111', over: '#f00', targetLine: '#f80' })
    // 17 (normal #111), 30 spike (clipped → #f00), target line (#f80)
    expect(seq).toEqual(['#111', '#f00', '#f80'])
  })
})
