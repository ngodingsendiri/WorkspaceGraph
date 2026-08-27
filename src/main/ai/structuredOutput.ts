/**
 * M3 (AI-4): formal schema validation for structured AI outputs.
 *
 * Validates that AI-produced structured content (plan notes, task extraction,
 * knowledge notes) conforms to the expected schema BEFORE the content is
 * persisted or presented to the user. Uses the same JSON-schema shape as
 * `validateToolArgs` (ObjectSchema).
 *
 * Each schema has a `kind` identifier and a set of required fields — a plan
 * must have steps, a knowledge note must have a title, etc. Validation
 * produces a sanitized copy (no prototype pollution), or an error message.
 */
import { validateToolArgs } from './toolArgsValidation'

export interface ObjectSchema {
  type: 'object'
  properties: Record<string, { type?: string; description?: string }>
  required?: readonly string[]
}

/** Named schemas for structured outputs the AI produces. */
const SCHEMAS: Record<string, ObjectSchema> = {
  plan: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Plan title' },
      goal: { type: 'string', description: 'One-sentence goal' },
      steps: { type: 'array', description: 'Ordered implementation steps' },
      notes: { type: 'string', description: 'Optional context notes' }
    },
    required: ['title', 'goal', 'steps']
  },
  knowledgeNote: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Note title' },
      content: { type: 'string', description: 'Markdown body' },
      tags: { type: 'array', description: 'Tag list' },
      summary: { type: 'string', description: 'Optional one-line summary' }
    },
    required: ['title', 'content']
  },
  taskExtraction: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Task title' },
      priority: { type: 'string', description: 'high/medium/low' },
      status: { type: 'string', description: 'inbox/todo/in_progress/done' },
      dueDate: { type: 'string', description: 'YYYY-MM-DD or empty' }
    },
    required: ['title', 'priority']
  }
}

export type StructuredOutputKind = keyof typeof SCHEMAS

/**
 * Validate a structured AI output against its named schema. Returns the
 * sanitized value on success, or an error message string on failure. Never
 * throws.
 */
export function validateStructuredOutput(
  kind: StructuredOutputKind,
  value: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const schema = SCHEMAS[kind]
  if (!schema) {
    return { ok: false, message: `Unknown schema kind: ${kind}` }
  }
  return validateToolArgs(schema, value)
}