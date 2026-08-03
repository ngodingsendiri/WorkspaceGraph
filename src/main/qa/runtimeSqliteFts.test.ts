import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'

/**
 * Runtime SQLite FTS5 check — mirrors scripts/qa-phase2.mjs section 1.
 * Uses vi.importActual to bypass the better-sqlite3 mock in setup.ts so we
 * verify the real native binding + FTS5 schema actually works.
 */
describe('SQLite FTS5 runtime', () => {
  it('creates FTS5 table, inserts, matches, ranks by bm25', async () => {
    const mod = (await vi.importActual('better-sqlite3')) as unknown as {
      default: new (p: string) => {
      pragma(s: string): unknown
      exec(s: string): void
      prepare(s: string): {
        run(...a: unknown[]): unknown
        get(...a: unknown[]): Record<string, unknown> | undefined
        all(...a: unknown[]): Record<string, unknown>[]
      }
      close(): void
    }
  }
    const Database = mod.default
    const dbp = path.join(tmpdir(), `wg-fts-${Date.now()}.db`)
    const db = new Database(dbp)
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        relative_path TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        type TEXT NOT NULL DEFAULT 'note',
        headings TEXT NOT NULL DEFAULT '',
        frontmatter TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        title, content, tags, relative_path, headings,
        content='notes', content_rowid='rowid',
        tokenize='porter unicode61'
      );
      CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, content, tags, relative_path, headings)
        VALUES (new.rowid, new.title, new.content, new.tags, new.relative_path, new.headings);
      END;
      CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content, tags, relative_path, headings)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags, old.relative_path, old.headings);
      END;
    `)
    const ins = db.prepare(
      `INSERT INTO notes (id, path, relative_path, title, content, tags, type, headings, frontmatter, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    ins.run('a1', path.join(dbp, 'Knowledge', 'Alpha.md'), 'Knowledge/Alpha.md', 'Alpha', 'Pegawai cuti tahunan', '["cuti"]', 'knowledge', 'Alpha', '{}', '2026-07-21')
    ins.run('b1', path.join(dbp, 'SOP', 'Cuti.md'), 'SOP/Cuti.md', 'SOP Cuti', 'Prosedur cuti ASN', '["sop"]', 'sop', 'SOP Cuti', '{}', '2026-07-20')
    ins.run('c1', path.join(dbp, 'Knowledge', 'Beta.md'), 'Knowledge/Beta.md', 'Beta', 'unrelated text', '[]', 'note', 'Beta', '{}', '2026-07-19')

    const hits = db
      .prepare(
        `SELECT n.title FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT 5`
      )
      .all('"cuti"*')
    expect(hits.length).toBeGreaterThanOrEqual(2)
    const count = db.prepare('SELECT COUNT(*) as c FROM notes').get()?.c
    expect(count).toBe(3)

    db.close()
    try {
      fs.unlinkSync(dbp)
    } catch {}
  })
})
