/**
 * ONE-OFF validation for WB-12 (hybrid blend tuning) — run with `npx tsx scripts/wb12-validation.ts`.
 *
 * Uses the REAL production pieces (no vitest mocks):
 *   - corpus: the repo's own *.md docs copied to a temp vault
 *   - keyword: real SQLite FTS5 + Fuse (IndexDatabase.open + SearchEngine.buildIndex)
 *   - semantic: real Xenova/all-MiniLM-L6-v2 embeddings (first run downloads ~23MB
 *     into node_modules/@xenova/transformers/.cache — gitignored)
 *   - new blend: the REAL SearchEngine.search() (embeddingEngine.search monkey-patched
 *     to return the real hits)
 *   - old blend: reconstructed from the pre-WB-12 code (min-max normalize, 0.6/0.4 merge)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline, env } from '@xenova/transformers'
import { SearchEngine } from '../src/main/engine/SearchEngine'
import { MarkdownEngine } from '../src/main/engine/MarkdownEngine'
import { indexDatabase } from '../src/main/engine/IndexDatabase'
import { chunkText, embeddingEngine } from '../src/main/ai/EmbeddingEngine'

env.allowRemoteModels = true

function dotProduct(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Replicates embeddingEngine.search() production scoring (cosine + titleBoost + adaptive threshold). */
function scoreSemantic(
  query: string,
  vectors: Map<string, { filePath: string; chunk: string; vector: Float32Array }[]>,
  qv: Float32Array,
  topK = 6
): { filePath: string; chunk: string; score: number }[] {
  const titleBoost = (filePath: string): number => {
    const base = filePath.replace(/\\/g, '/').split('/').pop() || ''
    const title = base.replace(/\.md$/i, '').toLowerCase()
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
    return terms.some((t) => title.includes(t)) ? 0.06 : 0
  }
  const scored: { filePath: string; chunk: string; score: number }[] = []
  for (const chunks of vectors.values()) {
    for (const c of chunks) {
      scored.push({ filePath: c.filePath, chunk: c.chunk, score: dotProduct(qv, c.vector) + titleBoost(c.filePath) })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const topScore = scored[0]?.score ?? 0
  const minScore = topScore > 0.25 ? Math.max(0.22, topScore * 0.6) : 0.15
  const seen = new Set<string>()
  const out: { filePath: string; chunk: string; score: number }[] = []
  for (const item of scored) {
    if (item.score < minScore) break
    const k = item.filePath.replace(/\\/g, '/')
    if (!seen.has(k)) {
      seen.add(k)
      out.push(item)
    }
    if (out.length >= topK) break
  }
  return out
}

/** OLD blend (pre-WB-12): min-max normalize keyword + semantic scores, then 0.6/0.4 merge. */
function oldBlend(
  kw: { title: string; score: number }[],
  sem: { title: string; score: number }[],
  limit: number
): { title: string; score: number; src: string }[] {
  const minMax = (scores: number[]): number[] => {
    if (scores.length === 0) return []
    let min = Infinity
    let max = -Infinity
    for (const s of scores) {
      if (s < min) min = s
      if (s > max) max = s
    }
    if (max === min) return scores.map(() => 1)
    return scores.map((s) => (s - min) / (max - min))
  }
  const kwNorm = minMax(kw.map((r) => r.score))
  const semNorm = minMax(sem.map((r) => r.score))
  const pool = [
    ...kw.map((r, i) => ({ title: r.title, score: 0.6 * kwNorm[i], src: 'kw' })),
    ...sem.map((r, i) => ({ title: r.title, score: 0.4 * semNorm[i], src: 'sem' }))
  ].sort((a, b) => b.score - a.score)
  return pool.slice(0, limit)
}

async function main(): Promise<void> {
  // 1) Temp vault = copy of the repo's own docs (real prose corpus).
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb12-vault-'))
  const srcFiles = fs
    .readdirSync(process.cwd())
    .filter((f) => /\.md$/i.test(f) && /^\d{2}_|^README/i.test(f))
  for (const f of srcFiles) fs.copyFileSync(f, path.join(vaultDir, f))
  const md = new MarkdownEngine()
  const parsed = srcFiles.map((f) =>
    md.parseFile(path.join(vaultDir, f), fs.readFileSync(path.join(vaultDir, f), 'utf8'), vaultDir)
  )
  console.log(`\n=== Corpus: ${parsed.length} docs (${vaultDir}) ===`)

  // 2) Real keyword path: FTS (better-sqlite3) + Fuse.
  indexDatabase.open(vaultDir)
  const search = new SearchEngine()
  await search.buildIndex(parsed)
  console.log(`FTS open: ${indexDatabase.isOpen()} · index size: ${search.getIndexSize()}`)

  // 3) Real MiniLM embeddings (per-chunk, like production).
  console.log('Loading Xenova/all-MiniLM-L6-v2 (first run downloads ~23MB)…')
  const pipe: any = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  const extractor = (texts: string[], opts: Record<string, unknown>): Promise<any> =>
    typeof pipe === 'function' ? pipe(texts, opts) : pipe.__call(texts, opts)
  const vectors = new Map<string, { filePath: string; chunk: string; vector: Float32Array }[]>()
  for (const p of parsed) {
    const chunks = chunkText(p.rawContent)
    const outs: any = await extractor(chunks, { pooling: 'mean', normalize: true })
    const dim = p.rawContent.length > 0 ? outs.data.length / chunks.length : 0
    vectors.set(
      p.filePath,
      chunks.map((chunk, i) => ({
        filePath: p.filePath,
        chunk,
        vector: new Float32Array(outs.data.buffer, i * dim * 4, dim)
      }))
    )
  }
  console.log(`Embedded ${vectors.size} docs via MiniLM`)

  // 4) Drive the REAL production search() with the real hits (monkey-patch the singleton).
  const originalSearch = embeddingEngine.search.bind(embeddingEngine)
  const originalIsReady = Object.getOwnPropertyDescriptor(embeddingEngine, 'isReady')
  ;(embeddingEngine as unknown as { search: unknown }).search = async (_q: string, _k?: number) => []
  Object.defineProperty(embeddingEngine, 'isReady', { get: () => true, configurable: true })

  const queries = [
    'graph visualization',
    'sqlite fts ranking',
    'keyboard shortcuts',
    'plugin sdk development',
    'security sandbox permissions',
    'hybrid semantic search'
  ]

  let orderChanged = 0
  for (const q of queries) {
    const qv: Float32Array = (await extractor(q, { pooling: 'mean', normalize: true })).data
    const semHits = scoreSemantic(q, vectors, qv, 6)
    ;(embeddingEngine as unknown as { search: unknown }).search = async (_q: string, _k?: number) => semHits

    const newResults = await search.search({ query: q, limit: 10 })
    const kwOnly = search.searchSync({ query: q, limit: 10 })

    const kwList = kwOnly.map((r) => ({ title: r.title, score: r.score }))
    const semList = semHits
      .map((h) => ({ title: path.basename(h.filePath).replace(/\.md$/i, ''), score: h.score }))
      .filter((s) => !kwList.some((k) => k.title === s.title))
    const oldResults = oldBlend(kwList, semList, 10)

    const oldTitles = oldResults.map((r) => r.title)
    const newTitles = newResults.map((r) => r.title)
    const differs = oldTitles.join('|') !== newTitles.join('|')
    if (differs) orderChanged++

    console.log(`\n--- query: "${q}"${differs ? '  ⚠️ ORDER CHANGED' : ''} ---`)
    console.log('  KEYWORD  (top5): ' + kwList.slice(0, 5).map((r) => `${r.title}=${r.score.toFixed(1)}`).join(', '))
    console.log('  SEMANTIC (top5): ' + semList.slice(0, 5).map((r) => `${r.title}=${r.score.toFixed(3)}`).join(', '))
    console.log('  OLD top5: ' + oldTitles.slice(0, 5).join(' > '))
    console.log('  NEW top5: ' + newTitles.slice(0, 5).join(' > '))
  }
  console.log(`\n=== ${orderChanged}/${queries.length} queries changed ordering ===`)

  // Restore + cleanup.
  ;(embeddingEngine as unknown as { search: unknown }).search = originalSearch
  if (originalIsReady) Object.defineProperty(embeddingEngine, 'isReady', originalIsReady)
  indexDatabase.close()
  fs.rmSync(vaultDir, { recursive: true, force: true })
}

main().catch((e) => {
  console.error('VALIDATION FAILED:', e)
  process.exit(1)
})
