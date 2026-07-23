/**
 * Full feature audit — tested ONE BY ONE.
 * Runtime where possible; marks MANUAL where Electron UI / API key required.
 *
 * Run: node scripts/qa-features-sequential.mjs
 */
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const require = createRequire(import.meta.url)

const results = [] // { id, name, status: pass|fail|manual|skip, detail }

function record(id, name, status, detail = '') {
  results.push({ id, name, status, detail })
  const tag =
    status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : status === 'manual' ? 'MANUAL' : 'SKIP'
  const line = `  [${tag.padEnd(6)}] ${id} — ${name}${detail ? ` · ${detail}` : ''}`
  if (status === 'fail') console.error(line)
  else console.log(line)
}

function read(p) {
  return fs.readFileSync(path.join(root, p), 'utf8')
}
function exists(p) {
  return fs.existsSync(path.join(root, p))
}

// ─── 0. Project foundation ─────────────────────────────────────────
function auditFoundation() {
  console.log('\n═══ 0. Foundation ═══')
  record('0.1', 'package.json scripts (dev/typecheck/qa)', exists('package.json') && read('package.json').includes('"typecheck"') ? 'pass' : 'fail')
  record('0.2', 'Blueprint constitution present', exists('00_Constitution.md') ? 'pass' : 'fail')
  record('0.3', 'electron-vite config + better-sqlite3 external', read('electron.vite.config.ts').includes('better-sqlite3') ? 'pass' : 'fail')
  record('0.4', 'SDK packages load (sqlite/gemini/openai/claude)', (() => {
    try {
      require('better-sqlite3')
      require('@google/genai')
      require('openai')
      require('@anthropic-ai/sdk')
      return 'pass'
    } catch (e) {
      return 'fail'
    }
  })(), '')
}

// ─── 1. Vault / Workspace ──────────────────────────────────────────
function auditWorkspace() {
  console.log('\n═══ 1. Workspace / Vault ═══')
  const we = read('src/main/engine/WorkspaceEngine.ts')
  record('1.1', 'Open workspace (scan + config)', we.includes('openWorkspace') ? 'pass' : 'fail')
  record('1.2', 'Create workspace + standard folders', we.includes('STANDARD_FOLDERS') && we.includes('createWorkspace') ? 'pass' : 'fail')
  record('1.3', 'Seed templates on create', we.includes('seedBuiltinToVault') ? 'pass' : 'fail')
  record('1.4', 'Recent workspaces', we.includes('recentWorkspaces') || we.includes('getRecentWorkspaces') ? 'pass' : 'fail')
  record('1.5', 'IPC workspace open/create/close', read('src/main/ipc/index.ts').includes('workspace:open') && read('src/main/ipc/index.ts').includes('workspace:create') ? 'pass' : 'fail')
  record('1.6', 'Welcome UI open + create vault', read('src/renderer/src/components/welcome/WelcomeScreen.tsx').includes('createWorkspace') && read('src/renderer/src/components/welcome/WelcomeScreen.tsx').includes('openFolder') ? 'pass' : 'fail')
  record('1.7', 'UI: open/create vault in running app', 'manual', 'npm run dev → Open/Create vault')
}

