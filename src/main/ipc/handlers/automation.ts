import { ipcMain } from 'electron'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { automationEngine, AutomationEngine } from '../../engine/AutomationEngine'
import { readPermissions } from '../../security/Permissions'

export function registerAutomationHandlers(): void {
  ipcMain.handle('automation:get', async () => {
    return {
      enabled: automationEngine.isEnabled(),
      config: automationEngine.getConfig(),
      logs: automationEngine.getLogs(40),
      schedule: automationEngine.getSchedulerInfo()
    }
  })

  ipcMain.handle('automation:save', async (_, config: unknown) => {
    const perms = readPermissions(workspaceEngine.getSettings())
    if (!perms.automation) return { ok: false, error: 'Automation permission disabled' }
    const errs = AutomationEngine.validateConfig(config as never)
    if (errs.length > 0) return { ok: false, error: errs.join('; ') }
    automationEngine.save(config as never)
    return { ok: true }
  })

  ipcMain.handle('automation:setEnabled', async (_, enabled: boolean) => {
    // AE-3: gate enabling on the Automation permission, consistent with
    // automation:save / automation:runRule. Turning OFF is always allowed.
    // The Settings toggle grants the permission itself (WC-4 default-off), so
    // a real user flipping the switch is never blocked by this gate.
    const perms = readPermissions(workspaceEngine.getSettings())
    if (Boolean(enabled) && !perms.automation) {
      return { ok: false, error: 'Automation permission disabled (Settings → Security)' }
    }
    automationEngine.setEnabled(Boolean(enabled))
    return { ok: true }
  })

  ipcMain.handle('automation:runRule', async (_, ruleId: string) => {
    const perms = readPermissions(workspaceEngine.getSettings())
    if (!perms.automation) return { ok: false, error: 'Automation permission disabled' }
    return automationEngine.runManual(ruleId)
  })
}
