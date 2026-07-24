import WebSocket from 'ws'
import fs from 'fs'
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id=0
const send=(m,p={})=>new Promise((res,rej)=>{const mid=++id;const h=d=>{const x=JSON.parse(d);if(x.id===mid){ws.off('message',h);res(x)}};ws.on('message',h);ws.send(JSON.stringify({id:mid,method:m,params:p}));setTimeout(()=>rej(new Error(m)),12000)})
await new Promise(r=>ws.once('open',r))
const info = await send('Runtime.evaluate',{expression:`({
  host: !!document.querySelector('.graph-svg-host'),
  svg: !!document.querySelector('.graph-svg-host .graph-svg, .graph-svg'),
  circles: document.querySelectorAll('.graph-svg circle, .graph-svg-host circle').length,
  lines: document.querySelectorAll('.graph-svg line, .graph-svg-host line').length,
  texts: document.querySelectorAll('.graph-svg text, .graph-svg-host text').length,
  hud: document.querySelector('.graph-live-hud')?.textContent,
  stats: document.querySelector('.graph-toolbar-stats')?.textContent
})`,returnByValue:true})
console.log(JSON.stringify(info.result?.result?.value,null,2))
const shot = await send('Page.captureScreenshot',{format:'png',fromSurface:true})
const b64 = shot.result?.data || shot.result?.value
fs.writeFileSync('scripts/graph-screenshot.png', Buffer.from(b64,'base64'))
console.log('shot', Buffer.from(b64,'base64').length)
ws.close()
