export interface AIMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AIRequest {
  messages: AIMessage[]
  model?: string
  maxTokens?: number
  temperature?: number
  stream?: boolean
  systemPrompt?: string
}

export interface AIResponse {
  content: string
  model: string
  provider: string
  tokensUsed?: number
  finishReason?: string
}

export interface AIStreamChunk {
  content: string
  done: boolean
  model?: string
  error?: string
}

export interface ProviderCapabilities {
  chat: boolean
  streaming: boolean
  vision: boolean
  toolCalling: boolean
  embeddings: boolean
}

export interface ModelInfo {
  id: string
  name: string
  contextWindow?: number
  maxOutput?: number
}

export interface ProviderStatus {
  id: string
  name: string
  connected: boolean
  configured: boolean
  error?: string
  models: ModelInfo[]
  defaultModel?: string
}

export abstract class BaseProvider {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly capabilities: ProviderCapabilities

  protected apiKey: string = ''
  protected baseUrl: string = ''
  protected defaultModel: string = ''

  configure(config: { apiKey?: string; baseUrl?: string; defaultModel?: string }): void {
    if (config.apiKey !== undefined) this.apiKey = config.apiKey || ''
    if (config.baseUrl !== undefined) this.baseUrl = config.baseUrl || ''
    if (config.defaultModel !== undefined && config.defaultModel) {
      this.defaultModel = config.defaultModel
    }
  }

  getDefaultModel(): string {
    return this.defaultModel
  }

  getApiKeyMasked(): string {
    if (!this.apiKey) return ''
    if (this.apiKey.length <= 8) return '••••••••'
    return this.apiKey.slice(0, 4) + '…' + this.apiKey.slice(-4)
  }

  /** Lightweight: key present / base URL reachable — do NOT burn tokens */
  abstract healthCheck(): Promise<boolean>
  abstract listModels(): Promise<ModelInfo[]>
  abstract sendMessage(request: AIRequest): Promise<AIResponse>
  abstract streamMessage(request: AIRequest, onChunk: (chunk: AIStreamChunk) => void): Promise<void>

  isConfigured(): boolean {
    // Ollama needs no API key — "configured" means base URL set (default localhost)
    if (this.id === 'ollama') return Boolean((this.baseUrl && this.baseUrl.trim()) || true)
    return Boolean(this.apiKey && this.apiKey.trim().length > 0)
  }

  getStatus(): Omit<ProviderStatus, 'connected' | 'models' | 'configured'> {
    return { id: this.id, name: this.name, defaultModel: this.defaultModel }
  }
}
