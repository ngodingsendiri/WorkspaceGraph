/**
 * M3 (AI-4): formal schema validation for structured AI outputs.
 */
import { describe, it, expect } from 'vitest'
import { validateStructuredOutput } from './structuredOutput'

describe('M3 AI-4 — validateStructuredOutput', () => {
  it('accepts a well-formed plan', () => {
    const r = validateStructuredOutput('plan', {
      title: 'Ship E2E',
      goal: 'Green CI',
      steps: ['Write test', 'Run CI'],
      notes: 'do it'
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.title).toBe('Ship E2E')
      expect((r.value.steps as unknown[]).length).toBe(2)
    }
  })

  it('rejects a plan missing required fields', () => {
    const r = validateStructuredOutput('plan', { title: 'X' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('missing required')
  })

  it('rejects a plan with empty steps (sanitizes non-array)', () => {
    const r = validateStructuredOutput('plan', { title: 'X', goal: 'g', steps: 'nope' })
    expect(r.ok).toBe(false)
  })

  it('validates knowledgeNote schema', () => {
    const ok = validateStructuredOutput('knowledgeNote', {
      title: 'T',
      content: 'body',
      tags: ['a', 'b']
    })
    expect(ok.ok).toBe(true)
    expect(validateStructuredOutput('knowledgeNote', { title: 'T' }).ok).toBe(false)
  })

  it('sanitizes output (no prototype pollution via __proto__ key)', () => {
    const r = validateStructuredOutput('plan', {
      title: 'safe',
      goal: 'g',
      steps: ['a'],
      __proto__: { polluted: true }
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.value as Record<string, unknown>).polluted).toBeUndefined()
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    }
  })

  it('unknown kind rejected', () => {
    const r = validateStructuredOutput('nope' as never, {})
    expect(r.ok).toBe(false)
  })
})
