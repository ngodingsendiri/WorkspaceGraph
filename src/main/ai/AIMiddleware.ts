import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  ProviderStatus,
  AIMessage
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
  isReadTool,
  isWriteTool,
  getProposal,
  type WriteProposal,
  type ToolResult
} from './AgentTools'

export type StreamEvent = AIStreamChunk & {
  citations?: { title: string; path: string }[]
  proposals?: WriteProposal[]
  toolStatus?: string
  round?: number
}

const MAX_TOOL_ROUNDS = 4

export class AIMiddleware {
  private providers: Map<string, BaseProvider> = new Map()
  private activeProviderId: string = 'grok'
  private contextEngine: ContextEngine
  private abortFlags = new Map<string, boolean>()

  constructor() {
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
  }

  isCancelled(requestId?: string): boolean {
    if (!requestId) return false
    return this.abortFlags.get(requestId) === true
  }

  clearCancel(requestId: string): void {
    this.abortFlags.delete(requestId)
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

  private buildSystemPrompt(
    request: AIRequest,
    activeFilePath: string | undefined,
    useContext: boolean,
    agentRole: AgentRole,
    enableTools: boolean
  ): { systemPrompt: string; citations: { title: string; path: string }[] } {
    let systemPrompt = request.systemPrompt || ''
    let citations: { title: string; path: string }[] = []

    if (useContext && request.messages.length > 0) {
      const lastUserMsg = request.messages[request.messages.length - 1]
      if (lastUserMsg.role === 'user') {
        const ctxPackage = this.contextEngine.buildContextPackage(
          lastUserMsg.content,
          activeFilePath,
          agentRole
        )
        systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') + ctxPackage.formattedContext
        citations = ctxPackage.citations
      }
    }

    if (enableTools) {
      systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') + TOOLS_SYSTEM_PROMPT
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

    // Ensure model is set — avoid empty / accidental pro on free tier
    if (!request.model || request.model === 'undefined') {
      request.model = provider.getDefaultModel()
    }
    // Soft guard: gemini-2.5-pro often has free-tier limit 0
    if (
      provider.id === 'gemini' &&
      /gemini-2\.5-pro|gemini-1\.5-pro/i.test(request.model) &&
      process.env.WG_ALLOW_GEMINI_PRO !== '1'
    ) {
      // Don't force-switch (user may have paid tier) — just note in first chunk if fails
    }

    const { systemPrompt, citations } = this.buildSystemPrompt(
      request,
      activeFilePath,
      useContext,
      agentRole,
      enableTools
    )

    let messages: AIMessage[] = [...request.messages]
    if (messages.length === 0) {
      onChunk({ content: '', done: true, error: 'No messages in request' })
      return
    }

    const allProposals: WriteProposal[] = []
    let lastCitations = citations

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
      const req: AIRequest = {
        ...request,
        messages,
        systemPrompt,
        stream: true
      }

      await provider.streamMessage(req, (chunk) => {
        if (requestId && this.isCancelled(requestId)) return
        if (chunk.error) streamError = chunk.error
        fullText += chunk.content || ''
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
          round
        })
      })

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
        onChunk({ content: '', done: true, citations: lastCitations, proposals: allProposals })
        return
      }

      const actions = parseToolActions(fullText)
      if (actions.length === 0) {
        onChunk({ content: '', done: true, citations: lastCitations, proposals: allProposals })
        return
      }

      const readActions = actions.filter((a) => isReadTool(a.tool))
      const writeActions = actions.filter((a) => isWriteTool(a.tool))
      const results: ToolResult[] = []

      // Execute write tools → proposals (no disk until confirm)
      for (const action of writeActions) {
        onChunk({
          content: '',
          done: false,
          toolStatus: `Proposing ${action.tool}…`,
          round
        })
        const r = await executeTool(action)
        results.push(r)
        if (r.proposalId) {
          const prop = getProposal(r.proposalId)
          if (prop) {
            allProposals.push(prop)
            onChunk({
              content: `\n\n📝 **Write proposal** \`${prop.relativePath}\` (${prop.mode}) — confirm to apply.\n`,
              done: false,
              proposals: [prop],
              toolStatus: `Proposal ${prop.id}`,
              round
            })
          }
        }
      }

      // Execute read tools immediately
      for (const action of readActions) {
        onChunk({
          content: '',
          done: false,
          toolStatus: `Running ${action.tool}…`,
          round
        })
        const r = await executeTool(action)
        results.push(r)
        if (r.ok && action.tool === 'read_note' && r.result && typeof r.result === 'object') {
          const res = r.result as { title?: string; absolutePath?: string }
          if (res.absolutePath && res.title) {
            if (!lastCitations.some((c) => c.path === res.absolutePath)) {
              lastCitations = [...lastCitations, { title: res.title, path: res.absolutePath }]
            }
          }
        }
        if (r.ok && action.tool === 'search' && Array.isArray(r.result)) {
          for (const hit of r.result as { title: string; absolutePath: string }[]) {
            if (hit.absolutePath && !lastCitations.some((c) => c.path === hit.absolutePath)) {
              lastCitations = [...lastCitations, { title: hit.title, path: hit.absolutePath }]
            }
          }
        }
      }

      // If only writes, stop (user must confirm); model already proposed
      if (readActions.length === 0) {
        onChunk({ content: '', done: true, citations: lastCitations, proposals: allProposals })
        return
      }

      // Continue loop with tool results
      const cleanAssistant = stripToolActions(fullText) || fullText
      messages = [
        ...messages,
        { role: 'assistant', content: cleanAssistant },
        { role: 'user', content: formatToolResultsForModel(results) }
      ]

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
      proposals: allProposals
    })
  }
}

export const aiMiddleware = new AIMiddleware()
