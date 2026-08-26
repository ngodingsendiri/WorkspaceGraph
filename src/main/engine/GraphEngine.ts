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
    /** Unresolved wikilink target (Obsidian ghost / non-existing file) */
    | 'ghost'
    /** Obsidian tag node (#tag) */
    | 'tag'
    /** Non-markdown vault file (image, pdf, …) */
    | 'attachment'
  path: string
  relativePath: string
  tags: string[]
  /** Kept for wiki resolve after single-file updates (aliases used to be wiped) */
  aliases?: string[]
  /**
   * Cached raw outgoing wikilink targets (pre-resolve).
   * Required for incremental re-resolve when other notes are added/renamed/removed
   * so backlinks reappear without full vault rebuild.
   */
  outLinks?: string[]
  /**
   * True when node is a synthetic unresolved target (not a real vault file).
   * Obsidian: shown when "Existing files only" is off.
   */
  isGhost?: boolean
  /** Synthetic #tag node */
  isTag?: boolean
  /** Non-md file node */
  isAttachment?: boolean
  degree: number
  /**
   * Degree counting wiki_link edges ONLY (WB-4) — hub detection must not be
   * inflated by shared #tags. `degree` remains the visual degree (wiki + tag).
   */
  wikiDegree?: number
  /** M7 G1: temporal metadata from frontmatter (spec 08 node attributes) */
  created?: string
  updated?: string
  pinned?: boolean
  x?: number
  y?: number
  fx?: number | null
  fy?: number | null
}

/** Vault non-markdown file eligible as attachment node */
export interface GraphAttachmentMeta {
  id: string
  path: string
  relativePath: string
  title: string
}

export function tagNodeId(tag: string): string {
  const t = (tag || '').replace(/^#/, '').trim().toLowerCase()
  return t ? `tag:${t}` : ''
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: 'wiki_link' | 'tag' | 'folder' | 'backlink' | 'reference' | 'dependency' | 'related'
  weight: number
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  nodeCount: number
  edgeCount: number
  /** Real markdown notes only (excludes ghosts/tags) */
  realNodeCount?: number
  /** Unresolved target nodes */
  ghostNodeCount?: number
  unresolvedLinkCount?: number
  tagNodeCount?: number
  attachmentNodeCount?: number
}

/** Stable id for an unresolved wikilink target */
export function ghostNodeId(rawTarget: string): string {
  const key = normalizeLinkTarget(rawTarget)
  return key ? `ghost:${key}` : ''
}

type LookupMaps = {
  /** unique key → id ; ambiguous keys omitted (Obsidian: only unique names resolve) */
  unique: Map<string, string>
  /** key → all matching ids (for diagnostics) */
  multi: Map<string, string[]>
  /** M7.4 (G8): path-suffix → id ; ambiguous suffixes omitted. Built once at
   * buildLookupMaps so resolveLinkTarget does O(1) lookups instead of
   * scanning every unique entry per link (O(links × keys)). */
  suffixUnique: Map<string, string>
  /** path-suffix → all candidate ids (step-4 disambiguation) */
  suffixMulti: Map<string, Set<string>>
}

function nodeTypeFromPath(relativePath: string): GraphNode['type'] {
  const lower = relativePath.toLowerCase().replace(/\\/g, '/')
  if (lower.startsWith('knowledge') || lower.includes('/knowledge/')) return 'knowledge'
  if (lower.startsWith('projects') || lower.includes('/projects/')) return 'project'
  if (lower.startsWith('tasks') || lower.includes('/tasks/')) return 'task'
  if (lower.startsWith('daily') || lower.includes('/daily/')) return 'daily'
  if (lower.startsWith('templates') || lower.includes('/templates/')) return 'template'
  if (lower.startsWith('documents') || lower.includes('/documents/')) return 'document'
  if (lower.startsWith('people') || lower.includes('/people/')) return 'people'
  if (lower.startsWith('sop') || lower.includes('/sop/')) return 'sop'
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

/** M7.4 (G8): index one path suffix into the unique/multi suffix maps. */
function addSuffix(maps: LookupMaps, suffix: string, id: string): void {
  if (!suffix) return
  let set = maps.suffixMulti.get(suffix)
  if (!set) maps.suffixMulti.set(suffix, (set = new Set<string>()))
  set.add(id)
  if (set.size === 1) maps.suffixUnique.set(suffix, id)
  else maps.suffixUnique.delete(suffix)
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

  // 2) path link: full-path suffix via prebuilt index (O(1)), then basename
  if (key.includes('/')) {
    const base = key.split('/').pop()!
    // Prefer full path suffix match first
    const suf = maps.suffixUnique.get(key)
    if (suf) return suf
    // Unique basename only
    if (maps.unique.has(base)) return maps.unique.get(base)!
  }

  // 3) ends-with unique path (e.g. "Kerjaan/Cuti/00 Index Cuti") — O(1) via index
  const suf3 = maps.suffixUnique.get(key)
  if (suf3) return suf3

  // 4) multi-map: if exactly one path ends with key
  const candidates = maps.suffixMulti.get(key)
  if (candidates && candidates.size === 1) return [...candidates][0]

  return null
}

function buildLookupMaps(
  items: { id: string; title: string; path: string; relativePath: string; aliases?: string[] }[]
): LookupMaps {
  const maps: LookupMaps = {
    unique: new Map(),
    multi: new Map(),
    suffixUnique: new Map(),
    suffixMulti: new Map()
  }

  for (const file of items) {
    const id = file.id
    addKey(maps, file.title.toLowerCase().trim(), id)

    const baseName = path.basename(file.path, path.extname(file.path))
    addKey(maps, baseName, id)

    const rel = file.relativePath.replace(/\\/g, '/').replace(/\.md$/i, '')
    addKey(maps, rel, id)

    // M7.4 (G8): index every '/'-boundary path suffix once — O(paths×segments)
    // at build time replaces the per-link O(unique) scans in resolveLinkTarget.
    // Suffixes live in the dedicated suffix indexes (NOT unique/multi) so the
    // step-1 exact match keeps its old semantics.
    const parts = rel.split('/').filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      addSuffix(maps, parts.slice(i).join('/'), id)
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

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const k of a) if (!b.has(k)) return false
  return true
}

function recomputeDegrees(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>): void {
  for (const n of nodes.values()) {
    n.degree = 0
    n.wikiDegree = 0
  }
  const neighbors = new Map<string, Set<string>>()
  const wikiNeighbors = new Map<string, Set<string>>()
  for (const e of edges.values()) {
    if (e.type !== 'wiki_link' && e.type !== 'tag') continue
    // Ghost guard: skip edges whose endpoints no longer exist
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue
    // Visual degree: wiki + tag edges (Obsidian tag hubs grow).
    if (!neighbors.has(e.source)) neighbors.set(e.source, new Set())
    if (!neighbors.has(e.target)) neighbors.set(e.target, new Set())
    neighbors.get(e.source)!.add(e.target)
    neighbors.get(e.target)!.add(e.source)
    // Hub degree (WB-4): wiki links only — shared #tags must not inflate hubs.
    if (e.type === 'wiki_link') {
      if (!wikiNeighbors.has(e.source)) wikiNeighbors.set(e.source, new Set())
      if (!wikiNeighbors.has(e.target)) wikiNeighbors.set(e.target, new Set())
      wikiNeighbors.get(e.source)!.add(e.target)
      wikiNeighbors.get(e.target)!.add(e.source)
    }
  }
  for (const [id, set] of neighbors) {
    const n = nodes.get(id)
    if (n) n.degree = set.size
  }
  for (const [id, set] of wikiNeighbors) {
    const n = nodes.get(id)
    if (n) n.wikiDegree = set.size
  }
}

/** Drop edges with missing endpoints (ghosts after rename/delete). */
function pruneGhostEdges(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>): number {
  let removed = 0
  for (const [edgeId, edge] of edges.entries()) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target) || edge.source === edge.target) {
      edges.delete(edgeId)
      removed++
    }
  }
  return removed
}

