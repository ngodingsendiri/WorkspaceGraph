import { ipcMain } from 'electron'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { refreshDomainFromDisk } from '../shared'
import { InternalAPI } from '../../api/InternalAPI'

export function registerDomainHandlers(): void {
  ipcMain.handle('domain:overview', async () => {
    const root = workspaceEngine.getState().rootPath
    if (root) refreshDomainFromDisk(root)
    return InternalAPI.getDomainOverview()
  })

  ipcMain.handle('domain:list', async (_, type: string) => {
    return InternalAPI.listDomain(String(type ?? ''))
  })

  // M4b.4: people linked to a note (dead code wired to UI)
  ipcMain.handle('domain:peopleLinkedTo', async (_, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') return []
    return InternalAPI.peopleLinkedTo(filePath)
  })
}