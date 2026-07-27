/**
 * Live demo: drag individual note NODES (dots), not camera pan.
 */
import WebSocket from 'ws'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, 'node-drag-proof')
fs.mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitCdp(ms = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json')).json()
      if (list.some((t) => t.type === 'page')) return list
    } catch {
      /* */
    }
    await sleep(400)
  }
  throw new Error('CDP not ready')
}

const list = await waitCdp()
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
    setTimeout(() => rej(new Error(method)), 25000)
  })

await new Promise((r) => ws.once('open', r))
await send('Runtime.enable')
await send('Input.enable')
await send('Page.enable')
await send('Page.bringToFront').catch(() => {})

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
  const p = path.join(outDir, name)
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'))
  console.log('shot', name)
}

console.log('=== DEMO: drag TITIK CATATAN (node), bukan pan kamera ===')

// Ensure graph open
await E(`(() => {
  const b = [...document.querySelectorAll('button.nav-item,button')].find(el =>
    (el.innerText||'').includes('D:\\\\Obs\\\\Obs')
  )
  if (b) b.click()
})()`)
await sleep(3000)
await E(`(() => {
  const g = [...document.querySelectorAll('.nav-item')].find(e =>
    (e.innerText||'').toLowerCase().includes('graph')
  )
  if (g) g.click()
})()`)
await sleep(4000)

// Pick a circle near center of stage (a real node on screen)
const pick = await E(`(() => {
  const stage = document.querySelector('.graph-stage')
  if (!stage) return { err: 'no stage' }
  const sr = stage.getBoundingClientRect()
  const circles = [...document.querySelectorAll('.graph-svg circle')].filter(c => {
    const r = Number(c.getAttribute('r')||0)
    return r >= 4 && r < 40 // real nodes, not selection ring
  })
  if (!circles.length) return { err: 'no circles', n: 0 }
  // Prefer circle closest to stage center
  const cx = sr.left + sr.width / 2
  const cy = sr.top + sr.height / 2
  let best = null
  let bestD = Infinity
  for (const c of circles) {
    const x = Number(c.getAttribute('cx'))
    const y = Number(c.getAttribute('cy'))
    // SVG coords are already screen-space in this app (paint applies transform)
    const d = (x - sr.width/2)**2 + (y - sr.height/2)**2
    if (d < bestD) {
      bestD = d
      best = { x: sr.left + x, y: sr.top + y, cx: x, cy: y, r: Number(c.getAttribute('r')), fill: c.getAttribute('fill') }
    }
  }
  // Also sample top 3 positions for proof
  const sample = circles.slice(0, 5).map(c => ({
    cx: Number(c.getAttribute('cx')),
    cy: Number(c.getAttribute('cy')),
    r: Number(c.getAttribute('r'))
  }))
  return { best, sample, stage: { x: sr.x, y: sr.y, w: sr.width, h: sr.height }, count: circles.length }
})()`)
console.log('pick', JSON.stringify(pick))

if (!pick?.best) {
  console.error('FAIL: no node to drag')
  process.exit(1)
}

const node = pick.best
console.log('target node screen', node.x, node.y, 'svg', node.cx, node.cy)
await shot('01-before-node-drag.png')

const beforePos = { cx: node.cx, cy: node.cy }
const cam0 = await E(`window.__wgGraph ? window.__wgGraph.getTransform() : null`)
console.log('camera before', cam0)

// Drag THIS node ~150px down-right (slow so user sees)
const x0 = node.x
const y0 = node.y
const x1 = x0 + 160
const y1 = y0 + 120
console.log('>>> DRAG NODE', x0, y0, '→', x1, y1)

await send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: x0,
  y: y0,
  button: 'left',
  buttons: 1,
  clickCount: 1
})
for (let i = 1; i <= 40; i++) {
  const u = i / 40
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: x0 + (x1 - x0) * u,
    y: y0 + (y1 - y0) * u,
    button: 'left',
    buttons: 1
  })
  await sleep(28)
}
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: x1,
  y: y1,
  button: 'left',
  buttons: 0,
  clickCount: 1
})
await sleep(500)

const after = await E(`(() => {
  const stage = document.querySelector('.graph-stage')
  const sr = stage.getBoundingClientRect()
  // Find circle nearest to drop point in screen space
  const dropX = ${x1}
  const dropY = ${y1}
  const circles = [...document.querySelectorAll('.graph-svg circle')].filter(c => {
    const r = Number(c.getAttribute('r')||0)
    return r >= 4 && r < 40
  })
  let nearest = null
  let bestD = Infinity
  for (const c of circles) {
    const sx = sr.left + Number(c.getAttribute('cx'))
    const sy = sr.top + Number(c.getAttribute('cy'))
    const d = (sx - dropX)**2 + (sy - dropY)**2
    if (d < bestD) {
      bestD = d
      nearest = {
        cx: Number(c.getAttribute('cx')),
        cy: Number(c.getAttribute('cy')),
        screenX: sx,
        screenY: sy,
        distToDrop: Math.sqrt(d)
      }
    }
  }
  // Also: circle closest to original position
  let atOld = null
  bestD = Infinity
  const ox = ${beforePos.cx}, oy = ${beforePos.cy}
  for (const c of circles) {
    const cx = Number(c.getAttribute('cx'))
    const cy = Number(c.getAttribute('cy'))
    const d = (cx - ox)**2 + (cy - oy)**2
    if (d < bestD) {
      bestD = d
      atOld = { cx, cy, d: Math.sqrt(d) }
    }
  }
  return {
    nearest,
    atOld,
    cam: window.__wgGraph ? window.__wgGraph.getTransform() : null,
    hud: document.querySelector('.graph-live-hud')?.textContent || ''
  }
})()`)
console.log('after drag', JSON.stringify(after, null, 2))
await shot('02-after-node-drag.png')

const cam1 = after?.cam
const camMoved =
  cam0 && cam1 && (Math.abs(cam1.x - cam0.x) > 20 || Math.abs(cam1.y - cam0.y) > 20)
// Node drag success: a circle is near the drop point (within ~40px) OR old position emptied
const nodeMoved =
  after?.nearest && after.nearest.distToDrop < 50
    ? true
    : after?.atOld && after.atOld.d > 40

console.log({
  camMoved,
  nodeMoved,
  distToDrop: after?.nearest?.distToDrop,
  oldPosShift: after?.atOld?.d
})

if (nodeMoved && !camMoved) {
  console.log('PASS: node moved, camera stayed (true node drag)')
} else if (nodeMoved && camMoved) {
  console.log('MIXED: something moved but camera also changed (might have panned)')
} else if (!nodeMoved && camMoved) {
  console.log('FAIL: only camera panned — node did not drag')
} else {
  console.log('FAIL: neither node nor clear drag result')
}

console.log('proof:', outDir)
ws.close()
process.exit(nodeMoved ? 0 : 2)
