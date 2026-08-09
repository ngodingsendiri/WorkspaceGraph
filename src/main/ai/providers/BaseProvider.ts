/** One native function call requested by the model (OpenAI tool_calls shape). */
export interface AIToolCall {
  id: string
  name: string
  /** JSON-stringified arguments — parsed by the tool executor. */
  arguments: string
}

/** An image attached to a chat message (vision, P-A2). */
export interface ImageAttachment {
  /** e.g. 'image/png' */
  mimeType: string
  /** Raw base64 payload — no data: prefix */
  dataBase64: string
  name?: string
}

export interface AIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  /** Native function calls on an assistant message (OpenAI tool_calls). */
  tool_calls?: AIToolCall[]
  /** Native tool result — required when role === 'tool' (OpenAI tool role). */
  tool_call_id?: string
  /** Images attached to a USER message — rendered as image content blocks. */
  images?: ImageAttachment[]
}

/** OpenAI-compatible function-tool schema (sent as `tools` on the request). */
export interface ProviderTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ProviderToolChoice = 'auto' | 'none' | { type: 'function'; function: { name: string } }

export interface AIRequest {
  messages: AIMessage[]
  model?: string
  maxTokens?: number
  temperature?: number
  stream?: boolean
  systemPrompt?: string
  /** OpenAI-compatible function tools (native function calling). */
  tools?: ProviderTool[]
  tool_choice?: ProviderToolChoice
  /** Images attached to the CURRENT prompt (attached to the last user message). */
  images?: ImageAttachment[]
}

export interface AIResponse {
  content: string
  model: string
  provider: string
  tokensUsed?: number
  finishReason?: string
  /** Native tool calls returned by the model (non-stream path). */
  toolCalls?: AIToolCall[]
}

export interface AIStreamChunk {
  content: string
  done: boolean
  model?: string
  error?: string
  /** Total tokens used by this completion (streamed usage, when provider reports it). */
  tokensUsed?: number
  /** Completed native tool calls (accumulated from stream deltas, final chunk). */
  toolCalls?: AIToolCall[]
  /** Streaming chain-of-thought delta (P2-4): xAI/DeepSeek `reasoning_content`,
   * OpenAI o-series `reasoning`. Rendered as a collapsible block in the UI. */
  reasoning?: string
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
  /** True when the provider reports/implies the model is free tier ($0). */
  free?: boolean
  /** Provider-reported owner (OpenAI-compat `owned_by`), when available. */
  ownedBy?: string
  /** R2-1: runtime per-token USD pricing (OpenRouter /models) — exact when
   * present; cost.ts falls back to its static table otherwise. */
  pricing?: { input: number; output: number }
}

export interface ProviderStatus {
  id: string
  name: string
  connected: boolean
  configured: boolean
  error?: string
  models: ModelInfo[]
  defaultModel?: string
  /** Unix ms when the model list was last fetched from the API (cache set time). */
  modelsFetchedAt?: number
  /** Last live-ping failure (Settings → Test), e.g. invalid API key. Cleared on the
   * next successful test or model-list fetch, so the card stops showing it once
   * the key works again. */
  testError?: string
  /** Why the model list is empty — the GET /models fetch failed (bad key, wrong
   * base URL, offline). Lets the card explain "0 models" instead of hiding it. */
  modelsError?: string
}

import { createModelCache } from './modelDiscovery'

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

  /**
   * TTL cache for the runtime model list (shared by every provider). Cleared
   * by clearModelCache() — Settings → Refresh models — and on configure() so
   * a new key/base URL never serves a stale catalog.
   */
  protected modelCache = createModelCache()

  /** Bust the runtime model-list cache (Settings → Refresh models). */
  clearModelCache(): void {
    this.modelCache.clear()
  }

  /** When the current model list was last fetched (cache set time), or null.
   * Public so AIMiddleware can stamp ProviderStatus.modelsFetchedAt. */
  lastModelsFetchedAt(): number | null {
    return this.modelCache.fetchedAt()
  }

  /**
   * R2-1: runtime per-token pricing for a model, when the cached /models list
   * carries it (OpenRouter). Synchronous and never throws — returns null so
   * cost.ts falls back to the static table. Null when the cache is cold or
   * the model is unknown; listModels() warms it lazily on chat paths.
   */
  modelPricing(modelId: string | undefined | null): { input: number; output: number } | null {
    try {
      const id = String(modelId || '')
      const list = this.modelCache.get()
      if (!list) return null
      const m = list.find((x) => x.id === id || x.id === id.replace(/\.[a-z]+$/i, ''))
      return m?.pricing ?? null
    } catch {
      return null
    }
  }

  /** Lightweight: key present / base URL reachable — do NOT burn tokens */
  abstract healthCheck(): Promise<boolean>
  abstract listModels(): Promise<ModelInfo[]>
  abstract sendMessage(request: AIRequest): Promise<AIResponse>
  /**
   * Stream chunks. Optional AbortSignal lets the caller stop the HTTP request
   * for real (cancel button must not keep burning tokens).
   */
  abstract streamMessage(
    request: AIRequest,
    onChunk: (chunk: AIStreamChunk) => void,
    signal?: AbortSignal
  ): Promise<void>

  isConfigured(): boolean {
    // Ollama needs no API key — "configured" means base URL set (default localhost)
    if (this.id === 'ollama') return Boolean((this.baseUrl && this.baseUrl.trim()) || true)
    return Boolean(this.apiKey && this.apiKey.trim().length > 0)
  }

  getStatus(): Omit<ProviderStatus, 'connected' | 'models' | 'configured'> {
    return { id: this.id, name: this.name, defaultModel: this.defaultModel }
  }
}
