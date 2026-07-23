/**
 * Graph layout persistence + default graph UI settings (Phase 0).
 * Layout file lives in the vault: .workspacegraph/graph-layout.json
 * Preferences live in app settings.json under key `graph`.
 */
import fs from 'fs'
import path from 'path'

export const GRAPH_LAYOUT_VERSION = 1 as const
export const GRAPH_LAYOUT_FILENAME = 'graph-layout.json'

/** Force parameters consumed by d3 simulation (Phase 3 UI) */
export interface GraphForceSettings {
  /** Pull toward center 0–0.2 */
  center: number
  /** Many-body charge (negative = repel), e.g. -40 .. -200 */
  charge: number
  /** Ideal link distance in px */
  linkDist: number
  /** Link spring strength 0–1 */
  linkStr: number
  /** Collision strength 0–1 */
  collide: number
}

export interface GraphDisplaySettings {
  showLabels: boolean
  showTagEdges: boolean
  showLegend: boolean
  /** Dim high-degree hubs instead of full size (legacy; prefer filters.hubMode) */
  dimHubs: boolean
  /** Hide degree-0 nodes in global view (legacy; prefer filters.orphanMode) */
  hideOrphans: boolean
  /** Obsidian-like: draw direction arrows on wikilink edges */
  arrows: boolean
  /** Obsidian-like: zoom level where labels reach full opacity (0.4–2.5) */
  textFade: number
  /** Obsidian-like: node radius multiplier (0.25–2) */
  nodeSize: number
  /** Obsidian-like: edge thickness multiplier (0.25–3) */
  lineThickness: number
  /**
   * Obsidian "Existing files only": when true, hide unresolved (ghost) nodes.
   * When false, show hollow ghost nodes for broken wikilinks.
   */
  existingFilesOnly: boolean
  /** Obsidian Tags filter — show #tag as nodes */
  showTags: boolean
  /** Obsidian Attachments filter — show non-md files */
  showAttachments: boolean
  /**
   * Keep force simulation gently alive (Obsidian "animate" feel).
   * When false, settles fully after layout.
   */
  animateForces: boolean
}

/** Obsidian-like color group: query match → node color override */
export interface GraphColorGroup {
  id: string
  query: string
  color: string
}

/** Phase 2 global graph filter modes */
export type GraphOrphanMode = 'all' | 'hide' | 'only'
export type GraphHubMode = 'all' | 'dim' | 'hide'

/** How graph search/query affects visibility (Obsidian: search filters the graph). */
export type GraphSearchMode = 'spotlight' | 'filter'

export interface GraphFilterSettings {
  /** Degree ≥ this counts as hub */
  hubDegreeThreshold: number
  /** Default local graph depth (1–5, Obsidian-like) */
  localDepth: number
  /** Orphan visibility in global graph */
  orphanMode: GraphOrphanMode
  /** Hub sizing / visibility in global graph */
  hubMode: GraphHubMode
  /**
   * spotlight = dim non-matches (default, less jarring)
   * filter = hide non-matches (Obsidian subtraction filter)
   */
  searchMode: GraphSearchMode
}

export interface GraphSettings {
  forces: GraphForceSettings
  display: GraphDisplaySettings
  filters: GraphFilterSettings
  /** Obsidian-like color groups (first match wins) */
  groups: GraphColorGroup[]
}

export interface GraphLayoutNodePos {
  x: number
  y: number
  pinned?: boolean
}

/** Canvas pan/zoom (d3 zoom identity: translate + scale) */
export interface GraphCamera {
  x: number
  y: number
  k: number
}

export interface GraphLayoutFile {
  version: typeof GRAPH_LAYOUT_VERSION
  /** Absolute vault root when saved (diagnostics) */
  vaultPath?: string
  updatedAt: string
  nodes: Record<string, GraphLayoutNodePos>
  /** Last global graph camera (Obsidian-like remember view) */
  camera?: GraphCamera | null
}

