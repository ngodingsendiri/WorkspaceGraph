/**
 * Runtime model discovery (shared by every provider).
 *
 * Goal: given just an API key + base URL, the app auto-detects the real model
 * list from the provider instead of shipping a hardcoded snapshot. Each
 * provider calls ONE of the fetchers below and falls back to its static list
 * when the endpoint is unreachable (offline / wrong key / non-standard base).
 *
 * Free-model indication:
 * - OpenRouter exposes real per-model pricing (`pricing.prompt === '0'`) → the
 *   `free` flag is exact there (huge catalog of $0 open models).
 * - Ollama is local → every model is free by definition.
 * - Gemini free-tier models (flash/nano/lite/light) are flagged via a naming
 *   heuristic — the API does not expose pricing.
 * - OpenAI/Grok/Claude have no $0 models; their lists stay unmarked.
 *
 * Every fetcher has a short timeout + try/catch and returns [] on failure so a
 * slow/stale endpoint can never hang the Settings panel.
 */
import type { ModelInfo } from './BaseProvider'

export const DISCOVERY_TIMEOUT_MS = 8_000

/** Fetch with AbortController timeout — never hangs the UI. */
async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = DISCOVERY_TIMEOUT_MS
): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** OpenAI-compatible `GET /models` → `{ data: [{ id, owned_by }] }`. */
export async function fetchOpenAICompatModels(
  baseUrl: string,
  apiKey: string
): Promise<ModelInfo[]> {
  if (!baseUrl || !apiKey) return []
  const clean = baseUrl.replace(/\/+$/, '')
  const json = await fetchJson(`${clean}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  const data = (json as { data?: { id?: string; owned_by?: string }[] })?.data
  if (!Array.isArray(data)) return []
  return data
    .map((m) => ({
      id: m.id || '',
      name: m.id || '',
      ownedBy: m.owned_by
    }))
    .filter((m) => m.id)
}

/** True when the base already carries a version segment (/v1, /api/v2 …). */
export function isVersionedBase(userBase: string): boolean {
  const clean = userBase.trim().replace(/\/+$/, '')
  return /(\/v\d+$|\/api\/v\d+$)/.test(clean)
}

/**
 * Single adoption rule shared by listModels + the lazy chat-path guard: return
 * the chat base to adopt (or null when the current base already works). Both
 * providers use this so the two paths can never drift on adoption semantics.
 */
export function shouldAdoptChatBase(
  currentBase: string,
  discovered: { chatBase: string } | null
): string | null {
  if (discovered && discovered.chatBase !== currentBase) return discovered.chatBase
  return null
}

/**
 * Candidate chat-base URLs for a user-entered endpoint. Covers the common
 * OpenAI-compat layouts so "just paste the domain" works for any gateway:
 * - `https://host`            → itself, `https://host/v1`, `https://host/api/v1`
 * - `https://host/v1`         → as-is (already versioned)
 * - `https://host/v1/models`  → stripped to `https://host/v1` (full URL pasted)
 * Query/hash fragments (e.g. pasted signed URLs) are dropped first.
 */
export function chatBaseCandidates(userBase: string): string[] {
  let clean = userBase.trim().replace(/\/+$/, '')
  if (!clean) return []
  // Drop query/hash so a pasted signed URL can't poison the probes
  clean = clean.split(/[?#]/)[0].replace(/\/+$/, '')
  // User pasted the full models URL — strip to the chat base
  clean = clean.replace(/\/models\/?$/, '')
  if (isVersionedBase(clean)) return [clean]
  return [clean, `${clean}/v1`, `${clean}/api/v1`]
}

/**
 * Try every candidate chat-base until one answers `GET /models` with data.
 * Returns the models AND the working chat base — the caller should adopt the
 * base so chat completions hit the same versioned path, not just discovery.
 */
export async function discoverOpenAICompat(
  userBase: string,
  apiKey: string
): Promise<{ models: ModelInfo[]; chatBase: string } | null> {
  for (const candidate of chatBaseCandidates(userBase)) {
    const models = await fetchOpenAICompatModels(candidate, apiKey)
    if (models.length > 0) return { models, chatBase: candidate }
  }
  return null
}

/**
 * Anthropic `GET /v1/models` → `{ data: [{ id, display_name }] }`.
 * Uses the `x-api-key` header (not Bearer). Returns [] when the endpoint is
 * unavailable so callers fall back to their static list.
 */
export async function fetchAnthropicModels(
  apiKey: string,
  baseUrl = 'https://api.anthropic.com/v1'
): Promise<ModelInfo[]> {
  if (!apiKey) return []
  const clean = baseUrl.replace(/\/+$/, '')
  const json = await fetchJson(`${clean}/models`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  })
  const data = (json as { data?: { id?: string; display_name?: string }[] })?.data
  if (!Array.isArray(data)) return []
  return data
    .map((m) => ({ id: m.id || '', name: m.display_name || m.id || '' }))
    .filter((m) => m.id)
}

/** Gemini `GET /v1beta/models?key=…` → `{ models: [{ name, displayName, inputTokenLimit }] }`. */
export async function fetchGeminiModels(apiKey: string): Promise<ModelInfo[]> {
  if (!apiKey) return []
  const json = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
  )
  const models = (
    json as {
      models?: { name?: string; displayName?: string; inputTokenLimit?: number }[]
    }
  )?.models
  if (!Array.isArray(models)) return []
  return models
    .map((m) => ({
      // name is "models/gemini-2.5-flash" — strip the prefix for the model id
      id: (m.name || '').replace(/^models\//, ''),
      name: m.displayName || (m.name || '').replace(/^models\//, ''),
      contextWindow: m.inputTokenLimit,
      free: isGeminiFreeTier(m.name || '')
    }))
    .filter((m) => m.id)
}

/**
 * OpenRouter `GET /api/v1/models` → `{ data: [{ id, name, pricing }] }`.
 * `pricing` values are STRING numbers; `"0"` everywhere = the model is free.
 */
export async function fetchOpenRouterModels(apiKey: string): Promise<ModelInfo[]> {
  if (!apiKey) return []
  const json = await fetchJson('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  const data = (
    json as {
      data?: {
        id?: string
        name?: string
        context_length?: number
        pricing?: { prompt?: string; completion?: string; request?: string; image?: string }
      }[]
    }
  )?.data
  if (!Array.isArray(data)) return []
  return data
    .map((m) => {
      const pricing = m.pricing || {}
      // BUGFIX: only mark free when pricing is ACTUALLY present with at least
      // one field and every field is $0. A missing/empty pricing object is a
      // malformed entry, not a free model — `Object.values({}).every(...)`
      // would otherwise be vacuously true and claim broken rows are free.
      const hasPricing = Object.keys(pricing).length > 0
      const free =
        hasPricing &&
        Object.values(pricing).every(
          (v) => v === undefined || v === null || v === '' || Number(v) === 0
        )
      return {
        id: m.id || '',
        name: m.name || m.id || '',
        contextWindow: m.context_length,
        // omitted when no pricing — unknown ≠ free, never a false claim
        ...(hasPricing ? { free } : {})
      }
    })
    .filter((m) => m.id)
}

/** Gemini free-tier naming heuristic (flash/nano/lite/light — no pricing API). */
export function isGeminiFreeTier(modelName: string): boolean {
  return /-(flash|nano|lite|light)(\b|-|$)/i.test(modelName)
}

/**
 * Free-tier fallback for providers WITHOUT pricing data (OpenAI/Grok/Claude):
 * name-based hints only — stays conservative (no false "free" claims).
 */
const FREE_NAME_HINTS = [
  // Conservative: only models that are widely $0. No speculative guesses — a
  // false "Gratis" claim on a billed model is worse than no badge at all.
  /-flash$/i,
  /-nano$/i,
  /-lite$/i,
  /-light$/i,
  /^llama3\.2.*(1b|3b)$/i,
  /^qwen2\.5.*(0\.5b|1\.5b|3b)$/i
]

export function markFreeByHeuristic(models: ModelInfo[]): ModelInfo[] {
  return models.map((m) => {
    if (m.free !== undefined) return m // real data already present
    return { ...m, free: FREE_NAME_HINTS.some((re) => re.test(m.id)) }
  })
}

/**
 * Merge runtime discovery with the static fallback list. Runtime wins; static
 * entries that runtime didn't report are appended (keeps offline models visible
 * without letting them shadow the real list). Duplicate ids are de-duplicated.
 */
export function mergeWithFallback(runtime: ModelInfo[], fallback: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const m of [...runtime, ...fallback]) {
    if (!m.id || seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
}

/**
 * Small per-provider cache so the Settings panel / model picker don't hammer
 * `GET /models` on every keystroke. TTL ~5 minutes; bust on configure.
 */
export function createModelCache(): {
  get(): ModelInfo[] | null
  /** `fromRuntime` = the list came from a LIVE /models fetch (true) vs the
   *  static fallback (false). Only live fetches stamp the "diperbarui …"
   *  time — a dead endpoint must not look freshly refreshed. */
  set(models: ModelInfo[], fromRuntime?: boolean): void
  clear(): void
  /** Unix ms when the LIVE model list was last fetched — null when never,
   *  cleared, or the last load fell back to the static list. Historical after
   *  TTL expiry, so a stale list shows an old stamp (never disappears). */
  fetchedAt(): number | null
} {
  let models: ModelInfo[] | null = null
  let at = 0
  let lastWasRuntime = false
  const TTL_MS = 5 * 60 * 1000
  return {
    get: () => (models && Date.now() - at < TTL_MS ? models : null),
    set: (m, fromRuntime = true) => {
      models = m
      at = Date.now()
      lastWasRuntime = fromRuntime
    },
    clear: () => {
      models = null
      at = 0
      lastWasRuntime = false
    },
    fetchedAt: () => (at > 0 && lastWasRuntime ? at : null)
  }
}
