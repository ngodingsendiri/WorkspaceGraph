/**
 * Deep Graph View data-integrity & behavior tests (engine-level).
 * Run: node scripts/qa-graph-deep.mjs
 *
 * Covers:
 *  - incremental update preserves backlinks
 *  - rename/add re-resolves edges from other notes (outLinks cache)
 *  - remove node drops ghosts + re-resolves
 *  - local depth 1–5
 *  - large synthetic graph (1000 nodes) build + local + path
 *  - prune duplicate / ghost edges
 *  - soft LOD + settings clamps
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
function ok(id, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  OK   ${id}${detail ? ' · ' + detail : ''}`)
  } else {
    fail++
    console.error(`  FAIL ${id}${detail ? ' · ' + detail : ''}`)
  }
}

async function load() {
  const outDir = path.join(root, 'scripts/.tmp-graph-deep')
  fs.mkdirSync(outDir, { recursive: true })
  const { execSync } = await import('child_process')
  execSync(
    `npx esbuild src/main/engine/GraphLayoutStore.ts src/main/engine/GraphEngine.ts src/main/engine/MarkdownEngine.ts --bundle --platform=node --outdir=scripts/.tmp-graph-deep --format=esm --packages=external`,
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

async function main() {
  console.log('\n═══ Deep Graph Engine ═══')
  const { layout, GraphEngine, MarkdownEngine } = await load()
  const md = new MarkdownEngine()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-graph-deep-'))

  // --- 1. Basic + backlink preserve ---
  writeVault(tmp, {
    'Knowledge/A.md': '---\ntitle: Alpha\n---\n# Alpha\n[[Beta]] [[Gamma]]\n',
    'Knowledge/B.md': '---\ntitle: Beta\n---\n# Beta\n[[Alpha]]\n',
    'Knowledge/C.md': '---\ntitle: Gamma\n---\n# Gamma\nSee [[Alpha]]\n'
  })
  const parseAll = () => {
    const files = []
    for (const name of ['A.md', 'B.md', 'C.md']) {
      const p = path.join(tmp, 'Knowledge', name)
      files.push(md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp))
    }
    return files
  }
  let g = new GraphEngine()
  let data = g.buildFromParsedFiles(parseAll())
  ok('build-nodes', data.nodeCount === 3, String(data.nodeCount))
  ok('build-edges', data.edgeCount >= 3, String(data.edgeCount))

  const a = g.getNodeByPath(path.join(tmp, 'Knowledge', 'A.md'))
  const b = g.getNodeByPath(path.join(tmp, 'Knowledge', 'B.md'))
  ok('has-a-b', Boolean(a && b))

  // Edit B — backlink A→B must remain
  const bPath = path.join(tmp, 'Knowledge', 'B.md')
  fs.writeFileSync(bPath, '---\ntitle: Beta\n---\n# Beta\n[[Alpha]]\nedited body\n')
  g.updateNodeAndEdges(md.parseFile(bPath, fs.readFileSync(bPath, 'utf8'), tmp))
  ok(
    'backlink-after-edit',
    g.getBacklinks(b.id).nodes.some((n) => n.id === a.id),
    'A→B preserved'
  )

  // --- 2. New note appears → previously unresolved becomes linked ---
  // D does not exist yet; add link from A to Delta
  fs.writeFileSync(
    path.join(tmp, 'Knowledge', 'A.md'),
    '---\ntitle: Alpha\n---\n# Alpha\n[[Beta]] [[Gamma]] [[Delta]]\n'
  )
  g.updateNodeAndEdges(
    md.parseFile(
      path.join(tmp, 'Knowledge', 'A.md'),
      fs.readFileSync(path.join(tmp, 'Knowledge', 'A.md'), 'utf8'),
      tmp
    )
  )
  const beforeDelta = g.getGraphData().edgeCount
  ok('unresolved-delta-no-edge', !g.resolveTitleToPath('Delta'))

  // Create Delta
  const dPath = path.join(tmp, 'Knowledge', 'D.md')
  fs.writeFileSync(dPath, '---\ntitle: Delta\n---\n# Delta\nLinked from A\n')
  g.updateNodeAndEdges(md.parseFile(dPath, fs.readFileSync(dPath, 'utf8'), tmp))
  const afterDelta = g.getGraphData()
  const deltaNode = g.getNodeByPath(dPath)
  ok('delta-node-exists', Boolean(deltaNode))
  ok(
    'a-to-delta-after-create',
    Boolean(deltaNode && g.getOutgoingLinks(a.id).nodes.some((n) => n.id === deltaNode.id)),
    `edges ${beforeDelta}→${afterDelta.edgeCount}`
  )
  // A was not re-parsed after Delta create — outLinks cache must re-resolve
  ok(
    'reresolve-without-reparsing-source',
    Boolean(deltaNode && g.getBacklinks(deltaNode.id).nodes.some((n) => n.id === a.id))
  )

  // --- 3. Remove node → no ghost edges ---
  g.removeNode(deltaNode.id)
  const afterRm = g.getGraphData()
  ok('remove-node-gone', !afterRm.nodes.some((n) => n.id === deltaNode.id))
  ok(
    'no-ghost-edges',
    afterRm.edges.every((e) => afterRm.nodes.some((n) => n.id === e.source) && afterRm.nodes.some((n) => n.id === e.target))
  )

  // --- 4. Local depth 1–5 ---
  // Rebuild richer graph
  g = new GraphEngine()
  writeVault(tmp, {
    'Knowledge/A.md': '# A\n[[B]]\n',
    'Knowledge/B.md': '# B\n[[C]] [[A]]\n',
    'Knowledge/C.md': '# C\n[[D]]\n',
    'Knowledge/D.md': '# D\n[[E]]\n',
    'Knowledge/E.md': '# E\n[[F]]\n',
    'Knowledge/F.md': '# F\n'
  })
  const chain = []
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const p = path.join(tmp, 'Knowledge', `${name}.md`)
    chain.push(md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp))
  }
  g.buildFromParsedFiles(chain)
  const center = g.getNodeByPath(path.join(tmp, 'Knowledge', 'A.md'))
  const d1 = g.getLocalGraph(center.id, 1)
  const d2 = g.getLocalGraph(center.id, 2)
  const d3 = g.getLocalGraph(center.id, 3)
  const d5 = g.getLocalGraph(center.id, 5)
  const d9 = g.getLocalGraph(center.id, 9) // clamp to 5
  ok('local-d1', d1 && d1.depth === 1 && d1.nodeCount >= 2)
  ok('local-d2-ge-d1', d2 && d1 && d2.nodeCount >= d1.nodeCount)
  ok('local-d3-ge-d2', d3 && d2 && d3.nodeCount >= d2.nodeCount)
  ok('local-d5-ge-d3', d5 && d3 && d5.nodeCount >= d3.nodeCount)
  ok('local-depth-clamp-5', d9 && d9.depth === 5)
  ok('local-includes-cross-edges', d2 && d2.edgeCount >= 1)

  // --- 5. getNeighbors wiki-only + subgraph edges ---
  const neigh = g.getNeighbors(center.id, 2)
  ok('neighbors-no-self', neigh.nodes.every((n) => n.id !== center.id))
  ok('neighbors-has-nodes', neigh.nodes.length >= 1)

  // --- 6. Path ---
  const fNode = g.getNodeByPath(path.join(tmp, 'Knowledge', 'F.md'))
  const pathAF = g.findShortestPath(center.id, fNode.id)
  ok('path-chain', pathAF && pathAF.found && pathAF.length >= 4, pathAF && String(pathAF.length))

  // --- 7. Large synthetic graph (1000 notes, sparse links) ---
  console.log('\n═══ Large graph (1000) ═══')
  const big = new GraphEngine()
  const bigTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-graph-big-'))
  const parsedBig = []
  const N = 1000
  const t0 = Date.now()
  for (let i = 0; i < N; i++) {
    const name = `N${String(i).padStart(4, '0')}`
    const links = []
    if (i > 0) links.push(`[[N${String(i - 1).padStart(4, '0')}]]`)
    if (i % 7 === 0 && i + 3 < N) links.push(`[[N${String(i + 3).padStart(4, '0')}]]`)
    if (i % 11 === 0) links.push(`[[N${String(Math.floor(i / 2)).padStart(4, '0')}]]`)
    const body = `# ${name}\n${links.join(' ')}\n`
    const p = path.join(bigTmp, 'Knowledge', `${name}.md`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
    parsedBig.push(md.parseFile(p, body, bigTmp))
  }
  const tParse = Date.now()
  const bigData = big.buildFromParsedFiles(parsedBig)
  const tBuild = Date.now()
  // realNodeCount excludes unresolved ghosts (may appear when links miss)
  ok(
    'large-nodes',
    (bigData.realNodeCount ?? bigData.nodes.filter((n) => !n.isGhost).length) === N,
    `real=${bigData.realNodeCount} total=${bigData.nodeCount}`
  )
  ok('large-edges', bigData.edgeCount > N / 2, String(bigData.edgeCount))
  ok('large-build-ms', tBuild - tParse < 5000, `${tBuild - tParse}ms (parse+write ${tParse - t0}ms)`)

  const hub = big.getHubNodes(5)
  ok('large-hubs', hub.length >= 1, String(hub.length))
  const localBig = big.getLocalGraph(hub[0]?.id || bigData.nodes.find((n) => !n.isGhost).id, 2)
  ok('large-local', localBig && localBig.nodeCount >= 2 && localBig.nodeCount < N + 5)
  const orphans = big.getOrphanNodeIds()
  ok('large-orphans-array', Array.isArray(orphans))

  // Incremental update on large graph
  const mid = parsedBig[500]
  mid.wikiLinks = [...(mid.wikiLinks || []), { target: 'N0001', display: 'N0001' }]
  const tUp0 = Date.now()
  big.updateNodeAndEdges(mid)
  const tUp1 = Date.now()
  ok('large-incremental-ms', tUp1 - tUp0 < 2000, `${tUp1 - tUp0}ms`)
  const afterBig = big.getGraphData()
  ok(
    'large-still-valid',
    (afterBig.realNodeCount ?? afterBig.nodes.filter((n) => !n.isGhost).length) === N,
    String(afterBig.realNodeCount)
  )

  // --- 8. Ghost / unresolved nodes ---
  console.log('\n═══ Ghost nodes (Existing files only) ═══')
  g = new GraphEngine()
  writeVault(tmp, {
    'Knowledge/Real.md': '# Real\n[[MissingNote]] [[AlsoMissing]]\n',
    'Knowledge/Linked.md': '# Linked\n[[Real]]\n'
  })
  const ghostParsed = []
  for (const name of ['Real.md', 'Linked.md']) {
    const p = path.join(tmp, 'Knowledge', name)
    ghostParsed.push(md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp))
  }
  const gData = g.buildFromParsedFiles(ghostParsed)
  ok('ghost-count', (gData.ghostNodeCount || 0) >= 2, String(gData.ghostNodeCount))
  ok(
    'ghost-nodes-flagged',
    gData.nodes.filter((n) => n.isGhost).length >= 2
  )
  ok(
    'ghost-edges-present',
    gData.edges.some((e) => gData.nodes.find((n) => n.id === e.target)?.isGhost)
  )
  const realOnly = g.getGraphData({ includeGhosts: false })
  ok('includeGhosts-false', realOnly.nodes.every((n) => !n.isGhost))
  ok('includeGhosts-false-count', realOnly.nodeCount === 2, String(realOnly.nodeCount))

  // Create missing → ghost becomes real, edge re-resolves
  const missPath = path.join(tmp, 'Knowledge', 'MissingNote.md')
  fs.writeFileSync(missPath, '# MissingNote\nnow exists\n')
  g.updateNodeAndEdges(md.parseFile(missPath, fs.readFileSync(missPath, 'utf8'), tmp))
  const afterMiss = g.getGraphData()
  ok(
    'ghost-promoted',
    afterMiss.nodes.some((n) => n.title === 'MissingNote' && !n.isGhost)
  )
  ok(
    'ghost-count-after-create',
    (afterMiss.ghostNodeCount || 0) < (gData.ghostNodeCount || 99),
    String(afterMiss.ghostNodeCount)
  )

  // --- 9. Settings clamps ---
  console.log('\n═══ Settings ═══')
  ok('depth-clamp-5', layout.mergeGraphSettings({ filters: { localDepth: 99 } }).filters.localDepth === 5)
  ok('depth-clamp-1', layout.mergeGraphSettings({ filters: { localDepth: 0 } }).filters.localDepth === 1)
  ok('lod-full-small', layout.resolveGraphLod(50, 'auto') === 'full')
  ok('lod-medium', layout.resolveGraphLod(200, 'auto') === 'medium')
  ok('lod-low', layout.resolveGraphLod(500, 'auto') === 'low')
  ok(
    'existing-files-default',
    layout.mergeGraphSettings(null).display.existingFilesOnly === true
  )
  ok(
    'search-mode-filter',
    layout.mergeGraphSettings({ filters: { searchMode: 'filter' } }).filters.searchMode === 'filter'
  )
  ok(
    'search-mode-bad-fallback',
    layout.mergeGraphSettings({ filters: { searchMode: 'nope' } }).filters.searchMode === 'spotlight'
  )

  // --- 10. Source contracts (renderer) ---
  console.log('\n═══ Source contracts ═══')
  const gc = fs.readFileSync(path.join(root, 'src/renderer/src/components/graph/GraphCanvas.tsx'), 'utf8')
  const shared = fs.readFileSync(path.join(root, 'src/renderer/src/components/graph/graphShared.ts'), 'utf8')
  const eng = fs.readFileSync(path.join(root, 'src/main/engine/GraphEngine.ts'), 'utf8')
  const filtersUi = fs.readFileSync(
    path.join(root, 'src/renderer/src/components/graph/GraphFiltersPanel.tsx'),
    'utf8'
  )
  ok('soft-merge', gc.includes('canSoft') || gc.includes('Soft update'))
  ok('hydrate-filters', gc.includes('filters.orphanMode') && gc.includes('filters.hubMode'))
  ok('outLinks-cache', eng.includes('outLinks') && eng.includes('rebuildWikiEdgesFromOutLinks'))
  ok('prune-ghost', eng.includes('pruneGhostEdges'))
  ok('ghost-engine', eng.includes('isGhost') && eng.includes('ensureGhostNode'))
  ok('shared-forces', shared.includes('chargeFor') && shared.includes('linkDistanceFor'))
  ok('spatial-hash', shared.includes('SpatialHash2D'))
  ok('spatial-hit', gc.includes('spatialRef') || gc.includes('SpatialHash2D'))
  ok('existing-files-ui', filtersUi.includes('Existing files only') || filtersUi.includes('existingFilesOnly'))
  ok('search-mode-ui', filtersUi.includes('searchMode') || filtersUi.includes('Spotlight'))
  ok('tags-ui', filtersUi.includes('showTags') || filtersUi.includes('Tags'))
  ok('attachments-ui', filtersUi.includes('showAttachments') || filtersUi.includes('Attachments'))
  ok('animate-ui', filtersUi.includes('animateForces') || filtersUi.includes('Animate'))
  ok('force-presets', shared.includes('FORCE_PRESETS') || gc.includes('FORCE_PRESETS'))
  ok('edge-budget', shared.includes('edgeDrawBudget'))
  ok('local-depth-5-ui', fs.readFileSync(path.join(root, 'src/renderer/src/components/graph/LocalGraphCanvas.tsx'), 'utf8').includes('1, 2, 3, 4, 5'))

  // --- Tag + attachment nodes ---
  console.log('\n═══ Tags & Attachments ═══')
  g = new GraphEngine()
  writeVault(tmp, {
    'Knowledge/T1.md': '---\ntags: [alpha, beta]\n---\n# T1\n[[T2]]\n#alpha\n',
    'Knowledge/T2.md': '---\ntags: [alpha]\n---\n# T2\n'
  })
  const tagFiles = []
  for (const name of ['T1.md', 'T2.md']) {
    const p = path.join(tmp, 'Knowledge', name)
    tagFiles.push(md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp))
  }
  // Ensure tags extracted — may come from frontmatter or body depending on parser
  const td = g.buildFromParsedFiles(tagFiles)
  ok('tag-nodes-built', (td.tagNodeCount || td.nodes.filter((n) => n.isTag).length) >= 1, String(td.tagNodeCount))
  ok(
    'tag-edges',
    td.edges.some((e) => e.type === 'tag' && e.id.startsWith('tagnode:'))
  )
  const imgPath = path.join(tmp, 'Knowledge', 'pic.png')
  fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const attachId = crypto.createHash('sha256').update(imgPath.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 24)
  g.setAttachments([
    {
      id: attachId,
      path: imgPath,
      relativePath: 'Knowledge/pic.png',
      title: 'pic.png'
    }
  ])
  // Link to attachment
  const t1p = path.join(tmp, 'Knowledge', 'T1.md')
  fs.writeFileSync(t1p, '---\ntags: [alpha]\n---\n# T1\n[[pic.png]]\n')
  g.updateNodeAndEdges(md.parseFile(t1p, fs.readFileSync(t1p, 'utf8'), tmp))
  const afterAtt = g.getGraphData()
  ok(
    'attachment-node',
    afterAtt.nodes.some((n) => n.isAttachment && n.title === 'pic.png')
  )
  ok(
    'attachment-linked',
    afterAtt.edges.some((e) => {
      const tgt = afterAtt.nodes.find((n) => n.id === e.target)
      return tgt?.isAttachment
    })
  )
  ok(
    'settings-showTags-default-off',
    layout.mergeGraphSettings(null).display.showTags === false
  )
  ok(
    'settings-animate-default-off',
    layout.mergeGraphSettings(null).display.animateForces === false
  )

  // --- Camera persist ---
  console.log('\n═══ Camera ═══')
  const camTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cam-'))
  fs.mkdirSync(path.join(camTmp, '.workspacegraph'), { recursive: true })
  const camSave = layout.saveGraphLayout(camTmp, {
    nodes: { a: { x: 1, y: 2 } },
    camera: { x: 10, y: 20, k: 1.5 }
  })
  ok('camera-save-ok', camSave.ok)
  const camLoad = layout.loadGraphLayout(camTmp)
  ok('camera-load-k', camLoad.camera && Math.abs(camLoad.camera.k - 1.5) < 0.001)
  ok('camera-load-xy', camLoad.camera && camLoad.camera.x === 10 && camLoad.camera.y === 20)
  const camOnly = layout.saveGraphLayout(
    camTmp,
    { camera: { x: 3, y: 4, k: 0.8 } },
    { cameraOnly: true }
  )
  ok('camera-only-ok', camOnly.ok)
  const camLoad2 = layout.loadGraphLayout(camTmp)
  ok('camera-only-keeps-nodes', camLoad2.nodes.a && camLoad2.nodes.a.x === 1)
  ok('camera-only-updates', camLoad2.camera && Math.abs(camLoad2.camera.k - 0.8) < 0.001)
  ok('camera-normalize-reject', layout.normalizeCamera({ x: 1, y: 2, k: 99 }) === null)
  ok('camera-normalize-ok', layout.normalizeCamera({ x: 1, y: 2, k: 1.2 })?.k === 1.2)
  // via upsert view
  const vCam = layout.upsertGraphView(camTmp, {
    name: 'CamView',
    snapshot: { orphanMode: 'all', camera: { x: 5, y: 6, k: 2 } }
  })
  ok('view-camera-saved', vCam.ok && vCam.view?.snapshot?.camera?.k === 2)
  ok('gc-camera-restore', gc.includes('layoutCamera') || gc.includes('saveGraphCamera'))
  ok('gc-schedule-camera', gc.includes('scheduleSaveCamera') || gc.includes('saveGraphCamera'))
  ok('gc-arrow-pan', gc.includes('ArrowLeft') && gc.includes('ArrowRight'))
  ok('gc-zoom-keys', gc.includes("e.key === '='") || gc.includes('zoomBy(1.2)'))
  ok('gc-open-intent', gc.includes('consumeOpenIntent') || gc.includes('openIntent'))
  const dash = fs.readFileSync(
    path.join(root, 'src/renderer/src/components/dashboard/DashboardView.tsx'),
    'utf8'
  )
  ok('dash-orphan-graph', dash.includes('orphanMode') && dash.includes("setActiveView('graph')"))
  ok('dash-orphan-list', dash.includes('Orphan notes') || dash.includes('orphanNodes'))
  const storeSrc = fs.readFileSync(path.join(root, 'src/renderer/src/store/graphStore.ts'), 'utf8')
  ok('store-open-intent', storeSrc.includes('GraphOpenIntent') && storeSrc.includes('setOpenIntent'))
  const localUi = fs.readFileSync(
    path.join(root, 'src/renderer/src/components/graph/LocalGraphCanvas.tsx'),
    'utf8'
  )
  const editorUi = fs.readFileSync(
    path.join(root, 'src/renderer/src/components/editor/MarkdownEditor.tsx'),
    'utf8'
  )
  ok('local-soft-hover', localUi.includes('hoverStrengthRef') || localUi.includes('kickHoverAnim'))
  ok('local-include-tags', localUi.includes('includeTags'))
  ok('local-graph-updated', localUi.includes('onGraphUpdated'))
  ok('local-open-global-intent', localUi.includes('setOpenIntent'))
  ok('editor-has-local', editorUi.includes('LocalGraphView'))

  // --- Adversarial fixes (re-audit pass) ---
  console.log('\n═══ Adversarial re-audit ═══')
  // Attachment upsert / remove lightweight API
  g = new GraphEngine()
  writeVault(tmp, { 'Knowledge/X.md': '# X\n[[pic2.png]]\n' })
  const xp = path.join(tmp, 'Knowledge', 'X.md')
  g.buildFromParsedFiles([md.parseFile(xp, fs.readFileSync(xp, 'utf8'), tmp)])
  const pic2 = path.join(tmp, 'Knowledge', 'pic2.png')
  fs.writeFileSync(pic2, Buffer.from([1, 2, 3]))
  const pid = crypto.createHash('sha256').update(pic2.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 24)
  g.upsertAttachment({ id: pid, path: pic2, relativePath: 'Knowledge/pic2.png', title: 'pic2.png' })
  ok('upsert-attachment', g.getGraphData().nodes.some((n) => n.isAttachment && n.id === pid))
  ok(
    'upsert-resolves-wiki',
    g.getGraphData().edges.some((e) => e.target === pid)
  )
  g.removeAttachment(pid)
  ok(
    'remove-attachment-gone',
    !g.getGraphData().nodes.some((n) => n.id === pid)
  )
  ok(
    'remove-attachment-no-ghost-edge',
    !g.getGraphData().edges.some((e) => e.source === pid || e.target === pid)
  )
  // resolveTitleToPath must not return ghost paths
  g = new GraphEngine()
  writeVault(tmp, { 'Knowledge/Y.md': '# Y\n[[MissingZ]]\n' })
  const yp = path.join(tmp, 'Knowledge', 'Y.md')
  g.buildFromParsedFiles([md.parseFile(yp, fs.readFileSync(yp, 'utf8'), tmp)])
  ok('resolve-missing-null', g.resolveTitleToPath('MissingZ') === null)
  // openExternal IPC wired
  const ipcSrc = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8')
  const preSrc = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
  ok('ipc-open-external', ipcSrc.includes('file:openExternal') && ipcSrc.includes('shell.openPath'))
  ok('preload-open-external', preSrc.includes('openFileExternal'))
  ok('gc-hydrate-once', gc.includes('Hydrate filter/display/forces ONCE') || gc.includes('settingsHydratedRef'))
  ok('gc-edge-priority', gc.includes('edgePriority') || gc.includes('edgesToDraw'))
  ok('gc-pending-intent', gc.includes('pendingIntentRef'))
  ok('engine-upsert-attach', eng.includes('upsertAttachment') && eng.includes('removeAttachment'))
  try {
    fs.rmSync(camTmp, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  // cleanup
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(bigTmp, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  console.log(`\n═══ DEEP SUMMARY: ${pass} PASS · ${fail} FAIL ═══`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
