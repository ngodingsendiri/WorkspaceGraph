import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIProvider } from './OpenAIProvider'
import type { AIStreamChunk } from './BaseProvider'

const origFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = origFetch
  vi.restoreAllMocks()
})

type Private = { baseUrl: string; client: unknown; ensureChatBase(): Promise<void> }

describe('OpenAIProvider.ensureChatBase (lazy base adoption on chat path)', () => {
  it('probes once and adopts the working versioned base for a bare domain', async () => {
    const p = new OpenAIProvider() as unknown as Private
    p.configure({ apiKey: 'sk-x', baseUrl: 'https://host' })
    let calls = 0
    globalThis.fetch = (async (url: unknown) => {
      calls++
      const ok = String(url).endsWith('/v1/models')
      return { ok, json: async () => (ok ? { data: [{ id: 'gpt-x' }] } : {}) }
    }) as unknown as typeof fetch

    await p.ensureChatBase()
    expect(p.baseUrl).toBe('https://host/v1')
    expect(p.client).toBeNull() // SDK client must rebuild against the resolved base
    expect(calls).toBe(2) // bare probe (404) + /v1 probe (hit) — /api/v1 never tried

    // Second call is a no-op — probe guard prevents re-hammering
    await p.ensureChatBase()
    expect(calls).toBe(2)
  })

  it('skips probing when baseUrl is already versioned or unset', async () => {
    const p = new OpenAIProvider() as unknown as Private
    p.configure({ apiKey: 'sk-x', baseUrl: 'https://api.openai.com/v1' })
    const probe = vi.fn()
    globalThis.fetch = probe as unknown as typeof fetch
    await p.ensureChatBase()
    expect(probe).not.toHaveBeenCalled()

    const p2 = new OpenAIProvider() as unknown as Private
    p2.configure({ apiKey: 'sk-x' })
    await p2.ensureChatBase()
    expect(probe).not.toHaveBeenCalled()
  })

  it('R0-3: sendMessage retries a 429 once then succeeds', async () => {
    type WithRetry = Private & {
      sendMessage(req: {
        messages: { role: string; content: string }[]
        model?: string
      }): Promise<{ content: string; tokensUsed?: number }>
      client: {
        chat: {
          completions: {
            create: (...args: unknown[]) => Promise<{
              choices: { message: { content: string; tool_calls?: unknown } }[]
              usage?: { total_tokens?: number }
            }>
          }
        }
      }
    }
    const p = new OpenAIProvider() as unknown as WithRetry
    p.configure({ apiKey: 'sk-x', baseUrl: 'https://host/v1' })
    const create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('429 Too Many Requests'), { status: 429 }))
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'ok', tool_calls: undefined } }],
        usage: { total_tokens: 7 }
      })
    p.client.chat.completions.create = create as never

    const res = await p.sendMessage({ messages: [{ role: 'user', content: 'hi' }], model: 'm1' })
    expect(res.content).toBe('ok')
    expect(res.tokensUsed).toBe(7)
    expect(create).toHaveBeenCalledTimes(2) // retried once
  })

  it('R0-3: sendMessage does NOT retry a 401 (auth failures surface immediately)', async () => {
    type WithRetry = Private & {
      sendMessage(req: {
        messages: { role: string; content: string }[]
        model?: string
      }): Promise<{ content: string }>
      client: { chat: { completions: { create: (...args: unknown[]) => Promise<unknown> } } }
    }
    const p = new OpenAIProvider() as unknown as WithRetry
    p.configure({ apiKey: 'sk-x', baseUrl: 'https://host/v1' })
    const create = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('401 Unauthorized'), { status: 401 }))
    p.client.chat.completions.create = create as never

    await expect(
      p.sendMessage({ messages: [{ role: 'user', content: 'hi' }], model: 'm1' })
    ).rejects.toThrow('401')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('R0-3: streamMessage retries a create-time 5xx without duplicating chunks', async () => {
    type WithRetry = Private & {
      streamMessage(
        req: { messages: { role: string; content: string }[]; model?: string },
        onChunk: (c: AIStreamChunk) => void
      ): Promise<void>
      client: { chat: { completions: { create: (...args: unknown[]) => Promise<unknown> } } }
    }
    const p = new OpenAIProvider() as unknown as WithRetry
    p.configure({ apiKey: 'sk-x', baseUrl: 'https://host/v1' })
    async function* gen(): AsyncGenerator<{
      choices: { delta: { content?: string; tool_calls?: unknown } }[]
      usage?: { total_tokens?: number }
    }> {
      yield { choices: [{ delta: { content: 'hello' } }] }
      yield { choices: [{ delta: {} }], usage: { total_tokens: 3 } }
    }
    const create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('503 Service Unavailable'), { status: 503 }))
      .mockResolvedValueOnce(gen())
    p.client.chat.completions.create = create as never

    const chunks: AIStreamChunk[] = []
    await p.streamMessage({ messages: [{ role: 'user', content: 'hi' }], model: 'm1' }, (c) =>
      chunks.push(c)
    )
    // Content from the SUCCESSFUL attempt only — nothing duplicated from the retried create
    expect(
      chunks
        .filter((c) => c.content)
        .map((c) => c.content)
        .join('')
    ).toBe('hello')
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('records the fetch time after listModels and keeps it on cache hits', async () => {
    type WithCache = Private & {
      listModels(): Promise<unknown>
      lastModelsFetchedAt(): number | null
    }
    const p = new OpenAIProvider() as unknown as WithCache
    p.configure({ apiKey: 'sk-x', baseUrl: 'https://host/v1' })
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-x', owned_by: 'openai' }] })
    })) as unknown as typeof fetch

    await p.listModels()
    const t1 = p.lastModelsFetchedAt()
    expect(t1).not.toBeNull()
    expect(Date.now() - t1!).toBeLessThan(5000)

    // Second call hits the 5-min cache — the stamp is a READ, not a refetch
    const t2 = p.lastModelsFetchedAt()
    expect(t2).toBe(t1)
  })

  it('keeps the configured base when every candidate fails (no bad adoption)', async () => {
    const p = new OpenAIProvider() as unknown as Private
    p.configure({ apiKey: 'sk-x', baseUrl: 'https://dead' })
    globalThis.fetch = (async () => ({
      ok: false,
      json: async () => ({})
    })) as unknown as typeof fetch
    await p.ensureChatBase()
    expect(p.baseUrl).toBe('https://dead') // untouched — never adopted a guessed base
  })

  it('re-probes after configure() changes the apiKey (failed probe must not latch)', async () => {
    const p = new OpenAIProvider() as unknown as Private
    // Wrong key on a bare domain → discovery 401s → probe latched, no adoption
    p.configure({ apiKey: 'bad', baseUrl: 'https://host' })
    globalThis.fetch = (async () => ({
      ok: false,
      json: async () => ({ error: '401' })
    })) as unknown as typeof fetch
    await p.ensureChatBase()
    expect(p.baseUrl).toBe('https://host')

    // User fixes the key WITHOUT touching the base → guard must reset and the
    // now-working discovery adopts /v1 (otherwise chats 404 forever)
    let calls = 0
    globalThis.fetch = (async (url: unknown) => {
      calls++
      const ok = String(url).endsWith('/v1/models')
      return { ok, json: async () => (ok ? { data: [{ id: 'gpt-x' }] } : {}) }
    }) as unknown as typeof fetch
    p.configure({ apiKey: 'good' })
    await p.ensureChatBase()
    expect(p.baseUrl).toBe('https://host/v1')
    expect(calls).toBe(2)
  })

  it('re-probes after configure() changes the baseUrl', async () => {
    const p = new OpenAIProvider() as unknown as Private
    p.configure({ apiKey: 'sk-x', baseUrl: 'https://host' })
    globalThis.fetch = (async (url: unknown) => {
      const ok = String(url).endsWith('/v1/models')
      return { ok, json: async () => (ok ? { data: [{ id: 'gpt-x' }] } : {}) }
    }) as unknown as typeof fetch
    await p.ensureChatBase()
    expect(p.baseUrl).toBe('https://host/v1')

    // New endpoint → flag reset → discovery re-runs against the new host
    let calls = 0
    globalThis.fetch = (async (url: unknown) => {
      calls++
      const ok = String(url).includes('other/v1/models')
      return { ok, json: async () => (ok ? { data: [{ id: 'm2' }] } : {}) }
    }) as unknown as typeof fetch
    p.configure({ baseUrl: 'https://other' })
    await p.ensureChatBase()
    expect(p.baseUrl).toBe('https://other/v1')
    expect(calls).toBe(2)
  })
})
