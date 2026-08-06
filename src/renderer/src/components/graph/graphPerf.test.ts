/**
 * Performance micro-benchmark for the graph render pipeline on large vaults
 * (1000+ nodes). Runs in the node test env with a no-op canvas context, so the
 * numbers isolate JS pipeline cost (logic + allocation), not GPU rasterization.
 *
 * These are not pass/fail assertions — they LOG the measured frame budget so a
 * perf regression is visible in CI output. Soft upper bounds are asserted to
 * catch catastrophic regressions only.
 */
import { describe, it, expect } from 'vitest'
import type { SimNode, SimLink, Palette, ViewFlags } from './graphTypes'
import { drawCanvas2DScene, computeHotSet } from './graphCanvas2D'
import { resolveLod } from './graphShared'
import { nodeEntryProgress } from './graphRenderTokens'

/** Minimal no-op 2D context — every method is a no-op, props are plain fields. */
function makeCtx(): CanvasRenderingContext2D {
  const noop = (): void => {}
  return {
    setTransform: noop,
    fillRect: noop,
    save: noop,
    translate: noop,
    scale: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    setLineDash: noop,
    fillText: noop,
    restore: noop,
    lineCap: '',
    lineWidth: 0,
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1
  } as unknown as CanvasRenderingContext2D
}

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

function makeFlags(over: Partial<ViewFlags> = {}): ViewFlags {
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
    focusSelId: null,
    arrows: false,
    textFade: 0.75,
    nodeSize: 1,
    lineThickness: 1,
    groupColors: null,
    ...over
  }
}

/** Build a large synthetic vault: `n` nodes with degree-scaled positions. */
function makeVault(n: number, edgeFactor = 3): { nodes: SimNode[]; links: SimLink[] } {
  const nodes: SimNode[] = []
  const R = Math.min(n, 400)
  for (let i = 0; i < n; i++) {
    const a = (i / Math.max(1, n)) * Math.PI * 2
    const r = (i % R) + 1
    const deg = (i % 25) + 1
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
      x: Math.cos(a) * r * 40,
      y: Math.sin(a) * r * 40,
      pinned: false
    })
  }
  const links: SimLink[] = []
  for (let i = 0; i < n; i++) {
    for (let j = 1; j <= edgeFactor; j++) {
      const t = (i + j * 37) % n
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

describe('graph render perf (benchmark, informational)', () => {
  // A 1000+ node vault with ~3× edges — the size where LOD drops to 'low'.
  const { nodes, links } = makeVault(1000)
  const lod = resolveLod(nodes.length, 'auto')
  const flags = makeFlags()
  const pal = makePal()
  const dc = {
    ctx: makeCtx(),
    w: 1600,
    h: 1000,
    dpr: 1.5,
    pal,
    tx: 100,
    ty: 50,
    k: 1,
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

  it('drawCanvas2DScene frame cost (low LOD, 1000 nodes / ~3000 links)', () => {
    // Warmup
    for (let i = 0; i < 5; i++) drawCanvas2DScene(dc, hot)
    const samples: number[] = []
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now()
      drawCanvas2DScene(dc, hot)
      samples.push(performance.now() - t0)
    }
    const ms = median(samples)
    // Log the budget so regressions show in CI output

    console.log(
      `[perf] drawCanvas2DScene 1000 nodes/${links.length} links lod=${lod}: ${ms.toFixed(2)}ms/frame (~${Math.round(1000 / Math.max(0.01, ms))} fps budget)`
    )
    // Soft catastrophic-regression guard only (a 60fps budget = 16.7ms)
    expect(ms).toBeLessThan(60)
  })

  it('computeHotSet on hover (O(E) neighbor scan)', () => {
    const samples: number[] = []
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now()
      computeHotSet('n500', 1, links)
      samples.push(performance.now() - t0)
    }
    const ms = median(samples)

    console.log(`[perf] computeHotSet hover scan over ${links.length} links: ${ms.toFixed(3)}ms`)
    expect(ms).toBeLessThan(5)
  })

  it('entry progress reduce over 1000 nodes (G19 per-frame cost)', () => {
    const born = performance.now() - 100
    const maxOrder = nodes.reduce(
      (m, n) => (n.enterOrder != null ? Math.max(m, n.enterOrder) : m),
      -1
    )
    const samples: number[] = []
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now()
      for (const n of nodes) {
        nodeEntryProgress(born, n.born, n.enterOrder, maxOrder >= 0 ? maxOrder + 1 : undefined)
      }
      samples.push(performance.now() - t0)
    }
    const ms = median(samples)

    console.log(`[perf] nodeEntryProgress over 1000 nodes: ${ms.toFixed(3)}ms`)
    expect(ms).toBeLessThan(5)
  })

  it('edge sort skip vs active-highlight sort (O(E log E) delta, low LOD over budget)', () => {
    // low LOD budget is 900 edges but the vault has ~3000 → sort path runs.
    // Idle (no highlight): sort must be skipped entirely.
    const idle = makeFlags()
    const warm = (flagsOver: ViewFlags): number => {
      const d = { ...dc, flags: flagsOver }
      for (let i = 0; i < 5; i++) drawCanvas2DScene(d, hot)
      const s: number[] = []
      for (let i = 0; i < 40; i++) {
        const t0 = performance.now()
        drawCanvas2DScene(d, hot)
        s.push(performance.now() - t0)
      }
      return median(s)
    }
    const idleMs = warm(idle)
    // Active highlight: path set forces the full priority sort every frame
    const pathFlags = makeFlags({
      pathNodeIds: new Set(['n500']),
      pathEdgeKeys: new Set(['1->2']),
      pathFromId: 'n1',
      pathToId: 'n2'
    })
    const hotMs = warm(pathFlags)

    console.log(
      `[perf] edge draw over budget (${links.length} links): idle=${idleMs.toFixed(2)}ms/frame, ` +
        `path-highlight=${hotMs.toFixed(2)}ms/frame`
    )
    expect(hotMs).toBeLessThan(60)
  })

  it('SVG frame object build cost (1000 nodes, pure array construction)', () => {
    // Mirrors the paint() hot loop: per node we allocate a handful of objects
    // + per edge a couple more. Measures the JS-side cost that precedes the
    // React reconciliation of the SvgFrame state update.
    const t0 = performance.now()
    for (let frame = 0; frame < 30; frame++) {
      const nodesOut: unknown[] = []
      for (const n of nodes) {
        if (n.x == null || n.y == null || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
        nodesOut.push({
          key: n.id,
          kind: 'circle',
          cx: n.x,
          cy: n.y,
          r: 8 + (n.degree ?? 0) * 0.15,
          fill: '#7c6cf0',
          stroke: '#000',
          sw: 0.55,
          fillOp: 1,
          strokeOp: 1
        })
      }
      const edgesOut: unknown[] = []
      for (const e of links) {
        const s = e.source as SimNode
        const tg = e.target as SimNode
        if (!s?.x || !tg?.x) continue
        edgesOut.push({
          key: e.id,
          x1: s.x,
          y1: s.y,
          x2: tg.x,
          y2: tg.y,
          stroke: 'rgba(170,175,190,0.38)',
          sw: 0.75,
          op: 0.55
        })
      }
      void nodesOut
      void edgesOut
    }
    const total = performance.now() - t0
    const ms = total / 30

    console.log(
      `[perf] SVG frame object build 1000 nodes/${links.length} links: ${ms.toFixed(2)}ms/frame`
    )
    expect(ms).toBeLessThan(20)
  })
})
