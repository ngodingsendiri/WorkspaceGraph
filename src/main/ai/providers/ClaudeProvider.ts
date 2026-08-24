import Anthropic from '@anthropic-ai/sdk'
import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  ModelInfo,
  ProviderCapabilities
} from './BaseProvider'
import { fetchAnthropicModels, mergeWithFallback } from './modelDiscovery'
import { withProviderRetry } from './providerRetry'

export class ClaudeProvider extends BaseProvider {
  readonly id = 'claude'
  readonly name = 'Anthropic Claude'
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    vision: true,
    // P-A1: native function calling belum di-wire (bukan OpenAI-compat) — tool
    // loop memakai fallback fence wg-action di AIMiddleware.
    toolCalling: false,
    embeddings: false
  }

  private client: Anthropic | null = null
  protected defaultModel = 'claude-3-5-sonnet-20241022'

  private getClient(): Anthropic {
    if (!this.apiKey) {
      throw new Error('Claude API Key is not set.')
    }
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.apiKey })
    }
    return this.client
  }

  configure(config: { apiKey?: string; baseUrl?: string; defaultModel?: string }): void {
    super.configure(config)
    if (config.apiKey) {
      this.client = new Anthropic({ apiKey: config.apiKey })
    }
    this.modelCache.clear()
  }

  async healthCheck(): Promise<boolean> {
    return this.healthWithTtl(async () => {
      if (!this.isConfigured()) return false
      const models = await fetchAnthropicModels(this.apiKey, this.baseUrl || undefined)
      return models.length > 0
    })
  }

  async listModels(): Promise<ModelInfo[]> {
    const cached = this.modelCache.get()
    if (cached) return cached
    // Runtime: Anthropic's GET /v1/models (the account's real catalog). Falls
    // back to the static snapshot when the endpoint is unreachable/older keys.
    const runtime = await fetchAnthropicModels(this.apiKey, this.baseUrl || undefined)
    const out = mergeWithFallback(runtime, [
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', contextWindow: 200000 },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', contextWindow: 200000 },
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', contextWindow: 200000 }
    ])
    if (out.length > 0) this.modelCache.set(out, runtime.length > 0)
    return out
  }

  /** Map WG messages to Anthropic messages — images become image blocks (P-A2). */
  private toClaudeMessages(request: AIRequest): Anthropic.MessageParam[] {
    return request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'user' && m.images?.length) {
          return {
            role: 'user' as const,
            content: [
              ...m.images.map((img) => ({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  // mimeType is a plain string; the SDK wants the literal union —
                  // the renderer already guards to png/jpeg/webp/gif on attach.
                  media_type: img.mimeType as Anthropic.Base64ImageSource['media_type'],
                  data: img.dataBase64
                }
              })),
              { type: 'text' as const, text: m.content }
            ]
          }
        }
        return { role: m.role as 'user' | 'assistant', content: m.content }
      })
  }

  async sendMessage(request: AIRequest): Promise<AIResponse> {
    const client = this.getClient()
    const model = request.model || this.defaultModel

    const messages = this.toClaudeMessages(request)

    // R0-3: transient 429/5xx are retried with backoff before surfacing
    const response = await withProviderRetry(() =>
      client.messages.create({
        model,
        max_tokens: request.maxTokens || 4096,
        system: request.systemPrompt,
        messages,
        temperature: request.temperature
      })
    )

    const textBlock = response.content.find((b) => b.type === 'text')
    return {
      content: textBlock?.type === 'text' ? textBlock.text : '',
      model,
      provider: this.id,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens
    }
  }

  async streamMessage(
    request: AIRequest,
    onChunk: (chunk: AIStreamChunk) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const client = this.getClient()
    const model = request.model || this.defaultModel

    const messages = this.toClaudeMessages(request)

    try {
      if (messages.length === 0) {
        throw new Error('No messages to send')
      }
      const stream = client.messages.stream(
        {
          model,
          max_tokens: request.maxTokens || 4096,
          system: request.systemPrompt,
          messages,
          temperature: request.temperature
        },
        { signal }
      )

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          onChunk({ content: event.delta.text, done: false, model })
        }
      }
      onChunk({ content: '', done: true, model })
    } catch (err) {
      if (signal?.aborted) return
      const msg = err instanceof Error ? err.message : String(err)
      onChunk({ content: '', done: true, model, error: `Claude: ${msg}` })
    }
  }
}
