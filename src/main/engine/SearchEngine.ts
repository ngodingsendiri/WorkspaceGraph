import Fuse, { type FuseResult } from 'fuse.js'
import type { ParsedMarkdown } from './MarkdownEngine'
import { indexDatabase } from './IndexDatabase'
import { graphEngine } from './GraphEngine'
import { getSearchIndexWorker } from '../workers/worker-pool'
import type { IndexEntry, SearchResult } from '../workers/worker-pool'
import { embeddingEngine } from '../ai/EmbeddingEngine'

export interface SearchOptions {
  query: string
  limit?: number
  filterType?: string
  filterTag?: string
  searchIn?: ('title' | 'content' | 'tags' | 'path')[]
}

/** M7.5a (S4): open `- [ ] task` lines, capped per note. */
export function extractOpenTasks(content: string, cap = 50): string[] {
  const out: string[] = []
  const re = /^\s*[-*+]\s+\[ \]\s+(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const text = m[1].trim()
    if (text) out.push(text)
    if (out.length >= cap) break
  }
  return out
}

export class SearchEngine {
  private index: Map<string, IndexEntry> = new Map()
  private fuse: Fuse<IndexEntry> | null = null
  private useFts = true

  setUseFts(enabled: boolean): void {
    this.useFts = enabled
  }

  /** Drop in-memory search state (workspace close / switch). SQLite closed separately. */
  clear(): void {
    this.index.clear()
    this.byPath.clear()
    this.fuse = null
    this.searchWorker = null
    this.orphanIds = new Set()
    this.pendingFuseUpdates.clear()
    this.pendingFuseRemoves.clear()
    if (this.fuseFlushTimer) {
      clearTimeout(this.fuseFlushTimer)
      this.fuseFlushTimer = null
    }
  }

  private searchWorker: Awaited<ReturnType<typeof getSearchIndexWorker>> | null = null
  // WG_NO_SEARCH_WORKER=1 forces local Fuse (no worker thread) — used by the
  // one-off WB-12 validation script (ADR-0005) and handy for perf A/B in plain node.
  private useWorker = process.env.WG_NO_SEARCH_WORKER !== '1'

  // WB-2: pending Fuse deltas — flushed to the worker (debounced) instead of
  // re-posting the entire index on every single-file edit.
  private pendingFuseUpdates: Map<string, IndexEntry> = new Map()
  private pendingFuseRemoves: Set<string> = new Set()
  private fuseFlushTimer: NodeJS.Timeout | null = null

  private async ensureWorker(): Promise<boolean> {
    if (this.searchWorker) return true
    if (!this.useWorker) return false
    // Skip worker in test environment (vitest sets this)
    if (process.env.VITEST || process.env.NODE_ENV === 'test') {
      this.useWorker = false
      return false
    }
    try {
      this.searchWorker = await getSearchIndexWorker()
      return true
    } catch {
      this.useWorker = false
      return false
    }
  }

  private initFuseLocal(): void {
    this.fuse = new Fuse(Array.from(this.index.values()), {
      keys: [
        { name: 'title', weight: 0.4 },
        { name: 'tags', weight: 0.2 },
        { name: 'content', weight: 0.3 },
        { name: 'relativePath', weight: 0.1 }
      ],
      includeScore: true,
      includeMatches: true,
      threshold: 0.4,
      ignoreLocation: true
    })
  }

  /** WB-2: schedule a (debounced) flush of pending Fuse deltas to the worker. */
  private scheduleFuseFlush(): void {
    if (this.fuseFlushTimer) clearTimeout(this.fuseFlushTimer)
    this.fuseFlushTimer = setTimeout(() => {
      this.fuseFlushTimer = null
      void this.flushFuseDelta()
    }, 250)
  }