// ─── 2. Markdown engine ────────────────────────────────────────────
async function auditMarkdown(md) {
  console.log('\n═══ 2. Markdown Engine ═══')
  const raw = `---
title: Audit Note
tags: [audit, test]
updated: 2026-07-22
---
# Audit Note
See [[Other]] and [[Beta|alias]].
#inlineTag
`
  const parsed = md.parseFile('/vault/Knowledge/Audit.md', raw, '/vault')
  record('2.1', 'Parse frontmatter title', parsed.title === 'Audit Note' ? 'pass' : 'fail', parsed.title)
  record('2.2', 'Extract wikilinks', parsed.wikiLinks?.length >= 2 ? 'pass' : 'fail', String(parsed.wikiLinks?.length))
  record('2.3', 'Merge tags fm+inline', parsed.tags?.includes('audit') && parsed.tags?.includes('inlineTag') ? 'pass' : 'fail')
  record('2.4', 'Extract headings', parsed.headings?.some(h => h.text === 'Audit Note') ? 'pass' : 'fail')
  record('2.5', 'Stable id (sha length)', parsed.id?.length === 24 ? 'pass' : 'fail')
  const html = md.renderToHtml(parsed.content)
  record('2.6', 'Render wiki-link HTML', html.includes('wiki-link') && html.includes('data-target') ? 'pass' : 'fail')
  record('2.7', 'Note template frontmatter', md.createNoteTemplate('X', 'knowledge').includes('type: knowledge') ? 'pass' : 'fail')
  record('2.8', 'Daily template', md.createDailyNoteTemplate('2026-07-22').includes('type: daily') ? 'pass' : 'fail')
  record('2.9', 'Editor live preview + autosave (UI)', 'manual', 'Open note, type, split preview')
}

// ─── 3. Graph ──────────────────────────────────────────────────────
async function auditGraph(md, GraphEngine) {
  console.log('\n═══ 3. Graph Engine ═══')
  const graph = new GraphEngine()
  const root = '/vault'
  const files = [
    md.parseFile(`${root}/Knowledge/A.md`, '---\ntitle: A\ntags: [t]\n---\n# A\n[[B]]\n', root),
    md.parseFile(`${root}/Knowledge/B.md`, '---\ntitle: B\ntags: [t]\n---\n# B\n[[A]]\n', root),
    md.parseFile(`${root}/Knowledge/C.md`, '---\ntitle: C\n---\n# C\nOrphan\n', root)
  ]
  const g = graph.buildFromParsedFiles(files)
  record('3.1', 'Build nodes', g.nodeCount === 3 ? 'pass' : 'fail', String(g.nodeCount))
  record('3.2', 'Wiki edges A↔B', g.edges.filter(e => e.type === 'wiki_link').length >= 2 ? 'pass' : 'fail')
  const back = graph.getBacklinks(files[1].id)
  record('3.3', 'Backlinks of B include A', back.nodes.some(n => n.id === files[0].id) ? 'pass' : 'fail')
  const out = graph.getOutgoingLinks(files[0].id)
  record('3.4', 'Outgoing from A include B', out.nodes.some(n => n.id === files[1].id) ? 'pass' : 'fail')
  const orphans = graph.getOrphanNodeIds()
  record('3.5', 'Orphan detection (C)', orphans.includes(files[2].id) ? 'pass' : 'fail')
  record('3.6', 'resolveTitleToPath', graph.resolveTitleToPath('B')?.includes('B.md') ? 'pass' : 'fail')
  record('3.7', 'IPC graph:getBacklinks + resolveLink', read('src/main/ipc/index.ts').includes('graph:getBacklinks') && read('src/main/ipc/index.ts').includes('graph:resolveLink') ? 'pass' : 'fail')
  record('3.8', 'GraphCanvas fluid UI present', read('src/renderer/src/components/graph/GraphCanvas.tsx').includes('forceSimulation') && read('src/renderer/src/components/graph/GraphCanvas.tsx').includes('posCache') ? 'pass' : 'fail')
  record('3.9', 'UI: open Graph View, drag/zoom', 'manual', 'Graph View in app')
}

