// src/main/ai/providers/GrokProvider.ts
import OpenAI from "openai";
import os from "os";
import fs from "fs";
import path from "path";

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

// src/main/ai/providers/GrokProvider.ts
var OFFICIAL_BASE = "https://api.x.ai/v1";
var AUTH_PATH = () => path.join(os.homedir(), ".grok", "auth.json");
var GrokProvider = class extends BaseProvider {
  id = "grok";
  name = "Grok (xAI)";
  capabilities = {
    chat: true,
    streaming: true,
    vision: true,
    toolCalling: true,
    embeddings: false
  };
  client = null;
  baseUrl = OFFICIAL_BASE;
  defaultModel = "grok-4.5";
  backend = "chat";
  /** When true, re-read ~/.grok/auth.json (and refresh OIDC) before each call */
  useCliSession = false;
  lastCliRefreshMs = 0;
  setBackend(backend) {
    this.backend = backend;
  }
  getBackend() {
    return this.backend;
  }
  getClient() {
    if (!this.apiKey) {
      throw new Error(
        "Grok API key belum di-set. Import dari Grok CLI (Settings) atau paste key dari https://console.x.ai"
      );
    }
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl || OFFICIAL_BASE,
        defaultHeaders: {
          "X-Title": "WorkspaceGraph",
          "User-Agent": "WorkspaceGraph/1.0 (Grok-CLI-session)"
        }
      });
    }
    return this.client;
  }
  configure(config) {
    super.configure(config);
    if (config.backend) this.backend = config.backend;
    if (config.useCliSession !== void 0) this.useCliSession = config.useCliSession;
    if (config.baseUrl?.includes("cli-chat-proxy")) {
      this.baseUrl = OFFICIAL_BASE;
      this.backend = "chat";
      this.useCliSession = true;
    }
    if (config.apiKey !== void 0 || config.baseUrl !== void 0) {
      this.client = null;
    }
  }
  async healthCheck() {
    return this.isConfigured();
  }
  async listModels() {
    const cached = readGrokCliModels();
    if (cached.length > 0) return cached;
    return [
      { id: "grok-4.5", name: "Grok 4.5", contextWindow: 5e5 },
      { id: "grok-3", name: "Grok 3", contextWindow: 131072 },
      { id: "grok-3-mini", name: "Grok 3 Mini", contextWindow: 131072 },
      { id: "grok-2", name: "Grok 2", contextWindow: 131072 }
    ];
  }
  /** Re-load CLI session + OIDC refresh if near expiry */
  async ensureSession() {
    if (!this.useCliSession && !this.baseUrl.includes("cli-chat-proxy")) {
      if (!this.apiKey) {
        const imp = importGrokCliAuth();
        if (imp.ok && imp.apiKey) {
          this.configure({
            apiKey: imp.apiKey,
            baseUrl: OFFICIAL_BASE,
            defaultModel: imp.defaultModel,
            backend: "chat",
            useCliSession: true
          });
        }
      }
      return;
    }
    const now = Date.now();
    if (now - this.lastCliRefreshMs < 15e3 && this.apiKey) return;
    this.lastCliRefreshMs = now;
    const session = await loadFreshCliSession();
    if (session?.key) {
      if (session.key !== this.apiKey) {
        this.apiKey = session.key;
        this.client = null;
      }
      this.useCliSession = true;
      this.baseUrl = OFFICIAL_BASE;
      this.backend = "chat";
    }
  }
  toChatMessages(request) {
    const messages = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    for (const m of request.messages) {
      if (!m.content?.trim()) continue;
      if (m.role === "system") {
        messages.push({ role: "system", content: m.content });
      } else if (m.role === "assistant") {
        messages.push({ role: "assistant", content: m.content });
      } else {
        messages.push({ role: "user", content: m.content });
      }
    }
    return messages;
  }
  toResponsesInput(request) {
    const parts = [];
    if (request.systemPrompt) parts.push(`[System]
${request.systemPrompt}`);
    for (const m of request.messages) {
      if (!m.content?.trim()) continue;
      const label = m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User";
      parts.push(`[${label}]
${m.content}`);
    }
    return parts.join("\n\n") || "Hello";
  }
  async sendMessage(request) {
    await this.ensureSession();
    const client = this.getClient();
    const model = request.model || this.defaultModel;
    try {
      if (this.backend === "responses" && this.baseUrl.includes("cli-chat-proxy")) {
        const resp = await client.responses.create({
          model,
          input: this.toResponsesInput(request)
        });
        const text = resp.output_text || resp.output?.map((o) => o.content?.map((c) => c.text).join("")).join("") || "";
        return { content: text, model, provider: this.id };
      }
      const messages = this.toChatMessages(request);
      const response = await client.chat.completions.create({
        model,
        messages,
        temperature: request.temperature
      });
      return {
        content: response.choices[0]?.message?.content || "",
        model,
        provider: this.id,
        tokensUsed: response.usage?.total_tokens
      };
    } catch (err) {
      if (/401|Unauthorized|invalid/i.test(err instanceof Error ? err.message : String(err))) {
        this.lastCliRefreshMs = 0;
        this.useCliSession = true;
        await this.ensureSession();
        try {
          const messages = this.toChatMessages(request);
          const response = await this.getClient().chat.completions.create({
            model,
            messages,
            temperature: request.temperature
          });
          return {
            content: response.choices[0]?.message?.content || "",
            model,
            provider: this.id,
            tokensUsed: response.usage?.total_tokens
          };
        } catch (err2) {
          throw new Error(`Grok: ${formatGrokError(err2)}`);
        }
      }
      throw new Error(`Grok: ${formatGrokError(err)}`);
    }
  }
  async streamMessage(request, onChunk) {
    await this.ensureSession();
    const model = request.model || this.defaultModel;
    const runChatStream = async () => {
      const messages = this.toChatMessages(request);
      const stream = await this.getClient().chat.completions.create({
        model,
        messages,
        temperature: request.temperature,
        stream: true
      });
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        if (text) onChunk({ content: text, done: false, model });
      }
      onChunk({ content: "", done: true, model });
    };
    try {
      if (this.useCliSession || this.baseUrl.includes("api.x.ai") || this.backend === "chat") {
        if (this.baseUrl.includes("cli-chat-proxy")) {
          this.baseUrl = OFFICIAL_BASE;
          this.backend = "chat";
          this.client = null;
        }
        await runChatStream();
        return;
      }
      if (this.backend === "responses") {
        const stream = await this.getClient().responses.create({
          model,
          input: this.toResponsesInput(request),
          stream: true
        });
        for await (const event of stream) {
          if (event?.type === "response.output_text.delta" && event.delta) {
            onChunk({ content: String(event.delta), done: false, model });
          } else {
            const t = event?.delta || event?.text || event?.output_text || event?.choices?.[0]?.delta?.content || "";
            if (typeof t === "string" && t) onChunk({ content: t, done: false, model });
          }
        }
        onChunk({ content: "", done: true, model });
        return;
      }
      await runChatStream();
    } catch (err) {
      try {
        this.lastCliRefreshMs = 0;
        this.useCliSession = true;
        this.baseUrl = OFFICIAL_BASE;
        this.backend = "chat";
        this.client = null;
        await this.ensureSession();
        await runChatStream();
        return;
      } catch (err2) {
        const msg = formatGrokError(err2);
        onChunk({ content: "", done: true, model, error: `Grok: ${msg}` });
      }
    }
  }
};
function formatGrokError(err) {
  const raw = err instanceof Error ? err.message : String(err);
  if (/426|outdated|Upgrade Required/i.test(raw)) {
    return "cli-chat-proxy menolak client non-CLI. WorkspaceGraph memakai api.x.ai \u2014 klik Import Grok CLI lagi. " + raw.slice(0, 120);
  }
  if (/401|Unauthorized|invalid.*key|api.?key/i.test(raw)) {
    return "Auth gagal. Import ulang dari Grok CLI (login X) atau paste XAI_API_KEY dari https://console.x.ai \u2014 " + raw.slice(0, 180);
  }
  if (/429|quota|rate/i.test(raw)) {
    return `Rate limit / kuota: ${raw.slice(0, 200)}`;
  }
  return raw.length > 400 ? raw.slice(0, 400) + "\u2026" : raw;
}
function importGrokCliAuth() {
  const authPath = AUTH_PATH();
  if (!fs.existsSync(authPath)) {
    return {
      ok: false,
      error: "Grok CLI auth tidak ditemukan (~/.grok/auth.json). Jalankan `grok` di terminal dan login akun X dulu."
    };
  }
  try {
    const session = readCliSessionFromDisk();
    if (!session?.key) {
      return { ok: false, error: "Tidak ada field key di auth.json Grok CLI" };
    }
    const expired = session.expires_at && Date.parse(session.expires_at) < Date.now();
    if (expired && !session.refresh_token) {
      return {
        ok: false,
        error: "Sesi Grok CLI kadaluarsa. Jalankan `grok` di terminal dan login ulang akun X."
      };
    }
    const modelsMeta = readGrokCliModelsMeta();
    const defaultModel = modelsMeta.defaultModel || "grok-4.5";
    return {
      ok: true,
      apiKey: session.key,
      baseUrl: OFFICIAL_BASE,
      defaultModel,
      email: session.email,
      authMode: session.auth_mode,
      backend: "chat",
      source: "cli-session"
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
function readCliSessionFromDisk() {
  const authPath = AUTH_PATH();
  if (!fs.existsSync(authPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const entries = Object.entries(raw).filter(([k]) => k.includes("auth.x.ai") || k.includes("x.ai"));
    const list = entries.length > 0 ? entries : Object.entries(raw);
    if (list.length === 0) return null;
    let best = null;
    let bestExp = 0;
    for (const [, s] of list) {
      if (!s?.key) continue;
      const exp = s.expires_at ? Date.parse(s.expires_at) : Date.now();
      if (!best || exp > bestExp) {
        best = s;
        bestExp = exp;
      }
    }
    return best;
  } catch {
    return null;
  }
}
async function loadFreshCliSession() {
  let session = readCliSessionFromDisk();
  if (!session?.key) return null;
  const expMs = session.expires_at ? Date.parse(session.expires_at) : 0;
  const needsRefresh = !expMs || expMs - Date.now() < 12e4;
  if (!needsRefresh) return session;
  if (!session.refresh_token || !session.oidc_client_id) {
    return session;
  }
  try {
    const issuer = session.oidc_issuer || "https://auth.x.ai";
    const discRes = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (!discRes.ok) return session;
    const disc = await discRes.json();
    if (!disc.token_endpoint) return session;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refresh_token,
      client_id: session.oidc_client_id
    });
    const tokenRes = await fetch(disc.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!tokenRes.ok) {
      console.warn("[Grok] OIDC refresh failed", tokenRes.status, await tokenRes.text().catch(() => ""));
      return session;
    }
    const tok = await tokenRes.json();
    if (!tok.access_token) return session;
    const expiresAt = new Date(Date.now() + (tok.expires_in || 21600) * 1e3).toISOString();
    const updated = {
      ...session,
      key: tok.access_token,
      refresh_token: tok.refresh_token || session.refresh_token,
      expires_at: expiresAt
    };
    try {
      const authPath = AUTH_PATH();
      const raw = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      for (const k of Object.keys(raw)) {
        if (raw[k]?.email === session.email || raw[k]?.key === session.key) {
          raw[k] = { ...raw[k], ...updated };
        }
      }
      fs.writeFileSync(authPath, JSON.stringify(raw, null, 2), "utf-8");
    } catch (e) {
      console.warn("[Grok] could not write refreshed auth.json", e);
    }
    console.log("[Grok] OIDC session refreshed, expires", expiresAt);
    return updated;
  } catch (e) {
    console.warn("[Grok] refresh error", e);
    return session;
  }
}
function readGrokCliModelsMeta() {
  const p = path.join(os.homedir(), ".grok", "models_cache.json");
  if (!fs.existsSync(p)) return {};
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf-8"));
    const models = j.models || {};
    const ids = Object.keys(models);
    if (ids.length === 0) return {};
    const preferred = ids.find((id) => id.includes("4.5")) || ids[0];
    const info = models[preferred]?.info;
    return {
      defaultModel: info?.id || preferred,
      // Never return cli-chat-proxy for app use
      baseUrl: OFFICIAL_BASE
    };
  } catch {
    return {};
  }
}
function readGrokCliModels() {
  const p = path.join(os.homedir(), ".grok", "models_cache.json");
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf-8"));
    return Object.entries(j.models || {}).map(([id, v]) => ({
      id: v.info?.id || id,
      name: v.info?.name || id,
      contextWindow: v.info?.context_window
    }));
  } catch {
    return [];
  }
}
export {
  GrokProvider,
  importGrokCliAuth
};
