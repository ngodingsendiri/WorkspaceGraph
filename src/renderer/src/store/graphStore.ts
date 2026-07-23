import { create } from 'zustand'

export interface GraphNodeData {
  id: string
  title: string
  type: string
  path: string
  relativePath: string
  tags: string[]
  degree: number
  /** Unresolved wikilink target (Obsidian ghost) */
  isGhost?: boolean
  isTag?: boolean
  isAttachment?: boolean
}

export interface GraphEdgeData {
  id: string
  source: string
  target: string
  type: string
  weight: number
}

export interface GraphForceSettings {
  center: number
  charge: number
  linkDist: number
  linkStr: number
  collide: number
}

export interface GraphDisplaySettings {
  showLabels: boolean
  showTagEdges: boolean
  showLegend: boolean
  dimHubs: boolean
  hideOrphans: boolean
  /** Obsidian-like: direction arrows on wikilink edges */
  arrows: boolean
  /** Obsidian-like: zoom where labels reach full opacity */
  textFade: number
  /** Obsidian-like: node radius multiplier */
  nodeSize: number
  /** Obsidian-like: edge thickness multiplier */
  lineThickness: number
  /** Obsidian "Existing files only" — hide ghost/unresolved nodes when true */
  existingFilesOnly: boolean
  /** Show #tag as nodes */
  showTags: boolean
  /** Show non-md attachments */
  showAttachments: boolean
  /** Keep force sim gently alive */
  animateForces: boolean
}

/** Obsidian-like color group: query match → node color override */
export interface GraphColorGroup {
  id: string
  query: string
  color: string
}

/** Obsidian-like display knobs (subset of GraphDisplaySettings) */
export type GraphDisplayOpts = Pick<
  GraphDisplaySettings,
  'arrows' | 'textFade' | 'nodeSize' | 'lineThickness'
>

export type GraphOrphanMode = 'all' | 'hide' | 'only'
export type GraphHubMode = 'all' | 'dim' | 'hide'
export type GraphSearchMode = 'spotlight' | 'filter'

export interface GraphFilterSettings {
  hubDegreeThreshold: number
  localDepth: number
  /** Phase 2 — global orphan filter */
  orphanMode: GraphOrphanMode
  /** Phase 2 — global hub filter */
  hubMode: GraphHubMode
  /** spotlight = dim non-matches; filter = hide non-matches (Obsidian) */
  searchMode: GraphSearchMode
}

export interface GraphSettings {
  forces: GraphForceSettings
  display: GraphDisplaySettings
  filters: GraphFilterSettings
  groups: GraphColorGroup[]
}

/** Deep-partial patch accepted by graph:saveSettings IPC (nested fields merge). */
export type GraphSettingsPatch = {
  forces?: Partial<GraphForceSettings>
  display?: Partial<GraphDisplaySettings>
  filters?: Partial<GraphFilterSettings>
  groups?: GraphColorGroup[]
}

export interface GraphLayoutNodePos {
  x: number
  y: number
  pinned?: boolean
}

export interface GraphCamera {
  x: number
  y: number
  k: number
}

export interface LocalGraphData {
  centerId: string
  depth: number
  nodes: GraphNodeData[]
  edges: GraphEdgeData[]
  nodeCount: number
  edgeCount: number
}

/** Phase 5 saved view snapshot (mirrors main GraphViewSnapshot) */
export type GraphPerfMode = 'auto' | 'quality' | 'speed'

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
  perfMode: GraphPerfMode
  arrows: boolean
  textFade: number
  nodeSize: number
  lineThickness: number
  existingFilesOnly: boolean
  searchMode: GraphSearchMode
  showTags?: boolean
  showAttachments?: boolean
  animateForces?: boolean
  camera?: GraphCamera | null
  groups: GraphColorGroup[]
}

export interface GraphSavedView {
  id: string
  name: string
  updatedAt: string
  snapshot: GraphViewSnapshot
}

/** One-shot intent when opening Graph from dashboard/search (consumed by GraphCanvas). */
export interface GraphOpenIntent {
  orphanMode?: GraphOrphanMode
  hubMode?: GraphHubMode
  searchQuery?: string
  searchMode?: GraphSearchMode
  showTags?: boolean
  showAttachments?: boolean
  focusNodeId?: string
}

export interface GraphStore {
  nodes: GraphNodeData[]
  edges: GraphEdgeData[]
  focusedNodeId: string | null
  filterType: string | null
  filterTag: string | null
  /** Consumed once when Graph view mounts / becomes active */
  openIntent: GraphOpenIntent | null

  /** Phase 0: layout positions from vault file */
  layoutNodes: Record<string, GraphLayoutNodePos>
  /** Last saved camera from graph-layout.json */
  layoutCamera: GraphCamera | null
  /** Phase 0: persisted graph preferences */
  graphSettings: GraphSettings | null
  orphanIds: string[]
  hubIds: string[]
  /** Phase 5: named views */
  savedViews: GraphSavedView[]

