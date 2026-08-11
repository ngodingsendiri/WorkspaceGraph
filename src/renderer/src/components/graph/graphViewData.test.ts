import { describe, it, expect } from 'vitest'
import type { GraphNodeData, GraphEdgeData } from '../../store/graphStore'
import {
  computeRealDegree,
  computeSearchMatchIds,
  computeFilteredNodes,
  computeFilteredEdges,
  countGraphNotes,
  countGraphLinks,
  graphCounts
} from './graphViewData'
import { matchGroupQuery, resolveGroupColors } from './graphQuery'

const n = (id: string, extra: Partial<GraphNodeData> = {}): GraphNodeData => ({
  id,
  title: id,
  type: 'note',
  path: `/vault/${id}.md`,
  relativePath: `${id}.md`,
  tags: [],
  degree: 0,
  ...extra
})

const e = (id: string, source: string, target: string, type = 'wiki_link'): GraphEdgeData => ({
  id,
  source,
  target,
  type,
  weight: 1
})

describe('F-5 graphCounts — one source of truth for dashboard card + graph header', () => {
  it('counts real notes only, never tag/ghost/attachment nodes', () => {
    const nodes: GraphNodeData[] = [
      n('a'),
      n('b'),
      n('t1', { isTag: true, type: 'tag' }),
      n('t2', { type: 'tag' }),
      n('g', { isGhost: true, type: 'ghost' }),
      n('att', { isAttachment: true, type: 'attachment' })
    ]
    expect(countGraphNotes(nodes)).toBe(2)
  })

  it('counts non-tag links only', () => {
    const edges: GraphEdgeData[] = [e('1', 'a', 'b'), e('2', 'a', 't1', 'tag'), e('3', 'b', 'c')]
    expect(countGraphLinks(edges)).toBe(2)
  })

  it('graphCounts matches the dashboard semantics for a tag-visible graph', () => {
    // Graph renders 15 nodes (7 notes + 8 tags) and 13 edges (11 wiki + 2 tag)
    // → header must say 7 notes · 11 links, identical to the dashboard card.
    const nodes: GraphNodeData[] = [
      ...Array.from({ length: 7 }, (_, i) => n(`note${i}`)),
      ...Array.from({ length: 8 }, (_, i) => n(`tag${i}`, { isTag: true, type: 'tag' }))
    ]
    const edges: GraphEdgeData[] = [
      ...Array.from({ length: 11 }, (_, i) => e(`w${i}`, `note${i % 7}`, `note${(i + 1) % 7}`)),
      ...Array.from({ length: 2 }, (_, i) => e(`t${i}`, `note${i}`, `tag${i}`, 'tag'))
    ]
    const { notes, links } = graphCounts(nodes, edges)
    expect(notes).toBe(7)
    expect(links).toBe(11)
  })
})

describe('computeRealDegree', () => {
  it('counts undirected visible edges', () => {
    const nodes = [n('a'), n('b'), n('c')]
    const edges = [e('1', 'a', 'b'), e('2', 'b', 'c')]
    const deg = computeRealDegree(nodes, edges, {
      existingFilesOnly: true,
      showTags: false,
      showAttachments: false
    })
    expect(deg.get('a')).toBe(1)
    expect(deg.get('b')).toBe(2)
    expect(deg.get('c')).toBe(1)
  })

  it('ignores ghost/tag/attachment nodes when hidden', () => {
    const nodes = [
      n('a'),
      n('t', { isTag: true, type: 'tag' }),
      n('g', { isGhost: true, type: 'ghost' })
    ]
    const edges = [e('1', 'a', 't'), e('2', 'a', 'g')]
    const deg = computeRealDegree(nodes, edges, {
      existingFilesOnly: true,
      showTags: false,
      showAttachments: false
    })
    expect(deg.get('a')).toBe(0)
    // Tag edges also excluded when showTags is off
    expect(deg.has('t')).toBe(false)
  })
})

describe('computeSearchMatchIds', () => {
  it('matches title and returns null for empty query', () => {
    const nodes = [n('Apollo'), n('Zeus')]
    expect(computeSearchMatchIds(nodes, '')).toBeNull()
    const ids = computeSearchMatchIds(nodes, 'apol')
    expect(ids).not.toBeNull()
    expect(ids!.has('Apollo')).toBe(true)
    expect(ids!.has('Zeus')).toBe(false)
  })
})

