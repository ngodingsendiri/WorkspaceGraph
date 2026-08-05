/**
 * Plugin runtime — the worker-side core that runs a plugin handler inside the
 * sandbox and bridges `api.*` calls back to the main process via postMessage.
 *
 * Kept as a pure module (transport-agnostic) so the real worker is a thin shell
 * and vitest can exercise the exact same code path in-process with an
 * in-memory transport.
 */
import fs from 'fs'
import { executePluginModule } from './sandbox'

export interface PluginTransport {
  post(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): void
}

export interface RuntimeOptions {
  entry: string
  handler: string
  args: Record<string, unknown>
  transport: PluginTransport
  /** Sandbox sync-execution cap */
  timeoutMs?: number
  /** Plugin metadata surfaced to the handler via ctx.plugin */
  plugin?: { id: string; name: string; version?: string; dir: string }
}

/** Error message that works across vm realms (vm Errors fail host instanceof). */
function errMsg(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message
    if (typeof m === 'string' && m) return m
  }
  return String(e)
}

function safeClone(v: unknown): unknown {
  if (v === undefined) return null
  try {
    return structuredClone(v)
  } catch {
    /* non-cloneable (functions, DOM…) — fall through */
  }
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return String(v)
  }
}

/** Build the host-side api request bridge: (ns, method, args) → postMessage + await reply. */
function createApiBridge(transport: PluginTransport): {
  request: (ns: string, method: string, args: unknown[]) => Promise<unknown>
  handleResult: (msg: unknown) => void
} {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let callId = 0

  const request = (ns: string, method: string, callArgs: unknown[]): Promise<unknown> => {
    const id = ++callId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      transport.post({ type: 'api-call', callId: id, ns, method, args: callArgs })
    })
  }

  return {
    request,
    handleResult: (msg) => {
      const m = msg as { type?: string; callId?: number; ok?: boolean; value?: { error?: string } }
      if (m.type !== 'api-result' || typeof m.callId !== 'number') return
      const p = pending.get(m.callId)
      if (!p) return
      pending.delete(m.callId)
      if (m.ok) p.resolve(m.value)
      else p.reject(new Error(m.value?.error || 'Plugin API error'))
    }
  }
}

/**
 * Run one plugin command inside the sandbox. Progress is reported through the
 * transport: `api-call` (→ main), `log`, `error` (load/execute failure),
 * `done` (handler finished). This function returns after wiring everything up;
 * completion is delivered asynchronously via the transport.
 */
export function createPluginRuntime(opts: RuntimeOptions): void {
  const { entry, handler, args, transport } = opts
  const { request, handleResult } = createApiBridge(transport)
  const meta = opts.plugin ?? { id: '', name: '', version: '', dir: '' }
  transport.onMessage(handleResult)

  let code: string
  try {
    code = fs.readFileSync(entry, 'utf-8')
  } catch (e) {
    transport.post({ type: 'error', error: `Cannot read plugin entry: ${errMsg(e)}` })
    return
  }

  let handle: ReturnType<typeof executePluginModule>
  try {
    handle = executePluginModule(code, entry, request, {
      timeoutMs: opts.timeoutMs ?? 10_000,
      forwardLog: (text) => transport.post({ type: 'log', text })
    })
  } catch (e) {
    transport.post({ type: 'error', error: `Plugin load failed: ${errMsg(e)}` })
    return
  }

  if (typeof handle.exports[handler] !== 'function') {
    transport.post({ type: 'error', error: `Handler "${handler}" is not exported by the plugin` })
    return
  }

  Promise.resolve()
    .then(() =>
      handle.callHandler(handler, {
        args,
        plugin: { id: meta.id, name: meta.name, version: meta.version || '', dir: meta.dir },
        input: undefined
      })
    )
    .then((result) => transport.post({ type: 'done', ok: true, result: safeClone(result) }))
    .catch((e) =>
      transport.post({
        type: 'done',
        ok: false,
        error: errMsg(e)
      })
    )
}
