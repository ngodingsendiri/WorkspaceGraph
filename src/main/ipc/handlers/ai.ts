import { ipcMain, BrowserWindow } from 'electron'
import path from 'path'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { aiMiddleware } from '../../ai/AIMiddleware'
import { embeddingEngine } from '../../ai/EmbeddingEngine'
import {
  applyProposal,
  rejectProposal,
  listPendingProposals,
  getProposal
} from '../../ai/AgentTools'
import {
  ensureAiMemoryScaffold,
  listAiMemoryPaths,
  getCoreMemoryRelPaths,
  AI_MEMORY_DIR
} from '../../ai/WorkspaceMemory'
import { readPermissions } from '../../security/Permissions'
import { assertPathInVault } from '../../security/PathSandbox'
import {
  requireOpenVault,
  syncSingleFile,
  markSelfWrite,
  debounceEmit,
  loadSettingsIntoProviders
} from '../shared'

export function registerAIHandlers(): void {
  // --- AI Embedding Status ---
  ipcMain.handle('ai:embeddingStatus', async () => {
    return embeddingEngine.getStatus()
  })

  // --- AI Handlers ---
  ipcMain.handle('ai:getProviders', async () => {
    return aiMiddleware.getAllProvidersStatus()
  })

  ipcMain.handle('ai:testProvider', async (_, providerId?: string) => {
    return aiMiddleware.testProvider(providerId)
  })

  /** Import Grok CLI session (X account login via `grok` CLI) into WorkspaceGraph */
  ipcMain.handle('ai:importGrokCli', async () => {
    try {
      const res = aiMiddleware.importGrokFromCli()
      if (!res.ok || !res.apiKey) {
        return { ok: false, error: res.error || 'Import gagal' }
      }

      const settings = workspaceEngine.getSettings() as Record<string, unknown>
      const ai = { ...((settings.ai as Record<string, Record<string, string>>) || {}) }
      ai.grok = {
        apiKey: res.apiKey,
        // Official API (cli-chat-proxy returns 426 for non-CLI clients)
        baseUrl: res.baseUrl || 'https://api.x.ai/v1',
        defaultModel: res.model || 'grok-4.5',
        backend: res.backend || 'chat',
        useCliSession: '1'
      }
      settings.ai = ai
      settings.activeProvider = 'grok'
      const savedPath = workspaceEngine.saveSettings(settings)
      loadSettingsIntoProviders()
      return {
        ok: true,
        email: res.email,
        model: res.model,
        baseUrl: res.baseUrl,
        path: savedPath
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'ai:configure',
    async (_, { providerId, apiKey, baseUrl, defaultModel, backend }) => {
      try {
        // Configure in-memory first (plaintext key)
        const patch: {
          apiKey?: string
          baseUrl?: string
          defaultModel?: string
          backend?: string
        } = {}
        if (apiKey !== undefined && String(apiKey).trim()) patch.apiKey = String(apiKey).trim()
        if (baseUrl !== undefined) patch.baseUrl = baseUrl
        if (defaultModel !== undefined) patch.defaultModel = defaultModel
        if (backend !== undefined) patch.backend = backend
        aiMiddleware.configureProvider(providerId, patch)

        // Persist — merge onto existing decrypted settings then encrypt on disk
        const settings = workspaceEngine.getSettings() as Record<string, unknown>
        const ai = { ...((settings.ai as Record<string, Record<string, string>>) || {}) }
        const prev = { ...(ai[providerId] || {}) }
        if (patch.apiKey) prev.apiKey = patch.apiKey
        if (patch.baseUrl !== undefined) prev.baseUrl = patch.baseUrl
        if (patch.defaultModel !== undefined) prev.defaultModel = patch.defaultModel
        if (patch.backend !== undefined) (prev as Record<string, string>).backend = patch.backend
        ai[providerId] = prev
        settings.ai = ai
        const savedPath = workspaceEngine.saveSettings(settings)

        // Reload OTHER fields only — do not wipe key with failed decrypt
        loadSettingsIntoProviders()

        return { ok: true, path: savedPath }
      } catch (err) {
        console.error('[ai:configure] failed:', err)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('ai:setActiveProvider', async (_, providerId: string) => {
    aiMiddleware.setActiveProvider(providerId)
    const settings = workspaceEngine.getSettings() as Record<string, unknown>
    settings.activeProvider = providerId
    workspaceEngine.saveSettings(settings)
    return true
  })

  ipcMain.handle(
    'ai:sendMessage',
    async (_, { request, activeFilePath, useContext, agentRole }) => {
      const perms = readPermissions(workspaceEngine.getSettings())
      if (!perms.aiAccess) {
        throw new Error('AI access disabled in Settings → Security.')
      }
      if (activeFilePath) assertPathInVault(activeFilePath, requireOpenVault())
      return aiMiddleware.sendMessage(request, activeFilePath, useContext, agentRole)
    }
  )

  ipcMain.handle(
    'ai:streamMessage',
    async (
      event,
      {
        requestId,
        request,
        activeFilePath,
        useContext,
        agentRole,
        enableTools
      }: {
        requestId: string
        request: unknown
        activeFilePath?: string
        useContext?: boolean
        agentRole?: string
        enableTools?: boolean
      }
    ) => {
      const perms = readPermissions(workspaceEngine.getSettings())
      if (!perms.aiAccess) {
        const win = BrowserWindow.fromWebContents(event.sender)
        win?.webContents.send(`ai:stream:${requestId}`, {
          content: '**Error:** AI access disabled in Settings → Security.',
          done: true,
          error: 'AI access disabled in Settings → Security.'
        })
        return
      }
      if (activeFilePath) assertPathInVault(activeFilePath, requireOpenVault())
      const toolsAllowed = Boolean(enableTools) && perms.aiTools
      const win = BrowserWindow.fromWebContents(event.sender)
      const send = (chunk: unknown) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send(`ai:stream:${requestId}`, chunk)
        }
      }
      try {
        await aiMiddleware.streamMessage(
          request as never,
          send,
          activeFilePath,
          useContext,
          (agentRole as never) || 'general',
          toolsAllowed,
          requestId
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        send({
          content: `\n\n**Error:** ${msg}`,
          done: true,
          error: msg
        })
      }
    }
  )

  ipcMain.handle('ai:cancelStream', async (_, requestId: string) => {
    aiMiddleware.cancelStream(requestId)
    return true
  })

  ipcMain.handle('ai:applyProposal', async (_, proposalId: string) => {
    const result = applyProposal(proposalId)
    if (result.ok && result.path) {
      const state = workspaceEngine.getState()
      if (state.rootPath) {
        syncSingleFile(result.path, state.rootPath)
        debounceEmit()
      }
    }
    return result
  })

  ipcMain.handle('ai:rejectProposal', async (_, proposalId: string) => {
    return { ok: rejectProposal(proposalId) }
  })

  ipcMain.handle('ai:listProposals', async () => {
    return listPendingProposals()
  })

  ipcMain.handle('ai:getProposal', async (_, proposalId: string) => {
    return getProposal(proposalId) || null
  })

  /** Ensure AI Memory/ scaffold exists (L1 how-to memory for RAG + graph) */
  ipcMain.handle('ai:ensureMemory', async () => {
    const root = workspaceEngine.getState().rootPath
    const res = ensureAiMemoryScaffold(root)
    if (res.ok && res.created.length && root) {
      for (const rel of res.created) {
        const abs = path.join(root, rel)
        try {
          markSelfWrite(abs)
          syncSingleFile(abs, root)
        } catch {
          /* ignore single file */
        }
      }
      debounceEmit()
    }
    return res
  })

  ipcMain.handle('ai:listMemory', async () => {
    const root = workspaceEngine.getState().rootPath
    if (!root) return { ok: false, dir: AI_MEMORY_DIR, files: [] as string[] }
    const abs = listAiMemoryPaths(root)
    return {
      ok: true,
      dir: AI_MEMORY_DIR,
      files: abs.map((p) => path.relative(root, p).replace(/\\/g, '/')),
      core: getCoreMemoryRelPaths(root)
    }
  })
}
