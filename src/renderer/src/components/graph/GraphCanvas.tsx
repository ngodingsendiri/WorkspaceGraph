/**
 * Graph view — Obsidian-like Canvas 2D + d3-force (no per-node SVG DOM).
 * Default edges = wikilinks only (tag edges optional).
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

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** Stable pastel from folder name for color-by-folder mode */
function folderColor(relativePath: string, isLight: boolean): string {
  const folder = (relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean)[0] || 'root'
  let h = 0
  for (let i = 0; i < folder.length; i++) h = (h * 31 + folder.charCodeAt(i)) >>> 0
  const hue = h % 360
  return isLight ? `hsl(${hue}, 48%, 42%)` : `hsl(${hue}, 42%, 58%)`
}

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
function matchGroupQuery(query: string, n: GraphNodeData): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return false
  const title = n.title.toLowerCase()
  const path = (n.relativePath || '').toLowerCase().replace(/\\/g, '/')
  const tags = n.tags.map((t) => t.toLowerCase())
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

type LodLevel = 'full' | 'medium' | 'low'

/** Phase 5: paint LOD from node count + preference (mirrors GraphLayoutStore.resolveGraphLod) */
function resolveLod(nodeCount: number, perfMode: GraphPerfMode = 'auto'): LodLevel {
  if (perfMode === 'quality') return 'full'
  if (perfMode === 'speed') {
    if (nodeCount > 40) return 'low'
    if (nodeCount > 15) return 'medium'
    return 'full'
  }
  if (nodeCount > 200) return 'low'
  if (nodeCount > 80) return 'medium'
  return 'full'
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

function readPalette(): Palette {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light'
  return {
    isLight,
    bg: css('--bg-app', isLight ? '#f4f6f9' : '#1e1e22'),
    edge: css('--graph-edge-wiki', isLight ? 'rgba(60,70,90,0.35)' : 'rgba(180,190,210,0.28)'),
    edgeTag: css('--graph-edge-tag', isLight ? 'rgba(60,70,90,0.18)' : 'rgba(140,150,170,0.16)'),
    edgeHot: css(
      '--graph-edge-hover',
      isLight ? 'rgba(100,80,200,0.85)' : 'rgba(170,150,255,0.75)'
    ),
    label: css('--graph-label-fill', isLight ? '#1a1f2a' : 'rgba(230,235,245,0.9)'),
    labelBg: isLight ? 'rgba(255,255,255,0.75)' : 'rgba(20,22,28,0.55)',
    nodeStroke: css('--graph-node-stroke', isLight ? '#fff' : 'rgba(0,0,0,0.45)'),
    colors: {
      knowledge: css('--node-knowledge', '#7c6bc4'),
      project: css('--node-project', '#3d9bb8'),
      task: css('--node-task', '#c4923a'),
      daily: css('--node-daily', '#4a9e6e'),
      people: css('--node-person', '#c46a4a'),
      template: css('--node-template', '#9a6bb8'),
      document: css('--node-document', '#5a8ab8'),
      sop: css('--node-sop', '#c45a7a'),
      other: css('--node-default', '#7a8494')
    }
  }
}

function radius(d: SimNode, scale = 1): number {
  const base = Math.max(3, Math.min(10, 3 + Math.sqrt(Math.max(0, d.degree)) * 1.35))
  return base * scale
}

function nid(x: string | SimNode): string {
  return typeof x === 'object' ? x.id : x
}

/** Smoothstep 0..1 */
function smooth01(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Obsidian-like text fade by zoom.
 * Higher textFade threshold → need more zoom-in before labels are solid
 * (zoom out = fade, then gone). Larger/high-degree nodes appear earlier.
 */
function labelZoomAlpha(zoomK: number, textFade: number, degree: number): number {
  // textFade ≈ zoom scale where label reaches full opacity (slider 0.4–2.5)
  const thr = Math.max(0.35, textFade || 1)
  // High-degree hubs stay readable a bit longer when zoomed out
  const boost = Math.min(0.35, Math.sqrt(Math.max(0, degree)) * 0.06)
  const fullAt = thr * (1 - boost * 0.55)
  const startAt = fullAt * 0.42
  if (zoomK <= startAt) return 0
  if (zoomK >= fullAt) return 1
  return smooth01((zoomK - startAt) / Math.max(0.0001, fullAt - startAt))
}

/** Apply Phase 3 force settings onto a live d3 simulation. */
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
    link.distance(forces.linkDist).strength(forces.linkStr)
  }
  const charge = large ? Math.max(forces.charge * 0.55, -220) : forces.charge
  sim.force(
    'charge',
    d3
      .forceManyBody()
      .strength(charge)
      .distanceMax(large ? 180 : Math.max(220, forces.linkDist * 4))
      .theta(0.95)
  )
  sim.force('center', d3.forceCenter(width / 2, height / 2).strength(forces.center))
  const soft = Math.min(0.12, forces.center * 0.7)
  sim.force('x', d3.forceX(width / 2).strength(soft))
  sim.force('y', d3.forceY(height / 2).strength(soft))
  sim.force(
    'collide',
    d3
      .forceCollide<SimNode>()
      .radius((d) => radius(d) * sizeMul + 4)
      .strength(forces.collide)
      .iterations(1)
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
    saveLayoutPositions,
    findPath,
    fetchNeighborhood,
    savedViews,
    saveGraphView,
    deleteGraphView
  } = useGraphStore()
  const openTab = useEditorStore((s) => s.openTab)
  const setActiveView = useWorkspaceStore((s) => s.setActiveView)
  const activeView = useWorkspaceStore((s) => s.activeView)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
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
  const focusDepthRef = useRef<1 | 2>(1)
  const layoutHydratedRef = useRef(false)
  /** Phase 6: only auto-fit once per session / after empty→data (not every filter rebuild) */
  const hasAutoFitRef = useRef(false)
  const saveLayoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  const [focusDepth, setFocusDepth] = useState<1 | 2>(1)
  const [focusNodeIds, setFocusNodeIds] = useState<Set<string> | null>(null)
  const [focusEdgeKeys, setFocusEdgeKeys] = useState<Set<string> | null>(null)
  const [stats, setStats] = useState({ nodes: 0, edges: 0 })

  const [layoutStatus, setLayoutStatus] = useState<string | null>(null)
  const [pinnedCount, setPinnedCount] = useState(0)
  const [perfMode, setPerfMode] = useState<GraphPerfMode>('auto')
  const [viewsStatus, setViewsStatus] = useState<string | null>(null)
  /** Phase 7 multi-select */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  /** Obsidian-like display knobs + color groups */
  const [displayOpts, setDisplayOpts] = useState<GraphDisplayOpts>({ ...DEFAULT_DISPLAY_OPTS })
  const [colorGroups, setColorGroups] = useState<GraphColorGroup[]>([])

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
      el.innerHTML = `<div class="gt-title">${escapeHtml(hit.title)}</div>
        <div class="gt-meta">${escapeHtml(hit.type)} · ${hit.degree} link${hit.degree !== 1 ? 's' : ''}</div>
        ${hit.tags.length ? `<div class="gt-tags">${hit.tags.map((t) => '#' + escapeHtml(t)).join(' ')}</div>` : ''}
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
    fetchGraph()
    void fetchGraphMeta()
    const unsub = window.api.onGraphUpdated(() => {
      fetchGraph()
      void fetchGraphMeta()
    })
    return () => {
      unsub()
      if (hoverAnimRafRef.current) cancelAnimationFrame(hoverAnimRafRef.current)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (saveLayoutTimer.current) clearTimeout(saveLayoutTimer.current)
    }
  }, [fetchGraph, fetchGraphMeta])

  // Hydrate display + Phase 2 filter modes + Phase 3 forces from persisted graph settings
  useEffect(() => {
    if (!graphSettings) return
    setShowLabels(graphSettings.display.showLabels)
    setShowTagEdges(graphSettings.display.showTagEdges)
    setShowLegend(graphSettings.display.showLegend)
    setHubThreshold(graphSettings.filters.hubDegreeThreshold)
    const om = graphSettings.filters.orphanMode
    if (om === 'all' || om === 'hide' || om === 'only') {
      setOrphanMode(om)
    } else if (graphSettings.display.hideOrphans) {
      setOrphanMode('hide')
    } else {
      setOrphanMode('all')
    }
    const hm = graphSettings.filters.hubMode
    if (hm === 'all' || hm === 'dim' || hm === 'hide') {
      setHubMode(hm)
    } else if (graphSettings.display.dimHubs) {
      setHubMode('dim')
    } else {
      setHubMode('all')
    }
    if (graphSettings.forces) {
      setForces({ ...DEFAULT_FORCE_SETTINGS, ...graphSettings.forces })
    }
    const gd = graphSettings.display
    setDisplayOpts({
      arrows: gd.arrows ?? DEFAULT_DISPLAY_OPTS.arrows,
      textFade: gd.textFade ?? DEFAULT_DISPLAY_OPTS.textFade,
      nodeSize: gd.nodeSize ?? DEFAULT_DISPLAY_OPTS.nodeSize,
      lineThickness: gd.lineThickness ?? DEFAULT_DISPLAY_OPTS.lineThickness
    })
    setColorGroups(graphSettings.groups || [])
  }, [graphSettings])

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
    nodes.forEach((n) => n.tags.forEach((t) => s.add(t)))
    return Array.from(s).sort()
  }, [nodes])

  const typeOptions = useMemo(() => {
    const s = new Set(nodes.map((n) => n.type).filter(Boolean))
    return Array.from(s).sort()
  }, [nodes])

  // Spotlight: match ids (null = no search)
  const searchMatchIds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return null
    return new Set(
      nodes
        .filter(
          (n) => n.title.toLowerCase().includes(q) || n.relativePath.toLowerCase().includes(q)
        )
        .map((n) => n.id)
    )
  }, [nodes, searchQuery])

  const orphanIdSet = useMemo(() => new Set(orphanIds), [orphanIds])
  // Prefer live degree (always on node); fall back to engine orphan set if degree missing
  const filteredNodes = useMemo(() => {
    return nodes.filter((n) => {
      if (selectedType !== 'all' && n.type !== selectedType) return false
      if (selectedTag !== 'all' && !n.tags.includes(selectedTag)) return false
      const isOrphan = typeof n.degree === 'number' ? n.degree === 0 : orphanIdSet.has(n.id)
      if (orphanMode === 'hide' && isOrphan) return false
      if (orphanMode === 'only' && !isOrphan) return false
      if (hubMode === 'hide' && n.degree >= hubThreshold) return false
      // Search does NOT remove nodes — spotlight only (paint dim)
      return true
    })
  }, [nodes, selectedType, selectedTag, orphanMode, hubMode, hubThreshold, orphanIdSet])

  const filteredNodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes])

  const filteredEdges = useMemo(() => {
    return edges.filter((e) => {
      if (!filteredNodeIds.has(e.source) || !filteredNodeIds.has(e.target)) return false
      if (!showTagEdges && e.type === 'tag') return false
      return true
    })
  }, [edges, filteredNodeIds, showTagEdges])

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
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

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

    // Clear
    ctx.fillStyle = pal.bg
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

    const matchIds = flags.searchMatchIds
    const thr = flags.hubThreshold
    const dimHubsOn = flags.dimHubs
    const focusId = flags.focusedId
    const pathN = flags.pathNodeIds
    const pathE = flags.pathEdgeKeys
    const focN = flags.focusNodeIds
    const focE = flags.focusEdgeKeys
    const colorMode = flags.colorBy
    const sel = flags.selectedIds
    const pulse = pathPulseRef.current

    // Edges
    ctx.lineCap = 'round'
    const lineMul = flags.lineThickness || 1
    const sizeMul = flags.nodeSize || 1
    const drawArrows = flags.arrows && t.k >= 0.4
    for (const e of simLinks) {
      const s = e.source as SimNode
      const tg = e.target as SimNode
      if (s.x == null || s.y == null || tg.x == null || tg.y == null) continue
      // Phase 5 frustum: skip edges fully outside viewport
      if (!inView(s.x, s.y) && !inView(tg.x, tg.y)) continue
      const ek = edgeKey(s.id, tg.id)
      const onPath = pathE != null && pathE.has(ek)
      const onFocus = focE != null && focE.has(ek)
      const isHot = hot
        ? hot.has(s.id) && hot.has(tg.id) && (s.id === hover || tg.id === hover)
        : false
      const dimHover = Boolean(hot && !isHot && pathN == null && focN == null)
      const dimPath = pathN != null && !onPath
      const dimFocus = pathN == null && focN != null && !onFocus
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
          ? 1.85 + pulse * 0.3
          : isHot
            ? lerp(1.1, 1.45, hs)
            : e.type === 'wiki_link'
              ? 1.1
              : 0.8) * lineMul
      const baseEdge = e.type === 'tag' ? pal.edgeTag : pal.edge
      const edgeColor = onPath ? pal.edgeHot : isHot && hs > 0.4 ? pal.edgeHot : baseEdge
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(tg.x, tg.y)
      ctx.strokeStyle = edgeColor
      ctx.globalAlpha = edgeAlpha
      ctx.lineWidth = edgeW / t.k
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
      const isHub = n.degree >= thr
      const hubScale = dimHubsOn && isHub ? 0.62 : 1
      const r = radius(n, hubScale) * sizeMul
      const col =
        flags.groupColors?.get(n.id) ||
        (colorMode === 'folder'
          ? folderColor(n.relativePath, pal.isLight)
          : pal.colors[n.type] || pal.colors.other)
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

      let alpha = 1
      if (dimHover) alpha = lerp(1, pal.isLight ? 0.42 : 0.36, hs)
      else if (dimPath) alpha = pal.isLight ? 0.3 : 0.26
      else if (dimFocus) alpha = pal.isLight ? 0.34 : 0.28
      else if (dimSearch) alpha = pal.isLight ? 0.38 : 0.32
      else if (dimHubsOn && isHub && !isMatch && !isFocus && !onPath && !onFoc && !isSelected)
        alpha = 0.55
      if (onPath) alpha = Math.min(1, alpha + pulse * 0.05)
      ctx.globalAlpha = alpha

      // Soft glow: path/selection only (not full-graph flash on every hover)
      if (
        lod === 'full' &&
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
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
      ctx.fillStyle = col
      ctx.fill()
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

      for (const n of simNodes) {
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

        const text = n.title.length > 28 ? n.title.slice(0, 27) + '…' : n.title
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

    dirtyRef.current = false
  }, [])

  paintFnRef.current = paint

  const schedulePaint = useCallback(() => {
    requestPaint()
  }, [requestPaint])

  // Phase 7: gentle path pulse (slow + low amp — less “blink”)
  useEffect(() => {
    if (!pathNodeIds || pathNodeIds.size === 0) {
      pathPulseRef.current = 0
      return
    }
    let raf = 0
    let alive = true
    const loop = (t: number) => {
      if (!alive) return
      pathPulseRef.current = (Math.sin(t / 520) + 1) / 2
      schedulePaint()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      pathPulseRef.current = 0
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
   */
  const hitNode = useCallback((clientX: number, clientY: number): SimNode | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const t = transformRef.current
    const x = (clientX - rect.left - t.x) / t.k
    const y = (clientY - rect.top - t.y) / t.k
    const thr = viewFlagsRef.current.hubThreshold
    const dimHubsOn = viewFlagsRef.current.dimHubs
    const sizeMul = viewFlagsRef.current.nodeSize || 1
    const stickyId = hoverIdRef.current
    let best: SimNode | null = null
    let bestD = Infinity
    let sticky: SimNode | null = null
    let stickyD = Infinity
    for (const n of nodesRef.current) {
      if (n.x == null || n.y == null) continue
      const dx = n.x - x
      const dy = n.y - y
      const d = dx * dx + dy * dy
      const hubScale = dimHubsOn && n.degree >= thr ? 0.62 : 1
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
    if (sticky && best) {
      if (sticky.id === best.id) return sticky
      // Switch only if another node is clearly closer (~45% nearer)
      if (bestD < stickyD * 0.55) return best
      return sticky
    }
    return sticky || best
  }, [])

  // Build simulation whenever data changes
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    simRef.current?.stop()

    const width = wrap.clientWidth || 800
    const height = wrap.clientHeight || 600
    canvas.style.width = '100%'
    canvas.style.height = '100%'

    if (filteredNodes.length === 0) {
      nodesRef.current = []
      linksRef.current = []
      setStats({ nodes: 0, edges: 0 })
      hasAutoFitRef.current = false
      schedulePaint()
      return
    }

    const f0 = forcesRef.current
    const simNodes: SimNode[] = filteredNodes.map((n) => {
      const c = posCache.current.get(n.id)
      const layout = layoutNodes[n.id]
      const x = c?.x ?? layout?.x ?? width / 2 + (Math.random() - 0.5) * 60
      const y = c?.y ?? layout?.y ?? height / 2 + (Math.random() - 0.5) * 60
      const pinned = c?.fx != null || Boolean(layout?.pinned)
      const fx = pinned ? (c?.fx ?? layout?.x ?? x) : null
      const fy = pinned ? (c?.fy ?? layout?.y ?? y) : null
      return {
        ...n,
        x,
        y,
        fx,
        fy,
        pinned
      }
    })
    const idSet = new Set(simNodes.map((n) => n.id))
    const simLinks: SimLink[] = filteredEdges
      .filter((e) => idSet.has(e.source) && idSet.has(e.target))
      .map((e) => ({
        id: e.id,
        type: e.type,
        weight: e.weight,
        source: e.source,
        target: e.target
      }))

    nodesRef.current = simNodes
    linksRef.current = simLinks
    setStats({ nodes: simNodes.length, edges: simLinks.length })
    setPinnedCount(simNodes.filter((n) => n.pinned || n.fx != null).length)

    const n = simNodes.length
    const large = n > 80

    const sim = d3
      .forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        d3
          .forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(f0.linkDist)
          .strength(f0.linkStr)
      )
      .velocityDecay(0.42)
      .alphaDecay(large ? 0.07 : 0.05)
      .alphaMin(0.025)
      .alpha(large ? 0.5 : 0.65)

    applyForces(
      sim as d3.Simulation<SimNode, undefined>,
      f0,
      width,
      height,
      large,
      viewFlagsRef.current.nodeSize || 1
    )
    simRef.current = sim

    let tick = 0
    const lod0 = resolveLod(n, viewFlagsRef.current.perfMode)
    const paintEvery = lod0 === 'low' ? 3 : 2
    sim.on('tick', () => {
      tick++
      if (tick % paintEvery === 0 || sim.alpha() < 0.05) schedulePaint()
      if (tick % 15 === 0) {
        for (const node of simNodes) {
          if (node.x != null && node.y != null) {
            posCache.current.set(node.id, { x: node.x, y: node.y, fx: node.fx, fy: node.fy })
          }
        }
      }
    })
    sim.on('end', () => {
      for (const node of simNodes) {
        if (node.x != null && node.y != null) {
          posCache.current.set(node.id, { x: node.x, y: node.y, fx: node.fx, fy: node.fy })
        }
      }
      // Phase 6 debt fix: auto-fit only first settle (filter/force rebuild keeps camera)
      if (!hasAutoFitRef.current) {
        hasAutoFitRef.current = true
        fitView(false)
      }
      schedulePaint()
    })

    schedulePaint()

    return () => {
      sim.stop()
      simRef.current = null
    }
    // Rebuild on data/filter change only — force slider updates apply live (below)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredNodes, filteredEdges, schedulePaint])

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
    (animate: boolean) => {
      const wrap = wrapRef.current
      const simNodes = nodesRef.current
      if (!wrap || simNodes.length === 0) return
      const width = wrap.clientWidth
      const height = wrap.clientHeight
      const xs = simNodes.map((n) => n.x || 0)
      const ys = simNodes.map((n) => n.y || 0)
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
      if (!animate) {
        transformRef.current = target
        schedulePaint()
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
      }
      requestAnimationFrame(step)
    },
    [schedulePaint]
  )

  // Obsidian-like zoom controls (bottom-right): zoom around viewport center
  const zoomBy = useCallback(
    (factor: number) => {
      const wrap = wrapRef.current
      if (!wrap) return
      const cx = wrap.clientWidth / 2
      const cy = wrap.clientHeight / 2
      const t = transformRef.current
      const nextK = Math.max(0.08, Math.min(6, t.k * factor))
      const x = cx - ((cx - t.x) * nextK) / t.k
      const y = cy - ((cy - t.y) * nextK) / t.k
      transformRef.current = d3.zoomIdentity.translate(x, y).scale(nextK)
      schedulePaint()
    },
    [schedulePaint]
  )

  // Pointer interactions (pan / zoom / drag / click)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let panning = false
    let panLast = { x: 0, y: 0 }
    let dragged: SimNode | null = null
    let moved = false

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const t = transformRef.current
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      const nextK = Math.max(0.08, Math.min(6, t.k * factor))
      const x = mx - ((mx - t.x) * nextK) / t.k
      const y = my - ((my - t.y) * nextK) / t.k
      transformRef.current = d3.zoomIdentity.translate(x, y).scale(nextK)
      schedulePaint()
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
          setPathStatus(`Path dari: ${hit.title}`)
        } else if (from && !to) {
          setPathToId(hit.id)
          setPathStatus(`Path ke: ${hit.title} · mencari…`)
          void findPath(from, hit.id, showTagEdgesRef.current).then((res) => {
            if (!res?.found) {
              setPathNodeIds(null)
              setPathEdgeKeys(null)
              setPathStatus('Tidak ada jalur wikilink')
              return
            }
            setPathNodeIds(new Set(res.nodeIds))
            setPathEdgeKeys(new Set(res.edgeKeys))
            setPathStatus(`Path ${res.length} hop · ${res.nodeIds.length} notes`)
            setFocusNodeIds(null)
            setFocusEdgeKeys(null)
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
        canvas.setPointerCapture(e.pointerId)
      } else if (e.button === 0 || e.button === 1) {
        panning = true
        panLast = { x: e.clientX, y: e.clientY }
        canvas.setPointerCapture(e.pointerId)
      }
    }

    const onMove = (e: PointerEvent) => {
      if (dragged) {
        moved = true
        const rect = canvas.getBoundingClientRect()
        const t = transformRef.current
        dragged.fx = (e.clientX - rect.left - t.x) / t.k
        dragged.fy = (e.clientY - rect.top - t.y) / t.k
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
          // click open
          void openTab(d.path)
          setActiveView('editor')
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
        simRef.current?.alphaTarget(0)
        dragged = null
        dragIdRef.current = null
      }
      panning = false
      try {
        canvas.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }

    const onDbl = (e: MouseEvent) => {
      const hit = hitNode(e.clientX, e.clientY)
      if (!hit) return
      hit.fx = null
      hit.fy = null
      hit.pinned = false
      posCache.current.set(hit.id, { x: hit.x!, y: hit.y!, fx: null, fy: null })
      setPinnedCount(nodesRef.current.filter((n) => n.pinned || n.fx != null).length)
      simRef.current?.alpha(0.3).restart()
      schedulePaint()
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('dblclick', onDbl)

    return () => {
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('dblclick', onDbl)
    }
  }, [
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
    setHoverId
  ])

  // External focus
  useEffect(() => {
    if (!focusedNodeId) return
    const d = nodesRef.current.find((n) => n.id === focusedNodeId)
    if (!d || d.x == null || d.y == null || !wrapRef.current) {
      setFocusedNode(null)
      return
    }
    const width = wrapRef.current.clientWidth
    const height = wrapRef.current.clientHeight
    const k = 1.8
    transformRef.current = d3.zoomIdentity
      .translate(width / 2 - d.x * k, height / 2 - d.y * k)
      .scale(k)
    setHoverId(focusedNodeId)
    setFocusedNode(null)
  }, [focusedNodeId, setFocusedNode, setHoverId])

  // Resize
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let t: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        const sim = simRef.current
        if (!sim) {
          schedulePaint()
          return
        }
        const w = el.clientWidth
        const h = el.clientHeight
        applyForces(
          sim as d3.Simulation<SimNode, undefined>,
          forcesRef.current,
          w,
          h,
          nodesRef.current.length > 80
        )
        sim.alpha(0.06).restart()
        schedulePaint()
      }, 100)
    })
    ro.observe(el)
    return () => {
      if (t) clearTimeout(t)
      ro.disconnect()
    }
  }, [schedulePaint])

  const collectLayoutPatch = useCallback((onlyPinned = false) => {
    const patch: Record<string, { x: number; y: number; pinned?: boolean }> = {}
    for (const n of nodesRef.current) {
      if (n.x == null || n.y == null) continue
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
    simRef.current?.alpha(0.7).restart()
    schedulePaint()
  }, [schedulePaint])

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
    if (!pathFromId || !pathToId) {
      setPathStatus('Pilih dua note untuk path')
      return
    }
    const res = await findPath(pathFromId, pathToId, showTagEdges)
    if (!res) {
      setPathStatus('Path gagal (engine)')
      setPathNodeIds(null)
      setPathEdgeKeys(null)
      return
    }
    if (!res.found) {
      setPathStatus('Tidak ada jalur wikilink antara kedua note')
      setPathNodeIds(null)
      setPathEdgeKeys(null)
      return
    }
    setPathNodeIds(new Set(res.nodeIds))
    setPathEdgeKeys(new Set(res.edgeKeys))
    setPathStatus(
      res.length === 0 ? 'Note yang sama' : `Path ${res.length} hop · ${res.nodeIds.length} notes`
    )
    setFocusNodeIds(null)
    setFocusEdgeKeys(null)
  }, [pathFromId, pathToId, findPath, showTagEdges])

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
          lineThickness: s.lineThickness ?? 1
        },
        filters: {
          hubDegreeThreshold: s.hubDegreeThreshold ?? 15,
          localDepth: graphSettings?.filters.localDepth ?? 1,
          orphanMode: s.orphanMode || 'all',
          hubMode: s.hubMode || 'dim'
        },
        groups: s.groups || []
      })
      setViewsStatus(`Loaded “${view.name}”`)
      schedulePaint()
    },
    [savedViews, updateGraphSettings, graphSettings?.filters.localDepth, schedulePaint]
  )

  const handleDeleteView = useCallback(
    async (id: string) => {
      const ok = await deleteGraphView(id)
      setViewsStatus(ok ? 'View dihapus' : 'Gagal hapus view')
    },
    [deleteGraphView]
  )

  const handleExportPng = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      setViewsStatus('Canvas belum siap')
      return
    }
    // Ensure latest paint before export
    paint()
    try {
      const url = canvas.toDataURL('image/png')
      const a = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      a.href = url
      a.download = `workspacegraph-${stamp}.png`
      a.click()
      setViewsStatus(`PNG diexport · ${stats.nodes} nodes`)
    } catch (err) {
      console.error(err)
      setViewsStatus('Export PNG gagal')
    }
  }, [paint, stats.nodes])

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
        handleReheat()
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
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    activeView,
    handleClearPath,
    handleClearFocus,
    fitView,
    handleReheat,
    handleSaveLayout,
    handleExportPng,
    schedulePaint,
    openTab,
    setActiveView
  ])

  return (
    <div className="graph-container" ref={wrapRef}>
      <div className="graph-toolbar">
        <span className="graph-toolbar-stats">
          {stats.nodes}/{nodes.length} notes · {stats.edges} links
          {searchQuery.trim() ? ` · spotlight “${searchQuery.trim()}”` : ''}
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
            title="Esc clear · F fit · R layout · S save · E PNG · P panel · / search · Ctrl+klik select · Ctrl+A all · Ctrl+C copy · O open"
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
            onClick={handleReheat}
            title="Lepas pin & re-layout"
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
          orphanCount={nodes.length ? nodes.filter((n) => n.degree === 0).length : orphanIds.length}
          hubCount={
            nodes.length ? nodes.filter((n) => n.degree >= hubThreshold).length : hubIds.length
          }
          totalNodes={nodes.length}
          visibleNodes={filteredNodes.length}
          forces={forces}
          onForcesChange={handleForcesChange}
          onForcesCommit={handleForcesCommit}
          onForcesReset={handleForcesReset}
          pinnedCount={pinnedCount}
          layoutNodeCount={Object.keys(layoutNodes || {}).length}
          layoutStatus={layoutStatus}
          onSaveLayout={() => void handleSaveLayout()}
          onClearLayout={() => void handleClearLayout()}
          onReheat={handleReheat}
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

      {filteredNodes.length === 0 ? (
        <div className="graph-empty">
          <p>Tidak ada node untuk ditampilkan.</p>
          <p className="muted">Buka vault berisi note Markdown, atau longgarkan filter.</p>
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          className="graph-canvas"
          style={{ width: '100%', height: '100%' }}
        />
      )}

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
