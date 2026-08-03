import { describe, it, expect } from 'vitest'
import {
  scrubSettingsSecrets,
  mergeSettingsPreservingSecrets,
  protectSettingsSecrets,
  revealSettingsSecrets
} from './SecretsStore'

describe('SecretsStore — CRIT-2 renderer key isolation', () => {
  it('scrubSettingsSecrets strips apiKey and marks apiKeySet', () => {
    const settings = {
      theme: 'dark',
      ai: {
        gemini: { apiKey: 'sk-secret-123', baseUrl: 'https://example.com' },
        openai: { apiKey: 'sk-other' },
        ollama: { apiKey: '' }
      }
    }
    const scrubbed = scrubSettingsSecrets(settings)
    // Never ship the raw key
    expect(scrubbed.ai.gemini.apiKey).toBe('')
    expect(scrubbed.ai.openai.apiKey).toBe('')
    // Marker so UI can show "saved" without the key
    expect(scrubbed.ai.gemini.apiKeySet).toBe(true)
    expect(scrubbed.ai.openai.apiKeySet).toBe(true)
    expect(scrubbed.ai.ollama.apiKeySet).toBe(false)
    // Non-secret fields survive
    expect(scrubbed.ai.gemini.baseUrl).toBe('https://example.com')
    expect(scrubbed.theme).toBe('dark')
    // Input object is not mutated
    expect(settings.ai.gemini.apiKey).toBe('sk-secret-123')
  })

  it('mergeSettingsPreservingSecrets keeps stored key when renderer sends empty apiKey', () => {
    const stored = {
      theme: 'dark',
      ai: { gemini: { apiKey: 'enc:v1:ABC', baseUrl: 'https://a.com' } }
    }
    // Renderer round-trips a scrubbed settings object (theme save flow)
    const incoming = {
      theme: 'light',
      ai: { gemini: { apiKey: '', apiKeySet: true, baseUrl: 'https://a.com' } }
    }
    const merged = mergeSettingsPreservingSecrets(stored, incoming)
    expect(merged.theme).toBe('light')
    expect(merged.ai.gemini.apiKey).toBe('enc:v1:ABC') // stored key preserved
    expect(merged.ai.gemini.apiKeySet).toBeUndefined() // marker never persisted
    expect(merged.ai.gemini.baseUrl).toBe('https://a.com')
  })

  it('mergeSettingsPreservingSecrets replaces key when a new non-empty one is provided', () => {
    const stored = { ai: { gemini: { apiKey: 'enc:v1:OLD', baseUrl: 'https://a.com' } } }
    const incoming = { ai: { gemini: { apiKey: 'sk-new', baseUrl: 'https://a.com' } } }
    const merged = mergeSettingsPreservingSecrets(stored, incoming)
    expect(merged.ai.gemini.apiKey).toBe('sk-new')
  })

  it('mergeSettingsPreservingSecrets preserves providers omitted by renderer payload', () => {
    const stored = {
      ai: {
        gemini: { apiKey: 'enc:v1:g', baseUrl: 'https://g.com' },
        openai: { apiKey: 'enc:v1:o', baseUrl: 'https://o.com' }
      }
    }
    // Renderer only sends gemini (e.g. partial update) — openai must survive
    const incoming = { ai: { gemini: { apiKey: '', baseUrl: 'https://g.com' } } }
    const merged = mergeSettingsPreservingSecrets(stored, incoming)
    expect(merged.ai.gemini.apiKey).toBe('enc:v1:g')
    expect(merged.ai.openai.apiKey).toBe('enc:v1:o')
  })

  it('full round-trip: protect → reveal → scrub → merge does not wipe keys', () => {
    const original = { theme: 'dark', ai: { gemini: { apiKey: 'sk-real' } } }
    // saveSettings path: encrypt
    const protectedSettings = protectSettingsSecrets(original)
    expect(protectedSettings.ai.gemini.apiKey).not.toBe('sk-real')
    // getSettings path: decrypt
    const revealed = revealSettingsSecrets(protectedSettings)
    expect(revealed.ai.gemini.apiKey).toBe('sk-real')
    // settings:get path: scrub for renderer
    const scrubbed = scrubSettingsSecrets(revealed)
    expect(scrubbed.ai.gemini.apiKey).toBe('')
    // settings:save path: renderer round-trips scrubbed object → merge with stored raw
    const merged = mergeSettingsPreservingSecrets(protectedSettings, scrubbed)
    const reProtected = protectSettingsSecrets(merged)
    const final = revealSettingsSecrets(reProtected)
    expect(final.ai.gemini.apiKey).toBe('sk-real')
    expect(final.theme).toBe('dark')
  })
})
