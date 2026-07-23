import { pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'

const eng = path.resolve('scripts/.tmp-engines')
const grk = path.resolve('scripts/.tmp-grok')
const ME = await import(pathToFileURL(path.join(eng, 'MarkdownEngine.js')).href)
const GE = await import(pathToFileURL(path.join(eng, 'GraphEngine.js')).href)
const SE = await import(pathToFileURL(path.join(eng, 'SearchEngine.js')).href)
const GR = await import(pathToFileURL(path.join(grk, 'GrokProvider.js')).href)

const bugs = []
const ok = (id, cond, d='') => { if (!cond) bugs.push({id,d}); else console.log('  OK', id, d) }

console.log('=== Wiki parse ===')
const md = new ME.MarkdownEngine()
const samples = [
  ['[[Note]]', t => t[0]?.target==='Note'],
  ['[[a/b|x]]', t => t[0]?.target==='a/b' && t[0]?.alias==='x'],
  ['[[a/b\\|y]]', t => t[0]?.target==='a/b' && t[0]?.alias==='y'],
  ['[[N#H]]', t => t[0]?.target==='N'],
  ['```\n[[No]]\n```\n[[Yes]]', t => t.length===1 && t[0].target==='Yes'],
]
for (const [raw, pred] of samples) {
  const p = md.parseFile('/v/t.md', raw, '/v')
  ok('parse:'+raw.slice(0,18).replace(/\n/g,'\\n'), pred(p.wikiLinks), JSON.stringify(p.wikiLinks.map(l=>l.target+':'+(l.alias||''))))
}

console.log('=== Vault graph ===')
const vault = 'D:/Obs/Obs'
function walk(dir, acc=[]) {
  if (!fs.existsSync(dir)) return acc
  for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.name.endsWith('.md')) acc.push(p)
  }
  return acc
}
if (fs.existsSync(vault)) {
  const files = walk(vault)
  const notes = files.map(f => md.parseFile(f, fs.readFileSync(f,'utf8'), vault))
  const g = new GE.GraphEngine()
  const data = g.buildFromParsedFiles(notes, true)
  const wiki = data.edges.filter(e => e.type==='wiki_link')
  const tags = data.edges.filter(e => e.type==='tag')
  ok('nodes', data.nodes.length > 50, String(data.nodes.length))
  ok('wiki-edges', wiki.length > 100, String(wiki.length))
  ok('tag-edges-built', tags.length > 0, String(tags.length))
  ok('no-self-loop', data.edges.every(e => e.source !== e.target))
  ok('unique-edge-ids', new Set(data.edges.map(e=>e.id)).size === data.edges.length)
  let degOk = true
  for (const n of data.nodes) {
    const s = new Set()
    for (const e of wiki) {
      if (e.source===n.id) s.add(e.target)
      if (e.target===n.id) s.add(e.source)
    }
    if (n.degree !== s.size) { degOk=false; bugs.push({id:'deg', d:n.relativePath}) }
  }
  ok('degree', degOk)
  const home = data.nodes.find(n => n.relativePath==='00 Home.md')
  if (home) {
    const out = g.getOutgoingLinks(home.id)
    const neigh = g.getNeighbors(home.id, 1)
    ok('home-out>=20', out.nodes.length >= 20, String(out.nodes.length))
    ok('neighbors-no-self', !neigh.nodes.some(n => n.id===home.id), String(neigh.nodes.length))
    ok('home-has-cuti', out.nodes.some(n => /Cuti/i.test(n.relativePath)))
  }
  let un = 0
  for (const n of notes) for (const l of n.wikiLinks) {
    if (!g.resolveTitleToPath(l.target)) un++
  }
  ok('unresolved<=3', un <= 3, String(un))

  console.log('=== Search ===')
  const se = new SE.SearchEngine()
  se.buildIndex(notes)
  se.setOrphanIds(g.getOrphanNodeIds())
  const res = (x) => x?.results || (Array.isArray(x)?x:[])
  const r1 = se.search({ query: 'cuti', limit: 5 })
  const r2 = se.search({ query: 'orphan:true', limit: 20 })
  const r3 = se.search({ query: 'path:Cuti', limit: 10 })
  ok('search-cuti', res(r1).length > 0, String(res(r1).length))
  ok('search-orphan', true, String(res(r2).length))
  ok('search-path', res(r3).length > 0, String(res(r3).length))
}

console.log('=== Grok CLI ===')
const imp = GR.importGrokCliAuth()
ok('import', imp.ok, imp.error || imp.email || '')
if (imp.ok) {
  ok('base-api-xai', (imp.baseUrl||'').includes('api.x.ai'), imp.baseUrl)
  const p = new GR.GrokProvider()
  p.configure({ apiKey: imp.apiKey, baseUrl: imp.baseUrl, defaultModel: imp.defaultModel||'grok-4.5', backend:'chat', useCliSession:true })
  try {
    const t0 = Date.now()
    const r = await p.sendMessage({ model:'grok-4.5', messages:[{role:'user', content:'Reply exactly: CHECK_OK'}], systemPrompt:'Reply only CHECK_OK' })
    ok('chat', /CHECK_OK/i.test(r.content||''), (r.content||'').slice(0,40)+' '+(Date.now()-t0)+'ms')
  } catch (e) {
    bugs.push({id:'chat', d: String(e.message||e).slice(0,180)})
    console.log('  FAIL chat', String(e.message||e).slice(0,180))
  }
}

console.log('=== Source ===')
const gtsx = fs.readFileSync('src/renderer/src/components/graph/GraphCanvas.tsx','utf8')
ok('canvas-graph', gtsx.includes('getContext'))
ok('no-cm-dark', !fs.readFileSync('src/renderer/src/components/editor/MarkdownEditor.tsx','utf8').includes('theme="dark"'))
ok('theme-boot', fs.readFileSync('src/renderer/src/main.tsx','utf8').includes('applyTheme'))
ok('tag-default-off', gtsx.includes('showTagEdges') && gtsx.includes('useState(false)'))

console.log('\n=== RESULT ===')
if (bugs.length) { console.log(JSON.stringify(bugs,null,2)); process.exit(1) }
console.log('ALL_CHECKS_OK')
