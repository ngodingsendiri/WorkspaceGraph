/**
 * Persist AI chat transcripts under vault cache (not SoT — Law 009).
 * Path: <vault>/.workspacegraph/chats/
 */
import fs from 'fs'
import path from 'path'
import { workspaceEngine } from '../engine/WorkspaceEngine'

export interface StoredMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  citations?: { title: string; path: string }[]
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

export function saveConversation(conv: StoredConversation): {
  ok: boolean
  path?: string
  error?: string
} {
  const dir = chatsDir()
  if (!dir) return { ok: false, error: 'No workspace open' }
  try {
    const filePath = path.join(dir, `${conv.id}.json`)
    fs.writeFileSync(filePath, JSON.stringify(conv, null, 2), 'utf-8')
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
          return JSON.parse(fs.readFileSync(f, 'utf-8')) as StoredConversation
        } catch {
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
  const filePath = path.join(dir, `${id}.json`)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StoredConversation
  } catch {
    return null
  }
}

export function newConversationId(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${Math.random().toString(36).slice(2, 6)}`
}
