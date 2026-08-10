/**
 * Flash-decision gate for the provider ROW Save in Settings.
 *
 * The row Save persists defs first, then the NEWLY typed key via ai:configure.
 * A failed configure must NEVER be reported as "…disimpan — tes otomatis…" —
 * that fake-success flash hid real persistence failures (the key never landed
 * in settings.ai[id]). This pure builder decides what the user sees from the
 * configure outcome, so the no-fake-success contract is unit-testable in the
 * node test environment (no jsdom) — the same extraction pattern as
 * providerDeleteConfirm.ts / failoverOrder.ts.
 */

export interface SaveKeyOutcome {
  /** Falsy/undefined means the persist failed (or the IPC was rejected). */
  ok?: boolean
  error?: string
}

/** LOW-5: single shared label for a provider def — name when present, else id. */
export function providerLabel(def: { id: string; name?: string }): string {
  return def.name?.trim() ? def.name.trim() : def.id
}

/**
 * The flash message for a row Save.
 * - No key typed            → plain "disimpan" (nothing to verify)
 * - Key typed + configure OK → "…disimpan — tes otomatis…"
 * - Key typed + configure FAILED (or IPC rejected → undefined) → the real
 *   error, NEVER a success flash.
 */
export function buildRowSaveFlash(
  def: { id: string; name?: string },
  hadKey: boolean,
  outcome: SaveKeyOutcome | undefined
): string {
  const label = providerLabel(def)
  if (!hadKey) return `Provider ${label} disimpan`
  if (!outcome || !outcome.ok) {
    return `Gagal menyimpan key ${label}: ${outcome?.error || 'unknown'}`
  }
  return `Provider ${label} disimpan — tes otomatis…`
}
