// @vitest-environment jsdom
/**
 * Component tests (Testing Library) for the SettingsView Test-button flow.
 *
 * LOW-1 — a baseUrl edited in the card but not yet saved must be what the Test
 *         button pings (same in-memory-only rule as a typed key).
 * MED-1 — the Save auto-verify runs SILENT so its "OK …" success flash never
 *         overwrites the save flash. Positive control: a MANUAL Test click
 *         DOES flash "OK …" — proving the silence assertion is discriminating.
 *
 * Renders the real SettingsView in jsdom with a full window.api mock (the
 * renderer never receives real keys — secrets stay on main).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsView } from './SettingsView'

const defs = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://saved.example/v1', defaultModel: 'gpt-4o' },
  { id: 'grok', name: 'Grok', baseUrl: '', defaultModel: '' }
]

const providers = [
  { id: 'openai', name: 'OpenAI', configured: false, connected: false, models: [] },
  { id: 'grok', name: 'Grok', configured: false, connected: false, models: [] }
]

let apiMock: Record<string, ReturnType<typeof vi.fn>>
let testAIProvider: ReturnType<typeof vi.fn>

function createApiMock(): Record<string, ReturnType<typeof vi.fn>> {
  const impl: Record<string, (...args: never[]) => unknown> = {
    getAIProviderConfigs: async () => ({ defs }),
    getAIProviders: async () => providers,
    getSettings: async () => ({
      theme: 'light',
      ai: {},
      semanticContext: true,
      trashEnabled: true,
      aiEventRetentionDays: 0
    }),
    getSearchStats: async () => ({}),
    getEmbeddingStatus: async () => ({ state: 'idle', totalChunks: 0, indexedFiles: 0 }),
    getSecurityStatus: async () => ({ secrets: {} }),
    getAutomation: async () => ({ enabled: false, rules: [] }),
    listPlugins: async () => [],
    listPluginCommands: async () => [],
    getApiHealth: async () => ({ ok: true }),
    getMcpServers: async () => ({ servers: [], statuses: [] }),
    onAIProviderStatus: () => () => {},
    testAIProvider: async () => ({ ok: true, sample: 'connected' }),
    saveAIProviderConfigs: async () => ({ ok: true, defs }),
    configureAIProvider: async () => ({ ok: true }),
    refreshProviderModels: async () => ({ ok: true, models: [] }),
    saveSettings: async () => ({ ok: true })
  }
  const store: Record<string, ReturnType<typeof vi.fn>> = {}
  // Proxy: any API method SettingsView calls that isn't listed gets a resolving
  // stub instead of an undefined-call crash.
  return new Proxy(store, {
    get(t, k) {
      if (typeof k !== 'string') return undefined
      if (!(k in t)) t[k] = vi.fn(impl[k] ?? (async () => ({})))
      return t[k]
    }
  })
}

beforeEach(() => {
  apiMock = createApiMock()
  testAIProvider = apiMock.testAIProvider
  ;(window as { api: unknown }).api = apiMock
  // jsdom lacks matchMedia — theme utils may consult it.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
})

describe('SettingsView Test button flow', () => {
  it('LOW-1: Test pings the baseUrl edited in the card but not yet saved', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    const baseInputs = await screen.findAllByPlaceholderText('Base URL (https://…/v1)')
    expect(baseInputs.length).toBeGreaterThan(0)
    // First card = openai with the SAVED baseUrl 'https://saved.example/v1'.
    await user.clear(baseInputs[0])
    await user.type(baseInputs[0], 'https://edited.example/v2')

    const testButtons = screen.getAllByRole('button', { name: 'Test' })
    await user.click(testButtons[0])

    await waitFor(() => {
      expect(testAIProvider).toHaveBeenCalledWith('openai', {
        apiKey: undefined,
        baseUrl: 'https://edited.example/v2'
      })
    })
  })

  it('MED-1 positive control: a MANUAL Test flashes its OK message', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    const testButtons = await screen.findAllByRole('button', { name: 'Test' })
    await user.click(testButtons[0])

    // Non-silent path — the success flash must be visible in the DOM.
    expect(await screen.findByText('OK openai: connected')).toBeTruthy()
  })

  it('MED-1: Save auto-verify runs SILENT — no Testing/OK banner while the ping is in flight', async () => {
    const user = userEvent.setup()
    // Deferred ping: hold the auto-verify open so a NON-silent implementation
    // would visibly flash "Testing openai…" — flash() is replace, so asserting
    // only the final badge cannot distinguish silent from non-silent.
    let resolvePing!: (v: { ok: boolean; sample?: string }) => void
    testAIProvider.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePing = resolve
        })
    )
    render(<SettingsView />)

    const keyInputs = await screen.findAllByPlaceholderText('API Key')
    await user.type(keyInputs[0], 'sk-test-123')
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0])

    // The silent auto-verify ping is IN FLIGHT…
    await waitFor(() => expect(testAIProvider).toHaveBeenCalled())
    // …and while it is pending there must be NO flash at all — silent means
    // handleTest never calls flash() on success (nor the "Testing…" banner).
    expect(screen.queryByText('Testing openai…')).toBeNull()
    expect(screen.queryByText('OK openai: connected')).toBeNull()

    // Resolve the ping → the save message is the final badge.
    await act(async () => {
      resolvePing({ ok: true, sample: 'connected' })
    })
    expect(await screen.findByText('Provider OpenAI disimpan — tes otomatis…')).toBeTruthy()
  })
})
