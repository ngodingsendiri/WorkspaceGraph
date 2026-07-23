import { create } from 'zustand'

export interface GraphNodeData {
  id: string
  title: string
  type: string
  path: string
  relativePath: string
  tags: string[]
  degree: number
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

export interface GraphFilterSettings {
  hubDegreeThreshold: number
  localDepth: number
  /** Phase 2 — global orphan filter */
  orphanMode: GraphOrphanMode
  /** Phase 2 — global hub filter */
  hubMode: GraphHubMode
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
  groups: GraphColorGroup[]
}

export interface GraphSavedView {
  id: string
  name: string
  updatedAt: string
  snapshot: GraphViewSnapshot
}

export interface GraphStore {
  nodes: GraphNodeData[]
  edges: GraphEdgeData[]
  focusedNodeId: string | null
  filterType: string | null
  filterTag: string | null

  /** Phase 0: layout positions from vault file */
  layoutNodes: Record<string, GraphLayoutNodePos>
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
    lineThickness: 1
  },
  filters: { hubDegreeThreshold: 15, localDepth: 1, orphanMode: 'all', hubMode: 'dim' },
  groups: []
}

export const useGraphStore = create<GraphStore>((set, get) => ({
  nodes: [],
  edges: [],
  focusedNodeId: null,
  filterType: null,
  filterTag: null,
  layoutNodes: {},
  graphSettings: null,
  orphanIds: [],
  hubIds: [],
  savedViews: [],

  fetchGraph: async () => {
    try {
      const data = await window.api.getGraphData()
      set({ nodes: data.nodes || [], edges: data.edges || [] })
    } catch (err) {
      console.error('Failed to fetch graph data:', err)
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
      set({
        orphanIds: orphans?.ids || [],
        hubIds: hubs?.ids || [],
        graphSettings: settings || emptySettingsHint,
        layoutNodes: layout?.nodes || {},
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
        set({ layoutNodes: layout?.nodes || {} })
        return true
      }
      return false
    } catch (err) {
      console.error('Failed to save graph layout:', err)
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
  setFilterTag: (tag) => set({ filterTag: tag })
}))
