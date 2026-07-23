import { GoogleGenAI } from '@google/genai'
import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  ModelInfo,
  ProviderCapabilities
} from './BaseProvider'

export class GeminiProvider extends BaseProvider {
  readonly id = 'gemini'
  readonly name = 'Google Gemini'
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    vision: true,
    toolCalling: true,
    embeddings: true
  }

  private ai: GoogleGenAI | null = null

  // Free-tier friendly default (pro often has limit:0 on free plan)
  protected defaultModel = 'gemini-2.0-flash'

  private getClient(): GoogleGenAI {
    if (!this.apiKey) {
      throw new Error('Gemini API Key is not set.')
    }
    if (!this.ai) {
      this.ai = new GoogleGenAI({ apiKey: this.apiKey })
    }
    return this.ai
  }

  configure(config: { apiKey?: string; baseUrl?: string; defaultModel?: string }): void {
    super.configure(config)
    if (config.apiKey) {
      this.ai = new GoogleGenAI({ apiKey: config.apiKey })
    }
  }

  /** Don't burn tokens — configured key = "connected" for UI */
  async healthCheck(): Promise<boolean> {
    return this.isConfigured()
  }

  async listModels(): Promise<ModelInfo[]> {
    // Flash first — Pro free-tier often returns quota limit:0
    return [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (recommended)', contextWindow: 1048576 },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576 },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', contextWindow: 1048576 },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (paid/quota)', contextWindow: 2097152 },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro (paid/quota)', contextWindow: 2097152 }
    ]
  }

  /** Parse SDK errors into short actionable Indonesian/English messages */
  static formatError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err)
    // Nested JSON from Google SDK
    let msg = raw
    try {
      const j = JSON.parse(raw)
      if (j?.error?.message) msg = String(j.error.message)
      if (j?.error?.code) msg = `[${j.error.code}] ${msg}`
    } catch {
      /* keep raw */
    }
    // Further nested stringified JSON
    if (
      msg.includes('"RESOURCE_EXHAUSTED"') ||
      msg.includes('429') ||
      /quota|rate.?limit/i.test(msg)
    ) {
      const modelMatch = msg.match(/model:\s*([a-z0-9.-]+)/i)
      const model = modelMatch?.[1] || 'gemini'
      return (
        `Kuota Gemini habis / rate limit (429) untuk model "${model}". ` +
        `Ganti ke model Flash (gemini-2.0-flash / gemini-2.5-flash), tunggu ~20 detik, ` +
        `atau cek billing: https://ai.google.dev/gemini-api/docs/rate-limits. ` +
        `Tips: matikan Context/Tools sementara agar token lebih hemat.`
      )
    }
    if (/API key|apiKey|invalid|PERMISSION|401|403/i.test(msg)) {
      return `API key Gemini tidak valid atau tidak punya akses. Cek key di https://aistudio.google.com/apikey — ${msg.slice(0, 200)}`
    }
    return msg.length > 500 ? msg.slice(0, 500) + '…' : msg
  }

  /** Gemini requires alternating user/model; system → systemInstruction */
  private buildContents(request: AIRequest) {
    const contents: { role: string; parts: { text: string }[] }[] = []
    for (const m of request.messages) {
      if (!m.content?.trim()) continue
      if (m.role === 'system') continue
      const role = m.role === 'assistant' ? 'model' : 'user'
      const last = contents[contents.length - 1]
      if (last && last.role === role) {
        last.parts[0].text += '\n\n' + m.content
      } else {
        contents.push({ role, parts: [{ text: m.content }] })
      }
    }
    // Must start with user
    if (contents.length && contents[0].role !== 'user') {
      contents.unshift({ role: 'user', parts: [{ text: '(continue)' }] })
    }
    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: 'Hello' }] })
    }
    return contents
  }

  async sendMessage(request: AIRequest): Promise<AIResponse> {
    const client = this.getClient()
    const model = request.model || this.defaultModel
    const contents = this.buildContents(request)

    const config: Record<string, unknown> = {}
    if (request.systemPrompt) config.systemInstruction = request.systemPrompt
    if (request.temperature !== undefined) config.temperature = request.temperature
    if (request.maxTokens) config.maxOutputTokens = request.maxTokens

    try {
      const response = await client.models.generateContent({ model, contents, config })
      return {
        content: response.text || '',
        model,
        provider: this.id
      }
    } catch (err) {
      throw new Error(`Gemini: ${GeminiProvider.formatError(err)}`)
    }
  }

  async streamMessage(request: AIRequest, onChunk: (chunk: AIStreamChunk) => void): Promise<void> {
    const client = this.getClient()
    const model = request.model || this.defaultModel
    const contents = this.buildContents(request)

    const config: Record<string, unknown> = {}
    // Cap system prompt size to protect free-tier input tokens
    if (request.systemPrompt) {
      const sp = request.systemPrompt
      config.systemInstruction =
        sp.length > 12000 ? sp.slice(0, 12000) + '\n…[context truncated]' : sp
    }
    if (request.temperature !== undefined) config.temperature = request.temperature
    if (request.maxTokens) config.maxOutputTokens = request.maxTokens

    const runStream = async (useModel: string) => {
      const responseStream = await client.models.generateContentStream({
        model: useModel,
        contents,
        config
      })
      for await (const chunk of responseStream) {
        if (chunk.text) {
          onChunk({ content: chunk.text, done: false, model: useModel })
        }
      }
      onChunk({ content: '', done: true, model: useModel })
    }

    try {
      await runStream(model)
    } catch (err) {
      const formatted = GeminiProvider.formatError(err)
      const isQuota = /429|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(formatted)
      const isPro = /pro/i.test(model)
      // Auto-fallback Pro → Flash when free-tier blocks Pro
      if (isQuota && isPro) {
        const fallback = 'gemini-2.0-flash'
        try {
          onChunk({
            content: `_(Model ${model} kuota habis → fallback ${fallback})_\n\n`,
            done: false,
            model: fallback
          })
          await runStream(fallback)
          return
        } catch (err2) {
          const msg2 = GeminiProvider.formatError(err2)
          onChunk({ content: '', done: true, model: fallback, error: `Gemini: ${msg2}` })
          return
        }
      }
      onChunk({ content: '', done: true, model, error: `Gemini: ${formatted}` })
    }
  }
}
