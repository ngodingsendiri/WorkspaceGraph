/**
 * Shared graph view helpers — force defaults, LOD, radius, Obsidian palette.
 * Design authority: Obsidian Graph (force-directed, organic clusters).
 * Used by GraphCanvas to avoid drift.
 *
 * Obsidian model (what we match):
 * - Single default node tint; color groups override (optional type/folder modes)
 * - Thin semi-transparent edges; solid circles; hollow ghosts
 * - Nodes/edges scale with zoom (world space); labels readable + text-fade
 * - Soft center, many-body repel, link spring; optional Animate breathe
 * - Tech: we use Canvas/SVG + d3-force (Obsidian uses WebGL) — same feel, not same GPU stack
 *
 * Module layout:
 * - ./graphRenderTokens — renderer-parity tokens (G1–G17) shared by SVG + Canvas2D
 * - ./graphDiagnostics  — if-A-then-B banner builders + SpatialHash2D
 * - this file          — forces, palette, LOD budgets, generic utilities
 */
import * as d3 from 'd3'
import type { GraphForceSettings, GraphPerfMode } from '../../store/graphStore'
import type { Palette, SimNode, SimLink } from './graphTypes'

/**
 * Obsidian-like default forces (d3 units, not Obsidian UI 0–1 sliders).
 * Tuned for Obsidian's signature circular-cloud look:
 * - Moderate center pull so the whole graph reads as one round cloud (not a star/snake)
 * - Moderate charge so hubs stay inside their clusters instead of blowing them apart
 * - Link springs + collision keep cluster rings readable
 * Reference (Obsidian Graph View defaults): Repel 45, Link force 45,
 * Link distance 75, Center force 20 (all 0–100 UI sliders → d3 units below).
 */
export const DEFAULT_FORCE_SETTINGS: GraphForceSettings = {
  center: 0.06,
  charge: -110,
  linkDist: 54,
  linkStr: 0.6,
  collide: 0.72
}

/**
 * Simulation cooling — Obsidian rubber-band settle (underdamped, elastic).
 * Lower friction/decay than d3 defaults so linked nodes follow a drag with
 * springy lag and the release recoils softly, then the graph settles organic.
 * animateAlphaTarget: gentle “breathe” when Animate is on.
 */
export const OBSIDIAN_SIM = {
  /** friction — LOWER = springier (less damping = overshoot + recoil) */
  velocityDecay: 0.32,
  velocityDecayLarge: 0.44,
  /** cool-down rate — lower = more ticks to form clusters, softer settle */
  alphaDecay: 0.024,
  alphaDecayLarge: 0.03,
  alphaMin: 0.001,
  /** initial heat on (re)build */
  alphaStart: 0.72,
  alphaStartLarge: 0.55,
  /** continuous animate (Obsidian “Animate”) */
  animateAlphaTarget: 0.014,
  /** sim heat while a node is grabbed — warm enough to stay alive, low enough
   *  not to jitter the whole graph while held */
  dragAlphaTarget: 0.15,
  /** reheat when grabbing a node (settled sim would otherwise not respond) */
  dragAlpha: 0.5,
  /** reheat on release — soft recoil of the stretched graph */
  releaseAlpha: 0.26
} as const

/**
 * Obsidian-like visual tokens (not rainbow-by-type).
 * Color groups / folder / type modes override the default note fill.
 */
