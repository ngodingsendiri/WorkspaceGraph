import { pathToFileURL } from 'url'
import path from 'path'
const m = await import(pathToFileURL(path.resolve('scripts/.tmp-grok/GrokProvider.js')).href)
const { GrokProvider, importGrokCliAuth } = m
const imp = importGrokCliAuth()
console.log('IMPORT', JSON.stringify({ok:imp.ok, email:imp.email, base:imp.baseUrl}))
const p = new GrokProvider()
p.configure({apiKey:imp.apiKey, baseUrl:'https://api.x.ai/v1', defaultModel:'grok-4.5', backend:'chat', useCliSession:true})
await p.ensureSession()
const t0=Date.now()
const res = await p.sendMessage({model:'grok-4.5', messages:[{role:'user',content:'Reply exactly: API_OK'}], systemPrompt:'Reply only API_OK', maxTokens:16})
console.log('SEND', Date.now()-t0+'ms', JSON.stringify((res.content||'').slice(0,40)))
let acc='', err=null, done=false
await p.streamMessage({model:'grok-4.5', messages:[{role:'user',content:'Say ping'}], maxTokens:12}, c=>{ if(c.content)acc+=c.content; if(c.error)err=c.error; if(c.done)done=true })
console.log('STREAM', JSON.stringify({done, err, acc:acc.slice(0,50)}))
console.log(done && !err && /API_OK|OK/i.test(res.content||'') ? 'GROK_LIVE_OK' : 'GROK_LIVE_PARTIAL')
