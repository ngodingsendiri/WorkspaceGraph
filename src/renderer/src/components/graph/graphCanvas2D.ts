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
  labelZoomAlpha,
  canvasSafeColor,
  nodeRadiusFor,
  edgeWidthFor,
  nid,
  type LodLevel
} from './graphShared'

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
  /** Path pulse animation 0..1 */
  pulse: number
  /** LOD level (pre-computed) */
  lod: LodLevel
  /** Whether graph is "large" (for label thinning) */
  large: boolean
  /** Whether labels are visible */
  showLabels: boolean
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
    pulse,
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
      : [...simLinks].sort((a, b) => edgePriority(b) - edgePriority(a)).slice(0, maxEdges)

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

    const pathAlpha = onPath ? 0.9 + pulse * 0.08 : 1
    let edgeAlpha = 1
    if (dimHover) edgeAlpha = lerp(1, 0.38, hs)
    else if (dimPath) edgeAlpha = 0.28
    else if (dimFocus) edgeAlpha = 0.32
    else if (dimSearch) edgeAlpha = 0.32
    else if (onPath) edgeAlpha = pathAlpha

    const edgeW =
      (onPath
        ? 1.5 + pulse * 0.2
        : isHot
          ? lerp(0.85, 1.2, hs)
          : e.type === 'wiki_link'
            ? 0.75
            : 0.55) * lineMul
    const baseEdge = e.type === 'tag' ? pal.edgeTag : pal.edge
    const edgeColor = onPath ? pal.edgeHot : isHot && hs > 0.4 ? pal.edgeHot : baseEdge

    ctx.beginPath()
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(tg.x, tg.y)
    ctx.strokeStyle = canvasSafeColor(edgeColor, 'rgba(170,175,190,0.38)')
    ctx.globalAlpha = Math.max(0.08, Math.min(0.95, edgeAlpha * (onPath ? 1 : 0.7)))
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
    const r = nodeRadiusFor(
      n.degree ?? 0,
      sizeMul,
      dimHubsOn && isHub,
      kSafe,
      isGhost || isTag || isAttachment ? 0.9 : 1
    )
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

    let alpha = isGhost ? 0.9 : 1
    if (dimHover) alpha = lerp(1, pal.isLight ? 0.5 : 0.55, hs)
    else if (dimPath) alpha = pal.isLight ? 0.4 : 0.42
    else if (dimFocus) alpha = pal.isLight ? 0.42 : 0.45
    else if (dimSearch) alpha = pal.isLight ? 0.45 : 0.48
    else if (dimHubsOn && isHub && !isMatch && !isFocus && !onPath && !onFoc && !isSelected)
      alpha = 0.72
    if (onPath) alpha = Math.min(1, alpha + pulse * 0.05)
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
      const glowA = isHoverNode && !onPath && !isSelected ? 0.08 * hs : pal.isLight ? 0.16 : 0.11
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
      else if (hotIds && !hotIds.has(n.id) && pathN == null && focN == null)
        spotMul = lerp(1, 0.28, hs)

      const isHub = n.degree >= thr
      const rWorld = nodeRadiusFor(n.degree ?? 0, sizeMul, dimHubsOn && isHub, kSafe)
      const sx = n.x * k + tx + rWorld * k + 6
      const sy = n.y * k + ty
      if (sx < -40 || sx > w + 40 || sy < -20 || sy > h + 20) continue

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
}
