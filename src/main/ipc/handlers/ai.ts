import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { aiMiddleware } from '../../ai/AIMiddleware'
import { embeddingEngine } from '../../ai/EmbeddingEngine'
import {
  logAIEvent,
  readAIEvents,
  readTerminalAIEvents,
  aiEventsToCSV,
  getAIEventStats,
  getAIEventStatsWindow,
  clearAIEvents
} from '../../ai/AIEventLog'
import {
  applyProposal,
  rejectProposal,
  listPendingProposals,
  getProposal,
  promoteToKnowledge
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

// Idempotency guard: registerAIHandlers may run more than once (startup + e2e
// test harness), and each run would stack another onProgress listener on the
// singleton engine. Only the first registration wires the broadcast.
let progressBroadcastWired = false

function wireEmbeddingProgressBroadcast(): void {
  if (progressBroadcastWired) return
  progressBroadcastWired = true
  // Push live indexing progress to all windows (dashboard progress badge,
  // status bar). App-lifetime listener; unsubscribing is unnecessary.
  embeddingEngine.onProgress((current, total, stage) => {
    const status = embeddingEngine.getStatus()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('embedding:progress', { current, total, stage, status })
      }
    }
  })
}

export function registerAIHandlers(): void {
  // --- AI Embedding Status ---
  ipcMain.handle('ai:embeddingStatus', async () => {
    return embeddingEngine.getStatus()
  })

  wireEmbeddingProgressBroadcast()

  // --- AI Handlers ---
  ipcMain.handle('ai:getProviders', async () => {
    return aiMiddleware.getAllProvidersStatus()
  })

  ipcMain.handle('ai:testProvider', async (_, providerId?: string) => {
    return aiMiddleware.testProvider(providerId)
  })

  /** P-model-discovery: force-refresh one provider's runtime model list. */
  ipcMain.handle('ai:refreshProviderModels', async (_, providerId: string) => {
    return aiMiddleware.refreshProviderModels(providerId)
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
      const send = (chunk: unknown): void => {
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

  /**
   * P1 pipeline: sequential agent orchestration (e.g. Research → Writer).
   * Mirrors ai:streamMessage's chunk delivery but drives middleware.streamPipeline
   * with a stage list; each stage runs with its own role (per-role tool gates).
   */
  ipcMain.handle(
    'ai:streamPipeline',
    async (
      event,
      {
        requestId,
        request,
        stages,
        activeFilePath,
        useContext
      }: {
        requestId: string
        request: unknown
        stages: { role: string; instruction: string }[]
        activeFilePath?: string
        useContext?: boolean
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
      if (!perms.aiTools) {
        const win = BrowserWindow.fromWebContents(event.sender)
        win?.webContents.send(`ai:stream:${requestId}`, {
          content: '**Error:** Pipeline membutuhkan izin tools (Settings → Security).',
          done: true,
          error: 'AI tools disabled in Settings → Security.'
        })
        return
      }
      if (activeFilePath) assertPathInVault(activeFilePath, requireOpenVault())
      const win = BrowserWindow.fromWebContents(event.sender)
      const send = (chunk: unknown): void => {
        if (win && !win.isDestroyed()) {
          win.webContents.send(`ai:stream:${requestId}`, chunk)
        }
      }
      try {
        await aiMiddleware.streamPipeline(
          request as never,
          stages as never,
          send,
          activeFilePath,
          useContext,
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

  ipcMain.handle('ai:applyProposal', async (_, proposalId: string, content?: string) => {
    // P2-6: optional edited content from the diff preview dialog
    const result = applyProposal(proposalId, content)
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

  /**
   * P2 knowledge promotion: turn a chat answer into a Knowledge/ note proposal
   * (with automatic backlinks to the cited notes). Same lifecycle as agent
   * writes — pending → dock → user Apply.
   */
  ipcMain.handle(
    'ai:promoteKnowledge',
    async (
      _,
      content: string,
      citations: { title: string; path: string }[],
      suggestedTitle?: string
    ) => {
      const res = promoteToKnowledge(content, citations, suggestedTitle)
      // P3 audit logging: handler-level operation (promote is not a middleware call)
      logAIEvent({
        kind: 'ipc',
        channel: 'ai:promoteKnowledge',
        status: res.ok ? 'ok' : 'error',
        error: res.error,
        role: 'curator'
      })
      return res
    }
  )

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

  /**
   * P3 audit logging: read the structured AI event trail (newest first) and
   * aggregate stats. Backed by the JSONL under .workspacegraph/logs/.
   */
  ipcMain.handle('ai:listAIEvents', async (_, limit?: number) => {
    const root = workspaceEngine.getState().rootPath
    return readAIEvents(root, Math.min(Math.max(Number(limit) || 200, 1), 5000))
  })

  ipcMain.handle('ai:getAIEventStats', async (_, days?: number) => {
    const root = workspaceEngine.getState().rootPath
    // Windowed summary powers the dashboard "AI usage" card. `days` of 0/NaN
    // falls back to the 7-day default (never 1) — the || 7 default wins first.
    const windowed = getAIEventStatsWindow(root, Math.max(Number(days) || 7, 1))
    return { ...getAIEventStats(root), windowed }
  })

  /** P3: wipe the AI event trail (Settings → AI Activity → Clear). */
  ipcMain.handle('ai:clearAIEvents', async () => {
    const root = workspaceEngine.getState().rootPath
    return clearAIEvents(root)
  })

  /**
   * P3: export terminal AI events to CSV via a native save dialog, defaulting
   * to the Downloads folder. Mirrors graph:savePng's dialog pattern.
   */
  ipcMain.handle('ai:exportAIEventsCSV', async () => {
    try {
      const root = workspaceEngine.getState().rootPath
      if (!root) return { ok: false, error: 'No vault open' }
      const events = readTerminalAIEvents(root, 50_000)
      if (events.length === 0) return { ok: false, error: 'Belum ada aktivitas AI untuk diekspor' }
      const res = await dialog.showSaveDialog({
        title: 'Export AI activity log',
        defaultPath: path.join(
          app.getPath('downloads'),
          `ai-events-${new Date().toISOString().slice(0, 10)}.csv`
        ),
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      fs.writeFileSync(res.filePath, aiEventsToCSV(events), 'utf-8')
      return { ok: true, path: res.filePath, count: events.length }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