  /**
   * WB-2: push pending updates/removes to the worker index (delta), or fall
   * back to the local Fuse instance when no worker is available. Called by the
   * debounce timer AND by search() so a query never misses pending edits.
   */
  async flushFuseDelta(): Promise<void> {
    if (this.fuseFlushTimer) {
      clearTimeout(this.fuseFlushTimer)
      this.fuseFlushTimer = null
    }
    if (this.pendingFuseUpdates.size === 0 && this.pendingFuseRemoves.size === 0) return
    const updates = Array.from(this.pendingFuseUpdates.values())
    const removes = Array.from(this.pendingFuseRemoves)
    this.pendingFuseUpdates.clear()
    this.pendingFuseRemoves.clear()

    const hasWorker = await this.ensureWorker()
    if (hasWorker && this.searchWorker) {
      try {
        if (removes.length > 0) {
          await this.searchWorker.post({ type: 'removeEntries', ids: removes })
        }
        if (updates.length > 0) {
          await this.searchWorker.post({ type: 'updateEntries', entries: updates })
        }
        return
      } catch {
        // Fall through to local rebuild
      }
    }
    this.applyFuseDeltaLocal(updates, removes)
  }

  /** Apply deltas to the in-process Fuse instance (tests / worker unavailable). */
  private applyFuseDeltaLocal(updates: IndexEntry[], removes: string[]): void {
    if (!this.fuse) {
      this.initFuseLocal()
      return
    }
    if (removes.length > 0) {
      const idSet = new Set(removes)
      this.fuse.remove((doc) => idSet.has(doc.id))
    }
    if (updates.length > 0) {
      const idSet = new Set(updates.map((u) => u.id))
      this.fuse.remove((doc) => idSet.has(doc.id))
      for (const u of updates) this.fuse.add(u)
    }
  }

  async buildIndex(parsedFiles: ParsedMarkdown[]): Promise<void> {
    this.index.clear()
    this.byPath.clear()
    this.pendingFuseUpdates.clear()
    this.pendingFuseRemoves.clear()
    if (this.fuseFlushTimer) {
      clearTimeout(this.fuseFlushTimer)
      this.fuseFlushTimer = null
    }
    const entries: IndexEntry[] = []
    // M7.5a (S4): FTS rebuild gets task lines as synthetic headings so
    // searching task text finds the containing note.
    const ftsFiles: ParsedMarkdown[] = []
    for (const file of parsedFiles) {
      const tasks = extractOpenTasks(file.content)
      const entry: IndexEntry = {
        id: file.id,
        title: file.title,
        path: file.filePath,
        relativePath: file.relativePath,
        content: file.content,
        tags: file.tags,
        type: (file.frontmatter.type as string) || 'note',
        rawContent: file.content,
        updatedAt:
          this.coerceDate(file.frontmatter.updated) ||
          this.coerceDate(file.frontmatter.date) ||
          undefined,
        headings: [
          ...(file.headings || []).map((h) => h.text),
          ...tasks.map((t) => `[task] ${t}`)
        ].join(' ')
      }
      this.index.set(file.id, entry)
      this.byPath.set(entry.path.replace(/\\/g, '/').toLowerCase(), entry)
      entries.push(entry)
      if (tasks.length > 0) {
        ftsFiles.push({
          ...file,
          headings: [
            ...(file.headings || []),
            ...tasks.map((t) => ({ level: 6, text: `[task] ${t}` }))
          ]
        })
      } else {
        ftsFiles.push(file)
      }
    }
    await this.buildFuseWorker(entries)
    if (indexDatabase.isOpen()) {
      indexDatabase.rebuild(ftsFiles)
    }
  }

  private async buildFuseWorker(entries: IndexEntry[]): Promise<void> {
    const hasWorker = await this.ensureWorker()
    if (hasWorker && this.searchWorker) {
      try {
        await this.searchWorker.post({ type: 'buildIndex', entries })
        return
      } catch {
        // Fall through to local
      }
    }
    this.initFuseLocal()
  }

  private coerceDate(val: unknown): string | undefined {
    if (val == null || val === '') return undefined
    if (val instanceof Date) return val.toISOString()
    if (typeof val === 'number') return new Date(val).toISOString()
    if (typeof val === 'string') return val
    return String(val)
  }

