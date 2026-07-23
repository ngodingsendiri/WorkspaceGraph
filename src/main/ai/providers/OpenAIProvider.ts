import OpenAI from 'openai'
import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  ModelInfo,
  ProviderCapabilities
} from './BaseProvider'

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

    const messages: OpenAI.ChatCompletionMessageParam[] = []
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }
    for (const m of request.messages) {
      messages.push({ role: m.role, content: m.content })
    }

    const response = await client.chat.completions.create({
      model,
      messages,
      temperature: request.temperature,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {})
    })

    const choice = response.choices[0]
    return {
      content: choice.message.content || '',
      model,
      provider: this.id,
      tokensUsed: response.usage?.total_tokens
    }
  }

  async streamMessage(request: AIRequest, onChunk: (chunk: AIStreamChunk) => void): Promise<void> {
    const client = this.getClient()
    const model = request.model || this.defaultModel

    const messages: OpenAI.ChatCompletionMessageParam[] = []
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }
    for (const m of request.messages) {
      messages.push({ role: m.role, content: m.content })
    }

    try {
      const stream = await client.chat.completions.create({
        model,
        messages,
        temperature: request.temperature,
        stream: true,
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {})
      })

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || ''
        if (text) {
          onChunk({ content: text, done: false, model })
        }
      }
      onChunk({ content: '', done: true, model })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onChunk({ content: '', done: true, model, error: `OpenAI: ${msg}` })
    }
  }
}
