// src/main/ai/providers/OpenAIProvider.ts
import OpenAI from "openai";

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

// src/main/ai/providers/OpenAIProvider.ts
var OpenAIProvider = class extends BaseProvider {
  id = "openai";
  name = "OpenAI";
  capabilities = {
    chat: true,
    streaming: true,
    vision: true,
    toolCalling: true,
    embeddings: true
  };
  client = null;
  defaultModel = "gpt-4o-mini";
  getClient() {
    if (!this.apiKey) {
      throw new Error("OpenAI API Key is not set.");
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseUrl || void 0 });
    }
    return this.client;
  }
  configure(config) {
    super.configure(config);
    if (config.apiKey || config.baseUrl) {
      this.client = new OpenAI({
        apiKey: config.apiKey || this.apiKey,
        baseURL: config.baseUrl || this.baseUrl || void 0
      });
    }
  }
  async healthCheck() {
    return this.isConfigured();
  }
  async listModels() {
    return [
      { id: "gpt-4o", name: "GPT-4o", contextWindow: 128e3 },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128e3 },
      { id: "o1", name: "o1", contextWindow: 2e5 },
      { id: "o3-mini", name: "o3-mini", contextWindow: 2e5 }
    ];
  }
  async sendMessage(request) {
    const client = this.getClient();
    const model = request.model || this.defaultModel;
    const messages = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    for (const m of request.messages) {
      messages.push({ role: m.role, content: m.content });
    }
    const response = await client.chat.completions.create({
      model,
      messages,
      temperature: request.temperature,
      ...request.maxTokens ? { max_tokens: request.maxTokens } : {}
    });
    const choice = response.choices[0];
    return {
      content: choice.message.content || "",
      model,
      provider: this.id,
      tokensUsed: response.usage?.total_tokens
    };
  }
  async streamMessage(request, onChunk) {
    const client = this.getClient();
    const model = request.model || this.defaultModel;
    const messages = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    for (const m of request.messages) {
      messages.push({ role: m.role, content: m.content });
    }
    try {
      const stream = await client.chat.completions.create({
        model,
        messages,
        temperature: request.temperature,
        stream: true,
        ...request.maxTokens ? { max_tokens: request.maxTokens } : {}
      });
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        if (text) {
          onChunk({ content: text, done: false, model });
        }
      }
      onChunk({ content: "", done: true, model });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onChunk({ content: "", done: true, model, error: `OpenAI: ${msg}` });
    }
  }
};
export {
  OpenAIProvider
};
