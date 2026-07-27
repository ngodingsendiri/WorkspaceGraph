/**
 * Visual pan test: open vault → Graph → drag with real mouse → screenshot before/after
 * + transform probe + snap-back wait
 */
import WebSocket from 'ws'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, 'pan-proof')
fs.mkdirSync(outDir, { recursive: true })

async function waitCdp(ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json')).json()
      if (list.some((t) => t.type === 'page')) return list
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('CDP not ready')
}

const list = await waitCdp()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('no page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const mid = ++id
    const h = (d) => {
      const x = JSON.parse(d.toString())
      if (x.id === mid) {
        ws.off('message', h)
        res(x)
      }
    }
    ws.on('message', h)
    ws.send(JSON.stringify({ id: mid, method, params }))
    setTimeout(() => rej(new Error('timeout ' + method)), 30000)
  })

await new Promise((r) => ws.once('open', r))
await send('Runtime.enable')
await send('Page.enable')
await send('Input.enable')

const E = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result?.exceptionDetails) {
    console.error('eval', r.result.exceptionDetails?.exception?.description)
    return null
  }
  return r.result?.result?.value
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const buf = Buffer.from(r.result.data, 'base64')
  const p = path.join(outDir, name)
  fs.writeFileSync(p, buf)
  console.log('shot', p, buf.length)
  return p
}

// Open vault
console.log(
  'vault',
  await E(`(() => {
  const b = [...document.querySelectorAll('button.nav-item,button')].find(el =>
    (el.innerText||'').includes('D:\\\\Obs\\\\Obs') || (el.innerText||'').includes('Obs\\\\Obs')
  )
  if (!b) return 'no-btn'
  b.click()
  return 'ok'
})()`)
)
await new Promise((r) => setTimeout(r, 4500))

// Graph
console.log(
  'graph',
  await E(`(() => {
  const g = [...document.querySelectorAll('.nav-item,button')].find(e =>
    (e.innerText||'').toLowerCase().includes('graph')
  )
  if (!g) return 'missing'
  g.click()
  return 'ok'
})()`)
)
await new Promise((r) => setTimeout(r, 4500))

// Wait for circles
for (let i = 0; i < 20; i++) {
  const n = await E(`document.querySelectorAll('.graph-svg circle,.graph-svg polygon').length`)
  console.log('circles', n)
  if (n > 5) break
  await new Promise((r) => setTimeout(r, 300))
}

const stage = await E(`(() => {
  const s = document.querySelector('.graph-stage')
  if (!s) return null
  const r = s.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, hasZoom: !!(window.__wgGraph) }
})()`)
console.log('stage', stage)
if (!stage || stage.w < 50) {
  console.error('FAIL no stage')
  process.exit(1)
}

const tBefore = await E(`window.__wgGraph ? window.__wgGraph.getTransform() : null`)
const hudBefore = await E(`document.querySelector('.graph-live-hud')?.textContent || ''`)
console.log('BEFORE transform', tBefore)
console.log('BEFORE hud', hudBefore)
await shot('01-before-pan.png')

// Real mouse drag across empty top-left of stage
const x0 = stage.x + 28
const y0 = stage.y + 28
console.log('drag from', x0, y0, 'to', x0 + 280, y0 + 160)

await send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: x0,
  y: y0,
  button: 'left',
  buttons: 1,
  clickCount: 1
})
for (let i = 1; i <= 28; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: x0 + i * 10,
    y: y0 + i * 6,
    button: 'left',
    buttons: 1
  })
  if (i % 7 === 0) await new Promise((r) => setTimeout(r, 16))
}
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: x0 + 280,
  y: y0 + 160,
  button: 'left',
  buttons: 0,
  clickCount: 1
})
await new Promise((r) => setTimeout(r, 400))

const tAfter = await E(`window.__wgGraph ? window.__wgGraph.getTransform() : null`)
const hudAfter = await E(`document.querySelector('.graph-live-hud')?.textContent || ''`)
console.log('AFTER transform', tAfter)
console.log('AFTER hud', hudAfter)
await shot('02-after-pan.png')

// Second pan with __wgGraph
await E(`window.__wgGraph && window.__wgGraph.panBy(150, 90)`)
await new Promise((r) => setTimeout(r, 200))
const tPanBy = await E(`window.__wgGraph ? window.__wgGraph.getTransform() : null`)
console.log('AFTER panBy', tPanBy)
await shot('03-after-panBy.png')

// Snap-back check
await new Promise((r) => setTimeout(r, 4000))
const tWait = await E(`window.__wgGraph ? window.__wgGraph.getTransform() : null`)
console.log('AFTER 4s wait', tWait)
await shot('04-after-wait.png')

const dx = tAfter && tBefore ? tAfter.x - tBefore.x : 0
const dy = tAfter && tBefore ? tAfter.y - tBefore.y : 0
const mouseMoved = Math.hypot(dx, dy) > 40
const panByMoved =
  tPanBy && tAfter && (Math.abs(tPanBy.x - tAfter.x) > 40 || Math.abs(tPanBy.y - tAfter.y) > 40)
const stable =
  tWait &&
  tPanBy &&
  Math.abs(tWait.x - tPanBy.x) < 3 &&
  Math.abs(tWait.y - tPanBy.y) < 3

console.log({ dx, dy, mouseMoved, panByMoved, stable, hasProbe: !!tBefore })
console.log(
  mouseMoved && panByMoved && stable
    ? 'PASS: I dragged the graph; camera moved and stayed'
    : 'FAIL: pan did not stick or did not move'
)
console.log('proof images in', outDir)
ws.close()
process.exit(mouseMoved && panByMoved && stable ? 0 : 2)
