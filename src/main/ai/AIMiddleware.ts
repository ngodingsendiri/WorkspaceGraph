import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  ProviderStatus,
  AIMessage,
  AIToolCall
} from './providers/BaseProvider'
import { GeminiProvider } from './providers/GeminiProvider'
import { OpenAIProvider } from './providers/OpenAIProvider'
import { ClaudeProvider } from './providers/ClaudeProvider'
import { OllamaProvider } from './providers/OllamaProvider'
import { OpenRouterProvider } from './providers/OpenRouterProvider'
import { GrokProvider, importGrokCliAuth } from './providers/GrokProvider'
import { ContextEngine, AgentRole } from './ContextEngine'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { searchEngine } from '../engine/SearchEngine'
import {
  TOOLS_SYSTEM_PROMPT,
  parseToolActions,
  stripToolActions,
  executeTool,
  formatToolResultsForModel,
  formatToolResultForModel,
  isReadTool,
  isWriteTool,
  getProposal,
  buildToolSchemas,
  nativeCallsToActions,
  type WriteProposal,
  type ToolResult,
  type ToolAction
} from './AgentTools'
import { KERNEL_SYSTEM_PROMPT } from './WorkspaceMemory'
import { verifyCitations, type CitationVerification } from './CitationVerifier'

export type StreamEvent = AIStreamChunk & {
  citations?: { title: string; path: string }[]
  proposals?: WriteProposal[]
  toolStatus?: string
  round?: number
  /** Estimated tokens injected as workspace context (from ContextEngine). */
  contextTokens?: number
  /** Post-generation grounding check: which citations the answer actually draws on. */
  verifications?: CitationVerification[]
}

const MAX_TOOL_ROUNDS = 4

export class AIMiddleware {
  private providers: Map<string, BaseProvider> = new Map()
  private activeProviderId: string = 'grok'
  private contextEngine: ContextEngine
  private abortFlags = new Map<string, boolean>()
  /** Real HTTP cancellation — abort() stops the provider stream, not just UI. */
  private abortControllers = new Map<string, AbortController>()

  constructor(overrides?: { providers?: Record<string, BaseProvider> }) {
    this.contextEngine = new ContextEngine(workspaceEngine, searchEngine)

    const grok = new GrokProvider()
    const gemini = new GeminiProvider()
    const openai = new OpenAIProvider()
    const claude = new ClaudeProvider()
    const ollama = new OllamaProvider()
    const openrouter = new OpenRouterProvider()

    // Grok first — primary for this workspace app
    this.providers.set(grok.id, grok)
    this.providers.set(gemini.id, gemini)
    this.providers.set(openai.id, openai)
    this.providers.set(claude.id, claude)
    this.providers.set(ollama.id, ollama)
    this.providers.set(openrouter.id, openrouter)

    // Test seam: inject fake providers (P-A1 native loop / fence fallback)
    if (overrides?.providers) {
      for (const [id, p] of Object.entries(overrides.providers)) {
        this.providers.set(id, p)
      }
    }
  }

  configureProvider(
    providerId: string,
    config: {
      apiKey?: string
      baseUrl?: string
      defaultModel?: string
      backend?: string
      useCliSession?: boolean
    }
  ): void {
    const provider = this.providers.get(providerId)
    if (!provider) throw new Error(`Provider not found: ${providerId}`)
    if (provider instanceof GrokProvider) {
      provider.configure({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        defaultModel: config.defaultModel,
        backend: (config.backend as 'chat' | 'responses') || 'chat',
        useCliSession: config.useCliSession
      })
    } else {
      provider.configure(config)
    }
  }

  /** Import session from Grok CLI (~/.grok/auth.json) — login X via CLI once */
  importGrokFromCli(): {
    ok: boolean
    error?: string
    email?: string
    model?: string
    baseUrl?: string
    apiKey?: string
    backend?: string
  } {
    const imp = importGrokCliAuth()
    if (!imp.ok || !imp.apiKey) {
      return { ok: false, error: imp.error || 'Import gagal' }
    }
    // Official API — CLI proxy rejects non-CLI clients with 426
    this.configureProvider('grok', {
      apiKey: imp.apiKey,
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: imp.defaultModel || 'grok-4.5',
      backend: 'chat',
      useCliSession: true
    })
    this.setActiveProvider('grok')
    return {
      ok: true,
      email: imp.email,
      model: imp.defaultModel || 'grok-4.5',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: imp.apiKey,
      backend: 'chat'
    }
  }

