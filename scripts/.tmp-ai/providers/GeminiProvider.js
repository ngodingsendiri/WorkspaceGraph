// src/main/ai/providers/GeminiProvider.ts
import { GoogleGenAI } from "@google/genai";

// src/main/ai/providers/BaseProvider.ts
var BaseProvider = class {
  apiKey = "";
  baseUrl = "";
  defaultModel = "";
  configure(config) {
    if (config.apiKey !== void 0) this.apiKey = config.apiKey || "";
    if (config.baseUrl !== void 0) this.baseUrl = config.baseUrl || "";
    if (config.defaultModel !== void 0 && config.defaultModel) {
      this.defaultModel = config.defaultModel;
    }
  }
  getDefaultModel() {
    return this.defaultModel;
  }
  getApiKeyMasked() {
    if (!this.apiKey) return "";
    if (this.apiKey.length <= 8) return "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
    return this.apiKey.slice(0, 4) + "\u2026" + this.apiKey.slice(-4);
  }
  isConfigured() {
    if (this.id === "ollama") return Boolean(this.baseUrl || true);
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }
  getStatus() {
    return { id: this.id, name: this.name, defaultModel: this.defaultModel };
  }
};

// src/main/ai/providers/GeminiProvider.ts
var GeminiProvider = class _GeminiProvider extends BaseProvider {
  id = "gemini";
  name = "Google Gemini";
  capabilities = {
    chat: true,
    streaming: true,
    vision: true,
    toolCalling: true,
    embeddings: true
  };
  ai = null;
  // Free-tier friendly default (pro often has limit:0 on free plan)
  defaultModel = "gemini-2.0-flash";
  getClient() {
    if (!this.apiKey) {
      throw new Error("Gemini API Key is not set.");
    }
    if (!this.ai) {
      this.ai = new GoogleGenAI({ apiKey: this.apiKey });
    }
    return this.ai;
  }
  configure(config) {
    super.configure(config);
    if (config.apiKey) {
      this.ai = new GoogleGenAI({ apiKey: config.apiKey });
    }
  }
  /** Don't burn tokens — configured key = "connected" for UI */
  async healthCheck() {
    return this.isConfigured();
  }
  async listModels() {
    return [
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash (recommended)", contextWindow: 1048576 },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1048576 },
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", contextWindow: 1048576 },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (paid/quota)", contextWindow: 2097152 },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro (paid/quota)", contextWindow: 2097152 }
    ];
  }
  /** Parse SDK errors into short actionable Indonesian/English messages */
  static formatError(err) {
    const raw = err instanceof Error ? err.message : String(err);
    let msg = raw;
    try {
      const j = JSON.parse(raw);
      if (j?.error?.message) msg = String(j.error.message);
      if (j?.error?.code) msg = `[${j.error.code}] ${msg}`;
    } catch {
    }
    if (msg.includes('"RESOURCE_EXHAUSTED"') || msg.includes("429") || /quota|rate.?limit/i.test(msg)) {
      const modelMatch = msg.match(/model:\s*([a-z0-9.-]+)/i);
      const model = modelMatch?.[1] || "gemini";
      return `Kuota Gemini habis / rate limit (429) untuk model "${model}". Ganti ke model Flash (gemini-2.0-flash / gemini-2.5-flash), tunggu ~20 detik, atau cek billing: https://ai.google.dev/gemini-api/docs/rate-limits. Tips: matikan Context/Tools sementara agar token lebih hemat.`;
    }
    if (/API key|apiKey|invalid|PERMISSION|401|403/i.test(msg)) {
      return `API key Gemini tidak valid atau tidak punya akses. Cek key di https://aistudio.google.com/apikey \u2014 ${msg.slice(0, 200)}`;
    }
    return msg.length > 500 ? msg.slice(0, 500) + "\u2026" : msg;
  }
  /** Gemini requires alternating user/model; system → systemInstruction */
  buildContents(request) {
    const contents = [];
    for (const m of request.messages) {
      if (!m.content?.trim()) continue;
      if (m.role === "system") continue;
      const role = m.role === "assistant" ? "model" : "user";
      const last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts[0].text += "\n\n" + m.content;
      } else {
        contents.push({ role, parts: [{ text: m.content }] });
      }
    }
    if (contents.length && contents[0].role !== "user") {
      contents.unshift({ role: "user", parts: [{ text: "(continue)" }] });
    }
    if (contents.length === 0) {
      contents.push({ role: "user", parts: [{ text: "Hello" }] });
    }
    return contents;
  }
  async sendMessage(request) {
    const client = this.getClient();
    const model = request.model || this.defaultModel;
    const contents = this.buildContents(request);
    const config = {};
    if (request.systemPrompt) config.systemInstruction = request.systemPrompt;
    if (request.temperature !== void 0) config.temperature = request.temperature;
    if (request.maxTokens) config.maxOutputTokens = request.maxTokens;
    try {
      const response = await client.models.generateContent({ model, contents, config });
      return {
        content: response.text || "",
        model,
        provider: this.id
      };
    } catch (err) {
      throw new Error(`Gemini: ${_GeminiProvider.formatError(err)}`);
    }
  }
  async streamMessage(request, onChunk) {
    const client = this.getClient();
    const model = request.model || this.defaultModel;
    const contents = this.buildContents(request);
    const config = {};
    if (request.systemPrompt) {
      const sp = request.systemPrompt;
      config.systemInstruction = sp.length > 12e3 ? sp.slice(0, 12e3) + "\n\u2026[context truncated]" : sp;
    }
    if (request.temperature !== void 0) config.temperature = request.temperature;
    if (request.maxTokens) config.maxOutputTokens = request.maxTokens;
    const runStream = async (useModel) => {
      const responseStream = await client.models.generateContentStream({
        model: useModel,
        contents,
        config
      });
      for await (const chunk of responseStream) {
        if (chunk.text) {
          onChunk({ content: chunk.text, done: false, model: useModel });
        }
      }
      onChunk({ content: "", done: true, model: useModel });
    };
    try {
      await runStream(model);
    } catch (err) {
      const formatted = _GeminiProvider.formatError(err);
      const isQuota = /429|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(formatted);
      const isPro = /pro/i.test(model);
      if (isQuota && isPro) {
        const fallback = "gemini-2.0-flash";
        try {
          onChunk({
            content: `_(Model ${model} kuota habis \u2192 fallback ${fallback})_

`,
            done: false,
            model: fallback
          });
          await runStream(fallback);
          return;
        } catch (err2) {
          const msg2 = _GeminiProvider.formatError(err2);
          onChunk({ content: "", done: true, model: fallback, error: `Gemini: ${msg2}` });
          return;
        }
      }
      onChunk({ content: "", done: true, model, error: `Gemini: ${formatted}` });
    }
  }
};
export {
  GeminiProvider
};
