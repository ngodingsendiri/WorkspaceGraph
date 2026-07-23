import WebSocket from 'ws'
import fs from 'fs'

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page')
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
    setTimeout(() => reject(new Error('timeout ' + method)), 10000)
  })
}
await new Promise((r) => ws.once('open', r))
await send('Page.enable')

// Force Fit via keyboard
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 })
await new Promise((r) => setTimeout(r, 800))

const r = await send('Runtime.evaluate', {
  expression: `({
    stats: document.querySelector('.graph-toolbar-stats')?.textContent,
    canvas: (() => {
      const c = document.querySelector('canvas.graph-canvas')
      if (!c) return null
      const ctx = c.getContext('2d')
      let colored = 0, total = 0
      for (let y = 0; y < c.height; y += 8) {
        for (let x = 0; x < c.width; x += 8) {
          const d = ctx.getImageData(x,y,1,1).data
          total++
          // bg ~29,29,32 — count brighter colorful pixels (nodes)
          if (d[0] > 50 || d[1] > 50 || d[2] > 60) colored++
        }
      }
      return { w: c.width, h: c.height, colored, total, ratio: colored/total }
    })()
  })`,
  returnByValue: true
})
console.log(JSON.stringify(r.result?.result?.value, null, 2))

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
const b64 = shot.result?.data || shot.result?.value
if (!b64) {
  console.error('no data', Object.keys(shot.result || {}))
  process.exit(1)
}
const buf = Buffer.from(b64, 'base64')
fs.writeFileSync('scripts/graph-screenshot.png', buf)
console.log('saved', buf.length)
ws.close()