export class GraphEngine {
  private nodes: Map<string, GraphNode> = new Map()
  private edges: Map<string, GraphEdge> = new Map()
  /** Last attachment list (for incremental rebuild after note update) */
  private attachments: GraphAttachmentMeta[] = []
  /** Whether co-tag star edges between notes are built (legacy toggle) */
  private includeCoTagEdges = false
  /**
   * WB-3 (M5): inverted tag index — tagLower → note ids that carry it (ghosts
   * excluded), kept incrementally so co-tag star edges don't rescan every node
   * per mutation. Membership semantics match the pre-M5 full scan exactly
   * (raw tag.toLowerCase(), no #-strip / trim, tag nodes included).
   */
  private tagIndex = new Map<string, string[]>()
  /** Tags whose membership changed since their star edges were last rebuilt. */
  private dirtyTags = new Set<string>()
  /** Star edge ids created per tag (ownership for stale-edge removal). */
  private tagEdgeIdsByTag = new Map<string, Set<string>>()

  /** Drop all graph state (workspace close / switch). */
  clear(): void {
    this.nodes.clear()
    this.edges.clear()
    this.attachments = []
    this.includeCoTagEdges = false
    this.tagIndex.clear()
    this.dirtyTags.clear()
    this.tagEdgeIdsByTag.clear()
  }

  private buildLookupFromNodes(): LookupMaps {
    // Ghosts & pure tag nodes never resolve as file targets.
    // Attachments + real notes do (Obsidian: [[file.png]] / [[Note]]).
    return buildLookupMaps(
      Array.from(this.nodes.values())
        .filter((n) => !n.isGhost && !n.isTag)
        .map((n) => ({
          id: n.id,
          title: n.title,
          path: n.path,
          relativePath: n.relativePath,
          aliases: n.aliases || []
        }))
    )
  }

  /** Remove all synthetic ghost nodes (and their edges will be rebuilt). */
  private clearGhostNodes(): void {
    for (const [id, n] of this.nodes.entries()) {
      if (n.isGhost) this.nodes.delete(id)
    }
  }

  private clearTagNodes(): void {
    for (const [id, n] of this.nodes.entries()) {
      if (n.isTag) this.nodes.delete(id)
    }
    for (const [edgeId] of this.edges.entries()) {
      // note→#tag edges only (co-tag star edges use id `tag:a<->b`)
      if (edgeId.startsWith('tagnode:')) this.edges.delete(edgeId)
    }
  }

  private clearAttachmentNodes(): void {
    for (const [id, n] of this.nodes.entries()) {
      if (n.isAttachment) this.nodes.delete(id)
    }
  }