  addToIndex(file: ParsedMarkdown, rebuildFuse = true, writeDb = true): void {
    const entry: IndexEntry = {
      id: file.id,
      title: file.title,
      path: file.filePath,
      relativePath: file.relativePath,
      content: file.content,
      tags: file.tags,
      type: (file.frontmatter.type as string) || 'note',
      rawContent: file.content,
      updatedAt:
        this.coerceDate(file.frontmatter.updated) ||
        this.coerceDate(file.frontmatter.date) ||
        undefined,
      headings: (file.headings || []).map((h) => h.text).join(' ')
    }
    this.index.set(file.id, entry)
    this.byPath.set(entry.path.replace(/\\/g, '/').toLowerCase(), entry)
    if (writeDb && indexDatabase.isOpen()) {
      indexDatabase.upsertNote(file)
    }
    if (rebuildFuse) {
      if (this.searchWorker && this.useWorker) {
        // WB-2: delta to the worker (debounced) — no full-index re-post per edit.
        this.pendingFuseUpdates.set(file.id, entry)
        this.pendingFuseRemoves.delete(file.id)
        this.scheduleFuseFlush()
      } else {
        // No worker (tests / worker unavailable): apply immediately so
        // synchronous callers see fresh results right away.
        this.applyFuseDeltaLocal([entry], [])
      }
    }
  }

  removeFromIndex(fileId: string): void {
    this.index.delete(fileId)
    if (indexDatabase.isOpen()) {
      indexDatabase.removeById(fileId)
    }
    // WB-2: delta removal; supersedes any pending upsert for the same id.
    if (this.searchWorker && this.useWorker) {
      this.pendingFuseUpdates.delete(fileId)
      this.pendingFuseRemoves.add(fileId)
      this.scheduleFuseFlush()
    } else {
      this.fuse?.remove((doc) => doc.id === fileId)
    }
  }

  rebuildSqliteFromMemory(): number {
    if (!indexDatabase.isOpen()) return 0
    const files = Array.from(this.index.values()).map((e) => ({
      id: e.id,
      filePath: e.path,
      relativePath: e.relativePath,
      title: e.title,
      frontmatter: { type: e.type, updated: e.updatedAt } as ParsedMarkdown['frontmatter'],
      content: e.content,
      rawContent: e.rawContent,
      wikiLinks: [],
      tags: e.tags,
      wordCount: 0,
      // M7.2 (S7): keep the joined headings string as ONE heading entry.
      // Splitting on whitespace produced a fake level-1 heading per WORD,
      // polluting the FTS headings column after every memory rebuild.
      // Searchability is unchanged (same text indexed); no per-word noise.
      headings: e.headings ? [{ level: 1, text: e.headings }] : []
    }))
    return indexDatabase.rebuild(files as ParsedMarkdown[])
  }

  /**
   * WB-5: single keyword-search core shared by searchSync and search — FTS +
   * Fuse merge with filters. Fuse hits arrive pre-built (local Fuse or worker)
   * so both call sites stay in lockstep instead of duplicating this logic.
   */
  private keywordResults(
    q: string,
    limit: number,
    filterType: string | undefined,
    filterTag: string | undefined,
    fuseResults: SearchResult[]
  ): SearchResult[] {
    const results: SearchResult[] = []
    const seen = new Set<string>()

    if (this.useFts && indexDatabase.isOpen()) {
      const ftsHits = indexDatabase.searchFts(q, limit)
      for (const hit of ftsHits) {
        if (filterType && hit.type !== filterType) continue
        if (filterTag && !hit.tags.some((t) => t.toLowerCase() === filterTag.toLowerCase()))
          continue
        seen.add(hit.id)
        const score = Math.max(0, Math.min(100, 80 + hit.rank * -2))
        results.push({
          id: hit.id,
          title: hit.title,
          path: hit.path,
          relativePath: hit.relativePath,
          score,
          type: hit.type,
          tags: hit.tags,
          preview: hit.snippet || undefined,
          matchedField: 'content',
          source: 'fts'
        })
      }
    }

    for (const r of fuseResults) {
      if (seen.has(r.id)) continue
      if (filterType && r.type !== filterType) continue
      if (filterTag && !r.tags.some((t) => t.toLowerCase() === filterTag.toLowerCase())) continue
      results.push(r)
      seen.add(r.id)
      if (results.length >= limit) break
    }

    // M7.5b (S3): backlink-count ranking signal. ADR-0005 keeps the absolute
    // keyword/semantic blend; this applies a bounded multiplicative nudge so
    // well-connected notes rise among otherwise-similar scores (cap +15%,
    // saturating at 15 backlinks — never dominates exact matches).
    const boosted = results.map((r) => {
      const node = graphEngine.getNodeById(r.id)
      if (!node || node.degree <= 0) return r
      const factor = 1 + Math.min(node.degree, 15) * 0.01
      return { ...r, score: Math.min(100, r.score * factor) }
    })
    boosted.sort((a, b) => b.score - a.score)

    return boosted.slice(0, limit)
  }

