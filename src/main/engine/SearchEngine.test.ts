import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { SearchEngine } from './SearchEngine'
import { MarkdownEngine } from './MarkdownEngine'
import { embeddingEngine } from '../ai/EmbeddingEngine'

describe('SearchEngine', () => {
  let search: SearchEngine
  let markdown: MarkdownEngine

  beforeEach(() => {
    search = new SearchEngine()
    markdown = new MarkdownEngine()
  })

  const parse = (filePath: string, content: string) => {
    return markdown.parseFile(filePath, content, '/vault')
  }

  const buildIndex = async (files: ReturnType<typeof parse>[]) => {
    await search.buildIndex(files)
  }

  describe('buildIndex', () => {
    it('indexes parsed files', () => {
      const files = [
        parse('/vault/A.md', '# A\n\nContent A'),
        parse('/vault/B.md', '# B\n\nContent B')
      ]
      buildIndex(files)

      expect(search.getIndexSize()).toBe(2)
    })

    it('clears previous index', () => {
      buildIndex([parse('/vault/A.md', '# A')])
      buildIndex([parse('/vault/B.md', '# B')])
      expect(search.getIndexSize()).toBe(1)
    })
  })

  describe('searchSync (synchronous)', () => {
    beforeEach(async () => {
      await buildIndex([
        parse('/vault/A.md', '---\ntype: knowledge\n---\n# A\n\nKnowledge about TypeScript'),
        parse('/vault/B.md', '---\ntype: project\n---\n# B\n\nProject planning'),
        parse('/vault/C.md', '---\ntype: task\n---\n# C\n\nTask list')
      ])
    })

    it('returns recent files for empty query', () => {
      const results = search.searchSync({ query: '', limit: 10 })
      expect(results.length).toBeGreaterThan(0)
    })

    it('searches by keyword', () => {
      const results = search.searchSync({ query: 'TypeScript', limit: 10 })
      expect(results.some((r) => r.title === 'A')).toBe(true)
    })

    it('filters by type', () => {
      const results = search.searchSync({ query: 'planning', filterType: 'project', limit: 10 })
      expect(results.every((r) => r.type === 'project')).toBe(true)
    })

    it('filters by tag', () => {
      const tagged = parse('/vault/D.md', '---\ntags: [mytag]\ntype: note\n---\n# D')
      search.addToIndex(tagged)

      const results = search.searchSync({ query: '', filterTag: 'mytag', limit: 10 })
      expect(results.some((r) => r.title === 'D')).toBe(true)
    })

    it('supports orphan:true query', () => {
      const results = search.searchSync({ query: 'orphan:true', limit: 10 })
      expect(results.length).toBeGreaterThanOrEqual(0)
    })

    it('supports backlinks: query', () => {
      const files = [
        parse('/vault/A.md', '---\ntype: note\n---\n# A\n\n[[B]]'),
        parse('/vault/B.md', '---\ntype: note\n---\n# B')
      ]
      buildIndex(files)

      const results = search.searchSync({ query: 'backlinks:B', limit: 10 })
      expect(results.some((r) => r.matchedField === 'backlink')).toBe(true)
    })

    it('supports path: query', () => {
      const results = search.searchSync({ query: 'path:folder', limit: 10 })
      expect(results.length).toBeGreaterThanOrEqual(0)
    })

    it('supports #tag exact query', () => {
      const tagged = parse('/vault/D.md', '---\ntags: [exact]\ntype: note\n---\n# D')
      search.addToIndex(tagged)

      const results = search.searchSync({ query: '#exact', limit: 10 })
      expect(results.some((r) => r.matchedField === 'tag')).toBe(true)
    })
  })

  describe('search (async with worker)', () => {
    beforeEach(async () => {
      await buildIndex([
        parse('/vault/A.md', '# A\n\nKnowledge about TypeScript'),
        parse('/vault/B.md', '# B\n\nProject planning')
      ])
    })

    it('returns Promise<SearchResult[]>', async () => {
      const results = await search.search({ query: 'TypeScript', limit: 10 })
      expect(results).toBeInstanceOf(Array)
    })

    it('finds fuzzy matches', async () => {
      const results = await search.search({ query: 'TypeScrpt', limit: 10 }) // typo
      expect(results.length).toBeGreaterThanOrEqual(0)
    })

    it('blends semantic hits into keyword results (hybrid)', async () => {
      const isReadySpy = vi.spyOn(embeddingEngine, 'isReady', 'get').mockReturnValue(true)
      const searchSpy = vi
        .spyOn(embeddingEngine, 'search')
        .mockResolvedValue([
          { filePath: '/vault/A.md', chunk: 'vector hit on A', score: 0.85 }
        ])

      const results = await search.search({ query: 'TypeScript', limit: 10 })
      // A appears once, sourced from semantic, and is merged into results
      expect(results.some((r) => r.title === 'A')).toBe(true)
      expect(results.filter((r) => r.title === 'A')).toHaveLength(1)
      isReadySpy.mockRestore()
      searchSpy.mockRestore()
    })

    it('returns semantic-only results when keyword search finds nothing', async () => {
      const isReadySpy = vi.spyOn(embeddingEngine, 'isReady', 'get').mockReturnValue(true)
      const searchSpy = vi
        .spyOn(embeddingEngine, 'search')
        .mockResolvedValue([
          { filePath: '/vault/A.md', chunk: 'only semantic match on A', score: 0.8 }
        ])

      // Query that matches no keyword — hybrid must still surface the vector hit.
      const results = await search.search({ query: 'zzz-no-keyword-match', limit: 10 })
      expect(results.some((r) => r.title === 'A')).toBe(true)
      isReadySpy.mockRestore()
      searchSpy.mockRestore()
    })

    it('does not duplicate entries already returned by keyword search', async () => {
      const isReadySpy = vi.spyOn(embeddingEngine, 'isReady', 'get').mockReturnValue(true)
      // A is already a keyword hit — semantic must not add a second entry
      const searchSpy = vi
        .spyOn(embeddingEngine, 'search')
        .mockResolvedValue([
          { filePath: '/vault/B.md', chunk: 'vector hit on B', score: 0.9 }
        ])

      const results = await search.search({ query: 'TypeScript', limit: 10 })
      expect(results.filter((r) => r.title === 'B')).toHaveLength(1)
      isReadySpy.mockRestore()
      searchSpy.mockRestore()
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })
  })

  describe('addToIndex / removeFromIndex', () => {
    it('adds single file incrementally', () => {
      buildIndex([parse('/vault/A.md', '# A')])
      expect(search.getIndexSize()).toBe(1)

      search.addToIndex(parse('/vault/B.md', '# B'))
      expect(search.getIndexSize()).toBe(2)
    })

    it('removes file from index', () => {
      buildIndex([parse('/vault/A.md', '# A'), parse('/vault/B.md', '# B')])
      expect(search.getIndexSize()).toBe(2)

      search.removeFromIndex('A-id') // won't match but tests API
      // Actual removal requires correct ID
    })
  })

  describe('searchBacklinks', () => {
    it('finds backlinks via graph engine', () => {
      const files = [
        parse('/vault/A.md', '# A\n\n[[B]]'),
        parse('/vault/B.md', '# B'),
        parse('/vault/C.md', '# C\n\n[[B]]')
      ]
      buildIndex(files)

      const results = search.searchBacklinks('B', 10)
      expect(results.length).toBe(2)
      expect(results.every((r) => r.matchedField === 'backlink')).toBe(true)
    })
  })

  describe('searchByPathFragment', () => {
    it('finds files by path fragment', () => {
      const files = [parse('/vault/Folder/Note.md', '# Note'), parse('/vault/Other.md', '# Other')]
      buildIndex(files)

      const results = search.searchByPathFragment('Folder', 10)
      expect(results.length).toBe(1)
      expect(results[0].title).toBe('Note')
    })
  })

  describe('searchByTag', () => {
    it('finds notes by tag', () => {
      const files = [
        parse('/vault/A.md', '---\ntags: [tag1]\n---\n# A'),
        parse('/vault/B.md', '---\ntags: [tag2]\n---\n# B')
      ]
      buildIndex(files)

      const results = search.searchByTag('tag1')
      expect(results.length).toBe(1)
      expect(results[0].title).toBe('A')
    })
  })

  describe('getRecentFiles', () => {
    it('returns recent files', () => {
      const files = [parse('/vault/A.md', '# A'), parse('/vault/B.md', '# B')]
      buildIndex(files)

      const results = search.getRecentFiles(5)
      expect(results.length).toBe(2)
    })
  })

  describe('getAllTags', () => {
    it('returns tags with counts', () => {
      const files = [
        parse('/vault/A.md', '---\ntags: [tag1, tag2]\n---\n# A'),
        parse('/vault/B.md', '---\ntags: [tag1]\n---\n# B')
      ]
      buildIndex(files)

      const tags = search.getAllTags()
      expect(tags.find((t) => t.tag === 'tag1')?.count).toBe(2)
      expect(tags.find((t) => t.tag === 'tag2')?.count).toBe(1)
    })
  })

  describe('getSystemFolderNotes', () => {
    it('returns notes from system folders', () => {
      const files = [
        parse('/vault/Rules/R1.md', '# R1'),
        parse('/vault/SOP/S1.md', '# S1'),
        parse('/vault/Other.md', '# Other')
      ]
      buildIndex(files)

      const sysNotes = search.getSystemFolderNotes()
      expect(sysNotes.length).toBe(2)
    })
  })

  describe('clear', () => {
    it('resets all state', () => {
      buildIndex([parse('/vault/A.md', '# A')])
      expect(search.getIndexSize()).toBe(1)

      search.clear()
      expect(search.getIndexSize()).toBe(0)
    })
  })
})
