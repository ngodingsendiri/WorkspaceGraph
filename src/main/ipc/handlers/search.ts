import { ipcMain } from 'electron'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { indexDatabase } from '../../engine/IndexDatabase'
import { syncWorkspaceData } from '../shared'
import { InternalAPI } from '../../api/InternalAPI'

export function registerSearchHandlers(): void {
  ipcMain.handle('search:query', async (_, options: { query?: string; limit?: number } = {}) => {
    // M8 API-1: route through the stable InternalAPI facade
    return InternalAPI.search(String(options?.query ?? ''), Number(options?.limit) || 20)
  })

  ipcMain.handle('search:recentNotes', async (_, limit: number) => {
    return InternalAPI.searchRecentNotes(Number(limit) || 12)
  })

  ipcMain.handle('search:byTag', async (_, tag: string) => {
    if (typeof tag !== 'string') return []
    return InternalAPI.searchByTag(tag)
  })

  ipcMain.handle('search:getTags', async () => {
    return InternalAPI.getSearchTags()
  })

  ipcMain.handle('search:getStats', async () => {
    return InternalAPI.getIndexStats()
  })

  ipcMain.handle('search:rebuildIndex', async () => {
    const state = workspaceEngine.getState()
    if (!state.rootPath) {
      return { ok: false, error: 'No workspace open', count: 0 }
    }
    if (!indexDatabase.isOpen()) {
      indexDatabase.open(state.rootPath)
    }
    syncWorkspaceData(state.rootPath)
    const stats = InternalAPI.getIndexStats()
    return {
      ok: true,
      count: stats.memoryCount ?? 0
    }
  })
}