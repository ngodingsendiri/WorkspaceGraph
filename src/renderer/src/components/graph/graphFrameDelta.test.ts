import { describe, it, expect } from 'vitest'
import { sameSvgEdge, sameSvgNode, sameSvgLabel, deltaMerge } from './graphFrameDelta'
import type { SvgEdge, SvgNode, SvgLabel } from './graphTypes'

function edge(over: Partial<SvgEdge> = {}): SvgEdge {
  return {
    key: 'a->b',
    x1: 0,
    y1: 0,
    x2: 10,
    y2: 10,
    stroke: '#888',
    sw: 1.2,
    op: 0.8,
    dash: undefined,
    ...over
  }
}

function node(over: Partial<SvgNode> = {}): SvgNode {
  return {
    key: 'n1',
    kind: 'circle',
    cx: 5,
    cy: 5,
    r: 8,
    fill: '#fff',
    stroke: '#333',
    sw: 1,
    fillOp: 1,
    strokeOp: 1,
    ...over
  }
}

function label(over: Partial<SvgLabel> = {}): SvgLabel {
  return {
    key: 'l1',
    x: 5,
    y: 5,
    text: 'Note',
    fill: '#ccc',
    bold: false,
    op: 0.9,
    ...over
  }
}

describe('sameSvg* value equality', () => {
  it('edge: identical → true, any field change → false', () => {
    const a = edge()
    expect(sameSvgEdge(a, edge())).toBe(true)
    expect(sameSvgEdge(a, edge({ x1: 1 }))).toBe(false)
    expect(sameSvgEdge(a, edge({ sw: 2 }))).toBe(false)
    expect(sameSvgEdge(a, edge({ op: 0.1 }))).toBe(false)
    expect(sameSvgEdge(a, edge({ dash: '3 4' }))).toBe(false)
    expect(sameSvgEdge(a, edge({ stroke: '#000' }))).toBe(false)
  })

  it('node: identical → true, any field change → false', () => {
    const a = node()
    expect(sameSvgNode(a, node())).toBe(true)
    expect(sameSvgNode(a, node({ cx: 1 }))).toBe(false)
    expect(sameSvgNode(a, node({ r: 4 }))).toBe(false)
    expect(sameSvgNode(a, node({ kind: 'ghost' }))).toBe(false)
    expect(sameSvgNode(a, node({ fillOp: 0.5 }))).toBe(false)
  })

  it('label: identical → true, any field change → false', () => {
    const a = label()
    expect(sameSvgLabel(a, label())).toBe(true)
    expect(sameSvgLabel(a, label({ text: 'Other' }))).toBe(false)
    expect(sameSvgLabel(a, label({ bold: true }))).toBe(false)
    expect(sameSvgLabel(a, label({ op: 0.2 }))).toBe(false)
  })
})

describe('deltaMerge', () => {
  it('no prev → fresh copy (own references)', () => {
    const fresh = [edge({ key: 'a' }), edge({ key: 'b' })]
    const out = deltaMerge(undefined, fresh, sameSvgEdge)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(fresh[0])
    expect(out[1]).toBe(fresh[1])
  })

  it('all identical + same count → returns the PREV array reference', () => {
    const prev = [edge({ key: 'a' }), edge({ key: 'b' })]
    const fresh = [edge({ key: 'a' }), edge({ key: 'b' })]
    const out = deltaMerge(prev, fresh, sameSvgEdge)
    expect(out).toBe(prev) // same identity → memo consumers can bail
  })

  it('one changed element → keeps prev refs for the rest, fresh for the change', () => {
    const prev = [edge({ key: 'a' }), edge({ key: 'b' }), edge({ key: 'c' })]
    const changed = edge({ key: 'b', op: 0.2 })
    const fresh = [edge({ key: 'a' }), changed, edge({ key: 'c' })]
    const out = deltaMerge(prev, fresh, sameSvgEdge)
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(prev[0]) // unchanged → reused
    expect(out[1]).toBe(changed) // changed → fresh
    expect(out[2]).toBe(prev[2]) // unchanged → reused
  })

  it('order change with identical content → stable prev array (React reconciles by key)', () => {
    const pa = edge({ key: 'a' })
    const pb = edge({ key: 'b' })
    const prev = [pa, pb]
    const fresh = [pb, pa]
    const out = deltaMerge(prev, fresh, sameSvgEdge)
    // All-shared → SAME array reference; element ORDER is prev's (React keys
    // handle ordering, so returning the stable identity is the win).
    expect(out).toBe(prev)
    expect(out[0]).toBe(pa)
    expect(out[1]).toBe(pb)
  })

  it('removed elements are dropped; new elements appear', () => {
    const prev = [edge({ key: 'a' }), edge({ key: 'b' })]
    const fresh = [edge({ key: 'a' }), edge({ key: 'c', op: 0.5 })]
    const out = deltaMerge(prev, fresh, sameSvgEdge)
    expect(out.map((e) => e.key)).toEqual(['a', 'c'])
    expect(out[0]).toBe(prev[0])
  })

  it('fresh empty → empty array', () => {
    expect(deltaMerge([edge()], [], sameSvgEdge)).toEqual([])
    expect(deltaMerge(undefined, [], sameSvgEdge)).toEqual([])
  })

  it('node + label merges behave identically', () => {
    const prevN = [node(), node({ key: 'n2' })]
    const freshN = [node(), node({ key: 'n2' })]
    expect(deltaMerge(prevN, freshN, sameSvgNode)).toBe(prevN)

    const prevL = [label(), label({ key: 'l2' })]
    const freshL = [label({ key: 'l2' }), label({ key: 'l3' })]
    const outL = deltaMerge(prevL, freshL, sameSvgLabel)
    expect(outL.map((l) => l.key)).toEqual(['l2', 'l3'])
    expect(outL[0]).toBe(prevL[1])
  })
})

describe('deltaMerge benchmark (1000 elements)', () => {
  it('identical frame → zero new element references (memo bail target)', () => {
    const prev = Array.from({ length: 1000 }, (_, i) =>
      edge({ key: `n${i}->n${i + 1}`, x1: i, y1: i, x2: i + 1, y2: i + 1 })
    )
    const fresh = prev.map((e) => ({ ...e })) // new objects, same values
    const out = deltaMerge(prev, fresh, sameSvgEdge)
    // Every output element must be a PREV reference — React.memo bails on all
    let reused = 0
    for (let i = 0; i < out.length; i++) if (out[i] === prev[i]) reused++
    expect(reused).toBe(1000)
  })

  it('10% changed frame → only changed elements are fresh objects', () => {
    const prev = Array.from({ length: 1000 }, (_, i) =>
      edge({ key: `n${i}->n${i + 1}`, x1: i, y1: i, x2: i + 1, y2: i + 1 })
    )
    const fresh = prev.map((e, i) => (i % 10 === 0 ? { ...e, op: 0.3 } : { ...e }))
    const out = deltaMerge(prev, fresh, sameSvgEdge)
    let reused = 0
    for (let i = 0; i < out.length; i++) if (out[i] === prev[i]) reused++
    expect(reused).toBe(900)
  })
})
