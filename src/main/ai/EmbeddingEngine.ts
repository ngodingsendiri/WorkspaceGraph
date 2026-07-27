/**
 * EmbeddingEngine — Local Semantic Vector Search (Worker-backed)
 *
 * Uses @xenova/transformers via a dedicated worker thread to run
 * all-MiniLM-L6-v2 (~25MB) off the main Electron process.
 *
 * PERSISTENCE: Vectors stored as BLOB in vault's .workspacegraph/index.db
 * (table: embedding_chunks). On vault re-open we load existing vectors from DB,
 * and only re-index files whose mtime is newer than stored timestamp.
 *
 * STATUS: embeddingEngine.getStatus() returns live { state, totalChunks, indexedFiles }
 * for the IPC handler ai:embeddingStatus so the UI can show a progress badge.
 *
 * Lifecycle:
 *   1. embeddingEngine.init()                     — spawn worker, load model (once per app run)
 *   2. embeddingEngine.loadFromDb(db)             — restore persisted vectors from SQLite
 *   3. embeddingEngine.indexVaultBackground(root, db) — index new/changed files via worker
 *   4. embeddingEngine.search(query)              — semantic search via worker
 *   5. embeddingEngine.clear()                    — on vault close/switch
 */

import path from 'path'
import fs from 'fs'
import { getEmbeddingWorker, terminateAllWorkers } from '../workers/worker-pool'
import type { SemanticHit, WorkerResponse } from '../workers/worker-pool'

const CHUNK_SIZE = 480
const CHUNK_OVERLAP = 60

export type EmbeddingState = 'idle' | 'loading_model' | 'indexing' | 'ready'

export interface EmbeddingStatus {
  state: EmbeddingState
  totalChunks: number
  indexedFiles: number
  modelReady: boolean
}

// Minimal SQLite type for our needs — matches better-sqlite3 interface
interface MinDb {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => unknown
    get: (...args: unknown[]) => unknown
    all: (...args: unknown[]) => unknown[]
  }
  exec: (sql: string) => void
}

function float32ToBuffer(f: Float32Array): Buffer {
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength)
}

function bufferToFloat32(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Float32Array(ab)
}

function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + size))
    start += size - overlap
    if (start + overlap >= text.length) break
  }
  const tail = text.slice(Math.max(0, text.length - size))
  if (tail && tail !== chunks[chunks.length - 1]) chunks.push(tail)
  return chunks.filter((c) => c.trim().length > 20)
}

interface LocalChunkEntry {
  filePath: string
  chunk: string
  vector: Float32Array
  mtime: number
}

export class EmbeddingEngine {
  private index: LocalChunkEntry[] = []
  private state: EmbeddingState = 'idle'
  private initializing = false
  private indexedPaths = new Set<string>()
  private currentDb: MinDb | null = null
  private worker: Awaited<ReturnType<typeof getEmbeddingWorker>> | null = null
  private useWorker = true
  private progressCallbacks: ((current: number, total: number, stage: string) => void)[] = []

  // ── Public status ────────────────────────────────────────────────────────────

  get isReady(): boolean {
    return this.state === 'ready' || (this.worker !== null && this.state === 'indexing')
  }

  getStatus(): EmbeddingStatus {
    return {
      state: this.state,
      totalChunks: this.index.length,
      indexedFiles: this.indexedPaths.size,
      modelReady: this.worker !== null,
    }
  }

  onProgress(cb: (current: number, total: number, stage: string) => void): () => void {
    this.progressCallbacks.push(cb)
    return () => {
      const i = this.progressCallbacks.indexOf(cb)
      if (i >= 0) this.progressCallbacks.splice(i, 1)
    }
  }

  private emitProgress(current: number, total: number, stage: string): void {
    for (const cb of this.progressCallbacks) cb(current, total, stage)
  }

  // ── Worker management ────────────────────────────────────────────────────────

  private async ensureWorker(): Promise<boolean> {
    if (this.worker) return true
    if (!this.useWorker) return false
    // Skip worker in test environment (vitest sets this)
    if (process.env.VITEST || process.env.NODE_ENV === 'test') {
      this.useWorker = false
      return false
    }
    try {
      this.state = 'loading_model'
      this.worker = await getEmbeddingWorker()
      return true
    } catch (err) {
      console.warn('[EmbeddingEngine] Worker unavailable, falling back to main thread:', err)
      this.useWorker = false
      return false
    }
  }

