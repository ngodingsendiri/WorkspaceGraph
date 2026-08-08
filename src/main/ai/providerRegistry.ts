import { BaseProvider } from './providers/BaseProvider'
import { GrokProvider } from './providers/GrokProvider'
import { GeminiProvider } from './providers/GeminiProvider'
import { OpenAIProvider } from './providers/OpenAIProvider'
import { ClaudeProvider } from './providers/ClaudeProvider'
import { OllamaProvider } from './providers/OllamaProvider'
import { OpenRouterProvider } from './providers/OpenRouterProvider'
import { OpenAICompatProvider } from './providers/OpenAICompatProvider'

/**
 * A persisted provider definition. The set of providers is DATA, not code:
 * settings.aiProviders holds this array, so users can add / edit / delete
 * providers (custom ones run through the generic OpenAI-compatible adapter).
 *
 * Built-ins (grok/gemini/openai/claude/ollama/openrouter) keep their special
 * adapters — Grok CLI auth, Gemini SDK, Ollama localhost probe — but are still
 * ordinary rows: editable, deletable, replaceable by a custom entry.
 */
export interface AIProviderDef {
  id: string
  name: string
  /** 'builtin' → instantiate the known adapter; anything else → OpenAI-compatible. */
  kind: 'builtin' | 'openai-compat'
  /** The adapter key when kind === 'builtin' (grok/gemini/openai/claude/ollama/openrouter). */
  builtinId?: string
  baseUrl?: string
  defaultModel?: string
}

/** Default seed set — the classic six, as data. First-run / fallback. */
export const DEFAULT_PROVIDER_DEFS: AIProviderDef[] = [
  {
    id: 'grok',
    name: 'Grok (xAI)',
    kind: 'builtin',
    builtinId: 'grok',
    baseUrl: 'https://api.x.ai/v1'
  },
  { id: 'gemini', name: 'Gemini', kind: 'builtin', builtinId: 'gemini' },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'builtin',
    builtinId: 'openai',
    baseUrl: 'https://api.openai.com/v1'
  },
  { id: 'claude', name: 'Claude', kind: 'builtin', builtinId: 'claude' },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'builtin',
    builtinId: 'ollama',
    baseUrl: 'http://localhost:11434'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'builtin',
    builtinId: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1'
  }
]

const BUILTIN_FACTORIES: Record<string, () => BaseProvider> = {
  grok: () => new GrokProvider(),
  gemini: () => new GeminiProvider(),
  openai: () => new OpenAIProvider(),
  claude: () => new ClaudeProvider(),
  ollama: () => new OllamaProvider(),
  openrouter: () => new OpenRouterProvider()
}

/** Own-property check — `in` would accept prototype-chain names like
 * 'toString'/'constructor', letting a crafted def crash buildProviderMap
 * (and, since settings persist before rebuild, brick the app on next boot). */
function isBuiltinId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_FACTORIES, id)
}

/** Slug an arbitrary name into a stable provider id: "My Mistral" → my-mistral. */
export function makeProviderId(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'provider'
  return base
}

