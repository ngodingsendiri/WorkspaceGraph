/**
 * Graph view — Obsidian-like Canvas 2D + d3-force (no per-node SVG DOM).
 * Default edges = wikilinks only (tag edges optional).
 *
 * Physics goal (Obsidian benchmark): alive but stable — soft settle, hubs
 * breathe, filter/data updates soft-merge positions (no full explode).
 */
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import * as d3 from 'd3'
import {
  useGraphStore,
  GraphNodeData,
  type GraphColorGroup,
  type GraphDisplayOpts,
  type GraphForceSettings,
  type GraphPerfMode,
  type GraphViewSnapshot
} from '../../store/graphStore'
import { useEditorStore } from '../../store/editorStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { SimNode, SimLink, SvgEdge, SvgNode, SvgLabel, SvgFrame } from './graphTypes'
import { deltaMerge, sameSvgEdge, sameSvgNode, sameSvgLabel } from './graphFrameDelta'
import { countGraphNotes, countGraphLinks, graphCounts } from './graphViewData'
import {
  DEFAULT_FORCE_SETTINGS,
  OBSIDIAN_SIM,
  resolveObsidianNodeFill,
  labelDrawBudget,
  resolveLod,
  edgeKey,
  smooth01,
  lerp,
  easeOutCubic,
  FORCE_PRESETS,
  canvasSafeColor,
  readPalette,
  nid,
  safeTags,
  escapeHtml
} from './graphShared'
import {
  labelZoomAlpha,
  nodeRadiusFor,
  edgeWidthFor,
  hoverEaseStep,
  HOVER_GLOW_ALPHA,
  edgeGlowAlpha,
  HOT_EDGE_COLOR_HS,
  hotEdgeWidth,
  baseEdgeOpacity,
  hotEdgeOpacity,
  PATH_EDGE_OP,
  PATH_EDGE_W,
  baseEdgeWidth,
  edgeColorFor,
  shouldThrottleSvgPush,
  NODE_ENTRY_MS,
  NODE_ENTRY_STAGGER_MS,
  nodeEntryProgress,
  nodeEntryScale,
  nodeEntryOpacity,
  edgeEntryOpacity,
  cullMargin,
  pointOnScreen,
  edgeOnScreen,
  DOT_GRID_SPACING,
  DOT_GRID_RADIUS,
  dotGrainColor,
  FOCUS_RING_DASH,
  labelBelowNode
} from './graphRenderTokens'
import {
  useGraphPerf,
  THROTTLE_TARGET_P95_MS,
  THROTTLE_MIN_MS,
  THROTTLE_MAX_MS
} from './graphPerfOverlay'
import { RollingPerfStats } from './graphPerfStats'
import { SvgEdgeItem, SvgNodeItem, SvgLabelItem, PerfSparkChart } from './graphSvgItems'
import {
  DEFAULT_DISPLAY_OPTS,
  resolveGroupColors,
  lodLabel,
  applyForces,
  spiralSeed
} from './graphQuery'
import {
  SpatialHash2D,
  diagnoseEmptyFilter,
  diagnoseViewportBlank,
  diagnosePathResult,
  formatGraphDiag,
  type GraphDiag
} from './graphDiagnostics'
import { computeHotSet, drawCanvas2DScene, type DrawContext } from './graphCanvas2D'
import {
  createTooltipScheduler,
  TOOLTIP_DELAY_MS,
  type TooltipScheduler
} from './graphTooltipScheduler'
import { TooltipPreviewCache } from './graphTooltipPreview'
import { Icon } from '../ui/Icons'
import { confirmDialog } from '../ui/Dialog'

import {
  GraphFiltersPanel,
  type OrphanMode,
  type HubMode,
  type ColorByMode
} from './GraphFiltersPanel'
import type { GraphSearchMode } from '../../store/graphStore'

/**
 * Interactive overlays rendered inside .graph-stage that must keep their own
 * clicks. .graph-svg-host and .graph-canvas are pointer-events:none, so pointer
 * events on the graph surface arrive with target = .graph-stage itself — only
 * these overlay containers (pointer-events:auto) produce their own targets.
 */
/** G18: zoom-ease duration (ms) — Obsidian-feel smooth landing for button /
 *  wheel zooms. Short enough to feel responsive, long enough to read as motion. */
const ZOOM_EASE_MS = 150

const GRAPH_OVERLAY_UI =
  '.graph-zoom-controls, .graph-filter-live-chip, .graph-diag-banner, .graph-empty'