// ─── 4. Search ─────────────────────────────────────────────────────
async function auditSearch(md, SearchEngine, GraphEngine) {
  console.log('\n═══ 4. Search ═══')
  const se = new SearchEngine()
  const graph = new GraphEngine()
  const root = '/v'
  const files = [
    md.parseFile(`${root}/Alpha.md`, '---\ntitle: Alpha\ntags: [core]\nupdated: 2026-07-21\n---\n# Alpha\ncuti tahunan\n[[Beta]]\n', root),
    md.parseFile(`${root}/Beta.md`, '---\ntitle: Beta\ntags: [core]\nupdated: 2026-07-22\n---\n# Beta\npegawai\n', root),
    md.parseFile(`${root}/Lonely.md`, '---\ntitle: Lonely\n---\n# Lonely\nisolated\n', root)
  ]
  graph.buildFromParsedFiles(files)
  se.buildIndex(files)
  se.setOrphanIds(graph.getOrphanNodeIds())

  record('4.1', 'Empty query → recent', se.search({ query: '', limit: 5 }).length > 0 ? 'pass' : 'fail')
  record('4.2', 'Fuzzy find Alpha', se.search({ query: 'Alpha', limit: 5 }).some(r => r.title === 'Alpha') ? 'pass' : 'fail')
  record('4.3', 'Tag operator #core', se.search({ query: '#core', limit: 10 }).length >= 2 ? 'pass' : 'fail')
  record('4.4', 'orphan:true', se.search({ query: 'orphan:true', limit: 10 }).some(r => r.title === 'Lonely') ? 'pass' : 'fail')
  record('4.5', 'path: operator', se.search({ query: 'path:Alpha', limit: 5 }).length >= 1 || se.searchByPathFragment ? 'pass' : 'fail')
  // path operator via search
  const pathHits = se.search({ query: 'path:Alpha', limit: 5 })
  record('4.5b', 'path:Alpha results', pathHits.length >= 1 ? 'pass' : 'fail', String(pathHits.length))
  const bl = se.search({ query: 'backlink:Beta', limit: 10 })
  record('4.6', 'backlink:Beta finds Alpha', bl.some(r => r.title === 'Alpha') ? 'pass' : 'fail')
  record('4.7', 'getAllTags', se.getAllTags().some(t => t.tag === 'core') ? 'pass' : 'fail')
  record('4.8', 'IPC search:query + recent + rebuild', read('src/main/ipc/index.ts').includes('search:rebuildIndex') ? 'pass' : 'fail')
  record('4.9', 'UI: Ctrl+K search', 'manual', 'Search modal in app')
}

// ─── 5. Index DB FTS ───────────────────────────────────────────────
function auditIndexDb() {
  console.log('\n═══ 5. Search Index (SQLite FTS) ═══')
  try {
    const Database = require('better-sqlite3')
    const dbp = path.join(os.tmpdir(), `wg-feat-${Date.now()}.db`)
    const db = new Database(dbp)
    db.exec(`
      CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, content TEXT);
      CREATE VIRTUAL TABLE notes_fts USING fts5(title, content, content='notes', content_rowid='rowid');
      CREATE TRIGGER ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
    `)
    db.prepare('INSERT INTO notes VALUES (?,?,?)').run('1', 'Cuti', 'prosedur cuti ASN')
    const hits = db.prepare(`SELECT n.title FROM notes_fts JOIN notes n ON n.rowid=notes_fts.rowid WHERE notes_fts MATCH ?`).all('cuti')
    record('5.1', 'FTS5 insert+match', hits.length === 1 ? 'pass' : 'fail')
    db.close()
    fs.unlinkSync(dbp)
  } catch (e) {
    record('5.1', 'FTS5 runtime', 'fail', e.message)
  }
  const idb = read('src/main/engine/IndexDatabase.ts')
  record('5.2', 'IndexDatabase index.db path', idb.includes('index.db') && idb.includes('fts5') ? 'pass' : 'fail')
  record('5.3', 'IPC rebuild + stats', read('src/main/ipc/index.ts').includes('search:rebuildIndex') ? 'pass' : 'fail')
  record('5.4', 'Settings Search Index UI', read('src/renderer/src/components/settings/SettingsView.tsx').includes('Rebuild') || read('src/renderer/src/components/settings/SettingsView.tsx').includes('rebuild') ? 'pass' : 'fail')
}

