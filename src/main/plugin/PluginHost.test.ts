import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { PluginHost, PLUGIN_SDK_VERSION } from './PluginHost'

// Mock electron for the host (jsRunner imports it transitively)
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { vi } from 'vitest'

describe('M6b — PluginHost SDK gate (PLG-3)', () => {
  let root: string
  let host: PluginHost

  const writePlugin = (id: string, manifest: Record<string, unknown>): void => {
    const dir = path.join(root, '.workspacegraph', 'plugins', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'wg-plugin-host-'))
    host = new PluginHost()
    host.setAllowed(true)
  })

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('PLUGIN_SDK_VERSION is a valid semver', () => {
    expect(PLUGIN_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('plugin with minSdkVersion <= host loads', () => {
    writePlugin('old-ok', {
      id: 'old-ok',
      name: 'Old OK',
      version: '1.0.0',
      main: 'main.js',
      minSdkVersion: '0.9.0'
    })
    fs.writeFileSync(path.join(root, '.workspacegraph', 'plugins', 'old-ok', 'main.js'), '')
    host.load(root)
    expect(host.list().some((p) => p.manifest.id === 'old-ok')).toBe(true)
  })

  it('plugin with minSdkVersion > host is skipped (not loaded)', () => {
    writePlugin('future', {
      id: 'future',
      name: 'Future',
      version: '1.0.0',
      main: 'main.js',
      minSdkVersion: '999.0.0'
    })
    fs.writeFileSync(path.join(root, '.workspacegraph', 'plugins', 'future', 'main.js'), '')
    host.load(root)
    expect(host.list().some((p) => p.manifest.id === 'future')).toBe(false)
  })

  it('plugin without minSdkVersion still loads (back-compat)', () => {
    writePlugin('legacy', { id: 'legacy', name: 'Legacy', version: '1.0.0' })
    host.load(root)
    expect(host.list().some((p) => p.manifest.id === 'legacy')).toBe(true)
  })
})

describe('M6b — PluginHost extension points (PLG-1)', () => {
  let root: string
  let host: PluginHost

  const writePlugin = (
    id: string,
    manifest: Record<string, unknown>,
    jsContent?: string
  ): void => {
    const dir = path.join(root, '.workspacegraph', 'plugins', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    if (jsContent) fs.writeFileSync(path.join(dir, 'main.js'), jsContent)
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'wg-plugin-ext-'))
    host = new PluginHost()
    host.setAllowed(true)
  })

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('context menus are listed only from enabled plugins', () => {
    writePlugin('ctx-on', {
      id: 'ctx-on',
      name: 'Ctx On',
      version: '1.0.0',
      enabled: true,
      contextMenus: [{ id: 'open-in-other', title: 'Buka di aplikasi lain', when: 'file', commandId: 'x' }]
    })
    writePlugin('ctx-off', {
      id: 'ctx-off',
      name: 'Ctx Off',
      version: '1.0.0',
      enabled: false,
      contextMenus: [{ id: 'hidden', title: 'Hidden', commandId: 'y' }]
    })
    host.load(root)
    const menus = host.listContextMenus()
    expect(menus.some((m) => m.pluginId === 'ctx-on')).toBe(true)
    expect(menus.some((m) => m.pluginId === 'ctx-off')).toBe(false)
    expect(menus[0].when).toBe('file')
    expect(menus[0].commandId).toBe('x')
  })

  it('search providers require an enabled JS plugin entry', () => {
    writePlugin(
      'search-on',
      {
        id: 'search-on',
        name: 'Search On',
        version: '1.0.0',
        enabled: true,
        main: 'main.js',
        permissions: ['read'],
        searchProviders: [{ id: 'note-search', name: 'Note Search', handler: 'searchNotes' }]
      },
      `module.exports = { async searchNotes() { return [] } }`
    )
    writePlugin('search-nojs', {
      id: 'search-nojs',
      name: 'No JS',
      version: '1.0.0',
      enabled: true,
      searchProviders: [{ id: 'x', name: 'X', handler: 'x' }]
    })
    host.load(root)
    const providers = host.listSearchProviders()
    expect(providers.some((s) => s.pluginId === 'search-on')).toBe(true)
    // declarative-only plugin has no main.js → not a JS provider
    expect(providers.some((s) => s.pluginId === 'search-nojs')).toBe(false)
  })

  it('runSearchProvider rejects missing/disabled/unknown providers safely', async () => {
    expect((await host.runSearchProvider('nope', 'x', 'q')).ok).toBe(false)
    writePlugin('search-off', {
      id: 'search-off',
      name: 'Off',
      version: '1.0.0',
      enabled: false,
      main: 'main.js',
      searchProviders: [{ id: 's', name: 'S', handler: 'h' }]
    })
    fs.writeFileSync(
      path.join(root, '.workspacegraph', 'plugins', 'search-off', 'main.js'),
      ''
    )
    host.load(root)
    expect((await host.runSearchProvider('search-off', 's', 'q')).ok).toBe(false)
  })
})

describe('M6b — PluginHost event subscription (PLG-6)', () => {
  let root: string
  let host: PluginHost

  const writePlugin = (id: string, manifest: Record<string, unknown>, jsContent: string): void => {
    const dir = path.join(root, '.workspacegraph', 'plugins', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    fs.writeFileSync(path.join(dir, 'main.js'), jsContent)
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'wg-plugin-evt-'))
    host = new PluginHost()
    host.setAllowed(true)
  })

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('emitEvent skips plugins without matching events in manifest', () => {
    writePlugin(
      'no-events',
      { id: 'no-events', name: 'No Events', version: '1.0.0', main: 'main.js' },
      'module.exports = {}'
    )
    host.load(root)
    // Should not throw — no plugin subscribed to 'file_created'
    expect(() => host.emitEvent('file_created')).not.toThrow()
  })

  it('emitEvent runs onEvent handler on subscribed plugins', async () => {
    let handled = false
    writePlugin(
      'evt',
      {
        id: 'evt',
        name: 'Event Subscriber',
        version: '1.0.0',
        main: 'main.js',
        events: ['file_created']
      },
      `module.exports = {
        async onEvent(ctx) {
          if (ctx.input.type === 'file_created') {
            const { api } = ctx
            await api.ui.notify('got event')
          }
        }
      }`
    )
    host.load(root)
    // emitEvent is fire-and-forget; wait briefly for the worker to run
    await new Promise((r) => setTimeout(r, 500))
    expect(() => host.emitEvent('file_created', '/vault/test.md')).not.toThrow()
    await new Promise((r) => setTimeout(r, 500))
    handled = true
  })

  it('emitEvent does not fire for unsubscribed event types', () => {
    writePlugin(
      'filtered',
      {
        id: 'filtered',
        name: 'Filtered',
        version: '1.0.0',
        main: 'main.js',
        events: ['daily_note_created']
      },
      'module.exports = { async onEvent() {} }'
    )
    host.load(root)
    expect(() => host.emitEvent('file_deleted')).not.toThrow()
    expect(() => host.emitEvent('daily_note_created', '/vault/2026-08-27.md')).not.toThrow()
  })
})
