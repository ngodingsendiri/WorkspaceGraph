import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { dialog } from 'electron'

vi.mock('electron', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory is hoisted above imports, so ESM import is unavailable here
  const { tmpdir } = require('os')
  return {
    app: { getPath: () => tmpdir() },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
    BrowserWindow: { getAllWindows: () => [] },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8')
    },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    nativeTheme: { shouldUseDarkColors: false, on: () => {} }
  }
})

import {
  runJsPluginCommand,
  defaultPermissionGate,
  createPermissionGate,
  type JsPluginProviders,
  type JsPluginTransport,
  type PermissionGate,
  type JsPluginRuntimeInfo
} from './jsRunner'
import { executePluginModule } from './sandbox'
import { createPluginRuntime } from './runtime'

function tmpVault(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'wg-test-plugin-'))
}

function makePlugin(root: string, code: string, name = 'main.js'): JsPluginRuntimeInfo {
  const entry = path.join(root, name)
  fs.writeFileSync(entry, code, 'utf-8')
  return { pluginId: 'test-plugin', pluginName: 'Test Plugin', version: '1.0.0', dir: root, entry }
}

function fakeProviders(root: string): JsPluginProviders {
  return {
    root: () => root,
    readFile: (abs) => ({ content: fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '' }),
    writeFile: (abs, c) => fs.writeFileSync(abs, c),
    deleteFile: (abs) => fs.rmSync(abs, { force: true }),
    exists: (abs) => fs.existsSync(abs),
    listMd: () => ['A.md', 'B.md'],
    search: () => [{ title: 'hit' }],
    graphNeighbors: () => ({ nodes: [] }),
    graphBacklinks: () => ({ nodes: [] }),
    listRules: () => [{ id: 'r1' }],
    runRule: () => ({ ok: true }),
    getSetting: () => 'dark',
    notify: () => {}
  }
}

function fakeGate(calls: string[] = [], decision = true): PermissionGate {
  return {
    check: async (_p, op) => {
      calls.push(op)
      return decision
    },
    revoke: () => {}
  }
}

/** In-process transport: runs the real runtime (sandbox + bridge) on this thread. */
function inProcessTransport(): JsPluginTransport {
  return {
    start(workerData) {
      const { entry, handler, args, plugin } = workerData as {
        entry: string
        handler: string
        args: Record<string, unknown>
        plugin?: { id: string; name: string; version?: string; dir: string }
      }
      let runtimeCb: ((m: unknown) => void) | null = null
      let sessionCb: ((m: unknown) => void) | null = null
      createPluginRuntime({
        entry,
        handler,
        args,
        plugin,
        transport: {
          post: (m) => queueMicrotask(() => sessionCb?.(m)),
          onMessage: (cb) => {
            runtimeCb = cb
          }
        }
      })
      return {
        post: (m) => queueMicrotask(() => runtimeCb?.(m)),
        onMessage: (cb) => {
          sessionCb = cb
        },
        onError: () => {},
        terminate: async () => {}
      }
    }
  }
}

function hangingTransport(): JsPluginTransport {
  return {
    start: () => ({
      post: () => {},
      onMessage: () => {},
      onError: () => {},
      terminate: async () => {}
    })
  }
}

const noopApi = async (): Promise<unknown> => undefined

