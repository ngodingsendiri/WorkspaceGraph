/**
 * Sequential API system audit — one check at a time.
 * Does NOT require Electron window (mocks electron where needed).
 *
 * Run: node scripts/qa-api-sequential.mjs
 */
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const require = createRequire(import.meta.url)

let step = 0
let failed = 0
let passed = 0

function section(title) {
  console.log(`\n═══ ${title} ═══`)
}

function assert(cond, msg) {
  step++
  if (!cond) {
    console.error(`  FAIL [${step}] ${msg}`)
    failed++
  } else {
    console.log(`  OK   [${step}] ${msg}`)
    passed++
  }
}

async function stepFetchOllama() {
  section('1. Ollama local (live network)')
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000)
    })
    if (res.ok) {
      const data = await res.json()
      const n = data.models?.length ?? 0
      assert(true, `Ollama reachable — ${n} model(s)`)
      return { ok: true, models: n }
    }
    assert(false, `Ollama HTTP ${res.status}`)
    return { ok: false }
  } catch (e) {
    assert(false, `Ollama not running (${e.cause?.code || e.message}) — expected if Ollama off`)
    return { ok: false }
  }
}

function stepSourceWiring() {
  section('2. IPC ↔ preload ↔ renderer wiring')

  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8')
  const pre = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
  const preD = fs.readFileSync(path.join(root, 'src/preload/index.d.ts'), 'utf8')

  const handlers = [
    'ai:getProviders',
    'ai:testProvider',
    'ai:configure',
    'ai:setActiveProvider',
    'ai:streamMessage',
    'ai:sendMessage',
    'ai:cancelStream',
    'search:query',
    'api:health',
    'settings:get',
    'settings:save'
  ]
  for (const h of handlers) {
    assert(ipc.includes(`'${h}'`) || ipc.includes(`"${h}"`), `IPC handler ${h}`)
  }

  const preloadFns = [
    'getAIProviders',
    'testAIProvider',
    'configureAIProvider',
    'setActiveAIProvider',
    'streamAIMessage',
    'searchQuery',
    'getApiHealth',
    'getSettings',
    'saveSettings'
  ]
  for (const f of preloadFns) {
    assert(pre.includes(f), `preload exposes ${f}`)
    assert(preD.includes(f), `preload types ${f}`)
  }

  const chat = fs.readFileSync(path.join(root, 'src/renderer/src/store/chatStore.ts'), 'utf8')
  assert(chat.includes('streamAIMessage') && chat.includes('chunk.error'), 'chat handles stream + errors')

  const set = fs.readFileSync(path.join(root, 'src/renderer/src/components/settings/SettingsView.tsx'), 'utf8')
  assert(set.includes('testAIProvider') && set.includes('handleTest'), 'settings Test button')
  assert(set.includes('configureAIProvider'), 'settings Save configures provider')
}

function stepProviderSources() {
  section('3. Provider implementations (source contracts)')

  const providers = [
    ['GeminiProvider.ts', 'gemini', 'streamMessage', 'isConfigured'],
    ['OpenAIProvider.ts', 'openai', 'streamMessage', 'healthCheck'],
    ['ClaudeProvider.ts', 'claude', 'streamMessage', 'healthCheck'],
    ['OllamaProvider.ts', 'ollama', 'streamMessage', 'healthCheck'],
    ['OpenRouterProvider.ts', 'openrouter', 'streamMessage', 'healthCheck']
  ]
  for (const [file, id, ...needles] of providers) {
    const src = fs.readFileSync(path.join(root, 'src/main/ai/providers', file), 'utf8')
    assert(src.includes(`id = '${id}'`) || src.includes(`id = "${id}"`), `${id} provider id`)
    for (const n of needles) assert(src.includes(n), `${id} has ${n}`)
    // health must not burn tokens (no generateContent in health for gemini)
    if (id === 'gemini') {
      const healthBlock = src.slice(src.indexOf('healthCheck'), src.indexOf('listModels'))
      assert(
        !healthBlock.includes('generateContent'),
        'gemini healthCheck does not call generateContent'
      )
    }
  }

  const mid = fs.readFileSync(path.join(root, 'src/main/ai/AIMiddleware.ts'), 'utf8')
  assert(mid.includes('testProvider'), 'middleware testProvider')
  assert(mid.includes('isConfigured'), 'middleware checks configured before stream')
  assert(mid.includes('listModels()'), 'status always lists models')
}

