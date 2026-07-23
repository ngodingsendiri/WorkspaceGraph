/**
 * Local graph — Obsidian-style mini canvas under the editor.
 * Data: graph:getLocal (center + neighbors, depth 1–5, wiki edges by default).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import { useEditorStore } from '../../store/editorStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGraphStore, GraphNodeData, type GraphForceSettings } from '../../store/graphStore'
import { Icon } from '../ui/Icons'
import { DEFAULT_FORCE_SETTINGS } from './GraphFiltersPanel'
import { chargeFor, linkDistanceFor, nodeRadius } from './graphShared'

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
      other: css('--node-default', '#7a8494'),
      tag: css('--node-tag', isLight ? '#b8860b' : '#e0b84a'),
      ghost: css('--node-ghost', isLight ? 'rgba(90,100,120,0.55)' : 'rgba(160,170,190,0.45)'),
      attachment: css('--node-attachment', isLight ? '#5a8a6a' : '#6ab88a')
    }
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function nid(x: string | SimNode): string {
  return typeof x === 'object' ? x.id : x
}

function radius(d: SimNode): number {
  if (d.isCenter) return Math.max(7, Math.min(12, nodeRadius(d.degree, 1.15)))
  return Math.max(4, Math.min(9, nodeRadius(d.degree, 0.95)))
}

export const LocalGraphCanvas: React.FC = () => {
  const openTab = useEditorStore((s) => s.openTab)
  const activeTabPath = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.path)
  const activeTabTitle = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.title)
  const setActiveView = useWorkspaceStore((s) => s.setActiveView)
  const {
    fetchLocalGraph,
    setFocusedNode,
    setOpenIntent,
    graphSettings,
    loadGraphSettings,
    updateGraphSettings
  } = useGraphStore()
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
  const hoverStrengthRef = useRef(0)
  const hoverAnimRafRef = useRef(0)
  const centerIdRef = useRef<string | null>(null)
  const rafRef = useRef(0)
  const dirtyRef = useRef(true)
  const posCache = useRef<
    Map<string, { x: number; y: number; fx?: number | null; fy?: number | null }>
  >(new Map())

  const clampDepth = (d: number): number => Math.min(5, Math.max(1, Math.floor(d) || 1))
  const defaultDepth = clampDepth(graphSettings?.filters.localDepth ?? 1)
  const [depth, setDepth] = useState(defaultDepth)
  const [showLabels, setShowLabels] = useState(true)
  const [includeTags, setIncludeTags] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState({ nodes: 0, edges: 0, centerTitle: '' })
  const [emptyReason, setEmptyReason] = useState<'no-file' | 'not-in-graph' | 'no-links' | null>(
    'no-file'
  )
  const [reloadToken, setReloadToken] = useState(0)

  const persistDepth = useCallback(
    (d: number) => {
      void updateGraphSettings({
        filters: {
          localDepth: d,
          hubDegreeThreshold: graphSettings?.filters.hubDegreeThreshold ?? 15,
          orphanMode: graphSettings?.filters.orphanMode ?? 'all',
          hubMode: graphSettings?.filters.hubMode ?? 'dim',
          searchMode: graphSettings?.filters.searchMode ?? 'spotlight'
        }
      })
    },
    [updateGraphSettings, graphSettings?.filters]
  )

  useEffect(() => {
    void loadGraphSettings()
  }, [loadGraphSettings])

  useEffect(() => {
    const d = graphSettings?.filters.localDepth
    if (typeof d === 'number' && d >= 1 && d <= 5) {
      setDepth(clampDepth(d))
    }
  }, [graphSettings?.filters.localDepth])

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // Prefer wrap size — canvas.clientWidth is often 0 until layout settles
    let w = Math.floor(Math.max(canvas.clientWidth, wrap?.clientWidth || 0, 0))
    let h = Math.floor(Math.max(canvas.clientHeight, wrap?.clientHeight || 0, 0))
    if (w < 8 || h < 8) {
      w = Math.max(280, Math.floor((wrap?.parentElement?.clientWidth || 400) * 0.95))
      h = Math.max(140, 180)
    }
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
    }
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
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

    const hs = hoverStrengthRef.current
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

    ctx.lineCap = 'round'
    for (const e of simLinks) {
      const s = e.source as SimNode
      const tg = e.target as SimNode
      if (s.x == null || s.y == null || tg.x == null || tg.y == null) continue
      const isHot = hot
        ? (s.id === hover || tg.id === hover) && hot.has(s.id) && hot.has(tg.id)
        : false
      const dim = Boolean(hot && !isHot)
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(tg.x, tg.y)
      ctx.strokeStyle = isHot && hs > 0.35 ? pal.edgeHot : pal.edge
      ctx.globalAlpha = dim ? lerp(1, 0.22, hs) : 1
      ctx.lineWidth = (isHot ? lerp(1.15, 1.85, hs) : e.type === 'tag' ? 0.9 : 1.15) / t.k
      if (e.type === 'tag') ctx.setLineDash([3 / t.k, 3 / t.k])
      else ctx.setLineDash([])
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    for (const n of simNodes) {
      if (n.x == null || n.y == null) continue
      const r = radius(n)
      const isTag = n.isTag || n.type === 'tag'
      const isGhost = n.isGhost || n.type === 'ghost'
      const col = isTag
        ? pal.colors.tag
        : isGhost
          ? pal.colors.ghost
          : pal.colors[n.type] || pal.colors.other
      const dim = Boolean(hot && !hot.has(n.id))
      const isC = n.id === centerId || n.isCenter
      ctx.globalAlpha = dim ? lerp(1, pal.isLight ? 0.28 : 0.2, hs) : 1

      if (isC && !dim) {
        ctx.beginPath()
        ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2)
        ctx.fillStyle = pal.centerStroke
        ctx.globalAlpha = (pal.isLight ? 0.2 : 0.25) * (dim ? 0.3 : 1)
        ctx.fill()
        ctx.globalAlpha = dim ? lerp(1, 0.25, hs) : 1
      }

      ctx.beginPath()
      if (isTag) {
        const d = r * 1.1
        ctx.moveTo(n.x, n.y - d)
        ctx.lineTo(n.x + d, n.y)
        ctx.lineTo(n.x, n.y + d)
        ctx.lineTo(n.x - d, n.y)
        ctx.closePath()
        ctx.fillStyle = col
        ctx.fill()
      } else if (isGhost) {
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = pal.isLight ? 'rgba(255,255,255,0.4)' : 'rgba(20,22,28,0.4)'
        ctx.fill()
        ctx.setLineDash([2 / t.k, 2 / t.k])
        ctx.strokeStyle = col
        ctx.lineWidth = 1.4 / t.k
        ctx.stroke()
        ctx.setLineDash([])
      } else {
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = col
        ctx.fill()
      }
      if (!isGhost) {
        ctx.lineWidth = (isC ? 2.4 : n.id === hover ? lerp(1, 1.8, hs) : 1) / t.k
        ctx.strokeStyle =
          isC ? pal.centerStroke : n.id === hover && hs > 0.4 ? pal.edgeHot : pal.nodeStroke
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

    if (showLabels) {
      // Screen-space labels (readable at any zoom)
      ctx.restore()
      ctx.save()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const fontPx = 11
      ctx.font = `${fontPx}px Inter,"Segoe UI Variable","Segoe UI",system-ui,sans-serif`
      ctx.textBaseline = 'middle'
      for (const n of simNodes) {
        if (n.x == null || n.y == null) continue
        if (hot && !hot.has(n.id) && n.id !== hover) continue
        const rWorld = radius(n)
        const titleStr = String(n.title || n.id || '')
        const text = titleStr.length > 22 ? titleStr.slice(0, 21) + '…' : titleStr
        const sx = n.x * t.k + t.x + rWorld * t.k + 5
        const sy = n.y * t.k + t.y
        const labelA =
          n.id === hover || n.id === centerId ? 1 : hot ? lerp(0.85, 0.9, hs) : 0.82
        if (pal.isLight && labelA > 0.3) {
          const tw = ctx.measureText(text).width
          ctx.fillStyle = pal.labelBg
          ctx.globalAlpha = labelA * 0.9
          ctx.fillRect(sx - 2, sy - 7, tw + 4, 14)
        }
        ctx.fillStyle = n.id === centerId ? pal.centerStroke : pal.label
        ctx.globalAlpha = labelA
        ctx.font =
          n.id === centerId
            ? `600 ${fontPx}px Inter,"Segoe UI Variable","Segoe UI",system-ui,sans-serif`
            : `${fontPx}px Inter,"Segoe UI Variable","Segoe UI",system-ui,sans-serif`
        ctx.fillText(text, sx, sy)
      }
      ctx.globalAlpha = 1
      ctx.restore()
      dirtyRef.current = false
      return
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

  const kickHoverAnim = useCallback(() => {
    if (hoverAnimRafRef.current) return
    const step = () => {
      const target = hoverIdRef.current ? 1 : 0
      const cur = hoverStrengthRef.current
      const rate = target > cur ? 0.3 : 0.2
      const next = cur + (target - cur) * rate
      if (Math.abs(next - target) < 0.015) {
        hoverStrengthRef.current = target
        hoverAnimRafRef.current = 0
        schedulePaint()
        return
      }
      hoverStrengthRef.current = next
      schedulePaint()
      hoverAnimRafRef.current = requestAnimationFrame(step)
    }
    hoverAnimRafRef.current = requestAnimationFrame(step)
  }, [schedulePaint])

  const setHoverId = useCallback(
    (id: string | null) => {
      if (hoverIdRef.current === id) return
      hoverIdRef.current = id
      if (id && hoverStrengthRef.current < 0.5) {
        hoverStrengthRef.current = Math.max(hoverStrengthRef.current, 0.5)
      }
      kickHoverAnim()
    },
    [kickHoverAnim]
  )

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

  // Live reload when vault graph updates
  useEffect(() => {
    if (!window.api?.onGraphUpdated) return
    const unsub = window.api.onGraphUpdated(() => {
      setReloadToken((n) => n + 1)
    })
    return () => {
      unsub()
      if (hoverAnimRafRef.current) cancelAnimationFrame(hoverAnimRafRef.current)
    }
  }, [])

  const hitNode = useCallback((clientX: number, clientY: number): SimNode | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width < 2) return null
    const t = transformRef.current
    const x = (clientX - rect.left - t.x) / t.k
    const y = (clientY - rect.top - t.y) / t.k
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
      const pad = n.id === stickyId ? 12 : 5
      const r = radius(n) + pad
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
      if (bestD < stickyD * 0.55) return best
      return sticky
    }
    return sticky || best
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
        const data = await fetchLocalGraph(activeTabPath, depth, includeTags)
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
          .map((e) => {
            const source = typeof e.source === 'string' ? e.source : String((e as { source?: string }).source || '')
            const target = typeof e.target === 'string' ? e.target : String((e as { target?: string }).target || '')
            return { e, source, target }
          })
          .filter(({ source, target }) => source && target && idSet.has(source) && idSet.has(target))
          .map(({ e, source, target }) => ({
            id: e.id || `${source}->${target}`,
            type: e.type || 'wiki_link',
            source,
            target
          }))

        nodesRef.current = simNodes
        linksRef.current = simLinks
        setStats({
          nodes: data.nodeCount,
          edges: data.edgeCount,
          centerTitle: simNodes.find((n) => n.isCenter)?.title || activeTabTitle || ''
        })

        // Global force prefs scaled for mini local canvas (Obsidian local feel)
        const f = forcesRef.current
        const linkDist = Math.max(36, Math.min(110, f.linkDist * 0.82))
        const centerStr = Math.min(0.15, Math.max(0.04, f.center * 1.15))
        const linkStr = Math.min(0.9, Math.max(0.2, f.linkStr))
        const collideStr = Math.min(1, Math.max(0.2, f.collide))
        const baseCharge = Math.max(-180, Math.min(-28, f.charge * 0.78))

        simRef.current?.stop()
        const sim = d3
          .forceSimulation<SimNode>(simNodes)
          .force(
            'link',
            d3
              .forceLink<SimNode, SimLink>(simLinks)
              .id((d) => d.id)
              .distance((l) => {
                const s = l.source as SimNode
                const t = l.target as SimNode
                const sd = typeof s === 'object' ? s.degree || 0 : 0
                const td = typeof t === 'object' ? t.degree || 0 : 0
                return linkDistanceFor(sd, td, linkDist)
              })
              .strength(linkStr)
          )
          .force(
            'charge',
            d3
              .forceManyBody<SimNode>()
              .strength((d) => chargeFor(d.degree || 0, baseCharge, simNodes.length > 40))
              .distanceMax(Math.max(140, linkDist * 3))
              .theta(0.9)
          )
          .force('center', d3.forceCenter(width / 2, height / 2).strength(centerStr))
          .force('x', d3.forceX(width / 2).strength(centerStr * 0.55))
          .force('y', d3.forceY(height / 2).strength(centerStr * 0.55))
          .force(
            'collide',
            d3
              .forceCollide<SimNode>()
              .radius((d) => radius(d) + 6)
              .strength(collideStr)
              .iterations(2)
          )
          .velocityDecay(0.38)
          .alphaDecay(0.05)
          .alphaMin(0.025)
          .alpha(0.55)

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
    includeTags,
    reloadToken,
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
        setHoverId(next)
        canvas.style.cursor = hit ? 'pointer' : 'grab'
      }
    }

    const onUp = (e: PointerEvent) => {
      if (dragged) {
        const d = dragged
        if (!moved) {
          if ((d.isTag || d.type === 'tag') && !d.isCenter) {
            // Open global graph filtered to this tag
            setOpenIntent({
              searchQuery: (d.title || '').replace(/^#/, ''),
              searchMode: 'filter',
              showTags: true,
              focusNodeId: d.id
            })
            setActiveView('graph')
          } else if (
            (d.isAttachment || d.type === 'attachment') &&
            d.path &&
            window.api?.openFileExternal
          ) {
            void window.api.openFileExternal(d.path)
          } else if (d.path && !d.isCenter && !d.isGhost) {
            void openTab(d.path)
          }
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

    const onLeave = () => setHoverId(null)

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
  }, [collapsed, hitNode, openTab, schedulePaint, setHoverId, setOpenIntent, setActiveView])

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
    if (cid) {
      setFocusedNode(cid)
      setOpenIntent({ focusNodeId: cid })
    }
    setActiveView('graph')
  }

  const handleFit = () => {
    const el = wrapRef.current
    if (!el) return
    fitView(nodesRef.current, el.clientWidth, el.clientHeight)
  }

  const zoomBy = (factor: number) => {
    const el = wrapRef.current
    if (!el) return
    const cx = el.clientWidth / 2
    const cy = el.clientHeight / 2
    const t = transformRef.current
    const nextK = Math.max(0.35, Math.min(3.5, t.k * factor))
    const x = cx - ((cx - t.x) * nextK) / t.k
    const y = cy - ((cy - t.y) * nextK) / t.k
    transformRef.current = d3.zoomIdentity.translate(x, y).scale(nextK)
    schedulePaint()
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
              {([1, 2, 3, 4, 5] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`local-graph-chip ${depth === d ? 'active' : ''}`}
                  title={`Local graph depth ${d}`}
                  onClick={() => {
                    setDepth(d)
                    persistDepth(d)
                  }}
                >
                  {d === 1 ? 'D1' : `D${d}`}
                </button>
              ))}
            </div>
            <label className="local-graph-check">
              <input
                type="checkbox"
                checked={showLabels}
                onChange={(e) => setShowLabels(e.target.checked)}
              />
              Labels
            </label>
            <label className="local-graph-check" title="Sertakan edge/tag nodes">
              <input
                type="checkbox"
                checked={includeTags}
                onChange={(e) => setIncludeTags(e.target.checked)}
              />
              Tags
            </label>
            <button
              type="button"
              className="local-graph-chip"
              onClick={() => zoomBy(1.15)}
              title="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              className="local-graph-chip"
              onClick={() => zoomBy(1 / 1.15)}
              title="Zoom out"
            >
              −
            </button>
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
