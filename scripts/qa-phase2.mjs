/**
 * Phase 2 QA: IndexDatabase FTS + Search hybrid operators + Context structure
 * Run: node scripts/qa-phase2.mjs
 */
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const require = createRequire(import.meta.url)

let failed = 0
let passed = 0
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    failed++
  } else {
    console.log('OK  ', msg)
    passed++
  }
}

async function main() {
  // --- better-sqlite3 native ---
  let Database
  try {
    Database = require('better-sqlite3')
    assert(true, 'better-sqlite3 loads')
  } catch (e) {
    assert(false, 'better-sqlite3 loads: ' + e.message)
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(1)
  }

  const tmp = path.join(os.tmpdir(), `wg-p2-${Date.now()}`)
  fs.mkdirSync(path.join(tmp, '.workspacegraph'), { recursive: true })
  const dbPath = path.join(tmp, '.workspacegraph', 'index.db')
  const db = new Database(dbPath)
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
  ins.run(
    'a1',
    path.join(tmp, 'Knowledge', 'Alpha.md'),
    'Knowledge/Alpha.md',
    'Alpha',
    'Pegawai cuti tahunan dan SOP kepegawaian Diskominfo',
    '["pegawai","cuti"]',
    'knowledge',
    'Alpha',
    '{}',
    '2026-07-21'
  )
  ins.run(
    'b1',
    path.join(tmp, 'SOP', 'Cuti.md'),
    'SOP/Cuti.md',
    'SOP Cuti',
    'Prosedur cuti ASN sesuai BKN',
    '["sop"]',
    'sop',
    'SOP Cuti',
    '{}',
    '2026-07-20'
  )
  ins.run(
    'c1',
    path.join(tmp, 'Knowledge', 'Beta.md'),
    'Knowledge/Beta.md',
    'Beta',
    'Graph and wiki links unrelated text',
    '[]',
    'note',
    'Beta',
    '{}',
    '2026-07-19'
  )

  const hits = db
    .prepare(
      `SELECT n.title FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
       WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT 5`
    )
    .all('"cuti"*')
  assert(hits.length >= 2, `FTS cuti finds >=2 got ${hits.length}`)
  assert(
    hits.some(h => h.title.includes('Cuti') || h.title === 'Alpha'),
    'FTS ranks cuti-related notes'
  )

  const count = db.prepare('SELECT COUNT(*) as c FROM notes').get().c
  assert(count === 3, '3 notes indexed')

  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })

  // --- Source wiring ---
  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8')
  assert(ipc.includes('indexDatabase.open'), 'IPC opens index.db')
  assert(ipc.includes('search:rebuildIndex'), 'IPC rebuild index')
  assert(ipc.includes('search:getStats'), 'IPC index stats')

  const se = fs.readFileSync(path.join(root, 'src/main/engine/SearchEngine.ts'), 'utf8')
  assert(se.includes('searchFts') || se.includes('indexDatabase'), 'SearchEngine hybrid FTS')
  assert(se.includes('searchBacklinks') && se.includes('backlinks:'), 'backlink operator')
  assert(se.includes('path:'), 'path operator')

  const ctx = fs.readFileSync(path.join(root, 'src/main/ai/ContextEngine.ts'), 'utf8')
  assert(ctx.includes('tokenBudget') || ctx.includes('TOKEN_BUDGET'), 'token budget')
  assert(ctx.includes('backlink') && ctx.includes('getBacklinks'), 'context backlinks')
  assert(ctx.includes('getSystemFolderNotes') || ctx.includes('system'), 'system folder include')
  assert(ctx.includes('tokenEstimate'), 'token estimate in package')

  const idb = fs.readFileSync(path.join(root, 'src/main/engine/IndexDatabase.ts'), 'utf8')
  assert(idb.includes('index.db') && idb.includes('fts5'), 'IndexDatabase FTS5 file')

  const pre = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
  assert(pre.includes('rebuildSearchIndex') && pre.includes('getSearchStats'), 'preload index APIs')

  const set = fs.readFileSync(path.join(root, 'src/renderer/src/components/settings/SettingsView.tsx'), 'utf8')
  assert(set.includes('Rebuild index') || set.includes('rebuildSearchIndex'), 'settings rebuild UI')

  const vite = fs.readFileSync(path.join(root, 'electron.vite.config.ts'), 'utf8')
  assert(vite.includes('better-sqlite3'), 'vite externalizes better-sqlite3')

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