export function normalizeCamera(v: unknown): GraphCamera | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const x = Number(o.x)
  const y = Number(o.y)
  const k = Number(o.k)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(k)) return null
  if (k < 0.05 || k > 8) return null
  return { x, y, k: Math.min(6, Math.max(0.08, k)) }
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  forces: {
    center: 0.06,
    charge: -90,
    linkDist: 68,
    linkStr: 0.4,
    collide: 0.6
  },
  display: {
    showLabels: true,
    showTagEdges: false,
    showLegend: false,
    dimHubs: true,
    hideOrphans: false,
    arrows: false,
    textFade: 1,
    nodeSize: 1,
    lineThickness: 1,
    existingFilesOnly: true,
    showTags: false,
    showAttachments: false,
    animateForces: false
  },
  filters: {
    hubDegreeThreshold: 15,
    localDepth: 1,
    orphanMode: 'all',
    hubMode: 'dim',
    searchMode: 'spotlight'
  },
  groups: []
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min
  return Math.min(max, Math.max(min, n))
}

const ORPHAN_MODES: GraphOrphanMode[] = ['all', 'hide', 'only']
const HUB_MODES: GraphHubMode[] = ['all', 'dim', 'hide']
const SEARCH_MODES: GraphSearchMode[] = ['spotlight', 'filter']

export function normalizeOrphanMode(
  v: unknown,
  fallback: GraphOrphanMode = 'all'
): GraphOrphanMode {
  return ORPHAN_MODES.includes(v as GraphOrphanMode) ? (v as GraphOrphanMode) : fallback
}

export function normalizeHubMode(v: unknown, fallback: GraphHubMode = 'dim'): GraphHubMode {
  return HUB_MODES.includes(v as GraphHubMode) ? (v as GraphHubMode) : fallback
}

export function normalizeSearchMode(
  v: unknown,
  fallback: GraphSearchMode = 'spotlight'
): GraphSearchMode {
  return SEARCH_MODES.includes(v as GraphSearchMode) ? (v as GraphSearchMode) : fallback
}

const MAX_COLOR_GROUPS = 20

/** Normalize color groups from untrusted JSON (settings file / IPC). */
export function normalizeColorGroups(v: unknown): GraphColorGroup[] {
  if (!Array.isArray(v)) return []
  const out: GraphColorGroup[] = []
  for (const g of v) {
    if (!g || typeof g !== 'object') continue
    const query =
      typeof (g as GraphColorGroup).query === 'string'
        ? (g as GraphColorGroup).query.trim().slice(0, 120)
        : ''
    if (!query) continue
    const rawColor =
      typeof (g as GraphColorGroup).color === 'string' ? (g as GraphColorGroup).color.trim() : ''
    const color = /^#[0-9a-fA-F]{3,8}$/.test(rawColor) ? rawColor : '#a882dd'
    const id =
      typeof (g as GraphColorGroup).id === 'string' && (g as GraphColorGroup).id
        ? (g as GraphColorGroup).id.slice(0, 48)
        : `grp_${out.length}_${Math.random().toString(36).slice(2, 7)}`
    out.push({ id, query, color })
    if (out.length >= MAX_COLOR_GROUPS) break
  }
  return out
}

