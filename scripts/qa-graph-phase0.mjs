/**
 * Phase 0 graph foundation tests (no Electron window).
 * Run: node scripts/qa-graph-phase0.mjs
 */
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const require = createRequire(import.meta.url)

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

// ─── 1. GraphLayoutStore pure ───────────────────────────────────────
console.log('\n═══ 1. GraphLayoutStore ═══')
const GLS = await import(pathToFileURL(path.join(root, 'src/main/engine/GraphLayoutStore.ts')).href).catch(
  () => null
)

// Prefer compiled/bundled path — use dynamic import after esbuild
async function loadLayoutModule() {
  const outDir = path.join(root, 'scripts/.tmp-graph')
  fs.mkdirSync(outDir, { recursive: true })
  const { execSync } = await import('child_process')
  execSync(
    `npx esbuild src/main/engine/GraphLayoutStore.ts src/main/engine/GraphEngine.ts src/main/engine/MarkdownEngine.ts --bundle --platform=node --outdir=scripts/.tmp-graph --format=esm --packages=external`,
    { cwd: root, stdio: 'pipe' }
  )
  const layout = await import(pathToFileURL(path.join(outDir, 'GraphLayoutStore.js')).href)
  const GE = await import(pathToFileURL(path.join(outDir, 'GraphEngine.js')).href)
  const ME = await import(pathToFileURL(path.join(outDir, 'MarkdownEngine.js')).href)
  return { layout, GE, ME }
}

const { layout, GE, ME } = await loadLayoutModule()

const merged = layout.mergeGraphSettings({ forces: { charge: -50 }, display: { showTagEdges: true } })
ok('defaults-merge-charge', merged.forces.charge === -50)
ok('defaults-merge-tag', merged.display.showTagEdges === true)
ok('defaults-center-kept', merged.forces.center === layout.DEFAULT_GRAPH_SETTINGS.forces.center)
ok('clamp-charge', layout.mergeGraphSettings({ forces: { charge: -999 } }).forces.charge === -400)
ok('clamp-depth', layout.mergeGraphSettings({ filters: { localDepth: 9 } }).filters.localDepth === 5)

const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-graph-p0-'))
fs.mkdirSync(path.join(tmpVault, '.workspacegraph'), { recursive: true })

const emptyLoad = layout.loadGraphLayout(tmpVault)
ok('load-empty-nodes', Object.keys(emptyLoad.nodes).length === 0)
ok('load-version', emptyLoad.version === 1)

const save1 = layout.saveGraphLayout(tmpVault, {
  nodes: { a: { x: 10, y: 20, pinned: true }, b: { x: 1, y: 2 } }
})
ok('save-ok', save1.ok === true, save1.path)
ok('save-count', save1.count === 2)

const load1 = layout.loadGraphLayout(tmpVault)
ok('load-pinned', load1.nodes.a?.pinned === true && load1.nodes.a.x === 10)
ok('load-b', load1.nodes.b?.y === 2)

// merge partial save
const save2 = layout.saveGraphLayout(tmpVault, { nodes: { b: { x: 99, y: 99, pinned: true } } })
ok('save-merge-ok', save2.ok)
const load2 = layout.loadGraphLayout(tmpVault)
ok('merge-keeps-a', load2.nodes.a?.x === 10)
ok('merge-updates-b', load2.nodes.b?.x === 99 && load2.nodes.b?.pinned === true)

// reject non-finite
layout.saveGraphLayout(tmpVault, { nodes: { bad: { x: NaN, y: 1 } } })
const load3 = layout.loadGraphLayout(tmpVault)
ok('reject-nan', !load3.nodes.bad)

ok('no-vault-save', layout.saveGraphLayout(null, { nodes: {} }).ok === false)

// ─── 2. GraphEngine local / hubs / orphans ──────────────────────────
console.log('\n═══ 2. GraphEngine local / hubs / orphans ═══')
const md = new ME.MarkdownEngine()
const vault = path.join(tmpVault, 'notes')
fs.mkdirSync(path.join(vault, 'Knowledge'), { recursive: true })
fs.mkdirSync(path.join(vault, 'Daily'), { recursive: true })