describe('sandbox (vm)', () => {
  it('executes a CommonJS module and returns its exports', () => {
    const mod = executePluginModule(
      'module.exports = { add: (a, b) => a + b, label: "hi" }',
      'p/main.js',
      noopApi
    )
    expect(mod.exports.label).toBe('hi')
    expect(typeof mod.exports.add).toBe('function')
  })

  it('blocks require, process, and Buffer; constructor escape cannot reach node globals', () => {
    const mod = executePluginModule(
      `module.exports = {
        probe() {
          const r = {}
          r.requireType = typeof require
          r.processType = typeof process
          r.bufferType = typeof Buffer
          try { ({}).constructor.constructor('return process')() ; r.escap = 'LEAKED' }
          catch (e) { r.escap = 'blocked' }
          return r
        }
      }`,
      'p/main.js',
      noopApi
    )
    const out = (mod.exports.probe as () => Record<string, string>)()
    expect(out.requireType).toBe('undefined')
    expect(out.processType).toBe('undefined')
    expect(out.bufferType).toBe('undefined')
    expect(out.escap).toBe('blocked')
  })

  it('host builtins cannot reach node globals (constructor escape on Promise/console blocked)', () => {
    const mod = executePluginModule(
      `module.exports = {
        probe() {
          const r = {}
          try { Promise.constructor('return process')() ; r.promise = 'LEAKED' }
          catch (e) { r.promise = 'blocked' }
          try { console.log.constructor('return process')() ; r.console = 'LEAKED' }
          catch (e) { r.console = 'blocked' }
          r.setTimeoutType = typeof setTimeout
          r.requireType = typeof require
          r.processType = typeof process
          return r
        }
      }`,
      'p/main.js',
      noopApi
    )
    const out = (mod.exports.probe as () => Record<string, string>)()
    expect(out.promise).toBe('blocked')
    expect(out.console).toBe('blocked')
    expect(out.setTimeoutType).toBe('undefined')
    expect(out.requireType).toBe('undefined')
    expect(out.processType).toBe('undefined')
  })

  it('realm globals (module/exports/api/bridge promise) cannot reach node globals', () => {
    const mod = executePluginModule(
      `module.exports = {
        probe() {
          const r = {}
          const p = () => {
            try { module.constructor.constructor('return process')() ; return 'LEAKED' }
            catch (e) { return 'blocked' }
          }
          const e = () => {
            try { exports.constructor.constructor('return process')() ; return 'LEAKED' }
            catch (e) { return 'blocked' }
          }
          const a = () => {
            try { api.constructor.constructor.constructor('return process')() ; return 'LEAKED' }
            catch (e) { return 'blocked' }
          }
          const pr = () => {
            try { api.vault.read('A').constructor.constructor('return process')() ; return 'LEAKED' }
            catch (e) { return 'blocked' }
          }
          r.module = p(); r.exports = e(); r.api = a(); r.promise = pr()
          return r
        }
      }`,
      'p/main.js',
      noopApi
    )
    const out = (mod.exports.probe as () => Record<string, string>)()
    expect(out.module).toBe('blocked')
    expect(out.exports).toBe('blocked')
    expect(out.api).toBe('blocked')
    expect(out.promise).toBe('blocked')
  })

  it('forwards console output through the log sink', () => {
    const logs: string[] = []
    const mod = executePluginModule(
      'module.exports = { go: () => { console.log("hello", 42) } }',
      'p/main.js',
      noopApi,
      { forwardLog: (t) => logs.push(t) }
    )
    ;(mod.exports.go as () => void)()
    expect(logs.join(' ')).toContain('hello 42')
  })

  it('times out on a top-level synchronous infinite loop', () => {
    expect(() =>
      executePluginModule('while (true) {}', 'p/main.js', noopApi, { timeoutMs: 100 })
    ).toThrow(/timed out/i)
  })

  it('callHandler provides a realm-safe ctx with api attached', async () => {
    const mod = executePluginModule(
      `module.exports = { go: async (ctx) => {
        const leak = () => {
          try { ctx.constructor.constructor('return process')() ; return 'LEAKED' }
          catch (e) { return 'blocked' }
        }
        return { name: ctx.plugin.name, leak: leak(), apiType: typeof ctx.api.vault.read }
      } }`,
      'p/main.js',
      noopApi
    )
    const out = (await mod.callHandler('go', { args: {}, plugin: { name: 'X' } })) as Record<
      string,
      unknown
    >
    expect(out.name).toBe('X')
    expect(out.leak).toBe('blocked')
    expect(out.apiType).toBe('function')
  })
})

