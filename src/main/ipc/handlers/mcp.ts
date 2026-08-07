import { ipcMain } from 'electron'
import { mcpManager, type McpServerConfig } from '../../mcp/McpClientManager'

/**
 * R0-1 — MCP server registry IPC. Settings → MCP drives these; the agent side
 * reads the same singleton (AgentTools routes `mcp__` calls through it).
 */
export function registerMcpHandlers(): void {
  /** Config + live statuses. Best-effort connects enabled servers so tool
   * counts and errors are visible without a manual "connect" click. */
  ipcMain.handle('mcp:getServers', async () => {
    const servers = mcpManager.getServers()
    const statuses = await mcpManager.ensureConnected().catch(() => mcpManager.getStatus())
    return { servers, statuses }
  })

  /** Persist the full server list, then reconnect so statuses are fresh. */
  ipcMain.handle('mcp:saveServers', async (_, servers: McpServerConfig[]) => {
    const res = mcpManager.saveServers(servers)
    if (!res.ok) return { ok: false, error: res.error }
    const statuses = await mcpManager.ensureConnected().catch(() => mcpManager.getStatus())
    return { ok: true, statuses }
  })

  /**
   * Live-test a candidate server (add/edit form): registers it temporarily,
   * connects (handshake + tools/list), reports tool count / error, then
   * restores the previous config — the vault config is only touched on Save.
   */
  ipcMain.handle('mcp:testServer', async (_, server: McpServerConfig) => {
    const prev = mcpManager.getServers()
    const id = server.id
    try {
      const save = mcpManager.saveServers([...prev.filter((s) => s.id !== id), server])
      if (!save.ok) return { ok: false, error: save.error }
      await mcpManager.ensureConnected([id])
      const status = mcpManager.getStatus().find((s) => s.id === id)
      return {
        ok: status?.connected === true,
        tools: status?.tools ?? 0,
        error: status?.error
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await mcpManager.disconnect(id)
      mcpManager.saveServers(prev)
    }
  })

  /** All discovered tools across connected servers (flattened, for display). */
  ipcMain.handle('mcp:getTools', async () => {
    return mcpManager.listTools()
  })
}
