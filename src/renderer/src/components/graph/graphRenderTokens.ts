/**
 * Renderer parity tokens — the SINGLE source of truth shared by the SVG
 * renderer (GraphCanvas) and the Canvas2D gesture renderer (graphCanvas2D).
 * Built across the G1–G17 audit so a wheel/pan/hover/path handoff between the
 * two renderers never shows a size, width, opacity, or ease jump.
 *
 * Rule: if a visual value can be computed in BOTH renderers, it MUST live here
 * (or import from here) — never re-derive a per-renderer literal.
 */
import { nodeRadius, lerp, smooth01, easeOutCubic, type LodLevel } from './graphShared'

/**
 * Minimum on-screen node radius (px) — both renderers keep nodes visible
 * at low zoom so the SVG↔Canvas2D handoff never shows a size jump.
 */
export const MIN_NODE_SCREEN_R = 2.5
/** Minimum on-screen edge width (px). */
export const MIN_EDGE_SCREEN_W = 0.6

/**
 * Node radius in world units with a shared screen-space floor (~2.5px on
 * screen at ANY zoom). k = current camera zoom. Both the SVG renderer and
 * the Canvas2D gesture renderer must use this SAME rule so a wheel/pan
 * handoff never pops.
 */
export function nodeRadiusFor(
  degree: number,
  scale: number,
  hubDim: boolean,
  k: number,
  tagMul = 1
): number {
  const world = nodeRadius(degree, scale, hubDim) * tagMul
  return Math.max(MIN_NODE_SCREEN_R / Math.max(k, 0.05), world)
}

/**
 * Edge width in world units with a shared screen-space floor (~0.6px on
 * screen). Shared by SVG + Canvas2D so stroke width never jumps between
 * renderers.
 */
export function edgeWidthFor(world: number, k: number): number {
  return Math.max(MIN_EDGE_SCREEN_W / Math.max(k, 0.05), world)
}

/**
 * Hover-strength ease time constants — frame-rate independent (G5).
 * Exponential smoothing with fixed time constants: snappier in (50 ms,
 * ~150 ms to 95% of the gap), softer out (80 ms, ~240 ms to 95%).
 */
export const HOVER_EASE_IN_MS = 50
export const HOVER_EASE_OUT_MS = 80

/**
 * One step of the hover-strength animation: the strength value `dtMs`
 * milliseconds after `cur`, moving toward `target`. Pure exponential with a
 * constant time constant, so sub-stepping (small dt per rAF frame) converges
 * to exactly the same value as one larger step — the transition is identical
 * on 60 Hz, 120 Hz, or 144 Hz displays.
 */
export function hoverEaseStep(cur: number, target: number, dtMs: number): number {
  if (dtMs <= 0) return cur
  const tauMs = target > cur ? HOVER_EASE_IN_MS : HOVER_EASE_OUT_MS
  return cur + (target - cur) * (1 - Math.exp(-dtMs / tauMs))
}

/**
 * G8: hover glow opacity — shared by BOTH renderers (SVG + Canvas2D) so the
 * handoff never changes how strongly the hovered cluster glows. Obsidian:
 * the hovered node gets a soft halo and its connected edges light up with the
 * same tint. Was 0.08 (nearly invisible) — raised to 0.14, just under the
 * 0.16 light-theme path glow so hover pops without stealing focus.
 */
export const HOVER_GLOW_ALPHA = 0.14

/**
 * G10: hover-strength threshold at which a hot edge's stroke turns edgeHot.
 * Shared by BOTH renderers — SVG used 0.45, Canvas2D used 0.4, so the same
 * eased hs flipped the color at different moments across the handoff. 0.45 is
 * kept (SVG was canonical); both must read this single constant.
 */
export const HOT_EDGE_COLOR_HS = 0.45

