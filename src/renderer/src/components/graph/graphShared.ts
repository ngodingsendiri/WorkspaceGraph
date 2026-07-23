/**
 * Shared graph view helpers — force defaults, LOD, radius, Obsidian-like forces.
 * Used by GraphCanvas + LocalGraphCanvas to avoid drift.
 */
import type { GraphForceSettings, GraphPerfMode } from '../../store/graphStore'

export const DEFAULT_FORCE_SETTINGS: GraphForceSettings = {
  center: 0.06,
  charge: -90,
  linkDist: 68,
  linkStr: 0.4,
  collide: 0.6
}

/** Obsidian-like force presets (name → settings) */
export const FORCE_PRESETS: Record<string, { label: string; forces: GraphForceSettings }> = {
  default: {
    label: 'Default',
    forces: { ...DEFAULT_FORCE_SETTINGS }
  },
  compact: {
    label: 'Compact',
    forces: { center: 0.1, charge: -55, linkDist: 42, linkStr: 0.55, collide: 0.75 }
  },
  relaxed: {
    label: 'Relaxed',
    forces: { center: 0.035, charge: -140, linkDist: 100, linkStr: 0.28, collide: 0.45 }
  },
  clustered: {
    label: 'Clustered',
    forces: { center: 0.02, charge: -180, linkDist: 55, linkStr: 0.65, collide: 0.55 }
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

/** Node radius from degree (Obsidian-like: hubs larger). scale multiplies for display knob. */
export function nodeRadius(degree: number, scale = 1, hubDim = false): number {
  const base = Math.max(3, Math.min(11, 3 + Math.sqrt(Math.max(0, degree)) * 1.35))
  return base * scale * (hubDim ? 0.62 : 1)
}

/** Ideal link distance — longer for hubs so clusters breathe (Obsidian-ish). */
export function linkDistanceFor(
  sourceDegree: number,
  targetDegree: number,
  base: number
): number {
  const d = Math.max(sourceDegree, 0) + Math.max(targetDegree, 0)
  const boost = Math.min(48, Math.sqrt(d) * 6)
  return base + boost * 0.35
}

/** Many-body charge strength — hubs repel slightly more so they don't sit on top of leaves. */
export function chargeFor(degree: number, baseCharge: number, large: boolean): number {
  const hubBoost = 1 + Math.min(0.55, Math.sqrt(Math.max(0, degree)) * 0.08)
  let c = baseCharge * hubBoost
  if (large) c = Math.max(c * 0.6, -280)
  return c
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
 */
export function labelZoomAlpha(zoomK: number, textFade: number, degree: number): number {
  const thr = Math.max(0.35, textFade || 1)
  const boost = Math.min(0.35, Math.sqrt(Math.max(0, degree)) * 0.06)
  const fullAt = thr * (1 - boost * 0.55)
  const startAt = fullAt * 0.42
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
  if (searchMode === 'filter' && searchQuery.trim()) active.push(`search-filter:“${searchQuery.trim()}”`)

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
      action: 'Fit otomatis dijalankan & kamera dikoreksi. Tekan F / Home bila perlu. Jangan pan jauh lalu tutup app tanpa Fit.',
      severity: 'warn'
    }
  }

  const code: GraphDiagCode =
    trigger.includes('resize')
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
        action: 'Tambah wikilink di note, atau naikkan depth Focus, atau pilih pasangan yang terhubung',
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
