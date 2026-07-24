import WebSocket from 'ws'
import fs from 'fs'
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id
  const h = (d) => { const m = JSON.parse(d); if (m.id === mid) { ws.off('message', h); resolve(m) } }
  ws.on('message', h)
  ws.send(JSON.stringify({ id: mid, method, params }))
  setTimeout(() => reject(new Error(method)), 10000)
})
await new Promise(r => ws.once('open', r))
const r = await send('Runtime.evaluate', {
  expression: `({
    dots: document.querySelectorAll('.graph-dom-nodes .gdn').length,
    stage: !!document.querySelector('.graph-stage'),
    stageWH: (() => { const s = document.querySelector('.graph-stage'); return s ? { w: s.clientWidth, h: s.clientHeight } : null })(),
    stats: document.querySelector('.graph-toolbar-stats')?.textContent
  })`,
  returnByValue: true
})
console.log(JSON.stringify(r.result?.result?.value, null, 2))
ws.close()
