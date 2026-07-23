/**
 * Full live verify: open vault → Graph View → Fit → screenshot + pixel stats.
 * Expects electron already running with --remote-debugging-port=9222
 * OR pass --launch to start it.
 */
import WebSocket from 'ws'
import fs from 'fs'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const launch = process.argv.includes('--launch')

async function waitCdp(ms = 15000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      const r = await fetch('http://127.0.0.1:9222/json')
      if (r.ok) return await r.json()
    } catch {
      /* retry */
    }
    await new Promise((x) => setTimeout(x, 300))
  }
  throw new Error('CDP not ready')
}

let child = null
if (launch) {
  const electron = path.join(root, 'node_modules/electron/dist/electron.exe')
  child = spawn(electron, ['.', '--remote-debugging-port=9222'], {
    cwd: root,
    stdio: 'ignore',
    detached: true
  })
  child.unref()
  console.log('launched', child.pid)
}

const list = await waitCdp()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('no page')

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
    setTimeout(() => reject(new Error('timeout ' + method)), 15000)
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
  return r.result?.result?.value
}

// Open recent vault if on welcome
const needOpen = await evalExpr(`/Open Vault/i.test(document.body?.innerText || '')`)
if (needOpen) {
  console.log('opening vault...')
  const opened = await evalExpr(`(() => {
    const btns = [...document.querySelectorAll('button.nav-item')]
    // Prefer exact D:\\Obs\\Obs recent row
    let b = btns.find((x) => (x.textContent || '').includes('D:\\\\Obs\\\\Obs'))
    if (!b) b = btns.find((x) => (x.textContent || '').includes('Obs') && (x.textContent || '').includes('D:'))
    if (!b && btns[0]) b = btns[0]
    if (!b) return { ok: false, count: btns.length }
    b.click()
    return { ok: true, text: (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) }
  })()`)
  console.log('opened', opened)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400))
    const st = await evalExpr(`({
      hasGraph: /Graph View/i.test(document.body?.innerText || ''),
      title: document.title,
      stillWelcome: /Open Vault/i.test(document.body?.innerText || '')
    })`)
    if (i % 5 === 0) console.log('boot', i, st)
    if (st?.hasGraph && !st?.stillWelcome) break
  }
}

// Click Graph View
await evalExpr(`(() => {
  const all = [...document.querySelectorAll('button, a, div, span, li')]
  const g = all.find(e => {
    const t = (e.textContent || '').replace(/\\s+/g,' ').trim()
    return t === 'Graph View' || (t.includes('Graph View') && t.length < 28)
  })
  g?.click()
  return !!g
})()`)

// Wait for canvas + stats
let stats = null
for (let i = 0; i < 25; i++) {
  await new Promise((r) => setTimeout(r, 400))
  stats = await evalExpr(`document.querySelector('.graph-toolbar-stats')?.textContent || null`)
  if (stats && /notes/.test(stats)) break
}
console.log('stats', stats)

// Press F for fit
await send('Input.dispatchKeyEvent', {
  type: 'keyDown',
  key: 'f',
  code: 'KeyF',
  windowsVirtualKeyCode: 70,
  nativeVirtualKeyCode: 70,
  text: 'f'
})
await send('Input.dispatchKeyEvent', {
  type: 'keyUp',
  key: 'f',
  code: 'KeyF',
  windowsVirtualKeyCode: 70,
  nativeVirtualKeyCode: 70
})
await new Promise((r) => setTimeout(r, 1200))

const report = await evalExpr(`(() => {
  const c = document.querySelector('canvas.graph-canvas')
  const stats = document.querySelector('.graph-toolbar-stats')?.textContent || null
  const filterChip = document.querySelector('.graph-filter-live-chip')?.textContent || null
  const diag = document.querySelector('.graph-diag-banner')?.textContent || null
  const empty = document.querySelector('.graph-empty')?.textContent || null
  if (!c) return { stats, filterChip, diag, empty, canvas: null }
  const ctx = c.getContext('2d')
  let bright = 0, total = 0
  // bg is ~29,29,32 — node colors are purple/cyan/etc much brighter channel-wise
  for (let y = 4; y < c.height; y += 6) {
    for (let x = 4; x < c.width; x += 6) {
      const d = ctx.getImageData(x, y, 1, 1).data
      total++
      const maxc = Math.max(d[0], d[1], d[2])
      const minc = Math.min(d[0], d[1], d[2])
      // colored or clearly lighter than app bg
      if (maxc > 55 || maxc - minc > 18) bright++
    }
  }
  return {
    stats,
    filterChip,
    diag,
    empty,
    canvas: { w: c.width, h: c.height, bright, total, ratio: +(bright / total).toFixed(4) }
  }
})()`)
console.log('REPORT', JSON.stringify(report, null, 2))

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
const b64 = shot.result?.data || shot.result?.value
if (b64) {
  const buf = Buffer.from(b64, 'base64')
  const out = path.join(root, 'scripts/graph-screenshot.png')
  fs.writeFileSync(out, buf)
  console.log('screenshot', buf.length, out)
} else {
  console.error('screenshot missing keys', Object.keys(shot.result || {}))
}

ws.close()
// leave app running for user
process.exit(0)