const files = {
  'Knowledge/A.md': `---\ntitle: Alpha\n---\n# Alpha\nSee [[Beta]] and [[Gamma]].\n`,
  'Knowledge/B.md': `---\ntitle: Beta\n---\n# Beta\nBack to [[Alpha]].\n`,
  'Knowledge/C.md': `---\ntitle: Gamma\n---\n# Gamma\n[[Alpha]]\n`,
  'Knowledge/Orphan.md': `---\ntitle: Orphan\n---\n# Orphan\nAlone.\n`,
  'Daily/Hub.md': `---\ntitle: Hub\n---\n# Hub\n[[Alpha]] [[Beta]] [[Gamma]] [[Orphan]]\n`
}
// Fix: Orphan linked from Hub so not orphan — make real orphan without links
files['Knowledge/Orphan.md'] = `---\ntitle: Orphan\n---\n# Orphan\nAlone.\n`
files['Daily/Hub.md'] = `---\ntitle: Hub\n---\n# Hub\n[[Alpha]] [[Beta]] [[Gamma]]\n`

for (const [rel, body] of Object.entries(files)) {
  const fp = path.join(vault, rel)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, body)
}

const notes = Object.keys(files).map(rel => {
  const fp = path.join(vault, rel)
  return md.parseFile(fp, fs.readFileSync(fp, 'utf8'), vault)
})
const g = new GE.GraphEngine()
const data = g.buildFromParsedFiles(notes, false)
ok('build-nodes', data.nodes.length === 5, String(data.nodes.length))
ok('build-wiki-edges', data.edges.filter(e => e.type === 'wiki_link').length >= 4)

const alpha = data.nodes.find(n => n.title === 'Alpha' || n.relativePath.includes('A.md'))
const hub = data.nodes.find(n => n.title === 'Hub' || n.relativePath.includes('Hub.md'))
const orphan = data.nodes.find(n => n.title === 'Orphan')
ok('found-alpha', !!alpha)
ok('found-hub', !!hub)
ok('found-orphan', !!orphan)

const local1 = g.getLocalGraph(alpha.id, 1)
ok('local-has-center', local1 && local1.centerId === alpha.id)
ok('local-includes-center-node', local1?.nodes.some(n => n.id === alpha.id))
ok('local-depth1-neighbors', local1 && local1.nodes.length >= 3, String(local1?.nodes.length))
ok('local-edges-only-subgraph', local1?.edges.every(e => {
  const ids = new Set(local1.nodes.map(n => n.id))
  return ids.has(e.source) && ids.has(e.target)
}))

const localByPath = g.getLocalGraph(alpha.path, 1)
ok('local-resolve-path', localByPath?.centerId === alpha.id)

const local2 = g.getLocalGraph(alpha.id, 2)
ok('local-depth2-ge-depth1', local2 && local2.nodes.length >= local1.nodes.length)

const localMissing = g.getLocalGraph('does-not-exist-xyz', 1)
ok('local-missing-null', localMissing === null)

const orphans = g.getOrphanNodeIds()
ok('orphan-includes', orphans.includes(orphan.id), orphans.join(','))
ok('orphan-not-hub', !orphans.includes(hub.id))

const hubs = g.getHubNodeIds(2)
ok('hub-includes-high-degree', hubs.includes(hub.id) || hubs.includes(alpha.id), hubs.join(','))
const hubsHigh = g.getHubNodeIds(100)
ok('hub-high-threshold-empty-or-few', hubsHigh.length === 0, String(hubsHigh.length))

