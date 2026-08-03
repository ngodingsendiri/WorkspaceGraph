import { ipcMain } from 'electron'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { automationEngine } from '../../engine/AutomationEngine'
import { readPermissions } from '../../security/Permissions'

export function registerAutomationHandlers(): void {
  ipcMain.handle('automation:get', async () => {
    return {
      enabled: automationEngine.isEnabled(),
      config: automationEngine.getConfig(),
      logs: automationEngine.getLogs(40)
    }
  })

  ipcMain.handle('automation:save', async (_, config: unknown) => {
    const perms = readPermissions(workspaceEngine.getSettings())
    if (!perms.automation) return { ok: false, error: 'Automation permission disabled' }
    automationEngine.save(config as never)
    return { ok: true }
  })

  ipcMain.handle('automation:setEnabled', async (_, enabled: boolean) => {
    automationEngine.setEnabled(Boolean(enabled))
    return true
  })

  ipcMain.handle('automation:runRule', async (_, ruleId: string) => {
    const perms = readPermissions(workspaceEngine.getSettings())
    if (!perms.automation) return { ok: false, error: 'Automation permission disabled' }
    return automationEngine.runManual(ruleId)
  })
}
