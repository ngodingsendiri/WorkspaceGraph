import { describe, it, expect, vi, afterEach } from 'vitest'
import { withProviderRetry, isRetryableProviderError } from './providerRetry'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('isRetryableProviderError (R0-3)', () => {
  it('retries only 429 and 5xx — never 4xx auth/bad-request', () => {
    expect(isRetryableProviderError(Object.assign(new Error('limit'), { status: 429 }))).toBe(true)
    expect(isRetryableProviderError(Object.assign(new Error('boom'), { status: 503 }))).toBe(true)
    expect(isRetryableProviderError(Object.assign(new Error('boom'), { status: 500 }))).toBe(true)
    expect(isRetryableProviderError(Object.assign(new Error('bad key'), { status: 401 }))).toBe(false)
    expect(isRetryableProviderError(Object.assign(new Error('bad req'), { status: 400 }))).toBe(false)
  })

  it('falls back to the message text when the SDK does not set .status', () => {
    expect(isRetryableProviderError(new Error('OpenAI: 429 Too Many Requests'))).toBe(true)
    expect(isRetryableProviderError(new Error('Gemini: 503 Service Unavailable'))).toBe(true)
    expect(isRetryableProviderError(new Error('401 Unauthorized'))).toBe(false)
    expect(isRetryableProviderError(new Error('400 Bad Request'))).toBe(false)
    expect(isRetryableProviderError(null)).toBe(false)
    expect(isRetryableProviderError(undefined)).toBe(false)
  })
})

describe('withProviderRetry (R0-3)', () => {
  it('retries a transient failure and returns the second attempt result', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('429'), { status: 429 }))
      .mockResolvedValueOnce('ok')
    const res = await withProviderRetry(run, { baseDelayMs: 1 })
    expect(res).toBe('ok')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('gives up after `attempts` and rethrows the last error', async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('429'), { status: 429 }))
    await expect(withProviderRetry(run, { attempts: 2, baseDelayMs: 1 })).rejects.toThrow('429')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('never retries non-retryable failures (4xx)', async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('401'), { status: 401 }))
    await expect(withProviderRetry(run, { attempts: 3 })).rejects.toThrow('401')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('backs off exponentially (base → base×2) and caps at maxDelayMs', async () => {
    vi.useFakeTimers()
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('429'), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error('429'), { status: 429 }))
      .mockResolvedValueOnce('ok')
    const p = withProviderRetry(run, { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 })
    // attempt 1 fails → sleep ~100–200ms; attempt 2 fails → sleep ~200–300ms
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(400)
    await expect(p).resolves.toBe('ok')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('shouldRetry returning false aborts retries immediately (user cancelled)', async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('429'), { status: 429 }))
    await expect(
      withProviderRetry(run, { attempts: 3, baseDelayMs: 1, shouldRetry: () => false })
    ).rejects.toThrow('429')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
