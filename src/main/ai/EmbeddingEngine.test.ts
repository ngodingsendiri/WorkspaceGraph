import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EmbeddingEngine, chunkText } from './EmbeddingEngine'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'

describe('EmbeddingEngine', () => {
  let engine: EmbeddingEngine

  beforeEach(() => {
    engine = new EmbeddingEngine()
    // Disable worker in tests
    vi.spyOn(
      engine as unknown as { ensureWorker: () => Promise<boolean> },
      'ensureWorker'
    ).mockResolvedValue(false)
    // Create mock fallback embedder as a callable function
    const mockEmbedder = vi.fn().mockResolvedValue({ data: new Float32Array(384).fill(0.1) })
    engine['fallbackEmbedder'] = mockEmbedder
    engine['useWorker'] = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
    engine.clear()
  })

  describe('chunkText', () => {
    it('splits long text into multiple chunks', () => {
      const text = 'word '.repeat(300)
      const chunks = chunkText(text, 480, 60)
      expect(chunks.length).toBeGreaterThan(1)
      // Reassembling keeps all content (overlap may duplicate a few chars)
      const joined = chunks.join('')
      expect(joined.length).toBeGreaterThan(text.length - 80)
    })

    it('prefers paragraph boundaries over hard cuts', () => {
      // Paragraph break sits inside the first window — chunk must break there
      const text = 'x'.repeat(400) + '\n\n' + 'y'.repeat(400)
      const chunks = chunkText(text, 480, 60)
      expect(chunks[0].includes('\n\n')).toBe(true)
    })

    it('breaks paragraphs on CRLF vaults (\r\n\r\n)', () => {
      // Windows vault: paragraph separator is \r\n\r\n — must chunk at the boundary
      const text = 'x'.repeat(400) + '\r\n\r\n' + 'y'.repeat(400)
      const chunks = chunkText(text, 480, 60)
      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks[0].includes('\n\n')).toBe(true)
    })

    it('does not emit empty or <20-char fragments', () => {
      const text = 'a'.repeat(2000)
      const chunks = chunkText(text, 480, 60)
      expect(chunks.length).toBeGreaterThan(1)
      for (const c of chunks) expect(c.trim().length).toBeGreaterThan(20)
    })

    it('returns a single chunk for short text', () => {
      // Must still pass the >20-char minimum filter
      expect(chunkText('# Hi\n\nThis is a short note with enough words.')).toHaveLength(1)
    })
  })

  describe('init', () => {
    it('initializes without error', async () => {
      await expect(engine.init()).resolves.not.toThrow()
    })

    it('sets isReady after init', async () => {
      await engine.init()
      expect(engine.isReady).toBe(true)
    })
  })

  describe('loadFromDb', () => {
    it('loads chunks from database', () => {
      const mockDb = {
        exec: vi.fn(),
        prepare: vi.fn().mockReturnThis(),
        all: vi.fn().mockReturnValue([
          {
            path: '/vault/A.md',
            chunk: 'content',
            vector: Buffer.from(new Float32Array([0.1, 0.2]).buffer),
            mtime_ms: 1000
          }
        ])
      }
      engine.loadFromDb(mockDb as unknown as Parameters<EmbeddingEngine['loadFromDb']>[0])
      expect(engine.getStatus().totalChunks).toBe(1)
    })

    it('handles corrupted rows gracefully', () => {
      const mockDb = {
        exec: vi.fn(),
        prepare: vi.fn().mockReturnThis(),
        all: vi.fn().mockReturnValue([
          {
            path: '/vault/A.md',
            chunk: 'content',
            vector: Buffer.from('invalid'),
            mtime_ms: 1000
          }
        ])
      }
      engine.loadFromDb(mockDb as unknown as Parameters<EmbeddingEngine['loadFromDb']>[0])
      expect(engine.getStatus().totalChunks).toBe(0)
    })
  })

  describe('indexFile', () => {
    it('indexes file and creates chunks', async () => {
      const testFile = path.join(tmpdir(), 'test-note.md')
      fs.writeFileSync(testFile, '# Test\n\nContent to index.')

      await engine.indexFile(testFile)
      expect(engine.getStatus().totalChunks).toBeGreaterThan(0)

      fs.unlinkSync(testFile)
    })

    it('skips file if mtime unchanged', async () => {
      const testFile = path.join(tmpdir(), 'test-note2.md')
      fs.writeFileSync(testFile, '# Test\n\nContent')

      await engine.indexFile(testFile)
      const chunksAfterFirst = engine.getStatus().totalChunks

      await engine.indexFile(testFile)
      expect(engine.getStatus().totalChunks).toBe(chunksAfterFirst)

      fs.unlinkSync(testFile)
    })

    it('skips non-existent files', async () => {
      await engine.indexFile('/nonexistent/path.md')
      expect(engine.getStatus().totalChunks).toBe(0)
    })
  })

  describe('search', () => {
    beforeEach(async () => {
      const testFile = path.join(tmpdir(), 'search-test.md')
      fs.writeFileSync(testFile, '# Search Test\n\nThis is content about machine learning.')
      await engine.indexFile(testFile)
      fs.unlinkSync(testFile)
    })

    it('returns semantic hits for query', async () => {
      const hits = await engine.search('machine learning', 5)
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]).toHaveProperty('filePath')
      expect(hits[0]).toHaveProperty('chunk')
      expect(hits[0]).toHaveProperty('score')
    })

    it('returns empty for empty query', async () => {
      const hits = await engine.search('', 5)
      expect(hits).toHaveLength(0)
    })

    it('returns empty when not ready', async () => {
      const freshEngine = new EmbeddingEngine()
      freshEngine['useWorker'] = false
      freshEngine['fallbackEmbedder'] = null
      const hits = await freshEngine.search('query', 5)
      expect(hits).toHaveLength(0)
    })
  })

  describe('indexVaultBackground', () => {
    it('indexes all markdown files in vault', async () => {
      const vaultDir = path.join(tmpdir(), 'test-vault-' + Date.now())
      fs.mkdirSync(vaultDir, { recursive: true })
      fs.writeFileSync(path.join(vaultDir, 'a.md'), '# A\n\nContent A')
      fs.writeFileSync(path.join(vaultDir, 'b.md'), '# B\n\nContent B')
      fs.mkdirSync(path.join(vaultDir, 'sub'), { recursive: true })
      fs.writeFileSync(path.join(vaultDir, 'sub', 'c.md'), '# C\n\nContent C')

      await engine.indexVaultBackground(vaultDir)
      expect(engine.getStatus().indexedFiles).toBe(3)

      fs.rmSync(vaultDir, { recursive: true })
    })

    it('emits progress events', async () => {
      const vaultDir = path.join(tmpdir(), 'test-vault2-' + Date.now())
      fs.mkdirSync(vaultDir, { recursive: true })
      fs.writeFileSync(path.join(vaultDir, 'a.md'), '# A')

      const progressSpy = vi.fn()
      const unsub = engine.onProgress(progressSpy)

      await engine.indexVaultBackground(vaultDir)
      expect(progressSpy).toHaveBeenCalled()

      unsub()
      fs.rmSync(vaultDir, { recursive: true })
    })
  })

  describe('removeFile / reindexFile', () => {
    it('removes file chunks', async () => {
      const testFile = path.join(tmpdir(), 'remove-test.md')
      fs.writeFileSync(testFile, '# Test\n\nContent')
      await engine.indexFile(testFile)

      engine.removeFile(testFile)
      expect(engine.getStatus().totalChunks).toBe(0)

      fs.unlinkSync(testFile)
    })

    it('reindexes file', async () => {
      const testFile = path.join(tmpdir(), 'reindex-test.md')
      fs.writeFileSync(testFile, '# Original\n\nContent')
      await engine.indexFile(testFile)

      fs.writeFileSync(testFile, '# Updated\n\nNew content')
      await engine.reindexFile(testFile)
      expect(engine.getStatus().totalChunks).toBeGreaterThan(0)

      fs.unlinkSync(testFile)
    })
  })

  describe('clear', () => {
    it('clears all state', async () => {
      const testFile = path.join(tmpdir(), 'clear-test.md')
      fs.writeFileSync(testFile, '# Test\n\nContent')
      await engine.indexFile(testFile)

      engine.clear()
      expect(engine.getStatus().totalChunks).toBe(0)
      expect(engine.getStatus().indexedFiles).toBe(0)

      fs.unlinkSync(testFile)
    })
  })

  describe('getStatus', () => {
    it('returns current state', async () => {
      const status = engine.getStatus()
      expect(status).toHaveProperty('state')
      expect(status).toHaveProperty('totalChunks')
      expect(status).toHaveProperty('indexedFiles')
      expect(status).toHaveProperty('modelReady')
    })
  })
})