describe('computeFilteredNodes', () => {
  const nodes = [n('a'), n('b'), n('c')]
  const base = {
    selectedType: 'all',
    selectedTag: 'all',
    orphanMode: 'all' as const,
    hubMode: 'all' as const,
    hubThreshold: 12,
    existingFilesOnly: true,
    showTags: false,
    showAttachments: false,
    searchMode: 'spotlight' as const,
    searchQuery: ''
  }

  it('applies type filter', () => {
    const mixed = [n('a', { type: 'project' }), n('b', { type: 'note' })]
    const out = computeFilteredNodes(
      mixed,
      { ...base, selectedType: 'project' },
      new Map(),
      new Set()
    )
    expect(out.map((x) => x.id)).toEqual(['a'])
  })

  it('applies orphan hide/only via visible degree', () => {
    const deg = new Map([
      ['a', 2],
      ['b', 0]
    ])
    const hide = computeFilteredNodes(nodes, { ...base, orphanMode: 'hide' }, deg, new Set())
    expect(hide.map((x) => x.id)).toEqual(['a'])
    const only = computeFilteredNodes(nodes, { ...base, orphanMode: 'only' }, deg, new Set())
    expect(only.map((x) => x.id)).toEqual(['b', 'c'])
  })

  it('applies filter search mode (Obsidian subtraction)', () => {
    const named = [n('Rocket'), n('Garden')]
    const out = computeFilteredNodes(
      named,
      { ...base, searchMode: 'filter', searchQuery: 'rocket' },
      new Map(),
      new Set()
    )
    expect(out.map((x) => x.id)).toEqual(['Rocket'])
  })
})

describe('computeFilteredEdges', () => {
  it('drops edges to filtered-out nodes', () => {
    const nodes = [n('a'), n('b'), n('c')]
    const edges = [e('1', 'a', 'b'), e('2', 'b', 'c')]
    const ids = new Set(['a', 'b'])
    const byId = new Map(nodes.map((x) => [x.id, x]))
    const out = computeFilteredEdges(edges, ids, byId, false, false)
    expect(out.map((x) => x.id)).toEqual(['1'])
  })

  it('handles tag edges per visibility rules', () => {
    const nodes = [n('a'), n('t', { isTag: true, type: 'tag' })]
    const edges = [e('1', 'a', 't', 'tag')]
    const ids = new Set(['a', 't'])
    const byId = new Map(nodes.map((x) => [x.id, x]))
    // tags hidden → tag edge dropped
    expect(computeFilteredEdges(edges, ids, byId, false, false)).toHaveLength(0)
    // tags shown → note→tag edge kept even without showTagEdges
    expect(computeFilteredEdges(edges, ids, byId, false, true)).toHaveLength(1)
  })
})

describe('group query helpers (re-exported parity)', () => {
  it('matchGroupQuery AND semantics + negation + prefixes', () => {
    const node = n('Apollo 11', { type: 'project', tags: ['space', 'history'] })
    expect(matchGroupQuery('space', node)).toBe(true)
    expect(matchGroupQuery('tag:space', node)).toBe(true)
    expect(matchGroupQuery('path:Apollo', node)).toBe(true)
    expect(matchGroupQuery('type:project', node)).toBe(true)
    expect(matchGroupQuery('space -history', node)).toBe(false)
    expect(matchGroupQuery('space -ocean', node)).toBe(true)
  })

  it('resolveGroupColors first match wins', () => {
    const nodes = [n('A', { tags: ['x'] }), n('B', { tags: ['y'] })]
    const groups = [
      { id: 'g1', query: 'x', color: '#ff0000' },
      { id: 'g2', query: 'y', color: '#00ff00' }
    ]
    const map = resolveGroupColors(nodes, groups)
    expect(map!.get('A')).toBe('#ff0000')
    expect(map!.get('B')).toBe('#00ff00')
  })

  it('resolveGroupColors handles empty groups', () => {
    expect(resolveGroupColors([n('A')], [])).toBeNull()
    expect(resolveGroupColors([], [{ id: 'g', query: 'x', color: '#123' }])).toBeNull()
  })
})
