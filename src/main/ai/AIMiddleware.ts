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
  buildToolsSystemPrompt,
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
import { renderPrompt } from './PromptRegistry'
import { logAIEvent, logAIOutcome, type AIEventStatus } from './AIEventLog'
import { verifyCitations, type CitationVerification } from './CitationVerifier'

/**
 * Structured per-tool lifecycle event (P1-1). One runId spans the whole
 * invocation: a `running` event opens the run, then `ok` / `error` closes it.
 * `detail` carries the result preview for the expandable pill in the chat UI.
 */
export interface ToolRunEvent {
  /** Stable id for the invocation — the renderer matches updates on this. */
  runId: string
  tool: string
  status: 'running' | 'ok' | 'error'
  /** Short result preview (ok) or failure reason (error); absent while running. */
  detail?: string
  round?: number
}

export type StreamEvent = AIStreamChunk & {
  citations?: { title: string; path: string }[]
  proposals?: WriteProposal[]
  toolStatus?: string
  /** Structured per-tool event for the collapsible tool-run trail (P1-1). */
  toolRun?: ToolRunEvent
  round?: number
  /** Estimated tokens injected as workspace context (from ContextEngine). */
  contextTokens?: number
  /** P1-4: tokens saved by sending the workspace context only in round 0 of a
   * multi-round tool loop (context estimate × rounds beyond the first). */
  contextSavedTokens?: number
  /** Post-generation grounding check: which citations the answer actually draws on. */
  verifications?: CitationVerification[]
}

const MAX_TOOL_ROUNDS = 4

/**
 * One stage of a sequential agent pipeline (P1 — doc 20 orchestration).
 * Each stage runs as a sub-invocation with its own AgentRole, so the
 * per-role tool permissions gate what that stage may do (e.g. a researcher
 * stage can read/search but never write).
 */
export interface PipelineStage {
  role: AgentRole
  /** Short instruction appended to the system prompt for this stage. */
  instruction: string
}

/**
 * Preset: Research → Writer. The researcher stage gathers + verifies facts
 * (read-only tools), hands its summary to the writer stage, which composes
 * the final document (may propose writes).
 */
export const RESEARCH_TO_WRITER_STAGES: PipelineStage[] = [
  {
    role: 'researcher',
    instruction:
      'Stage 1/2 — RESEARCH. Gather and verify facts from the workspace using search/read/list tools. End with a concise research summary with [[WikiLinks]]. Do NOT propose writes yet.'
  },
  {
    role: 'writer',
    instruction:
      'Stage 2/2 — WRITING. Using the research summary from Stage 1, compose the final document/answer. You may propose writes for durable output.'
  }
]

/** Hard per-invocation tool timeout — a stuck fs/search call must not freeze
 * the whole tool loop (the round watchdog only guards BETWEEN rounds). */
export const EXECUTE_TOOL_TIMEOUT_MS = 30_000

/**
 * Run one tool with a bounded lifetime. A hung tool resolves to an error
 * result after EXECUTE_TOOL_TIMEOUT_MS so the loop continues with a visible
 * failure instead of stalling forever. `role` gates the tool via the P1
 * per-role capability matrix (denied tools never execute).
 */
export async function executeToolWithTimeout(
  action: ToolAction,
  role: AgentRole = 'general'
): Promise<ToolResult> {
  // P3 audit logging: one structured 'tool' event per invocation (tool, role,
  // duration, ok/error) so the JSONL trail matches what the UI tool-run pills show.
  const startedAt = Date.now()
  return new Promise<ToolResult>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const r: ToolResult = {
        ok: false,
        tool: action.tool,
        error: `Tool timeout (${EXECUTE_TOOL_TIMEOUT_MS / 1000}s)`
      }
      logAIOutcome('tool', {
        startedAt,
        ok: false,
        error: r.error,
        tool: action.tool,
        role
      })
      resolve(r)
    }, EXECUTE_TOOL_TIMEOUT_MS)
    executeTool(action, role).then(
      (r) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        logAIOutcome('tool', {
          startedAt,
          ok: r.ok,
          error: r.error,
          tool: action.tool,
          role
        })
        resolve(r)
      },
      (err: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const msg = err instanceof Error ? err.message : String(err)
        logAIOutcome('tool', { startedAt, ok: false, error: msg, tool: action.tool, role })
        resolve({
          ok: false,
          tool: action.tool,
          error: msg
        })
      }
    )
  })
}

/** Monotonic run-id generator — each tool invocation gets a stable identity so
 * the renderer can update a run in place instead of appending duplicates. */
