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

  it('scales the tallest bar to the top of the chart', () => {
    const l = sparkLayout([10, 50], W, H, TARGET)
    expect(l.scaleMs).toBe(50)
    const tallest = l.bars.find((b) => b.commitMs === 50)!
    expect(tallest.y + tallest.h).toBeCloseTo(H, 5)
    expect(tallest.y).toBeCloseTo(0, 5)
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
})