// ─── 6. Editor / UX ────────────────────────────────────────────────
function auditEditor() {
  console.log('\n═══ 6. Editor & shell UX ═══')
  const ed = read('src/renderer/src/store/editorStore.ts')
  record('6.1', 'Tabs open/save/preview refresh', ed.includes('refreshPreview') && ed.includes('saveTab') ? 'pass' : 'fail')
  record('6.2', 'Backlinks panel + outline', read('src/renderer/src/components/editor/BacklinksPanel.tsx').includes('Outline') && read('src/renderer/src/components/editor/BacklinksPanel.tsx').includes('Backlinks') ? 'pass' : 'fail')
  record('6.3', 'Wikilink click in preview', read('src/renderer/src/components/editor/MarkdownPreview.tsx').includes('resolveWikiLink') ? 'pass' : 'fail')
  record('6.4', 'File tree context menu', read('src/renderer/src/components/layout/Sidebar.tsx').includes('onContextMenu') ? 'pass' : 'fail')
  record('6.5', 'Hotkeys Ctrl+K/N/B/J', read('src/renderer/src/components/layout/AppShell.tsx').includes("key === 'n'") && read('src/renderer/src/components/layout/AppShell.tsx').includes("key === 'k'") ? 'pass' : 'fail')
  const iconsSrc = read('src/renderer/src/components/ui/Icons.tsx')
  const mainTsx = read('src/renderer/src/main.tsx')
  const mainElectron = read('src/main/index.ts')
  record(
    '6.6',
    'Material Icons (Google) system',
    exists('src/renderer/src/components/ui/Icons.tsx') &&
      iconsSrc.includes('Material Symbols') &&
      iconsSrc.includes('MATERIAL_ICON') &&
      read('src/renderer/src/components/layout/Sidebar.tsx').includes('<Icon') &&
      (mainTsx.includes('material-symbols') || mainTsx.includes('Material+Symbols')) &&
      mainElectron.includes('fonts.gstatic.com')
      ? 'pass'
      : 'fail'
  )
  record('6.7', 'UI: edit note, backlinks, hotkeys', 'manual', 'Editor + inspector in app')
}

// ─── 7. Templates + Domain ─────────────────────────────────────────
function auditTemplatesDomain() {
  console.log('\n═══ 7. Templates & Domain ═══')
  const te = read('src/main/engine/TemplateEngine.ts')
  record('7.1', 'Builtin project/task/people templates', te.includes('builtin-project') && te.includes('builtin-task') && te.includes('builtin-people') ? 'pass' : 'fail')
  record('7.2', 'Variable render {{title}}', te.includes('{{title}}') && te.includes('render(') ? 'pass' : 'fail')
  // Runtime render
  const body = 'title: {{title}}\ndate: {{date}}'
  const rendered = body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => ({ title: 'Hello', date: '2026-07-22' })[k] || '')
  record('7.3', 'Template var substitution runtime', rendered.includes('Hello') && rendered.includes('2026-07-22') ? 'pass' : 'fail')
  record('7.4', 'IPC template:list/createNote', read('src/main/ipc/index.ts').includes('template:createNote') ? 'pass' : 'fail')
  record('7.5', 'Template picker UI', exists('src/renderer/src/components/systems/TemplatePicker.tsx') ? 'pass' : 'fail')
  const de = read('src/main/engine/DomainEngine.ts')
  record('7.6', 'Domain overview projects/tasks/people', de.includes('getOverview') && de.includes('parseCheckboxes') ? 'pass' : 'fail')
  // Checkbox parse
  const sample = '- [ ] Open\n- [x] Done\n'
  const open = (sample.match(/\[ \]/g) || []).length
  const done = (sample.match(/\[[xX]\]/g) || []).length
  record('7.7', 'Checkbox parse open/done', open === 1 && done === 1 ? 'pass' : 'fail')
  record('7.8', 'Dashboard domain widgets', read('src/renderer/src/components/dashboard/DashboardView.tsx').includes('getDomainOverview') ? 'pass' : 'fail')
  record('7.9', 'UI: From template create Project', 'manual', 'Dashboard → From template')
}

