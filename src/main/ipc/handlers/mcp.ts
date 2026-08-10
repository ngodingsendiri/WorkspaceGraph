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
   * Live-test a candidate server (add/edit form): AE-6 — registers it in
   * memory only via mcpManager.testServer (no persist+restore round-trip of
   * mcp.json), connects (handshake + tools/list), reports tool count / error,
   * then restores the previous config. The vault config is only touched on Save.
   */
  ipcMain.handle('mcp:testServer', async (_, server: McpServerConfig) => {
    return mcpManager.testServer(server)
  })

  /** All discovered tools across connected servers (flattened, for display). */
  ipcMain.handle('mcp:getTools', async () => {
    return mcpManager.listTools()
  })
}
