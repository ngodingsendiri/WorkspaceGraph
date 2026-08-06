/**
 * Real-browser LOD-culling measurement harness.
 *
 * Uses the PRODUCTION modules (graphCanvas2D / graphRenderTokens /
 * graphPerfStats) on a synthetic 1000-node vault and measures, at two zooms:
 *   1. canvas2D gesture draw time (real 2D context) — drawCanvas2DScene
 *   2. SVG DOM reconciliation cost — building the post-cull frame elements in
 *      a real <svg> (the dominant term of the React commit the throttle gates)
 *   3. pre→post cull counts — the shared pointOnScreen/edgeOnScreen/labelZoomAlpha
 *   4. AdaptiveThrottle window trajectory from the measured commit p95
 *
 * This is NOT the Electron app — React reconciliation itself and the `D`
 * overlay live in GraphCanvas, which needs window.api. The DOM-append cost
 * here scales identically and is the honest browser-side number available
 * without the app.
 */
import { drawCanvas2DScene, computeHotSet } from '../src/renderer/src/components/graph/graphCanvas2D'
import {
  pointOnScreen,
  edgeOnScreen,
  cullMargin,
  labelZoomAlpha
} from '../src/renderer/src/components/graph/graphRenderTokens'
import {
  AdaptiveThrottle,
  THROTTLE_MIN_MS,
  THROTTLE_MAX_MS
} from '../src/renderer/src/components/graph/graphPerfStats'
import { resolveLod, labelDrawBudget, type LodLevel } from '../src/renderer/src/components/graph/graphShared'
import type { SimNode, SimLink, Palette, ViewFlags } from '../src/renderer/src/components/graph/graphTypes'

const W = 1600
const H = 1000

function makePal(): Palette {
  return {
    isLight: false,
    bg: '#1e1e1e',
    edge: 'rgba(170,175,190,0.38)',
    edgeTag: 'rgba(150,155,170,0.22)',
    edgeFolder: 'rgba(94,200,232,0.42)',
    edgeAttachment: 'rgba(90,158,120,0.45)',
    edgeHot: 'rgba(167,139,250,0.9)',
    label: 'rgba(228,230,237,0.92)',
    nodeStroke: 'rgba(0,0,0,0.35)',
    colors: { default: '#7c6cf0', tag: '#c9a227', attachment: '#5a9e78' }
  }
}

function makeFlags(): ViewFlags {
  return {
    searchMatchIds: null,
    dimHubs: true,
    hubThreshold: 12,
    focusedId: null,
    pathNodeIds: null,
    pathEdgeKeys: null,
    pathFromId: '',
    pathToId: '',
    focusNodeIds: null,
    focusEdgeKeys: null,
    colorBy: 'default',
    edgeColorBy: 'default',
    perfMode: 'auto',
    selectedIds: null,
    arrows: false,
    textFade: 0.75,
    nodeSize: 1,
    lineThickness: 1,
    groupColors: null
  }
}