/** Deep-merge partial graph settings onto defaults (safe for IPC/UI). */
export function mergeGraphSettings(partial?: Partial<GraphSettings> | null): GraphSettings {
  const p = partial || {}
  const f: Partial<GraphForceSettings> = p.forces || {}
  const d: Partial<GraphDisplaySettings> = p.display || {}
  const fil: Partial<GraphFilterSettings> = p.filters || {}

  // Prefer explicit filter modes; migrate legacy display.dimHubs / hideOrphans
  let orphanMode: GraphOrphanMode
  if (fil.orphanMode != null) {
    orphanMode = normalizeOrphanMode(fil.orphanMode)
  } else if (d.hideOrphans === true) {
    orphanMode = 'hide'
  } else {
    orphanMode = DEFAULT_GRAPH_SETTINGS.filters.orphanMode
  }

  let hubMode: GraphHubMode
  if (fil.hubMode != null) {
    hubMode = normalizeHubMode(fil.hubMode)
  } else if (d.dimHubs === false) {
    hubMode = 'all'
  } else if (d.dimHubs === true) {
    hubMode = 'dim'
  } else {
    hubMode = DEFAULT_GRAPH_SETTINGS.filters.hubMode
  }

  return {
    forces: {
      center: clamp(f.center ?? DEFAULT_GRAPH_SETTINGS.forces.center, 0, 0.25),
      charge: clamp(f.charge ?? DEFAULT_GRAPH_SETTINGS.forces.charge, -400, -10),
      linkDist: clamp(f.linkDist ?? DEFAULT_GRAPH_SETTINGS.forces.linkDist, 20, 200),
      linkStr: clamp(f.linkStr ?? DEFAULT_GRAPH_SETTINGS.forces.linkStr, 0.05, 1),
      collide: clamp(f.collide ?? DEFAULT_GRAPH_SETTINGS.forces.collide, 0, 1)
    },
    display: {
      showLabels: d.showLabels ?? DEFAULT_GRAPH_SETTINGS.display.showLabels,
      showTagEdges: d.showTagEdges ?? DEFAULT_GRAPH_SETTINGS.display.showTagEdges,
      showLegend: d.showLegend ?? DEFAULT_GRAPH_SETTINGS.display.showLegend,
      arrows: d.arrows ?? DEFAULT_GRAPH_SETTINGS.display.arrows,
      textFade: clamp(d.textFade ?? DEFAULT_GRAPH_SETTINGS.display.textFade, 0.4, 2.5),
      nodeSize: clamp(d.nodeSize ?? DEFAULT_GRAPH_SETTINGS.display.nodeSize, 0.25, 2),
      lineThickness: clamp(
        d.lineThickness ?? DEFAULT_GRAPH_SETTINGS.display.lineThickness,
        0.25,
        3
      ),
      existingFilesOnly:
        d.existingFilesOnly ?? DEFAULT_GRAPH_SETTINGS.display.existingFilesOnly,
      showTags: d.showTags ?? DEFAULT_GRAPH_SETTINGS.display.showTags,
      showAttachments: d.showAttachments ?? DEFAULT_GRAPH_SETTINGS.display.showAttachments,
      animateForces: d.animateForces ?? DEFAULT_GRAPH_SETTINGS.display.animateForces,
      // Keep booleans in sync with modes (legacy consumers / dashboard)
      dimHubs: hubMode === 'dim',
      hideOrphans: orphanMode === 'hide'
    },
    filters: {
      hubDegreeThreshold: clamp(
        fil.hubDegreeThreshold ?? DEFAULT_GRAPH_SETTINGS.filters.hubDegreeThreshold,
        2,
        200
      ),
      localDepth: clamp(fil.localDepth ?? DEFAULT_GRAPH_SETTINGS.filters.localDepth, 1, 5),
      orphanMode,
      hubMode,
      searchMode: normalizeSearchMode(
        fil.searchMode,
        DEFAULT_GRAPH_SETTINGS.filters.searchMode
      )
    },
    groups: normalizeColorGroups(p.groups)
  }
}

export function getLayoutFilePath(vaultRoot: string): string {
  return path.join(vaultRoot, '.workspacegraph', GRAPH_LAYOUT_FILENAME)
}

