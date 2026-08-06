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
 * they never produce samples — exactly the signal the AdaptiveThrottle
 * controller tunes the SVG_PUSH_THROTTLE_MS window against).
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

/**
 * Adaptive throttle window policy.
 *
 * SVG_PUSH_THROTTLE_MS starts at 50ms; the controller widens it when real
 * commits are expensive (p95 above target) and narrows it when they are cheap
 * (p95 below target), so the throttle self-tunes to the actual machine + vault.
 * Hard bounds keep it sane: never below one frame budget (throttling below
 * that is pointless at 60fps), never above 500ms (graph would visibly stutter).
 *
 * Approximation note: the p95 comes from ALL commits, including unthrottled
 * interaction commits (hover/zoom/entry) — the throttle only gates sim-motion
 * paints. An expensive hover can therefore widen the window a little beyond
 * the sim-only cost; accepted as a deliberate simplification (measuring the
 * two paths separately is not worth the complexity for a tuning heuristic).
 */
export const THROTTLE_TARGET_P95_MS = 16
/** Commit p95 must exceed target×1.25 to widen, drop below target×0.6 to narrow. */
export const THROTTLE_HYSTERESIS_WIDE = 1.25
export const THROTTLE_HYSTERESIS_NARROW = 0.6
export const THROTTLE_MIN_MS = 16
export const THROTTLE_MAX_MS = 500
export const THROTTLE_ADAPT_COOLDOWN_MS = 2000
export const THROTTLE_MIN_SAMPLES = 10

export class AdaptiveThrottle {
  windowMs: number
  /** Last adaptation timestamp; -Infinity so the FIRST decision is never
   *  blocked by the cooldown (now - (-Infinity) = +Infinity > cooldown). */
  private lastAdaptAt = -Infinity

  constructor(baseMs: number) {
    this.windowMs = baseMs
  }

  /**
   * Consider the latest commit p95; returns the (possibly changed) window.
   * Requires at least THROTTLE_MIN_SAMPLES commits and a cooldown between
   * changes so a single spike doesn't thrash the window.
   */
  consider(p95CommitMs: number, sampleCount: number, now: number): number {
    if (sampleCount < THROTTLE_MIN_SAMPLES) return this.windowMs
    if (now - this.lastAdaptAt < THROTTLE_ADAPT_COOLDOWN_MS) return this.windowMs
    if (p95CommitMs > THROTTLE_TARGET_P95_MS * THROTTLE_HYSTERESIS_WIDE) {
      this.windowMs = Math.min(THROTTLE_MAX_MS, Math.round(this.windowMs * 1.6))
      this.lastAdaptAt = now
    } else if (p95CommitMs < THROTTLE_TARGET_P95_MS * THROTTLE_HYSTERESIS_NARROW) {
      this.windowMs = Math.max(THROTTLE_MIN_MS, Math.round(this.windowMs / 1.6))
      this.lastAdaptAt = now
    }
    return this.windowMs
  }

  reset(baseMs: number): void {
    this.windowMs = baseMs
    this.lastAdaptAt = -Infinity
  }
}

/** Sorted-index percentile (nearest-rank, shared with the spark chart). */
export function percentile(sorted: number[], p: number): number {
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

  /**
   * The last `n` commit durations (oldest → newest). Feeds the overlay spark
   * chart (SPARK_BARS = 60), so throttling spikes + sim-settle patterns are
   * visible at a glance without reading raw numbers.
   */
  recent(n: number): number[] {
    if (n <= 0) return []
    return this.samples.slice(-n).map((s) => s.commitMs)
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
