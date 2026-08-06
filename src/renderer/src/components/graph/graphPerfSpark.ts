/**
 * G-perf: mini bar-chart for the perf overlay — the last 60 SVG commit
 * durations drawn as a tiny canvas so throttling spikes and the sim-settle
 * pattern are visible at a glance (no need to read raw numbers).
 *
 * Layout math is PURE (no canvas/DOM) so it unit-tests in node; the draw
 * function takes a minimal 2D-ctx-like interface so a fake can drive it.
 * Colors are theme-aware via CSS vars passed in by the caller — the module
 * never touches `document`.
 *
 * Scale is p95-based (nearest-rank, same convention as RollingPerfStats): a
 * single outlier spike (say 500ms) no longer flattens every normal bar — the
 * scale follows the typical commit cost. Bars above p95 are CAPPED at the
 * chart top (full-height spikes), so they stay clearly visible as spikes.
 */

import { percentile } from './graphPerfStats'

/** How many of the most recent commit durations the chart shows. */
export const SPARK_BARS = 60
/** Horizontal gap between bars (px). */
export const SPARK_GAP = 2
/** Min height of a drawn bar so a single 0.5ms commit is still visible. */
export const SPARK_MIN_BAR_H = 2

export interface SparkBar {
  x: number
  y: number
  w: number
  h: number
  commitMs: number
  /** commitMs > targetMs (over the 16ms budget). */
  over: boolean
  /** commitMs >= scaleMs (beyond the p95 scale) — a genuine spike, drawn
   *  as a full-height capped bar with the spike tint. */
  clipped: boolean
}

export interface SparkLayout {
  bars: SparkBar[]
  /** Chart width in px (bars laid out inside; used to draw the target line). */
  width: number
  height: number
  /** Y of the target-p95 line (px, top-relative) — 0 when no samples yet. */
  targetY: number
  /** Commit ms that maps to the top of the chart (scale max). */
  scaleMs: number
}

/**
 * Pure bar layout for `samples` commit durations (oldest → newest, at most
 * `maxBars` used — last ones win). Scale = max(1, target, p95 of the tail) so
 * the chart always has a visible target line, empty/short histories render,
 * and a lone outlier does not stretch every other bar into the floor. Bars
 * above p95 (the spikes) are clamped to full chart height with `y = 0`, so
 * they remain visible as tall capped spikes instead of being clipped mid-air.
 */
export function sparkLayout(
  samples: number[],
  width: number,
  height: number,
  targetMs: number,
  maxBars = SPARK_BARS
): SparkLayout {
  const tail = samples.slice(-maxBars)
  const scaleMs = Math.max(
    1,
    targetMs,
    percentile(
      [...tail].sort((a, b) => a - b),
      0.95
    )
  )
  const barW = width / Math.max(1, tail.length)
  const bars: SparkBar[] = tail.map((commitMs, i) => {
    const hRaw = (commitMs / scaleMs) * height
    const h = Math.min(height, Math.max(SPARK_MIN_BAR_H, hRaw))
    return {
      x: i * barW + SPARK_GAP / 2,
      y: height - h,
      w: Math.max(1, barW - SPARK_GAP),
      h,
      commitMs,
      over: commitMs > targetMs,
      clipped: commitMs >= scaleMs
    }
  })
  return {
    bars,
    width,
    height,
    targetY: height - (targetMs / scaleMs) * height,
    scaleMs
  }
}

/** Minimal 2D-context surface the draw function needs (testable in node).
 *  fillStyle is widened to the DOM union so a real CanvasRenderingContext2D
 *  is directly assignable; the draw code only ever assigns plain strings. */
export interface SparkCtxLike {
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  fillStyle: string | CanvasGradient | CanvasPattern
}

export interface SparkTheme {
  bar: string
  over: string
  targetLine: string
}

/**
 * Draw the layout onto a canvas-sized surface. `dpr` is the devicePixelRatio
 * the caller already applied to the backing store (canvas.width = w*dpr), so
 * geometry stays in CSS pixels here.
 */
export function drawSparkBars(ctx: SparkCtxLike, layout: SparkLayout, theme: SparkTheme): void {
  ctx.clearRect(0, 0, layout.width, layout.height)
  for (const bar of layout.bars) {
    // Spike tint keys on `clipped` (beyond the p95 scale), not `over` — with a
    // p95-based scale, `over` can fire on most bars (target→p95 band) and would
    // drown the chart in error color; only true spikes get the flag.
    ctx.fillStyle = bar.clipped ? theme.over : theme.bar
    ctx.fillRect(bar.x, bar.y, bar.w, bar.h)
  }
  if (layout.bars.length > 0 && layout.targetY > 0 && layout.targetY < layout.height) {
    ctx.fillStyle = theme.targetLine
    ctx.fillRect(0, layout.targetY, layout.width, 1)
  }
}