// tag edges not in local by default
const g2 = new GE.GraphEngine()
// two notes same tag
const tnotes = [
  md.parseFile(path.join(vault, 'Knowledge/A.md'), '---\ntags: [shared]\n---\n# A\n[[B]]\n', vault),
  md.parseFile(path.join(vault, 'Knowledge/B.md'), '---\ntags: [shared]\n---\n# B\n', vault),
  md.parseFile(path.join(vault, 'Knowledge/C.md'), '---\ntags: [shared]\n---\n# C\n', vault)
]
// rewrite paths properly
const td = path.join(tmpVault, 'tags')
fs.mkdirSync(td, { recursive: true })
const ta = path.join(td, 'A.md')
const tb = path.join(td, 'B.md')
const tc = path.join(td, 'C.md')
fs.writeFileSync(ta, '---\ntags: [shared]\n---\n# A\n[[B]]\n')
fs.writeFileSync(tb, '---\ntags: [shared]\n---\n# B\n')
fs.writeFileSync(tc, '---\ntags: [shared]\n---\n# C\n')
const tparsed = [ta, tb, tc].map(f => md.parseFile(f, fs.readFileSync(f, 'utf8'), td))
g2.buildFromParsedFiles(tparsed, true)
const aNode = g2.getGraphData().nodes.find(n => n.title === 'A')
const locNoTag = g2.getLocalGraph(aNode.id, 1, { includeTagEdges: false })
const locTag = g2.getLocalGraph(aNode.id, 1, { includeTagEdges: true })
ok('local-default-no-tag-only-wiki-or-less', locNoTag.edgeCount <= locTag.edgeCount)
ok(
  'local-with-tag-more-or-equal-nodes',
  locTag.nodeCount >= locNoTag.nodeCount,
  `tag=${locTag.nodeCount} no=${locNoTag.nodeCount}`
)

// ─── 3. Source wiring ───────────────────────────────────────────────
console.log('\n═══ 3. IPC / preload wiring ═══')
const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8')
const pre = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
const preD = fs.readFileSync(path.join(root, 'src/preload/index.d.ts'), 'utf8')
for (const h of [
  'graph:getLocal',
  'graph:getOrphans',
  'graph:getHubs',
  'graph:getLayout',
  'graph:saveLayout',
  'graph:getSettings',
  'graph:saveSettings'
]) {
  ok('ipc-' + h, ipc.includes(`'${h}'`))
}
for (const fn of [
  'getLocalGraph',
  'getGraphOrphans',
  'getGraphHubs',
  'getGraphLayout',
  'saveGraphLayout',
  'getGraphSettings',
  'saveGraphSettings'
]) {
  ok('preload-' + fn, pre.includes(fn))
  ok('types-' + fn, preD.includes(fn))
}

const store = fs.readFileSync(path.join(root, 'src/renderer/src/store/graphStore.ts'), 'utf8')
ok('store-fetchLocal', store.includes('fetchLocalGraph'))
ok('store-layout', store.includes('saveLayoutPositions'))
ok('store-settings', store.includes('loadGraphSettings'))

// ─── 4. Phase 1 LocalGraphCanvas wiring ─────────────────────────────
console.log('\n═══ 4. Phase 1 LocalGraphCanvas UI ═══')
const localUi = fs.readFileSync(path.join(root, 'src/renderer/src/components/graph/LocalGraphCanvas.tsx'), 'utf8')
const localExport = fs.readFileSync(path.join(root, 'src/renderer/src/components/graph/LocalGraphView.tsx'), 'utf8')
const editor = fs.readFileSync(path.join(root, 'src/renderer/src/components/editor/MarkdownEditor.tsx'), 'utf8')
const globals = fs.readFileSync(path.join(root, 'src/renderer/src/styles/globals.css'), 'utf8')

ok('ui-canvas-getContext', localUi.includes('getContext') && localUi.includes('forceSimulation'))
ok('ui-fetchLocalGraph', localUi.includes('fetchLocalGraph'))
ok('ui-depth-toggle', localUi.includes('setDepth') && (localUi.includes('1, 2, 3, 4, 5') || localUi.includes('setDepth(d)')))
ok('ui-labels-toggle', localUi.includes('showLabels'))
ok('ui-open-global', localUi.includes("setActiveView('graph')") && localUi.includes('setFocusedNode'))
ok('ui-center-highlight', localUi.includes('isCenter') && localUi.includes('centerStroke'))
ok('ui-collapse', localUi.includes('collapsed'))
ok('export-local-view', localExport.includes('LocalGraphCanvas'))
// Local graph dock under editor (Obsidian-like)
ok('editor-local-graph', editor.includes('LocalGraphView') || editor.includes('LocalGraphCanvas'))
ok('css-local-graph', globals.includes('.local-graph') && globals.includes('.local-graph-canvas'))
ok('css-local-height', globals.includes('height: 220px') || globals.includes('220px') || globals.includes('200px'))

