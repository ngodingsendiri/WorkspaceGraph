/**
 * G-perf: structural sharing for SVG frame builds.
 *
 * paint() rebuilds a full SvgFrame every frame. Without this, every element is
 * a fresh object, so React re-renders + diffs the DOM for thousands of nodes,
 * edges and labels on every commit. With delta merging, an element whose fields
 * are identical to the previous frame reuses the SAME object reference; the
 * memoized SVG element components (React.memo with a single object prop) then
 * bail out with a reference-equality check — no component call, no DOM diff,
 * no layout for unchanged elements.
 *
 * Effective for frames where most elements do NOT change: hover dims a handful
 * of nodes, path/focus/search dim subsets, zoom lands on the same world
 * positions, entry animation reaches steady state, filter changes touch few
 * nodes. (Full sim motion changes positions of everything — that cost is
 * already bounded by the SVG_PUSH_THROTTLE_MS commit throttle.)
 *
 * INVARIANT: after an element object is pushed into a frame, callers must
 * NEVER mutate it in place. Reuse turns any mutation into cross-frame aliasing
 * (a node edited here would silently re-render everywhere its reference is
 * shared). paint() always builds fresh objects each frame and the memo
 * components only read — keep it that way.
 */
import type { SvgEdge, SvgLabel, SvgNode } from './graphTypes'

/** Value equality for a single SVG edge (all render-affecting fields). */
export function sameSvgEdge(a: SvgEdge, b: SvgEdge): boolean {
  return (
    a.key === b.key &&
    a.x1 === b.x1 &&
    a.y1 === b.y1 &&
    a.x2 === b.x2 &&
    a.y2 === b.y2 &&
    a.stroke === b.stroke &&
    a.sw === b.sw &&
    a.op === b.op &&
    a.dash === b.dash
  )
}

/** Value equality for a single SVG node (all render-affecting fields). */
export function sameSvgNode(a: SvgNode, b: SvgNode): boolean {
  return (
    a.key === b.key &&
    a.kind === b.kind &&
    a.cx === b.cx &&
    a.cy === b.cy &&
    a.r === b.r &&
    a.fill === b.fill &&
    a.stroke === b.stroke &&
    a.sw === b.sw &&
    a.fillOp === b.fillOp &&
    a.strokeOp === b.strokeOp &&
    a.dash === b.dash
  )
}

/** Value equality for a single SVG label (all render-affecting fields). */
export function sameSvgLabel(a: SvgLabel, b: SvgLabel): boolean {
  return (
    a.key === b.key &&
    a.x === b.x &&
    a.y === b.y &&
    a.text === b.text &&
    a.fill === b.fill &&
    a.bold === b.bold &&
    a.op === b.op
  )
}

/**
 * Delta-merge a freshly built element list against the previous frame's list.
 *
 * - Element present in prev with identical fields → reuse prev's object
 *   reference (memo bail, zero DOM work).
 * - New / changed element → keep the fresh object.
 * - All elements shared and same length → returns the prev ARRAY reference, so
 *   even the list itself is stable for consumers that compare by identity.
 * - Elements that disappeared are simply dropped (no prune pass needed — the
 *   merged list is rebuilt from prev + fresh only).
 */
export function deltaMerge<T extends { key: string }>(
  prev: readonly T[] | null | undefined,
  fresh: readonly T[],
  same: (a: T, b: T) => boolean
): T[] {
  if (!prev || prev.length === 0) return [...fresh]
  if (fresh.length === 0) return []
  const prevByKey = new Map<string, T>()
  for (const p of prev) prevByKey.set(p.key, p)

  const out: T[] = new Array(fresh.length)
  let allShared = fresh.length === prev.length
  for (let i = 0; i < fresh.length; i++) {
    const f = fresh[i]
    const p = prevByKey.get(f.key)
    if (p && same(p, f)) {
      out[i] = p
    } else {
      out[i] = f
      allShared = false
    }
  }
  // All elements unchanged and same count → return the SAME array reference so
  // even the list identity is stable (memo consumers can bail on it directly).
  return allShared ? (prev as T[]) : out
}
