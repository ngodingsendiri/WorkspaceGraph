/**
 * useGraphInteraction — pointer interaction layer extracted from the
 * GraphCanvas monolith:
 *  - sticky hover hit-test (SpatialHash2D on large graphs)
 *  - imperative DOM tooltip (no React setState per pointermove)
 *  - hover-strength easing (soft Obsidian dim, no hard blink)
 *  - unified pointer gesture engine (pan / node-drag / pinch / ctrl-select /
 *    shift-path / alt-focus / wheel-zoom / dblclick-unpin / context menu)
 */
import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import * as d3 from 'd3'
import type { SimNode } from './graphTypes'
import { OBSIDIAN_SIM, radius, safeTags, escapeHtml } from './graphShared'
import type { GraphSimulation, GraphViewFlags } from './graphSimulation'

export interface GraphInteractionApi {
  activeView: string
  wrapRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  sim: GraphSimulation
  transformRef: MutableRefObject<d3.ZoomTransform>
  viewFlagsRef: MutableRefObject<GraphViewFlags>
  pointerGestureRef: MutableRefObject<boolean>
  interactiveCanvasRef: MutableRefObject<boolean>
  drawCanvas2DRef: MutableRefObject<() => void>
  wheelDebounceRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  saveLayoutTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>
  saveLayoutPositions: (
    patch: Record<string, { x: number; y: number; pinned?: boolean }>,
    replaceAll: boolean
  ) => Promise<unknown>
  setCameraTransformRef: MutableRefObject<
    (t: d3.ZoomTransform, opts?: { user?: boolean; save?: boolean }) => void
  >
  scheduleSaveCameraRef: MutableRefObject<() => void>
  showInteractiveCanvas: () => void
  hideInteractiveCanvas: () => void
  paintFnRef: MutableRefObject<() => void>
  schedulePaint: () => void
  setCtxMenu: (m: { x: number; y: number; node: SimNode } | null) => void
  setSelectedIds: (fn: (prev: Set<string>) => Set<string>) => void
  setPathFromId: (id: string) => void
  setPathToId: (id: string) => void
  setPathNodeIds: (ids: Set<string> | null) => void
  setPathEdgeKeys: (keys: Set<string> | null) => void
  setPathStatus: (s: string | null) => void
  setSearchQuery: (q: string) => void
  setSearchMode: (m: 'spotlight' | 'filter') => void
  setPinnedCount: (n: number) => void
  setFocusNodeIds: (ids: Set<string> | null) => void
  setFocusEdgeKeys: (keys: Set<string> | null) => void
  findPath: (
    from: string,
    to: string,
    includeTagEdges?: boolean
  ) => Promise<{
    found: boolean
    length: number
    nodeIds: string[]
    edgeKeys: string[]
  } | null>
  fetchNeighborhood: (
    id: string,
    depth?: number
  ) => Promise<{
    ids: string[]
    edgeKeys: string[]
  } | null>
  openTab: (path: string) => Promise<unknown>
  setActiveView: (view: 'welcome' | 'dashboard' | 'editor' | 'graph' | 'settings') => void
  showTagEdgesRef: MutableRefObject<boolean>
  focusDepthRef: MutableRefObject<number>
  animateForcesRef: MutableRefObject<boolean>
  /** User has panned/zoomed this visit — suppress auto-fit */
  userCameraTouchedRef: MutableRefObject<boolean>
  /** Camera restored from vault layout / named view */
  cameraHydratedRef: MutableRefObject<boolean>
  /** Shift-path selection anchors (live, kept in refs by parent) */
  pathFromIdRef: MutableRefObject<string>
  pathToIdRef: MutableRefObject<string>
  fitViewRef: MutableRefObject<
    ((animate: boolean, onlyIds?: Set<string> | null, opts?: { silent?: boolean }) => void) | null
  >
}

export interface GraphInteraction {
  hoverIdRef: MutableRefObject<string | null>
  hoverStrengthRef: MutableRefObject<number>
  setHoverId: (id: string | null) => void
  tooltipElRef: RefObject<HTMLDivElement | null>
  dragIdRef: MutableRefObject<string | null>
}

