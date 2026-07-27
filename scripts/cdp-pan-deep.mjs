/** Deep pan test: real mouse + __wgGraph + snap-back check */
import WebSocket from 'ws'

async function waitCdp(ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json')).json()
      if (list.some((t) => t.type === 'page')) return list
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('no cdp')
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
    setTimeout(() => rej(new Error(method)), 20000)
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
  return r.result?.result?.value
}

// assume vault already open from previous or re-open
await E(`(() => {
  const b = [...document.querySelectorAll('button.nav-item')].find(el => (el.innerText||'').includes('D:\\\\Obs\\\\Obs'))
  if (b) b.click()
})()`)
await new Promise((r) => setTimeout(r, 2500))
await E(`(() => {
  const g = [...document.querySelectorAll('.nav-item')].find(e => (e.innerText||'').toLowerCase().includes('graph'))
  if (g) g.click()
})()`)
await new Promise((r) => setTimeout(r, 3000))

const t0 = await E(`window.__wgGraph ? window.__wgGraph.getTransform() : null`)
console.log('t0', t0)
if (!t0) {
  console.error('FAIL no __wgGraph probe — zoom not bound')
  process.exit(1)
}

// Programmatic pan
await E(`window.__wgGraph.panBy(180, 120)`)
await new Promise((r) => setTimeout(r, 200))
const t1 = await E(`window.__wgGraph.getTransform()`)
console.log('t1 after panBy', t1)

// Real mouse drag empty corner
const rect = await E(`(() => {
  const s = document.querySelector('.graph-stage')
  const r = s.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})()`)
const x0 = rect.x + 30
const y0 = rect.y + 30
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
for (let i = 1; i <= 20; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: x0 + i * 15,
    y: y0 + i * 10,
    button: 'left',
    buttons: 1
  })
}
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: x0 + 300,
  y: y0 + 200,
  button: 'left',
  clickCount: 1
})
await new Promise((r) => setTimeout(r, 200))
const t2 = await E(`window.__wgGraph.getTransform()`)
console.log('t2 after mouse', t2)

// Wait for snap-back
await new Promise((r) => setTimeout(r, 3500))
const t3 = await E(`window.__wgGraph.getTransform()`)
console.log('t3 after 3.5s', t3)

const panByOk = t1 && (Math.abs(t1.x - t0.x) > 50 || Math.abs(t1.y - t0.y) > 50)
const mouseOk = t2 && (Math.abs(t2.x - t1.x) > 30 || Math.abs(t2.y - t1.y) > 30)
const noSnap =
  t3 && Math.abs(t3.x - t2.x) < 5 && Math.abs(t3.y - t2.y) < 5 && Math.abs(t3.k - t2.k) < 0.01

console.log({ panByOk, mouseOk, noSnap })
console.log(panByOk && mouseOk && noSnap ? 'PASS deep pan' : 'FAIL deep pan')
ws.close()
process.exit(panByOk && mouseOk && noSnap ? 0 : 2)
