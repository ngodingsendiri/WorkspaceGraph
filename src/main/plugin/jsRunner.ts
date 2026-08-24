/**
 * JS plugin runner (main process) — spawns a worker thread per command
 * invocation (isolation + hard termination), routes `api.*` calls to the real
 * engines with vault path checks, and prompts the user before any
 * write-capable operation.
 *
 * Permission model:
 *  - read/search/graph/automation-list/settings-get ops: auto-allowed
 *    (vault-scoped, read-only)
 *  - vault.write / vault.delete / automation.runRule: first-use prompt
 *    (dialog) with "Selalu izinkan" remembered for the session
 */
import fs from 'fs'
import path from 'path'
import { Worker } from 'worker_threads'
import { dialog, BrowserWindow } from 'electron'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { searchEngine } from '../engine/SearchEngine'
import { graphEngine } from '../engine/GraphEngine'
import { automationEngine } from '../engine/AutomationEngine'
import { resolveVaultRelative } from '../security/PathSandbox'
import { scrubSettingsSecrets } from '../security/SecretsStore'

export interface JsPluginRuntimeInfo {
  pluginId: string
  pluginName: string
  version?: string
  dir: string
  entry: string
  /**
   * M1.5 (PLG-4): declared manifest permissions — the capability baseline.
   * `undefined` = legacy plugin without a permissions field → permissive
   * (read-only ops allowed, write still prompts). A declared array is the
   * least-privilege baseline: read-only ops are denied without a dialog when
   * the matching permission is absent.
   */
  permissions?: string[]
}

/** Engines behind the plugin API — injectable for tests. */
export interface JsPluginProviders {
  root(): string | null
  readFile(abs: string): { content: string }
  writeFile(abs: string, content: string): void
  deleteFile(abs: string): void
  exists(abs: string): boolean
  listMd(): string[]
  search(query: string, limit: number): unknown[]
  graphNeighbors(nodeId: string): unknown
  graphBacklinks(nodeId: string): unknown
  listRules(): unknown
  runRule(id: string): { ok: boolean; error?: string }
  getSetting(key: string): unknown
  notify(message: string): void
}

export interface PermissionGate {
  /** Ask (or recall) whether the plugin may perform `op`. */
  check(plugin: JsPluginRuntimeInfo, op: string): Promise<boolean>
  revoke(pluginId: string): void
}

/** Session transport abstraction — real impl wraps worker_threads. */
export interface JsPluginSession {
  post(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): void
  onError(cb: (err: Error) => void): void
  terminate(): Promise<void>
}
export interface JsPluginTransport {
  start(workerData: unknown): JsPluginSession
}

export const DEFAULT_TIMEOUT_MS = 15_000

const OP_DETAILS: Record<string, string> = {
  'vault.write': 'menulis / mengubah file di vault',
  'vault.delete': 'menghapus file dari vault (pindah ke .trash)',
  'automation.runRule': 'menjalankan aturan automation'
}

// ─── Default providers (real engines) ──────────────────────────────────────

export const defaultProviders: JsPluginProviders = {
  root: () => workspaceEngine.getState().rootPath,
  readFile: (abs) => workspaceEngine.readFile(abs),
  writeFile: (abs, content) => workspaceEngine.writeFile(abs, content),
  deleteFile: (abs) => workspaceEngine.deleteFile(abs),
  exists: (abs) => fs.existsSync(abs),
  listMd: () => workspaceEngine.getAllMarkdownPaths(),
  search: (q, limit) => searchEngine.searchSync({ query: q, limit }),
  graphNeighbors: (id) => graphEngine.getNeighbors(id),
  graphBacklinks: (id) => graphEngine.getBacklinks(id),
  listRules: () => automationEngine.getConfig().rules,
  runRule: (id) => automationEngine.runManual(id),
  getSetting: (key) => {
    const scrubbed = scrubSettingsSecrets(workspaceEngine.getSettings())
    return scrubbed[key]
  },
  notify: (message) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('plugin:notify', { message })
    }
  }
}

// ─── Permission gate (dialog prompt + per-session grants) ──────────────────

type Grant = 'allow' | 'deny' | 'always'