  /** WB-5: special query syntax (orphan/backlink/path/#tag) shared by both entry points. */
  private specialSearch(q: string, limit: number): SearchResult[] | null {
    const lower = q.toLowerCase()
    if (lower === 'orphan:true' || lower === 'is:orphan') {
      return this.searchOrphans(limit)
    }
    const backMatch = q.match(/^backlinks?:(.+)$/i)
    if (backMatch) {
      return this.searchBacklinks(backMatch[1].trim(), limit)
    }
    const pathMatch = q.match(/^path:(.+)$/i)
    if (pathMatch) {
      return this.searchByPathFragment(pathMatch[1].trim(), limit)
    }
    const tagMatch = q.match(/^#([a-zA-Z0-9_/-]+)$/)
    if (tagMatch) {
      return this.searchByTagExact(tagMatch[1], limit)
    }
    // M7 S1: metadata search — `metadata:type project`, `metadata:status active`
    const metaMatch = q.match(/^metadata:(\w+)[\s:](.+)$/i)
    if (metaMatch) {
      return this.searchByMetadata(
        metaMatch[1].toLowerCase(),
        metaMatch[2].trim().toLowerCase(),
        limit
      )
    }
    return null
  }

  /**
   * M7 S1: search notes by frontmatter key/value. Reads the raw content of
   * each indexed note and matches `key: value` patterns in the YAML block.
   */
  private searchByMetadata(key: string, value: string, limit: number): SearchResult[] {
    const out: SearchResult[] = []
    for (const entry of this.index.values()) {
      if (out.length >= limit) break
      try {
        const raw = entry.rawContent || entry.content || ''
        const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/)
        if (!fmMatch) continue
        const line = fmMatch[1]
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith(`${key}:`))
        if (!line) continue
        const val = line
          .split(':')
          .slice(1)
          .join(':')
          .trim()
          .replace(/^["'[]|["'\]]$/g, '')
          .toLowerCase()
        if (!val.includes(value)) continue
        out.push({
          id: entry.id,
          title: entry.title,
          path: entry.path,
          relativePath: entry.relativePath,
          type: entry.type,
          tags: entry.tags,
          score: 100,
          preview: `${key}: ${val}`,
          matchedField: 'content',
          source: 'fts'
        })
      } catch {
        /* skip */
      }
    }
    return out
  }

  /** WB-5: build SearchResult[] from raw Fuse hits (preview + matched field). */
  private fuseHitsToResults(
    fuseResults: FuseResult<IndexEntry>[],
    query: string,
    limit: number
  ): SearchResult[] {
    const out: SearchResult[] = []
    for (const res of fuseResults) {
      const entry = res.item
      let preview: string | undefined
      let matchedField: SearchResult['matchedField'] = 'content'

      if (res.matches && res.matches.length > 0) {
        const match = res.matches[0]
        if (match.key === 'title') matchedField = 'title'
        else if (match.key === 'tags') matchedField = 'tag'
        else if (match.key === 'relativePath') matchedField = 'path'

        if (match.key === 'content' && match.indices && match.indices.length > 0) {
          const matchStart = match.indices[0][0]
          const start = Math.max(0, matchStart - 60)
          const end = Math.min(entry.rawContent.length, matchStart + query.length + 60)
          preview = '...' + entry.rawContent.slice(start, end).replace(/\n/g, ' ').trim() + '...'
        }
      }
      if (!preview) {
        preview = entry.rawContent.slice(0, 120).replace(/\n/g, ' ').trim()
      }

      out.push({
        id: entry.id,
        title: entry.title,
        path: entry.path,
        relativePath: entry.relativePath,
        score: (1 - (res.score || 0)) * 100,
        type: entry.type,
        tags: entry.tags,
        preview,
        matchedField,
        source: 'fuse'
      })
      if (out.length >= limit) break
    }
    return out
  }

  /** Synchronous search using local Fuse + FTS — for backward compat with sync call sites. */
  searchSync(options: SearchOptions): SearchResult[] {
    const { query, limit = 20, filterType, filterTag } = options
    const q = (query || '').trim()

    if (!q) {
      return this.getRecentFiles(limit)
    }

    const special = this.specialSearch(q, limit)
    if (special) return special

    const fuseHits = this.fuse ? this.fuse.search(q) : []
    return this.keywordResults(
      q,
      limit,
      filterType,
      filterTag,
      this.fuseHitsToResults(fuseHits, q, limit)
    )
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const { query, limit = 20, filterType, filterTag } = options
    const q = (query || '').trim()

    if (!q) {
      return this.getRecentFiles(limit)
    }

    const special = this.specialSearch(q, limit)
    if (special) return special

    // WB-2: never query a stale worker index — flush pending deltas first.
    await this.flushFuseDelta()
    const fuseResults = await this.searchFuseWorker(q, limit)
    const results = this.keywordResults(q, limit, filterType, filterTag, fuseResults)

    // Hybrid: blend keyword (FTS/Fuse) results with semantic hits so a strong
    // vector match can surface even when the keyword signal is weak — including
    // notes that match ONLY semantically (empty keyword results). Falls back to
    // keyword-only when the embedding engine is not ready.
    if (embeddingEngine.isReady) {
      try {
        const semHits = await embeddingEngine.search(q, limit)
        const semResults: SearchResult[] = []
        // WB-12 — ADR-0005 (vault validation): a doc that is BOTH a weak keyword
        // hit and a strong semantic hit must keep its BEST signal. The old
        // keyword-first dedupe discarded the semantic score for docs already in
        // `results`, sinking the most relevant doc to the bottom (validated:
        // 'plugin sdk development' put 28_Plugin_SDK last). Merge per-doc with
        // max() instead — semantic rescues weak keyword hits without letting a
        // marginal semantic match leapfrog strong keyword matches.
        const semBoost = new Map<string, number>()
        const seen = new Set(results.map((r) => r.id))
        for (const hit of semHits) {
          const entry = this.getEntryByPath(hit.filePath)
          if (!entry) continue
          const s = 0.4 * Math.max(0, Math.min(1, hit.score)) * 100
          if (seen.has(entry.id)) {
            const prev = semBoost.get(entry.id)
            if (prev === undefined || s > prev) semBoost.set(entry.id, s)
          } else {
            semResults.push({
              id: entry.id,
              title: entry.title,
              path: entry.path,
              relativePath: entry.relativePath,
              score: hit.score,
              type: entry.type,
              tags: entry.tags,
              preview: hit.chunk.slice(0, 220).replace(/\n/g, ' ').trim(),
              matchedField: 'content',
              source: 'semantic'
            })
            seen.add(entry.id)
          }
        }
        if (semResults.length > 0 || semBoost.size > 0) {
          // WB-12 — ADR-0005: min-max normalization flattened every keyword
          // score to 1.0 (FTS rank scores are compressed into a narrow band), so
          // even a weak tail keyword hit outranked a strong vector match. Blend
          // on ABSOLUTE scales instead — keyword keeps its 0-100 rank/Fuse
          // score, semantic cosine maps to 0-100. A strong semantic hit (≥~0.9)
          // now surfaces over weak keyword tail hits while exact keyword matches
          // still lead.
          const pool = results.map((r) => ({ r, s: 0.6 * r.score }))
          for (const r of semResults)
            pool.push({ r, s: 0.4 * Math.max(0, Math.min(1, r.score)) * 100 })
          for (const [id, s] of semBoost) {
            const found = pool.find((p) => p.r.id === id)
            if (found && s > found.s) found.s = s
          }
          pool.sort((a, b) => b.s - a.s)
          return pool.slice(0, limit).map((p) => p.r)
        }
      } catch {
        /* keyword-only fallback */
      }
    }

    return results.slice(0, limit)
  }

  private async searchFuseWorker(query: string, limit: number): Promise<SearchResult[]> {
    const hasWorker = await this.ensureWorker()
    if (hasWorker && this.searchWorker) {
      try {
        const resp = await this.searchWorker.post({ type: 'fuzzySearch', query, limit })
        if (resp.type === 'fuzzyResult') return resp.results
      } catch {
        // Fall through to local
      }
    }
    if (!this.fuse) return []
    return this.fuseHitsToResults(this.fuse.search(query), query, limit)
  }

  searchBacklinks(targetTitle: string, limit = 50): SearchResult[] {
    const key = targetTitle.toLowerCase().replace(/\.md$/, '').trim()
    if (!key) return []

    // 1) Prefer graph engine (shared singleton in Electron main)
    let targetId: string | null = null
    for (const entry of this.index.values()) {
      if (entry.title.toLowerCase() === key) {
        targetId = entry.id
        break
      }
      const base =
        entry.relativePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/i, '') || ''
      if (base.toLowerCase() === key) {
        targetId = entry.id
        break
      }
    }
    if (!targetId) {
      const p = graphEngine.resolveTitleToPath(targetTitle)
      if (p) {
        const node = graphEngine.getNodeByPath(p)
        if (node) targetId = node.id
      }
    }
    if (targetId) {
      const { nodes } = graphEngine.getBacklinks(targetId)
      if (nodes.length > 0) {
        return nodes.slice(0, limit).map((n) => ({
          id: n.id,
          title: n.title,
          path: n.path,
          relativePath: n.relativePath,
          score: 100,
          type: n.type,
          tags: n.tags,
          matchedField: 'backlink' as const,
          preview: `→ links to [[${targetTitle}]]`,
          source: 'meta' as const
        }))
      }
    }

    // 2) Fallback: scan index content for [[Target]] / [[Target|alias]]
    //    (works even if graph singleton not synced — e.g. tests / partial reindex)
    // Same rules as MarkdownEngine: \| alias, # heading, strip code fences
    const wikiRe = /\[\[([^\]]+?)\]\]/g
    const results: SearchResult[] = []
    for (const e of this.index.values()) {
      if (targetId && e.id === targetId) continue
      if (e.title.toLowerCase() === key) continue
      const body = (e.content || e.rawContent || '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`\n]+`/g, '')
      wikiRe.lastIndex = 0
      let m: RegExpExecArray | null
      let hit = false
      while ((m = wikiRe.exec(body)) !== null) {
        const inner = m[1].replace(/\\\|/g, '|')
        const pipe = inner.indexOf('|')
        let t = (pipe >= 0 ? inner.slice(0, pipe) : inner).split('#')[0].split('^')[0].trim()
        t = t.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase()
        const base = t.includes('/') ? t.split('/').pop()! : t
        if (t === key || base === key) {
          hit = true
          break
        }
      }
      if (hit) {
        results.push({
          id: e.id,
          title: e.title,
          path: e.path,
          relativePath: e.relativePath,
          score: 100,
          type: e.type,
          tags: e.tags,
          matchedField: 'backlink',
          preview: `→ links to [[${targetTitle}]]`,
          source: 'meta'
        })
        if (results.length >= limit) break
      }
    }
    return results
  }

