import { describe, it, expect } from 'vitest'
import {
  encryptSecret,
  decryptSecret,
  isEncryptedForm,
  mergeSettingsPreservingSecrets,
  protectSettingsSecrets,
  revealSettingsSecrets,
  scrubSettingsSecrets
} from './SecretsStore'

/**
 * SecretsStore roundtrip using the electron safeStorage mock
 * (setup.ts: encryptString -> "encrypted:<str>", decryptString reverses it).
 */
describe('SecretsStore', () => {
  it('encrypts and decrypts a plain key', () => {
    const enc = encryptSecret('sk-test-123')
    expect(enc).not.toBe('sk-test-123')
    expect(decryptSecret(enc)).toBe('sk-test-123')
  })

  it('detects encrypted form', () => {
    expect(isEncryptedForm(encryptSecret('x'))).toBe(true)
    expect(isEncryptedForm('plain-text')).toBe(false)
  })

  it('protectSettingsSecrets encrypts ai api keys in place', () => {
    const settings = { ai: { provider1: { apiKey: 'secret-key', model: 'x' } }, theme: 'dark' }
    const out = protectSettingsSecrets(settings)
    const key = out.ai.provider1.apiKey as string
    expect(key).not.toBe('secret-key')
    expect(out.ai.provider1.model).toBe('x')
    expect(out.theme).toBe('dark')
    // Decrypts back to original
    expect(decryptSecret(key)).toBe('secret-key')
  })

  it('revealSettingsSecrets decrypts keys back', () => {
    const settings = { ai: { p: { apiKey: encryptSecret('orig') } } }
    const revealed = revealSettingsSecrets(settings)
    expect(revealed.ai.p.apiKey).toBe('orig')
  })

  it('scrubSettingsSecrets masks keys for renderer', () => {
    const settings = { ai: { p: { apiKey: 'SECRET' } } }
    const scrubbed = scrubSettingsSecrets(settings)
    const key = scrubbed.ai.p.apiKey as string
    expect(key).not.toBe('SECRET')
    expect(String(key)).not.toContain('SECRET')
  })

  it('handles missing/non-object settings gracefully', () => {
    expect(protectSettingsSecrets({})).toEqual({})
    expect(revealSettingsSecrets({})).toEqual({})
  })

  // ── CRIT-2 regression: merge-preserve on settings:save ──
  it('mergeSettingsPreservingSecrets keeps stored key when incoming apiKey is empty', () => {
    const current = {
      theme: 'dark',
      ai: { gemini: { apiKey: 'stored-key', model: 'gemini-2.0' } }
    }
    // Renderer round-trip: scrubbed settings sent back with apiKey '' + apiKeySet marker
    const incoming = {
      theme: 'dark',
      ai: { gemini: { apiKey: '', apiKeySet: true, model: 'gemini-2.0' } }
    }
    const merged = mergeSettingsPreservingSecrets(current, incoming)
    expect(merged.ai.gemini.apiKey).toBe('stored-key')
    expect(merged.ai.gemini.model).toBe('gemini-2.0')
  })

  it('mergeSettingsPreservingSecrets uses new key when one is typed', () => {
    const current = { ai: { openai: { apiKey: 'old-key' } } }
    const incoming = { ai: { openai: { apiKey: 'new-key', apiKeySet: true } } }
    const merged = mergeSettingsPreservingSecrets(current, incoming)
    expect(merged.ai.openai.apiKey).toBe('new-key')
  })

  it('mergeSettingsPreservingSecrets strips internal apiKeySet marker before persist', () => {
    const current = { ai: { grok: { apiKey: 'stored' } } }
    const incoming = { ai: { grok: { apiKey: '', apiKeySet: true } } }
    const merged = mergeSettingsPreservingSecrets(current, incoming)
    expect(merged.ai.grok.apiKeySet).toBeUndefined()
    expect(merged.ai.grok.apiKey).toBe('stored')
  })

  it('mergeSettingsPreservingSecrets handles new provider ids and missing ai', () => {
    const current = { ai: {} }
    const incoming = { ai: { ollama: { apiKey: '', baseUrl: 'http://localhost:11434' } } }
    const merged = mergeSettingsPreservingSecrets(current, incoming)
    expect(merged.ai.ollama.baseUrl).toBe('http://localhost:11434')
    // New provider with empty incoming key: nothing stored to preserve → key stays falsy
    expect(merged.ai.ollama.apiKey).toBeFalsy()
    expect(mergeSettingsPreservingSecrets(current, { theme: 'light' }).theme).toBe('light')
  })
})
