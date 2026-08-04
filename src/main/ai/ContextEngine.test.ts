import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ContextEngine, ROLE_PROFILES } from './ContextEngine'
import type { SearchEngine } from '../engine/SearchEngine'
import type { WorkspaceEngine } from '../engine/WorkspaceEngine'
import { embeddingEngine } from './EmbeddingEngine'

/** Minimal fakes — ContextEngine only touches these members. */
function makeFakes() {
  const workspaceEngine = {
    readFile: vi.fn((p: string) => ({ content: `# ${p}\\n\\nBody of ${p}. Lorem ipsum dolor sit amet.` })),
    getState: vi.fn(() => ({ rootPath: null }))
  } as unknown as WorkspaceEngine
  const searchEngine = {
    searchSync: vi.fn(() => []),
    getSystemFolderNotes: vi.fn(() => [])
  } as unknown as SearchEngine
  const ctx = new ContextEngine(workspaceEngine, searchEngine)
  return { ctx, workspaceEngine, searchEngine }
}

describe('ROLE_PROFILES', () => {
  it('scales token budget by role (researcher > general > planner)', () => {
    expect(ROLE_PROFILES.researcher.budget).toBeGreaterThan(ROLE_PROFILES.general.budget)
    expect(ROLE_PROFILES.general.budget).toBeGreaterThan(ROLE_PROFILES.planner.budget)
  })

  it('every role has positive retrieval caps', () => {
    for (const [role, p] of Object.entries(ROLE_PROFILES)) {
      expect(p.budget).toBeGreaterThan(0)
      expect(p.searchFiles).toBeGreaterThan(0)
      expect(p.semanticFiles).toBeGreaterThan(0)
      expect(p.systemCap).toBeGreaterThan(0)
      expect(role).toBeTruthy()
    }
  })
})

describe('ContextEngine.buildContextPackage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the FTS/Fuse preview window as the snippet, not the file head', () => {
    const { ctx, searchEngine } = makeFakes()
    searchEngine.searchSync = vi.fn(() => [
      {
        id: '1',
        title: 'Note A',
        path: '/vault/Notes/A.md',
        relativePath: 'Notes/A.md',
        score: 88,
        type: 'note',
        tags: [],
        preview: '…the matched window about machine learning…',
        matchedField: 'content',
        source: 'fts'
      }
    ]) as never

    const pkg = ctx.buildContextPackage('machine learning', undefined, 'general')
    const search = pkg.relevantFiles.find((f) => f.tier === 'search')
    expect(search).toBeTruthy()
    // Snippet must come from the FTS match window, not from the top of the file
    expect(search!.snippet).toContain('matched window')
    expect(search!.snippet).not.toContain('# /vault/Notes/A.md')
  })

  it('caps search files by the role profile', () => {
    const { ctx, searchEngine } = makeFakes()
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      title: `Note ${i}`,
      path: `/vault/N${i}.md`,
      relativePath: `N${i}.md`,
      score: 90 - i,
      type: 'note',
      tags: [],
      preview: 'match',
      matchedField: 'content',
      source: 'fts'
    }))
    searchEngine.searchSync = vi.fn(() => many) as never

    const pkg = ctx.buildContextPackage('query', undefined, 'general')
    const searchCount = pkg.relevantFiles.filter((f) => f.tier === 'search').length
    expect(searchCount).toBeLessThanOrEqual(ROLE_PROFILES.general.searchFiles)
    expect(searchCount).toBeGreaterThan(0)
  })

  it('tracks tokenEstimate and budget line', () => {
    const { ctx } = makeFakes()
    const pkg = ctx.buildContextPackage('query', undefined, 'general')
    expect(pkg.tokenEstimate).toBeGreaterThan(0)
    expect(pkg.formattedContext).toContain('Token budget ~3600')
    expect(pkg.formattedContext).toContain('=== WORKSPACE CONTEXT ===')
    expect(pkg.formattedContext).toContain('=== END OF WORKSPACE CONTEXT ===')
  })
})

