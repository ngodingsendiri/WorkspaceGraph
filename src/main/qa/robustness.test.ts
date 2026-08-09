/**
 * Robustness / resilience suite — the app must never crash on corrupt
 * on-disk state, malformed persisted files, or garbage secrets. Each case
 * exercises a REAL singleton (workspaceEngine / indexDatabase /
 * CheckpointStore / SecretsStore) against deliberately damaged files.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'

/**
 * Controllable better-sqlite3 mock (overrides setup.ts's for THIS file): lets
 * the corrupt-index.db test make the native constructor refuse the file,
 * exactly like the real binding does with a garbage db (SQLITE_NOTADB).
 */
const dbMock = vi.hoisted(() => ({ failNext: false }))
// eslint-disable-next-line @typescript-eslint/no-require-imports
vi.mock('better-sqlite3', () => {
  const m = {
    prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
    exec: vi.fn(),
    pragma: vi.fn(),
    close: vi.fn(),
    transaction: vi.fn((fn: unknown) => fn)
  }
  return vi.fn(() => {
    if (dbMock.failNext) throw new Error('SQLITE_NOTADB: file is not a database')
    return m
  })
})

import { WorkspaceEngine, workspaceEngine } from '../engine/WorkspaceEngine'
import { indexDatabase } from '../engine/IndexDatabase'
import { saveConversation, listConversations, loadConversation } from '../ai/ConversationStore'
import { listPendingProposals } from '../ai/AgentTools'
import {
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  deleteCheckpoint
} from '../ai/CheckpointStore'
import { decryptSecret, encryptSecret } from '../security/SecretsStore'

