/**
 * M8 API-3: typed IPC input validation.
 *
 * IPC handlers receive untrusted renderer input. This module gives handlers a
 * tiny, dependency-free way to (a) assert a payload is an object and (b) reject
 * malformed shapes before any engine call — replacing ad-hoc `as never` casts
 * with a single typed boundary check.
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'string[]'

export interface FieldSpec {
  type: FieldType
  optional?: boolean
}

/** Runtime type check for a single value. */
function matches(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
    default:
      return true
  }
}

/**
 * Validate a renderer payload object against a shape spec. Returns the payload
 * (typed) on success, or a rejected result with a message. Unknown extra fields
 * are allowed (forward compat) — only declared fields are checked.
 */
export function validateShape<T extends object>(
  payload: unknown,
  shape: Record<string, FieldSpec>
): { ok: true; value: T } | { ok: false; error: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: 'Invalid payload: expected an object' }
  }
  const record = payload as Record<string, unknown>
  for (const [key, spec] of Object.entries(shape)) {
    const present = key in record
    if (!present) {
      if (spec.optional) continue
      return { ok: false, error: `Invalid payload: missing required field "${key}"` }
    }
    if (!matches(record[key], spec.type)) {
      return { ok: false, error: `Invalid payload: field "${key}" must be a ${spec.type}` }
    }
  }
  return { ok: true, value: record as T }
}

/** Validate a payload is an array of objects with the given id-ish string keys. */
export function validateArrayOf<T extends object>(
  payload: unknown,
  itemSpec: Record<string, FieldSpec>
): { ok: true; value: T[] } | { ok: false; error: string } {
  if (!Array.isArray(payload)) {
    return { ok: false, error: 'Invalid payload: expected an array' }
  }
  for (let i = 0; i < payload.length; i++) {
    const item = validateShape<T>(payload[i], itemSpec)
    if (!item.ok) return { ok: false, error: `Invalid payload item ${i}: ${item.error}` }
  }
  return { ok: true, value: payload as T[] }
}