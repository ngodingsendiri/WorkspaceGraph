import { ipcMain, dialog } from 'electron'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { graphEngine } from '../../engine/GraphEngine'
import { searchEngine } from '../../engine/SearchEngine'
import { indexDatabase } from '../../engine/IndexDatabase'
import { domainEngine } from '../../engine/DomainEngine'
import { embeddingEngine } from '../../ai/EmbeddingEngine'
import { fileWatcher } from '../../engine/FileWatcher'
import { automationEngine } from '../../engine/AutomationEngine'
import { pluginHost } from '../../plugin/PluginHost'
import { readPermissions } from '../../security/Permissions'
import { syncWorkspaceData, attachFileWatcher } from '../shared'

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
    indexDatabase.close()
    graphEngine.clear()
    searchEngine.clear()
    domainEngine.clear()
    embeddingEngine.clear()
    const state = workspaceEngine.openWorkspace(folderPath)
    const root = state.rootPath
    if (!root) throw new Error('Failed to open workspace')
    indexDatabase.open(root)
    // Fire-and-forget (original behavior): return state immediately, index in background
    syncWorkspaceData(root)
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
    // Load persisted vectors, then background-index only new/changed files
    const db = indexDatabase.getDb()
    embeddingEngine
      .init()
      .then(() => {
        if (db) embeddingEngine.loadFromDb(db)
        return embeddingEngine.indexVaultBackground(root, db)
      })
      .catch(() => {})
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
      if (state.rootPath) {
        indexDatabase.close()
        graphEngine.clear()
        searchEngine.clear()
        domainEngine.clear()
        embeddingEngine.clear()
        indexDatabase.open(state.rootPath)
        // Fire-and-forget (original behavior): return state immediately, index in background
        syncWorkspaceData(state.rootPath)
        attachFileWatcher(state.rootPath)
        const perms = readPermissions(workspaceEngine.getSettings())
        automationEngine.load(state.rootPath)
        automationEngine.setEnabled(perms.automation)
        automationEngine.start()
        pluginHost.setAllowed(perms.plugins)
        pluginHost.load(state.rootPath)
        const db = indexDatabase.getDb()
        embeddingEngine
          .init()
          .then(() => {
            if (db) embeddingEngine.loadFromDb(db)
            return embeddingEngine.indexVaultBackground(state.rootPath!, db)
          })
          .catch(() => {})
      }
      return state
    }
  )

  ipcMain.handle('workspace:close', async () => {
    fileWatcher.stop()
    indexDatabase.close()
    automationEngine.stop()
    automationEngine.unload()
    pluginHost.unload()
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
