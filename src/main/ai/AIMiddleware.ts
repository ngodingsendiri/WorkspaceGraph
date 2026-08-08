import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  ProviderStatus,
  AIMessage,
  AIToolCall,
  ModelInfo
} from './providers/BaseProvider'
import { GrokProvider, importGrokCliAuth } from './providers/GrokProvider'
import { readProviderDefs, buildProviderMap, type AIProviderDef } from './providerRegistry'
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
  isDelegateTool,
  isToolAllowed,
  getProposal,
  buildToolSchemas,
  nativeCallsToActions,
  roleCanWriteMCP,
  type WriteProposal,
  type ToolResult,
  type ToolAction,
  type ToolAdvertOptions
} from './AgentTools'
import { mcpManager } from '../mcp/McpClientManager'
import { renderPrompt } from './PromptRegistry'
import { logAIEvent, logAIOutcome, type AIEventStatus } from './AIEventLog'
import { estimateStreamCostUsd } from './cost'
import { shouldFailoverError, failoverCandidatesFor } from './providerFailover'
import { verifyCitations, type CitationVerification } from './CitationVerifier'
import { compactMessages, contextBudgetForModel, RESERVED_OUTPUT_TOKENS } from './contextCompaction'

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
  /** R2-1: estimated USD cost of the whole stream (context input + output). */
  costUsd?: number
}

const MAX_TOOL_ROUNDS = 4

/**
 * R2-2: resume a truncated stream from its checkpoint. The renderer persists
 * (message index + round + contextTokens) when a stream ends cancelled /
 * timed-out / errored, then passes the round back on retry so the tool loop
 * continues from the interruption point instead of restarting at round 0
 * (which would re-run tools and re-bill the whole invocation).
 */
