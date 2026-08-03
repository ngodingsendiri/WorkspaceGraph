import { ipcMain } from 'electron'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { domainEngine } from '../../engine/DomainEngine'
import { refreshDomainFromDisk } from '../shared'

export function registerDomainHandlers(): void {
  ipcMain.handle('domain:overview', async () => {
    const root = workspaceEngine.getState().rootPath
    if (root) refreshDomainFromDisk(root)
    return domainEngine.getOverview()
  })

  ipcMain.handle('domain:list', async (_, type: string) => {
    return domainEngine.listByType(type as never)
  })
}