  getGrokProvider(): GrokProvider | null {
    const p = this.providers.get('grok')
    return p instanceof GrokProvider ? p : null
  }

  setActiveProvider(providerId: string): void {
    if (!this.providers.has(providerId)) throw new Error(`Provider not found: ${providerId}`)
    this.activeProviderId = providerId
  }

  getActiveProvider(): BaseProvider {
    const provider = this.providers.get(this.activeProviderId)
    if (!provider) throw new Error(`Active provider not configured: ${this.activeProviderId}`)
    return provider
  }

  cancelStream(requestId: string): void {
    this.abortFlags.set(requestId, true)
    this.abortControllers.get(requestId)?.abort()
  }

  isCancelled(requestId?: string): boolean {
    if (!requestId) return false
    return this.abortFlags.get(requestId) === true
  }

  clearCancel(requestId: string): void {
    this.abortFlags.delete(requestId)
    this.abortControllers.delete(requestId)
  }

  async getAllProvidersStatus(): Promise<ProviderStatus[]> {
    const statuses: ProviderStatus[] = []
    for (const provider of this.providers.values()) {
      const configured = provider.isConfigured()
      // Always expose model list so UI can select before/after key entry
      const models = await provider.listModels().catch(() => [])
      /**
       * BUGFIX: most healthCheck() === isConfigured() (key present), which made UI
       * claim "connected" without a live ping. Only Ollama implements a real probe.
       * - connected: live reachability when available (Ollama /api/tags)
       * - configured: credentials present (cloud key / ollama always true by design)
       */
      let connected = false
      if (provider.id === 'ollama') {
        connected = await provider.healthCheck().catch(() => false)
      } else {
        // Cloud: do not fake "connected" — use Test for live proof
        connected = false
      }
      let error: string | undefined
      if (provider.id === 'ollama') {
        error = connected ? undefined : 'Ollama offline (localhost:11434)'
      } else if (!configured) {
        error = 'API key belum di-set'
      }
      statuses.push({
        id: provider.id,
        name: provider.name,
        connected,
        configured,
        models,
        defaultModel: provider.getDefaultModel(),
        error
      })
    }
    return statuses
  }

