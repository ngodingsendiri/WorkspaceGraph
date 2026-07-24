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
import { Icon } from '../ui/Icons'

import {
  GraphFiltersPanel,
  DEFAULT_FORCE_SETTINGS,
  type OrphanMode,
  type HubMode,
  type ColorByMode
} from './GraphFiltersPanel'
import {
  edgeKey,
  folderColor,
  labelZoomAlpha,
  lerp,
  nodeRadius,
  chargeFor,
  linkDistanceFor,
  resolveLod,
  smooth01,
  SpatialHash2D,
  FORCE_PRESETS,
  edgeDrawBudget,
  labelDrawBudget,
  diagnoseEmptyFilter,
  diagnoseViewportBlank,
  diagnosePathResult,
  formatGraphDiag,
  type GraphDiag,
  type LodLevel
} from './graphShared'
import type { GraphSearchMode } from '../../store/graphStore'

export const DEFAULT_DISPLAY_OPTS: GraphDisplayOpts = {
  arrows: false,
  textFade: 1,
  nodeSize: 1,
  lineThickness: 1
}

/**
 * Obsidian-like group query matcher.
 * Space-separated terms, AND semantics; `-term` negates.
 * Prefixes: tag:, path:, file:, type: — bare term matches title/path/tag.
 */
function safeTags(n: { tags?: string[] | null }): string[] {
  return Array.isArray(n.tags) ? n.tags : []
}

function matchGroupQuery(query: string, n: GraphNodeData): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return false
  const title = (n.title || '').toLowerCase()
  const path = (n.relativePath || '').toLowerCase().replace(/\\/g, '/')
  const tags = safeTags(n).map((t) => t.toLowerCase())
  return terms.every((raw) => {
    let term = raw
    let neg = false
    if (term.startsWith('-')) {
      neg = true
      term = term.slice(1)
    }
    if (!term) return true
    let hit: boolean
    if (term.startsWith('tag:')) {
      const q = term.slice(4).replace(/^#/, '')
      hit = q.length > 0 && tags.some((t) => t === q || t.startsWith(q + '/'))
    } else if (term.startsWith('path:')) {
      hit = term.length > 5 && path.includes(term.slice(5))
    } else if (term.startsWith('file:')) {
      hit = term.length > 5 && title.includes(term.slice(5))
    } else if (term.startsWith('type:')) {
      hit = term.length > 5 && n.type.toLowerCase() === term.slice(5)
    } else {
      hit = title.includes(term) || path.includes(term) || tags.some((t) => t.includes(term))
    }
    return neg ? !hit : hit
  })
}

/** First matching group wins (Obsidian semantics) */
function resolveGroupColors(
  nodes: GraphNodeData[],
  groups: GraphColorGroup[]
): Map<string, string> | null {
  if (!groups.length || !nodes.length) return null
  const map = new Map<string, string>()
  for (const n of nodes) {
    for (const g of groups) {
      if (matchGroupQuery(g.query, n)) {
        map.set(n.id, g.color)
        break
      }
    }
  }
  return map.size > 0 ? map : null
}

function lodLabel(lod: LodLevel, n: number, mode: GraphPerfMode): string {
  return `${lod} · ${n} nodes · ${mode}`
}

interface SimNode extends d3.SimulationNodeDatum, GraphNodeData {
  pinned?: boolean
}
interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  id: string
  type: string
  weight: number
  source: string | SimNode
  target: string | SimNode
}

type Palette = {
  isLight: boolean
  bg: string
  edge: string
  edgeTag: string
  edgeHot: string
  label: string
  labelBg: string
  nodeStroke: string
  colors: Record<string, string>
}

function css(name: string, fb: string): string {
  if (typeof document === 'undefined') return fb
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb
}

/**
 * Canvas 2D is picky: some CSS color functions / unresolved vars silently fail
 * → fillStyle stays previous (often = bg) → "kamar gelap" (hit works, nodes invisible).
 * Always prefer plain hex / rgba for stroke & fill.
 */
function canvasSafeColor(raw: string, fallback: string): string {
  const s = (raw || '').trim()
  if (!s) return fallback
  // Accept hex, rgb(a), hsl(a) — reject empty/var()/color-mix leftovers
  if (s.startsWith('var(') || s.startsWith('color-mix') || s.startsWith('oklch') || s.startsWith('oklab')) {
    return fallback
  }
  return s
}

/** Hardcoded high-contrast palette for graph canvas (never depends on broken CSS). */
function readPalette(): Palette {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light'
  if (isLight) {
    return {
      isLight: true,
      bg: canvasSafeColor(css('--bg-app', '#f2f4f7'), '#f2f4f7'),
      edge: 'rgba(50, 60, 80, 0.55)',
      edgeTag: 'rgba(50, 60, 80, 0.28)',
      edgeHot: 'rgba(90, 70, 200, 0.95)',
      label: '#1a1f2a',
      labelBg: 'rgba(255,255,255,0.88)',
      nodeStroke: '#ffffff',
      colors: {
        knowledge: '#6b5bb5',
        project: '#2a8aab',
        task: '#c48420',
        daily: '#2f8f58',
        people: '#c45a35',
        template: '#8a5aa8',
        document: '#3a7aa8',
        sop: '#c0456a',
        other: '#5a6575',
        ghost: 'rgba(90,100,120,0.65)',
        tag: '#b8860b',
        attachment: '#3a8a5a'
      }
    }
  }
  // Dark — brighter nodes so they pop on near-black bg
  return {
    isLight: false,
    bg: canvasSafeColor(css('--bg-app', '#1e1e22'), '#1e1e22'),
    edge: 'rgba(200, 210, 230, 0.55)',
    edgeTag: 'rgba(160, 170, 190, 0.32)',
    edgeHot: 'rgba(190, 170, 255, 0.95)',
    label: 'rgba(240, 244, 255, 0.95)',
    labelBg: 'rgba(12, 14, 20, 0.72)',
    nodeStroke: 'rgba(255, 255, 255, 0.55)',
    colors: {
      knowledge: '#a694f0',
      project: '#5ec8e8',
      task: '#e8b04a',
      daily: '#5ed090',
      people: '#f09070',
      template: '#c090e0',
      document: '#7ab0e0',
      sop: '#e878a0',
      other: '#a0aab8',
      ghost: 'rgba(180,190,210,0.55)',
      tag: '#f0c85a',
      attachment: '#7ad0a0'
    }
  }
}



function radius(d: SimNode, scale = 1): number {
  return nodeRadius(d.degree, scale, false)
}

function nid(x: string | SimNode): string {
  return typeof x === 'object' ? x.id : x
}

/**
 * Apply Obsidian-like force settings onto a live d3 simulation.
 * - Link distance grows slightly with endpoint degree (cluster breathing)
 * - Charge scales with degree (hubs push neighbors away)
 * - Soft center + mild xy so graph stays readable without hard collapse
 */
function applyForces(
  sim: d3.Simulation<SimNode, undefined>,
  forces: GraphForceSettings,
  width: number,
  height: number,
  large: boolean,
  sizeMul = 1
): void {
  const link = sim.force('link') as d3.ForceLink<SimNode, SimLink> | null
  if (link) {
    link
      .distance((l) => {
        const s = l.source as SimNode
        const t = l.target as SimNode
        const sd = typeof s === 'object' && s ? s.degree || 0 : 0
        const td = typeof t === 'object' && t ? t.degree || 0 : 0
        return linkDistanceFor(sd, td, forces.linkDist)
      })
      .strength((l) => {
        // Tag edges weaker so they don't dominate layout
        const typ = (l as SimLink).type
        return typ === 'tag' ? forces.linkStr * 0.35 : forces.linkStr
      })
  }
  sim.force(
    'charge',
    d3
      .forceManyBody<SimNode>()
      .strength((d) => chargeFor(d.degree || 0, forces.charge, large))
      .distanceMax(large ? 220 : Math.max(280, forces.linkDist * 5))
      .theta(large ? 0.92 : 0.9)
  )
  sim.force('center', d3.forceCenter(width / 2, height / 2).strength(forces.center))
  // Soft gravity — lower than before so clusters can form away from dead-center
  const soft = Math.min(0.08, forces.center * 0.55)
  sim.force('x', d3.forceX(width / 2).strength(soft))
  sim.force('y', d3.forceY(height / 2).strength(soft))
  sim.force(
    'collide',
    d3
      .forceCollide<SimNode>()
      .radius((d) => radius(d) * sizeMul + (large ? 3 : 5))
      .strength(forces.collide)
      .iterations(large ? 1 : 2)
  )
}

