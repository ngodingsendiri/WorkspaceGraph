import { describe, it, expect } from 'vitest'
import { validateToolArgs } from './toolArgsValidation'

const objSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): Parameters<typeof validateToolArgs>[0] => ({
  type: 'object',
  properties,
  required
})

describe('validateToolArgs (M2.5 / MC-6)', () => {
  it('lulus untuk args valid', () => {
    const schema = objSchema({ path: { type: 'string' }, limit: { type: 'number' } }, ['path'])
    expect(validateToolArgs(schema, { path: 'Notes/a.md', limit: 5 }).ok).toBe(true)
    // optional omitted
    expect(validateToolArgs(schema, { path: 'Notes/a.md' }).ok).toBe(true)
  })

  it('menolak properti required yang hilang', () => {
    const schema = objSchema({ path: { type: 'string' }, content: { type: 'string' } }, [
      'path',
      'content'
    ])
    const r = validateToolArgs(schema, { path: 'a.md' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('missing required: content')
  })

  it('menolak tipe yang salah dengan path yang jelas', () => {
    const r = validateToolArgs(objSchema({ query: { type: 'string' } }, ['query']), {
      query: 42
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('query: expected string')

    const num = validateToolArgs(objSchema({ limit: { type: 'number' } }), { limit: 'many' })
    expect(num.ok).toBe(false)
    if (!num.ok) expect(num.message).toContain('limit: expected number')
  })

  it('menolak non-object pada root', () => {
    const schema = objSchema({ query: { type: 'string' } })
    for (const bad of ['not-an-object', [1, 2], 42]) {
      const r = validateToolArgs(schema, bad)
      expect(r.ok).toBe(false)
    }
  })

  it('menolak nilai di luar enum', () => {
    const schema = objSchema({ role: { type: 'string', enum: ['general', 'writer'] } }, ['role'])
    const bad = validateToolArgs(schema, { role: 'admin' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message).toContain('value not allowed')
    expect(validateToolArgs(schema, { role: 'writer' }).ok).toBe(true)
  })

  it('memvalidasi array items', () => {
    const schema = objSchema({ steps: { type: 'array', items: { type: 'string' } } }, ['steps'])
    expect(validateToolArgs(schema, { steps: ['a', 'b'] }).ok).toBe(true)
    const bad = validateToolArgs(schema, { steps: ['a', 42] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message).toContain('[1]: expected string')
    expect(validateToolArgs(schema, { steps: 'not-array' }).ok).toBe(false)
  })

  it('sanitasi memblokir prototype pollution via __proto__', () => {
    const schema = objSchema({ safe: { type: 'string' } })
    const malicious = JSON.parse('{"__proto__": {"polluted": true}, "safe": "ok"}')
    const r = validateToolArgs(schema, malicious)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // The sanitized copy is prototype-safe — no pollution escapes
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype)
      expect(r.value.safe).toBe('ok')
    }
  })

  it('tidak pernah melempar — input aneh tetap menghasilkan hasil, bukan crash', () => {
    const schema = objSchema({ x: { type: 'string' } })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => validateToolArgs(schema, circular)).not.toThrow()
    expect(validateToolArgs(schema, null).ok).toBe(true) // coerced to {}
  })

  it('unknown property diteruskan (tanpa additionalProperties: false)', () => {
    const schema = objSchema({ a: { type: 'string' } })
    const r = validateToolArgs(schema, { a: 'x', extra: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.extra).toBe(1)
  })

  it('menolak unknown property bila additionalProperties: false', () => {
    const schema: Parameters<typeof validateToolArgs>[0] = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: [],
      additionalProperties: false
    }
    const r = validateToolArgs(schema, { a: 'x', extra: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('unknown property: extra')
  })

  it('args null/undefined dipaksa menjadi objek kosong (tool tanpa argumen)', () => {
    expect(validateToolArgs(objSchema({}), null).ok).toBe(true)
    expect(validateToolArgs(objSchema({}), undefined).ok).toBe(true)
  })
})