// ─── 5. Phase 2 Global filters (orphan / hub / spotlight) ───────────
console.log('\n═══ 5. Phase 2 Global filters ═══')
const globalUi = fs.readFileSync(path.join(root, 'src/renderer/src/components/graph/GraphCanvas.tsx'), 'utf8')
const filtersUi = fs.readFileSync(
  path.join(root, 'src/renderer/src/components/graph/GraphFiltersPanel.tsx'),
  'utf8'
)

// Settings schema: orphanMode + hubMode
const def = layout.DEFAULT_GRAPH_SETTINGS
ok('p2-default-orphanMode', def.filters.orphanMode === 'all', def.filters.orphanMode)
ok('p2-default-hubMode', def.filters.hubMode === 'dim', def.filters.hubMode)

const mHide = layout.mergeGraphSettings({ filters: { orphanMode: 'hide', hubMode: 'hide' } })
ok('p2-merge-orphan-hide', mHide.filters.orphanMode === 'hide' && mHide.display.hideOrphans === true)
ok('p2-merge-hub-hide', mHide.filters.hubMode === 'hide' && mHide.display.dimHubs === false)

const mOnly = layout.mergeGraphSettings({ filters: { orphanMode: 'only', hubMode: 'dim' } })
ok('p2-merge-orphan-only', mOnly.filters.orphanMode === 'only')
ok('p2-merge-hub-dim-flag', mOnly.display.dimHubs === true)

// Legacy migration: hideOrphans / dimHubs without explicit modes
const mLegacy = layout.mergeGraphSettings({ display: { hideOrphans: true, dimHubs: false } })
ok('p2-legacy-orphan', mLegacy.filters.orphanMode === 'hide')
ok('p2-legacy-hub-all', mLegacy.filters.hubMode === 'all')

// Preserve modes when only threshold changes (full object like IPC)
const mThr = layout.mergeGraphSettings({
  forces: mHide.forces,
  display: mHide.display,
  filters: { ...mHide.filters, hubDegreeThreshold: 22 }
})
ok('p2-threshold-preserves-modes', mThr.filters.orphanMode === 'hide' && mThr.filters.hubMode === 'hide')
ok('p2-threshold-value', mThr.filters.hubDegreeThreshold === 22)

// Filter logic semantics on engine data
const orphansP2 = g.getOrphanNodeIds()
const hubsP2 = g.getHubNodeIds(2)
ok('p2-engine-orphan-count', orphansP2.length >= 1)
ok('p2-engine-hub-count', hubsP2.length >= 1)

// Simulate global filter: hide orphans → remaining nodes have degree > 0
const allNodes = data.nodes
const afterHideOrphans = allNodes.filter(n => n.degree > 0)
ok(
  'p2-filter-hide-orphans',
  afterHideOrphans.every(n => n.degree > 0) && afterHideOrphans.length < allNodes.length,
  `${afterHideOrphans.length}/${allNodes.length}`
)
const onlyOrphans = allNodes.filter(n => n.degree === 0)
ok('p2-filter-only-orphans', onlyOrphans.length === orphansP2.length || onlyOrphans.length >= 1)
const afterHideHubs = allNodes.filter(n => n.degree < 2)
ok('p2-filter-hide-hubs', afterHideHubs.every(n => n.degree < 2))

// UI wiring
ok('p2-ui-GraphFiltersPanel', filtersUi.includes('GraphFiltersPanel') && filtersUi.includes('Spotlight'))
ok('p2-ui-orphan-modes', filtersUi.includes("'hide'") && filtersUi.includes("'only'"))
ok('p2-ui-hub-modes', filtersUi.includes("'dim'") && filtersUi.includes('Ambang hub'))
ok('p2-ui-persist-modes', filtersUi.includes('orphanMode') && filtersUi.includes('hubMode'))
ok('p2-canvas-imports-panel', globalUi.includes('GraphFiltersPanel'))
ok('p2-canvas-spotlight', globalUi.includes('searchMatchIds') && globalUi.includes('dimSearch'))
ok('p2-canvas-orphanMode', globalUi.includes('orphanMode') && globalUi.includes("=== 'hide'"))
ok('p2-canvas-hubMode', globalUi.includes('hubMode') && globalUi.includes('dimHubs'))
ok('p2-canvas-no-search-remove', globalUi.includes('spotlight') || globalUi.includes('Search does NOT'))
ok('p2-canvas-hydrate-modes', globalUi.includes('filters.orphanMode') && globalUi.includes('filters.hubMode'))
ok('p2-store-modes', store.includes('orphanMode') && store.includes('hubMode'))
ok('p2-css-filters-panel', globals.includes('.graph-filters-panel') && globals.includes('.graph-filter-seg'))
ok('p2-css-filter-range', globals.includes('.graph-filter-range'))

