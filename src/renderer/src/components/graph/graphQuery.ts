/**
 * Pure graph query + layout helpers extracted from the GraphCanvas monolith.
 * No React, no DOM — unit-testable in isolation.
 */
import * as d3 from 'd3'
import type {
  GraphNodeData,
  GraphColorGroup,
  GraphDisplayOpts,
  GraphForceSettings,
  GraphPerfMode
} from '../../store/graphStore'
import type { SimNode } from './graphTypes'
import { safeTags, applyForceLayout, type LodLevel } from './graphShared'

/** Obsidian-like display defaults (text fade soft at distance). */
export const DEFAULT_DISPLAY_OPTS: GraphDisplayOpts = {
  arrows: false,
  textFade: 0.9,
  nodeSize: 1,
  lineThickness: 1
}

/**
 * Obsidian-like group query matcher.
 * Space-separated terms, AND semantics; `-term` negates.
 * Prefixes: tag:, path:, file:, type: — bare term matches title/path/tag.
 */
export function matchGroupQuery(query: string, n: GraphNodeData): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return false
  const title = (n.title || '').toLowerCase()
  const path = (n.relativePath || '').toLowerCase().replace(/\\/g, '/')
  const tags = safeTags(n).map((t) => t.toLowerCase())
  return terms.every((raw) => {
    let term = raw
    let neg = false
    if (term.startsWith('-')) {
      neg = true
      term = term.slice(1)
    }
    if (!term) return true
    let hit: boolean
    if (term.startsWith('tag:')) {
      const q = term.slice(4).replace(/^#/, '')
      hit = q.length > 0 && tags.some((t) => t === q || t.startsWith(q + '/'))
    } else if (term.startsWith('path:')) {
      hit = term.length > 5 && path.includes(term.slice(5))
    } else if (term.startsWith('file:')) {
      hit = term.length > 5 && title.includes(term.slice(5))
    } else if (term.startsWith('type:')) {
      hit = term.length > 5 && n.type.toLowerCase() === term.slice(5)
    } else {
      hit = title.includes(term) || path.includes(term) || tags.some((t) => t.includes(term))
    }
    return neg ? !hit : hit
  })
}

/** First matching group wins (Obsidian semantics) */
export function resolveGroupColors(
  nodes: GraphNodeData[],
  groups: GraphColorGroup[]
): Map<string, string> | null {
  if (!groups.length || !nodes.length) return null
  const map = new Map<string, string>()
  for (const n of nodes) {
    for (const g of groups) {
      if (matchGroupQuery(g.query, n)) {
        map.set(n.id, g.color)
        break
      }
    }
  }
  return map.size > 0 ? map : null
}

export function lodLabel(lod: LodLevel, n: number, mode: GraphPerfMode): string {
  return `${lod} · ${n} nodes · ${mode}`
}

/**
 * Apply Obsidian-like force settings onto a live d3 simulation.
 * Delegates to the shared applyForceLayout (graphShared) so Global and Local
 * graphs use identical physics / presets / softened hub charge.
 */
export function applyForces(
  sim: d3.Simulation<SimNode, undefined>,
  forces: GraphForceSettings,
  width: number,
  height: number,
  large: boolean,
  sizeMul = 1
): void {
  applyForceLayout(sim, forces, { width, height, large, sizeMul })
}

/**
 * Obsidian-like opening layout: golden-angle spiral around the center.
 * First render looks organized (ring/cluster feel) instead of a random blob;
 * the force simulation then refines it. (Obsidian opens graphs circularly.)
 */
export function spiralSeed(i: number, n: number, w: number, h: number): { x: number; y: number } {
  if (n <= 0) return { x: w / 2, y: h / 2 }
  const golden = Math.PI * (3 - Math.sqrt(5)) // ~2.39996 rad
  const r = Math.min(w, h) * 0.44 * Math.sqrt(i / n)
  const theta = i * golden
  return { x: w / 2 + Math.cos(theta) * r, y: h / 2 + Math.sin(theta) * r }
}
export type { LodLevel }