/** Golden-angle spiral vault (like the app's spiralSeed), 1000 nodes / ~3000 links. */
function makeVault(n: number, edgeFactor = 3): { nodes: SimNode[]; links: SimLink[] } {
  const nodes: SimNode[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const deg = (i % 25) + 1
    const r = 400 * Math.sqrt((i + 1) / n)
    const theta = i * golden
    nodes.push({
      id: `n${i}`,
      title: `Note ${i}`,
      path: `note-${i}.md`,
      relativePath: `note-${i}.md`,
      tags: [],
      type: i % 9 === 0 ? 'tag' : i % 13 === 0 ? 'attachment' : 'knowledge',
      degree: deg,
      isTag: i % 9 === 0,
      isAttachment: i % 13 === 0,
      x: Math.cos(theta) * r,
      y: Math.sin(theta) * r,
      pinned: false
    })
  }
  const links: SimLink[] = []
  for (let i = 0; i < n; i++) {
    for (let j = 1; j <= edgeFactor; j++) {
      // LOCAL edges: each node links to its spiral neighbors (representative of
      // real Obsidian vaults where notes link to nearby related notes). Global
      // long-distance links would make every edge span the whole cloud and
      // defeat viewport culling — that is not how real graphs look.
      const t = (i + j * 3) % n
      if (t === i) continue
      links.push({
        id: `${i}->${t}`,
        type: i % 7 === 0 ? 'tag' : 'wiki_link',
        source: `n${i}`,
        target: `n${t}`,
        weight: 1
      })
    }
  }
  return { nodes, links }
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

interface CullCounts {
  totalEdges: number
  totalNodes: number
  renderedEdges: number
  renderedNodes: number
  renderedLabels: number
}

/** Mirror of the SVG frame-build culling (same helpers + LOD label rules). */
function svgCullCounts(
  nodes: SimNode[],
  links: SimLink[],
  tx: number,
  ty: number,
  k: number,
  lod: LodLevel
): CullCounts {
  const margin = cullMargin(lod)
  const kSafe = Math.max(k, 0.05)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  let renderedNodes = 0
  let renderedEdges = 0
  let renderedLabels = 0
  let labCount = 0
  const maxLabels = labelDrawBudget(lod)

  for (const n of nodes) {
    if (n.x == null || n.y == null || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
    const sx = n.x * k + tx
    const sy = n.y * k + ty
    if (!pointOnScreen(sx, sy, W, H, margin)) continue
    renderedNodes++
    // Label rules from the SVG pass (no highlights active)
    const deg = typeof n.degree === 'number' ? n.degree : 0
    const zA = labelZoomAlpha(kSafe, 0.75, deg)
    if (zA < 0.04 || labCount >= maxLabels) continue
    if (lod === 'low' && deg < 3) continue
    if (lod === 'medium' && deg < 2) continue
    renderedLabels++
    labCount++
  }

  for (const e of links) {
    const s = byId.get(typeof e.source === 'string' ? e.source : (e.source as SimNode)?.id)
    const tg = byId.get(typeof e.target === 'string' ? e.target : (e.target as SimNode)?.id)
    if (!s || !tg || s.x == null || s.y == null || tg.x == null || tg.y == null) continue
    const esx1 = s.x * k + tx
    const esy1 = s.y * k + ty
    const esx2 = tg.x * k + tx
    const esy2 = tg.y * k + ty
    if (edgeOnScreen(esx1, esy1, esx2, esy2, W, H, margin)) renderedEdges++
  }
  return { totalEdges: links.length, totalNodes: nodes.length, renderedEdges, renderedNodes, renderedLabels }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Real DOM reconciliation proxy: build + append the post-cull frame elements. */
function measureSvgDomCost(c: CullCounts, runs = 15): number {
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px'
    document.body.appendChild(svg)
    const t0 = performance.now()
    for (let e = 0; e < c.renderedEdges; e++) {
      const el = document.createElementNS(SVG_NS, 'line')
      el.setAttribute('x1', '0')
      el.setAttribute('y1', '0')
      el.setAttribute('x2', '10')
      el.setAttribute('y2', '10')
      el.setAttribute('stroke', 'rgba(170,175,190,0.38)')
      el.setAttribute('stroke-width', '1')
      svg.appendChild(el)
    }
    for (let n = 0; n < c.renderedNodes; n++) {
      const el = document.createElementNS(SVG_NS, 'circle')
      el.setAttribute('cx', '0')
      el.setAttribute('cy', '0')
      el.setAttribute('r', '3')
      el.setAttribute('fill', '#7c6cf0')
      svg.appendChild(el)
    }
    for (let l = 0; l < c.renderedLabels; l++) {
      const el = document.createElementNS(SVG_NS, 'text')
      el.setAttribute('x', '0')
      el.setAttribute('y', '0')
      el.setAttribute('font-size', '11')
      el.textContent = 'Note 123'
      svg.appendChild(el)
    }
    samples.push(performance.now() - t0)
    svg.remove()
  }
  return median(samples)
}

function fmt(ms: number): string {
  return ms < 10 ? `${ms.toFixed(2)}ms` : `${ms.toFixed(1)}ms`
}

function run(): void {
  const { nodes, links } = makeVault(1000)
  const lod = resolveLod(nodes.length, 'auto')
  const flags = makeFlags()
  const pal = makePal()
  const canvas = document.getElementById('perf-canvas') as HTMLCanvasElement
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  // Cameras: zoom-out fits the whole cloud; zoom-in targets a RIM cluster
  // (edge of the spiral — where real culling wins) at two depths.
  const rim = nodes[997]!
  const cams = [
    { name: 'zoom-out (k=0.55, seluruh awan)', tx: W / 2, ty: H / 2, k: 0.55 },
    {
      name: 'zoom-in (k=3.0, cluster tepi)',
      tx: W / 2 - rim.x! * 3,
      ty: H / 2 - rim.y! * 3,
      k: 3
    },
    {
      name: 'zoom-in dalam (k=8.0, cluster tepi)',
      tx: W / 2 - rim.x! * 8,
      ty: H / 2 - rim.y! * 8,
      k: 8
    }
  ]

  const out: string[] = []
  out.push(
    `<div class="hdr">Vault: <b>${nodes.length} node</b> · <b>${links.length} edge</b> · LOD <b>${lod}</b> · viewport ${W}×${H}</div>`
  )

  const dcBase = {
    w: W,
    h: H,
    dpr: 1,
    pal,
    simNodes: nodes,
    simLinks: links,
    hover: null,
    hoverStrength: 0,
    flags,
    lod,
    large: true,
    showLabels: true
  }
  const hot = computeHotSet(null, 0, links)

  for (const cam of cams) {
    const c = svgCullCounts(nodes, links, cam.tx, cam.ty, cam.k, lod)
    // canvas2D gesture draw — real 2D context, median of 40
    const drawSamples: number[] = []
    for (let i = 0; i < 10; i++) drawCanvas2DScene({ ...dcBase, ctx, tx: cam.tx, ty: cam.ty, k: cam.k }, hot)
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now()
      drawCanvas2DScene({ ...dcBase, ctx, tx: cam.tx, ty: cam.ty, k: cam.k }, hot)
      drawSamples.push(performance.now() - t0)
    }
    const drawMs = median(drawSamples)
    const domMs = measureSvgDomCost(c)
    const culledE = c.totalEdges - c.renderedEdges
    const culledN = c.totalNodes - c.renderedNodes

    // AdaptiveThrottle trajectory from the MEASURED commit p95 (DOM proxy)
    const ctrl = new AdaptiveThrottle(50)
    const windows = [50]
    let count = 0
    for (let s = 1; s <= 12; s++) {
      count += 20
      const w = ctrl.consider(domMs, count, s * 1000)
      if (w !== windows[windows.length - 1]) windows.push(w)
    }
    out.push(`
      <div class="cam">
        <h3>${cam.name}</h3>
        <table>
          <tr><td>canvas2D draw (median 40×)</td><td><b>${fmt(drawMs)}</b></td></tr>
          <tr><td>SVG DOM frame build (median 15×)</td><td><b>${fmt(domMs)}</b></td></tr>
          <tr><td>elemen frame</td><td><b>${c.renderedEdges + c.renderedNodes + c.renderedLabels}</b>
            <span class="muted">(${c.renderedEdges}E · ${c.renderedNodes}N · ${c.renderedLabels}L)</span></td></tr>
          <tr><td>culled (pre→post)</td><td><b>${culledE}E · ${culledN}N</b>
            <span class="muted">E ${c.totalEdges}→${c.renderedEdges} · N ${c.totalNodes}→${c.renderedNodes}</span></td></tr>
          <tr><td>adaptive window 12s</td><td><b>${windows.join(' → ')}ms</b>
            <span class="muted">(batas ${THROTTLE_MIN_MS}–${THROTTLE_MAX_MS}ms)</span></td></tr>
        </table>
      </div>`)
  }

  document.getElementById('results')!.innerHTML =
    out.join('') +
    `<div class="foot">commit p95 proxy = DOM frame build (creation + append), bukan React reconciliation
     (itu hanya terukur di aplikasi asli lewat tombol D). Modul yang dipakai: graphCanvas2D,
     graphRenderTokens (cullMargin/pointOnScreen/edgeOnScreen/labelZoomAlpha), graphPerfStats (AdaptiveThrottle).</div>`
}

window.addEventListener('DOMContentLoaded', run)