export const OBSIDIAN_VISUAL = {
  dark: {
    bg: '#1e1e1e',
    edge: 'rgba(170, 175, 190, 0.38)',
    edgeTag: 'rgba(150, 155, 170, 0.22)',
    edgeFolder: 'rgba(94, 200, 232, 0.42)',
    edgeAttachment: 'rgba(90, 158, 120, 0.45)',
    edgeHot: 'rgba(167, 139, 250, 0.9)',
    label: 'rgba(228, 230, 237, 0.92)',
    nodeStroke: 'rgba(0, 0, 0, 0.35)',
    nodeDefault: '#7c6cf0',
    nodeGhost: 'rgba(160, 165, 180, 0.55)',
    nodeTag: '#c9a227',
    nodeAttachment: '#5a9e78',
    nodeCenter: '#a694f0'
  },
  light: {
    bg: '#f5f5f5',
    edge: 'rgba(50, 55, 70, 0.32)',
    edgeTag: 'rgba(50, 55, 70, 0.18)',
    edgeFolder: 'rgba(30, 130, 165, 0.5)',
    edgeAttachment: 'rgba(61, 138, 92, 0.5)',
    edgeHot: 'rgba(100, 80, 210, 0.85)',
    label: 'rgba(30, 32, 40, 0.92)',
    nodeStroke: 'rgba(255, 255, 255, 0.85)',
    nodeDefault: '#6b5ce7',
    nodeGhost: 'rgba(90, 95, 110, 0.5)',
    nodeTag: '#b8860b',
    nodeAttachment: '#3d8a5c',
    nodeCenter: '#6d5bd0'
  }
} as const

/** Legacy type tints — only used when Color by = Type (not Obsidian default). */
export const TYPE_NODE_COLORS = {
  dark: {
    knowledge: '#a694f0',
    project: '#5ec8e8',
    task: '#e8b04a',
    daily: '#5ed090',
    people: '#f09070',
    template: '#c090e0',
    document: '#7ab0e0',
    sop: '#e878a0',
    other: '#a0aab8'
  },
  light: {
    knowledge: '#6b5bb5',
    project: '#2a8aab',
    task: '#c48420',
    daily: '#2f8f58',
    people: '#c45a35',
    template: '#8a5aa8',
    document: '#3a7aa8',
    sop: '#c0456a',
    other: '#5a6575'
  }
} as const

/** Resolve fill for a graph node — Obsidian: mono default + group override. */
export function resolveObsidianNodeFill(opts: {
  isLight: boolean
  isGhost?: boolean
  isTag?: boolean
  isAttachment?: boolean
  type?: string
  relativePath?: string
  groupColor?: string | null
  /** default = Obsidian mono; type/folder = extensions */
  colorBy?: 'default' | 'type' | 'folder'
}): string {
  const theme = opts.isLight ? OBSIDIAN_VISUAL.light : OBSIDIAN_VISUAL.dark
  if (opts.isGhost) return theme.nodeGhost
  if (opts.isTag) return theme.nodeTag
  if (opts.isAttachment) return theme.nodeAttachment
  if (opts.groupColor) return opts.groupColor
  const mode = opts.colorBy || 'default'
  if (mode === 'folder') {
    return folderColor(opts.relativePath || '', opts.isLight)
  }
  if (mode === 'type') {
    const bag = opts.isLight ? TYPE_NODE_COLORS.light : TYPE_NODE_COLORS.dark
    const t = (opts.type || 'other') as keyof typeof bag
    return bag[t] || bag.other
  }
  return theme.nodeDefault
}

/**
 * Obsidian-like force presets (name → settings).
 * Each preset keeps the circular-cloud DNA but shifts one dial:
 * - default  : balanced circular cloud (Obsidian defaults)
 * - compact  : tight ball — strong center + weak repel for dense vaults
 * - relaxed  : airy spread — strong repel + long soft links for exploration
 * - clustered: distinct community blobs — strong links bind clusters, charge separates them
 */
export const FORCE_PRESETS: Record<string, { label: string; forces: GraphForceSettings }> = {
  default: {
    label: 'Default',
    forces: { ...DEFAULT_FORCE_SETTINGS }
  },
  compact: {
    label: 'Compact',
    forces: { center: 0.1, charge: -60, linkDist: 36, linkStr: 0.8, collide: 0.88 }
  },
  relaxed: {
    label: 'Relaxed',
    forces: { center: 0.035, charge: -170, linkDist: 92, linkStr: 0.3, collide: 0.4 }
  },
  clustered: {
    label: 'Cluster',
    forces: { center: 0.04, charge: -165, linkDist: 48, linkStr: 0.75, collide: 0.6 }
  }
}

