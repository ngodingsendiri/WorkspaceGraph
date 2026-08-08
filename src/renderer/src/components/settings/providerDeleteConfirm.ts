/**
 * Confirmation gate for deleting a provider row in Settings.
 *
 * Deleting a provider permanently removes its saved API key from the secure
 * store (main's ai:saveProviderConfigs drops settings.ai[id]), so the delete
 * must be an explicit, danger-styled confirmation — never a one-click action.
 *
 * Kept as a pure builder so the confirmation contract is unit-testable in the
 * node test environment (no jsdom) — the same extraction pattern as
 * failoverOrder.ts.
 */

export interface ProviderDeleteConfirmInput {
  id: string
  name?: string
  /** True when the secure store holds a key for this provider. */
  hasKey: boolean
}

/** The dialog request shape — mirrors DialogOptions in ../ui/Dialog. */
export interface ConfirmRequest {
  title: string
  message: string
  danger: boolean
  okLabel: string
  cancelLabel: string
}

export function buildProviderDeleteConfirm(def: ProviderDeleteConfirmInput): ConfirmRequest {
  const label = def.name?.trim() ? def.name.trim() : def.id
  return {
    title: `Hapus provider ${label}?`,
    message: def.hasKey
      ? `API key untuk ${def.id} akan ikut terhapus permanen dari penyimpanan aman. Lanjutkan?`
      : `Provider ${def.id} akan dihapus dari daftar. Lanjutkan?`,
    danger: true,
    okLabel: 'Hapus',
    cancelLabel: 'Batal'
  }
}

/**
 * The full gate: build the confirm request and run it through the given
 * dialog implementation. The component passes confirmDialog from ../ui/Dialog;
 * tests pass a fake to prove that a declined dialog aborts the deletion.
 */
export function confirmProviderDelete(
  confirm: (req: ConfirmRequest) => Promise<boolean>,
  def: ProviderDeleteConfirmInput
): Promise<boolean> {
  return confirm(buildProviderDeleteConfirm(def))
}