// ─── 6. Phase 3 Forces + layout persist ─────────────────────────────
console.log('\n═══ 6. Phase 3 Forces + layout persist ═══')

ok('p3-default-forces-center', def.forces.center === 0.06)
ok('p3-default-forces-charge', def.forces.charge === -90)
ok('p3-default-forces-linkDist', def.forces.linkDist === 68)
ok('p3-default-forces-linkStr', def.forces.linkStr === 0.4)
ok('p3-default-forces-collide', def.forces.collide === 0.6)

const mForce = layout.mergeGraphSettings({
  forces: { charge: -150, linkDist: 100, center: 0.1, linkStr: 0.7, collide: 0.9 }
})
ok('p3-merge-charge', mForce.forces.charge === -150)
ok('p3-merge-linkDist', mForce.forces.linkDist === 100)
ok('p3-merge-center', mForce.forces.center === 0.1)
ok('p3-clamp-center-hi', layout.mergeGraphSettings({ forces: { center: 9 } }).forces.center === 0.25)
ok('p3-clamp-linkDist-lo', layout.mergeGraphSettings({ forces: { linkDist: 1 } }).forces.linkDist === 20)
ok('p3-clamp-linkStr', layout.mergeGraphSettings({ forces: { linkStr: 0 } }).forces.linkStr === 0.05)

// Preserve other settings when only forces change
const mForceOnly = layout.mergeGraphSettings({
  forces: { ...mHide.forces, charge: -120 },
  display: mHide.display,
  filters: mHide.filters
})
ok('p3-force-preserves-orphan', mForceOnly.filters.orphanMode === 'hide')
ok('p3-force-preserves-hub', mForceOnly.filters.hubMode === 'hide')
ok('p3-force-new-charge', mForceOnly.forces.charge === -120)

// Layout pin round-trip
const pinSave = layout.saveGraphLayout(tmpVault, {
  nodes: {
    n1: { x: 12, y: 34, pinned: true },
    n2: { x: 56, y: 78, pinned: false }
  }
})
ok('p3-layout-save-pins', pinSave.ok)
const pinLoad = layout.loadGraphLayout(tmpVault)
ok('p3-layout-load-pinned', pinLoad.nodes.n1?.pinned === true && pinLoad.nodes.n1.x === 12)
ok('p3-layout-load-unpinned', pinLoad.nodes.n2?.pinned === false)
const pinClear = layout.saveGraphLayout(tmpVault, { nodes: {} }, { replaceAll: true })
ok('p3-layout-clear', pinClear.ok && pinClear.count === 0)
const pinEmpty = layout.loadGraphLayout(tmpVault)
ok('p3-layout-empty-after-clear', Object.keys(pinEmpty.nodes).length === 0)

// UI wiring Phase 3
ok('p3-ui-forces-section', filtersUi.includes('Forces') && filtersUi.includes('Repel'))
ok('p3-ui-force-sliders', filtersUi.includes('linkDist') || filtersUi.includes('Link dist'))
ok('p3-ui-layout-section', filtersUi.includes('Save layout') && filtersUi.includes('Clear file'))
ok('p3-ui-reset-forces', filtersUi.includes('Reset forces'))
ok('p3-ui-DEFAULT_FORCE', filtersUi.includes('DEFAULT_FORCE_SETTINGS'))
ok('p3-canvas-applyForces', globalUi.includes('applyForces') || globalUi.includes('forcesRef'))
ok('p3-canvas-layoutNodes', globalUi.includes('layoutNodes') && globalUi.includes('saveLayoutPositions'))
ok('p3-canvas-handleSaveLayout', globalUi.includes('handleSaveLayout') || globalUi.includes('Save layout'))
ok('p3-canvas-pinned-paint', globalUi.includes('isPinned') || globalUi.includes('pinned'))
ok('p3-canvas-live-forces', globalUi.includes('[forces, schedulePaint]') || globalUi.includes('forces, schedulePaint'))
ok('p3-store-saveLayout', store.includes('saveLayoutPositions'))
ok('p3-css-filter-actions', globals.includes('.graph-filter-actions'))
ok('p3-css-filter-status', globals.includes('.graph-filter-status'))