export function loadGraphLayout(vaultRoot: string | null | undefined): GraphLayoutFile {
  const empty: GraphLayoutFile = {
    version: GRAPH_LAYOUT_VERSION,
    updatedAt: new Date().toISOString(),
    nodes: {},
    camera: null
  }
  if (!vaultRoot) return empty
  const filePath = getLayoutFilePath(vaultRoot)
  try {
    if (!fs.existsSync(filePath)) return { ...empty, vaultPath: vaultRoot }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<GraphLayoutFile>
    const nodes: Record<string, GraphLayoutNodePos> = {}
    if (raw.nodes && typeof raw.nodes === 'object') {
      for (const [id, pos] of Object.entries(raw.nodes)) {
        if (!pos || typeof pos !== 'object') continue
        const x = Number((pos as GraphLayoutNodePos).x)
        const y = Number((pos as GraphLayoutNodePos).y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        nodes[id] = {
          x,
          y,
          pinned: Boolean((pos as GraphLayoutNodePos).pinned)
        }
      }
    }
    return {
      version: GRAPH_LAYOUT_VERSION,
      vaultPath: vaultRoot,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : empty.updatedAt,
      nodes,
      camera: normalizeCamera(raw.camera)
    }
  } catch (err) {
    console.error('[GraphLayoutStore] load failed:', err)
    return { ...empty, vaultPath: vaultRoot }
  }
}

/**
 * Atomic write of layout positions.
 * Merges with existing file so partial saves don't wipe other nodes.
 */
export function saveGraphLayout(
  vaultRoot: string | null | undefined,
  patch: { nodes?: Record<string, GraphLayoutNodePos>; camera?: GraphCamera | null },
  options?: { replaceAll?: boolean; cameraOnly?: boolean }
): { ok: boolean; path?: string; count?: number; error?: string } {
  if (!vaultRoot) return { ok: false, error: 'No vault open' }
  try {
    const dir = path.join(vaultRoot, '.workspacegraph')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const existing = options?.replaceAll
      ? { nodes: {} as Record<string, GraphLayoutNodePos>, camera: null as GraphCamera | null }
      : loadGraphLayout(vaultRoot)
    const nextNodes = options?.cameraOnly
      ? { ...existing.nodes }
      : { ...existing.nodes }
    if (!options?.cameraOnly) {
      for (const [id, pos] of Object.entries(patch.nodes || {})) {
        if (!id || !pos) continue
        const x = Number(pos.x)
        const y = Number(pos.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        nextNodes[id] = { x, y, pinned: Boolean(pos.pinned) }
      }
    }

    let camera = existing.camera ?? null
    if (patch.camera !== undefined) {
      camera = patch.camera === null ? null : normalizeCamera(patch.camera)
    }

    const payload: GraphLayoutFile = {
      version: GRAPH_LAYOUT_VERSION,
      vaultPath: vaultRoot,
      updatedAt: new Date().toISOString(),
      nodes: nextNodes,
      camera
    }

    const filePath = getLayoutFilePath(vaultRoot)
    const tmp = filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    fs.renameSync(tmp, filePath)
    return { ok: true, path: filePath, count: Object.keys(nextNodes).length }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Extract graph settings blob from full app settings object */
export function readGraphSettingsFromAppSettings(
  settings: Record<string, unknown> | null | undefined
): GraphSettings {
  const g = settings?.graph
  if (g && typeof g === 'object') {
    return mergeGraphSettings(g as Partial<GraphSettings>)
  }
  return mergeGraphSettings(null)
}

// ─── Phase 5: Saved graph views (vault file) ─────────────────────────

export const GRAPH_VIEWS_VERSION = 1 as const
export const GRAPH_VIEWS_FILENAME = 'graph-views.json'

/** Snapshot of filter/display/force chrome (+ optional camera). Node positions = layout file. */
export interface GraphViewSnapshot {
  orphanMode: GraphOrphanMode
  hubMode: GraphHubMode
  hubDegreeThreshold: number
  selectedType: string
  selectedTag: string
  showLabels: boolean
  showTagEdges: boolean
  showLegend: boolean
  colorBy: 'type' | 'folder'
  forces: GraphForceSettings
  /** Performance preference */
  perfMode: 'auto' | 'quality' | 'speed'
  /** Obsidian-like display options */
  arrows: boolean
  textFade: number
  nodeSize: number
  lineThickness: number
  existingFilesOnly: boolean
  searchMode: GraphSearchMode
  showTags?: boolean
  showAttachments?: boolean
  animateForces?: boolean
  /** Saved pan/zoom for this named view */
  camera?: GraphCamera | null
  groups: GraphColorGroup[]
}

export interface GraphSavedView {
  id: string
  name: string
  updatedAt: string
  snapshot: GraphViewSnapshot
}

export interface GraphViewsFile {
  version: typeof GRAPH_VIEWS_VERSION
  vaultPath?: string
  updatedAt: string
  views: GraphSavedView[]
}

export const DEFAULT_VIEW_SNAPSHOT: GraphViewSnapshot = {
  orphanMode: 'all',
  hubMode: 'dim',
  hubDegreeThreshold: 15,
  selectedType: 'all',
  selectedTag: 'all',
  showLabels: true,
  showTagEdges: false,
  showLegend: false,
  colorBy: 'type',
  forces: { ...DEFAULT_GRAPH_SETTINGS.forces },
  perfMode: 'auto',
  arrows: DEFAULT_GRAPH_SETTINGS.display.arrows,
  textFade: DEFAULT_GRAPH_SETTINGS.display.textFade,
  nodeSize: DEFAULT_GRAPH_SETTINGS.display.nodeSize,
  lineThickness: DEFAULT_GRAPH_SETTINGS.display.lineThickness,
  existingFilesOnly: DEFAULT_GRAPH_SETTINGS.display.existingFilesOnly,
  searchMode: DEFAULT_GRAPH_SETTINGS.filters.searchMode,
  showTags: DEFAULT_GRAPH_SETTINGS.display.showTags,
  showAttachments: DEFAULT_GRAPH_SETTINGS.display.showAttachments,
  animateForces: DEFAULT_GRAPH_SETTINGS.display.animateForces,
  camera: null,
  groups: []
}

export function getViewsFilePath(vaultRoot: string): string {
  return path.join(vaultRoot, '.workspacegraph', GRAPH_VIEWS_FILENAME)
}

function sanitizeSnapshot(raw: Partial<GraphViewSnapshot> | null | undefined): GraphViewSnapshot {
  const s = raw || {}
  const disp = {
    arrows: s.arrows ?? DEFAULT_VIEW_SNAPSHOT.arrows,
    textFade: clamp(Number(s.textFade ?? DEFAULT_VIEW_SNAPSHOT.textFade), 0.4, 2.5),
    nodeSize: clamp(Number(s.nodeSize ?? DEFAULT_VIEW_SNAPSHOT.nodeSize), 0.25, 2),
    lineThickness: clamp(
      Number(s.lineThickness ?? DEFAULT_VIEW_SNAPSHOT.lineThickness),
      0.25,
      3
    ),
    existingFilesOnly: s.existingFilesOnly ?? DEFAULT_VIEW_SNAPSHOT.existingFilesOnly,
    showTags: s.showTags ?? DEFAULT_VIEW_SNAPSHOT.showTags,
    showAttachments: s.showAttachments ?? DEFAULT_VIEW_SNAPSHOT.showAttachments,
    animateForces: s.animateForces ?? DEFAULT_VIEW_SNAPSHOT.animateForces
  }
  const forces = mergeGraphSettings({ forces: s.forces }).forces
  return {
    orphanMode: normalizeOrphanMode(s.orphanMode, DEFAULT_VIEW_SNAPSHOT.orphanMode),
    hubMode: normalizeHubMode(s.hubMode, DEFAULT_VIEW_SNAPSHOT.hubMode),
    hubDegreeThreshold: clamp(
      Number(s.hubDegreeThreshold ?? DEFAULT_VIEW_SNAPSHOT.hubDegreeThreshold),
      2,
      200
    ),
    selectedType: typeof s.selectedType === 'string' && s.selectedType ? s.selectedType : 'all',
    selectedTag: typeof s.selectedTag === 'string' && s.selectedTag ? s.selectedTag : 'all',
    showLabels: s.showLabels ?? true,
    showTagEdges: s.showTagEdges ?? false,
    showLegend: s.showLegend ?? false,
    colorBy: s.colorBy === 'folder' ? 'folder' : 'type',
    forces,
    perfMode: s.perfMode === 'quality' || s.perfMode === 'speed' ? s.perfMode : 'auto',
    arrows: disp.arrows,
    textFade: disp.textFade,
    nodeSize: disp.nodeSize,
    lineThickness: disp.lineThickness,
    existingFilesOnly: disp.existingFilesOnly,
    searchMode: normalizeSearchMode(s.searchMode, DEFAULT_VIEW_SNAPSHOT.searchMode),
    showTags: disp.showTags,
    showAttachments: disp.showAttachments,
    animateForces: disp.animateForces,
    camera: normalizeCamera(s.camera),
    groups: normalizeColorGroups(s.groups)
  }
}

export function loadGraphViews(vaultRoot: string | null | undefined): GraphViewsFile {
  const empty: GraphViewsFile = {
    version: GRAPH_VIEWS_VERSION,
    updatedAt: new Date().toISOString(),
    views: []
  }
  if (!vaultRoot) return empty
  const filePath = getViewsFilePath(vaultRoot)
  try {
    if (!fs.existsSync(filePath)) return { ...empty, vaultPath: vaultRoot }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<GraphViewsFile>
    const views: GraphSavedView[] = []
    if (Array.isArray(raw.views)) {
      for (const v of raw.views) {
        if (!v || typeof v !== 'object') continue
        const id = typeof v.id === 'string' && v.id ? v.id : null
        const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim() : null
        if (!id || !name) continue
        views.push({
          id,
          name: name.slice(0, 80),
          updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : empty.updatedAt,
          snapshot: sanitizeSnapshot(v.snapshot)
        })
      }
    }
    return {
      version: GRAPH_VIEWS_VERSION,
      vaultPath: vaultRoot,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : empty.updatedAt,
      views
    }
  } catch (err) {
    console.error('[GraphLayoutStore] load views failed:', err)
    return { ...empty, vaultPath: vaultRoot }
  }
}

function writeViewsFile(
  vaultRoot: string,
  views: GraphSavedView[]
): { ok: boolean; path?: string; count?: number; error?: string } {
  try {
    const dir = path.join(vaultRoot, '.workspacegraph')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const payload: GraphViewsFile = {
      version: GRAPH_VIEWS_VERSION,
      vaultPath: vaultRoot,
      updatedAt: new Date().toISOString(),
      views
    }
    const filePath = getViewsFilePath(vaultRoot)
    const tmp = filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    fs.renameSync(tmp, filePath)
    return { ok: true, path: filePath, count: views.length }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Create or update a named view. Pass id to overwrite; omit to create. */
export function upsertGraphView(
  vaultRoot: string | null | undefined,
  input: { id?: string; name: string; snapshot: Partial<GraphViewSnapshot> }
): { ok: boolean; view?: GraphSavedView; views?: GraphSavedView[]; error?: string } {
  if (!vaultRoot) return { ok: false, error: 'No vault open' }
  const name = (input.name || '').trim().slice(0, 80)
  if (!name) return { ok: false, error: 'Name required' }
  const file = loadGraphViews(vaultRoot)
  const now = new Date().toISOString()
  const snapshot = sanitizeSnapshot(input.snapshot)
  let views = [...file.views]
  let view: GraphSavedView
  if (input.id) {
    const idx = views.findIndex((v) => v.id === input.id)
    if (idx >= 0) {
      view = { ...views[idx], name, updatedAt: now, snapshot }
      views[idx] = view
    } else {
      view = { id: input.id, name, updatedAt: now, snapshot }
      views.push(view)
    }
  } else {
    // Upsert by name (case-insensitive) to avoid duplicates
    const idx = views.findIndex((v) => v.name.toLowerCase() === name.toLowerCase())
    if (idx >= 0) {
      view = { ...views[idx], name, updatedAt: now, snapshot }
      views[idx] = view
    } else {
      view = {
        id: `view_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        name,
        updatedAt: now,
        snapshot
      }
      views.push(view)
    }
  }
  // Cap at 40 views
  if (views.length > 40) views = views.slice(-40)
  const res = writeViewsFile(vaultRoot, views)
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, view, views }
}

export function deleteGraphView(
  vaultRoot: string | null | undefined,
  id: string
): { ok: boolean; views?: GraphSavedView[]; error?: string } {
  if (!vaultRoot) return { ok: false, error: 'No vault open' }
  if (!id) return { ok: false, error: 'id required' }
  const file = loadGraphViews(vaultRoot)
  const views = file.views.filter((v) => v.id !== id)
  const res = writeViewsFile(vaultRoot, views)
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, views }
}

/** Phase 5: resolve paint LOD from node count + preference */
export type GraphPerfMode = 'auto' | 'quality' | 'speed'
export type GraphLodLevel = 'full' | 'medium' | 'low'

export function resolveGraphLod(
  nodeCount: number,
  perfMode: GraphPerfMode = 'auto'
): GraphLodLevel {
  if (perfMode === 'quality') return 'full'
  if (perfMode === 'speed') {
    if (nodeCount > 40) return 'low'
    if (nodeCount > 15) return 'medium'
    return 'full'
  }
  // auto — aligned with renderer graphShared (canvas 2d + d3-force)
  if (nodeCount > 400) return 'low'
  if (nodeCount > 150) return 'medium'
  return 'full'
}
