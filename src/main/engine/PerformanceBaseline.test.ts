/**
 * M9 (TST-5): performance baseline gate.
 *
 * Not a correctness suite — it measures 2-3 hot-path metrics with LOOSE
 * thresholds so real regressions (an accidental O(N²) graph rebuild, a search
 * worker that stops returning) trip the gate while legitimate machine variance
 * does not. Keep thresholds generous: CI runners are slow.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { GraphEngine } from './GraphEngine'
import { SearchEngine } from './SearchEngine'
import { MarkdownEngine, type ParsedMarkdown } from './MarkdownEngine'

// LOOSE gates — fast CI boxes run ~2-4x faster; these only catch order-of-magnitude regressions.
const GRAPH_BUILD_1000_MS = 5000
const GRAPH_UPDATE_1_MS = 2000
const SEARCH_BUILD_1000_MS = 15000
const SEARCH_QUERY_MS = 1000

describe('M9 TST-5: performance baseline gate', () => {
  let tmp: string
  let md: MarkdownEngine

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), 'wg-perf-'))
    md = new MarkdownEngine()
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function buildNotes(n: number): ParsedMarkdown[] {
    const out: ParsedMarkdown[] = []
    for (let i = 0; i < n; i++) {
      const name = `Perf${String(i).padStart(4, '0')}`
      const links: string[] = []
      if (i > 0) links.push(`[[Perf${String(i - 1).padStart(4, '0')}]]`)
      if (i % 7 === 0 && i + 3 < n) links.push(`[[Perf${String(i + 3).padStart(4, '0')}]]`)
      const body = `---
title: ${name}
type: knowledge
tags: [perf, e2e, group${i % 10}]
---

# ${name}

Note ${i} dengan konten stabil untuk baseline graph build.
${links.join(' ')}
`
      const filePath = path.join(tmp, `${name}.md`)
      out.push(md.parseFile(filePath, body, tmp))
    }
    return out
  }

  it('graph: build 1000 notes < 5s, single update < 2s', () => {
    const graph = new GraphEngine()
    const parsed = buildNotes(1000)

    const t0 = Date.now()
    const data = graph.buildFromParsedFiles(parsed)
    const buildMs = Date.now() - t0
    expect(data.nodes.length).toBeGreaterThanOrEqual(1000)
    expect(data.edgeCount).toBeGreaterThan(500)
    expect(buildMs).toBeLessThan(GRAPH_BUILD_1000_MS)

    const mid = parsed[500]
    mid.wikiLinks = [...(mid.wikiLinks || []), { target: 'Perf0001', display: 'Perf0001' }]
    const t1 = Date.now()
    graph.updateNodeAndEdges(mid)
    const updateMs = Date.now() - t1
    expect(updateMs).toBeLessThan(GRAPH_UPDATE_1_MS)
  })

  it('search: index 1000 docs < 15s, query < 1s', async () => {
    const search = new SearchEngine()
    const parsed = buildNotes(1000)

    const t0 = Date.now()
    await search.buildIndex(parsed)
    const buildMs = Date.now() - t0
    expect(search.getIndexSize()).toBe(1000)
    expect(buildMs).toBeLessThan(SEARCH_BUILD_1000_MS)

    const t1 = Date.now()
    const results = await search.search({ query: 'baseline graph build', limit: 10 })
    const queryMs = Date.now() - t1
    expect(Array.isArray(results)).toBe(true)
    expect(queryMs).toBeLessThan(SEARCH_QUERY_MS)
  })
})
