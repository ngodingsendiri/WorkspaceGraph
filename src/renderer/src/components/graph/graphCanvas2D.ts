/**
 * Shared Canvas 2D drawing functions for GraphCanvas.
 * Used by both `paint()` (PNG export) and `drawCanvas2D()` (interactive gestures).
 * Eliminates ~600 lines of duplicated drawing code.
 */
import type { SimNode, SimLink, Palette, ViewFlags } from './graphTypes'
import {
  resolveObsidianNodeFill,
  edgeDrawBudget,
  labelDrawBudget,
  edgeKey,
  smooth01,
  lerp,
  canvasSafeColor,
  nid,
  type LodLevel
} from './graphShared'
import {
  labelZoomAlpha,
  nodeRadiusFor,
  edgeWidthFor,
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
  nodeEntryProgress,
  nodeEntryScale,
  nodeEntryOpacity
} from './graphRenderTokens'

/** Parameters needed by the drawing functions */
export interface DrawContext {
  ctx: CanvasRenderingContext2D
  w: number
  h: number
  dpr: number
  pal: Palette
  /** Camera transform (world → screen) */
  tx: number
  ty: number
  k: number
  /** Simulation data */
  simNodes: SimNode[]
  simLinks: SimLink[]
  /** Interaction state */
  hover: string | null
  hoverStrength: number
  /** View flags (filters, path, focus, search, display) */
  flags: ViewFlags
  /** LOD level (pre-computed) */
  lod: LodLevel
  /** Whether graph is "large" (for label thinning) */
  large: boolean
  /** Whether labels are visible */
  showLabels: boolean
  /** G19: force entry animation complete (PNG export never captures mid-fade) */
  entryComplete?: boolean
}

/** Pre-computed hot set (hover neighbors) */
export interface HotSet {
  ids: Set<string> | null
}

/**
 * Compute hot set (hover neighbors) — call once when hover changes, not per frame.
 */
export function computeHotSet(
  hover: string | null,
  hoverStrength: number,
  simLinks: SimLink[]
): HotSet {
  if (!hover || hoverStrength <= 0.02) return { ids: null }
  const ids = new Set<string>([hover])
  for (const e of simLinks) {
    const s = nid(e.source)
    const t = nid(e.target)
    if (s === hover) ids.add(t)
    if (t === hover) ids.add(s)
  }
  return { ids }
}

/** Check if a world-space point is in the viewport */
function inView(
  x: number,
  y: number,
  tx: number,
  ty: number,
  k: number,
  w: number,
  h: number,
  margin: number
): boolean {
  const sx = x * k + tx
  const sy = y * k + ty
  return sx >= -margin && sx <= w + margin && sy >= -margin && sy <= h + margin
}

/**
 * Draw the full graph scene to a Canvas 2D context.
 * This is the single source of truth for Canvas 2D rendering.
 */
