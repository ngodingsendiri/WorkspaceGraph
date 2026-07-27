/**
 * Embedding Worker — runs Xenova Transformers (ONNX) in a separate thread.
 * Receives texts, returns Float32Array vectors.
 * 
 * This runs in a worker_thread, NOT the main Electron process.
 */
import { parentPort, workerData } from 'worker_threads'
import type { WorkerMessage, WorkerResponse, ChunkEntry, SemanticHit } from './worker-pool'

// Dynamic import to avoid bundling issues with electron-vite
let embedder: any = null
let initializing = false

async function initEmbedder(): Promise<void> {
  if (embedder || initializing) return
  initializing = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { pipeline, env } = await import('@xenova/transformers')
    env.allowLocalModels = false
    if (env.backends?.onnx) env.backends.onnx.logLevel = 'error'
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
    parentPort?.postMessage({ type: 'ready' } as WorkerResponse)
  } catch (err) {
    parentPort?.postMessage({ type: 'error', error: String(err) } as WorkerResponse)
  } finally {
    initializing = false
  }
}

async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (!embedder) await initEmbedder()
  if (!embedder) throw new Error('Embedder not initialized')

  const vectors: Float32Array[] = []
  for (let i = 0; i < texts.length; i++) {
    const out = await embedder(texts[i], { pooling: 'mean', normalize: true })
    vectors.push(out.data as Float32Array)
    if (i % 5 === 0) {
      parentPort?.postMessage({ type: 'progress', current: i + 1, total: texts.length, stage: 'embedding' } as WorkerResponse)
    }
  }
  return vectors
}

function cosineSearch(queryVec: Float32Array, index: ChunkEntry[], topK: number): SemanticHit[] {
  const hits: SemanticHit[] = []
  for (const entry of index) {
    let sum = 0
    const v = entry.vector
    for (let i = 0; i < v.length; i++) sum += queryVec[i] * v[i]
    if (sum > 0) hits.push({ filePath: entry.filePath, chunk: entry.chunk, score: sum })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, topK)
}

parentPort?.on('message', async (msg: WorkerMessage) => {
  try {
    switch (msg.type) {
      case 'init': {
        await initEmbedder()
        break
      }
      case 'embed': {
        const vectors = await embedTexts(msg.texts)
        parentPort?.postMessage({ type: 'embedded', vectors } as WorkerResponse)
        break
      }
      case 'search': {
        if (!embedder) await initEmbedder()
        const qOut = await embedder(msg.queryVector, { pooling: 'mean', normalize: true })
        const hits = cosineSearch(qOut.data as Float32Array, msg.indexSnapshot, msg.topK)
        parentPort?.postMessage({ type: 'searchResult', hits } as WorkerResponse)
        break
      }
      case 'shutdown': {
        process.exit(0)
        break
      }
    }
  } catch (err) {
    parentPort?.postMessage({ type: 'error', error: String(err) } as WorkerResponse)
  }
})

// Signal ready if no init payload
if (!workerData) {
  initEmbedder()
}