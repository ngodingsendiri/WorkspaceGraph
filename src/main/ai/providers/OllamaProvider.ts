import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  ModelInfo,
  ProviderCapabilities
} from './BaseProvider'

export class OllamaProvider extends BaseProvider {
  readonly id = 'ollama'
  readonly name = 'Ollama (Local AI)'
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    vision: true,
    toolCalling: false,
    embeddings: true,
    reasoning: false,
    structuredOutput: false
  }

  protected baseUrl = 'http://localhost:11434'
  protected defaultModel = 'llama3.2'

  configure(config: { apiKey?: string; baseUrl?: string; defaultModel?: string }): void {
    super.configure(config)
    // BUGFIX: a base URL change (e.g. switching to a remote Ollama server)
    // must not serve the previous server's cached model list for 5 minutes.
    this.modelCache.clear()
  }

  async healthCheck(): Promise<boolean> {
    return this.healthWithTtl(async () => {
      try {
        const res = await fetch(`${this.baseUrl}/api/tags`)
        return res.ok
      } catch {
        return false
      }
    })
  }

  async listModels(): Promise<ModelInfo[]> {
    const cached = this.modelCache.get()
    if (cached) return cached
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`)
      if (!res.ok) return []
      const data = (await res.json()) as { models?: { name: string }[] }
      // Local models are free by definition ($0, runs on your machine)
      const out = (data.models || []).map((m) => ({ id: m.name, name: m.name, free: true }))
      if (out.length > 0) this.modelCache.set(out)
      return out
    } catch {
      return [
        { id: 'llama3.2', name: 'Llama 3.2', free: true },
        { id: 'mistral', name: 'Mistral', free: true },
        { id: 'qwen2.5', name: 'Qwen 2.5', free: true }
      ]
    }
  }

  /** Map WG messages to Ollama chat messages — vision images ride per-message. */
  private toOllamaMessages(request: AIRequest): {
    role: string
    content: string
    images?: string[]
  }[] {
    const messages = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      // Ollama expects raw base64 (no data: prefix) in message.images
      ...(m.images?.length ? { images: m.images.map((img) => img.dataBase64) } : {})
    }))
    if (request.systemPrompt) {
      messages.unshift({ role: 'system', content: request.systemPrompt })
    }
    return messages
  }

  async sendMessage(request: AIRequest): Promise<AIResponse> {
    const model = request.model || this.defaultModel

    const messages = this.toOllamaMessages(request)

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false
      })
    })

    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.statusText}`)
    }

    const data = (await res.json()) as { message: { content: string } }
    return {
      content: data.message.content,
      model,
      provider: this.id
    }
  }

  async streamMessage(
    request: AIRequest,
    onChunk: (chunk: AIStreamChunk) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const model = request.model || this.defaultModel

    const messages = this.toOllamaMessages(request)

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true
      }),
      signal
    })

    try {
      if (!res.ok || !res.body) {
        throw new Error(`Ollama stream error: ${res.status} ${res.statusText}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        const lines = text.split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const json = JSON.parse(line) as {
              message?: { content: string }
              done?: boolean
              error?: string
              done_reason?: string
            }
            if (json.error) throw new Error(json.error)
            if (json.message?.content) {
              onChunk({ content: json.message.content, done: false, model })
            }
            if (json.done) {
              // M2.4 (MC-4): Ollama reports done_reason on the final line —
              // 'length' means the generation hit the num_predict limit.
              const reason =
                json.done_reason === 'length'
                  ? 'length'
                  : json.done_reason === 'stop'
                    ? 'stop'
                    : undefined
              onChunk({
                content: '',
                done: true,
                model,
                ...(reason ? { finishReason: reason } : {})
              })
              return
            }
          } catch (e) {
            if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
              if (e.message.startsWith('{')) continue
              throw e
            }
          }
        }
      }
      onChunk({ content: '', done: true, model })
    } catch (err) {
      if (signal?.aborted) return
      const msg = err instanceof Error ? err.message : String(err)
      onChunk({
        content: '',
        done: true,
        model,
        error: `Ollama: ${msg}. Pastikan Ollama jalan di ${this.baseUrl}`
      })
    }
  }
}
