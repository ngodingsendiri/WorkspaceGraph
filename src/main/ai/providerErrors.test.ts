import { describe, it, expect } from 'vitest'
import {
  categorizeProviderError,
  isRetryableProviderError,
  shouldFailoverError,
  isContextLengthExceeded,
  retryAfterMsOf
} from './providerErrors'

const withStatus = (status: number): Error => Object.assign(new Error('nope'), { status })

describe('categorizeProviderError (M2.3 / MC-3)', () => {
  it('classifies by structured status code first', () => {
    expect(categorizeProviderError(withStatus(429))).toBe('rate_limit')
    expect(categorizeProviderError(withStatus(401))).toBe('auth')
    expect(categorizeProviderError(withStatus(403))).toBe('auth')
    expect(categorizeProviderError(withStatus(500))).toBe('server')
    expect(categorizeProviderError(withStatus(503))).toBe('server')
    expect(categorizeProviderError(withStatus(400))).toBe('invalid_request')
    expect(categorizeProviderError(withStatus(404))).toBe('invalid_request')
    expect(categorizeProviderError(withStatus(422))).toBe('invalid_request')
  })

  it('reads status from response.status (axios/fetch shape)', () => {
    expect(
      categorizeProviderError(Object.assign(new Error('nope'), { response: { status: 429 } }))
    ).toBe('rate_limit')
    expect(
      categorizeProviderError(Object.assign(new Error('nope'), { response: { status: 502 } }))
    ).toBe('server')
  })

  it('falls back to message patterns when no structured status exists', () => {
    expect(categorizeProviderError(new Error('invalid api key'))).toBe('auth')
    expect(categorizeProviderError(new Error('401 Unauthorized'))).toBe('auth')
    expect(categorizeProviderError(new Error('Grok API error 429: rate limit exceeded'))).toBe(
      'rate_limit'
    )
    expect(categorizeProviderError(new Error('ECONNREFUSED 127.0.0.1:11434'))).toBe('network')
    expect(categorizeProviderError(new Error('fetch failed'))).toBe('network')
    expect(categorizeProviderError(new Error('maximum context length is 128000'))).toBe(
      'context_length_exceeded'
    )
    expect(categorizeProviderError(new Error('something exploded'))).toBe('unknown')
  })

  it('handles null/undefined/empty', () => {
    expect(categorizeProviderError(null)).toBe('unknown')
    expect(categorizeProviderError(undefined)).toBe('unknown')
    expect(categorizeProviderError('')).toBe('unknown')
  })
})

describe('taxonomy predicates stay consistent (single categorizer)', () => {
  it('retryable = rate_limit | server | network', () => {
    expect(isRetryableProviderError(withStatus(429))).toBe(true)
    expect(isRetryableProviderError(withStatus(500))).toBe(true)
    expect(isRetryableProviderError(new Error('ECONNRESET'))).toBe(true)
    // Non-transient:
    expect(isRetryableProviderError(withStatus(401))).toBe(false)
    expect(isRetryableProviderError(withStatus(400))).toBe(false)
    expect(isRetryableProviderError(new Error('maximum context length exceeded'))).toBe(false)
  })

  it('failover = auth | rate_limit | server — never context_length or invalid_request', () => {
    expect(shouldFailoverError(withStatus(401))).toBe(true)
    expect(shouldFailoverError(withStatus(429))).toBe(true)
    expect(shouldFailoverError(withStatus(503))).toBe(true)
    expect(shouldFailoverError(withStatus(400))).toBe(false)
    expect(shouldFailoverError(withStatus(404))).toBe(false)
    // Recoverable in place → never hop providers
    expect(shouldFailoverError(new Error('maximum context length is 200000'))).toBe(false)
  })

  it('context_length only matches the context category', () => {
    expect(isContextLengthExceeded(new Error('context_length_exceeded'))).toBe(true)
    expect(isContextLengthExceeded(withStatus(401))).toBe(false)
    expect(isContextLengthExceeded(null)).toBe(false)
  })
})

describe('retryAfterMsOf', () => {
  it('reads retryAfterMs / Retry-After header when present', () => {
    expect(retryAfterMsOf({ retryAfterMs: 1500 })).toBe(1500)
    expect(retryAfterMsOf({ response: { headers: { 'retry-after': '2' } } })).toBe(2000)
  })

  it('returns undefined when absent or malformed', () => {
    expect(retryAfterMsOf({})).toBeUndefined()
    expect(retryAfterMsOf({ retryAfterMs: -1 })).toBeUndefined()
    expect(retryAfterMsOf({ response: { headers: { 'retry-after': 'abc' } } })).toBeUndefined()
    expect(retryAfterMsOf(null)).toBeUndefined()
  })
})