/**
 * G12: hot-edge stroke width ramp (world units, before lineMul + screen floor).
 * Both renderers must interpolate the hovered edge's width with this EXACT
 * curve — SVG used lerp(0.85, 1.15, hs), canvas lerp(0.85, 1.2, hs); the 1.15
 * end (SVG, canonical) is kept so the width transition is identical across the
 * canvas→SVG handoff. Used by the main edge stroke AND the G8 edge-glow width.
 */
export function hotEdgeWidth(hs: number): number {
  return lerp(0.85, 1.15, Math.max(0, Math.min(1, hs)))
}

/**
 * Edge-glow opacity for an edge touching the hovered node. Scales with hover
 * strength hs (0..1). The underlay is intentionally softer on non-path edges
 * (×0.7) so the halo never outshines the main stroke — the SVG and Canvas2D
 * renderers must both use this EXACT rule.
 */
export function edgeGlowAlpha(hs: number, onPath: boolean): number {
  const base = lerp(0.08, 0.22, Math.max(0, Math.min(1, hs)))
  return Math.max(0.06, Math.min(0.5, base * (onPath ? 1 : 0.7)))
}

/**
 * G13: rest edge opacity by type — shared by BOTH renderers (SVG and Canvas2D)
 * so a normal edge looks identical across the handoff. Tag edges are thinner
 * and fainter (0.45) than wikilink/note edges (0.55).
 */
export function baseEdgeOpacity(isTag: boolean): number {
  return isTag ? 0.45 : 0.55
}

/**
 * G13: hot-edge opacity ramp — starts at the edge's base opacity and eases
 * toward 0.88 with hover strength. SVG used lerp(base, 0.88, hs); Canvas2D used
 * a flat 0.7, so the hovered edge's brightness never moved. Both renderers must
 * use this EXACT curve so the hover glow ramps identically at the handoff.
 */
export function hotEdgeOpacity(base: number, hs: number): number {
  return lerp(base, 0.88, Math.max(0, Math.min(1, hs)))
}

/**
 * G15: on-path edge opacity — shared by BOTH renderers. SVG was flat 0.92;
 * Canvas2D pulsed 0.9 + pulse*0.08 (clamped 0.95), so a path-mode handoff
 * showed the edge brightness jump. Kept flat like SVG: path edges read as a
 * steady highlight, not a breathing line.
 */
export const PATH_EDGE_OP = 0.92

/**
 * G16: on-path edge width (world units, before lineMul + screen floor) —
 * shared by BOTH renderers. SVG was flat 1.6; Canvas2D pulsed 1.5 + pulse*0.2.
 * Kept flat like SVG (steady highlight — same call as G15), so a path-mode
 * handoff never shows the width jump.
 */
export const PATH_EDGE_W = 1.6

/**
 * G16: rest edge width by type (world units, before lineMul + screen floor) —
 * shared by BOTH renderers. Tag edges stay thin (0.55); wikilink, folder and
 * attachment edges render 0.75 (SVG's rule — Canvas2D used wiki_link ? 0.75
 * : 0.55, which silently drew folder/attachment edges thinner).
 */
export function baseEdgeWidth(type: string): number {
  return type === 'tag' ? 0.55 : 0.75
}

/**
 * Obsidian-like text fade by zoom.
 * Higher textFade → need more zoom-in before labels are solid.
 * Default textFade ~0.75 (G6): labels appear earlier on zoom-in than 0.9,
 * closer to Obsidian's label emergence.
 */
export function labelZoomAlpha(zoomK: number, textFade: number, degree: number): number {
  const thr = Math.max(0.35, textFade || 0.75)
  const boost = Math.min(0.35, Math.sqrt(Math.max(0, degree)) * 0.06)
  // Hubs get labels slightly earlier
  const fullAt = thr * (1 - boost * 0.55)
  const startAt = fullAt * 0.38
  if (zoomK <= startAt) return 0
  if (zoomK >= fullAt) return 1
  return smooth01((zoomK - startAt) / Math.max(0.0001, fullAt - startAt))
}