  /** Live ping — actually calls the API once (for Settings → Test) */
  async testProvider(
    providerId?: string
  ): Promise<{ ok: boolean; error?: string; sample?: string }> {
    const id = providerId || this.activeProviderId
    const provider = this.providers.get(id)
    if (!provider) return { ok: false, error: `Provider not found: ${id}` }
    // Grok CLI session: refresh token before test (otherwise expired JWT looks like "not configured")
    if (provider instanceof GrokProvider) {
      try {
        await provider.ensureSession()
      } catch {
        /* continue — sendMessage will surface auth errors */
      }
    }
    if (!provider.isConfigured()) {
      return {
        ok: false,
        error:
          id === 'grok'
            ? 'Grok belum dikonfigurasi. Settings → Import Grok CLI, atau paste XAI_API_KEY.'
            : 'API key / base URL belum dikonfigurasi'
      }
    }
    try {
      const res = await provider.sendMessage({
        model: provider.getDefaultModel(),
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        maxTokens: 16,
        systemPrompt: 'You are a connectivity test. Reply only OK.'
      })
      return { ok: true, sample: (res.content || '').slice(0, 80) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async buildSystemPromptAsync(
    request: AIRequest,
    activeFilePath: string | undefined,
    useContext: boolean,
    agentRole: AgentRole,
    toolMode: 'native' | 'fence' | 'off'
  ): Promise<{
    systemPrompt: string
    citations: { title: string; path: string }[]
    contextTokens?: number
  }> {
    // Kernel layer always present
    let systemPrompt = KERNEL_SYSTEM_PROMPT
    if (request.systemPrompt) {
      systemPrompt += '\n\n' + request.systemPrompt
    }
    let citations: { title: string; path: string }[] = []
    let contextTokens: number | undefined

    if (useContext && request.messages.length > 0) {
      const lastUserMsg = request.messages[request.messages.length - 1]
      if (lastUserMsg.role === 'user') {
        try {
          // buildContextPackageAsync runs semantic vector search (EmbeddingEngine) before FTS
          const ctxPackage = await this.contextEngine.buildContextPackageAsync(
            lastUserMsg.content,
            activeFilePath,
            agentRole
          )
          systemPrompt += '\n\n' + ctxPackage.formattedContext
          citations = ctxPackage.citations
          contextTokens = ctxPackage.tokenEstimate
          if (process.env.WG_DEBUG_CONTEXT === '1') {
            console.log(
              `[AI context] tokens~${ctxPackage.tokenEstimate} files=${ctxPackage.relevantFiles.length} citations=${citations.length} semantic=${ctxPackage.relevantFiles.filter((f) => f.tier === 'semantic').length}`
            )
          }
        } catch (err) {
          console.error('[AI context] build failed:', err)
          systemPrompt +=
            '\n\n=== WORKSPACE CONTEXT ===\n(Context build failed — answer carefully; ask user to open a vault.)\n=== END ===\n'
        }
      }
    }

    // Fence protocol instructions only for the fence fallback — the native
    // path declares tools through the API, so teaching wg-action fences there
    // would encourage double-calling (fences AND tool_calls).
    if (toolMode === 'fence') {
      systemPrompt += '\n\n' + TOOLS_SYSTEM_PROMPT
    }

    return { systemPrompt, citations, contextTokens }
  }

  /** @deprecated Use buildSystemPromptAsync in streaming path */
  private buildSystemPrompt(
    request: AIRequest,
    activeFilePath: string | undefined,
    useContext: boolean,
    agentRole: AgentRole,
    enableTools: boolean
  ): { systemPrompt: string; citations: { title: string; path: string }[] } {
    // Kernel layer always present
    let systemPrompt = KERNEL_SYSTEM_PROMPT
    if (request.systemPrompt) {
      systemPrompt += '\n\n' + request.systemPrompt
    }
    let citations: { title: string; path: string }[] = []

    if (useContext && request.messages.length > 0) {
      const lastUserMsg = request.messages[request.messages.length - 1]
      if (lastUserMsg.role === 'user') {
        try {
          const ctxPackage = this.contextEngine.buildContextPackage(
            lastUserMsg.content,
            activeFilePath,
            agentRole
          )
          systemPrompt += '\n\n' + ctxPackage.formattedContext
          citations = ctxPackage.citations
          if (process.env.WG_DEBUG_CONTEXT === '1') {
            console.log(
              `[AI context] tokens~${ctxPackage.tokenEstimate} files=${ctxPackage.relevantFiles.length} citations=${citations.length}`
            )
          }
        } catch (err) {
          console.error('[AI context] build failed:', err)
          systemPrompt +=
            '\n\n=== WORKSPACE CONTEXT ===\n(Context build failed — answer carefully; ask user to open a vault.)\n=== END ===\n'
        }
      }
    }

    if (enableTools) {
      systemPrompt += '\n\n' + TOOLS_SYSTEM_PROMPT
    }

    return { systemPrompt, citations }
  }

  async sendMessage(
    request: AIRequest,
    activeFilePath?: string,
    useContext = true,
    agentRole: AgentRole = 'general'
  ): Promise<{ response: AIResponse; citations: { title: string; path: string }[] }> {
    const provider = this.getActiveProvider()
    const { systemPrompt, citations } = this.buildSystemPrompt(
      request,
      activeFilePath,
      useContext,
      agentRole,
      false
    )
    request.systemPrompt = systemPrompt
    const res = await provider.sendMessage(request)
    return { response: res, citations }
  }

  /**
   * Stream with optional multi-round tool loop (Phase 3).
   */
  async streamMessage(
    request: AIRequest,
    onChunk: (chunk: StreamEvent) => void,
    activeFilePath?: string,
    useContext = true,
    agentRole: AgentRole = 'general',
    enableTools = false,
    requestId?: string
  ): Promise<void> {
    if (requestId) this.clearCancel(requestId)
    const controller = requestId ? new AbortController() : undefined
    if (controller && requestId) this.abortControllers.set(requestId, controller)
    const signal = controller?.signal
    try {
      await this.runStreamInner(
        request,
        onChunk,
        activeFilePath,
        useContext,
        agentRole,
        enableTools,
        requestId,
        signal,
        controller
      )
    } finally {
      if (requestId) this.abortControllers.delete(requestId)
    }
  }

  private async runStreamInner(
    request: AIRequest,
    onChunk: (chunk: StreamEvent) => void,
    activeFilePath: string | undefined,
    useContext: boolean,
    agentRole: AgentRole,
    enableTools: boolean,
    requestId: string | undefined,
    signal: AbortSignal | undefined,
    controller: AbortController | undefined
  ): Promise<void> {
    let provider: BaseProvider
    try {
      provider = this.getActiveProvider()
    } catch (err) {
      onChunk({
        content: '',
        done: true,
        error: err instanceof Error ? err.message : String(err)
      })
      return
    }

    if (!provider.isConfigured()) {
      onChunk({
        content: '',
        done: true,
        error: `Provider "${provider.name}" belum dikonfigurasi. Buka Settings → AI Providers, isi API key, lalu Save.`
      })
      return
    }

    // P-A2 vision gate: images only work on providers that advertise vision.
    if (request.images?.length && !provider.capabilities.vision) {
      onChunk({
        content: '',
        done: true,
        error: `Provider "${provider.name}" tidak mendukung vision — hapus lampiran gambar atau pindah ke provider dengan vision (Grok/Gemini/OpenAI/Claude/OpenRouter).`
      })
      return
    }

    // Ensure model is set — avoid empty / accidental pro on free tier
    if (!request.model || request.model === 'undefined') {
      request.model = provider.getDefaultModel()
    }
    // P-A1: providers with native function calling get the tools array;
    // everyone else (Claude/Gemini/Ollama) falls back to the wg-action fence.
    const nativeTools = enableTools && provider.capabilities.toolCalling
    const toolMode: 'native' | 'fence' | 'off' = nativeTools
      ? 'native'
      : enableTools
        ? 'fence'
        : 'off'

    // Soft guard: gemini-2.5-pro often has free-tier limit 0
    if (
      provider.id === 'gemini' &&
      /gemini-2\.5-pro|gemini-1\.5-pro/i.test(request.model) &&
      process.env.WG_ALLOW_GEMINI_PRO !== '1'
    ) {
      // Don't force-switch (user may have paid tier) — just note in first chunk if fails
    }

    const { systemPrompt, citations, contextTokens } = await this.buildSystemPromptAsync(
      request,
      activeFilePath,
      useContext,
      agentRole,
      toolMode
    )

    let messages: AIMessage[] = [...request.messages]
    if (messages.length === 0) {
      onChunk({ content: '', done: true, error: 'No messages in request' })
      return
    }

    // P-A2: request-level images attach to the LAST user message (the current
    // prompt) and ride along in `messages` through every tool round — each
    // provider translates them into its native image content block format.
    if (request.images?.length) {
      const lastIdx = messages.length - 1
      if (lastIdx >= 0 && messages[lastIdx].role === 'user') {
        messages[lastIdx] = { ...messages[lastIdx], images: request.images }
      }
    }

    const allProposals: WriteProposal[] = []
    let lastCitations = citations
    // contextTokens are emitted once per STREAM (not per tool round).
    let contextMetaSent = false
    // Accumulated streamed text across ALL tool rounds — used for the citation
    // grounding check right before the final done chunk.
    let lastFullText = ''
    let verifications: CitationVerification[] | undefined
    const getVerifications = (): CitationVerification[] | undefined => {
      if (verifications === undefined && lastFullText && lastCitations.length > 0) {
        try {
          verifications = verifyCitations(
            lastFullText,
            lastCitations,
            (p) => workspaceEngine.readFile(p).content
          )
        } catch {
          verifications = undefined
        }
      }
      return verifications
    }

    // Timeout guard (~3 min total)
    const started = Date.now()
    const TIMEOUT_MS = 180_000

    for (let round = 0; round < (enableTools ? MAX_TOOL_ROUNDS : 1); round++) {
      if (requestId && this.isCancelled(requestId)) {
        onChunk({
          content: '\n\n*(cancelled)*\n',
          done: true,
          citations: lastCitations,
          proposals: allProposals
        })
        return
      }
      if (Date.now() - started > TIMEOUT_MS) {
        onChunk({
          content: '\n\n*(timeout — stopped tool loop)*\n',
          done: true,
          citations: lastCitations,
          proposals: allProposals
        })
        return
      }

      let fullText = ''
      let streamError: string | undefined
      // P-A1: native tool calls accumulated from the provider's stream deltas
      let toolCalls: AIToolCall[] = []
      const req: AIRequest = {
        ...request,
        messages,
        systemPrompt,
        stream: true
      }
      if (nativeTools) {
        req.tools = buildToolSchemas()
        req.tool_choice = 'auto'
      }

      // Watchdog: a provider stream that stalls must not hang the chat forever.
      // The round-level TIMEOUT_MS guard above only runs BETWEEN rounds — a stuck
      // stream would otherwise keep isGenerating=true indefinitely.
      const remainingMs = TIMEOUT_MS - (Date.now() - started)
      if (remainingMs <= 0) {
        onChunk({
          content: '\n\n*(timeout — stream stalled)*\n',
          done: true,
          error: 'Stream timed out',
          citations: lastCitations,
          proposals: allProposals,
          round
        })
        return
      }
      let timedOut = false
      let watchdogTimer: ReturnType<typeof setTimeout> | undefined
      const watchdog = new Promise<void>((resolve) => {
        watchdogTimer = setTimeout(() => {
          timedOut = true
          controller?.abort()
          onChunk({
            content: '\n\n*(timeout — stream stalled)*\n',
            done: true,
            error: 'Stream timed out',
            citations: lastCitations,
            proposals: allProposals,
            round
          })
          resolve()
        }, remainingMs)
      })
      const streamPromise = provider.streamMessage(
        req,
        (chunk) => {
          if (timedOut || (requestId && this.isCancelled(requestId))) return
          if (chunk.error) streamError = chunk.error
          fullText += chunk.content || ''
          lastFullText += chunk.content || ''
          if (chunk.toolCalls?.length) toolCalls = chunk.toolCalls
          // Don't mark done until tool loop finishes (unless error)
          if (chunk.error) {
            onChunk({
              content: chunk.content || '',
              done: false,
              error: chunk.error,
              citations: lastCitations,
              round
            })
            return
          }
          onChunk({
            content: chunk.content,
            done: false,
            citations: lastCitations,
            round,
            // Surface context token estimate once per stream (first chunk).
            contextTokens: contextMetaSent ? undefined : contextTokens,
            tokensUsed: chunk.tokensUsed
          })
          contextMetaSent = true
        },
        signal
      )
      await Promise.race([streamPromise, watchdog])
      if (watchdogTimer) clearTimeout(watchdogTimer)
      if (Date.now() - started > TIMEOUT_MS) {
        // Watchdog won — timeout chunk already emitted (or stream finished past
        // budget). Stop cleanly; the done marker is already on the wire.
        if (requestId) this.clearCancel(requestId)
        return
      }

      // Soft-cancel: provider may still finish network; stop loop cleanly with marker
      if (requestId && this.isCancelled(requestId)) {
        onChunk({
          content: '\n\n*(cancelled)*\n',
          done: true,
          citations: lastCitations,
          proposals: allProposals
        })
        this.clearCancel(requestId)
        return
      }

      if (streamError) {
        onChunk({
          content: `\n\n**Error:** ${streamError}`,
          done: true,
          error: streamError,
          citations: lastCitations,
          proposals: allProposals
        })
        return
      }

      if (!enableTools) {
        onChunk({
          content: '',
          done: true,
          citations: lastCitations,
          proposals: allProposals,
          verifications: getVerifications()
        })
        return
      }

      // Native path: model calls arrive as structured tool_calls; fence path
      // parses the wg-action protocol. Both yield the same executable actions.
      const pending: { callId?: string; action: ToolAction }[] = nativeTools
        ? nativeCallsToActions(toolCalls)
        : parseToolActions(fullText).map((a) => ({ action: a }))
      if (pending.length === 0) {
        onChunk({
          content: '',
          done: true,
          citations: lastCitations,
          proposals: allProposals,
          verifications: getVerifications()
        })
        return
      }

      const known = pending.filter((p) => isReadTool(p.action.tool) || isWriteTool(p.action.tool))
      const unknown = pending.filter(
        (p) => !isReadTool(p.action.tool) && !isWriteTool(p.action.tool)
      )
      if (unknown.length) {
        onChunk({
          content: `\n\n*(unknown tools skipped: ${unknown.map((u) => u.action.tool).join(', ')})*\n`,
          done: false,
          toolStatus: `Skipped ${unknown.length} unknown tool(s)`,
          round
        })
      }
      if (known.length === 0) {
        onChunk({
          content: '',
          done: true,
          citations: lastCitations,
          proposals: allProposals,
          verifications: getVerifications()
        })
        return
      }

      const readPending = known.filter((p) => isReadTool(p.action.tool))
      const writePending = known.filter((p) => isWriteTool(p.action.tool))
      const results: ToolResult[] = []
      // Native loop: results must zip back to the model's tool_call_id
      const resultByCall = new Map<string, ToolResult>()

      // Reads first (gather facts), then write proposals
      for (const p of readPending) {
        onChunk({
          content: '',
          done: false,
          toolStatus: `▸ ${p.action.tool}`,
          round
        })
        const r = await executeTool(p.action)
        results.push(r)
        if (p.callId) resultByCall.set(p.callId, r)
        if (!r.ok) {
          onChunk({
            content: `\n\n*(tool ${p.action.tool} failed: ${r.error})*\n`,
            done: false,
            toolStatus: `✗ ${p.action.tool}`,
            round
          })
        }
        if (r.ok && p.action.tool === 'read_note' && r.result && typeof r.result === 'object') {
          const res = r.result as { title?: string; absolutePath?: string }
          if (res.absolutePath && res.title) {
            if (!lastCitations.some((c) => c.path === res.absolutePath)) {
              lastCitations = [...lastCitations, { title: res.title, path: res.absolutePath }]
            }
          }
        }
        if (r.ok && p.action.tool === 'search' && Array.isArray(r.result)) {
          for (const hit of r.result as { title: string; absolutePath: string }[]) {
            if (hit.absolutePath && !lastCitations.some((c) => c.path === hit.absolutePath)) {
              lastCitations = [...lastCitations, { title: hit.title, path: hit.absolutePath }]
            }
          }
        }
      }

      for (const p of writePending) {
        onChunk({
          content: '',
          done: false,
          toolStatus: `▸ propose ${p.action.tool}`,
          round
        })
        const r = await executeTool(p.action)
        results.push(r)
        if (p.callId) resultByCall.set(p.callId, r)
        if (r.proposalId) {
          const prop = getProposal(r.proposalId)
          if (prop) {
            allProposals.push(prop)
            onChunk({
              content: `\n\n📝 **Write proposal** \`${prop.relativePath}\` (${prop.mode}) — Apply di panel.\n`,
              done: false,
              proposals: [prop],
              toolStatus: `proposal ${prop.relativePath}`,
              round
            })
          }
        } else if (!r.ok) {
          onChunk({
            content: `\n\n*(write tool failed: ${r.error})*\n`,
            done: false,
            toolStatus: `✗ ${p.action.tool}`,
            round
          })
        }
      }

      // Only writes → stop so user can Apply (still OK if reads failed)
      if (readPending.length === 0) {
        onChunk({
          content: '',
          done: true,
          citations: lastCitations,
          proposals: allProposals,
          verifications: getVerifications()
        })
        return
      }

      if (nativeTools) {
        // Continue the native loop: assistant tool_calls + `tool` role results,
        // zipped by the model's call ids (OpenAI-compatible message shape).
        // Zip assistant tool_calls with the calls that actually ran — OpenAI
        // rejects a round where a tool_call_id has no matching tool message,
        // so calls that were filtered (unknown/duplicate) must not appear here.
        const executedCalls = toolCalls.filter((c) => resultByCall.has(c.id))
        messages = [
          ...messages,
          {
            role: 'assistant',
            content: stripToolActions(fullText) || '',
            tool_calls: executedCalls.map((c) => ({
              id: c.id,
              name: c.name,
              arguments: c.arguments
            }))
          },
          ...executedCalls.map((c) => ({
            role: 'tool' as const,
            tool_call_id: c.id,
            content: formatToolResultForModel(resultByCall.get(c.id)!)
          }))
        ]
      } else {
        // Continue loop with tool results
        const cleanAssistant = stripToolActions(fullText) || fullText
        messages = [
          ...messages,
          { role: 'assistant', content: cleanAssistant },
          { role: 'user', content: formatToolResultsForModel(results) }
        ]
      }

      onChunk({
        content: '\n\n---\n*Tool results applied — continuing…*\n\n',
        done: false,
        toolStatus: `Round ${round + 1} tools done`,
        citations: lastCitations,
        round
      })
    }

    onChunk({
      content: '\n\n*(max tool rounds reached)*\n',
      done: true,
      citations: lastCitations,
      proposals: allProposals,
      verifications: getVerifications()
    })
  }
}

export const aiMiddleware = new AIMiddleware()
