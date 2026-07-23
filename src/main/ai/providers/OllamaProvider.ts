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
    embeddings: true
  }

  protected baseUrl = 'http://localhost:11434'
  protected defaultModel = 'llama3.2'

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`)
      return res.ok
    } catch {
      return false
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`)
      if (!res.ok) return []
      const data = (await res.json()) as { models?: { name: string }[] }
      return (data.models || []).map((m) => ({
        id: m.name,
        name: m.name
      }))
    } catch {
      return [
        { id: 'llama3.2', name: 'Llama 3.2' },
        { id: 'mistral', name: 'Mistral' },
        { id: 'qwen2.5', name: 'Qwen 2.5' }
      ]
    }
  }

  async sendMessage(request: AIRequest): Promise<AIResponse> {
    const model = request.model || this.defaultModel

    const messages = request.messages.map((m) => ({
      role: m.role,
      content: m.content
    }))
    if (request.systemPrompt) {
      messages.unshift({ role: 'system', content: request.systemPrompt })
    }

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

  async streamMessage(request: AIRequest, onChunk: (chunk: AIStreamChunk) => void): Promise<void> {
    const model = request.model || this.defaultModel

    const messages = request.messages.map((m) => ({
      role: m.role,
      content: m.content
    }))
    if (request.systemPrompt) {
      messages.unshift({ role: 'system', content: request.systemPrompt })
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true
      })
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
            }
            if (json.error) throw new Error(json.error)
            if (json.message?.content) {
              onChunk({ content: json.message.content, done: false, model })
            }
            if (json.done) {
              onChunk({ content: '', done: true, model })
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
