/**
 * Security/audit event log (M8.5 / SEC-1, spec 33).
 *
 * Security-relevant operations append ONE JSON line to
 *     <vault>/.workspacegraph/logs/audit.jsonl
 *
 * Covered: settings changes, plugin load/run/permission grant-revoke,
 * MCP config changes, permission denials, automation enable/disable.
 * NOT covered: AI streams (see AIEventLog) — kept separate so security
 * review never wades through token/cost telemetry.
 *
 * Same safety contract as AIEventLog: logging NEVER breaks the caller —
 * every path is try/catch-swallowed; no open vault → no-op. Rotation via
 * the shared rotateAIEventLog helper (5 MB × 5 files).
 */
import fs from 'fs'
import path from 'path'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { aiEventsDir } from '../ai/AIEventLog'

export type AuditKind =
  | 'settings_changed'
  | 'plugin_loaded'
  | 'plugin_command'
  | 'plugin_permission_revoked'
  | 'mcp_config_changed'
  | 'automation_config_changed'
  | 'permission_denied'
  | 'secret_decrypt_failed'
  | 'backup_created'

export interface AuditEvent {
  ts: string
  kind: AuditKind
  /** Free-form detail: which setting/file/plugin/rule was touched */
  target?: string
  status?: 'ok' | 'denied' | 'error'
  error?: string
}

const AUDIT_FILE = 'audit.jsonl'
const AUDIT_MAX_BYTES = 5 * 1024 * 1024
const AUDIT_KEEP = 3

function auditFile(root: string): string {
  return path.join(aiEventsDir(root), AUDIT_FILE)
}

/** Size-based rotation: audit.jsonl → audit.1.jsonl → … (keep AUDIT_KEEP). */
function rotateAuditLog(file: string): void {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < AUDIT_MAX_BYTES) return
    for (let i = AUDIT_KEEP - 1; i >= 1; i--) {
      const from = i === 1 ? file : file.replace('.jsonl', `.${i - 1}.jsonl`)
      const to = file.replace('.jsonl', `.${i}.jsonl`)
      if (fs.existsSync(from)) fs.renameSync(from, to)
    }
  } catch {
    /* rotation best-effort */
  }
}

/** Append one audit line; never throws. No vault open → no-op. */
export function logAudit(ev: Omit<AuditEvent, 'ts'>): void {
  try {
    const root = workspaceEngine.getState().rootPath
    if (!root) return
    const dir = aiEventsDir(root)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = auditFile(root)
    rotateAuditLog(file)
    const line = JSON.stringify({ ...ev, ts: new Date().toISOString() }) + '\n'
    fs.appendFileSync(file, line, 'utf-8')
  } catch {
    /* audit must never break the caller */
  }
}

/** Read recent audit events (newest first). Never throws. */
export function readAuditLog(limit = 100): AuditEvent[] {
  try {
    const root = workspaceEngine.getState().rootPath
    if (!root) return []
    const file = auditFile(root)
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l) as AuditEvent
        } catch {
          return null
        }
      })
      .filter((e): e is AuditEvent => e !== null)
  } catch {
    return []
  }
}
