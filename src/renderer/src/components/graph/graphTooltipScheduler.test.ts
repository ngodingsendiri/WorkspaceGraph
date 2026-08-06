import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTooltipScheduler, TOOLTIP_DELAY_MS } from './graphTooltipScheduler'

interface FakeNode {
  id: string
  title: string
}

function makeScheduler(delay = TOOLTIP_DELAY_MS): {
  s: ReturnType<typeof createTooltipScheduler<FakeNode>>
  calls: { show: [FakeNode, number, number][]; move: [number, number][]; hide: number }
} {
  const calls = {
    show: [] as [FakeNode, number, number][],
    move: [] as [number, number][],
    hide: 0
  }
  let visible = false
  const s = createTooltipScheduler<FakeNode>({
    delay,
    show: (node, x, y) => {
      calls.show.push([node, x, y])
      visible = true
    },
    move: (x, y) => calls.move.push([x, y]),
    hide: () => {
      calls.hide++
      visible = false
    },
    isVisible: () => visible
  })
  return { s, calls }
}

describe('createTooltipScheduler (P1-2 hover-delay)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not show before the delay elapses', () => {
    const { s, calls } = makeScheduler()
    s.hover({ id: 'a', title: 'A' }, 10, 20)
    expect(calls.show).toHaveLength(0)
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1)
    expect(calls.show).toHaveLength(0)
  })

  it('shows the node at the stored anchor once the delay elapses', () => {
    const { s, calls } = makeScheduler()
    s.hover({ id: 'a', title: 'A' }, 10, 20)
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
    expect(calls.show).toHaveLength(1)
    expect(calls.show[0]).toEqual([{ id: 'a', title: 'A' }, 10, 20])
  })

  it('cancels on leave — the timer never fires', () => {
    const { s, calls } = makeScheduler()
    s.hover({ id: 'a', title: 'A' }, 10, 20)
    s.leave()
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS * 2)
    expect(calls.show).toHaveLength(0)
    expect(calls.hide).toBe(1)
  })

  it('hovering empty space hides immediately', () => {
    const { s, calls } = makeScheduler()
    s.hover({ id: 'a', title: 'A' }, 10, 20)
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
    expect(calls.show).toHaveLength(1)
    s.hover(null, 0, 0)
    expect(calls.hide).toBe(1)
  })

  it('switching node re-arms the timer and shows the NEW node', () => {
    const { s, calls } = makeScheduler()
    s.hover({ id: 'a', title: 'A' }, 10, 20)
    vi.advanceTimersByTime(100)
    s.hover({ id: 'b', title: 'B' }, 30, 40)
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
    // A's pending show was cancelled; only B ever shows
    expect(calls.show).toHaveLength(1)
    expect(calls.show[0][0].id).toBe('b')
    expect(calls.show[0].slice(1)).toEqual([30, 40])
  })

  it('switching node while visible hides the stale tooltip immediately', () => {
    const { s, calls } = makeScheduler()
    s.hover({ id: 'a', title: 'A' }, 10, 20)
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
    expect(calls.show).toHaveLength(1)
    // Move to B: A's visible tooltip must NOT linger during the re-arm window
    s.hover({ id: 'b', title: 'B' }, 30, 40)
    expect(calls.hide).toBe(1)
    expect(calls.show).toHaveLength(1)
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
    expect(calls.show).toHaveLength(2)
    expect(calls.show[1][0].id).toBe('b')
  })

  it('moves while pending refresh the anchor used when the timer fires', () => {
    const { s, calls } = makeScheduler()
    s.hover({ id: 'a', title: 'A' }, 10, 20)
    vi.advanceTimersByTime(50)
    s.hover({ id: 'a', title: 'A' }, 60, 70)
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
    expect(calls.show).toHaveLength(1)
    expect(calls.show[0].slice(1)).toEqual([60, 70])
  })

  it('follows the cursor via move once visible (no re-arm)', () => {
    const { s, calls } = makeScheduler()
    s.hover({ id: 'a', title: 'A' }, 10, 20)
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
    s.hover({ id: 'a', title: 'A' }, 25, 35)
    s.hover({ id: 'a', title: 'A' }, 40, 50)
    expect(calls.move).toEqual([
      [25, 35],
      [40, 50]
    ])
    expect(calls.show).toHaveLength(1)
  })

  it('dispose cancels a pending timer without hiding a visible tooltip', () => {
    const { s, calls } = makeScheduler()
    s.hover({ id: 'a', title: 'A' }, 10, 20)
    s.dispose()
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS * 2)
    expect(calls.show).toHaveLength(0)
    expect(calls.hide).toBe(0)
  })

  it('respects a custom delay', () => {
    const { s, calls } = makeScheduler(80)
    s.hover({ id: 'a', title: 'A' }, 10, 20)
    vi.advanceTimersByTime(79)
    expect(calls.show).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(calls.show).toHaveLength(1)
  })
})
