/**
 * AI Providers audit — static contracts + optional live pings
 * Run: node scripts/qa-ai-providers.mjs
 * Live Grok: uses ~/.grok/auth.json if present
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const require = createRequire(import.meta.url)

let pass = 0
let fail = 0
let skip = 0
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

function skipTest(id, reason) {
  skip++
  console.log(`  SKIP ${id} · ${reason}`)
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

console.log('\n═══ 1. Provider modules (static) ═══')
const PROVIDERS = [
  ['grok', 'GrokProvider.ts'],
  ['gemini', 'GeminiProvider.ts'],
  ['openai', 'OpenAIProvider.ts'],
  ['claude', 'ClaudeProvider.ts'],
  ['ollama', 'OllamaProvider.ts'],
  ['openrouter', 'OpenRouterProvider.ts']
]

for (const [id, file] of PROVIDERS) {
  const p = path.join(root, 'src/main/ai/providers', file)
  ok(`file-${id}`, fs.existsSync(p))
  if (!fs.existsSync(p)) continue
  const src = fs.readFileSync(p, 'utf8')
  ok(`id-${id}`, src.includes(`readonly id = '${id}'`) || src.includes(`id = '${id}'`))
  ok(`implements-${id}`, src.includes('sendMessage') && src.includes('streamMessage') && src.includes('listModels'))
  ok(`health-${id}`, src.includes('healthCheck'))
  ok(`extends-${id}`, src.includes('extends BaseProvider'))
}

const base = read('src/main/ai/providers/BaseProvider.ts')
ok('base-isConfigured', base.includes('isConfigured()'))
ok('base-configure', base.includes('configure(config'))
ok('base-masked-key', base.includes('getApiKeyMasked'))

console.log('\n═══ 2. Middleware registration ═══')
const mid = read('src/main/ai/AIMiddleware.ts')
ok('mid-registers-grok', mid.includes('GrokProvider') && mid.includes("providers.set(grok.id"))
ok('mid-registers-gemini', mid.includes('GeminiProvider') && mid.includes('gemini.id'))
ok('mid-registers-openai', mid.includes('OpenAIProvider') && mid.includes('openai.id'))
ok('mid-registers-claude', mid.includes('ClaudeProvider') && mid.includes('claude.id'))
ok('mid-registers-ollama', mid.includes('OllamaProvider') && mid.includes('ollama.id'))
ok('mid-registers-openrouter', mid.includes('OpenRouterProvider') && mid.includes('openrouter.id'))
ok('mid-default-active-grok', mid.includes("activeProviderId: string = 'grok'"))
ok('mid-testProvider', mid.includes('async testProvider'))
ok('mid-importGrok', mid.includes('importGrokFromCli'))
ok('mid-getAllStatus', mid.includes('getAllProvidersStatus'))
ok('mid-stream-tools', mid.includes('enableTools') && mid.includes('MAX_TOOL_ROUNDS'))
ok('mid-cancel', mid.includes('cancelStream'))
ok('mid-api-xai-not-proxy', mid.includes('api.x.ai') || read('src/main/ai/providers/GrokProvider.ts').includes('api.x.ai'))

const grokSrc = read('src/main/ai/providers/GrokProvider.ts')
ok('grok-official-api', grokSrc.includes("OFFICIAL_BASE = 'https://api.x.ai/v1'"))
ok('grok-avoids-426-proxy', grokSrc.includes('cli-chat-proxy') && grokSrc.includes('426'))
ok('grok-cli-import', grokSrc.includes('importGrokCliAuth') && grokSrc.includes('auth.json'))
ok('grok-refresh-oidc', grokSrc.includes('refresh_token') || grokSrc.includes('loadFreshCliSession'))
ok('grok-ensureSession', grokSrc.includes('ensureSession'))

const gem = read('src/main/ai/providers/GeminiProvider.ts')
ok('gemini-flash-default', gem.includes('gemini-2.0-flash') || gem.includes('flash'))
ok('gemini-429-message', gem.includes('429') || gem.includes('RESOURCE_EXHAUSTED'))

const ollama = read('src/main/ai/providers/OllamaProvider.ts')
ok('ollama-localhost', ollama.includes('11434'))
ok('ollama-no-key-required', ollama.includes("id === 'ollama'") || base.includes("id === 'ollama'"))

console.log('\n═══ 3. IPC / preload / Settings UI ═══')
const ipc = read('src/main/ipc/index.ts')
for (const h of [
  'ai:getProviders',
  'ai:testProvider',
  'ai:importGrokCli',
  'ai:configure',
  'ai:setActiveProvider',
  'ai:sendMessage',
  'ai:streamMessage',
  'ai:cancelStream'
]) {
  ok(`ipc-${h}`, ipc.includes(`'${h}'`))
}
ok('ipc-loadSettingsIntoProviders', ipc.includes('loadSettingsIntoProviders'))
ok('ipc-aiAccess-gate', ipc.includes('aiAccess') || ipc.includes('perms.aiAccess'))

const pre = read('src/preload/index.ts')
for (const fn of [
  'getAIProviders',
  'testAIProvider',
  'importGrokCli',
  'configureAIProvider',
  'setActiveAIProvider',
  'streamAIMessage',
  'cancelAIStream'
]) {
  ok(`preload-${fn}`, pre.includes(fn))
}

const settings = read('src/renderer/src/components/settings/SettingsView.tsx')
ok('ui-getProviders', settings.includes('getAIProviders'))
ok('ui-test', settings.includes('testAIProvider') || settings.includes('Test'))
ok('ui-import-grok', settings.includes('importGrokCli'))
ok('ui-configure', settings.includes('configureAIProvider') || settings.includes('configure'))
ok('ui-provider-list', settings.includes('provider') || settings.includes('Provider'))

const chat = read('src/renderer/src/store/chatStore.ts')
ok('chat-stream', chat.includes('streamAIMessage') || chat.includes('streamMessage'))
ok('chat-provider-model', chat.includes('provider') || chat.includes('activeProvider') || chat.includes('model'))
ok('chat-error-display', chat.includes('error') || read('src/renderer/src/components/chat/ChatPanel.tsx').includes('error'))

console.log('\n═══ 4. Secrets / permissions ═══')
const secrets = read('src/main/security/SecretsStore.ts')
ok('secrets-encrypt-ai', secrets.includes('apiKey') || secrets.includes('encrypt'))
const perm = read('src/main/security/Permissions.ts')
ok('perm-aiAccess', perm.includes('aiAccess'))
ok('perm-aiTools', perm.includes('aiTools'))

console.log('\n═══ 5. Bundle GrokProvider (esbuild smoke) ═══')
const outDir = path.join(root, 'scripts/.tmp-ai')
fs.mkdirSync(outDir, { recursive: true })
try {
  execSync(
    `npx esbuild src/main/ai/providers/GrokProvider.ts --bundle --platform=node --outfile=scripts/.tmp-ai/GrokProvider.js --format=esm --packages=external`,
    { cwd: root, stdio: 'pipe' }
  )
  ok('esbuild-grok', fs.existsSync(path.join(outDir, 'GrokProvider.js')))
} catch (e) {
  const msg = e?.stderr?.toString?.() || (e instanceof Error ? e.message : String(e))
  ok('esbuild-grok', false, msg.slice(0, 200))
}

// Import Grok provider pure functions
console.log('\n═══ 6. Grok CLI auth (local) ═══')
const authPath = path.join(os.homedir(), '.grok', 'auth.json')
ok('grok-auth-file-exists', fs.existsSync(authPath), authPath)

/** Mirror GrokProvider.readCliSessionFromDisk for audit without full bundle */
function readCliSessionFromDiskLocal() {
  if (!fs.existsSync(authPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf-8'))
    const entries = Object.entries(raw).filter(
      ([k]) => String(k).includes('auth.x.ai') || String(k).includes('x.ai')
    )
    const list = entries.length > 0 ? entries : Object.entries(raw)
    let best = null
    let bestExp = 0
    for (const [, s] of list) {
      if (!s?.key) continue
      const exp = s.expires_at ? Date.parse(s.expires_at) : Date.now()
      if (!best || exp > bestExp) {
        best = s
        bestExp = exp
      }
    }
    return best
  } catch {
    return null
  }
}

let grokKey = null
let grokEmail = null
if (fs.existsSync(authPath)) {
  let imp = null
  try {
    if (fs.existsSync(path.join(outDir, 'GrokProvider.js'))) {
      const mod = await import(pathToFileURL(path.join(outDir, 'GrokProvider.js')).href + `?t=${Date.now()}`)
      imp = mod.importGrokCliAuth()
    }
  } catch (e) {
    console.log('  · bundle import failed, using disk parser:', e instanceof Error ? e.message : e)
  }
  if (!imp) {
    const session = readCliSessionFromDiskLocal()
    imp = session?.key
      ? { ok: true, apiKey: session.key, email: session.email, baseUrl: 'https://api.x.ai/v1' }
      : { ok: false, error: 'no key in auth.json' }
  }
  ok('grok-import-ok', imp.ok === true, imp.error || imp.email || '')
  ok('grok-import-key', Boolean(imp.apiKey), imp.apiKey ? `len=${imp.apiKey.length}` : 'no key')
  ok('grok-import-base-xai', !imp.baseUrl || imp.baseUrl.includes('api.x.ai'), imp.baseUrl || 'default')
  // Expiry diagnostic
  const sess = readCliSessionFromDiskLocal()
  if (sess?.expires_at) {
    const exp = Date.parse(sess.expires_at)
    const leftMin = Math.round((exp - Date.now()) / 60000)
    ok('grok-session-not-expired', exp > Date.now(), `expires_in=${leftMin}m · ${sess.expires_at}`)
  } else {
    skipTest('grok-session-not-expired', 'no expires_at field')
  }
  if (imp.ok && imp.apiKey) {
    grokKey = imp.apiKey
    grokEmail = imp.email
  }
} else {
  skipTest('grok-import-ok', 'no ~/.grok/auth.json')
  skipTest('grok-import-key', 'no auth')
  skipTest('grok-import-base-xai', 'no auth')
  skipTest('grok-session-not-expired', 'no auth')
}

console.log('\n═══ 7. Live connectivity ═══')

// Ollama
try {
  const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) })
  ok('live-ollama-up', r.ok, `status=${r.status}`)
} catch {
  skipTest('live-ollama-up', 'Ollama not running (optional)')
}

