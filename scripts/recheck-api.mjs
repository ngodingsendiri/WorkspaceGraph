import { pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'

const bugs = []
const ok = (id, c, d='') => { if (!c) bugs.push({id,d}); else console.log(' OK', id, d) }

// Source regression checks for API fixes
const mid = fs.readFileSync('src/main/ai/AIMiddleware.ts','utf8')
ok('test-ensureSession', mid.includes('ensureSession'))
ok('cancel-after-stream', mid.includes('*(cancelled)*') && mid.includes('isCancelled(requestId)'))
const ipc = fs.readFileSync('src/main/ipc/index.ts','utf8')
ok('ai-access-error-field', ipc.includes("error: 'AI access disabled") || ipc.includes('AI access disabled in Settings'))
const chat = fs.readFileSync('src/renderer/src/store/chatStore.ts','utf8')
ok('no-double-error', chat.includes('already') || chat.includes('*(cancelled)*'))
const grok = fs.readFileSync('src/main/ai/providers/GrokProvider.ts','utf8')
ok('grok-maxTokens', grok.includes('max_tokens') && grok.includes('maxTokens'))
const oai = fs.readFileSync('src/main/ai/providers/OpenAIProvider.ts','utf8')
ok('openai-maxTokens', oai.includes('max_tokens'))
const gem = fs.readFileSync('src/main/ai/providers/GeminiProvider.ts','utf8')
ok('gemini-maxOut', gem.includes('maxOutputTokens'))

// Live Grok
const m = await import(pathToFileURL(path.resolve('scripts/.tmp-grok/GrokProvider.js')).href)
const { GrokProvider, importGrokCliAuth } = m
const imp = importGrokCliAuth()
ok('import', imp.ok, imp.email || imp.error || '')
ok('base-xai', (imp.baseUrl||'').includes('api.x.ai'), imp.baseUrl)
if (imp.ok) {
  const p = new GrokProvider()
  p.configure({ apiKey: imp.apiKey, baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-4.5', backend: 'chat', useCliSession: true })
  await p.ensureSession()
  const t0 = Date.now()
  const res = await p.sendMessage({ model: 'grok-4.5', messages: [{ role: 'user', content: 'Reply exactly: RECHECK_OK' }], systemPrompt: 'Reply only RECHECK_OK', maxTokens: 16 })
  ok('send', /RECHECK_OK/i.test(res.content||''), (res.content||'').slice(0,40)+' '+(Date.now()-t0)+'ms')
  let acc='', err=null, done=false
  await p.streamMessage({ model:'grok-4.5', messages:[{role:'user',content:'Say hi'}], maxTokens:12 }, c => { if(c.content)acc+=c.content; if(c.error)err=c.error; if(c.done)done=true })
  ok('stream', done && !err, acc.slice(0,40))
}

console.log(bugs.length ? 'BUGS '+JSON.stringify(bugs) : 'ALL_RECHECK_OK')
process.exit(bugs.length?1:0)
