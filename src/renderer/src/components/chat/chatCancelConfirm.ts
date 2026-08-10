/**
 * Two-step stop gate for the streaming composer button.
 *
 * Cancelling mid-stream costs the user the tool round in progress (work is
 * re-done on resume). A single accidental click on a plain "Cancel" button
 * does exactly that, so the stop button never cancels on the first click:
 *
 *   1st click  → arm: button turns into a pulsing "Stop? n" countdown
 *   2nd click  → within the arm window: cancel (cancelStream)
 *   click      → after the window expired: re-arm, NOT cancel
 *
 * Kept as pure functions so the confirmation contract is unit-testable in
 * the node test environment (no jsdom) — the same extraction pattern as
 * providerDeleteConfirm.ts / failoverOrder.ts.
 */

/** How long the armed confirmation stays live before expiring (ms). */
export const CANCEL_ARM_MS = 2500

/** Milliseconds left in the confirmation window — 0 when idle or expired. */
export function cancelRemainingMs(armedAt: number | null, now: number): number {
  if (armedAt === null) return 0
  return Math.max(0, CANCEL_ARM_MS - (now - armedAt))
}

/** True once the armed confirmation has expired (must re-arm, not cancel). */
export function isArmedExpired(armedAt: number | null, now: number): boolean {
  return armedAt !== null && now - armedAt >= CANCEL_ARM_MS
}

export type CancelClickResult = 'arm' | 'cancel' | 'rearm'

/**
 * The click contract. First click on idle arms; a second click inside the
 * window cancels; a click after the window expired re-arms (an expired
 * confirmation must never fire a cancel).
 */
export function nextCancelClick(
  armed: boolean,
  armedAt: number | null,
  now: number
): CancelClickResult {
  if (!armed) return 'arm'
  if (isArmedExpired(armedAt, now)) return 'rearm'
  return 'cancel'
}

/**
 * Short label for the armed button — "Stop? 3", "Stop? 2", "Stop? 1".
 * At 0ms (window edge, one tick before disarm) the label is plain "Stop?"
 * (NIT-2) — a ticking "Stop? 1" that is about to vanish reads as a broken
 * countdown; a bare confirmation is stable and never implies a second left.
 */
export function cancelConfirmLabel(remainingMs: number): string {
  if (remainingMs <= 0) return 'Stop?'
  const sec = Math.ceil(remainingMs / 1000)
  return `Stop? ${sec}`
}
