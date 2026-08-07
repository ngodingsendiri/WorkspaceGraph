import { describe, it, expect } from 'vitest'
import {
  shouldFailoverError,
  resolveFailoverCandidates,
  failoverCandidatesFor,
  type FailoverCandidate
} from './providerFailover'
import type { BaseProvider } from './providers/BaseProvider'

describe('shouldFailoverError (R1-2)', () => {
  it('fails over on terminal auth/rate/server status codes', () => {
    expect(shouldFailoverError(Object.assign(new Error('nope'), { status: 401 }))).toBe(true)
    expect(shouldFailoverError(Object.assign(new Error('nope'), { status: 403 }))).toBe(true)
    expect(shouldFailoverError(Object.assign(new Error('nope'), { status: 429 }))).toBe(true)
    expect(shouldFailoverError(Object.assign(new Error('nope'), { status: 500 }))).toBe(true)
    expect(shouldFailoverError(Object.assign(new Error('nope'), { status: 502 }))).toBe(true)
    expect(shouldFailoverError(Object.assign(new Error('nope'), { status: 503 }))).toBe(true)
  })

  it('reads status from response.status too (axios/fetch shape)', () => {
    expect(
      shouldFailoverError(Object.assign(new Error('nope'), { response: { status: 429 } }))
    ).toBe(true)
    expect(
      shouldFailoverError(Object.assign(new Error('nope'), { response: { status: 504 } }))
    ).toBe(true)
  })

  it('does NOT fail over on client errors (400/404/422) — retrying a bad request is wasted', () => {
    expect(shouldFailoverError(Object.assign(new Error('nope'), { status: 400 }))).toBe(false)
    expect(shouldFailoverError(Object.assign(new Error('nope'), { status: 404 }))).toBe(false)
    expect(shouldFailoverError(Object.assign(new Error('nope'), { status: 422 }))).toBe(false)
  })

  it('falls back to message scanning when no structured status exists', () => {
    expect(shouldFailoverError(new Error('Grok API error 429: rate limit exceeded'))).toBe(true)
    expect(shouldFailoverError(new Error('invalid api key'))).toBe(true)
    expect(shouldFailoverError(new Error('unauthorized'))).toBe(true)
    expect(shouldFailoverError(new Error('forbidden'))).toBe(true)
    expect(shouldFailoverError(new Error('500 Internal Server Error'))).toBe(true)
    expect(shouldFailoverError(new Error('503 Service Unavailable'))).toBe(true)
    // Transient-looking but not terminal — no status, no keyword
    expect(shouldFailoverError(new Error('model not found'))).toBe(false)
    expect(shouldFailoverError(new Error('network hiccup'))).toBe(false)
  })

  it('handles plain string errors and garbage input', () => {
    expect(shouldFailoverError('429 Too Many Requests')).toBe(true)
    expect(shouldFailoverError('401 Unauthorized')).toBe(true)
    expect(shouldFailoverError('bad request 400')).toBe(false)
    expect(shouldFailoverError(null)).toBe(false)
    expect(shouldFailoverError(undefined)).toBe(false)
    expect(shouldFailoverError(42)).toBe(false)
  })

  it('does not treat 5-digit codes as status', () => {
    expect(shouldFailoverError(new Error('HTTP 55000 something'))).toBe(false)
    // 503 inside an arbitrary sentence still parses as a 5xx status — the
    // pattern is intentionally broad for provider error strings
    expect(shouldFailoverError(new Error('my pet has 503 legs'))).toBe(true)
  })
})

describe('resolveFailoverCandidates (R1-2)', () => {
  const mk = (id: string, configured: boolean): FailoverCandidate => ({
    id,
    name: id,
    isConfigured: () => configured
  })
  const registered = [
    mk('grok', true),
    mk('gemini', true),
    mk('openai', true),
    mk('ollama', true), // local — must never be a candidate
    mk('claude', false) // unconfigured — must be skipped
  ]

  it('excludes the active provider itself', () => {
    const out = resolveFailoverCandidates(registered, 'grok')
    expect(out.map((c) => c.id)).not.toContain('grok')
  })

  it('excludes Ollama even when configured and listed', () => {
    const out = resolveFailoverCandidates(registered, 'grok')
    expect(out.map((c) => c.id)).not.toContain('ollama')
  })

  it('excludes unconfigured providers', () => {
    const out = resolveFailoverCandidates(registered, 'grok')
    expect(out.map((c) => c.id)).not.toContain('claude')
  })

  it('defaults to registration order', () => {
    const out = resolveFailoverCandidates(registered, 'grok')
    expect(out.map((c) => c.id)).toEqual(['gemini', 'openai'])
  })

  it('honors a valid aiFailoverOrder from settings', () => {
    const out = resolveFailoverCandidates(registered, 'grok', {
      aiFailoverOrder: ['openai', 'gemini', 'grok']
    })
    expect(out.map((c) => c.id)).toEqual(['openai', 'gemini'])
  })

  it('ignores invalid aiFailoverOrder entries (unknown ids, active, ollama, non-strings)', () => {
    const out = resolveFailoverCandidates(registered, 'grok', {
      aiFailoverOrder: ['ghost', 'ollama', 'grok', 42 as unknown as string, 'openai']
    })
    expect(out.map((c) => c.id)).toEqual(['openai'])
  })

  it('falls back to registration order when aiFailoverOrder is empty or malformed', () => {
    expect(resolveFailoverCandidates(registered, 'grok', { aiFailoverOrder: [] })).toHaveLength(2)
    expect(resolveFailoverCandidates(registered, 'grok', { aiFailoverOrder: 'nope' })).toHaveLength(
      2
    )
  })

  it('returns an empty list when nothing else is configured', () => {
    const solo = [mk('grok', true)]
    expect(resolveFailoverCandidates(solo, 'grok')).toEqual([])
  })

  it('failoverCandidatesFor resolves real provider objects from the registry map', () => {
    const fake = (id: string): BaseProvider =>
      ({ id, name: id, isConfigured: () => true }) as unknown as BaseProvider
    const map = new Map<string, BaseProvider>([
      ['grok', fake('grok')],
      ['gemini', fake('gemini')],
      ['ollama', fake('ollama')]
    ])
    const out = failoverCandidatesFor(map, 'grok')
    expect(out.map((p) => p.id)).toEqual(['gemini'])
  })
})
