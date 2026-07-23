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

// src/main/ai/providers/OllamaProvider.ts
var OllamaProvider = class extends BaseProvider {
  id = "ollama";
  name = "Ollama (Local AI)";
  capabilities = {
    chat: true,
    streaming: true,
    vision: true,
    toolCalling: false,
    embeddings: true
  };
  baseUrl = "http://localhost:11434";
  defaultModel = "llama3.2";
  async healthCheck() {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }
  async listModels() {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.models || []).map((m) => ({
        id: m.name,
        name: m.name
      }));
    } catch {
      return [
        { id: "llama3.2", name: "Llama 3.2" },
        { id: "mistral", name: "Mistral" },
        { id: "qwen2.5", name: "Qwen 2.5" }
      ];
    }
  }
  async sendMessage(request) {
    const model = request.model || this.defaultModel;
    const messages = request.messages.map((m) => ({
      role: m.role,
      content: m.content
    }));
    if (request.systemPrompt) {
      messages.unshift({ role: "system", content: request.systemPrompt });
    }
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false
      })
    });
    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.statusText}`);
    }
    const data = await res.json();
    return {
      content: data.message.content,
      model,
      provider: this.id
    };
  }
  async streamMessage(request, onChunk) {
    const model = request.model || this.defaultModel;
    const messages = request.messages.map((m) => ({
      role: m.role,
      content: m.content
    }));
    if (request.systemPrompt) {
      messages.unshift({ role: "system", content: request.systemPrompt });
    }
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true
      })
    });
    try {
      if (!res.ok || !res.body) {
        throw new Error(`Ollama stream error: ${res.status} ${res.statusText}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        const lines = text.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            if (json.error) throw new Error(json.error);
            if (json.message?.content) {
              onChunk({ content: json.message.content, done: false, model });
            }
            if (json.done) {
              onChunk({ content: "", done: true, model });
              return;
            }
          } catch (e) {
            if (e instanceof Error && e.message !== "Unexpected end of JSON input") {
              if (e.message.startsWith("{")) continue;
              throw e;
            }
          }
        }
      }
      onChunk({ content: "", done: true, model });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onChunk({
        content: "",
        done: true,
        model,
        error: `Ollama: ${msg}. Pastikan Ollama jalan di ${this.baseUrl}`
      });
    }
  }
};
export {
  OllamaProvider
};
