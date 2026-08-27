/**
 * M8 API-3: typed IPC payload validation helpers.
 */
import { describe, it, expect } from 'vitest'
import { validateShape, validateArrayOf } from './ipcValidation'

const USER_SHAPE = {
  id: { type: 'string' },
  age: { type: 'number' },
  tags: { type: 'string[]' },
  meta: { type: 'object' },
  active: { type: 'boolean', optional: true }
} as const

describe('M8 API-3 — validateShape', () => {
  it('accepts a well-formed payload', () => {
    const r = validateShape({ id: 'a', age: 3, tags: ['x'], meta: { k: 1 }, active: true }, USER_SHAPE)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.id).toBe('a')
  })

  it('rejects non-object payloads', () => {
    for (const bad of [null, undefined, 'x', 5, [1, 2]]) {
      expect(validateShape(bad, USER_SHAPE).ok).toBe(false)
    }
  })

  it('rejects missing required fields', () => {
    const r = validateShape({ id: 'a' }, USER_SHAPE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('missing required')
  })

  it('rejects wrong field type', () => {
    const r = validateShape({ id: 'a', age: 'nope', tags: [], meta: {} }, USER_SHAPE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('age')
  })

  it('allows unknown extra fields (forward compat)', () => {
    const r = validateShape({ id: 'a', age: 1, tags: [], meta: {}, future: 42 }, USER_SHAPE)
    expect(r.ok).toBe(true)
  })

  it('optional fields may be absent', () => {
    const r = validateShape({ id: 'a', age: 1, tags: [], meta: {} }, USER_SHAPE)
    expect(r.ok).toBe(true)
  })
})

describe('M8 API-3 — validateArrayOf', () => {
  it('accepts an array of valid items', () => {
    const r = validateArrayOf(
      [
        { id: 'a', age: 1, tags: [], meta: {} },
        { id: 'b', age: 2, tags: ['t'], meta: { x: 1 } }
      ],
      USER_SHAPE
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toHaveLength(2)
  })

  it('rejects non-array payloads', () => {
    expect(validateArrayOf('nope', USER_SHAPE).ok).toBe(false)
  })

  it('rejects a bad item with its index', () => {
    const r = validateArrayOf([{ id: 'a', age: 1, tags: [], meta: {} }, { id: 9, age: 1, tags: [], meta: {} }], USER_SHAPE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('item 1')
  })
})
