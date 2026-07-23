import Fuse from 'fuse.js'
import type { ParsedMarkdown } from './MarkdownEngine'
import { indexDatabase } from './IndexDatabase'
import { graphEngine } from './GraphEngine'

export interface SearchResult {
  id: string
  title: string
  path: string
  relativePath: string
  score: number
  type: string
  tags: string[]
  preview?: string
  matchedField: 'title' | 'content' | 'tag' | 'path' | 'backlink'
  source?: 'fts' | 'fuse' | 'meta'
}

export interface SearchOptions {
  query: string
  limit?: number
  filterType?: string
  filterTag?: string
  searchIn?: ('title' | 'content' | 'tags' | 'path')[]
}

interface IndexEntry {
  id: string
  title: string
  path: string
  relativePath: string
  content: string
  tags: string[]
  type: string
  rawContent: string
  updatedAt?: string
  headings?: string
}

export class SearchEngine {
  private index: Map<string, IndexEntry> = new Map()
  private fuse: Fuse<IndexEntry> | null = null
  private useFts = true

  private initFuse() {
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

  setUseFts(enabled: boolean): void {
    this.useFts = enabled
  }

  buildIndex(parsedFiles: ParsedMarkdown[]): void {
    this.index.clear()
    for (const file of parsedFiles) {
      this.addToIndex(file, false, false)
    }
    this.initFuse()
    // Persist to SQLite cache (Law 009)
    if (indexDatabase.isOpen()) {
      indexDatabase.rebuild(parsedFiles)
    }
  }

  private coerceDate(val: unknown): string | undefined {
    if (val == null || val === '') return undefined
    if (val instanceof Date) return val.toISOString()
    if (typeof val === 'number') return new Date(val).toISOString()
    if (typeof val === 'string') return val
    return String(val)
  }

  addToIndex(file: ParsedMarkdown, rebuildFuse = true, writeDb = true): void {
    this.index.set(file.id, {
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
    })
    if (writeDb && indexDatabase.isOpen()) {
      indexDatabase.upsertNote(file)
    }
    if (rebuildFuse) {
      this.initFuse()
    }
  }

  removeFromIndex(fileId: string): void {
    this.index.delete(fileId)
    if (indexDatabase.isOpen()) {
      indexDatabase.removeById(fileId)
    }
    this.initFuse()
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
      headings: (e.headings || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((text) => ({ level: 1, text }))
    }))
    return indexDatabase.rebuild(files as ParsedMarkdown[])
  }

  search(options: SearchOptions): SearchResult[] {
    const { query, limit = 20, filterType, filterTag } = options
    const q = (query || '').trim()

    if (!q) {
      return this.getRecentFiles(limit)
    }

    const lower = q.toLowerCase()

    if (lower === 'orphan:true' || lower === 'is:orphan') {
      return this.searchOrphans(limit)
    }

    // backlinks:NoteTitle or backlink:NoteTitle
    const backMatch = q.match(/^backlinks?:(.+)$/i)
    if (backMatch) {
      return this.searchBacklinks(backMatch[1].trim(), limit)
    }

    // path:foo
    const pathMatch = q.match(/^path:(.+)$/i)
    if (pathMatch) {
      return this.searchByPathFragment(pathMatch[1].trim(), limit)
    }

    const tagMatch = q.match(/^#([a-zA-Z0-9_/-]+)$/)
    if (tagMatch) {
      return this.searchByTagExact(tagMatch[1], limit)
    }

    // Hybrid: FTS first (keyword), then fuse fill for fuzzy typos
    const results: SearchResult[] = []
    const seen = new Set<string>()

    if (this.useFts && indexDatabase.isOpen()) {
      const ftsHits = indexDatabase.searchFts(q, limit)
      for (const hit of ftsHits) {
        if (filterType && hit.type !== filterType) continue
        if (filterTag && !hit.tags.some((t) => t.toLowerCase() === filterTag.toLowerCase()))
          continue
        seen.add(hit.id)
        // bm25 is negative; more negative ≈ better → map to 0–100
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

    if (results.length < limit && this.fuse) {
      const fuseResults = this.fuse.search(q)
      for (const res of fuseResults) {
        const entry = res.item
        if (seen.has(entry.id)) continue
        if (filterType && entry.type !== filterType) continue
        if (filterTag && !entry.tags.some((t) => t.toLowerCase() === filterTag.toLowerCase()))
          continue

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
            const end = Math.min(entry.rawContent.length, matchStart + q.length + 60)
            preview = '...' + entry.rawContent.slice(start, end).replace(/\n/g, ' ').trim() + '...'
          }
        }
        if (!preview) {
          preview = entry.rawContent.slice(0, 120).replace(/\n/g, ' ').trim()
        }

        results.push({
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
        seen.add(entry.id)
        if (results.length >= limit) break
      }
    }

    return results.slice(0, limit)
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

  /** Paths under Rules/SOP/Templates for context auto-include */
  getSystemFolderNotes(): IndexEntry[] {
    return Array.from(this.index.values()).filter((e) => {
      const p = e.relativePath.replace(/\\/g, '/').toLowerCase()
      return (
        p.startsWith('rules/') ||
        p.startsWith('sop/') ||
        p.startsWith('templates/') ||
        p.startsWith('prompt/')
      )
    })
  }

  getEntryByPath(filePath: string): IndexEntry | undefined {
    const norm = filePath.replace(/\\/g, '/')
    for (const e of this.index.values()) {
      if (e.path.replace(/\\/g, '/') === norm) return e
    }
    return undefined
  }
}

export const searchEngine = new SearchEngine()
