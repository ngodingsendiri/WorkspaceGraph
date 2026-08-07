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
}

export interface ProviderLike {
  id: string
  name: string
  defaultModel?: string
  models: ModelOption[]
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
