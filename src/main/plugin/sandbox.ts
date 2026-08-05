/**
 * Plugin sandbox — executes untrusted plugin JS inside a Node `vm` realm with a
 * deliberately small, capability-restricted global: no `require`, no `process`,
 * no `Buffer`, no `fetch`, no timers, no network.
 *
 * SECURITY (verified empirically): NOTHING host-realm may be reachable from the
 * context, because any host object/function's `.constructor` chain leads to the
 * host `Function` (e.g. `module.constructor.constructor('return process')()`
 * leaks `process`). Therefore EVERYTHING a plugin touches is realm-built:
 *  - `module` / `exports` / `api` / `console` are created in-realm by a
 *    bootstrap; the only host references (`__wgLog`, `__wgApi`) are captured
 *    in closures and deleted from the global immediately.
 *  - Handlers are invoked in-realm too, with a ctx object JSON-parsed inside
 *    the realm — the plugin never receives a host object (not even as an
 *    argument).
 *  - The api bridge returns realm promises, so an un-awaited `api.*` promise
 *    cannot leak host `Promise` either.
 * The context's own intrinsics (Promise, Math, JSON, …) are realm-safe.
 *
 * Defense in depth: this vm runs inside a dedicated worker thread (see
 * js-plugin.worker.ts) so a runaway loop/allocation is terminated with the
 * worker, and even a vm escape would not cross the thread boundary.
 */
import vm from 'vm'
import path from 'path'
import util from 'util'

export interface SandboxOptions {
  /** Synchronous execution cap (vm `timeout`) — guards infinite loops. */
  timeoutMs?: number
  /** Forward console.* output (worker → main) so plugin logs are visible. */
  forwardLog?: (text: string) => void
}

export interface SandboxContext {
  args: unknown
  plugin: unknown
  input?: unknown
}

export interface SandboxHandle {
  /** module.exports of the plugin (realm object; safe to read from host). */
  exports: Record<string, unknown>
  /**
   * Invoke a named handler IN-realm. ctx is JSON-serialized so the handler
   * only ever receives realm values; the realm `api` is attached in-realm.
   * Returns a realm promise (awaitable from host).
   */
  callHandler(handler: string, ctx: SandboxContext): Promise<unknown>
}

/** In-realm bootstrap: realm-safe console / module / exports / api bridge. */
const BOOTSTRAP = `(() => {
  const __m = { exports: {} }
  globalThis.module = __m
  globalThis.exports = __m.exports

  const logSink = __wgLog
  globalThis.console = {
    log: (...a) => logSink(a),
    info: (...a) => logSink(a),
    warn: (...a) => logSink(a),
    error: (...a) => logSink(a)
  }

  // api bridge: in-realm Proxy + realm promises; only the sink is host
  const apiSink = __wgApi
  globalThis.api = new Proxy({}, {
    get: (_t, ns) => {
      if (typeof ns !== 'string') return undefined
      // then guard: awaiting api must not round-trip realm functions to main
      if (ns === 'then' || ns === 'valueOf' || ns === 'toPrimitive') return undefined
      return new Proxy({}, {
        get: (_n, method) => {
          if (typeof method !== 'string') return undefined
          return (...a) =>
            new Promise((res, rej) => {
              Promise.resolve(apiSink(ns, method, a)).then(res, rej)
            })
        }
      })
    }
  })

  delete globalThis.__wgLog
  delete globalThis.__wgApi
})()`

function buildCtxSource(ctx: SandboxContext): string {
  // JSON round-trip: ctx values become realm objects (JSON.parse is safe
  // against __proto__ pollution), then the realm api is attached in-realm.
  const json = JSON.stringify(ctx)
  return `(() => { const d = JSON.parse(${JSON.stringify(json)}); d.api = api; return d })()`
}

/**
 * Compile a CommonJS-style plugin module inside the sandbox. Handlers are plain
 * functions: `module.exports = { myCommand: async (ctx) => { ... } }`.
 *
 * `apiRequest(ns, method, args)` is the host-side privileged bridge; it must
 * return a promise resolving to the api result or rejecting with an Error.
 *
 * Throws on compile error, runtime sync throw, or vm timeout (at load).
 */
export function executePluginModule(
  code: string,
  filename: string,
  apiRequest: (ns: string, method: string, args: unknown[]) => Promise<unknown>,
  opts: SandboxOptions = {}
): SandboxHandle {
  const forwardLog = opts.forwardLog ?? (() => {})
  const timeoutMs = opts.timeoutMs ?? 10_000

  const context = vm.createContext({
    __filename: filename,
    __dirname: path.dirname(filename)
    // Intentionally absent: require, process, Buffer, global, fetch, timers.
  })

  // Temporary host sinks — consumed by the bootstrap, then deleted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(context as any).__wgLog = (args: unknown[]) =>
    forwardLog(
      args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 3 }))).join(' ')
    )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(context as any).__wgApi = (ns: string, method: string, args: unknown[]) =>
    apiRequest(ns, method, args)

  vm.runInContext(BOOTSTRAP, context, { filename: '<plugin-bootstrap>' })
  vm.runInContext(code, context, { filename, timeout: timeoutMs })

  const exports = vm.runInContext('module.exports', context)

  // Note: vm `timeout` only guards the synchronous start of the handler; a sync
  // loop *after* an await, or a never-resolving promise, is stopped by the
  // worker-thread terminate in the runner (defense in depth).
  const callHandler = (handler: string, ctx: SandboxContext): Promise<unknown> =>
    vm.runInContext(`module.exports[${JSON.stringify(handler)}](${buildCtxSource(ctx)})`, context, {
      timeout: timeoutMs
    }) as Promise<unknown>

  return { exports: (exports ?? {}) as Record<string, unknown>, callHandler }
}
