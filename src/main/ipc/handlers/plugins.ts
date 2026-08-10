import { ipcMain } from 'electron'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { pluginHost } from '../../plugin/PluginHost'
import { InternalAPI } from '../../api/InternalAPI'
import { readPermissions } from '../../security/Permissions'
import { isEncryptedForm, decryptSecret } from '../../security/SecretsStore'

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

  ipcMain.handle(
    'plugins:runCommand',
    async (_, payload: { pluginId: string; commandId: string; args?: Record<string, unknown> }) => {
      const perms = readPermissions(workspaceEngine.getSettings())
      if (!perms.plugins) return { ok: false, error: 'Plugin permission disabled' }
      return pluginHost.runCommand(payload.pluginId, payload.commandId, payload.args || {})
    }
  )

  ipcMain.handle('plugins:revoke', async (_, pluginId: string) => {
    pluginHost.revokePermissions(pluginId)
    return { ok: true }
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
      // WA-8: an enc:v1 key that no longer decrypts (keychain/device changed)
      // is reported explicitly instead of masquerading as a healthy key.
      else if (isEncryptedForm(cfg.apiKey)) {
        keyStatus[id] = decryptSecret(cfg.apiKey) ? 'encrypted' : 'decrypt-failed'
      } else if (String(cfg.apiKey).startsWith('plain:')) keyStatus[id] = 'plaintext-fallback'
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