describe('robustness: corrupt on-disk state must never crash the app', () => {
  let vault: string
  let settingsDir: string

  beforeAll(() => {
    vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-robust-'))
    settingsDir = path.dirname(workspaceEngine.getSettingsPath())
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
  })

  it('corrupt settings.json → defaults returned, no throw, garbage preserved as backup', () => {
    const settingsPath = workspaceEngine.getSettingsPath()
    fs.writeFileSync(settingsPath, '{ this is not json !!!')
    expect(() => workspaceEngine.getSettings()).not.toThrow()
    const s = workspaceEngine.getSettings()
    expect(s.version).toBeDefined()
    // The unreadable file is backed up — a later save must never silently
    // destroy the only copy of the user's settings.
    const backups = fs
      .readdirSync(settingsDir)
      .filter((f) => f.startsWith('settings.json.corrupt-'))
    expect(backups.length).toBeGreaterThan(0)
    expect(fs.readFileSync(path.join(settingsDir, backups[0]), 'utf-8')).toContain('not json')
    // Raw read equally safe
    expect(workspaceEngine.getSettingsRaw()).toEqual({})
  })

  it('recovers settings from the .tmp atomic-write leftover when the main file is corrupt', () => {
    const settingsPath = workspaceEngine.getSettingsPath()
    // A leftover .tmp is the last FULL write (atomic rename never completed)
    fs.writeFileSync(settingsPath + '.tmp', JSON.stringify({ theme: 'light', editorFontSize: 13 }))
    fs.writeFileSync(settingsPath, 'garbage{{')
    const s = workspaceEngine.getSettings()
    expect(s.theme).toBe('light')
    expect(s.editorFontSize).toBe(13)
  })

  it('corrupt workspace config → vault still opens (config recreated, garbage preserved)', () => {
    const configDir = path.join(vault, '.workspacegraph')
    fs.mkdirSync(configDir, { recursive: true })
    const configPath = path.join(configDir, 'workspace.json')
    fs.writeFileSync(configPath, '{{{{{{{ corrupt')
    let state: { rootPath: string } | undefined
    expect(() => {
      state = workspaceEngine.openWorkspace(vault)
    }).not.toThrow()
    expect(state?.rootPath).toBe(path.resolve(vault))
    // config recreated as valid JSON
    expect(() => JSON.parse(fs.readFileSync(configPath, 'utf-8'))).not.toThrow()
    // garbage preserved for inspection
    const backups = fs.readdirSync(configDir).filter((f) => f.startsWith('workspace.json.corrupt-'))
    expect(backups.length).toBeGreaterThan(0)
  })

  it('recent.json corrupt → quarantined + empty, no crash', () => {
    const recentPath = path.join(settingsDir, 'recent.json')
    fs.writeFileSync(recentPath, '{{{{not json')
    // A fresh instance re-runs loadRecentWorkspaces (the singleton loaded at
    // import time, before we corrupted the file)
    const eng = new WorkspaceEngine()
    expect(eng.getRecentWorkspaces()).toEqual([])
    // moved aside — preserved, and never re-read/re-backed-up on every boot
    const backups = fs.readdirSync(settingsDir).filter((f) => f.startsWith('recent.json.corrupt-'))
    expect(backups.length).toBeGreaterThan(0)
    expect(fs.existsSync(recentPath)).toBe(false)
  })

  it('recent.json recovers from the .tmp atomic-write leftover', () => {
    const recentPath = path.join(settingsDir, 'recent.json')
    const existingDir = fs.mkdtempSync(path.join(tmpdir(), 'wg-recent-exists-'))
    try {
      fs.writeFileSync(recentPath + '.tmp', JSON.stringify([existingDir]))
      fs.writeFileSync(recentPath, 'garbage{{')
      const eng = new WorkspaceEngine()
      expect(eng.getRecentWorkspaces()).toEqual([path.resolve(existingDir)])
    } finally {
      fs.rmSync(existingDir, { recursive: true, force: true })
    }
  })

  it('corrupt chat file is quarantined; healthy chats and foreign shapes survive the list', () => {
    const dir = path.join(vault, '.workspacegraph', 'chats')
    fs.mkdirSync(dir, { recursive: true })
    const good = {
      id: '20260809_120000_abcd',
      title: 'Good',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ id: 'm1', role: 'user' as const, content: 'halo', timestamp: '12:00' }]
    }
    expect(saveConversation(good).ok).toBe(true)
    fs.writeFileSync(path.join(dir, 'corrupt-chat.json'), '{{{{ not json')
    // valid JSON but wrong shape — skipped by the guard, NOT quarantined
    // (could be a future schema version)
    fs.writeFileSync(path.join(dir, 'foreign-chat.json'), JSON.stringify({ hello: 'world' }))

    const list = listConversations(50)
    expect(list.some((c) => c.id === good.id)).toBe(true)
    expect(list.some((c) => (c as unknown as { hello?: string }).hello === 'world')).toBe(false)
    // the corrupt file was quarantined (preserved aside, removed from the dir)
    const quarantined = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('corrupt-chat.json.corrupt-'))
    expect(quarantined.length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(dir, 'foreign-chat.json'))).toBe(true)
    // direct load of the corrupt id → null, no crash
    expect(loadConversation('corrupt-chat')).toBeNull()
  })

  it('corrupt proposal file is quarantined on load; pending ones survive', () => {
    const dir = path.join(vault, '.workspacegraph', 'proposals')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'p-good.json'),
      JSON.stringify({ id: 'p-good', status: 'pending' })
    )
    fs.writeFileSync(path.join(dir, 'p-corrupt.json'), '{{{{ nope')

    const list = listPendingProposals()
    expect(list.some((p) => p.id === 'p-good')).toBe(true)
    expect(list.some((p) => p.id === 'p-corrupt')).toBe(false)
    const quarantined = fs.readdirSync(dir).filter((f) => f.startsWith('p-corrupt.json.corrupt-'))
    expect(quarantined.length).toBeGreaterThan(0)
  })

  it('corrupt + foreign checkpoint files are skipped — load/list/save never crash', () => {
    const dir = path.join(vault, '.workspacegraph', 'checkpoints')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'bad.json'), 'not json at all')
    // valid JSON but wrong shape — must NOT surface as a resume point
    fs.writeFileSync(path.join(dir, 'foreign.json'), JSON.stringify({ hello: 'world' }))
    expect(() => listCheckpoints()).not.toThrow()
    const list = listCheckpoints()
    expect(Array.isArray(list)).toBe(true)
    expect(list.some((c) => (c as { hello?: string }).hello === 'world')).toBe(false)
    expect(loadCheckpoint('bad')).toBeNull()
    expect(loadCheckpoint('foreign')).toBeNull()
    expect(loadCheckpoint('nope-not-here')).toBeNull()
    // save/delete still work around corrupt siblings
    const cp = {
      id: '20260809_120000_abcd_m1',
      conversationId: '20260809_120000_abcd',
      messageId: 'm1',
      messageIndex: 2,
      round: 1,
      reason: 'cancelled' as const,
      timestamp: new Date().toISOString()
    }
    expect(saveCheckpoint(cp).ok).toBe(true)
    expect(loadCheckpoint(cp.id)?.messageIndex).toBe(2)
    expect(deleteCheckpoint(cp.id).ok).toBe(true)
    // path-traversal id rejected safely
    expect(saveCheckpoint({ ...cp, id: '../../evil' }).ok).toBe(false)
  })

  it('corrupt index.db → Fuse-only fallback, no crash, corrupt file moved aside', () => {
    const dbDir = path.join(vault, '.workspacegraph')
    const dbPath = path.join(dbDir, 'index.db')
    fs.writeFileSync(dbPath, 'this is not a sqlite database at all 12345')
    dbMock.failNext = true
    expect(() => indexDatabase.open(vault)).not.toThrow()
    expect(indexDatabase.getDb()).toBeNull()
    // corrupt file moved aside so the NEXT open can create a fresh index
    const moved = fs.readdirSync(dbDir).filter((f) => f.startsWith('index.db.corrupt-'))
    expect(moved.length).toBeGreaterThan(0)
  })

  it('garbage secrets decrypt to empty without crashing; encryption degrades when safeStorage is off', () => {
    // Valid round-trip
    const enc = encryptSecret('sk-real')
    expect(enc.startsWith('enc:v1:')).toBe(true)
    expect(decryptSecret(enc)).toBe('sk-real')
    // Garbage ciphertext never crashes and never returns undefined (the real
    // safeStorage decryptString THROWS on bad ciphertext; decryptSecret must
    // catch that → '' — the test mock is naive, so assert the no-throw/string
    // contract here and the '' case on the empty-payload path).
    expect(() => decryptSecret('enc:v1:!!!not-base64!!!')).not.toThrow()
    expect(typeof decryptSecret('enc:v1:!!!not-base64!!!')).toBe('string')
    expect(decryptSecret('enc:v1:')).toBe('')
    // Legacy plaintext marker still readable
    expect(decryptSecret('plain:sk-legacy')).toBe('sk-legacy')
  })
})