export function createPermissionGate(): PermissionGate {
  const grants = new Map<string, Map<string, Grant>>()

  const decide = async (plugin: JsPluginRuntimeInfo, op: string): Promise<Grant> => {
    const opts = {
      type: 'question' as const,
      buttons: ['Tolak', 'Izinkan', 'Selalu izinkan'],
      defaultId: 1,
      cancelId: 0,
      title: 'Izin plugin',
      message: `Plugin "${plugin.pluginName}" meminta: ${OP_DETAILS[op] || op}`,
      detail:
        'Plugin berjalan di sandbox terisolasi. Operasi ini hanya diizinkan di dalam vault. ' +
        '"Selalu izinkan" berlaku untuk sesi ini.'
    }
    const wins = BrowserWindow.getAllWindows()
    const { response } =
      wins.length > 0
        ? await dialog.showMessageBox(wins[0], opts)
        : await dialog.showMessageBox(opts)
    if (response === 2) return 'always'
    if (response === 1) return 'allow'
    return 'deny'
  }

  return {
    async check(plugin, op) {
      const g = grants.get(plugin.pluginId)?.get(op)
      if (g === 'always' || g === 'allow') return true
      if (g === 'deny') return false
      const decision = await decide(plugin, op)
      if (!grants.has(plugin.pluginId)) grants.set(plugin.pluginId, new Map())
      grants.get(plugin.pluginId)!.set(op, decision)
      return decision !== 'deny'
    },
    revoke(pluginId) {
      grants.delete(pluginId)
    }
  }
}

export const defaultPermissionGate = createPermissionGate()

// ─── Privileged API executor ───────────────────────────────────────────────

/**
 * M1.5 (PLG-4): manifest permission required per op. A plugin that declares a
 * `permissions` array must declare the matching capability for an op to be
 * allowed at all — read-only ops are denied WITHOUT a dialog (declaration is
 * the baseline), write ops additionally keep the interactive dialog (execApi
 * still calls gate.check). `undefined` required = always allowed (settings.get,
 * ui.notify — non-sensitive).
 */
const OP_MANIFEST_PERM: Record<string, string | undefined> = {
  'vault.read': 'read',
  'vault.exists': 'read',
  'vault.list': 'read',
  'vault.write': 'read',
  'vault.delete': 'read',
  'search.query': 'search',
  'graph.getNeighbors': 'read',
  'graph.getBacklinks': 'read',
  'automation.listRules': 'automation',
  'automation.runRule': 'automation',
  'settings.get': undefined,
  'ui.notify': undefined
}

/** True when the plugin's declared permissions cover `op` (or it's legacy). */
function manifestAllows(plugin: JsPluginRuntimeInfo, op: string): boolean {
  const required = OP_MANIFEST_PERM[op]
  if (!required) return true
  const declared = plugin.permissions
  if (declared === undefined) return true // legacy: no declaration = permissive
  return declared.includes(required)
}

async function execApi(
  ns: string,
  method: string,
  callArgs: unknown[],
  plugin: JsPluginRuntimeInfo,
  providers: JsPluginProviders,
  gate: PermissionGate
): Promise<{ ok: boolean; value?: unknown }> {
  const op = `${ns}.${method}`
  try {
    const root = providers.root()
    if (!root) return { ok: false, value: { error: 'No workspace open' } }

    // M1.5 (PLG-4): enforce declared manifest permissions as the capability
    // baseline. A plugin that declares permissions: [] can no longer reach ANY
    // read/search/graph/automation op (no dialog for missing declarations) —
    // only settings.get / ui.notify (undefined-required) stay open.
    if (!manifestAllows(plugin, op)) {
      return {
        ok: false,
        value: {
          error: `Permission denied: ${op} (butuh permission "${OP_MANIFEST_PERM[op]}" di manifest)`
        }
      }
    }

    switch (op) {
      case 'vault.read': {
        const abs = resolveVaultRelative(String(callArgs[0] ?? ''), root)
        return { ok: true, value: providers.readFile(abs).content }
      }
      case 'vault.exists': {
        const abs = resolveVaultRelative(String(callArgs[0] ?? ''), root)
        return { ok: true, value: providers.exists(abs) }
      }
      case 'vault.list':
        return { ok: true, value: providers.listMd() }
      case 'vault.write': {
        if (!(await gate.check(plugin, op))) {
          return { ok: false, value: { error: `Permission denied: ${op}` } }
        }
        const abs = resolveVaultRelative(String(callArgs[0] ?? ''), root)
        providers.writeFile(abs, String(callArgs[1] ?? ''))
        return { ok: true, value: true }
      }
      case 'vault.delete': {
        if (!(await gate.check(plugin, op))) {
          return { ok: false, value: { error: `Permission denied: ${op}` } }
        }
        const abs = resolveVaultRelative(String(callArgs[0] ?? ''), root)
        providers.deleteFile(abs)
        return { ok: true, value: true }
      }
      case 'search.query': {
        const o = (callArgs[0] ?? {}) as { query?: string; limit?: number }
        return { ok: true, value: providers.search(String(o.query ?? ''), o.limit ?? 10) }
      }
      case 'graph.getNeighbors':
        return { ok: true, value: providers.graphNeighbors(String(callArgs[0] ?? '')) }
      case 'graph.getBacklinks':
        return { ok: true, value: providers.graphBacklinks(String(callArgs[0] ?? '')) }
      case 'automation.listRules':
        return { ok: true, value: providers.listRules() }
      case 'automation.runRule': {
        if (!(await gate.check(plugin, op))) {
          return { ok: false, value: { error: `Permission denied: ${op}` } }
        }
        const res = providers.runRule(String(callArgs[0] ?? ''))
        if (!res.ok) return { ok: false, value: { error: res.error || 'Rule failed' } }
        return { ok: true, value: true }
      }
      case 'settings.get':
        return { ok: true, value: providers.getSetting(String(callArgs[0] ?? '')) }
      case 'ui.notify':
        providers.notify(String(callArgs[0] ?? ''))
        return { ok: true, value: true }
      default:
        return { ok: false, value: { error: `Unknown plugin API: ${op}` } }
    }
  } catch (e) {
    return {
      ok: false,
      value: { error: e instanceof Error ? e.message : String(e) }
    }
  }
}

