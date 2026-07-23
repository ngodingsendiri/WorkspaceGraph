import path from 'path'
import type { ParsedMarkdown } from './MarkdownEngine'

export interface GraphNode {
  id: string
  title: string
  type:
    | 'knowledge'
    | 'project'
    | 'task'
    | 'daily'
    | 'template'
    | 'document'
    | 'people'
    | 'sop'
    | 'other'
  path: string
  relativePath: string
  tags: string[]
  /** Kept for wiki resolve after single-file updates (aliases used to be wiped) */
  aliases?: string[]
  degree: number
  pinned?: boolean
  x?: number
  y?: number
  fx?: number | null
  fy?: number | null
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: 'wiki_link' | 'tag' | 'folder'
  weight: number
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  nodeCount: number
  edgeCount: number
}

type LookupMaps = {
  /** unique key → id ; ambiguous keys omitted (Obsidian: only unique names resolve) */
  unique: Map<string, string>
  /** key → all matching ids (for diagnostics) */
  multi: Map<string, string[]>
}

function nodeTypeFromPath(relativePath: string): GraphNode['type'] {
  const lower = relativePath.toLowerCase().replace(/\\/g, '/')
  if (lower.startsWith('knowledge') || lower.includes('/knowledge/')) return 'knowledge'
  if (lower.startsWith('projects') || lower.includes('/projects/')) return 'project'
  if (lower.startsWith('tasks') || lower.includes('/tasks/')) return 'task'
  if (lower.startsWith('daily') || lower.startsWith('02 harian') || lower.includes('/02 harian/'))
    return 'daily'
  if (
    lower.startsWith('templates') ||
    lower.startsWith('99 templates') ||
    lower.includes('/templates/')
  )
    return 'template'
  if (lower.startsWith('documents') || lower.includes('/documents/')) return 'document'
  if (
    lower.startsWith('people') ||
    lower.startsWith('05 pegawai') ||
    lower.includes('/05 pegawai/')
  )
    return 'people'
  if (lower.startsWith('sop') || lower.startsWith('06 sop') || lower.includes('/sop')) return 'sop'
  if (lower.startsWith('03 kerjaan') || lower.includes('/03 kerjaan/')) return 'project'
  return 'other'
}

/** Normalize Obsidian-style wikilink target for matching */
export function normalizeLinkTarget(raw: string): string {
  let t = (raw || '').trim()
  t = t.split('#')[0].split('^')[0].trim()
  t = t.replace(/\\/g, '/')
  t = t.replace(/\.md$/i, '')
  t = t.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '')
  // table-escape leftovers
  t = t.replace(/\\+$/g, '').trim()
  return t.toLowerCase()
}

function addKey(maps: LookupMaps, key: string, id: string): void {
  if (!key) return
  const k = key.toLowerCase().trim()
  if (!k) return
  const list = maps.multi.get(k) || []
  if (!list.includes(id)) list.push(id)
  maps.multi.set(k, list)
  if (list.length === 1) {
    maps.unique.set(k, id)
  } else {
    // Ambiguous short names must not resolve (Obsidian behavior for non-unique basenames)
    maps.unique.delete(k)
  }
}

/**
 * Resolve [[wikilink]] like Obsidian:
 * - exact relative path
 * - unique basename / title / alias
 * - path suffix that uniquely matches
 */
export function resolveLinkTarget(rawTarget: string, maps: LookupMaps): string | null {
  const key = normalizeLinkTarget(rawTarget)
  if (!key) return null

  // 1) exact unique match (path, title, name, alias)
  if (maps.unique.has(key)) return maps.unique.get(key)!

  // 2) basename of path link
  if (key.includes('/')) {
    const base = key.split('/').pop()!
    // Prefer full path suffix match first
    for (const [p, id] of maps.unique.entries()) {
      if (p === key || p.endsWith('/' + key)) return id
    }
    // Unique basename only
    if (maps.unique.has(base)) return maps.unique.get(base)!
  }

  // 3) ends-with unique path (e.g. "Kerjaan/Cuti/00 Index Cuti")
  for (const [p, id] of maps.unique.entries()) {
    if (p.endsWith('/' + key) || p === key) return id
  }

  // 4) multi-map: if exactly one path ends with key
  const candidates = new Set<string>()
  for (const [p, ids] of maps.multi.entries()) {
    if (p === key || p.endsWith('/' + key)) {
      for (const id of ids) candidates.add(id)
    }
  }
  if (candidates.size === 1) return [...candidates][0]

  return null
}

