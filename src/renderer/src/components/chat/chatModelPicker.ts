/**
 * P1-3: inline model picker helpers for the composer.
 *
 * The composer chip shows either a concrete model or the `auto` sentinel
 * ("use the active provider's default"). `sendMessage` resolves `auto` to
 * `undefined` so the middleware picks the provider default — the same guard
 * it already uses for empty models.
 */

/** Sentinel value: follow the active provider's default model. */
export const AUTO_MODEL = 'auto'

export function isAutoModel(modelId: string | undefined | null): boolean {
  return !modelId || modelId === AUTO_MODEL
}

export interface ModelOption {
  id: string
  name: string
  free?: boolean
  contextWindow?: number
  ownedBy?: string
}

export interface ProviderLike {
  id: string
  name: string
  defaultModel?: string
  models: ModelOption[]
}

/** Compact context-window label: "128k", "1M", "2.1M", "1048576". */
export function formatContextWindow(n: number | undefined): string {
  if (!n || n <= 0) return ''
  if (n >= 1_000_000) {
    // 1,048,576 → "1M" (strip a trailing .0); 2,097,152 → "2.1M"
    const m = (n / 1_000_000).toFixed(1).replace(/\.0$/, '')
    return `${m}M`
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** Detail subtitle for a model row: "1M ctx · owned_by". */
export function modelDetailSubtitle(model: ModelOption): string {
  const parts: string[] = []
  const ctx = formatContextWindow(model.contextWindow)
  if (ctx) parts.push(`${ctx} context`)
  if (model.ownedBy) parts.push(model.ownedBy)
  return parts.join(' · ')
}

/** The concrete model `auto` resolves to for a provider. */
export function resolveAutoModel(provider: ProviderLike | undefined | null): string {
  if (!provider) return ''
  return provider.defaultModel || provider.models[0]?.id || ''
}

/** Dropdown label for the auto row: `Auto · <resolved model>` (or just Auto). */
export function autoLabel(provider: ProviderLike | undefined | null): string {
  const resolved = resolveAutoModel(provider)
  return resolved ? `Auto · ${resolved}` : 'Auto'
}

export interface ModelGroup {
  providerId: string
  providerName: string
  models: ModelOption[]
}

/** Group providers' models for the picker — empty providers are omitted. */
export function buildModelGroups(providers: ProviderLike[]): ModelGroup[] {
  return providers
    .map((p) => ({ providerId: p.id, providerName: p.name, models: p.models }))
    .filter((g) => g.models.length > 0)
}
