import { describe, it, expect, vi, beforeEach } from 'vitest'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { graphEngine } from '../engine/GraphEngine'
import { handleWatcherEvent, flushWatcherQueue } from '../ipc/shared'
import type { FileChangeEvent } from '../engine/FileWatcher'
import type { ParsedMarkdown } from '../engine/MarkdownEngine'

describe('X1 — watcher queue race (indexing vs incremental)', () => {
  const rootPath = '/tmp/wg-test-vault-x1'
  const mdPath = `${rootPath}/test.md`
  const unlinkEvent: FileChangeEvent = { type: 'unlink', path: mdPath }

  const parsed: ParsedMarkdown = {
    id: 'test-note',
    filePath: mdPath,
    relativePath: 'test.md',
    title: 'Test',
    content: '# Test',
    rawContent: '# Test',
    tags: [],
    frontmatter: {},
    wikiLinks: [],
    headings: [{ level: 1, text: 'Test' }],
    wordCount: 2
  }

  beforeEach(() => {
    const state = workspaceEngine.getState()
    state.indexing = false
    state.rootPath = rootPath
    graphEngine.clear()
    vi.restoreAllMocks()
  })

  it('mengantre event saat indexing=true, tidak memproses langsung', () => {
    const state = workspaceEngine.getState()
    state.indexing = true
    const result = handleWatcherEvent({ type: 'add', path: mdPath }, rootPath)
    expect(result).toBe(true)
  })

  it('memproses langsung saat indexing=false', () => {
    const state = workspaceEngine.getState()
    state.indexing = false
    const result = handleWatcherEvent({ type: 'add', path: mdPath }, rootPath)
    expect(result).toBe(false)
  })

  it('event yang diantre saat indexing diproses setelah flushWatcherQueue', () => {
    const state = workspaceEngine.getState()
    state.indexing = true

    // Seed graph with the note so unlink has a node to remove
    graphEngine.buildFromParsedFiles([parsed], false)
    expect(graphEngine.getNodeByPath(mdPath)).toBeDefined()

    // Queue an unlink during indexing — must NOT remove the node yet
    handleWatcherEvent(unlinkEvent, rootPath)
    expect(graphEngine.getNodeByPath(mdPath)).toBeDefined()

    // Flush — simulate indexing completed; queued unlink now applies
    state.indexing = false
    flushWatcherQueue()
    expect(graphEngine.getNodeByPath(mdPath)).toBeUndefined()
  })
})

void workspaceEngine
