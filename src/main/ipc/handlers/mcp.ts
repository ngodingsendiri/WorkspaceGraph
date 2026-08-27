import { ipcMain } from 'electron'
import { mcpManager, type McpServerConfig } from '../../mcp/McpClientManager'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { readPermissions } from '../../security/Permissions'
import { logAudit } from '../../security/AuditLog'
import { validateArrayOf, validateShape, type FieldSpec } from '../../api/ipcValidation'

const MCP_SERVER_SHAPE: Record<string, FieldSpec> = {
  id: { type: 'string' },
  name: { type: 'string' },
  command: { type: 'string', optional: true },
  args: { type: 'array', optional: true },
  enabled: { type: 'boolean', optional: true },
  env: { type: 'object', optional: true },
  url: { type: 'string', optional: true }
}

/**
 * R0-1 — MCP server registry IPC. Settings → MCP drives these; the agent side
 * reads the same singleton (AgentTools routes `mcp__` calls through it).
 *
 * M8.1 (MCP-2 / ADR-0006): mutating handlers + auto-connect are gated behind
 * the `aiTools` permission — a vault from an untrusted source must not spawn
 * arbitrary processes just by being opened.
 *
 * M8.2 (MCP-3): env secrets never leave the main process — getServers
 * returns configs with env values REDACTED; the full values stay disk-side
 * only for the child-process spawn.
 */

/** Redact env values before sending configs to the renderer. */
function redactEnv(servers: McpServerConfig[]): McpServerConfig[] {
  return servers.map((s) =>
    s.env && Object.keys(s.env).length > 0
      ? { ...s, env: { __redacted: 'true' } as Record<string, string> }
      : s
  )
}

function mcpAllowed(): boolean {
  try {
    return readPermissions(workspaceEngine.getSettings() as never).aiTools === true
  } catch {
    return false
  }
}

export function registerMcpHandlers(): void {
  /** Config + live statuses. Best-effort connects enabled servers so tool
   * counts and errors are visible without a manual "connect" click.
   * M8.2: env redacted in the response. */
  ipcMain.handle('mcp:getServers', async () => {
    const servers = redactEnv(mcpManager.getServers())
    const statuses = await mcpManager.ensureConnected().catch(() => mcpManager.getStatus())
    return { servers, statuses }
  })

  /** Persist the full server list, then reconnect so statuses are fresh.
   * M8.1 (ADR-0006): gated on aiTools + array-validated (MCP-1). The client
   * sends back the redacted env shape — preserve existing real env values
   * server-side instead of trusting the renderer round-trip. */
  ipcMain.handle('mcp:saveServers', async (_, servers: unknown) => {
    const checked = validateArrayOf<McpServerConfig>(servers, MCP_SERVER_SHAPE)
    if (!checked.ok) {
      return { ok: false, error: `Invalid payload: ${checked.error}` }
    }
    if (!mcpAllowed()) {
      // M8.5 (SEC-1): denied MCP config writes are audited
      logAudit({
        kind: 'permission_denied',
        target: 'mcp:saveServers',
        status: 'denied'
      })
      return { ok: false, error: 'MCP dinonaktifkan — aktifkan AI Tools di Settings → Security' }
    }
    // Merge: keep the REAL env of existing servers; honor new env from the
    // form only when it carries non-redacted values.
    const prev = mcpManager.getServers()
    const merged = checked.value.map((s) => {
      const old = prev.find((p) => p.id === s.id)
      const redactedSent =
        s.env &&
        typeof s.env === 'object' &&
        (s.env as Record<string, unknown>).__redacted === 'true'
      if (old && (!s.env || redactedSent)) return { ...s, env: old.env }
      return s
    })
    const res = mcpManager.saveServers(merged)
    if (!res.ok) return { ok: false, error: res.error }
    // M8.5 (SEC-1): MCP config changes spawn processes — always audited
    logAudit({
      kind: 'mcp_config_changed',
      target: merged.map((s) => s.id).join(','),
      status: 'ok'
    })
    const statuses = await mcpManager.ensureConnected().catch(() => mcpManager.getStatus())
    return { ok: true, statuses }
  })

  /**
   * Live-test a candidate server (add/edit form): AE-6 — registers it in
   * memory only via mcpManager.testServer (no persist+restore round-trip of
   * mcp.json), connects (handshake + tools/list), reports tool count / error,
   * then restores the previous config. The vault config is only touched on Save.
   * M8.1: gated on aiTools (spawns an arbitrary process).
   */
  ipcMain.handle('mcp:testServer', async (_, server: unknown) => {
    const checked = validateShape<McpServerConfig>(server, {
      id: { type: 'string' },
      name: { type: 'string' },
      command: { type: 'string', optional: true },
      url: { type: 'string', optional: true },
      args: { type: 'array', optional: true },
      env: { type: 'object', optional: true },
      enabled: { type: 'boolean', optional: true }
    })
    if (!checked.ok) {
      return { ok: false, error: `Invalid server config: ${checked.error}` }
    }
    if (!mcpAllowed()) {
      return { ok: false, error: 'MCP dinonaktifkan — aktifkan AI Tools di Settings → Security' }
    }
    return mcpManager.testServer(checked.value)
  })

  /** All discovered tools across connected servers (flattened, for display). */
  ipcMain.handle('mcp:getTools', async () => {
    return mcpManager.listTools()
  })
}
