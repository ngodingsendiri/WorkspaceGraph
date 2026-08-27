import { ipcMain } from 'electron'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { pluginHost } from '../../plugin/PluginHost'
import { InternalAPI } from '../../api/InternalAPI'
import { readPermissions } from '../../security/Permissions'
import { isEncryptedForm, decryptSecret } from '../../security/SecretsStore'
import { logAudit } from '../../security/AuditLog'
import { validateShape, type FieldSpec } from '../../api/ipcValidation'

const RUN_CMD_SHAPE: Record<string, FieldSpec> = {
  pluginId: { type: 'string' },
  commandId: { type: 'string' },
  args: { type: 'object', optional: true }
}

const RUN_PROVIDER_SHAPE: Record<string, FieldSpec> = {
  pluginId: { type: 'string' },
  providerId: { type: 'string' },
  query: { type: 'string' },
  limit: { type: 'number', optional: true }
}

export function registerPluginsHandlers(): void {
  ipcMain.handle('plugins:list', async () => {
    return InternalAPI.getPlugins()
  })

  ipcMain.handle('plugins:commands', async () => {
    return InternalAPI.getPluginCommands()
  })

  // M6b PLG-1: declarative context-menu extension point
  ipcMain.handle('plugins:contextMenus', async () => {
    return InternalAPI.getPluginContextMenus()
  })

  // M6b PLG-1: declarative search-provider extension point
  ipcMain.handle('plugins:searchProviders', async () => {
    return InternalAPI.getPluginSearchProviders()
  })

  ipcMain.handle(
    'plugins:runSearchProvider',
    async (_, payload: unknown) => {
      const checked = validateShape<{ pluginId: string; providerId: string; query: string; limit?: number }>(
        payload,
        RUN_PROVIDER_SHAPE
      )
      if (!checked.ok) return { ok: false, error: checked.error }
      const perms = readPermissions(workspaceEngine.getSettings())
      if (!perms.plugins) return { ok: false, error: 'Plugin permission disabled' }
      return InternalAPI.runPluginSearchProvider(
        checked.value.pluginId,
        checked.value.providerId,
        checked.value.query,
        checked.value.limit ?? 10
      )
    }
  )

  ipcMain.handle('plugins:reload', async () => {
    const root = workspaceEngine.getState().rootPath
    if (!root) return { ok: false }
    const perms = readPermissions(workspaceEngine.getSettings())
    pluginHost.setAllowed(perms.plugins)
    pluginHost.load(root)
    // M8.5 (SEC-1): plugin load is security-relevant (code entering the app)
    logAudit({ kind: 'plugin_loaded', target: `${pluginHost.list().length} plugins`, status: 'ok' })
    return { ok: true, count: pluginHost.list().length }
  })

  ipcMain.handle(
    'plugins:runCommand',
    async (_, payload: unknown) => {
      const checked = validateShape<{ pluginId: string; commandId: string; args?: Record<string, unknown> }>(
        payload,
        RUN_CMD_SHAPE
      )
      if (!checked.ok) return { ok: false, error: checked.error }
      const perms = readPermissions(workspaceEngine.getSettings())
      if (!perms.plugins) {
        logAudit({
          kind: 'permission_denied',
          target: `plugins:runCommand ${checked.value.pluginId}/${checked.value.commandId}`,
          status: 'denied'
        })
        return { ok: false, error: 'Plugin permission disabled' }
      }
      logAudit({
        kind: 'plugin_command',
        target: `${checked.value.pluginId}/${checked.value.commandId}`,
        status: 'ok'
      })
      return pluginHost.runCommand(checked.value.pluginId, checked.value.commandId, checked.value.args || {})
    }
  )

  ipcMain.handle('plugins:revoke', async (_, pluginId: string) => {
    pluginHost.revokePermissions(pluginId)
    // M8.5 (SEC-1): permission revocation is audited
    logAudit({ kind: 'plugin_permission_revoked', target: pluginId, status: 'ok' })
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
