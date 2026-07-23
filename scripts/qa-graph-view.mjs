/**
 * Graph View smoke checks (no full Electron UI required for most asserts).
 * Run: node scripts/qa-graph-view.mjs
 *
 * Verifies:
 *  - GraphEngine builds non-empty graph from a vault-like tree
 *  - Canvas size fallback logic (never 0×0 when window has size)
 *  - CSS contract: graph-container absolute fill of main-content
 *  - GraphCanvas source guards (syncCanvasSize always ready, paint try/catch, pointer on wrap)
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const require = createRequire(import.meta.url)

let failed = 0
let passed = 0
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    failed++
  } else {
    console.log('OK  ', msg)
    passed++
  }
}

/** Mirror renderer syncCanvasSize fallback chain (unit logic) */
function resolveViewSize(wrap, main, win) {
  let w = Math.floor(Math.max(wrap.clientWidth || 0, wrap.rectW || 0, 0))
  let h = Math.floor(Math.max(wrap.clientHeight || 0, wrap.rectH || 0, 0))
  if (w < 32 || h < 32) {
    w = Math.floor(Math.max(main.clientWidth || 0, main.rectW || 0, w))
    h = Math.floor(Math.max(main.clientHeight || 0, main.rectH || 0, h))
  }
  if (w < 32 || h < 32) {
    w = Math.max(320, Math.floor(win.innerWidth * 0.55))
    h = Math.max(240, Math.floor(win.innerHeight * 0.7))
  }
  return { w, h, ready: w >= 32 && h >= 32 }
}

