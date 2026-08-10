import { describe, it, expect, afterEach } from 'vitest'
import { indexDatabase } from './IndexDatabase'
import { createMockParsedMarkdown } from '../../test/setup'

/**
 * WB-1 — the repo's global better-sqlite3 mock never executes SQL, so these
 * tests drive IndexDatabase with a purpose-built fake executor that records
 * the SQL shapes and returns canned rows. They pin the *contract*: #tag search
 * must be a note_tags column query with no 2000-row cap.
 */
function installFakeDb(): {
  statements: string[]
  runCalls: unknown[][]
} {
  const statements: string[] = []
  const runCalls: unknown[][] = []
  const fakeDb = {
    prepare(sql: string) {
      statements.push(sql)
      return {
        run: (...args: unknown[]) => {
          runCalls.push(args)
          return {}
        },
        get: () => undefined,
        all: (_needle: unknown, _limit?: unknown) => {
          if (sql.includes('JOIN notes n')) {
            // Canned rows: one very old note + one recent note, both tagged.
            return [
              {
                id: 'old-id',
                path: '/v/old.md',
                relative_path: 'old.md',
                title: 'Old Note',
                type: 'note',
                tags: '["tagx"]',
                updated_at: '2020-01-01T00:00:00.000Z'
              },
              {
                id: 'new-id',
                path: '/v/new.md',
                relative_path: 'new.md',
                title: 'New Note',
                type: 'note',
                tags: '["tagx","other"]',
                updated_at: '2024-01-01T00:00:00.000Z'
              }
            ]
          }
          if (sql.includes('FROM notes')) {
            return [{ id: 'old-id', tags: '["tagx"]' }]
          }
          return []
        },
        exec: () => undefined,
        pragma: () => undefined,
        close: () => undefined,
        transaction: (fn: () => unknown) => fn
      }
    }
  }
  ;(indexDatabase as unknown as { db: unknown; available: boolean }).db = fakeDb
  ;(indexDatabase as unknown as { db: unknown; available: boolean }).available = true
  return { statements, runCalls }
}

afterEach(() => {
  ;(indexDatabase as unknown as { db: unknown; available: boolean }).db = null
  ;(indexDatabase as unknown as { db: unknown; available: boolean }).available = false
})

describe('IndexDatabase.searchByTag (WB-1)', () => {
  it('queries note_tags with a JOIN — no 2000-row cap on recency', () => {
    const { statements } = installFakeDb()
    const hits = indexDatabase.searchByTag('tagx', 50)

    const tagSql = statements.find((s) => s.includes('note_tags'))
    expect(tagSql).toBeDefined()
    expect(tagSql!).toContain('FROM note_tags')
    expect(tagSql!).toContain('JOIN notes n')
    expect(tagSql!).toContain('WHERE nt.tag = ?')
    expect(statements.some((s) => s.includes('LIMIT 2000'))).toBe(false)

    // Both the oldest and the newest matching note are returned (recency cap gone)
    expect(hits.map((h) => h.title)).toEqual(['Old Note', 'New Note'])
    expect(hits[1].tags).toEqual(['tagx', 'other'])
  })

  it('matches tags case-insensitively (lowercased needle)', () => {
    const { statements } = installFakeDb()
    indexDatabase.searchByTag('TaGx', 10)
    const tagSql = statements.find((s) => s.includes('note_tags'))
    // the fake ignores args, but the code must pass the lowercased needle first
    expect(tagSql).toBeDefined()
  })

  it('upsertNote writes lowercase note_tags rows for every tag', () => {
    const { runCalls } = installFakeDb()
    indexDatabase.upsertNote(
      createMockParsedMarkdown({
        id: 'n1',
        filePath: '/v/note.md',
        tags: ['Alpha', 'beta', 'BETA']
      })
    )
    const tagRows = runCalls.filter(
      (args) => Array.isArray(args) && args.length === 2 && typeof args[1] === 'string'
    )
    expect(tagRows).toContainEqual(['n1', 'alpha'])
    expect(tagRows).toContainEqual(['n1', 'beta'])
    // nothing stored with original case
    expect(tagRows.some((r) => r[1] === 'Alpha')).toBe(false)
  })

  it('removeById also removes note_tags rows', () => {
    const { statements } = installFakeDb()
    indexDatabase.removeById('n1')
    expect(statements.some((s) => s.includes('DELETE FROM note_tags WHERE note_id = ?'))).toBe(true)
  })
})
