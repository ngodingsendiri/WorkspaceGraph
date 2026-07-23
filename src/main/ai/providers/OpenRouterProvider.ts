import OpenAI from 'openai'
import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  ModelInfo,
  ProviderCapabilities
} from './BaseProvider'

export class OpenRouterProvider extends BaseProvider {
  readonly id = 'openrouter'
  readonly name = 'OpenRouter'
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    vision: true,
    toolCalling: true,
    embeddings: false
  }

  private client: OpenAI | null = null
  protected baseUrl = 'https://openrouter.ai/api/v1'
  protected defaultModel = 'anthropic/claude-3.5-sonnet'

  private getClient(): OpenAI {
    if (!this.apiKey) {
      throw new Error('OpenRouter API Key is not set.')
    }
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
        defaultHeaders: {
          'HTTP-Referer': 'https://workspacegraph.app',
          'X-Title': 'WorkspaceGraph'
        }
      })
    }
    return this.client
  }

  configure(config: { apiKey?: string; baseUrl?: string; defaultModel?: string }): void {
    super.configure(config)
    if (config.apiKey) {
      this.client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: this.baseUrl,
        defaultHeaders: {
          'HTTP-Referer': 'https://workspacegraph.app',
          'X-Title': 'WorkspaceGraph'
        }
      })
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.isConfigured()
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      { id: 'openai/gpt-4o', name: 'GPT-4o' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3' },
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B' }
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
      provider: this.id
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
      onChunk({ content: '', done: true, model, error: `OpenRouter: ${msg}` })
    }
  }
}
