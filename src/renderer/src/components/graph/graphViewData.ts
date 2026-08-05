/**
 * Derived graph view data extracted from the GraphCanvas monolith.
 *
 * Pure functions (unit-testable) + a `useGraphViewData` hook that memoizes the
 * same computation the monolith ran in a dozen interlocking useMemos:
 * visible-degree, filtered nodes/edges, spotlight matches, group colors, and
 * the node/tag/type option lists.
 */
import { useMemo } from 'react'
import type {
  GraphNodeData,
  GraphEdgeData,
  GraphColorGroup,
  GraphSearchMode
} from '../../store/graphStore'
import { safeTags } from './graphShared'
import { resolveGroupColors } from './graphQuery'

export type OrphanMode = 'all' | 'hide' | 'only'
export type HubMode = 'all' | 'dim' | 'hide'

export interface GraphFilterState {
  selectedType: string
  selectedTag: string
  orphanMode: OrphanMode
  hubMode: HubMode
  hubThreshold: number
  existingFilesOnly: boolean
  showTags: boolean
  showAttachments: boolean
  searchMode: GraphSearchMode
  searchQuery: string
}

export interface GraphViewData {
  allTags: string[]
  typeOptions: string[]
  /** Spotlight match ids (null = no search active) */
  searchMatchIds: Set<string> | null
  orphanIdSet: Set<string>
  /** Visible-graph undirected degree (respects tag/ghost/attachment visibility) */
  realDegreeById: Map<string, number>
  filteredNodes: GraphNodeData[]
  filteredNodeIds: Set<string>
  nodeById: Map<string, GraphNodeData>
  filteredEdges: GraphEdgeData[]
  /** Obsidian color groups: node id → group color (first match wins) */
  groupColorById: Map<string, string> | null
  nodeOptions: { id: string; title: string }[]
}

/**
 * Visible-graph degree for orphan/hub filters.
 * - Always ignore ghosts when existingFilesOnly
 * - Count tag edges only when showTags is on (tag nodes visible)
 * - Ignore attachments when showAttachments is off
 */
export function computeRealDegree(
  nodes: GraphNodeData[],
  edges: GraphEdgeData[],
  opts: { existingFilesOnly: boolean; showTags: boolean; showAttachments: boolean }
): Map<string, number> {
  const hidden = new Set<string>()
  for (const n of nodes) {
    if (opts.existingFilesOnly && (n.isGhost || n.type === 'ghost')) hidden.add(n.id)
    if (!opts.showTags && (n.isTag || n.type === 'tag')) hidden.add(n.id)
    if (!opts.showAttachments && (n.isAttachment || n.type === 'attachment')) hidden.add(n.id)
  }
  const neigh = new Map<string, Set<string>>()
  for (const e of edges) {
    const s = typeof e.source === 'string' ? e.source : ''
    const t = typeof e.target === 'string' ? e.target : ''
    if (!s || !t || s === t) continue
    if (e.type === 'tag' && !opts.showTags) continue
    if (hidden.has(s) || hidden.has(t)) continue
    if (!neigh.has(s)) neigh.set(s, new Set())
    if (!neigh.has(t)) neigh.set(t, new Set())
    neigh.get(s)!.add(t)
    neigh.get(t)!.add(s)
  }
  const undirected = new Map<string, number>()
  for (const n of nodes) {
    if (hidden.has(n.id)) continue
    undirected.set(n.id, neigh.get(n.id)?.size ?? 0)
  }
  return undirected
}

/** Spotlight: match ids (null = no search) — title / path / type / tags (Obsidian-like) */
export function computeSearchMatchIds(nodes: GraphNodeData[], query: string): Set<string> | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const bare = q.replace(/^#/, '')
  return new Set(
    nodes
      .filter((n) => {
        if ((n.title || '').toLowerCase().includes(q)) return true
        if ((n.relativePath || '').toLowerCase().includes(q)) return true
        if ((n.type || '').toLowerCase() === q || (n.type || '').toLowerCase().includes(q))
          return true
        return safeTags(n).some((t) => t.toLowerCase().includes(bare) || t.toLowerCase() === bare)
      })
      .map((n) => n.id)
  )
}

