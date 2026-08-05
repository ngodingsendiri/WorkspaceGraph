/**
 * G-perf: real-browser SVG commit measurement.
 *
 * paint() pushes an SVG frame to React via pushSvgFrame/flushSvgFrame. Each
 * commit stamps performance.now() before setSvgFrame; a useLayoutEffect keyed
 * on svgFrame (runs synchronously after the DOM mutation, before paint)
 * measures the actual React render + reconciliation + DOM-diff duration.
 *
 * Samples live in a fixed-capacity rolling window so the overlay shows the
 * RECENT cost (avg / p95 / max), not a lifetime average, and commits/sec stays
 * meaningful while the throttle is engaged (throttled frames never commit, so
 * they never produce samples — exactly the signal we want to tune the 100 ms
 * SVG_PUSH_THROTTLE_MS window against).
 */
export interface PerfSample {
  /** React render + DOM commit duration for this SVG frame (ms). */
  commitMs: number
  /** Element counts in the committed frame (SVG DOM size). */
  edges: number
  nodes: number
  labels: number
  /** performance.now() at commit — for fps windowing. */
  ts: number
}

export interface PerfSnapshot {
  count: number
  avgCommitMs: number
  p95CommitMs: number
  maxCommitMs: number
  /** Commits in the trailing 1000 ms window. */
  fps: number
  edges: number
  nodes: number
  labels: number
}

const WINDOW_CAPACITY = 90
const FPS_WINDOW_MS = 1000

/** Sorted-index p95 (nearest-rank). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

export class RollingPerfStats {
  private samples: PerfSample[] = []

  push(sample: PerfSample): void {
    this.samples.push(sample)
    if (this.samples.length > WINDOW_CAPACITY) this.samples.shift()
  }

  reset(): void {
    this.samples.length = 0
  }

  get count(): number {
    return this.samples.length
  }

  snapshot(): PerfSnapshot {
    const ms = this.samples.map((s) => s.commitMs)
    const sorted = [...ms].sort((a, b) => a - b)
    const avg = ms.length > 0 ? ms.reduce((a, b) => a + b, 0) / ms.length : 0
    const now = performance.now()
    const fps = this.samples.filter((s) => now - s.ts <= FPS_WINDOW_MS).length
    const last = this.samples[this.samples.length - 1]
    return {
      count: ms.length,
      avgCommitMs: avg,
      p95CommitMs: percentile(sorted, 0.95),
      maxCommitMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
      fps,
      edges: last?.edges ?? 0,
      nodes: last?.nodes ?? 0,
      labels: last?.labels ?? 0
    }
  }
}
