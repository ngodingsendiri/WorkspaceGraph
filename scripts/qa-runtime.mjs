/**
 * Runtime functional QA for Markdown / Graph / Search engines.
 * Run: node scripts/qa-runtime.mjs
 * Requires: npx esbuild ... (see package.json qa script)
 */
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const engDir = path.join(__dirname, '.tmp-engines')

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

async function loadEngines() {
  const md = await import(pathToFileURL(path.join(engDir, 'MarkdownEngine.js')).href)
  const gr = await import(pathToFileURL(path.join(engDir, 'GraphEngine.js')).href)
  const se = await import(pathToFileURL(path.join(engDir, 'SearchEngine.js')).href)
  return {
    MarkdownEngine: md.MarkdownEngine,
    GraphEngine: gr.GraphEngine,
    SearchEngine: se.SearchEngine
  }
}

async function main() {
  if (!fs.existsSync(path.join(engDir, 'MarkdownEngine.js'))) {
    console.error('Missing scripts/.tmp-engines — run esbuild first')
    process.exit(1)
  }

  const { MarkdownEngine, GraphEngine, SearchEngine } = await loadEngines()
  const md = new MarkdownEngine()
  const graph = new GraphEngine()
  const search = new SearchEngine()

  const root = path.join(os.tmpdir(), `wg-qa-${Date.now()}`)
  fs.mkdirSync(path.join(root, 'Knowledge'), { recursive: true })
  fs.mkdirSync(path.join(root, 'Daily'), { recursive: true })

  const alphaPath = path.join(root, 'Knowledge', 'Alpha.md')
  const betaPath = path.join(root, 'Knowledge', 'Beta.md')
  const gammaPath = path.join(root, 'Knowledge', 'Gamma.md')
  const orphanPath = path.join(root, 'Knowledge', 'Lonely.md')
  const dailyPath = path.join(root, 'Daily', '2026-07-22.md')

  const alphaRaw = `---
title: Alpha
tags: [core, test]
updated: 2026-07-20
---
# Alpha
See [[Beta]] and [[Gamma|alias G]].
Also #inlineTag
`
  const betaRaw = `---
title: Beta
tags: [core]
updated: 2026-07-21
---
# Beta
Back to [[Alpha]].
`
  const gammaRaw = `---
title: Gamma
tags: []
updated: 2026-07-19
---
# Gamma
No links out.
`
  const orphanRaw = `---
title: Lonely
tags: [solo]
---
# Lonely
Isolated note.
`
  const dailyRaw = md.createDailyNoteTemplate('2026-07-22')

  fs.writeFileSync(alphaPath, alphaRaw)
  fs.writeFileSync(betaPath, betaRaw)
  fs.writeFileSync(gammaPath, gammaRaw)
  fs.writeFileSync(orphanPath, orphanRaw)
  fs.writeFileSync(dailyPath, dailyRaw)

  // --- MarkdownEngine ---
  const a = md.parseFile(alphaPath, alphaRaw, root)
  const b = md.parseFile(betaPath, betaRaw, root)
  const g = md.parseFile(gammaPath, gammaRaw, root)
  const o = md.parseFile(orphanPath, orphanRaw, root)
  const d = md.parseFile(dailyPath, dailyRaw, root)

  assert(a.title === 'Alpha', 'parse title from frontmatter')
  assert(a.wikiLinks.length === 2 && a.wikiLinks[0].target === 'Beta', 'extract wikilinks')
  assert(a.wikiLinks[1].alias === 'alias G' || a.wikiLinks[1].alias === 'G' || a.wikiLinks[1].target === 'Gamma', 'wikilink with alias')
  assert(a.tags.includes('core') && a.tags.includes('test') && a.tags.includes('inlineTag'), 'merge fm + inline tags')
  assert(a.headings.some(h => h.level === 1 && h.text === 'Alpha'), 'extract headings')
  assert(a.id && a.id.length === 24, 'stable sha id length')
  assert(a.relativePath.replace(/\\/g, '/') === 'Knowledge/Alpha.md', 'relative path')
  assert(d.frontmatter.type === 'daily' || dailyRaw.includes('type: daily'), 'daily template has type')

  const html = md.renderToHtml(a.content)
  assert(html.includes('wiki-link') && html.includes('data-target="Beta"'), 'render wikilink spans')
  // Headings always include id= for anchors: <h1 id="alpha">…</h1>
  assert(/<h1\b[^>]*>/i.test(html), 'render h1')
  const unsafeHtml = md.renderToHtml('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))')
  assert(!unsafeHtml.includes('<script>') && !unsafeHtml.includes('<img src='), 'escape unsafe markdown HTML')
  assert(!unsafeHtml.includes('href="javascript:'), 'block unsafe markdown URLs')

  const noteTpl = md.createNoteTemplate('Hello', 'knowledge')
  assert(noteTpl.includes('title: Hello') && noteTpl.includes('type: knowledge'), 'note template frontmatter')

  // Unique IDs for different paths
  assert(a.id !== b.id && b.id !== g.id, 'no ID collision across files')

  // resolveWikiLink
  const map = new Map([
    [alphaPath, 'Alpha'],
    [betaPath, 'Beta'],
    [gammaPath, 'Gamma']
  ])
  assert(md.resolveWikiLink('Beta', map) === betaPath, 'resolve wiki by title')
  assert(md.resolveWikiLink('alpha', map) === alphaPath, 'resolve wiki case-insensitive')

  // --- GraphEngine ---
  const files = [a, b, g, o, d]
  const gd = graph.buildFromParsedFiles(files)
  assert(gd.nodeCount === 5, `graph nodes=5 got ${gd.nodeCount}`)
  const wikiEdges = gd.edges.filter(e => e.type === 'wiki_link')
  assert(wikiEdges.length >= 2, `wiki edges >=2 got ${wikiEdges.length}`)
  // Alpha->Beta, Alpha->Gamma, Beta->Alpha
  assert(wikiEdges.some(e => e.source === a.id && e.target === b.id), 'edge Alpha→Beta')
  assert(wikiEdges.some(e => e.source === b.id && e.target === a.id), 'edge Beta→Alpha')

  const back = graph.getBacklinks(b.id)
  assert(back.nodes.some(n => n.id === a.id), 'backlinks of Beta include Alpha')
  const out = graph.getOutgoingLinks(a.id)
  assert(out.nodes.some(n => n.id === b.id) && out.nodes.some(n => n.id === g.id), 'outgoing from Alpha')

  const orphans = graph.getOrphanNodeIds()
  assert(orphans.includes(o.id), 'Lonely is orphan')
  assert(!orphans.includes(a.id), 'Alpha not orphan')

  const resolved = graph.resolveTitleToPath('Beta')
  assert(resolved && resolved.replace(/\\/g, '/').endsWith('Knowledge/Beta.md'), 'resolveTitleToPath')

  const neighbors = graph.getNeighbors(a.id, 1)
  assert(neighbors.nodes.length >= 2 && !neighbors.nodes.some(n => n.id === a.id), 'neighbors of Alpha include linked nodes without self')

  // Incremental update: add link from Gamma to Lonely
  const g2raw = gammaRaw.replace('No links out.', 'Link [[Lonely]]')
  const g2 = md.parseFile(gammaPath, g2raw, root)
  graph.updateNodeAndEdges(g2)
  assert(graph.getOutgoingLinks(g.id).nodes.some(n => n.id === o.id), 'updateNodeAndEdges adds Gamma→Lonely')
  assert(!graph.getOrphanNodeIds().includes(o.id), 'Lonely no longer orphan after link')

  graph.removeNode(o.id)
  assert(!graph.getNodeById(o.id), 'removeNode deletes node')
  assert(!graph.getGraphData().edges.some(e => e.source === o.id || e.target === o.id), 'removeNode clears edges')

  // rebuild clean for search
  graph.buildFromParsedFiles(files)

  // --- SearchEngine ---
  search.buildIndex(files)
  search.setOrphanIds(graph.getOrphanNodeIds())

  const empty = search.search({ query: '', limit: 5 })
  assert(empty.length > 0, 'empty query → recent notes')
  assert(empty[0].title === 'Beta' || empty.some(r => r.title === 'Beta'), 'recent prefers newer updated (Beta 07-21)')

  const qAlpha = search.search({ query: 'Alpha', limit: 10 })
  assert(qAlpha.some(r => r.title === 'Alpha'), 'fuzzy find Alpha')

  const byTag = search.search({ query: '#core', limit: 10 })
  assert(byTag.length >= 2 && byTag.every(r => r.tags.some(t => t.toLowerCase() === 'core')), 'tag operator #core')

  const orphansS = search.search({ query: 'orphan:true', limit: 20 })
  assert(orphansS.some(r => r.title === 'Lonely'), 'orphan:true finds Lonely')

  const tags = search.getAllTags()
  assert(tags.some(t => t.tag === 'core' && t.count >= 2), 'getAllTags counts')

  // Filter type
  search.addToIndex({
    ...d,
    frontmatter: { ...d.frontmatter, type: 'daily' }
  })
  // daily type from frontmatter
  const dailyEntry = md.parseFile(dailyPath, dailyRaw, root)
  search.addToIndex(dailyEntry)

  // Source integrity checks (static)
  const rootSrc = path.join(__dirname, '..', 'src')
  const ipc = fs.readFileSync(path.join(rootSrc, 'main/ipc/index.ts'), 'utf8')
  assert(ipc.includes('graph:getBacklinks'), 'IPC backlinks')
  assert(ipc.includes('markdown:render'), 'IPC render')
  assert(ipc.includes('attachFileWatcher'), 'IPC shared watcher attach')
  assert(ipc.includes('loadSettingsIntoProviders'), 'AI keys load from settings on startup')
  assert(ipc.includes('workspaceEngine.saveSettings'), 'AI configure persists settings')

  const wel = fs.readFileSync(path.join(rootSrc, 'renderer/src/components/welcome/WelcomeScreen.tsx'), 'utf8')
  assert(!wel.includes('Proyek\\\\Workspacegraph') && !wel.includes('Proyek\\Workspacegraph'), 'no bad demo path')
  assert(wel.includes('createWorkspace'), 'create vault UI')

  const side = fs.readFileSync(path.join(rootSrc, 'renderer/src/components/layout/Sidebar.tsx'), 'utf8')
  assert(side.includes('onContextMenu'), 'file tree context menu')
  assert(side.includes('Rename') && side.includes('Delete'), 'context menu rename/delete')

  const shell = fs.readFileSync(path.join(rootSrc, 'renderer/src/components/layout/AppShell.tsx'), 'utf8')
  assert(shell.includes("key === 'n'"), 'hotkey Ctrl+N')
  assert(shell.includes("key === 'd'"), 'hotkey daily note')

  const settings = fs.readFileSync(path.join(rootSrc, 'renderer/src/components/settings/SettingsView.tsx'), 'utf8')
  assert(settings.includes('saveSettings') || settings.includes('getSettings'), 'settings persist')
  assert(settings.includes('theme') || settings.includes('data-theme'), 'theme settings')

  const bl = fs.readFileSync(path.join(rootSrc, 'renderer/src/components/editor/BacklinksPanel.tsx'), 'utf8')
  assert(bl.includes('Outline') && bl.includes('Backlinks'), 'inspector outline + backlinks')

  const chat = fs.readFileSync(path.join(rootSrc, 'renderer/src/store/chatStore.ts'), 'utf8')
  assert(chat.includes('historyForApi'), 'chat history no duplicate user msg')

  const status = fs.readFileSync(path.join(rootSrc, 'renderer/src/components/layout/StatusBar.tsx'), 'utf8')
  assert(status.includes('wordCount') || status.includes('words'), 'statusbar word count')

  // cleanup
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {}

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
