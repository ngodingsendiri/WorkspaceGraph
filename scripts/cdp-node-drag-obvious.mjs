/**
 * Drag one node FAR into empty space so user can clearly see it on screen.
 */
import WebSocket from 'ws'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, 'node-drag-proof')
fs.mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page')
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
    setTimeout(() => rej(new Error(method)), 20000)
  })
await new Promise((r) => ws.once('open', r))
await send('Runtime.enable')
await send('Input.enable')
await send('Page.bringToFront').catch(() => {})

const E = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  return r.result?.result?.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(outDir, name), Buffer.from(r.result.data, 'base64'))
  console.log('shot', name)
}

console.log('=== Drag node JAUH ke area kosong (lihat layar) ===')
await E(`(() => {
  const g = [...document.querySelectorAll('.nav-item')].find(e => (e.innerText||'').toLowerCase().includes('graph'))
  if (g) g.click()
})()`)
await sleep(2000)

// Pick leftmost visible node (easier to drag left into empty)
const pick = await E(`(() => {
  const stage = document.querySelector('.graph-stage')
  const sr = stage.getBoundingClientRect()
  const circles = [...document.querySelectorAll('.graph-svg circle')].filter(c => {
    const r = Number(c.getAttribute('r')||0)
    return r >= 5 && r < 25
  })
  let best = null
  for (const c of circles) {
    const cx = Number(c.getAttribute('cx'))
    const cy = Number(c.getAttribute('cy'))
    if (cx < 80 || cy < 80 || cx > sr.width - 40 || cy > sr.height - 40) continue
    if (!best || cx < best.cx) best = { cx, cy, r: Number(c.getAttribute('r')), sx: sr.left + cx, sy: sr.top + cy }
  }
  return { best, stage: { x: sr.x, y: sr.y, w: sr.w || sr.width, h: sr.height } }
})()`)
console.log('pick leftmost', pick)
if (!pick?.best) {
  console.error('no node')
  process.exit(1)
}

const n = pick.best
const cam0 = await E(`window.__wgGraph.getTransform()`)
console.log('cam0', cam0)
await shot('03-before-obvious.png')

// Drag FAR left-up into empty void (slow)
const x0 = n.sx
const y0 = n.sy
const x1 = pick.stage.x + 80
const y1 = pick.stage.y + 100
console.log('DRAG NODE from cluster', x0.toFixed(0), y0.toFixed(0), '→ empty', x1, y1)

await send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: x0,
  y: y0,
  button: 'left',
  buttons: 1,
  clickCount: 1
})
for (let i = 1; i <= 50; i++) {
  const u = i / 50
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: x0 + (x1 - x0) * u,
    y: y0 + (y1 - y0) * u,
    button: 'left',
    buttons: 1
  })
  await sleep(35)
}
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: x1,
  y: y1,
  button: 'left',
  buttons: 0,
  clickCount: 1
})
await sleep(600)

const res = await E(`(() => {
  const stage = document.querySelector('.graph-stage')
  const sr = stage.getBoundingClientRect()
  const circles = [...document.querySelectorAll('.graph-svg circle')].filter(c => {
    const r = Number(c.getAttribute('r')||0)
    return r >= 5 && r < 25
  })
  // any circle near drop?
  let nearDrop = null
  let best = 1e9
  for (const c of circles) {
    const sx = sr.left + Number(c.getAttribute('cx'))
    const sy = sr.top + Number(c.getAttribute('cy'))
    const d = Math.hypot(sx - ${x1}, sy - ${y1})
    if (d < best) { best = d; nearDrop = { sx, sy, cx: Number(c.getAttribute('cx')), cy: Number(c.getAttribute('cy')), d } }
  }
  return {
    nearDrop,
    cam: window.__wgGraph.getTransform(),
    hud: document.querySelector('.graph-live-hud')?.textContent
  }
})()`)
console.log('result', JSON.stringify(res, null, 2))
await shot('04-after-obvious.png')

const cam1 = res.cam
const camSame =
  Math.abs(cam1.x - cam0.x) < 5 && Math.abs(cam1.y - cam0.y) < 5 && Math.abs(cam1.k - cam0.k) < 0.02
const nodeAtDrop = res.nearDrop && res.nearDrop.d < 40
console.log({ camSame, nodeAtDrop, dist: res.nearDrop?.d })
console.log(
  nodeAtDrop && camSame
    ? 'PASS: node pulled into empty space, camera fixed'
    : nodeAtDrop
      ? 'PARTIAL: node moved but camera also changed'
      : 'FAIL: node not at drop'
)
ws.close()
process.exit(nodeAtDrop ? 0 : 2)