  // ── Model init ────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.worker || this.initializing) return
    this.initializing = true
    this.state = 'loading_model'
    const ok = await this.ensureWorker()
    if (!ok) {
      // Fallback: load model on main thread (original behavior)
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const xenovaMod = await import('@xenova/transformers')
        const { pipeline, env } = xenovaMod
        env.allowLocalModels = false
        if (env.backends?.onnx) env.backends.onnx.logLevel = 'error'
        // Store embedder on a temp property for fallback
        ;(this as any)._fallbackEmbedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
        console.log('[EmbeddingEngine] Fallback model ready on main thread')
      } catch (e) {
        console.warn('[EmbeddingEngine] Fallback init failed:', e)
        this.state = 'idle'
      }
    }
    this.initializing = false
    if (this.worker || (this as any)._fallbackEmbedder) this.state = 'ready'
  }

  // ── DB persistence ────────────────────────────────────────────────────────────

  private migrateDb(db: MinDb): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_chunks (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        path     TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        chunk    TEXT NOT NULL,
        vector   BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_emb_path ON embedding_chunks(path);
    `)
  }

  loadFromDb(db: MinDb): void {
    this.migrateDb(db)
    this.currentDb = db
    type Row = { path: string; chunk: string; vector: Buffer; mtime_ms: number }
    const rows = db.prepare('SELECT path, chunk, vector, mtime_ms FROM embedding_chunks').all() as Row[]
    let loaded = 0
    for (const row of rows) {
      try {
        const vector = bufferToFloat32(row.vector)
        this.index.push({ filePath: row.path, chunk: row.chunk, vector, mtime: row.mtime_ms })
        this.indexedPaths.add(row.path.replace(/\\/g, '/'))
        loaded++
      } catch {
        /* corrupted row — skip */
      }
    }
    if (loaded > 0) {
      console.log(`[EmbeddingEngine] Loaded ${loaded} chunks from DB`)
    }
  }

  private saveChunkToDb(db: MinDb, filePath: string, chunk: string, vector: Float32Array, mtime: number): void {
    try {
      db.prepare(
        'INSERT INTO embedding_chunks (path, mtime_ms, chunk, vector) VALUES (?, ?, ?, ?)'
      ).run(filePath, mtime, chunk, float32ToBuffer(vector))
    } catch {
      /* ignore write errors */
    }
  }

  private deleteFromDb(db: MinDb, filePath: string): void {
    try {
      db.prepare('DELETE FROM embedding_chunks WHERE path = ?').run(filePath)
    } catch { /* ignore */ }
  }

  // ── Embedding (worker or fallback) ──────────────────────────────────────────

  private async embedTexts(texts: string[]): Promise<Float32Array[]> {
    if (this.worker) {
      const resp = await this.worker.post<WorkerResponse['type']>({ type: 'embed', texts })
      if (resp.type === 'embedded') return resp.vectors
      throw new Error('Worker embed failed')
    }
    // Fallback: main thread
    const embedder = (this as any)._fallbackEmbedder
    if (!embedder) throw new Error('No embedder available')
    const vectors: Float32Array[] = []
    for (let i = 0; i < texts.length; i++) {
      const out = await embedder(texts[i], { pooling: 'mean', normalize: true })
      vectors.push(out.data as Float32Array)
      if (i % 5 === 0) this.emitProgress(i + 1, texts.length, 'embedding')
    }
    return vectors
  }

  // ── Indexing ────────────────────────────────────────────────────────────────

  async indexFile(filePath: string, db?: MinDb | null): Promise<void> {
    if (!this.worker && !(this as any)._fallbackEmbedder) return
    const norm = filePath.replace(/\\/g, '/')

    let mtime = 0
    try { mtime = fs.statSync(filePath).mtimeMs } catch { return }

    const activeDb = db ?? this.currentDb

    if (this.indexedPaths.has(norm)) {
      if (activeDb) {
        type MtimeRow = { mtime_ms: number }
        const row = activeDb.prepare(
          'SELECT mtime_ms FROM embedding_chunks WHERE path = ? LIMIT 1'
        ).get(filePath) as MtimeRow | undefined
        if (row && row.mtime_ms >= mtime) return
        this.index = this.index.filter((e) => e.filePath.replace(/\\/g, '/') !== norm)
        this.indexedPaths.delete(norm)
        this.deleteFromDb(activeDb, filePath)
      } else {
        return
      }
    }

    this.indexedPaths.add(norm)

    let raw: string
    try { raw = fs.readFileSync(filePath, 'utf-8') } catch { return }

    let body = raw
    if (body.startsWith('---')) {
      const end = body.indexOf('\n---', 3)
      if (end !== -1) body = body.slice(end + 4)
    }

    const chunks = chunkText(body)
    if (chunks.length === 0) return

    const vectors = await this.embedTexts(chunks)
    for (let i = 0; i < chunks.length; i++) {
      if (vectors[i]) {
        this.index.push({ filePath, chunk: chunks[i], vector: vectors[i], mtime })
        if (activeDb) this.saveChunkToDb(activeDb, filePath, chunks[i], vectors[i], mtime)
      }
    }
  }

  async indexVaultBackground(vaultRoot: string, db?: MinDb | null): Promise<void> {
    if (!this.worker && !(this as any)._fallbackEmbedder) return
    const activeDb = db ?? this.currentDb
    this.state = 'indexing'
    const files = this.collectMarkdownPaths(vaultRoot)
    console.log(`[EmbeddingEngine] Background indexing ${files.length} files…`)
    let n = 0
    for (const fp of files) {
      await this.indexFile(fp, activeDb)
      if (++n % 20 === 0) await new Promise<void>((r) => setTimeout(r, 0))
      this.emitProgress(n, files.length, 'indexing')
    }
    this.state = 'ready'
    console.log(`[EmbeddingEngine] Ready — ${n} files, ${this.index.length} chunks`)
    this.emitProgress(this.index.length, this.index.length, 'ready')
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  async search(query: string, topK = 6): Promise<SemanticHit[]> {
    if ((!this.worker && !(this as any)._fallbackEmbedder) || !query.trim() || this.index.length === 0) return []

    let qv: Float32Array
    if (this.worker) {
      // Use worker to embed query, then do cosine search locally (fast)
      const resp = await this.worker.post<WorkerResponse['type']>({ type: 'embed', texts: [query] })
      if (resp.type !== 'embedded') throw new Error('Worker embed failed')
      qv = resp.vectors[0]
    } else {
      const embedder = (this as any)._fallbackEmbedder
      const out = await embedder(query, { pooling: 'mean', normalize: true })
      qv = out.data as Float32Array
    }

    const scored = this.index
      .map((e) => ({ filePath: e.filePath, chunk: e.chunk, score: dotProduct(qv, e.vector) }))
      .sort((a, b) => b.score - a.score)

    const seen = new Set<string>()
    const out: SemanticHit[] = []
    for (const item of scored) {
      if (item.score < 0.25) break
      const k = item.filePath.replace(/\\/g, '/')
      if (!seen.has(k)) {
        seen.add(k)
        out.push(item)
      }
      if (out.length >= topK) break
    }
    return out
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  removeFile(filePath: string): void {
    const norm = filePath.replace(/\\/g, '/')
    this.index = this.index.filter((e) => e.filePath.replace(/\\/g, '/') !== norm)
    this.indexedPaths.delete(norm)
    if (this.currentDb) this.deleteFromDb(this.currentDb, filePath)
  }

  async reindexFile(filePath: string): Promise<void> {
    this.removeFile(filePath)
    await this.indexFile(filePath, this.currentDb)
  }

  clear(): void {
    this.index = []
    this.indexedPaths.clear()
    this.currentDb = null
    this.state = this.worker || (this as any)._fallbackEmbedder ? 'idle' : 'idle'
    console.log('[EmbeddingEngine] Index cleared')
  }

  private collectMarkdownPaths(vaultRoot: string): string[] {
    const out: string[] = []
    const walk = (dir: string) => {
      let entries: fs.Dirent[] = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.toLowerCase().endsWith('.md')) out.push(full)
      }
    }
    walk(vaultRoot)
    return out
  }

  async terminate(): Promise<void> {
    await terminateAllWorkers()
    this.worker = null
  }
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

export const embeddingEngine = new EmbeddingEngine()