export const GraphCanvas: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const {
    nodes,
    edges,
    fetchGraph,
    fetchGraphMeta,
    focusedNodeId,
    setFocusedNode,
    graphSettings,
    updateGraphSettings,
    orphanIds,
    hubIds,
    layoutNodes,
    layoutCamera,
    saveLayoutPositions,
    saveGraphCamera,
    findPath,
    fetchNeighborhood,
    savedViews,
    saveGraphView,
    deleteGraphView,
    consumeOpenIntent
  } = useGraphStore()
  const openTab = useEditorStore((s) => s.openTab)
  const setActiveView = useWorkspaceStore((s) => s.setActiveView)
  const activeView = useWorkspaceStore((s) => s.activeView)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** G18: running zoom-ease rAF id (0 = none) — camera animates toward target */
  const zoomTweenRafRef = useRef(0)
  /** G18: exposed so gesture handlers can start / cancel the zoom tween */
  const startZoomTweenRef = useRef<(targetK: number, fx: number, fy: number) => void>(() => {})
  const cancelZoomTweenRef = useRef<() => void>(() => {})
  const [svgFrame, setSvgFrame] = useState<SvgFrame | null>(null)
  /** Last React SVG frame COMMIT time (pushes can be throttled/deferred). */
  const lastSvgPushRef = useRef(0)
  const svgRef = useRef<SVGSVGElement | null>(null) // for PNG export clone
  const emptySvgFramesRef = useRef(0)
  const lastAutoFitOffscreenAtRef = useRef(0)
  /** Only paint hidden canvas when exporting PNG */
  const exportCanvasPaintRef = useRef(false)
  /** G-perf: while the force sim moves, throttle React SVG reconciliation. */
  const pendingSvgFrameRef = useRef<SvgFrame | null>(null)
  const svgThrottleRef = useRef(false)
  /** G-perf: previous frame element lists — delta merge reuses unchanged refs. */
  const prevEdgesRef = useRef<SvgEdge[] | null>(null)
  const prevNodesRef = useRef<SvgNode[] | null>(null)
  const prevLabelsRef = useRef<SvgLabel[] | null>(null)
  /**
   * G-perf debug overlay: real-browser commit measurement + element counts.
   * Toggle with `d` in the graph view. The sampler itself is ALWAYS on (one
   * timestamp diff + one array push per commit — negligible) because the
   * adaptive throttle window reads the same p95 even while the overlay is
   * hidden; the overlay only adds a 250 ms panel refresh tick.
   */
  const {
    perfOverlay,
    setPerfOverlay,
    perfOverlayRef,
    perfCommitStartRef,
    perfThrottledRef,
    perfSnap,
    canvasStatsRef,
    canvasSnap,
    sparkSamples,
    throttleWindowMsRef
  } = useGraphPerf(svgFrame, activeView)
  /**
   * Drop prev-frame references at structural rebuilds (filter change, empty,
   * error path). deltaMerge is value-safe (equal fields ⇒ same rendering), but
   * the caches would otherwise pin the previous graph generation's element
   * objects in memory until the next non-empty merge replaces them.
   */
  const resetFrameCache = useCallback(() => {
    prevEdgesRef.current = null
    prevNodesRef.current = null
    prevLabelsRef.current = null
  }, [])
  /**
   * Commit an SVG frame to React. With `throttle`, when a commit happened
   * within the current throttle window (throttleWindowMsRef — base
   * SVG_PUSH_THROTTLE_MS, widened/narrowed at runtime by AdaptiveThrottle) we
   * keep the newest frame as pending (latest-wins) and skip setState — the
   * frame object is still rebuilt every paint (cheap, ~0.2ms), but React does
   * not reconcile thousands of elements every sim tick.
   */
  const pushSvgFrame = useCallback(
    (frame: SvgFrame, throttle = false) => {
      const now = performance.now()
      if (
        shouldThrottleSvgPush(now, lastSvgPushRef.current, throttle, throttleWindowMsRef.current)
      ) {
        if (perfOverlayRef.current) perfThrottledRef.current++
        pendingSvgFrameRef.current = frame
        return
      }
      pendingSvgFrameRef.current = null
      lastSvgPushRef.current = now
      perfCommitStartRef.current = now
      setSvgFrame(frame)
    },
    [perfCommitStartRef, perfOverlayRef, perfThrottledRef, throttleWindowMsRef]
  )
  /** Force-commit any throttled pending frame (sim settle / gesture start). */
  const flushSvgFrame = useCallback(() => {
    const pending = pendingSvgFrameRef.current
    if (!pending) return
    pendingSvgFrameRef.current = null
    lastSvgPushRef.current = performance.now()
    perfCommitStartRef.current = performance.now()
    setSvgFrame(pending)
  }, [perfCommitStartRef])
  const flushSvgFrameRef = useRef(flushSvgFrame)
  flushSvgFrameRef.current = flushSvgFrame

  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null)
  const nodesRef = useRef<SimNode[]>([])
  const linksRef = useRef<SimLink[]>([])
  const posCache = useRef<
    Map<string, { x: number; y: number; fx?: number | null; fy?: number | null }>
  >(new Map())
  const transformRef = useRef(d3.zoomIdentity)
  const paletteRef = useRef(readPalette())
  const hoverIdRef = useRef<string | null>(null)
  /** 0..1 animated dim strength — avoids hard blink on hover enter/leave */
  const hoverStrengthRef = useRef(0)
  const hoverAnimRafRef = useRef(0)
  const dragIdRef = useRef<string | null>(null)
  const rafRef = useRef(0)
  const dirtyRef = useRef(true)
  /** Latest paint() — used by hover ease loop without stale closures */
  const paintFnRef = useRef<() => void>(() => {})
  /** DOM tooltip — avoid React setState on every hover (was causing blink/rebind) */
  const tooltipElRef = useRef<HTMLDivElement | null>(null)
  const tooltipNodeIdRef = useRef<string | null>(null)
  /** P1-2: hover-delay scheduler (timer + cancel) — lazy-built after DOM callbacks */
  const tooltipSchedulerRef = useRef<TooltipScheduler<SimNode> | null>(null)
  /** P1-3: per-note content-preview cache (readFile + strip markdown) */
  const tooltipPreviewCacheRef = useRef<TooltipPreviewCache | null>(null)
  /** P1-3: monotonic guard — a slow read must never overwrite a newer tooltip */
  const previewSeqRef = useRef(0)
  const showLabelsRef = useRef(true)
  const pathFromIdRef = useRef('')
  const pathToIdRef = useRef('')
  const showTagEdgesRef = useRef(false)
  const focusDepthRef = useRef(1)
  const layoutHydratedRef = useRef(false)
  /** Phase 6: only auto-fit once per session / after empty→data (not every filter rebuild) */
  const hasAutoFitRef = useRef(false)
  /** Restored camera from vault layout / named view — skips first auto-fit */
  const cameraHydratedRef = useRef(false)
  /**
   * User intentionally panned/zoomed this Graph visit.
   * While true, never auto-fit / force identity (BUG-2).
   * Cleared on Fit/Layout button and on re-enter Graph.
   */
  const userCameraTouchedRef = useRef(false)
  const saveLayoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveCameraTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Wheel zoom debounce — hide interactive canvas after scrolling stops */
  const wheelDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** G19: bounded entry-animation driver — repaints while new nodes fade in */
  const entryEndRef = useRef(0)
  const entryRafRef = useRef(0)
  const entryKickRef = useRef<() => void>(() => {})

  /** True only when auto recovery may steal the camera */
  const canAutoFitCamera = (): boolean =>
    !userCameraTouchedRef.current && !cameraHydratedRef.current && !hasAutoFitRef.current
  const forcesRef = useRef<GraphForceSettings>({ ...DEFAULT_FORCE_SETTINGS })
  const selectedIdsRef = useRef<Set<string>>(new Set())
  /** P2-7: index of the camera-focused node within the ordered selection ([/]) */
  const selectionNavIndexRef = useRef(0)
  /** P3-1: last observed theme — only dip the stage on an actual flip (not mount) */
  const themeRef = useRef<string | null>(null)
  /** Phase 2–4 paint flags — read each frame */
  const viewFlagsRef = useRef({
    searchMatchIds: null as Set<string> | null,
    dimHubs: true,
    hubThreshold: 12,
    focusedId: null as string | null,
    pathNodeIds: null as Set<string> | null,
    pathEdgeKeys: null as Set<string> | null,
    pathFromId: '' as string,
    pathToId: '' as string,
    focusNodeIds: null as Set<string> | null,
    focusEdgeKeys: null as Set<string> | null,
    colorBy: 'default' as ColorByMode,
    edgeColorBy: 'default' as 'default' | 'type',
    perfMode: 'auto' as GraphPerfMode,
    selectedIds: null as Set<string> | null,
    /** P2-8: camera-focused selected node ([ / ] navigation dashed ring) */
    focusSelId: null as string | null,
    /** Obsidian-like display knobs */
    arrows: false,
    textFade: 0.75,
    nodeSize: 1,
    lineThickness: 1,
    groupColors: null as Map<string, string> | null
  })

  const [selectedType, setSelectedType] = useState('all')
  const [selectedTag, setSelectedTag] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const showFiltersRef = useRef(showFilters)
  showFiltersRef.current = showFilters
  const [showTagEdges, setShowTagEdges] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [showLegend, setShowLegend] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: SimNode } | null>(null)
  const [orphanMode, setOrphanMode] = useState<OrphanMode>('all')
  const [hubMode, setHubMode] = useState<HubMode>('dim')
  const [hubThreshold, setHubThreshold] = useState(12)
  const [forces, setForces] = useState<GraphForceSettings>({ ...DEFAULT_FORCE_SETTINGS })
  const [colorBy, setColorBy] = useState<ColorByMode>('default')
  const [pathFromId, setPathFromId] = useState('')
  const [pathToId, setPathToId] = useState('')
  const [pathNodeIds, setPathNodeIds] = useState<Set<string> | null>(null)
  const [pathEdgeKeys, setPathEdgeKeys] = useState<Set<string> | null>(null)
  const [pathStatus, setPathStatus] = useState<string | null>(null)
  const pathStatusRef = useRef(pathStatus)
  pathStatusRef.current = pathStatus
  const [focusDepth, setFocusDepth] = useState(1)
  const [focusNodeIds, setFocusNodeIds] = useState<Set<string> | null>(null)
  const [focusEdgeKeys, setFocusEdgeKeys] = useState<Set<string> | null>(null)
  const [stats, setStats] = useState({ nodes: 0, edges: 0 })

  const [layoutStatus, setLayoutStatus] = useState<string | null>(null)
  /** Structured diagnosis for blank/filter/path — shown as specific if-A-then-B banner */
  const [graphDiag, setGraphDiag] = useState<GraphDiag | null>(null)
  const hadSavedCameraRef = useRef(false)
  const [pinnedCount, setPinnedCount] = useState(0)
  const [perfMode, setPerfMode] = useState<GraphPerfMode>('auto')
  const [viewsStatus, setViewsStatus] = useState<string | null>(null)
  /** Always-visible feedback for Fit / Layout / Save / PNG / Settings (panel may be closed) */
  const [actionToast, setActionToast] = useState<string | null>(null)
  const actionToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashAction = useCallback((msg: string) => {
    setActionToast(msg)
    setLayoutStatus(msg)
    if (actionToastTimer.current) clearTimeout(actionToastTimer.current)
    actionToastTimer.current = setTimeout(() => setActionToast(null), 3200)
  }, [])
  /** Phase 7 multi-select */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  /** Obsidian-like display knobs + color groups */
  const [displayOpts, setDisplayOpts] = useState<GraphDisplayOpts>({ ...DEFAULT_DISPLAY_OPTS })
  const [colorGroups, setColorGroups] = useState<GraphColorGroup[]>([])
  /** Distinguishes "still loading" vs "vault has no notes" for empty state */
  const [graphLoaded, setGraphLoaded] = useState(false)
  /** Obsidian "Existing files only" — hide unresolved ghost nodes when true */
  const [existingFilesOnly, setExistingFilesOnly] = useState(true)
  /** spotlight = dim non-matches; filter = hide non-matches */
  const [searchMode, setSearchMode] = useState<GraphSearchMode>('spotlight')
  const [showTags, setShowTags] = useState(false)
  const showTagsRef = useRef(showTags)
  showTagsRef.current = showTags
  const [showAttachments, setShowAttachments] = useState(false)
  const [animateForces, setAnimateForces] = useState(false)
  const spatialRef = useRef(new SpatialHash2D<SimNode>(56))
  const spatialDirtyRef = useRef(true)
  const animateForcesRef = useRef(false)
  animateForcesRef.current = animateForces

  forcesRef.current = forces
  selectedIdsRef.current = selectedIds
  pathFromIdRef.current = pathFromId
  pathToIdRef.current = pathToId
  showTagEdgesRef.current = showTagEdges
  focusDepthRef.current = focusDepth
  showLabelsRef.current = showLabels

  const requestPaint = useCallback(() => {
    dirtyRef.current = true
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      if (dirtyRef.current) paintFnRef.current()
    })
  }, [])

  /** fitView assigned after declaration — used by paint auto-fit without dep cycles */
  const fitViewRef = useRef<
    ((animate: boolean, onlyIds?: Set<string> | null, opts?: { silent?: boolean }) => void) | null
  >(null)
  /** ensureGraphVisible assigned later — paint HUD may call it when nodes off-screen */
  const ensureGraphVisibleRef = useRef<(reason?: string) => boolean>(() => false)

  /**
   * Size canvas like the proven editor dock pattern (visible on same machine).
   * Prefer wrap client box; fallback main-content / window. Never paint 0×0.
   */
  const syncCanvasSize = useCallback((): { w: number; h: number; ready: boolean } => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return { w: 0, h: 0, ready: false }

    // Same proven sizing formula — clientWidth first (not only getBoundingClientRect)
    let w = Math.floor(Math.max(wrap.clientWidth, canvas.clientWidth, 0))
    let h = Math.floor(Math.max(wrap.clientHeight, canvas.clientHeight, 0))
    if (w < 32 || h < 32) {
      const rect = wrap.getBoundingClientRect()
      w = Math.floor(Math.max(w, rect.width, 0))
      h = Math.floor(Math.max(h, rect.height, 0))
    }
    if (w < 32 || h < 32) {
      const main = wrap.closest('.main-content') as HTMLElement | null
      if (main) {
        w = Math.floor(Math.max(main.clientWidth, w))
        h = Math.floor(Math.max(main.clientHeight - 48, h)) // leave toolbar room
      }
    }
    if (w < 32 || h < 32) {
      w = Math.max(320, Math.floor(window.innerWidth * 0.55))
      h = Math.max(240, Math.floor(window.innerHeight * 0.65))
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const bw = Math.max(1, Math.floor(w * dpr))
    const bh = Math.max(1, Math.floor(h * dpr))
    // Match LocalGraph: only resize buffer when needed (resize clears pixels)
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }
    // CSS size via stylesheet (100%) — still set inline as LocalGraph does for reliability
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    return { w, h, ready: true }
  }, [])

  /** Ease hoverStrengthRef toward 1 (hovering) / 0 (clear) — soft Obsidian feel.
   *  Time-based exponential smoothing (G5): identical transition on any refresh
   *  rate — ~150 ms in, ~240 ms out (snappier in, softer out). */
  const kickHoverAnim = useCallback(() => {
    if (hoverAnimRafRef.current) return
    let lastTs = 0
    const step = (ts: number): void => {
      const target = hoverIdRef.current ? 1 : 0
      const cur = hoverStrengthRef.current
      // First frame has no previous timestamp — start the clock, keep value.
      if (!lastTs) lastTs = ts
      // dt drives the easing; clamp stale gaps (e.g. hidden tab) to avoid jumps.
      const dt = Math.min(Math.max(ts - lastTs, 0), 50)
      lastTs = ts
      const next = hoverEaseStep(cur, target, dt)
      if (Math.abs(next - target) < 0.012) {
        hoverStrengthRef.current = target
        hoverAnimRafRef.current = 0
        if (interactiveCanvasRef.current) drawCanvas2DRef.current()
        else requestPaint()
        return
      }
      hoverStrengthRef.current = next
      if (interactiveCanvasRef.current) drawCanvas2DRef.current()
      else requestPaint()
      hoverAnimRafRef.current = requestAnimationFrame(step)
    }
    hoverAnimRafRef.current = requestAnimationFrame(step)
  }, [requestPaint])

  const setHoverId = useCallback(
    (id: string | null) => {
      if (hoverIdRef.current === id) return
      hoverIdRef.current = id
      // Keep strength if switching node→node so dim doesn't drop to 0 mid-hover
      if (id && hoverStrengthRef.current < 0.55) {
        hoverStrengthRef.current = Math.max(hoverStrengthRef.current, 0.55)
      }
      kickHoverAnim()
    },
    [kickHoverAnim]
  )

  /** Imperative tooltip — no React re-render on pointermove */
  const hideTooltipDom = useCallback(() => {
    // P1-3: invalidate any in-flight preview so it cannot write into a fresh tooltip
    previewSeqRef.current++
    const el = tooltipElRef.current
    if (!el) return
    el.style.opacity = '0'
    tooltipNodeIdRef.current = null
  }, [])

  const showTooltipDom = useCallback((hit: SimNode, clientX: number, clientY: number) => {
    const el = tooltipElRef.current
    if (!el) return
    const rect = wrapRef.current?.getBoundingClientRect()
    const x = clientX - (rect?.left || 0) + 14
    const y = clientY - (rect?.top || 0) + 14
    if (tooltipNodeIdRef.current !== hit.id) {
      const tags = safeTags(hit)
      const deg = typeof hit.degree === 'number' ? hit.degree : 0
      const showPath = hit.relativePath || hit.path || ''
      el.innerHTML = `<div class="gt-title">${escapeHtml(hit.title || '')}</div>
        <div class="gt-meta">${escapeHtml(hit.type || 'note')} · ${deg} link${deg !== 1 ? 's' : ''}</div>
        ${showPath ? `<div class="gt-path">${escapeHtml(showPath)}</div>` : ''}
        ${tags.length ? `<div class="gt-tags">${tags.map((t) => '#' + escapeHtml(String(t))).join(' ')}</div>` : ''}
        <div class="gt-preview gt-preview-loading">memuat…</div>
        <div class="gt-hint">klik select · dblklik buka · Ctrl+klik multi · Shift path · Alt focus<br>[ ] siklus seleksi · Enter buka · Esc deselect</div>`
      tooltipNodeIdRef.current = hit.id
      // P1-3: fill the preview from the per-note cache; a later show/hide bumps
      // previewSeqRef so this read can never paint into a different tooltip
      const seq = ++previewSeqRef.current
      const pid = hit.id
      void tooltipPreviewCacheRef.current?.get(hit).then((text) => {
        if (seq !== previewSeqRef.current) return
        // The tooltip may have been re-targeted — only paint into pid's own preview
        if (tooltipNodeIdRef.current !== pid) return
        const pv = tooltipElRef.current?.querySelector('.gt-preview')
        if (!pv) return
        if (text) {
          pv.textContent = text
          pv.classList.remove('gt-preview-loading')
        } else {
          pv.remove()
        }
      })
    }
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.opacity = '1'
  }, [])

  const moveTooltipDom = useCallback((clientX: number, clientY: number) => {
    const el = tooltipElRef.current
    if (!el || tooltipNodeIdRef.current == null) return
    const rect = wrapRef.current?.getBoundingClientRect()
    el.style.left = `${clientX - (rect?.left || 0) + 14}px`
    el.style.top = `${clientY - (rect?.top || 0) + 14}px`
  }, [])

  useEffect(() => {
    setGraphLoaded(false)
    void fetchGraph().finally(() => setGraphLoaded(true))
    void fetchGraphMeta()
    const unsub = window.api.onGraphUpdated(() => {
      void fetchGraph().finally(() => setGraphLoaded(true))
      void fetchGraphMeta()
      // P1-3: note bodies may have changed (edit/save) — drop stale previews
      tooltipPreviewCacheRef.current?.invalidate()
    })
    return () => {
      unsub()
      if (hoverAnimRafRef.current) cancelAnimationFrame(hoverAnimRafRef.current)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (saveLayoutTimer.current) clearTimeout(saveLayoutTimer.current)
      if (saveCameraTimer.current) clearTimeout(saveCameraTimer.current)
      if (actionToastTimer.current) clearTimeout(actionToastTimer.current)
    }
  }, [fetchGraph, fetchGraphMeta])

  /** True while mouse/touch is down for pan or node-drag */
  const pointerGestureRef = useRef(false)
  /** True while Canvas 2D is rendering directly (bypass React SVG for 60fps pan) */
  const interactiveCanvasRef = useRef(false)
  /** drawCanvas2D assigned after declaration — used by setCameraTransform without dep cycles */
  const drawCanvas2DRef = useRef<() => void>(() => {})

  const scheduleSaveCamera = useCallback(() => {
    if (saveCameraTimer.current) clearTimeout(saveCameraTimer.current)
    saveCameraTimer.current = setTimeout(() => {
      if (pointerGestureRef.current) return
      const t = transformRef.current
      if (!t || !Number.isFinite(t.k)) return
      void saveGraphCamera({ x: t.x, y: t.y, k: t.k })
    }, 700)
  }, [saveGraphCamera])

  const scheduleSaveCameraRef = useRef(scheduleSaveCamera)
  scheduleSaveCameraRef.current = scheduleSaveCamera

  /** Set camera transform (Fit / restore / keyboard / pan) */
  const setCameraTransform = useCallback(
    (t: d3.ZoomTransform, opts?: { user?: boolean; save?: boolean; tween?: boolean }) => {
      // A user-initiated camera jump (Fit / reset / restore / keyboard) cancels
      // any running zoom ease — the tween's own steps pass tween:true to skip.
      if (!opts?.tween) cancelZoomTweenRef.current()
      transformRef.current = t
      if (opts?.user) {
        userCameraTouchedRef.current = true
        cameraHydratedRef.current = true
      }
      // During interactive gesture or wheel, draw directly to Canvas 2D (bypass React SVG)
      if (interactiveCanvasRef.current) {
        drawCanvas2DRef.current()
      } else {
        requestPaint()
      }
      if (opts?.save !== false) scheduleSaveCameraRef.current()
    },
    [requestPaint]
  )
  const setCameraTransformRef = useRef(setCameraTransform)
  setCameraTransformRef.current = setCameraTransform

  /**
   * How many nodes project into the viewport?
   * Optional cam/points: pre-check vault camera against layout positions before restore.
   */
  const countNodesInViewport = useCallback(
    (
      cam?: { x: number; y: number; k: number },
      points?: { x: number; y: number }[]
    ): { inView: number; total: number; w: number; h: number } => {
      const sized = syncCanvasSize()
      let w = sized.ready ? sized.w : wrapRef.current?.clientWidth || 0
      let h = sized.ready ? sized.h : wrapRef.current?.clientHeight || 0
      if (w < 32 || h < 32) {
        w = Math.max(320, Math.floor(window.innerWidth * 0.55))
        h = Math.max(240, Math.floor(window.innerHeight * 0.65))
      }
      const t = cam || transformRef.current
      const pad = 32
      let inView = 0
      let total = 0
      const list =
        points ||
        nodesRef.current
          .filter(
            (n) => n.x != null && n.y != null && Number.isFinite(n.x!) && Number.isFinite(n.y!)
          )
          .map((n) => ({ x: n.x as number, y: n.y as number }))
      for (const n of list) {
        total++
        const sx = n.x * t.k + t.x
        const sy = n.y * t.k + t.y
        if (sx >= -pad && sx <= w + pad && sy >= -pad && sy <= h + pad) inView++
      }
      return { inView, total, w, h }
    },
    [syncCanvasSize]
  )

  const cameraShowsPoints = useCallback(
    (cam: { x: number; y: number; k: number }, points: { x: number; y: number }[]) => {
      if (cam.k < 0.08 || cam.k > 5) return false
      const { inView, total, w, h } = countNodesInViewport(cam, points)
      if (total === 0) return true
      if (w < 32 || h < 32) return false
      const minNeed = total <= 5 ? 1 : Math.max(1, Math.floor(total * 0.05))
      return inView >= minNeed
    },
    [countNodesInViewport]
  )

  const applyCamera = useCallback(
    (cam: { x: number; y: number; k: number } | null | undefined, markHydrated = true) => {
      if (!cam || !Number.isFinite(cam.k) || cam.k <= 0) return false
      if (cam.k < 0.05 || cam.k > 6) return false
      setCameraTransformRef.current(d3.zoomIdentity.translate(cam.x, cam.y).scale(cam.k), {
        user: false,
        save: false
      })
      if (markHydrated) cameraHydratedRef.current = true
      return true
    },
    []
  )

  // Restore vault camera once when available (BUG-1).
  // Never re-apply on camera auto-save (would fight pan) or mid-gesture.
  const camRestoreOnceRef = useRef(false)
  useEffect(() => {
    if (activeView !== 'graph') {
      camRestoreOnceRef.current = false
      return
    }
    if (camRestoreOnceRef.current) return
    if (userCameraTouchedRef.current || pointerGestureRef.current) return
    if (cameraHydratedRef.current) return
    if (!layoutCamera) return

    hadSavedCameraRef.current = true
    const layoutPts = Object.values(layoutNodes || {})
      .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({ x: p.x, y: p.y }))

    const ok = layoutPts.length === 0 ? true : cameraShowsPoints(layoutCamera, layoutPts)

    if (!ok) {
      // Leave cameraHydrated false so first auto-fit may run — but mark restore attempted
      camRestoreOnceRef.current = true
      hasAutoFitRef.current = false
      return
    }
    if (applyCamera(layoutCamera, true)) {
      camRestoreOnceRef.current = true
      hasAutoFitRef.current = true
      // Quiet restore — no setState banner (setState here was re-rendering during interaction)
    }
  }, [activeView, layoutCamera, layoutNodes, applyCamera, cameraShowsPoints])

  /**
   * Pending open-intent from dashboard — applied AFTER settings hydrate so
   * fetchGraphMeta/hydrate cannot overwrite orphanMode/search from intent.
   */
  const pendingIntentRef = useRef<import('../../store/graphStore').GraphOpenIntent | null>(null)
  const settingsHydratedRef = useRef(false)

  const applyOpenIntent = useCallback(
    (intent: import('../../store/graphStore').GraphOpenIntent) => {
      if (intent.orphanMode) setOrphanMode(intent.orphanMode)
      if (intent.hubMode) setHubMode(intent.hubMode)
      if (intent.searchQuery != null) setSearchQuery(intent.searchQuery)
      if (intent.searchMode) setSearchMode(intent.searchMode)
      if (intent.showTags != null) setShowTags(intent.showTags)
      if (intent.showAttachments != null) setShowAttachments(intent.showAttachments)
      if (intent.focusNodeId) setFocusedNode(intent.focusNodeId)
      if (intent.orphanMode === 'only') {
        setPathStatus('Filter: orphans only (dari dashboard)')
        setShowFilters(true)
      }
      requestPaint()
    },
    [setFocusedNode, requestPaint]
  )

  // Capture intent when Graph becomes active (may run before settings hydrate)
  useEffect(() => {
    if (activeView !== 'graph') return
    const intent = consumeOpenIntent()
    if (!intent) return
    if (settingsHydratedRef.current) {
      applyOpenIntent(intent)
    } else {
      pendingIntentRef.current = intent
    }
  }, [activeView, consumeOpenIntent, applyOpenIntent])

  /**
   * Hydrate filter/display/forces ONCE per mount.
   * Re-running on every fetchGraphMeta would wipe keyboard/dashboard filters mid-session.
   */
  useEffect(() => {
    if (!graphSettings) return
    // Always drain pending intent even after first hydrate
    const drainPending = (): void => {
      settingsHydratedRef.current = true
      const pending = pendingIntentRef.current
      if (pending) {
        pendingIntentRef.current = null
        requestAnimationFrame(() => applyOpenIntent(pending))
      }
    }
    if (settingsHydratedRef.current) {
      drainPending()
      return
    }
    try {
      const gd = graphSettings.display || ({} as typeof graphSettings.display)
      // Hydrate filters.orphanMode + filters.hubMode from persisted settings
      const filters = graphSettings.filters || {
        hubDegreeThreshold: 12,
        localDepth: 1,
        orphanMode: 'all' as const,
        hubMode: 'dim' as const
      }
      setShowLabels(gd.showLabels !== false)
      setShowTagEdges(Boolean(gd.showTagEdges))
      setShowLegend(Boolean(gd.showLegend))
      const thr = filters.hubDegreeThreshold
      setHubThreshold(typeof thr === 'number' && Number.isFinite(thr) ? thr : 12)
      const om = filters.orphanMode
      if (om === 'all' || om === 'hide' || om === 'only') {
        setOrphanMode(om)
      } else if (gd.hideOrphans) {
        setOrphanMode('hide')
      } else {
        setOrphanMode('all')
      }
      const hm = filters.hubMode
      if (hm === 'all' || hm === 'dim' || hm === 'hide') {
        setHubMode(hm)
      } else if (gd.dimHubs) {
        setHubMode('dim')
      } else {
        setHubMode('all')
      }
      if (graphSettings.forces) {
        setForces({ ...DEFAULT_FORCE_SETTINGS, ...graphSettings.forces })
      }
      setDisplayOpts({
        arrows: gd.arrows ?? DEFAULT_DISPLAY_OPTS.arrows,
        textFade: gd.textFade ?? DEFAULT_DISPLAY_OPTS.textFade,
        nodeSize: gd.nodeSize ?? DEFAULT_DISPLAY_OPTS.nodeSize,
        lineThickness: gd.lineThickness ?? DEFAULT_DISPLAY_OPTS.lineThickness,
        edgeColorBy: gd.edgeColorBy === 'type' ? 'type' : 'default'
      })
      setExistingFilesOnly(gd.existingFilesOnly !== false)
      setShowTags(Boolean(gd.showTags))
      setShowAttachments(Boolean(gd.showAttachments))
      setAnimateForces(Boolean(gd.animateForces))
      const sm = filters.searchMode
      setSearchMode(sm === 'filter' ? 'filter' : 'spotlight')
      setColorGroups(Array.isArray(graphSettings.groups) ? graphSettings.groups : [])
      drainPending()
    } catch (err) {
      console.error('[GraphCanvas] hydrate settings failed:', err)
    }
  }, [graphSettings, applyOpenIntent])

  // Seed posCache from vault layout file (once per load; user moves win afterwards)
  useEffect(() => {
    const entries = Object.entries(layoutNodes || {})
    if (entries.length === 0) return
    const firstHydrate = !layoutHydratedRef.current
    let seeded = 0
    for (const [id, pos] of entries) {
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue
      const existing = posCache.current.get(id)
      // First hydrate: vault wins. Later: only fill missing ids.
      if (!firstHydrate && existing) continue
      posCache.current.set(id, {
        x: pos.x,
        y: pos.y,
        fx: pos.pinned ? pos.x : (existing?.fx ?? null),
        fy: pos.pinned ? pos.y : (existing?.fy ?? null)
      })
      seeded++
    }
    layoutHydratedRef.current = true
    for (const n of nodesRef.current) {
      const c = posCache.current.get(n.id)
      if (!c) continue
      if (firstHydrate || n.x == null) {
        n.x = c.x
        n.y = c.y
      }
      if (c.fx != null && c.fy != null) {
        n.fx = c.fx
        n.fy = c.fy
        n.pinned = true
      }
    }
    setPinnedCount(nodesRef.current.filter((n) => n.pinned || n.fx != null).length)
    if (seeded > 0) {
      simRef.current?.alpha(0.12).restart()
      requestPaint()
    }
  }, [layoutNodes, requestPaint])

  useEffect(() => {
    const apply = (): void => {
      paletteRef.current = readPalette()
      const mode = document.documentElement.getAttribute('data-theme')
      const stage = wrapRef.current
      if (
        themeRef.current != null &&
        themeRef.current !== mode &&
        stage &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
        !stage.classList.contains('graph-theme-fade')
      ) {
        // P3-1: painted canvas/SVG colors can't CSS-transition, so dip the
        // stage opacity briefly — the repaint reads as an Obsidian cross-fade.
        // Reduced-motion skips the class entirely (animation:none would leave
        // it stuck — animationend never fires).
        stage.classList.add('graph-theme-fade')
        const onEnd = (e: AnimationEvent): void => {
          if (e.animationName === 'graph-theme-fade') {
            stage.classList.remove('graph-theme-fade')
            stage.removeEventListener('animationend', onEnd)
          }
        }
        stage.addEventListener('animationend', onEnd)
      }
      themeRef.current = mode
      requestPaint()
    }
    apply()
    const obs = new MutationObserver(apply)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [requestPaint])

  const allTags = useMemo(() => {
    const s = new Set<string>()
    for (const n of nodes) {
      for (const t of safeTags(n)) s.add(t)
    }
    return Array.from(s).sort()
  }, [nodes])

  const typeOptions = useMemo(() => {
    const s = new Set(nodes.map((n) => n.type).filter(Boolean))
    return Array.from(s).sort()
  }, [nodes])

  // Spotlight: match ids (null = no search) — title / path / tags (Obsidian-like)
  const searchMatchIds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return null
    const bare = q.replace(/^#/, '')
    return new Set(
      nodes
        .filter((n) => {
          if ((n.title || '').toLowerCase().includes(q)) return true
          if ((n.relativePath || '').toLowerCase().includes(q)) return true
          if ((n.type || '').toLowerCase() === q || (n.type || '').toLowerCase().includes(q))
            return true
          return safeTags(n).some((t) => t.toLowerCase().includes(bare) || t.toLowerCase() === bare)
        })
        .map((n) => n.id)
    )
  }, [nodes, searchQuery])

  const orphanIdSet = useMemo(() => new Set(orphanIds), [orphanIds])

  /**
   * Visible-graph degree for orphan/hub filters.
   * - Always ignore ghosts when existingFilesOnly
   * - Count tag edges only when showTags is on (tag nodes visible)
   * - Ignore attachments when showAttachments is off
   */
  const realDegreeById = useMemo(() => {
    const hidden = new Set<string>()
    for (const n of nodes) {
      if (existingFilesOnly && (n.isGhost || n.type === 'ghost')) hidden.add(n.id)
      if (!showTags && (n.isTag || n.type === 'tag')) hidden.add(n.id)
      if (!showAttachments && (n.isAttachment || n.type === 'attachment')) hidden.add(n.id)
    }
    const neigh = new Map<string, Set<string>>()
    for (const e of edges) {
      const s = typeof e.source === 'string' ? e.source : ''
      const t = typeof e.target === 'string' ? e.target : ''
      if (!s || !t || s === t) continue
      if (e.type === 'tag' && !showTags) continue
      if (hidden.has(s) || hidden.has(t)) continue
      if (!neigh.has(s)) neigh.set(s, new Set())
      if (!neigh.has(t)) neigh.set(t, new Set())
      neigh.get(s)!.add(t)
      neigh.get(t)!.add(s)
    }
    const undirected = new Map<string, number>()
    for (const n of nodes) {
      if (hidden.has(n.id)) continue
      undirected.set(n.id, neigh.get(n.id)?.size ?? 0)
    }
    return undirected
  }, [nodes, edges, existingFilesOnly, showTags, showAttachments])

  // Prefer live degree (always on node); fall back to engine orphan set if degree missing
  const filteredNodesRef = useRef<GraphNodeData[]>([])
  const filteredEdgesRef = useRef<typeof edges>([])

  const filteredNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const bare = q.replace(/^#/, '')
    return nodes.filter((n) => {
      if (!n?.id) return false
      // Obsidian "Existing files only"
      if (existingFilesOnly && (n.isGhost || n.type === 'ghost')) return false
      if (!showTags && (n.isTag || n.type === 'tag')) return false
      if (!showAttachments && (n.isAttachment || n.type === 'attachment')) return false
      if (selectedType !== 'all' && n.type !== selectedType) return false
      if (selectedTag !== 'all' && !safeTags(n).includes(selectedTag)) return false
      // Always use visible-degree (matches on-screen edges), not raw engine degree
      const deg =
        realDegreeById.get(n.id) ??
        (orphanIdSet.has(n.id)
          ? 0
          : typeof n.degree === 'number' && Number.isFinite(n.degree)
            ? n.degree
            : 0)
      const isOrphan = !n.isGhost && !n.isTag && !n.isAttachment && deg === 0
      if (orphanMode === 'hide' && isOrphan) return false
      if (orphanMode === 'only' && !isOrphan) return false
      if (hubMode === 'hide' && deg >= hubThreshold) return false
      // Search filter mode = Obsidian subtraction (hide non-matches)
      if (searchMode === 'filter' && q) {
        const title = (n.title || '').toLowerCase()
        const path = (n.relativePath || '').toLowerCase()
        const hit =
          title.includes(q) ||
          path.includes(q) ||
          (n.type || '').toLowerCase().includes(q) ||
          safeTags(n).some((t) => t.toLowerCase().includes(bare))
        if (!hit) return false
      }
      return true
    })
  }, [
    nodes,
    selectedType,
    selectedTag,
    orphanMode,
    hubMode,
    hubThreshold,
    orphanIdSet,
    existingFilesOnly,
    showTags,
    showAttachments,
    searchMode,
    searchQuery,
    realDegreeById
  ])

  const filteredNodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes])
  const nodeById = useMemo(() => {
    const m = new Map<string, (typeof nodes)[0]>()
    for (const n of nodes) m.set(n.id, n)
    return m
  }, [nodes])

  const filteredEdges = useMemo(() => {
    return edges.filter((e) => {
      const src = typeof e.source === 'string' ? e.source : (e.source as { id?: string })?.id
      const tgt = typeof e.target === 'string' ? e.target : (e.target as { id?: string })?.id
      if (!src || !tgt) return false
      if (!filteredNodeIds.has(src) || !filteredNodeIds.has(tgt)) return false
      if (e.type === 'tag') {
        // Note→#tag edges must show when Tags filter is on.
        // Co-tag star edges between notes only when showTagEdges is on.
        const sn = nodeById.get(src)
        const tn = nodeById.get(tgt)
        const involvesTagNode =
          Boolean(sn?.isTag || sn?.type === 'tag' || tn?.isTag || tn?.type === 'tag') ||
          src.startsWith('tag:') ||
          tgt.startsWith('tag:')
        if (involvesTagNode) {
          if (!showTags) return false
        } else if (!showTagEdges) {
          return false
        }
      }
      return true
    })
  }, [edges, filteredNodeIds, showTagEdges, showTags, nodeById])

  // Live refs so graph-enter timers don't rebind on every filter tick
  filteredNodesRef.current = filteredNodes
  filteredEdgesRef.current = filteredEdges

  // F-5: ONE source of truth for the "notes · links" header — counts real
  // notes (never tag/ghost/attachment nodes) and non-tag links, exactly like
  // the dashboard Graph card. Raw sim totals (stats) stay for LOD/perf.
  const { notes: noteCount, links: linkCount } = useMemo(
    () => graphCounts(filteredNodes, filteredEdges),
    [filteredNodes, filteredEdges]
  )

  // P2-7: never keep a selection on ids that left the visible graph (note
  // deleted, filter changed, rebuild) — Delete/O/arrows must not act on ghosts
  useEffect(() => {
    if (selectedIds.size === 0) return
    const kept = new Set([...selectedIds].filter((id) => filteredNodeIds.has(id)))
    if (kept.size !== selectedIds.size) setSelectedIds(kept)
  }, [filteredNodeIds, selectedIds])

  // Obsidian-like color groups: node id → group color (first match wins)
  const groupColorById = useMemo(() => resolveGroupColors(nodes, colorGroups), [nodes, colorGroups])

  /**
   * AF-1 a11y: accessible fallback — a keyboard/screen-reader reachable list of
   * the visible notes (the canvas itself is not keyboard-navigable as a list).
   * Rendered sr-only; capped so a huge vault doesn't emit thousands of buttons.
   */
  const a11yNodeList = useMemo(() => {
    return nodes
      .filter((n) => n.path && !n.isGhost && !n.isTag && !n.isAttachment)
      .sort((a, b) => (a.title || '').localeCompare(b.title || ''))
      .slice(0, 150)
  }, [nodes])

  // Keep paint flags in sync — mutate existing ref to avoid recreation
  viewFlagsRef.current.searchMatchIds = searchMatchIds
  viewFlagsRef.current.dimHubs = hubMode === 'dim'
  viewFlagsRef.current.hubThreshold = hubThreshold
  viewFlagsRef.current.focusedId = focusedNodeId
  viewFlagsRef.current.pathNodeIds = pathNodeIds
  viewFlagsRef.current.pathEdgeKeys = pathEdgeKeys
  viewFlagsRef.current.pathFromId = pathFromId
  viewFlagsRef.current.pathToId = pathToId
  viewFlagsRef.current.focusNodeIds = focusNodeIds
  viewFlagsRef.current.focusEdgeKeys = focusEdgeKeys
  viewFlagsRef.current.colorBy = colorBy
  viewFlagsRef.current.perfMode = perfMode
  viewFlagsRef.current.selectedIds = selectedIds.size > 0 ? selectedIds : null
  viewFlagsRef.current.arrows = displayOpts.arrows
  viewFlagsRef.current.textFade = displayOpts.textFade
  viewFlagsRef.current.nodeSize = displayOpts.nodeSize
  viewFlagsRef.current.lineThickness = displayOpts.lineThickness
  viewFlagsRef.current.edgeColorBy = displayOpts.edgeColorBy
  viewFlagsRef.current.groupColors = groupColorById

  const nodeOptions = useMemo(
    () =>
      [...nodes]
        .map((n) => ({ id: n.id, title: n.title || n.relativePath }))
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })),
    [nodes]
  )

  const paint = useCallback(() => {
    // During interactive gestures, draw directly to Canvas 2D — skip SVG reconciliation
    if (interactiveCanvasRef.current) {
      // Consume any leftover sim-motion throttle: a gesture can span a sim tick
      // (grab a node mid-settle), so the paint right after hideInteractiveCanvas
      // must commit the final frame — never inherit a stale throttle flag.
      svgThrottleRef.current = false
      pendingSvgFrameRef.current = null
      drawCanvas2DRef.current()
      dirtyRef.current = false
      return
    }
    // G-perf: this paint may be a sim-motion frame — throttle the React commit.
    // Read + reset here so only the sim-tick paints are throttled, not hover /
    // entry / zoom tweens (those flush every frame for smooth interaction).
    const svgThrottle = svgThrottleRef.current
    svgThrottleRef.current = false
    try {
      // ── Size from STAGE (wrap) first — display must not depend on hidden canvas ──
      const wrap = wrapRef.current
      const canvas = canvasRef.current
      const sized = syncCanvasSize()
      let w = sized.ready ? sized.w : Math.floor(wrap?.clientWidth || 0)
      let h = sized.ready ? sized.h : Math.floor(wrap?.clientHeight || 0)
      if (w < 8 || h < 8) {
        // If wrap has no dimensions at all, don't loop — wait for ResizeObserver
        if (!wrap || wrap.clientWidth < 2 || wrap.clientHeight < 2) {
          dirtyRef.current = true
          return
        }
        w = Math.max(320, Math.floor(window.innerWidth * 0.55))
        h = Math.max(240, Math.floor(window.innerHeight * 0.65))
        dirtyRef.current = true
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0
            paintFnRef.current()
          })
        }
        // Still try to draw with fallback size — don't leave SVG blank forever
      }

      const pal = paletteRef.current
      const t = transformRef.current
      const simNodes = nodesRef.current
      const simLinks = linksRef.current
      const hover = hoverIdRef.current
      /** Animated 0..1 — multiplies hover dim so enter/leave doesn't hard-flash */
      const hs = hoverStrengthRef.current
      const flags = viewFlagsRef.current
      const lod = resolveLod(simNodes.length, flags.perfMode)
      const large = lod !== 'full' || simNodes.length > 100
      // LOD culling: shared frustum margin (same rule as Canvas2D — no handoff
      // pop at the viewport edge, and low LOD culls tighter on huge vaults).
      const margin = cullMargin(lod)

      const kSafe = Math.max(t.k, 0.05)

      const pathN = flags.pathNodeIds
      const pathE = flags.pathEdgeKeys
      const focN = flags.focusNodeIds
      const focE = flags.focusEdgeKeys
      const focusId = flags.focusedId
      const colorMode = flags.colorBy
      const matchIds = flags.searchMatchIds
      const thr = flags.hubThreshold
      const dimHubsOn = flags.dimHubs

      // ── 1) React SVG frame (Obsidian: world-space graph + screen labels) ──
      let drawn = 0
      try {
        if (simNodes.length === 0) {
          emptySvgFramesRef.current++
          // Keep last React frame during short rebuilds; only clear after many empty frames
          if (emptySvgFramesRef.current >= 12) {
            pushSvgFrame({
              w: Math.max(1, w),
              h: Math.max(1, h),
              tx: t.x,
              ty: t.y,
              k: t.k || 1,
              edges: [],
              nodes: [],
              labels: [],
              culled: { totalEdges: 0, totalNodes: 0, renderedEdges: 0, renderedNodes: 0 },
              hud: 'sim:0 · kosong — cek filter / data vault'
            })
          }
        } else {
          emptySvgFramesRef.current = 0
          const sizeMul = flags.nodeSize || 1
          const lineMul = flags.lineThickness || 1

          // Hover neighbor set (Obsidian: dim non-neighbors)
          let hot: Set<string> | null = null
          if (hover && hs > 0.02) {
            hot = new Set([hover])
            for (const e of simLinks) {
              const s = nid(e.source)
              const tg = nid(e.target)
              if (s === hover) hot.add(tg)
              if (tg === hover) hot.add(s)
            }
          }

          for (const n of simNodes) {
            if (n.x == null || n.y == null || !Number.isFinite(n.x) || !Number.isFinite(n.y))
              continue
            const sx = n.x * t.k + t.x
            const sy = n.y * t.k + t.y
            if (pointOnScreen(sx, sy, w, h, margin)) drawn++
          }

          const byId = new Map(simNodes.map((n) => [n.id, n]))
          const end = (x: string | SimNode): SimNode | null => {
            if (x && typeof x === 'object' && 'id' in x) return x as SimNode
            if (typeof x === 'string') return byId.get(x) || null
            return null
          }

          // G19: entry animation — one time base + batch max order for the WHOLE
          // paint (nodes, labels AND edges) so the stagger is stable frame to
          // frame and the SVG↔canvas handoff mid-animation stays identical.
          const entryNow = performance.now()
          const entryMaxOrder = simNodes.reduce(
            (m, nd) => (nd.enterOrder != null ? Math.max(m, nd.enterOrder) : m),
            -1
          )

          // LOD culling BEFORE the budget: off-frustum edges never consume the
          // LOD budget, so a zoomed-in cluster keeps full detail instead of
          // wasting slots on edges the user can't see. Path/focus edges always
          // pass (they are the point of the highlight).
          const visibleLinks: SimLink[] = []
          for (const e of simLinks) {
            const s = end(e.source as string | SimNode)
            const tg = end(e.target as string | SimNode)
            if (!s?.id || !tg?.id || s.x == null || s.y == null || tg.x == null || tg.y == null)
              continue
            if (
              !Number.isFinite(s.x) ||
              !Number.isFinite(s.y) ||
              !Number.isFinite(tg.x) ||
              !Number.isFinite(tg.y)
            )
              continue
            const ek = edgeKey(s.id, tg.id)
            if ((pathE != null && pathE.has(ek)) || (focE != null && focE.has(ek))) {
              visibleLinks.push(e)
              continue
            }
            const esx1 = s.x * t.k + t.x
            const esy1 = s.y * t.k + t.y
            const esx2 = tg.x * t.k + t.x
            const esy2 = tg.y * t.k + t.y
            if (edgeOnScreen(esx1, esy1, esx2, esy2, w, h, margin)) visibleLinks.push(e)
          }
          const maxE = Math.min(
            visibleLinks.length,
            lod === 'low' ? 500 : lod === 'medium' ? 1500 : 6000
          )
          const edgesOut: SvgEdge[] = []
          let edgeList = visibleLinks
          if (visibleLinks.length > maxE) {
            // Perf: priority sort is O(E·log E) per frame; without any highlight
            // layer (path/focus/hover) every edge scores 0 so sort is pure waste
            // on every sim tick of a large vault — slice directly instead.
            const hasEdgePriority = pathE != null || focE != null || hot != null
            edgeList = hasEdgePriority
              ? [...visibleLinks]
                  .sort((a, b) => {
                    const score = (e: SimLink): 0 | 3 | 2 => {
                      const s = end(e.source as string | SimNode)
                      const tg = end(e.target as string | SimNode)
                      if (!s?.id || !tg?.id) return 0
                      const ek = edgeKey(s.id, tg.id)
                      if (pathE != null && pathE.has(ek)) return 3
                      if (focE != null && focE.has(ek)) return 2
                      if (hot && (s.id === hover || tg.id === hover)) return 2
                      return 0
                    }
                    return score(b) - score(a)
                  })
                  .slice(0, maxE)
              : visibleLinks.slice(0, maxE)
          }
          for (const e of edgeList) {
            const s = end(e.source as string | SimNode)
            const tg = end(e.target as string | SimNode)
            if (!s?.id || !tg?.id || s.x == null || s.y == null || tg.x == null || tg.y == null)
              continue
            if (
              !Number.isFinite(s.x) ||
              !Number.isFinite(s.y) ||
              !Number.isFinite(tg.x) ||
              !Number.isFinite(tg.y)
            )
              continue
            const ek = edgeKey(s.id, tg.id)
            const onPath = pathE != null && pathE.has(ek)
            const onFoc = focE != null && focE.has(ek)
            const isHot =
              Boolean(hot) &&
              (s.id === hover || tg.id === hover) &&
              hot!.has(s.id) &&
              hot!.has(tg.id)
            // Edges here are pre-culled (visibleLinks) — path/focus always pass.
            const dimHover = Boolean(hot && !isHot && pathN == null && focN == null)
            const dimPath = pathN != null && !onPath
            const dimFocus = pathN == null && focN != null && !onFoc
            const dimSearch =
              pathN == null &&
              focN == null &&
              matchIds != null &&
              !matchIds.has(s.id) &&
              !matchIds.has(tg.id)
            let op = baseEdgeOpacity(e.type === 'tag')
            if (onPath) op = PATH_EDGE_OP
            else if (onFoc) op = 0.78
            else if (isHot) op = hotEdgeOpacity(op, hs)
            else if (dimHover) op = lerp(op, 0.12, hs)
            else if (dimPath || dimFocus) op = 0.12
            else if (dimSearch) op = 0.14
            // G19 parity: edges fade in with their SLOWEST endpoint — same rule
            // as Canvas2D (edgeEntryOpacity), applied AFTER the dim ladder so
            // dims still apply and the entry fade sits on top. Steady-state
            // edges (no `born`) are unaffected (×1).
            const entryOp = edgeEntryOpacity(
              entryNow,
              s.born,
              s.enterOrder,
              tg.born,
              tg.enterOrder,
              entryMaxOrder
            )
            op *= entryOp
            // World-space stroke (scales with zoom via group transform) with a
            // shared screen-space floor so edges stay visible when zoomed out
            const sw = edgeWidthFor(
              (onPath ? PATH_EDGE_W : isHot ? hotEdgeWidth(hs) : baseEdgeWidth(e.type)) * lineMul,
              t.k
            )
            // G8: glow underlay for edges touching the hovered node — wide soft
            // stroke beneath the main edge, same rule as Canvas2D (edgeGlowAlpha)
            // so the SVG→canvas handoff glows identically. Hot edges only, full
            // LOD like the node halo, never in path/focus/search modes.
            if (lod === 'full' && isHot && hs > 0.1 && !dimPath && !dimFocus && !dimSearch) {
              edgesOut.push({
                key: ek + ':glow',
                x1: s.x,
                y1: s.y,
                x2: tg.x,
                y2: tg.y,
                stroke: pal.edgeHot,
                sw: edgeWidthFor(hotEdgeWidth(hs) * lineMul * 2.4, t.k),
                op: edgeGlowAlpha(hs, onPath) * entryOp
              })
            }
            edgesOut.push({
              key: ek,
              x1: s.x,
              y1: s.y,
              x2: tg.x,
              y2: tg.y,
              stroke:
                onPath || (isHot && hs > HOT_EDGE_COLOR_HS)
                  ? pal.edgeHot
                  : edgeColorFor(e.type, flags.edgeColorBy, pal),
              sw,
              op,
              dash: e.type === 'tag' && !onPath ? '3 4' : undefined
            })
          }

          const nodesOut: SvgNode[] = []
          const labelsOut: SvgLabel[] = []
          const labelsOn = showLabelsRef.current
          const maxLabels = labelsOn ? labelDrawBudget(lod) : 0
          let labCount = 0
          /** Unique nodes that passed the frustum — perf overlay pre→post. */
          let nodesRendered = 0
          const sel = flags.selectedIds
          for (const n of simNodes) {
            if (n.x == null || n.y == null || !Number.isFinite(n.x) || !Number.isFinite(n.y))
              continue
            const sx = n.x * t.k + t.x
            const sy = n.y * t.k + t.y
            const isHover = n.id === hover
            const isSel = sel != null && sel.has(n.id)
            const onPath = pathN != null && pathN.has(n.id)
            const onFoc = focN != null && focN.has(n.id)
            const isMatch = matchIds != null && matchIds.has(n.id)
            // Frustum in screen space (shared margin rule with Canvas2D).
            // Highlight nodes are always kept (same exemption as Canvas2D) so a
            // path/focus edge never ends at a culled void.
            if (
              !onPath &&
              !onFoc &&
              !isSel &&
              !isHover &&
              n.id !== focusId &&
              !isMatch &&
              !pointOnScreen(sx, sy, w, h, margin)
            )
              continue
            nodesRendered++

            const isTag = Boolean(n.isTag || n.type === 'tag')
            const isGhost = Boolean(n.isGhost || n.type === 'ghost')
            const isAtt = Boolean(n.isAttachment || n.type === 'attachment')
            const isHub = !isGhost && !isTag && n.degree >= thr
            const col = canvasSafeColor(
              resolveObsidianNodeFill({
                isLight: pal.isLight,
                isGhost,
                isTag,
                isAttachment: isAtt,
                type: n.type,
                relativePath: n.relativePath,
                groupColor: flags.groupColors?.get(n.id) || null,
                colorBy: colorMode === 'folder' || colorMode === 'type' ? colorMode : 'default'
              }),
              pal.colors.default || '#7c6cf0'
            )
            const deg = typeof n.degree === 'number' ? n.degree : 0
            // World radius — scales with zoom (Obsidian feel) with a shared
            // screen-space floor (same rule as Canvas2D, no handoff jump)
            const rWorldBase = nodeRadiusFor(
              deg,
              sizeMul,
              dimHubsOn && isHub,
              t.k,
              isTag || isAtt ? 0.9 : 1
            )
            // G19: new nodes fade + scale in (same helper as Canvas2D).
            const entryP = nodeEntryProgress(
              entryNow,
              n.born,
              n.enterOrder,
              entryMaxOrder >= 0 ? entryMaxOrder + 1 : undefined
            )
            const rWorld = rWorldBase * nodeEntryScale(entryP)
            // G7: nodes directly connected to the hovered node get a subtle
            // highlight ring — Obsidian lights up the cluster, not just the node
            const isNeighbor =
              hot != null &&
              hot.has(n.id) &&
              !isHover &&
              !isSel &&
              !onPath &&
              !onFoc &&
              !isMatch &&
              !isGhost
            let fillOp = isGhost ? 0.5 : 1
            if (pathN != null && !onPath && !isSel && !isHover) fillOp *= 0.22
            else if (pathN == null && focN != null && !onFoc && !isSel && !isHover) fillOp *= 0.26
            else if (
              pathN == null &&
              focN == null &&
              matchIds != null &&
              !matchIds.has(n.id) &&
              !isSel &&
              !isHover
            ) {
              fillOp *= 0.3
            } else if (hot && !hot.has(n.id) && pathN == null && focN == null) {
              fillOp *= lerp(1, 0.22, hs)
            }
            // G19: entry fade — new nodes fade in on top of any dim gates
            fillOp *= nodeEntryOpacity(entryP)
            // Dim gates mirror the Canvas2D node pass exactly (G3 parity): a
            // selected node is never "dimmed", so its glow can still show.
            const dimHoverNode = Boolean(
              hot && !hot.has(n.id) && pathN == null && focN == null && !isSel
            )
            const dimPathNode = pathN != null && !onPath && !isSel
            const dimFocusNode = pathN == null && focN != null && !onFoc && !isSel

            // G8: soft halo on the hovered/path/match/selected node — same
            // opacity rule as Canvas2D (HOVER_GLOW_ALPHA for hover-only, theme
            // 0.16/0.11 otherwise) so the handoff glows identically. Pushed
            // before the node circle so it renders underneath it.
            if (
              lod === 'full' &&
              !isGhost &&
              (onPath || isSel || isMatch || isHover) &&
              !dimHoverNode &&
              !dimPathNode &&
              !dimFocusNode
            ) {
              let glowA = pal.isLight ? 0.16 : 0.11
              if (isHover && !onPath && !isSel) glowA = HOVER_GLOW_ALPHA * hs
              nodesOut.push({
                key: n.id + ':glow',
                kind: 'circle',
                cx: n.x,
                cy: n.y,
                r: rWorld + (onPath || isSel ? 4.5 : 2.5),
                fill: onPath || isMatch || isSel ? pal.edgeHot : col,
                stroke: 'none',
                sw: 0,
                fillOp: glowA,
                strokeOp: 0
              })
            }

            const stroke =
              isHover || isSel || onPath || isMatch ? pal.edgeHot : isGhost ? col : pal.nodeStroke
            const sw = edgeWidthFor(
              isSel || onPath ? 1.35 : isHover ? lerp(0.7, 1.1, hs) : isGhost ? 1 : 0.55,
              t.k
            )

            nodesOut.push({
              key: n.id,
              kind: isGhost ? 'ghost' : 'circle',
              cx: n.x,
              cy: n.y,
              r: rWorld,
              fill: isGhost ? (pal.isLight ? 'rgba(255,255,255,0.35)' : 'rgba(20,22,28,0.4)') : col,
              stroke,
              sw,
              fillOp,
              strokeOp: isGhost ? Math.min(1, fillOp + 0.25) : fillOp,
              title: n.title || n.relativePath || n.id
            })
            if (isSel) {
              nodesOut.push({
                key: n.id + ':sel',
                kind: 'circle',
                cx: n.x,
                cy: n.y,
                r: rWorld + 2.2,
                fill: 'none',
                stroke: pal.edgeHot,
                sw: 0.9,
                fillOp: 0,
                strokeOp: 0.75
              })
            }
            // P2-8: dashed ring on the camera-focused selected node ([ / ]) —
            // same world-space rule as Canvas2D (no handoff jump)
            if (isSel && flags.focusSelId === n.id) {
              nodesOut.push({
                key: n.id + ':fsel',
                kind: 'circle',
                cx: n.x,
                cy: n.y,
                r: rWorld + 6,
                fill: 'none',
                stroke: pal.edgeHot,
                sw: 0.8,
                fillOp: 0,
                strokeOp: 0.9,
                dash: FOCUS_RING_DASH.join(' ')
              })
            }
            if (isNeighbor) {
              // Ring eases in/out with hover strength; thinner than the hover
              // ring. strokeOp multiplies fillOp so the ring dims together with
              // the node in focus/search/path modes (parity with Canvas2D).
              nodesOut.push({
                key: n.id + ':nbr',
                kind: 'circle',
                cx: n.x,
                cy: n.y,
                r: rWorld + 1.6,
                fill: 'none',
                stroke: pal.edgeHot,
                sw: edgeWidthFor(lerp(0.45, 0.8, hs), t.k),
                fillOp: 0,
                strokeOp: lerp(0.25, 0.6, hs) * fillOp
              })
            }

            // Labels: screen-space + Obsidian text fade by zoom
            const forceLab = isHover || isSel || onPath || onFoc || n.id === focusId || isMatch
            let zA = labelZoomAlpha(kSafe, flags.textFade, deg)
            if (forceLab) zA = Math.max(zA, smooth01(Math.min(1, kSafe / 0.4)) * 0.95)
            if (!labelsOn || zA < 0.04 || labCount >= maxLabels) continue
            if (lod === 'low' && !forceLab && deg < 3) continue
            if (lod === 'medium' && !forceLab && deg < 2) continue
            if (large && lod === 'full' && !forceLab && deg < 2 && simNodes.length > 120) continue

            let labOp = zA
            if (hot && !hot.has(n.id) && !forceLab) labOp *= lerp(1, 0.15, hs)
            else if (pathN != null && !onPath && !forceLab) labOp *= 0.15
            else if (matchIds != null && !matchIds.has(n.id) && !forceLab) labOp *= 0.18
            // G19: label fades in with its node
            labOp *= nodeEntryOpacity(entryP)

            const titleStr = String(n.title || n.relativePath || n.id || '')
            const text = titleStr.length > 28 ? titleStr.slice(0, 27) + '…' : titleStr
            // P3-2: Obsidian anchor — centered below the node (shared helper,
            // SVG ↔ Canvas2D parity). rWorld is the screen-space radius so the
            // label hugs the actual drawn circle, entry-scale included.
            const labPos = labelBelowNode(sx, sy, rWorld)
            // Cull on the ACTUAL label anchor (below the node) — a label that
            // would land fully off-viewport is skipped (parity with Canvas2D).
            if (!pointOnScreen(labPos.x, labPos.y, w, h, margin)) continue
            labelsOut.push({
              key: n.id,
              x: labPos.x,
              y: labPos.y,
              text,
              fill: forceLab ? pal.edgeHot : pal.label,
              bold: Boolean(forceLab),
              op: labOp
            })
            labCount++
          }

          if (nodesOut.length === 0 && simNodes.length > 0) {
            // Screen-space helper (outside transform) via labels only + one node at origin-ish
            labelsOut.push({
              key: '__offscreen-lab',
              x: w / 2,
              y: h / 2,
              text: `${simNodes.length} node di luar layar — tekan F (Fit)`,
              fill: '#f0c060',
              bold: true,
              op: 1
            })
          }

          const hud = `${countGraphNotes(simNodes)} notes · ${countGraphLinks(simLinks)} links · k:${kSafe.toFixed(2)}`
          // G-perf: structural sharing — reuse unchanged element references so
          // the memoized SVG components bail out (no DOM diff) for everything
          // that did not change this frame.
          const mergedEdges = deltaMerge(prevEdgesRef.current, edgesOut, sameSvgEdge)
          const mergedNodes = deltaMerge(prevNodesRef.current, nodesOut, sameSvgNode)
          const mergedLabels = deltaMerge(prevLabelsRef.current, labelsOut, sameSvgLabel)
          prevEdgesRef.current = mergedEdges
          prevNodesRef.current = mergedNodes
          prevLabelsRef.current = mergedLabels
          pushSvgFrame(
            {
              w: Math.max(1, w),
              h: Math.max(1, h),
              tx: t.x,
              ty: t.y,
              k: kSafe,
              edges: mergedEdges,
              nodes: mergedNodes,
              labels: mergedLabels,
              culled: {
                totalEdges: simLinks.length,
                totalNodes: simNodes.length,
                renderedEdges: edgeList.length,
                renderedNodes: nodesRendered
              },
              hud
            },
            svgThrottle
          )
        }
      } catch (svgErr) {
        console.error('[GraphCanvas] SVG frame failed:', svgErr)
        pushSvgFrame({
          w: Math.max(1, w),
          h: Math.max(1, h),
          tx: 0,
          ty: 0,
          k: 1,
          edges: [],
          nodes: [],
          labels: [],
          culled: {
            totalEdges: simLinks.length,
            totalNodes: simNodes.length,
            renderedEdges: 0,
            renderedNodes: 0
          },
          hud: `SVG error · sim:${simNodes.length}`
        })
      }

      // Off-screen recovery ONLY on first load — never after user pan/zoom or vault camera (BUG-2)
      if (simNodes.length > 0 && drawn === 0 && canAutoFitCamera()) {
        const now = Date.now()
        if (now - lastAutoFitOffscreenAtRef.current > 900) {
          lastAutoFitOffscreenAtRef.current = now
          requestAnimationFrame(() => {
            try {
              if (!canAutoFitCamera()) return
              fitViewRef.current?.(false)
              hasAutoFitRef.current = true
            } catch {
              /* ignore */
            }
          })
        }
      }

      // First-fit once nodes exist (skipped if vault camera restored)
      if (
        simNodes.length > 0 &&
        canAutoFitCamera() &&
        simNodes.some((n) => n.x != null && n.y != null)
      ) {
        requestAnimationFrame(() => {
          try {
            if (!canAutoFitCamera()) return
            fitViewRef.current?.(false)
            hasAutoFitRef.current = true
          } catch {
            /* ignore */
          }
        })
      }

      // ── 2) Hidden canvas = PNG fallback only — skip every frame (display is SVG)
      if (!exportCanvasPaintRef.current) {
        dirtyRef.current = false
        return
      }
      exportCanvasPaintRef.current = false

      const ctx = canvas?.getContext('2d') || null
      if (!ctx || !canvas || simNodes.length === 0) {
        dirtyRef.current = false
        return
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'source-over'

        // Delegate to shared Canvas 2D drawing (same code as interactive gesture path)
        const dc: DrawContext = {
          ctx,
          w,
          h,
          dpr,
          pal,
          tx: t.x,
          ty: t.y,
          k: t.k,
          simNodes,
          simLinks,
          hover,
          hoverStrength: hs,
          flags,
          lod,
          large,
          showLabels: showLabelsRef.current,
          // G19: PNG export captures fully-entered nodes, never mid-fade
          entryComplete: true
        }
        const hotExport = computeHotSet(hover, hs, simLinks)
        drawCanvas2DScene(dc, hotExport)
      } catch (canvasErr) {
        // Export buffer only — never blank the SVG display path
        console.error('[GraphCanvas] export-canvas paint failed:', canvasErr)
      }

      dirtyRef.current = false
    } catch (err) {
      console.error('[GraphCanvas] paint failed:', err)
      dirtyRef.current = true
    }
    // Paint loop is driven by dirtyRef from rAF; canvas size sync is pushed in,
    // never a dependency of this callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushSvgFrame])

  paintFnRef.current = paint

  /**
   * drawCanvas2D — lightweight Canvas 2D draw for interactive gestures (pan/drag/zoom).
   * Same visual as the SVG path but renders directly to canvas (no React reconciliation).
   * Called from onDocMove during pointer gesture — must be fast.
   */
  const drawCanvas2D = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx || !canvas) return
    const wrap = wrapRef.current
    const w = wrap?.clientWidth || canvas.clientWidth || 0
    const h = wrap?.clientHeight || canvas.clientHeight || 0
    if (w < 4 || h < 4) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // Re-size canvas buffer if wrap changed (sidebar toggle, window resize during gesture)
    const expectedW = Math.floor(w * dpr)
    const expectedH = Math.floor(h * dpr)
    if (canvas.width !== expectedW || canvas.height !== expectedH) {
      canvas.width = expectedW
      canvas.height = expectedH
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
    }
    const pal = paletteRef.current
    const t = transformRef.current
    const simNodes = nodesRef.current
    const simLinks = linksRef.current
    const hover = hoverIdRef.current
    const hs = hoverStrengthRef.current
    const flags = viewFlagsRef.current
    const lod = resolveLod(simNodes.length, flags.perfMode)
    const large = lod !== 'full' || simNodes.length > 100
    try {
      const dc: DrawContext = {
        ctx,
        w,
        h,
        dpr,
        pal,
        tx: t.x,
        ty: t.y,
        k: t.k,
        simNodes,
        simLinks,
        hover,
        hoverStrength: hs,
        flags,
        lod,
        large,
        showLabels: showLabelsRef.current
      }
      const hot = computeHotSet(hover, hs, simLinks)
      // G-perf: measure the gesture-path draw while the overlay is on so the
      // Canvas2D renderer can be compared head-to-head with SVG commits in the
      // same HUD. Gated on the overlay to keep the gesture path zero-cost.
      const t0 = perfOverlayRef.current ? performance.now() : 0
      drawCanvas2DScene(dc, hot)
      if (perfOverlayRef.current) {
        if (!canvasStatsRef.current) canvasStatsRef.current = new RollingPerfStats()
        canvasStatsRef.current.push({
          commitMs: performance.now() - t0,
          edges: simLinks.length,
          nodes: simNodes.length,
          labels: 0,
          // Canvas2D row measures draw-time only — culling isn't tracked here,
          // so pre==post (the SVG commit row owns the culled counter).
          totalEdges: simLinks.length,
          totalNodes: simNodes.length,
          renderedEdges: simLinks.length,
          renderedNodes: simNodes.length,
          ts: performance.now()
        })
      }
    } catch (err) {
      console.error('[GraphCanvas] drawCanvas2D failed:', err)
      // Reset flag AND DOM — without DOM reset, canvas stays visible with SVG hidden
      interactiveCanvasRef.current = false
      const canvas = canvasRef.current
      if (canvas) {
        canvas.style.visibility = 'hidden'
        canvas.style.opacity = '0'
        canvas.style.zIndex = '0'
      }
      const svgHost = wrapRef.current?.querySelector('.graph-svg-host') as HTMLElement | null
      if (svgHost) svgHost.style.display = ''
    }
  }, [canvasStatsRef, perfOverlayRef])

  drawCanvas2DRef.current = drawCanvas2D

  /**
   * G19: bounded entry-animation repaint driver. When the sim rebuild adds new
   * nodes, this repaints the active renderer every frame until every new node's
   * fade+scale-in window has elapsed, then stops itself (unlike the removed
   * G17 pulse loop — never an infinite rAF).
   */
  const kickEntryAnimation = useCallback(() => {
    // Extend the window for the newest batch (stagger pushes later nodes out)
    entryEndRef.current = Math.max(
      entryEndRef.current,
      performance.now() + NODE_ENTRY_MS + NODE_ENTRY_STAGGER_MS + 40
    )
    if (entryRafRef.current) return
    const tick = (): void => {
      if (performance.now() >= entryEndRef.current) {
        entryRafRef.current = 0
        return
      }
      // Drive whichever renderer is live so mid-animation handoffs stay smooth
      if (interactiveCanvasRef.current) drawCanvas2DRef.current()
      else paintFnRef.current()
      entryRafRef.current = requestAnimationFrame(tick)
    }
    entryRafRef.current = requestAnimationFrame(tick)
  }, [])
  entryKickRef.current = kickEntryAnimation

  // Never leave the entry rAF running after unmount — read the ref inside the
  // cleanup (capturing at mount time would always see 0 and cancel nothing)
  useEffect(
    () => () => {
      if (entryRafRef.current) cancelAnimationFrame(entryRafRef.current)
      entryRafRef.current = 0
    },
    []
  )

  /**
   * Show canvas on top of SVG during interactive gestures.
   * Hides SVG, shows canvas — eliminates React reconciliation overhead.
   */
  const showInteractiveCanvas = useCallback(() => {
    if (interactiveCanvasRef.current) return
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    interactiveCanvasRef.current = true
    const w = wrap.clientWidth
    const h = wrap.clientHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    const svgHost = wrap.querySelector('.graph-svg-host') as HTMLElement | null
    if (svgHost) svgHost.style.display = 'none'
    // First draw happens via caller (onDocMove/onWheel) — not here, to avoid double-draw
    canvas.style.visibility = 'visible'
    canvas.style.opacity = '1'
    canvas.style.zIndex = '5'
    canvas.style.pointerEvents = 'none'
  }, [])

  /**
   * Hide canvas, restore SVG. Called on gesture end.
   */
  const hideInteractiveCanvas = useCallback(() => {
    if (!interactiveCanvasRef.current) return
    interactiveCanvasRef.current = false
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (canvas) {
      canvas.style.visibility = 'hidden'
      canvas.style.opacity = '0'
      canvas.style.zIndex = '0'
    }
    const svgHost = wrap?.querySelector('.graph-svg-host') as HTMLElement | null
    if (svgHost) svgHost.style.display = ''
  }, [])

  const schedulePaint = useCallback(() => {
    requestPaint()
  }, [requestPaint])

  /** G18: cancel the running zoom-ease tween (idempotent). */
  const cancelZoomTween = useCallback(() => {
    if (zoomTweenRafRef.current) {
      cancelAnimationFrame(zoomTweenRafRef.current)
      zoomTweenRafRef.current = 0
    }
  }, [])
  cancelZoomTweenRef.current = cancelZoomTween

  /**
   * G18: eased zoom (Obsidian feel) — animate the camera from its current
   * transform toward `targetK` over ZOOM_EASE_MS with easeOutCubic, keeping the
   * focal point (fx, fy) anchored on screen. Runs on the interactive canvas so
   * the zoom is fluid; hands back to the SVG renderer when it lands.
   */
  const startZoomTween = useCallback(
    (targetK: number, fx: number, fy: number) => {
      cancelZoomTween()
      const t = transformRef.current
      const fromK = t.k || 1
      if (Math.abs(targetK - fromK) < 0.001) return
      const fromX = t.x
      const fromY = t.y
      const start = performance.now()
      showInteractiveCanvas()
      // M5 UI-15: skip zoom tween when user prefers reduced motion
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setCameraTransformRef.current(d3.zoomIdentity.translate(fx, fy).scale(targetK), {
          user: true,
          save: true,
          tween: false
        })
        return
      }
      const step = (now: number): void => {
        const p = easeOutCubic((now - start) / ZOOM_EASE_MS)
        const k = fromK + (targetK - fromK) * p
        // Keep the focal point fixed on screen while k changes
        const x = fx - ((fx - fromX) * k) / fromK
        const y = fy - ((fy - fromY) * k) / fromK
        setCameraTransformRef.current(d3.zoomIdentity.translate(x, y).scale(k), {
          user: true,
          save: true,
          tween: true
        })
        if (p < 1) {
          zoomTweenRafRef.current = requestAnimationFrame(step)
        } else {
          zoomTweenRafRef.current = 0
          // Tween landed — hand back to the SVG renderer (sync paint so the
          // canvas never snaps back to a stale SVG camera frame)
          hideInteractiveCanvas()
          paintFnRef.current()
        }
      }
      zoomTweenRafRef.current = requestAnimationFrame(step)
    },
    [cancelZoomTween, showInteractiveCanvas, hideInteractiveCanvas]
  )
  startZoomTweenRef.current = startZoomTween

  // Never leave a tween running after unmount
  useEffect(() => () => cancelZoomTweenRef.current(), [])

  /**
   * Graph View open: seed nodes + restore vault camera (BUG-1).
   * Auto-fit at most once if no camera — never steal after user pan (BUG-2).
   */
  useEffect(() => {
    // Embedded (split view) mounts the canvas while activeView is 'editor' —
    // still run the seed/paint pipeline, just never steal global keys.
    // Keep-alive (P-2): when the full graph view is open, the split pane is
    // hidden — skip so a hidden embedded canvas never runs its own pipeline
    // (double fetchGraph + sim while the full canvas is active).
    if (activeView !== 'graph' && !(embedded && activeView === 'editor')) return

    // Fresh visit: allow vault restore; clear "user moved camera" for this enter
    userCameraTouchedRef.current = false
    hasAutoFitRef.current = false
    cameraHydratedRef.current = false
    emptySvgFramesRef.current = 0

    // BUG-1: try vault camera once on enter (do NOT re-run when camera auto-saves)
    const storeSnap = useGraphStore.getState()
    const cam = storeSnap.layoutCamera
    const layoutSnap = storeSnap.layoutNodes || {}
    if (cam && Number.isFinite(cam.k) && cam.k > 0 && cam.k >= 0.05 && cam.k <= 6) {
      const layoutPts = Object.values(layoutSnap)
        .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => ({ x: p.x, y: p.y }))
      const ok = layoutPts.length === 0 || cameraShowsPoints(cam, layoutPts)
      if (ok && applyCamera(cam, true)) {
        hasAutoFitRef.current = true
        hadSavedCameraRef.current = true
      } else {
        setCameraTransformRef.current(d3.zoomIdentity, { user: false, save: false })
      }
    } else {
      setCameraTransformRef.current(d3.zoomIdentity, { user: false, save: false })
    }

    void fetchGraph().finally(() => {
      setGraphLoaded(true)
      schedulePaint()
    })

    // Declared BEFORE kick — kick() closes over them and is called synchronously
    // below (TDZ crash if declared after: "Cannot access 'kickRafs' before init").
    const kickRafs: number[] = []
    let resizeRaf = 0

    const kick = (why: string, opts?: { allowFit?: boolean }): void => {
      syncCanvasSize()
      const fNodes = filteredNodesRef.current
      const fEdges = filteredEdgesRef.current
      if (nodesRef.current.length === 0 && fNodes.length > 0) {
        resetFrameCache()
        const wrap = wrapRef.current
        const w = Math.max(wrap?.clientWidth || 0, 400)
        const h = Math.max(wrap?.clientHeight || 0, 300)
        const liveLayout = useGraphStore.getState().layoutNodes || {}
        nodesRef.current = fNodes.map((n, i) => {
          const layout = liveLayout[n.id]
          const c = posCache.current.get(n.id)
          // Circular opening (Obsidian feel): golden-angle spiral fallback when
          // no vault layout / cache exists — organized, not a random grid blob.
          const seed = spiralSeed(i, fNodes.length, w, h)
          return {
            ...n,
            title: n.title || n.relativePath || n.id,
            tags: safeTags(n),
            degree: typeof n.degree === 'number' ? n.degree : 0,
            x: c?.x ?? layout?.x ?? seed.x,
            y: c?.y ?? layout?.y ?? seed.y,
            fx: layout?.pinned ? layout.x : null,
            fy: layout?.pinned ? layout.y : null,
            pinned: Boolean(layout?.pinned)
          }
        })
        const idSet = new Set(nodesRef.current.map((n) => n.id))
        linksRef.current = fEdges
          .filter((e) => {
            const s = typeof e.source === 'string' ? e.source : (e as { source?: string }).source
            const t = typeof e.target === 'string' ? e.target : (e as { target?: string }).target
            return Boolean(s && t && idSet.has(s) && idSet.has(t))
          })
          .map((e) => ({
            id: e.id,
            type: e.type || 'wiki_link',
            weight: e.weight || 1,
            source: typeof e.source === 'string' ? e.source : String(e.source),
            target: typeof e.target === 'string' ? e.target : String(e.target)
          }))
        setStats({
          nodes: nodesRef.current.length,
          edges: linksRef.current.length
        })
      }
      try {
        paintFnRef.current()
      } catch (e) {
        console.error('[GraphCanvas] kick paint', why, e)
      }
      schedulePaint()
      // Fit only if allowed and camera not restored / user not panned
      if (opts?.allowFit !== false && nodesRef.current.length > 0 && canAutoFitCamera()) {
        kickRafs.push(
          requestAnimationFrame(() => {
            try {
              if (!canAutoFitCamera()) return
              fitViewRef.current?.(false)
              hasAutoFitRef.current = true
              paintFnRef.current()
              schedulePaint()
            } catch {
              /* ignore */
            }
          })
        )
      }
    }

    kick('graph-enter')
    // Fewer delayed kicks — only seed/paint + one fit chance if still needed
    const delays = [120, 400, 1000]
    const timers = delays.map((ms) => setTimeout(() => kick(`graph-enter-${ms}`), ms))

    let ro: ResizeObserver | null = null
    const wrap = wrapRef.current
    if (wrap && typeof ResizeObserver !== 'undefined') {
      // Resize: re-paint; coalesce per frame — window drag fires RO on every tick
      ro = new ResizeObserver(() => {
        if (resizeRaf) return
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0
          // allowFit:false — no per-frame camera re-fit while dragging the
          // window (fit happens once after the resize settles, see onResize)
          kick('resize', { allowFit: false })
        })
      })
      ro.observe(wrap)
    }

    return () => {
      for (const t of timers) clearTimeout(t)
      for (const r of kickRafs) cancelAnimationFrame(r)
      if (resizeRaf) cancelAnimationFrame(resizeRaf)
      ro?.disconnect()
      if (wheelDebounceRef.current) {
        clearTimeout(wheelDebounceRef.current)
        wheelDebounceRef.current = null
      }
    }
    // ONLY activeView/embedded — any other dep re-ran this and reset camera/pan mid-session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, embedded])

  // If toolbar already shows node count but SVG frame empty → force paint (user blank case)
  useEffect(() => {
    if (activeView !== 'graph') return
    if (stats.nodes <= 0) return
    if (svgFrame && svgFrame.nodes.length > 0) return
    const t = window.setTimeout(() => {
      try {
        paintFnRef.current()
      } catch (e) {
        console.error('[GraphCanvas] stats-watch paint', e)
      }
    }, 100)
    return () => clearTimeout(t)
  }, [activeView, stats.nodes, stats.edges, svgFrame])

  // Labels toggle must repaint (paint closes over showLabels)
  useEffect(() => {
    schedulePaint()
  }, [showLabels, schedulePaint])

  /**
   * Hit-test with sticky hysteresis (Obsidian-like):
   * keep current hover until pointer clearly leaves expanded radius,
   * so edges between nodes don't flicker.
   * Large graphs use SpatialHash2D so hover stays O(k) not O(n).
   */
  const hitNode = useCallback((clientX: number, clientY: number): SimNode | null => {
    // Always stage box — matches SVG screen coords + camera transform
    const el = wrapRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return null
    const t = transformRef.current
    const x = (clientX - rect.left - t.x) / t.k
    const y = (clientY - rect.top - t.y) / t.k
    const thr = viewFlagsRef.current.hubThreshold
    const dimHubsOn = viewFlagsRef.current.dimHubs
    const sizeMul = viewFlagsRef.current.nodeSize || 1
    const stickyId = hoverIdRef.current
    const all = nodesRef.current
    if (all.length === 0) return null

    // Rebuild spatial index only when nodes have moved significantly or first time
    // Use a threshold to avoid rebuilding on every tiny movement
    const shouldRebuild = spatialDirtyRef.current || all.length > 80
    if (shouldRebuild) {
      spatialRef.current.rebuild(all)
      spatialDirtyRef.current = false
    }
    const candidates = all.length > 80 ? spatialRef.current.query(x, y, 80) : all

    let best: SimNode | null = null
    let bestD = Infinity
    let sticky: SimNode | null = null
    let stickyD = Infinity
    for (const n of candidates) {
      if (n.x == null || n.y == null) continue
      const dx = n.x - x
      const dy = n.y - y
      const d = dx * dx + dy * dy
      const isGhost = Boolean(n.isGhost || n.type === 'ghost')
      const isTag = Boolean(n.isTag || n.type === 'tag')
      const isAtt = Boolean(n.isAttachment || n.type === 'attachment')
      const hubDim = !isGhost && dimHubsOn && n.degree >= thr
      // Same radius rule as the renderers (screen-space floor) so hit-testing
      // matches what is drawn, then a generous grab pad for touch
      const baseR = nodeRadiusFor(
        n.degree ?? 0,
        sizeMul,
        hubDim,
        t.k,
        isGhost || isTag || isAtt ? 0.9 : 1
      )
      const pad = n.id === stickyId ? 22 : 16
      const r = baseR + pad
      if (d <= r * r) {
        if (n.id === stickyId) {
          sticky = n
          stickyD = d
        }
        if (d < bestD) {
          best = n
          bestD = d
        }
      }
    }
    // Sticky may sit outside candidate cell after pan — check sticky alone
    if (!sticky && stickyId) {
      const sn = all.find((n) => n.id === stickyId)
      if (sn && sn.x != null && sn.y != null) {
        const dx = sn.x - x
        const dy = sn.y - y
        const d = dx * dx + dy * dy
        const hubDim = dimHubsOn && sn.degree >= thr
        const r = nodeRadiusFor(sn.degree ?? 0, sizeMul, hubDim, t.k) + 14
        if (d <= r * r) {
          sticky = sn
          stickyD = d
        }
      }
    }
    if (sticky && best) {
      if (sticky.id === best.id) return sticky
      // Switch only if another node is clearly closer (~45% nearer)
      if (bestD < stickyD * 0.55) return best
      return sticky
    }
    return sticky || best
  }, [])

  // Track last known wrap size so resize 0→real can re-center + fit
  const lastSizeRef = useRef({ w: 0, h: 0 })

  /**
   * Build / soft-merge simulation when filtered graph data changes.
   * Soft-merge (Obsidian-like): keep positions for known nodes, mild reheat —
   * avoid full explode on every filter toggle or vault incremental update.
   */
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    // Don't permanently skip sim if layout not ready — retry (user open path hits this often)
    if (!canvas || !wrap) {
      const t = setTimeout(() => schedulePaint(), 100)
      return () => clearTimeout(t)
    }

    const sized = syncCanvasSize()
    const width = sized.ready ? sized.w : Math.max(wrap.clientWidth, 800)
    const height = sized.ready ? sized.h : Math.max(wrap.clientHeight, 600)
    if (sized.ready) lastSizeRef.current = { w: sized.w, h: sized.h }

    let sizeRetry: ReturnType<typeof setTimeout> | null = null
    if (!sized.ready) {
      sizeRetry = setTimeout(() => {
        const again = syncCanvasSize()
        if (again.ready) {
          lastSizeRef.current = { w: again.w, h: again.h }
          const sim = simRef.current
          if (sim) {
            applyForces(
              sim as d3.Simulation<SimNode, undefined>,
              forcesRef.current,
              again.w,
              again.h,
              nodesRef.current.length > 80,
              viewFlagsRef.current.nodeSize || 1
            )
            sim.alpha(Math.max(sim.alpha(), 0.2)).restart()
          }
          if (canAutoFitCamera()) {
            fitView(false)
            hasAutoFitRef.current = true
          }
          schedulePaint()
        } else {
          schedulePaint()
        }
      }, 80)
    }

    if (filteredNodes.length === 0) {
      simRef.current?.stop()
      simRef.current = null
      nodesRef.current = []
      linksRef.current = []
      resetFrameCache()
      setStats({ nodes: 0, edges: 0 })
      hasAutoFitRef.current = false
      schedulePaint()
      return () => {
        if (sizeRetry) clearTimeout(sizeRetry)
      }
    }

    // Skip rebuild if node set hasn't changed (e.g. spotlight searchQuery change)
    const newIds = filteredNodes.map((n) => n.id)
    const prevIds = nodesRef.current.map((n) => n.id)
    if (newIds.length === prevIds.length && newIds.every((id, i) => id === prevIds[i])) {
      // Still update links if edges changed
      const idSet = new Set(newIds)
      const simLinks: SimLink[] = []
      for (const e of filteredEdges) {
        const src =
          typeof e.source === 'string' ? e.source : String((e as { source?: string }).source || '')
        const tgt =
          typeof e.target === 'string' ? e.target : String((e as { target?: string }).target || '')
        if (!src || !tgt || src === tgt) continue
        if (!idSet.has(src) || !idSet.has(tgt)) continue
        simLinks.push({
          id: e.id || `${src}->${tgt}`,
          type: e.type || 'wiki_link',
          weight: typeof e.weight === 'number' ? e.weight : 1,
          source: src,
          target: tgt
        })
      }
      linksRef.current = simLinks
      // Update the simulation's internal link force so physics matches visible edges
      const sim = simRef.current
      if (sim) {
        const linkF = sim.force('link') as d3.ForceLink<SimNode, SimLink> | null
        if (linkF) {
          linkF.links(simLinks).id((d) => d.id)
          sim.alpha(Math.max(sim.alpha(), 0.15)).restart()
        }
      }
      schedulePaint()
      return () => {
        if (sizeRetry) clearTimeout(sizeRetry)
      }
    }

    try {
      const f0 = forcesRef.current
      const prevById = new Map(nodesRef.current.map((n) => [n.id, n]))
      const prevCount = nodesRef.current.length
      // G19: stamp entry-animation state on NEW nodes only (filter change /
      // cold start). Pre-existing nodes keep their stamp so they never
      // re-animate on soft updates. Pure visual — sim physics untouched.
      const now = performance.now()
      let newBatch = 0
      const simNodes: SimNode[] = filteredNodes.map((n, i) => {
        const prev = prevById.get(n.id)
        const c = posCache.current.get(n.id)
        const layout = layoutNodes[n.id]
        // Prefer live sim → cache → vault layout → golden-spiral (Obsidian-like)
        const seed = spiralSeed(i, filteredNodes.length, width, height)
        const x = prev?.x ?? c?.x ?? layout?.x ?? seed.x
        const y = prev?.y ?? c?.y ?? layout?.y ?? seed.y
        const pinned =
          prev?.fx != null || c?.fx != null || Boolean(layout?.pinned) || Boolean(prev?.pinned)
        const fx = pinned ? (prev?.fx ?? c?.fx ?? layout?.x ?? x) : null
        const fy = pinned ? (prev?.fy ?? c?.fy ?? layout?.y ?? y) : null
        const isNew = prev == null
        if (isNew) newBatch++
        return {
          ...n,
          title: n.title || n.relativePath || n.id,
          tags: safeTags(n),
          degree: typeof n.degree === 'number' && Number.isFinite(n.degree) ? n.degree : 0,
          x,
          y,
          fx,
          fy,
          pinned,
          vx: prev?.vx,
          vy: prev?.vy,
          born: isNew ? now : prev?.born,
          enterOrder: isNew ? newBatch - 1 : prev?.enterOrder
        }
      })
      const idSet = new Set(simNodes.map((n) => n.id))
      const simLinks: SimLink[] = []
      for (const e of filteredEdges) {
        const src =
          typeof e.source === 'string' ? e.source : String((e as { source?: string }).source || '')
        const tgt =
          typeof e.target === 'string' ? e.target : String((e as { target?: string }).target || '')
        if (!src || !tgt || src === tgt) continue
        if (!idSet.has(src) || !idSet.has(tgt)) continue
        simLinks.push({
          id: e.id || `${src}->${tgt}`,
          type: e.type || 'wiki_link',
          weight: typeof e.weight === 'number' ? e.weight : 1,
          source: src,
          target: tgt
        })
      }

      nodesRef.current = simNodes
      linksRef.current = simLinks
      // G19: new nodes entered the sim → run the bounded entry repaint driver
      // so they fade+scale in. No-op when nothing changed (soft membership).
      if (newBatch > 0) entryKickRef.current()
      resetFrameCache()
      // Prune posCache entries for nodes no longer in the simulation
      const activeIds = new Set(simNodes.map((n) => n.id))
      for (const key of posCache.current.keys()) {
        if (!activeIds.has(key)) posCache.current.delete(key)
      }
      setStats({ nodes: simNodes.length, edges: simLinks.length })
      setPinnedCount(simNodes.filter((n) => n.pinned || n.fx != null).length)

      const n = simNodes.length
      const large = n > 80
      // Soft merge if we already had a sim and overlap is significant
      const overlap = simNodes.filter((s) => prevById.has(s.id)).length
      const canSoft =
        simRef.current != null && prevCount > 0 && overlap >= Math.min(prevCount, n) * 0.4

      if (typeof d3.forceSimulation !== 'function') {
        console.error('[GraphCanvas] d3.forceSimulation missing — check d3 import')
        schedulePaint()
        return
      }

      let sim = simRef.current

      if (canSoft && sim) {
        // Soft update: swap nodes/links, mild reheat (Obsidian filter feel)
        sim.nodes(simNodes)
        const linkF = sim.force('link') as d3.ForceLink<SimNode, SimLink> | null
        if (linkF) {
          linkF.links(simLinks).id((d) => d.id)
        } else {
          sim.force(
            'link',
            d3
              .forceLink<SimNode, SimLink>(simLinks)
              .id((d) => d.id)
              .distance(f0.linkDist)
              .strength(f0.linkStr)
          )
        }
        applyForces(
          sim as d3.Simulation<SimNode, undefined>,
          f0,
          width,
          height,
          large,
          viewFlagsRef.current.nodeSize || 1
        )
        // Delta-driven heat: more change → more motion, still softer than cold start
        const churn = 1 - overlap / Math.max(n, 1)
        const heat = Math.min(0.45, 0.12 + churn * 0.4)
        sim.alpha(Math.max(sim.alpha(), heat)).restart()
      } else {
        // Cold start / major membership change
        sim?.stop()
        sim = d3
          .forceSimulation<SimNode>(simNodes)
          .force(
            'link',
            d3
              .forceLink<SimNode, SimLink>(simLinks)
              .id((d) => d.id)
              .distance(f0.linkDist)
              .strength(f0.linkStr)
          )
          // Obsidian-like settle: enough heat to cluster, cool smoothly
          .velocityDecay(large ? OBSIDIAN_SIM.velocityDecayLarge : OBSIDIAN_SIM.velocityDecay)
          .alphaDecay(large ? OBSIDIAN_SIM.alphaDecayLarge : OBSIDIAN_SIM.alphaDecay)
          .alphaMin(OBSIDIAN_SIM.alphaMin)
          .alpha(large ? OBSIDIAN_SIM.alphaStartLarge : OBSIDIAN_SIM.alphaStart)

        applyForces(
          sim as d3.Simulation<SimNode, undefined>,
          f0,
          width,
          height,
          large,
          viewFlagsRef.current.nodeSize || 1
        )
        simRef.current = sim
      }

      let tick = 0
      const lod0 = resolveLod(n, viewFlagsRef.current.perfMode)
      const paintEvery = lod0 === 'low' ? 3 : lod0 === 'medium' ? 2 : 1
      const activeSim = sim
      activeSim.on('tick', () => {
        tick++
        // Spatial hash invalidation for large-graph hit tests
        // Only mark dirty when simulation is actively moving (high alpha)
        if (activeSim.alpha() > 0.3 && tick % 16 === 0) spatialDirtyRef.current = true
        if (tick % paintEvery === 0 || activeSim.alpha() < 0.05) {
          if (interactiveCanvasRef.current) {
            drawCanvas2DRef.current()
          } else {
            // G-perf: while the sim is actively moving, throttle the React SVG
            // commit (latest-wins at most every SVG_PUSH_THROTTLE_MS). The final
            // settle frame (alpha < 0.05) always commits immediately.
            svgThrottleRef.current = activeSim.alpha() >= 0.05
            schedulePaint()
          }
        }
        if (tick % 12 === 0) {
          for (const node of nodesRef.current) {
            if (node.x != null && node.y != null) {
              const existing = posCache.current.get(node.id)
              if (existing) {
                existing.x = node.x
                existing.y = node.y
                existing.fx = node.fx
                existing.fy = node.fy
              } else {
                posCache.current.set(node.id, { x: node.x, y: node.y, fx: node.fx, fy: node.fy })
              }
            }
          }
        }
      })
      activeSim.on('end', () => {
        for (const node of nodesRef.current) {
          if (node.x != null && node.y != null) {
            const existing = posCache.current.get(node.id)
            if (existing) {
              existing.x = node.x
              existing.y = node.y
              existing.fx = node.fx
              existing.fy = node.fy
            } else {
              posCache.current.set(node.id, { x: node.x, y: node.y, fx: node.fx, fy: node.fy })
            }
          }
        }
        // Fit only if never fitted / no vault camera / user hasn't panned (BUG-2)
        // Skip during active gesture to avoid camera jump
        if (canAutoFitCamera() && !pointerGestureRef.current) {
          hasAutoFitRef.current = true
          fitView(false)
        }
        requestAnimationFrame(() => {
          if (!pointerGestureRef.current && !animateForcesRef.current)
            ensureGraphVisibleRef.current('sim-end')
        })
        // Obsidian-like continuous gentle motion
        if (animateForcesRef.current) {
          activeSim.alphaTarget(OBSIDIAN_SIM.animateAlphaTarget).restart()
        }
        // G-perf: force-commit any throttled frame so the settled graph is exact
        flushSvgFrameRef.current()
        if (!interactiveCanvasRef.current) schedulePaint()
      })

      schedulePaint()
      // Early check once nodes have initial positions
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (!pointerGestureRef.current) ensureGraphVisibleRef.current('sim-start')
        }, 60)
      })

      return () => {
        if (sizeRetry) clearTimeout(sizeRetry)
        // Clean up simulation event listeners to prevent memory leaks
        if (activeSim) {
          activeSim.on('tick', null)
          activeSim.on('end', null)
        }
        // Do NOT stop sim on soft re-run — next effect call owns it.
        // Only stop on unmount (detected via cleanup when deps change to empty later).
      }
    } catch (err) {
      console.error('[GraphCanvas] simulation build failed:', err)
      nodesRef.current = []
      linksRef.current = []
      resetFrameCache()
      setStats({ nodes: 0, edges: 0 })
      schedulePaint()
      return () => {
        if (sizeRetry) clearTimeout(sizeRetry)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredNodes, filteredEdges, schedulePaint, syncCanvasSize])

  // Unmount: stop simulation
  useEffect(() => {
    return () => {
      simRef.current?.stop()
      simRef.current = null
    }
  }, [])

  // Phase 3: live-update forces without full node rebuild
  useEffect(() => {
    const sim = simRef.current
    const wrap = wrapRef.current
    if (!sim || !wrap) return
    const width = wrap.clientWidth || 800
    const height = wrap.clientHeight || 600
    const large = nodesRef.current.length > 80
    applyForces(
      sim as d3.Simulation<SimNode, undefined>,
      forces,
      width,
      height,
      large,
      viewFlagsRef.current.nodeSize || 1
    )
    sim.alpha(Math.max(sim.alpha(), 0.18)).restart()
    schedulePaint()
  }, [forces, schedulePaint])

  // Obsidian-like: node size knob updates collide radius without full rebuild
  useEffect(() => {
    const sim = simRef.current
    const wrap = wrapRef.current
    if (!sim || !wrap) return
    const width = wrap.clientWidth || 800
    const height = wrap.clientHeight || 600
    applyForces(
      sim as d3.Simulation<SimNode, undefined>,
      forcesRef.current,
      width,
      height,
      nodesRef.current.length > 80,
      displayOpts.nodeSize || 1
    )
    sim.alpha(Math.max(sim.alpha(), 0.12)).restart()
    schedulePaint()
  }, [displayOpts.nodeSize, schedulePaint])

  const fitView = useCallback(
    (animate: boolean, onlyIds?: Set<string> | null, opts?: { silent?: boolean }) => {
      // Auto-fit stays quiet; user Fit/Layout pass { silent: false }
      const announce = opts?.silent === false
      const wrap = wrapRef.current
      let simNodes = nodesRef.current
      if (onlyIds && onlyIds.size > 0) {
        simNodes = simNodes.filter((n) => onlyIds.has(n.id))
      }
      if (!wrap) {
        if (announce) flashAction('Fit gagal — area graph belum siap')
        return
      }
      if (simNodes.length === 0) {
        if (announce) flashAction('Fit — belum ada node (buka vault / rebuild graph)')
        return
      }
      const sized = syncCanvasSize()
      // Never abort fit on 0×0 — use fallbacks (this was a silent blank-forever path)
      let width = sized.ready ? sized.w : Math.max(wrap.clientWidth, 0)
      let height = sized.ready ? sized.h : Math.max(wrap.clientHeight, 0)
      if (width < 32 || height < 32) {
        width = Math.max(320, Math.floor(window.innerWidth * 0.55))
        height = Math.max(240, Math.floor(window.innerHeight * 0.65))
      }
      // Prefer nodes with real positions (skip NaN)
      simNodes = simNodes.filter(
        (n) =>
          typeof n.x === 'number' &&
          typeof n.y === 'number' &&
          Number.isFinite(n.x) &&
          Number.isFinite(n.y)
      )
      if (simNodes.length === 0) {
        if (announce) flashAction('Fit — posisi node belum siap, coba Layout')
        return
      }
      const xs = simNodes.map((n) => n.x as number)
      const ys = simNodes.map((n) => n.y as number)
      const minX = xs.reduce((a, b) => Math.min(a, b), Infinity)
      const maxX = xs.reduce((a, b) => Math.max(a, b), -Infinity)
      const minY = ys.reduce((a, b) => Math.min(a, b), Infinity)
      const maxY = ys.reduce((a, b) => Math.max(a, b), -Infinity)
      const gw = Math.max(maxX - minX, 40)
      const gh = Math.max(maxY - minY, 40)
      const pad = 48
      const k = Math.min((width - pad * 2) / gw, (height - pad * 2) / gh, 2.2)
      const tx = (width - k * (minX + maxX)) / 2
      const ty = (height - k * (minY + maxY)) / 2
      const target = d3.zoomIdentity.translate(tx, ty).scale(k)
      const done = (): void => {
        hasAutoFitRef.current = true
        // Explicit Fit/Layout owns camera again (auto-fit may not steal after this until pan)
        if (announce) {
          userCameraTouchedRef.current = false
          cameraHydratedRef.current = true
        }
        scheduleSaveCamera()
        if (announce) flashAction(`Fit · ${simNodes.length} nodes · k=${k.toFixed(2)}`)
      }
      if (!animate) {
        setCameraTransformRef.current(target, { user: announce, save: true })
        done()
        return
      }
      // simple lerp frames
      const from = transformRef.current
      const steps = 12
      let i = 0
      const step = (): void => {
        i++
        const u = i / steps
        const e = 1 - Math.pow(1 - u, 3)
        const mid = d3.zoomIdentity
          .translate(from.x + (target.x - from.x) * e, from.y + (target.y - from.y) * e)
          .scale(from.k + (target.k - from.k) * e)
        setCameraTransformRef.current(mid, { user: false, save: false })
        if (i < steps) requestAnimationFrame(step)
        else {
          setCameraTransformRef.current(target, { user: announce, save: true })
          done()
        }
      }
      requestAnimationFrame(step)
    },
    [syncCanvasSize, scheduleSaveCamera, flashAction]
  )
  fitViewRef.current = fitView

  /**
   * Force Fit if almost no nodes on screen.
   * Retries when sim not ready (total=0) — that was leaving the graph blank forever.
   */
  const ensureGraphVisible = useCallback(
    (reason = 'auto'): boolean => {
      const { inView, total, w, h } = countNodesInViewport()
      const t = transformRef.current
      // Canvas not ready: still try fit with fallbacks (fitView uses syncCanvasSize too)
      if (w < 32 || h < 32) {
        // Don't thrash diagnostics while user is panning a 0×0 flex frame
        if (userCameraTouchedRef.current || cameraHydratedRef.current) return false
        const diag = diagnoseViewportBlank({
          inView,
          total,
          w,
          h,
          zoomK: t.k,
          camX: t.x,
          camY: t.y,
          trigger: reason,
          hadSavedCamera: hadSavedCameraRef.current
        })
        setGraphDiag(diag)
        setLayoutStatus(formatGraphDiag(diag))
        console.warn(formatGraphDiag(diag))
        return false
      }
      if (total === 0) {
        if (reason.includes('late') || reason.includes('end') || reason.includes('retry')) {
          const diag = diagnoseViewportBlank({
            inView: 0,
            total: 0,
            w,
            h,
            zoomK: t.k,
            camX: t.x,
            camY: t.y,
            trigger: reason,
            hadSavedCamera: hadSavedCameraRef.current
          })
          setGraphDiag(diag)
          setLayoutStatus(formatGraphDiag(diag))
        }
        return false
      }
      // Need at least 1 node in view, or ≥5% of nodes for large graphs (stricter)
      const minNeed = total <= 5 ? 1 : Math.max(1, Math.floor(total * 0.05))
      if (inView >= minNeed) {
        hasAutoFitRef.current = true
        setGraphDiag((prev) =>
          prev &&
          (prev.code === 'CAM_OFFSCREEN' ||
            prev.code === 'CAM_EXTREME_ZOOM' ||
            prev.code === 'CAM_RESTORED_OK' ||
            prev.code === 'FIT_RESIZE' ||
            prev.code === 'FIT_SIM' ||
            prev.code === 'FIT_DATA' ||
            prev.code === 'CANVAS_SIZE_ZERO' ||
            prev.code === 'NO_SIM_POSITIONS')
            ? {
                code: 'OK',
                title: 'Graph terlihat',
                cause: `${inView}/${total} node di viewport ${w}×${h}`,
                action: 'Siap dieksplorasi. F=fit · R=re-layout · P=panel',
                severity: 'info'
              }
            : prev
        )
        return true
      }

      // BUG-2: user pan/zoom or restored camera → never steal camera
      if (userCameraTouchedRef.current || cameraHydratedRef.current) {
        return false
      }
      if (hasAutoFitRef.current) {
        // Already fitted once; empty viewport may be intentional zoom into void
        return false
      }

      const diag = diagnoseViewportBlank({
        inView,
        total,
        w,
        h,
        zoomK: t.k,
        camX: t.x,
        camY: t.y,
        trigger: reason,
        hadSavedCamera: hadSavedCameraRef.current
      })
      console.warn(formatGraphDiag(diag))
      setCameraTransformRef.current(d3.zoomIdentity, { user: false, save: false })
      fitView(false)
      hasAutoFitRef.current = true
      setGraphDiag(diag)
      setLayoutStatus(formatGraphDiag(diag))
      scheduleSaveCamera()
      requestAnimationFrame(() => schedulePaint())
      return false
    },
    [countNodesInViewport, fitView, scheduleSaveCamera, schedulePaint]
  )
  ensureGraphVisibleRef.current = ensureGraphVisible

  // First-load recovery only — NOT re-run on camera save (removed layoutCamera dep = BUG-2)
  useEffect(() => {
    if (filteredNodes.length === 0) return
    if (userCameraTouchedRef.current) return
    const delays = [80, 200, 500, 1200]
    const timers = delays.map((ms, i) =>
      setTimeout(() => {
        if (userCameraTouchedRef.current || cameraHydratedRef.current) return
        const ok = ensureGraphVisibleRef.current(
          i >= delays.length - 2 ? `post-data-late-${ms}` : `post-data-${ms}`
        )
        // One hard fit only if never fitted and still blank
        if (!ok && i === delays.length - 1 && canAutoFitCamera()) {
          fitViewRef.current?.(false)
          hasAutoFitRef.current = true
          schedulePaint()
        }
      }, ms)
    )
    return () => {
      for (const t of timers) clearTimeout(t)
    }
  }, [filteredNodes.length, schedulePaint])

  // Soft visibility check on enter — never force-fit if vault camera restored or user panned
  useEffect(() => {
    if (activeView !== 'graph') return
    const timers = [150, 600].map((ms) =>
      setTimeout(() => {
        syncCanvasSize()
        if (nodesRef.current.length === 0) return
        if (userCameraTouchedRef.current || cameraHydratedRef.current) {
          schedulePaint()
          return
        }
        const { inView, total } = countNodesInViewport()
        if (total > 0 && inView < Math.max(1, Math.floor(total * 0.05)) && canAutoFitCamera()) {
          fitViewRef.current?.(false)
          hasAutoFitRef.current = true
        } else {
          schedulePaint()
        }
      }, ms)
    )
    return () => {
      for (const t of timers) clearTimeout(t)
    }
  }, [activeView, syncCanvasSize, countNodesInViewport, schedulePaint])

  // Obsidian-like zoom controls (bottom-right): zoom around viewport center
  const zoomBy = useCallback(
    (factor: number) => {
      const sized = syncCanvasSize()
      const cx = (sized.ready ? sized.w : wrapRef.current?.clientWidth || 400) / 2
      const cy = (sized.ready ? sized.h : wrapRef.current?.clientHeight || 300) / 2
      const t = transformRef.current
      const k0 = t.k || 1
      const nextK = Math.max(0.08, Math.min(6, k0 * factor))
      // G18: eased zoom around the viewport center (buttons / keyboard)
      startZoomTweenRef.current(nextK, cx, cy)
    },
    [syncCanvasSize]
  )

  // Keep latest handlers in refs so pointer listeners never rebind mid-pan
  const hitNodeRef = useRef(hitNode)
  hitNodeRef.current = hitNode
  const findPathRef = useRef(findPath)
  findPathRef.current = findPath
  const fetchNeighborhoodRef = useRef(fetchNeighborhood)
  fetchNeighborhoodRef.current = fetchNeighborhood
  const openTabRef = useRef(openTab)
  openTabRef.current = openTab
  const setActiveViewRef = useRef(setActiveView)
  setActiveViewRef.current = setActiveView
  const saveLayoutPositionsRef = useRef(saveLayoutPositions)
  saveLayoutPositionsRef.current = saveLayoutPositions
  const showTooltipDomRef = useRef(showTooltipDom)
  showTooltipDomRef.current = showTooltipDom
  const hideTooltipDomRef = useRef(hideTooltipDom)
  hideTooltipDomRef.current = hideTooltipDom
  const moveTooltipDomRef = useRef(moveTooltipDom)
  moveTooltipDomRef.current = moveTooltipDom
  // P1-2: hover-delay — built once; callbacks read refs at call time (never stale)
  if (!tooltipSchedulerRef.current) {
    tooltipSchedulerRef.current = createTooltipScheduler<SimNode>({
      delay: TOOLTIP_DELAY_MS,
      show: (node, x, y) => showTooltipDomRef.current(node, x, y),
      move: (x, y) => moveTooltipDomRef.current(x, y),
      hide: () => hideTooltipDomRef.current(),
      isVisible: () => tooltipNodeIdRef.current != null
    })
  }
  // P1-3: preview cache — reads note bodies through the sandboxed main-process API
  if (!tooltipPreviewCacheRef.current) {
    tooltipPreviewCacheRef.current = new TooltipPreviewCache({
      read: async (p) => {
        const res = await window.api.readFile(p)
        return { content: res?.content ?? '' }
      }
    })
  }
  const setHoverIdRef = useRef(setHoverId)
  setHoverIdRef.current = setHoverId

  /**
   * Unified pointer interaction (mouse + touch + pen):
   * - 1 finger/pointer on empty → pan camera
   * - 1 finger/pointer on node → drag node (pinned on release)
   * - 2 fingers → pinch zoom + pan
   * - wheel → zoom toward cursor
   * No d3.zoom input (conflicts with touch + node drag on Windows).
   */
  useEffect(() => {
    if (activeView !== 'graph') return
    let cancelled = false
    let wrapEl: HTMLDivElement | null = null

    type Mode = 'none' | 'pan' | 'node' | 'pinch'
    let mode: Mode = 'none'
    let moved = false
    let dragged: SimNode | null = null
    let panLast = { x: 0, y: 0 }
    let activeId: number | null = null
    let pinchStartDist = 0
    let pinchStartK = 1
    let pinchStartMid = { x: 0, y: 0 }
    let pinchStartT = d3.zoomIdentity
    const pointers = new Map<number, { x: number; y: number }>()
    const DRAG_THRESH = 6

    // Overlays keep their own clicks — preventDefault + pointer capture on the
    // stage swallows their click events in Chromium (zoom buttons appeared dead
    // / snapped back). During an active gesture the SVG is hidden and the
    // canvas is pointer-events:none, so extra fingers land on the stage itself
    // — those must still register (pinch), hence the mode === 'none' guard.
    const isOverlayUi = (target: EventTarget | null): boolean => {
      const el = target as Element | null
      if (!el || typeof el.closest !== 'function') return false
      return el.closest(GRAPH_OVERLAY_UI) !== null
    }

    const screenToWorld = (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = wrapEl!.getBoundingClientRect()
      const t = transformRef.current
      const k = t.k || 1
      return {
        x: (clientX - rect.left - t.x) / k,
        y: (clientY - rect.top - t.y) / k
      }
    }

    const distPts = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
      Math.hypot(a.x - b.x, a.y - b.y)

    const clearDocListeners = (): void => {
      document.removeEventListener('pointermove', onDocMove, true)
      document.removeEventListener('pointerup', onDocUp, true)
      document.removeEventListener('pointercancel', onDocUp, true)
    }

    const endGesture = (): void => {
      if (mode === 'node' && dragged) {
        const d = dragged
        if (!moved) {
          if (d.isTag || d.type === 'tag') {
            // Tag shortcut (unchanged): click a tag node → filter by it
            setSearchQuery((d.title || '').replace(/^#/, ''))
            setSearchMode('filter')
          } else {
            // Obsidian: single-click SELECTS — double-click is the only open
            // gesture. A plain click replaces the selection (Ctrl+click toggles
            // in pointerdown). Never navigates away from the graph.
            const cur = selectedIdsRef.current
            if (cur.size !== 1 || !cur.has(d.id)) {
              setSelectedIds(new Set([d.id]))
              schedulePaint()
            }
          }
        } else {
          d.pinned = true
          posCache.current.set(d.id, { x: d.x!, y: d.y!, fx: d.fx, fy: d.fy })
          setPinnedCount(nodesRef.current.filter((n) => n.pinned || n.fx != null).length)
          if (saveLayoutTimer.current) clearTimeout(saveLayoutTimer.current)
          saveLayoutTimer.current = setTimeout(() => {
            const patch: Record<string, { x: number; y: number; pinned?: boolean }> = {}
            for (const n of nodesRef.current) {
              if (n.x == null || n.y == null) continue
              if (n.isGhost || n.type === 'ghost' || n.isTag || n.type === 'tag') continue
              if (n.pinned || n.fx != null) patch[n.id] = { x: n.x, y: n.y, pinned: true }
            }
            if (Object.keys(patch).length) void saveLayoutPositionsRef.current(patch, false)
          }, 600)
        }
        // Always end the node gesture back at the resting target — the grab
        // raised it to dragAlphaTarget, and a plain click (tag/ghost without
        // navigation) must not leave the graph simmering at that level forever.
        const nodeEndSim = simRef.current
        if (nodeEndSim) {
          nodeEndSim.alphaTarget(animateForcesRef.current ? OBSIDIAN_SIM.animateAlphaTarget : 0)
          if (moved) {
            // Release recoil — let the stretched graph spring back softly (rubber)
            nodeEndSim.alpha(Math.max(nodeEndSim.alpha(), OBSIDIAN_SIM.releaseAlpha)).restart()
          } else {
            nodeEndSim.restart()
          }
        }
      } else if ((mode === 'pan' || mode === 'pinch') && moved) {
        scheduleSaveCameraRef.current()
      } else if (mode === 'pan' && !moved) {
        // Obsidian: clicking empty space clears the selection (pan with motion
        // keeps it — matches how Obsidian drags don't deselect)
        if (selectedIdsRef.current.size > 0) {
          setSelectedIds(new Set())
          schedulePaint()
        }
      }
      // Hide interactive canvas and sync final state back to React SVG
      if (wheelDebounceRef.current) {
        clearTimeout(wheelDebounceRef.current)
        wheelDebounceRef.current = null
      }
      // Hide canvas FIRST, then paint to SVG (paint() checks interactiveCanvasRef)
      hideInteractiveCanvas()
      paintFnRef.current()
      mode = 'none'
      moved = false
      dragged = null
      dragIdRef.current = null
      activeId = null
      pointers.clear()
      pointerGestureRef.current = false
      clearDocListeners()
    }

    const onDocMove = (e: PointerEvent): void => {
      if (!wrapEl) return
      if (activeId != null && e.pointerId !== activeId && mode !== 'pinch') return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (mode === 'pinch' && pointers.size >= 2) {
        const pts = [...pointers.values()]
        const d = distPts(pts[0], pts[1])
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
        if (pinchStartDist > 0) {
          const scale = Math.max(0.08, Math.min(6, pinchStartK * (d / pinchStartDist)))
          const rect = wrapEl.getBoundingClientRect()
          const mx = mid.x - rect.left
          const my = mid.y - rect.top
          const t0 = pinchStartT
          const k0 = t0.k || 1
          const wx = (mx - t0.x) / k0
          const wy = (my - t0.y) / k0
          const nx = mx - wx * scale
          const ny = my - wy * scale
          const dx = mid.x - pinchStartMid.x
          const dy = mid.y - pinchStartMid.y
          transformRef.current = d3.zoomIdentity.translate(nx + dx, ny + dy).scale(scale)
          userCameraTouchedRef.current = true
          cameraHydratedRef.current = true
          moved = true
          showInteractiveCanvas()
          drawCanvas2D()
        }
        return
      }

      if (mode === 'node' && dragged) {
        const dx = e.clientX - panLast.x
        const dy = e.clientY - panLast.y
        if (!moved && Math.hypot(dx, dy) < DRAG_THRESH) return
        moved = true
        const w = screenToWorld(e.clientX, e.clientY)
        dragged.fx = w.x
        dragged.fy = w.y
        dragged.x = w.x
        dragged.y = w.y
        showInteractiveCanvas()
        drawCanvas2D()
        return
      }

      if (mode === 'pan') {
        // G18: user takes over with a pan — stop any running zoom ease
        cancelZoomTweenRef.current()
        const dx = e.clientX - panLast.x
        const dy = e.clientY - panLast.y
        if (!moved && Math.hypot(dx, dy) < DRAG_THRESH) return
        moved = true
        panLast = { x: e.clientX, y: e.clientY }
        const t = transformRef.current
        transformRef.current = d3.zoomIdentity.translate(t.x + dx, t.y + dy).scale(t.k || 1)
        userCameraTouchedRef.current = true
        cameraHydratedRef.current = true
        showInteractiveCanvas()
        drawCanvas2D()
      }
    }

    const onDocUp = (e: PointerEvent): void => {
      pointers.delete(e.pointerId)
      if (mode === 'pinch') {
        if (pointers.size >= 2) return
        if (pointers.size === 1) {
          const p = [...pointers.entries()][0]
          activeId = p[0]
          mode = 'pan'
          panLast = { x: p[1].x, y: p[1].y }
          return
        }
        endGesture()
        return
      }
      if (activeId != null && e.pointerId !== activeId) return
      endGesture()
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (!wrapEl) return
      // Overlay UI inside the stage keeps its own clicks. In-progress gestures
      // (mode !== 'none') still accept extra fingers for pinch zoom.
      if (mode === 'none' && isOverlayUi(e.target)) return
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return
      e.preventDefault()
      // Cancel wheel debounce to prevent race with pointer gesture
      if (wheelDebounceRef.current) {
        clearTimeout(wheelDebounceRef.current)
        wheelDebounceRef.current = null
      }
      setCtxMenu(null)
      // P1-2: any gesture (pan/drag/pinch) cancels a pending tooltip + hides it
      tooltipSchedulerRef.current?.leave()
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (pointers.size >= 2) {
        mode = 'pinch'
        // G18: pinch takes over — stop any running zoom ease
        cancelZoomTweenRef.current()
        pointerGestureRef.current = true
        const pts = [...pointers.values()]
        pinchStartDist = distPts(pts[0], pts[1]) || 1
        pinchStartK = transformRef.current.k || 1
        pinchStartMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
        pinchStartT = transformRef.current
        moved = false
        if (dragged) {
          dragged.fx = null
          dragged.fy = null
          dragged = null
          dragIdRef.current = null
        }
        document.addEventListener('pointermove', onDocMove, true)
        document.addEventListener('pointerup', onDocUp, true)
        document.addEventListener('pointercancel', onDocUp, true)
        return
      }

      if (mode !== 'none') return
      activeId = e.pointerId
      panLast = { x: e.clientX, y: e.clientY }
      moved = false
      pointerGestureRef.current = true

      const hit = hitNodeRef.current(e.clientX, e.clientY)

      if (e.pointerType === 'mouse' && e.button === 1) {
        mode = 'pan'
      } else if (hit && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        mode = 'node'
        dragged = hit
        dragIdRef.current = hit.id
        hit.fx = hit.x
        hit.fy = hit.y
        // Obsidian rubber-band: reheat the whole sim on grab so linked
        // neighbors follow the drag with springy lag — a cooled-down graph
        // would otherwise sit dead while the node slides away.
        const dragSim = simRef.current
        if (dragSim) {
          dragSim.alphaTarget(OBSIDIAN_SIM.dragAlphaTarget)
          dragSim.alpha(Math.max(dragSim.alpha(), OBSIDIAN_SIM.dragAlpha)).restart()
        }
      } else if (hit && (e.ctrlKey || e.metaKey)) {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(hit.id)) next.delete(hit.id)
          else next.add(hit.id)
          return next
        })
        pointerGestureRef.current = false
        pointers.clear()
        schedulePaint()
        return
      } else if (hit && e.shiftKey) {
        const from = pathFromIdRef.current
        const to = pathToIdRef.current
        if (!from || (from && to)) {
          setPathFromId(hit.id)
          setPathToId('')
          setPathNodeIds(null)
          setPathEdgeKeys(null)
          setPathStatus(`[PATH] From = "${hit.title}" · Shift+klik tujuan`)
          schedulePaint()
        } else {
          setPathToId(hit.id)
          void findPathRef.current(from, hit.id, showTagEdgesRef.current).then((res) => {
            if (!res?.found) {
              setPathStatus('Path tidak ditemukan')
              return
            }
            setPathNodeIds(new Set(res.nodeIds))
            setPathEdgeKeys(new Set(res.edgeKeys))
            setPathStatus(`Path ${res.length} hop`)
            if (res.nodeIds.length) {
              requestAnimationFrame(() => fitViewRef.current?.(true, new Set(res.nodeIds)))
            }
          })
        }
        pointerGestureRef.current = false
        pointers.clear()
        return
      } else if (hit && e.altKey) {
        void fetchNeighborhoodRef.current(hit.id, focusDepthRef.current).then((res) => {
          if (!res) return
          setFocusNodeIds(new Set(res.ids))
          setFocusEdgeKeys(new Set(res.edgeKeys))
          setPathStatus(`Focus “${hit.title}” · ${res.ids.length}`)
        })
        pointerGestureRef.current = false
        pointers.clear()
        return
      } else {
        mode = 'pan'
      }

      document.addEventListener('pointermove', onDocMove, true)
      document.addEventListener('pointerup', onDocUp, true)
      document.addEventListener('pointercancel', onDocUp, true)
      try {
        wrapEl?.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      if (!wrapEl) return
      const rect = wrapEl.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const t = transformRef.current
      const k0 = t.k || 1
      // Proportional wheel zoom: scale by real scroll distance (not fixed 1.12
      // jumps) so trackpads and fast flicks zoom smoothly without stutter.
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 120 : e.deltaY
      const nextK = Math.max(0.08, Math.min(6, k0 * Math.exp(-dy * 0.0012)))
      // G18: eased wheel zoom anchored at the cursor — the tween shows the
      // interactive canvas itself (bypass React SVG reconciliation)
      startZoomTweenRef.current(nextK, mx, my)
      // Debounce: hide canvas + sync SVG after scrolling stops (280ms idle).
      // Paint SYNCHRONOUSLY (not via rAF) so the zoomed frame is guaranteed to
      // replace the stale SVG even if a sim-tick rAF starves the paint loop —
      // otherwise the canvas hides and the old camera frame snaps back.
      if (wheelDebounceRef.current) clearTimeout(wheelDebounceRef.current)
      wheelDebounceRef.current = setTimeout(() => {
        wheelDebounceRef.current = null
        // Don't hide if a pointer gesture started during the debounce window
        if (pointerGestureRef.current) return
        hideInteractiveCanvas()
        paintFnRef.current()
      }, 280)
    }

    const onHover = (e: PointerEvent): void => {
      if (mode !== 'none') return
      if (e.pointerType === 'touch') return
      // Same overlay rule as pointerdown — no phantom tooltips over overlay UI
      if (isOverlayUi(e.target)) return
      const hit = hitNodeRef.current(e.clientX, e.clientY)
      const next = hit?.id || null
      if (next !== hoverIdRef.current) {
        setHoverIdRef.current(next)
        // Obsidian affordance: pointer cursor over a draggable node
        wrapEl?.classList.toggle('node-hover', next != null)
        // P1-2: delay before showing; switching node re-arms the timer
        tooltipSchedulerRef.current?.hover(hit ?? null, e.clientX, e.clientY)
      } else if (hit) {
        // Same node: follow the cursor (or refresh the pending anchor)
        tooltipSchedulerRef.current?.hover(hit, e.clientX, e.clientY)
      }
    }

    const onLeave = (): void => {
      if (mode !== 'none') return
      wrapEl?.classList.remove('node-hover')
      setHoverIdRef.current(null)
      tooltipSchedulerRef.current?.leave()
    }

    const onDbl = (e: MouseEvent): void => {
      // Rapid clicks on zoom controls must not zoom/open nodes behind the buttons
      if (isOverlayUi(e.target)) return
      const hit = hitNodeRef.current(e.clientX, e.clientY)
      if (hit) {
        // Ghosts (unresolved wikilinks) and tags have no note to open — ignore
        if (hit.isGhost || hit.isTag) return
        // P2-4: double-click a node → open it (Obsidian). Keep the legacy
        // unpin — dragging only ever pins, so dblclick stays the release path.
        hit.fx = null
        hit.fy = null
        hit.pinned = false
        posCache.current.set(hit.id, { x: hit.x!, y: hit.y!, fx: null, fy: null })
        setPinnedCount(nodesRef.current.filter((n) => n.pinned || n.fx != null).length)
        simRef.current?.alpha(0.3).restart()
        schedulePaint()
        // Obsidian: dblclick is THE open gesture — single-click only selects
        // now, so both notes (editor tab) and attachments (OS app) open here
        // without any double-launch risk.
        if (hit.path && !hit.isAttachment) {
          void openTabRef.current(hit.path)
          setActiveViewRef.current('editor')
        } else if (hit.isAttachment && hit.path && window.api?.openFileExternal) {
          void window.api.openFileExternal(hit.path)
        }
        return
      }
      // P2-4: double-click empty space → zoom in at the cursor (Obsidian
      // canvas feel), using the same eased tween as wheel/buttons (G18)
      const rect = wrapRef.current?.getBoundingClientRect()
      if (!rect) return
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const k0 = transformRef.current.k || 1
      const nextK = Math.max(0.08, Math.min(6, k0 * 1.5))
      startZoomTweenRef.current(nextK, mx, my)
    }

    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      const hit = hitNodeRef.current(e.clientX, e.clientY)
      if (!hit) {
        setCtxMenu(null)
        return
      }
      setCtxMenu({ x: e.clientX, y: e.clientY, node: hit })
    }

    const bind = (el: HTMLDivElement): void => {
      wrapEl = el
      el.style.touchAction = 'none'
      el.style.userSelect = 'none'
      el.style.webkitUserSelect = 'none'

      el.addEventListener('pointerdown', onPointerDown, { passive: false })
      el.addEventListener('pointermove', onHover, { passive: true })
      el.addEventListener('pointerleave', onLeave)
      el.addEventListener('wheel', onWheel, { passive: false })
      el.addEventListener('dblclick', onDbl)
      el.addEventListener('contextmenu', onContextMenu)

      ;(window as unknown as { __wgGraph?: object }).__wgGraph = {
        getTransform: () => {
          const t = transformRef.current
          return { x: t.x, y: t.y, k: t.k }
        },
        panBy: (dx: number, dy: number) => {
          const t = transformRef.current
          setCameraTransformRef.current(
            d3.zoomIdentity.translate(t.x + dx, t.y + dy).scale(t.k || 1),
            { user: true, save: false }
          )
        }
      }
    }

    const unbind = (): void => {
      clearDocListeners()
      if (wheelDebounceRef.current) {
        clearTimeout(wheelDebounceRef.current)
        wheelDebounceRef.current = null
      }
      // P1-2: drop any pending tooltip timer on unbind (never fire after cleanup)
      tooltipSchedulerRef.current?.dispose()
      // Reset interactive canvas state on cleanup
      if (interactiveCanvasRef.current) {
        interactiveCanvasRef.current = false
        const canvas = canvasRef.current
        if (canvas) {
          canvas.style.visibility = 'hidden'
          canvas.style.opacity = '0'
          canvas.style.zIndex = '0'
        }
        const svgHost = wrapRef.current?.querySelector('.graph-svg-host') as HTMLElement | null
        if (svgHost) svgHost.style.display = ''
      }
      if (!wrapEl) return
      wrapEl.removeEventListener('pointerdown', onPointerDown)
      wrapEl.removeEventListener('pointermove', onHover)
      wrapEl.removeEventListener('pointerleave', onLeave)
      wrapEl.removeEventListener('wheel', onWheel)
      wrapEl.removeEventListener('dblclick', onDbl)
      wrapEl.removeEventListener('contextmenu', onContextMenu)
      wrapEl = null
      try {
        delete (window as unknown as { __wgGraph?: object }).__wgGraph
      } catch {
        /* */
      }
    }

    const tryBind = (): void => {
      if (cancelled) return
      const el = wrapRef.current
      if (el) {
        bind(el)
        return
      }
      requestAnimationFrame(tryBind)
    }
    tryBind()

    return () => {
      cancelled = true
      unbind()
    }
    // Binding retries until sim is ready; canvas draw/show helpers are stable
    // imperative handlers that must not retrigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, schedulePaint])

  // External focus — retry until sim has positions (was clearing focus too early)
  useEffect(() => {
    if (!focusedNodeId) return
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const attempt = (): void => {
      const d = nodesRef.current.find((n) => n.id === focusedNodeId)
      const wrap = wrapRef.current
      if (d && d.x != null && d.y != null && wrap && wrap.clientWidth > 8) {
        const width = wrap.clientWidth
        const height = wrap.clientHeight || 400
        const k = 1.8
        transformRef.current = d3.zoomIdentity
          .translate(width / 2 - d.x * k, height / 2 - d.y * k)
          .scale(k)
        setHoverId(focusedNodeId)
        hasAutoFitRef.current = true
        cameraHydratedRef.current = true
        scheduleSaveCamera()
        schedulePaint()
        setFocusedNode(null)
        return
      }
      tries++
      if (tries < 24) {
        // ~1.2s of retries while simulation settles
        timer = setTimeout(attempt, 50)
      } else {
        setFocusedNode(null)
      }
    }
    attempt()
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [focusedNodeId, setFocusedNode, setHoverId, schedulePaint, scheduleSaveCamera])

  // Resize — critical for first open (flex height 0 → real size)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let t: ReturnType<typeof setTimeout> | null = null
    const onResize = (): void => {
      // Cheap path: resize buffer + repaint immediately so the canvas tracks the drag
      syncCanvasSize()
      schedulePaint()
      // Expensive path (re-apply forces + auto-fit) only after the resize settles,
      // otherwise dragging the window re-runs the d3 simulation every tick (jank)
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        const sized = syncCanvasSize()
        if (!sized.ready) {
          return
        }
        const { w, h } = sized
        const wasZero = lastSizeRef.current.w < 8 || lastSizeRef.current.h < 8
        const grewALot =
          lastSizeRef.current.w > 0 &&
          (Math.abs(w - lastSizeRef.current.w) > 40 || Math.abs(h - lastSizeRef.current.h) > 40)
        lastSizeRef.current = { w, h }

        const sim = simRef.current
        if (sim) {
          applyForces(
            sim as d3.Simulation<SimNode, undefined>,
            forcesRef.current,
            w,
            h,
            nodesRef.current.length > 80,
            viewFlagsRef.current.nodeSize || 1
          )
          sim.alpha(Math.max(sim.alpha(), wasZero ? 0.35 : 0.08)).restart()
        }
        // First real size (0→valid): fit only if camera not restored/user panned
        if (wasZero && nodesRef.current.length > 0 && canAutoFitCamera()) {
          hasAutoFitRef.current = true
          fitView(false)
        } else if (grewALot && canAutoFitCamera() && nodesRef.current.length > 0) {
          hasAutoFitRef.current = true
          fitView(false)
        } else if (
          grewALot &&
          nodesRef.current.length > 0 &&
          !userCameraTouchedRef.current &&
          !cameraHydratedRef.current
        ) {
          ensureGraphVisibleRef.current('resize')
        }
        schedulePaint()
      }, 250)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(el)
    // Also run once after mount (covers cases RO doesn't fire on first open)
    requestAnimationFrame(() => requestAnimationFrame(onResize))
    // Extra delayed pass — Windows Electron sometimes settles titlebar/flex one frame late
    const boot = window.setTimeout(onResize, 120)
    return () => {
      if (t) clearTimeout(t)
      clearTimeout(boot)
      ro.disconnect()
    }
  }, [schedulePaint, syncCanvasSize, fitView])

  const collectLayoutPatch = useCallback((onlyPinned = false) => {
    const patch: Record<string, { x: number; y: number; pinned?: boolean }> = {}
    for (const n of nodesRef.current) {
      if (n.x == null || n.y == null) continue
      if (n.isGhost || n.type === 'ghost' || n.isTag || n.type === 'tag') continue
      const pinned = Boolean(n.pinned || n.fx != null)
      if (onlyPinned && !pinned) continue
      patch[n.id] = { x: n.x, y: n.y, pinned }
    }
    return patch
  }, [])

  const handleReheat = useCallback(() => {
    for (const n of nodesRef.current) {
      n.fx = null
      n.fy = null
      n.pinned = false
      posCache.current.set(n.id, { x: n.x!, y: n.y!, fx: null, fy: null })
    }
    setPinnedCount(0)
    setLayoutStatus('Pins released · re-layout')
    const sim = simRef.current
    if (sim) {
      sim.alphaTarget(animateForcesRef.current ? OBSIDIAN_SIM.animateAlphaTarget : 0)
      sim.alpha(0.75).restart()
    }
    schedulePaint()
  }, [schedulePaint])

  /** Reheat forces + fit camera (Obsidian "start" feel) */
  const handleReheatAndFit = useCallback(() => {
    userCameraTouchedRef.current = false
    cameraHydratedRef.current = false
    hasAutoFitRef.current = false
    handleReheat()
    flashAction('Layout — reheat forces…')
    requestAnimationFrame(() => {
      requestAnimationFrame(() => fitView(true, null, { silent: false }))
    })
  }, [handleReheat, fitView, flashAction])

  const applyForcePreset = useCallback(
    (key: string) => {
      const preset = FORCE_PRESETS[key]
      if (!preset) return
      const next = { ...preset.forces }
      setForces(next)
      void updateGraphSettings({ forces: next })
      setLayoutStatus(`Preset: ${preset.label}`)
      simRef.current?.alpha(0.55).restart()
    },
    [updateGraphSettings]
  )

  // Obsidian "Animate" — gentle continuous forces when on
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return
    if (animateForces) {
      sim.alphaTarget(OBSIDIAN_SIM.animateAlphaTarget).restart()
    } else {
      sim.alphaTarget(0)
    }
    schedulePaint()
  }, [animateForces, schedulePaint])

  const handleSaveLayout = useCallback(async () => {
    const patch = collectLayoutPatch(false)
    const count = Object.keys(patch).length
    if (count === 0) {
      flashAction('Save — tidak ada posisi (tunggu sim / buka vault)')
      return
    }
    flashAction(`Save — menyimpan ${count} nodes…`)
    const ok = await saveLayoutPositions(patch, false)
    // Also persist camera so Fit state survives reload
    const t = transformRef.current
    if (ok && Number.isFinite(t.k)) {
      void saveGraphCamera({ x: t.x, y: t.y, k: t.k })
    }
    flashAction(
      ok
        ? `Save OK · ${count} nodes → .workspacegraph/graph-layout.json`
        : 'Save gagal — vault belum open / write error'
    )
  }, [collectLayoutPatch, saveLayoutPositions, saveGraphCamera, flashAction])

  const handleClearLayout = useCallback(async () => {
    handleReheat()
    const ok = await saveLayoutPositions({}, true)
    layoutHydratedRef.current = false
    flashAction(ok ? 'Layout file dikosongkan' : 'Gagal clear layout')
  }, [handleReheat, saveLayoutPositions, flashAction])

  const handleForcesChange = useCallback((next: GraphForceSettings) => {
    setForces(next)
  }, [])

  const handleForcesCommit = useCallback(
    (next: GraphForceSettings) => {
      setForces(next)
      void updateGraphSettings({ forces: next })
      setLayoutStatus('Forces disimpan')
      // Visible reheat: releasing a force slider should reshape the graph now
      simRef.current?.alpha(0.55).restart()
      schedulePaint()
    },
    [updateGraphSettings, schedulePaint]
  )

  const handleForcesReset = useCallback(() => {
    const next = { ...DEFAULT_FORCE_SETTINGS }
    setForces(next)
    void updateGraphSettings({ forces: next })
    setLayoutStatus('Forces di-reset ke default')
  }, [updateGraphSettings])

  // Obsidian-like display opts: live while sliding, persist on commit
  const handleDisplayOptsChange = useCallback((next: GraphDisplayOpts) => {
    setDisplayOpts(next)
  }, [])

  const handleDisplayOptsCommit = useCallback(
    (next: GraphDisplayOpts) => {
      setDisplayOpts(next)
      void updateGraphSettings({ display: next })
    },
    [updateGraphSettings]
  )

  const handleColorGroupsChange = useCallback(
    (next: GraphColorGroup[]) => {
      setColorGroups(next)
      void updateGraphSettings({ groups: next })
    },
    [updateGraphSettings]
  )

  // Re-paint when filter/path/focus paint flags change without full sim rebuild
  useEffect(() => {
    schedulePaint()
  }, [
    searchMatchIds,
    hubMode,
    hubThreshold,
    focusedNodeId,
    pathNodeIds,
    pathEdgeKeys,
    focusNodeIds,
    focusEdgeKeys,
    colorBy,
    perfMode,
    selectedIds,
    displayOpts,
    groupColorById,
    schedulePaint
  ])

  const handleFindPath = useCallback(async () => {
    const titleOf = (id: string): string =>
      nodesRef.current.find((n) => n.id === id)?.title || id.slice(0, 8)
    if (!pathFromId || !pathToId) {
      const d = diagnosePathResult({ phase: 'need-two' })
      setGraphDiag(d)
      setPathStatus(formatGraphDiag(d))
      return
    }
    const fromTitle = titleOf(pathFromId)
    const toTitle = titleOf(pathToId)
    setPathStatus(`[PATH] Mencari “${fromTitle}” → “${toTitle}”…`)
    const res = await findPath(pathFromId, pathToId, showTagEdges)
    if (!res) {
      const d = diagnosePathResult({
        phase: 'fail-engine',
        fromTitle,
        toTitle
      })
      setGraphDiag(d)
      setPathStatus(formatGraphDiag(d))
      setPathNodeIds(null)
      setPathEdgeKeys(null)
      return
    }
    if (!res.found) {
      const d = diagnosePathResult({
        phase: 'fail-none',
        fromTitle,
        toTitle
      })
      setGraphDiag(d)
      setPathStatus(formatGraphDiag(d))
      setPathNodeIds(null)
      setPathEdgeKeys(null)
      return
    }
    setPathNodeIds(new Set(res.nodeIds))
    setPathEdgeKeys(new Set(res.edgeKeys))
    const d = diagnosePathResult({
      phase: 'ok',
      fromTitle,
      toTitle,
      hops: res.length,
      noteCount: res.nodeIds.length
    })
    setGraphDiag(d)
    setPathStatus(
      res.length === 0 ? `[PATH_OK] Note yang sama (“${fromTitle}”)` : formatGraphDiag(d)
    )
    setFocusNodeIds(null)
    setFocusEdgeKeys(null)
    // Frame path endpoints in view
    if (res.nodeIds.length > 0) {
      requestAnimationFrame(() => fitView(true, new Set(res.nodeIds)))
    }
  }, [pathFromId, pathToId, findPath, showTagEdges, fitView])

  const handleClearPath = useCallback(() => {
    setPathFromId('')
    setPathToId('')
    setPathNodeIds(null)
    setPathEdgeKeys(null)
    setPathStatus(null)
  }, [])

  const handleFocusNeighbors = useCallback(async () => {
    const center = pathFromId || hoverIdRef.current || focusedNodeId
    if (!center) {
      setPathStatus('Pilih path-from atau hover node, lalu Focus')
      return
    }
    const res = await fetchNeighborhood(center, focusDepth)
    if (!res) {
      setPathStatus('Focus gagal')
      return
    }
    setFocusNodeIds(new Set(res.ids))
    setFocusEdgeKeys(new Set(res.edgeKeys))
    setPathNodeIds(null)
    setPathEdgeKeys(null)
    setPathStatus(`Focus depth ${focusDepth} · ${res.ids.length} notes`)
  }, [pathFromId, focusedNodeId, fetchNeighborhood, focusDepth])

  const handleClearFocus = useCallback(() => {
    setFocusNodeIds(null)
    setFocusEdgeKeys(null)
    if (pathStatusRef.current?.startsWith('Focus')) setPathStatus(null)
  }, [])

  const buildViewSnapshot = useCallback((): GraphViewSnapshot => {
    const t = transformRef.current
    return {
      orphanMode,
      hubMode,
      hubDegreeThreshold: hubThreshold,
      selectedType,
      selectedTag,
      showLabels,
      showTagEdges,
      showLegend,
      colorBy,
      forces: { ...forces },
      perfMode,
      ...displayOpts,
      existingFilesOnly,
      searchMode,
      showTags,
      showAttachments,
      animateForces,
      camera: t ? { x: t.x, y: t.y, k: t.k } : null,
      groups: colorGroups
    }
  }, [
    orphanMode,
    hubMode,
    hubThreshold,
    selectedType,
    selectedTag,
    showLabels,
    showTagEdges,
    showLegend,
    colorBy,
    forces,
    perfMode,
    displayOpts,
    existingFilesOnly,
    searchMode,
    showTags,
    showAttachments,
    animateForces,
    colorGroups
  ])

  const handleSaveView = useCallback(
    async (name: string) => {
      const snap = buildViewSnapshot()
      const view = await saveGraphView(name, snap)
      setViewsStatus(view ? `View “${view.name}” tersimpan` : 'Gagal simpan view')
    },
    [buildViewSnapshot, saveGraphView]
  )

  const handleLoadView = useCallback(
    (id: string) => {
      const view = savedViews.find((v) => v.id === id)
      if (!view?.snapshot) {
        setViewsStatus('View tidak ditemukan')
        return
      }
      const s = view.snapshot
      setOrphanMode(s.orphanMode === 'hide' || s.orphanMode === 'only' ? s.orphanMode : 'all')
      setHubMode(s.hubMode === 'hide' || s.hubMode === 'dim' ? s.hubMode : 'all')
      setHubThreshold(s.hubDegreeThreshold ?? 12)
      setSelectedType(s.selectedType || 'all')
      setSelectedTag(s.selectedTag || 'all')
      setShowLabels(s.showLabels !== false)
      setShowTagEdges(Boolean(s.showTagEdges))
      setShowLegend(Boolean(s.showLegend))
      setColorBy(s.colorBy === 'folder' ? 'folder' : s.colorBy === 'type' ? 'type' : 'default')
      if (s.forces) setForces({ ...DEFAULT_FORCE_SETTINGS, ...s.forces })
      setPerfMode(s.perfMode === 'quality' || s.perfMode === 'speed' ? s.perfMode : 'auto')
      setExistingFilesOnly(s.existingFilesOnly !== false)
      setSearchMode(s.searchMode === 'filter' ? 'filter' : 'spotlight')
      setShowTags(Boolean(s.showTags))
      setShowAttachments(Boolean(s.showAttachments))
      setAnimateForces(Boolean(s.animateForces))
      setDisplayOpts((prev) => ({
        ...prev,
        edgeColorBy: s.edgeColorBy === 'type' ? 'type' : 'default'
      }))
      // Persist forces/display to app settings so they stick
      void updateGraphSettings({
        forces: s.forces || DEFAULT_FORCE_SETTINGS,
        display: {
          showLabels: s.showLabels !== false,
          showTagEdges: Boolean(s.showTagEdges),
          showLegend: Boolean(s.showLegend),
          dimHubs: s.hubMode === 'dim',
          hideOrphans: s.orphanMode === 'hide',
          arrows: s.arrows ?? false,
          textFade: s.textFade ?? DEFAULT_DISPLAY_OPTS.textFade,
          nodeSize: s.nodeSize ?? 1,
          lineThickness: s.lineThickness ?? 1,
          existingFilesOnly: s.existingFilesOnly !== false,
          showTags: Boolean(s.showTags),
          showAttachments: Boolean(s.showAttachments),
          animateForces: Boolean(s.animateForces),
          edgeColorBy: s.edgeColorBy === 'type' ? 'type' : 'default'
        },
        filters: {
          hubDegreeThreshold: s.hubDegreeThreshold ?? 12,
          localDepth: graphSettings?.filters.localDepth ?? 1,
          orphanMode: s.orphanMode || 'all',
          hubMode: s.hubMode || 'dim',
          searchMode: s.searchMode === 'filter' ? 'filter' : 'spotlight'
        },
        groups: s.groups || []
      })
      if (s.camera && applyCamera(s.camera, true)) {
        setViewsStatus(`Loaded “${view.name}” + camera`)
      } else {
        setViewsStatus(`Loaded “${view.name}”`)
      }
      schedulePaint()
    },
    [savedViews, updateGraphSettings, graphSettings?.filters.localDepth, schedulePaint, applyCamera]
  )

  const handleDeleteView = useCallback(
    async (id: string) => {
      const ok = await deleteGraphView(id)
      setViewsStatus(ok ? 'View dihapus' : 'Gagal hapus view')
    },
    [deleteGraphView]
  )

  const handleExportPng = useCallback(() => {
    const sized = syncCanvasSize()
    if (!sized.ready) {
      flashAction('PNG — area graph belum siap, tekan Fit dulu')
      setViewsStatus('Area graph belum berukuran — coba Fit dulu')
      schedulePaint()
      return
    }
    if (nodesRef.current.length === 0) {
      flashAction('PNG — graph kosong')
      return
    }
    if (!hasAutoFitRef.current && nodesRef.current.length > 0) {
      hasAutoFitRef.current = true
      fitView(false)
    }
    flashAction('PNG — mengekspor…')
    // Paint hidden canvas buffer now (export path inside paint)
    exportCanvasPaintRef.current = true
    paint()
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const fileName = `workspacegraph-${stamp}.png`

    /** Electron can't reliably trigger <a download> with data URLs — use the
     * native save dialog via IPC (dialog.showSaveDialog + fs.writeFile). */
    const downloadDataUrl = (url: string, note: string): void => {
      void window.api
        .saveGraphPng(url, fileName)
        .then((res) => {
          if (!res?.ok) {
            const why = res?.canceled ? 'dibatalkan' : res?.error || 'unknown'
            flashAction(`PNG gagal — ${why}`)
            setViewsStatus(`Export PNG ${why}`)
            return
          }
          const msg = `PNG OK · ${stats.nodes} nodes${note}${res.path ? ' → ' + res.path : ''}`
          setViewsStatus(msg)
          flashAction(msg)
        })
        .catch((err) => {
          console.error(err)
          flashAction('PNG gagal unduh')
          setViewsStatus('Export PNG gagal unduh')
        })
    }

    const tryCanvasDownload = (note: string): void => {
      const canvas = canvasRef.current
      if (!canvas || canvas.width < 8 || canvas.height < 8) {
        flashAction('PNG gagal — canvas kosong')
        setViewsStatus('Export PNG gagal (canvas kosong)')
        return
      }
      try {
        downloadDataUrl(canvas.toDataURL('image/png'), note)
      } catch (e) {
        console.error(e)
        flashAction('PNG gagal (canvas)')
        setViewsStatus('Export PNG gagal')
      }
    }

    // Prefer SVG → raster (what user sees). Wait 1–2 frames so React SVG is current.
    const { w, h } = sized
    const runSvgExport = (): void => {
      const svg = svgRef.current
      if (!svg || w <= 8 || h <= 8) {
        tryCanvasDownload(' · canvas')
        return
      }
      try {
        const clone = svg.cloneNode(true) as SVGSVGElement
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
        clone.setAttribute('width', String(w))
        clone.setAttribute('height', String(h))
        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        bg.setAttribute('width', '100%')
        bg.setAttribute('height', '100%')
        bg.setAttribute('fill', paletteRef.current.bg || '#1e1e22')
        clone.insertBefore(bg, clone.firstChild)
        const xml = new XMLSerializer().serializeToString(clone)
        // data: URL avoids blob CORS issues on some Electron builds
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)
        const img = new Image()
        img.onload = () => {
          try {
            const out = document.createElement('canvas')
            const dpr = Math.min(window.devicePixelRatio || 1, 2)
            out.width = Math.floor(w * dpr)
            out.height = Math.floor(h * dpr)
            const c = out.getContext('2d')
            if (!c) throw new Error('no 2d')
            c.scale(dpr, dpr)
            c.fillStyle = paletteRef.current.bg || '#1e1e22'
            c.fillRect(0, 0, w, h)
            c.drawImage(img, 0, 0, w, h)
            downloadDataUrl(out.toDataURL('image/png'), ' · SVG')
          } catch (err) {
            console.error(err)
            tryCanvasDownload(' · canvas fallback')
          }
        }
        img.onerror = () => tryCanvasDownload(' · canvas fallback')
        img.src = url
      } catch (err) {
        console.error(err)
        tryCanvasDownload(' · canvas')
      }
    }

    requestAnimationFrame(() => requestAnimationFrame(runSvgExport))
  }, [paint, stats.nodes, syncCanvasSize, schedulePaint, fitView, flashAction])

  // Phase 6: keyboard shortcuts when Graph view is active
  const onKey = useCallback(
    async (e: KeyboardEvent) => {
      if (activeView !== 'graph') return
      const el = e.target as HTMLElement | null
      if (!el) return
      const tag = el.tagName
      // Interactive targets own their keys — Enter must activate a focused
      // panel BUTTON, not open a selected node (P2-7 regression guard)
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        tag === 'BUTTON' ||
        tag === 'A' ||
        el.isContentEditable
      ) {
        if (e.key === 'Escape') {
          ;(el as HTMLInputElement).blur?.()
          return
        }
        return
      }
      // Phase 7: Ctrl/Cmd+A select all visible; Ctrl+C copy wikilinks
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        setSelectedIds(new Set(nodesRef.current.map((n) => n.id)))
        setPathStatus(`Selected ${nodesRef.current.length} nodes`)
        schedulePaint()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        const ids = selectedIdsRef.current
        if (ids.size === 0) return
        e.preventDefault()
        const titles = nodesRef.current.filter((n) => ids.has(n.id)).map((n) => `[[${n.title}]]`)
        void navigator.clipboard?.writeText(titles.join(' ')).then(
          () => setPathStatus(`Copied ${titles.length} wikilink(s)`),
          () => setPathStatus('Clipboard gagal')
        )
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return

      if (e.key === 'Escape') {
        e.preventDefault()
        // Obsidian: Esc deselects FIRST — the full path/focus/spotlight reset
        // only runs once nothing is selected (two-step, never destructive)
        if (selectedIdsRef.current.size > 0) {
          setSelectedIds(new Set())
          schedulePaint()
          setPathStatus('Selection cleared')
          return
        }
        handleClearPath()
        handleClearFocus()
        setSearchQuery('')
        setShowFilters(false)
        setPathStatus('Cleared path/focus/selection/spotlight')
        schedulePaint()
        return
      }
      // P2-7: [ / ] cycle the camera between selected nodes (keyboard
      // inspection of a multi-selection); Enter opens the node the camera
      // is currently on
      if (e.key === '[' || e.key === ']') {
        const ids = [...selectedIdsRef.current]
        if (ids.length < 2) return
        e.preventDefault()
        // Only actionable nodes are navigable — ghosts (unresolved) and tags
        // cannot open, and a ghost is already dashed (no double-dash visual)
        const ordered = nodesRef.current.filter(
          (n) =>
            ids.includes(n.id) && !n.isGhost && n.type !== 'ghost' && !n.isTag && n.type !== 'tag'
        )
        if (ordered.length < 2) return
        let idx = selectionNavIndexRef.current
        if (idx >= ordered.length) idx = 0
        idx = (idx + (e.key === ']' ? 1 : -1) + ordered.length) % ordered.length
        selectionNavIndexRef.current = idx
        const target = ordered[idx]
        // P2-8: mark the focused node for the dashed ring (read at paint time
        // by both renderers; stale ids render nothing because renderers also
        // require flags.selectedIds.has(id))
        viewFlagsRef.current.focusSelId = target.id
        // Guarantee a repaint even if the camera transform doesn't change
        // (overlapping selected nodes) — setCameraTransformRef may short-circuit
        schedulePaint()
        const sized = syncCanvasSize()
        const cx = (sized.ready ? sized.w : wrapRef.current?.clientWidth || 400) / 2
        const cy = (sized.ready ? sized.h : wrapRef.current?.clientHeight || 300) / 2
        const t = transformRef.current
        const k = Math.max(t.k || 1, 0.8)
        setCameraTransformRef.current(
          d3.zoomIdentity.translate(cx - (target.x ?? 0) * k, cy - (target.y ?? 0) * k).scale(k),
          { user: true, save: true }
        )
        return
      }
      if (e.key === 'Enter') {
        const ids = [...selectedIdsRef.current]
        if (ids.length === 0) return
        e.preventDefault()
        const ordered = nodesRef.current.filter((n) => ids.includes(n.id))
        const idx = Math.min(selectionNavIndexRef.current, ordered.length - 1)
        const focus = ordered[idx] ?? ordered[0]
        if (!focus) return
        if (focus.isAttachment && focus.path && window.api?.openFileExternal) {
          void window.api.openFileExternal(focus.path)
        } else if (
          focus.path &&
          !focus.isGhost &&
          !focus.isAttachment &&
          !focus.isTag &&
          focus.type !== 'tag'
        ) {
          void openTab(focus.path)
          setActiveView('editor')
        }
        return
      }
      if (e.key === 'o' || e.key === 'O') {
        const ids = [...selectedIdsRef.current]
        if (ids.length === 0) return
        e.preventDefault()
        const first = nodesRef.current.find((n) => n.id === ids[0])
        if (first?.isAttachment && first.path && window.api?.openFileExternal) {
          void window.api.openFileExternal(first.path)
        } else if (first?.path && !first.isGhost && !first.isAttachment) {
          void openTab(first.path)
          setActiveView('editor')
        }
        return
      }
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        fitView(true, null, { silent: false })
        return
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        handleReheatAndFit()
        return
      }
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        void handleSaveLayout()
        return
      }
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault()
        handleExportPng()
        return
      }
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault()
        const next = !showFiltersRef.current
        setShowFilters(next)
        flashAction(next ? 'Settings terbuka' : 'Settings ditutup')
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        setShowFilters(true)
        requestAnimationFrame(() => {
          document.getElementById('graph-spotlight')?.focus()
        })
        return
      }
      if (e.key === '1') {
        e.preventDefault()
        setOrphanMode('all')
        return
      }
      if (e.key === '2') {
        e.preventDefault()
        setOrphanMode((m) => (m === 'hide' ? 'all' : 'hide'))
        return
      }
      if (e.key === '3') {
        e.preventDefault()
        setHubMode((m) => (m === 'dim' ? 'all' : 'dim'))
        return
      }
      if (e.key === '4') {
        e.preventDefault()
        setOrphanMode('only')
        setPathStatus('Orphans only')
        return
      }
      // Arrow keys: pan (Obsidian-like explore)
      const panStep = e.shiftKey ? 80 : 40
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const t = transformRef.current
        setCameraTransformRef.current(
          d3.zoomIdentity.translate(t.x + panStep, t.y).scale(t.k || 1),
          { user: true, save: true }
        )
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        const t = transformRef.current
        setCameraTransformRef.current(
          d3.zoomIdentity.translate(t.x - panStep, t.y).scale(t.k || 1),
          { user: true, save: true }
        )
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        const t = transformRef.current
        setCameraTransformRef.current(
          d3.zoomIdentity.translate(t.x, t.y + panStep).scale(t.k || 1),
          { user: true, save: true }
        )
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const t = transformRef.current
        setCameraTransformRef.current(
          d3.zoomIdentity.translate(t.x, t.y - panStep).scale(t.k || 1),
          { user: true, save: true }
        )
        return
      }
      // Zoom: +/= and -/_
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        zoomBy(1.2)
        return
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        zoomBy(1 / 1.2)
        return
      }
      // Home = fit all; 0 = mild re-center fit
      if (e.key === 'Home') {
        e.preventDefault()
        fitView(true, null, { silent: false })
        return
      }
      if (e.key === '0') {
        e.preventDefault()
        fitView(true, null, { silent: false })
        return
      }
      // A = toggle animate forces
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault()
        const next = !animateForcesRef.current
        setAnimateForces(next)
        void updateGraphSettings({ display: { animateForces: next } })
        setPathStatus(next ? 'Animate ON' : 'Animate OFF')
        return
      }
      // T = toggle tags
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        const next = !showTagsRef.current
        setShowTags(next)
        void updateGraphSettings({ display: { showTags: next } })
        setPathStatus(next ? 'Tags ON' : 'Tags OFF')
        return
      }
      // D = toggle real-browser SVG perf overlay (commit ms + element counts)
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault()
        const next = !perfOverlayRef.current
        setPerfOverlay(next)
        setPathStatus(
          next
            ? `Perf overlay ON — throttle adaptif ${throttleWindowMsRef.current}ms (target p95 ${THROTTLE_TARGET_P95_MS}ms)`
            : 'Perf overlay OFF'
        )
        return
      }
      // Delete = delete selected non-ghost nodes
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const ids = [...selectedIdsRef.current]
        if (ids.length === 0) return
        e.preventDefault()
        const targets = nodesRef.current.filter(
          (n) =>
            ids.includes(n.id) &&
            !n.isGhost &&
            n.type !== 'ghost' &&
            !n.isTag &&
            n.type !== 'tag' &&
            n.path
        )
        if (targets.length === 0) {
          setPathStatus('Tidak ada node yang bisa dihapus')
          return
        }
        void confirmDialog({
          title: 'Hapus file?',
          message: `Hapus ${targets.length} file?`,
          danger: true,
          okLabel: 'Hapus'
        }).then((ok) => {
          if (!ok) return
          for (const n of targets) void window.api.deleteFile(n.path)
          setSelectedIds(new Set())
          setPathStatus(`Terhapus ${targets.length} file`)
        })
        return
      }
    },
    // schedulePaint / scheduleSaveCamera are stable rAF helpers, not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeView,
      handleClearPath,
      handleClearFocus,
      fitView,
      handleReheatAndFit,
      handleSaveLayout,
      handleExportPng,
      zoomBy,
      updateGraphSettings,
      openTab,
      setActiveView,
      flashAction
    ]
  )

  useEffect(() => {
    if (activeView !== 'graph') return
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeView, onKey])

  // Command palette bridge (F-3) — wg:graph-command runs even in split view
  useEffect(() => {
    const onGraphCommand = (e: Event): void => {
      const cmd = (e as CustomEvent<string>).detail
      if (cmd === 'fit') fitView(true)
      else if (cmd === 'export-png') handleExportPng()
      else if (cmd === 'save-layout') void handleSaveLayout()
      else if (cmd === 'reheat') handleReheatAndFit()
      else if (cmd === 'toggle-panel') setShowFilters((v) => !v)
    }
    window.addEventListener('wg:graph-command', onGraphCommand)
    return () => window.removeEventListener('wg:graph-command', onGraphCommand)
  }, [fitView, handleExportPng, handleSaveLayout, handleReheatAndFit])

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return
    const close = (e: MouseEvent): void => {
      const menu = document.querySelector('.ctx-menu')
      if (menu && !menu.contains(e.target as Node)) setCtxMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [ctxMenu])

  return (
    <div className="graph-container" role="application" aria-label="Knowledge graph" tabIndex={0}>
      <ul className="sr-only" aria-label="Notes in this graph (accessible list)">
        {a11yNodeList.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => {
                if (n.isAttachment && n.path && window.api?.openFileExternal) {
                  void window.api.openFileExternal(n.path)
                } else if (
                  n.path &&
                  !n.isGhost &&
                  !n.isAttachment &&
                  !n.isTag &&
                  n.type !== 'tag'
                ) {
                  void openTab(n.path)
                  setActiveView('editor')
                }
              }}
            >
              {n.title}
            </button>
          </li>
        ))}
      </ul>
      <div className="graph-toolbar">
        <span className="graph-toolbar-stats">
          {noteCount} notes · {linkCount} links
          {searchQuery.trim() ? ` · “${searchQuery.trim()}”` : ''}
          {pathNodeIds ? ` · path ${pathNodeIds.size}` : ''}
          {focusNodeIds ? ` · focus` : ''}
          {selectedIds.size ? ` · ${selectedIds.size} sel` : ''}
        </span>
        <div className="graph-toolbar-actions">
          {actionToast ? (
            <span
              className="graph-toolbar-toast"
              role="status"
              aria-live="polite"
              title={actionToast}
            >
              {actionToast}
            </span>
          ) : (
            <span
              className="graph-toolbar-hint"
              title="←↑↓→ pan · +/− zoom · Home/0 fit · Esc clear · F fit · R layout · S save · E PNG · P panel · / search · 1–4 orphans · A animate · T tags · Ctrl+A select · Ctrl+C copy · O open"
            >
              keys
            </span>
          )}
          {selectedIds.size > 0 && (
            <button
              type="button"
              className="graph-chip"
              title="Clear selection"
              onClick={() => {
                setSelectedIds(new Set())
                schedulePaint()
              }}
            >
              Clear sel
            </button>
          )}
          <button
            type="button"
            className="graph-chip"
            onClick={() => fitView(true, null, { silent: false })}
            title="Fit all nodes in view (F)"
          >
            Fit
          </button>
          <button
            type="button"
            className="graph-chip"
            onClick={handleReheatAndFit}
            title="Release pins, re-layout & fit (R)"
          >
            Layout
          </button>
          <button
            type="button"
            className="graph-chip"
            onClick={() => void handleSaveLayout()}
            title="Save node positions + camera to vault (S)"
          >
            Save
          </button>
          <button
            type="button"
            className="graph-chip"
            onClick={handleExportPng}
            title="Export graph as PNG (E)"
          >
            PNG
          </button>
          <button
            type="button"
            className={`graph-chip graph-chip-icon ${showFilters ? 'active' : ''}`}
            onClick={() => {
              const next = !showFiltersRef.current
              setShowFilters(next)
              flashAction(next ? 'Settings terbuka' : 'Settings ditutup')
            }}
            title="Graph settings panel (P)"
            aria-label="Graph settings"
            aria-expanded={showFilters}
            aria-pressed={showFilters}
          >
            <Icon name="settings" size={13} />
          </button>
        </div>
      </div>

      {showFilters && (
        <GraphFiltersPanel
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selectedType={selectedType}
          onTypeChange={setSelectedType}
          selectedTag={selectedTag}
          onTagChange={setSelectedTag}
          allTags={allTags}
          typeOptions={typeOptions.length ? typeOptions : Object.keys(paletteRef.current.colors)}
          orphanMode={orphanMode}
          onOrphanMode={setOrphanMode}
          hubMode={hubMode}
          onHubMode={setHubMode}
          hubThreshold={hubThreshold}
          onHubThreshold={setHubThreshold}
          showTagEdges={showTagEdges}
          onShowTagEdges={setShowTagEdges}
          showLabels={showLabels}
          onShowLabels={setShowLabels}
          showLegend={showLegend}
          onShowLegend={setShowLegend}
          existingFilesOnly={existingFilesOnly}
          onExistingFilesOnly={(v) => {
            setExistingFilesOnly(v)
            void updateGraphSettings({ display: { existingFilesOnly: v } })
          }}
          showTags={showTags}
          onShowTags={(v) => {
            setShowTags(v)
            void updateGraphSettings({ display: { showTags: v } })
          }}
          showAttachments={showAttachments}
          onShowAttachments={(v) => {
            setShowAttachments(v)
            void updateGraphSettings({ display: { showAttachments: v } })
          }}
          animateForces={animateForces}
          onAnimateForces={(v) => {
            setAnimateForces(v)
            void updateGraphSettings({ display: { animateForces: v } })
          }}
          onForcePreset={applyForcePreset}
          searchMode={searchMode}
          onSearchMode={(m) => {
            setSearchMode(m)
            void updateGraphSettings({ filters: { searchMode: m } })
          }}
          orphanCount={
            nodes.length
              ? nodes.filter((n) => !n.isGhost && !n.isTag && !n.isAttachment && n.degree === 0)
                  .length
              : orphanIds.length
          }
          hubCount={
            nodes.length
              ? nodes.filter(
                  (n) => !n.isGhost && !n.isTag && !n.isAttachment && n.degree >= hubThreshold
                ).length
              : hubIds.length
          }
          totalNodes={nodes.filter((n) => !n.isGhost && !n.isTag && !n.isAttachment).length}
          visibleNodes={filteredNodes.length}
          ghostCount={nodes.filter((n) => n.isGhost).length}
          tagCount={nodes.filter((n) => n.isTag).length}
          attachmentCount={nodes.filter((n) => n.isAttachment).length}
          forces={forces}
          onForcesChange={handleForcesChange}
          onForcesCommit={handleForcesCommit}
          onForcesReset={handleForcesReset}
          pinnedCount={pinnedCount}
          layoutNodeCount={Object.keys(layoutNodes || {}).length}
          layoutStatus={layoutStatus}
          onSaveLayout={() => void handleSaveLayout()}
          onClearLayout={() => void handleClearLayout()}
          onReheat={handleReheatAndFit}
          colorBy={colorBy}
          onColorBy={setColorBy}
          nodeOptions={nodeOptions}
          pathFromId={pathFromId}
          pathToId={pathToId}
          onPathFromId={setPathFromId}
          onPathToId={setPathToId}
          pathStatus={pathStatus}
          hasPath={Boolean(pathNodeIds && pathNodeIds.size)}
          onFindPath={() => void handleFindPath()}
          onClearPath={handleClearPath}
          focusDepth={focusDepth}
          onFocusDepth={setFocusDepth}
          hasFocus={Boolean(focusNodeIds && focusNodeIds.size)}
          onFocusNeighbors={() => void handleFocusNeighbors()}
          onClearFocus={handleClearFocus}
          perfMode={perfMode}
          onPerfMode={setPerfMode}
          lodLabel={lodLabel(
            resolveLod(stats.nodes || filteredNodes.length, perfMode),
            stats.nodes || filteredNodes.length,
            perfMode
          )}
          savedViews={savedViews}
          onSaveView={(name) => void handleSaveView(name)}
          onLoadView={handleLoadView}
          onDeleteView={(id) => void handleDeleteView(id)}
          onExportPng={handleExportPng}
          viewsStatus={viewsStatus}
          displayOpts={displayOpts}
          onDisplayOptsChange={handleDisplayOptsChange}
          onDisplayOptsCommit={handleDisplayOptsCommit}
          // G20: edge-type legend swatches mirror the actual palette colors
          // (single source: pal.edge/edgeTag/edgeFolder/edgeAttachment)
          edgeLegend={[
            { type: 'wikilink', color: paletteRef.current.edge },
            { type: 'tag', color: paletteRef.current.edgeTag },
            { type: 'folder', color: paletteRef.current.edgeFolder },
            { type: 'lampiran', color: paletteRef.current.edgeAttachment }
          ]}
          colorGroups={colorGroups}
          onColorGroupsChange={handleColorGroupsChange}
          onPersist={(partial) => {
            void updateGraphSettings(partial)
          }}
        />
      )}

      {/* Stage = relative flex child; canvas fills it (proven pattern) */}
      <div className="graph-stage" ref={wrapRef}>
        {/* Off-screen buffer for PNG export fallback */}
        <canvas ref={canvasRef} className="graph-canvas graph-canvas--export" aria-hidden="true" />
        {/* React-owned SVG — world graph under camera transform (Obsidian zoom scale) */}
        <div className="graph-svg-host" role="img" aria-label="Knowledge graph">
          {svgFrame ? (
            <svg ref={svgRef} className="graph-svg" width={svgFrame.w} height={svgFrame.h}>
              <defs>
                {/* P2-5: Obsidian dot-grain — userSpaceOnUse pins the tile to
                    screen space, so dots stay fixed while the world pans (same
                    rule as the Canvas2D pattern). Rebuilt with the frame so a
                    theme switch repaints it via paletteRef. */}
                <pattern
                  id="wg-dotgrain-pattern"
                  width={DOT_GRID_SPACING}
                  height={DOT_GRID_SPACING}
                  patternUnits="userSpaceOnUse"
                >
                  <circle
                    cx={DOT_GRID_SPACING / 2}
                    cy={DOT_GRID_SPACING / 2}
                    r={DOT_GRID_RADIUS}
                    fill={dotGrainColor(paletteRef.current.isLight)}
                  />
                </pattern>
              </defs>
              {svgFrame.w > 0 && svgFrame.h > 0 && (
                <rect width={svgFrame.w} height={svgFrame.h} fill="url(#wg-dotgrain-pattern)" />
              )}
              <g
                className="g-world"
                transform={`translate(${svgFrame.tx},${svgFrame.ty}) scale(${svgFrame.k})`}
              >
                <g className="g-edges">
                  {svgFrame.edges.map((e) => (
                    <SvgEdgeItem key={e.key} e={e} />
                  ))}
                </g>
                <g className="g-nodes">
                  {svgFrame.nodes.map((n) => (
                    <SvgNodeItem key={n.key} n={n} />
                  ))}
                </g>
              </g>
              <g className="g-labels">
                {svgFrame.labels.map((lab) => (
                  <SvgLabelItem key={lab.key} lab={lab} />
                ))}
              </g>
            </svg>
          ) : (
            <div className="graph-live-hud graph-live-hud--load" aria-live="polite">
              Memuat graph…
            </div>
          )}
        </div>
        {nodes.length === 0 || filteredNodes.length === 0
          ? (() => {
              const emptyDiag = diagnoseEmptyFilter({
                totalNodes: nodes.length,
                loaded: graphLoaded,
                orphanMode,
                hubMode,
                selectedType,
                selectedTag,
                searchQuery,
                searchMode,
                existingFilesOnly,
                showTags,
                showAttachments
              })
              return (
                <div className="graph-empty" style={{ pointerEvents: 'auto' }}>
                  <p>
                    <code className="graph-diag-code">{emptyDiag.code}</code> {emptyDiag.title}
                  </p>
                  <p className="muted">
                    <strong>Sebab:</strong> {emptyDiag.cause}
                  </p>
                  <p className="muted">
                    <strong>Lakukan:</strong> {emptyDiag.action}
                  </p>
                  {nodes.length === 0 && graphLoaded ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      style={{ marginTop: 12, pointerEvents: 'auto' }}
                      onClick={() => window.dispatchEvent(new Event('wg:new-note'))}
                    >
                      + Buat note pertama
                    </button>
                  ) : nodes.length > 0 && filteredNodes.length === 0 ? (
                    <button
                      type="button"
                      className="btn btn-surface btn-sm"
                      style={{ marginTop: 12, pointerEvents: 'auto' }}
                      onClick={() => {
                        setOrphanMode('all')
                        setHubMode('dim')
                        setSelectedType('all')
                        setSelectedTag('all')
                        setSearchQuery('')
                        setSearchMode('spotlight')
                        setExistingFilesOnly(true)
                        setGraphDiag(null)
                        setPathStatus('[FILTER] Reset → orphans:all, type:all, search clear')
                      }}
                    >
                      Reset filter
                    </button>
                  ) : null}
                </div>
              )
            })()
          : null}

        {/* Always-on filter chip when not full graph — never silent about orphans:only */}
        {orphanMode !== 'all' ||
        hubMode === 'hide' ||
        selectedType !== 'all' ||
        selectedTag !== 'all' ? (
          <div className="graph-filter-live-chip" role="status">
            <span>
              Filter aktif:{' '}
              <strong>
                {[
                  orphanMode !== 'all' ? `orphans:${orphanMode}` : null,
                  hubMode === 'hide' ? 'hubs:hide' : null,
                  selectedType !== 'all' ? `type:${selectedType}` : null,
                  selectedTag !== 'all' ? `tag:${selectedTag}` : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </strong>
              {` · tampil ${filteredNodes.length}/${nodes.filter((n) => !n.isGhost).length}`}
            </span>
            <button
              type="button"
              className="graph-chip"
              style={{ pointerEvents: 'auto' }}
              onClick={() => {
                setOrphanMode('all')
                setHubMode('dim')
                setSelectedType('all')
                setSelectedTag('all')
                setSearchQuery('')
                setSearchMode('spotlight')
                setShowLabels(true)
                setGraphDiag(null)
                setPathStatus('[FILTER] Reset → tampilkan semua note')
                void updateGraphSettings({
                  filters: { orphanMode: 'all', hubMode: 'dim', searchMode: 'spotlight' },
                  display: { showLabels: true }
                })
                requestAnimationFrame(() => {
                  setCameraTransformRef.current(d3.zoomIdentity, { user: true, save: true })
                  hasAutoFitRef.current = false
                  fitViewRef.current?.(false)
                  hasAutoFitRef.current = true
                  schedulePaint()
                })
              }}
            >
              Tampilkan semua
            </button>
          </div>
        ) : null}

        {/* Specific banner after auto-fit / path / camera (if-A-then-B) */}
        {graphDiag && graphDiag.code !== 'OK' && filteredNodes.length > 0 ? (
          <div
            className={`graph-diag-banner graph-diag-banner--${graphDiag.severity}`}
            role="status"
          >
            <div className="graph-diag-banner-row">
              <code className="graph-diag-code">{graphDiag.code}</code>
              <strong>{graphDiag.title}</strong>
              <button
                type="button"
                className="graph-diag-dismiss"
                aria-label="Tutup"
                onClick={() => setGraphDiag(null)}
              >
                ×
              </button>
            </div>
            <p className="muted">
              <strong>Sebab:</strong> {graphDiag.cause}
            </p>
            <p className="muted">
              <strong>Lakukan:</strong> {graphDiag.action}
            </p>
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="graph-chip"
                onClick={() => {
                  setCameraTransformRef.current(d3.zoomIdentity, { user: true, save: true })
                  fitView(true, null, { silent: false })
                  setGraphDiag(null)
                }}
              >
                Fit sekarang (F)
              </button>
              <button
                type="button"
                className="graph-chip"
                onClick={() => {
                  handleReheatAndFit()
                  setGraphDiag(null)
                }}
              >
                Layout + Fit (R)
              </button>
            </div>
          </div>
        ) : null}

        {showLegend && (
          <div className="graph-legend">
            {colorGroups.length > 0
              ? colorGroups.map((g) => (
                  <div key={g.id} className="graph-legend-item" title={g.query}>
                    <span className="graph-legend-dot" style={{ background: g.color }} />
                    <span>{g.query}</span>
                  </div>
                ))
              : Object.entries(paletteRef.current.colors)
                  .filter(([k]) => k !== 'other')
                  .map(([type, color]) => (
                    <div key={type} className="graph-legend-item">
                      <span className="graph-legend-dot" style={{ background: color }} />
                      <span>{type}</span>
                    </div>
                  ))}
          </div>
        )}

        {/* Obsidian-like zoom controls (bottom-right) */}
        <div className="graph-zoom-controls">
          <button type="button" onClick={() => zoomBy(1.25)} title="Zoom in" aria-label="Zoom in">
            <Icon name="zoomIn" size={15} />
          </button>
          <button type="button" onClick={() => zoomBy(0.8)} title="Zoom out" aria-label="Zoom out">
            <Icon name="zoomOut" size={15} />
          </button>
          <button
            type="button"
            onClick={() => fitView(true, null, { silent: false })}
            title="Zoom to fit (F)"
            aria-label="Zoom to fit"
          >
            <Icon name="fitScreen" size={15} />
          </button>
        </div>

        <div
          ref={tooltipElRef}
          className="graph-tooltip"
          style={{
            opacity: 0,
            left: 0,
            top: 0,
            pointerEvents: 'none'
          }}
        />

        {/* G-perf debug overlay — toggle with D, measures real React commit */}
        {perfOverlay && perfSnap && (
          <div className="graph-perf-overlay" role="status" aria-live="off">
            <div className="graph-perf-row graph-perf-title">
              SVG commit <span className="graph-perf-kbd">D</span> tutup · throttle{' '}
              <strong>{throttleWindowMsRef.current}ms</strong>
              <span className="graph-perf-muted">
                {' '}
                (target p95 {THROTTLE_TARGET_P95_MS}ms · batas {THROTTLE_MIN_MS}–{THROTTLE_MAX_MS}
                ms)
              </span>
            </div>
            <div className="graph-perf-row">
              commit <strong>{perfSnap.avgCommitMs.toFixed(2)}ms</strong>
              <span className="graph-perf-muted">
                {' '}
                p95 {perfSnap.p95CommitMs.toFixed(2)} · max {perfSnap.maxCommitMs.toFixed(2)}
              </span>
            </div>
            <div className="graph-perf-row">
              elemen <strong>{perfSnap.edges + perfSnap.nodes + perfSnap.labels}</strong>
              <span className="graph-perf-muted">
                {' '}
                ({perfSnap.edges}E · {perfSnap.nodes}N · {perfSnap.labels}L)
              </span>
            </div>
            {/* LOD culling win: pre→post. `post` = node unik / edge utama yang
                lolos frustum — baris elemen di atas menghitung DOM incl. glow/
                ring, jadi dua baris bisa beda saat hover (disengaja). */}
            <div className="graph-perf-row">
              culled <strong>{Math.max(0, perfSnap.totalEdges - perfSnap.renderedEdges)}E</strong> ·{' '}
              <strong>{Math.max(0, perfSnap.totalNodes - perfSnap.renderedNodes)}N</strong>
              <span className="graph-perf-muted">
                {' '}
                pre→post: E {perfSnap.totalEdges}→{perfSnap.renderedEdges} · N {perfSnap.totalNodes}
                →{perfSnap.renderedNodes} (node unik)
              </span>
            </div>
            <div className="graph-perf-row">
              commit/s <strong>{perfSnap.fps}</strong>
              <span className="graph-perf-muted">
                {' '}
                · {perfSnap.count} sample · throttle-defer{' '}
                <strong>{perfThrottledRef.current}</strong>
              </span>
            </div>
            <div className="graph-perf-row graph-perf-row-canvas">
              {canvasSnap && canvasSnap.count > 0 ? (
                <>
                  canvas2D <strong>{canvasSnap.avgCommitMs.toFixed(2)}ms</strong>
                  <span className="graph-perf-muted">
                    {' '}
                    p95 {canvasSnap.p95CommitMs.toFixed(2)} · max{' '}
                    {canvasSnap.maxCommitMs.toFixed(2)}· {canvasSnap.fps}/s · {canvasSnap.count}{' '}
                    sample
                  </span>
                </>
              ) : (
                <span className="graph-perf-muted">canvas2D — pan/pinch untuk ukur draw-time</span>
              )}
            </div>
            <div className="graph-perf-row graph-perf-row-spark">
              <span className="graph-perf-muted">
                commit 60 terakhir (baris = target {THROTTLE_TARGET_P95_MS}ms)
              </span>
              <PerfSparkChart samples={sparkSamples} />
            </div>
          </div>
        )}
      </div>
      {/* .graph-stage */}

      {ctxMenu && (
        <div
          className="ctx-menu"
          style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 'var(--z-dropdown)' }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {!ctxMenu.node.isGhost && ctxMenu.node.type !== 'ghost' && ctxMenu.node.path && (
            <button
              type="button"
              onClick={() => {
                if (ctxMenu.node.isAttachment && window.api?.openFileExternal) {
                  void window.api.openFileExternal(ctxMenu.node.path)
                } else if (!ctxMenu.node.isAttachment) {
                  void openTab(ctxMenu.node.path)
                  setActiveView('editor')
                }
                setCtxMenu(null)
              }}
            >
              {ctxMenu.node.isAttachment ? 'Buka dengan app' : 'Open'}
            </button>
          )}
          {ctxMenu.node.title && (
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(ctxMenu.node.path || ctxMenu.node.title || '')
                flashAction('Path disalin')
                setCtxMenu(null)
              }}
            >
              Salin path
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              const n = ctxMenu.node
              const isPinned = Boolean(n.pinned || (n.fx != null && n.fy != null))
              if (isPinned) {
                n.fx = null
                n.fy = null
                n.pinned = false
              } else {
                n.pinned = true
              }
              posCache.current.set(n.id, { x: n.x!, y: n.y!, fx: n.fx, fy: n.fy })
              setPinnedCount(nodesRef.current.filter((nd) => nd.pinned || nd.fx != null).length)
              simRef.current?.alpha(0.3).restart()
              schedulePaint()
              setCtxMenu(null)
            }}
          >
            {ctxMenu.node.pinned || ctxMenu.node.fx != null ? 'Lepas pin' : 'Pin'}
          </button>
          {!ctxMenu.node.isGhost &&
            ctxMenu.node.type !== 'ghost' &&
            !ctxMenu.node.isTag &&
            ctxMenu.node.type !== 'tag' &&
            ctxMenu.node.path && (
              <button
                type="button"
                className="danger"
                onClick={() => {
                  void confirmDialog({
                    title: 'Hapus file?',
                    message: `Hapus "${ctxMenu.node.title || ctxMenu.node.path}"?`,
                    danger: true,
                    okLabel: 'Hapus'
                  }).then((ok) => {
                    if (!ok) return
                    void window.api.deleteFile(ctxMenu.node.path)
                    setCtxMenu(null)
                  })
                }}
              >
                Hapus
              </button>
            )}
        </div>
      )}
    </div>
  )
}