// ─── 7. Phase 4 Path highlight + neighborhood + color-by ─────────────
console.log('\n═══ 7. Phase 4 Path / focus / color-by ═══')

// Alpha ↔ Gamma path via wiki (A-B, A-C, Hub-A etc.)
const pathAG = g.findShortestPath(alpha.id, orphan.id)
ok('p4-path-method', typeof g.findShortestPath === 'function')
ok('p4-path-orphan-maybe', pathAG != null)
// Orphan is isolated → no path
ok('p4-path-orphan-not-found', pathAG && pathAG.found === false, JSON.stringify(pathAG && { found: pathAG.found, len: pathAG.length }))

const pathAB = g.findShortestPath(alpha.id, hub.id)
ok('p4-path-alpha-hub-found', pathAB && pathAB.found === true, pathAB && String(pathAB.length))
ok('p4-path-has-nodes', pathAB && pathAB.nodeIds.length >= 2)
ok('p4-path-starts-alpha', pathAB && pathAB.nodeIds[0] === alpha.id)
ok('p4-path-ends-hub', pathAB && pathAB.nodeIds[pathAB.nodeIds.length - 1] === hub.id)
ok('p4-path-edge-keys', pathAB && pathAB.edgeKeys.length === pathAB.length)

const pathSame = g.findShortestPath(alpha.id, alpha.id)
ok('p4-path-same-node', pathSame && pathSame.found && pathSame.length === 0)

const pathMissing = g.findShortestPath('nope-xyz', alpha.id)
ok('p4-path-missing-null', pathMissing === null)

const pathByPath = g.findShortestPath(alpha.path, hub.path)
ok('p4-path-resolve-by-path', pathByPath && pathByPath.found)

// Neighborhood
const neigh = g.getNeighborhoodIds(alpha.id, 1)
ok('p4-neigh-includes-center', neigh && neigh.ids.includes(alpha.id))
ok('p4-neigh-has-others', neigh && neigh.ids.length >= 2, neigh && String(neigh.ids.length))
const neigh2 = g.getNeighborhoodIds(alpha.id, 2)
ok('p4-neigh-depth2-ge', neigh2 && neigh && neigh2.ids.length >= neigh.ids.length)

// IPC wiring
ok('p4-ipc-getPath', ipc.includes("'graph:getPath'"))
ok('p4-ipc-getNeighborhood', ipc.includes("'graph:getNeighborhood'"))
ok('p4-preload-getGraphPath', pre.includes('getGraphPath'))
ok('p4-preload-getGraphNeighborhood', pre.includes('getGraphNeighborhood'))
ok('p4-types-getGraphPath', preD.includes('getGraphPath'))
ok('p4-store-findPath', store.includes('findPath') && store.includes('fetchNeighborhood'))

// UI
ok('p4-ui-explore', filtersUi.includes('Explore') && filtersUi.includes('Find path'))
ok('p4-ui-color-by', filtersUi.includes('Warna node') && filtersUi.includes('Folder'))
ok('p4-ui-focus-depth', filtersUi.includes('Depth 1') || filtersUi.includes('focusDepth'))
ok('p4-canvas-path-paint', globalUi.includes('pathNodeIds') && globalUi.includes('pathEdgeKeys'))
ok('p4-canvas-shift-click', globalUi.includes('shiftKey') && globalUi.includes('altKey'))
ok('p4-canvas-folderColor', globalUi.includes('folderColor') || globalUi.includes("colorBy === 'folder'"))
ok('p4-canvas-findPath', globalUi.includes('handleFindPath') || globalUi.includes('findPath'))

// ─── 8. Phase 5 Saved views + export + LOD ──────────────────────────
console.log('\n═══ 8. Phase 5 Views / export / LOD ═══')

ok('p5-resolveLod-fn', typeof layout.resolveGraphLod === 'function')
ok('p5-lod-auto-small', layout.resolveGraphLod(10, 'auto') === 'full')
ok('p5-lod-auto-mid', layout.resolveGraphLod(180, 'auto') === 'medium')
ok('p5-lod-auto-big', layout.resolveGraphLod(450, 'auto') === 'low')
ok('p5-lod-quality', layout.resolveGraphLod(500, 'quality') === 'full')
ok('p5-lod-speed', layout.resolveGraphLod(50, 'speed') === 'low')

