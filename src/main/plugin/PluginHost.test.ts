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
