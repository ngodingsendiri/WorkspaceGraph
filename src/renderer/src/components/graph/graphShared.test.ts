import { describe, it, expect } from 'vitest'
import * as d3 from 'd3'
import {
  applyForceLayout,
  FORCE_PRESETS,
  DEFAULT_FORCE_SETTINGS,
  chargeFor,
  OBSIDIAN_SIM,
  localRadius,
  scaleLocalForces
} from './graphShared'
import type { GraphForceSettings } from '../../store/graphStore'
import type { SimNode, SimLink } from './graphTypes'

function makeSim(nodes: SimNode[], links: SimLink[]): d3.Simulation<SimNode, undefined> {
  return d3.forceSimulation<SimNode>(nodes).force(
    'link',
    d3.forceLink<SimNode, SimLink>(links).id((d) => d.id)
  )
}

/** Run applyForceLayout and return typed accessors for assertions. */
function layout(partial?: Partial<Parameters<typeof applyForceLayout>[2]>): {
  sim: d3.Simulation<SimNode, undefined>
  links: SimLink[]
} {
  const nodes: SimNode[] = [
    { id: 'a', title: 'A', type: 'note', path: '/a.md', relativePath: 'a.md', tags: [], degree: 0 },
    { id: 'b', title: 'B', type: 'note', path: '/b.md', relativePath: 'b.md', tags: [], degree: 2 },
    { id: 'c', title: 'C', type: 'note', path: '/c.md', relativePath: 'c.md', tags: [], degree: 6 }
  ]
  const links: SimLink[] = [
    { id: 'a->b', type: 'wiki_link', source: 'a', target: 'b' },
    { id: 'b->c', type: 'tag', source: 'b', target: 'c' }
  ]
  const sim = makeSim(nodes, links)
  const opts = {
    width: 600,
    height: 400,
    large: false,
    sizeMul: 1.2,
    ...partial
  }
  applyForceLayout(sim, DEFAULT_FORCE_SETTINGS, opts)
  return { sim, links }
}

describe('applyForceLayout (shared force source for Global + Local graphs)', () => {
  it('applies tag-edge damping and degree-based link distance', () => {
    const { sim, links } = layout()
    const link = sim.force('link') as d3.ForceLink<SimNode, SimLink>
    const strength = link.strength() as (l: SimLink) => number
    const distance = link.distance() as (l: SimLink) => number
    // Tag edges spring ~65% weaker so they don't dominate layout
    expect(strength(links[0])).toBe(DEFAULT_FORCE_SETTINGS.linkStr)
    expect(strength(links[1])).toBeCloseTo(DEFAULT_FORCE_SETTINGS.linkStr * 0.35, 5)
    // Distance grows with endpoint degree (cluster breathing)
    expect(distance(links[1])).toBeGreaterThan(distance(links[0]))
  })

  it('uses softened hub charge via chargeFor and honors chargeRange override', () => {
    const { sim } = layout({ large: true, chargeRange: 180 })
    const charge = sim.force('charge') as d3.ForceManyBody<SimNode>
    const strength = charge.strength() as (d: SimNode) => number
    // Same softened hub boost as global graph
    expect(strength({ ...({} as SimNode), degree: 6 })).toBe(
      chargeFor(6, DEFAULT_FORCE_SETTINGS.charge, true)
    )
    // Override wins over the large-graph default (220)
    expect(charge.distanceMax()).toBe(180)
  })

  it('defaults charge distanceMax for small graphs to max(280, linkDist*5)', () => {
    const { sim } = layout()
    const charge = sim.force('charge') as d3.ForceManyBody<SimNode>
    expect(charge.distanceMax()).toBe(Math.max(280, DEFAULT_FORCE_SETTINGS.linkDist * 5))
  })

  it('collide uses radiusFn and collidePad', () => {
    const { sim } = layout({ radiusFn: () => 7, collidePad: 6, large: true })
    const collide = sim.force('collide') as d3.ForceCollide<SimNode>
    const radius = collide.radius() as (d: SimNode) => number
    // radiusFn * sizeMul + collidePad
    expect(radius({} as SimNode)).toBe(7 * 1.2 + 6)
  })

  it('center / soft x-y follow the preset center value', () => {
    const { sim } = layout({ width: 500, height: 300 })
    const center = sim.force('center') as d3.ForceCenter<SimNode>
    const fx = sim.force('x') as d3.ForceX<SimNode>
    expect(center.strength()).toBe(DEFAULT_FORCE_SETTINGS.center)
    // soft x/y = min(0.06, center * 0.5); forceX wraps the constant in an accessor
    expect((fx.strength() as () => number)()).toBe(
      Math.min(0.06, DEFAULT_FORCE_SETTINGS.center * 0.5)
    )
  })

  it('presets keep the circular-cloud DNA across all four options', () => {
    // Guard: every preset must be a valid full settings object (no undefined dials)
    for (const p of Object.values(FORCE_PRESETS)) {
      const f = p.forces
      expect(typeof f.center).toBe('number')
      expect(typeof f.charge).toBe('number')
      expect(typeof f.linkDist).toBe('number')
      expect(typeof f.linkStr).toBe('number')
      expect(typeof f.collide).toBe('number')
      expect(Number.isFinite(f.center)).toBe(true)
    }
  })
})

