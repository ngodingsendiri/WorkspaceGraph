/**
 * SVG element items for the graph (AF-1 slice: render concern).
 *
 * Each takes the element object as a single prop; React.memo's default shallow
 * compare turns into a reference check, so elements whose object identity is
 * stable across frames (delta merge) bail out without re-rendering or DOM
 * diffing. Defined at module scope so the component identity is stable across
 * GraphCanvas renders.
 */
import { memo, useEffect, useRef } from 'react'
import type { SvgEdge, SvgLabel, SvgNode } from './graphTypes'
import { drawSparkBars, sparkLayout } from './graphPerfSpark'
import { THROTTLE_TARGET_P95_MS } from './graphPerfStats'

export const SvgEdgeItem = memo(function SvgEdgeItem({ e }: { e: SvgEdge }) {
  return (
    <line
      x1={e.x1}
      y1={e.y1}
      x2={e.x2}
      y2={e.y2}
      stroke={e.stroke}
      strokeWidth={e.sw}
      strokeOpacity={e.op}
      strokeLinecap="round"
      strokeDasharray={e.dash}
    />
  )
})

/** AF-1 a11y: each rendered node carries its title for assistive tech. */
export const SvgNodeItem = memo(function SvgNodeItem({ n }: { n: SvgNode }) {
  return (
    <circle
      cx={n.cx}
      cy={n.cy}
      r={n.r}
      fill={n.fill === 'none' ? 'none' : n.fill}
      stroke={n.stroke}
      strokeWidth={n.sw}
      fillOpacity={n.fill === 'none' ? 0 : n.fillOp}
      strokeOpacity={n.strokeOp ?? (n.fill === 'none' ? n.fillOp : 1)}
      strokeDasharray={n.kind === 'ghost' ? '2 2' : n.dash}
      aria-label={n.title}
    />
  )
})

export const SvgLabelItem = memo(function SvgLabelItem({ lab }: { lab: SvgLabel }) {
  return (
    <text
      x={lab.x}
      y={lab.y}
      fill={lab.fill}
      fillOpacity={lab.op}
      fontSize={11}
      fontFamily='Inter, "Segoe UI", system-ui, sans-serif'
      fontWeight={lab.bold ? 600 : 400}
      textAnchor="middle"
      dominantBaseline="middle"
    >
      {lab.text}
    </text>
  )
})

function readThemeVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/**
 * G-perf overlay spark chart: last SPARK_BARS commit durations as bars on a
 * tiny canvas. Theme-aware via CSS vars (read once per draw — cheap, and the
 * chart only draws while the overlay is visible). Renders empty until samples
 * arrive; bars over the target p95 are tinted to flag throttling spikes.
 */
export const PerfSparkChart = memo(function PerfSparkChart({
  samples,
  width = 200,
  height = 30
}: {
  samples: number[]
  width?: number
  height?: number
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = width * dpr
    cv.height = height * dpr
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawSparkBars(ctx, sparkLayout(samples, width, height, THROTTLE_TARGET_P95_MS), {
      bar: readThemeVar('--color-info', '#4cc9f0'),
      over: readThemeVar('--color-error', '#f0567c'),
      targetLine: readThemeVar('--color-warning', '#f5a623')
    })
  }, [samples, width, height])
  return <canvas ref={ref} className="graph-perf-spark" />
})
