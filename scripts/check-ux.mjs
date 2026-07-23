import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

const bugs = []
const ok = (id, c, d='') => { if (!c) bugs.push({id,d}); else console.log(' OK', id, d) }

// --- Source UX fixes present ---
const ed = fs.readFileSync('src/renderer/src/components/editor/MarkdownEditor.tsx','utf8')
ok('cm-ref', ed.includes('cmRef') && ed.includes('ReactCodeMirrorRef'))
ok('insert-cursor', ed.includes('view.state.selection.main') || ed.includes('sliceDoc'))
ok('preview-label', ed.includes('Hide preview') && ed.includes("showPreview ? 'Hide preview'"))
ok('no-always-append', !ed.includes('`${activeTab.content}\\n${before}${after}`'))

const chat = fs.readFileSync('src/renderer/src/components/chat/ChatPanel.tsx','utf8')
ok('chat-autoscroll', chat.includes('messagesEndRef') && chat.includes('scrollIntoView'))
ok('chat-apply-error-color', chat.includes('applyOk') && chat.includes('color-error'))
ok('chat-disabled-generating', chat.includes('disabled={isGenerating}'))

const search = fs.readFileSync('src/renderer/src/components/search/SearchModal.tsx','utf8')
ok('search-scroll', search.includes('scrollIntoView') && search.includes('itemRefs'))
ok('search-hover-index', search.includes('onMouseEnter'))

const dash = fs.readFileSync('src/renderer/src/components/dashboard/DashboardView.tsx','utf8')
ok('dash-responsive', dash.includes('auto-fit') || dash.includes('minmax(220px'))

const welcome = fs.readFileSync('src/renderer/src/components/welcome/WelcomeScreen.tsx','utf8')
ok('welcome-cursor', welcome.includes("not-allowed"))

const css = fs.readFileSync('src/renderer/src/styles/globals.css','utf8')
ok('btn-active', css.includes('.btn.active') || css.includes('.btn-ghost.active'))
ok('btn-disabled', css.includes('.btn:disabled') || css.includes('btn[disabled]'))

const local = fs.readFileSync('src/renderer/src/components/graph/LocalGraphView.tsx','utf8')
ok('local-graph-refresh', local.includes('onGraphUpdated'))

const gtsx = fs.readFileSync('src/renderer/src/components/graph/GraphCanvas.tsx','utf8')
ok('canvas-graph', gtsx.includes('getContext'))
ok('tag-default-off', /showTagEdges[^\n]*useState\(false\)/.test(gtsx) || gtsx.includes('useState(false)') && gtsx.includes('showTagEdges'))

// --- Runtime vault ---
const ME = await import(pathToFileURL(path.resolve('scripts/.tmp-engines/MarkdownEngine.js')).href)
const GE = await import(pathToFileURL(path.resolve('scripts/.tmp-engines/GraphEngine.js')).href)
const md = new ME.MarkdownEngine()
const vault = 'D:/Obs/Obs'
function walk(dir, acc=[]) {
  if (!fs.existsSync(dir)) return acc
  for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
    if (e.name.startsWith('.')) continue
    const p = path.join(dir,e.name)
    if (e.isDirectory()) walk(p,acc)
    else if (e.name.endsWith('.md')) acc.push(p)
  }
  return acc
}
if (fs.existsSync(vault)) {
  const notes = walk(vault).map(f => md.parseFile(f, fs.readFileSync(f,'utf8'), vault))
  const g = new GE.GraphEngine()
  const data = g.buildFromParsedFiles(notes, true)
  const home = data.nodes.find(n => n.relativePath==='00 Home.md')
  ok('vault-nodes', data.nodes.length>=80, String(data.nodes.length))
  ok('wiki-edges', data.edges.filter(e=>e.type==='wiki_link').length>=100, String(data.edges.filter(e=>e.type==='wiki_link').length))
  if (home) {
    const out = g.getOutgoingLinks(home.id)
    const neigh = g.getNeighbors(home.id,1)
    ok('home-out', out.nodes.length>=20, String(out.nodes.length))
    ok('neigh-no-self', !neigh.nodes.some(n=>n.id===home.id))
  }
  // code fence
  const cf = md.parseFile('/v/c.md','```\n[[No]]\n```\n[[Yes]]','/v')
  ok('code-fence', cf.wikiLinks.length===1 && cf.wikiLinks[0].target==='Yes')
}

// Grok quick
const GR = await import(pathToFileURL(path.resolve('scripts/.tmp-grok/GrokProvider.js')).href)
const imp = GR.importGrokCliAuth()
ok('grok-import', imp.ok, imp.email||imp.error||'')
if (imp.ok) {
  ok('grok-api-xai', (imp.baseUrl||'').includes('api.x.ai'), imp.baseUrl)
}

console.log('\n' + (bugs.length ? 'BUGS '+JSON.stringify(bugs,null,2) : 'ALL_CHECKS_OK'))
process.exit(bugs.length?1:0)