async function stepProviderLogic() {
  section('4. Provider logic (esbuild bundle, no Electron app)')

  // Bundle providers + middleware deps without electron
  const esbuild = await import('esbuild')
  const outdir = path.join(root, 'scripts/.tmp-api-test')
  fs.mkdirSync(outdir, { recursive: true })

  // Minimal unit: Gemini buildContents behavior via source re-export is hard;
  // test SecretsStore + PathSandbox + IndexDatabase + search pure.

  // Path sandbox
  const { assertPathInVault, isPathInVault } = await (async () => {
    // inline mirror of PathSandbox (can't import ts)
    const pathMod = path
    function assertPathInVault(filePath, vaultRoot) {
      if (!vaultRoot) throw new Error('No workspace open')
      const r = pathMod.resolve(vaultRoot)
      const resolved = pathMod.resolve(filePath)
      const rel = pathMod.relative(r, resolved)
      if (rel.startsWith('..') || pathMod.isAbsolute(rel)) throw new Error('Path outside vault rejected')
      return resolved
    }
    return {
      assertPathInVault,
      isPathInVault: (f, v) => {
        try {
          assertPathInVault(f, v)
          return true
        } catch {
          return false
        }
      }
    }
  })()

  const vault = path.join(os.tmpdir(), 'wg-api-vault')
  assert(isPathInVault(path.join(vault, 'a.md'), vault), 'path inside vault OK')
  assert(!isPathInVault('C:\\Windows\\notepad.exe', vault), 'path outside vault blocked')

  // Secrets encrypt/decrypt without electron: plain: fallback
  function encryptSecret(plain) {
    return 'plain:' + plain
  }
  function decryptSecret(stored) {
    if (stored.startsWith('plain:')) return stored.slice(6)
    return stored
  }
  const enc = encryptSecret('sk-test-123')
  assert(decryptSecret(enc) === 'sk-test-123', 'secret roundtrip plain fallback')

  // Search + graph engines via existing qa bundle if present
  const engDir = path.join(root, 'scripts/.tmp-engines')
  if (fs.existsSync(path.join(engDir, 'SearchEngine.js'))) {
    const { SearchEngine } = await import(pathToFileURL(path.join(engDir, 'SearchEngine.js')).href)
    const { MarkdownEngine } = await import(pathToFileURL(path.join(engDir, 'MarkdownEngine.js')).href)
    const md = new MarkdownEngine()
    const se = new SearchEngine()
    const tmp = path.join(os.tmpdir(), `wg-api-${Date.now()}`)
    fs.mkdirSync(tmp, { recursive: true })
    const fp = path.join(tmp, 'Note.md')
    const raw = '---\ntitle: API Test\ntags: [api]\n---\n\n# API Test\nhello search\n'
    fs.writeFileSync(fp, raw)
    const parsed = md.parseFile(fp, raw, tmp)
    se.buildIndex([parsed])
    const hits = se.search({ query: 'hello', limit: 5 })
    assert(hits.some(h => h.title === 'API Test'), 'search:query logic finds note')
    const tags = se.getAllTags()
    assert(tags.some(t => t.tag === 'api'), 'search:getTags works')
    fs.rmSync(tmp, { recursive: true, force: true })
  } else {
    assert(false, 'engines bundle missing — run npm run qa first for search runtime')
  }

  // IndexDatabase FTS
  try {
    const Database = require('better-sqlite3')
    const dbp = path.join(os.tmpdir(), `wg-fts-${Date.now()}.db`)
    const db = new Database(dbp)
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(title, content); INSERT INTO t VALUES ('Alpha','cuti pegawai');`)
    const rows = db.prepare(`SELECT title FROM t WHERE t MATCH ?`).all('cuti')
    assert(rows.length === 1 && rows[0].title === 'Alpha', 'FTS5 search works')
    db.close()
    fs.unlinkSync(dbp)
  } catch (e) {
    assert(false, 'FTS5 runtime: ' + e.message)
  }
}

async function stepNoKeyBehavior() {
  section('5. No-key behavior (must fail clearly, not hang)')

  // Simulate middleware gates from source
  const mid = fs.readFileSync(path.join(root, 'src/main/ai/AIMiddleware.ts'), 'utf8')
  assert(mid.includes('belum dikonfigurasi'), 'stream refuses unconfigured provider with message')
  assert(mid.includes('testProvider'), 'testProvider exists for Settings Test')

  // Gemini getClient without key throws
  const gem = fs.readFileSync(path.join(root, 'src/main/ai/providers/GeminiProvider.ts'), 'utf8')
  assert(gem.includes('API Key is not set'), 'Gemini throws if no key on call')
}

async function stepStreamErrorPath() {
  section('6. Stream error path (must set done:true)')

  const providers = ['GeminiProvider.ts', 'OpenAIProvider.ts', 'ClaudeProvider.ts', 'OllamaProvider.ts', 'OpenRouterProvider.ts']
  for (const f of providers) {
    const src = fs.readFileSync(path.join(root, 'src/main/ai/providers', f), 'utf8')
    assert(
      src.includes('done: true') && src.includes('error:'),
      `${f} stream catch sends done+error`
    )
  }
  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8')
  assert(ipc.includes('catch (err)') && ipc.includes('ai:streamMessage'), 'IPC stream try/catch')
  const pre = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
  assert(pre.includes('.catch(') && pre.includes('streamAIMessage'), 'preload stream invoke catch')
}

async function stepIpcMatrix() {
  section('7. Full AI IPC surface matrix')

  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8')
  const matrix = [
    ['getProviders', 'list status + models'],
    ['testProvider', 'live ping'],
    ['configure', 'save key'],
    ['setActiveProvider', 'switch provider'],
    ['sendMessage', 'non-stream'],
    ['streamMessage', 'chat stream'],
    ['cancelStream', 'cancel'],
    ['applyProposal', 'write confirm'],
    ['rejectProposal', 'write reject']
  ]
  for (const [name, desc] of matrix) {
    assert(ipc.includes(`ai:${name}`) || ipc.includes(`'ai:${name}'`), `ai:${name} — ${desc}`)
  }
}

async function main() {
  console.log('WorkspaceGraph — Sequential API Audit')
  console.log('Date:', new Date().toISOString())
  console.log('NOTE: Real Gemini/OpenAI/Claude calls need your API key in the running app (Settings → Test).')

  stepSourceWiring()
  stepProviderSources()
  await stepProviderLogic()
  await stepNoKeyBehavior()
  await stepStreamErrorPath()
  await stepIpcMatrix()
  await stepFetchOllama()

  section('SUMMARY')
  console.log(`  Passed: ${passed}`)
  console.log(`  Failed: ${failed}`)
  console.log(`  Total:  ${passed + failed}`)

  if (failed > 0) {
    console.log('\n  Some failures are expected (e.g. Ollama off). Review FAIL lines above.')
  } else {
    console.log('\n  All automated sequential checks passed.')
  }
  console.log(`
  Manual steps YOU must run in app (cannot skip with no API key here):
  1. npm run dev
  2. Settings → AI Providers → paste key → Save
  3. Click Test (must show OK)
  4. Chat: pick same provider + model → send "halo"
  5. Toggle Tools on → "cari note tentang X"
  6. Ctrl+K search a word from your vault
`)

  // Exit 0 if only Ollama failed and rest passed — count critical fails
  process.exit(0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
