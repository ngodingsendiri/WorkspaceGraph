/**
 * R2-2 — stream resume checkpoints.
 * One JSON per truncated assistant message under <vault>/.workspacegraph/checkpoints/.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import {
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  deleteCheckpoint,
  checkpointIdFor,
  type StreamCheckpoint
} from './CheckpointStore'

function makeCp(overrides: Partial<StreamCheckpoint> = {}): StreamCheckpoint {
  return {
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
    activeFilePath: path.join(tmpdir(), 'vault', 'Notes.md'),
    reason: 'cancelled',
    timestamp: '2026-08-07T12:00:00.000Z',
    ...overrides
  }
}

describe('CheckpointStore (R2-2)', () => {
  let vault: string

  beforeAll(() => {
    vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-cp-'))
    workspaceEngine.openWorkspace(vault)
  })

  afterAll(() => {
    try {
      workspaceEngine.closeWorkspace()
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('saves one JSON per checkpoint under .workspacegraph/checkpoints/', () => {
    const res = saveCheckpoint(makeCp())
    expect(res.ok).toBe(true)
    const file = path.join(vault, '.workspacegraph', 'checkpoints', '20260807_120000_abcd_m1.json')
    expect(fs.existsSync(file)).toBe(true)
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as StreamCheckpoint
    expect(onDisk.round).toBe(2)
    expect(onDisk.messageIndex).toBe(3)
    expect(onDisk.contextTokens).toBe(1240)
    expect(onDisk.reason).toBe('cancelled')
    expect(onDisk.messageId).toBe('m1')
  })

  it('loads and lists persisted checkpoints', () => {
    saveCheckpoint(makeCp({ id: 'conv2_m2', messageId: 'm2', round: 0 }))
    const loaded = loadCheckpoint('conv2_m2')
    expect(loaded?.messageId).toBe('m2')
    expect(loaded?.round).toBe(0)

    const all = listCheckpoints()
    expect(all.some((c) => c.id === '20260807_120000_abcd_m1')).toBe(true)
    expect(all.some((c) => c.id === 'conv2_m2')).toBe(true)
  })

  it('overwriting the same id replaces the previous snapshot (retry re-checkpoint)', () => {
    saveCheckpoint(makeCp({ id: 'conv3_m3', round: 1, reason: 'timeout' }))
    saveCheckpoint(makeCp({ id: 'conv3_m3', round: 3, reason: 'error' }))
    const loaded = loadCheckpoint('conv3_m3')
    expect(loaded?.round).toBe(3)
    expect(loaded?.reason).toBe('error')
    const files = fs
      .readdirSync(path.join(vault, '.workspacegraph', 'checkpoints'))
      .filter((f) => f.startsWith('conv3_m3'))
    expect(files).toHaveLength(1)
  })

  it('delete removes the file and is idempotent', () => {
    saveCheckpoint(makeCp({ id: 'conv4_m4' }))
    expect(loadCheckpoint('conv4_m4')).not.toBeNull()
    expect(deleteCheckpoint('conv4_m4').ok).toBe(true)
    expect(loadCheckpoint('conv4_m4')).toBeNull()
    // Deleting again must not fail
    expect(deleteCheckpoint('conv4_m4').ok).toBe(true)
  })

  it('rejects path-traversal ids', () => {
    const res = saveCheckpoint(makeCp({ id: '../evil' }))
    expect(res.ok).toBe(false)
    expect(loadCheckpoint('../evil')).toBeNull()
    expect(deleteCheckpoint('../../etc/passwd').ok).toBe(false)
  })

  it('skips corrupt checkpoint files when listing', () => {
    const dir = path.join(vault, '.workspacegraph', 'checkpoints')
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{not json', 'utf-8')
    const all = listCheckpoints()
    expect(all.some((c) => c.id === 'corrupt')).toBe(false)
  })

  it('checkpointIdFor sanitizes conversation/message ids to safe filenames', () => {
    expect(checkpointIdFor('20260807_120000_abcd', 'm1')).toBe('20260807_120000_abcd_m1')
    expect(checkpointIdFor('', 'm/x..y')).toBe('anon_m_x__y')
    expect(checkpointIdFor('a/b', 'c')).toBe('a_b_c')
  })

  it('degrades gracefully when no workspace is open', () => {
    workspaceEngine.closeWorkspace()
    expect(saveCheckpoint(makeCp()).ok).toBe(false)
    expect(loadCheckpoint('anything')).toBeNull()
    expect(listCheckpoints()).toEqual([])
    expect(deleteCheckpoint('anything').ok).toBe(false)
    workspaceEngine.openWorkspace(vault)
  })
})