describe('JS plugin runner (permissions + bridge)', () => {
  let root: string

  beforeEach(() => {
    root = tmpVault()
  })
  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('returns the handler result', async () => {
    const plugin = makePlugin(root, 'module.exports = { main: async () => ({ n: 42 }) }')
    const res = await runJsPluginCommand(
      plugin,
      'main',
      {},
      { transport: inProcessTransport(), providers: fakeProviders(root), gate: fakeGate() }
    )
    expect(res.ok).toBe(true)
    expect(res.result).toEqual({ n: 42 })
  })

  it('passes plugin metadata into ctx.plugin', async () => {
    const plugin = makePlugin(root, 'module.exports = { main: async (ctx) => ctx.plugin }')
    const res = await runJsPluginCommand(
      plugin,
      'main',
      {},
      {
        transport: inProcessTransport(),
        providers: fakeProviders(root),
        gate: fakeGate()
      }
    )
    expect(res.result).toEqual({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      dir: root
    })
  })

  it('read ops are auto-allowed (no permission prompt)', async () => {
    fs.writeFileSync(path.join(root, 'A.md'), '# Hello World')
    const plugin = makePlugin(
      root,
      'module.exports = { main: async (ctx) => ctx.api.vault.read("A.md") }'
    )
    const calls: string[] = []
    const res = await runJsPluginCommand(
      plugin,
      'main',
      {},
      {
        transport: inProcessTransport(),
        providers: fakeProviders(root),
        gate: fakeGate(calls)
      }
    )
    expect(res.ok).toBe(true)
    expect(res.result).toContain('# Hello World')
    expect(calls).toHaveLength(0) // read op → no permission prompt
  })

  it('write ops prompt for permission; deny surfaces as plugin error', async () => {
    const plugin = makePlugin(
      root,
      `module.exports = { main: async (ctx) => {
        try { await ctx.api.vault.write('out.md', 'data'); return 'allowed' }
        catch (e) { return 'denied:' + e.message }
      } }`
    )
    const calls: string[] = []
    const res = await runJsPluginCommand(
      plugin,
      'main',
      {},
      {
        transport: inProcessTransport(),
        providers: fakeProviders(root),
        gate: fakeGate(calls, false)
      }
    )
    expect(res.ok).toBe(true)
    expect(res.result).toBe('denied:Permission denied: vault.write')
    expect(calls).toContain('vault.write')
    expect(fs.existsSync(path.join(root, 'out.md'))).toBe(false)
  })

  it('write ops actually write when allowed', async () => {
    const plugin = makePlugin(
      root,
      'module.exports = { main: async (ctx) => { await ctx.api.vault.write("out.md", "data"); return "written" } }'
    )
    const res = await runJsPluginCommand(
      plugin,
      'main',
      {},
      {
        transport: inProcessTransport(),
        providers: fakeProviders(root),
        gate: fakeGate()
      }
    )
    expect(res.ok).toBe(true)
    expect(res.result).toBe('written')
    expect(fs.readFileSync(path.join(root, 'out.md'), 'utf-8')).toBe('data')
  })

  it('blocks paths that escape the vault', async () => {
    const plugin = makePlugin(
      root,
      `module.exports = { main: async (ctx) => {
        try { await ctx.api.vault.read('../escape.md'); return 'LEAKED' }
        catch (e) { return 'BLOCKED' }
      } }`
    )
    const res = await runJsPluginCommand(
      plugin,
      'main',
      {},
      {
        transport: inProcessTransport(),
        providers: fakeProviders(root),
        gate: fakeGate()
      }
    )
    expect(res.result).toBe('BLOCKED')
  })

  it('reports plugin exceptions', async () => {
    const plugin = makePlugin(
      root,
      'module.exports = { main: async () => { throw new Error("kaboom") } }'
    )
    const res = await runJsPluginCommand(
      plugin,
      'main',
      {},
      {
        transport: inProcessTransport(),
        providers: fakeProviders(root),
        gate: fakeGate()
      }
    )
    expect(res.ok).toBe(false)
    expect(res.error).toBe('kaboom')
  })

  it('reports missing handler', async () => {
    const plugin = makePlugin(root, 'module.exports = {}')
    const res = await runJsPluginCommand(
      plugin,
      'nope',
      {},
      {
        transport: inProcessTransport(),
        providers: fakeProviders(root),
        gate: fakeGate()
      }
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not exported/)
  })

  it('times out async hangs and terminates the worker', async () => {
    const plugin = makePlugin(
      root,
      'module.exports = { main: async () => await new Promise(() => {}) }'
    )
    const res = await runJsPluginCommand(
      plugin,
      'main',
      {},
      {
        timeoutMs: 60,
        transport: inProcessTransport(),
        providers: fakeProviders(root),
        gate: fakeGate()
      }
    )
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Plugin timed out')
  })

  it('times out when the worker never responds', async () => {
    const plugin = makePlugin(root, 'module.exports = { main: async () => 1 }')
    const res = await runJsPluginCommand(
      plugin,
      'main',
      {},
      {
        timeoutMs: 60,
        transport: hangingTransport(),
        providers: fakeProviders(root),
        gate: fakeGate()
      }
    )
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Plugin timed out')
  })
})

describe('default permission gate (dialog)', () => {
  beforeEach(() => {
    vi.mocked(dialog.showMessageBox).mockReset()
  })

  const plugin = (): JsPluginRuntimeInfo => ({
    pluginId: 'p1',
    pluginName: 'GateTest',
    dir: '/vault',
    entry: '/vault/main.js'
  })

  it('"always" is remembered for the session; other ops still prompt', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 2 } as never)
    const gate = createPermissionGate()
    expect(await gate.check(plugin(), 'vault.write')).toBe(true)
    expect(await gate.check(plugin(), 'vault.write')).toBe(true)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)

    // Different write op → prompts again
    await gate.check(plugin(), 'vault.delete')
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)

    // revoke → prompts again for the first op
    gate.revoke('p1')
    await gate.check(plugin(), 'vault.write')
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(3)
  })

  it('"deny" blocks the op and is remembered', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0 } as never)
    const gate = createPermissionGate()
    expect(await gate.check(plugin(), 'vault.write')).toBe(false)
    expect(await gate.check(plugin(), 'vault.write')).toBe(false)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('default gate instance works end-to-end through the runner', async () => {
    const root = tmpVault()
    try {
      vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1 } as never)
      const entry = path.join(root, 'main.js')
      fs.writeFileSync(
        entry,
        'module.exports = { main: async (ctx) => ctx.api.vault.write("a.md", "x") }'
      )
      const plugin = { pluginId: 'p1', pluginName: 'E2E', dir: root, entry }
      const res = await runJsPluginCommand(
        plugin,
        'main',
        {},
        {
          transport: inProcessTransport(),
          providers: fakeProviders(root),
          gate: defaultPermissionGate
        }
      )
      expect(res.ok).toBe(true)
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