function buildLookupMaps(
  items: { id: string; title: string; path: string; relativePath: string; aliases?: string[] }[]
): LookupMaps {
  const maps: LookupMaps = { unique: new Map(), multi: new Map() }

  for (const file of items) {
    const id = file.id
    addKey(maps, file.title.toLowerCase().trim(), id)

    const baseName = path.basename(file.path, path.extname(file.path))
    addKey(maps, baseName, id)

    const rel = file.relativePath.replace(/\\/g, '/').replace(/\.md$/i, '')
    addKey(maps, rel, id)

    // Every path suffix: "a/b/c" → "a/b/c", "b/c", "c"
    const parts = rel.split('/').filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/')
      addKey(maps, suffix, id)
    }

    // Frontmatter aliases (Obsidian)
    if (file.aliases) {
      for (const a of file.aliases) {
        if (a) addKey(maps, String(a), id)
      }
    }
  }

  // Re-enable unique short names when multi was only self-duplicates of same id
  for (const [k, ids] of maps.multi.entries()) {
    const uniq = [...new Set(ids)]
    if (uniq.length === 1) maps.unique.set(k, uniq[0])
  }

  return maps
}

function recomputeDegrees(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>): void {
  for (const n of nodes.values()) n.degree = 0
  const neighbors = new Map<string, Set<string>>()
  for (const e of edges.values()) {
    if (e.type !== 'wiki_link') continue
    if (!neighbors.has(e.source)) neighbors.set(e.source, new Set())
    if (!neighbors.has(e.target)) neighbors.set(e.target, new Set())
    neighbors.get(e.source)!.add(e.target)
    neighbors.get(e.target)!.add(e.source)
  }
  for (const [id, set] of neighbors) {
    const n = nodes.get(id)
    if (n) n.degree = set.size
  }
}

export class GraphEngine {
  private nodes: Map<string, GraphNode> = new Map()
  private edges: Map<string, GraphEdge> = new Map()

  /**
   * Build graph.
   * Default includeTagEdges=false → match Obsidian global graph (wikilinks only).
   */
  buildFromParsedFiles(parsedFiles: ParsedMarkdown[], includeTagEdges = false): GraphData {
    this.nodes.clear()
    this.edges.clear()

    const tagToNodeIds = new Map<string, string[]>()

    for (const file of parsedFiles) {
      const nodeAliases = Array.isArray(file.frontmatter?.aliases)
        ? file.frontmatter.aliases.map(String)
        : []
      const node: GraphNode = {
        id: file.id,
        // Prefer filename for graph label (Obsidian-like); keep full title in data via path
        title: path.basename(file.filePath, path.extname(file.filePath)),
        type: nodeTypeFromPath(file.relativePath),
        path: file.filePath,
        relativePath: file.relativePath,
        tags: file.tags,
        aliases: nodeAliases,
        degree: 0
      }
      // Prefer frontmatter/H1 title when short enough; long emoji titles clutter graph
      const fmTitle = file.title?.trim()
      if (fmTitle && fmTitle.length > 0 && fmTitle.length <= 48 && !/^#+\s/.test(fmTitle)) {
        node.title = fmTitle
      }
      this.nodes.set(file.id, node)

      for (const tag of file.tags) {
        const tagLower = tag.toLowerCase()
        const existing = tagToNodeIds.get(tagLower) || []
        existing.push(file.id)
        tagToNodeIds.set(tagLower, existing)
      }
    }

    const maps = buildLookupMaps(
      parsedFiles.map((f) => ({
        id: f.id,
        title: f.title,
        path: f.filePath,
        relativePath: f.relativePath,
        aliases: Array.isArray(f.frontmatter?.aliases) ? f.frontmatter.aliases.map(String) : []
      }))
    )

    // Wiki links → directed edges (A→B if A contains [[B]]); graph view draws them undirected-looking
    let linked = 0
    let unresolved = 0
    const unresolvedSamples: string[] = []

    for (const file of parsedFiles) {
      for (const link of file.wikiLinks) {
        const targetId = resolveLinkTarget(link.target, maps)
        if (targetId && targetId !== file.id) {
          const edgeId = `${file.id}->${targetId}`
          if (!this.edges.has(edgeId)) {
            this.edges.set(edgeId, {
              id: edgeId,
              source: file.id,
              target: targetId,
              type: 'wiki_link',
              weight: 2
            })
            linked++
          }
        } else if (link.target?.trim()) {
          unresolved++
          if (unresolvedSamples.length < 12) {
            // ASCII arrow — Windows consoles mangle Unicode → as mojibake
            unresolvedSamples.push(`${file.relativePath} -> [[${link.target}]]`)
          }
        }
      }
    }

    if (unresolved > 0) {
      console.log(`[GraphEngine] wiki edges=${linked}, unresolved=${unresolved}`, unresolvedSamples)
    } else {
      console.log(`[GraphEngine] wiki edges=${linked} (all resolved)`)
    }

    // Optional tag edges (star) — OFF by default like Obsidian
    if (includeTagEdges) {
      for (const [, nodeIds] of tagToNodeIds.entries()) {
        if (nodeIds.length < 2 || nodeIds.length > 8) continue
        const hub = nodeIds[0]
        for (let i = 1; i < nodeIds.length; i++) {
          const tgtId = nodeIds[i]
          const edgeId = `tag:${hub}<->${tgtId}`
          const wiki1 = `${hub}->${tgtId}`
          const wiki2 = `${tgtId}->${hub}`
          if (!this.edges.has(edgeId) && !this.edges.has(wiki1) && !this.edges.has(wiki2)) {
            this.edges.set(edgeId, {
              id: edgeId,
              source: hub,
              target: tgtId,
              type: 'tag',
              weight: 1
            })
          }
        }
      }
    }

    recomputeDegrees(this.nodes, this.edges)
    return this.getGraphData()
  }