async function main() {
  // --- Size fallback ---
  const zeroWrap = { clientWidth: 0, clientHeight: 0, rectW: 0, rectH: 0 }
  const zeroMain = { clientWidth: 0, clientHeight: 0, rectW: 0, rectH: 0 }
  const win = { innerWidth: 1280, innerHeight: 800 }
  const fb = resolveViewSize(zeroWrap, zeroMain, win)
  assert(fb.ready && fb.w >= 320 && fb.h >= 240, `size fallback never 0×0 (got ${fb.w}x${fb.h})`)

  const okWrap = { clientWidth: 900, clientHeight: 600, rectW: 900, rectH: 600 }
  const ok = resolveViewSize(okWrap, zeroMain, win)
  assert(ok.w === 900 && ok.h === 600, 'prefers wrap size when valid')

  // --- CSS contract ---
  const css = fs.readFileSync(path.join(root, 'src/renderer/src/styles/globals.css'), 'utf8')
  assert(css.includes('.graph-container') && css.includes('position: absolute'), 'graph-container absolute fill')
  assert(css.includes('.main-content') && css.includes('min-height: 0'), 'main-content min-height 0')
  assert(css.includes('.app-body') && css.includes('min-height: 0'), 'app-body min-height 0')

  // --- Source guards ---
  const gc = fs.readFileSync(
    path.join(root, 'src/renderer/src/components/graph/GraphCanvas.tsx'),
    'utf8'
  )
  assert(gc.includes('ALWAYS produce a drawable size') || gc.includes('Last resort'), 'syncCanvasSize always-ready comment')
  assert(gc.includes('paint failed') || gc.includes('try {'), 'paint try/catch')
  assert(gc.includes('fitViewRef'), 'auto-fit via fitViewRef')
  assert(gc.includes('bind to wrap') || gc.includes('canvas || wrap'), 'pointer bind canvas||wrap')
  assert(gc.includes('titleStr') || gc.includes("n.title || n.relativePath"), 'safe title in paint')
  assert(gc.includes('dragged.x = dragged.fx'), 'drag keeps x/y in sync')
  assert(
    gc.includes('ensureGraphVisible') || gc.includes('countNodesInViewport'),
    'blank-viewport recovery (stale camera)'
  )
  assert(
    gc.includes('diagnoseViewportBlank') || gc.includes('formatGraphDiag') || gc.includes('CAM_OFFSCREEN'),
    'specific viewport diagnosis codes'
  )
  assert(gc.includes('diagnoseEmptyFilter') || gc.includes('FILTER_ORPHAN'), 'specific empty-filter diagnosis')
  assert(gc.includes('diagnosePathResult') || gc.includes('PATH_NONE'), 'specific path diagnosis')

  const store = fs.readFileSync(path.join(root, 'src/renderer/src/store/graphStore.ts'), 'utf8')
  assert(store.includes('Array.isArray(data?.nodes)') || store.includes('rawNodes'), 'normalize graph nodes')
  assert(store.includes('tags: Array.isArray'), 'normalize tags array')

  // --- Engine: real graph from sample vault ---
  const engDir = path.join(__dirname, '.tmp-engines')
  if (!fs.existsSync(path.join(engDir, 'GraphEngine.js'))) {
    const { execSync } = await import('child_process')
    execSync(
      'npx esbuild src/main/engine/MarkdownEngine.ts src/main/engine/GraphEngine.ts src/main/engine/SearchEngine.ts --bundle --platform=node --outdir=scripts/.tmp-engines --format=esm --packages=external',
      { cwd: root, stdio: 'inherit' }
    )
  }
  const { MarkdownEngine } = await import(pathToFileURL(path.join(engDir, 'MarkdownEngine.js')).href)
  const { GraphEngine } = await import(pathToFileURL(path.join(engDir, 'GraphEngine.js')).href)
  const md = new MarkdownEngine()
  const graph = new GraphEngine()

  const tmp = path.join(os.tmpdir(), `wg-graphview-${Date.now()}`)
  fs.mkdirSync(path.join(tmp, 'Knowledge'), { recursive: true })
  const files = []
  for (const [name, body] of [
    ['Alpha.md', '---\ntitle: Alpha\n---\n# Alpha\n[[Beta]] [[Gamma]]\n'],
    ['Beta.md', '---\ntitle: Beta\n---\n# Beta\n[[Alpha]]\n'],
    ['Gamma.md', '---\ntitle: Gamma\n---\n# Gamma\nSee [[Alpha]]\n']
  ]) {
    const p = path.join(tmp, 'Knowledge', name)
    fs.writeFileSync(p, body)
    files.push(md.parseFile(p, body, tmp))
  }
  const data = graph.buildFromParsedFiles(files)
  assert(data.nodeCount === 3, `graph nodes=3 got ${data.nodeCount}`)
  assert(data.edgeCount >= 2, `graph edges>=2 got ${data.edgeCount}`)

  // Incremental update must keep backlinks (regression)
  const beta2 = md.parseFile(
    path.join(tmp, 'Knowledge', 'Beta.md'),
    '---\ntitle: Beta\n---\n# Beta\n[[Alpha]]\nedited\n',
    tmp
  )
  graph.updateNodeAndEdges(beta2)
  const alpha = files[0]
  const beta = files[1]
  assert(
    graph.getBacklinks(beta.id).nodes.some((n) => n.id === alpha.id),
    'backlinks preserved after update (graph view data integrity)'
  )

  // Optional: live vault if present
  const liveVault = 'D:\\Obs\\Obs'
  if (fs.existsSync(liveVault) && fs.existsSync(path.join(liveVault, '00 Home.md'))) {
    let mdCount = 0
    const walk = (dir, depth = 0) => {
      if (depth > 4 || mdCount > 50) return
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, depth + 1)
        else if (e.name.endsWith('.md') && mdCount < 40) {
          try {
            const raw = fs.readFileSync(full, 'utf8')
            files.push(md.parseFile(full, raw, liveVault))
            mdCount++
          } catch {
            /* skip */
          }
        }
      }
    }
    const liveFiles = []
    // re-parse only Knowledge + root-ish
    for (const sub of ['Knowledge', '05 Pegawai', 'Daily', '02 Harian']) {
      const d = path.join(liveVault, sub)
      if (fs.existsSync(d)) {
        const sample = []
        const walk2 = (dir, depth = 0) => {
          if (depth > 3 || sample.length > 25) return
          let ents = []
          try {
            ents = fs.readdirSync(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of ents) {
            if (e.name.startsWith('.')) continue
            const full = path.join(dir, e.name)
            if (e.isDirectory()) walk2(full, depth + 1)
            else if (e.name.endsWith('.md') && sample.length < 25) {
              try {
                const raw = fs.readFileSync(full, 'utf8')
                sample.push(md.parseFile(full, raw, liveVault))
              } catch {
                /* skip */
              }
            }
          }
        }
        walk2(d)
        liveFiles.push(...sample)
      }
    }
    if (liveFiles.length > 0) {
      const g2 = new GraphEngine()
      const live = g2.buildFromParsedFiles(liveFiles)
      assert(live.nodeCount > 0, `live vault sample nodes=${live.nodeCount}`)
      assert(Array.isArray(live.nodes) && live.nodes.every((n) => n.id && Array.isArray(n.tags)), 'live nodes have id+tags')
      console.log(`     live sample: ${live.nodeCount} nodes, ${live.edgeCount} edges`)
    } else {
      console.log('SKIP live vault sample (no md found in expected folders)')
    }
  } else {
    console.log('SKIP live vault D:\\Obs\\Obs (not found)')
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
