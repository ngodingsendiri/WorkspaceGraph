import { describe, it, expect } from 'vitest'
import * as d3 from 'd3'
import {
  applyForceLayout,
  FORCE_PRESETS,
  DEFAULT_FORCE_SETTINGS,
  chargeFor,
  OBSIDIAN_SIM,
  nodeRadiusFor,
  edgeWidthFor,
  MIN_NODE_SCREEN_R,
  MIN_EDGE_SCREEN_W
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
// Runs the real d3 force simulation (same wiring as GraphCanvas)
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

// ─── Obsidian rubber-band: drag reheat propagates spring motion ────────────
// The “rubber band” feel comes from reheating the sim when a node is grabbed:
// linked neighbors follow the drag with springy lag. A settled (cold) sim must
// NOT react — forces are scaled by alpha, so alpha≈0 means a dead graph.

describe('Obsidian rubber-band drag physics', () => {
  /** Build a settled 3-cluster graph; returns sim + hub-0 + its linked ids. */
  function settledGraph(): {
    sim: d3.Simulation<SimNode, undefined>
    hub: SimNode
    linkedIds: string[]
  } {
    const { nodes, links } = buildSyntheticGraph(6)
    nodes.forEach((n, i) => {
      const p = spiralSeed(i, nodes.length, 600, 400)
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
    applyForceLayout(sim as d3.Simulation<SimNode, undefined>, DEFAULT_FORCE_SETTINGS, {
      width: 600,
      height: 400,
      large: false
    })
    sim.tick(300)
    const hub = nodes[0]!
    const linkedIds = links
      .filter((l) => l.source === hub || l.target === hub)
      .map((l) => (l.source === hub ? (l.target as SimNode).id : (l.source as SimNode).id))
    return { sim, hub, linkedIds }
  }

  function snapshotPositions(
    sim: d3.Simulation<SimNode, undefined>
  ): Map<string, { x: number; y: number }> {
    return new Map(sim.nodes().map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]))
  }

  function countMoved(
    sim: d3.Simulation<SimNode, undefined>,
    ids: string[],
    before: Map<string, { x: number; y: number }>,
    threshold: number
  ): number {
    let moved = 0
    for (const n of sim.nodes()) {
      if (!ids.includes(n.id)) continue
      const b = before.get(n.id)
      if (!b || n.x == null || n.y == null) continue
      if (Math.hypot(n.x - b.x, n.y - b.y) > threshold) moved++
    }
    return moved
  }

  it('reheating on grab propagates the drag to linked leaves (rubber stretch)', () => {
    const { sim, hub, linkedIds } = settledGraph()
    const before = snapshotPositions(sim)
    // Grab: pin hub far to the right and reheat exactly like GraphCanvas
    hub.fx = (hub.x ?? 0) + 260
    hub.fy = hub.y
    sim.alphaTarget(OBSIDIAN_SIM.dragAlphaTarget)
    sim.alpha(Math.max(sim.alpha(), OBSIDIAN_SIM.dragAlpha)).restart()
    sim.tick(60)
    // Linked leaves were dragged along — the rubber stretch is visible
    expect(countMoved(sim, linkedIds, before, 12)).toBeGreaterThan(0)
  })

  it('a settled (cold) sim barely reacts — reheating is what makes it elastic', () => {
    const { sim, hub, linkedIds } = settledGraph()
    const before = snapshotPositions(sim)
    hub.fx = (hub.x ?? 0) + 260
    hub.fy = hub.y
    // OLD behavior: no reheat — alpha stays at its settled near-zero value
    sim.restart()
    sim.tick(60)
    expect(countMoved(sim, linkedIds, before, 12)).toBe(0)
  })

  it('nodeRadiusFor keeps nodes >= ~2.5px on screen at ANY zoom (shared SVG+Canvas rule)', () => {
    // At deep zoom-out the world radius shrinks, but the screen floor wins
    const rWorldFar = nodeRadiusFor(0, 1, false, 0.3)
    expect(rWorldFar * 0.3).toBeGreaterThanOrEqual(MIN_NODE_SCREEN_R - 0.01)
    // At zoom-in the floor backs off and the world radius (degree-driven) rules
    const rWorldNear = nodeRadiusFor(8, 1, false, 2.5)
    expect(rWorldNear).toBeGreaterThan(nodeRadiusFor(0, 1, false, 2.5))
    expect(rWorldNear * 2.5).toBeGreaterThan(MIN_NODE_SCREEN_R)
    // Never below the world radius — floor only ever enlarges
    const kSafe = 0.01 // extreme zoom-out, floor clamps at 0.05
    const rWorld = nodeRadiusFor(12, 1, false, kSafe)
    expect(rWorld).toBeGreaterThanOrEqual(nodeRadiusFor(12, 1, false, 1) / 1)
    expect(rWorld * 0.05).toBeGreaterThanOrEqual(MIN_NODE_SCREEN_R - 0.01)
  })

  it('nodeRadiusFor applies tag/ghost shrink and hub dim consistently', () => {
    // Tags draw ~0.9x the base size in both renderers
    const base = nodeRadiusFor(4, 1, false, 1)
    const tag = nodeRadiusFor(4, 1, false, 1, 0.9)
    expect(tag).toBeCloseTo(base * 0.9)
    // Hub dim (0.7x) still applies on top of the shared floor
    const dim = nodeRadiusFor(4, 1, true, 1)
    expect(dim).toBeLessThan(nodeRadiusFor(4, 1, false, 1))
    expect(dim).toBeGreaterThanOrEqual(MIN_NODE_SCREEN_R)
  })

  it('edgeWidthFor keeps edges visible when zoomed out (shared floor)', () => {
    const far = edgeWidthFor(0.75, 0.3)
    expect(far * 0.3).toBeGreaterThanOrEqual(MIN_EDGE_SCREEN_W - 0.01)
    // World width passes through when it already exceeds the floor
    expect(edgeWidthFor(1.6, 1)).toBe(1.6)
    expect(edgeWidthFor(0.75, 2)).toBe(0.75)
  })

  it('releasing the grab leaves a soft recoil instead of a dead stop', () => {
    const { sim, hub } = settledGraph()
    hub.fx = (hub.x ?? 0) + 260
    hub.fy = hub.y
    sim.alphaTarget(OBSIDIAN_SIM.dragAlphaTarget)
    sim.alpha(Math.max(sim.alpha(), OBSIDIAN_SIM.dragAlpha)).restart()
    sim.tick(40)
    // Release: cool back down but with a recoil reheat (GraphCanvas endGesture)
    sim.alphaTarget(0)
    sim.alpha(Math.max(sim.alpha(), OBSIDIAN_SIM.releaseAlpha)).restart()
    const before = new Map(sim.nodes().map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]))
    sim.tick(40)
    // Nodes keep moving after release (spring-back), not a hard freeze
    let stillMoving = 0
    for (const n of sim.nodes()) {
      const b = before.get(n.id)
      if (!b || n.x == null || n.y == null) continue
      if (Math.hypot(n.x - b.x, n.y - b.y) > 1) stillMoving++
    }
    expect(stillMoving).toBeGreaterThan(0)
  })
})