// Grok live ping
if (grokKey) {
  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${grokKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'WorkspaceGraph-QA/1.0'
      },
      body: JSON.stringify({
        model: 'grok-3-mini',
        max_tokens: 16,
        messages: [
          { role: 'system', content: 'Reply only OK' },
          { role: 'user', content: 'Reply with exactly: OK' }
        ]
      }),
      signal: AbortSignal.timeout(45000)
    })
    const text = await res.text()
    let sample = ''
    try {
      const j = JSON.parse(text)
      sample = j?.choices?.[0]?.message?.content || j?.error?.message || text.slice(0, 120)
    } catch {
      sample = text.slice(0, 120)
    }
    ok('live-grok-http', res.ok, `HTTP ${res.status} · ${String(sample).slice(0, 80)}`)
    if (res.ok) {
      ok('live-grok-content', /ok/i.test(String(sample)), String(sample).slice(0, 60))
    } else {
      // Auth/rate failures are environmental — record as fail with detail for user
      ok('live-grok-content', false, `API error: ${String(sample).slice(0, 160)}`)
    }
  } catch (e) {
    ok('live-grok-http', false, e instanceof Error ? e.message : String(e))
    skipTest('live-grok-content', 'request failed')
  }
} else {
  skipTest('live-grok-http', 'no Grok session key')
  skipTest('live-grok-content', 'no Grok session key')
}

// Gemini — only if env key
const gemKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
if (gemKey) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${gemKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply OK' }] }],
        generationConfig: { maxOutputTokens: 8 }
      }),
      signal: AbortSignal.timeout(30000)
    })
    ok('live-gemini', res.ok, `HTTP ${res.status}`)
  } catch (e) {
    ok('live-gemini', false, e instanceof Error ? e.message : String(e))
  }
} else {
  skipTest('live-gemini', 'no GEMINI_API_KEY env')
}

console.log(`\n═══ SUMMARY: ${pass} PASS · ${fail} FAIL · ${skip} SKIP ═══\n`)
if (fail > 0) {
  console.error(JSON.stringify(bugs, null, 2))
  process.exit(1)
}
console.log('AI_PROVIDERS_AUDIT_OK')
if (grokEmail) console.log('GROK_SESSION', grokEmail)
process.exit(0)
