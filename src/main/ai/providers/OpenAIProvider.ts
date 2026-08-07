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

export class OpenAIProvider extends BaseProvider {
  readonly id = 'openai'
  readonly name = 'OpenAI'
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    vision: true,
    toolCalling: true,
    embeddings: true
  }

  private client: OpenAI | null = null
  protected defaultModel = 'gpt-4o-mini'

  private getClient(): OpenAI {
    if (!this.apiKey) {
      throw new Error('OpenAI API Key is not set.')
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseUrl || undefined })
    }
    return this.client
  }

  configure(config: { apiKey?: string; baseUrl?: string; defaultModel?: string }): void {
    super.configure(config)
    if (config.apiKey || config.baseUrl) {
      this.client = new OpenAI({
        apiKey: config.apiKey || this.apiKey,
        baseURL: config.baseUrl || this.baseUrl || undefined
      })
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.isConfigured()
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000 },
      { id: 'o1', name: 'o1', contextWindow: 200000 },
      { id: 'o3-mini', name: 'o3-mini', contextWindow: 200000 }
    ]
  }

  async sendMessage(request: AIRequest): Promise<AIResponse> {
    const client = this.getClient()
    const model = request.model || this.defaultModel
    const messages = buildOpenAIMessages(request)

    const response = await client.chat.completions.create({
      model,
      messages,
      temperature: request.temperature,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...toolOptions(request)
    })

    const choice = response.choices[0]
    // Cast: SDK v5 unions tool_calls with custom variants; we only consume the
    // standard function-calling shape.
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
    const client = this.getClient()
    const model = request.model || this.defaultModel
    const messages = buildOpenAIMessages(request)

    try {
      const stream = await client.chat.completions.create(
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
      )

      let tokensUsed: number | undefined
      // P-A1: accumulate streaming tool_calls deltas (args split across chunks)
      const acc: MutableToolCall[] = []
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        const text = delta?.content || ''
        // P2-4: o-series reasoning rides `delta.reasoning` (reasoning_content on
        // some compat servers) — surface it before the content arrives
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
      onChunk({ content: '', done: true, model, error: `OpenAI: ${msg}` })
    }
  }
}