export const GraphCanvas: React.FC = () => {
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
  /**
   * Primary display = React-owned SVG frame (state).
   * Imperative innerHTML was wiped by React re-renders AND failed for some user boot paths.
   * Throttled setState keeps ~20fps during sim; fine for ~100 nodes.
   */
  type SvgEdge = { key: string; x1: number; y1: number; x2: number; y2: number; stroke: string; sw: number; op: number }
  type SvgNode =
    | { key: string; kind: 'circle'; cx: number; cy: number; r: number; fill: string; stroke: string; sw: number; fillOp: number }
    | { key: string; kind: 'poly'; points: string; fill: string; stroke: string; sw: number; fillOp: number }
  type SvgLabel = { key: string; x: number; y: number; text: string; fill: string; bold: boolean }
  type SvgFrame = {
    w: number
    h: number
    edges: SvgEdge[]
    nodes: SvgNode[]
    labels: SvgLabel[]
    hud: string
  }
  const [svgFrame, setSvgFrame] = useState<SvgFrame | null>(null)
  const lastSvgPushRef = useRef(0)
  const svgRef = useRef<SVGSVGElement | null>(null) // for PNG export clone
  const emptySvgFramesRef = useRef(0)
  const lastAutoFitOffscreenAtRef = useRef(0)
  /** Only paint hidden canvas when exporting PNG */
  const exportCanvasPaintRef = useRef(false)
  const pathPulseFrameRef = useRef(0)
  const pushSvgFrame = useCallback((frame: SvgFrame, _force = false) => {
    // Always apply — throttling caused "Memuat graph…" forever when paint
    // coalesced and the only successful frame was dropped. 94 nodes is cheap.
    lastSvgPushRef.current = performance.now()
    setSvgFrame(frame)
  }, [])
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
  const saveLayoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveCameraTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const forcesRef = useRef<GraphForceSettings>({ ...DEFAULT_FORCE_SETTINGS })
  /** Phase 7: path edge pulse 0..1 */
  const pathPulseRef = useRef(0)
  const selectedIdsRef = useRef<Set<string>>(new Set())
  /** Phase 2–4 paint flags — read each frame */
  const viewFlagsRef = useRef({
    searchMatchIds: null as Set<string> | null,
    dimHubs: true,
    hubThreshold: 15,
    focusedId: null as string | null,
    pathNodeIds: null as Set<string> | null,
    pathEdgeKeys: null as Set<string> | null,
    pathFromId: '' as string,
    pathToId: '' as string,
    focusNodeIds: null as Set<string> | null,
    focusEdgeKeys: null as Set<string> | null,
    colorBy: 'type' as ColorByMode,
    perfMode: 'auto' as GraphPerfMode,
    selectedIds: null as Set<string> | null,
    /** Obsidian-like display knobs */
    arrows: false,
    textFade: 1,
    nodeSize: 1,
    lineThickness: 1,
    groupColors: null as Map<string, string> | null
  })

  const [selectedType, setSelectedType] = useState('all')
  const [selectedTag, setSelectedTag] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [showTagEdges, setShowTagEdges] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [showLegend, setShowLegend] = useState(false)
  const [orphanMode, setOrphanMode] = useState<OrphanMode>('all')
  const [hubMode, setHubMode] = useState<HubMode>('dim')
  const [hubThreshold, setHubThreshold] = useState(15)
  const [forces, setForces] = useState<GraphForceSettings>({ ...DEFAULT_FORCE_SETTINGS })
  const [colorBy, setColorBy] = useState<ColorByMode>('type')
  const [pathFromId, setPathFromId] = useState('')
  const [pathToId, setPathToId] = useState('')
  const [pathNodeIds, setPathNodeIds] = useState<Set<string> | null>(null)
  const [pathEdgeKeys, setPathEdgeKeys] = useState<Set<string> | null>(null)
  const [pathStatus, setPathStatus] = useState<string | null>(null)
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
  const fitViewRef = useRef<((animate: boolean) => void) | null>(null)
  /** ensureGraphVisible assigned later — paint HUD may call it when nodes off-screen */
  const ensureGraphVisibleRef = useRef<(reason?: string) => boolean>(() => false)

  /**
   * Size canvas like LocalGraphCanvas (proven visible on same machine).
   * Prefer wrap client box; fallback main-content / window. Never paint 0×0.
   */
  const syncCanvasSize = useCallback((): { w: number; h: number; ready: boolean } => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return { w: 0, h: 0, ready: false }

    // Same formula as LocalGraphCanvas — clientWidth first (not only getBoundingClientRect)
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

  /** Ease hoverStrengthRef toward 1 (hovering) / 0 (clear) — soft Obsidian feel */
  const kickHoverAnim = useCallback(() => {
    if (hoverAnimRafRef.current) return
    const step = () => {
      const target = hoverIdRef.current ? 1 : 0
      const cur = hoverStrengthRef.current
      // slightly snappier in, softer out
      const rate = target > cur ? 0.28 : 0.18
      const next = cur + (target - cur) * rate
      if (Math.abs(next - target) < 0.012) {
        hoverStrengthRef.current = target
        hoverAnimRafRef.current = 0
        requestPaint()
        return
      }
      hoverStrengthRef.current = next
      requestPaint()
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
      el.innerHTML = `<div class="gt-title">${escapeHtml(hit.title || '')}</div>
        <div class="gt-meta">${escapeHtml(hit.type || 'note')} · ${deg} link${deg !== 1 ? 's' : ''}</div>
        ${tags.length ? `<div class="gt-tags">${tags.map((t) => '#' + escapeHtml(String(t))).join(' ')}</div>` : ''}
        <div class="gt-hint">klik buka · Ctrl+klik select · Shift path · Alt focus</div>`
      tooltipNodeIdRef.current = hit.id
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
    })
    return () => {
      unsub()
      if (hoverAnimRafRef.current) cancelAnimationFrame(hoverAnimRafRef.current)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (saveLayoutTimer.current) clearTimeout(saveLayoutTimer.current)
      if (saveCameraTimer.current) clearTimeout(saveCameraTimer.current)
    }
  }, [fetchGraph, fetchGraphMeta])

  const scheduleSaveCamera = useCallback(() => {
    if (saveCameraTimer.current) clearTimeout(saveCameraTimer.current)
    saveCameraTimer.current = setTimeout(() => {
      const t = transformRef.current
      if (!t || !Number.isFinite(t.k)) return
      void saveGraphCamera({ x: t.x, y: t.y, k: t.k })
    }, 700)
  }, [saveGraphCamera])

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
          .filter((n) => n.x != null && n.y != null && Number.isFinite(n.x!) && Number.isFinite(n.y!))
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
      transformRef.current = d3.zoomIdentity.translate(cam.x, cam.y).scale(cam.k)
      if (markHydrated) cameraHydratedRef.current = true
      requestPaint()
      return true
    },
    [requestPaint]
  )

  // Restore vault camera only if it still shows layout nodes; else reject + force fit later
  useEffect(() => {
    if (cameraHydratedRef.current) return
    if (!layoutCamera) return
    hadSavedCameraRef.current = true
    const layoutPts = Object.values(layoutNodes || {})
      .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({ x: p.x, y: p.y }))
    const ok = cameraShowsPoints(layoutCamera, layoutPts)
    if (!ok) {
      cameraHydratedRef.current = true
      hasAutoFitRef.current = false
      const { inView, total, w, h } = countNodesInViewport(layoutCamera, layoutPts)
      const diag = diagnoseViewportBlank({
        inView,
        total: total || layoutPts.length,
        w,
        h,
        zoomK: layoutCamera.k,
        camX: layoutCamera.x,
        camY: layoutCamera.y,
        trigger: 'reject-saved-camera',
        hadSavedCamera: true
      })
      diag.title = 'Kamera vault ditolak (graph di luar layar)'
      diag.action =
        'Kamera graph-layout.json TIDAK dipakai. Auto-fit saat data siap. Tekan F / R jika masih blank.'
      setGraphDiag(diag)
      setLayoutStatus(formatGraphDiag(diag))
      // Wipe bad camera from vault (null) so next open does not restore it again
      void window.api?.saveGraphLayout?.({ camera: null, cameraOnly: true })
      return
    }
    if (applyCamera(layoutCamera, true)) {
      const t = transformRef.current
      const { inView, total, w, h } = countNodesInViewport(layoutCamera, layoutPts)
      const diag: GraphDiag = {
        code: 'CAM_RESTORED_OK',
        title: 'Kamera vault dipulihkan',
        cause: `graph-layout.json · x=${t.x.toFixed(0)} y=${t.y.toFixed(0)} k=${t.k.toFixed(2)} · cek layout ${inView}/${total || layoutPts.length} terlihat di ~${w}×${h}`,
        action: 'Lolos cek awal. Jika blank setelah load → auto-fit berulang · atau tekan F.',
        severity: 'info'
      }
      setGraphDiag(diag)
      setLayoutStatus(formatGraphDiag(diag))
    }
  }, [
    layoutCamera,
    layoutNodes,
    applyCamera,
    cameraShowsPoints,
    countNodesInViewport,
    saveGraphCamera
  ])

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
    const drainPending = () => {
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
        hubDegreeThreshold: 15,
        localDepth: 1,
        orphanMode: 'all' as const,
        hubMode: 'dim' as const
      }
      setShowLabels(gd.showLabels !== false)
      setShowTagEdges(Boolean(gd.showTagEdges))
      setShowLegend(Boolean(gd.showLegend))
      const thr = filters.hubDegreeThreshold
      setHubThreshold(typeof thr === 'number' && Number.isFinite(thr) ? thr : 15)
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
        lineThickness: gd.lineThickness ?? DEFAULT_DISPLAY_OPTS.lineThickness
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
    const apply = () => {
      paletteRef.current = readPalette()
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
          return safeTags(n).some(
            (t) => t.toLowerCase().includes(bare) || t.toLowerCase() === bare
          )
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

  // Obsidian-like color groups: node id → group color (first match wins)
  const groupColorById = useMemo(() => resolveGroupColors(nodes, colorGroups), [nodes, colorGroups])

  // Keep paint flags in sync
  viewFlagsRef.current = {
    searchMatchIds,
    dimHubs: hubMode === 'dim',
    hubThreshold,
    focusedId: focusedNodeId,
    pathNodeIds,
    pathEdgeKeys,
    pathFromId,
    pathToId,
    focusNodeIds,
    focusEdgeKeys,
    colorBy,
    perfMode,
    selectedIds: selectedIds.size > 0 ? selectedIds : null,
    arrows: displayOpts.arrows,
    textFade: displayOpts.textFade,
    nodeSize: displayOpts.nodeSize,
    lineThickness: displayOpts.lineThickness,
    groupColors: groupColorById
  }

  const nodeOptions = useMemo(
    () =>
      [...nodes]
        .map((n) => ({ id: n.id, title: n.title || n.relativePath }))
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })),
    [nodes]
  )

  const paint = useCallback(() => {
    try {
    // ── Size from STAGE (wrap) first — display must not depend on hidden canvas ──
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const sized = syncCanvasSize()
    let w = sized.ready ? sized.w : Math.floor(wrap?.clientWidth || 0)
    let h = sized.ready ? sized.h : Math.floor(wrap?.clientHeight || 0)
    if (w < 8 || h < 8) {
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
    const margin = lod === 'low' ? 24 : 48
    const inView = (x: number, y: number) => {
      const sx = x * t.k + t.x
      const sy = y * t.k + t.y
      return sx >= -margin && sx <= w + margin && sy >= -margin && sy <= h + margin
    }
    // Min node radius on screen (px) so zoom-out never makes graph "invisible furniture"
    const minScreenR = 5.5
    const kSafe = Math.max(t.k, 0.05)
    const minWorldR = minScreenR / kSafe

    const pathN = flags.pathNodeIds
    const pathE = flags.pathEdgeKeys
    const focN = flags.focusNodeIds
    const focE = flags.focusEdgeKeys
    const focusId = flags.focusedId
    const colorMode = flags.colorBy
    const matchIds = flags.searchMatchIds
    const thr = flags.hubThreshold
    const dimHubsOn = flags.dimHubs

    // ── 1) React SVG frame (what user sees) ──
    let drawn = 0
    try {
      if (simNodes.length === 0) {
        emptySvgFramesRef.current++
        // Keep last React frame during short rebuilds; only clear after many empty frames
        if (emptySvgFramesRef.current >= 12) {
          pushSvgFrame(
            {
              w: Math.max(1, w),
              h: Math.max(1, h),
              edges: [],
              nodes: [],
              labels: [],
              hud: 'sim:0 · kosong — cek filter / data vault'
            },
            true
          )
        }
      } else {
        emptySvgFramesRef.current = 0
        for (const n of simNodes) {
          if (n.x == null || n.y == null || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
          const sx = n.x * t.k + t.x
          const sy = n.y * t.k + t.y
          if (sx >= -40 && sx <= w + 40 && sy >= -40 && sy <= h + 40) drawn++
        }

        const byId = new Map(simNodes.map((n) => [n.id, n]))
        const end = (x: string | SimNode): SimNode | null => {
          if (x && typeof x === 'object' && 'id' in x) return x as SimNode
          if (typeof x === 'string') return byId.get(x) || null
          return null
        }

        const maxE = Math.min(simLinks.length, lod === 'low' ? 400 : lod === 'medium' ? 1200 : 4000)
        const edgesOut: SvgEdge[] = []
        let edgeList = simLinks
        if (simLinks.length > maxE) {
          edgeList = [...simLinks]
            .sort((a, b) => {
              const score = (e: SimLink) => {
                const s = end(e.source as string | SimNode)
                const tg = end(e.target as string | SimNode)
                if (!s?.id || !tg?.id) return 0
                const ek = edgeKey(s.id, tg.id)
                if (pathE != null && pathE.has(ek)) return 3
                if (focE != null && focE.has(ek)) return 2
                return 0
              }
              return score(b) - score(a)
            })
            .slice(0, maxE)
        }
        for (const e of edgeList) {
          const s = end(e.source as string | SimNode)
          const tg = end(e.target as string | SimNode)
          if (!s?.id || !tg?.id || s.x == null || s.y == null || tg.x == null || tg.y == null) continue
          if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(tg.x) || !Number.isFinite(tg.y))
            continue
          const ek = edgeKey(s.id, tg.id)
          const onPath = pathE != null && pathE.has(ek)
          const onFoc = focE != null && focE.has(ek)
          edgesOut.push({
            key: ek,
            x1: s.x * t.k + t.x,
            y1: s.y * t.k + t.y,
            x2: tg.x * t.k + t.x,
            y2: tg.y * t.k + t.y,
            stroke: onPath ? pal.edgeHot : e.type === 'tag' ? pal.edgeTag : pal.edge,
            sw: onPath ? 2.6 : onFoc ? 2 : e.type === 'tag' ? 1.1 : 1.5,
            op: onPath ? 0.95 : onFoc ? 0.85 : 0.72
          })
        }

        const nodesOut: SvgNode[] = []
        const labelsOut: SvgLabel[] = []
        const labelsOn = showLabelsRef.current
        const maxLabels = labelsOn ? (lod === 'low' ? 40 : lod === 'medium' ? 90 : 180) : 0
        let labCount = 0
        const sel = flags.selectedIds
        for (const n of simNodes) {
          if (n.x == null || n.y == null || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
          const sx = n.x * t.k + t.x
          const sy = n.y * t.k + t.y
          if (sx < -30 || sy < -30 || sx > w + 30 || sy > h + 30) continue
          const isTag = Boolean(n.isTag || n.type === 'tag')
          const isGhost = Boolean(n.isGhost || n.type === 'ghost')
          const isAtt = Boolean(n.isAttachment || n.type === 'attachment')
          const col = canvasSafeColor(
            isGhost
              ? pal.colors.ghost
              : isTag
                ? pal.colors.tag
                : isAtt
                  ? pal.colors.attachment
                  : flags.groupColors?.get(n.id) ||
                    (colorMode === 'folder'
                      ? folderColor(n.relativePath, pal.isLight)
                      : pal.colors[n.type] || pal.colors.other),
            '#a0aab8'
          )
          const deg = typeof n.degree === 'number' ? n.degree : 0
          const rPx =
            Math.max(6, Math.min(14, 5 + Math.sqrt(Math.max(0, deg)) * 1.35)) *
            (flags.nodeSize || 1)
          const isHover = n.id === hover
          const isSel = sel != null && sel.has(n.id)
          const onPath = pathN != null && pathN.has(n.id)
          const onFoc = focN != null && focN.has(n.id)
          let fillOp = isGhost ? 0.45 : 1
          if (pathN != null && !onPath && !isSel && !isHover) fillOp *= 0.28
          else if (pathN == null && focN != null && !onFoc && !isSel && !isHover) fillOp *= 0.32
          else if (
            pathN == null &&
            focN == null &&
            matchIds != null &&
            !matchIds.has(n.id) &&
            !isSel &&
            !isHover
          ) {
            fillOp *= 0.38
          }
          const isMatch = matchIds != null && matchIds.has(n.id)
          const stroke = isHover || isSel || onPath || isMatch ? pal.edgeHot : pal.nodeStroke
          const sw = isSel || onPath ? 2.8 : isHover ? 2.5 : 1.4
          if (isTag) {
            const d = rPx * 1.1
            nodesOut.push({
              key: n.id,
              kind: 'poly',
              points: `${sx},${sy - d} ${sx + d},${sy} ${sx},${sy + d} ${sx - d},${sy}`,
              fill: col,
              stroke,
              sw,
              fillOp
            })
          } else {
            nodesOut.push({
              key: n.id,
              kind: 'circle',
              cx: sx,
              cy: sy,
              r: rPx,
              fill: col,
              stroke,
              sw,
              fillOp
            })
          }
          if (isSel) {
            nodesOut.push({
              key: n.id + ':sel',
              kind: 'circle',
              cx: sx,
              cy: sy,
              r: rPx + 4,
              fill: 'none',
              stroke: pal.edgeHot,
              sw: 1.6,
              fillOp: 0.85
            })
          }
          const forceLab = isHover || isSel || onPath || onFoc || n.id === focusId
          if (labelsOn && labCount < maxLabels && (forceLab || deg >= 1 || simNodes.length <= 80)) {
            const titleStr = String(n.title || n.relativePath || n.id || '')
            const text = titleStr.length > 26 ? titleStr.slice(0, 25) + '…' : titleStr
            labelsOut.push({
              key: n.id,
              x: sx + rPx + 5,
              y: sy + 4,
              text,
              fill: forceLab ? pal.edgeHot : pal.label,
              bold: Boolean(forceLab)
            })
            labCount++
          }
        }

        if (nodesOut.length === 0 && simNodes.length > 0) {
          nodesOut.push({
            key: '__offscreen',
            kind: 'circle',
            cx: w / 2,
            cy: h / 2,
            r: 10,
            fill: '#a694f0',
            stroke: '#fff',
            sw: 2,
            fillOp: 1
          })
          labelsOut.push({
            key: '__offscreen-lab',
            x: w / 2 + 14,
            y: h / 2 + 4,
            text: `${simNodes.length} node di luar layar — tekan F`,
            fill: '#f0c060',
            bold: true
          })
        }

        const hud = `sim:${simNodes.length} · layar:${drawn} · ${w}×${h} · k:${t.k.toFixed(2)} · SVG`
        pushSvgFrame(
          {
            w: Math.max(1, w),
            h: Math.max(1, h),
            edges: edgesOut,
            nodes: nodesOut,
            labels: labelsOut,
            hud
          },
          drawn === 0 || nodesOut.length > 0
        )
      }
    } catch (svgErr) {
      console.error('[GraphCanvas] SVG frame failed:', svgErr)
      pushSvgFrame(
        {
          w: Math.max(1, w),
          h: Math.max(1, h),
          edges: [],
          nodes: [],
          labels: [],
          hud: `SVG error · sim:${simNodes.length}`
        },
        true
      )
    }

    // Off-screen auto-fit (throttled — was thrashing and blanking the view)
    if (simNodes.length > 0 && drawn === 0) {
      const now = Date.now()
      if (now - lastAutoFitOffscreenAtRef.current > 600) {
        lastAutoFitOffscreenAtRef.current = now
        requestAnimationFrame(() => {
          try {
            transformRef.current = d3.zoomIdentity
            fitViewRef.current?.(false)
            hasAutoFitRef.current = true
            ensureGraphVisibleRef.current('paint-offscreen')
          } catch {
            /* ignore */
          }
        })
      }
    }

    // First-fit once nodes exist (does not depend on canvas buffer)
    if (
      simNodes.length > 0 &&
      !hasAutoFitRef.current &&
      !cameraHydratedRef.current &&
      simNodes.some((n) => n.x != null && n.y != null)
    ) {
      requestAnimationFrame(() => {
        try {
          if (hasAutoFitRef.current || cameraHydratedRef.current) return
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
    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    try {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = pal.bg || '#1e1e22'
    ctx.fillRect(0, 0, w, h)

    ctx.save()
    ctx.translate(t.x, t.y)
    ctx.scale(t.k, t.k)

    // Neighbor set for hover dimming (only when strength > 0)
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

    const sel = flags.selectedIds
    const pulse = pathPulseRef.current

    // Edges (budgeted on large graphs — prioritize path/focus/hover so they never drop)
    ctx.lineCap = 'round'
    const lineMul = flags.lineThickness || 1
    const sizeMul = flags.nodeSize || 1
    const drawArrows = flags.arrows && t.k >= 0.4 && lod === 'full'
    const maxEdges = edgeDrawBudget(lod, simLinks.length)
    const edgePriority = (e: SimLink): number => {
      const s = e.source as SimNode
      const tg = e.target as SimNode
      if (!s?.id || !tg?.id) return 0
      const ek = edgeKey(s.id, tg.id)
      if (pathE != null && pathE.has(ek)) return 3
      if (focE != null && focE.has(ek)) return 2
      if (hot && (s.id === hover || tg.id === hover)) return 2
      if (sel && (sel.has(s.id) || sel.has(tg.id))) return 1
      return 0
    }
    const edgesToDraw =
      simLinks.length <= maxEdges
        ? simLinks
        : [...simLinks].sort((a, b) => edgePriority(b) - edgePriority(a)).slice(0, maxEdges)
    for (const e of edgesToDraw) {
      const s = e.source as SimNode
      const tg = e.target as SimNode
      if (s.x == null || s.y == null || tg.x == null || tg.y == null) continue
      // Phase 5 frustum: skip edges fully outside viewport (never skip path/focus)
      const ekEarly = edgeKey(s.id, tg.id)
      const forceEdge =
        (pathE != null && pathE.has(ekEarly)) || (focE != null && focE.has(ekEarly))
      if (!forceEdge && !inView(s.x, s.y) && !inView(tg.x, tg.y)) continue
      const ek = ekEarly
      const onPath = pathE != null && pathE.has(ek)
      const onFocus = focE != null && focE.has(ek)
      const isHot = hot
        ? hot.has(s.id) && hot.has(tg.id) && (s.id === hover || tg.id === hover)
        : false
      const dimHover = Boolean(hot && !isHot && pathN == null && focN == null)
      const dimPath = pathN != null && !onPath
      const dimFocus = pathN == null && focN != null && !onFocus
      // Spotlight mode only dims; filter mode already removed non-matches
      const dimSearch =
        pathN == null &&
        focN == null &&
        matchIds != null &&
        !matchIds.has(s.id) &&
        !matchIds.has(tg.id)
      // Soft edge dim: lerp toward muted alpha (never hard-cut)
      const pathAlpha = onPath ? 0.9 + pulse * 0.08 : 1
      let edgeAlpha = 1
      if (dimHover) edgeAlpha = lerp(1, 0.38, hs)
      else if (dimPath) edgeAlpha = 0.28
      else if (dimFocus) edgeAlpha = 0.32
      else if (dimSearch) edgeAlpha = 0.32
      else if (onPath) edgeAlpha = pathAlpha
      // Hot edges: slight thickness only (color stays mostly neutral to avoid flash)
      const edgeW =
        (onPath
          ? 2.2 + pulse * 0.3
          : isHot
            ? lerp(1.4, 1.85, hs)
            : e.type === 'wiki_link'
              ? 1.55
              : 1.1) * lineMul
      const baseEdge = e.type === 'tag' ? pal.edgeTag : pal.edge
      const edgeColor = onPath ? pal.edgeHot : isHot && hs > 0.4 ? pal.edgeHot : baseEdge
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(tg.x, tg.y)
      ctx.strokeStyle = canvasSafeColor(edgeColor, 'rgba(200,210,230,0.55)')
      // Keep edges more visible on dark bg (was too faint → only "felt" via hit-test)
      ctx.globalAlpha = Math.max(0.35, edgeAlpha)
      ctx.lineWidth = Math.max(edgeW / t.k, 1.1 / t.k)
      if (e.type === 'tag' && !onPath) ctx.setLineDash([3 / t.k, 4 / t.k])
      else ctx.setLineDash([])
      ctx.stroke()
      // Obsidian-like direction arrows on wikilink edges (source → target)
      if (drawArrows && e.type !== 'tag' && edgeAlpha > 0.15) {
        const dx = tg.x - s.x
        const dy = tg.y - s.y
        const len = Math.hypot(dx, dy)
        if (len > 8) {
          const tgHub = dimHubsOn && tg.degree >= thr ? 0.62 : 1
          const tgR = radius(tg, tgHub) * sizeMul
          const ux = dx / len
          const uy = dy / len
          const ax = tg.x - ux * (tgR + 2 + edgeW * 0.5)
          const ay = tg.y - uy * (tgR + 2 + edgeW * 0.5)
          const aw = (2.6 + edgeW * 1.9) / t.k
          const ah = aw * 1.7
          const px = -uy
          const py = ux
          ctx.beginPath()
          ctx.moveTo(ax + ux * ah, ay + uy * ah)
          ctx.lineTo(ax + px * aw, ay + py * aw)
          ctx.lineTo(ax - px * aw, ay - py * aw)
          ctx.closePath()
          ctx.fillStyle = edgeColor
          ctx.fill()
        }
      }
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    // Nodes — no size pop on hover (that was a major blink source)
    for (const n of simNodes) {
      if (n.x == null || n.y == null) continue
      const onPath = pathN != null && pathN.has(n.id)
      const onFoc = focN != null && focN.has(n.id)
      const isSelected = sel != null && sel.has(n.id)
      // Phase 5 frustum cull (keep path/focus/hover/selection always)
      if (
        !onPath &&
        !onFoc &&
        !isSelected &&
        n.id !== hover &&
        n.id !== focusId &&
        !inView(n.x, n.y)
      ) {
        continue
      }
      const isGhost = Boolean(n.isGhost || n.type === 'ghost')
      const isTag = Boolean(n.isTag || n.type === 'tag')
      const isAttachment = Boolean(n.isAttachment || n.type === 'attachment')
      const isHub = !isGhost && !isTag && n.degree >= thr
      const hubScale = dimHubsOn && isHub ? 0.62 : 1
      const rBase =
        (isGhost
          ? Math.max(3, radius(n, 0.85))
          : isTag
            ? Math.max(3.5, radius(n, 0.9))
            : isAttachment
              ? Math.max(3.5, radius(n, 0.88))
              : radius(n, hubScale)) * sizeMul
      // Never smaller than ~5.5px on screen — fixes "nabrak di gelap" when zoomed out
      const r = Math.max(rBase, minWorldR)
      const colRaw = isGhost
        ? pal.colors.ghost
        : isTag
          ? pal.colors.tag
          : isAttachment
            ? pal.colors.attachment
            : flags.groupColors?.get(n.id) ||
              (colorMode === 'folder'
                ? folderColor(n.relativePath, pal.isLight)
                : pal.colors[n.type] || pal.colors.other)
      const col = canvasSafeColor(colRaw, pal.colors.other)
      const dimHover =
        Boolean(hot && !hot.has(n.id) && pathN == null && focN == null && !isSelected)
      const dimPath = pathN != null && !onPath && !isSelected
      const dimFocus = pathN == null && focN != null && !onFoc && !isSelected
      const dimSearch =
        pathN == null && focN == null && matchIds != null && !matchIds.has(n.id) && !isSelected
      const isFocus = focusId === n.id
      const isMatch = matchIds != null && matchIds.has(n.id)
      const isEndpoint =
        onPath && (n.id === flags.pathFromId || n.id === flags.pathToId || n.id === flags.focusedId)
      const isHoverNode = n.id === hover && hs > 0.05

      // Dim less aggressively — dark theme made dimmed nodes vanish into bg
      let alpha = isGhost ? 0.9 : 1
      if (dimHover) alpha = lerp(1, pal.isLight ? 0.5 : 0.55, hs)
      else if (dimPath) alpha = pal.isLight ? 0.4 : 0.42
      else if (dimFocus) alpha = pal.isLight ? 0.42 : 0.45
      else if (dimSearch) alpha = pal.isLight ? 0.45 : 0.48
      else if (dimHubsOn && isHub && !isMatch && !isFocus && !onPath && !onFoc && !isSelected)
        alpha = 0.72
      if (onPath) alpha = Math.min(1, alpha + pulse * 0.05)
      ctx.globalAlpha = alpha

      // Soft glow: path/selection only (not full-graph flash on every hover)
      if (
        lod === 'full' &&
        !isGhost &&
        (onPath || isSelected || isMatch || isHoverNode) &&
        !dimHover &&
        !dimPath &&
        !dimFocus
      ) {
        ctx.beginPath()
        ctx.arc(n.x, n.y, r + (onPath || isSelected ? 4.5 : 2.5), 0, Math.PI * 2)
        ctx.fillStyle = onPath || isMatch || isSelected ? pal.edgeHot : col
        const glowA = isHoverNode && !onPath && !isSelected ? 0.08 * hs : pal.isLight ? 0.16 : 0.11
        ctx.globalAlpha = glowA * alpha
        ctx.fill()
        ctx.globalAlpha = alpha
      }

      ctx.beginPath()
      if (isTag) {
        // Diamond for #tag (distinct from notes)
        const d = r * 1.15
        ctx.moveTo(n.x, n.y - d)
        ctx.lineTo(n.x + d, n.y)
        ctx.lineTo(n.x, n.y + d)
        ctx.lineTo(n.x - d, n.y)
        ctx.closePath()
        ctx.fillStyle = col
        ctx.fill()
      } else if (isAttachment) {
        // Rounded square for attachments
        const s = r * 0.95
        const rr = s * 0.35
        const x0 = n.x - s
        const y0 = n.y - s
        ctx.moveTo(x0 + rr, y0)
        ctx.arcTo(x0 + s * 2, y0, x0 + s * 2, y0 + s * 2, rr)
        ctx.arcTo(x0 + s * 2, y0 + s * 2, x0, y0 + s * 2, rr)
        ctx.arcTo(x0, y0 + s * 2, x0, y0, rr)
        ctx.arcTo(x0, y0, x0 + s * 2, y0, rr)
        ctx.closePath()
        ctx.fillStyle = col
        ctx.fill()
      } else {
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        if (isGhost) {
          // Obsidian-like hollow ghost for unresolved targets
          ctx.fillStyle = pal.isLight ? 'rgba(255,255,255,0.35)' : 'rgba(20,22,28,0.35)'
          ctx.fill()
          ctx.strokeStyle = col
          ctx.lineWidth = 1.6 / t.k
          ctx.setLineDash([2.5 / t.k, 2 / t.k])
          ctx.stroke()
          ctx.setLineDash([])
        } else {
          ctx.fillStyle = col
          ctx.fill()
        }
      }
      const isPinned = Boolean(n.pinned || (n.fx != null && n.fy != null))
      const strokeW =
        isSelected || isEndpoint || isFocus
          ? 2.8
          : onPath || isMatch
            ? 2.2
            : isPinned
              ? 2
              : isHoverNode
                ? lerp(1, 1.7, hs)
                : 1
      if (!isGhost) {
        ctx.lineWidth = strokeW / t.k
        ctx.strokeStyle =
          isSelected || onPath || isFocus || isMatch || isEndpoint
            ? pal.edgeHot
            : isPinned
              ? pal.edgeHot
              : isHoverNode && hs > 0.5
                ? pal.edgeHot
                : pal.nodeStroke
        ctx.stroke()
      }
      // Phase 7: selection ring (solid)
      if (isSelected) {
        ctx.beginPath()
        ctx.arc(n.x, n.y, r + 4.5, 0, Math.PI * 2)
        ctx.strokeStyle = pal.edgeHot
        ctx.globalAlpha = 0.85 * alpha
        ctx.lineWidth = 1.8 / t.k
        ctx.setLineDash([])
        ctx.stroke()
        ctx.globalAlpha = alpha
      }
      // Phase 3: pinned ring (skip on low LOD unless hover)
      if (isPinned && !dimHover && !dimPath && (lod !== 'low' || n.id === hover)) {
        ctx.beginPath()
        ctx.arc(n.x, n.y, r + 3.2, 0, Math.PI * 2)
        ctx.strokeStyle = pal.edgeHot
        ctx.globalAlpha = 0.55 * alpha
        ctx.lineWidth = 1.2 / t.k
        ctx.setLineDash([2.5 / t.k, 2 / t.k])
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = alpha
      }
    }
    ctx.globalAlpha = 1
    ctx.restore()

    // ── Labels in SCREEN space (Obsidian: zoom out → fade; font size stays readable) ──
    const labelsOn = showLabelsRef.current
    if (labelsOn) {
      ctx.save()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Fixed screen font — doesn't fight canvas zoom scale
      const fontPx = lod === 'low' ? 10 : 11
      ctx.font = `${fontPx}px Inter,"Segoe UI Variable","Segoe UI",system-ui,sans-serif`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      const maxLabels = labelDrawBudget(lod)
      let labelsDrawn = 0

      for (const n of simNodes) {
        if (labelsDrawn >= maxLabels) break
        if (n.x == null || n.y == null) continue
        const onPath = pathN != null && pathN.has(n.id)
        const onFoc = focN != null && focN.has(n.id)
        const isSel = sel != null && sel.has(n.id)
        if (!onPath && !onFoc && n.id !== hover && !isSel && !inView(n.x, n.y)) continue

        // Per-node zoom fade (high degree stays longer when zoomed out)
        let zA = labelZoomAlpha(t.k, flags.textFade, n.degree)
        // Always keep hover / path / focus / match labels visible if zoom allows a bit
        const forceLabel =
          n.id === hover ||
          onPath ||
          onFoc ||
          isSel ||
          n.id === focusId ||
          (matchIds != null && matchIds.has(n.id))
        if (forceLabel) zA = Math.max(zA, smooth01(Math.min(1, t.k / 0.35)) * 0.95)
        if (zA < 0.03) continue

        // LOD thinning — but never hard-drop non-neighbors on hover (that was the blink)
        if (lod === 'low' && !forceLabel && n.degree < 3) continue
        if (lod === 'medium' && !forceLabel && n.degree < 2) continue
        if (large && lod === 'full' && !forceLabel && n.degree < 2) continue
        labelsDrawn++

        // Soft dim labels outside spotlight (path / focus / search / hover)
        let spotMul = 1
        if (pathN != null && !onPath && !forceLabel) spotMul = 0.22
        else if (pathN == null && focN != null && !onFoc && !forceLabel) spotMul = 0.25
        else if (
          pathN == null &&
          focN == null &&
          matchIds != null &&
          !matchIds.has(n.id) &&
          !forceLabel
        )
          spotMul = 0.28
        else if (hot && !hot.has(n.id) && pathN == null && focN == null)
          spotMul = lerp(1, 0.28, hs) // dim non-neighbors, don't remove

        const isHub = n.degree >= thr
        const rWorld = radius(n, dimHubsOn && isHub ? 0.62 : 1) * sizeMul
        const sx = n.x * t.k + t.x + rWorld * t.k + 6
        const sy = n.y * t.k + t.y
        if (sx > w + 40 || sy < -20 || sy > h + 20) continue

        const titleStr = String(n.title || n.relativePath || n.id || '')
        const text = titleStr.length > 28 ? titleStr.slice(0, 27) + '…' : titleStr
        const labelAlpha = zA * spotMul * (forceLabel ? 1 : 0.88)

        if (pal.isLight && labelAlpha > 0.25) {
          const tw = ctx.measureText(text).width
          ctx.fillStyle = pal.labelBg
          ctx.globalAlpha = labelAlpha * 0.85
          ctx.fillRect(sx - 2, sy - 7, tw + 4, 14)
        }
        ctx.fillStyle = pal.label
        ctx.globalAlpha = labelAlpha
        ctx.fillText(text, sx, sy)
      }
      ctx.globalAlpha = 1
      ctx.restore()
    }
    } catch (canvasErr) {
      // Export buffer only — never blank the SVG display path
      console.error('[GraphCanvas] export-canvas paint failed:', canvasErr)
    }

    dirtyRef.current = false
    } catch (err) {
      console.error('[GraphCanvas] paint failed:', err)
      dirtyRef.current = true
    }
  }, [pushSvgFrame])

  paintFnRef.current = paint

  const schedulePaint = useCallback(() => {
    requestPaint()
  }, [requestPaint])

  /**
   * User-open path (npm run dev): force seed + fit when Graph View opens.
   * Automations often wait longer; humans click immediately while layout is 0×0.
   */
  useEffect(() => {
    if (activeView !== 'graph') return

    hasAutoFitRef.current = false
    cameraHydratedRef.current = true // skip re-applying stale vault camera this session enter
    emptySvgFramesRef.current = 0
    transformRef.current = d3.zoomIdentity

    void fetchGraph().finally(() => {
      setGraphLoaded(true)
      schedulePaint()
    })

    const kick = (why: string) => {
      syncCanvasSize()
      if (nodesRef.current.length === 0 && filteredNodes.length > 0) {
        const wrap = wrapRef.current
        const w = Math.max(wrap?.clientWidth || 0, 400)
        const h = Math.max(wrap?.clientHeight || 0, 300)
        nodesRef.current = filteredNodes.map((n, i) => {
          const layout = layoutNodes[n.id]
          const c = posCache.current.get(n.id)
          const col = i % 12
          const row = Math.floor(i / 12)
          return {
            ...n,
            title: n.title || n.relativePath || n.id,
            tags: safeTags(n),
            degree: typeof n.degree === 'number' ? n.degree : 0,
            x: c?.x ?? layout?.x ?? w * 0.2 + col * 48,
            y: c?.y ?? layout?.y ?? h * 0.2 + row * 40,
            fx: layout?.pinned ? layout.x : null,
            fy: layout?.pinned ? layout.y : null,
            pinned: Boolean(layout?.pinned)
          }
        })
        const idSet = new Set(nodesRef.current.map((n) => n.id))
        linksRef.current = filteredEdges
          .filter((e) => idSet.has(e.source) && idSet.has(e.target))
          .map((e) => ({
            id: e.id,
            type: e.type || 'wiki_link',
            weight: e.weight || 1,
            source: e.source,
            target: e.target
          }))
        setStats({
          nodes: nodesRef.current.length,
          edges: linksRef.current.length
        })
      }
      // Sync paint now (don't only rely on rAF — user open races were dropping frames)
      try {
        paintFnRef.current()
      } catch (e) {
        console.error('[GraphCanvas] kick paint', why, e)
      }
      schedulePaint()
      if (nodesRef.current.length > 0) {
        requestAnimationFrame(() => {
          try {
            transformRef.current = d3.zoomIdentity
            fitViewRef.current?.(false)
            hasAutoFitRef.current = true
            ensureGraphVisibleRef.current(why)
            paintFnRef.current()
            schedulePaint()
          } catch {
            /* ignore */
          }
        })
      }
    }

    kick('graph-enter')
    const delays = [100, 300, 600, 1200, 2200]
    const timers = delays.map((ms) => setTimeout(() => kick(`graph-enter-${ms}`), ms))

    let ro: ResizeObserver | null = null
    const wrap = wrapRef.current
    if (wrap && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => kick('resize'))
      ro.observe(wrap)
    }

    const watchdog = window.setInterval(() => {
      const hasStore = filteredNodes.length > 0
      // Read latest frame via DOM (React SVG)
      const hasSvgNodes = Boolean(
        document.querySelector('.graph-svg g.g-nodes circle, .graph-svg g.g-nodes polygon')
      )
      if (hasStore && !hasSvgNodes) kick('watchdog')
    }, 500)

    return () => {
      for (const t of timers) clearTimeout(t)
      ro?.disconnect()
      clearInterval(watchdog)
    }
  }, [
    activeView,
    fetchGraph,
    schedulePaint,
    syncCanvasSize,
    filteredNodes.length,
    filteredEdges.length
    // layoutNodes read live from closure in kick — avoid re-bind storms
  ])

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

  // Phase 7: gentle path pulse — throttle SVG rebuilds (was 60fps full innerHTML)
  useEffect(() => {
    if (!pathNodeIds || pathNodeIds.size === 0) {
      pathPulseRef.current = 0
      pathPulseFrameRef.current = 0
      return
    }
    let raf = 0
    let alive = true
    const loop = (t: number) => {
      if (!alive) return
      pathPulseRef.current = (Math.sin(t / 520) + 1) / 2
      pathPulseFrameRef.current++
      // ~20fps is enough for soft pulse; full SVG rewrite every frame caused lag/flicker
      if (pathPulseFrameRef.current % 3 === 0) schedulePaint()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      pathPulseRef.current = 0
      pathPulseFrameRef.current = 0
    }
  }, [pathNodeIds, schedulePaint])

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

    // Rebuild spatial index when sim moved nodes
    if (spatialDirtyRef.current || all.length > 80) {
      if (spatialDirtyRef.current) {
        spatialRef.current.rebuild(all)
        spatialDirtyRef.current = false
      }
    }
    const candidates =
      all.length > 80 ? spatialRef.current.query(x, y, 36 * sizeMul) : all

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
      const hubScale = !isGhost && dimHubsOn && n.degree >= thr ? 0.62 : 1
      const baseR = radius(n, hubScale) * sizeMul
      // Enter: modest pad; stay on sticky: larger pad
      const pad = n.id === stickyId ? 14 : 6
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
        const hubScale = dimHubsOn && sn.degree >= thr ? 0.62 : 1
        const r = radius(sn, hubScale) * sizeMul + 14
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
          if (!hasAutoFitRef.current) {
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
      setStats({ nodes: 0, edges: 0 })
      hasAutoFitRef.current = false
      schedulePaint()
      return () => {
        if (sizeRetry) clearTimeout(sizeRetry)
      }
    }

    try {
      const f0 = forcesRef.current
      const prevById = new Map(nodesRef.current.map((n) => [n.id, n]))
      const prevCount = nodesRef.current.length

      const simNodes: SimNode[] = filteredNodes.map((n) => {
        const prev = prevById.get(n.id)
        const c = posCache.current.get(n.id)
        const layout = layoutNodes[n.id]
        // Prefer live sim → cache → vault layout → mild random near center
        const x =
          prev?.x ??
          c?.x ??
          layout?.x ??
          width / 2 + (Math.random() - 0.5) * Math.min(120, 40 + filteredNodes.length)
        const y =
          prev?.y ??
          c?.y ??
          layout?.y ??
          height / 2 + (Math.random() - 0.5) * Math.min(120, 40 + filteredNodes.length)
        const pinned =
          prev?.fx != null || c?.fx != null || Boolean(layout?.pinned) || Boolean(prev?.pinned)
        const fx = pinned ? (prev?.fx ?? c?.fx ?? layout?.x ?? x) : null
        const fy = pinned ? (prev?.fy ?? c?.fy ?? layout?.y ?? y) : null
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
          vy: prev?.vy
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
      setStats({ nodes: simNodes.length, edges: simLinks.length })
      setPinnedCount(simNodes.filter((n) => n.pinned || n.fx != null).length)

      const n = simNodes.length
      const large = n > 80
      // Soft merge if we already had a sim and overlap is significant
      const overlap = simNodes.filter((s) => prevById.has(s.id)).length
      const canSoft =
        simRef.current != null &&
        prevCount > 0 &&
        overlap >= Math.min(prevCount, n) * 0.4

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
          // Slightly higher decay = settles smoother (alive but stable)
          .velocityDecay(large ? 0.48 : 0.4)
          .alphaDecay(large ? 0.06 : 0.042)
          .alphaMin(0.02)
          .alpha(large ? 0.45 : 0.58)

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
        if (tick % 4 === 0) spatialDirtyRef.current = true
        if (tick % paintEvery === 0 || activeSim.alpha() < 0.05) schedulePaint()
        if (tick % 12 === 0) {
          for (const node of nodesRef.current) {
            if (node.x != null && node.y != null) {
              posCache.current.set(node.id, {
                x: node.x,
                y: node.y,
                fx: node.fx,
                fy: node.fy
              })
            }
          }
        }
      })
      activeSim.on('end', () => {
        for (const node of nodesRef.current) {
          if (node.x != null && node.y != null) {
            posCache.current.set(node.id, {
              x: node.x,
              y: node.y,
              fx: node.fx,
              fy: node.fy
            })
          }
        }
        // Fit only if never fitted; always re-check viewport (stale camera → blank)
        if (!hasAutoFitRef.current) {
          hasAutoFitRef.current = true
          fitView(false)
        }
        requestAnimationFrame(() => {
          ensureGraphVisibleRef.current('sim-end')
        })
        // Obsidian-like continuous gentle motion
        if (animateForcesRef.current) {
          activeSim.alphaTarget(0.018).restart()
        }
        schedulePaint()
      })

      schedulePaint()
      // Early check once nodes have initial positions
      requestAnimationFrame(() => {
        setTimeout(() => ensureGraphVisibleRef.current('sim-start'), 60)
      })

      return () => {
        if (sizeRetry) clearTimeout(sizeRetry)
        // Do NOT stop sim on soft re-run — next effect call owns it.
        // Only stop on unmount (detected via cleanup when deps change to empty later).
      }
    } catch (err) {
      console.error('[GraphCanvas] simulation build failed:', err)
      nodesRef.current = []
      linksRef.current = []
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
    (animate: boolean, onlyIds?: Set<string> | null) => {
      const wrap = wrapRef.current
      let simNodes = nodesRef.current
      if (onlyIds && onlyIds.size > 0) {
        simNodes = simNodes.filter((n) => onlyIds.has(n.id))
      }
      if (!wrap || simNodes.length === 0) return
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
        (n) => typeof n.x === 'number' && typeof n.y === 'number' && Number.isFinite(n.x) && Number.isFinite(n.y)
      )
      if (simNodes.length === 0) return
      const xs = simNodes.map((n) => n.x as number)
      const ys = simNodes.map((n) => n.y as number)
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)
      const gw = Math.max(maxX - minX, 40)
      const gh = Math.max(maxY - minY, 40)
      const pad = 48
      const k = Math.min((width - pad * 2) / gw, (height - pad * 2) / gh, 2.2)
      const tx = (width - k * (minX + maxX)) / 2
      const ty = (height - k * (minY + maxY)) / 2
      const target = d3.zoomIdentity.translate(tx, ty).scale(k)
      const done = () => {
        hasAutoFitRef.current = true
        scheduleSaveCamera()
      }
      if (!animate) {
        transformRef.current = target
        schedulePaint()
        done()
        return
      }
      // simple lerp frames
      const from = transformRef.current
      const steps = 12
      let i = 0
      const step = () => {
        i++
        const u = i / steps
        const e = 1 - Math.pow(1 - u, 3)
        transformRef.current = d3.zoomIdentity
          .translate(from.x + (target.x - from.x) * e, from.y + (target.y - from.y) * e)
          .scale(from.k + (target.k - from.k) * e)
        schedulePaint()
        if (i < steps) requestAnimationFrame(step)
        else done()
      }
      requestAnimationFrame(step)
    },
    [schedulePaint, syncCanvasSize, scheduleSaveCamera]
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
        // Keep trying — Windows flex often 0 for a few frames
        return false
      }
      if (total === 0) {
        // Sim not ready yet — caller must retry; report only on late attempts
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
      hasAutoFitRef.current = false
      cameraHydratedRef.current = true
      // Identity first so fitView doesn't lerp from a broken extreme
      transformRef.current = d3.zoomIdentity
      fitView(false)
      hasAutoFitRef.current = true
      setGraphDiag(diag)
      setLayoutStatus(formatGraphDiag(diag))
      scheduleSaveCamera()
      hadSavedCameraRef.current = false
      // Second pass after fit
      requestAnimationFrame(() => schedulePaint())
      return false
    },
    [countNodesInViewport, fitView, scheduleSaveCamera, schedulePaint]
  )
  ensureGraphVisibleRef.current = ensureGraphVisible

  // Aggressive multi-retry: blank often happens because first checks run before sim positions exist
  useEffect(() => {
    if (filteredNodes.length === 0) return
    const delays = [50, 120, 250, 450, 800, 1400, 2200, 3500]
    const timers = delays.map((ms, i) =>
      setTimeout(() => {
        const ok = ensureGraphVisibleRef.current(
          i >= delays.length - 3 ? `post-data-late-${ms}` : `post-data-${ms}`
        )
        // If still not visible on late retries, hard reset camera + fit
        if (!ok && i >= delays.length - 3) {
          transformRef.current = d3.zoomIdentity
          hasAutoFitRef.current = false
          fitViewRef.current?.(false)
          hasAutoFitRef.current = true
          schedulePaint()
        }
      }, ms)
    )
    return () => {
      for (const t of timers) clearTimeout(t)
    }
  }, [filteredNodes.length, layoutCamera, schedulePaint])

  // Every time user opens Graph View: force visibility pass (don't rely on stale camera)
  useEffect(() => {
    if (activeView !== 'graph') return
    const timers = [100, 400, 1000, 2000].map((ms) =>
      setTimeout(() => {
        syncCanvasSize()
        if (nodesRef.current.length === 0) return
        const { inView, total } = countNodesInViewport()
        if (total > 0 && inView < Math.max(1, Math.floor(total * 0.05))) {
          transformRef.current = d3.zoomIdentity
          fitViewRef.current?.(false)
          hasAutoFitRef.current = true
          ensureGraphVisibleRef.current(`view-enter-${ms}`)
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
      const nextK = Math.max(0.08, Math.min(6, t.k * factor))
      const x = cx - ((cx - t.x) * nextK) / t.k
      const y = cy - ((cy - t.y) * nextK) / t.k
      transformRef.current = d3.zoomIdentity.translate(x, y).scale(nextK)
      schedulePaint()
      scheduleSaveCamera()
    },
    [schedulePaint, syncCanvasSize, scheduleSaveCamera]
  )

  // Pointer on STAGE (wrap), not canvas — canvas may be hidden (GPU black);
  // hit-test is pure math on nodesRef, same as local graph interaction model.
  useEffect(() => {
    const wrap = wrapRef.current
    const target = wrap
    if (!target) return

    let panning = false
    let panLast = { x: 0, y: 0 }
    let dragged: SimNode | null = null
    let moved = false

    const viewRect = () => wrap!.getBoundingClientRect()

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = viewRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const t = transformRef.current
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      const nextK = Math.max(0.08, Math.min(6, t.k * factor))
      const x = mx - ((mx - t.x) * nextK) / t.k
      const y = my - ((my - t.y) * nextK) / t.k
      transformRef.current = d3.zoomIdentity.translate(x, y).scale(nextK)
      schedulePaint()
      scheduleSaveCamera()
    }

    const onDown = (e: PointerEvent) => {
      moved = false
      const hit = hitNode(e.clientX, e.clientY)

      // Phase 7: Ctrl/Cmd+click = multi-select toggle
      if (hit && e.button === 0 && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(hit.id)) next.delete(hit.id)
          else next.add(hit.id)
          return next
        })
        schedulePaint()
        return
      }

      // Phase 4: Shift+click = path endpoints; Alt+click = neighborhood focus
      // Use refs so pointer listeners stay stable (no rebind → no hover blink)
      if (hit && e.button === 0 && e.shiftKey) {
        e.preventDefault()
        const from = pathFromIdRef.current
        const to = pathToIdRef.current
        if (!from || (from && to)) {
          setPathFromId(hit.id)
          setPathToId('')
          setPathNodeIds(null)
          setPathEdgeKeys(null)
          setPathStatus(`[PATH] From = “${hit.title}” · Shift+klik note tujuan`)
        } else if (from && !to) {
          setPathToId(hit.id)
          const fromTitle =
            nodesRef.current.find((n) => n.id === from)?.title || from.slice(0, 8)
          setPathStatus(`[PATH] Mencari “${fromTitle}” → “${hit.title}”…`)
          void findPath(from, hit.id, showTagEdgesRef.current).then((res) => {
            if (!res) {
              const d = diagnosePathResult({
                phase: 'fail-engine',
                fromTitle,
                toTitle: hit.title
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
                toTitle: hit.title
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
              toTitle: hit.title,
              hops: res.length,
              noteCount: res.nodeIds.length
            })
            setGraphDiag(d)
            setPathStatus(formatGraphDiag(d))
            setFocusNodeIds(null)
            setFocusEdgeKeys(null)
            if (res.nodeIds.length > 0) {
              requestAnimationFrame(() => fitView(true, new Set(res.nodeIds)))
            }
          })
        }
        return
      }
      if (hit && e.button === 0 && e.altKey) {
        e.preventDefault()
        const depth = focusDepthRef.current
        void fetchNeighborhood(hit.id, depth).then((res) => {
          if (!res) return
          setFocusNodeIds(new Set(res.ids))
          setFocusEdgeKeys(new Set(res.edgeKeys))
          setPathNodeIds(null)
          setPathEdgeKeys(null)
          setPathStatus(`Focus “${hit.title}” depth ${depth} · ${res.ids.length}`)
        })
        return
      }

      if (hit && e.button === 0) {
        dragged = hit
        dragIdRef.current = hit.id
        hit.fx = hit.x
        hit.fy = hit.y
        simRef.current?.alphaTarget(0.15).restart()
        try {
          target.setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
      } else if (e.button === 0 || e.button === 1) {
        panning = true
        panLast = { x: e.clientX, y: e.clientY }
        try {
          target.setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
      }
    }

    const onMove = (e: PointerEvent) => {
      if (dragged) {
        moved = true
        const rect = viewRect()
        const t = transformRef.current
        dragged.fx = (e.clientX - rect.left - t.x) / t.k
        dragged.fy = (e.clientY - rect.top - t.y) / t.k
        // Keep sim node position in sync while dragging
        dragged.x = dragged.fx
        dragged.y = dragged.fy
        schedulePaint()
        return
      }
      if (panning) {
        moved = true
        const dx = e.clientX - panLast.x
        const dy = e.clientY - panLast.y
        panLast = { x: e.clientX, y: e.clientY }
        const t = transformRef.current
        transformRef.current = d3.zoomIdentity.translate(t.x + dx, t.y + dy).scale(t.k)
        schedulePaint()
        scheduleSaveCamera()
        return
      }
      // hover — animated strength via setHoverId (no React setState)
      const hit = hitNode(e.clientX, e.clientY)
      const next = hit?.id || null
      if (next !== hoverIdRef.current) {
        setHoverId(next)
        if (hit) showTooltipDom(hit, e.clientX, e.clientY)
        else hideTooltipDom()
      } else if (hit) {
        moveTooltipDom(e.clientX, e.clientY)
      }
    }

    const onLeave = () => {
      setHoverId(null)
      hideTooltipDom()
    }

    const onUp = (e: PointerEvent) => {
      if (dragged) {
        const d = dragged
        if (!moved) {
          // click open — ghosts have no file; tags filter by tag name
          if (d.isTag || d.type === 'tag') {
            const tag = (d.title || '').replace(/^#/, '')
            setSearchQuery(tag.startsWith('#') ? tag : tag)
            setSearchMode('filter')
            setPathStatus(`Filter tag #${tag}`)
            schedulePaint()
          } else if (d.isGhost || d.type === 'ghost' || !d.path) {
            setPathStatus(`Ghost “${d.title}” — note belum ada (buat [[${d.title}]])`)
          } else if (d.isAttachment || d.type === 'attachment') {
            if (d.path && window.api?.openFileExternal) {
              void window.api.openFileExternal(d.path).then((res) => {
                if (res?.ok) setPathStatus(`Opened: ${d.title}`)
                else setPathStatus(`Gagal buka attachment: ${res?.error || d.title}`)
              })
            } else {
              setPathStatus(`Attachment: ${d.title}${d.path ? ` · ${d.relativePath || d.path}` : ''}`)
            }
          } else {
            void openTab(d.path)
            setActiveView('editor')
          }
        } else {
          d.pinned = true
          posCache.current.set(d.id, { x: d.x!, y: d.y!, fx: d.fx, fy: d.fy })
          setPinnedCount(nodesRef.current.filter((n) => n.pinned || n.fx != null).length)
          // Debounced auto-save of pinned positions to vault layout
          if (saveLayoutTimer.current) clearTimeout(saveLayoutTimer.current)
          saveLayoutTimer.current = setTimeout(() => {
            const patch: Record<string, { x: number; y: number; pinned?: boolean }> = {}
            for (const n of nodesRef.current) {
              if (n.x == null || n.y == null) continue
              // Never persist synthetic nodes (ghost / tag) into layout file
              if (n.isGhost || n.type === 'ghost' || n.isTag || n.type === 'tag') continue
              if (n.pinned || n.fx != null) {
                patch[n.id] = { x: n.x, y: n.y, pinned: true }
              }
            }
            if (Object.keys(patch).length) {
              void saveLayoutPositions(patch, false).then((ok) => {
                if (ok) setLayoutStatus(`Auto-saved ${Object.keys(patch).length} pin(s)`)
              })
            }
          }, 600)
        }
        // Keep gentle animate if enabled (don't kill continuous motion after drag)
        simRef.current?.alphaTarget(animateForcesRef.current ? 0.018 : 0)
        dragged = null
        dragIdRef.current = null
      }
      panning = false
      try {
        target.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }

    const onDbl = (e: MouseEvent) => {
      const hit = hitNode(e.clientX, e.clientY)
      if (!hit) return
      if (hit.isGhost || hit.isTag || hit.type === 'ghost' || hit.type === 'tag') return
      hit.fx = null
      hit.fy = null
      hit.pinned = false
      posCache.current.set(hit.id, { x: hit.x!, y: hit.y!, fx: null, fy: null })
      setPinnedCount(nodesRef.current.filter((n) => n.pinned || n.fx != null).length)
      simRef.current?.alpha(0.3).restart()
      if (animateForcesRef.current) simRef.current?.alphaTarget(0.018)
      schedulePaint()
    }

    const el = target as HTMLElement
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('dblclick', onDbl)

    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('dblclick', onDbl)
    }
    // filteredNodes.length: rebind after first data load (canvas was empty shell)
  }, [
    filteredNodes.length,
    hitNode,
    openTab,
    setActiveView,
    schedulePaint,
    saveLayoutPositions,
    findPath,
    fetchNeighborhood,
    showTooltipDom,
    hideTooltipDom,
    moveTooltipDom,
    setHoverId,
    scheduleSaveCamera,
    schedulePaint,
    fitView
  ])

  // External focus — retry until sim has positions (was clearing focus too early)
  useEffect(() => {
    if (!focusedNodeId) return
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const attempt = () => {
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
    const onResize = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        const sized = syncCanvasSize()
        if (!sized.ready) {
          schedulePaint()
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
        // First real size: always fit so graph isn't off-screen / blank-looking
        if (wasZero && nodesRef.current.length > 0) {
          hasAutoFitRef.current = true
          fitView(false)
        } else if (grewALot && !hasAutoFitRef.current && nodesRef.current.length > 0) {
          hasAutoFitRef.current = true
          fitView(false)
        } else if (grewALot && nodesRef.current.length > 0) {
          // Window resize can push old camera off-screen
          ensureGraphVisibleRef.current('resize')
        }
        schedulePaint()
      }, 50)
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
      sim.alphaTarget(animateForcesRef.current ? 0.018 : 0)
      sim.alpha(0.75).restart()
    }
    schedulePaint()
  }, [schedulePaint])

  /** Reheat forces + fit camera (Obsidian "start" feel) */
  const handleReheatAndFit = useCallback(() => {
    handleReheat()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => fitView(true))
    })
    setLayoutStatus('Re-layout + fit')
  }, [handleReheat, fitView])

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

  // Live animate forces toggle
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return
    if (animateForces) {
      sim.alphaTarget(0.018).restart()
    } else {
      sim.alphaTarget(0)
    }
    schedulePaint()
  }, [animateForces, schedulePaint])

  const handleSaveLayout = useCallback(async () => {
    const patch = collectLayoutPatch(false)
    const count = Object.keys(patch).length
    if (count === 0) {
      setLayoutStatus('Tidak ada posisi untuk disimpan')
      return
    }
    const ok = await saveLayoutPositions(patch, false)
    setLayoutStatus(ok ? `Layout tersimpan (${count} nodes)` : 'Gagal simpan layout')
  }, [collectLayoutPatch, saveLayoutPositions])

  const handleClearLayout = useCallback(async () => {
    handleReheat()
    const ok = await saveLayoutPositions({}, true)
    layoutHydratedRef.current = false
    setLayoutStatus(ok ? 'File layout dikosongkan' : 'Gagal clear layout')
  }, [handleReheat, saveLayoutPositions])

  const handleForcesChange = useCallback((next: GraphForceSettings) => {
    setForces(next)
  }, [])

  const handleForcesCommit = useCallback(
    (next: GraphForceSettings) => {
      setForces(next)
      void updateGraphSettings({ forces: next })
      setLayoutStatus('Forces disimpan')
    },
    [updateGraphSettings]
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
    const titleOf = (id: string) => nodesRef.current.find((n) => n.id === id)?.title || id.slice(0, 8)
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
      res.length === 0
        ? `[PATH_OK] Note yang sama (“${fromTitle}”)`
        : formatGraphDiag(d)
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
    if (pathStatus?.startsWith('Focus')) setPathStatus(null)
  }, [pathStatus])

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
      setHubThreshold(s.hubDegreeThreshold ?? 15)
      setSelectedType(s.selectedType || 'all')
      setSelectedTag(s.selectedTag || 'all')
      setShowLabels(s.showLabels !== false)
      setShowTagEdges(Boolean(s.showTagEdges))
      setShowLegend(Boolean(s.showLegend))
      setColorBy(s.colorBy === 'folder' ? 'folder' : 'type')
      if (s.forces) setForces({ ...DEFAULT_FORCE_SETTINGS, ...s.forces })
      setPerfMode(s.perfMode === 'quality' || s.perfMode === 'speed' ? s.perfMode : 'auto')
      setExistingFilesOnly(s.existingFilesOnly !== false)
      setSearchMode(s.searchMode === 'filter' ? 'filter' : 'spotlight')
      setShowTags(Boolean(s.showTags))
      setShowAttachments(Boolean(s.showAttachments))
      setAnimateForces(Boolean(s.animateForces))
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
          textFade: s.textFade ?? 1,
          nodeSize: s.nodeSize ?? 1,
          lineThickness: s.lineThickness ?? 1,
          existingFilesOnly: s.existingFilesOnly !== false,
          showTags: Boolean(s.showTags),
          showAttachments: Boolean(s.showAttachments),
          animateForces: Boolean(s.animateForces)
        },
        filters: {
          hubDegreeThreshold: s.hubDegreeThreshold ?? 15,
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
    [
      savedViews,
      updateGraphSettings,
      graphSettings?.filters.localDepth,
      schedulePaint,
      applyCamera
    ]
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
      setViewsStatus('Area graph belum berukuran — coba Fit dulu')
      schedulePaint()
      return
    }
    if (!hasAutoFitRef.current && nodesRef.current.length > 0) {
      hasAutoFitRef.current = true
      fitView(false)
    }
    // SVG display + optional canvas fallback buffer
    exportCanvasPaintRef.current = true
    paint()
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const download = (url: string, note: string) => {
      const a = document.createElement('a')
      a.href = url
      a.download = `workspacegraph-${stamp}.png`
      a.click()
      setViewsStatus(`PNG diexport · ${stats.nodes} nodes${note}`)
    }

    // Prefer SVG → canvas (what user actually sees). Hidden canvas toDataURL can be blank
    // on the same Windows GPU path that made Graph View black.
    const svg = svgRef.current
    const { w, h } = sized
    if (svg && w > 8 && h > 8) {
      try {
        const clone = svg.cloneNode(true) as SVGSVGElement
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
        clone.setAttribute('width', String(w))
        clone.setAttribute('height', String(h))
        // Opaque background (SVG is transparent)
        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        bg.setAttribute('width', '100%')
        bg.setAttribute('height', '100%')
        bg.setAttribute('fill', paletteRef.current.bg || '#1e1e22')
        clone.insertBefore(bg, clone.firstChild)
        const xml = new XMLSerializer().serializeToString(clone)
        const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
        const url = URL.createObjectURL(blob)
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
            download(out.toDataURL('image/png'), ' · SVG')
          } catch (err) {
            console.error(err)
            setViewsStatus('Export PNG gagal (SVG raster)')
          } finally {
            URL.revokeObjectURL(url)
          }
        }
        img.onerror = () => {
          URL.revokeObjectURL(url)
          // Fallback: hidden canvas buffer
          const canvas = canvasRef.current
          if (!canvas) {
            setViewsStatus('Export PNG gagal')
            return
          }
          try {
            download(canvas.toDataURL('image/png'), ' · canvas')
          } catch (e) {
            console.error(e)
            setViewsStatus('Export PNG gagal')
          }
        }
        img.src = url
        return
      } catch (err) {
        console.error(err)
      }
    }

    const canvas = canvasRef.current
    if (!canvas) {
      setViewsStatus('Export belum siap')
      return
    }
    try {
      download(canvas.toDataURL('image/png'), ' · canvas')
    } catch (err) {
      console.error(err)
      setViewsStatus('Export PNG gagal')
    }
  }, [paint, stats.nodes, syncCanvasSize, schedulePaint, fitView])

  // Phase 6: keyboard shortcuts when Graph view is active
  useEffect(() => {
    if (activeView !== 'graph') return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (!el) return
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) {
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
        handleClearPath()
        handleClearFocus()
        setSelectedIds(new Set())
        setSearchQuery('')
        setShowFilters(false)
        setPathStatus('Cleared path/focus/selection/spotlight')
        schedulePaint()
        return
      }
      if (e.key === 'o' || e.key === 'O') {
        const ids = [...selectedIdsRef.current]
        if (ids.length === 0) return
        e.preventDefault()
        const first = nodesRef.current.find((n) => n.id === ids[0])
        if (first?.path) {
          void openTab(first.path)
          setActiveView('editor')
        }
        return
      }
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        fitView(true)
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
        setShowFilters((v) => !v)
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
        transformRef.current = d3.zoomIdentity.translate(t.x + panStep, t.y).scale(t.k)
        schedulePaint()
        scheduleSaveCamera()
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        const t = transformRef.current
        transformRef.current = d3.zoomIdentity.translate(t.x - panStep, t.y).scale(t.k)
        schedulePaint()
        scheduleSaveCamera()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        const t = transformRef.current
        transformRef.current = d3.zoomIdentity.translate(t.x, t.y + panStep).scale(t.k)
        schedulePaint()
        scheduleSaveCamera()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const t = transformRef.current
        transformRef.current = d3.zoomIdentity.translate(t.x, t.y - panStep).scale(t.k)
        schedulePaint()
        scheduleSaveCamera()
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
        fitView(true)
        return
      }
      if (e.key === '0') {
        e.preventDefault()
        fitView(true)
        return
      }
      // A = toggle animate forces
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault()
        setAnimateForces((v) => {
          const next = !v
          void updateGraphSettings({ display: { animateForces: next } })
          setPathStatus(next ? 'Animate ON' : 'Animate OFF')
          return next
        })
        return
      }
      // T = toggle tags
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        setShowTags((v) => {
          const next = !v
          void updateGraphSettings({ display: { showTags: next } })
          setPathStatus(next ? 'Tags ON' : 'Tags OFF')
          return next
        })
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    activeView,
    handleClearPath,
    handleClearFocus,
    fitView,
    handleReheatAndFit,
    handleSaveLayout,
    handleExportPng,
    schedulePaint,
    scheduleSaveCamera,
    zoomBy,
    updateGraphSettings,
    openTab,
    setActiveView
  ])

  return (
    <div className="graph-container">
      <div className="graph-toolbar">
        <span className="graph-toolbar-stats">
          {stats.nodes}/{nodes.filter((n) => !n.isGhost).length} notes · {stats.edges} links
          {!existingFilesOnly
            ? ` · ghosts:${nodes.filter((n) => n.isGhost).length}`
            : ''}
          {searchQuery.trim()
            ? ` · ${searchMode === 'filter' ? 'filter' : 'spot'} “${searchQuery.trim()}”`
            : ''}
          {orphanMode !== 'all' ? ` · orphans:${orphanMode}` : ''}
          {hubMode !== 'all' ? ` · hubs:${hubMode}` : ''}
          {pathNodeIds ? ` · path:${pathNodeIds.size}` : ''}
          {focusNodeIds ? ` · focus:${focusNodeIds.size}` : ''}
          {selectedIds.size ? ` · sel:${selectedIds.size}` : ''}
          {colorBy !== 'type' ? ` · color:${colorBy}` : ''}
          {` · lod:${resolveLod(stats.nodes, perfMode)}`}
        </span>
        <div className="graph-toolbar-actions">
          <span
            className="graph-toolbar-hint"
            title="←↑↓→ pan · +/− zoom · Home/0 fit · Esc clear · F fit · R layout · S save · E PNG · P panel · / search · 1–4 orphans · A animate · T tags · Ctrl+A select · Ctrl+C copy · O open"
          >
            keys
          </span>
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
            onClick={() => fitView(true)}
            title="Fit (F)"
          >
            Fit
          </button>
          <button
            type="button"
            className="graph-chip"
            onClick={handleReheatAndFit}
            title="Lepas pin, re-layout & fit (R)"
          >
            Layout
          </button>
          <button
            type="button"
            className="graph-chip"
            onClick={() => void handleSaveLayout()}
            title="Simpan posisi"
          >
            Save
          </button>
          <button type="button" className="graph-chip" onClick={handleExportPng} title="Export PNG">
            PNG
          </button>
          <button
            type="button"
            className={`graph-chip graph-chip-icon ${showFilters ? 'active' : ''}`}
            onClick={() => setShowFilters((p) => !p)}
            title="Graph settings (P)"
            aria-label="Graph settings"
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
          colorGroups={colorGroups}
          onColorGroupsChange={handleColorGroupsChange}
          onPersist={(partial) => {
            void updateGraphSettings(partial)
          }}
        />
      )}

      {/* Stage mirrors local-graph-body: relative flex child; canvas fills it (LocalGraph path) */}
      <div className="graph-stage" ref={wrapRef}>
      {/* Off-screen buffer for PNG export fallback */}
      <canvas
        ref={canvasRef}
        className="graph-canvas graph-canvas--export"
        aria-hidden="true"
      />
      {/* React-owned SVG — survives re-renders (unlike innerHTML on bare <svg>) */}
      <div className="graph-svg-host" role="img" aria-label="Knowledge graph">
        {svgFrame ? (
          <svg
            ref={svgRef}
            className="graph-svg"
            viewBox={`0 0 ${svgFrame.w} ${svgFrame.h}`}
            width={svgFrame.w}
            height={svgFrame.h}
            preserveAspectRatio="none"
          >
            <g className="g-edges">
              {svgFrame.edges.map((e) => (
                <line
                  key={e.key}
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                  stroke={e.stroke}
                  strokeWidth={e.sw}
                  strokeOpacity={e.op}
                />
              ))}
            </g>
            <g className="g-nodes">
              {svgFrame.nodes.map((n) =>
                n.kind === 'poly' ? (
                  <polygon
                    key={n.key}
                    points={n.points}
                    fill={n.fill}
                    stroke={n.stroke}
                    strokeWidth={n.sw}
                    fillOpacity={n.fillOp}
                  />
                ) : (
                  <circle
                    key={n.key}
                    cx={n.cx}
                    cy={n.cy}
                    r={n.r}
                    fill={n.fill}
                    stroke={n.stroke}
                    strokeWidth={n.sw}
                    fillOpacity={n.fill === 'none' ? 0 : n.fillOp}
                    strokeOpacity={n.fill === 'none' ? n.fillOp : 1}
                  />
                )
              )}
            </g>
            <g className="g-labels">
              {svgFrame.labels.map((lab) => (
                <text
                  key={lab.key}
                  x={lab.x}
                  y={lab.y}
                  fill={lab.fill}
                  fontSize={11}
                  fontFamily="system-ui, Segoe UI, sans-serif"
                  fontWeight={lab.bold ? 600 : 400}
                >
                  {lab.text}
                </text>
              ))}
            </g>
          </svg>
        ) : (
          <div className="graph-live-hud" style={{ position: 'absolute', left: 12, top: 12 }}>
            Memuat graph…
          </div>
        )}
      </div>
      <div className="graph-live-hud" aria-live="polite">
        {svgFrame?.hud || (graphLoaded ? 'sim:…' : 'memuat…')}
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
                {nodes.length > 0 && filteredNodes.length === 0 ? (
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
      {orphanMode !== 'all' || hubMode === 'hide' || selectedType !== 'all' || selectedTag !== 'all' ? (
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
                transformRef.current = d3.zoomIdentity
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
                transformRef.current = d3.zoomIdentity
                fitView(true)
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
        <button
          type="button"
          onClick={() => zoomBy(1.25)}
          title="Zoom in"
          aria-label="Zoom in"
        >
          <Icon name="zoomIn" size={15} />
        </button>
        <button
          type="button"
          onClick={() => zoomBy(0.8)}
          title="Zoom out"
          aria-label="Zoom out"
        >
          <Icon name="zoomOut" size={15} />
        </button>
        <button
          type="button"
          onClick={() => fitView(true)}
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
      </div>{/* .graph-stage */}
    </div>
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}




