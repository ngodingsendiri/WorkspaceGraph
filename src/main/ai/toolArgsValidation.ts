/**
 * M2.5 (MC-6): deterministic JSON-schema argument validation for tool calls.
 *
 * Adapted from MiniCore's `tool.ts` (`validateArgs`). Before this module, every
 * tool call's raw arguments from the model were used directly — a
 * hallucinated or malformed argument could cause a weird error mid-execution
 * or, in edge cases, prototype pollution. Arguments are now validated against
 * the tool's schema (the same one advertised to the model) before any
 * execution code runs. Invalid arguments produce an error ToolResult — the
 * loop continues, the model sees the error, and can self-correct.
 *
 * The schema format is the OpenAI-compatible `parameters` object:
 *   { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
 * This is the exact format returned by `buildToolSchemas` in AgentTools.ts.
 */

interface PropertySchema {
  type?: string
  description?: string
  enum?: readonly unknown[]
  items?: PropertySchema
  properties?: Record<string, PropertySchema>
  required?: readonly string[]
  additionalProperties?: boolean
}

function error(msg: string): string {
  return msg
}

function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
}

function validateOne(
  schema: PropertySchema,
  args: unknown,
  path: string
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (schema.properties || schema.type === 'object') {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return { ok: false, message: error(`${path}expected an object`) }
    }
    const record = args as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of schema.required ?? []) {
      if (!(key in record)) return { ok: false, message: error(`${path}missing required: ${key}`) }
    }
    for (const [key, value] of Object.entries(record)) {
      const sub = schema.properties?.[key]
      if (sub) {
        const result = validateOne(sub, value, `${path}${key}: `)
        if (!result.ok) return result
        setOwn(out, key, result.value)
      } else if (schema.additionalProperties === false) {
        return { ok: false, message: error(`${path}unknown property: ${key}`) }
      } else {
        setOwn(out, key, value)
      }
    }
    return { ok: true, value: out }
  }
  if (schema.enum) {
    if (!schema.enum.some((v) => Object.is(v, args))) {
      return { ok: false, message: error(`${path}value not allowed`) }
    }
    return { ok: true, value: args }
  }
  switch (schema.type) {
    case 'string':
      return typeof args === 'string'
        ? { ok: true, value: args }
        : { ok: false, message: error(`${path}expected string`) }
    case 'number':
      return typeof args === 'number' && Number.isFinite(args)
        ? { ok: true, value: args }
        : { ok: false, message: error(`${path}expected number`) }
    case 'integer':
      return typeof args === 'number' && Number.isInteger(args)
        ? { ok: true, value: args }
        : { ok: false, message: error(`${path}expected integer`) }
    case 'boolean':
      return typeof args === 'boolean'
        ? { ok: true, value: args }
        : { ok: false, message: error(`${path}expected boolean`) }
    case 'array': {
      if (!Array.isArray(args)) return { ok: false, message: error(`${path}expected an array`) }
      if (!schema.items) return { ok: true, value: args }
      const out: unknown[] = []
      for (let i = 0; i < args.length; i++) {
        const result = validateOne(schema.items, args[i], `${path}[${i}]: `)
        if (!result.ok) return result
        out.push(result.value)
      }
      return { ok: true, value: out }
    }
    default:
      return { ok: true, value: args }
  }
}

/**
 * Deterministic JSON-schema validator for tool arguments.
 * Returns the SANITIZED arguments on success (built with defineProperty, so a
 * `__proto__` key in the model output can never swap the result's prototype),
 * or an error message string on failure. Never throws — malformed input always
 * produces a message, not a crash.
 */
export function validateToolArgs(
  schema: PropertySchema,
  args: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const result = validateOne(schema, args ?? {}, '')
  if (!result.ok) return result
  return { ok: true, value: (result.value ?? {}) as Record<string, unknown> }
}
