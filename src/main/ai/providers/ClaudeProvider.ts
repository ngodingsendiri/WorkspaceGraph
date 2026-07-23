import Anthropic from '@anthropic-ai/sdk'
import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  ModelInfo,
  ProviderCapabilities
} from './BaseProvider'

export class ClaudeProvider extends BaseProvider {
  readonly id = 'claude'
  readonly name = 'Anthropic Claude'
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    vision: true,
    toolCalling: true,
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
  }

  async healthCheck(): Promise<boolean> {
    return this.isConfigured()
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', contextWindow: 200000 },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', contextWindow: 200000 },
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', contextWindow: 200000 }
    ]
  }

  async sendMessage(request: AIRequest): Promise<AIResponse> {
    const client = this.getClient()
    const model = request.model || this.defaultModel

    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
      }))

    const response = await client.messages.create({
      model,
      max_tokens: request.maxTokens || 4096,
      system: request.systemPrompt,
      messages,
      temperature: request.temperature
    })

    const textBlock = response.content.find((b) => b.type === 'text')
    return {
      content: textBlock?.type === 'text' ? textBlock.text : '',
      model,
      provider: this.id,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens
    }
  }

  async streamMessage(request: AIRequest, onChunk: (chunk: AIStreamChunk) => void): Promise<void> {
    const client = this.getClient()
    const model = request.model || this.defaultModel

    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
      }))

    try {
      if (messages.length === 0) {
        throw new Error('No messages to send')
      }
      const stream = await client.messages.stream({
        model,
        max_tokens: request.maxTokens || 4096,
        system: request.systemPrompt,
        messages,
        temperature: request.temperature
      })

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          onChunk({ content: event.delta.text, done: false, model })
        }
      }
      onChunk({ content: '', done: true, model })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onChunk({ content: '', done: true, model, error: `Claude: ${msg}` })
    }
  }
}
