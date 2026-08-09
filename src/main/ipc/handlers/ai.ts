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
import {
  readProviderDefs,
  applyProviderDefsToSettings,
  mergeBuiltinDefs,
  type AIProviderDef
} from '../../ai/providerRegistry'

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

/** Persist a def list + rebuild the live provider map — shared tail of
 * ai:saveProviderConfigs and ai:resetProviderConfigs. */
function persistProviderDefs(settings: Record<string, unknown>, defs: unknown): AIProviderDef[] {
  const clean = applyProviderDefsToSettings(settings, defs)
  workspaceEngine.saveSettings(settings)
  aiMiddleware.rebuildProviders(clean)
  loadSettingsIntoProviders()
  return clean
}

export function registerAIHandlers(): void {
  // --- AI Embedding Status ---
  ipcMain.handle('ai:embeddingStatus', async () => {
    return embeddingEngine.getStatus()
  })

  wireEmbeddingProgressBroadcast()

  // --- AI Handlers ---

  /** Dynamic provider registry: the persisted provider defs (no keys). */
  ipcMain.handle('ai:getProviderConfigs', async () => {
    const settings = workspaceEngine.getSettings() as { aiProviders?: unknown }
    return { defs: readProviderDefs(settings) }
  })

  /**
   * Add / edit / delete providers. Persists the def list, drops API keys of
   * removed providers, and falls the active provider back to the first one
   * when it was deleted. Rebuilds the live provider map in place.
   */
  ipcMain.handle('ai:saveProviderConfigs', async (_, defs: unknown) => {
    try {
      // Robustness: only an ARRAY may replace the list. A malformed payload
      // (undefined/null/object) must never wipe every saved provider+key —
      // legit delete-all sends an explicit empty array [].
      if (!Array.isArray(defs)) {
        return { ok: false, error: 'defs must be an array' }
      }
      // Pure settings-mutation (unit-tested in providerRegistry.test.ts):
      // key-cleanup for removed providers, baseUrl/defaultModel sync (P1),
      // active-provider fallback. The handler then persists + rebuilds.
      const settings = workspaceEngine.getSettings() as Record<string, unknown>
      const clean = persistProviderDefs(settings, defs)
      return { ok: true, defs: clean }
    } catch (err) {
      console.error('[ai:saveProviderConfigs] failed:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Persist a model pick as the provider's default (chat picker): the live
   * provider, the key entry (settings.ai), and the def list are all updated so
   * the pick survives sessions and rebuilds. Auto always resolves to it.
   */
  ipcMain.handle('ai:setProviderDefaultModel', async (_, providerId: string, modelId: string) => {
    try {
      if (typeof providerId !== 'string' || !providerId) {
        return { ok: false, error: 'providerId required' }
      }
      const clean = String(modelId ?? '').trim()
      aiMiddleware.configureProvider(providerId, { defaultModel: clean || undefined })
      const settings = workspaceEngine.getSettings() as Record<string, unknown>
      const ai = (settings.ai as Record<string, Record<string, unknown>>) || {}
      if (ai[providerId]) ai[providerId].defaultModel = clean || undefined
      else ai[providerId] = { defaultModel: clean || undefined }
      settings.ai = ai
      // Keep the def list in sync (it is the persisted source at rebuild time)
      const defs = (settings.aiProviders as AIProviderDef[] | undefined) ?? []
      const def = defs.find((d) => d.id === providerId)
      if (def) {
        if (clean) def.defaultModel = clean
        else delete def.defaultModel
      }
      workspaceEngine.saveSettings(settings)
      return { ok: true }
    } catch (err) {
      console.error('[ai:setProviderDefaultModel] failed:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Reset ke provider bawaan: merge the six built-in seeds back into the def
   * list (non-destructive — existing providers are kept). Restores the special
   * adapters (Grok CLI, Ollama probe, Gemini SDK) after a delete-all without
   * hand-editing settings.json.
   */
  ipcMain.handle('ai:resetProviderConfigs', async () => {
    try {
      const settings = workspaceEngine.getSettings() as Record<string, unknown>
      const clean = persistProviderDefs(settings, mergeBuiltinDefs(settings.aiProviders))
      return { ok: true, defs: clean }
    } catch (err) {
      console.error('[ai:resetProviderConfigs] failed:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('ai:getProviders', async (event) => {
    // Push each provider's status as it resolves so the Settings panel can
    // flip that card's spinner immediately (fast providers land way before
    // slow ones in the parallel batch — never a blank "0 models" card).
    return aiMiddleware.getAllProvidersStatus((status) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) win.webContents.send('ai:providerStatus', status)
    })
  })

  ipcMain.handle(
    'ai:testProvider',
    async (_, providerId?: string, overrides?: { apiKey?: string; baseUrl?: string }) => {
      try {
        // A key typed in the card but not yet saved: patch the in-memory config
        // (never persisted by a Test) so the ping verifies the NEW key instead of
        // the stale saved one — the natural paste → Test → Save flow stays honest.
        if (overrides?.apiKey && String(overrides.apiKey).trim() && providerId) {
          const patch: { apiKey?: string; baseUrl?: string } = {
            apiKey: String(overrides.apiKey).trim()
          }
          if (overrides.baseUrl) patch.baseUrl = overrides.baseUrl
          aiMiddleware.configureProvider(providerId, patch)
        }
        return await aiMiddleware.testProvider(providerId)
      } catch (err) {
        console.error('[ai:testProvider] failed:', err)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

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
        enableTools,
        planMode,
        resumeFrom
      }: {
        requestId: string
        request: unknown
        activeFilePath?: string
        useContext?: boolean
        agentRole?: string
        enableTools?: boolean
        planMode?: boolean
        /** R2-2: resume a truncated stream from its checkpoint round. */
        resumeFrom?: { round: number; contextTokens?: number }
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
          requestId,
          Boolean(planMode),
          resumeFrom
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
