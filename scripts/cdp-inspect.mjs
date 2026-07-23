import WebSocket from 'ws'
import fs from 'fs'

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('no page', list)
  process.exit(1)
}
console.log('page', page.title, page.url)

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id
    const onMsg = (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id === mid) {
        ws.off('message', onMsg)
        resolve(msg)
      }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id: mid, method, params }))
    setTimeout(() => reject(new Error('timeout ' + method)), 8000)
  })
}

await new Promise((r) => ws.once('open', r))
await send('Runtime.enable')
await send('Page.enable')

const evalExpr = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result?.exceptionDetails) {
    console.error('eval error', JSON.stringify(r.result.exceptionDetails, null, 2))
  }
  return r.result?.result?.value
}

const info = await evalExpr(`({
  title: document.title,
  href: location.href,
  rootLen: (document.getElementById('root')?.innerHTML || '').length,
  bodyText: (document.body?.innerText || '').slice(0, 800),
  hasCanvas: !!document.querySelector('canvas.graph-canvas'),
  graphStats: document.querySelector('.graph-toolbar-stats')?.textContent || null,
  filterChip: document.querySelector('.graph-filter-live-chip')?.textContent || null,
  diag: document.querySelector('.graph-diag-banner')?.textContent || null,
  activeNav: document.querySelector('.nav-item.active, .sidebar-item.active, [aria-current]')?.textContent || null
})`)
console.log('INFO', JSON.stringify(info, null, 2))

// Try click Graph View via DOM
const clicked = await evalExpr(`(() => {
  const els = [...document.querySelectorAll('button, a, div, span, li')]
  const g = els.find(e => /Graph View/i.test(e.textContent || '') && (e.textContent||'').trim().length < 40)
  if (!g) return 'not-found'
  g.click()
  return 'clicked:' + (g.textContent||'').trim().slice(0,40)
})()`)
console.log('CLICK', clicked)

await new Promise((r) => setTimeout(r, 2500))

const info2 = await evalExpr(`({
  bodyText: (document.body?.innerText || '').slice(0, 1000),
  hasCanvas: !!document.querySelector('canvas.graph-canvas'),
  canvasW: document.querySelector('canvas.graph-canvas')?.width || 0,
  canvasH: document.querySelector('canvas.graph-canvas')?.height || 0,
  graphStats: document.querySelector('.graph-toolbar-stats')?.textContent || null,
  filterChip: document.querySelector('.graph-filter-live-chip')?.textContent || null,
  diag: document.querySelector('.graph-diag-banner')?.textContent || null,
  hudApprox: (() => {
    const c = document.querySelector('canvas.graph-canvas')
    if (!c) return null
    try {
      const ctx = c.getContext('2d')
      // sample center pixel
      const x = Math.floor(c.width/2), y = Math.floor(c.height/2)
      const d = ctx.getImageData(x, y, 1, 1).data
      return { centerRGBA: [d[0],d[1],d[2],d[3]], w:c.width, h:c.height }
    } catch(e) { return String(e) }
  })()
})`)
console.log('INFO2', JSON.stringify(info2, null, 2))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const buf = Buffer.from(shot.result.value, 'base64')
fs.writeFileSync('scripts/graph-screenshot.png', buf)
console.log('screenshot', buf.length)

ws.close()
process.exit(0)