describe('ContextEngine.buildContextPackageAsync rerank', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('interleaves a strong semantic hit above a weak FTS hit (realistic scores)', async () => {
    const { ctx, searchEngine } = makeFakes()
    // Realistic FTS band: top hit 80, weaker hit 62 (SearchEngine: 80 + rank*-2).
    searchEngine.searchSync = vi.fn(() => [
      {
        id: '1',
        title: 'Strong Keyword Note',
        path: '/vault/Strong.md',
        relativePath: 'Strong.md',
        score: 80,
        type: 'note',
        tags: [],
        preview: 'strong keyword match',
        matchedField: 'content',
        source: 'fts'
      },
      {
        id: '2',
        title: 'Weak Keyword Note',
        path: '/vault/Weak.md',
        relativePath: 'Weak.md',
        score: 62,
        type: 'note',
        tags: [],
        preview: 'weak keyword match',
        matchedField: 'content',
        source: 'fts'
      }
    ]) as never

    // Realistic semantic cosine ~0.6 → min-max maps it to 1.0 (single hit).
    const isReadySpy = vi.spyOn(embeddingEngine, 'isReady', 'get').mockReturnValue(true)
    const searchSpy = vi
      .spyOn(embeddingEngine, 'search')
      .mockResolvedValue([
        { filePath: '/vault/Semantic.md', chunk: 'highly relevant vector chunk', score: 0.6 }
      ])

    const pkg = await ctx.buildContextPackageAsync('query', undefined, 'general')
    const semIdx = pkg.relevantFiles.findIndex((f) => f.tier === 'semantic')
    const searchFiles = pkg.relevantFiles
      .map((f, i) => ({ f, i }))
      .filter((x) => x.f.tier === 'search')

    // Semantic (0.45) outranks the weaker FTS hit (0.55 * 0 = 0) but stays below
    // the strong FTS hit (0.55 * 1 = 0.55) — real interleave, not FTS-always-first.
    expect(semIdx).toBeGreaterThanOrEqual(0)
    expect(searchFiles.length).toBe(2)
    expect(semIdx).toBeGreaterThan(searchFiles[0].i) // below strong FTS
    expect(semIdx).toBeLessThan(searchFiles[1].i) // above weak FTS
    expect(pkg.formattedContext).toContain('[SEMANTIC]')
    isReadySpy.mockRestore()
    searchSpy.mockRestore()
  })

  it('does not duplicate the related-documents section when reranking', async () => {
    const { ctx, searchEngine } = makeFakes()
    searchEngine.searchSync = vi.fn(() => [
      {
        id: '1',
        title: 'Keyword Hit',
        path: '/vault/Keyword.md',
        relativePath: 'Keyword.md',
        score: 80,
        type: 'note',
        tags: [],
        preview: 'keyword window snippet',
        matchedField: 'content',
        source: 'fts'
      }
    ]) as never

    const isReadySpy = vi.spyOn(embeddingEngine, 'isReady', 'get').mockReturnValue(true)
    const searchSpy = vi
      .spyOn(embeddingEngine, 'search')
      .mockResolvedValue([
        { filePath: '/vault/Semantic.md', chunk: 'semantic chunk body', score: 0.55 }
      ])

    const pkg = await ctx.buildContextPackageAsync('query', undefined, 'general')
    const marker = 'Related documents (priority order):'
    const markerCount = pkg.formattedContext.split(marker).length - 1
    const searchCount = pkg.formattedContext.split('[SEARCH] "Keyword Hit"').length - 1
    const endMarkerCount = pkg.formattedContext.split('=== END OF WORKSPACE CONTEXT ===').length - 1

    expect(markerCount).toBe(1)
    expect(searchCount).toBe(1)
    expect(endMarkerCount).toBe(1)
    isReadySpy.mockRestore()
    searchSpy.mockRestore()
  })

  it('skips semantic step when embedding engine is not ready', async () => {
    const { ctx } = makeFakes()
    const pkg = await ctx.buildContextPackageAsync('query', undefined, 'general')
    expect(pkg.relevantFiles.some((f) => f.tier === 'semantic')).toBe(false)
  })
})
