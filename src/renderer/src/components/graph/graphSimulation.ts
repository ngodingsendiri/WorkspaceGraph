/**
 * useGraphSimulation — d3-force simulation lifecycle extracted from the
 * GraphCanvas monolith.
 *
 * Owns the simulation state (simRef/nodesRef/linksRef/posCache/spatial hash)
 * and re-creates / soft-merges the force simulation when the filtered graph
 * changes. Behavior is a verbatim move of the monolith's effects; it receives
 * the mutable refs the render/interaction layers still own (view flags, forces,
 * camera fit, interactive-canvas) so nothing re-binds mid-gesture.
 */
import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import * as d3 from 'd3'
import type { GraphNodeData, GraphEdgeData, GraphForceSettings } from '../../store/graphStore'
import type { SimNode, SimLink } from './graphTypes'
import { OBSIDIAN_SIM, resolveLod, SpatialHash2D, safeTags } from './graphShared'
import { applyForces, spiralSeed } from './graphQuery'
import type { ColorByMode } from './GraphFiltersPanel'

/** Paint/view flags shared between the render pipeline and the simulation. */
export interface GraphViewFlags {
  searchMatchIds: Set<string> | null
  dimHubs: boolean
  hubThreshold: number
  focusedId: string | null
  pathNodeIds: Set<string> | null
  pathEdgeKeys: Set<string> | null
  pathFromId: string
  pathToId: string
  focusNodeIds: Set<string> | null
  focusEdgeKeys: Set<string> | null
  colorBy: ColorByMode
  perfMode: 'auto' | 'quality' | 'speed'
  selectedIds: Set<string> | null
  arrows: boolean
  textFade: number
  nodeSize: number
  lineThickness: number
  groupColors: Map<string, string> | null
}

export interface GraphSimulation {
  simRef: MutableRefObject<d3.Simulation<SimNode, SimLink> | null>
  nodesRef: MutableRefObject<SimNode[]>
  linksRef: MutableRefObject<SimLink[]>
  posCache: MutableRefObject<
    Map<string, { x: number; y: number; fx?: number | null; fy?: number | null }>
  >
  spatialRef: MutableRefObject<SpatialHash2D<SimNode>>
  spatialDirtyRef: MutableRefObject<boolean>
  lastSizeRef: MutableRefObject<{ w: number; h: number }>
}

export function useGraphSimulation(opts: {
  filteredNodes: GraphNodeData[]
  filteredEdges: GraphEdgeData[]
  layoutNodes: Record<string, { x: number; y: number; pinned?: boolean }>
  canvasRef: RefObject<HTMLCanvasElement | null>
  wrapRef: RefObject<HTMLDivElement | null>
  forcesRef: MutableRefObject<GraphForceSettings>
  viewFlagsRef: MutableRefObject<GraphViewFlags>
  displayOptsNodeSize: number
  forces: GraphForceSettings
  animateForces: boolean
  animateForcesRef: MutableRefObject<boolean>
  pointerGestureRef: MutableRefObject<boolean>
  interactiveCanvasRef: MutableRefObject<boolean>
  drawCanvas2DRef: MutableRefObject<() => void>
  canAutoFitCamera: () => boolean
  hasAutoFitRef: MutableRefObject<boolean>
  fitViewRef: MutableRefObject<
    ((animate: boolean, onlyIds?: Set<string> | null, opts?: { silent?: boolean }) => void) | null
  >
  ensureGraphVisibleRef: MutableRefObject<(reason?: string) => boolean>
  syncCanvasSize: () => { w: number; h: number; ready: boolean }
  schedulePaint: () => void
  setStats: (s: { nodes: number; edges: number }) => void
  setPinnedCount: (n: number) => void
}): GraphSimulation {
  const {
    filteredNodes,
    filteredEdges,
    layoutNodes,
    canvasRef,
    wrapRef,
    forcesRef,
    viewFlagsRef,
    displayOptsNodeSize,
    forces,
    animateForces,
    animateForcesRef,
    pointerGestureRef,
    interactiveCanvasRef,
    drawCanvas2DRef,
    canAutoFitCamera,
    hasAutoFitRef,
    fitViewRef,
    ensureGraphVisibleRef,
    syncCanvasSize,
    schedulePaint,
    setStats,
    setPinnedCount
  } = opts

  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null)
  const nodesRef = useRef<SimNode[]>([])
  const linksRef = useRef<SimLink[]>([])
  const posCache = useRef<
    Map<string, { x: number; y: number; fx?: number | null; fy?: number | null }>
  >(new Map())
  const spatialRef = useRef(new SpatialHash2D<SimNode>(56))
  const spatialDirtyRef = useRef(true)
  const lastSizeRef = useRef({ w: 0, h: 0 })

  /** Unmount: stop simulation */
  useEffect(() => {
    return () => {
      simRef.current?.stop()
      simRef.current = null
    }
  }, [])

  /** Build / soft-merge simulation when filtered graph data changes. */
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
            fitViewRef.current?.(false)
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
          fitViewRef.current?.(false)
        }
        requestAnimationFrame(() => {
          if (!pointerGestureRef.current && !animateForcesRef.current)
            ensureGraphVisibleRef.current('sim-end')
        })
        // Obsidian-like continuous gentle motion
        if (animateForcesRef.current) {
          activeSim.alphaTarget(OBSIDIAN_SIM.animateAlphaTarget).restart()
        }
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

  /** Phase 3: live-update forces without full node rebuild */
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
    // viewFlags/wrap are read via refs to avoid rebuilding the sim effect on
    // every render; forces array is the only real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forces, schedulePaint])

  /** Obsidian-like: node size knob updates collide radius without full rebuild */
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
      displayOptsNodeSize || 1
    )
    sim.alpha(Math.max(sim.alpha(), 0.12)).restart()
    schedulePaint()
    // forcesRef/wrapRef are imperative; node-size knob is the only real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayOptsNodeSize, schedulePaint])

  /** Obsidian "Animate" — gentle continuous forces when on */
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

  return {
    simRef,
    nodesRef,
    linksRef,
    posCache,
    spatialRef,
    spatialDirtyRef,
    lastSizeRef
  }
}
