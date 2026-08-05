/**
 * Behavioral IPC end-to-end test.
 *
 * The old qa-api-sequential.mjs (which drove real main-process handlers) was
 * dropped during the vitest migration — leaving ~80 ipcMain channels covered
 * only by per-engine unit tests. This file restores that safety net: it
 * registers the REAL handler modules against a capture-only ipcMain mock, then
 * invokes them in sequence like the renderer would (file → search → chat),
 * asserting the full main-process chain end to end.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'

/**
 * Capture ipcMain.handle registrations. The mock object is created inside
 * vi.hoisted (no import bindings available there) and shared with the test
 * body via the returned references.
 */
const state = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers,
    electronMock: {
      app: {
        // WorkspaceEngine resolves userData at CONSTRUCTION (import time), so
        // this must be a fixed non-null path — recent.json lands here and is
        // cleaned up in afterAll.
        getPath: (name: string) => (name === 'userData' ? '/tmp/wg-e2e-userdata' : '/mock/path')
      },
      ipcMain: {
        handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
          handlers.set(channel, fn)
        },
        on: () => undefined,
        removeHandler: () => undefined
      },
      BrowserWindow: {
        getAllWindows: () => [],
        fromWebContents: () => null
      },
      shell: { openPath: async () => '', openExternal: async () => {} },
      nativeTheme: { shouldUseDarkColors: false },
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true, filePath: '' })
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(`enc:${s}`),
        decryptString: (b: Buffer) => b.toString().replace('enc:', '')
      }
    }
  }
})

vi.mock('electron', () => state.electronMock)

import { registerFileHandlers } from '../ipc/handlers/files'
import { registerChatHandlers } from '../ipc/handlers/chat'
import { registerSearchHandlers } from '../ipc/handlers/search'
import { registerWorkspaceHandlers } from '../ipc/handlers/workspace'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { indexDatabase } from '../engine/IndexDatabase'

/** Invoke a registered handler exactly like ipcRenderer.invoke would. */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = state.handlers.get(channel)
  if (!fn) throw new Error(`IPC handler not registered: ${channel}`)
  return await (fn as (...a: unknown[]) => unknown)({}, ...args)
}

describe('IPC handlers end-to-end', () => {
  let vault: string

  beforeAll(() => {
    vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-e2e-vault-'))
    registerFileHandlers()
    registerChatHandlers()
    registerSearchHandlers()
    registerWorkspaceHandlers()
    workspaceEngine.openWorkspace(vault)
    indexDatabase.open(vault)
  })

  afterAll(() => {
    try {
      workspaceEngine.closeWorkspace()
    } catch {
      /* ignore */
    }
    try {
      indexDatabase.close()
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync('/tmp/wg-e2e-userdata', { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('workspace:getState reflects the opened vault', async () => {
    const st = (await invoke('workspace:getState')) as { rootPath: string | null }
    expect(st.rootPath).toBe(path.resolve(vault))
  })

  it('file:create → file:read round-trip through the real handler chain', async () => {
    const p = path.join(vault, 'Apollo.md')
    await invoke('file:create', {
      filePath: p,
      content: '# Apollo\n\nMisi pendaratan bulan pertama.'
    })
    expect(fs.existsSync(p)).toBe(true)
    const read = (await invoke('file:read', p)) as { title: string; content: string }
    expect(read.title).toBe('Apollo')
    expect(read.content).toContain('pendaratan')
  })

  it('file:write detects mtime conflict (MergeDialog path)', async () => {
    const p = path.join(vault, 'Apollo.md')
    const ok = (await invoke('file:write', {
      filePath: p,
      content: '# Apollo\n\nDiperbarui.',
      expectedMtime: fs.statSync(p).mtimeMs
    })) as { conflict: boolean }
    expect(ok.conflict).toBe(false)
    expect(fs.readFileSync(p, 'utf-8')).toContain('Diperbarui')

    // Stale mtime → conflict with both versions returned, file untouched
    const stale = (await invoke('file:write', {
      filePath: p,
      content: '# Apollo\n\nVersi lain.',
      expectedMtime: 1
    })) as { conflict: boolean; theirs: string; yours: string }
    expect(stale.conflict).toBe(true)
    expect(stale.theirs).toContain('Diperbarui')
    expect(stale.yours).toContain('Versi lain')
    expect(fs.readFileSync(p, 'utf-8')).toContain('Diperbarui')
  })

  it('markdown:render escapes raw HTML', async () => {
    const html = (await invoke('markdown:render', '<script>x</script>')) as string
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('search:query finds a note written via handlers (self-contained)', async () => {
    // Own note + unique term — no dependency on other tests' mutations.
    const p = path.join(vault, 'Rocket.md')
    await invoke('file:create', {
      filePath: p,
      content: '# Rocket\n\nMesin roket bertenaga nuklir.'
    })
    const results = (await invoke('search:query', { query: 'nuklir', limit: 10 })) as Array<{
      path: string
    }>
    expect(Array.isArray(results)).toBe(true)
    expect(results.some((r) => r.path.replace(/\\/g, '/').endsWith('Rocket.md'))).toBe(true)
  })

  it('chat:newId → chat:save → chat:list → chat:load → chat:delete lifecycle', async () => {
    const id = (await invoke('chat:newId')) as string
    expect(typeof id).toBe('string')
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/)

    const saved = (await invoke('chat:save', {
      id,
      title: 'E2E',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      agentRole: 'general',
      messages: [{ id: 'm1', role: 'user', content: 'halo', timestamp: '12:00' }]
    })) as { ok: boolean }
    expect(saved.ok).toBe(true)

    const list = (await invoke('chat:list')) as Array<{ id: string }>
    expect(list.some((c) => c.id === id)).toBe(true)

    const loaded = (await invoke('chat:load', id)) as {
      messages: Array<{ content: string }>
    } | null
    expect(loaded?.messages[0]?.content).toBe('halo')

    const del = (await invoke('chat:delete', id)) as { ok: boolean }
    expect(del.ok).toBe(true)
    expect(await invoke('chat:load', id)).toBeNull()
  })

  it('path sandbox rejects reads/writes outside the vault', async () => {
    const outside = path.join(tmpdir(), `wg-e2e-outside-${Date.now()}.md`)
    fs.writeFileSync(outside, 'x')
    try {
      await expect(invoke('file:read', outside)).rejects.toThrow()
      await expect(invoke('file:write', { filePath: outside, content: 'x' })).rejects.toThrow()
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })
})
