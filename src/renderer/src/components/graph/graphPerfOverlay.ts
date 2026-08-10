/**
 * useGraphPerf — G-perf overlay + adaptive throttle (AF-1 slice: perf concern).
 *
 * Owns every piece of commit-measurement state for the graph: the always-on
 * commit sampler (feeds the adaptive throttle), the HUD refresh interval, and
 * the adaptive throttle controller. pushSvgFrame/flushSvgFrame (in the
 * component) read the exposed refs live, so throttling keeps working without
 * the component re-reading hook state.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SvgFrame } from './graphTypes'
import {
  RollingPerfStats,
  AdaptiveThrottle,
  THROTTLE_TARGET_P95_MS,
  THROTTLE_MIN_MS,
  THROTTLE_MAX_MS,
  type PerfSnapshot
} from './graphPerfStats'
import { SPARK_BARS } from './graphPerfSpark'
import { SVG_PUSH_THROTTLE_MS } from './graphRenderTokens'

export type PerfSnap = ReturnType<RollingPerfStats['snapshot']>

export function useGraphPerf(
  svgFrame: SvgFrame | null,
  activeView: string
): {
  perfOverlay: boolean
  setPerfOverlay: React.Dispatch<React.SetStateAction<boolean>>
  perfOverlayRef: React.MutableRefObject<boolean>
  perfStatsRef: React.MutableRefObject<RollingPerfStats | null>
  perfCommitStartRef: React.MutableRefObject<number>
  perfThrottledRef: React.MutableRefObject<number>
  perfSnap: PerfSnap | null
  canvasStatsRef: React.MutableRefObject<RollingPerfStats | null>
  canvasSnap: PerfSnapshot | null
  sparkSamples: number[]
  throttleWindowMsRef: React.MutableRefObject<number>
} {
  const [perfOverlay, setPerfOverlay] = useState(false)
  const perfOverlayRef = useRef(false)
  perfOverlayRef.current = perfOverlay
  const perfStatsRef = useRef<RollingPerfStats | null>(null)
  const perfCommitStartRef = useRef(0)
  /** Pushes deferred by the throttle (frames that never reached React). */
  const perfThrottledRef = useRef(0)
  const [perfSnap, setPerfSnap] = useState<PerfSnap | null>(null)
  /** Canvas2D gesture-path draw stats (sampled only while the overlay is on). */
  const canvasStatsRef = useRef<RollingPerfStats | null>(null)
  const [canvasSnap, setCanvasSnap] = useState<PerfSnapshot | null>(null)
  /** Last SPARK_BARS SVG commit durations — fed to the overlay spark chart. */
  const [sparkSamples, setSparkSamples] = useState<number[]>([])
  const perfTickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** Current adaptive throttle window (ms) — pushSvgFrame reads this each commit. */
  const throttleWindowMsRef = useRef(SVG_PUSH_THROTTLE_MS)
  const adaptiveThrottleRef = useRef<AdaptiveThrottle | null>(null)

  /**
   * Real-browser commit measurement: stamp before setState (done in
   * pushSvgFrame/flushSvgFrame), then useLayoutEffect fires synchronously after
   * the DOM mutation — the delta is React render + reconciliation + DOM diff
   * for exactly this frame, no rAF jitter.
   */
  useLayoutEffect(() => {
    if (!svgFrame) return
    if (!perfStatsRef.current) perfStatsRef.current = new RollingPerfStats()
    const stats = perfStatsRef.current
    const start = perfCommitStartRef.current
    stats.push({
      commitMs: start > 0 ? Math.max(0, performance.now() - start) : 0,
      edges: svgFrame.edges.length,
      nodes: svgFrame.nodes.length,
      labels: svgFrame.labels.length,
      totalEdges: svgFrame.culled?.totalEdges ?? 0,
      totalNodes: svgFrame.culled?.totalNodes ?? 0,
      renderedEdges: svgFrame.culled?.renderedEdges ?? 0,
      renderedNodes: svgFrame.culled?.renderedNodes ?? 0,
      ts: performance.now()
    })
  }, [svgFrame])

  /**
   * While the overlay is on, refresh the HUD panel a few times per second
   * (the panel is a tiny React node — cheap; it never touches the SVG tree).
   * Paused when the graph view is hidden (no commits happen anyway).
   * NOTE: does NOT null perfStatsRef — the sampler stays alive for the
   * adaptive throttle; the overlay just gets a fresh window on enable.
   */
  useEffect(() => {
    if (!perfOverlay || activeView !== 'graph') return
    // Fresh window for the panel. The adaptive controller keeps its own
    // windowMs, so only its ≥10-sample gate restarts (~1s of sim motion) —
    // acceptable, adaptation recovers quickly.
    perfStatsRef.current = new RollingPerfStats()
    perfThrottledRef.current = 0
    perfCommitStartRef.current = 0
    canvasStatsRef.current = new RollingPerfStats()
    setPerfSnap(perfStatsRef.current.snapshot())
    setCanvasSnap(null)
    setSparkSamples([])
    perfTickRef.current = setInterval(() => {
      if (perfStatsRef.current) {
        setPerfSnap(perfStatsRef.current.snapshot())
        setSparkSamples(perfStatsRef.current.recent(SPARK_BARS))
      }
      if (canvasStatsRef.current) setCanvasSnap(canvasStatsRef.current.snapshot())
    }, 250)
    return () => {
      if (perfTickRef.current) clearInterval(perfTickRef.current)
      perfTickRef.current = null
    }
  }, [perfOverlay, activeView])

  /**
   * Adaptive throttle: sample commit p95 once per second while the graph is
   * visible and let the controller widen/narrow the window (hard bounds
   * THROTTLE_MIN/MAX_MS). pushSvgFrame reads throttleWindowMsRef live, so the
   * very next commit uses the new window.
   */
  useEffect(() => {
    if (activeView !== 'graph') return
    if (!adaptiveThrottleRef.current) {
      adaptiveThrottleRef.current = new AdaptiveThrottle(SVG_PUSH_THROTTLE_MS)
    }
    const id = setInterval(() => {
      const stats = perfStatsRef.current
      const ctrl = adaptiveThrottleRef.current
      if (!stats || !ctrl) return
      const snap = stats.snapshot()
      // Gate on recent activity: a stale p95 from a long-past busy phase must
      // not silently widen/narrow the window while the user is idle.
      if (snap.fps === 0) return
      throttleWindowMsRef.current = ctrl.consider(snap.p95CommitMs, snap.count, performance.now())
    }, 1000)
    return () => clearInterval(id)
  }, [activeView])

  return {
    perfOverlay,
    setPerfOverlay,
    perfOverlayRef,
    perfStatsRef,
    perfCommitStartRef,
    perfThrottledRef,
    perfSnap,
    canvasStatsRef,
    canvasSnap,
    sparkSamples,
    throttleWindowMsRef
  }
}

export { THROTTLE_TARGET_P95_MS, THROTTLE_MIN_MS, THROTTLE_MAX_MS }
