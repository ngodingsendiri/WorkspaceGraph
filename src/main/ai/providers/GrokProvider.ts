/**
 * Grok / xAI provider
 * - Official API: https://api.x.ai/v1 (OpenAI-compatible chat) — works with CLI OIDC session
 * - Grok CLI: import from ~/.grok/auth.json + auto-refresh via refresh_token
 *
 * Note: cli-chat-proxy.grok.com requires private CLI version headers (426 without them).
 * Session tokens from the CLI work on api.x.ai, so we use that path for WorkspaceGraph.
 */
import OpenAI from 'openai'
import os from 'os'
import fs from 'fs'
import path from 'path'
import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  AIToolCall,
  ModelInfo,
  ProviderCapabilities
} from './BaseProvider'
import {
  accumulateToolCallDeltas,
  deltaReasoning,
  finalizeToolCalls,
  MutableToolCall
} from './openaiCompat'
import {
  discoverOpenAICompat,
  isVersionedBase,
  mergeWithFallback,
  markFreeByHeuristic,
  shouldAdoptChatBase
} from './modelDiscovery'
import { withProviderRetry } from './providerRetry'

export type GrokBackend = 'chat' | 'responses'

export interface GrokCliImportResult {
  ok: boolean
  error?: string
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
  email?: string
  authMode?: string
  backend?: GrokBackend
  source?: 'cli-session' | 'api-key'
}

const OFFICIAL_BASE = 'https://api.x.ai/v1'
const CLI_PROXY_BASE = 'https://cli-chat-proxy.grok.com/v1'
const AUTH_PATH = (): string => path.join(os.homedir(), '.grok', 'auth.json')

type CliSession = {
  key: string
  email?: string
  auth_mode?: string
  expires_at?: string
  refresh_token?: string
  oidc_issuer?: string
  oidc_client_id?: string
}