export function computeFilteredNodes(
  nodes: GraphNodeData[],
  filter: GraphFilterState,
  realDegreeById: Map<string, number>,
  orphanIdSet: Set<string>
): GraphNodeData[] {
  const q = filter.searchQuery.trim().toLowerCase()
  const bare = q.replace(/^#/, '')
  return nodes.filter((n) => {
    if (!n?.id) return false
    // Obsidian "Existing files only"
    if (filter.existingFilesOnly && (n.isGhost || n.type === 'ghost')) return false
    if (!filter.showTags && (n.isTag || n.type === 'tag')) return false
    if (!filter.showAttachments && (n.isAttachment || n.type === 'attachment')) return false
    if (filter.selectedType !== 'all' && n.type !== filter.selectedType) return false
    if (filter.selectedTag !== 'all' && !safeTags(n).includes(filter.selectedTag)) return false
    // Always use visible-degree (matches on-screen edges), not raw engine degree
    const deg =
      realDegreeById.get(n.id) ??
      (orphanIdSet.has(n.id)
        ? 0
        : typeof n.degree === 'number' && Number.isFinite(n.degree)
          ? n.degree
          : 0)
    const isOrphan = !n.isGhost && !n.isTag && !n.isAttachment && deg === 0
    if (filter.orphanMode === 'hide' && isOrphan) return false
    if (filter.orphanMode === 'only' && !isOrphan) return false
    if (filter.hubMode === 'hide' && deg >= filter.hubThreshold) return false
    // Search filter mode = Obsidian subtraction (hide non-matches)
    if (filter.searchMode === 'filter' && q) {
      const title = (n.title || '').toLowerCase()
      const path = (n.relativePath || '').toLowerCase()
      const hit =
        title.includes(q) ||
        path.includes(q) ||
        (n.type || '').toLowerCase().includes(q) ||
        safeTags(n).some((t) => t.toLowerCase().includes(bare))
      if (!hit) return false
    }
    return true
  })
}

export function computeFilteredEdges(
  edges: GraphEdgeData[],
  filteredNodeIds: Set<string>,
  nodeById: Map<string, GraphNodeData>,
  showTagEdges: boolean,
  showTags: boolean
): GraphEdgeData[] {
  return edges.filter((e) => {
    const src = typeof e.source === 'string' ? e.source : (e.source as { id?: string })?.id
    const tgt = typeof e.target === 'string' ? e.target : (e.target as { id?: string })?.id
    if (!src || !tgt) return false
    if (!filteredNodeIds.has(src) || !filteredNodeIds.has(tgt)) return false
    if (e.type === 'tag') {
      // Note→#tag edges must show when Tags filter is on.
      // Co-tag star edges between notes only when showTagEdges is on.
      const sn = nodeById.get(src)
      const tn = nodeById.get(tgt)
      const involvesTagNode =
        Boolean(sn?.isTag || sn?.type === 'tag' || tn?.isTag || tn?.type === 'tag') ||
        src.startsWith('tag:') ||
        tgt.startsWith('tag:')
      if (involvesTagNode) {
        if (!showTags) return false
      } else if (!showTagEdges) {
        return false
      }
    }
    return true
  })
}

/**
 * Hook: memoized derived data for the graph view. Mirrors the monolith's
 * useMemo network exactly (same inputs → same outputs, no behavior change).
 */
export function useGraphViewData(params: {
  nodes: GraphNodeData[]
  edges: GraphEdgeData[]
  orphanIds: string[]
  colorGroups: GraphColorGroup[]
  searchQuery: string
  selectedType: string
  selectedTag: string
  orphanMode: OrphanMode
  hubMode: HubMode
  hubThreshold: number
  existingFilesOnly: boolean
  showTagEdges: boolean
  showTags: boolean
  showAttachments: boolean
  searchMode: GraphSearchMode
}): GraphViewData {
  const {
    nodes,
    edges,
    orphanIds,
    colorGroups,
    searchQuery,
    selectedType,
    selectedTag,
    orphanMode,
    hubMode,
    hubThreshold,
    existingFilesOnly,
    showTagEdges,
    showTags,
    showAttachments,
    searchMode
  } = params

  const allTags = useMemo(() => {
    const s = new Set<string>()
    for (const n of nodes) {
      for (const t of safeTags(n)) s.add(t)
    }
    return Array.from(s).sort()
  }, [nodes])

  const typeOptions = useMemo(() => {
    const s = new Set(nodes.map((n) => n.type).filter(Boolean))
    return Array.from(s).sort()
  }, [nodes])

  const searchMatchIds = useMemo(
    () => computeSearchMatchIds(nodes, searchQuery),
    [nodes, searchQuery]
  )

  const orphanIdSet = useMemo(() => new Set(orphanIds), [orphanIds])

  const realDegreeById = useMemo(
    () => computeRealDegree(nodes, edges, { existingFilesOnly, showTags, showAttachments }),
    [nodes, edges, existingFilesOnly, showTags, showAttachments]
  )

  const filteredNodes = useMemo(
    () =>
      computeFilteredNodes(
        nodes,
        {
          selectedType,
          selectedTag,
          orphanMode,
          hubMode,
          hubThreshold,
          existingFilesOnly,
          showTags,
          showAttachments,
          searchMode,
          searchQuery
        },
        realDegreeById,
        orphanIdSet
      ),
    [
      nodes,
      selectedType,
      selectedTag,
      orphanMode,
      hubMode,
      hubThreshold,
      orphanIdSet,
      existingFilesOnly,
      showTags,
      showAttachments,
      searchMode,
      searchQuery,
      realDegreeById
    ]
  )

  const filteredNodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes])

  const nodeById = useMemo(() => {
    const m = new Map<string, GraphNodeData>()
    for (const n of nodes) m.set(n.id, n)
    return m
  }, [nodes])

  const filteredEdges = useMemo(
    () => computeFilteredEdges(edges, filteredNodeIds, nodeById, showTagEdges, showTags),
    [edges, filteredNodeIds, showTagEdges, showTags, nodeById]
  )

  const groupColorById = useMemo(() => resolveGroupColors(nodes, colorGroups), [nodes, colorGroups])

  const nodeOptions = useMemo(
    () =>
      [...nodes]
        .map((n) => ({ id: n.id, title: n.title || n.relativePath }))
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })),
    [nodes]
  )

  return {
    allTags,
    typeOptions,
    searchMatchIds,
    orphanIdSet,
    realDegreeById,
    filteredNodes,
    filteredNodeIds,
    nodeById,
    filteredEdges,
    groupColorById,
    nodeOptions
  }
}
