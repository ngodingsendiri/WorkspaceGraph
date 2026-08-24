import { ipcMain, dialog, BrowserWindow } from 'electron'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { graphEngine } from '../../engine/GraphEngine'
import { searchEngine } from '../../engine/SearchEngine'
import { indexDatabase } from '../../engine/IndexDatabase'
import { domainEngine } from '../../engine/DomainEngine'
import { embeddingEngine } from '../../ai/EmbeddingEngine'
import { fileWatcher } from '../../engine/FileWatcher'
import { automationEngine } from '../../engine/AutomationEngine'
import { pluginHost } from '../../plugin/PluginHost'
import { mcpManager } from '../../mcp/McpClientManager'
import { readPermissions } from '../../security/Permissions'
import { syncWorkspaceData, attachFileWatcher, flushWatcherQueue } from '../shared'

/**
 * AE-2: shared vault-open flow for workspace:open and workspace:create.
 * Every engine reset, index kick, watcher attach, and platform load happens
 * here so the two entry points can never drift apart. Workspace creation is
 * also an open, so both fire `workspace_opened` to automation rules.
 */
function openVaultFlow(root: string): void {
  indexDatabase.close()
  graphEngine.clear()
  searchEngine.clear()
  domainEngine.clear()
  embeddingEngine.clear()
  indexDatabase.open(root)
  const state = workspaceEngine.getState()
  // AE-5: expose indexing readiness — stays true until the background index
  // pass finishes; search/graph may be partial while it runs.
  state.indexing = true
  // Fire-and-forget (original behavior): return state immediately, index in
  // background. Errors are logged, and the flag always flips back + notifies.
  syncWorkspaceData(root)
    .catch((err) => {
      console.error('[workspace] index failed:', err)
    })
    .finally(() => {
      const s = workspaceEngine.getState()
      if (s.rootPath === root) {
        // X1: initial index done — flip flag, then apply any file changes that
        // arrived mid-index so none are lost and none raced the full rebuild.
        s.indexing = false
        try {
          flushWatcherQueue()
        } catch (err) {
          console.error('[workspace] flush watcher queue failed:', err)
        }
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue
          win.webContents.send('workspace:updated', workspaceEngine.getState())
        }
      }
    })
  attachFileWatcher(root)
  const perms = readPermissions(workspaceEngine.getSettings())
  automationEngine.load(root)
  automationEngine.setEnabled(perms.automation)
  automationEngine.start()
  pluginHost.setAllowed(perms.plugins)
  pluginHost.load(root)
  if (perms.automation) {
    automationEngine.handleEvent('workspace_opened')
  }
  // R0-1: connect enabled MCP servers for this vault (fire-and-forget — a
  // dead server must not block vault open; Settings shows the error).
  mcpManager.connectAll()
  // Load persisted vectors, then background-index only new/changed files
  const db = indexDatabase.getDb()
  embeddingEngine
    .init()
    .then(() => {
      if (db) embeddingEngine.loadFromDb(db)
      return embeddingEngine.indexVaultBackground(root, db)
    })
    .catch(() => {})
}

export function registerWorkspaceHandlers(): void {
  // --- Dialog Handlers ---
  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0]
    }
    return null
  })

  // --- Workspace Handlers ---
  ipcMain.handle('workspace:open', async (_, folderPath: string) => {
    if (!folderPath || typeof folderPath !== 'string') {
      throw new Error('Invalid workspace path')
    }
    const state = workspaceEngine.openWorkspace(folderPath)
    const root = state.rootPath
    if (!root) throw new Error('Failed to open workspace')
    openVaultFlow(root)
    return state
  })

  ipcMain.handle(
    'workspace:create',
    async (_, { parentPath, name }: { parentPath: string; name: string }) => {
      if (!parentPath || !name || typeof parentPath !== 'string' || typeof name !== 'string') {
        throw new Error('Invalid parent path or workspace name')
      }
      // Reject path separators in name to avoid nested create surprises
      if (/[/\\]/.test(name) || name === '.' || name === '..') {
        throw new Error('Invalid workspace name')
      }
      const state = workspaceEngine.createWorkspace(parentPath, name)
      if (state.rootPath) openVaultFlow(state.rootPath)
      return state
    }
  )

  ipcMain.handle('workspace:close', async () => {
    fileWatcher.stop()
    indexDatabase.close()
    automationEngine.stop()
    automationEngine.unload()
    pluginHost.unload()
    mcpManager.disconnectAll()
    graphEngine.clear()
    searchEngine.clear()
    domainEngine.clear()
    embeddingEngine.clear()
    workspaceEngine.closeWorkspace()
    return true
  })

  ipcMain.handle('workspace:getState', async () => {
    return workspaceEngine.getState()
  })

  ipcMain.handle('workspace:getRecent', async () => {
    return workspaceEngine.getRecentWorkspaces()
  })
}
