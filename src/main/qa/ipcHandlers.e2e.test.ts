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
  // WorkspaceEngine resolves userData at CONSTRUCTION (import time), so the
  // path must be computable HERE (hoisted, before any import binding exists —
  // no fs/path/os available). A timestamp + random suffix makes it unique per
  // run: two e2e runs can never share settings.json/recent.json, so a second
  // e2e file added later stays isolated. The engine mkdirs the dir itself on
  // construction; afterAll removes it via state.userDataDir.
  const userDataDir = `/tmp/wg-e2e-userdata-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    handlers,
    userDataDir,
    electronMock: {
      app: {
        getPath: (name: string) => (name === 'userData' ? userDataDir : '/mock/path')
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
import { registerCheckpointHandlers } from '../ipc/handlers/checkpoint'
import { registerSearchHandlers } from '../ipc/handlers/search'
import { registerWorkspaceHandlers } from '../ipc/handlers/workspace'
import { registerAIHandlers } from '../ipc/handlers/ai'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { indexDatabase } from '../engine/IndexDatabase'
import { readProviderDefs } from '../ai/providerRegistry'

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
    registerCheckpointHandlers()
    registerSearchHandlers()
    registerWorkspaceHandlers()
    registerAIHandlers()
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
      fs.rmSync(state.userDataDir, { recursive: true, force: true })
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

  it('checkpoint:save → checkpoint:list → checkpoint:load → checkpoint:delete lifecycle (R2-2)', async () => {
    const cp = {
      id: '20260807_120000_abcd_m1',
      conversationId: '20260807_120000_abcd',
      messageId: 'm1',
      messageIndex: 3,
      round: 2,
      contextTokens: 1240,
      model: 'grok-4.5',
      agentRole: 'general',
      useContext: true,
      enableTools: true,
      planMode: false,
      reason: 'cancelled',
      timestamp: new Date().toISOString()
    }

    const saved = (await invoke('checkpoint:save', cp)) as { ok: boolean; path?: string }
    expect(saved.ok).toBe(true)
    expect(fs.existsSync(saved.path || '')).toBe(true)
    expect(fs.existsSync(path.join(vault, '.workspacegraph', 'checkpoints', `${cp.id}.json`))).toBe(
      true
    )

    const list = (await invoke('checkpoint:list')) as Array<{ id: string }>
    expect(list.some((c) => c.id === cp.id)).toBe(true)

    const loaded = (await invoke('checkpoint:load', cp.id)) as {
      round: number
      messageIndex: number
    }
    expect(loaded?.round).toBe(2)
    expect(loaded?.messageIndex).toBe(3)

    // Path-traversal id never touches the filesystem
    expect(
      ((await invoke('checkpoint:save', { ...cp, id: '../evil' })) as { ok: boolean }).ok
    ).toBe(false)

    const del = (await invoke('checkpoint:delete', cp.id)) as { ok: boolean }
    expect(del.ok).toBe(true)
    expect(await invoke('checkpoint:load', cp.id)).toBeNull()
  })

  it('dynamic provider registry: get configs → add custom → delete → key cleanup (R2-4)', async () => {
    // Seeds: nothing saved yet → the classic six built-ins as data
    const initial = (await invoke('ai:getProviderConfigs')) as { defs: any[] }
    expect(initial.defs.map((d: { id: string }) => d.id)).toEqual([
      'grok',
      'gemini',
      'openai',
      'claude',
      'ollama',
      'openrouter'
    ])

    // Stash a key for a provider that is about to be deleted — save must drop it
    const settings = workspaceEngine.getSettings() as Record<string, unknown>
    settings.ai = { grok: { apiKey: 'sk-test-delete-me', baseUrl: 'https://api.x.ai/v1' } }
    settings.activeProvider = 'grok'
    workspaceEngine.saveSettings(settings)

    // Add a custom OpenAI-compatible provider + delete grok in one save
    const custom = {
      id: 'my-mistral',
      name: 'My Mistral',
      kind: 'openai-compat',
      baseUrl: 'https://api.mistral.ai/v1',
      defaultModel: 'mistral-large'
    }
    const saved = (await invoke('ai:saveProviderConfigs', [
      custom,
      ...initial.defs.filter((d: { id: string }) => d.id !== 'grok')
    ])) as { ok: boolean; defs?: any[] }
    expect(saved.ok).toBe(true)
    expect(saved.defs?.map((d) => d.id)).toEqual([
      'my-mistral',
      'gemini',
      'openai',
      'claude',
      'ollama',
      'openrouter'
    ])

    // Persisted + the deleted provider's key is gone; active fell back off grok
    const after = (await invoke('ai:getProviderConfigs')) as { defs: any[] }
    expect(after.defs.map((d: { id: string }) => d.id)).toContain('my-mistral')
    const persisted = workspaceEngine.getSettings() as Record<string, unknown>
    const persistedAi = (persisted.ai as Record<string, unknown>) || {}
    expect(persistedAi.grok).toBeUndefined()
    expect(persisted.activeProvider).not.toBe('grok')

    // Delete the custom provider too → list shrinks, no orphan key
    const del = (await invoke('ai:saveProviderConfigs', [
      ...after.defs.filter((d: { id: string }) => d.id !== 'my-mistral')
    ])) as { ok: boolean; defs?: any[] }
    expect(del.ok).toBe(true)
    expect(del.defs?.some((d: { id: string }) => d.id === 'my-mistral')).toBe(false)
    const finalSettings = workspaceEngine.getSettings() as Record<string, unknown>
    const finalAi = (finalSettings.ai as Record<string, unknown>) || {}
    expect(finalAi['my-mistral']).toBeUndefined()
  })

  it('full provider flow: colliding name → key on grok-2, baseUrl edit applies live, delete-all survives restart (R2-4)', async () => {
    // Self-contained: reset to a clean slate (no saved defs → seeds)
    const reset = workspaceEngine.getSettings() as Record<string, unknown>
    reset.aiProviders = undefined
    delete reset.ai
    reset.activeProvider = 'grok'
    workspaceEngine.saveSettings(reset)

    // 1. Baseline: nothing saved → the six built-in seeds as data
    const initial = (await invoke('ai:getProviderConfigs')) as { defs: any[] }
    expect(initial.defs.map((d: { id: string }) => d.id)).toEqual([
      'grok',
      'gemini',
      'openai',
      'claude',
      'ollama',
      'openrouter'
    ])

    // 2. UI adds a CUSTOM provider named "Grok" — collides with the builtin id.
    // The UI appends new rows after the existing defs ([...defs, newDef]).
    const add = (await invoke('ai:saveProviderConfigs', [
      ...initial.defs,
      { id: 'grok', name: 'Grok', kind: 'openai-compat', baseUrl: 'https://grok.local/v1' }
    ])) as { ok: boolean; defs?: any[] }
    expect(add.ok).toBe(true)
    const custom = add.defs?.find((d) => d.kind === 'openai-compat')
    // The server dedupes: the custom row must NOT steal the builtin 'grok' id
    expect(custom?.id).toBe('grok-2')
    expect(add.defs?.filter((d) => d.id === 'grok')).toHaveLength(1) // builtin grok intact

    // 3. UI configures the key against the FINAL server id — never the builtin
    const cfg = (await invoke('ai:configure', {
      providerId: 'grok-2',
      apiKey: 'sk-collision-test',
      baseUrl: 'https://grok.local/v1'
    })) as { ok: boolean }
    expect(cfg.ok).toBe(true)
    const s1 = workspaceEngine.getSettings() as Record<string, any>
    expect(s1.ai?.['grok-2']?.apiKey).toBe('sk-collision-test')
    expect(s1.ai?.['grok']).toBeUndefined() // key never leaked into the builtin

    // 4. UI edits the base URL only (no key re-typed) and saves the row
    const edit = (await invoke('ai:saveProviderConfigs', [
      ...add.defs!.map((d) =>
        d.id === 'grok-2' ? { ...d, baseUrl: 'https://grok-new.local/v1' } : d
      )
    ])) as { ok: boolean }
    expect(edit.ok).toBe(true)
    const s2 = workspaceEngine.getSettings() as Record<string, any>
    // The def holds the new URL...
    const def2 = s2.aiProviders.find((d: { id: string }) => d.id === 'grok-2')
    expect(def2?.baseUrl).toBe('https://grok-new.local/v1')
    // ...and the key entry must follow, or loadSettingsIntoProviders would
    // re-apply the STALE url onto the live provider until the next restart
    expect(s2.ai?.['grok-2']?.baseUrl).toBe('https://grok-new.local/v1')

    // 5. Delete ALL providers — explicit empty must persist (no seed resurrection)
    const del = (await invoke('ai:saveProviderConfigs', [])) as { ok: boolean; defs?: any[] }
    expect(del.ok).toBe(true)
    expect(del.defs).toEqual([])
    const s3 = workspaceEngine.getSettings() as Record<string, unknown>
    expect(s3.aiProviders).toEqual([])
    expect(s3.ai).toBeUndefined() // every saved key wiped
    // "Restart": readProviderDefs honors the explicitly-saved empty list
    expect(readProviderDefs(s3)).toEqual([])

    // 6. Reset ke provider bawaan — the six seeds come back (special adapters
    // restored), no custom rows, keys still empty
    const resetDefs = (await invoke('ai:resetProviderConfigs')) as {
      ok: boolean
      defs?: any[]
    }
    expect(resetDefs.ok).toBe(true)
    expect(resetDefs.defs?.map((d) => d.id)).toEqual([
      'grok',
      'gemini',
      'openai',
      'claude',
      'ollama',
      'openrouter'
    ])
    expect((workspaceEngine.getSettings() as Record<string, unknown>).aiProviders).toHaveLength(6)

    // 7. A model pick in chat persists as the provider's default (live + key
    // entry + def list all in sync — survives sessions and rebuilds)
    const pick = (await invoke('ai:setProviderDefaultModel', 'gemini', 'gemini-2.5-flash')) as {
      ok: boolean
      error?: string
    }
    expect(pick.ok).toBe(true)
    const s4 = workspaceEngine.getSettings() as Record<string, any>
    expect(s4.ai.gemini.defaultModel).toBe('gemini-2.5-flash')
    const def4 = s4.aiProviders.find((d: { id: string }) => d.id === 'gemini')
    expect(def4.defaultModel).toBe('gemini-2.5-flash')
    // Unknown provider → clean error, nothing persisted
    const bad = (await invoke('ai:setProviderDefaultModel', 'nope', 'x')) as {
      ok: boolean
      error?: string
    }
    expect(bad.ok).toBe(false)
  })

  it('malformed IPC payloads degrade to clean errors — never wipe or crash state', async () => {
    // A non-array defs payload must NOT wipe the saved provider list (a legit
    // delete-all is an explicit []); unknown/null/object forms are rejected
    const before = (await invoke('ai:getProviderConfigs')) as { defs: any[] }
    const bad = (await invoke('ai:saveProviderConfigs', 'not-an-array')) as {
      ok: boolean
      error?: string
    }
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('array')
    const after = (await invoke('ai:getProviderConfigs')) as { defs: any[] }
    expect(after.defs.map((d: { id: string }) => d.id)).toEqual(
      before.defs.map((d: { id: string }) => d.id)
    )
    expect(((await invoke('ai:saveProviderConfigs', null)) as { ok: boolean }).ok).toBe(false)
    expect(((await invoke('ai:saveProviderConfigs', {})) as { ok: boolean }).ok).toBe(false)
    // Oversized file content → clean rejection (no partial write)
    await expect(
      invoke('file:create', {
        filePath: path.join(vault, 'Big.md'),
        content: 'x'.repeat(5_000_001)
      })
    ).rejects.toThrow()
    // Non-string workspace path → clean rejection before any state mutation
    await expect(invoke('workspace:open', 42)).rejects.toThrow()
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