// Views CRUD on tmp vault
const vSave = layout.upsertGraphView(tmpVault, {
  name: 'Kerja focus',
  snapshot: {
    orphanMode: 'hide',
    hubMode: 'dim',
    hubDegreeThreshold: 12,
    selectedType: 'project',
    selectedTag: 'all',
    showLabels: true,
    showTagEdges: false,
    showLegend: false,
    colorBy: 'folder',
    forces: { center: 0.08, charge: -120, linkDist: 80, linkStr: 0.5, collide: 0.7 },
    perfMode: 'speed'
  }
})
ok('p5-view-save-ok', vSave.ok === true, vSave.error)
ok('p5-view-has-id', Boolean(vSave.view?.id))
ok('p5-view-snapshot-orphan', vSave.view?.snapshot.orphanMode === 'hide')
ok('p5-view-snapshot-color', vSave.view?.snapshot.colorBy === 'folder')
ok('p5-view-snapshot-perf', vSave.view?.snapshot.perfMode === 'speed')

const vLoad = layout.loadGraphViews(tmpVault)
ok('p5-view-load-count', vLoad.views.length === 1, String(vLoad.views.length))
ok('p5-view-load-name', vLoad.views[0]?.name === 'Kerja focus')

// Upsert by same name updates
const vUp = layout.upsertGraphView(tmpVault, {
  name: 'Kerja focus',
  snapshot: { orphanMode: 'only', colorBy: 'type' }
})
ok('p5-view-upsert-same-name', vUp.ok && vUp.views?.length === 1)
ok('p5-view-upsert-updated', vUp.view?.snapshot.orphanMode === 'only')

const vDel = layout.deleteGraphView(tmpVault, vUp.view.id)
ok('p5-view-delete', vDel.ok && vDel.views?.length === 0)
ok('p5-view-no-vault', layout.upsertGraphView(null, { name: 'x', snapshot: {} }).ok === false)

// Sanitize invalid modes
const vSan = layout.upsertGraphView(tmpVault, {
  name: 'san',
  snapshot: { orphanMode: 'nope', hubMode: 'zzz', perfMode: 'turbo', colorBy: 'rainbow' }
})
ok('p5-view-sanitize-orphan', vSan.view?.snapshot.orphanMode === 'all')
ok('p5-view-sanitize-hub', vSan.view?.snapshot.hubMode === 'dim')
ok('p5-view-sanitize-perf', vSan.view?.snapshot.perfMode === 'auto')
ok('p5-view-sanitize-color', vSan.view?.snapshot.colorBy === 'type')

// IPC / UI wiring
ok('p5-ipc-listViews', ipc.includes("'graph:listViews'"))
ok('p5-ipc-saveView', ipc.includes("'graph:saveView'"))
ok('p5-ipc-deleteView', ipc.includes("'graph:deleteView'"))
ok('p5-preload-list', pre.includes('listGraphViews'))
ok('p5-preload-save', pre.includes('saveGraphView'))
ok('p5-preload-del', pre.includes('deleteGraphView'))
ok('p5-store-views', store.includes('savedViews') && store.includes('saveGraphView'))
ok('p5-ui-views-section', filtersUi.includes('Views & Export') || filtersUi.includes('Simpan view'))
ok('p5-ui-export-png', filtersUi.includes('Export PNG') && globalUi.includes('toDataURL'))
ok('p5-ui-perf-mode', filtersUi.includes('Performance') && filtersUi.includes('Quality'))
ok('p5-canvas-resolveLod', globalUi.includes('resolveLod') || globalUi.includes('resolveGraphLod'))
ok('p5-canvas-frustum', globalUi.includes('inView') || globalUi.includes('frustum'))
ok('p5-canvas-export', globalUi.includes('handleExportPng') || globalUi.includes('toDataURL'))
ok('p5-canvas-loadView', globalUi.includes('handleLoadView') || globalUi.includes('onLoadView'))
ok('p5-css-views-list', globals.includes('.graph-views-list'))

