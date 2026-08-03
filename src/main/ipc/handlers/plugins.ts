import { ipcMain } from 'electron'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { pluginHost } from '../../plugin/PluginHost'
import { InternalAPI } from '../../api/InternalAPI'
import { readPermissions } from '../../security/Permissions'
import { isEncryptedForm } from '../../security/SecretsStore'

export function registerPluginsHandlers(): void {
  ipcMain.handle('plugins:list', async () => {
    return InternalAPI.getPlugins()
  })

  ipcMain.handle('plugins:commands', async () => {
    return InternalAPI.getPluginCommands()
  })

  ipcMain.handle('plugins:reload', async () => {
    const root = workspaceEngine.getState().rootPath
    if (!root) return { ok: false }
    const perms = readPermissions(workspaceEngine.getSettings())
    pluginHost.setAllowed(perms.plugins)
    pluginHost.load(root)
    return { ok: true, count: pluginHost.list().length }
  })

  // --- Platform API health ---
  ipcMain.handle('api:health', async () => {
    return InternalAPI.health()
  })

  ipcMain.handle('security:status', async () => {
    const settings = workspaceEngine.getSettings()
    const raw = workspaceEngine.getSettingsRaw()
    const ai = (raw.ai || {}) as Record<string, { apiKey?: string }>
    const keyStatus: Record<string, string> = {}
    for (const [id, cfg] of Object.entries(ai)) {
      if (!cfg?.apiKey) keyStatus[id] = 'empty'
      else if (isEncryptedForm(cfg.apiKey)) keyStatus[id] = 'encrypted'
      else if (String(cfg.apiKey).startsWith('plain:')) keyStatus[id] = 'plaintext-fallback'
      else keyStatus[id] = 'legacy-plaintext'
    }
    return {
      permissions: readPermissions(settings),
      secrets: keyStatus,
      encryptionAvailable: (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { safeStorage } = require('electron')
          return safeStorage.isEncryptionAvailable()
        } catch {
          return false
        }
      })()
    }
  })
}
