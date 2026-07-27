/**
 * Live demo: open vault + Graph, pan slowly so user can watch on screen.
 */
import WebSocket from 'ws'

async function waitCdp(ms = 25000) {
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
  throw new Error('CDP not ready — is Electron running with --remote-debugging-port=9222?')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
await send('Page.bringToFront').catch(() => {})

const E = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  return r.result?.result?.value
}

console.log('=== LIVE DEMO: lihat window WorkspaceGraph di layar ===')

// Open vault
const v = await E(`(() => {
  const b = [...document.querySelectorAll('button.nav-item,button')].find(el =>
    (el.innerText||'').includes('D:\\\\Obs\\\\Obs') || (el.innerText||'').includes('Obs\\\\Obs')
  )
  if (!b) return 'skip-already-open-or-missing'
  b.click()
  return 'clicked-vault'
})()`)
console.log('1) vault:', v)
await sleep(4000)

// Graph View
const g = await E(`(() => {
  const el = [...document.querySelectorAll('.nav-item,button')].find(e =>
    (e.innerText||'').toLowerCase().includes('graph')
  )
  if (!el) return 'no-graph-nav'
  el.click()
  return 'clicked-graph'
})()`)
console.log('2) graph:', g)
await sleep(3500)

const stage = await E(`(() => {
  const s = document.querySelector('.graph-stage')
  if (!s) return null
  const r = s.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, probe: !!window.__wgGraph }
})()`)
console.log('3) stage:', stage)
if (!stage?.w) {
  console.error('Graph stage not found — abort')
  process.exit(1)
}

const t = () => E(`window.__wgGraph ? window.__wgGraph.getTransform() : null`)
console.log('4) transform awal:', await t())
console.log('>>> SEKARANG AKU GESER PELAN (lihat layar) <<<')
await sleep(1500)

async function drag(fromX, fromY, toX, toY, steps = 40, stepDelay = 25) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: fromX,
    y: fromY,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  for (let i = 1; i <= steps; i++) {
    const u = i / steps
    const x = fromX + (toX - fromX) * u
    const y = fromY + (toY - fromY) * u
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'left',
      buttons: 1
    })
    await sleep(stepDelay)
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: toX,
    y: toY,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
}

// Pan 1: empty corner → right/down (slow so visible)
const x0 = stage.x + 40
const y0 = stage.y + 40
console.log('5) pan #1 kanan-bawah…')
await drag(x0, y0, x0 + 220, y0 + 140, 35, 30)
console.log('   transform:', await t())
await sleep(2000)

// Pan 2: left
console.log('6) pan #2 kiri…')
await drag(x0 + 100, y0 + 80, x0 - 80, y0 + 80, 30, 30)
console.log('   transform:', await t())
await sleep(2000)

// Pan 3: programmatic so clear jump
console.log('7) pan #3 lewat API (+200, +100)…')
await E(`window.__wgGraph && window.__wgGraph.panBy(200, 100)`)
await sleep(500)
console.log('   transform:', await t())
await sleep(2500)

// Zoom out a bit with wheel
console.log('8) scroll zoom…')
const cx = stage.x + stage.w / 2
const cy = stage.y + stage.h / 2
for (let i = 0; i < 6; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: cx,
    y: cy,
    deltaX: 0,
    deltaY: 120
  })
  await sleep(120)
}
console.log('   transform:', await t())
await sleep(2000)

console.log('9) selesai — graph harus sudah bergeser di layar lo')
console.log('final:', await t())
ws.close()
process.exit(0)
