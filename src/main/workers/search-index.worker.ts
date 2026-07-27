/**
 * Search Index Worker — builds Fuse.js index and runs fuzzy search off main thread.
 * Also handles FTS5 rebuild coordination (DB writes stay on main, this prepares data).
 */
import { parentPort } from 'worker_threads'
import Fuse from 'fuse.js'
import type { WorkerMessage, WorkerResponse, IndexEntry, SearchResult } from './worker-pool'

let fuse: Fuse<IndexEntry> | null = null

function buildFuseIndex(entries: IndexEntry[]): void {
  fuse = new Fuse(entries, {
    keys: [
      { name: 'title', weight: 0.4 },
      { name: 'tags', weight: 0.2 },
      { name: 'content', weight: 0.3 },
      { name: 'relativePath', weight: 0.1 },
    ],
    includeScore: true,
    includeMatches: true,
    threshold: 0.4,
    ignoreLocation: true,
  })
  parentPort?.postMessage({ type: 'indexBuilt', size: entries.length } as WorkerResponse)
}

function fuzzySearch(query: string, limit: number): SearchResult[] {
  if (!fuse) return []
  const results = fuse.search(query)
  const out: SearchResult[] = []
  for (const res of results) {
    const e = res.item
    let preview: string | undefined
    let matchedField: SearchResult['matchedField'] = 'content'
    if (res.matches && res.matches.length > 0) {
      const m = res.matches[0]
      if (m.key === 'title') matchedField = 'title'
      else if (m.key === 'tags') matchedField = 'tag'
      else if (m.key === 'relativePath') matchedField = 'path'
      if (m.key === 'content' && m.indices && m.indices.length > 0) {
        const start = Math.max(0, m.indices[0][0] - 60)
        const end = Math.min(e.rawContent.length, m.indices[0][0] + query.length + 60)
        preview = '...' + e.rawContent.slice(start, end).replace(/\n/g, ' ').trim() + '...'
      }
    }
    if (!preview) preview = e.rawContent.slice(0, 120).replace(/\n/g, ' ').trim()
    out.push({
      id: e.id,
      title: e.title,
      path: e.path,
      relativePath: e.relativePath,
      score: (1 - (res.score || 0)) * 100,
      type: e.type,
      tags: e.tags,
      preview,
      matchedField,
      source: 'fuse',
    })
    if (out.length >= limit) break
  }
  return out
}

parentPort?.on('message', (msg: WorkerMessage) => {
  try {
    switch (msg.type) {
      case 'init': {
        // No-op, ready immediately
        parentPort?.postMessage({ type: 'ready' } as WorkerResponse)
        break
      }
      case 'buildIndex': {
        buildFuseIndex(msg.entries)
        break
      }
      case 'fuzzySearch': {
        const results = fuzzySearch(msg.query, msg.limit)
        parentPort?.postMessage({ type: 'fuzzyResult', results } as WorkerResponse)
        break
      }
      case 'shutdown': {
        process.exit(0)
        break
      }
    }
  } catch (err) {
    parentPort?.postMessage({ type: 'error', error: String(err) } as WorkerResponse)
  }
})