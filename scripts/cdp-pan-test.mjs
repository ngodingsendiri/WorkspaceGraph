/**
 * CDP pan test for Graph View
 * Electron must run with --remote-debugging-port=9222
 */
import WebSocket from 'ws'

async function waitCdp(ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch('http://127.0.0.1:9222/json')
      if (r.ok) {
        const list = await r.json()
        if (list.some((t) => t.type === 'page')) return list
      }
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 400))
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

const E = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result?.exceptionDetails) {
    console.error('ERR', r.result.exceptionDetails?.exception?.description)
    return null
  }
  return r.result?.result?.value
}

// Click Recent vault button (React onClick → store.openWorkspace)
const vaultClick = await E(`(() => {
  const buttons = [...document.querySelectorAll('button.nav-item,button')]
  const b = buttons.find((el) => (el.innerText || '').includes('D:\\\\Obs\\\\Obs') || (el.innerText || '').includes('Obs\\\\Obs'))
  if (!b) return 'missing recent: ' + buttons.map(x => (x.innerText||'').slice(0,40)).join(' || ')
  b.click()
  return 'clicked:' + (b.innerText||'').replace(/\\s+/g,' ').slice(0,50)
})()`)
console.log('vault', vaultClick)
await new Promise((r) => setTimeout(r, 5000))

let body = await E(`document.body.innerText.slice(0,300)`)
console.log('after vault body', JSON.stringify(body))

// Click Graph in sidebar
const gNav = await E(`(() => {
  const items = [...document.querySelectorAll('.nav-item,button')]
  const g = items.find((e) => {
    const t = (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase()
    return t === 'graph' || t.includes('graph view') || t === 'graphview'
  })
  if (!g) return 'no graph: ' + items.slice(0,12).map(i => (i.innerText||'').trim().slice(0,25)).join('|')
  g.click()
  return 'ok'
})()`)
console.log('graph', gNav)
await new Promise((r) => setTimeout(r, 4000))

const before = await E(`(() => {
  const stage = document.querySelector('.graph-stage')
  const r = stage && stage.getBoundingClientRect()
  return {
    stage: !!stage,
    w: stage ? stage.clientWidth : 0,
    h: stage ? stage.clientHeight : 0,
    circles: document.querySelectorAll('.graph-svg circle, .graph-svg polygon').length,
    hud: (document.querySelector('.graph-live-hud') || {}).textContent || '',
    stats: (document.querySelector('.graph-toolbar-stats') || {}).textContent || '',
    rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
    body: document.body.innerText.slice(0, 180)
  }
})()`)
console.log('before', JSON.stringify(before))

if (!before || !before.stage || before.w < 40) {
  console.error('FAIL no stage')
  ws.close()
  process.exit(1)
}

// Dispatch pointer events on stage
const panSyn = await E(`(() => {
  const stage = document.querySelector('.graph-stage')
  const r = stage.getBoundingClientRect()
  const hud0 = (document.querySelector('.graph-live-hud') || {}).textContent || ''
  const fire = (type, x, y, buttons) => {
    stage.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      buttons: buttons, button: 0
    }))
  }
  const sx = r.left + 36, sy = r.top + 36
  fire('pointerdown', sx, sy, 1)
  for (let i = 1; i <= 10; i++) fire('pointermove', sx + i * 22, sy + i * 14, 1)
  fire('pointerup', sx + 220, sy + 140, 0)
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const hud1 = (document.querySelector('.graph-live-hud') || {}).textContent || ''
    res({ hud0, hud1, changed: hud0 !== hud1 })
  })))
})()`)
console.log('synthetic', JSON.stringify(panSyn))

// Real CDP mouse
const rect = before.rect
const x0 = rect.x + 40
const y0 = rect.y + 40
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
for (let i = 1; i <= 15; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: x0 + i * 16,
    y: y0 + i * 10,
    button: 'left',
    buttons: 1
  })
}
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: x0 + 240,
  y: y0 + 150,
  button: 'left',
  clickCount: 1
})
await new Promise((r) => setTimeout(r, 500))

const after = await E(`({
  hud: (document.querySelector('.graph-live-hud') || {}).textContent || '',
  circles: document.querySelectorAll('.graph-svg circle, .graph-svg polygon').length
})`)
console.log('after', JSON.stringify(after))

const pass =
  (panSyn && panSyn.changed) || (before.hud && after && after.hud && before.hud !== after.hud)
console.log(pass ? 'PASS pan works' : 'FAIL pan no HUD change')
ws.close()
process.exit(pass ? 0 : 2)