  fetchGraph: () => Promise<void>
  fetchGraphMeta: () => Promise<void>
  fetchLocalGraph: (
    nodeIdOrPath: string,
    depth?: number,
    includeTagEdges?: boolean
  ) => Promise<LocalGraphData | null>
  /** Phase 4: shortest path highlight data */
  findPath: (
    fromIdOrPath: string,
    toIdOrPath: string,
    includeTagEdges?: boolean
  ) => Promise<{
    fromId: string
    toId: string
    found: boolean
    length: number
    nodeIds: string[]
    edgeKeys: string[]
  } | null>
  fetchNeighborhood: (
    nodeIdOrPath: string,
    depth?: number
  ) => Promise<{ centerId: string; ids: string[]; edgeKeys: string[] } | null>
  saveLayoutPositions: (
    nodes: Record<string, GraphLayoutNodePos>,
    replaceAll?: boolean
  ) => Promise<boolean>
  saveGraphCamera: (camera: GraphCamera) => Promise<boolean>
  loadGraphSettings: () => Promise<GraphSettings | null>
  updateGraphSettings: (partial: GraphSettingsPatch) => Promise<GraphSettings | null>
  fetchGraphViews: () => Promise<GraphSavedView[]>
  saveGraphView: (
    name: string,
    snapshot: GraphViewSnapshot,
    id?: string
  ) => Promise<GraphSavedView | null>
  deleteGraphView: (id: string) => Promise<boolean>
  setFocusedNode: (nodeId: string | null) => void
  setFilterType: (type: string | null) => void
  setFilterTag: (tag: string | null) => void
  setOpenIntent: (intent: GraphOpenIntent | null) => void
  consumeOpenIntent: () => GraphOpenIntent | null
}