// ─── Worker transport ───────────────────────────────────────────────────────

function workerScriptPath(): string {
  // Bundled layout: out/main/workers/js-plugin.worker.js (electron-vite input key)
  const candidates = [
    path.join(__dirname, 'workers', 'js-plugin.worker.js'),
    path.join(__dirname, 'js-plugin.worker.js')
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return candidates[0]
}

export function createWorkerTransport(): JsPluginTransport {
  return {
    start(workerData) {
      const worker = new Worker(workerScriptPath(), { workerData })
      return {
        post: (msg) => worker.postMessage(msg),
        onMessage: (cb) => worker.on('message', cb),
        onError: (cb) => worker.on('error', cb),
        terminate: async () => {
          await worker.terminate()
        }
      }
    }
  }
}

// ─── Public entry ───────────────────────────────────────────────────────────

export async function runJsPluginCommand(
  plugin: JsPluginRuntimeInfo,
  handler: string,
  args: Record<string, unknown> = {},
  opts: {
    timeoutMs?: number
    transport?: JsPluginTransport
    providers?: JsPluginProviders
    gate?: PermissionGate
  } = {}
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const providers = opts.providers ?? defaultProviders
  const gate = opts.gate ?? defaultPermissionGate
  const transport = opts.transport ?? createWorkerTransport()

  const session = transport.start({
    entry: plugin.entry,
    handler,
    args,
    plugin: {
      id: plugin.pluginId,
      name: plugin.pluginName,
      version: plugin.version,
      dir: plugin.dir
    }
  })

  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    // terminate() can reject on an already-dead worker — never let that hang us
    const safeTerminate = async (): Promise<void> => {
      try {
        await session.terminate()
      } catch {
        /* worker already gone */
      }
    }
    const finish = (v: { ok: boolean; result?: unknown; error?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }

    const timer = setTimeout(() => {
      timedOut = true
      void safeTerminate().then(() => finish({ ok: false, error: 'Plugin timed out' }))
    }, timeoutMs)

    session.onMessage(async (raw) => {
      const msg = raw as {
        type?: string
        callId?: number
        ns?: string
        method?: string
        args?: unknown[]
        ok?: boolean
        result?: unknown
        error?: string
        text?: string
      }
      if (msg.type === 'api-call') {
        const res = await execApi(
          String(msg.ns),
          String(msg.method),
          msg.args ?? [],
          plugin,
          providers,
          gate
        )
        if (!timedOut)
          session.post({ type: 'api-result', callId: msg.callId, ok: res.ok, value: res.value })
      } else if (msg.type === 'log') {
        console.log(`[plugin:${plugin.pluginId}] ${msg.text ?? ''}`)
      } else if (msg.type === 'error') {
        void safeTerminate().then(() => finish({ ok: false, error: msg.error || 'Plugin failed' }))
      } else if (msg.type === 'done') {
        void safeTerminate().then(() =>
          finish(
            msg.ok
              ? { ok: true, result: msg.result }
              : { ok: false, error: msg.error || 'Plugin failed' }
          )
        )
      }
    })
    session.onError((err) => {
      void safeTerminate().then(() => finish({ ok: false, error: err.message }))
    })
  })
}