  updateNodeAndEdges(parsedFile: ParsedMarkdown): void {
    const aliases = Array.isArray(parsedFile.frontmatter?.aliases)
      ? parsedFile.frontmatter.aliases.map(String)
      : []
    const existing = this.nodes.get(parsedFile.id)
    const displayTitle =
      parsedFile.title && parsedFile.title.length <= 48
        ? parsedFile.title
        : path.basename(parsedFile.filePath, path.extname(parsedFile.filePath))

    if (existing) {
      existing.title = displayTitle
      existing.tags = parsedFile.tags
      existing.aliases = aliases
      existing.path = parsedFile.filePath
      existing.relativePath = parsedFile.relativePath
    } else {
      this.nodes.set(parsedFile.id, {
        id: parsedFile.id,
        title: displayTitle,
        type: nodeTypeFromPath(parsedFile.relativePath),
        path: parsedFile.filePath,
        relativePath: parsedFile.relativePath,
        tags: parsedFile.tags,
        aliases,
        degree: 0
      })
    }

    // Drop only OUTGOING wiki edges from this node, then rebuild from its wikilinks.
    // Do NOT delete edges where target === this id — that wiped backlinks (A→B) whenever B saved.
    // Tag edges are only built on full rebuild; leave them intact on single-file sync.
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.type === 'wiki_link' && edge.source === parsedFile.id) {
        this.edges.delete(edgeId)
      }
    }

    // Preserve aliases for ALL nodes (previous bug wiped them on every single-file sync)
    const maps = buildLookupMaps(
      Array.from(this.nodes.values()).map((n) => ({
        id: n.id,
        title: n.title,
        path: n.path,
        relativePath: n.relativePath,
        aliases: n.aliases || []
      }))
    )

    for (const link of parsedFile.wikiLinks) {
      const targetId = resolveLinkTarget(link.target, maps)
      if (targetId && targetId !== parsedFile.id) {
        const edgeId = `${parsedFile.id}->${targetId}`
        if (!this.edges.has(edgeId)) {
          this.edges.set(edgeId, {
            id: edgeId,
            source: parsedFile.id,
            target: targetId,
            type: 'wiki_link',
            weight: 2
          })
        }
      }
    }

    recomputeDegrees(this.nodes, this.edges)
  }

  removeNode(nodeId: string): void {
    this.nodes.delete(nodeId)
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.source === nodeId || edge.target === nodeId) this.edges.delete(edgeId)
    }
    recomputeDegrees(this.nodes, this.edges)
  }

  getGraphData(): GraphData {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size
    }
  }

  getNeighbors(nodeId: string, depth = 1): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const visitedNodes = new Set<string>([nodeId])
    const resultEdges: GraphEdge[] = []
    let currentLayer = [nodeId]

    for (let d = 0; d < depth; d++) {
      const nextLayer: string[] = []
      for (const currId of currentLayer) {
        for (const edge of this.edges.values()) {
          if (edge.source === currId && !visitedNodes.has(edge.target)) {
            visitedNodes.add(edge.target)
            nextLayer.push(edge.target)
            resultEdges.push(edge)
          } else if (edge.target === currId && !visitedNodes.has(edge.source)) {
            visitedNodes.add(edge.source)
            nextLayer.push(edge.source)
            resultEdges.push(edge)
          }
        }
      }
      currentLayer = nextLayer
    }

    // Exclude center node — "neighbors" must not list self (LocalGraph / context)
    const neighborNodes = Array.from(visitedNodes)
      .filter((id) => id !== nodeId)
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined)

    return { nodes: neighborNodes, edges: resultEdges }
  }

  getNodeById(id: string): GraphNode | undefined {
    return this.nodes.get(id)
  }

  getNodeByPath(filePath: string): GraphNode | undefined {
    // Windows paths are case-insensitive — match lowered so openTab/backlinks work
    const normalizedSearch = filePath.replace(/\\/g, '/').toLowerCase()
    for (const node of this.nodes.values()) {
      if (node.path.replace(/\\/g, '/').toLowerCase() === normalizedSearch) return node
    }
    return undefined
  }

  getBacklinks(nodeId: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const edges: GraphEdge[] = []
    const nodeIds = new Set<string>()
    for (const edge of this.edges.values()) {
      if (edge.type === 'wiki_link' && edge.target === nodeId) {
        edges.push(edge)
        nodeIds.add(edge.source)
      }
    }
    const nodes = Array.from(nodeIds)
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined)
    return { nodes, edges }
  }

  getOutgoingLinks(nodeId: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const edges: GraphEdge[] = []
    const nodeIds = new Set<string>()
    for (const edge of this.edges.values()) {
      if (edge.type === 'wiki_link' && edge.source === nodeId) {
        edges.push(edge)
        nodeIds.add(edge.target)
      }
    }
    const nodes = Array.from(nodeIds)
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined)
    return { nodes, edges }
  }

  getOrphanNodeIds(): string[] {
    return Array.from(this.nodes.values())
      .filter((n) => n.degree === 0)
      .map((n) => n.id)
  }

  /** High-degree hubs (wiki degree). Default threshold matches Obsidian-style “hairball” control. */
  getHubNodeIds(minDegree = 15): string[] {
    const thr = Math.max(1, Math.floor(minDegree))
    return Array.from(this.nodes.values())
      .filter((n) => n.degree >= thr)
      .sort((a, b) => b.degree - a.degree)
      .map((n) => n.id)
  }

  getHubNodes(minDegree = 15): GraphNode[] {
    const ids = new Set(this.getHubNodeIds(minDegree))
    return Array.from(this.nodes.values())
      .filter((n) => ids.has(n.id))
      .sort((a, b) => b.degree - a.degree)
  }

  /** Resolve node id from id or absolute/relative path */
  resolveNodeId(nodeIdOrPath: string): string | null {
    if (!nodeIdOrPath?.trim()) return null
    if (this.nodes.has(nodeIdOrPath)) return nodeIdOrPath
    const byPath = this.getNodeByPath(nodeIdOrPath)
    if (byPath) return byPath.id
    // relative path match
    const norm = nodeIdOrPath.replace(/\\/g, '/').replace(/^\//, '').toLowerCase()
    for (const n of this.nodes.values()) {
      const rel = n.relativePath.replace(/\\/g, '/').toLowerCase()
      if (
        rel === norm ||
        rel === norm + '.md' ||
        rel.endsWith('/' + norm) ||
        rel.endsWith('/' + norm + '.md')
      ) {
        return n.id
      }
    }
    return null
  }

  /**
   * Local graph subgraph (Obsidian local graph foundation).
   * Includes center node + neighbors within depth (1–2).
   * Default: wiki_link edges only (tag edges optional).
   */
  getLocalGraph(
    nodeIdOrPath: string,
    depth = 1,
    options?: { includeTagEdges?: boolean }
  ): {
    centerId: string
    depth: number
    nodes: GraphNode[]
    edges: GraphEdge[]
    nodeCount: number
    edgeCount: number
  } | null {
    const centerId = this.resolveNodeId(nodeIdOrPath)
    if (!centerId || !this.nodes.has(centerId)) return null

    const maxDepth = Math.min(2, Math.max(1, Math.floor(depth) || 1))
    const includeTag = Boolean(options?.includeTagEdges)

    const visited = new Set<string>([centerId])
    let layer = [centerId]
    for (let d = 0; d < maxDepth; d++) {
      const next: string[] = []
      for (const curr of layer) {
        for (const edge of this.edges.values()) {
          if (!includeTag && edge.type === 'tag') continue
          if (edge.type !== 'wiki_link' && edge.type !== 'tag') continue
          let other: string | null = null
          if (edge.source === curr) other = edge.target
          else if (edge.target === curr) other = edge.source
          if (other && !visited.has(other) && this.nodes.has(other)) {
            visited.add(other)
            next.push(other)
          }
        }
      }
      layer = next
    }

    const nodes = Array.from(visited)
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined)

    const edges: GraphEdge[] = []
    for (const edge of this.edges.values()) {
      if (!includeTag && edge.type === 'tag') continue
      if (edge.type !== 'wiki_link' && edge.type !== 'tag') continue
      if (visited.has(edge.source) && visited.has(edge.target)) {
        edges.push(edge)
      }
    }

    return {
      centerId,
      depth: maxDepth,
      nodes,
      edges,
      nodeCount: nodes.length,
      edgeCount: edges.length
    }
  }

  resolveTitleToPath(target: string): string | null {
    const maps = buildLookupMaps(
      Array.from(this.nodes.values()).map((n) => ({
        id: n.id,
        title: n.title,
        path: n.path,
        relativePath: n.relativePath,
        // Must include aliases — Ctrl+click [[alias]] was broken after graph updates
        aliases: n.aliases || []
      }))
    )
    const id = resolveLinkTarget(target, maps)
    if (!id) return null
    return this.nodes.get(id)?.path || null
  }

  /**
   * Build undirected adjacency for wiki_link edges (tag optional).
   * Phase 4 path-finding foundation.
   */
  private buildAdj(includeTagEdges = false): Map<string, Set<string>> {
    const adj = new Map<string, Set<string>>()
    const ensure = (id: string) => {
      if (!adj.has(id)) adj.set(id, new Set())
    }
    for (const n of this.nodes.keys()) ensure(n)
    for (const e of this.edges.values()) {
      if (e.type === 'wiki_link' || (includeTagEdges && e.type === 'tag')) {
        ensure(e.source)
        ensure(e.target)
        adj.get(e.source)!.add(e.target)
        adj.get(e.target)!.add(e.source)
      }
    }
    return adj
  }

  /**
   * Shortest path (BFS) between two notes on wiki links (Obsidian-like path highlight).
   * Accepts node id or path for either endpoint.
   */
  findShortestPath(
    fromIdOrPath: string,
    toIdOrPath: string,
    options?: { includeTagEdges?: boolean; maxDepth?: number }
  ): {
    fromId: string
    toId: string
    found: boolean
    length: number
    nodeIds: string[]
    edgeKeys: string[]
    nodes: GraphNode[]
    edges: GraphEdge[]
  } | null {
    const fromId = this.resolveNodeId(fromIdOrPath)
    const toId = this.resolveNodeId(toIdOrPath)
    if (!fromId || !toId) return null
    if (fromId === toId) {
      const n = this.nodes.get(fromId)
      return {
        fromId,
        toId,
        found: true,
        length: 0,
        nodeIds: [fromId],
        edgeKeys: [],
        nodes: n ? [n] : [],
        edges: []
      }
    }

    const maxDepth = Math.min(50, Math.max(1, options?.maxDepth ?? 32))
    const adj = this.buildAdj(Boolean(options?.includeTagEdges))
    const prev = new Map<string, string | null>()
    const q: string[] = [fromId]
    prev.set(fromId, null)
    let found = false
    const depthAt: Map<string, number> = new Map([[fromId, 0]])

    while (q.length > 0) {
      const cur = q.shift()!
      const d = depthAt.get(cur) ?? 0
      if (d >= maxDepth) continue
      for (const nb of adj.get(cur) || []) {
        if (prev.has(nb)) continue
        prev.set(nb, cur)
        depthAt.set(nb, d + 1)
        if (nb === toId) {
          found = true
          q.length = 0
          break
        }
        q.push(nb)
      }
    }

    if (!found) {
      return {
        fromId,
        toId,
        found: false,
        length: -1,
        nodeIds: [],
        edgeKeys: [],
        nodes: [],
        edges: []
      }
    }

    // Reconstruct path
    const nodeIds: string[] = []
    let walk: string | null = toId
    while (walk) {
      nodeIds.push(walk)
      walk = prev.get(walk) ?? null
    }
    nodeIds.reverse()

    const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
    const edgeKeys: string[] = []
    for (let i = 0; i < nodeIds.length - 1; i++) {
      edgeKeys.push(edgeKey(nodeIds[i], nodeIds[i + 1]))
    }

    const idSet = new Set(nodeIds)
    const edges: GraphEdge[] = []
    for (const e of this.edges.values()) {
      if (e.type !== 'wiki_link' && !(options?.includeTagEdges && e.type === 'tag')) continue
      const k = edgeKey(e.source, e.target)
      if (edgeKeys.includes(k) && idSet.has(e.source) && idSet.has(e.target)) {
        edges.push(e)
      }
    }

    const nodes = nodeIds
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined)

    return {
      fromId,
      toId,
      found: true,
      length: nodeIds.length - 1,
      nodeIds,
      edgeKeys,
      nodes,
      edges
    }
  }

  /**
   * Neighborhood ids including center (paint focus). depth 1–3.
   */
  getNeighborhoodIds(
    nodeIdOrPath: string,
    depth = 1,
    options?: { includeTagEdges?: boolean }
  ): { centerId: string; ids: string[]; edgeKeys: string[] } | null {
    const centerId = this.resolveNodeId(nodeIdOrPath)
    if (!centerId) return null
    const maxDepth = Math.min(3, Math.max(1, Math.floor(depth) || 1))
    const adj = this.buildAdj(Boolean(options?.includeTagEdges))
    const visited = new Set<string>([centerId])
    let layer = [centerId]
    for (let d = 0; d < maxDepth; d++) {
      const next: string[] = []
      for (const cur of layer) {
        for (const nb of adj.get(cur) || []) {
          if (!visited.has(nb)) {
            visited.add(nb)
            next.push(nb)
          }
        }
      }
      layer = next
    }
    const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
    const edgeKeys: string[] = []
    for (const e of this.edges.values()) {
      if (e.type !== 'wiki_link' && !(options?.includeTagEdges && e.type === 'tag')) continue
      if (visited.has(e.source) && visited.has(e.target)) {
        edgeKeys.push(edgeKey(e.source, e.target))
      }
    }
    return { centerId, ids: Array.from(visited), edgeKeys }
  }

  filterByType(types: GraphNode['type'][]): GraphData {
    const filteredNodes = Array.from(this.nodes.values()).filter((n) => types.includes(n.type))
    const filteredIds = new Set(filteredNodes.map((n) => n.id))
    const filteredEdges = Array.from(this.edges.values()).filter(
      (e) => filteredIds.has(e.source) && filteredIds.has(e.target)
    )
    return {
      nodes: filteredNodes,
      edges: filteredEdges,
      nodeCount: filteredNodes.length,
      edgeCount: filteredEdges.length
    }
  }

  filterByTag(tag: string): GraphData {
    const filteredNodes = Array.from(this.nodes.values()).filter((n) =>
      n.tags.some((t) => t.toLowerCase() === tag.toLowerCase())
    )
    const filteredIds = new Set(filteredNodes.map((n) => n.id))
    const filteredEdges = Array.from(this.edges.values()).filter(
      (e) => filteredIds.has(e.source) && filteredIds.has(e.target)
    )
    return {
      nodes: filteredNodes,
      edges: filteredEdges,
      nodeCount: filteredNodes.length,
      edgeCount: filteredEdges.length
    }
  }
}

export const graphEngine = new GraphEngine()
