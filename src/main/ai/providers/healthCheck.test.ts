import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAIProvider } from './OpenAIProvider'
import { discoverOpenAICompat } from './modelDiscovery'

// Mock the discovery fetcher so healthCheck probes deterministically.
vi.mock('./modelDiscovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./modelDiscovery')>()
  return {
    ...actual,
    discoverOpenAICompat: vi.fn()
  }
})

describe('M1.4 — provider health check (AI-5)', () => {
  let provider: OpenAIProvider
  const discover = vi.mocked(discoverOpenAICompat)

  beforeEach(() => {
    vi.useFakeTimers()
    provider = new OpenAIProvider()
    provider.configure({ apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1' })
    discover.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('probe memanggil GET /models dan true saat model ditemukan', async () => {
    discover.mockResolvedValue({ base: 'x', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] } as never)
    await expect(provider.healthCheck()).resolves.toBe(true)
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it('kunci invalid → probe kosong → false (bukan isConfigured palsu)', async () => {
    discover.mockResolvedValue({ base: 'x', models: [] } as never)
    await expect(provider.healthCheck()).resolves.toBe(false)
  })

  it('tidak terkonfigurasi → false tanpa memanggil jaringan', async () => {
    provider.configure({ apiKey: '' })
    await expect(provider.healthCheck()).resolves.toBe(false)
    expect(discover).not.toHaveBeenCalled()
  })

  it('hasil di-cache dalam TTL (tidak probe ulang tiap panggilan)', async () => {
    discover.mockResolvedValue({ base: 'x', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] } as never)
    await provider.healthCheck()
    await provider.healthCheck()
    await provider.healthCheck()
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it('cache TTL basi → probe ulang', async () => {
    discover.mockResolvedValue({ base: 'x', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] } as never)
    await provider.healthCheck()
    vi.advanceTimersByTime(6 * 60_000) // past 5-min TTL
    await provider.healthCheck()
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('configure dengan kunci baru membatalkan cache health', async () => {
    discover.mockResolvedValue({ base: 'x', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] } as never)
    await provider.healthCheck()
    provider.configure({ apiKey: 'new-key' })
    await provider.healthCheck()
    expect(discover).toHaveBeenCalledTimes(2)
  })
})
