import { ipcMain } from 'electron'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { automationEngine } from '../../engine/AutomationEngine'
import { pluginHost } from '../../plugin/PluginHost'
import { readPermissions } from '../../security/Permissions'
import { scrubSettingsSecrets, mergeSettingsPreservingSecrets } from '../../security/SecretsStore'
import { logAudit } from '../../security/AuditLog'
import { createBackup, listBackups } from '../../security/Backup'
import { loadSettingsIntoProviders } from '../shared'

export function registerSettingsHandlers(): void {
  /**
   * Renderer NEVER receives real API keys — only scrubbed settings with apiKeySet flags.
   * A new key is only accepted when the user explicitly types one via ai:configure;
   * the stored key is never shipped to the renderer (not even on demand).
   */
  ipcMain.handle('settings:get', async () => {
    return scrubSettingsSecrets(workspaceEngine.getSettings())
  })

  ipcMain.handle('settings:save', async (_, settings: Record<string, unknown>) => {
    // Merge over stored settings so scrubbed apiKey:'' from renderer never wipes real keys
    const merged = mergeSettingsPreservingSecrets(workspaceEngine.getSettings(), settings)
    workspaceEngine.saveSettings(merged)
    const perms = readPermissions(merged)
    automationEngine.setEnabled(perms.automation)
    pluginHost.setAllowed(perms.plugins)
    loadSettingsIntoProviders()
    // M8.5 (SEC-1): settings changes are security-relevant — audit them
    try {
      logAudit({
        kind: 'settings_changed',
        target: Object.keys(settings).sort().join(','),
        status: 'ok'
      })
    } catch {
      /* audit best-effort */
    }
    return true
  })

  // M8.6 (SEC-2): manual vault backup + checksum manifest
  ipcMain.handle('backup:create', async () => {
    const root = workspaceEngine.getState().rootPath
    if (!root) return { ok: false, error: 'No workspace open' }
    const res = createBackup(root)
    if (res.ok) {
      logAudit({
        kind: 'backup_created',
        target: res.dir,
        status: 'ok'
      })
    }
    return res
  })

  ipcMain.handle('backup:list', async () => {
    const root = workspaceEngine.getState().rootPath
    if (!root) return []
    return listBackups(root)
  })
}
