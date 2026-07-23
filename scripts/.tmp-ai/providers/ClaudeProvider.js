// src/main/ai/providers/ClaudeProvider.ts
import Anthropic from "@anthropic-ai/sdk";

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

// src/main/ai/providers/ClaudeProvider.ts
var ClaudeProvider = class extends BaseProvider {
  id = "claude";
  name = "Anthropic Claude";
  capabilities = {
    chat: true,
    streaming: true,
    vision: true,
    toolCalling: true,
    embeddings: false
  };
  client = null;
  defaultModel = "claude-3-5-sonnet-20241022";
  getClient() {
    if (!this.apiKey) {
      throw new Error("Claude API Key is not set.");
    }
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.apiKey });
    }
    return this.client;
  }
  configure(config) {
    super.configure(config);
    if (config.apiKey) {
      this.client = new Anthropic({ apiKey: config.apiKey });
    }
  }
  async healthCheck() {
    return this.isConfigured();
  }
  async listModels() {
    return [
      { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", contextWindow: 2e5 },
      { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", contextWindow: 2e5 },
      { id: "claude-3-opus-20240229", name: "Claude 3 Opus", contextWindow: 2e5 }
    ];
  }
  async sendMessage(request) {
    const client = this.getClient();
    const model = request.model || this.defaultModel;
    const messages = request.messages.filter((m) => m.role !== "system").map((m) => ({
      role: m.role,
      content: m.content
    }));
    const response = await client.messages.create({
      model,
      max_tokens: request.maxTokens || 4096,
      system: request.systemPrompt,
      messages,
      temperature: request.temperature
    });
    const textBlock = response.content.find((b) => b.type === "text");
    return {
      content: textBlock?.type === "text" ? textBlock.text : "",
      model,
      provider: this.id,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens
    };
  }
  async streamMessage(request, onChunk) {
    const client = this.getClient();
    const model = request.model || this.defaultModel;
    const messages = request.messages.filter((m) => m.role !== "system").map((m) => ({
      role: m.role,
      content: m.content
    }));
    try {
      if (messages.length === 0) {
        throw new Error("No messages to send");
      }
      const stream = await client.messages.stream({
        model,
        max_tokens: request.maxTokens || 4096,
        system: request.systemPrompt,
        messages,
        temperature: request.temperature
      });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          onChunk({ content: event.delta.text, done: false, model });
        }
      }
      onChunk({ content: "", done: true, model });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onChunk({ content: "", done: true, model, error: `Claude: ${msg}` });
    }
  }
};
export {
  ClaudeProvider
};