/**
 * G19: node entry animation — new nodes fade + scale in when the layout
 * rebuilds (filter change / cold start). Pure visual: physics (sim) is never
 * touched, and pre-existing nodes (no `born`) render fully opaque at scale 1.
 *
 * Both renderers derive their entry values from these SAME functions so the
 * SVG↔Canvas2D handoff mid-animation stays identical.
 */

/** Entry duration per node (ms). */
export const NODE_ENTRY_MS = 420
/** Max stagger between the first and last new node of a batch (ms). */
export const NODE_ENTRY_STAGGER_MS = 260
/** Start scale (multiplier of the node radius) at entry begin. */
export const NODE_ENTRY_START_SCALE = 0.4
/** Start opacity at entry begin. */
export const NODE_ENTRY_START_OP = 0

/**
 * 0..1 eased entry progress for a node. Nodes without a `born` stamp
 * (pre-existing) are fully entered; others ease from 0→1 over
 * NODE_ENTRY_MS with a stagger proportional to `enterOrder`.
 */
export function nodeEntryProgress(
  now: number,
  born: number | undefined,
  enterOrder: number | undefined,
  maxOrder: number | undefined
): number {
  if (born == null) return 1
  const delay = (NODE_ENTRY_STAGGER_MS * (enterOrder ?? 0)) / Math.max(1, maxOrder ?? 1)
  return easeOutCubic((now - born - delay) / NODE_ENTRY_MS)
}

/** Radius multiplier for an entry progress value. */
export function nodeEntryScale(p: number): number {
  return lerp(NODE_ENTRY_START_SCALE, 1, p)
}

/** Opacity multiplier for an entry progress value. */
export function nodeEntryOpacity(p: number): number {
  return lerp(NODE_ENTRY_START_OP, 1, p)
}

/**
 * G19 parity: edge entry fade — an edge fades in with its SLOWEST endpoint
 * (min of both nodes' entry progress), so a link between two entering nodes
 * only appears once both are visible, and a link to a pre-existing node fades
 * with the new endpoint. Pre-existing nodes (no `born`) progress to 1, so
 * steady-state edges are unaffected. Both renderers must multiply their edge
 * opacity (and hot-edge glow) by this EXACT value — a handoff mid-entry must
 * never show the edge pop.
 */
export function edgeEntryOpacity(
  now: number,
  bornA: number | undefined,
  enterOrderA: number | undefined,
  bornB: number | undefined,
  enterOrderB: number | undefined,
  maxOrder: number | undefined
): number {
  const m = maxOrder != null && maxOrder >= 0 ? maxOrder + 1 : undefined
  return nodeEntryOpacity(
    Math.min(
      nodeEntryProgress(now, bornA, enterOrderA, m),
      nodeEntryProgress(now, bornB, enterOrderB, m)
    )
  )
}

/**
 * LOD viewport culling — shared by BOTH renderers so a gesture handoff never
 * pops a node/edge at the frustum edge. The SVG renderer reconciles every
 * element it is handed, so culling off-screen geometry here is what actually
 * drops the DOM count (and thus the commit cost) on big vaults; Canvas2D must
 * skip the same geometry with the same margins or the handoff differs.
 *
 * Margins: low LOD (huge vaults) uses a tighter frustum (24px) so more is
 * culled; full/medium uses 48px so hovered clusters near the edge don't pop.
 */

/** Frustum margin (screen px) at low LOD — tighter, culls more. */
export const CULL_MARGIN_LO = 24
/** Frustum margin (screen px) at full/medium LOD — looser, no edge popping. */
export const CULL_MARGIN_HI = 48

/** Shared frustum margin for a LOD level. */
export function cullMargin(lod: LodLevel): number {
  return lod === 'low' ? CULL_MARGIN_LO : CULL_MARGIN_HI
}

/** Screen-space point inside the viewport frustum (margin inclusive). */
export function pointOnScreen(
  sx: number,
  sy: number,
  w: number,
  h: number,
  margin: number
): boolean {
  return sx >= -margin && sx <= w + margin && sy >= -margin && sy <= h + margin
}