const emptySettingsHint: GraphSettings = {
  forces: { center: 0.06, charge: -90, linkDist: 68, linkStr: 0.4, collide: 0.6 },
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

export const useGraphStore = create<GraphStore>((set, get) => ({
  nodes: [],
  edges: [],
  focusedNodeId: null,
  filterType: null,
  filterTag: null,
  openIntent: null,
  layoutNodes: {},
  layoutCamera: null,
  graphSettings: null,
  orphanIds: [],
  hubIds: [],
  savedViews: [],

  fetchGraph: async () => {
    try {
      if (!window.api?.getGraphData) {
        console.error('Failed to fetch graph data: window.api.getGraphData missing')
        set({ nodes: [], edges: [] })
        return
      }
      const data = await window.api.getGraphData()
      const rawNodes = Array.isArray(data?.nodes) ? data.nodes : []
      const rawEdges = Array.isArray(data?.edges) ? data.edges : []
      // Normalize — bad/partial IPC payloads must not crash GraphCanvas
      const nodes = rawNodes
        .filter((n: { id?: string }) => n && typeof n.id === 'string' && n.id)
        .map(
          (n: {
            id: string
            title?: string
            type?: string
            path?: string
            relativePath?: string
            tags?: string[]
            degree?: number
            isGhost?: boolean
          }) => ({
            id: n.id,
            title: n.title || n.relativePath || n.id,
            type: n.isGhost ? 'ghost' : n.type || 'other',
            path: n.path || '',
            relativePath: n.relativePath || '',
            tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
            degree: typeof n.degree === 'number' && Number.isFinite(n.degree) ? n.degree : 0,
            isGhost: Boolean(n.isGhost || n.type === 'ghost'),
            isTag: Boolean((n as { isTag?: boolean }).isTag || n.type === 'tag'),
            isAttachment: Boolean(
              (n as { isAttachment?: boolean }).isAttachment || n.type === 'attachment'
            )
          })
        )
      const edges = rawEdges
        .map(
          (e: {
            id?: string
            source?: string
            target?: string
            type?: string
            weight?: number
          }) => {
            const source = typeof e?.source === 'string' ? e.source : ''
            const target = typeof e?.target === 'string' ? e.target : ''
            if (!source || !target) return null
            return {
              id: e.id || `${source}->${target}`,
              source,
              target,
              type: e.type || 'wiki_link',
              weight: typeof e.weight === 'number' ? e.weight : 1
            }
          }
        )
        .filter(Boolean) as GraphEdgeData[]
      set({ nodes, edges })
    } catch (err) {
      console.error('Failed to fetch graph data:', err)
      set({ nodes: [], edges: [] })
    }
  },

  /** Orphans, hubs, layout, settings — for global graph chrome */
  fetchGraphMeta: async () => {
    try {
      const [orphans, settings, layout, viewsFile] = await Promise.all([
        window.api.getGraphOrphans(),
        window.api.getGraphSettings(),
        window.api.getGraphLayout(),
        window.api.listGraphViews().catch(() => null)
      ])
      const thr = settings?.filters?.hubDegreeThreshold ?? 15
      const hubs = await window.api.getGraphHubs(thr)
      const cam = layout?.camera
      const layoutCamera =
        cam &&
        typeof cam.x === 'number' &&
        typeof cam.y === 'number' &&
        typeof cam.k === 'number' &&
        Number.isFinite(cam.k)
          ? { x: cam.x, y: cam.y, k: cam.k }
          : null
      set({
        orphanIds: orphans?.ids || [],
        hubIds: hubs?.ids || [],
        graphSettings: settings || emptySettingsHint,
        layoutNodes: layout?.nodes || {},
        layoutCamera,
        savedViews: (viewsFile?.views || []) as unknown as GraphSavedView[]
      })
    } catch (err) {
      console.error('Failed to fetch graph meta:', err)
    }
  },

  fetchLocalGraph: async (nodeIdOrPath, depth, includeTagEdges) => {
    try {
      const data = await window.api.getLocalGraph({
        nodeIdOrPath,
        depth,
        includeTagEdges
      })
      return data as LocalGraphData | null
    } catch (err) {
      console.error('Failed to fetch local graph:', err)
      return null
    }
  },

  findPath: async (fromIdOrPath, toIdOrPath, includeTagEdges) => {
    try {
      const data = await window.api.getGraphPath({
        fromIdOrPath,
        toIdOrPath,
        includeTagEdges
      })
      if (!data) return null
      return {
        fromId: data.fromId,
        toId: data.toId,
        found: data.found,
        length: data.length,
        nodeIds: data.nodeIds || [],
        edgeKeys: data.edgeKeys || []
      }
    } catch (err) {
      console.error('Failed to find graph path:', err)
      return null
    }
  },

  fetchNeighborhood: async (nodeIdOrPath, depth) => {
    try {
      return await window.api.getGraphNeighborhood({
        nodeIdOrPath,
        depth
      })
    } catch (err) {
      console.error('Failed to fetch neighborhood:', err)
      return null
    }
  },

  saveLayoutPositions: async (nodes, replaceAll) => {
    try {
      const res = await window.api.saveGraphLayout({ nodes, replaceAll })
      if (res?.ok) {
        const layout = await window.api.getGraphLayout()
        const cam = layout?.camera
        set({
          layoutNodes: layout?.nodes || {},
          layoutCamera:
            cam && Number.isFinite(cam.k) ? { x: cam.x, y: cam.y, k: cam.k } : get().layoutCamera
        })
        return true
      }
      return false
    } catch (err) {
      console.error('Failed to save graph layout:', err)
      return false
    }
  },

  saveGraphCamera: async (camera) => {
    try {
      if (!camera || !Number.isFinite(camera.k)) return false
      const res = await window.api.saveGraphLayout({
        camera: { x: camera.x, y: camera.y, k: camera.k },
        cameraOnly: true
      })
      if (res?.ok) {
        set({ layoutCamera: { x: camera.x, y: camera.y, k: camera.k } })
        return true
      }
      return false
    } catch (err) {
      console.error('Failed to save graph camera:', err)
      return false
    }
  },

  loadGraphSettings: async () => {
    try {
      const s = await window.api.getGraphSettings()
      set({ graphSettings: s })
      return s
    } catch {
      return null
    }
  },

  updateGraphSettings: async (partial) => {
    try {
      const merged = await window.api.saveGraphSettings(partial as Record<string, unknown>)
      set({ graphSettings: merged })
      // refresh hubs if threshold changed
      const thr =
        merged?.filters?.hubDegreeThreshold ?? get().graphSettings?.filters.hubDegreeThreshold
      if (thr != null) {
        const hubs = await window.api.getGraphHubs(thr)
        set({ hubIds: hubs?.ids || [] })
      }
      return merged
    } catch (err) {
      console.error('Failed to save graph settings:', err)
      return null
    }
  },

  fetchGraphViews: async () => {
    try {
      const file = await window.api.listGraphViews()
      const views = (file?.views || []) as unknown as GraphSavedView[]
      set({ savedViews: views })
      return views
    } catch (err) {
      console.error('Failed to list graph views:', err)
      return []
    }
  },

  saveGraphView: async (name, snapshot, id) => {
    try {
      const res = await window.api.saveGraphView({
        id,
        name,
        snapshot: snapshot as unknown as Record<string, unknown>
      })
      if (res?.ok && res.views) {
        set({ savedViews: res.views as unknown as GraphSavedView[] })
        return (res.view as unknown as GraphSavedView) || null
      }
      return null
    } catch (err) {
      console.error('Failed to save graph view:', err)
      return null
    }
  },

  deleteGraphView: async (id) => {
    try {
      const res = await window.api.deleteGraphView(id)
      if (res?.ok) {
        set({ savedViews: (res.views || []) as unknown as GraphSavedView[] })
        return true
      }
      return false
    } catch (err) {
      console.error('Failed to delete graph view:', err)
      return false
    }
  },

  setFocusedNode: (nodeId) => set({ focusedNodeId: nodeId }),
  setFilterType: (type) => set({ filterType: type }),
  setFilterTag: (tag) => set({ filterTag: tag }),
  setOpenIntent: (intent) => set({ openIntent: intent }),
  consumeOpenIntent: () => {
    const intent = get().openIntent
    if (intent) set({ openIntent: null })
    return intent
  }
}))
