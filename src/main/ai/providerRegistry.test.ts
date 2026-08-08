import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PROVIDER_DEFS,
  AIProviderDef,
  makeProviderId,
  sanitizeDefs,
  readProviderDefs,
  buildProviderMap,
  applyProviderDefsToSettings,
  mergeBuiltinDefs
} from './providerRegistry'
import { GrokProvider } from './providers/GrokProvider'
import { OpenAICompatProvider } from './providers/OpenAICompatProvider'
import { AIMiddleware } from './AIMiddleware'

describe('providerRegistry', () => {
  it('seeds the classic six built-ins as data (grok first, active default)', () => {
    const ids = DEFAULT_PROVIDER_DEFS.map((d) => d.id)
    expect(ids).toEqual(['grok', 'gemini', 'openai', 'claude', 'ollama', 'openrouter'])
    for (const d of DEFAULT_PROVIDER_DEFS) {
      expect(d.kind).toBe('builtin')
      expect(d.builtinId).toBe(d.id)
    }
  })

  it('makeProviderId slugs arbitrary names into stable ids', () => {
    expect(makeProviderId('My Mistral')).toBe('my-mistral')
    expect(makeProviderId('  Grok  Cloud ')).toBe('grok-cloud')
    expect(makeProviderId('!!!')).toBe('provider')
  })

  it('sanitizeDefs trims, slugs, and dedupes ids; drops malformed entries', () => {
    const clean = sanitizeDefs([
      {
        id: ' My Mistral ',
        name: ' My Mistral ',
        kind: 'openai-compat',
        baseUrl: 'https://api.mistral.ai/v1/'
      },
      { id: 'my-mistral', name: 'Dup', kind: 'openai-compat', baseUrl: 'https://x' },
      { id: 'broken', name: '', kind: 'openai-compat' },
      null,
      'nope',
      42
    ] as never)
    expect(clean.length).toBe(3)
    expect(clean[0].id).toBe('my-mistral')
    expect(clean[0].name).toBe('My Mistral')
    expect(clean[0].baseUrl).toBe('https://api.mistral.ai/v1') // trailing slash stripped
    expect(clean[1].id).toBe('my-mistral-2') // dedupe
    // No name → kept with the id as its name (never silently deleted)
    expect(clean[2].id).toBe('broken')
    expect(clean[2].name).toBe('broken')
  })

  it('sanitizeDefs forces builtin defs to the adapter id and falls back for unknown kinds', () => {
    const clean = sanitizeDefs([
      { id: 'anything', name: 'Grok', kind: 'builtin', builtinId: 'grok' },
      { id: 'custom', name: 'X', kind: 'builtin', builtinId: 'not-a-builtin' }
    ] as never)
    expect(clean[0]).toMatchObject({ id: 'grok', kind: 'builtin', builtinId: 'grok' })
    expect(clean[1]).toMatchObject({ id: 'custom', kind: 'openai-compat' })
  })

  it('readProviderDefs falls back to seeds only when nothing (or junk) is saved', () => {
    expect(readProviderDefs(null).map((d) => d.id)).toEqual(DEFAULT_PROVIDER_DEFS.map((d) => d.id))
    expect(readProviderDefs({ aiProviders: {} }).map((d) => d.id)).toEqual(
      DEFAULT_PROVIDER_DEFS.map((d) => d.id)
    )
    expect(readProviderDefs({ aiProviders: 'junk' }).map((d) => d.id)).toEqual(
      DEFAULT_PROVIDER_DEFS.map((d) => d.id)
    )
  })

  it('readProviderDefs honors an explicitly-saved EMPTY list (deleting all providers persists)', () => {
    expect(readProviderDefs({ aiProviders: [] })).toEqual([])
  })

  it('readProviderDefs returns the saved list when present', () => {
    const defs: AIProviderDef[] = [
      { id: 'my-provider', name: 'My Provider', kind: 'openai-compat', baseUrl: 'https://x/v1' }
    ]
    const out = readProviderDefs({ aiProviders: defs })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'my-provider', baseUrl: 'https://x/v1' })
  })

  it('sanitizeDefs/buildProviderMap reject prototype-chain builtin ids (toString/constructor)', () => {
    // 'toString' in BUILTIN_FACTORIES is true via the prototype chain — a
    // crafted def must not pass sanitize or crash buildProviderMap.
    const clean = sanitizeDefs([
      { id: 'x', name: 'X', kind: 'builtin', builtinId: 'toString' },
      { id: 'y', name: 'Y', kind: 'builtin', builtinId: 'constructor' },
      { id: 'z', name: 'Z', kind: 'builtin', builtinId: 'hasOwnProperty' }
    ] as never)
    for (const d of clean) expect(d.kind).toBe('openai-compat')
    // And building from such defs must never throw (no Object() call, no crash)
    expect(() => buildProviderMap(clean)).not.toThrow()
  })

  it('sanitizeDefs dedupes a custom name that slugs onto an existing builtin id', () => {
    // A custom provider named "Grok" must NOT steal the builtin 'grok' id —
    // its key would otherwise overwrite the real Grok credentials.
    const clean = sanitizeDefs([
      { id: 'grok', name: 'Grok (xAI)', kind: 'builtin', builtinId: 'grok' },
      { id: 'grok', name: 'Grok', kind: 'openai-compat', baseUrl: 'https://grok.local/v1' }
    ] as never)
    expect(clean.map((d) => d.id)).toEqual(['grok', 'grok-2'])
    expect(clean[1].kind).toBe('openai-compat')
    expect(clean[1].baseUrl).toBe('https://grok.local/v1')
  })

  it('sanitizeDefs: the builtin wins its canonical id even when the custom row comes first', () => {
    // Order-independence: a hand-edited settings.json (custom "Grok" listed
    // before the builtin) must still leave the adapter id 'grok' with the
    // builtin — the custom row gets bumped to 'grok-2', never the adapter.
    const clean = sanitizeDefs([
      { id: 'grok', name: 'Grok', kind: 'openai-compat', baseUrl: 'https://grok.local/v1' },
      { id: 'grok', name: 'Grok (xAI)', kind: 'builtin', builtinId: 'grok' }
    ] as never)
    expect(clean.map((d) => d.id)).toEqual(['grok-2', 'grok'])
    expect(clean[0].kind).toBe('openai-compat')
    expect(clean[1].kind).toBe('builtin')
    expect(clean[1].builtinId).toBe('grok')
  })

  it('applyProviderDefsToSettings drops keys of removed providers and keeps the rest (key-cleanup)', () => {
    const settings: Record<string, unknown> = {
      ai: {
        grok: { apiKey: 'sk-grok' },
        gemini: { apiKey: 'sk-gemini', baseUrl: 'https://gemini/v1' }
      },
      activeProvider: 'grok'
    }
    const clean = applyProviderDefsToSettings(settings, [
      { id: 'gemini', name: 'Gemini', kind: 'builtin', builtinId: 'gemini' }
    ])
    expect(clean.map((d) => d.id)).toEqual(['gemini'])
    // grok was removed → its key is gone; gemini's key survives untouched
    const ai = settings.ai as Record<string, Record<string, string>>
    expect(ai.grok).toBeUndefined()
    expect(ai.gemini?.apiKey).toBe('sk-gemini')
    expect(ai.gemini?.baseUrl).toBe('https://gemini/v1')
    // Active provider deleted → fell back to the first remaining def
    expect(settings.activeProvider).toBe('gemini')
  })

  it('applyProviderDefsToSettings syncs baseUrl/defaultModel edits into the key entry (P1)', () => {
    const settings: Record<string, unknown> = {
      ai: { 'grok-2': { apiKey: 'sk-custom', baseUrl: 'https://grok.local/v1' } },
      activeProvider: 'grok-2'
    }
    // Row edited to a NEW base URL, no key re-typed
    applyProviderDefsToSettings(settings, [
      { id: 'grok-2', name: 'Grok', kind: 'openai-compat', baseUrl: 'https://grok-new.local/v1' }
    ])
    const entry = (settings.ai as Record<string, Record<string, string>>)['grok-2']
    // The live-apply path (loadSettingsIntoProviders) must see the NEW url,
    // not a stale one lingering until restart
    expect(entry.baseUrl).toBe('https://grok-new.local/v1')
    // Sync must never touch the apiKey
    expect(entry.apiKey).toBe('sk-custom')
  })

  it('applyProviderDefsToSettings syncs defaultModel but leaves baseUrl alone when the def has none', () => {
    const settings: Record<string, unknown> = {
      ai: { x: { apiKey: 'sk-x', baseUrl: 'https://x/v1' } },
      activeProvider: 'x'
    }
    applyProviderDefsToSettings(settings, [
      { id: 'x', name: 'X', kind: 'openai-compat', defaultModel: 'x-large' }
    ])
    const entry = (settings.ai as Record<string, Record<string, string>>).x
    expect(entry.defaultModel).toBe('x-large')
    expect(entry.baseUrl).toBe('https://x/v1') // no def baseUrl → never wiped
    expect(entry.apiKey).toBe('sk-x')
  })

  it('applyProviderDefsToSettings: deleting every provider wipes settings.ai and empties activeProvider', () => {
    const settings: Record<string, unknown> = {
      ai: { grok: { apiKey: 'sk-grok' } },
      activeProvider: 'grok'
    }
    const clean = applyProviderDefsToSettings(settings, [])
    expect(clean).toEqual([])
    expect(settings.aiProviders).toEqual([])
    expect(settings.ai).toBeUndefined() // every saved key wiped
    expect(settings.activeProvider).toBe('')
  })

  it('applyProviderDefsToSettings sanitizes the saved list (colliding custom → grok-2) and cleans ITS key', () => {
    const settings: Record<string, unknown> = {
      ai: { 'grok-2': { apiKey: 'sk-custom' } },
      activeProvider: 'grok-2'
    }
    const clean = applyProviderDefsToSettings(settings, [
      { id: 'grok', name: 'Grok (xAI)', kind: 'builtin', builtinId: 'grok' },
      { id: 'grok', name: 'Grok', kind: 'openai-compat', baseUrl: 'https://grok.local/v1' }
    ])
    expect(clean.map((d) => d.id)).toEqual(['grok', 'grok-2'])
    // The custom's key follows the deduped id — no orphan under a raw slug
    const ai = settings.ai as Record<string, Record<string, string>>
    expect(ai['grok-2']?.apiKey).toBe('sk-custom')
    expect(settings.activeProvider).toBe('grok-2')
  })

  it('mergeBuiltinDefs restores all six seeds after a delete-all (empty list)', () => {
    expect(mergeBuiltinDefs([]).map((d) => d.id)).toEqual([
      'grok',
      'gemini',
      'openai',
      'claude',
      'ollama',
      'openrouter'
    ])
  })

  it('mergeBuiltinDefs adds only missing builtins, keeps customs and existing builtins', () => {
    const merged = mergeBuiltinDefs([
      { id: 'gemini', name: 'Gemini', kind: 'builtin', builtinId: 'gemini' },
      { id: 'my-mistral', name: 'My Mistral', kind: 'openai-compat', baseUrl: 'https://m/v1' }
    ])
    expect(merged.map((d) => d.id)).toEqual([
      'gemini',
      'my-mistral',
      'grok',
      'openai',
      'claude',
      'ollama',
      'openrouter'
    ])
    // Existing providers untouched (no duplicates, no reordering of their values)
    expect(merged.find((d) => d.id === 'gemini')?.kind).toBe('builtin')
    expect(merged.find((d) => d.id === 'my-mistral')?.baseUrl).toBe('https://m/v1')
  })

  it('mergeBuiltinDefs: a custom row holding a canonical id blocks that builtin (no steal)', () => {
    const merged = mergeBuiltinDefs([
      { id: 'grok', name: 'Grok', kind: 'openai-compat', baseUrl: 'https://grok.local/v1' }
    ])
    const ids = merged.map((d) => d.id)
    expect(ids).not.toContain('grok-2') // no duplicate adapter spawned
    expect(merged.filter((d) => d.id === 'grok')).toHaveLength(1)
    expect(merged.find((d) => d.id === 'grok')?.kind).toBe('openai-compat')
    // The other five seeds still come back
    expect(ids).toContain('gemini')
    expect(ids).toContain('openrouter')
  })

  it('mergeBuiltinDefs sanitizes junk input down to the seeds', () => {
    expect(mergeBuiltinDefs(null).map((d) => d.id)).toEqual(DEFAULT_PROVIDER_DEFS.map((d) => d.id))
    expect(mergeBuiltinDefs('nope').map((d) => d.id)).toEqual(
      DEFAULT_PROVIDER_DEFS.map((d) => d.id)
    )
  })

  it('AIMiddleware constructor never leaves the hardcoded grok default pointing at a deleted provider', () => {
    // No grok in defs + no saved activeProvider → active falls back to the first def
    const mid = new AIMiddleware({
      defs: [{ id: 'gemini', name: 'Gemini', kind: 'builtin', builtinId: 'gemini' }]
    })
    expect(mid.getActiveProvider().id).toBe('gemini')
    // Empty provider set → clear "add one" error, never "Active provider not configured: grok"
    const empty = new AIMiddleware({ defs: [] })
    expect(() => empty.getActiveProvider()).toThrow(/add one in Settings/)
  })

  it('buildProviderMap: builtins keep their adapter, custom entries become OpenAI-compatible', () => {
    const map = buildProviderMap([
      {
        id: 'grok',
        name: 'Grok (xAI)',
        kind: 'builtin',
        builtinId: 'grok',
        baseUrl: 'https://api.x.ai/v1'
      },
      {
        id: 'mistral',
        name: 'Mistral',
        kind: 'openai-compat',
        baseUrl: 'https://api.mistral.ai/v1',
        defaultModel: 'mistral-large'
      }
    ])
    expect(map.get('grok')).toBeInstanceOf(GrokProvider)
    const custom = map.get('mistral')
    expect(custom).toBeInstanceOf(OpenAICompatProvider)
    expect(custom?.id).toBe('mistral')
    expect(custom?.name).toBe('Mistral')
    expect(custom?.getDefaultModel()).toBe('mistral-large')
  })

  it('AIMiddleware.rebuildProviders swaps the set and falls the active provider back', () => {
    const mid = new AIMiddleware({
      defs: [{ id: 'a', name: 'A', kind: 'openai-compat', baseUrl: 'https://a/v1' }]
    })
    mid.setActiveProvider('a')
    expect(mid.getActiveProvider().id).toBe('a')
    // Active deleted → falls back to the first remaining provider
    mid.rebuildProviders([
      { id: 'b', name: 'B', kind: 'openai-compat', baseUrl: 'https://b/v1' },
      { id: 'c', name: 'C', kind: 'openai-compat', baseUrl: 'https://c/v1' }
    ])
    expect(mid.getActiveProvider().id).toBe('b')
    // Active still present → preserved
    mid.rebuildProviders([
      { id: 'a', name: 'A', kind: 'openai-compat', baseUrl: 'https://a/v1' },
      { id: 'b', name: 'B', kind: 'openai-compat', baseUrl: 'https://b/v1' }
    ])
    expect(mid.getActiveProvider().id).toBe('b')
  })
})