/**
 * Screen-space edge visibility: does the segment's bounding box touch the
 * frustum? An edge with BOTH endpoints off-screen still renders when its
 * segment crosses the viewport (endpoint-only checks would drop it); edges
 * fully beyond one side (bbox disjoint) are culled. Margin inclusive.
 */
export function edgeOnScreen(
  sx1: number,
  sy1: number,
  sx2: number,
  sy2: number,
  w: number,
  h: number,
  margin: number
): boolean {
  const minX = Math.min(sx1, sx2)
  const maxX = Math.max(sx1, sx2)
  const minY = Math.min(sy1, sy2)
  const maxY = Math.max(sy1, sy2)
  return !(maxX < -margin || minX > w + margin || maxY < -margin || minY > h + margin)
}

/**
 * G-perf: sim-motion SVG reconciliation throttle window (ms). While the force
 * sim moves, the frame object is rebuilt every paint (~0.2ms) but the React
 * commit of thousands of SVG elements happens at most once per window.
 */
/** Base/initial throttle window (ms). The adaptive controller in
 *  graphPerfStats may widen/narrow it at runtime within hard bounds.
 *  50ms (~20 sim commits/s max) keeps sim-settle responsive on fast machines;
 *  if commits are expensive the adaptive controller widens it toward 500ms. */
export const SVG_PUSH_THROTTLE_MS = 50

/**
 * G-perf: latest-wins throttle decision for SVG frame commits.
 * Returns true when a commit happened within the window (defer to pending),
 * false when it is time to commit (or the caller is flushing).
 * `windowMs` is the current adaptive window — defaults to the base constant
 * so callers/tests that don't care about adaptation keep working.
 */
export function shouldThrottleSvgPush(
  now: number,
  lastCommitAt: number,
  throttle = false,
  windowMs = SVG_PUSH_THROTTLE_MS
): boolean {
  if (!throttle) return false
  return now - lastCommitAt < windowMs
}

/**
 * G20: edge stroke color — single source of truth for BOTH renderers.
 * `default` = Obsidian mono (wiki_link/folder/attachment share the neutral
 * edge color, tag gets the dimmer edgeTag tint). `type` = distinct per-type
 * colors so the graph reads like Obsidian's color-coded links.
 */
export function edgeColorFor(
  type: string,
  mode: 'default' | 'type',
  pal: { edge: string; edgeTag: string; edgeFolder: string; edgeAttachment: string }
): string {
  if (mode === 'type') {
    if (type === 'tag') return pal.edgeTag
    if (type === 'folder') return pal.edgeFolder
    if (type === 'attachment') return pal.edgeAttachment
    return pal.edge
  }
  return type === 'tag' ? pal.edgeTag : pal.edge
}

// ── P2-5: Obsidian dot-grain underlay ──

/** Screen-space dot grid spacing (px) — dots are viewport-fixed, not world. */
export const DOT_GRID_SPACING = 24
/** Dot radius (px). */
export const DOT_GRID_RADIUS = 0.9

/**
 * Theme-aware dot-grain color (Obsidian graph paper): a very faint tint that
 * reads as texture on the plain background. Shared by BOTH renderers so the
 * SVG ↔ Canvas2D handoff never shows a pattern/alpha jump.
 */
export function dotGrainColor(isLight: boolean): string {
  // ~0.03 as requested — just enough to read as texture, never as noise
  return isLight ? 'rgba(45, 50, 66, 0.04)' : 'rgba(214, 219, 232, 0.032)'
}

/**
 * P2-8: dash pattern (on/off, world units) of the camera-focused selection
 * ring. Shared by BOTH renderers so the SVG ↔ Canvas2D handoff never drifts:
 * SVG joins it (`'4 3'`), Canvas2D divides by k (its dash is in user space).
 */
export const FOCUS_RING_DASH = [4, 3] as const
