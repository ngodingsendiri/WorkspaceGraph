/**
 * R2-2 — Resume stream checkpoints.
 *
 * When a stream ends truncated (user cancel / timeout / provider error) the
 * renderer writes ONE JSON checkpoint per interrupted assistant message under
 * <vault>/.workspacegraph/checkpoints/ (same vault-cache pattern as chats and
 * proposals — Law 009: never a source of truth). The checkpoint captures WHERE
 * the stream stopped (message index + tool round + context token estimate) so
 * the UI can offer "Lanjutkan" and the retry continues from that point instead
 * of restarting the whole invocation.
 *
 * The message content itself already lives in the transcript (saved via
 * saveCurrentChat on truncation), so the checkpoint only needs the stream
 * coordinates + the settings that shaped the interrupted request.
 */
import fs from 'fs'
import path from 'path'
import { workspaceEngine } from '../engine/WorkspaceEngine'

export type CheckpointReason = 'cancelled' | 'timeout' | 'error'

export interface StreamCheckpoint {
  /** `${conversationId}_${messageId}` — sanitized, unique per message. */
  id: string
  conversationId: string
  messageId: string
  /** Index of the interrupted assistant message in the session transcript. */
  messageIndex: number
  /** Tool-loop round where the stream stopped (0 = before/round 0). */
  round: number
  /** Workspace-context token estimate captured at interruption time. */
  contextTokens?: number
  model?: string
  agentRole?: string
  useContext?: boolean
  enableTools?: boolean
  planMode?: boolean
  activeFilePath?: string
  reason: CheckpointReason
  timestamp: string
}

function checkpointsDir(): string | null {
  const root = workspaceEngine.getState().rootPath
  if (!root) return null
  const dir = path.join(root, '.workspacegraph', 'checkpoints')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Only allow safe checkpoint ids (no path traversal). */
function safeCheckpointId(id: string): string | null {
  if (!id || typeof id !== 'string') return null
  const clean = id.trim()
  // conversationId (YYYYMMDD_HHMMSS_xxxx) + messageId (random alphanumeric) —
  // reject anything path-like.
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(clean)) return null
  return clean
}

export function saveCheckpoint(cp: StreamCheckpoint): {
  ok: boolean
  path?: string
  error?: string
} {
  const dir = checkpointsDir()
  if (!dir) return { ok: false, error: 'No workspace open' }
  const clean = safeCheckpointId(cp.id)
  if (!clean) return { ok: false, error: 'Invalid checkpoint id' }
  try {
    const filePath = path.join(dir, `${clean}.json`)
    const rel = path.relative(path.resolve(dir), path.resolve(filePath))
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: 'Invalid checkpoint path' }
    }
    fs.writeFileSync(filePath, JSON.stringify({ ...cp, id: clean }, null, 2), 'utf-8')
    return { ok: true, path: filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function loadCheckpoint(id: string): StreamCheckpoint | null {
  const dir = checkpointsDir()
  if (!dir) return null
  const clean = safeCheckpointId(id)
  if (!clean) return null
  const filePath = path.join(dir, `${clean}.json`)
  const rel = path.relative(path.resolve(dir), path.resolve(filePath))
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StreamCheckpoint
  } catch {
    return null
  }
}

export function listCheckpoints(): StreamCheckpoint[] {
  const dir = checkpointsDir()
  if (!dir) return []
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as StreamCheckpoint
        } catch {
          return null
        }
      })
      .filter((c): c is StreamCheckpoint => c !== null)
  } catch {
    return []
  }
}

export function deleteCheckpoint(id: string): { ok: boolean; error?: string } {
  const dir = checkpointsDir()
  if (!dir) return { ok: false, error: 'No workspace open' }
  const clean = safeCheckpointId(id)
  if (!clean) return { ok: false, error: 'Invalid checkpoint id' }
  const filePath = path.join(dir, `${clean}.json`)
  const rel = path.relative(path.resolve(dir), path.resolve(filePath))
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: 'Invalid checkpoint path' }
  }
  try {
    if (!fs.existsSync(filePath)) return { ok: true } // idempotent
    fs.unlinkSync(filePath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Mirror of the renderer's helper — keeps the two id constructions in sync. */
export function checkpointIdFor(conversationId: string, messageId: string): string {
  const raw = `${conversationId || 'anon'}_${messageId}`
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160)
  return clean || 'cp'
}
