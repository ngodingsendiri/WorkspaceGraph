/**
 * Workspace index cache (Law 009 — DB is cache only, Markdown is SoT).
 * Path: <vault>/.workspacegraph/index.db
 */
import fs from 'fs'
import path from 'path'
import type { ParsedMarkdown } from './MarkdownEngine'

export interface IndexNoteRow {
  id: string
  path: string
  relativePath: string
  title: string
  content: string
  tags: string[]
  type: string
  headings: string
  frontmatter: string
  updatedAt: string
}

export interface FtsHit {
  id: string
  path: string
  relativePath: string
  title: string
  type: string
  tags: string[]
  updatedAt: string
  rank: number
  snippet: string
}

type SqliteDb = {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => unknown
    get: (...args: unknown[]) => unknown
    all: (...args: unknown[]) => unknown[]
  }
  exec: (sql: string) => void
  pragma: (pragma: string) => unknown
  close: () => void
  transaction: <T>(fn: () => T) => () => T
}

export class IndexDatabase {
  private db: SqliteDb | null = null
  private dbPath: string | null = null
  private available = false

  isOpen(): boolean {
    return this.db !== null && this.available
  }

  getPath(): string | null {
    return this.dbPath
  }

  open(workspaceRoot: string): boolean {
    this.close()
    try {
      // Dynamic require so typecheck + missing native module degrade gracefully
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3') as new (path: string) => SqliteDb
      const dir = path.join(workspaceRoot, '.workspacegraph')
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      this.dbPath = path.join(dir, 'index.db')
      this.db = new Database(this.dbPath)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('synchronous = NORMAL')
      this.migrate()
      this.available = true
      return true
    } catch (err) {
      console.error('[IndexDatabase] open failed, Fuse-only mode:', err)
      this.db = null
      this.available = false
      return false
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close()
      } catch {
        /* ignore */
      }
    }
    this.db = null
    this.dbPath = null
    this.available = false
  }

  private migrate(): void {
    if (!this.db) return
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS notes (
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

      CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
      CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(type);

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title,
        content,
        tags,
        relative_path,
        headings,
        content='notes',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, content, tags, relative_path, headings)
        VALUES (new.rowid, new.title, new.content, new.tags, new.relative_path, new.headings);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content, tags, relative_path, headings)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags, old.relative_path, old.headings);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content, tags, relative_path, headings)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags, old.relative_path, old.headings);
        INSERT INTO notes_fts(rowid, title, content, tags, relative_path, headings)
        VALUES (new.rowid, new.title, new.content, new.tags, new.relative_path, new.headings);
      END;
    `)
  }

  clear(): void {
    if (!this.db) return
    this.db.exec('DELETE FROM notes')
    // FTS content table rebuild via triggers on delete
    try {
      this.db.exec(`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`)
    } catch {
      /* optional */
    }
  }

  upsertNote(file: ParsedMarkdown): void {
    if (!this.db) return
    const tags = JSON.stringify(file.tags || [])
    const headings = (file.headings || []).map((h) => h.text).join(' ')
    const fm = JSON.stringify(file.frontmatter || {})
    const updated =
      String(file.frontmatter.updated || file.frontmatter.date || '') || new Date().toISOString()
    const type = (file.frontmatter.type as string) || 'note'

    // Avoid UNIQUE(path) clash if id changed for same path
    this.db.prepare('DELETE FROM notes WHERE path = ? AND id != ?').run(file.filePath, file.id)

    this.db
      .prepare(
        `INSERT INTO notes (id, path, relative_path, title, content, tags, type, headings, frontmatter, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path=excluded.path,
           relative_path=excluded.relative_path,
           title=excluded.title,
           content=excluded.content,
           tags=excluded.tags,
           type=excluded.type,
           headings=excluded.headings,
           frontmatter=excluded.frontmatter,
           updated_at=excluded.updated_at`
      )
      .run(
        file.id,
        file.filePath,
        file.relativePath,
        file.title,
        file.content,
        tags,
        type,
        headings,
        fm,
        updated
      )
  }

  /** Full rebuild from parsed files (transaction) */
  rebuild(parsedFiles: ParsedMarkdown[]): number {
    if (!this.db) return 0
    const run = this.db.transaction(() => {
      this.clear()
      for (const f of parsedFiles) {
        this.upsertNote(f)
      }
      this.db!.prepare(
        `INSERT INTO meta(key, value) VALUES('last_rebuild', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      ).run(new Date().toISOString())
      return parsedFiles.length
    })
    return run()
  }

  removeById(id: string): void {
    if (!this.db) return
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id)
  }

  removeByPath(filePath: string): void {
    if (!this.db) return
    this.db.prepare('DELETE FROM notes WHERE path = ?').run(filePath)
  }

  count(): number {
    if (!this.db) return 0
    const row = this.db.prepare('SELECT COUNT(*) as c FROM notes').get() as { c: number }
    return row?.c || 0
  }

  getStats(): { count: number; path: string | null; lastRebuild: string | null; open: boolean } {
    if (!this.db) {
      return { count: 0, path: this.dbPath, lastRebuild: null, open: false }
    }
    const meta = this.db.prepare(`SELECT value FROM meta WHERE key = 'last_rebuild'`).get() as
      { value: string } | undefined
    return {
      count: this.count(),
      path: this.dbPath,
      lastRebuild: meta?.value || null,
      open: true
    }
  }

  /**
   * FTS5 query. Escapes user input to safe token query (AND of terms).
   */
  searchFts(query: string, limit = 20): FtsHit[] {
    if (!this.db || !query.trim()) return []

    const terms = query
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/["']/g, ''))
      .filter((t) => t.length > 0 && !t.includes(':'))
      .slice(0, 12)

    if (terms.length === 0) return []

    // Prefix match each term for partial words
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ')

    try {
      const rows = this.db
        .prepare(
          `SELECT n.id, n.path, n.relative_path, n.title, n.type, n.tags, n.updated_at,
                  bm25(notes_fts) AS rank,
                  snippet(notes_fts, 1, '«', '»', '…', 12) AS snip
           FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
           WHERE notes_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(ftsQuery, limit) as Array<{
        id: string
        path: string
        relative_path: string
        title: string
        type: string
        tags: string
        updated_at: string
        rank: number
        snip: string
      }>

      return rows.map((r) => ({
        id: r.id,
        path: r.path,
        relativePath: r.relative_path,
        title: r.title,
        type: r.type,
        tags: this.parseTags(r.tags),
        updatedAt: r.updated_at,
        rank: typeof r.rank === 'number' ? r.rank : 0,
        snippet: (r.snip || '').replace(/\n/g, ' ')
      }))
    } catch (err) {
      console.error('[IndexDatabase] FTS query failed:', err)
      return []
    }
  }

  searchByTag(tag: string, limit = 50): FtsHit[] {
    if (!this.db) return []
    const needle = tag.toLowerCase()
    const rows = this.db
      .prepare(`SELECT * FROM notes ORDER BY updated_at DESC LIMIT 2000`)
      .all() as Array<{
      id: string
      path: string
      relative_path: string
      title: string
      type: string
      tags: string
      updated_at: string
      content: string
    }>

    return rows
      .filter((r) => this.parseTags(r.tags).some((t) => t.toLowerCase() === needle))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        path: r.path,
        relativePath: r.relative_path,
        title: r.title,
        type: r.type,
        tags: this.parseTags(r.tags),
        updatedAt: r.updated_at,
        rank: 0,
        snippet: this.parseTags(r.tags).join(', ')
      }))
  }

  getRecent(limit = 10): FtsHit[] {
    if (!this.db) return []
    const rows = this.db
      .prepare(
        `SELECT id, path, relative_path, title, type, tags, updated_at, content
         FROM notes ORDER BY updated_at DESC LIMIT ?`
      )
      .all(limit) as Array<{
      id: string
      path: string
      relative_path: string
      title: string
      type: string
      tags: string
      updated_at: string
      content: string
    }>

    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      relativePath: r.relative_path,
      title: r.title,
      type: r.type,
      tags: this.parseTags(r.tags),
      updatedAt: r.updated_at,
      rank: 0,
      snippet: (r.content || '').slice(0, 100).replace(/\n/g, ' ').trim()
    }))
  }

  getByIds(ids: string[]): FtsHit[] {
    if (!this.db || ids.length === 0) return []
    const out: FtsHit[] = []
    const stmt = this.db.prepare(
      `SELECT id, path, relative_path, title, type, tags, updated_at, content FROM notes WHERE id = ?`
    )
    for (const id of ids) {
      const r = stmt.get(id) as
        | {
            id: string
            path: string
            relative_path: string
            title: string
            type: string
            tags: string
            updated_at: string
            content: string
          }
        | undefined
      if (!r) continue
      out.push({
        id: r.id,
        path: r.path,
        relativePath: r.relative_path,
        title: r.title,
        type: r.type,
        tags: this.parseTags(r.tags),
        updatedAt: r.updated_at,
        rank: 0,
        snippet: (r.content || '').slice(0, 100).replace(/\n/g, ' ').trim()
      })
    }
    return out
  }

  /** Notes under Rules/, SOP/, Templates/, Prompt/ for Context Engine auto-include */
  listSystemNotes(limit = 20): FtsHit[] {
    if (!this.db) return []
    const rows = this.db
      .prepare(
        `SELECT id, path, relative_path, title, type, tags, updated_at, content
         FROM notes
         WHERE lower(relative_path) LIKE 'rules/%'
            OR lower(relative_path) LIKE 'sop/%'
            OR lower(relative_path) LIKE 'templates/%'
            OR lower(relative_path) LIKE 'prompt/%'
         ORDER BY relative_path
         LIMIT ?`
      )
      .all(limit) as Array<{
      id: string
      path: string
      relative_path: string
      title: string
      type: string
      tags: string
      updated_at: string
      content: string
    }>

    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      relativePath: r.relative_path,
      title: r.title,
      type: r.type,
      tags: this.parseTags(r.tags),
      updatedAt: r.updated_at,
      rank: 0,
      snippet: (r.content || '').slice(0, 400).replace(/\n/g, ' ').trim()
    }))
  }

  private parseTags(raw: string): string[] {
    try {
      const arr = JSON.parse(raw || '[]')
      return Array.isArray(arr) ? arr.map(String) : []
    } catch {
      return []
    }
  }
}

export const indexDatabase = new IndexDatabase()