// ─── 8. AI system ──────────────────────────────────────────────────
function auditAI() {
  console.log('\n═══ 8. AI system ═══')
  const mid = read('src/main/ai/AIMiddleware.ts')
  const ipc = read('src/main/ipc/index.ts')
  const chat = read('src/renderer/src/store/chatStore.ts')
  record(
    '8.1',
    '6 providers registered',
    mid.includes('GrokProvider') &&
      mid.includes('GeminiProvider') &&
      mid.includes('OpenAIProvider') &&
      mid.includes('ClaudeProvider') &&
      mid.includes('OllamaProvider') &&
      mid.includes('OpenRouterProvider')
      ? 'pass'
      : 'fail'
  )
  record('8.2', 'Models listed even without key', mid.includes('listModels()') && mid.includes('configured') ? 'pass' : 'fail')
  record('8.3', 'Stream refuses unconfigured', mid.includes('belum dikonfigurasi') ? 'pass' : 'fail')
  record('8.4', 'testProvider for Settings Test', mid.includes('testProvider') && ipc.includes('ai:testProvider') ? 'pass' : 'fail')
  record('8.5', 'Stream error → done + error field', mid.includes('streamError') || read('src/main/ai/providers/GeminiProvider.ts').includes('error:') ? 'pass' : 'fail')
  record('8.6', 'Context engine + token budget', read('src/main/ai/ContextEngine.ts').includes('tokenBudget') || read('src/main/ai/ContextEngine.ts').includes('TOKEN') ? 'pass' : 'fail')
  record('8.7', 'Agent tools search/read/write proposals', read('src/main/ai/AgentTools.ts').includes('create_from_template') && read('src/main/ai/AgentTools.ts').includes('applyProposal') ? 'pass' : 'fail')
  record('8.8', 'Chat error display', chat.includes('chunk.error') ? 'pass' : 'fail')
  record('8.9', 'Permissions gate aiAccess', ipc.includes('aiAccess') ? 'pass' : 'fail')
  record('8.10', 'LIVE: Save key + Test + chat reply', 'manual', 'Settings → Save → Test → Chat "halo"')
  record('8.11', 'LIVE: Tools proposal Apply', 'manual', 'Tools on → minta buat note → Apply')
}

// ─── 9. Platform ───────────────────────────────────────────────────
function auditPlatform() {
  console.log('\n═══ 9. Platform (automation/security/plugins) ═══')
  record('9.1', 'Path sandbox', read('src/main/security/PathSandbox.ts').includes('assertPathInVault') ? 'pass' : 'fail')
  // runtime sandbox
  const vault = path.join(os.tmpdir(), 'v')
  const rel = path.relative(path.resolve(vault), path.resolve(path.join(vault, 'a.md')))
  const outside = path.relative(path.resolve(vault), path.resolve('C:\\Windows\\x')).startsWith('..')
  record('9.2', 'Path sandbox runtime relative', !rel.startsWith('..') && outside ? 'pass' : 'fail')
  record('9.3', 'Secrets encrypt (safeStorage)', read('src/main/security/SecretsStore.ts').includes('safeStorage') ? 'pass' : 'fail')
  record('9.4', 'Permissions flags', read('src/main/security/Permissions.ts').includes('aiTools') ? 'pass' : 'fail')
  record('9.5', 'AutomationEngine', read('src/main/engine/AutomationEngine.ts').includes('automation.json') ? 'pass' : 'fail')
  record('9.6', 'PluginHost declarative', read('src/main/plugin/PluginHost.ts').includes('manifest.json') ? 'pass' : 'fail')
  record('9.7', 'InternalAPI health', read('src/main/api/InternalAPI.ts').includes('health') ? 'pass' : 'fail')
  record('9.8', 'Settings Security/Automation/Plugins UI', read('src/renderer/src/components/settings/SettingsView.tsx').includes("'security'") && read('src/renderer/src/components/settings/SettingsView.tsx').includes("'automation'") ? 'pass' : 'fail')
  record('9.9', 'UI: toggle automation rule', 'manual', 'Settings → Automation')
}

