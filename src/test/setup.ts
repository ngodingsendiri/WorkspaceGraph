import { vi, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { threadId } from 'worker_threads'
import type { ParsedMarkdown } from '../main/engine/MarkdownEngine'

/**
 * Per-worker userData root. Vitest runs each test file in its own worker
 * (forks pool → unique process.pid per file; threads pool → unique threadId
 * per parallel thread), so the combination is unique per worker. Workers
 * previously ALL shared test-fixtures/userData/workspacegraph/{settings,recent}.json
 * — parallel files raced on writes (saveSettings atomic-renames but
 * recent.json is a plain write) and produced random cross-file failures.
 * A per-worker dir isolates every file's settings/recent completely.
 */
const userDataRoot = path.join(os.tmpdir(), `wg-test-userdata-${process.pid}-${threadId}`)
fs.mkdirSync(path.join(userDataRoot, 'workspacegraph'), { recursive: true })

// Mock electron modules
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return userDataRoot
      return '/mock/path'
    })
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn()
  },
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((str: string) => Buffer.from(`encrypted:${str}`)),
    decryptString: vi.fn((buf: Buffer) => buf.toString().replace('encrypted:', ''))
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: { dev: true }
}))

vi.mock('better-sqlite3', () => {
  const m = {
    prepare: vi.fn(() => ({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(() => [])
    })),
    exec: vi.fn(),
    pragma: vi.fn(),
    close: vi.fn(),
    transaction: vi.fn((fn) => fn)
  }
  return vi.fn(() => m)
})

vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn()
  }))
}))

vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue({
    __call: vi.fn().mockResolvedValue({ data: new Float32Array(384).fill(0.1) })
  }),
  env: { allowLocalModels: false, backends: { onnx: { logLevel: 'error' } } }
}))

// Test utilities
export function createMockParsedMarkdown(
  overrides: Partial<{
    id: string
    filePath: string
    relativePath: string
    title: string
    content: string
    tags: string[]
    frontmatter: Record<string, unknown>
    wikiLinks: Array<{ target: string; alias?: string }>
    headings: Array<{ level: number; text: string }>
  }> = {}
): ParsedMarkdown {
  const id = overrides.id || 'test-id-' + Math.random().toString(36).slice(2)
  return {
    id,
    filePath: overrides.filePath || `/vault/${id}.md`,
    relativePath: overrides.relativePath || `${id}.md`,
    title: overrides.title || id,
    content: overrides.content || `# ${overrides.title || id}\n\nTest content.`,
    rawContent: overrides.content || `# ${overrides.title || id}\n\nTest content.`,
    tags: overrides.tags || [],
    frontmatter: overrides.frontmatter || {},
    wikiLinks: overrides.wikiLinks || [],
    headings: overrides.headings || [{ level: 1, text: overrides.title || id }],
    wordCount: 10
  }
}

export function createTempDir(): string {
  const dir = path.join(
    __dirname,
    '..',
    '..',
    'test-fixtures',
    `test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

// Global test timeout
vi.setConfig({ testTimeout: 30000 })

// Clean up this worker's private userData dir once its files finish running
// (hooks registered here apply to every test file executed by this worker).
afterAll(() => {
  try {
    fs.rmSync(userDataRoot, { recursive: true, force: true })
  } catch {
    /* tmp cleanup is best-effort */
  }
})
