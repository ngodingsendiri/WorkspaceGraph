import { describe, it, expect, vi, afterEach } from 'vitest'
import { GrokProvider } from './GrokProvider'

const origFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = origFetch
  vi.restoreAllMocks()
})

type Private = { baseUrl: string; client: unknown; ensureChatBase(): Promise<void> }

describe('GrokProvider.ensureChatBase (lazy base adoption on chat path)', () => {
  it('is a no-op for the official versioned base (never probes xAI needlessly)', async () => {
    const p = new GrokProvider() as unknown as Private
    p.configure({ apiKey: 'xai-key' }) // default baseUrl = https://api.x.ai/v1
    const probe = vi.fn()
    globalThis.fetch = probe as unknown as typeof fetch
    await p.ensureChatBase()
    expect(probe).not.toHaveBeenCalled()
    expect(p.baseUrl).toBe('https://api.x.ai/v1')
  })

  it('adopts the working versioned base for a bare xAI domain', async () => {
    const p = new GrokProvider() as unknown as Private
    p.configure({ apiKey: 'xai-key', baseUrl: 'https://x.ai' })
    globalThis.fetch = (async (url: unknown) => {
      const ok = String(url).endsWith('/v1/models')
      return { ok, json: async () => (ok ? { data: [{ id: 'grok-4.5' }] } : {}) }
    }) as unknown as typeof fetch
    await p.ensureChatBase()
    expect(p.baseUrl).toBe('https://x.ai/v1')
    expect(p.client).toBeNull() // SDK client must rebuild against the resolved base
  })
})