export function drawCanvas2DScene(dc: DrawContext, hot: HotSet): void {
  const {
    ctx,
    w,
    h,
    dpr,
    pal,
    tx,
    ty,
    k,
    simNodes,
    simLinks,
    hover,
    hoverStrength: hs,
    flags,
    lod,
    large,
    showLabels
  } = dc

  const hotIds = hot.ids
  const pathN = flags.pathNodeIds
  const pathE = flags.pathEdgeKeys
  const focN = flags.focusNodeIds
  const focE = flags.focusEdgeKeys
  const focusId = flags.focusedId
  const colorMode = flags.colorBy
  const matchIds = flags.searchMatchIds
  const thr = flags.hubThreshold
  const dimHubsOn = flags.dimHubs
  const sel = flags.selectedIds
  const lineMul = flags.lineThickness || 1
  const sizeMul = flags.nodeSize || 1
  const drawArrows = flags.arrows && k >= 0.4 && lod === 'full'
  const margin = lod === 'low' ? 24 : 48
  const kSafe = Math.max(k, 0.05)

  // Canvas setup
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = pal.bg || '#1e1e22'
  ctx.fillRect(0, 0, w, h)
  ctx.save()
  ctx.translate(tx, ty)
  ctx.scale(k, k)

  // ── Edges ──
  ctx.lineCap = 'round'
  const maxEdges = edgeDrawBudget(lod, simLinks.length)
  // Perf: the priority sort is O(E·log E) per frame and only matters when
  // highlight layers are active. When path/focus/hover/selection are ALL empty
  // every edge scores 0 — sort would be a pure waste on every sim tick for
  // large vaults, so slice directly (same selection the sort would produce).
  const hasEdgePriority = pathE != null || focE != null || hotIds != null || sel != null
  const edgePriority = (e: SimLink): number => {
    const s = e.source as SimNode
    const tg = e.target as SimNode
    if (!s?.id || !tg?.id) return 0
    const ek = edgeKey(s.id, tg.id)
    if (pathE != null && pathE.has(ek)) return 3
    if (focE != null && focE.has(ek)) return 2
    if (hotIds && (s.id === hover || tg.id === hover)) return 2
    if (sel && (sel.has(s.id) || sel.has(tg.id))) return 1
    return 0
  }
  const edgesToDraw =
    simLinks.length <= maxEdges
      ? simLinks
      : hasEdgePriority
        ? [...simLinks].sort((a, b) => edgePriority(b) - edgePriority(a)).slice(0, maxEdges)
        : simLinks.slice(0, maxEdges)

  for (const e of edgesToDraw) {
    const s = e.source as SimNode
    const tg = e.target as SimNode
    if (s.x == null || s.y == null || tg.x == null || tg.y == null) continue
    const ek = edgeKey(s.id, tg.id)
    const forceEdge = (pathE != null && pathE.has(ek)) || (focE != null && focE.has(ek))
    if (
      !forceEdge &&
      !inView(s.x, s.y, tx, ty, k, w, h, margin) &&
      !inView(tg.x, tg.y, tx, ty, k, w, h, margin)
    )
      continue

    const onPath = pathE != null && pathE.has(ek)
    const onFocus = focE != null && focE.has(ek)
    const isHot = hotIds
      ? hotIds.has(s.id) && hotIds.has(tg.id) && (s.id === hover || tg.id === hover)
      : false
    const dimHover = Boolean(hotIds && !isHot && pathN == null && focN == null)
    const dimPath = pathN != null && !onPath
    const dimFocus = pathN == null && focN != null && !onFocus
    const dimSearch =
      pathN == null &&
      focN == null &&
      matchIds != null &&
      !matchIds.has(s.id) &&
      !matchIds.has(tg.id)

    // Edge opacity ladder is IDENTICAL to the SVG renderer (G13/G15) — same
    // base, same dim values (0.12/0.14), same hot ramp, same flat onPath 0.92 —
    // so the hovered cluster and path mode pop identically across a gesture
    // with no *0.7 rescale underneath.
    let edgeAlpha = baseEdgeOpacity(e.type === 'tag')
    if (onPath) edgeAlpha = PATH_EDGE_OP
    else if (onFocus) edgeAlpha = 0.78
    else if (isHot) edgeAlpha = hotEdgeOpacity(edgeAlpha, hs)
    else if (dimHover) edgeAlpha = lerp(edgeAlpha, 0.12, hs)
    else if (dimPath) edgeAlpha = 0.12
    else if (dimFocus) edgeAlpha = 0.12
    else if (dimSearch) edgeAlpha = 0.14

    const edgeW =
      (onPath ? PATH_EDGE_W : isHot ? hotEdgeWidth(hs) : baseEdgeWidth(e.type)) * lineMul
    const edgeColor = onPath
      ? pal.edgeHot
      : isHot && hs > HOT_EDGE_COLOR_HS
        ? pal.edgeHot
        : edgeColorFor(e.type, flags.edgeColorBy, pal)

    // G8: glow underlay for edges touching the hovered node — a wide soft stroke
    // beneath the main one, same rule as the SVG renderer (edgeGlowAlpha) so the
    // canvas→SVG handoff glows identically. Hot edges only, full LOD like the
    // node halo, and never in path/focus/search modes (their own highlights /
    // dimming already apply — a search-dimmed edge must not glow brighter than
    // its own stroke).
    if (lod === 'full' && isHot && hs > 0.1 && !dimPath && !dimFocus && !dimSearch) {
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(tg.x, tg.y)
      ctx.strokeStyle = canvasSafeColor(pal.edgeHot, 'rgba(170,175,190,0.38)')
      ctx.globalAlpha = edgeGlowAlpha(hs, onPath)
      ctx.lineWidth = edgeWidthFor(edgeW * 2.4, kSafe)
      ctx.setLineDash([])
      ctx.stroke()
    }

    ctx.beginPath()
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(tg.x, tg.y)
    ctx.strokeStyle = canvasSafeColor(edgeColor, 'rgba(170,175,190,0.38)')
    // Max is PATH_EDGE_OP 0.92 / min 0.12 (dims) — clamp kept as a safety net
    ctx.globalAlpha = Math.max(0.08, Math.min(0.95, edgeAlpha))
    // Shared screen-space floor (same rule as SVG) so edges don't jump on handoff
    ctx.lineWidth = edgeWidthFor(edgeW, kSafe)
    if (e.type === 'tag' && !onPath) ctx.setLineDash([3 / k, 4 / k])
    else ctx.setLineDash([])
    ctx.stroke()

    // Direction arrows on wikilink edges
    if (drawArrows && e.type !== 'tag' && edgeAlpha > 0.15) {
      const dx = tg.x - s.x
      const dy = tg.y - s.y
      const len = Math.hypot(dx, dy)
      if (len > 8) {
        const isTgGhost = Boolean(tg.isGhost || tg.type === 'ghost')
        const isTgTag = Boolean(tg.isTag || tg.type === 'tag')
        const isTgHub = !isTgGhost && !isTgTag && tg.degree >= thr && dimHubsOn
        const tgR = nodeRadiusFor(
          tg.degree ?? 0,
          sizeMul,
          isTgHub,
          kSafe,
          isTgGhost || isTgTag ? 0.9 : 1
        )
        const ux = dx / len
        const uy = dy / len
        const ax = tg.x - ux * (tgR + 2 + edgeW * 0.5)
        const ay = tg.y - uy * (tgR + 2 + edgeW * 0.5)
        const aw = (2.6 + edgeW * 1.9) / k
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

  // ── Nodes ──
  // G19: entry animation — same time base + batch max order as the SVG
  // renderer so the handoff mid-animation stays identical. PNG export passes
  // entryComplete so it never captures a half-faded frame.
  const entryNow = dc.entryComplete ? Number.POSITIVE_INFINITY : performance.now()
  const entryMaxOrder = simNodes.reduce(
    (m, nd) => (nd.enterOrder != null ? Math.max(m, nd.enterOrder) : m),
    -1
  )
  for (const n of simNodes) {
    if (n.x == null || n.y == null) continue
    const onPath = pathN != null && pathN.has(n.id)
    const onFoc = focN != null && focN.has(n.id)
    const isSelected = sel != null && sel.has(n.id)
    if (
      !onPath &&
      !onFoc &&
      !isSelected &&
      n.id !== hover &&
      n.id !== focusId &&
      !inView(n.x, n.y, tx, ty, k, w, h, margin)
    )
      continue

    const isGhost = Boolean(n.isGhost || n.type === 'ghost')
    const isTag = Boolean(n.isTag || n.type === 'tag')
    const isAttachment = Boolean(n.isAttachment || n.type === 'attachment')
    const isHub = !isGhost && !isTag && n.degree >= thr
    // Same rule as the SVG renderer: world radius + shared screen-space floor
    const rBase = nodeRadiusFor(
      n.degree ?? 0,
      sizeMul,
      dimHubsOn && isHub,
      kSafe,
      isGhost || isTag || isAttachment ? 0.9 : 1
    )
    // G19: new nodes fade + scale in (same helper as the SVG renderer)
    const entryP = nodeEntryProgress(
      entryNow,
      n.born,
      n.enterOrder,
      entryMaxOrder >= 0 ? entryMaxOrder + 1 : undefined
    )
    const r = rBase * nodeEntryScale(entryP)
    const col = canvasSafeColor(
      resolveObsidianNodeFill({
        isLight: pal.isLight,
        isGhost,
        isTag,
        isAttachment,
        type: n.type,
        relativePath: n.relativePath,
        groupColor: flags.groupColors?.get(n.id) || null,
        colorBy: colorMode === 'folder' || colorMode === 'type' ? colorMode : 'default'
      }),
      pal.colors.default || '#7c6cf0'
    )

    const dimHover = Boolean(
      hotIds && !hotIds.has(n.id) && pathN == null && focN == null && !isSelected
    )
    const dimPath = pathN != null && !onPath && !isSelected
    const dimFocus = pathN == null && focN != null && !onFoc && !isSelected
    const dimSearch =
      pathN == null && focN == null && matchIds != null && !matchIds.has(n.id) && !isSelected
    const isFocus = focusId === n.id
    const isMatch = matchIds != null && matchIds.has(n.id)
    const isEndpoint =
      onPath && (n.id === flags.pathFromId || n.id === flags.pathToId || n.id === flags.focusedId)
    const isHoverNode = n.id === hover && hs > 0.05

    // Dim depths identical to the SVG renderer (0.22/0.22/0.26/0.3) so the
    // canvas→SVG handoff never changes how deeply a hovered cluster dims.
    let alpha = isGhost ? 0.9 : 1
    if (dimHover) alpha = lerp(1, 0.22, hs)
    else if (dimPath) alpha = 0.22
    else if (dimFocus) alpha = 0.26
    else if (dimSearch) alpha = 0.3
    else if (dimHubsOn && isHub && !isMatch && !isFocus && !onPath && !onFoc && !isSelected)
      alpha = 0.72
    // G19: entry fade on top of dim gates (parity with SVG fillOp)
    alpha *= nodeEntryOpacity(entryP)
    ctx.globalAlpha = alpha

    // Soft glow: path/selection only
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
      let glowA = pal.isLight ? 0.16 : 0.11
      if (isHoverNode && !onPath && !isSelected) glowA = HOVER_GLOW_ALPHA * hs
      ctx.globalAlpha = glowA * alpha
      ctx.fill()
      ctx.globalAlpha = alpha
    }

    // Node circle
    ctx.beginPath()
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
    if (isGhost) {
      ctx.fillStyle = pal.isLight ? 'rgba(255,255,255,0.35)' : 'rgba(20,22,28,0.4)'
      ctx.fill()
      ctx.strokeStyle = col
      // Shared world-space rule with the SVG renderer (screen floor included)
      ctx.lineWidth = edgeWidthFor(1, kSafe)
      ctx.setLineDash([2.5 / k, 2 / k])
      ctx.stroke()
      ctx.setLineDash([])
    } else {
      ctx.fillStyle = col
      ctx.fill()
    }

    // Node stroke — same world-space values as the SVG renderer so the
    // canvas→SVG handoff never shows a stroke-thickness jump
    const isPinned = Boolean(n.pinned || (n.fx != null && n.fy != null))
    const strokeW =
      isSelected || isEndpoint || isFocus || onPath || isMatch
        ? 1.35
        : isPinned
          ? 1
          : isHoverNode
            ? lerp(0.7, 1.1, hs)
            : 0.55
    if (!isGhost) {
      ctx.lineWidth = edgeWidthFor(strokeW, kSafe)
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

    // Neighbor ring (G7): subtle edgeHot ring on nodes directly connected to
    // the hovered node — same rule as the SVG renderer (no handoff jump)
    const isNeighbor =
      hotIds != null &&
      hotIds.has(n.id) &&
      !isHoverNode &&
      !isSelected &&
      !onPath &&
      !isFocus &&
      !isEndpoint &&
      !isMatch &&
      !isGhost &&
      !isPinned
    if (isNeighbor) {
      ctx.beginPath()
      ctx.arc(n.x, n.y, r + 1.6, 0, Math.PI * 2)
      ctx.strokeStyle = pal.edgeHot
      ctx.globalAlpha = lerp(0.25, 0.6, hs) * alpha
      ctx.lineWidth = edgeWidthFor(lerp(0.45, 0.8, hs), kSafe)
      ctx.setLineDash([])
      ctx.stroke()
      ctx.globalAlpha = alpha
    }

    // Selection ring
    if (isSelected) {
      ctx.beginPath()
      ctx.arc(n.x, n.y, r + 4.5, 0, Math.PI * 2)
      ctx.strokeStyle = pal.edgeHot
      ctx.globalAlpha = 0.85 * alpha
      ctx.lineWidth = edgeWidthFor(0.9, kSafe)
      ctx.setLineDash([])
      ctx.stroke()
      ctx.globalAlpha = alpha
    }

    // Pinned ring
    if (isPinned && !dimHover && !dimPath && (lod !== 'low' || n.id === hover)) {
      ctx.beginPath()
      ctx.arc(n.x, n.y, r + 3.2, 0, Math.PI * 2)
      ctx.strokeStyle = pal.edgeHot
      ctx.globalAlpha = 0.55 * alpha
      ctx.lineWidth = 1.2 / k
      ctx.setLineDash([2.5 / k, 2 / k])
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = alpha
    }
  }
  ctx.globalAlpha = 1
  ctx.restore()

  // ── Labels (screen space) ──
  const labelsOn = showLabels
  if (labelsOn) {
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
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
      if (
        !onPath &&
        !onFoc &&
        n.id !== hover &&
        !isSel &&
        !inView(n.x, n.y, tx, ty, k, w, h, margin)
      )
        continue

      let zA = labelZoomAlpha(k, flags.textFade, n.degree)
      const forceLabel =
        n.id === hover ||
        onPath ||
        onFoc ||
        isSel ||
        n.id === focusId ||
        (matchIds != null && matchIds.has(n.id))
      if (forceLabel) zA = Math.max(zA, smooth01(Math.min(1, k / 0.35)) * 0.95)
      if (zA < 0.03) continue

      // LOD thinning
      if (lod === 'low' && !forceLabel && n.degree < 3) continue
      if (lod === 'medium' && !forceLabel && n.degree < 2) continue
      if (large && lod === 'full' && !forceLabel && n.degree < 2) continue
      labelsDrawn++

      // Spotlight dimming
      // Same dim depths as the SVG label pass (0.15 hover/path, 0.18 search)
      let spotMul = 1
      if (pathN != null && !onPath && !forceLabel) spotMul = 0.15
      else if (
        pathN == null &&
        focN == null &&
        matchIds != null &&
        !matchIds.has(n.id) &&
        !forceLabel
      )
        spotMul = 0.18
      else if (hotIds && !hotIds.has(n.id) && pathN == null && focN == null)
        spotMul = lerp(1, 0.15, hs)

      const isHub = n.degree >= thr
      const rWorld = nodeRadiusFor(n.degree ?? 0, sizeMul, dimHubsOn && isHub, kSafe)
      const sx = n.x * k + tx + rWorld * k + 6
      const sy = n.y * k + ty
      if (sx < -40 || sx > w + 40 || sy < -20 || sy > h + 20) continue

      const titleStr = String(n.title || n.relativePath || n.id || '')
      const text = titleStr.length > 28 ? titleStr.slice(0, 27) + '…' : titleStr
      // No non-hover multiplier: labels reach full zA opacity like the SVG
      // renderer (G6) — the old *0.88 kept canvas labels permanently soft.
      // G19: label fades in with its node (parity with SVG labOp)
      const entryP = nodeEntryProgress(
        entryNow,
        n.born,
        n.enterOrder,
        entryMaxOrder >= 0 ? entryMaxOrder + 1 : undefined
      )
      const labelAlpha = zA * spotMul * nodeEntryOpacity(entryP)
      // G9: no label background box — Obsidian graph labels are plain text
      // floating over the canvas, and the SVG renderer never drew one. Removing
      // it here gives the canvas→SVG handoff perfect parity in light theme.
      ctx.fillStyle = pal.label
      ctx.globalAlpha = labelAlpha
      ctx.fillText(text, sx, sy)
    }
    ctx.globalAlpha = 1
    ctx.restore()
  }
}
