import WebSocket from 'ws'

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('no page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id
    const h = (d) => {
      const m = JSON.parse(d)
      if (m.id === mid) {
        ws.off('message', h)
        resolve(m)
      }
    }
    ws.on('message', h)
    ws.send(JSON.stringify({ id: mid, method, params }))
    setTimeout(() => reject(new Error(method)), 15000)
  })

await new Promise((r) => ws.once('open', r))
await send('Runtime.enable')
const evalE = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  return r.result?.result?.value
}

if (await evalE(`/Open Vault/i.test(document.body.innerText)`)) {
  await evalE(`(()=>{const b=[...document.querySelectorAll('button.nav-item')].find(x=>x.textContent.includes('D:\\\\Obs\\\\Obs')); b&&b.click(); return !!b})()`)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 400))
    if (await evalE(`/Graph View/i.test(document.body.innerText)&&!/Open Vault/i.test(document.body.innerText)`))
      break
  }
}
await evalE(`(()=>{const all=[...document.querySelectorAll('button,div,span,li')]; const g=all.find(e=>{const t=(e.textContent||'').replace(/\\s+/g,' ').trim(); return t==='Graph View'||(t.includes('Graph View')&&t.length<28)}); g&&g.click(); return !!g})()`)
await new Promise((r) => setTimeout(r, 2500))

const probe = await evalE(`(() => {
  const c = document.querySelector('canvas.graph-canvas')
  const wrap = document.querySelector('.graph-container')
  if (!c) return { err: 'no canvas' }
  const cs = getComputedStyle(c)
  const ctx = c.getContext('2d')
  let bright=0, mid=0, dark=0, total=0, maxV=0
  for (let y=0;y<c.height;y+=4) for (let x=0;x<c.width;x+=4) {
    const d = ctx.getImageData(x,y,1,1).data
    total++
    const v = Math.max(d[0],d[1],d[2])
    if (v>maxV) maxV=v
    if (v < 40) dark++; else if (v < 80) mid++; else bright++
  }
  // force magenta test
  ctx.save()
  ctx.setTransform(1,0,0,1,0,0)
  ctx.fillStyle = '#ff00ff'
  ctx.beginPath()
  ctx.arc(c.width/2, c.height/2, 50, 0, Math.PI*2)
  ctx.fill()
  ctx.restore()
  const midPx = ctx.getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data
  return {
    stats: document.querySelector('.graph-toolbar-stats')?.textContent,
    canvas: {w:c.width,h:c.height, clientW:c.clientWidth, clientH:c.clientHeight},
    style: { opacity: cs.opacity, visibility: cs.visibility, display: cs.display, zIndex: cs.zIndex, filter: cs.filter, mixBlend: cs.mixBlendMode },
    wrapBg: wrap ? getComputedStyle(wrap).backgroundColor : null,
    pixels: { bright, mid, dark, total, maxV },
    afterMagenta: [midPx[0], midPx[1], midPx[2], midPx[3]],
    dpr: window.devicePixelRatio,
    theme: document.documentElement.getAttribute('data-theme')
  }
})()`)
console.log(JSON.stringify(probe, null, 2))
ws.close()
