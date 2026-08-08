import OpenAI from 'openai'
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
  buildOpenAIMessages,
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

/** tools/tool_choice pass-through (cast: ProviderTool mirrors the SDK shape). */
function toolOptions(
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

/**
 * Generic OpenAI-compatible provider for user-added providers (any base URL:
 * Mistral, Together, vLLM, LM Studio, llama.cpp, Azure OpenAI, …). Behaves like
 * the OpenAI adapter — same SDK, delta extractors, retry and base-path
 * auto-detection — but its id/name/baseUrl come from the dynamic provider
 * registry instead of a hardcoded class.
 */
export class OpenAICompatProvider extends BaseProvider {
  readonly id: string
  readonly name: string
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    vision: true,
    toolCalling: true,
    embeddings: false
  }

  private client: OpenAI | null = null
  /** True once the chat base was probed this process (avoids re-probing). */
  private chatBaseProbed = false

  constructor(def: { id: string; name: string; baseUrl?: string; defaultModel?: string }) {
    super()
    this.id = def.id
    this.name = def.name
    this.baseUrl = (def.baseUrl || '').trim()
    if (def.defaultModel) this.defaultModel = def.defaultModel
  }

  /**
   * Lazily adopt the working versioned base before a chat call. If the user
   * pasted just a domain (no /v1), the first chat after restart must not 404
   * just because listModels() hasn't run yet — probe once and remember.
   */
  private async ensureChatBase(): Promise<void> {
    if (this.chatBaseProbed) return
    this.chatBaseProbed = true
    const cur = (this.baseUrl || '').trim().replace(/\/+$/, '')
    // Empty → SDK default (api.openai.com/v1) is already correct; versioned → done
    if (!cur || isVersionedBase(cur)) return
    const adopted = shouldAdoptChatBase(this.baseUrl, await discoverOpenAICompat(cur, this.apiKey))
    if (adopted) {
      this.baseUrl = adopted
      this.client = null // rebuild SDK client against the resolved base
    }
  }

  private getClient(): OpenAI {
    if (!this.apiKey) {
      throw new Error(`${this.name} API key is not set.`)
    }
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl || undefined
      })
    }
    return this.client
  }

  configure(config: { apiKey?: string; baseUrl?: string; defaultModel?: string }): void {
    super.configure(config)
    // A new key or base can make a previously-failed discovery succeed — never
    // keep the probe guard latched across a reconfiguration
    if (config.apiKey !== undefined || config.baseUrl !== undefined) this.chatBaseProbed = false
    // Rebuild the SDK client eagerly ONLY when a key is present — constructing
    // it with an empty key throws in OpenAI SDK v5, and a keyless configure
    // (base URL only) must never blow up at startup/registry-build time.
    const key = config.apiKey || this.apiKey
    if ((config.apiKey || config.baseUrl) && key) {
      this.client = new OpenAI({
        apiKey: key,
        baseURL: config.baseUrl || this.baseUrl || undefined
      })
    }
    this.modelCache.clear()
  }

  async healthCheck(): Promise<boolean> {
    return this.isConfigured()
  }

  async listModels(): Promise<ModelInfo[]> {
    const cached = this.modelCache.get()
    if (cached) return cached
    // Runtime: the gateway's REAL models from GET /models (base path
    // auto-detected — pasting just the domain works for any compat server).
    const discovered = await discoverOpenAICompat(
      this.baseUrl || 'https://api.openai.com/v1',
      this.apiKey
    )
    const adopted = shouldAdoptChatBase(this.baseUrl, discovered)
    if (adopted) {
      this.baseUrl = adopted
      this.client = null
    }
    const runtime = discovered?.models ?? []
    const merged = mergeWithFallback(runtime, [])
    const out = markFreeByHeuristic(merged)
    if (out.length > 0) this.modelCache.set(out, runtime.length > 0)
    return out
  }

  async sendMessage(request: AIRequest): Promise<AIResponse> {
    await this.ensureChatBase()
    const client = this.getClient()
    const model = request.model || this.defaultModel
    const messages = buildOpenAIMessages(request)

    const response = await withProviderRetry(() =>
      client.chat.completions.create({
        model,
        messages,
        temperature: request.temperature,
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        ...toolOptions(request)
      })
    )

    const choice = response.choices[0]
    const rawCalls = choice.message.tool_calls as
      { id?: string; function?: { name?: string; arguments?: string } }[] | undefined
    const toolCalls: AIToolCall[] | undefined = rawCalls
      ?.map((tc) => ({
        id: tc.id || '',
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || ''
      }))
      .filter((c) => c.name)
    return {
      content: choice.message.content || '',
      model,
      provider: this.id,
      tokensUsed: response.usage?.total_tokens,
      ...(toolCalls?.length ? { toolCalls } : {})
    }
  }

  async streamMessage(
    request: AIRequest,
    onChunk: (chunk: AIStreamChunk) => void,
    signal?: AbortSignal
  ): Promise<void> {
    await this.ensureChatBase()
    const client = this.getClient()
    const model = request.model || this.defaultModel
    const messages = buildOpenAIMessages(request)

    try {
      // Retry only the CREATE — a stream that already emitted chunks can't be
      // resumed without duplicating content. Stop if the user cancelled.
      const stream = await withProviderRetry(
        () =>
          client.chat.completions.create(
            {
              model,
              messages,
              temperature: request.temperature,
              stream: true,
              stream_options: { include_usage: true },
              ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
              ...toolOptions(request)
            },
            { signal }
          ),
        { shouldRetry: () => !(signal?.aborted ?? false) }
      )

      let tokensUsed: number | undefined
      const acc: MutableToolCall[] = []
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        const text = delta?.content || ''
        const reasoning = deltaReasoning(delta)
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
        ...(toolCalls.length ? { toolCalls } : {})
      })
    } catch (err) {
      // User cancelled — don't surface an error, just stop
      if (signal?.aborted) return
      const msg = err instanceof Error ? err.message : String(err)
      onChunk({ content: '', done: true, model, error: `${this.name}: ${msg}` })
    }
  }
}