  searchByPathFragment(fragment: string, limit: number): SearchResult[] {
    const f = fragment.toLowerCase().replace(/\\/g, '/')
    return Array.from(this.index.values())
      .filter((e) => e.relativePath.toLowerCase().replace(/\\/g, '/').includes(f))
      .slice(0, limit)
      .map((e) => ({
        id: e.id,
        title: e.title,
        path: e.path,
        relativePath: e.relativePath,
        score: 90,
        type: e.type,
        tags: e.tags,
        matchedField: 'path' as const,
        preview: e.relativePath,
        source: 'meta' as const
      }))
  }

  searchByTag(tag: string): SearchResult[] {
    return this.searchByTagExact(tag.replace(/^#/, ''), 50)
  }

  private searchByTagExact(tag: string, limit: number): SearchResult[] {
    if (indexDatabase.isOpen()) {
      return indexDatabase.searchByTag(tag, limit).map((e) => ({
        id: e.id,
        title: e.title,
        path: e.path,
        relativePath: e.relativePath,
        score: 100,
        type: e.type,
        tags: e.tags,
        matchedField: 'tag' as const,
        preview: e.tags.join(', '),
        source: 'fts' as const
      }))
    }
    const t = tag.toLowerCase()
    return Array.from(this.index.values())
      .filter((e) => e.tags.some((x) => x.toLowerCase() === t))
      .slice(0, limit)
      .map((e) => ({
        id: e.id,
        title: e.title,
        path: e.path,
        relativePath: e.relativePath,
        score: 100,
        type: e.type,
        tags: e.tags,
        matchedField: 'tag' as const,
        preview: e.tags.join(', '),
        source: 'meta' as const
      }))
  }

  private orphanIds: Set<string> = new Set()

  setOrphanIds(ids: string[]): void {
    this.orphanIds = new Set(ids)
  }

  searchOrphans(limit = 50): SearchResult[] {
    return Array.from(this.index.values())
      .filter((e) => this.orphanIds.has(e.id))
      .slice(0, limit)
      .map((e) => ({
        id: e.id,
        title: e.title,
        path: e.path,
        relativePath: e.relativePath,
        score: 0,
        type: e.type,
        tags: e.tags,
        matchedField: 'title' as const,
        preview: 'Orphan note (no graph connections)',
        source: 'meta' as const
      }))
  }

  getRecentFiles(limit = 10): SearchResult[] {
    if (indexDatabase.isOpen()) {
      const hits = indexDatabase.getRecent(limit)
      if (hits.length > 0) {
        return hits.map((e) => ({
          id: e.id,
          title: e.title,
          path: e.path,
          relativePath: e.relativePath,
          score: 0,
          type: e.type,
          tags: e.tags,
          matchedField: 'title' as const,
          preview: e.snippet,
          source: 'fts' as const
        }))
      }
    }
    return Array.from(this.index.values())
      .sort((a, b) => {
        const ta = String(a.updatedAt || '')
        const tb = String(b.updatedAt || '')
        if (ta !== tb) return tb.localeCompare(ta)
        return a.title.localeCompare(b.title)
      })
      .slice(0, limit)
      .map((e) => ({
        id: e.id,
        title: e.title,
        path: e.path,
        relativePath: e.relativePath,
        score: 0,
        type: e.type,
        tags: e.tags,
        matchedField: 'title' as const,
        preview: e.rawContent.slice(0, 100).replace(/\n/g, ' ').trim(),
        source: 'meta' as const
      }))
  }

  getIndexSize(): number {
    return this.index.size
  }

  getIndexStats(): {
    memoryCount: number
    sqlite: { count: number; path: string | null; lastRebuild: string | null; open: boolean }
  } {
    return {
      memoryCount: this.index.size,
      sqlite: indexDatabase.getStats()
    }
  }

  getAllTags(): { tag: string; count: number }[] {
    const tagMap = new Map<string, number>()
    for (const entry of this.index.values()) {
      for (const tag of entry.tags) {
        tagMap.set(tag, (tagMap.get(tag) || 0) + 1)
      }
    }
    return Array.from(tagMap.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
  }

  /** Paths under Rules/SOP/Prompt for context auto-include.
   * M7 S6: Templates/ excluded — F-1/F-2 already keep template files OUT of
   * the index, so including the prefix here returned nothing and contradicted
   * the indexing policy. */
  getSystemFolderNotes(): IndexEntry[] {
    return Array.from(this.index.values()).filter((e) => {
      const p = e.relativePath.replace(/\\/g, '/').toLowerCase()
      return p.startsWith('rules/') || p.startsWith('sop/') || p.startsWith('prompt/')
    })
  }

  /** M7 S8: normalized-path → entry map for O(1) semantic-hit resolution. */
  private byPath = new Map<string, IndexEntry>()

  private reindexByPath(): void {
    this.byPath.clear()
    for (const e of this.index.values()) {
      this.byPath.set(e.path.replace(/\\/g, '/').toLowerCase(), e)
    }
  }

  getEntryByPath(filePath: string): IndexEntry | undefined {
    const norm = filePath.replace(/\\/g, '/').toLowerCase()
    // Fast path; rebuild lazily when the main index changed underneath us.
    let e = this.byPath.get(norm)
    if (e) return e
    if (this.byPath.size !== this.index.size) {
      this.reindexByPath()
      e = this.byPath.get(norm)
      if (e) return e
    }
    return undefined
  }
}

export const searchEngine = new SearchEngine()
