import WebSocket from 'ws'
import fs from 'fs'

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('no page')
  process.exit(1)
}
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
    setTimeout(() => reject(new Error('timeout ' + method)), 12000)
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
    console.error('eval error', r.result.exceptionDetails?.exception?.description || r.result.exceptionDetails)
  }
  return r.result?.result?.value
}

// Click recent vault "D:\\Obs\\Obs"
const openVault = await evalExpr(`(() => {
  const all = [...document.querySelectorAll('button, a, div, span, li, p')]
  // Prefer exact path text
  let el = all.find(e => (e.textContent || '').trim() === 'D:\\\\Obs\\\\Obs' || (e.textContent || '').trim() === 'D:\\\\Obs\\\\Obs')
  if (!el) el = all.find(e => /D:\\\\Obs\\\\Obs|D:\\/Obs\\/Obs/.test(e.textContent || '') && (e.textContent||'').length < 40)
  if (!el) {
    // click RECENT item labeled Obs that is under recent list
    const recent = all.filter(e => (e.textContent || '').trim() === 'Obs')
    el = recent[0]
  }
  if (!el) return { ok:false, sample: all.slice(0,30).map(e => (e.textContent||'').trim().slice(0,40)) }
  el.click()
  // also try parent
  el.parentElement?.click?.()
  return { ok:true, text: (el.textContent||'').trim().slice(0,60), tag: el.tagName }
})()`)
console.log('OPEN', JSON.stringify(openVault, null, 2))

// Wait for vault boot
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500))
  const st = await evalExpr(`({
    title: document.title,
    hasGraphNav: /Graph View/i.test(document.body?.innerText || ''),
    hasFiles: /FILES|Inbox|Dashboard/i.test(document.body?.innerText || ''),
    body: (document.body?.innerText || '').slice(0, 200)
  })`)
  console.log('boot', i, st?.title, st?.hasGraphNav, st?.hasFiles)
  if (st?.hasGraphNav) break
}

const clickGraph = await evalExpr(`(() => {
  const all = [...document.querySelectorAll('button, a, div, span, li')]
  const g = all.find(e => {
    const t = (e.textContent || '').replace(/\\s+/g,' ').trim()
    return t === 'Graph View' || t.endsWith('Graph View') && t.length < 30
  })
  if (!g) return 'not-found'
  g.click()
  return 'ok:' + (g.textContent||'').trim()
})()`)
console.log('GRAPH', clickGraph)

await new Promise((r) => setTimeout(r, 3500))

const info = await evalExpr(`({
  title: document.title,
  hasCanvas: !!document.querySelector('canvas.graph-canvas'),
  canvasW: document.querySelector('canvas.graph-canvas')?.width || 0,
  canvasH: document.querySelector('canvas.graph-canvas')?.height || 0,
  clientW: document.querySelector('canvas.graph-canvas')?.clientWidth || 0,
  clientH: document.querySelector('canvas.graph-canvas')?.clientHeight || 0,
  graphStats: document.querySelector('.graph-toolbar-stats')?.textContent || null,
  filterChip: document.querySelector('.graph-filter-live-chip')?.textContent || null,
  diag: document.querySelector('.graph-diag-banner')?.textContent || null,
  empty: document.querySelector('.graph-empty')?.textContent || null,
  bodySlice: (document.body?.innerText || '').slice(0, 600)
})`)
console.log('INFO', JSON.stringify(info, null, 2))

// Sample canvas pixels for non-black content
const pixels = await evalExpr(`(() => {
  const c = document.querySelector('canvas.graph-canvas')
  if (!c) return null
  const ctx = c.getContext('2d')
  const samples = []
  const pts = [[0.5,0.5],[0.3,0.4],[0.7,0.4],[0.5,0.3],[0.2,0.2],[0.8,0.8]]
  for (const [fx,fy] of pts) {
    const x = Math.floor(c.width * fx), y = Math.floor(c.height * fy)
    const d = ctx.getImageData(x,y,1,1).data
    samples.push([d[0],d[1],d[2],d[3]])
  }
  // count non-dark pixels in a grid
  let nonDark = 0, total = 0
  for (let y = 0; y < c.height; y += 20) {
    for (let x = 0; x < c.width; x += 20) {
      const d = ctx.getImageData(x,y,1,1).data
      total++
      if (d[0]+d[1]+d[2] > 40) nonDark++
    }
  }
  return { samples, nonDark, total, ratio: nonDark/total }
})()`)
console.log('PIXELS', JSON.stringify(pixels, null, 2))

try {
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const b64 = shot.result?.value
  if (b64) {
    const buf = Buffer.from(b64, 'base64')
    fs.writeFileSync('scripts/graph-screenshot.png', buf)
    console.log('screenshot', buf.length)
  } else {
    console.log('no screenshot data', JSON.stringify(shot).slice(0, 200))
  }
} catch (e) {
  console.error('shot fail', e)
}

ws.close()
process.exit(0)
