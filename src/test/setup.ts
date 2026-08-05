import { vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { ParsedMarkdown } from '../main/engine/MarkdownEngine'

// Mock electron modules
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return path.join(__dirname, '..', '..', 'test-fixtures', 'userData')
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
