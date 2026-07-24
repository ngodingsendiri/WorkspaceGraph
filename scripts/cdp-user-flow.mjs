import WebSocket from 'ws'
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
if (!page) { console.error('no page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id=0
const send=(m,p={})=>new Promise((res,rej)=>{const mid=++id;const h=d=>{const x=JSON.parse(d.toString());if(x.id===mid){ws.off('message',h);res(x)}};ws.on('message',h);ws.send(JSON.stringify({id:mid,method:m,params:p}));setTimeout(()=>rej(new Error(m)),15000)})
await new Promise(r=>ws.once('open',r))
await send('Runtime.enable')
const E=async(expression)=>{
  const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})
  if (r.result?.exceptionDetails) {
    console.error('eval err', r.result.exceptionDetails?.exception?.description||r.result.exceptionDetails)
    return null
  }
  return r.result?.result?.value
}

const body0 = await E(`document.body.innerText.slice(0,80)`)
console.log('t0', JSON.stringify(body0))

// open vault
const opened = await E(`(()=>{const b=[...document.querySelectorAll('button.nav-item')].find(x=>(x.textContent||'').includes('D:\\\\Obs\\\\Obs')); if(!b) return false; b.click(); return true})()`)
console.log('opened', opened)
await new Promise(r=>setTimeout(r,2000))

// click graph via nav item class if possible
const clicked = await E(`(()=>{
  const items=[...document.querySelectorAll('.nav-item,button,div,span')]
  const g=items.find(e=>{
    const t=(e.textContent||'').replace(/\\s+/g,' ').trim()
    return t==='Graph View' || (t.endsWith('Graph View') && t.length<24)
  })
  if(!g) return 'not-found'
  g.click()
  return 'clicked:'+ (g.className||'')
})()`)
console.log('graph click', clicked)

for (let step=0; step<20; step++) {
  await new Promise(r=>setTimeout(r,300))
  const s = await E(`({
    step: ${step},
    circles: document.querySelectorAll('.graph-svg-host circle, .graph-svg circle').length,
    lines: document.querySelectorAll('.graph-svg-host line, .graph-svg line').length,
    host: !!document.querySelector('.graph-svg-host'),
    svgChild: !!document.querySelector('.graph-svg-host > svg'),
    hud: document.querySelector('.graph-live-hud')?.textContent || null,
    stats: document.querySelector('.graph-toolbar-stats')?.textContent || null,
    stageW: document.querySelector('.graph-stage')?.clientWidth || 0,
    stageH: document.querySelector('.graph-stage')?.clientHeight || 0
  })`)
  console.log(JSON.stringify(s))
  if (s && s.circles > 10) break
}
ws.close()
process.exit(0)
