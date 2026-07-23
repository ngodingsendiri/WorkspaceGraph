/**
 * Local graph (Phase 1) — Obsidian-style mini canvas under the editor.
 * Data: graph:getLocal (center + neighbors, depth 1–2, wiki edges by default).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import { useEditorStore } from '../../store/editorStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGraphStore, GraphNodeData, type GraphForceSettings } from '../../store/graphStore'
import { Icon } from '../ui/Icons'
import { DEFAULT_FORCE_SETTINGS } from './GraphFiltersPanel'

interface SimNode extends d3.SimulationNodeDatum, GraphNodeData {
  pinned?: boolean
  isCenter?: boolean
}
interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  id: string
  type: string
  source: string | SimNode
  target: string | SimNode
}

type Palette = {
  isLight: boolean
  bg: string
  edge: string
  edgeHot: string
  label: string
  labelBg: string
  nodeStroke: string
  centerStroke: string
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
    bg: css('--bg-surface', isLight ? '#fff' : '#28282b'),
    edge: css('--graph-edge-wiki', isLight ? 'rgba(60,70,90,0.4)' : 'rgba(180,190,210,0.35)'),
    edgeHot: css('--graph-edge-hover', isLight ? 'rgba(100,80,200,0.9)' : 'rgba(170,150,255,0.8)'),
    label: css('--graph-label-fill', isLight ? '#1a1f2a' : 'rgba(230,235,245,0.92)'),
    labelBg: isLight ? 'rgba(255,255,255,0.88)' : 'rgba(20,22,28,0.7)',
    nodeStroke: css('--graph-node-stroke', isLight ? '#fff' : 'rgba(0,0,0,0.4)'),
    centerStroke: css('--color-primary', isLight ? '#6d5bd0' : '#9b8cff'),
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

function nid(x: string | SimNode): string {
  return typeof x === 'object' ? x.id : x
}

function radius(d: SimNode): number {
  if (d.isCenter) return Math.max(7, Math.min(12, 6 + Math.sqrt(Math.max(0, d.degree)) * 1.4))
  return Math.max(4, Math.min(9, 3.5 + Math.sqrt(Math.max(0, d.degree)) * 1.2))
}

export const LocalGraphCanvas: React.FC = () => {
  const openTab = useEditorStore((s) => s.openTab)
  const activeTabPath = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.path)
  const activeTabTitle = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.title)
  const setActiveView = useWorkspaceStore((s) => s.setActiveView)
  const { fetchLocalGraph, setFocusedNode, graphSettings, loadGraphSettings, updateGraphSettings } =
    useGraphStore()
  const forcesRef = useRef<GraphForceSettings>({ ...DEFAULT_FORCE_SETTINGS })
  if (graphSettings?.forces) {
    forcesRef.current = { ...DEFAULT_FORCE_SETTINGS, ...graphSettings.forces }
  }

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null)
  const nodesRef = useRef<SimNode[]>([])
  const linksRef = useRef<SimLink[]>([])
  const transformRef = useRef(d3.zoomIdentity)
  const paletteRef = useRef(readPalette())
  const hoverIdRef = useRef<string | null>(null)
  const centerIdRef = useRef<string | null>(null)
  const rafRef = useRef(0)
  const dirtyRef = useRef(true)
  const posCache = useRef<
    Map<string, { x: number; y: number; fx?: number | null; fy?: number | null }>
  >(new Map())

  const defaultDepth = graphSettings?.filters.localDepth === 2 ? 2 : 1
  const [depth, setDepth] = useState<1 | 2>(defaultDepth as 1 | 2)
  const [showLabels, setShowLabels] = useState(true)
  const [collapsed, setCollapsed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState({ nodes: 0, edges: 0, centerTitle: '' })
  const [emptyReason, setEmptyReason] = useState<'no-file' | 'not-in-graph' | 'no-links' | null>(
    'no-file'
  )

  useEffect(() => {
    void loadGraphSettings()
  }, [loadGraphSettings])

  useEffect(() => {
    if (graphSettings?.filters.localDepth === 1 || graphSettings?.filters.localDepth === 2) {
      setDepth(graphSettings.filters.localDepth as 1 | 2)
    }
  }, [graphSettings?.filters.localDepth])

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w < 2 || h < 2) return
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
    const centerId = centerIdRef.current

    ctx.fillStyle = pal.bg
    ctx.fillRect(0, 0, w, h)

    if (simNodes.length === 0) {
      dirtyRef.current = false
      return
    }

    ctx.save()
    ctx.translate(t.x, t.y)
    ctx.scale(t.k, t.k)

    let hot: Set<string> | null = null
    if (hover) {
      hot = new Set([hover])
      for (const e of simLinks) {
        const s = nid(e.source)
        const tg = nid(e.target)
        if (s === hover) hot.add(tg)
        if (tg === hover) hot.add(s)
      }
    }

    ctx.lineCap = 'round'
    for (const e of simLinks) {
      const s = e.source as SimNode
      const tg = e.target as SimNode
      if (s.x == null || s.y == null || tg.x == null || tg.y == null) continue
      const isHot = hot
        ? (s.id === hover || tg.id === hover) && hot.has(s.id) && hot.has(tg.id)
        : false
      const dim = hot && !isHot
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(tg.x, tg.y)
      ctx.strokeStyle = isHot ? pal.edgeHot : pal.edge
      ctx.globalAlpha = dim ? 0.08 : 1
      ctx.lineWidth = (isHot ? 1.8 : 1.15) / t.k
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    for (const n of simNodes) {
      if (n.x == null || n.y == null) continue
      const r = radius(n)
      const col = pal.colors[n.type] || pal.colors.other
      const dim = hot && !hot.has(n.id)
      const isC = n.id === centerId || n.isCenter
      ctx.globalAlpha = dim ? (pal.isLight ? 0.18 : 0.12) : 1

      if (isC && !dim) {
        ctx.beginPath()
        ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2)
        ctx.fillStyle = pal.centerStroke
        ctx.globalAlpha = pal.isLight ? 0.2 : 0.25
        ctx.fill()
        ctx.globalAlpha = 1
      }

      ctx.beginPath()
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
      ctx.fillStyle = col
      ctx.fill()
      ctx.lineWidth = (isC ? 2.4 : n.id === hover ? 1.8 : 1) / t.k
      ctx.strokeStyle = isC ? pal.centerStroke : n.id === hover ? pal.edgeHot : pal.nodeStroke
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    if (showLabels) {
      ctx.font = `${Math.max(10, 11 / Math.sqrt(Math.max(0.5, t.k)))}px Inter,"Segoe UI Variable","Segoe UI",system-ui,sans-serif`
      ctx.textBaseline = 'middle'
      for (const n of simNodes) {
        if (n.x == null || n.y == null) continue
        if (hot && !hot.has(n.id) && n.id !== hover) continue
        const r = radius(n)
        const text = n.title.length > 20 ? n.title.slice(0, 19) + '…' : n.title
        const x = n.x + r + 5
        const y = n.y
        if (pal.isLight) {
          const tw = ctx.measureText(text).width
          ctx.fillStyle = pal.labelBg
          ctx.fillRect(x - 2, y - 7, tw + 4, 14)
        }
        ctx.fillStyle = n.id === centerId ? pal.centerStroke : pal.label
        ctx.globalAlpha = n.id === hover || n.id === centerId ? 1 : hot ? 0.85 : 0.78
        ctx.font =
          n.id === centerId
            ? `600 ${Math.max(10, 11 / Math.sqrt(Math.max(0.5, t.k)))}px Inter,"Segoe UI Variable","Segoe UI",system-ui,sans-serif`
            : `${Math.max(10, 11 / Math.sqrt(Math.max(0.5, t.k)))}px Inter,"Segoe UI Variable","Segoe UI",system-ui,sans-serif`
        ctx.fillText(text, x, y)
      }
      ctx.globalAlpha = 1
    }

    ctx.restore()
    dirtyRef.current = false
  }, [showLabels])

  const schedulePaint = useCallback(() => {
    dirtyRef.current = true
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      if (dirtyRef.current) paint()
    })
  }, [paint])

  useEffect(() => {
    const apply = () => {
      paletteRef.current = readPalette()
      dirtyRef.current = true
      schedulePaint()
    }
    apply()
    const obs = new MutationObserver(apply)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [schedulePaint])

  useEffect(() => {
    schedulePaint()
  }, [showLabels, schedulePaint])

  const hitNode = useCallback((clientX: number, clientY: number): SimNode | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const t = transformRef.current
    const x = (clientX - rect.left - t.x) / t.k
    const y = (clientY - rect.top - t.y) / t.k
    let best: SimNode | null = null
    let bestD = Infinity
    for (const n of nodesRef.current) {
      if (n.x == null || n.y == null) continue
      const dx = n.x - x
      const dy = n.y - y
      const d = dx * dx + dy * dy
      const r = radius(n) + 5
      if (d <= r * r && d < bestD) {
        best = n
        bestD = d
      }
    }
    return best
  }, [])

  const fitView = useCallback(
    (nodes: SimNode[], width: number, height: number) => {
      if (nodes.length === 0) {
        transformRef.current = d3.zoomIdentity
        return
      }
      const xs = nodes.map((n) => n.x || 0)
      const ys = nodes.map((n) => n.y || 0)
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)
      const gw = Math.max(maxX - minX, 40)
      const gh = Math.max(maxY - minY, 40)
      const pad = 36
      const k = Math.min((width - pad * 2) / gw, (height - pad * 2) / gh, 1.8)
      const tx = (width - k * (minX + maxX)) / 2
      const ty = (height - k * (minY + maxY)) / 2
      transformRef.current = d3.zoomIdentity.translate(tx, ty).scale(k)
      schedulePaint()
    },
    [schedulePaint]
  )

  // Load local graph when active file / depth changes
  useEffect(() => {
    if (!activeTabPath) {
      setEmptyReason('no-file')
      setStats({ nodes: 0, edges: 0, centerTitle: '' })
      nodesRef.current = []
      linksRef.current = []
      centerIdRef.current = null
      simRef.current?.stop()
      schedulePaint()
      return
    }

    let cancelled = false
    const t = window.setTimeout(() => {
      setLoading(true)
      void (async () => {
        const data = await fetchLocalGraph(activeTabPath, depth, false)
        if (cancelled) return
        setLoading(false)

        if (!data || !data.centerId) {
          setEmptyReason('not-in-graph')
          setStats({ nodes: 0, edges: 0, centerTitle: activeTabTitle || '' })
          nodesRef.current = []
          linksRef.current = []
          centerIdRef.current = null
          simRef.current?.stop()
          schedulePaint()
          return
        }

        const neighborCount = data.nodes.filter((n) => n.id !== data.centerId).length
        if (neighborCount === 0) {
          setEmptyReason('no-links')
        } else {
          setEmptyReason(null)
        }

        const wrap = wrapRef.current
        const width = wrap?.clientWidth || 400
        const height = wrap?.clientHeight || 200
        centerIdRef.current = data.centerId

        const simNodes: SimNode[] = data.nodes.map((n) => {
          const cached = posCache.current.get(n.id)
          const isCenter = n.id === data.centerId
          return {
            ...n,
            isCenter,
            x: cached?.x ?? width / 2 + (isCenter ? 0 : (Math.random() - 0.5) * 80),
            y: cached?.y ?? height / 2 + (isCenter ? 0 : (Math.random() - 0.5) * 60),
            fx: isCenter ? width / 2 : (cached?.fx ?? null),
            fy: isCenter ? height / 2 : (cached?.fy ?? null),
            pinned: isCenter || cached?.fx != null
          }
        })

        const idSet = new Set(simNodes.map((n) => n.id))
        const simLinks: SimLink[] = data.edges
          .filter((e) => idSet.has(e.source) && idSet.has(e.target))
          .map((e) => ({
            id: e.id,
            type: e.type,
            source: e.source,
            target: e.target
          }))

        nodesRef.current = simNodes
        linksRef.current = simLinks
        setStats({
          nodes: data.nodeCount,
          edges: data.edgeCount,
          centerTitle: simNodes.find((n) => n.isCenter)?.title || activeTabTitle || ''
        })

        // Phase 6: use global force prefs (scaled for mini local canvas)
        const f = forcesRef.current
        const linkDist = Math.max(36, Math.min(100, f.linkDist * 0.82))
        const charge = Math.max(-160, Math.min(-30, f.charge * 0.78))
        const centerStr = Math.min(0.15, Math.max(0.04, f.center * 1.15))
        const linkStr = Math.min(0.9, Math.max(0.2, f.linkStr))
        const collideStr = Math.min(1, Math.max(0.2, f.collide))

        simRef.current?.stop()
        const sim = d3
          .forceSimulation<SimNode>(simNodes)
          .force(
            'link',
            d3
              .forceLink<SimNode, SimLink>(simLinks)
              .id((d) => d.id)
              .distance(linkDist)
              .strength(linkStr)
          )
          .force(
            'charge',
            d3
              .forceManyBody()
              .strength(charge)
              .distanceMax(Math.max(120, linkDist * 2.5))
              .theta(0.9)
          )
          .force('center', d3.forceCenter(width / 2, height / 2).strength(centerStr))
          .force('x', d3.forceX(width / 2).strength(centerStr * 0.65))
          .force('y', d3.forceY(height / 2).strength(centerStr * 0.65))
          .force(
            'collide',
            d3
              .forceCollide<SimNode>()
              .radius((d) => radius(d) + 6)
              .strength(collideStr)
              .iterations(1)
          )
          .velocityDecay(0.4)
          .alphaDecay(0.06)
          .alphaMin(0.03)
          .alpha(0.6)

        simRef.current = sim
        let tick = 0
        sim.on('tick', () => {
          tick++
          // Keep center soft-pinned to middle while sim runs (Obsidian local feel)
          const c = simNodes.find((n) => n.isCenter)
          if (c && c.fx == null) {
            c.x = width / 2
            c.y = height / 2
          }
          if (tick % 2 === 0 || sim.alpha() < 0.06) schedulePaint()
          if (tick % 12 === 0) {
            for (const n of simNodes) {
              if (n.x != null && n.y != null) {
                posCache.current.set(n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy })
              }
            }
          }
        })
        sim.on('end', () => {
          for (const n of simNodes) {
            if (n.x != null && n.y != null) {
              posCache.current.set(n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy })
            }
          }
          fitView(simNodes, width, height)
        })
        schedulePaint()
      })()
    }, 80)

    return () => {
      cancelled = true
      window.clearTimeout(t)
      simRef.current?.stop()
    }
    // Rebuild when note/depth/forces change (forces from global settings Phase 6)
  }, [
    activeTabPath,
    activeTabTitle,
    depth,
    fetchLocalGraph,
    schedulePaint,
    fitView,
    graphSettings?.forces?.charge,
    graphSettings?.forces?.linkDist,
    graphSettings?.forces?.linkStr,
    graphSettings?.forces?.center,
    graphSettings?.forces?.collide
  ])

  // Pointer interactions
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || collapsed) return

    let panning = false
    let panLast = { x: 0, y: 0 }
    let dragged: SimNode | null = null
    let moved = false

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const t = transformRef.current
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      const nextK = Math.max(0.35, Math.min(3.5, t.k * factor))
      const x = mx - ((mx - t.x) * nextK) / t.k
      const y = my - ((my - t.y) * nextK) / t.k
      transformRef.current = d3.zoomIdentity.translate(x, y).scale(nextK)
      schedulePaint()
    }

    const onDown = (e: PointerEvent) => {
      moved = false
      const hit = hitNode(e.clientX, e.clientY)
      if (hit && e.button === 0) {
        dragged = hit
        if (!hit.isCenter) {
          hit.fx = hit.x
          hit.fy = hit.y
        }
        simRef.current?.alphaTarget(0.12).restart()
        canvas.setPointerCapture(e.pointerId)
      } else if (e.button === 0) {
        panning = true
        panLast = { x: e.clientX, y: e.clientY }
        canvas.setPointerCapture(e.pointerId)
      }
    }

    const onMove = (e: PointerEvent) => {
      if (dragged && !dragged.isCenter) {
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
      const hit = hitNode(e.clientX, e.clientY)
      const next = hit?.id || null
      if (next !== hoverIdRef.current) {
        hoverIdRef.current = next
        schedulePaint()
        canvas.style.cursor = hit ? 'pointer' : 'grab'
      }
    }

    const onUp = (e: PointerEvent) => {
      if (dragged) {
        const d = dragged
        if (!moved && d.path && !d.isCenter) {
          void openTab(d.path)
          // openTab already switches to editor view
        } else if (moved && !d.isCenter) {
          d.pinned = true
          posCache.current.set(d.id, { x: d.x!, y: d.y!, fx: d.fx, fy: d.fy })
        }
        simRef.current?.alphaTarget(0)
        dragged = null
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
      if (!hit || hit.isCenter) return
      hit.fx = null
      hit.fy = null
      hit.pinned = false
      posCache.current.set(hit.id, { x: hit.x!, y: hit.y!, fx: null, fy: null })
      simRef.current?.alpha(0.25).restart()
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('dblclick', onDbl)
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('dblclick', onDbl)
    }
  }, [collapsed, hitNode, openTab, schedulePaint])

  // Resize
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let t: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        const sim = simRef.current
        const w = el.clientWidth
        const h = el.clientHeight
        if (sim) {
          sim.force('center', d3.forceCenter(w / 2, h / 2).strength(0.08))
          const c = nodesRef.current.find((n) => n.isCenter)
          if (c) {
            c.fx = w / 2
            c.fy = h / 2
          }
          sim.alpha(0.08).restart()
        }
        schedulePaint()
      }, 80)
    })
    ro.observe(el)
    return () => {
      if (t) clearTimeout(t)
      ro.disconnect()
    }
  }, [schedulePaint])

  const openInGlobal = () => {
    const cid = centerIdRef.current
    if (cid) setFocusedNode(cid)
    setActiveView('graph')
  }

  const handleFit = () => {
    const el = wrapRef.current
    if (!el) return
    fitView(nodesRef.current, el.clientWidth, el.clientHeight)
  }

  if (!activeTabPath) return null

  return (
    <div className={`local-graph ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="local-graph-toolbar">
        <button
          type="button"
          className="local-graph-toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand local graph' : 'Collapse local graph'}
        >
          <Icon name="graph" size={13} />
          <span>Local graph</span>
          {!collapsed && stats.nodes > 0 && (
            <span className="local-graph-stats">
              {stats.nodes} notes · {stats.edges} links
              {loading ? ' · …' : ''}
            </span>
          )}
        </button>

        {!collapsed && (
          <div className="local-graph-actions">
            <div className="local-graph-depth" role="group" aria-label="Depth">
              <button
                type="button"
                className={`local-graph-chip ${depth === 1 ? 'active' : ''}`}
                onClick={() => {
                  setDepth(1)
                  // Phase 6 debt: persist preferred local depth
                  void updateGraphSettings({
                    filters: {
                      localDepth: 1,
                      hubDegreeThreshold: graphSettings?.filters.hubDegreeThreshold ?? 15,
                      orphanMode: graphSettings?.filters.orphanMode ?? 'all',
                      hubMode: graphSettings?.filters.hubMode ?? 'dim'
                    }
                  })
                }}
              >
                Depth 1
              </button>
              <button
                type="button"
                className={`local-graph-chip ${depth === 2 ? 'active' : ''}`}
                onClick={() => {
                  setDepth(2)
                  void updateGraphSettings({
                    filters: {
                      localDepth: 2,
                      hubDegreeThreshold: graphSettings?.filters.hubDegreeThreshold ?? 15,
                      orphanMode: graphSettings?.filters.orphanMode ?? 'all',
                      hubMode: graphSettings?.filters.hubMode ?? 'dim'
                    }
                  })
                }}
              >
                Depth 2
              </button>
            </div>
            <label className="local-graph-check">
              <input
                type="checkbox"
                checked={showLabels}
                onChange={(e) => setShowLabels(e.target.checked)}
              />
              Labels
            </label>
            <button type="button" className="local-graph-chip" onClick={handleFit} title="Fit">
              Fit
            </button>
            <button
              type="button"
              className="local-graph-chip"
              onClick={openInGlobal}
              title="Open center in global graph"
              disabled={!centerIdRef.current}
            >
              Global
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="local-graph-body" ref={wrapRef}>
          {emptyReason === 'no-file' && (
            <div className="local-graph-empty">Buka sebuah note untuk melihat local graph.</div>
          )}
          {emptyReason === 'not-in-graph' && (
            <div className="local-graph-empty">
              Note belum terindeks di graph. Simpan file .md di vault, atau tunggu index selesai.
            </div>
          )}
          {emptyReason === 'no-links' && (
            <div className="local-graph-empty local-graph-empty--soft">
              Belum ada koneksi wikilink. Tambah <code>[[Note]]</code> ke / dari note ini.
              {stats.centerTitle ? (
                <>
                  {' '}
                  Center: <strong>{stats.centerTitle}</strong>
                </>
              ) : null}
            </div>
          )}
          <canvas
            ref={canvasRef}
            className="local-graph-canvas"
            style={{
              // Keep canvas visible for center-only (no-links); hide only when no graph data
              opacity: emptyReason === 'no-file' || emptyReason === 'not-in-graph' ? 0 : 1,
              pointerEvents:
                emptyReason === 'not-in-graph' || emptyReason === 'no-file' ? 'none' : 'auto'
            }}
          />
        </div>
      )}
    </div>
  )
}

// re-export alias used by editor
export const LocalGraphView = LocalGraphCanvas