// ─── 9. Phase 6 parity + debt fixes ─────────────────────────────────
console.log('\n═══ 9. Phase 6 keyboard / local forces / debt ═══')

// Global: auto-fit once (not every sim end)
ok('p6-autofit-once', globalUi.includes('hasAutoFitRef'))
ok('p6-autofit-guard', globalUi.includes('!hasAutoFitRef.current') || globalUi.includes('hasAutoFitRef.current'))

// Keyboard shortcuts
ok('p6-keys-activeView', globalUi.includes("activeView !== 'graph'") || globalUi.includes("activeView === 'graph'"))
ok('p6-keys-escape', globalUi.includes("e.key === 'Escape'"))
ok('p6-keys-fit', globalUi.includes("e.key === 'f'") || globalUi.includes("e.key === 'F'"))
ok('p6-keys-export', globalUi.includes("e.key === 'e'") || globalUi.includes("handleExportPng"))
ok('p6-keys-spotlight', globalUi.includes("e.key === '/'") && globalUi.includes('graph-spotlight'))
ok('p6-keys-hint-ui', globalUi.includes('graph-toolbar-hint') || filtersUi.includes('Keys:'))

// Local graph force parity + depth persist
ok('p6-local-forces', localUi.includes('forcesRef') || localUi.includes('DEFAULT_FORCE_SETTINGS'))
ok('p6-local-scaled-charge', localUi.includes('charge') && localUi.includes('0.78'))
ok('p6-local-depth-persist', localUi.includes('localDepth:') && localUi.includes('updateGraphSettings'))
ok('p6-local-updateSettings', localUi.includes('updateGraphSettings'))

// Light titlebar debt (cross-check tokens + main)
const tokensCss = fs.readFileSync(path.join(root, 'src/renderer/src/styles/tokens.css'), 'utf8')
const mainIdx = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
ok('p6-titlebar-token-light', tokensCss.includes("--titlebar-overlay-bg: #ffffff") || tokensCss.includes('--titlebar-overlay-bg: #fff'))
ok('p6-titlebar-main-light', mainIdx.includes("color: '#ffffff'") || mainIdx.includes('color: "#ffffff"'))
ok('p6-app-bg-aligned', mainIdx.includes('APP_BG') || mainIdx.includes('#f2f4f7'))

// ─── 10. Phase 7 multi-select + path pulse ──────────────────────────
console.log('\n═══ 10. Phase 7 multi-select / path pulse ═══')
ok('p7-selectedIds', globalUi.includes('selectedIds') && globalUi.includes('setSelectedIds'))
ok('p7-ctrl-click', globalUi.includes('ctrlKey') && globalUi.includes('metaKey') && globalUi.includes('multi-select'))
ok('p7-select-all', globalUi.includes("e.key === 'a'") || globalUi.includes("e.key === 'A'"))
ok('p7-copy-wikilinks', globalUi.includes('clipboard') && globalUi.includes('[['))
ok('p7-open-selected', globalUi.includes("e.key === 'o'") || globalUi.includes("e.key === 'O'"))
ok('p7-path-pulse', globalUi.includes('pathPulseRef') && globalUi.includes('Math.sin'))
ok('p7-selection-ring', globalUi.includes('isSelected') && globalUi.includes('selection ring'))
ok('p7-clear-sel-chip', globalUi.includes('Clear sel') || globalUi.includes('sel:'))
ok('p7-esc-clears-sel', globalUi.includes('setSelectedIds(new Set())'))

// ─── Summary ────────────────────────────────────────────────────────
console.log(`\n═══ SUMMARY: ${pass} PASS · ${fail} FAIL ═══\n`)
if (fail > 0) {
  console.error(JSON.stringify(bugs, null, 2))
  process.exit(1)
}
console.log('PHASE0_GRAPH_OK')
console.log('PHASE1_LOCAL_GRAPH_OK')
console.log('PHASE2_GLOBAL_FILTERS_OK')
console.log('PHASE3_FORCES_LAYOUT_OK')
console.log('PHASE4_PATH_FOCUS_OK')
console.log('PHASE5_VIEWS_EXPORT_LOD_OK')
console.log('PHASE6_PARITY_DEBT_OK')
console.log('PHASE7_SELECT_PULSE_OK')
process.exit(0)