  /**
   * Obsidian-like #tag nodes: one node per tag, edges from notes that use it.
   * Always built; UI hides via showTags filter.
   */
  private rebuildTagNodes(): void {
    this.clearTagNodes()
    const tagToNotes = new Map<string, string[]>()
    for (const n of this.nodes.values()) {
      if (n.isGhost || n.isTag || n.isAttachment) continue
      for (const raw of n.tags || []) {
        const t = String(raw).replace(/^#/, '').trim().toLowerCase()
        if (!t) continue
        const list = tagToNotes.get(t) || []
        list.push(n.id)
        tagToNotes.set(t, list)
      }
    }
    for (const [tag, noteIds] of tagToNotes) {
      const id = tagNodeId(tag)
      if (!id) continue
      this.nodes.set(id, {
        id,
        title: `#${tag}`,
        type: 'tag',
        path: '',
        relativePath: `#${tag}`,
        tags: [tag],
        isTag: true,
        degree: 0
      })
      // M7.1 (G4): ALWAYS create note→#tag edges. The old guard skipped these
      // when co-tag star edges were on, because the pre-WB-3 full rebuild
      // wiped them right after creation (create-then-delete). Since WB-3 the
      // star edges are rebuilt incrementally via rebuildDirtyTagEdges() and
      // nothing removes tagnode: edges anymore — so skipping them just left
      // every #tag node as an isolated degree-0 island in production.
      for (const noteId of noteIds) {
        const edgeId = `tagnode:${noteId}->${id}`
        this.edges.set(edgeId, {
          id: edgeId,
          source: noteId,
          target: id,
          type: 'tag',
          weight: 1
        })
      }
    }
  }

  /**
   * Register non-md vault files as attachment nodes (Obsidian Attachments filter).
   * Re-resolves wiki edges so [[image.png]] links to real attachment nodes.
   */
  setAttachments(list: GraphAttachmentMeta[]): void {
    this.attachments = Array.isArray(list) ? list.slice(0, 8000) : []
    this.clearAttachmentNodes()
    for (const a of this.attachments) {
      if (!a?.id || !a.path) continue
      // Don't clobber a markdown node with same id
      const existing = this.nodes.get(a.id)
      if (existing && !existing.isAttachment) continue
      this.nodes.set(a.id, {
        id: a.id,
        title: a.title || path.basename(a.path),
        type: 'attachment',
        path: a.path,
        relativePath: a.relativePath || '',
        tags: [],
        isAttachment: true,
        degree: 0
      })
    }
    // Re-resolve wiki (attachments now resolvable) + tags
    this.rebuildWikiEdgesFromOutLinks()
    this.rebuildTagNodes()
    if (this.includeCoTagEdges) this.rebuildDirtyTagEdges()
    recomputeDegrees(this.nodes, this.edges)
  }

  /** Lightweight: upsert one attachment without wiping the rest. */
  upsertAttachment(meta: GraphAttachmentMeta): void {
    if (!meta?.id || !meta.path) return
    const existing = this.nodes.get(meta.id)
    if (existing && !existing.isAttachment) return
    const idx = this.attachments.findIndex((a) => a.id === meta.id || a.path === meta.path)
    if (idx >= 0) this.attachments[idx] = meta
    else {
      if (this.attachments.length >= 8000) return
      this.attachments.push(meta)
    }
    this.nodes.set(meta.id, {
      id: meta.id,
      title: meta.title || path.basename(meta.path),
      type: 'attachment',
      path: meta.path,
      relativePath: meta.relativePath || '',
      tags: [],
      isAttachment: true,
      degree: existing?.degree ?? 0
    })
    this.rebuildWikiEdgesFromOutLinks()
    this.rebuildTagNodes()
    if (this.includeCoTagEdges) this.rebuildDirtyTagEdges()
    recomputeDegrees(this.nodes, this.edges)
  }

  /** Lightweight: remove one attachment by id or path. */
  removeAttachment(idOrPath: string): void {
    if (!idOrPath) return
    const node =
      this.nodes.get(idOrPath) ||
      Array.from(this.nodes.values()).find(
        (n) => n.isAttachment && (n.path === idOrPath || n.id === idOrPath)
      )
    if (!node?.isAttachment) return
    this.attachments = this.attachments.filter((a) => a.id !== node.id && a.path !== node.path)
    this.nodes.delete(node.id)
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.source === node.id || edge.target === node.id) this.edges.delete(edgeId)
    }
    this.rebuildWikiEdgesFromOutLinks()
    this.rebuildTagNodes()
    if (this.includeCoTagEdges) this.rebuildDirtyTagEdges()
    recomputeDegrees(this.nodes, this.edges)
  }

  private ensureGhostNode(rawTarget: string): string | null {
    // F-2 (testing 2026-08-11): template placeholders like [[{{project}}]] are
    // NOT unresolved links — never mint a ghost node for them (defensive: the
    // index already excludes Templates/, this guards future regressions).
    if (/\{\{[^}]*\}\}/.test(rawTarget)) return null
    const key = normalizeLinkTarget(rawTarget)
    if (!key) return null
    const id = ghostNodeId(rawTarget)
    if (!id) return null
    const existing = this.nodes.get(id)
    if (existing?.isGhost) {
      // Prefer display title from first seen raw (pretty case)
      return id
    }
    // Pretty title: last path segment of raw (strip heading)
    const pretty = (rawTarget || '')
      .trim()
      .split('#')[0]
      .split('^')[0]
      .replace(/\\/g, '/')
      .replace(/\.md$/i, '')
      .split('/')
      .filter(Boolean)
      .pop()
    const title = (pretty || key).slice(0, 80)
    this.nodes.set(id, {
      id,
      title,
      type: 'ghost',
      path: '',
      relativePath: `?/${key}`,
      tags: [],
      isGhost: true,
      degree: 0
    })
    return id
  }

  /**
   * Rebuild ALL wiki edges from cached outLinks on every node.
   * Critical after add/rename/delete so notes that still say [[NewTitle]]
   * re-link without waiting for each source file to be re-parsed.
   *
   * Unresolved targets become ghost nodes (Obsidian non-existing files).
   */
  private rebuildWikiEdgesFromOutLinks(): { linked: number; unresolved: number } {
    // Drop wiki edges only; keep tag edges until full rebuild
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.type === 'wiki_link') this.edges.delete(edgeId)
    }
    this.clearGhostNodes()

    const maps = this.buildLookupFromNodes()
    let linked = 0
    let unresolved = 0

    for (const node of this.nodes.values()) {
      if (node.isGhost || node.isTag || node.isAttachment) continue
      const outs = node.outLinks || []
      for (const raw of outs) {
        if (!raw?.trim()) continue
        const targetId = resolveLinkTarget(raw, maps)
        const tgt = targetId ? this.nodes.get(targetId) : undefined
        if (targetId && targetId !== node.id && tgt && !tgt.isGhost && !tgt.isTag) {
          const edgeId = `${node.id}->${targetId}`
          if (!this.edges.has(edgeId)) {
            this.edges.set(edgeId, {
              id: edgeId,
              source: node.id,
              target: targetId,
              type: 'wiki_link',
              weight: 2
            })
            linked++
          }
        } else if (raw.trim()) {
          const gid = this.ensureGhostNode(raw)
          if (gid && gid !== node.id) {
            const edgeId = `${node.id}->${gid}`
            if (!this.edges.has(edgeId)) {
              this.edges.set(edgeId, {
                id: edgeId,
                source: node.id,
                target: gid,
                type: 'wiki_link',
                weight: 1
              })
            }
            unresolved++
          }
        }
      }
    }

    pruneGhostEdges(this.nodes, this.edges)
    recomputeDegrees(this.nodes, this.edges)
    return { linked, unresolved }
  }

  /**
   * WB-3 (M5): rebuild the inverted tag index from scratch (full builds only —
   * buildFromParsedFiles). Marks every tag dirty so the first
   * rebuildDirtyTagEdges rebuilds the whole star-edge set.
   */
  private rebuildTagIndex(): void {
    this.tagIndex.clear()
    this.dirtyTags.clear()
    this.tagEdgeIdsByTag.clear()
    for (const n of this.nodes.values()) {
      if (n.isGhost) continue
      for (const raw of n.tags || []) {
        const tagLower = String(raw).toLowerCase()
        const list = this.tagIndex.get(tagLower)
        if (list) list.push(n.id)
        else this.tagIndex.set(tagLower, [n.id])
        this.dirtyTags.add(tagLower)
      }
    }
  }

  /**
   * WB-3 (M5): keep the inverted tag index in sync with one node's tags.
   * `remove` drops the node from every tag list (node deletion / tag change).
   * The affected tags are marked dirty so their star edges rebuild lazily.
   */
  private syncNodeTags(
    node: { id: string; isGhost?: boolean; tags?: string[] },
    remove = false
  ): void {
    if (!node || node.isGhost) return
    for (const raw of node.tags || []) {
      const tagLower = String(raw).toLowerCase()
      if (remove) {
        const list = this.tagIndex.get(tagLower)
        if (list) {
          const i = list.indexOf(node.id)
          if (i >= 0) list.splice(i, 1)
          if (list.length === 0) this.tagIndex.delete(tagLower)
        }
        this.dirtyTags.add(tagLower)
      } else {
        let list = this.tagIndex.get(tagLower)
        if (!list) {
          list = []
          this.tagIndex.set(tagLower, list)
        }
        if (!list.includes(node.id)) {
          list.push(node.id)
          this.dirtyTags.add(tagLower)
        }
      }
    }
  }

  /**
   * WB-3 (M5): rebuild co-tag star edges ONLY for tags whose membership changed
   * (inverted index — no full node scan). Star edge ids are owned per tag, so
   * stale edges for departed members are removed too. Edge-case note: when the
   * same note pair carries two tags, the star edge belongs to whichever tag
   * created it first; if that tag's membership drops the pair, ownership is
   * transferred to the other tag (pairConnectedByOtherTag) so the edge survives.
   */
  private rebuildDirtyTagEdges(): void {
    if (this.dirtyTags.size === 0) return
    for (const tagLower of this.dirtyTags) {
      const created = this.tagEdgeIdsByTag.get(tagLower)
      if (created) {
        for (const edgeId of created) {
          // `tag:${hub}<->${tgt}` — if another tag still connects the pair,
          // keep the edge and transfer ownership to it.
          const sep = edgeId.indexOf('<->')
          const a = sep > 4 ? edgeId.slice(4, sep) : ''
          const b = sep > 0 ? edgeId.slice(sep + 3) : ''
          const owner = a && b ? this.pairConnectedByOtherTag(a, b, tagLower) : null
          if (owner) {
            const ownerSet = this.tagEdgeIdsByTag.get(owner)
            if (ownerSet) ownerSet.add(edgeId)
            continue
          }
          this.edges.delete(edgeId)
        }
        created.clear()
      }
      const memberIds = this.tagIndex.get(tagLower) ?? []
      if (this.includeCoTagEdges && memberIds.length >= 2 && memberIds.length <= 8) {
        const hub = memberIds[0]
        for (let i = 1; i < memberIds.length; i++) {
          const tgtId = memberIds[i]
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
            let ownerSet = this.tagEdgeIdsByTag.get(tagLower)
            if (!ownerSet) {
              ownerSet = new Set()
              this.tagEdgeIdsByTag.set(tagLower, ownerSet)
            }
            ownerSet.add(edgeId)
          }
        }
      }
    }
    this.dirtyTags.clear()
  }

  /** True if any tag OTHER than exceptTag connects both note ids. */
  private pairConnectedByOtherTag(a: string, b: string, exceptTag: string): string | null {
    for (const [tagLower, ids] of this.tagIndex) {
      if (tagLower === exceptTag) continue
      if (ids.includes(a) && ids.includes(b)) return tagLower
    }
    return null
  }

  private displayTitleFromParsed(parsedFile: ParsedMarkdown): string {
    const fmTitle = parsedFile.title?.trim()
    if (fmTitle && fmTitle.length > 0 && fmTitle.length <= 48 && !/^#+\s/.test(fmTitle)) {
      return fmTitle
    }
    return path.basename(parsedFile.filePath, path.extname(parsedFile.filePath))
  }

  private outLinksFromParsed(parsedFile: ParsedMarkdown): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const link of parsedFile.wikiLinks || []) {
      const t = (link.target || '').trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      out.push(t)
    }
    return out
  }

  /**
   * Build graph.
   * Default includeTagEdges=false → co-tag star edges off; #tag nodes always built.
   */
  buildFromParsedFiles(parsedFiles: ParsedMarkdown[], includeTagEdges = false): GraphData {
    this.nodes.clear()
    this.edges.clear()
    this.includeCoTagEdges = includeTagEdges
    // Keep attachments list across rebuild if vault re-index; re-apply after notes
    const savedAttachments = this.attachments

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
        outLinks: this.outLinksFromParsed(file),
        degree: 0
      }
      // Prefer frontmatter/H1 title when short enough; long emoji titles clutter graph
      const fmTitle = file.title?.trim()
      if (fmTitle && fmTitle.length > 0 && fmTitle.length <= 48 && !/^#+\s/.test(fmTitle)) {
        node.title = fmTitle
      }
      this.nodes.set(file.id, node)
    }

    // Re-attach non-md files so [[file.pdf]] resolves before ghost fallback
    if (savedAttachments.length > 0) {
      for (const a of savedAttachments) {
        if (!a?.id || !a.path) continue
        if (this.nodes.has(a.id)) continue
        this.nodes.set(a.id, {
          id: a.id,
          title: a.title || path.basename(a.path),
          type: 'attachment',
          path: a.path,
          relativePath: a.relativePath || '',
          tags: [],
          isAttachment: true,
          degree: 0
        })
      }
    }

    const { linked, unresolved } = this.rebuildWikiEdgesFromOutLinks()
    this.rebuildTagIndex()
    this.rebuildTagNodes()
    if (includeTagEdges) this.rebuildDirtyTagEdges()
    recomputeDegrees(this.nodes, this.edges)

    if (unresolved > 0) {
      console.log(`[GraphEngine] wiki edges=${linked}, unresolved=${unresolved}`)
    } else {
      console.log(`[GraphEngine] wiki edges=${linked} (all resolved)`)
    }

    return this.getGraphData()
  }

  /**
   * WB-3: every way a [[link]] can address this node (title, basename, relative
   * path + suffixes, aliases) — used to find OTHER notes whose edges must be
   * re-resolved when this node is added/renamed/removed.
   */
  private identityKeys(node: GraphNode): Set<string> {
    const keys = new Set<string>()
    const add = (k: string): void => {
      if (k) keys.add(k.toLowerCase().trim())
    }
    add(node.title)
    add(path.basename(node.path, path.extname(node.path)))
    const rel = (node.relativePath || '').replace(/\\/g, '/').replace(/\.md$/i, '')
    add(rel)
    const parts = rel.split('/').filter(Boolean)
    for (let i = 0; i < parts.length; i++) add(parts.slice(i).join('/'))
    for (const a of node.aliases || []) add(a)
    return keys
  }

  /**
   * WB-3: nodes (other than skipId) whose cached outLinks reference any of the
   * given identity keys — they need their outgoing edges re-resolved.
   */
  private collectAffectedByKeys(keys: Set<string>, skipId: string): Set<string> {
    const affected = new Set<string>()
    if (keys.size === 0) return affected
    for (const node of this.nodes.values()) {
      if (node.id === skipId) continue
      if (node.isGhost || node.isTag || node.isAttachment) continue
      for (const raw of node.outLinks || []) {
        if (!raw) continue
        if (keys.has(normalizeLinkTarget(raw))) {
          affected.add(node.id)
          break
        }
      }
    }
    return affected
  }

  /** WB-3: drop ghost nodes that are no longer referenced by any wiki edge. */
  private pruneOrphanGhostNodes(): void {
    const referenced = new Set<string>()
    for (const e of this.edges.values()) {
      if (e.type === 'wiki_link') {
        referenced.add(e.source)
        referenced.add(e.target)
      }
    }
    for (const [id, n] of this.nodes.entries()) {
      if (n.isGhost && !referenced.has(id)) this.nodes.delete(id)
    }
  }

  /**
   * WB-3: rebuild ONLY the outgoing wiki edges of the given nodes. Incoming
   * edges are owned by their source nodes and only change when those sources
   * re-resolve (they are found via collectAffectedByKeys).
   */
  private rebuildWikiEdgesForNodes(nodeIds: Iterable<string>, maps: LookupMaps): void {
    for (const nodeId of nodeIds) {
      const node = this.nodes.get(nodeId)
      if (!node || node.isGhost || node.isTag || node.isAttachment) continue
      for (const [edgeId, edge] of this.edges.entries()) {
        if (edge.type === 'wiki_link' && edge.source === nodeId) this.edges.delete(edgeId)
      }
      for (const raw of node.outLinks || []) {
        if (!raw?.trim()) continue
        const targetId = resolveLinkTarget(raw, maps)
        const tgt = targetId ? this.nodes.get(targetId) : undefined
        if (targetId && targetId !== nodeId && tgt && !tgt.isGhost && !tgt.isTag) {
          const edgeId = `${nodeId}->${targetId}`
          if (!this.edges.has(edgeId)) {
            this.edges.set(edgeId, {
              id: edgeId,
              source: nodeId,
              target: targetId,
              type: 'wiki_link',
              weight: 2
            })
          }
        } else if (raw.trim()) {
          const gid = this.ensureGhostNode(raw)
          if (gid && gid !== nodeId) {
            const edgeId = `${nodeId}->${gid}`
            if (!this.edges.has(edgeId)) {
              this.edges.set(edgeId, {
                id: edgeId,
                source: nodeId,
                target: gid,
                type: 'wiki_link',
                weight: 1
              })
            }
          }
        }
      }
    }
  }

  updateNodeAndEdges(parsedFile: ParsedMarkdown): void {
    const aliases = Array.isArray(parsedFile.frontmatter?.aliases)
      ? parsedFile.frontmatter.aliases.map(String)
      : []
    // M7 G1: temporal metadata from frontmatter (spec 08 node attributes)
    const created = parsedFile.frontmatter.created
      ? String(parsedFile.frontmatter.created)
      : undefined
    const updated = parsedFile.frontmatter.updated
      ? String(parsedFile.frontmatter.updated)
      : undefined
    const existing = this.nodes.get(parsedFile.id)
    const wasReal = !!(existing && !existing.isAttachment && !existing.isTag && !existing.isGhost)
    const oldKeys = wasReal && existing ? this.identityKeys(existing) : new Set<string>()
    // WB-3 (M5): drop the OLD tag membership from the inverted index before the
    // in-place mutation below overwrites existing.tags.
    if (wasReal && existing) this.syncNodeTags(existing, true)
    const displayTitle = this.displayTitleFromParsed(parsedFile)
    const outLinks = this.outLinksFromParsed(parsedFile)
    const nodeType = nodeTypeFromPath(parsedFile.relativePath)

    if (wasReal && existing) {
      existing.title = displayTitle
      existing.tags = parsedFile.tags
      existing.aliases = aliases
      existing.path = parsedFile.filePath
      existing.relativePath = parsedFile.relativePath
      existing.type = nodeType
      existing.outLinks = outLinks
      if (created) existing.created = created
      if (updated) existing.updated = updated
    } else if (existing && existing.isAttachment) {
      // WB-10: file flipped from attachment to note (e.g. .png → .md). Convert
      // in place instead of leaving a stale attachment node until a full
      // rebuild; the old attachment registry entry is dropped too. (Re-resolve
      // of linkers is covered by the !wasReal branch below — new identity keys.)
      existing.title = displayTitle
      existing.tags = parsedFile.tags
      existing.aliases = aliases
      existing.path = parsedFile.filePath
      existing.relativePath = parsedFile.relativePath
      existing.type = nodeType
      existing.outLinks = outLinks
      if (created) existing.created = created
      if (updated) existing.updated = updated
      existing.isAttachment = false
      this.attachments = this.attachments.filter(
        (a) => a.id !== parsedFile.id && a.path !== parsedFile.filePath
      )
    } else if (!existing) {
      this.nodes.set(parsedFile.id, {
        id: parsedFile.id,
        title: displayTitle,
        type: nodeType,
        path: parsedFile.filePath,
        relativePath: parsedFile.relativePath,
        tags: parsedFile.tags,
        aliases,
        outLinks,
        degree: 0,
        ...(created ? { created } : {}),
        ...(updated ? { updated } : {})
      })
    }

    // WB-3: incremental wiki-edge update. For a plain content edit (identity
    // unchanged) only this node's own edges are rebuilt; when the node is
    // added/renamed (identity changed) also re-resolve every node that links
    // to its old/new identity — NOT the whole graph's outLinks.
    const newNode = this.nodes.get(parsedFile.id)
    // WB-3 (M5): record the NEW tag membership (adds the node to the index and
    // marks affected tags dirty for the lazy star-edge rebuild).
    if (newNode) this.syncNodeTags(newNode, false)
    const newKeys =
      newNode && !newNode.isGhost && !newNode.isTag && !newNode.isAttachment
        ? this.identityKeys(newNode)
        : new Set<string>()

    const affected = new Set<string>([parsedFile.id])
    if (!wasReal || !setsEqual(oldKeys, newKeys)) {
      const union = new Set(oldKeys)
      for (const k of newKeys) union.add(k)
      for (const id of this.collectAffectedByKeys(union, parsedFile.id)) affected.add(id)
    }

    const maps = this.buildLookupFromNodes()
    this.rebuildWikiEdgesForNodes(affected, maps)
    this.pruneOrphanGhostNodes()

    // M7 G5: incremental tag-node update — remove old tagnode edges for THIS
    // node, then re-create from the (already synced) inverted index. The old
    // code called rebuildTagNodes() which cleared ALL #tag nodes + edges then
    // rebuilt from scratch — O(total_notes × avg_tags) per single-file save.
    const nid = parsedFile.id
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edgeId.startsWith('tagnode:') && edge.source === nid) this.edges.delete(edgeId)
    }
    const updatedNode = this.nodes.get(nid)
    for (const raw of updatedNode?.tags || []) {
      const t = String(raw).replace(/^#/, '').trim().toLowerCase()
      if (!t) continue
      const tagId = tagNodeId(t)
      if (!tagId || !this.nodes.has(tagId)) continue
      const edgeId = `tagnode:${nid}->${tagId}`
      if (!this.edges.has(edgeId)) {
        this.edges.set(edgeId, { id: edgeId, source: nid, target: tagId, type: 'tag', weight: 1 })
      }
    }
    if (this.includeCoTagEdges) this.rebuildDirtyTagEdges()
    recomputeDegrees(this.nodes, this.edges)
  }

  removeNode(nodeId: string): void {
    const node = this.nodes.get(nodeId)
    if (node) this.syncNodeTags(node, true)
    const keys =
      node && !node.isGhost && !node.isTag && !node.isAttachment
        ? this.identityKeys(node)
        : new Set<string>()
    this.nodes.delete(nodeId)
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.source === nodeId || edge.target === nodeId) this.edges.delete(edgeId)
    }
    // WB-3: re-resolve only nodes that linked the removed note (their links
    // become unresolved ghosts) instead of the whole graph. Links that used an
    // ambiguous short name may also become uniquely resolvable again.
    const affected = this.collectAffectedByKeys(keys, nodeId)
    const maps = this.buildLookupFromNodes()
    this.rebuildWikiEdgesForNodes(affected, maps)
    this.pruneOrphanGhostNodes()

    this.rebuildTagNodes()
    if (this.includeCoTagEdges) this.rebuildDirtyTagEdges()
    recomputeDegrees(this.nodes, this.edges)
  }

  /**
   * WA-2: cascade-remove every node (notes + attachments) whose path lives under
   * dirPath — used when a whole folder is deleted (unlinkDir / file:delete on a
   * directory). One pass + one re-resolve instead of N×removeNode.
   * Returns the number of nodes removed.
   */
  removeNodesUnderPath(dirPath: string): number {
    const prefix = dirPath.replace(/\\/g, '/').toLowerCase()
    let count = 0
    const removedKeys = new Set<string>()
    for (const [id, n] of this.nodes.entries()) {
      const p = (n.path || '').replace(/\\/g, '/').toLowerCase()
      if (p === prefix || p.startsWith(prefix + '/')) {
        if (!n.isGhost && !n.isTag && !n.isAttachment) {
          for (const k of this.identityKeys(n)) removedKeys.add(k)
        }
        // WB-3 (M5): drop every removed node from the inverted tag index.
        this.syncNodeTags(n, true)
        this.nodes.delete(id)
        count++
      }
    }
    // Drop the attachment registry entries for the same subtree too.
    this.attachments = this.attachments.filter((a) => {
      const p = (a.path || '').replace(/\\/g, '/').toLowerCase()
      return !(p === prefix || p.startsWith(prefix + '/'))
    })
    if (count > 0) {
      for (const [edgeId, edge] of this.edges.entries()) {
        if (!this.nodes.has(edge.source) || !this.nodes.has(edge.target)) this.edges.delete(edgeId)
      }
      // WB-3: re-resolve only nodes that linked into the removed subtree.
      const affected = this.collectAffectedByKeys(removedKeys, '')
      const maps = this.buildLookupFromNodes()
      this.rebuildWikiEdgesForNodes(affected, maps)
      this.pruneOrphanGhostNodes()

      this.rebuildTagNodes()
      if (this.includeCoTagEdges) this.rebuildDirtyTagEdges()
      recomputeDegrees(this.nodes, this.edges)
    }
    return count
  }

  /**
   * Export graph for UI / IPC.
   * Ghosts/tags/attachments always included; client filters (Existing files / Tags / Attachments).
   */
  /**
   * Export full graph for UI/IPC.
   * Default: include ghosts, tags, attachments — renderer filters by settings
   * (Existing files only / Tags / Attachments). Opt-out via options if needed.
   */
  getGraphData(options?: {
    includeGhosts?: boolean
    includeTags?: boolean
    includeAttachments?: boolean
  }): GraphData {
    pruneGhostEdges(this.nodes, this.edges)
    // Defaults TRUE so Graph View always receives full data (client-side filters)
    const includeGhosts = options?.includeGhosts !== false
    const includeTags = options?.includeTags !== false
    const includeAttachments = options?.includeAttachments !== false

    const all = Array.from(this.nodes.values())
    const realNodeCount = all.filter((n) => !n.isGhost && !n.isTag && !n.isAttachment).length
    const ghostNodeCount = all.filter((n) => n.isGhost).length
    const tagNodeCount = all.filter((n) => n.isTag).length
    const attachmentNodeCount = all.filter((n) => n.isAttachment).length
    const nodes = all
      .filter((n) => {
        if (!includeGhosts && n.isGhost) return false
        if (!includeTags && n.isTag) return false
        if (!includeAttachments && n.isAttachment) return false
        return true
      })
      .map((n) => {
        const { outLinks: _ol, ...rest } = n
        return rest as GraphNode
      })
    const idSet = new Set(nodes.map((n) => n.id))
    const edges = Array.from(this.edges.values()).filter(
      (e) => idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target
    )
    return {
      nodes,
      edges,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      realNodeCount,
      ghostNodeCount,
      unresolvedLinkCount: ghostNodeCount,
      tagNodeCount,
      attachmentNodeCount
    }
  }

  /**
   * Skeleton graph for Global Graph view on large vaults.
   * Returns only lightweight node metadata — no outLinks, no heavy internal fields.
   * The renderer can use this for layout calculation without stressing IPC serialization.
   */
  getGraphSkeleton(): {
    nodes: Pick<
      GraphNode,
      | 'id'
      | 'title'
      | 'type'
      | 'relativePath'
      | 'tags'
      | 'degree'
      | 'x'
      | 'y'
      | 'pinned'
      | 'isGhost'
      | 'isTag'
      | 'isAttachment'
      | 'path'
    >[]
    edges: GraphEdge[]
    nodeCount: number
    edgeCount: number
    realNodeCount: number
  } {
    pruneGhostEdges(this.nodes, this.edges)
    const allNodes = Array.from(this.nodes.values())
    const skeletonNodes = allNodes.map((n) => ({
      id: n.id,
      title: n.title,
      type: n.type,
      relativePath: n.relativePath,
      path: n.path,
      tags: n.tags,
      degree: n.degree,
      x: n.x,
      y: n.y,
      pinned: n.pinned,
      isGhost: n.isGhost,
      isTag: n.isTag,
      isAttachment: n.isAttachment
    }))
    const idSet = new Set(skeletonNodes.map((n) => n.id))
    const edges = Array.from(this.edges.values()).filter(
      (e) => idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target
    )
    const realNodeCount = allNodes.filter((n) => !n.isGhost && !n.isTag && !n.isAttachment).length
    return {
      nodes: skeletonNodes,
      edges,
      nodeCount: skeletonNodes.length,
      edgeCount: edges.length,
      realNodeCount
    }
  }

  getGhostNodeIds(): string[] {
    return Array.from(this.nodes.values())
      .filter((n) => n.isGhost)
      .map((n) => n.id)
  }

  getRealNodeCount(): number {
    let c = 0
    for (const n of this.nodes.values()) if (!n.isGhost) c++
    return c
  }

  getNeighbors(
    nodeId: string,
    depth = 1,
    options?: { includeTagEdges?: boolean; includeGhosts?: boolean }
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const maxDepth = Math.min(5, Math.max(1, Math.floor(depth) || 1))
    const includeTag = Boolean(options?.includeTagEdges)
    const includeGhosts = Boolean(options?.includeGhosts)
    const visitedNodes = new Set<string>([nodeId])
    let currentLayer = [nodeId]

    const okNode = (id: string): boolean => {
      const n = this.nodes.get(id)
      if (!n) return false
      if (!includeGhosts && n.isGhost) return false
      if (!includeTag && n.isTag) return false
      return true
    }

    // M7.4 (G7): build an adjacency list ONCE (O(E)) instead of scanning all
    // edges for every node in every layer (old: O(depth × nodes × edges)).
    const adjacency = new Map<string, string[]>()
    for (const edge of this.edges.values()) {
      if (!includeTag && edge.type === 'tag') continue
      if (edge.type !== 'wiki_link' && edge.type !== 'tag') continue
      let s = adjacency.get(edge.source)
      if (!s) adjacency.set(edge.source, (s = []))
      s.push(edge.target)
      let t = adjacency.get(edge.target)
      if (!t) adjacency.set(edge.target, (t = []))
      t.push(edge.source)
    }

    for (let d = 0; d < maxDepth; d++) {
      const nextLayer: string[] = []
      for (const currId of currentLayer) {
        for (const other of adjacency.get(currId) ?? []) {
          if (!visitedNodes.has(other) && okNode(other)) {
            visitedNodes.add(other)
            nextLayer.push(other)
          }
        }
      }
      currentLayer = nextLayer
    }

    // All edges fully inside the neighborhood (including cross-links between neighbors)
    const resultEdges: GraphEdge[] = []
    for (const edge of this.edges.values()) {
      if (!includeTag && edge.type === 'tag') continue
      if (edge.type !== 'wiki_link' && edge.type !== 'tag') continue
      if (visitedNodes.has(edge.source) && visitedNodes.has(edge.target)) {
        // Skip ghost endpoints unless explicitly requested
        if (!includeGhosts) {
          const a = this.nodes.get(edge.source)
          const b = this.nodes.get(edge.target)
          if (a?.isGhost || b?.isGhost) continue
        }
        resultEdges.push(edge)
      }
    }

    // Exclude center node — "neighbors" must not list self (LocalGraph / context)
    const neighborNodes = Array.from(visitedNodes)
      .filter((id) => id !== nodeId)
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined)
      .map((n) => this.stripInternal(n))

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
    // Orphans = real notes with no wiki connections (ghosts/tags/attachments never count)
    const connectedToWiki = new Set<string>()
    for (const e of this.edges.values()) {
      if (e.type === 'wiki_link') {
        connectedToWiki.add(e.source)
        connectedToWiki.add(e.target)
      }
    }
    return Array.from(this.nodes.values())
      .filter((n) => !n.isGhost && !n.isTag && !n.isAttachment && !connectedToWiki.has(n.id))
      .map((n) => n.id)
  }

  /** High-degree hubs (wiki degree only — WB-4: tag edges never inflate hubs). */
  getHubNodeIds(minDegree = 15): string[] {
    const thr = Math.max(1, Math.floor(minDegree))
    const hubDegree = (n: GraphNode): number => n.wikiDegree ?? n.degree
    return Array.from(this.nodes.values())
      .filter((n) => !n.isGhost && !n.isTag && !n.isAttachment && hubDegree(n) >= thr)
      .sort((a, b) => hubDegree(b) - hubDegree(a))
      .map((n) => n.id)
  }

  getHubNodes(minDegree = 15): GraphNode[] {
    const ids = new Set(this.getHubNodeIds(minDegree))
    const hubDegree = (n: GraphNode): number => n.wikiDegree ?? n.degree
    return Array.from(this.nodes.values())
      .filter((n) => ids.has(n.id))
      .sort((a, b) => hubDegree(b) - hubDegree(a))
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
   * Includes center node + neighbors within depth (1–5, Obsidian-like).
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

    const maxDepth = Math.min(5, Math.max(1, Math.floor(depth) || 1))
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
      .map((n) => this.stripInternal(n))

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
    // Exclude ghosts/tags — only real files + attachments have openable paths
    const maps = buildLookupMaps(
      Array.from(this.nodes.values())
        .filter((n) => !n.isGhost && !n.isTag && Boolean(n.path))
        .map((n) => ({
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
    const node = this.nodes.get(id)
    if (!node?.path || node.isGhost || node.isTag) return null
    return node.path
  }

  /**
   * Build undirected adjacency for wiki_link edges (tag optional).
   * Phase 4 path-finding foundation.
   */
  /**
   * Undirected adjacency for path / neighborhood.
   * Default: real notes + attachments only (no ghosts, no tag-hub hops).
   */
  private buildAdj(
    includeTagEdges = false,
    options?: { includeGhosts?: boolean }
  ): Map<string, Set<string>> {
    const includeGhosts = Boolean(options?.includeGhosts)
    const adj = new Map<string, Set<string>>()
    const ensure = (id: string): void => {
      if (!adj.has(id)) adj.set(id, new Set())
    }
    const allowed = (id: string): boolean => {
      const n = this.nodes.get(id)
      if (!n) return false
      if (!includeGhosts && n.isGhost) return false
      // Tag nodes only participate when includeTagEdges (Obsidian path is note-to-note)
      if (n.isTag && !includeTagEdges) return false
      return true
    }
    for (const id of this.nodes.keys()) {
      if (allowed(id)) ensure(id)
    }
    for (const e of this.edges.values()) {
      if (!allowed(e.source) || !allowed(e.target)) continue
      if (e.type === 'wiki_link') {
        ensure(e.source)
        ensure(e.target)
        adj.get(e.source)!.add(e.target)
        adj.get(e.target)!.add(e.source)
      } else if (includeTagEdges && e.type === 'tag') {
        ensure(e.source)
        ensure(e.target)
        adj.get(e.source)!.add(e.target)
        adj.get(e.target)!.add(e.source)
      }
    }
    return adj
  }

  private stripInternal(n: GraphNode): GraphNode {
    const { outLinks: _ol, ...rest } = n
    return rest as GraphNode
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

    // Default 64 hops covers large vaults; hard cap 256 for safety
    const maxDepth = Math.min(256, Math.max(1, options?.maxDepth ?? 64))
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

    const edgeKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)
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
   * Neighborhood ids including center (paint focus). depth 1–5 (Obsidian local range).
   */
  getNeighborhoodIds(
    nodeIdOrPath: string,
    depth = 1,
    options?: { includeTagEdges?: boolean }
  ): { centerId: string; ids: string[]; edgeKeys: string[] } | null {
    const centerId = this.resolveNodeId(nodeIdOrPath)
    if (!centerId) return null
    const maxDepth = Math.min(5, Math.max(1, Math.floor(depth) || 1))
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
    const edgeKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)
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
    const filteredNodes = Array.from(this.nodes.values()).filter(
      (n) =>
        !n.isTag &&
        !n.isGhost &&
        !n.isAttachment &&
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
