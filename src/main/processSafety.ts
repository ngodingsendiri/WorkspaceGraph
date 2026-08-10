/**
 * AD-1 — Defensive process-wide safety net for the main process.
 *
 * Every abort path in the AI layer is currently clean (providers resolve on
 * abort instead of rejecting), but one future regression — e.g. a new provider
 * that rejects after abort, or a stray async error in a fire-and-forget path —
 * would otherwise surface as an unhandled rejection / uncaught exception that
 * takes down the whole app and the user's unsaved work.
 *
 * These handlers log loudly and keep the process alive. They are a net, not a
 * license to ignore errors: call sites should still handle their own failures.
 */

let installed = false

export function installProcessSafetyNet(): void {
  if (installed) return
  installed = true

  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? reason.stack || reason.message : JSON.stringify(reason)
    console.error(`[process] unhandledRejection — ${detail}`)
  })

  process.on('uncaughtException', (err) => {
    console.error(`[process] uncaughtException — ${err?.stack || err}`)
  })
}
