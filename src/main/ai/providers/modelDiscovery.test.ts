import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchOpenAICompatModels,
  chatBaseCandidates,
  geminiOpenAICompatBase,
  isVersionedBase,
  shouldAdoptChatBase,
  discoverOpenAICompat,
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

  it('chatBaseCandidates covers bare domain, already-versioned, and pasted /models URL', () => {
    expect(chatBaseCandidates('https://host')).toEqual([
      'https://host',
      'https://host/v1',
      'https://host/api/v1'
    ])
    expect(chatBaseCandidates('https://host/v1')).toEqual(['https://host/v1'])
    expect(chatBaseCandidates('https://host/api/v1')).toEqual(['https://host/api/v1'])
    // Full models URL pasted → stripped to the chat base (still versioned)
    expect(chatBaseCandidates('https://host/v1/models')).toEqual(['https://host/v1'])
    expect(chatBaseCandidates('https://host/api/v1/models/')).toEqual(['https://host/api/v1'])
    // Query/hash fragments dropped before probing (pasted signed URLs)
    expect(chatBaseCandidates('https://host/v1?signature=abc')).toEqual(['https://host/v1'])
    expect(chatBaseCandidates('https://host/models#frag')).toEqual([
      'https://host',
      'https://host/v1',
      'https://host/api/v1'
    ])
    expect(chatBaseCandidates('')).toEqual([])
  })

  it('geminiOpenAICompatBase maps native Gemini base → OpenAI-compat endpoint', () => {
    // Bare domain and /v1beta both resolve to /v1beta/openai
    expect(geminiOpenAICompatBase('https://generativelanguage.googleapis.com')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai'
    )
    expect(geminiOpenAICompatBase('https://generativelanguage.googleapis.com/v1beta')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai'
    )
    // Already on the compat endpoint → unchanged (null = no mapping needed)
    expect(
      geminiOpenAICompatBase('https://generativelanguage.googleapis.com/v1beta/openai')
    ).toBeNull()
    // Non-Gemini hosts are never touched
    expect(geminiOpenAICompatBase('https://api.openai.com/v1')).toBeNull()
    expect(geminiOpenAICompatBase('https://generativelanguage.example.com')).toBeNull()
    expect(geminiOpenAICompatBase('')).toBeNull()
  })

  it('chatBaseCandidates tries the Gemini OpenAI-compat base first for native URLs', () => {
    // Native /v1beta → compat endpoint first, native base as fallback
    expect(chatBaseCandidates('https://generativelanguage.googleapis.com/v1beta')).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'https://generativelanguage.googleapis.com/v1beta'
    ])
    // Bare Gemini domain → compat endpoint first, domain as fallback
    expect(chatBaseCandidates('https://generativelanguage.googleapis.com')).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'https://generativelanguage.googleapis.com'
    ])
    // Already-compat base → left alone (regular bare-domain probing)
    expect(chatBaseCandidates('https://generativelanguage.googleapis.com/v1beta/openai')).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'https://generativelanguage.googleapis.com/v1beta/openai/v1',
      'https://generativelanguage.googleapis.com/v1beta/openai/api/v1'
    ])
  })

  it('isVersionedBase detects /vN and /api/vN suffixes only', () => {
    expect(isVersionedBase('https://host/v1')).toBe(true)
    expect(isVersionedBase('https://host/api/v2')).toBe(true)
    expect(isVersionedBase('https://host/v1/')).toBe(true) // trailing slash ok
    expect(isVersionedBase('https://host')).toBe(false)
    expect(isVersionedBase('https://host/vault')).toBe(false) // not a version segment
    expect(isVersionedBase('')).toBe(false)
  })

  it('shouldAdoptChatBase: single adoption rule shared by listModels + chat guard', () => {
    expect(shouldAdoptChatBase('https://host', { chatBase: 'https://host/v1' })).toBe(
      'https://host/v1'
    )
    // Same base already → no adoption (keeps the SDK client untouched)
    expect(shouldAdoptChatBase('https://host/v1', { chatBase: 'https://host/v1' })).toBeNull()
    // Failed discovery → never adopt a guessed base
    expect(shouldAdoptChatBase('https://host', null)).toBeNull()
  })

  it('discoverOpenAICompat tries candidates in order and returns the working base', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url))
      const ok = String(url).includes('host/v1/models')
      return {
        ok,
        json: async () => (ok ? { data: [{ id: 'gpt-x', owned_by: 'openai' }] } : { error: '404' })
      }
    }) as unknown as typeof fetch
    const res = await discoverOpenAICompat('https://host', 'sk-x')
    expect(res).not.toBeNull()
    expect(res!.chatBase).toBe('https://host/v1')
    expect(res!.models[0].id).toBe('gpt-x')
    expect(res!.models[0].ownedBy).toBe('openai')
    // Tried bare first (404), then /v1 (hit) — never /api/v1
    expect(calls).toEqual(['https://host/models', 'https://host/v1/models'])
  })

  it('discoverOpenAICompat returns null when every candidate fails', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      json: async () => ({})
    })) as unknown as typeof fetch
    expect(await discoverOpenAICompat('https://dead', 'sk-x')).toBeNull()
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

  it('createModelCache.fetchedAt reports the last REAL fetch, never bumps on reads', () => {
    const cache = createModelCache()
    expect(cache.fetchedAt()).toBeNull() // never fetched yet
    cache.set([{ id: 'x', name: 'X' }])
    const t1 = cache.fetchedAt()
    expect(t1).not.toBeNull()
    expect(Date.now() - t1!).toBeLessThan(1000)
    // A cache GET is a read, not a fetch — the stamp must not move
    cache.get()
    expect(cache.fetchedAt()).toBe(t1)
    // After TTL the stamp is HISTORICAL: still the last real fetch time, so a
    // Settings card can truthfully say "diperbarui <old time>" (stale = old)
    const realNow = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * 60 * 1000)
    expect(cache.get()).toBeNull()
    expect(cache.fetchedAt()).toBe(t1)
    vi.restoreAllMocks()
    cache.clear()
    expect(cache.fetchedAt()).toBeNull()
  })

  it('fallback-only loads stay cached for offline visibility but get NO stamp', () => {
    const cache = createModelCache()
    // A dead endpoint falls back to the static list and caches it (so the UI
    // doesn't refetch on every keystroke) — but a fresh "diperbarui now" stamp
    // on a list that never came from the API would be a lie.
    cache.set([{ id: 's1', name: 'Static fallback' }], false)
    expect(cache.get()).toHaveLength(1) // still visible offline
    expect(cache.fetchedAt()).toBeNull() // but no freshness claim
    // A later LIVE fetch restores the stamp
    cache.set([{ id: 'live', name: 'Live' }], true)
    expect(cache.fetchedAt()).not.toBeNull()
  })
})
