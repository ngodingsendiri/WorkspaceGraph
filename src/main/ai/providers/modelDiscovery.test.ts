import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchOpenAICompatModels,
  fetchGeminiModels,
  fetchAnthropicModels,
  fetchOpenRouterModels,
  isGeminiFreeTier,
  markFreeByHeuristic,
  mergeWithFallback,
  createModelCache
} from './modelDiscovery'

const origFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = origFetch
  vi.restoreAllMocks()
})

function mockFetchOnce(status: number, body: unknown): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    json: async () => body
  }) as unknown as typeof fetch
}

describe('modelDiscovery (runtime model auto-detection)', () => {
  it('fetchOpenAICompatModels hits {base}/models with Bearer and maps data[].id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gpt-4o', owned_by: 'openai' },
          { id: 'gpt-4o-mini', owned_by: 'openai' },
          { id: 'o3-mini', owned_by: 'openai' }
        ]
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const models = await fetchOpenAICompatModels('https://api.openai.com/v1/', 'sk-test')
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/models', {
      headers: { Authorization: 'Bearer sk-test' },
      signal: expect.anything()
    })
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini', 'o3-mini'])
    expect(models[0].ownedBy).toBe('openai')
  })

  it('returns [] on non-ok or missing data (fallback path)', async () => {
    mockFetchOnce(401, { error: 'bad key' })
    expect(await fetchOpenAICompatModels('https://x.ai/v1', 'bad')).toEqual([])
    mockFetchOnce(200, {})
    expect(await fetchOpenAICompatModels('https://x.ai/v1', 'bad')).toEqual([])
    expect(await fetchOpenAICompatModels('', '')).toEqual([])
  })

  it('fetchGeminiModels strips models/ prefix and flags free-tier names', async () => {
    mockFetchOnce(200, {
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          inputTokenLimit: 1048576
        },
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 2097152 },
        { name: 'models/text-embedding-004' }
      ]
    })
    const models = await fetchGeminiModels('sk-gemini')
    expect(models.map((m) => m.id)).toEqual([
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'text-embedding-004'
    ])
    expect(models[0].free).toBe(true) // flash → free tier
    expect(models[1].free).toBe(false) // pro → paid
    expect(models[0].contextWindow).toBe(1048576)
  })

  it('isGeminiFreeTier heuristic covers flash/nano/lite/light only', () => {
    expect(isGeminiFreeTier('models/gemini-2.5-flash')).toBe(true)
    expect(isGeminiFreeTier('gemini-2.0-flash-lite')).toBe(true)
    expect(isGeminiFreeTier('gemini-nano-1')).toBe(true)
    expect(isGeminiFreeTier('gemini-2.5-pro')).toBe(false)
    expect(isGeminiFreeTier('gemini-flash-example-extra')).toBe(true) // -flash- suffix
  })

  it('fetchAnthropicModels uses x-api-key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' },
          { id: 'claude-3-5-haiku-20241022' }
        ]
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const models = await fetchAnthropicModels('sk-ant')
    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01' },
      signal: expect.anything()
    })
    expect(models).toHaveLength(2)
    expect(models[0].name).toBe('Claude 3.5 Sonnet')
  })

  it('fetchOpenRouterModels marks free exactly when ALL pricing entries are $0', async () => {
    mockFetchOnce(200, {
      data: [
        {
          id: 'meta-llama/llama-3.3-70b-instruct',
          name: 'Llama 3.3 70B',
          context_length: 131072,
          pricing: { prompt: '0', completion: '0', request: '0', image: '0' }
        },
        {
          id: 'openai/gpt-4o',
          name: 'GPT-4o',
          context_length: 128000,
          pricing: { prompt: '2.5', completion: '10', request: '0' }
        },
        {
          id: 'no-pricing',
          name: 'No pricing field',
          pricing: {}
        }
      ]
    })
    const models = await fetchOpenRouterModels('sk-or')
    expect(models.find((m) => m.id === 'meta-llama/llama-3.3-70b-instruct')?.free).toBe(true)
    expect(models.find((m) => m.id === 'openai/gpt-4o')?.free).toBe(false)
    // BUGFIX: a missing/empty pricing object is a malformed entry — it must
    // NOT be claimed free (vacuous Object.values({}).every would say yes).
    expect(models.find((m) => m.id === 'no-pricing')?.free).toBeUndefined()
    expect(models[0].contextWindow).toBe(131072)
  })

  it('markFreeByHeuristic only fills when free is undefined (no override)', () => {
    const out = markFreeByHeuristic([
      { id: 'gemini-2.5-flash', name: 'Flash' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'paid', name: 'Paid', free: false }
    ])
    expect(out[0].free).toBe(true) // -flash hint
    expect(out[1].free).toBe(false) // no hint → false
    expect(out[2].free).toBe(false) // existing value preserved
  })

  it('mergeWithFallback: runtime first, fallback appended, dedup by id', () => {
    const merged = mergeWithFallback(
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' }
      ],
      [
        { id: 'b', name: 'B static' }, // dup — runtime wins
        { id: 'c', name: 'C' }
      ]
    )
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(merged[1].name).toBe('B')
  })

  it('createModelCache stores fresh and expires after TTL (5 min)', () => {
    const cache = createModelCache()
    expect(cache.get()).toBeNull()
    cache.set([{ id: 'x', name: 'X' }])
    expect(cache.get()).toHaveLength(1)
    // Simulate expiry by manipulating Date.now
    const realNow = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * 60 * 1000)
    expect(cache.get()).toBeNull()
    vi.restoreAllMocks()
    cache.clear()
    expect(cache.get()).toBeNull()
  })
})
