import { ipcMain } from 'electron'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { searchEngine } from '../../engine/SearchEngine'
import { indexDatabase } from '../../engine/IndexDatabase'
import { syncWorkspaceData } from '../shared'

export function registerSearchHandlers(): void {
  ipcMain.handle('search:query', async (_, options) => {
    return searchEngine.search(options)
  })

  ipcMain.handle('search:recentNotes', async (_, limit: number) => {
    return searchEngine.getRecentFiles(limit)
  })

  ipcMain.handle('search:byTag', async (_, tag: string) => {
    return searchEngine.searchByTag(tag)
  })

  ipcMain.handle('search:getTags', async () => {
    return searchEngine.getAllTags()
  })

  ipcMain.handle('search:getStats', async () => {
    return searchEngine.getIndexStats()
  })

  ipcMain.handle('search:rebuildIndex', async () => {
    const state = workspaceEngine.getState()
    if (!state.rootPath) {
      return { ok: false, error: 'No workspace open', count: 0 }
    }
    if (!indexDatabase.isOpen()) {
      indexDatabase.open(state.rootPath)
    }
    // Full rescan from disk → memory + sqlite (keep original fire-and-forget timing)
    syncWorkspaceData(state.rootPath)
    const stats = searchEngine.getIndexStats()
    return {
      ok: true,
      count: stats.sqlite.count || stats.memoryCount,
      path: stats.sqlite.path,
      lastRebuild: stats.sqlite.lastRebuild
    }
  })
}