export function useGraphInteraction(api: GraphInteractionApi): GraphInteraction {
  const {
    activeView,
    wrapRef,
    canvasRef,
    sim,
    transformRef,
    viewFlagsRef,
    pointerGestureRef,
    interactiveCanvasRef,
    drawCanvas2DRef,
    wheelDebounceRef,
    saveLayoutTimer,
    saveLayoutPositions,
    setCameraTransformRef,
    scheduleSaveCameraRef,
    showInteractiveCanvas,
    hideInteractiveCanvas,
    paintFnRef,
    schedulePaint,
    setCtxMenu,
    setSelectedIds,
    setPathFromId,
    setPathToId,
    setPathNodeIds,
    setPathEdgeKeys,
    setPathStatus,
    setSearchQuery,
    setSearchMode,
    setPinnedCount,
    setFocusNodeIds,
    setFocusEdgeKeys,
    findPath,
    fetchNeighborhood,
    openTab,
    setActiveView,
    showTagEdgesRef,
    focusDepthRef,
    animateForcesRef,
    fitViewRef,
    userCameraTouchedRef,
    cameraHydratedRef,
    pathFromIdRef,
    pathToIdRef
  } = api
  const { simRef, nodesRef, posCache, spatialRef, spatialDirtyRef } = sim

  /** 0..1 animated dim strength — avoids hard blink on hover enter/leave */
  const hoverStrengthRef = useRef(0)
  const hoverAnimRafRef = useRef(0)
  const hoverIdRef = useRef<string | null>(null)
  const dragIdRef = useRef<string | null>(null)
  /** DOM tooltip — avoid React setState on every hover (was causing blink/rebind) */
  const tooltipElRef = useRef<HTMLDivElement | null>(null)
  const tooltipNodeIdRef = useRef<string | null>(null)

  /** Ease hoverStrengthRef toward 1 (hovering) / 0 (clear) — soft Obsidian feel */
  const kickHoverAnim = useCallback(() => {
    if (hoverAnimRafRef.current) return
    const step = (): void => {
      const target = hoverIdRef.current ? 1 : 0
      const cur = hoverStrengthRef.current
      // slightly snappier in, softer out
      const rate = target > cur ? 0.28 : 0.18
      const next = cur + (target - cur) * rate
      if (Math.abs(next - target) < 0.012) {
        hoverStrengthRef.current = target
        hoverAnimRafRef.current = 0
        if (interactiveCanvasRef.current) drawCanvas2DRef.current()
        else schedulePaint()
        return
      }
      hoverStrengthRef.current = next
      if (interactiveCanvasRef.current) drawCanvas2DRef.current()
      else schedulePaint()
      hoverAnimRafRef.current = requestAnimationFrame(step)
    }
    hoverAnimRafRef.current = requestAnimationFrame(step)
  }, [interactiveCanvasRef, drawCanvas2DRef, schedulePaint])

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

  const showTooltipDom = useCallback(
    (hit: SimNode, clientX: number, clientY: number) => {
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
    },
    [wrapRef]
  )

  const moveTooltipDom = useCallback(
    (clientX: number, clientY: number) => {
      const el = tooltipElRef.current
      if (!el || tooltipNodeIdRef.current == null) return
      const rect = wrapRef.current?.getBoundingClientRect()
      el.style.left = `${clientX - (rect?.left || 0) + 14}px`
      el.style.top = `${clientY - (rect?.top || 0) + 14}px`
    },
    [wrapRef]
  )

  /**
   * Hit-test with sticky hysteresis (Obsidian-like):
   * keep current hover until pointer clearly leaves expanded radius,
   * so edges between nodes don't flicker.
   * Large graphs use SpatialHash2D so hover stays O(k) not O(n).
   */
  const hitNode = useCallback(
    (clientX: number, clientY: number): SimNode | null => {
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
        const hubScale = !isGhost && dimHubsOn && n.degree >= thr ? 0.62 : 1
        const baseR = radius(n, hubScale) * sizeMul
        // Generous hit pad — touch needs even larger grab area
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
    },
    [wrapRef, transformRef, viewFlagsRef, hoverIdRef, nodesRef, spatialRef, spatialDirtyRef]
  )

  // Keep latest handlers in refs so pointer listeners never rebind mid-pan
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
  const setHoverIdRef = useRef(setHoverId)
  setHoverIdRef.current = setHoverId
  const hitNodeRef = useRef(hitNode)
  hitNodeRef.current = hitNode

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
            setSearchQuery((d.title || '').replace(/^#/, ''))
            setSearchMode('filter')
          } else if (d.isAttachment && d.path && window.api?.openFileExternal) {
            // Attachments (image/pdf) open with OS default app, not the editor
            void window.api.openFileExternal(d.path)
          } else if (d.path && !d.isGhost && !d.isAttachment && d.type !== 'ghost') {
            void openTabRef.current(d.path)
            setActiveViewRef.current('editor')
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
        simRef.current?.alphaTarget(animateForcesRef.current ? OBSIDIAN_SIM.animateAlphaTarget : 0)
      } else if ((mode === 'pan' || mode === 'pinch') && moved) {
        scheduleSaveCameraRef.current()
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
          drawCanvas2DRef.current()
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
        drawCanvas2DRef.current()
        return
      }

      if (mode === 'pan') {
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
        drawCanvas2DRef.current()
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
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return
      e.preventDefault()
      // Cancel wheel debounce to prevent race with pointer gesture
      if (wheelDebounceRef.current) {
        clearTimeout(wheelDebounceRef.current)
        wheelDebounceRef.current = null
      }
      setCtxMenu(null)
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (pointers.size >= 2) {
        mode = 'pinch'
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
        simRef.current?.alphaTarget(OBSIDIAN_SIM.animateAlphaTarget).restart()
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
      const x = mx - ((mx - t.x) * nextK) / k0
      const y = my - ((my - t.y) * nextK) / k0
      // Show Canvas 2D for smooth wheel zoom (bypass React SVG reconciliation)
      showInteractiveCanvas()
      setCameraTransformRef.current(d3.zoomIdentity.translate(x, y).scale(nextK), {
        user: true,
        save: true
      })
      // Debounce: hide canvas + sync SVG after scrolling stops (280ms idle)
      if (wheelDebounceRef.current) clearTimeout(wheelDebounceRef.current)
      wheelDebounceRef.current = setTimeout(() => {
        wheelDebounceRef.current = null
        // Don't hide if a pointer gesture started during the debounce window
        if (pointerGestureRef.current) return
        hideInteractiveCanvas()
        schedulePaint()
      }, 280)
    }

    const onHover = (e: PointerEvent): void => {
      if (mode !== 'none') return
      if (e.pointerType === 'touch') return
      const hit = hitNodeRef.current(e.clientX, e.clientY)
      const next = hit?.id || null
      if (next !== hoverIdRef.current) {
        setHoverIdRef.current(next)
        if (hit) showTooltipDomRef.current(hit, e.clientX, e.clientY)
        else hideTooltipDomRef.current()
      } else if (hit) {
        moveTooltipDomRef.current(e.clientX, e.clientY)
      }
    }

    const onLeave = (): void => {
      if (mode !== 'none') return
      setHoverIdRef.current(null)
      hideTooltipDomRef.current()
    }

    const onDbl = (e: MouseEvent): void => {
      const hit = hitNodeRef.current(e.clientX, e.clientY)
      if (!hit || hit.isGhost || hit.isTag) return
      hit.fx = null
      hit.fy = null
      hit.pinned = false
      posCache.current.set(hit.id, { x: hit.x!, y: hit.y!, fx: null, fy: null })
      setPinnedCount(nodesRef.current.filter((n) => n.pinned || n.fx != null).length)
      simRef.current?.alpha(0.3).restart()
      schedulePaint()
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
    // All other handlers flow through refs set by the imperative canvas; only
    // view activation should (re)bind the gesture listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, schedulePaint])

  return { hoverIdRef, hoverStrengthRef, setHoverId, tooltipElRef, dragIdRef }
}
