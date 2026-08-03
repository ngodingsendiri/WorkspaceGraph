import { ipcMain } from 'electron'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { automationEngine } from '../../engine/AutomationEngine'
import { pluginHost } from '../../plugin/PluginHost'
import { readPermissions } from '../../security/Permissions'
import { scrubSettingsSecrets, mergeSettingsPreservingSecrets } from '../../security/SecretsStore'
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
    return true
  })
}
