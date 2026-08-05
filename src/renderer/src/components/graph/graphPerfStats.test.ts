import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RollingPerfStats } from './graphPerfStats'

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

  it('reset clears everything', () => {
    stats.push(sample(1))
    stats.reset()
    expect(stats.count).toBe(0)
    expect(stats.snapshot().avgCommitMs).toBe(0)
  })
})
