import { describe, it, expect } from 'vitest'
import * as d3 from 'd3'
import {
  applyForceLayout,
  FORCE_PRESETS,
  DEFAULT_FORCE_SETTINGS,
  chargeFor,
  OBSIDIAN_SIM,
  easeOutCubic,
  easeOutBack
} from './graphShared'
import {
  nodeRadiusFor,
  edgeWidthFor,
  hoverEaseStep,
  HOVER_EASE_IN_MS,
  HOVER_EASE_OUT_MS,
  HOVER_GLOW_ALPHA,
  edgeGlowAlpha,
  labelZoomAlpha,
  HOT_EDGE_COLOR_HS,
  hotEdgeWidth,
  baseEdgeOpacity,
  hotEdgeOpacity,
  PATH_EDGE_OP,
  PATH_EDGE_W,
  baseEdgeWidth,
  MIN_NODE_SCREEN_R,
  MIN_EDGE_SCREEN_W,
  NODE_ENTRY_MS,
  NODE_ENTRY_STAGGER_MS,
  NODE_ENTRY_START_SCALE,
  NODE_ENTRY_START_OP,
  nodeEntryProgress,
  nodeEntryScale,
  nodeEntryOpacity,
  edgeEntryOpacity,
  edgeColorFor,
  SVG_PUSH_THROTTLE_MS,
  shouldThrottleSvgPush,
  DOT_GRID_SPACING,
  DOT_GRID_RADIUS,
  dotGrainColor,
  LABEL_BELOW_GAP,
  labelBelowNode
} from './graphRenderTokens'
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

  describe('labelZoomAlpha', () => {
    it('labels become solid earlier with a lower textFade (G6)', () => {
      // New default 0.75 → solid at k=0.75; old default 0.9 still fading at k=0.8
      expect(labelZoomAlpha(0.8, 0.75, 0)).toBe(1)
      expect(labelZoomAlpha(0.8, 0.9, 0)).toBeLessThan(1)
      // At any mid zoom, lower textFade is always brighter than higher
      expect(labelZoomAlpha(0.6, 0.75, 0)).toBeGreaterThan(labelZoomAlpha(0.6, 0.9, 0))
    })

    it('fades to zero far out and stays off-screen safe', () => {
      expect(labelZoomAlpha(0.1, 0.75, 0)).toBe(0)
      expect(labelZoomAlpha(3, 0.75, 0)).toBe(1)
    })
  })

  describe('labelBelowNode (P3-2)', () => {
    it('anchors the label centered below the node edge, not beside it', () => {
      // Node center (100, 80) with a 6px screen radius → label sits under it
      const pos = labelBelowNode(100, 80, 6)
      expect(pos.x).toBe(100)
      expect(pos.y).toBe(80 + 6 + LABEL_BELOW_GAP)
    })

    it('zero radius still leaves a readable gap (never overlaps the node)', () => {
      expect(labelBelowNode(50, 50, 0).y).toBe(50 + LABEL_BELOW_GAP)
    })

    it('is purely vertical — zoom never moves the label sideways (Obsidian look)', () => {
      expect(labelBelowNode(-37, 12, 4.5).x).toBe(-37)
      expect(labelBelowNode(-37, 12, 4.5).y).toBe(12 + 4.5 + LABEL_BELOW_GAP)
    })
  })

  describe('hover glow (G8)', () => {
    it('hover-only node glow is raised above the old 0.08 but below path glow', () => {
      // G8: 0.08 was nearly invisible; raised ~75% to 0.14
      expect(HOVER_GLOW_ALPHA).toBeGreaterThan(0.08)
      expect(HOVER_GLOW_ALPHA).toBeLessThan(0.16)
      // Both renderers must call the same constant — no per-renderer drift
      expect(HOVER_GLOW_ALPHA).toBe(0.14)
    })

    it('edge glow scales with hover strength and respects the 0.7 non-path dim', () => {
      // Cold (hs=0) → nearly invisible; full hover → strong
      expect(edgeGlowAlpha(0, false)).toBeLessThan(0.1)
      const hot = edgeGlowAlpha(1, false)
      expect(hot).toBeGreaterThan(0.1)
      // Path edges are not dimmed by *0.7 — brighter than their non-path twin
      expect(edgeGlowAlpha(1, true)).toBeGreaterThan(edgeGlowAlpha(1, false))
      expect(edgeGlowAlpha(1, true)).toBeCloseTo(edgeGlowAlpha(1, false) / 0.7, 3)
    })

    it('edge glow never falls below the clamp or above the cap', () => {
      for (const hs of [0, 0.3, 0.5, 1, 2, -1]) {
        const a = edgeGlowAlpha(hs, false)
        expect(a).toBeGreaterThanOrEqual(0.06)
        expect(a).toBeLessThanOrEqual(0.5)
      }
    })

    it('hot-edge color switch threshold is one shared value in the middle of the ease (G10)', () => {
      // Both renderers read HOT_EDGE_COLOR_HS — a single source so the eased hs
      // flips the edge color at the SAME moment across the SVG→canvas handoff.
      expect(HOT_EDGE_COLOR_HS).toBe(0.45)
      // Sane: past the G5 ~50ms in-ease midpoint (0.5) would feel late;
      // below 0.3 the color pops before the stroke width visibly grows.
      expect(HOT_EDGE_COLOR_HS).toBeGreaterThanOrEqual(0.3)
      expect(HOT_EDGE_COLOR_HS).toBeLessThan(0.6)
    })

    it('hot-edge width ramp is one shared curve (G12)', () => {
      // SVG used lerp(0.85,1.15,hs), canvas lerp(0.85,1.2,hs) — now both read
      // hotEdgeWidth so the stroke-thickness transition is identical at handoff.
      expect(hotEdgeWidth(0)).toBe(0.85)
      expect(hotEdgeWidth(1)).toBe(1.15)
      // Strictly monotonic between the ends
      expect(hotEdgeWidth(0.5)).toBeGreaterThan(0.85)
      expect(hotEdgeWidth(0.5)).toBeLessThan(1.15)
      // Input clamp keeps the curve bounded for out-of-range hs
      expect(hotEdgeWidth(-1)).toBe(0.85)
      expect(hotEdgeWidth(2)).toBe(1.15)
    })

    it('rest edge opacity is one shared value per type (G13)', () => {
      // Both renderers read baseEdgeOpacity — tag edges fainter than notes
      expect(baseEdgeOpacity(true)).toBe(0.45)
      expect(baseEdgeOpacity(false)).toBe(0.55)
    })

    it('hot-edge opacity ramps from the base toward 0.88 with hs (G13)', () => {
      // SVG lerp(base,0.88,hs) vs canvas' old flat 0.7 — now one shared curve
      expect(hotEdgeOpacity(0.55, 0)).toBe(0.55)
      expect(hotEdgeOpacity(0.55, 1)).toBe(0.88)
      expect(hotEdgeOpacity(0.45, 1)).toBe(0.88)
      // Monotonic and starts exactly at the base (no step at hover onset)
      expect(hotEdgeOpacity(0.55, 0.5)).toBeGreaterThan(0.55)
      expect(hotEdgeOpacity(0.55, 0.5)).toBeLessThan(0.88)
      // Clamped inputs stay bounded
      expect(hotEdgeOpacity(0.55, -1)).toBe(0.55)
      expect(hotEdgeOpacity(0.55, 2)).toBe(0.88)
    })

    it('on-path edge opacity is one flat shared value (G15)', () => {
      // Canvas pulsed 0.9+pulse*0.08 (clamp 0.95); SVG was flat 0.92 — a path
      // handoff showed the highlight brightness jump. Both now read PATH_EDGE_OP.
      expect(PATH_EDGE_OP).toBe(0.92)
      // Steady highlight: no breathing, and brighter than any hover ramp (0.88)
      expect(PATH_EDGE_OP).toBeGreaterThan(0.88)
      expect(PATH_EDGE_OP).toBeLessThan(1)
    })

    it('rest edge width is one shared value per type (G16)', () => {
      // SVG tag?0.55:0.75 vs canvas wiki_link?0.75:0.55 — folder/attachment
      // edges were thinner in canvas. Now both read baseEdgeWidth.
      expect(baseEdgeWidth('tag')).toBe(0.55)
      expect(baseEdgeWidth('wiki_link')).toBe(0.75)
      expect(baseEdgeWidth('folder')).toBe(0.75)
      expect(baseEdgeWidth('attachment')).toBe(0.75)
      // Unknown types fall back to the wide 0.75 (SVG rule) — lock the default
      expect(baseEdgeWidth('unknown')).toBe(0.75)
    })

    it('on-path edge width is one flat shared value (G16)', () => {
      // Canvas pulsed 1.5+pulse*0.2 (1.5–1.7); SVG was flat 1.6 — steady like
      // G15 so the path highlight never jumps width across the handoff.
      expect(PATH_EDGE_W).toBe(1.6)
    })
  })

  describe('hoverEaseStep', () => {
    it('closes one time constant (63%) after tau ms', () => {
      expect(hoverEaseStep(0, 1, HOVER_EASE_IN_MS)).toBeCloseTo(1 - Math.exp(-1), 5)
      expect(hoverEaseStep(1, 0, HOVER_EASE_OUT_MS)).toBeCloseTo(Math.exp(-1), 5)
    })

    it('is frame-rate independent: sub-steps equal one larger step', () => {
      // 3 × 20 ms must land exactly where 1 × 60 ms lands (pure exponential)
      const sub = hoverEaseStep(hoverEaseStep(hoverEaseStep(0, 1, 20), 1, 20), 1, 20)
      expect(sub).toBeCloseTo(hoverEaseStep(0, 1, 60), 5)
      // Also for the decelerating (out) path
      const out = hoverEaseStep(hoverEaseStep(1, 0, 16), 0, 16)
      expect(out).toBeCloseTo(hoverEaseStep(1, 0, 32), 5)
    })

    it('never overshoots and returns cur unchanged for non-positive dt', () => {
      expect(hoverEaseStep(0.9, 1, 200)).toBeLessThanOrEqual(1)
      expect(hoverEaseStep(0.1, 0, 200)).toBeGreaterThanOrEqual(0)
      expect(hoverEaseStep(0.5, 1, 0)).toBe(0.5)
      expect(hoverEaseStep(0.5, 0, -10)).toBe(0.5)
    })

    it('is softer out than in (Obsidian feel: snappier in, gentler release)', () => {
      expect(HOVER_EASE_OUT_MS).toBeGreaterThan(HOVER_EASE_IN_MS)
      // After the same elapsed time the "in" path is closer to its target
      expect(hoverEaseStep(0, 1, 100)).toBeGreaterThan(1 - hoverEaseStep(1, 0, 100))
    })
  })

  describe('easeOutCubic (G18 zoom ease)', () => {
    it('lands softly: 0→0, 1→1, midpoint ≈ 0.875', () => {
      expect(easeOutCubic(0)).toBe(0)
      expect(easeOutCubic(1)).toBe(1)
      expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 5)
    })

    it('is monotonic and clamps out-of-range t', () => {
      expect(easeOutCubic(0.25)).toBeLessThan(easeOutCubic(0.5))
      expect(easeOutCubic(-1)).toBe(0)
      expect(easeOutCubic(2)).toBe(1)
    })
  })

  describe('easeOutBack (A-1 node entry spring)', () => {
    it('lands exactly at 1 and clamps out-of-range t', () => {
      expect(easeOutBack(0)).toBe(0)
      expect(easeOutBack(1)).toBe(1)
      expect(easeOutBack(-1)).toBe(0)
      expect(easeOutBack(2)).toBe(1)
    })

    it('overshoots past 1 mid-flight then settles (elastic pop)', () => {
      const peak = Math.max(easeOutBack(0.5), easeOutBack(0.7), easeOutBack(0.8))
      expect(peak).toBeGreaterThan(1)
      // After the peak it must return to exactly 1, not stay above it
      expect(easeOutBack(0.99)).toBeCloseTo(1, 3)
    })
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

describe('node entry animation (G19)', () => {
  describe('nodeEntryProgress', () => {
    it('returns 1 for pre-existing nodes (no born stamp)', () => {
      expect(nodeEntryProgress(1000, undefined, 0, 5)).toBe(1)
    })

    it('returns 0 at birth (staggered delay shifts later nodes out)', () => {
      const born = 5000
      // Order 0 starts immediately
      expect(nodeEntryProgress(born, born, 0, 5)).toBe(0)
      // Last order still delayed at t=0
      expect(nodeEntryProgress(born, born, 4, 5)).toBe(0)
    })

    it('eases to 1 once the entry window + stagger elapsed', () => {
      const born = 5000
      const maxOrder = 5
      const full = born + NODE_ENTRY_MS + NODE_ENTRY_STAGGER_MS + 10
      for (let order = 0; order < maxOrder; order++) {
        expect(nodeEntryProgress(full, born, order, maxOrder)).toBe(1)
      }
    })

    it('is monotonic non-decreasing over time and staggered by order', () => {
      const born = 5000
      const mid = born + NODE_ENTRY_MS / 2
      const pEarly = nodeEntryProgress(born + 1, born, 0, 4)
      const pMid = nodeEntryProgress(mid, born, 0, 4)
      expect(pMid).toBeGreaterThanOrEqual(pEarly)
      // Higher order → delayed → smaller progress at the same instant
      const p0 = nodeEntryProgress(mid, born, 0, 4)
      const p3 = nodeEntryProgress(mid, born, 3, 4)
      expect(p3).toBeLessThanOrEqual(p0)
    })
  })

  describe('nodeEntryScale / nodeEntryOpacity', () => {
    it('scales from START_SCALE to 1 and fades 0→1', () => {
      expect(nodeEntryScale(0)).toBe(NODE_ENTRY_START_SCALE)
      expect(nodeEntryScale(1)).toBe(1)
      expect(nodeEntryOpacity(0)).toBe(NODE_ENTRY_START_OP)
      expect(nodeEntryOpacity(1)).toBe(1)
      // Mid-progress: partially scaled, partially visible
      expect(nodeEntryScale(0.5)).toBeGreaterThan(NODE_ENTRY_START_SCALE)
      expect(nodeEntryScale(0.5)).toBeLessThan(1)
      expect(nodeEntryOpacity(0.5)).toBeGreaterThan(0)
      expect(nodeEntryOpacity(0.5)).toBeLessThan(1)
    })
  })

  describe('edgeEntryOpacity (P1-1 — edges fade with their slowest endpoint)', () => {
    it('steady-state edges (no born stamps) are unaffected (×1)', () => {
      expect(edgeEntryOpacity(5000, undefined, undefined, undefined, undefined, -1)).toBe(1)
    })

    it('edge to a fresh node starts invisible and fades in with it', () => {
      const born = 5000
      // Both endpoints fresh, order 0 → progress 0 at birth
      expect(edgeEntryOpacity(born, born, 0, born, 0, 0)).toBe(NODE_ENTRY_START_OP)
      // A pre-existing node (no born) does not speed the edge up: min wins
      expect(edgeEntryOpacity(born, born, 0, undefined, undefined, 0)).toBe(NODE_ENTRY_START_OP)
    })

    it('reaches 1 once the entry window + stagger elapsed', () => {
      const born = 5000
      const full = born + NODE_ENTRY_MS + NODE_ENTRY_STAGGER_MS + 10
      expect(edgeEntryOpacity(full, born, 0, undefined, undefined, 5)).toBe(1)
      expect(edgeEntryOpacity(full, born, 5, born, 5, 5)).toBe(1)
    })

    it('uses the SLOWEST endpoint (min progress) — parity rule for both renderers', () => {
      const born = 5000
      const mid = born + NODE_ENTRY_MS / 2
      // New (order 0) + old → edge follows the new node's progress, capped at 1:
      // the spring overshoots the node's scale past 1 (elastic pop), but opacity
      // cannot exceed 1, so the steady-state endpoint wins the min once the new
      // node passes 1 (mid-flight overshoot).
      const withOld = edgeEntryOpacity(mid, born, 0, undefined, undefined, 0)
      expect(withOld).toBe(nodeEntryOpacity(Math.min(1, nodeEntryProgress(mid, born, 0, 1))))
      // Two new nodes: slower one (higher order, later stagger) wins
      const a = nodeEntryProgress(mid, born, 0, 2)
      const b = nodeEntryProgress(mid, born, 1, 2)
      expect(edgeEntryOpacity(mid, born, 0, born, 1, 1)).toBe(nodeEntryOpacity(Math.min(a, b)))
      expect(b).toBeLessThan(a)
    })

    it('PNG export (now = +Infinity) renders edges fully', () => {
      const born = 5000
      expect(edgeEntryOpacity(Number.POSITIVE_INFINITY, born, 0, born, 3, 5)).toBe(1)
    })
  })
})

describe('SVG push throttle (G-perf sim motion)', () => {
  it('throttles commits within the window only when enabled', () => {
    const t0 = 1000
    // Within window + throttle on → defer (true)
    expect(shouldThrottleSvgPush(t0 + 10, t0, true)).toBe(true)
    // Just outside the window → commit (false)
    expect(shouldThrottleSvgPush(t0 + SVG_PUSH_THROTTLE_MS + 1, t0, true)).toBe(false)
    // Throttle off (interaction flush) always commits
    expect(shouldThrottleSvgPush(t0 + 1, t0, false)).toBe(false)
    // Never commit more often than the window
    expect(shouldThrottleSvgPush(t0, t0, true)).toBe(true)
  })

  it('exposes the throttle window constant', () => {
    expect(SVG_PUSH_THROTTLE_MS).toBeGreaterThan(0)
    expect(SVG_PUSH_THROTTLE_MS).toBeLessThan(1000)
  })
})

describe('edgeColorFor (G20)', () => {
  const pal = {
    edge: '#edge',
    edgeTag: '#tag',
    edgeFolder: '#folder',
    edgeAttachment: '#att'
  }

  it('default mode: tag gets edgeTag, everything else shares neutral edge', () => {
    expect(edgeColorFor('tag', 'default', pal)).toBe('#tag')
    expect(edgeColorFor('wiki_link', 'default', pal)).toBe('#edge')
    expect(edgeColorFor('folder', 'default', pal)).toBe('#edge')
    expect(edgeColorFor('attachment', 'default', pal)).toBe('#edge')
    expect(edgeColorFor('unknown', 'default', pal)).toBe('#edge')
  })

  it('type mode: each edge type gets its own color, unknown falls back to edge', () => {
    expect(edgeColorFor('wiki_link', 'type', pal)).toBe('#edge')
    expect(edgeColorFor('tag', 'type', pal)).toBe('#tag')
    expect(edgeColorFor('folder', 'type', pal)).toBe('#folder')
    expect(edgeColorFor('attachment', 'type', pal)).toBe('#att')
    expect(edgeColorFor('unknown', 'type', pal)).toBe('#edge')
  })
})

describe('dot-grain underlay (P2-5)', () => {
  it('is a faint rgba in both themes, never a solid fill', () => {
    const dark = dotGrainColor(false)
    const light = dotGrainColor(true)
    for (const c of [dark, light]) {
      expect(c.startsWith('rgba(')).toBe(true)
      const alpha = Number(c.slice(c.lastIndexOf(',') + 1, -1))
      expect(alpha).toBeGreaterThan(0)
      expect(alpha).toBeLessThanOrEqual(0.06)
    }
  })

  it('differs between themes so light bg gets darker dots and vice versa', () => {
    expect(dotGrainColor(true)).not.toBe(dotGrainColor(false))
  })

  it('tile geometry is a small, even screen-space grid', () => {
    expect(DOT_GRID_SPACING).toBeGreaterThan(8)
    expect(DOT_GRID_RADIUS).toBeLessThan(DOT_GRID_SPACING / 6)
    expect(DOT_GRID_RADIUS).toBeGreaterThan(0)
  })
})
