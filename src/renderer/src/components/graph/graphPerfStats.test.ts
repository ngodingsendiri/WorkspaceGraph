import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  RollingPerfStats,
  AdaptiveThrottle,
  THROTTLE_MIN_MS,
  THROTTLE_MAX_MS
} from './graphPerfStats'

function sample(
  commitMs: number,
  opts: Partial<Parameters<RollingPerfStats['push']>[0]> = {}
): Parameters<RollingPerfStats['push']>[0] {
  return {
    commitMs,
    edges: 500,
    nodes: 400,
    labels: 100,
    ts: performance.now(),
    ...opts
  }
}

describe('RollingPerfStats', () => {
  let stats: RollingPerfStats

  beforeEach(() => {
    stats = new RollingPerfStats()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('empty snapshot is all zeros', () => {
    const s = stats.snapshot()
    expect(s.count).toBe(0)
    expect(s.avgCommitMs).toBe(0)
    expect(s.p95CommitMs).toBe(0)
    expect(s.maxCommitMs).toBe(0)
    expect(s.fps).toBe(0)
  })

  it('computes avg / p95 / max over samples', () => {
    // 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20 → p95 nearest-rank idx = 19
    for (let i = 1; i <= 20; i++) stats.push(sample(i))
    const s = stats.snapshot()
    expect(s.count).toBe(20)
    expect(s.avgCommitMs).toBeCloseTo(10.5, 5)
    expect(s.maxCommitMs).toBe(20)
    // nearest-rank p95: rank = ceil(0.95×20) = 19th value = 19
    expect(s.p95CommitMs).toBe(19)
  })

  it('p95 is correct on a non-exact bound', () => {
    // 1..10 → p95 idx = ceil(9.5)-1 = 9 → value 10
    for (let i = 1; i <= 10; i++) stats.push(sample(i))
    expect(stats.snapshot().p95CommitMs).toBe(10)
  })

  it('fps counts commits in the trailing 1000ms only', () => {
    const now = performance.now()
    vi.setSystemTime(now + 1000)
    for (let i = 0; i < 60; i++) stats.push(sample(2, { ts: performance.now() }))
    // 30 stale samples older than the window
    for (let i = 0; i < 30; i++) stats.push(sample(2, { ts: performance.now() - 5000 }))
    const s = stats.snapshot()
    expect(s.fps).toBe(60)
    expect(s.count).toBe(90) // window capacity keeps all 90
  })

  it('records the element counts of the latest sample', () => {
    stats.push(sample(1, { edges: 10, nodes: 20, labels: 30 }))
    stats.push(sample(2, { edges: 15, nodes: 25, labels: 35 }))
    const s = stats.snapshot()
    expect(s.edges).toBe(15)
    expect(s.nodes).toBe(25)
    expect(s.labels).toBe(35)
  })

  it('recent returns the last n commit durations oldest→newest', () => {
    for (let i = 1; i <= 5; i++) stats.push(sample(i))
    expect(stats.recent(3)).toEqual([3, 4, 5])
    expect(stats.recent(10)).toEqual([1, 2, 3, 4, 5])
    expect(stats.recent(0)).toEqual([])
  })

  it('recent keeps only commit durations (no element fields)', () => {
    stats.push(sample(7, { edges: 10, nodes: 20, labels: 30 }))
    expect(stats.recent(1)).toEqual([7])
  })

  it('reset clears everything', () => {
    stats.push(sample(1))
    stats.reset()
    expect(stats.count).toBe(0)
    expect(stats.snapshot().avgCommitMs).toBe(0)
  })
})

describe('AdaptiveThrottle', () => {
  const T = 1000
  let ctrl: AdaptiveThrottle

  beforeEach(() => {
    ctrl = new AdaptiveThrottle(100)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts at the base window', () => {
    expect(ctrl.windowMs).toBe(100)
  })

  it('ignores decisions until enough samples exist', () => {
    expect(ctrl.consider(50, 5, T)).toBe(100) // 5 < MIN_SAMPLES
    expect(ctrl.consider(50, 10, T)).not.toBe(100) // now it can react
  })

  it('widens the window when commit p95 is above target (expensive commits)', () => {
    // p95 = 40ms >> target 16ms → widen (100 * 1.6 = 160)
    expect(ctrl.consider(40, 12, T)).toBe(160)
    // cooldown: a second call in the same tick must not change again
    expect(ctrl.consider(40, 12, T + 100)).toBe(160)
  })

  it('narrows the window when commit p95 is well below target (cheap commits)', () => {
    // p95 = 5ms < 16*0.6=9.6 → narrow (100 / 1.6 ≈ 63)
    expect(ctrl.consider(5, 12, T)).toBe(63)
  })

  it('keeps the window in the hysteresis band (no thrash)', () => {
    // 18ms is within [target*0.6, target*1.25] = [9.6, 20] → no change
    expect(ctrl.consider(18, 12, T)).toBe(100)
    // 20.1ms is just above the band → widen
    expect(ctrl.consider(20.5, 12, T + 3000)).toBe(160)
  })

  it('clamps to hard bounds (never below MIN, never above MAX)', () => {
    const c = new AdaptiveThrottle(THROTTLE_MIN_MS)
    // already at min + cheap commits → stays at min
    expect(c.consider(1, 12, T)).toBe(THROTTLE_MIN_MS)
    const wide = new AdaptiveThrottle(THROTTLE_MAX_MS)
    expect(wide.consider(100, 12, T)).toBe(THROTTLE_MAX_MS)
  })

  it('respects the cooldown between successive adaptations', () => {
    expect(ctrl.consider(40, 12, T)).toBe(160) // adapt at T
    vi.setSystemTime(T + 500)
    expect(ctrl.consider(5, 12, T + 500)).toBe(160) // within cooldown (500 < 2000)
    vi.setSystemTime(T + 2500)
    expect(ctrl.consider(5, 12, T + 2500)).toBe(100) // cooldown passed → narrow back
  })

  it('reset restores the base window and cooldown state', () => {
    ctrl.consider(40, 12, T)
    ctrl.reset(100)
    expect(ctrl.windowMs).toBe(100)
    expect(ctrl.consider(40, 12, T + 100)).toBe(160) // can adapt immediately again
  })
})
