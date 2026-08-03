/**
 * Shared graph view helpers — force defaults, LOD, radius, Obsidian palette.
 * Design authority: Obsidian Graph (force-directed, organic clusters).
 * Used by GraphCanvas + LocalGraphCanvas to avoid drift.
 *
 * Obsidian model (what we match):
 * - Single default node tint; color groups override (optional type/folder modes)
 * - Thin semi-transparent edges; solid circles; hollow ghosts
 * - Nodes/edges scale with zoom (world space); labels readable + text-fade
 * - Soft center, many-body repel, link spring; optional Animate breathe
 * - Tech: we use Canvas/SVG + d3-force (Obsidian uses WebGL) — same feel, not same GPU stack
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
 * Simulation cooling — closer to Obsidian settle (organic → stable).
 * animateAlphaTarget: gentle “breathe” when Animate is on.
 */
export const OBSIDIAN_SIM = {
  /** friction — higher = settles smoother, less jitter */
  velocityDecay: 0.42,
  velocityDecayLarge: 0.5,
  /** cool-down rate — lower = more ticks to form clusters */
  alphaDecay: 0.028,
  alphaDecayLarge: 0.036,
  alphaMin: 0.001,
  /** initial heat on (re)build */
  alphaStart: 0.72,
  alphaStartLarge: 0.55,
  /** continuous animate (Obsidian “Animate”) */
  animateAlphaTarget: 0.014
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
    edgeHot: 'rgba(167, 139, 250, 0.9)',
    label: 'rgba(228, 230, 237, 0.92)',
    labelBg: 'rgba(20, 20, 22, 0.72)',
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
    edgeHot: 'rgba(100, 80, 210, 0.85)',
    label: 'rgba(30, 32, 40, 0.92)',
    labelBg: 'rgba(255, 255, 255, 0.88)',
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
 * Single source of truth for BOTH Global (GraphCanvas) and Local (LocalGraphCanvas)
 * graphs so presets / hub-charge tuning never drift apart.
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
  /** Node radius fn — global uses radius(); local uses its smaller localRadius() */
  radiusFn?: (d: SimNode) => number
  /** Charge distanceMax override for mini local canvas (defaults to global ranges) */
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
 * Obsidian-like text fade by zoom.
 * Higher textFade → need more zoom-in before labels are solid.
 * Default textFade ~0.9: labels soft at far zoom, solid when closer (Obsidian feel).
 */
export function labelZoomAlpha(zoomK: number, textFade: number, degree: number): number {
  const thr = Math.max(0.35, textFade || 0.9)
  const boost = Math.min(0.35, Math.sqrt(Math.max(0, degree)) * 0.06)
  // Hubs get labels slightly earlier
  const fullAt = thr * (1 - boost * 0.55)
  const startAt = fullAt * 0.38
  if (zoomK <= startAt) return 0
  if (zoomK >= fullAt) return 1
  return smooth01((zoomK - startAt) / Math.max(0.0001, fullAt - startAt))
}

/** Stable pastel from folder name for color-by-folder mode */
export function folderColor(relativePath: string, isLight: boolean): string {
  const folder = (relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean)[0] || 'root'
  let h = 0
  for (let i = 0; i < folder.length; i++) h = (h * 31 + folder.charCodeAt(i)) >>> 0
  const hue = h % 360
  return isLight ? `hsl(${hue}, 48%, 42%)` : `hsl(${hue}, 42%, 58%)`
}

// ─── Graph diagnostics (specific if-A-then-B messages) ─────────────────

export type GraphDiagCode =
  | 'OK'
  | 'CAM_OFFSCREEN'
  | 'CAM_EXTREME_ZOOM'
  | 'CAM_RESTORED_OK'
  | 'CANVAS_SIZE_ZERO'
  | 'NO_SIM_POSITIONS'
  | 'NO_DATA'
  | 'LOADING'
  | 'FILTER_ORPHAN_ONLY'
  | 'FILTER_ORPHAN_HIDE'
  | 'FILTER_HUB_HIDE'
  | 'FILTER_TYPE'
  | 'FILTER_TAG'
  | 'FILTER_SEARCH'
  | 'FILTER_MULTI'
  | 'FILTER_GHOST_HIDE'
  | 'FILTER_TYPES_HIDDEN'
  | 'FILTER_EMPTY_UNKNOWN'
  | 'PATH_NONE'
  | 'PATH_FAIL'
  | 'PATH_OK'
  | 'FIT_RESIZE'
  | 'FIT_SIM'
  | 'FIT_DATA'

export interface GraphDiag {
  code: GraphDiagCode
  /** Short headline for banner / status */
  title: string
  /** Specific cause (jalur A) */
  cause: string
  /** What we did or what user should do (maka B) */
  action: string
  severity: 'info' | 'warn' | 'error'
}

export function formatGraphDiag(d: GraphDiag): string {
  return `[${d.code}] ${d.title} — ${d.cause} → ${d.action}`
}

/** Diagnose empty filtered set: which filter killed visibility? */
export function diagnoseEmptyFilter(input: {
  totalNodes: number
  loaded: boolean
  orphanMode: string
  hubMode: string
  selectedType: string
  selectedTag: string
  searchQuery: string
  searchMode: string
  existingFilesOnly: boolean
  showTags: boolean
  showAttachments: boolean
}): GraphDiag {
  const {
    totalNodes,
    loaded,
    orphanMode,
    hubMode,
    selectedType,
    selectedTag,
    searchQuery,
    searchMode
  } = input

  if (!loaded) {
    return {
      code: 'LOADING',
      title: 'Memuat graph',
      cause: 'Data node/edge belum selesai di-fetch dari engine',
      action: 'Tunggu sebentar, atau buka ulang vault jika stuck',
      severity: 'info'
    }
  }
  if (totalNodes === 0) {
    return {
      code: 'NO_DATA',
      title: 'Tidak ada note di graph',
      cause: 'Vault tidak punya file .md terindeks, atau graph engine kosong',
      action: 'Buat/simpan note Markdown di vault, lalu buka lagi Graph',
      severity: 'warn'
    }
  }

  const active: string[] = []
  if (orphanMode === 'only') active.push('orphans:only')
  if (orphanMode === 'hide') active.push('orphans:hide')
  if (hubMode === 'hide') active.push('hubs:hide')
  if (selectedType !== 'all') active.push(`type:${selectedType}`)
  if (selectedTag !== 'all') active.push(`tag:${selectedTag}`)
  if (searchMode === 'filter' && searchQuery.trim())
    active.push(`search-filter:“${searchQuery.trim()}”`)

  if (active.length > 1) {
    return {
      code: 'FILTER_MULTI',
      title: 'Filter menghilangkan semua node',
      cause: `Beberapa filter aktif bersamaan: ${active.join(' + ')}`,
      action: 'Tekan Esc, atau Reset filter, atau longgarkan satu per satu (P)',
      severity: 'warn'
    }
  }
  if (orphanMode === 'only') {
    return {
      code: 'FILTER_ORPHAN_ONLY',
      title: 'Mode orphans only — kosong',
      cause: 'Filter menampilkan hanya note tanpa wikilink; tidak ada yang cocok',
      action: 'Tekan 1 (orphans:all) atau buka Dashboard → cek daftar orphan',
      severity: 'warn'
    }
  }
  if (orphanMode === 'hide') {
    return {
      code: 'FILTER_ORPHAN_HIDE',
      title: 'Semua node dianggap orphan & disembunyikan',
      cause: 'orphans:hide aktif dan semua note terlihat degree 0 (atau hanya orphan)',
      action: 'Tekan 1 atau 2 untuk tampilkan orphan lagi',
      severity: 'warn'
    }
  }
  if (hubMode === 'hide') {
    return {
      code: 'FILTER_HUB_HIDE',
      title: 'Hubs:hide menghapus semua node',
      cause: 'Semua note punya degree ≥ ambang hub, lalu disembunyikan',
      action: 'Tekan 3 (hub normal/dim) atau naikkan ambang hub di panel P',
      severity: 'warn'
    }
  }
  if (selectedType !== 'all') {
    return {
      code: 'FILTER_TYPE',
      title: `Tidak ada node tipe “${selectedType}”`,
      cause: `Filter type=${selectedType} tidak cocok dengan note di vault`,
      action: 'Panel P → Type: Semua',
      severity: 'warn'
    }
  }
  if (selectedTag !== 'all') {
    return {
      code: 'FILTER_TAG',
      title: `Tidak ada node dengan tag #${selectedTag}`,
      cause: `Filter tag aktif; tidak ada note bermuatan tag itu di graph`,
      action: 'Panel P → Tag: Semua, atau centang Tags di display',
      severity: 'warn'
    }
  }
  if (searchMode === 'filter' && searchQuery.trim()) {
    return {
      code: 'FILTER_SEARCH',
      title: 'Search filter: tidak ada match',
      cause: `Mode Filter + query “${searchQuery.trim()}” menyembunyikan non-match; 0 cocok`,
      action: 'Hapus search (/ lalu clear), atau ganti mode ke Spotlight',
      severity: 'warn'
    }
  }
  if (input.existingFilesOnly) {
    return {
      code: 'FILTER_GHOST_HIDE',
      title: 'Semua node adalah ghost (file belum ada)',
      cause: 'existingFilesOnly aktif dan semua note resolving ke file yang belum dibuat',
      action: 'Buat file note yang di-link, atau nonaktifkan "Existing files only" di panel P',
      severity: 'warn'
    }
  }
  if (!input.showTags && !input.showAttachments) {
    return {
      code: 'FILTER_TYPES_HIDDEN',
      title: 'Tags & Attachments disembunyikan',
      cause:
        'showTags=false dan showAttachments=false — semua node termasuk tag/attachment tersembunyi',
      action: 'Centang Tags / Attachments di panel P (display)',
      severity: 'warn'
    }
  }
  return {
    code: 'FILTER_EMPTY_UNKNOWN',
    title: 'Graph kosong (filter)',
    cause: 'Ada data di vault tapi filter UI menyembunyikan semuanya',
    action: 'Esc → Reset filter, atau tekan F setelah filter longgar',
    severity: 'warn'
  }
}

/** Diagnose blank viewport when sim has nodes but none visible. */
export function diagnoseViewportBlank(input: {
  inView: number
  total: number
  w: number
  h: number
  zoomK: number
  camX: number
  camY: number
  trigger: string
  hadSavedCamera: boolean
}): GraphDiag {
  const { inView, total, w, h, zoomK, camX, camY, trigger, hadSavedCamera } = input

  if (w < 32 || h < 32) {
    return {
      code: 'CANVAS_SIZE_ZERO',
      title: 'Kanvas belum berukuran',
      cause: `Ukuran canvas ${w}×${h}px (flex layout belum settle) · trigger=${trigger}`,
      action: 'Tunggu layout, resize jendela, atau tekan F setelah area graph terlihat',
      severity: 'warn'
    }
  }
  if (total === 0) {
    return {
      code: 'NO_SIM_POSITIONS',
      title: 'Simulasi belum punya posisi node',
      cause: `total sim nodes dengan x/y = 0 · trigger=${trigger}`,
      action: 'Tunggu physics settle, atau tekan R (re-layout + fit)',
      severity: 'info'
    }
  }

  const extremeZoom = zoomK < 0.12 || zoomK > 4.5
  const farPan = Math.abs(camX) > w * 2 || Math.abs(camY) > h * 2

  if (extremeZoom) {
    return {
      code: 'CAM_EXTREME_ZOOM',
      title: 'Zoom kamera ekstrem — graph di luar jangkauan',
      cause: `zoom k=${zoomK.toFixed(2)} (normal 0.3–2.5) · ${inView}/${total} di layar · pan=(${camX.toFixed(0)},${camY.toFixed(0)}) · ${w}×${h} · trigger=${trigger}`,
      action: 'Fit otomatis dijalankan. Tekan F jika masih kosong. Zoom disimpan ulang.',
      severity: 'warn'
    }
  }
  if (hadSavedCamera || farPan) {
    return {
      code: 'CAM_OFFSCREEN',
      title: 'Kamera tersimpan menaruh graph di luar layar',
      cause: `viewport ${w}×${h} · terlihat ${inView}/${total} node · kamera x=${camX.toFixed(0)} y=${camY.toFixed(0)} k=${zoomK.toFixed(2)} · trigger=${trigger}${hadSavedCamera ? ' · sumber=graph-layout.json camera' : ''}`,
      action:
        'Fit otomatis dijalankan & kamera dikoreksi. Tekan F / Home bila perlu. Jangan pan jauh lalu tutup app tanpa Fit.',
      severity: 'warn'
    }
  }

  const code: GraphDiagCode = trigger.includes('resize')
    ? 'FIT_RESIZE'
    : trigger.includes('sim')
      ? 'FIT_SIM'
      : trigger.includes('data')
        ? 'FIT_DATA'
        : 'CAM_OFFSCREEN'

  return {
    code,
    title: 'Graph tidak terlihat di viewport',
    cause: `${inView}/${total} node di layar · canvas ${w}×${h} · k=${zoomK.toFixed(2)} · trigger=${trigger}`,
    action: 'Fit otomatis dijalankan. Tekan F (Fit) atau R (Layout+Fit) jika masih blank.',
    severity: 'warn'
  }
}

export function diagnosePathResult(input: {
  phase: 'need-two' | 'searching' | 'fail-engine' | 'fail-none' | 'ok'
  fromTitle?: string
  toTitle?: string
  hops?: number
  noteCount?: number
}): GraphDiag {
  switch (input.phase) {
    case 'need-two':
      return {
        code: 'PATH_NONE',
        title: 'Path butuh 2 note',
        cause: 'Endpoint From/To belum lengkap (Shift+klik 2 node, atau pilih di panel)',
        action: 'Shift+klik note A, lalu Shift+klik note B',
        severity: 'info'
      }
    case 'fail-engine':
      return {
        code: 'PATH_FAIL',
        title: 'Path gagal (engine)',
        cause: 'IPC/engine mengembalikan null — node id tidak resolve atau graph kosong',
        action: 'Pastikan kedua note ada di vault & terindeks, lalu coba lagi',
        severity: 'error'
      }
    case 'fail-none':
      return {
        code: 'PATH_NONE',
        title: 'Tidak ada jalur wikilink',
        cause: `Tidak ada rantai [[link]] antara “${input.fromTitle || '?'}” ↔ “${input.toTitle || '?'}” (tanpa hop lewat note hilang/ghost)`,
        action:
          'Tambah wikilink di note, atau naikkan depth Focus, atau pilih pasangan yang terhubung',
        severity: 'warn'
      }
    case 'ok':
      return {
        code: 'PATH_OK',
        title: `Path ${input.hops ?? 0} hop`,
        cause: `Jalur ditemukan lewat ${input.noteCount ?? 0} note (wikilink nyata)`,
        action: 'Node di jalur disorot; tekan Esc untuk clear',
        severity: 'info'
      }
    default:
      return {
        code: 'PATH_NONE',
        title: 'Path',
        cause: 'Status path tidak dikenal',
        action: 'Coba Find path lagi dari panel Explore',
        severity: 'info'
      }
  }
}

/**
 * Uniform spatial hash for O(1) neighborhood hit-tests on large graphs.
 * Cell size in world units (graph space, pre-zoom).
 */
export class SpatialHash2D<T extends { x?: number | null; y?: number | null; id: string }> {
  private cellSize: number
  private cells = new Map<string, T[]>()

  constructor(cellSize = 48) {
    this.cellSize = Math.max(8, cellSize)
  }

  clear(): void {
    this.cells.clear()
  }

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`
  }

  rebuild(items: T[]): void {
    this.cells.clear()
    const s = this.cellSize
    for (const it of items) {
      if (it.x == null || it.y == null) continue
      const cx = Math.floor(it.x / s)
      const cy = Math.floor(it.y / s)
      const k = this.key(cx, cy)
      const bucket = this.cells.get(k)
      if (bucket) bucket.push(it)
      else this.cells.set(k, [it])
    }
  }

  /** Candidates near world point (includes neighboring cells). */
  query(x: number, y: number, radius = 24): T[] {
    const s = this.cellSize
    const r = Math.max(0, radius)
    const minCx = Math.floor((x - r) / s)
    const maxCx = Math.floor((x + r) / s)
    const minCy = Math.floor((y - r) / s)
    const maxCy = Math.floor((y + r) / s)
    const out: T[] = []
    const seen = new Set<string>()
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this.cells.get(this.key(cx, cy))
        if (!bucket) continue
        for (const it of bucket) {
          if (seen.has(it.id)) continue
          seen.add(it.id)
          out.push(it)
        }
      }
    }
    return out
  }
}

// ─── Shared utility functions (used by GraphCanvas + LocalGraphCanvas) ──────

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
    edgeHot: v.edgeHot,
    label: v.label,
    labelBg: v.labelBg,
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

/** Local graph node radius — smaller nodes, center node slightly larger (Obsidian local). */
export function localRadius(d: SimNode): number {
  if (d.isCenter) return Math.max(7, Math.min(12, nodeRadius(d.degree, 1.15)))
  return Math.max(4, Math.min(9, nodeRadius(d.degree, 0.95)))
}

/**
 * Mini-canvas force scaling (LocalGraphCanvas): tighter links, stronger center,
 * gentler charge than the global graph, all clamped to sane dial ranges.
 */
export function scaleLocalForces(f: GraphForceSettings): GraphForceSettings {
  return {
    center: Math.min(0.15, Math.max(0.04, f.center * 1.15)),
    charge: Math.max(-180, Math.min(-28, f.charge * 0.78)),
    linkDist: Math.max(36, Math.min(110, f.linkDist * 0.82)),
    linkStr: Math.min(0.9, Math.max(0.2, f.linkStr)),
    collide: Math.min(1, Math.max(0.2, f.collide))
  }
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