let toolRunSeq = 0
function nextToolRunId(): string {
  toolRunSeq += 1
  return `tr${toolRunSeq}`
}

/** Truncate a tool result into a one-line preview for the expandable pill. */
function toolResultDetail(r: ToolResult, max = 400): string | undefined {
  if (!r.ok) return r.error || undefined
  if (r.result === undefined || r.result === null) return undefined
  let text: string
  if (typeof r.result === 'string') {
    text = r.result
  } else {
    try {
      text = JSON.stringify(r.result)
    } catch {
      text = String(r.result)
    }
  }
  text = text.trim().replace(/\s+/g, ' ')
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Shared stream-audit wrapper (P3): capture the final outcome from the LAST
 * done chunk — status (ok/error/cancelled/timeout), tokensUsed, error, rounds —
 * so the stream_end log event reflects the real terminal state. The markers
 * `(cancelled)` / `(timeout` only ride on middleware-generated terminal chunks
 * (controlled content), so model prose can never false-positive them.
 */
function withStreamAudit(onChunk: (c: StreamEvent) => void): {
  wrapped: (c: StreamEvent) => void
  finalMeta: { status: AIEventStatus; tokensUsed?: number; error?: string; rounds?: number }
} {
  const finalMeta: {
    status: AIEventStatus
    tokensUsed?: number
    error?: string
    rounds?: number
  } = { status: 'ok' }
  const wrapped: (c: StreamEvent) => void = (c) => {
    if (c.done) {
      finalMeta.status = c.error
        ? 'error'
        : c.content?.includes('(cancelled)')
          ? 'cancelled'
          : c.content?.includes('(timeout')
            ? 'timeout'
            : 'ok'
      finalMeta.tokensUsed = c.tokensUsed
      finalMeta.error = c.error
      if (typeof c.round === 'number') finalMeta.rounds = c.round + 1
    }
    onChunk(c)
  }
  return { wrapped, finalMeta }
}

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
    const startedAt = Date.now()
    try {
      const res = await provider.sendMessage({
        model: provider.getDefaultModel(),
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        maxTokens: 16,
        systemPrompt: 'You are a connectivity test. Reply only OK.'
      })
      logAIOutcome('test', {
        startedAt,
        ok: true,
        provider: provider.id,
        model: provider.getDefaultModel()
      })
      return { ok: true, sample: (res.content || '').slice(0, 80) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logAIOutcome('test', {
        startedAt,
        ok: false,
        error: msg,
        provider: provider.id,
        model: provider.getDefaultModel()
      })
      return { ok: false, error: msg }
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
    /** Round-0 system prompt WITHOUT the workspace context block — tool-loop
     * rounds 1+ reuse this lean prompt (P1-4). */
    leanSystemPrompt: string
    citations: { title: string; path: string }[]
    contextTokens?: number
  }> {
    // Kernel layer always present (Prompt Registry — re-rendered per stream so
    // a vault override in .workspacegraph/prompts/prompts.json takes effect).
    // Resolved once: systemPrompt + leanSystemPrompt share the same kernel text.
    const kernelPrompt = renderPrompt('kernel')
    let systemPrompt = kernelPrompt
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
    // would encourage double-calling (fences AND tool_calls). P1: the tool
    // list is role-filtered — a researcher never sees write tools advertised.
    if (toolMode === 'fence') {
      systemPrompt += '\n\n' + buildToolsSystemPrompt(agentRole)
    }

    // P1-4: lean variant for tool-loop rounds 1+ — kernel + overrides + fence
    // protocol, WITHOUT the (large) workspace context block. The tool results
    // already sitting in `messages` carry the material those rounds need, so
    // re-sending ~3.5–4.6k tokens of context per round is wasted billing.
    // Tradeoff: vault rules / AI-memory snippets are dropped too — acceptable
    // because the model can re-read them via tools (read_note/search) if a
    // later-round answer needs them.
    let leanSystemPrompt = kernelPrompt
    if (request.systemPrompt) leanSystemPrompt += '\n\n' + request.systemPrompt
    if (toolMode === 'fence') leanSystemPrompt += '\n\n' + buildToolsSystemPrompt(agentRole)

    return { systemPrompt, leanSystemPrompt, citations, contextTokens }
  }

  /** @deprecated Use buildSystemPromptAsync in streaming path */
  private buildSystemPrompt(
    request: AIRequest,
    activeFilePath: string | undefined,
    useContext: boolean,
    agentRole: AgentRole,
    enableTools: boolean
  ): { systemPrompt: string; citations: { title: string; path: string }[] } {
    // Kernel layer always present (Prompt Registry default — sendMessage path)
    let systemPrompt = renderPrompt('kernel')
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
      systemPrompt += '\n\n' + buildToolsSystemPrompt(agentRole)
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
    const startedAt = Date.now()
    try {
      const res = await provider.sendMessage(request)
      logAIOutcome('send', {
        startedAt,
        ok: true,
        provider: provider.id,
        model: request.model,
        tokensUsed: res.tokensUsed
      })
      return { response: res, citations }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logAIOutcome('send', {
        startedAt,
        ok: false,
        error: msg,
        provider: provider.id,
        model: request.model
      })
      throw err
    }
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
    // P3 audit logging: stream_start at entry, stream_end in finally with the
    // final status/tokens captured from the LAST done chunk (never per-chunk).
    const startedAt = Date.now()
    const { wrapped, finalMeta } = withStreamAudit(onChunk)
    let providerId: string | undefined
    try {
      providerId = this.getActiveProvider().id
    } catch {
      /* provider may be unconfigured — runStreamInner surfaces the error */
    }
    logAIEvent({
      kind: 'stream_start',
      provider: providerId,
      model: request.model,
      requestId,
      role: agentRole,
      status: 'started'
    })
    try {
      await this.runStreamInner(
        request,
        wrapped,
        activeFilePath,
        useContext,
        agentRole,
        enableTools,
        requestId,
        signal,
        controller
      )
    } finally {
      logAIEvent({
        kind: 'stream_end',
        provider: providerId,
        model: request.model,
        requestId,
        role: agentRole,
        status: finalMeta.status,
        tokensUsed: finalMeta.tokensUsed,
        error: finalMeta.error,
        rounds: finalMeta.rounds,
        durationMs: Date.now() - startedAt
      })
      if (requestId) this.abortControllers.delete(requestId)
    }
  }

  /**
   * Sequential agent pipeline (P1): runs each PipelineStage as a sub-invocation
   * of the tool loop, handing each stage's accumulated output to the next stage
   * as a synthetic user message. Intermediate `done` chunks are suppressed in
   * favor of a stage-boundary status chunk; only the final stage terminates the
   * stream. Proposals + citations accumulate across stages.
   */
  async streamPipeline(
    request: AIRequest,
    stages: PipelineStage[],
    onChunk: (chunk: StreamEvent) => void,
    activeFilePath?: string,
    useContext = true,
    requestId?: string
  ): Promise<void> {
    if (requestId) this.clearCancel(requestId)
    const controller = requestId ? new AbortController() : undefined
    if (controller && requestId) this.abortControllers.set(requestId, controller)
    const signal = controller?.signal
    const startedAt = Date.now()
    const { wrapped, finalMeta } = withStreamAudit(onChunk)
    let providerId: string | undefined
    try {
      providerId = this.getActiveProvider().id
    } catch {
      /* provider may be unconfigured */
    }
    logAIEvent({
      kind: 'pipeline',
      provider: providerId,
      model: request.model,
      requestId,
      stageCount: stages.length,
      status: 'started'
    })
    try {
      await this.runPipelineInner(
        request,
        stages,
        wrapped,
        activeFilePath,
        useContext,
        requestId,
        signal,
        controller
      )
    } finally {
      logAIEvent({
        kind: 'pipeline',
        provider: providerId,
        model: request.model,
        requestId,
        stageCount: stages.length,
        status: finalMeta.status,
        tokensUsed: finalMeta.tokensUsed,
        error: finalMeta.error,
        durationMs: Date.now() - startedAt
      })
      if (requestId) this.abortControllers.delete(requestId)
    }
  }

  private async runPipelineInner(
    request: AIRequest,
    stages: PipelineStage[],
    onChunk: (chunk: StreamEvent) => void,
    activeFilePath: string | undefined,
    useContext: boolean,
    requestId: string | undefined,
    signal: AbortSignal | undefined,
    controller: AbortController | undefined
  ): Promise<void> {
    if (stages.length === 0) {
      onChunk({ content: '', done: true, error: 'Pipeline: tidak ada stage' })
      return
    }

    let messages: AIMessage[] = [...request.messages]
    const allProposals: WriteProposal[] = []
    const allCitations: { title: string; path: string }[] = []

    for (let i = 0; i < stages.length; i++) {
      if (requestId && this.isCancelled(requestId)) {
        onChunk({
          content: '\n\n*(pipeline cancelled)*\n',
          done: true,
          citations: allCitations,
          proposals: allProposals
        })
        return
      }
      const stage = stages[i]
      const isLast = i === stages.length - 1
      const stageRequest: AIRequest = {
        ...request,
        messages,
        systemPrompt: [
          request.systemPrompt,
          `[Pipeline Stage ${i + 1}/${stages.length} — ${stage.role}]\n${stage.instruction}`
        ]
          .filter(Boolean)
          .join('\n\n')
      }

      let stageText = ''
      let stageError: string | undefined
      // runStreamInner clears its own cancel flag on abort, so we detect the
      // abort via the cancelled terminal chunk itself (can't trust isCancelled
      // after the call returns).
      let stageAborted = false
      let forwardedDone = false
      const stageOnChunk: (chunk: StreamEvent) => void = (chunk) => {
        if (chunk.content) stageText += chunk.content
        if (chunk.error) stageError = chunk.error
        if (chunk.proposals) {
          for (const p of chunk.proposals) {
            if (!allProposals.some((x) => x.id === p.id)) allProposals.push(p)
          }
        }
        if (chunk.citations) {
          for (const c of chunk.citations) {
            if (!allCitations.some((x) => x.path === c.path)) allCitations.push(c)
          }
        }
        if (chunk.done) {
          // Terminal = the middleware's own error/cancel/timeout markers (its
          // done chunks carry controlled content — model prose never rides here).
          const terminal =
            Boolean(chunk.error) ||
            chunk.content?.includes('(cancelled)') === true ||
            chunk.content?.includes('(timeout') === true
          if (!isLast && !terminal) {
            // Intermediate stage: boundary status instead of terminating the stream
            onChunk({
              content: `\n\n---\n*[Stage ${i + 1}/${stages.length}: ${stage.role}] selesai — melanjutkan ke ${stages[i + 1]?.role}…*\n\n`,
              done: false,
              citations: allCitations,
              round: chunk.round,
              toolStatus: `Stage ${i + 1}/${stages.length} done`
            })
            return
          }
          // Final stage (or terminal error/cancel): forward with accumulated refs
          forwardedDone = true
          if (chunk.content?.includes('(cancelled)') === true) stageAborted = true
          onChunk({ ...chunk, citations: allCitations, proposals: allProposals })
          return
        }
        onChunk(chunk)
      }

      await this.runStreamInner(
        stageRequest,
        stageOnChunk,
        activeFilePath,
        useContext,
        stage.role,
        true, // tools on for every stage — permissions gate what each role may call
        requestId,
        signal,
        controller
      )

      if (stageError || stageAborted || (requestId && this.isCancelled(requestId))) {
        // runStreamInner already forwarded a terminal chunk — just stop
        return
      }

      // Safety net: runStreamInner terminates with done on every path today, but
      // if a future path returns without one, the renderer must not hang forever.
      if (isLast && !forwardedDone) {
        onChunk({ content: '', done: true, citations: allCitations, proposals: allProposals })
        return
      }

      // Hand the stage's accumulated output to the next stage as context
      if (!isLast) {
        const cleaned = stripToolActions(stageText).trim()
        messages = [
          ...messages,
          {
            role: 'user',
            content: `[Hasil Stage ${i + 1} — ${stage.role}]\n${cleaned || '(tidak ada output)'}\n\nLanjutkan ke stage berikutnya.`
          }
        ]
      }
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

    const { systemPrompt, leanSystemPrompt, citations, contextTokens } =
      await this.buildSystemPromptAsync(request, activeFilePath, useContext, agentRole, toolMode)

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

    // P1-runtime token accounting: OpenAI-compat providers (Grok/OpenAI/OpenRouter)
    // report usage.total_tokens on their final chunk; Claude/Gemini/Ollama report
    // nothing, so estimate from streamed chars (~4 chars/token) and attach the
    // estimate to the terminal done chunk — the UI budget bar is never stuck at 0.
    // NOTE: the estimate covers provider OUTPUT only (middleware-injected text
    // like proposal notices is intentionally excluded) — don't "fix" that into
    // double counting when a provider starts reporting real usage.
    let reportedTokens = false
    let estimatedTokens = 0

    // P1-4: count provider calls actually made so the terminal chunk can report
    // how much context billing was avoided (context estimate × rounds − 1).
    let sentRounds = 0
    const savedContextTokens = (): number | undefined =>
      contextTokens !== undefined && sentRounds > 1
        ? Math.round(contextTokens * (sentRounds - 1))
        : undefined

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
        // P1-4: workspace context only in round 0 — rounds 1+ reuse the lean
        // prompt (tool results carry the material; the full context would be
        // re-billed on every continuation of a multi-round stream).
        systemPrompt: round === 0 ? systemPrompt : leanSystemPrompt,
        stream: true
      }
      if (nativeTools) {
        // P1: only advertise the tools this role may call (researcher sees reads only)
        req.tools = buildToolSchemas(agentRole)
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
      sentRounds++
      const streamPromise = provider.streamMessage(
        req,
        (chunk) => {
          if (timedOut || (requestId && this.isCancelled(requestId))) return
          if (chunk.tokensUsed !== undefined && chunk.tokensUsed > 0) reportedTokens = true
          if (chunk.content) estimatedTokens += Math.ceil(chunk.content.length / 4)
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
            tokensUsed: chunk.tokensUsed,
            // P2-4: reasoning deltas ride through untouched (never appended to
            // the answer text / citation check — it's chain-of-thought, not output).
            reasoning: chunk.reasoning
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
          proposals: allProposals,
          tokensUsed: reportedTokens ? undefined : estimatedTokens,
          contextSavedTokens: savedContextTokens()
        })
        return
      }

      if (!enableTools) {
        onChunk({
          content: '',
          done: true,
          citations: lastCitations,
          proposals: allProposals,
          verifications: getVerifications(),
          tokensUsed: reportedTokens ? undefined : estimatedTokens,
          contextSavedTokens: savedContextTokens()
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
          verifications: getVerifications(),
          tokensUsed: reportedTokens ? undefined : estimatedTokens,
          contextSavedTokens: savedContextTokens()
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
          toolRun: {
            runId: nextToolRunId(),
            tool: `? ${unknown.map((u) => u.action.tool).join(', ')}`,
            status: 'error',
            detail: 'Tool tidak dikenal — dilewati.',
            round
          }
        })
      }
      if (known.length === 0) {
        onChunk({
          content: '',
          done: true,
          citations: lastCitations,
          proposals: allProposals,
          verifications: getVerifications(),
          tokensUsed: reportedTokens ? undefined : estimatedTokens,
          contextSavedTokens: savedContextTokens()
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
        const runId = nextToolRunId()
        onChunk({
          content: '',
          done: false,
          toolStatus: `▸ ${p.action.tool}`,
          toolRun: { runId, tool: p.action.tool, status: 'running', round },
          round
        })
        const r = await executeToolWithTimeout(p.action, agentRole)
        results.push(r)
        if (p.callId) resultByCall.set(p.callId, r)
        if (!r.ok) {
          onChunk({
            content: `\n\n*(tool ${p.action.tool} failed: ${r.error})*\n`,
            done: false,
            toolStatus: `✗ ${p.action.tool}`,
            toolRun: { runId, tool: p.action.tool, status: 'error', detail: r.error, round },
            round
          })
        } else {
          onChunk({
            content: '',
            done: false,
            toolRun: {
              runId,
              tool: p.action.tool,
              status: 'ok',
              detail: toolResultDetail(r),
              round
            },
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
        const runId = nextToolRunId()
        onChunk({
          content: '',
          done: false,
          toolStatus: `▸ propose ${p.action.tool}`,
          toolRun: { runId, tool: p.action.tool, status: 'running', round },
          round
        })
        const r = await executeToolWithTimeout(p.action, agentRole)
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
              toolRun: {
                runId,
                tool: p.action.tool,
                status: 'ok',
                detail: `Proposal ${prop.mode} → ${prop.relativePath} — Apply di panel.`,
                round
              },
              round
            })
          }
        } else if (!r.ok) {
          onChunk({
            content: `\n\n*(write tool failed: ${r.error})*\n`,
            done: false,
            toolStatus: `✗ ${p.action.tool}`,
            toolRun: {
              runId,
              tool: p.action.tool,
              status: 'error',
              detail: r.error,
              round
            },
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
          verifications: getVerifications(),
          tokensUsed: reportedTokens ? undefined : estimatedTokens,
          contextSavedTokens: savedContextTokens()
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

    // P1-4: report the measured context savings for the whole stream (debug
    // builds can confirm the lean-prompt win without reading chunk fields).
    const savedContext = savedContextTokens()
    if (process.env.WG_DEBUG_CONTEXT === '1' && savedContext !== undefined) {
      console.log(
        `[AI context] P1-4: context ~${contextTokens} tok × ${sentRounds} rounds → lean prompt saves ~${savedContext} tok`
      )
    }
    onChunk({
      content: '\n\n*(max tool rounds reached)*\n',
      done: true,
      citations: lastCitations,
      proposals: allProposals,
      verifications: getVerifications(),
      tokensUsed: reportedTokens ? undefined : estimatedTokens,
      contextSavedTokens: savedContextTokens()
    })
  }
}

export const aiMiddleware = new AIMiddleware()
