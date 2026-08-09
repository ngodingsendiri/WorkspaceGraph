/**
 * Persist AI chat transcripts under vault cache (not SoT — Law 009).
 * Path: <vault>/.workspacegraph/chats/
 */
import fs from 'fs'
import path from 'path'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { atomicWriteJson, quarantineCorruptFile } from '../utils/quarantine'

export interface StoredMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  citations?: { title: string; path: string }[]
  /** Grounding check persisted alongside citations so reloads keep the ⚠ hints. */
  verifications?: { path: string; title: string; supported: boolean; score: number }[]
  /** Attached images (vision) — kept for thumbnails in loaded history. */
  images?: { mimeType: string; dataBase64: string; name?: string }[]
}

export interface StoredConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  agentRole?: string
  messages: StoredMessage[]
}

function chatsDir(): string | null {
  const root = workspaceEngine.getState().rootPath
  if (!root) return null
  const dir = path.join(root, '.workspacegraph', 'chats')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Only allow safe conversation ids (no path traversal). */
function safeConversationId(id: string): string | null {
  if (!id || typeof id !== 'string') return null
  const clean = id.trim()
  // IDs are generated as YYYYMMDD_HHMMSS_xxxx — reject anything path-like
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(clean)) return null
  return clean
}

/** Minimal shape guard — a foreign/corrupt JSON in chats/ must never surface
 * as a conversation (an empty/undefined messages array would render a broken
 * chat). True when the file has the base conversation contract. */
function isStoredConversation(c: unknown): c is StoredConversation {
  if (!c || typeof c !== 'object') return false
  const x = c as Record<string, unknown>
  return typeof x.id === 'string' && Array.isArray(x.messages)
}

export function saveConversation(conv: StoredConversation): {
  ok: boolean
  path?: string
  error?: string
} {
  const dir = chatsDir()
  if (!dir) return { ok: false, error: 'No workspace open' }
  const clean = safeConversationId(conv.id)
  if (!clean) return { ok: false, error: 'Invalid conversation id' }
  try {
    const filePath = path.join(dir, `${clean}.json`)
    const rel = path.relative(path.resolve(dir), path.resolve(filePath))
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: 'Invalid conversation path' }
    }
    // Atomic write — a crash mid-save never leaves a half-written chat
    atomicWriteJson(filePath, { ...conv, id: clean })
    return { ok: true, path: filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function listConversations(limit = 30): StoredConversation[] {
  const dir = chatsDir()
  if (!dir) return []
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, limit)

    return files
      .map((f) => {
        try {
          const parsed = JSON.parse(fs.readFileSync(f, 'utf-8')) as unknown
          return isStoredConversation(parsed) ? parsed : null
        } catch {
          // Corrupt chat file: quarantine it (preserved for inspection, removed
          // from the list) so the store self-heals instead of silently dropping
          // the data with no trace.
          quarantineCorruptFile(f)
          return null
        }
      })
      .filter((c): c is StoredConversation => c !== null)
  } catch {
    return []
  }
}

export function loadConversation(id: string): StoredConversation | null {
  const dir = chatsDir()
  if (!dir) return null
  const clean = safeConversationId(id)
  if (!clean) return null
  const filePath = path.join(dir, `${clean}.json`)
  // Defense-in-depth: resolved path must stay under chats dir
  const rel = path.relative(path.resolve(dir), path.resolve(filePath))
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  if (!fs.existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown
    return isStoredConversation(parsed) ? parsed : null
  } catch {
    quarantineCorruptFile(filePath)
    return null
  }
}

export function deleteConversation(id: string): { ok: boolean; error?: string } {
  const dir = chatsDir()
  if (!dir) return { ok: false, error: 'No workspace open' }
  const clean = safeConversationId(id)
  if (!clean) return { ok: false, error: 'Invalid conversation id' }
  const filePath = path.join(dir, `${clean}.json`)
  const rel = path.relative(path.resolve(dir), path.resolve(filePath))
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: 'Invalid conversation path' }
  }
  try {
    if (!fs.existsSync(filePath)) return { ok: true } // idempotent
    fs.unlinkSync(filePath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function newConversationId(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${Math.random().toString(36).slice(2, 6)}`
}
