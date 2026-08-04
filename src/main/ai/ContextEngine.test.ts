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

  it('orders semantic above weak FTS hits when the vector score is strong', async () => {
    const { ctx, searchEngine } = makeFakes()
    // Weak keyword hit: score 40/100 → normalized FTS weight 0.55*0.4 = 0.22
    searchEngine.searchSync = vi.fn(() => [
      {
        id: '1',
        title: 'Weak Keyword Note',
        path: '/vault/Weak.md',
        relativePath: 'Weak.md',
        score: 40,
        type: 'note',
        tags: [],
        preview: 'keyword match',
        matchedField: 'content',
        source: 'fts'
      }
    ]) as never

    // Strong semantic hit: cosine ~0.9 → semantic weight 0.45*0.9 = 0.405 > 0.22
    const isReadySpy = vi.spyOn(embeddingEngine, 'isReady', 'get').mockReturnValue(true)
    const searchSpy = vi
      .spyOn(embeddingEngine, 'search')
      .mockResolvedValue([
        { filePath: '/vault/Semantic.md', chunk: 'highly relevant vector chunk', score: 0.9 }
      ])

    const pkg = await ctx.buildContextPackageAsync('query', undefined, 'general')
    const semIdx = pkg.relevantFiles.findIndex((f) => f.tier === 'semantic')
    const searchIdx = pkg.relevantFiles.findIndex((f) => f.tier === 'search')

    // Both present, and semantic (strong) ranks before the weak FTS hit
    expect(semIdx).toBeGreaterThanOrEqual(0)
    expect(searchIdx).toBeGreaterThanOrEqual(0)
    expect(semIdx).toBeLessThan(searchIdx)
    expect(pkg.formattedContext).toContain('[SEMANTIC]')
    isReadySpy.mockRestore()
    searchSpy.mockRestore()
  })

  it('skips semantic step when embedding engine is not ready', async () => {
    const { ctx } = makeFakes()
    const pkg = await ctx.buildContextPackageAsync('query', undefined, 'general')
    expect(pkg.relevantFiles.some((f) => f.tier === 'semantic')).toBe(false)
  })
})
