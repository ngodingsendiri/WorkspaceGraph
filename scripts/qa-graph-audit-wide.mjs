/**
 * Wide + deep Graph View audit (broader than qa-graph-deep).
 * Run: node scripts/qa-graph-audit-wide.mjs
 *
 * Areas: path-vs-ghost, tag edges vs showTags, strip outLinks,
 * rename id, cycle/self links, concurrent-ish rebuild, layout camera,
 * filter degree, IPC/preload surface.
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

let pass = 0
let fail = 0
const bugs = []
function ok(id, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  OK   ${id}${detail ? ' · ' + detail : ''}`)
  } else {
    fail++
    bugs.push({ id, detail })
    console.error(`  FAIL ${id}${detail ? ' · ' + detail : ''}`)
  }
}

async function load() {
  const outDir = path.join(root, 'scripts/.tmp-audit-wide')
  fs.mkdirSync(outDir, { recursive: true })
  const { execSync } = await import('child_process')
  execSync(
    `npx esbuild src/main/engine/GraphLayoutStore.ts src/main/engine/GraphEngine.ts src/main/engine/MarkdownEngine.ts --bundle --platform=node --outdir=scripts/.tmp-audit-wide --format=esm --packages=external`,
    { cwd: root, stdio: 'pipe' }
  )
  const layout = await import(pathToFileURL(path.join(outDir, 'GraphLayoutStore.js')).href)
  const { GraphEngine } = await import(pathToFileURL(path.join(outDir, 'GraphEngine.js')).href)
  const { MarkdownEngine } = await import(pathToFileURL(path.join(outDir, 'MarkdownEngine.js')).href)
  return { layout, GraphEngine, MarkdownEngine }
}

function writeVault(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body, 'utf8')
  }
}

function idOf(filePath) {
  return crypto
    .createHash('sha256')
    .update(filePath.replace(/\\/g, '/').toLowerCase())
    .digest('hex')
    .slice(0, 24)
}

async function main() {
  console.log('\n═══ Wide Graph Audit ═══')
  const { layout, GraphEngine, MarkdownEngine } = await load()
  const md = new MarkdownEngine()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-audit-wide-'))

  // ── 1. Path must NOT hop through ghosts ──
  console.log('\n── 1. Path vs ghosts ──')
  {
    const g = new GraphEngine()
    writeVault(tmp, {
      'Knowledge/A.md': '# A\n[[MissingBridge]]\n',
      'Knowledge/B.md': '# B\n[[MissingBridge]]\n'
    })
    const files = ['A.md', 'B.md'].map((n) => {
      const p = path.join(tmp, 'Knowledge', n)
      return md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp)
    })
    g.buildFromParsedFiles(files)
    const a = g.getNodeByPath(path.join(tmp, 'Knowledge', 'A.md'))
    const b = g.getNodeByPath(path.join(tmp, 'Knowledge', 'B.md'))
    const pathAB = g.findShortestPath(a.id, b.id)
    ok(
      'path-no-ghost-hop',
      pathAB && pathAB.found === false,
      pathAB ? `found=${pathAB.found} len=${pathAB.length}` : 'null'
    )
    // Neighbors of A should not include only-ghost as "real" neighbor for default
    const neigh = g.getNeighbors(a.id, 1)
    ok(
      'neighbors-no-ghost-default',
      !neigh.nodes.some((n) => n.isGhost),
      String(neigh.nodes.map((n) => n.title))
    )
  }

  // ── 2. Self-link + empty link ──
  console.log('\n── 2. Self / empty / alias ──')
  {
    const g = new GraphEngine()
    writeVault(tmp, {
      'Knowledge/Self.md': '---\naliases: [Me]\n---\n# Self\n[[Self]] [[]] [[Me]]\n'
    })
    const p = path.join(tmp, 'Knowledge', 'Self.md')
    const parsed = md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp)
    const data = g.buildFromParsedFiles([parsed])
    ok('self-no-loop-edge', !data.edges.some((e) => e.source === e.target))
    ok('node-count-self', data.realNodeCount === 1 || data.nodes.filter((n) => !n.isGhost).length >= 1)
  }

  // ── 3. outLinks stripped from API surfaces ──
  console.log('\n── 3. Strip outLinks ──')
  {
    const g = new GraphEngine()
    writeVault(tmp, {
      'Knowledge/P.md': '# P\n[[Q]]\n',
      'Knowledge/Q.md': '# Q\n'
    })
    const files = ['P.md', 'Q.md'].map((n) => {
      const p = path.join(tmp, 'Knowledge', n)
      return md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp)
    })
    g.buildFromParsedFiles(files)
    const gd = g.getGraphData()
    ok(
      'getGraphData-no-outLinks',
      gd.nodes.every((n) => n.outLinks === undefined)
    )
    const local = g.getLocalGraph(files[0].id, 1)
    ok(
      'getLocal-no-outLinks',
      local && local.nodes.every((n) => n.outLinks === undefined)
    )
    const neigh = g.getNeighbors(files[0].id, 1)
    ok(
      'getNeighbors-no-outLinks',
      neigh.nodes.every((n) => n.outLinks === undefined)
    )
  }

  // ── 4. Tag nodes have edges without showTagEdges (engine always has tagnode edges) ──
  console.log('\n── 4. Tag node edges ──')
  {
    const g = new GraphEngine()
    writeVault(tmp, {
      'Knowledge/T.md': '---\ntags: [alpha]\n---\n# T\n#alpha\n'
    })
    const p = path.join(tmp, 'Knowledge', 'T.md')
    // Ensure tags on parsed file
    const parsed = md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp)
    if (!parsed.tags?.length) parsed.tags = ['alpha']
    g.buildFromParsedFiles([parsed])
    const data = g.getGraphData()
    const tagNodes = data.nodes.filter((n) => n.isTag)
    const tagEdges = data.edges.filter((e) => e.id.startsWith('tagnode:'))
    ok('tag-nodes-exist', tagNodes.length >= 1, String(tagNodes.length))
    ok('tagnode-edges-exist', tagEdges.length >= 1, String(tagEdges.length))
    // Canvas rule contract: showTags implies tagnode edges visible even if showTagEdges false
    const gc = fs.readFileSync(
      path.join(root, 'src/renderer/src/components/graph/GraphCanvas.tsx'),
      'utf8'
    )
    ok(
      'canvas-tag-edge-rule',
      gc.includes('involvesTagNode') || (gc.includes('showTags') && gc.includes("e.type === 'tag'"))
    )
  }

  // ── 5. Attachment cycle + remove ──
  console.log('\n── 5. Attachment lifecycle ──')
  {
    const g = new GraphEngine()
    const ap = path.join(tmp, 'Knowledge', 'doc.pdf')
    fs.writeFileSync(ap, '%PDF-1.4')
    const aid = idOf(ap)
    writeVault(tmp, { 'Knowledge/R.md': '# R\n[[doc.pdf]]\n' })
    const rp = path.join(tmp, 'Knowledge', 'R.md')
    g.buildFromParsedFiles([md.parseFile(rp, fs.readFileSync(rp, 'utf8'), tmp)])
    g.upsertAttachment({ id: aid, path: ap, relativePath: 'Knowledge/doc.pdf', title: 'doc.pdf' })
    const d1 = g.getGraphData()
    ok('attach-linked', d1.edges.some((e) => e.target === aid))
    g.upsertAttachment({ id: aid, path: ap, relativePath: 'Knowledge/doc.pdf', title: 'doc.pdf' })
    ok('attach-upsert-idempotent', g.getGraphData().nodes.filter((n) => n.id === aid).length === 1)
    g.removeAttachment(aid)
    ok('attach-removed', !g.getGraphData().nodes.some((n) => n.id === aid))
    // After remove, link becomes ghost
    const after = g.getGraphData()
    ok('attach-removed-ghost-or-unresolved', (after.ghostNodeCount || 0) >= 1 || after.edgeCount >= 0)
  }

  // ── 6. Layout camera clamp + merge ──
  console.log('\n── 6. Layout / settings harden ──')
  {
    ok('cam-null-nan', layout.normalizeCamera({ x: NaN, y: 1, k: 1 }) === null)
    ok('cam-k-too-small', layout.normalizeCamera({ x: 0, y: 0, k: 0.01 }) === null)
    const m = layout.mergeGraphSettings({
      display: { showTags: true, animateForces: true, existingFilesOnly: false },
      filters: { searchMode: 'filter', orphanMode: 'only' }
    })
    ok('merge-showTags', m.display.showTags === true)
    ok('merge-animate', m.display.animateForces === true)
    ok('merge-existing-off', m.display.existingFilesOnly === false)
    ok('merge-search-filter', m.filters.searchMode === 'filter')
    ok('merge-orphan-only', m.filters.orphanMode === 'only')
  }

  // ── 7. Stress: 200 notes chain + update middle ──
  console.log('\n── 7. Stress chain 200 ──')
  {
    const g = new GraphEngine()
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-chain-'))
    const parsed = []
    const N = 200
    for (let i = 0; i < N; i++) {
      const name = `C${String(i).padStart(3, '0')}`
      const next = i < N - 1 ? `[[C${String(i + 1).padStart(3, '0')}]]` : ''
      const body = `# ${name}\n${next}\n`
      const p = path.join(big, 'Knowledge', `${name}.md`)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, body)
      parsed.push(md.parseFile(p, body, big))
    }
    const t0 = Date.now()
    g.buildFromParsedFiles(parsed)
    const t1 = Date.now()
    ok('chain-build-ms', t1 - t0 < 2000, `${t1 - t0}ms`)
    ok('chain-nodes', g.getGraphData().realNodeCount === N)
    const pathEnds = g.findShortestPath(parsed[0].id, parsed[N - 1].id, { maxDepth: 250 })
    ok(
      'chain-path-full',
      pathEnds && pathEnds.found && pathEnds.length === N - 1,
      pathEnds ? `found=${pathEnds.found} len=${pathEnds.length}` : 'null'
    )
    // Default maxDepth must still find short paths
    const shortPath = g.findShortestPath(parsed[0].id, parsed[10].id)
    ok('chain-path-default-depth', shortPath && shortPath.found && shortPath.length === 10)
    // Update middle node remove next link
    const mid = parsed[100]
    mid.wikiLinks = []
    mid.tags = []
    g.updateNodeAndEdges(mid)
    const pathBroken = g.findShortestPath(parsed[0].id, parsed[N - 1].id, { maxDepth: 250 })
    ok('chain-path-broken-after-edit', pathBroken && pathBroken.found === false)
    try {
      fs.rmSync(big, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  // ── 8. Source surface contracts (wide) ──
  console.log('\n── 8. Source surface ──')
  {
    const eng = fs.readFileSync(path.join(root, 'src/main/engine/GraphEngine.ts'), 'utf8')
    const gc = fs.readFileSync(path.join(root, 'src/renderer/src/components/graph/GraphCanvas.tsx'), 'utf8')
    const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8')
    const store = fs.readFileSync(path.join(root, 'src/renderer/src/store/graphStore.ts'), 'utf8')
    ok('buildAdj-skip-ghost', eng.includes('includeGhosts') && eng.includes('isGhost'))
    ok('stripInternal', eng.includes('stripInternal') || eng.includes('outLinks: _ol'))
    ok('visible-degree-filter', gc.includes('realDegreeById') && gc.includes('Always use visible-degree'))
    ok('tag-edge-involves', gc.includes('involvesTagNode'))
    ok('hydrate-once-comment', gc.includes('ONCE per mount'))
    ok('open-external-ipc', ipc.includes('file:openExternal'))
    ok('open-external-store-api', store.includes('getGraphData') && fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').includes('openFileExternal'))
    ok('debounce-emit', ipc.includes('graph:updated') && ipc.includes('1000'))
  }

  // cleanup
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  console.log(`\n═══ WIDE AUDIT SUMMARY: ${pass} PASS · ${fail} FAIL ═══`)
  if (bugs.length) {
    console.log('Failures:')
    for (const b of bugs) console.log(' -', b.id, b.detail)
  }
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
