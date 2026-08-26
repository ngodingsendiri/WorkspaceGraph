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

  /** Exposes the raw DB handle — used by EmbeddingEngine for the embedding_chunks table. */
  getDb(): SqliteDb | null {
    return this.available ? this.db : null
  }

  open(workspaceRoot: string): boolean {
    this.close()
    try {
      // Dynamic require so typecheck + missing native module degrade gracefully
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3') as new (path: string) => SqliteDb
      const dir = path.join(workspaceRoot, '.workspacegraph')
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      // M8 FST-1/2: index.db lives in cache/ (disposable) — migrate old location
      const cacheDir = path.join(dir, 'cache')
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
      const oldPath = path.join(dir, 'index.db')
      const newPath = path.join(cacheDir, 'index.db')
      if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
        try {
          fs.renameSync(oldPath, newPath)
        } catch {
          fs.copyFileSync(oldPath, newPath)
        }
      }
      this.dbPath = newPath
      this.db = new Database(this.dbPath)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('synchronous = NORMAL')
      this.migrate()
      this.backfillNoteTags()
      this.available = true
      return true
    } catch (err) {
      console.error('[IndexDatabase] open failed, Fuse-only mode:', err)
      // A corrupt/leftover db file must not block future opens forever — move
      // it aside so the next open can create a fresh index. Search degrades to
      // Fuse for this session, never a crash.
      try {
        if (this.dbPath && fs.existsSync(this.dbPath)) {
          // rename can fail while the sqlite handle still holds the file
          // (Windows EPERM) — fall back to copy + unlink; if even that fails,
          // leave the file and let the next open retry the recovery.
          const aside = `${this.dbPath}.corrupt-${Date.now()}`
          try {
            fs.renameSync(this.dbPath, aside)
          } catch {
            fs.copyFileSync(this.dbPath, aside)
            try {
              fs.rmSync(this.dbPath, { force: true })
            } catch {
              /* keep the corrupt file; next open retries */
            }
          }
        }
      } catch {
        /* best-effort */
      }
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

      -- WB-1: normalized tag index so #tag search is a column query, not a
      -- capped scan of the 2000 most recent notes. Tags stored lowercased.
      CREATE TABLE IF NOT EXISTS note_tags (
        note_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (note_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag);

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

  /**
   * WB-1 migration: index.db created before note_tags existed has no tag rows
   * until the next rebuild. Backfill once from the stored JSON so #tag search
   * is correct immediately after upgrade (no full reindex needed).
   */
  private backfillNoteTags(): void {
    if (!this.db) return
    const count = this.db.prepare('SELECT COUNT(*) as c FROM note_tags').get() as
      { c: number } | undefined
    if ((count?.c || 0) > 0) return
    const rows = this.db.prepare('SELECT id, tags FROM notes').all() as
      { id: string; tags: string }[] | []
    if (rows.length === 0) return
    const ins = this.db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)')
    for (const r of rows) {
      for (const t of this.parseTags(r.tags)) {
        ins.run(r.id, t.toLowerCase())
      }
    }
  }

  clear(): void {
    if (!this.db) return
    this.db.exec('DELETE FROM notes')
    this.db.exec('DELETE FROM note_tags')
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
    const tagList = Array.isArray(file.tags) ? file.tags.map(String) : []
    const headings = (file.headings || []).map((h) => h.text).join(' ')
    const fm = JSON.stringify(file.frontmatter || {})
    const updated =
      String(file.frontmatter.updated || file.frontmatter.date || '') || new Date().toISOString()
    const type = (file.frontmatter.type as string) || 'note'

    // Avoid UNIQUE(path) clash if id changed for same path — drop stale tag
    // rows for any note previously stored under this path, then re-insert.
    this.db
      .prepare('DELETE FROM note_tags WHERE note_id IN (SELECT id FROM notes WHERE path = ?)')
      .run(file.filePath)
    this.db.prepare('DELETE FROM notes WHERE path = ? AND id != ?').run(file.filePath, file.id)
    const insTag = this.db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)')
    for (const t of tagList) {
      insTag.run(file.id, t.toLowerCase())
    }

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
    this.db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(id)
  }

  removeByPath(filePath: string): void {
    if (!this.db) return
    this.db.prepare('DELETE FROM notes WHERE path = ?').run(filePath)
    this.db
      .prepare('DELETE FROM note_tags WHERE note_id IN (SELECT id FROM notes WHERE path = ?)')
      .run(filePath)
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
      // M7.6a (S9): strip FTS5 special chars INCLUDING ':' — a token like
      // `status:active` used to be dropped entirely; now the colon is removed
      // and both halves stay searchable (`status active`).
      .map((t) => t.replace(/["'*()^~{}[\]\\:]/g, '').trim())
      .filter((t) => t.length > 0)
      .slice(0, 12)

    if (terms.length === 0) return []

    // Prefix match each term for partial words (quoted → safe from operators)
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

  /**
   * WB-1: #tag search is a column query against note_tags — every matching
   * note is found regardless of recency (the old path scanned only the 2000
   * most recent rows and silently dropped older matches).
   */
  searchByTag(tag: string, limit = 50): FtsHit[] {
    if (!this.db) return []
    const needle = tag.toLowerCase()
    const rows = this.db
      .prepare(
        `SELECT n.id, n.path, n.relative_path, n.title, n.type, n.tags, n.updated_at
         FROM note_tags nt
         JOIN notes n ON n.id = nt.note_id
         WHERE nt.tag = ?
         ORDER BY n.updated_at DESC
         LIMIT ?`
      )
      .all(needle, limit) as Array<{
      id: string
      path: string
      relative_path: string
      title: string
      type: string
      tags: string
      updated_at: string
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
