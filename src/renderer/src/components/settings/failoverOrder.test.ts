import { describe, it, expect } from 'vitest'
import { buildFailoverCandidates, moveInOrder } from './failoverOrder'

const PROVIDERS = [
  { id: 'grok', name: 'Grok' },
  { id: 'gemini', name: 'Gemini' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'claude', name: 'Claude' },
  { id: 'ollama', name: 'Ollama' },
  { id: 'openrouter', name: 'OpenRouter' }
]

describe('buildFailoverCandidates (R1-2 Settings)', () => {
  it('excludes the active provider and Ollama, keeps registration order by default', () => {
    const out = buildFailoverCandidates(PROVIDERS, [], 'grok')
    expect(out.map((p) => p.id)).toEqual(['gemini', 'openai', 'claude', 'openrouter'])
  })

  it('honors a saved aiFailoverOrder for the head of the list', () => {
    const out = buildFailoverCandidates(PROVIDERS, ['claude', 'openai'], 'grok')
    expect(out.map((p) => p.id)).toEqual(['claude', 'openai', 'gemini', 'openrouter'])
  })

  it('drops unknown ids from the order (main-side validator parity)', () => {
    const out = buildFailoverCandidates(PROVIDERS, ['claude', 'ghost', 'openai'], 'grok')
    expect(out.map((p) => p.id)).toEqual(['claude', 'openai', 'gemini', 'openrouter'])
  })

  it('active provider is never in the list even if the order lists it', () => {
    const out = buildFailoverCandidates(PROVIDERS, ['openai', 'grok', 'claude'], 'grok')
    expect(out.some((p) => p.id === 'grok')).toBe(false)
  })

  it('active provider ollama → all cloud providers are candidates', () => {
    const out = buildFailoverCandidates(PROVIDERS, [], 'ollama')
    expect(out.map((p) => p.id)).toEqual(['grok', 'gemini', 'openai', 'claude', 'openrouter'])
  })

  it('dedupes repeated ids in the saved order', () => {
    const out = buildFailoverCandidates(PROVIDERS, ['claude', 'claude', 'openai'], 'grok')
    expect(out.map((p) => p.id)).toEqual(['claude', 'openai', 'gemini', 'openrouter'])
  })
})

describe('moveInOrder', () => {
  const order = ['a', 'b', 'c', 'd']

  it('moves an item down', () => {
    expect(moveInOrder(order, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves an item up', () => {
    expect(moveInOrder(order, 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('no-op returns a copy, never mutates the input', () => {
    const src = [...order]
    const out = moveInOrder(src, 1, 1)
    expect(out).toEqual(order)
    expect(src).toEqual(order)
  })

  it('clamps out-of-range moves defensively', () => {
    expect(moveInOrder(order, -1, 2)).toEqual(order)
    expect(moveInOrder(order, 0, 99)).toEqual(order)
  })
})