// ─── Layout regression: bounding-box sanity per preset ─────────────────────
// Runs the real d3 force simulation (same wiring as GraphCanvas/LocalGraphCanvas)
// on a synthetic cluster graph, then asserts the settled layout neither explodes
// (nodes fly off canvas) nor collapses (everything stacks on the center).

/**
 * Deterministic vault-like graph: 3 clusters (hub + leaves) + 2 tag hubs.
 * leavesPerCluster lets tests scale the graph past the 40-node "large" cut.
 */
function buildSyntheticGraph(leavesPerCluster = 10): { nodes: SimNode[]; links: SimLink[] } {
  const nodes: SimNode[] = []
  const links: SimLink[] = []
  let seq = 0
  const addNote = (title: string, degree: number): SimNode => {
    const n: SimNode = {
      id: `n${seq++}`,
      title,
      type: 'note',
      path: `/${title}.md`,
      relativePath: `${title}.md`,
      tags: [],
      degree
    }
    nodes.push(n)
    return n
  }

  const CLUSTERS = 3
  const LEAVES_PER_CLUSTER = leavesPerCluster
  const hubs: SimNode[] = []
  for (let c = 0; c < CLUSTERS; c++) {
    const hub = addNote(`hub-${c}`, LEAVES_PER_CLUSTER + 1)
    hubs.push(hub)
    for (let l = 0; l < LEAVES_PER_CLUSTER; l++) {
      const leaf = addNote(`c${c}-leaf-${l}`, 1)
      links.push({
        id: `${hub.id}->${leaf.id}`,
        type: 'wiki_link',
        source: hub.id,
        target: leaf.id
      })
    }
  }
  // Ring between hubs so clusters connect into one cloud
  for (let c = 0; c < CLUSTERS; c++) {
    const a = hubs[c]
    const b = hubs[(c + 1) % CLUSTERS]
    links.push({ id: `${a.id}->${b.id}`, type: 'wiki_link', source: a.id, target: b.id })
  }
  // Two tag nodes with weak (damped) tag edges
  const tagA: SimNode = { ...addNote('#area-a', 2), isTag: true, type: 'tag' }
  const tagB: SimNode = { ...addNote('#area-b', 2), isTag: true, type: 'tag' }
  links.push(
    { id: `${tagA.id}->${hubs[0].id}`, type: 'tag', source: tagA.id, target: hubs[0].id },
    { id: `${tagB.id}->${hubs[1].id}`, type: 'tag', source: tagB.id, target: hubs[1].id },
    { id: `${tagA.id}->${tagB.id}`, type: 'tag', source: tagA.id, target: tagB.id }
  )
  return { nodes, links }
}

/** Golden-angle spiral seed (same idea as GraphCanvas spiralSeed) */
function spiralSeed(i: number, n: number, w: number, h: number): { x: number; y: number } {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const r = Math.min(w, h) * 0.3 * Math.sqrt(i / n)
  const theta = i * golden
  return { x: w / 2 + Math.cos(theta) * r, y: h / 2 + Math.sin(theta) * r }
}

interface SettleResult {
  /** bounding box of settled node positions (world units) */
  width: number
  height: number
  diag: number
  maxR: number
  count: number
}

/**
 * Build the synthetic graph, run the shared force layout to settle,
 * and measure the resulting bounding box. Mirrors global graph wiring:
 * forceLink + applyForceLayout on a 600×400 world, sync via stop()+tick().
 */