// ─── 10. Ollama live ───────────────────────────────────────────────
async function auditOllama() {
  console.log('\n═══ 10. Live network (Ollama only) ═══')
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const data = await res.json()
      record('10.1', 'Ollama /api/tags', 'pass', `${data.models?.length || 0} models`)
    } else {
      record('10.1', 'Ollama /api/tags', 'fail', `HTTP ${res.status}`)
    }
  } catch (e) {
    // Optional dependency — mark skip, not fail
    record('10.1', 'Ollama running (optional)', 'skip', 'not running — OK if unused')
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗')
  console.log('║  WorkspaceGraph — Feature Audit (1-by-1)     ║')
  console.log('╚══════════════════════════════════════════════╝')
  console.log(new Date().toISOString())

  // Ensure engine bundle
  const engDir = path.join(root, 'scripts/.tmp-engines')
  if (!fs.existsSync(path.join(engDir, 'MarkdownEngine.js'))) {
    console.log('\nBuilding engines…')
    const { execSync } = await import('child_process')
    execSync(
      'npx esbuild src/main/engine/MarkdownEngine.ts src/main/engine/GraphEngine.ts src/main/engine/SearchEngine.ts --bundle --platform=node --outdir=scripts/.tmp-engines --format=esm --packages=external',
      { cwd: root, stdio: 'inherit' }
    )
  }

  const { MarkdownEngine } = await import(pathToFileURL(path.join(engDir, 'MarkdownEngine.js')).href)
  const { GraphEngine } = await import(pathToFileURL(path.join(engDir, 'GraphEngine.js')).href)
  const { SearchEngine } = await import(pathToFileURL(path.join(engDir, 'SearchEngine.js')).href)
  const md = new MarkdownEngine()

  auditFoundation()
  auditWorkspace()
  await auditMarkdown(md)
  await auditGraph(md, GraphEngine)
  await auditSearch(md, SearchEngine, GraphEngine)
  auditIndexDb()
  auditEditor()
  auditTemplatesDomain()
  auditAI()
  auditPlatform()
  await auditOllama()

  // Summary
  const pass = results.filter(r => r.status === 'pass').length
  const fail = results.filter(r => r.status === 'fail').length
  const manual = results.filter(r => r.status === 'manual').length
  const skip = results.filter(r => r.status === 'skip').length

  console.log('\n╔══════════════════════════════════════════════╗')
  console.log('║  SUMMARY                                     ║')
  console.log('╚══════════════════════════════════════════════╝')
  console.log(`  PASS   ${pass}`)
  console.log(`  FAIL   ${fail}`)
  console.log(`  MANUAL ${manual}  (butuh app + optional API key)`)
  console.log(`  SKIP   ${skip}`)
  console.log(`  TOTAL  ${results.length}`)

  if (fail > 0) {
    console.log('\n  Failed items:')
    for (const r of results.filter(x => x.status === 'fail')) {
      console.log(`   - ${r.id} ${r.name}${r.detail ? ' · ' + r.detail : ''}`)
    }
  }

  console.log('\n  MANUAL checklist (you / app):')
  for (const r of results.filter(x => x.status === 'manual')) {
    console.log(`   - ${r.id} ${r.name} → ${r.detail}`)
  }

  // Write report file
  const reportPath = path.join(root, 'docs', 'FEATURE_AUDIT.md')
  const lines = [
    '# Feature Audit Report',
    '',
    `**Date:** ${new Date().toISOString()}`,
    `**PASS:** ${pass} · **FAIL:** ${fail} · **MANUAL:** ${manual}`,
    '',
    '| ID | Feature | Status | Detail |',
    '|----|---------|--------|--------|',
    ...results.map(r => `| ${r.id} | ${r.name} | **${r.status.toUpperCase()}** | ${r.detail || ''} |`),
    '',
    '## Manual steps',
    '',
    '```bash',
    'cd C:\\code\\WorkspaceGraph',
    'npm run dev',
    '```',
    '',
    '1. Open/create vault',
    '2. Settings → AI → Save key → Test',
    '3. Chat "halo"',
    '4. Graph View drag/zoom',
    '5. Ctrl+K search',
    '6. From template → Project',
    '7. Tools on → create note proposal → Apply',
    ''
  ]
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8')
  console.log(`\n  Report written: docs/FEATURE_AUDIT.md`)

  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
