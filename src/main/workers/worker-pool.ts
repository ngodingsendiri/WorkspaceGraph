/**
 * Worker Pool — manages dedicated worker threads for heavy tasks.
 * Each worker is a long-lived Node.js worker_threads instance.
 */
import { Worker, isMainThread, parentPort } from 'worker_threads'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export type WorkerMessage =
  | { type: 'init'; payload: unknown }
  | { type: 'embed'; texts: string[] }
  | { type: 'search'; queryVector: Float32Array; topK: number; indexSnapshot: ChunkEntry[] }
  | { type: 'buildIndex'; entries: IndexEntry[] }
  | { type: 'fuzzySearch'; query: string; limit: number }
  | { type: 'shutdown' }

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'embedded'; vectors: Float32Array[] }
  | { type: 'searchResult'; hits: SemanticHit[] }
  | { type: 'indexBuilt'; size: number }
  | { type: 'fuzzyResult'; results: SearchResult[] }
  | { type: 'error'; error: string }
  | { type: 'progress'; current: number; total: number; stage: string }

export interface ChunkEntry {
  filePath: string
  chunk: string
  vector: Float32Array
}

export interface SemanticHit {
  filePath: string
  chunk: string
  score: number
}

export interface IndexEntry {
  id: string
  title: string
  path: string
  relativePath: string
  content: string
  tags: string[]
  type: string
  rawContent: string
  updatedAt?: string
  headings?: string
}

export interface SearchResult {
  id: string
  title: string
  path: string
  relativePath: string
  score: number
  type: string
  tags: string[]
  preview?: string
  matchedField: 'title' | 'content' | 'tag' | 'path' | 'backlink'
  source?: 'fts' | 'fuse' | 'meta' | 'semantic'
}

class WorkerWrapper {
  private worker: Worker
  private pending = new Map<
    number,
    { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void }
  >()
  private msgId = 0
  private initPromise: Promise<void>

  constructor(scriptName: string, initPayload?: unknown) {
    const scriptPath = path.join(__dirname, scriptName)
    this.worker = new Worker(scriptPath, { workerData: initPayload })
    this.worker.on('message', (msg: WorkerResponse) => this.handleMessage(msg))
    this.worker.on('error', (err) => this.rejectAll(err))
    this.worker.on('exit', (code) => {
      if (code !== 0) this.rejectAll(new Error(`Worker exited with code ${code}`))
    })

    this.initPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 30000)
      const onReady = (msg: WorkerResponse): void => {
        if (msg.type === 'ready') {
          clearTimeout(timeout)
          this.worker.off('message', onReady)
          resolve()
        }
      }
      this.worker.on('message', onReady)
    })

    if (initPayload) this.worker.postMessage({ type: 'init', payload: initPayload })
  }

  private handleMessage(msg: WorkerResponse): void {
    // Responses are matched by order (simple queue) — for now single-threaded use
    // In production, add msgId correlation
    for (const [, p] of this.pending) {
      p.resolve(msg)
      this.pending.delete(this.pending.keys().next().value!)
      return
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  async post<T extends WorkerResponse['type']>(
    msg: WorkerMessage
  ): Promise<Extract<WorkerResponse, { type: T }>> {
    await this.initPromise
    return new Promise((resolve, reject) => {
      this.pending.set(this.msgId++, {
        resolve: resolve as (v: WorkerResponse) => void,
        reject
      })
      this.worker.postMessage(msg)
    })
  }

  async terminate(): Promise<void> {
    this.worker.postMessage({ type: 'shutdown' })
    await this.worker.terminate()
  }
}

let embeddingWorker: WorkerWrapper | null = null
let searchIndexWorker: WorkerWrapper | null = null

export async function getEmbeddingWorker(): Promise<WorkerWrapper> {
  if (!embeddingWorker) {
    embeddingWorker = new WorkerWrapper('embedding.worker.js')
  }
  return embeddingWorker
}

export async function getSearchIndexWorker(): Promise<WorkerWrapper> {
  if (!searchIndexWorker) {
    searchIndexWorker = new WorkerWrapper('search-index.worker.js')
  }
  return searchIndexWorker
}

export async function terminateAllWorkers(): Promise<void> {
  await Promise.all([
    embeddingWorker
      ?.terminate()
      .then(() => {
        embeddingWorker = null
      })
      .catch(() => {}),
    searchIndexWorker
      ?.terminate()
      .then(() => {
        searchIndexWorker = null
      })
      .catch(() => {})
  ])
}

if (!isMainThread && parentPort) {
  // This file can also act as a worker entry point if needed
  parentPort.postMessage({ type: 'ready' })
}