function settlePreset(
  forces: GraphForceSettings,
  opts?: { large?: boolean; width?: number; height?: number; ticks?: number }
): SettleResult {
  const width = opts?.width ?? 600
  const height = opts?.height ?? 400
  const large = opts?.large ?? false
  const { nodes, links } = buildSyntheticGraph()

  nodes.forEach((n, i) => {
    const p = spiralSeed(i, nodes.length, width, height)
    n.x = p.x
    n.y = p.y
  })

  const sim = d3
    .forceSimulation<SimNode>(nodes)
    .force(
      'link',
      d3.forceLink<SimNode, SimLink>(links).id((d) => d.id)
    )
    .velocityDecay(OBSIDIAN_SIM.velocityDecay)
    .alphaDecay(OBSIDIAN_SIM.alphaDecay)
    .alphaMin(OBSIDIAN_SIM.alphaMin)
    .alpha(0.72)
    .stop()

  applyForceLayout(sim as d3.Simulation<SimNode, undefined>, forces, {
    width,
    height,
    large
  })
  sim.tick(opts?.ticks ?? 300)

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let valid = 0
  for (const n of nodes) {
    if (n.x == null || n.y == null || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
    valid++
    minX = Math.min(minX, n.x)
    maxX = Math.max(maxX, n.x)
    minY = Math.min(minY, n.y)
    maxY = Math.max(maxY, n.y)
  }
  const w = maxX - minX
  const h = maxY - minY
  return {
    width: w,
    height: h,
    diag: Math.hypot(w, h),
    maxR: Math.hypot(
      Math.max(Math.abs(minX - width / 2), Math.abs(maxX - width / 2)),
      Math.max(Math.abs(minY - height / 2), Math.abs(maxY - height / 2))
    ),
    count: valid
  }
}

describe('layout regression — bounding box per preset (no explode / no collapse)', () => {
  it('settles every node (finite positions)', () => {
    for (const [key, p] of Object.entries(FORCE_PRESETS)) {
      const r = settlePreset(p.forces)
      expect(r.count, `preset ${key}`).toBeGreaterThanOrEqual(30)
    }
  })

  it('does not explode: bounding box stays within a sane multiple of the canvas', () => {
    for (const [key, p] of Object.entries(FORCE_PRESETS)) {
      const r = settlePreset(p.forces)
      // World box far beyond canvas = blown-out spider (hub charge too strong).
      // Calibrated: relaxed (widest) measures ~462×517 @ maxR~379; ~2× headroom
      // still trips on a real blow-out (doubled charge spreads the cloud ~2×).
      expect(r.width, `preset ${key} width`).toBeLessThan(1000)
      expect(r.height, `preset ${key} height`).toBeLessThan(800)
      expect(r.maxR, `preset ${key} maxR`).toBeLessThan(750)
    }
  })

  it('does not collapse: nodes spread into a real cloud (not a center blob)', () => {
    for (const [key, p] of Object.entries(FORCE_PRESETS)) {
      const r = settlePreset(p.forces)
      expect(r.width, `preset ${key} width`).toBeGreaterThan(120)
      expect(r.height, `preset ${key} height`).toBeGreaterThan(80)
    }
  })

  it('large-graph path (damped charge) still stays bounded', () => {
    const r = settlePreset(FORCE_PRESETS.default.forces, { large: true, width: 1200, height: 800 })
    // Measured ~240×244 — 3× headroom, still trips on a large-graph blow-out
    expect(r.width).toBeLessThan(700)
    expect(r.height).toBeLessThan(500)
    expect(r.width).toBeGreaterThan(150)
    expect(r.count).toBeGreaterThanOrEqual(30)
  })

  it('preset ranking by spread: compact < default ≈ cluster < relaxed', () => {
    const compact = settlePreset(FORCE_PRESETS.compact.forces)
    const def = settlePreset(FORCE_PRESETS.default.forces)
    const cluster = settlePreset(FORCE_PRESETS.clustered.forces)
    const relaxed = settlePreset(FORCE_PRESETS.relaxed.forces)
    // Compact is the tightest ball
    expect(compact.diag).toBeLessThan(def.diag)
    // Relaxed is the airiest
    expect(relaxed.diag).toBeGreaterThan(cluster.diag)
    // Cluster separates communities → clearly wider than the compact ball
    expect(cluster.diag).toBeGreaterThan(compact.diag)
  })
})

// ─── Local graph layout regression (mini canvas) ──────────────────────────
// Mirrors LocalGraphCanvas wiring exactly (via shared graphShared helpers):
// scaleLocalForces, center node pinned at canvas middle, local sim cooling,
// localRadius, tight chargeRange and collidePad. Same no-explode / no-collapse
// guards on a small canvas.

interface LocalSettleResult extends SettleResult {
  /** settled position of the pinned center node (hub-0) */
  centerX: number
  centerY: number
}

/**
 * Run the local-graph layout on the synthetic graph, settle, and measure
 * the bounding box + center node position. Mirrors LocalGraphCanvas: center
 * pinned at width/2,height/2 via fx/fy, scaleLocalForces, local sim cooling,
 * radiusFn + chargeRange + collidePad overrides.
 */
function settleLocalPreset(
  presetForces: GraphForceSettings,
  opts?: { width?: number; height?: number; ticks?: number; leavesPerCluster?: number }
): LocalSettleResult {
  const width = opts?.width ?? 500
  const height = opts?.height ?? 220
  const { nodes, links } = buildSyntheticGraph(opts?.leavesPerCluster ?? 10)

  nodes.forEach((n, i) => {
    const p = spiralSeed(i, nodes.length, width, height)
    n.x = p.x
    n.y = p.y
  })
  // LocalGraphCanvas pins the center node (hub-0 here) to canvas middle
  const center = nodes.find((n) => n.title === 'hub-0')
  if (center) {
    center.isCenter = true
    center.fx = width / 2
    center.fy = height / 2
    center.pinned = true
  }

  const m = scaleLocalForces(presetForces)
  const sim = d3
    .forceSimulation<SimNode>(nodes)
    .force(
      'link',
      d3.forceLink<SimNode, SimLink>(links).id((d) => d.id)
    )
    .velocityDecay(OBSIDIAN_SIM.velocityDecay)
    .alphaDecay(Math.min(0.05, OBSIDIAN_SIM.alphaDecay + 0.012))
    .alphaMin(0.012)
    .alpha(0.65)
    .stop()

  applyForceLayout(sim as d3.Simulation<SimNode, undefined>, m, {
    width,
    height,
    large: nodes.length > 40,
    radiusFn: localRadius,
    chargeRange: Math.max(140, m.linkDist * 3),
    collidePad: 6
  })
  sim.tick(opts?.ticks ?? 300)

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let valid = 0
  for (const n of nodes) {
    if (n.x == null || n.y == null || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
    valid++
    minX = Math.min(minX, n.x)
    maxX = Math.max(maxX, n.x)
    minY = Math.min(minY, n.y)
    maxY = Math.max(maxY, n.y)
  }
  const w = maxX - minX
  const h = maxY - minY
  return {
    width: w,
    height: h,
    diag: Math.hypot(w, h),
    maxR: Math.hypot(
      Math.max(Math.abs(minX - width / 2), Math.abs(maxX - width / 2)),
      Math.max(Math.abs(minY - height / 2), Math.abs(maxY - height / 2))
    ),
    count: valid,
    centerX: center?.x ?? NaN,
    centerY: center?.y ?? NaN
  }
}

describe('local graph layout regression — mini canvas (no explode / no collapse)', () => {
  it('settles every node (finite positions)', () => {
    for (const [key, p] of Object.entries(FORCE_PRESETS)) {
      const r = settleLocalPreset(p.forces)
      expect(r.count, `preset ${key}`).toBeGreaterThanOrEqual(30)
    }
  })

  it('does not explode: mini-canvas bounding box stays bounded', () => {
    for (const [key, p] of Object.entries(FORCE_PRESETS)) {
      const r = settleLocalPreset(p.forces)
      // Calibrated: relaxed (widest local) ~378×375 @ maxR~284; ~1.8× headroom
      expect(r.width, `preset ${key} width`).toBeLessThan(700)
      expect(r.height, `preset ${key} height`).toBeLessThan(700)
      expect(r.maxR, `preset ${key} maxR`).toBeLessThan(520)
    }
  })

  it('does not collapse: local cloud spreads out of the center blob', () => {
    for (const [key, p] of Object.entries(FORCE_PRESETS)) {
      const r = settleLocalPreset(p.forces)
      // Compact (tightest local) ~174×168
      expect(r.width, `preset ${key} width`).toBeGreaterThan(100)
      expect(r.height, `preset ${key} height`).toBeGreaterThan(80)
    }
  })

  it('mini scaling keeps preset ranking: compact < default ≈ cluster < relaxed', () => {
    const compact = settleLocalPreset(FORCE_PRESETS.compact.forces)
    const def = settleLocalPreset(FORCE_PRESETS.default.forces)
    const cluster = settleLocalPreset(FORCE_PRESETS.clustered.forces)
    const relaxed = settleLocalPreset(FORCE_PRESETS.relaxed.forces)
    expect(compact.diag).toBeLessThan(def.diag)
    expect(relaxed.diag).toBeGreaterThan(cluster.diag)
    // Cluster separates communities → clearly wider than the compact ball
    expect(cluster.diag).toBeGreaterThan(compact.diag)
  })

  it('center node stays pinned at canvas middle (fx/fy honored)', () => {
    const width = 500
    const height = 220
    const r = settleLocalPreset(FORCE_PRESETS.default.forces, { width, height })
    // The pinned center must NOT drift off canvas middle
    expect(Math.abs(r.centerX - width / 2)).toBeLessThan(0.5)
    expect(Math.abs(r.centerY - height / 2)).toBeLessThan(0.5)
  })

  it('large local graph (>40 nodes) still stays bounded', () => {
    const r = settleLocalPreset(FORCE_PRESETS.default.forces, {
      width: 800,
      height: 360,
      leavesPerCluster: 14
    })
    // 3 hubs + 42 leaves + 2 tags = 47 nodes → large: true path exercised
    expect(r.count).toBeGreaterThanOrEqual(40)
    expect(r.width).toBeLessThan(1100)
    expect(r.height).toBeLessThan(800)
    expect(r.centerX).toBeCloseTo(400, 0)
  })
})