export interface StreamResume {
  /** Tool-loop round to continue from (0 = fresh stream). */
  round: number
  /** Workspace-context token estimate captured at interruption — informational
   * (the fresh request rebuilds its own context anyway). */
  contextTokens?: number
}

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
 * R1-3: result of a delegated sub-agent run — the tool result the parent
 * model sees, plus anything the sub-agent created that must bubble up to the
 * parent stream (proposals land in the user's dock; citations feed grounding).
 */
interface SubAgentOutcome {
  result: ToolResult
  proposals: WriteProposal[]
  citations: { title: string; path: string }[]
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
  role: AgentRole = 'general',
  opts: ToolAdvertOptions = {}
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
    executeTool(action, role, opts).then(
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
  finalMeta: {
    status: AIEventStatus
    tokensUsed?: number
    error?: string
    rounds?: number
    costUsd?: number
  }
} {
  const finalMeta: {
    status: AIEventStatus
    tokensUsed?: number
    error?: string
    rounds?: number
    costUsd?: number
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
      // R2-1: last terminal chunk carries the whole-stream cost estimate
      finalMeta.costUsd = c.costUsd
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

  constructor(overrides?: { providers?: Record<string, BaseProvider>; defs?: AIProviderDef[] }) {
    this.contextEngine = new ContextEngine(workspaceEngine, searchEngine)

    // Dynamic provider set: the persisted defs (or the built-in seeds) decide
    // which adapters exist. Custom entries become generic OpenAI-compatible
    // providers; builtins keep their special adapters (Grok CLI, Gemini SDK,
    // Ollama probe). Settings → add/edit/delete swaps this set at runtime.
    const defs = overrides?.defs ?? readProviderDefs(workspaceEngine.getSettings())
    for (const [id, p] of buildProviderMap(defs)) {
      this.providers.set(id, p)
    }

    // Test seam: inject fake providers (P-A1 native loop / fence fallback)
    if (overrides?.providers) {
      for (const [id, p] of Object.entries(overrides.providers)) {
        this.providers.set(id, p)
      }
    }
    // A deleted/absent provider must never stay the active one (default is
    // 'grok' — users can remove grok entirely, leaving it a dead pointer).
    // loadSettingsIntoProviders may still override to a valid saved value.
    if (!this.providers.has(this.activeProviderId)) {
      const first = this.providers.keys().next().value
      if (first) this.activeProviderId = first
    }
  }

  /** Replace the provider set from persisted defs (Settings add/edit/delete).
   * Keys are re-applied afterwards by loadSettingsIntoProviders. The active
   * provider survives when it still exists, otherwise falls back to the first. */
  rebuildProviders(defs: AIProviderDef[]): void {
    const next = buildProviderMap(defs)
    this.providers = next
    if (!next.has(this.activeProviderId)) {
      const first = next.keys().next().value
      if (first) this.activeProviderId = first
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
    if (!provider) {
      if (this.providers.size === 0) {
        throw new Error('No AI provider configured — add one in Settings → AI Providers')
      }
      throw new Error(`Active provider not configured: ${this.activeProviderId}`)
    }
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

  async getAllProvidersStatus(
    onProgress?: (status: ProviderStatus) => void
  ): Promise<ProviderStatus[]> {
    const providers = [...this.providers.values()]
    // P-model-discovery: fetch every provider's model list IN PARALLEL — a slow
    // /models endpoint (8s timeout each) must not serialize into ~48s of panel
    // hang on the first load. healthCheck runs concurrently too (only Ollama
    // does real work, but the pattern stays flat).
    const settled = await Promise.all(
      providers.map(async (provider) => {
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
        }
        let error: string | undefined
        if (provider.id === 'ollama') {
          error = connected ? undefined : 'Ollama offline (localhost:11434)'
        } else if (!configured) {
          error = 'API key belum di-set'
        }
        const status: ProviderStatus = {
          id: provider.id,
          name: provider.name,
          connected,
          configured,
          models,
          defaultModel: provider.getDefaultModel(),
          error,
          // When this list was really fetched (cache set time) — the Settings
          // card stamps "diperbarui HH:MM" so stale lists are visible at a glance
          modelsFetchedAt: provider.lastModelsFetchedAt() ?? undefined
        }
        // Per-provider progress push — lets the Settings panel flip its spinner
        // for THIS provider the moment its /models resolves (parallel batch, so
        // fast providers land long before slow ones). Optional: unit callers
        // (tests) omit it and just get the full array.
        onProgress?.(status)
        return status
      })
    )
    return settled
  }

  /**
   * Force-refresh ONE provider's runtime model list (Settings → Refresh
   * models): busts its TTL cache and hits GET /models again so a newly
   * saved key/base URL shows its real catalog without restarting.
   */
  async refreshProviderModels(
    providerId: string
  ): Promise<{ ok: boolean; models: ModelInfo[]; error?: string }> {
    const provider = this.providers.get(providerId)
    if (!provider) {
      return { ok: false, models: [], error: `Provider not found: ${providerId}` }
    }
    provider.clearModelCache()
    try {
      const models = await provider.listModels()
      return { ok: true, models }
    } catch (err) {
      return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) }
    }
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
    toolMode: 'native' | 'fence' | 'off',
    toolOptions: ToolAdvertOptions = {}
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
    // R0-1: MCP tools (role-filtered) ride the fence prompt for non-native
    // providers (Claude/Gemini/Ollama) via the manager's fence docs.
    if (toolMode === 'fence') {
      systemPrompt +=
        '\n\n' +
        buildToolsSystemPrompt(
          agentRole,
          mcpManager.getFenceDocs(toolOptions.planMode ? false : roleCanWriteMCP(agentRole)),
          toolOptions
        )
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
    if (toolMode === 'fence') {
      leanSystemPrompt +=
        '\n\n' +
        buildToolsSystemPrompt(
          agentRole,
          mcpManager.getFenceDocs(toolOptions.planMode ? false : roleCanWriteMCP(agentRole)),
          toolOptions
        )
    }

    // R1-3 plan mode: a hard behavioral contract riding BOTH the round-0 and
    // the lean prompt (rounds 1+ must keep planning, not start writing).
    if (toolOptions.planMode) {
      const planInstruction = [
        '',
        '[PLAN MODE — R1-3]',
        'Anda dalam PLAN MODE: JANGAN panggil tool tulis (write_note/append_note/create_note/create_from_template) atau MCP write.',
        'Kerjakan: (1) ANALISIS singkat situasi, (2) daftar LANGKAH implementasi bernomor, (3) panggil create_plan {title, goal, steps} sebagai langkah TERAKHIR agar rencana menjadi proposal yang bisa ditinjau user.',
        'Tulis seluruh analisis SEBELUM create_plan — stream berhenti setelah proposal plan dibuat.'
      ].join('\n')
      systemPrompt += '\n\n' + planInstruction
      leanSystemPrompt += '\n\n' + planInstruction
    }

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
    requestId?: string,
    planMode = false,
    resumeFrom?: StreamResume
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
      // R1-2: run the whole invocation with automatic provider failover — a
      // terminal error (401/403/429/5xx after the provider's own retries) on
      // the ACTIVE provider restarts the stream on the next configured one.
      // The returned id is the provider that actually served, so stream_end
      // records the real serving provider, not the one that was active first.
      providerId = await this.runStreamWithFailover(
        request,
        wrapped,
        activeFilePath,
        useContext,
        agentRole,
        enableTools,
        requestId,
        signal,
        controller,
        { planMode },
        resumeFrom
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
        costUsd: finalMeta.costUsd,
        durationMs: Date.now() - startedAt
      })
      if (requestId) this.abortControllers.delete(requestId)
    }
  }

  /**
   * R1-1: the model's context budget for compaction. Prefers the provider's
   * ACTUAL ModelInfo.contextWindow (listModels is TTL-cached, so warm calls are
   * instant); falls back to the static family map after a 250ms best-effort
   * race so a cold cache (first message of a session) can never stall the
   * stream start on an 8s /models fetch.
   */
  private async resolveCompactionBudget(provider: BaseProvider, model?: string): Promise<number> {
    const fromMap = contextBudgetForModel(model)
    if (!model) return fromMap
    try {
      const models = await Promise.race([
        provider.listModels(),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('budget timeout')), 250)
          t.unref?.()
        })
      ])
      const info = models.find((m) => m.id === model)
      if (info?.contextWindow && info.contextWindow > 0) return info.contextWindow
    } catch {
      /* cold cache / slow endpoint → static map */
    }
    return fromMap
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
        costUsd: finalMeta.costUsd,
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

      // R1-2: each stage independently gets provider failover (the note chunk
      // rides stageOnChunk → the user sees "failover" inside the stage too).
      await this.runStreamWithFailover(
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

  /**
   * R1-2: run the whole stream invocation with automatic provider failover.
   *
   * The ACTIVE provider runs first. When its stream ends in a TERMINAL error
   * (401/403/429/5xx — the provider-internal retry budget in providerRetry.ts
   * is already exhausted by then), the invocation restarts on the next
   * CONFIGURED provider (settings `aiFailoverOrder`, else registration order;
   * Ollama never participates — a dead local daemon isn't a cloud outage).
   *
   * The user sees a `*(failover: X → Y)*` note chunk (the failed attempt's
   * error chunk is swallowed so the UI never flashes an error mid-recovery),
   * and the AI event log records a `failover` event with from→target. The
   * stream_end event (logged by streamMessage) then records the provider that
   * ACTUALLY served. Watchdog timeouts / user cancels never fail over — only
   * hard provider errors.
   *
   * Returns the id of the provider that produced the terminal outcome (or
   * undefined when no provider was active/configured).
   */
  private async runStreamWithFailover(
    request: AIRequest,
    onChunk: (chunk: StreamEvent) => void,
    activeFilePath: string | undefined,
    useContext: boolean,
    agentRole: AgentRole,
    enableTools: boolean,
    requestId: string | undefined,
    signal: AbortSignal | undefined,
    controller: AbortController | undefined,
    opts: ToolAdvertOptions = {},
    resumeFrom?: StreamResume
  ): Promise<string | undefined> {
    let activeId: string | undefined
    try {
      activeId = this.getActiveProvider().id
    } catch {
      /* provider may be unconfigured — runStreamInner surfaces the error */
    }
    const settings = workspaceEngine.getSettings() as { aiFailoverOrder?: unknown } | undefined
    const candidates = activeId ? failoverCandidatesFor(this.providers, activeId, settings) : []

    // Fast path: no active provider or nothing to fail over to — behave exactly
    // like the pre-R1-2 single-provider flow.
    if (!activeId || candidates.length === 0) {
      await this.runStreamInner(
        request,
        onChunk,
        activeFilePath,
        useContext,
        agentRole,
        enableTools,
        requestId,
        signal,
        controller,
        opts,
        resumeFrom
      )
      return activeId
    }

    const chain: string[] = [activeId, ...candidates.map((c) => c.id)]
    // runStreamInner may stamp request.model with the first provider's default;
    // restore the caller's intent before every attempt so the next provider
    // falls back to ITS default rather than inheriting a foreign model id.
    const originalModel = request.model
    let servedBy: string | undefined = activeId
    let lastError: string | undefined

    try {
      for (let i = 0; i < chain.length; i++) {
        const providerId = chain[i]
        request.model = originalModel

        if (i > 0) {
          this.setActiveProvider(providerId)
          const from = chain[i - 1]
          onChunk({
            content: `\n\n*(⚠ failover: ${from} gagal (${lastError ?? 'unknown error'}) → mencoba ${providerId})*\n`,
            done: false,
            toolStatus: `Failover ke ${providerId}`
          })
          logAIEvent({
            kind: 'failover',
            provider: from,
            target: providerId,
            model: request.model,
            requestId,
            status: 'error',
            error: lastError
          })
        }

        // Hold the terminal chunk + mid-stream error markers: a failover-worthy
        // error must be swallowed (the note replaces it); success / final failure
        // is forwarded after the call. Mid-stream `done:false + error` markers
        // ride the same rule — the renderer treats `done && error` as terminal,
        // but a stale error field on a non-done chunk would still confuse it.
        let terminal: StreamEvent | undefined
        let midError: StreamEvent | undefined
        const capture: (c: StreamEvent) => void = (c) => {
          if (c.done) {
            terminal = c
            return
          }
          if (c.error) {
            midError = c
            return
          }
          onChunk(c)
        }
        await this.runStreamInner(
          request,
          capture,
          activeFilePath,
          useContext,
          agentRole,
          enableTools,
          requestId,
          signal,
          controller,
          opts,
          resumeFrom
        )
        servedBy = providerId

        const terminalError = terminal?.error
        const canFailover =
          Boolean(terminalError) && shouldFailoverError(terminalError) && i < chain.length - 1
        if (canFailover) {
          // Reviewer: guard against a cancel that lands BETWEEN attempts — the
          // user's Cancel shouldn't pay for a fresh provider round + note.
          if (requestId && this.isCancelled(requestId)) {
            if (terminal) onChunk(terminal)
            return servedBy
          }
          lastError = terminalError
          // swallow the failed attempt's error markers — recovery continues
          continue
        }
        // Forward the real terminal outcome (success, or the last provider's error)
        if (midError) onChunk(midError)
        if (terminal) onChunk(terminal)
        return servedBy
      }
      return servedBy
    } finally {
      // Failover is per-STREAM resilience: restore the user's configured active
      // provider so the next message starts from their selection again (a dead
      // key is still their choice — the note + AI event log make the recovery
      // visible). Never throws.
      if (activeId && activeId !== this.activeProviderId) {
        try {
          this.setActiveProvider(activeId)
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * R1-3: run a delegated sub-agent. The nested stream runs with the sub-
   * agent's OWN role (per-role tool gates apply to advertisement AND
   * execution), with delegate_subagent hidden so delegation cannot recurse.
   * Its final output becomes the tool result the parent model reads;
   * proposals + citations it created bubble up to the parent stream so the
   * user's dock and grounding checks stay complete.
   */
  private async runSubAgent(
    action: ToolAction,
    requestId: string | undefined,
    signal: AbortSignal | undefined,
    controller: AbortController | undefined
  ): Promise<SubAgentOutcome> {
    const role = String(action.args?.role || '').trim() as AgentRole
    const task = String(action.args?.task || '').trim()
    const valid: AgentRole[] = ['general', 'writer', 'researcher', 'curator', 'planner']
    if (!valid.includes(role)) {
      return {
        result: {
          tool: action.tool,
          ok: false,
          error: `delegate_subagent: role tidak dikenal "${role || '(kosong)'}"`
        },
        proposals: [],
        citations: []
      }
    }
    if (!task) {
      return {
        result: { tool: action.tool, ok: false, error: 'delegate_subagent: task kosong' },
        proposals: [],
        citations: []
      }
    }
    const subRequest: AIRequest = {
      // Sub-agent picks the provider's default model — never inherit the
      // parent's possibly foreign model id.
      model: undefined,
      maxTokens: 4000,
      messages: [{ role: 'user', content: task }],
      systemPrompt: `[Sub-agent — ${role}]\nAnda adalah sub-agent dengan peran "${role}" yang didelegasikan oleh agent utama. Selesaikan tugas di atas menggunakan tool yang tersedia. Balas HANYA dengan hasil kerja Anda — tanpa basa-basi, tanpa mengulang isi tugas.`
    }
    let output = ''
    let error: string | undefined
    const proposals: WriteProposal[] = []
    const citations: { title: string; path: string }[] = []
    const subOnChunk: (c: StreamEvent) => void = (c) => {
      if (c.content) output += c.content
      if (c.error) error = c.error
      if (c.proposals) {
        for (const p of c.proposals) {
          if (!proposals.some((x) => x.id === p.id)) proposals.push(p)
        }
      }
      if (c.citations) {
        for (const ct of c.citations) {
          if (!citations.some((x) => x.path === ct.path)) citations.push(ct)
        }
      }
    }
    await this.runStreamInner(
      subRequest,
      subOnChunk,
      undefined,
      false, // sub-agent context is the task itself — skip the context engine
      role,
      true, // tools on for the sub-agent; its role gates what it may call
      requestId,
      signal,
      controller,
      { excludeDelegate: true }
    )
    // Reviewer: a user cancel mid-sub-agent ends the nested stream with a
    // *(cancelled)* marker and NO error — surface it as a failed delegate
    // rather than an "ok" whose result text embeds the marker.
    if (requestId && this.isCancelled(requestId)) {
      return {
        result: { tool: action.tool, ok: false, error: 'delegate dibatalkan' },
        proposals,
        citations
      }
    }
    const cleaned = stripToolActions(output).trim()
    if (!cleaned && error) {
      return { result: { tool: action.tool, ok: false, error }, proposals, citations }
    }
    return {
      result: {
        tool: action.tool,
        ok: true,
        result: cleaned || '(sub-agent tidak menghasilkan output)'
      },
      proposals,
      citations
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
    controller: AbortController | undefined,
    opts: ToolAdvertOptions = {},
    resumeFrom?: StreamResume
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
      await this.buildSystemPromptAsync(
        request,
        activeFilePath,
        useContext,
        agentRole,
        toolMode,
        opts
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

    // R1-1: auto context compaction. When the estimated history crosses ~80%
    // of the model's context budget (minus injected workspace context and a
    // reply headroom), fold the OLDEST messages into a deterministic
    // [Compacted] block — the recent tail survives, so a 200-message chat
    // never stalls on provider limits. No extra model call (extractive).
    const compactBudget =
      (await this.resolveCompactionBudget(provider, request.model)) -
      (contextTokens ?? 0) -
      RESERVED_OUTPUT_TOKENS
    const compact = compactMessages(messages, Math.max(4096, compactBudget))
    if (compact.compactedCount > 0) {
      messages = compact.messages
      const freed =
        compact.freedTokens >= 1000
          ? `${(compact.freedTokens / 1000).toFixed(1)}k`
          : String(compact.freedTokens)
      onChunk({
        content: `\n\n*(context di-compact — ${compact.compactedCount} pesan lama diringkas, menghemat ±${freed} token)*\n`,
        done: false,
        toolStatus: `Context compacted (${compact.compactedCount} pesan)`
      })
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
    // R2-1: whole-stream USD estimate (context input + output tokens), attached
    // to the terminal done chunk so the budget bar/status line can show cost.
    // Always use estimatedTokens (chars/4 accumulator across ALL tool rounds)
    // as the output side — never zero it on provider-reporting, which would
    // under-count output cost when the provider sends a real usage chunk.
    const streamCostUsd = (): number =>
      estimateStreamCostUsd(
        request.model || provider.getDefaultModel(),
        contextTokens ?? 0,
        estimatedTokens,
        provider.modelPricing(request.model || provider.getDefaultModel())
      )

    // P1-4: count provider calls actually made so the terminal chunk can report
    // how much context billing was avoided (context estimate × rounds − 1).
    let sentRounds = 0
    const savedContextTokens = (): number | undefined =>
      contextTokens !== undefined && sentRounds > 1
        ? Math.round(contextTokens * (sentRounds - 1))
        : undefined

    // R2-2: a resumed stream continues from the checkpoint round — the tool
    // rounds already spent (and billed) before the interruption are NOT re-run.
    // Note: a cancel that lands BETWEEN rounds records the last COMPLETED round,
    // so resume conservatively re-runs it (one extra tool round + billing) rather
    // than orphaning tool results the model still needs in context. Total provider
    // calls across original + resume can therefore reach MAX_TOOL_ROUNDS + 1.
    const startRound = Math.max(0, Math.min(resumeFrom?.round ?? 0, MAX_TOOL_ROUNDS - 1))
    for (let round = startRound; round < (enableTools ? MAX_TOOL_ROUNDS : 1); round++) {
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
        // P1 / R1-3: advertise the tools this role may call under the current
        // mode (researcher sees reads only; plan mode reads + create_plan).
        // R0-1: MCP tools appended — role/write-gated (plan mode drops writes).
        req.tools = [
          ...buildToolSchemas(agentRole, undefined, opts),
          ...mcpManager.getToolSchemas(opts.planMode ? false : roleCanWriteMCP(agentRole))
        ]
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
          contextSavedTokens: savedContextTokens(),
          costUsd: streamCostUsd()
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
          contextSavedTokens: savedContextTokens(),
          costUsd: streamCostUsd()
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
          contextSavedTokens: savedContextTokens(),
          costUsd: streamCostUsd()
        })
        return
      }

      // R0-1: any mcp__ name is a KNOWN tool — a disconnected server must
      // surface executeTool's "tidak terhubung" error, never a misleading
      // "unknown tool skipped" (the model may call an advertised schema whose
      // server just dropped).
      const known = pending.filter(
        (p) =>
          isReadTool(p.action.tool) ||
          isWriteTool(p.action.tool) ||
          isDelegateTool(p.action.tool) ||
          mcpManager.isMcpTool(p.action.tool)
      )
      const unknown = pending.filter(
        (p) =>
          !isReadTool(p.action.tool) &&
          !isWriteTool(p.action.tool) &&
          !isDelegateTool(p.action.tool) &&
          !mcpManager.isMcpTool(p.action.tool)
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
          contextSavedTokens: savedContextTokens(),
          costUsd: streamCostUsd()
        })
        return
      }

      // R1-3: delegate_subagent runs a NESTED sub-agent stream — intercepted
      // here (the static executor can't stream). Executed after reads, before
      // writes; the loop continues so the model can use the sub-agent output.
      const delegates = known.filter((p) => isDelegateTool(p.action.tool))
      const rest = known.filter((p) => !isDelegateTool(p.action.tool))
      const readPending = rest.filter((p) => isReadTool(p.action.tool))
      // R0-1: MCP tools that aren't read-classified (write OR disconnected —
      // classification needs the live tool set) run on the sequential path so
      // executeTool surfaces the proper connect/write-gate error.
      const writePending = rest.filter(
        (p) => isWriteTool(p.action.tool) || mcpManager.isMcpTool(p.action.tool)
      )
      const results: ToolResult[] = []
      // Native loop: results must zip back to the model's tool_call_id
      const resultByCall = new Map<string, ToolResult>()

      // Reads first (gather facts), then write proposals.
      // R0-2: reads run in PARALLEL batches (rate-limit friendly) so N fact-gather
      // calls don't serialize into N×latency; writes stay sequential (deterministic
      // Apply order). The running/ok/error events are emitted in REQUEST order so
      // the UI tool-run trail never reorders even though calls overlap.
      const READ_BATCH_SIZE = 4
      const collectReadCitations = (r: ToolResult): void => {
        if (r.ok && r.tool === 'read_note' && r.result && typeof r.result === 'object') {
          const res = r.result as { title?: string; absolutePath?: string }
          if (res.absolutePath && res.title) {
            if (!lastCitations.some((c) => c.path === res.absolutePath)) {
              lastCitations = [...lastCitations, { title: res.title, path: res.absolutePath }]
            }
          }
        }
        if (r.ok && r.tool === 'search' && Array.isArray(r.result)) {
          for (const hit of r.result as { title: string; absolutePath: string }[]) {
            if (hit.absolutePath && !lastCitations.some((c) => c.path === hit.absolutePath)) {
              lastCitations = [...lastCitations, { title: hit.title, path: hit.absolutePath }]
            }
          }
        }
      }
      const runReadBatch = async (batch: (typeof readPending)[number][]): Promise<void> => {
        const runs = batch.map((p) => ({ p, runId: nextToolRunId() }))
        // running events first, in order — the trail shows the whole batch kicking off
        for (const { p, runId } of runs) {
          onChunk({
            content: '',
            done: false,
            toolStatus: `▸ ${p.action.tool}`,
            toolRun: { runId, tool: p.action.tool, status: 'running', round },
            round
          })
        }
        const executed = await Promise.all(
          runs.map(async ({ p, runId }) => ({
            p,
            runId,
            r: await executeToolWithTimeout(p.action, agentRole, opts)
          }))
        )
        // completion events in the SAME request order (deterministic UI trail)
        for (const { p, runId, r } of executed) {
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
          collectReadCitations(r)
        }
      }
      for (let i = 0; i < readPending.length; i += READ_BATCH_SIZE) {
        await runReadBatch(readPending.slice(i, i + READ_BATCH_SIZE))
      }

      // R1-3: dynamic pipeline — each delegated sub-agent runs a nested stream
      // with its own role (tool advertisement + execution gate follow it). Its
      // output returns to the model as a normal tool result; any proposals or
      // citations it created bubble up to the parent stream (the user's dock
      // and grounding checks stay complete).
      //
      // Defense-in-depth: the delegate is gated by the CURRENT mode TOO — plan
      // mode blocks delegation (a writer child could otherwise stage write
      // proposals mid-plan). The model never SEES the tool in plan mode, but a
      // hallucinated fence must not run either.
      for (const p of delegates) {
        const runId = nextToolRunId()
        const subRole = String(p.action.args?.role || '').trim()
        onChunk({
          content: '',
          done: false,
          toolStatus: `▸ sub-agent ${subRole || '?'}`,
          toolRun: { runId, tool: 'delegate_subagent', status: 'running', round },
          round
        })
        let r: ToolResult
        if (!isToolAllowed(agentRole, 'delegate_subagent', opts)) {
          r = {
            tool: 'delegate_subagent',
            ok: false,
            error: `delegate_subagent diblokir untuk role "${agentRole}"${opts.planMode ? ' (plan mode — delegasi off)' : ''}`
          }
        } else {
          const outcome = await this.runSubAgent(p.action, requestId, signal, controller)
          r = outcome.result
          for (const pr of outcome.proposals) {
            if (!allProposals.some((x) => x.id === pr.id)) allProposals.push(pr)
          }
          if (outcome.proposals.length > 0) {
            onChunk({ content: '', done: false, proposals: outcome.proposals })
          }
          for (const c of outcome.citations) {
            if (!lastCitations.some((x) => x.path === c.path)) {
              lastCitations = [...lastCitations, c]
            }
          }
        }
        results.push(r)
        if (p.callId) resultByCall.set(p.callId, r)
        if (!r.ok) {
          onChunk({
            content: `\n\n*(sub-agent gagal: ${r.error})*\n`,
            done: false,
            toolStatus: `✗ sub-agent ${subRole || '?'}`,
            toolRun: {
              runId,
              tool: 'delegate_subagent',
              status: 'error',
              detail: r.error,
              round
            },
            round
          })
        } else {
          onChunk({
            content: '',
            done: false,
            toolRun: {
              runId,
              tool: 'delegate_subagent',
              status: 'ok',
              detail: toolResultDetail(r),
              round
            },
            round
          })
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
        const r = await executeToolWithTimeout(p.action, agentRole, opts)
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
        } else {
          // Non-proposal write success (R0-1 MCP write tools execute directly —
          // external side effects, not vault proposals). Emit a completion event
          // so the tool-run trail doesn't hang on "running" forever.
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
      }

      // Only writes (no reads, no delegates) → stop so user can Apply. A
      // delegate round must CONTINUE — the model still has to synthesize the
      // sub-agent's output into its final answer.
      if (readPending.length === 0 && delegates.length === 0) {
        onChunk({
          content: '',
          done: true,
          citations: lastCitations,
          proposals: allProposals,
          verifications: getVerifications(),
          tokensUsed: reportedTokens ? undefined : estimatedTokens,
          contextSavedTokens: savedContextTokens(),
          costUsd: streamCostUsd()
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
      contextSavedTokens: savedContextTokens(),
      costUsd: streamCostUsd()
    })
  }
}

export const aiMiddleware = new AIMiddleware()