/**
 * Sanitize untrusted provider defs (renderer input): trim, slug+dedupe ids,
 * force builtin ids to the adapter key, drop malformed entries. Never throws.
 */ export function sanitizeDefs(defs: unknown): AIProviderDef[] {
  if (!Array.isArray(defs)) return []
  const seen = new Set<string>()
  const out: AIProviderDef[] = []
  for (const raw of defs) {
    if (!raw || typeof raw !== 'object') continue
    const d = raw as Record<string, unknown>
    const name = String(d.name ?? '').trim()
    let kind: AIProviderDef['kind'] = 'openai-compat'
    let builtinId: string | undefined
    if (d.kind === 'builtin' && typeof d.builtinId === 'string' && isBuiltinId(d.builtinId)) {
      kind = 'builtin'
      builtinId = d.builtinId
    } // Builtin rows keep the adapter's fixed id so the map key stays stable;
    // custom ids are slugged ('My Mistral' → 'my-mistral') so a saved id can
    // never contain spaces or other filename-unsafe characters.
    let id = kind === 'builtin' ? (builtinId as string) : makeProviderId(String(d.id ?? ''))
    if (!id || id === 'provider') id = makeProviderId(name || 'provider')
    if (seen.has(id)) {
      if (kind === 'builtin') {
        // A builtin always wins its canonical id, regardless of input order:
        // bump whichever non-builtin currently holds it (customs dedupe to
        // id-2, id-3, …) so the adapter key can never be renamed by a custom
        // row that slugged onto it.
        const holderIdx = out.findIndex((x) => x.id === id && x.kind !== 'builtin')
        if (holderIdx >= 0) {
          let n = 2
          while (seen.has(`${id}-${n}`)) n++
          const bumped = `${id}-${n}`
          seen.add(bumped)
          out[holderIdx] = { ...out[holderIdx], id: bumped, name: out[holderIdx].name || bumped }
        } else {
          // Duplicate builtin row — suffix it, the canonical id stays taken
          let n = 2
          while (seen.has(`${id}-${n}`)) n++
          id = `${id}-${n}`
        }
      } else {
        let n = 2
        while (seen.has(`${id}-${n}`)) n++
        id = `${id}-${n}`
      }
    }
    seen.add(id)
    const baseUrl = String(d.baseUrl ?? '')
      .trim()
      .replace(/\/+$/, '')
    const defaultModel = String(d.defaultModel ?? '').trim() || undefined
    out.push({
      id,
      name: name || id,
      kind,
      ...(builtinId ? { builtinId } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(defaultModel ? { defaultModel } : {})
    })
  }
  return out
}

/** The persisted provider set, or the built-in seeds when nothing is saved yet.
 * An explicitly-saved EMPTY array is authoritative — deleting every provider
 * must survive a restart, not resurrect the six built-ins. */
export function readProviderDefs(
  settings: { aiProviders?: unknown } | null | undefined
): AIProviderDef[] {
  const raw = settings?.aiProviders
  if (Array.isArray(raw)) return sanitizeDefs(raw)
  return DEFAULT_PROVIDER_DEFS.map((d) => ({ ...d }))
}

/**
 * Merge the built-in seeds back into a def list (Settings → Reset ke provider
 * bawaan): adds any seed whose canonical id is missing, keeps every existing
 * provider (custom or builtin) untouched. Non-destructive — after a delete-all
 * the result is exactly the six seeds; with customs present they survive.
 *
 * A custom row that happens to hold a canonical id (e.g. custom named "Grok"
 * with id 'grok') blocks that builtin — the adapter can't claim a taken id
 * without renaming the custom, which is out of scope for a reset.
 */
export function mergeBuiltinDefs(defs: unknown): AIProviderDef[] {
  const current = sanitizeDefs(defs)
  const ids = new Set(current.map((d) => d.id))
  for (const seed of DEFAULT_PROVIDER_DEFS) {
    if (!ids.has(seed.id)) {
      current.push({ ...seed })
      ids.add(seed.id)
    }
  }
  return current
}

/** Instantiate the provider map from definitions — builtins keep their adapter,
 * custom entries become OpenAI-compatible providers. */
export function buildProviderMap(defs: AIProviderDef[]): Map<string, BaseProvider> {
  const map = new Map<string, BaseProvider>()
  for (const def of sanitizeDefs(defs)) {
    let provider: BaseProvider
    if (def.kind === 'builtin' && def.builtinId && isBuiltinId(def.builtinId)) {
      provider = BUILTIN_FACTORIES[def.builtinId]()
    } else {
      provider = new OpenAICompatProvider({
        id: def.id,
        name: def.name,
        baseUrl: def.baseUrl,
        defaultModel: def.defaultModel
      })
    }
    provider.configure({
      ...(def.baseUrl ? { baseUrl: def.baseUrl } : {}),
      ...(def.defaultModel ? { defaultModel: def.defaultModel } : {})
    })
    map.set(provider.id, provider)
  }
  return map
}

/**
 * Pure settings-mutation behind ai:saveProviderConfigs — unit-testable without
 * the IPC layer. Applies the def list to a settings object and returns the
 * sanitized defs (the handler persists, rebuilds, and re-applies keys after).
 *
 * Contract:
 * - settings.aiProviders ← clean defs (the saved list IS the data)
 * - keys of REMOVED providers are dropped (deleted providers leave no trace)
 * - baseUrl/defaultModel are synced from defs into the key entries (P1: a row
 *   edited without re-typing a key must apply LIVE, not linger stale until
 *   restart) — apiKey is never touched here
 * - settings.ai removed entirely when nothing remains
 * - activeProvider falls back to the first def when it was deleted ('' when
 *   all providers are gone)
 */
export function applyProviderDefsToSettings(
  settings: Record<string, unknown>,
  defs: unknown
): AIProviderDef[] {
  const clean = sanitizeDefs(defs)
  settings.aiProviders = clean
  // Keys of removed providers are dropped so deleted providers leave no trace
  const ai = (settings.ai as Record<string, Record<string, unknown>>) || {}
  for (const id of Object.keys(ai)) {
    if (!clean.some((d) => d.id === id)) delete ai[id]
  }
  // Defs are the source of truth for baseUrl/defaultModel: push row edits into
  // settings.ai so loadSettingsIntoProviders applies them LIVE.
  for (const d of clean) {
    const entry = ai[d.id]
    if (!entry) continue
    if (d.baseUrl !== undefined) entry.baseUrl = d.baseUrl
    if (d.defaultModel !== undefined) entry.defaultModel = d.defaultModel
  }
  if (Object.keys(ai).length > 0) settings.ai = ai
  else delete settings.ai
  // Active provider fallback — never point at a provider that no longer exists
  const active = String(settings.activeProvider ?? '')
  if (!clean.some((d) => d.id === active)) {
    settings.activeProvider = clean[0]?.id ?? ''
  }
  return clean
}