/** Max edges to stroke per frame by LOD (keeps large graphs interactive) */
export function edgeDrawBudget(lod: LodLevel, edgeCount: number): number {
  if (lod === 'full') return edgeCount
  if (lod === 'medium') return Math.min(edgeCount, 2500)
  return Math.min(edgeCount, 900)
}

/** Max labels to paint per frame */
export function labelDrawBudget(lod: LodLevel): number {
  if (lod === 'full') return 400
  if (lod === 'medium') return 120
  return 40
}

export type LodLevel = 'full' | 'medium' | 'low'

/** Paint LOD from node count + preference (mirrors GraphLayoutStore.resolveGraphLod) */
export function resolveLod(nodeCount: number, perfMode: GraphPerfMode = 'auto'): LodLevel {
  if (perfMode === 'quality') return 'full'
  if (perfMode === 'speed') {
    if (nodeCount > 40) return 'low'
    if (nodeCount > 15) return 'medium'
    return 'full'
  }
  // auto — thresholds tuned for canvas 2d + d3-force on typical vaults
  if (nodeCount > 400) return 'low'
  if (nodeCount > 150) return 'medium'
  return 'full'
}

/** Node radius from degree (Obsidian: modest hubs, not huge orbs). scale = display knob. */
export function nodeRadius(degree: number, scale = 1, hubDim = false): number {
  const base = Math.max(2.6, Math.min(7.5, 2.8 + Math.sqrt(Math.max(0, degree)) * 1.05))
  return base * scale * (hubDim ? 0.7 : 1)
}

/** Ideal link distance — longer for hubs so clusters breathe (Obsidian-ish). */
export function linkDistanceFor(sourceDegree: number, targetDegree: number, base: number): number {
  const d = Math.max(sourceDegree, 0) + Math.max(targetDegree, 0)
  const boost = Math.min(48, Math.sqrt(d) * 6)
  return base + boost * 0.35
}

/**
 * Many-body charge strength — hubs get a *mild* boost so they don't sit on top of leaves,
 * but stay inside their cluster. Too strong a boost blows the graph into a spider shape;
 * Obsidian's hubs sit at the middle of their circular clusters.
 */
export function chargeFor(degree: number, baseCharge: number, large: boolean): number {
  const hubBoost = 1 + Math.min(0.3, Math.sqrt(Math.max(0, degree)) * 0.05)
  let c = baseCharge * hubBoost
  if (large) c = Math.max(c * 0.6, -280)
  return c
}

/**
 * Apply Obsidian-like force settings onto a live d3 simulation.
 * Single source of truth for the Global graph (GraphCanvas) so presets /
 * hub-charge tuning never drift.
 *
 * - Link distance grows slightly with endpoint degree (cluster breathing)
 * - Tag edges spring weaker so they don't dominate layout
 * - Charge scales with degree (hubs push neighbors away, softened boost)
 * - Soft center + mild xy so the graph reads as one round cloud, not a ball or snake
 */
export interface ForceLayoutOpts {
  width: number
  height: number
  /** Large graph (>~80 nodes global / >40 local): shorter range, fewer iterations */
  large: boolean
  /** Node size display knob multiplier (global nodeSize); local keeps 1 */
  sizeMul?: number
  /** Node radius fn — global uses radius() (kept for custom canvases) */
  radiusFn?: (d: SimNode) => number
  /** Charge distanceMax override for tight canvases (defaults to global ranges) */
  chargeRange?: number
  /** Collide pad override (defaults to large ? 4 : 6) */
  collidePad?: number
}

