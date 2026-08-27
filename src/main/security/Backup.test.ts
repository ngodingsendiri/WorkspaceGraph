/**
 * M8 SEC-2: scheduled vault backup — prune + scheduler lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import {
  createBackup,
  listBackups,
  pruneBackups,
  startScheduledBackups,
  stopScheduledBackups,
  getScheduledBackupStatus
} from './Backup'

describe('M8 SEC-2 — scheduled backups', () => {
  let vault: string

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-backup-sched-'))
    fs.mkdirSync(path.join(vault, 'Knowledge'), { recursive: true })
    fs.writeFileSync(path.join(vault, 'Knowledge', 'A.md'), '# A\n', 'utf-8')
  })

  afterEach(() => {
    stopScheduledBackups()
    try {
      fs.rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('createBackup writes a timestamped archive with checksum manifest', () => {
    const res = createBackup(vault)
    expect(res.ok).toBe(true)
    expect(fs.existsSync(path.join(res.dir as string, 'manifest.sha256'))).toBe(true)
    expect(listBackups(vault).length).toBe(1)
  })

  it('pruneBackups keeps only the newest N archives', () => {
    createBackup(vault)
    createBackup(vault)
    createBackup(vault)
    expect(listBackups(vault).length).toBe(3)
    const removed = pruneBackups(vault, 2)
    expect(removed).toBe(1)
    expect(listBackups(vault).length).toBe(2)
  })

  it('scheduled backups report lifecycle state and stop cleanly', () => {
    // unref'd interval: short interval so a real run is likely but not required
    startScheduledBackups(vault, 60_000, 3)
    const st = getScheduledBackupStatus()
    expect(st.active).toBe(true)
    expect(st.intervalMs).toBe(60_000)
    expect(typeof st.nextRunAt).toBe('number')
    stopScheduledBackups()
    expect(getScheduledBackupStatus().active).toBe(false)
  })

  it('interval below 60s is clamped to avoid hammering the disk', () => {
    startScheduledBackups(vault, 500, 3)
    expect(getScheduledBackupStatus().intervalMs).toBe(60_000)
    stopScheduledBackups()
  })
})
