/**
 * Stress / scale test — a vault with thousands of notes plus multi-MB binary
 * blobs must OPEN without hanging or crashing, and stay responsive afterwards.
 *
 * This is deliberately NOT a performance benchmark with tight numbers (machine
 * variance would make it flaky); it asserts generous ceilings that catch
 * pathological behavior (quadratic scans, content reads of binaries, hangs),
 * and logs the real timings so regressions are visible in the run output.
 *
 * Runtime: building 3,000 files + ~80 MB of blobs takes a few seconds; the
 * per-test timeouts (60 s) only exist to turn a HANG into a failure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { indexDatabase } from '../engine/IndexDatabase'

const NOTE_COUNT = 3000
const SUBDIRS = 20
const BINARY_COUNT = 4
const BINARY_SIZE = 20 * 1024 * 1024 // 20 MB each — 80 MB total of non-text bytes

describe('stress: thousands of files + giant binaries open without hang/crash', () => {
  let vault: string

  beforeAll(() => {
    vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-stress-'))
    const notesDir = path.join(vault, 'Notes')
    const binDir = path.join(vault, 'assets')
    fs.mkdirSync(notesDir, { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })
    // Thousands of small notes spread across nested subfolders (exercises the
    // recursive scan + per-dir sort path)
    for (let i = 0; i < NOTE_COUNT; i++) {
      const sub = path.join(notesDir, `sub${i % SUBDIRS}`)
      fs.mkdirSync(sub, { recursive: true })
      fs.writeFileSync(path.join(sub, `note-${i}.md`), `# Note ${i}\n\nKonten kecil ${i}.`)
    }
    // Giant binary blobs — must never be read as text during open/scan
    const blob = Buffer.alloc(BINARY_SIZE, 0xa5)
    for (let b = 0; b < BINARY_COUNT; b++) {
      fs.writeFileSync(path.join(binDir, `blob-${b}.bin`), blob)
    }
  }, 120_000)

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

  it('opens the big vault without hanging or crashing', () => {
    const t0 = Date.now()
    let state: { totalFiles: number; totalNotes: number }
    expect(() => {
      state = workspaceEngine.openWorkspace(vault)
    }).not.toThrow()
    const elapsed = Date.now() - t0
    // eslint-disable-next-line no-console
    console.log(`[stress] openWorkspace: ${elapsed}ms — ${state.totalFiles} files`)
    expect(state.totalFiles).toBeGreaterThanOrEqual(NOTE_COUNT + BINARY_COUNT)
    expect(state.totalNotes).toBeGreaterThanOrEqual(NOTE_COUNT)
    // Generous ceiling: catches pathological hangs, ignores machine variance
    expect(elapsed).toBeLessThan(60_000)
  }, 90_000)

  it('refreshFiles rescans the same vault without crashing', () => {
    const t0 = Date.now()
    workspaceEngine.refreshFiles()
    const elapsed = Date.now() - t0
    // totalFiles is the recursive count (files are nested in subfolders)
    const total = workspaceEngine.getState().totalFiles
    // eslint-disable-next-line no-console
    console.log(`[stress] refreshFiles: ${elapsed}ms — ${total} files`)
    expect(total).toBeGreaterThanOrEqual(NOTE_COUNT + BINARY_COUNT)
    expect(elapsed).toBeLessThan(30_000)
  }, 60_000)

  it('index db opens against the big vault (SQLite or Fuse fallback, never a crash)', () => {
    const t0 = Date.now()
    expect(() => indexDatabase.open(vault)).not.toThrow()
    // eslint-disable-next-line no-console
    console.log(`[stress] indexDatabase.open: ${Date.now() - t0}ms`)
  }, 60_000)

  it('reading a giant binary file never throws (opaque bytes, not UTF-8)', () => {
    const p = path.join(vault, 'assets', 'blob-0.bin')
    expect(() => {
      const { content } = workspaceEngine.readFile(p)
      expect(content.length).toBeGreaterThan(0)
    }).not.toThrow()
  }, 60_000)
})