export function applyForceLayout(
  sim: d3.Simulation<SimNode, undefined>,
  forces: GraphForceSettings,
  opts: ForceLayoutOpts
): void {
  const { width, height, large, sizeMul = 1 } = opts
  const radiusFn = opts.radiusFn ?? radius

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
      .distanceMax(opts.chargeRange ?? (large ? 220 : Math.max(280, forces.linkDist * 5)))
      .theta(large ? 0.92 : 0.9)
  )
  // Obsidian: soft centering so the graph reads as one round cloud, not a hard ball
  // or a stretched snake. x/y strength tracks center so presets behave consistently.
  sim.force('center', d3.forceCenter(width / 2, height / 2).strength(forces.center))
  const soft = Math.min(0.06, forces.center * 0.5)
  sim.force('x', d3.forceX(width / 2).strength(soft))
  sim.force('y', d3.forceY(height / 2).strength(soft))
  sim.force(
    'collide',
    d3
      .forceCollide<SimNode>()
      .radius((d) => radiusFn(d) * sizeMul + (opts.collidePad ?? (large ? 4 : 6)))
      .strength(forces.collide)
      .iterations(large ? 1 : 2)
  )
}

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** Smoothstep 0..1 */
export function smooth01(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Cubic ease-out — fast start, soft landing (Obsidian zoom ease).
 * Standard `1 - (1-t)³`; clamps t to [0,1].
 */
export function easeOutCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return 1 - Math.pow(1 - x, 3)
}

/** Stable pastel from folder name for color-by-folder mode */
export function folderColor(relativePath: string, isLight: boolean): string {
  const folder = (relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean)[0] || 'root'
  let h = 0
  for (let i = 0; i < folder.length; i++) h = (h * 31 + folder.charCodeAt(i)) >>> 0
  const hue = h % 360
  return isLight ? `hsl(${hue}, 48%, 42%)` : `hsl(${hue}, 42%, 58%)`
}

// ─── Shared utility functions (used by GraphCanvas) ────────────

/** Read CSS custom property from document root */
export function css(name: string, fb: string): string {
  if (typeof document === 'undefined') return fb
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb
}

/**
 * Canvas 2D is picky: some CSS color functions / unresolved vars silently fail.
 * Always prefer plain hex / rgba for stroke & fill.
 */
export function canvasSafeColor(raw: string, fallback: string): string {
  const s = (raw || '').trim()
  if (!s) return fallback
  if (
    s.startsWith('var(') ||
    s.startsWith('color-mix') ||
    s.startsWith('oklch') ||
    s.startsWith('oklab')
  ) {
    return fallback
  }
  return s
}

/**
 * Obsidian-like palette: flat bg, mono default nodes, muted edges.
 * Type rainbow kept only for Color by = Type (extension, not Obsidian default).
 */
export function readPalette(): Palette {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light'
  const v = isLight ? OBSIDIAN_VISUAL.light : OBSIDIAN_VISUAL.dark
  const types = isLight ? TYPE_NODE_COLORS.light : TYPE_NODE_COLORS.dark
  return {
    isLight,
    bg: canvasSafeColor(css('--bg-app', v.bg), v.bg),
    edge: v.edge,
    edgeTag: v.edgeTag,
    edgeFolder: v.edgeFolder,
    edgeAttachment: v.edgeAttachment,
    edgeHot: v.edgeHot,
    label: v.label,
    nodeStroke: v.nodeStroke,
    colors: {
      ...types,
      other: types.other,
      ghost: v.nodeGhost,
      tag: v.nodeTag,
      attachment: v.nodeAttachment,
      default: v.nodeDefault
    }
  }
}

/** Node radius wrapper (reads degree from SimNode-like object) */
export function radius(d: { degree?: number }, scale = 1, hubDim = false): number {
  return nodeRadius(d.degree ?? 0, scale, hubDim)
}

/** Extract string id from d3 node/link (handles string | SimNode) */
export function nid(x: string | { id: string }): string {
  return typeof x === 'object' ? x.id : x
}

/** Safe tag extraction from node data */
export function safeTags(n: { tags?: string | string[] }): string[] {
  if (!n.tags) return []
  if (Array.isArray(n.tags)) return n.tags
  return typeof n.tags === 'string'
    ? n.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : []
}

/** Escape HTML entities for safe DOM insertion */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, "'")
}
