import WebSocket from 'ws'
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id=0
const send=(m,p={})=>new Promise((res,rej)=>{const mid=++id;const h=d=>{const x=JSON.parse(d);if(x.id===mid){ws.off('message',h);res(x)}};ws.on('message',h);ws.send(JSON.stringify({id:mid,method:m,params:p}));setTimeout(()=>rej(new Error(m)),12000)})
await new Promise(r=>ws.once('open',r))
await send('Runtime.enable')
const E=async(expression)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});return r.result?.result?.value}

// open vault
if(await E(`/Open Vault/i.test(document.body.innerText)`)){
  await E(`([...document.querySelectorAll('button.nav-item')].find(x=>x.textContent.includes('D:\\\\Obs\\\\Obs'))||{}).click?.()`)
  for(let i=0;i<25;i++){await new Promise(r=>setTimeout(r,400));if(await E(`/Graph View/i.test(document.body.innerText)&&!/Open Vault/.test(document.body.innerText)`))break}
}

// Open a note first so local graph exists, then check styles
await E(`([...document.querySelectorAll('button,div,span')].find(e=>(e.textContent||'').trim()==='Editor')||{}).click?.()`)
await new Promise(r=>setTimeout(r,800))
await E(`([...document.querySelectorAll('.file-tree-item,.tree-item,button,div')].find(e=>(e.textContent||'').includes('Inbox.md'))||{}).click?.()`)
await new Promise(r=>setTimeout(r,1500))
const local = await E(`(()=>{
  const c=document.querySelector('canvas.local-graph-canvas')
  if(!c) return {err:'no local canvas'}
  const cs=getComputedStyle(c)
  const ctx=c.getContext('2d')
  let bright=0,total=0,maxV=0
  for(let y=0;y<c.height;y+=3)for(let x=0;x<c.width;x+=3){const d=ctx.getImageData(x,y,1,1).data;total++;const v=Math.max(d[0],d[1],d[2]);if(v>maxV)maxV=v;if(v>55)bright++}
  return {w:c.width,h:c.height,cw:c.clientWidth,ch:c.clientHeight,opacity:cs.opacity,transform:cs.transform,z:cs.zIndex,pos:cs.position,bg:cs.backgroundColor,bright,total,maxV,ratio:bright/total}
})()`)
console.log('LOCAL', JSON.stringify(local,null,2))

// Switch to graph view
await E(`(()=>{const all=[...document.querySelectorAll('button,div,span,li')];const g=all.find(e=>{const t=(e.textContent||'').replace(/\\s+/g,' ').trim();return t==='Graph View'||(t.includes('Graph View')&&t.length<28)});g&&g.click();return !!g})()`)
await new Promise(r=>setTimeout(r,2500))
const global = await E(`(()=>{
  const c=document.querySelector('canvas.graph-canvas')
  const wrap=document.querySelector('.graph-container')
  if(!c) return {err:'no global canvas'}
  const cs=getComputedStyle(c)
  const ws=getComputedStyle(wrap)
  const ctx=c.getContext('2d')
  // raw pixels
  let bright=0,total=0,maxV=0
  for(let y=0;y<c.height;y+=4)for(let x=0;x<c.width;x+=4){const d=ctx.getImageData(x,y,1,1).data;total++;const v=Math.max(d[0],d[1],d[2]);if(v>maxV)maxV=v;if(v>55)bright++}
  // stacking: what elements cover center of graph?
  const r=c.getBoundingClientRect()
  const cx=r.left+r.width/2, cy=r.top+r.height/2
  const stack=[]
  const all=document.elementsFromPoint(cx,cy)
  for(const el of all.slice(0,12)){
    const s=getComputedStyle(el)
    stack.push({tag:el.tagName,cls:(el.className||'').toString().slice(0,60),pe:s.pointerEvents,op:s.opacity,z:s.zIndex,bg:s.backgroundColor.slice(0,40)})
  }
  return {
    stats: document.querySelector('.graph-toolbar-stats')?.textContent,
    canvas:{w:c.width,h:c.height,cw:c.clientWidth,ch:c.clientHeight,left:r.left,top:r.top},
    style:{opacity:cs.opacity,transform:cs.transform,z:cs.zIndex,pos:cs.position,bg:cs.backgroundColor,filter:cs.filter,mix:cs.mixBlendMode,vis:cs.visibility},
    wrap:{w:wrap.clientWidth,h:wrap.clientHeight,op:ws.opacity,overflow:ws.overflow,z:ws.zIndex},
    pixels:{bright,total,maxV,ratio:bright/total},
    stack
  }
})()`)
console.log('GLOBAL', JSON.stringify(global,null,2))
ws.close()