export class GrokProvider extends BaseProvider {
  readonly id = 'grok'
  readonly name = 'Grok (xAI)'
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    vision: true,
    toolCalling: true,
    embeddings: false,
    reasoning: true,
    structuredOutput: true
  }

  private client: OpenAI | null = null
  protected baseUrl = OFFICIAL_BASE
  protected defaultModel = 'grok-4.5'
  private backend: GrokBackend = 'chat'
  /** When true, re-read ~/.grok/auth.json (and refresh OIDC) before each call */
  private useCliSession = false
  private lastCliRefreshMs = 0
  /** True once the chat base was probed this process (avoids re-probing). */
  private chatBaseProbed = false

  /**
   * Lazily adopt the working versioned base before a chat call, so a
   * bare-domain baseUrl (user pasted only the host) works even before
   * listModels() ran. No-op for official/cli bases (already versioned).
   */
  private async ensureChatBase(): Promise<void> {
    if (this.chatBaseProbed) return
    this.chatBaseProbed = true
    const cur = (this.baseUrl || '').trim().replace(/\/+$/, '')
    if (!cur || isVersionedBase(cur)) return
    const adopted = shouldAdoptChatBase(this.baseUrl, await discoverOpenAICompat(cur, this.apiKey))
    if (adopted) {
      this.baseUrl = adopted
      this.client = null // rebuild SDK client against the resolved base
    }
  }

  setBackend(backend: GrokBackend): void {
    this.backend = backend
  }

  getBackend(): GrokBackend {
    return this.backend
  }

  private getClient(): OpenAI {
    if (!this.apiKey) {
      throw new Error(
        'Grok API key belum di-set. Import dari Grok CLI (Settings) atau paste key dari https://console.x.ai'
      )
    }
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl || OFFICIAL_BASE,
        defaultHeaders: {
          'X-Title': 'WorkspaceGraph',
          'User-Agent': 'WorkspaceGraph/1.0 (Grok-CLI-session)'
        }
      })
    }
    return this.client
  }

  configure(config: {
    apiKey?: string
    baseUrl?: string
    defaultModel?: string
    backend?: GrokBackend
    useCliSession?: boolean
  }): void {
    super.configure(config)
    if (config.backend) this.backend = config.backend
    if (config.useCliSession !== undefined) this.useCliSession = config.useCliSession
    // CLI sessions: always prefer official API (proxy rejects non-CLI clients)
    if (config.baseUrl?.includes('cli-chat-proxy')) {
      this.baseUrl = OFFICIAL_BASE
      this.backend = 'chat'
      this.useCliSession = true
    }
    if (config.apiKey !== undefined || config.baseUrl !== undefined) {
      this.client = null
    }
    // A new key or base can make a previously-failed discovery succeed
    if (config.apiKey !== undefined || config.baseUrl !== undefined) this.chatBaseProbed = false
    this.modelCache.clear()
  }

  async healthCheck(): Promise<boolean> {
    return this.healthWithTtl(async () => {
      if (!this.isConfigured()) return false
      const discovered = await discoverOpenAICompat(this.baseUrl, this.apiKey)
      return (discovered?.models?.length ?? 0) > 0
    })
  }

  async listModels(): Promise<ModelInfo[]> {
    const cached = this.modelCache.get()
    if (cached) return cached
    // Priority: (1) runtime GET /models for the configured key/base — the
    // account's real catalog, with the base path auto-detected (/v1 vs bare)
    // so pasting just the xAI domain works; (2) models cached by the Grok CLI
    // (if any); (3) the static snapshot. CLI cache used to be primary; it is
    // now just the fallback so a stale local cache can't shadow the live API.
    const discovered = await discoverOpenAICompat(this.baseUrl, this.apiKey)
    const adopted = shouldAdoptChatBase(this.baseUrl, discovered)
    if (adopted) {
      this.baseUrl = adopted
      this.client = null // rebuild SDK client against the resolved base
    }
    const runtime = discovered?.models ?? []
    const merged = mergeWithFallback(runtime, [
      ...readGrokCliModels(),
      { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 500000 },
      { id: 'grok-3', name: 'Grok 3', contextWindow: 131072 },
      { id: 'grok-3-mini', name: 'Grok 3 Mini', contextWindow: 131072 },
      { id: 'grok-2', name: 'Grok 2', contextWindow: 131072 }
    ])
    const out = markFreeByHeuristic(merged)
    if (out.length > 0) this.modelCache.set(out, runtime.length > 0)
    return out
  }

  /** Re-load CLI session + OIDC refresh if near expiry */
  async ensureSession(): Promise<void> {
    if (!this.useCliSession && !this.baseUrl.includes('cli-chat-proxy')) {
      // Still try CLI auth if no key
      if (!this.apiKey) {
        const imp = importGrokCliAuth()
        if (imp.ok && imp.apiKey) {
          this.configure({
            apiKey: imp.apiKey,
            baseUrl: OFFICIAL_BASE,
            defaultModel: imp.defaultModel,
            backend: 'chat',
            useCliSession: true
          })
        }
      }
      return
    }

    // Throttle disk/OIDC work
    const now = Date.now()
    if (now - this.lastCliRefreshMs < 15_000 && this.apiKey) return
    this.lastCliRefreshMs = now

    const session = await loadFreshCliSession()
    if (session?.key) {
      if (session.key !== this.apiKey) {
        this.apiKey = session.key
        this.client = null
      }
      this.useCliSession = true
      this.baseUrl = OFFICIAL_BASE
      this.backend = 'chat'
    }
  }

  private toChatMessages(request: AIRequest): OpenAI.ChatCompletionMessageParam[] {
    const messages: OpenAI.ChatCompletionMessageParam[] = []
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }
    for (const m of request.messages) {
      // Native tool loop: assistant tool_calls messages have empty content but
      // MUST NOT be dropped — they carry the function calls.
      if (!m.content?.trim() && !m.tool_calls?.length) continue
      if (m.role === 'system') {
        messages.push({ role: 'system', content: m.content })
      } else if (m.role === 'tool') {
        messages.push({ role: 'tool', tool_call_id: m.tool_call_id || '', content: m.content })
      } else if (m.role === 'assistant' && m.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.tool_calls.map((tc) => ({
            type: 'function',
            id: tc.id,
            function: {
              name: tc.name,
              arguments: tc.arguments
            }
          }))
        })
      } else if (m.role === 'assistant') {
        messages.push({ role: 'assistant', content: m.content })
      } else if (m.role === 'user' && m.images?.length) {
        // Vision (P-A2): xAI accepts the OpenAI image_url content-part shape.
        // Text part omitted for image-only prompts (empty text rejected by some)
        const parts: OpenAI.ChatCompletionContentPart[] = m.images.map((img) => ({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` }
        }))
        if (m.content.trim()) parts.push({ type: 'text', text: m.content })
        messages.push({ role: 'user', content: parts })
      } else {
        messages.push({ role: 'user', content: m.content })
      }
    }
    return messages
  }

  /** tools/tool_choice pass-through for the chat backend (native P-A1). */
  private toolOptions(
    request: AIRequest
  ):
    | { tools: OpenAI.ChatCompletionTool[]; tool_choice: OpenAI.ChatCompletionToolChoiceOption }
    | undefined {
    if (!request.tools?.length) return undefined
    return {
      tools: request.tools as unknown as OpenAI.ChatCompletionTool[],
      tool_choice: (request.tool_choice ?? 'auto') as OpenAI.ChatCompletionToolChoiceOption
    }
  }

  private toResponsesInput(request: AIRequest): string {
    const parts: string[] = []
    if (request.systemPrompt) parts.push(`[System]\n${request.systemPrompt}`)
    for (const m of request.messages) {
      if (!m.content?.trim()) continue
      const label = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User'
      parts.push(`[${label}]\n${m.content}`)
    }
    return parts.join('\n\n') || 'Hello'
  }

  async sendMessage(request: AIRequest): Promise<AIResponse> {
    await this.ensureSession()
    await this.ensureChatBase()
    const client = this.getClient()
    const model = request.model || this.defaultModel

    try {
      // Prefer chat; responses only if explicitly set and not forced official
      if (this.backend === 'responses' && this.baseUrl.includes('cli-chat-proxy')) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const resp = await (client as any).responses.create({
          model,
          input: this.toResponsesInput(request)
        })
        const text =
          resp.output_text ||
          resp.output
            ?.map((o: { content?: { text?: string }[] }) => o.content?.map((c) => c.text).join(''))
            .join('') ||
          ''
        return { content: text, model, provider: this.id }
      }

      const messages = this.toChatMessages(request)
      // R0-3: transient 429/5xx are retried with backoff before surfacing
      const response = await withProviderRetry(() =>
        client.chat.completions.create({
          model,
          messages,
          temperature: request.temperature,
          // max_tokens: OpenAI-compat; xAI accepts max_tokens / max_completion_tokens
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          ...this.toolOptions(request)
        })
      )
      const toolCalls = grokToolCallsFromMessage(response.choices[0]?.message)
      return {
        content: response.choices[0]?.message?.content || '',
        model,
        provider: this.id,
        tokensUsed: response.usage?.total_tokens,
        ...(toolCalls.length ? { toolCalls } : {})
      }
    } catch (err) {
      // One retry after forced CLI re-auth
      if (/401|Unauthorized|invalid/i.test(err instanceof Error ? err.message : String(err))) {
        this.lastCliRefreshMs = 0
        this.useCliSession = true
        await this.ensureSession()
        try {
          const messages = this.toChatMessages(request)
          const response = await this.getClient().chat.completions.create({
            model,
            messages,
            temperature: request.temperature,
            ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
            ...this.toolOptions(request)
          })
          const toolCalls2 = grokToolCallsFromMessage(response.choices[0]?.message)
          return {
            content: response.choices[0]?.message?.content || '',
            model,
            provider: this.id,
            tokensUsed: response.usage?.total_tokens,
            ...(toolCalls2.length ? { toolCalls: toolCalls2 } : {})
          }
        } catch (err2) {
          throw new Error(`Grok: ${formatGrokError(err2)}`)
        }
      }
      throw new Error(`Grok: ${formatGrokError(err)}`)
    }
  }

  async streamMessage(
    request: AIRequest,
    onChunk: (chunk: AIStreamChunk) => void,
    signal?: AbortSignal
  ): Promise<void> {
    await this.ensureSession()
    await this.ensureChatBase()
    const model = request.model || this.defaultModel

    const runChatStream = async (): Promise<void> => {
      const messages = this.toChatMessages(request)
      // R0-3: retry only the CREATE (a stream that already emitted chunks can't
      // resume); stop if the user cancelled during the backoff window
      const stream = await withProviderRetry(
        () =>
          this.getClient().chat.completions.create(
            {
              model,
              messages,
              temperature: request.temperature,
              stream: true,
              // Request usage so the final chunk reports total tokens (OpenAI-compat).
              stream_options: { include_usage: true } as never,
              ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
              ...this.toolOptions(request)
            },
            { signal }
          ),
        { shouldRetry: () => !(signal?.aborted ?? false) }
      )
      let tokensUsed: number | undefined
      // P-A1: accumulate streaming tool_calls deltas (args split across chunks)
      const acc: MutableToolCall[] = []
      let finishReason: AIStreamChunk['finishReason']
      for await (const chunk of stream) {
        if (signal?.aborted) return
        const choice = chunk.choices[0]
        const delta = choice?.delta
        const text = delta?.content || ''
        // P2-4: Grok 3 reasoning emits reasoning_content deltas before content
        const reasoning = deltaReasoning(delta)
        // M2.4 (MC-4): remember why the stream ended
        if (choice?.finish_reason === 'stop') finishReason = 'stop'
        else if (choice?.finish_reason === 'length') finishReason = 'length'
        if (text || reasoning) {
          onChunk({ content: text, done: false, model, ...(reasoning ? { reasoning } : {}) })
        }
        if (delta?.tool_calls) {
          accumulateToolCallDeltas(acc, delta.tool_calls)
        }
        if (chunk.usage?.total_tokens) tokensUsed = chunk.usage.total_tokens
      }
      const toolCalls = finalizeToolCalls(acc)
      onChunk({
        content: '',
        done: true,
        model,
        tokensUsed,
        ...(finishReason ? { finishReason } : {}),
        ...(toolCalls.length ? { toolCalls } : {})
      })
    }

    try {
      // Always use chat against official API for CLI sessions (proven working)
      if (this.useCliSession || this.baseUrl.includes('api.x.ai') || this.backend === 'chat') {
        // Force official base if we were pointing at blocked proxy
        if (this.baseUrl.includes('cli-chat-proxy')) {
          this.baseUrl = OFFICIAL_BASE
          this.backend = 'chat'
          this.client = null
        }
        await runChatStream()
        return
      }

      if (this.backend === 'responses') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stream = await (this.getClient() as any).responses.create({
          model,
          input: this.toResponsesInput(request),
          stream: true
        })
        for await (const event of stream) {
          if (signal?.aborted) return
          if (event?.type === 'response.output_text.delta' && event.delta) {
            onChunk({ content: String(event.delta), done: false, model })
          } else {
            const t =
              event?.delta ||
              event?.text ||
              event?.output_text ||
              event?.choices?.[0]?.delta?.content ||
              ''
            if (typeof t === 'string' && t) onChunk({ content: t, done: false, model })
          }
        }
        onChunk({ content: '', done: true, model })
        return
      }

      await runChatStream()
    } catch (_err) {
      if (signal?.aborted) return
      // Fallback: refresh session + chat on official API
      try {
        this.lastCliRefreshMs = 0
        this.useCliSession = true
        this.baseUrl = OFFICIAL_BASE
        this.backend = 'chat'
        this.client = null
        await this.ensureSession()
        await runChatStream()
        return
      } catch (err2) {
        const msg = formatGrokError(err2)
        onChunk({ content: '', done: true, model, error: `Grok: ${msg}` })
      }
    }
  }
}

/** Extract native tool calls from a non-stream chat message (sendMessage path). */
function grokToolCallsFromMessage(
  msg:
    { tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } | undefined
): AIToolCall[] {
  if (!msg?.tool_calls?.length) return []
  return msg.tool_calls
    .map((tc) => ({
      id: tc.id || '',
      name: tc.function?.name || '',
      arguments: tc.function?.arguments || ''
    }))
    .filter((c) => c.name)
}

function formatGrokError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/426|outdated|Upgrade Required/i.test(raw)) {
    return (
      'cli-chat-proxy menolak client non-CLI. WorkspaceGraph memakai api.x.ai — klik Import Grok CLI lagi. ' +
      raw.slice(0, 120)
    )
  }
  if (/401|Unauthorized|invalid.*key|api.?key/i.test(raw)) {
    return (
      'Auth gagal. Import ulang dari Grok CLI (login X) atau paste XAI_API_KEY dari https://console.x.ai — ' +
      raw.slice(0, 180)
    )
  }
  if (/429|quota|rate/i.test(raw)) {
    return `Rate limit / kuota: ${raw.slice(0, 200)}`
  }
  return raw.length > 400 ? raw.slice(0, 400) + '…' : raw
}

/** Read ~/.grok/auth.json — session from `grok` CLI (X account login) */
export function importGrokCliAuth(): GrokCliImportResult {
  const authPath = AUTH_PATH()
  if (!fs.existsSync(authPath)) {
    return {
      ok: false,
      error:
        'Grok CLI auth tidak ditemukan (~/.grok/auth.json). Jalankan `grok` di terminal dan login akun X dulu.'
    }
  }

  try {
    // Sync path: try disk first; if expired caller should use loadFreshCliSession
    const session = readCliSessionFromDisk()
    if (!session?.key) {
      return { ok: false, error: 'Tidak ada field key di auth.json Grok CLI' }
    }

    const expired = session.expires_at && Date.parse(session.expires_at) < Date.now()
    if (expired && !session.refresh_token) {
      return {
        ok: false,
        error: 'Sesi Grok CLI kadaluarsa. Jalankan `grok` di terminal dan login ulang akun X.'
      }
    }

    // Prefer models from CLI cache for default model id only
    const modelsMeta = readGrokCliModelsMeta()
    const defaultModel = modelsMeta.defaultModel || 'grok-4.5'

    // IMPORTANT: use official API — cli-chat-proxy returns 426 for non-CLI clients
    return {
      ok: true,
      apiKey: session.key,
      baseUrl: OFFICIAL_BASE,
      defaultModel,
      email: session.email,
      authMode: session.auth_mode,
      backend: 'chat',
      source: 'cli-session'
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

function readCliSessionFromDisk(): CliSession | null {
  const authPath = AUTH_PATH()
  if (!fs.existsSync(authPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as Record<string, CliSession>
    const entries = Object.entries(raw).filter(
      ([k]) => k.includes('auth.x.ai') || k.includes('x.ai')
    )
    const list = entries.length > 0 ? entries : Object.entries(raw)
    if (list.length === 0) return null

    let best: CliSession | null = null
    let bestExp = 0
    for (const [, s] of list) {
      if (!s?.key) continue
      const exp = s.expires_at ? Date.parse(s.expires_at) : Date.now()
      if (!best || exp > bestExp) {
        best = s
        bestExp = exp
      }
    }
    return best
  } catch {
    return null
  }
}

/** Load session; if expired (or within 2 min), OIDC refresh and write back auth.json */
async function loadFreshCliSession(): Promise<CliSession | null> {
  const session = readCliSessionFromDisk()
  if (!session?.key) return null

  const expMs = session.expires_at ? Date.parse(session.expires_at) : 0
  const needsRefresh = !expMs || expMs - Date.now() < 120_000

  if (!needsRefresh) return session
  if (!session.refresh_token || !session.oidc_client_id) {
    // Still return key — might work on api.x.ai until JWT exp
    return session
  }

  try {
    const issuer = session.oidc_issuer || 'https://auth.x.ai'
    const discRes = await fetch(`${issuer}/.well-known/openid-configuration`)
    if (!discRes.ok) return session
    const disc = (await discRes.json()) as { token_endpoint?: string }
    if (!disc.token_endpoint) return session

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refresh_token,
      client_id: session.oidc_client_id
    })
    const tokenRes = await fetch(disc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    if (!tokenRes.ok) {
      console.warn(
        '[Grok] OIDC refresh failed',
        tokenRes.status,
        await tokenRes.text().catch(() => '')
      )
      return session
    }
    const tok = (await tokenRes.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!tok.access_token) return session

    const expiresAt = new Date(Date.now() + (tok.expires_in || 21600) * 1000).toISOString()
    const updated: CliSession = {
      ...session,
      key: tok.access_token,
      refresh_token: tok.refresh_token || session.refresh_token,
      expires_at: expiresAt
    }

    // Persist back so Grok CLI + WG share session
    try {
      const authPath = AUTH_PATH()
      const raw = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as Record<string, CliSession>
      for (const k of Object.keys(raw)) {
        if (raw[k]?.email === session.email || raw[k]?.key === session.key) {
          raw[k] = { ...raw[k], ...updated }
        }
      }
      fs.writeFileSync(authPath, JSON.stringify(raw, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[Grok] could not write refreshed auth.json', e)
    }

    console.log('[Grok] OIDC session refreshed, expires', expiresAt)
    return updated
  } catch (e) {
    console.warn('[Grok] refresh error', e)
    return session
  }
}

function readGrokCliModelsMeta(): { baseUrl?: string; defaultModel?: string } {
  const p = path.join(os.homedir(), '.grok', 'models_cache.json')
  if (!fs.existsSync(p)) return {}
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      models?: Record<string, { info?: { id?: string; base_url?: string } }>
    }
    const models = j.models || {}
    const ids = Object.keys(models)
    if (ids.length === 0) return {}
    const preferred = ids.find((id) => id.includes('4.5')) || ids[0]
    const info = models[preferred]?.info
    return {
      defaultModel: info?.id || preferred,
      // Never return cli-chat-proxy for app use
      baseUrl: OFFICIAL_BASE
    }
  } catch {
    return {}
  }
}

function readGrokCliModels(): ModelInfo[] {
  const p = path.join(os.homedir(), '.grok', 'models_cache.json')
  if (!fs.existsSync(p)) return []
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      models?: Record<string, { info?: { id?: string; name?: string; context_window?: number } }>
    }
    return Object.entries(j.models || {}).map(([id, v]) => ({
      id: v.info?.id || id,
      name: v.info?.name || id,
      contextWindow: v.info?.context_window
    }))
  } catch {
    return []
  }
}

// silence unused — kept for docs
void CLI_PROXY_BASE
