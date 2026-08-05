/**
 * Shared types for GraphCanvas.
 * Extracted to avoid duplication and enable testing.
 */
import type { GraphNodeData, GraphPerfMode } from '../../store/graphStore'

// ── Simulation types ──

export interface SimNode extends d3.SimulationNodeDatum, GraphNodeData {
  pinned?: boolean
  isCenter?: boolean
  /** Entry animation: performance.now() stamp when this node first entered the
   *  sim (layout rebuild / filter change). Undefined on pre-existing nodes. */
  born?: number
  /** Entry animation: per-batch stagger order (0 = enters first). */
  enterOrder?: number
}

export interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  id: string
  type: string
  weight?: number
  source: string | SimNode
  target: string | SimNode
}

// ── Palette ──

export type Palette = {
  isLight: boolean
  bg: string
  edge: string
  edgeTag: string
  edgeFolder: string
  edgeAttachment: string
  edgeHot: string
  label: string
  nodeStroke: string
  colors: Record<string, string>
}

// ── SVG frame types (React rendering) ──

export type SvgEdge = {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
  stroke: string
  sw: number
  op: number
  dash?: string
}

export type SvgNode = {
  key: string
  kind: 'circle' | 'ghost'
  cx: number
  cy: number
  r: number
  fill: string
  stroke: string
  sw: number
  fillOp: number
  strokeOp?: number
}

export type SvgLabel = {
  key: string
  x: number
  y: number
  text: string
  fill: string
  bold: boolean
  op: number
}

export type SvgFrame = {
  w: number
  h: number
  tx: number
  ty: number
  k: number
  edges: SvgEdge[]
  nodes: SvgNode[]
  labels: SvgLabel[]
  hud: string
}

// ── View flags (paint input) ──

export type ViewFlags = {
  searchMatchIds: Set<string> | null
  dimHubs: boolean
  hubThreshold: number
  focusedId: string | null
  pathNodeIds: Set<string> | null
  pathEdgeKeys: Set<string> | null
  pathFromId: string
  pathToId: string
  focusNodeIds: Set<string> | null
  focusEdgeKeys: Set<string> | null
  colorBy: 'default' | 'type' | 'folder'
  edgeColorBy: 'default' | 'type'
  perfMode: GraphPerfMode
  selectedIds: Set<string> | null
  arrows: boolean
  textFade: number
  nodeSize: number
  lineThickness: number
  groupColors: Map<string, string> | null
}
