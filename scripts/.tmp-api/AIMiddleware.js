var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main/engine/TemplateEngine.ts
var TemplateEngine_exports = {};
__export(TemplateEngine_exports, {
  TemplateEngine: () => TemplateEngine,
  templateEngine: () => templateEngine
});
import fs4 from "fs";
import path5 from "path";
import crypto from "crypto";
function today() {
  return (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
}
function nowTime() {
  return (/* @__PURE__ */ new Date()).toTimeString().slice(0, 5);
}
function uid() {
  return crypto.randomBytes(4).toString("hex");
}
var BUILTIN, TemplateEngine, templateEngine;
var init_TemplateEngine = __esm({
  "src/main/engine/TemplateEngine.ts"() {
    BUILTIN = [
      {
        id: "builtin-knowledge",
        name: "Knowledge Note",
        kind: "knowledge",
        description: "Catatan pengetahuan umum",
        defaultFolder: "Knowledge",
        body: `---
title: {{title}}
type: knowledge
status: active
created: {{date}}
updated: {{date}}
tags: []
---

# {{title}}

## Summary


## Notes


## Links

- 
`
      },
      {
        id: "builtin-project",
        name: "Project",
        kind: "project",
        description: "Proyek dengan status & milestone",
        defaultFolder: "Projects",
        body: `---
title: {{title}}
type: project
status: planning
owner: {{owner}}
start: {{date}}
target: 
tags: []
created: {{date}}
updated: {{date}}
---

# {{title}}

## Goal


## Scope


## Status

- [ ] Planning
- [ ] Active
- [ ] On Hold
- [ ] Completed

## Related Knowledge

- 

## Related Tasks

- [ ] 

## People

- 

## Notes

`
      },
      {
        id: "builtin-task",
        name: "Task",
        kind: "task",
        description: "Unit pekerjaan dengan prioritas",
        defaultFolder: "Tasks",
        body: `---
title: {{title}}
type: task
status: todo
priority: medium
due: 
project: {{project}}
created: {{date}}
updated: {{date}}
tags: []
---

# {{title}}

## Description


## Checklist

- [ ] 

## Related

- Project: [[{{project}}]]
- Knowledge: 

## Log

- {{date}}: created
`
      },
      {
        id: "builtin-people",
        name: "Person",
        kind: "people",
        description: "Profil orang / rekan / kontak",
        defaultFolder: "People",
        body: `---
title: {{title}}
type: people
role: 
organization: 
tags: []
created: {{date}}
updated: {{date}}
---

# {{title}}

## Role & Org


## Contact


## Related Projects

- 

## Related Knowledge

- 

## Notes

`
      },
      {
        id: "builtin-daily",
        name: "Daily Note",
        kind: "daily",
        description: "Catatan harian",
        defaultFolder: "Daily",
        body: `---
title: {{date}}
type: daily
date: {{date}}
tags: [daily]
---

# {{date}}

## Focus

- [ ] 

## Notes


## Tasks

- [ ] 

## Links

- 
`
      },
      {
        id: "builtin-sop",
        name: "SOP",
        kind: "sop",
        description: "Prosedur operasional standar",
        defaultFolder: "SOP",
        body: `---
title: {{title}}
type: sop
status: draft
owner: {{owner}}
created: {{date}}
updated: {{date}}
tags: [sop]
---

# {{title}}

## Tujuan


## Ruang Lingkup


## Definisi


## Prosedur

1. 
2. 
3. 

## Dokumen Terkait

- 

## Riwayat Perubahan

| Tanggal | Perubahan | Oleh |
|---------|-----------|------|
| {{date}} | Draft |  |
`
      },
      {
        id: "builtin-document",
        name: "Document Index",
        kind: "document",
        description: "Indeks dokumen / arsip",
        defaultFolder: "Documents",
        body: `---
title: {{title}}
type: document
status: active
created: {{date}}
updated: {{date}}
tags: []
---

# {{title}}

## Deskripsi


## Lokasi File

- Path: 

## Related People

- 

## Related Projects

- 
`
      },
      {
        id: "builtin-meeting",
        name: "Meeting Note",
        kind: "meeting",
        description: "Notulen rapat",
        defaultFolder: "Knowledge",
        body: `---
title: {{title}}
type: knowledge
subtype: meeting
date: {{date}}
attendees: []
tags: [meeting]
created: {{date}}
updated: {{date}}
---

# {{title}}

**Date:** {{date}} \xB7 **Time:** {{time}}

## Attendees

- 

## Agenda

1. 

## Notes


## Action Items

- [ ] 

## Links

- 
`
      }
    ];
    TemplateEngine = class {
      getBuiltinTemplates() {
        return BUILTIN.map((t) => ({ ...t, builtin: true }));
      }
      /** List builtin + user templates from Templates/*.md */
      listTemplates(workspaceRoot) {
        const list = this.getBuiltinTemplates();
        if (!workspaceRoot) return list;
        const dir = path5.join(workspaceRoot, "Templates");
        if (!fs4.existsSync(dir)) return list;
        try {
          const files = fs4.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
          for (const f of files) {
            const full = path5.join(dir, f);
            const body = fs4.readFileSync(full, "utf-8");
            const name = path5.basename(f, ".md");
            const kind = this.inferKindFromName(name, body);
            list.push({
              id: `user-${name.toLowerCase().replace(/\s+/g, "-")}`,
              name,
              kind,
              description: `User template: Templates/${f}`,
              defaultFolder: this.folderForKind(kind),
              sourcePath: `Templates/${f}`,
              builtin: false,
              body
            });
          }
        } catch {
        }
        return list;
      }
      getTemplate(id, workspaceRoot) {
        return this.listTemplates(workspaceRoot).find((t) => t.id === id) || null;
      }
      render(templateBody, vars = {}) {
        const defaults = {
          date: today(),
          time: nowTime(),
          datetime: (/* @__PURE__ */ new Date()).toISOString(),
          uuid: uid(),
          title: vars.title || "Untitled",
          filename: vars.filename || vars.title || "Untitled",
          workspace: vars.workspace || "",
          project: vars.project || "",
          owner: vars.owner || ""
        };
        const merged = { ...defaults, ...vars };
        let out = templateBody;
        out = out.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
          const v = merged[key];
          return v !== void 0 && v !== null ? String(v) : "";
        });
        return out;
      }
      renderById(id, workspaceRoot, vars = {}) {
        const t = this.getTemplate(id, workspaceRoot);
        if (!t) return null;
        return this.render(t.body, vars);
      }
      /** Write seed templates into Templates/ if missing */
      seedBuiltinToVault(workspaceRoot) {
        const dir = path5.join(workspaceRoot, "Templates");
        if (!fs4.existsSync(dir)) fs4.mkdirSync(dir, { recursive: true });
        let n = 0;
        for (const t of this.getBuiltinTemplates()) {
          const file = path5.join(dir, `${t.name.replace(/\s+/g, "-")}.md`);
          if (!fs4.existsSync(file)) {
            fs4.writeFileSync(file, t.body, "utf-8");
            n++;
          }
        }
        return n;
      }
      /** Suggest template id for AI / create when kind known */
      suggestTemplateId(kind) {
        return `builtin-${kind === "meeting" ? "meeting" : kind}`;
      }
      folderForKind(kind) {
        switch (kind) {
          case "project":
            return "Projects";
          case "task":
            return "Tasks";
          case "people":
            return "People";
          case "daily":
            return "Daily";
          case "sop":
            return "SOP";
          case "document":
            return "Documents";
          case "meeting":
          case "knowledge":
          default:
            return "Knowledge";
        }
      }
      inferKindFromName(name, body) {
        const lower = (name + " " + body.slice(0, 200)).toLowerCase();
        if (lower.includes("type: project") || lower.includes("project")) return "project";
        if (lower.includes("type: task") || lower.includes("task")) return "task";
        if (lower.includes("type: people") || lower.includes("person")) return "people";
        if (lower.includes("type: daily") || lower.includes("daily")) return "daily";
        if (lower.includes("type: sop") || lower.includes("sop")) return "sop";
        if (lower.includes("type: document") || lower.includes("document")) return "document";
        if (lower.includes("meeting")) return "meeting";
        return "custom";
      }
    };
    templateEngine = new TemplateEngine();
  }
});

// src/main/security/SecretsStore.ts
var SecretsStore_exports = {};
__export(SecretsStore_exports, {
  decryptSecret: () => decryptSecret,
  encryptSecret: () => encryptSecret,
  isEncryptedForm: () => isEncryptedForm,
  protectSettingsSecrets: () => protectSettingsSecrets,
  revealSettingsSecrets: () => revealSettingsSecrets
});
import { safeStorage } from "electron";
function encryptSecret(plain) {
  if (!plain) return plain;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(plain);
      return ENC_PREFIX + buf.toString("base64");
    }
  } catch {
  }
  return "plain:" + plain;
}
function decryptSecret(stored) {
  if (!stored) return stored;
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buf = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
        return safeStorage.decryptString(buf);
      }
    } catch {
      return "";
    }
    return "";
  }
  if (stored.startsWith("plain:")) return stored.slice(6);
  return stored;
}
function isEncryptedForm(stored) {
  return typeof stored === "string" && stored.startsWith(ENC_PREFIX);
}
function protectSettingsSecrets(settings) {
  const clone = JSON.parse(JSON.stringify(settings));
  const ai = clone.ai;
  if (ai && typeof ai === "object") {
    for (const id of Object.keys(ai)) {
      if (ai[id]?.apiKey && !ai[id].apiKey.startsWith(ENC_PREFIX) && !ai[id].apiKey.startsWith("plain:")) {
        ai[id].apiKey = encryptSecret(ai[id].apiKey);
      } else if (ai[id]?.apiKey && ai[id].apiKey.startsWith("plain:")) {
        const plain = decryptSecret(ai[id].apiKey);
        ai[id].apiKey = encryptSecret(plain);
      }
    }
  }
  return clone;
}
function revealSettingsSecrets(settings) {
  const clone = JSON.parse(JSON.stringify(settings));
  const ai = clone.ai;
  if (ai && typeof ai === "object") {
    for (const id of Object.keys(ai)) {
      if (ai[id]?.apiKey) {
        ai[id].apiKey = decryptSecret(ai[id].apiKey);
      }
    }
  }
  return clone;
}
var ENC_PREFIX;
var init_SecretsStore = __esm({
  "src/main/security/SecretsStore.ts"() {
    ENC_PREFIX = "enc:v1:";
  }
});

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
    let model = request.model || this.defaultModel;
    const contents = this.buildContents(request);
    const config = {};
    if (request.systemPrompt) {
      const sp = request.systemPrompt;
      config.systemInstruction = sp.length > 12e3 ? sp.slice(0, 12e3) + "\n\u2026[context truncated]" : sp;
    }
    if (request.temperature !== void 0) config.temperature = request.temperature;
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

// src/main/ai/providers/OpenAIProvider.ts
import OpenAI from "openai";
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
      temperature: request.temperature
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
        stream: true
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

// src/main/ai/providers/ClaudeProvider.ts
import Anthropic from "@anthropic-ai/sdk";
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

// src/main/ai/providers/OpenRouterProvider.ts
import OpenAI2 from "openai";
var OpenRouterProvider = class extends BaseProvider {
  id = "openrouter";
  name = "OpenRouter";
  capabilities = {
    chat: true,
    streaming: true,
    vision: true,
    toolCalling: true,
    embeddings: false
  };
  client = null;
  baseUrl = "https://openrouter.ai/api/v1";
  defaultModel = "anthropic/claude-3.5-sonnet";
  getClient() {
    if (!this.apiKey) {
      throw new Error("OpenRouter API Key is not set.");
    }
    if (!this.client) {
      this.client = new OpenAI2({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
        defaultHeaders: {
          "HTTP-Referer": "https://workspacegraph.app",
          "X-Title": "WorkspaceGraph"
        }
      });
    }
    return this.client;
  }
  configure(config) {
    super.configure(config);
    if (config.apiKey) {
      this.client = new OpenAI2({
        apiKey: config.apiKey,
        baseURL: this.baseUrl,
        defaultHeaders: {
          "HTTP-Referer": "https://workspacegraph.app",
          "X-Title": "WorkspaceGraph"
        }
      });
    }
  }
  async healthCheck() {
    return this.isConfigured();
  }
  async listModels() {
    return [
      { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
      { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "deepseek/deepseek-chat", name: "DeepSeek V3" },
      { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B" }
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
      temperature: request.temperature
    });
    const choice = response.choices[0];
    return {
      content: choice.message.content || "",
      model,
      provider: this.id
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
        stream: true
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
      onChunk({ content: "", done: true, model, error: `OpenRouter: ${msg}` });
    }
  }
};

// src/main/ai/providers/GrokProvider.ts
import OpenAI3 from "openai";
import os from "os";
import fs from "fs";
import path from "path";
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
      this.client = new OpenAI3({
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

// src/main/engine/GraphEngine.ts
import path2 from "path";
function nodeTypeFromPath(relativePath) {
  const lower = relativePath.toLowerCase().replace(/\\/g, "/");
  if (lower.startsWith("knowledge") || lower.includes("/knowledge/")) return "knowledge";
  if (lower.startsWith("projects") || lower.includes("/projects/")) return "project";
  if (lower.startsWith("tasks") || lower.includes("/tasks/")) return "task";
  if (lower.startsWith("daily") || lower.startsWith("02 harian") || lower.includes("/02 harian/"))
    return "daily";
  if (lower.startsWith("templates") || lower.startsWith("99 templates") || lower.includes("/templates/"))
    return "template";
  if (lower.startsWith("documents") || lower.includes("/documents/")) return "document";
  if (lower.startsWith("people") || lower.startsWith("05 pegawai") || lower.includes("/05 pegawai/"))
    return "people";
  if (lower.startsWith("sop") || lower.startsWith("06 sop") || lower.includes("/sop")) return "sop";
  if (lower.startsWith("03 kerjaan") || lower.includes("/03 kerjaan/")) return "project";
  return "other";
}
function normalizeLinkTarget(raw) {
  let t = (raw || "").trim();
  t = t.split("#")[0].split("^")[0].trim();
  t = t.replace(/\\/g, "/");
  t = t.replace(/\.md$/i, "");
  t = t.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  t = t.replace(/\\+$/g, "").trim();
  return t.toLowerCase();
}
function addKey(maps, key, id) {
  if (!key) return;
  const k = key.toLowerCase().trim();
  if (!k) return;
  const list = maps.multi.get(k) || [];
  if (!list.includes(id)) list.push(id);
  maps.multi.set(k, list);
  if (list.length === 1) {
    maps.unique.set(k, id);
  } else {
    maps.unique.delete(k);
  }
}
function resolveLinkTarget(rawTarget, maps) {
  const key = normalizeLinkTarget(rawTarget);
  if (!key) return null;
  if (maps.unique.has(key)) return maps.unique.get(key);
  if (key.includes("/")) {
    const base = key.split("/").pop();
    for (const [p, id] of maps.unique.entries()) {
      if (p === key || p.endsWith("/" + key)) return id;
    }
    if (maps.unique.has(base)) return maps.unique.get(base);
  }
  for (const [p, id] of maps.unique.entries()) {
    if (p.endsWith("/" + key) || p === key) return id;
  }
  const candidates = /* @__PURE__ */ new Set();
  for (const [p, ids] of maps.multi.entries()) {
    if (p === key || p.endsWith("/" + key)) {
      for (const id of ids) candidates.add(id);
    }
  }
  if (candidates.size === 1) return [...candidates][0];
  return null;
}
function buildLookupMaps(items) {
  const maps = { unique: /* @__PURE__ */ new Map(), multi: /* @__PURE__ */ new Map() };
  for (const file of items) {
    const id = file.id;
    addKey(maps, file.title.toLowerCase().trim(), id);
    const baseName = path2.basename(file.path, path2.extname(file.path));
    addKey(maps, baseName, id);
    const rel = file.relativePath.replace(/\\/g, "/").replace(/\.md$/i, "");
    addKey(maps, rel, id);
    const parts = rel.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join("/");
      addKey(maps, suffix, id);
    }
    if (file.aliases) {
      for (const a of file.aliases) {
        if (a) addKey(maps, String(a), id);
      }
    }
  }
  for (const [k, ids] of maps.multi.entries()) {
    const uniq = [...new Set(ids)];
    if (uniq.length === 1) maps.unique.set(k, uniq[0]);
  }
  return maps;
}
function recomputeDegrees(nodes, edges) {
  for (const n of nodes.values()) n.degree = 0;
  const neighbors = /* @__PURE__ */ new Map();
  for (const e of edges.values()) {
    if (e.type !== "wiki_link") continue;
    if (!neighbors.has(e.source)) neighbors.set(e.source, /* @__PURE__ */ new Set());
    if (!neighbors.has(e.target)) neighbors.set(e.target, /* @__PURE__ */ new Set());
    neighbors.get(e.source).add(e.target);
    neighbors.get(e.target).add(e.source);
  }
  for (const [id, set] of neighbors) {
    const n = nodes.get(id);
    if (n) n.degree = set.size;
  }
}
var GraphEngine = class {
  nodes = /* @__PURE__ */ new Map();
  edges = /* @__PURE__ */ new Map();
  /**
   * Build graph.
   * Default includeTagEdges=false → match Obsidian global graph (wikilinks only).
   */
  buildFromParsedFiles(parsedFiles, includeTagEdges = false) {
    this.nodes.clear();
    this.edges.clear();
    const tagToNodeIds = /* @__PURE__ */ new Map();
    for (const file of parsedFiles) {
      const node = {
        id: file.id,
        // Prefer filename for graph label (Obsidian-like); keep full title in data via path
        title: path2.basename(file.filePath, path2.extname(file.filePath)),
        type: nodeTypeFromPath(file.relativePath),
        path: file.filePath,
        relativePath: file.relativePath,
        tags: file.tags,
        degree: 0
      };
      const fmTitle = file.title?.trim();
      if (fmTitle && fmTitle.length > 0 && fmTitle.length <= 48 && !/^#+\s/.test(fmTitle)) {
        node.title = fmTitle;
      }
      this.nodes.set(file.id, node);
      for (const tag of file.tags) {
        const tagLower = tag.toLowerCase();
        const existing = tagToNodeIds.get(tagLower) || [];
        existing.push(file.id);
        tagToNodeIds.set(tagLower, existing);
      }
    }
    const maps = buildLookupMaps(
      parsedFiles.map((f) => ({
        id: f.id,
        title: f.title,
        path: f.filePath,
        relativePath: f.relativePath,
        aliases: Array.isArray(f.frontmatter?.aliases) ? f.frontmatter.aliases.map(String) : []
      }))
    );
    let linked = 0;
    let unresolved = 0;
    const unresolvedSamples = [];
    for (const file of parsedFiles) {
      for (const link of file.wikiLinks) {
        const targetId = resolveLinkTarget(link.target, maps);
        if (targetId && targetId !== file.id) {
          const edgeId = `${file.id}->${targetId}`;
          if (!this.edges.has(edgeId)) {
            this.edges.set(edgeId, {
              id: edgeId,
              source: file.id,
              target: targetId,
              type: "wiki_link",
              weight: 2
            });
            linked++;
          }
        } else if (link.target?.trim()) {
          unresolved++;
          if (unresolvedSamples.length < 12) {
            unresolvedSamples.push(`${file.relativePath} \u2192 [[${link.target}]]`);
          }
        }
      }
    }
    if (unresolved > 0) {
      console.log(
        `[GraphEngine] wiki edges=${linked}, unresolved=${unresolved}`,
        unresolvedSamples
      );
    } else {
      console.log(`[GraphEngine] wiki edges=${linked} (all resolved)`);
    }
    if (includeTagEdges) {
      for (const [, nodeIds] of tagToNodeIds.entries()) {
        if (nodeIds.length < 2 || nodeIds.length > 8) continue;
        const hub = nodeIds[0];
        for (let i = 1; i < nodeIds.length; i++) {
          const tgtId = nodeIds[i];
          const edgeId = `tag:${hub}<->${tgtId}`;
          const wiki1 = `${hub}->${tgtId}`;
          const wiki2 = `${tgtId}->${hub}`;
          if (!this.edges.has(edgeId) && !this.edges.has(wiki1) && !this.edges.has(wiki2)) {
            this.edges.set(edgeId, {
              id: edgeId,
              source: hub,
              target: tgtId,
              type: "tag",
              weight: 1
            });
          }
        }
      }
    }
    recomputeDegrees(this.nodes, this.edges);
    return this.getGraphData();
  }
  updateNodeAndEdges(parsedFile) {
    const aliases = Array.isArray(parsedFile.frontmatter?.aliases) ? parsedFile.frontmatter.aliases.map(String) : [];
    const existing = this.nodes.get(parsedFile.id);
    const displayTitle = parsedFile.title && parsedFile.title.length <= 48 ? parsedFile.title : path2.basename(parsedFile.filePath, path2.extname(parsedFile.filePath));
    if (existing) {
      existing.title = displayTitle;
      existing.tags = parsedFile.tags;
    } else {
      this.nodes.set(parsedFile.id, {
        id: parsedFile.id,
        title: displayTitle,
        type: nodeTypeFromPath(parsedFile.relativePath),
        path: parsedFile.filePath,
        relativePath: parsedFile.relativePath,
        tags: parsedFile.tags,
        degree: 0
      });
    }
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.type === "wiki_link" && (edge.source === parsedFile.id || edge.target === parsedFile.id)) {
        this.edges.delete(edgeId);
      } else if (edge.type === "tag" && (edge.source === parsedFile.id || edge.target === parsedFile.id)) {
        this.edges.delete(edgeId);
      }
    }
    const maps = buildLookupMaps(
      Array.from(this.nodes.values()).map((n) => ({
        id: n.id,
        title: n.title,
        path: n.path,
        relativePath: n.relativePath,
        aliases: n.id === parsedFile.id ? aliases : []
      }))
    );
    for (const link of parsedFile.wikiLinks) {
      const targetId = resolveLinkTarget(link.target, maps);
      if (targetId && targetId !== parsedFile.id) {
        const edgeId = `${parsedFile.id}->${targetId}`;
        if (!this.edges.has(edgeId)) {
          this.edges.set(edgeId, {
            id: edgeId,
            source: parsedFile.id,
            target: targetId,
            type: "wiki_link",
            weight: 2
          });
        }
      }
    }
    recomputeDegrees(this.nodes, this.edges);
  }
  removeNode(nodeId) {
    this.nodes.delete(nodeId);
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.source === nodeId || edge.target === nodeId) this.edges.delete(edgeId);
    }
    recomputeDegrees(this.nodes, this.edges);
  }
  getGraphData() {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size
    };
  }
  getNeighbors(nodeId, depth = 1) {
    const visitedNodes = /* @__PURE__ */ new Set([nodeId]);
    const resultEdges = [];
    let currentLayer = [nodeId];
    for (let d = 0; d < depth; d++) {
      const nextLayer = [];
      for (const currId of currentLayer) {
        for (const edge of this.edges.values()) {
          if (edge.source === currId && !visitedNodes.has(edge.target)) {
            visitedNodes.add(edge.target);
            nextLayer.push(edge.target);
            resultEdges.push(edge);
          } else if (edge.target === currId && !visitedNodes.has(edge.source)) {
            visitedNodes.add(edge.source);
            nextLayer.push(edge.source);
            resultEdges.push(edge);
          }
        }
      }
      currentLayer = nextLayer;
    }
    const neighborNodes = Array.from(visitedNodes).filter((id) => id !== nodeId).map((id) => this.nodes.get(id)).filter((n) => n !== void 0);
    return { nodes: neighborNodes, edges: resultEdges };
  }
  getNodeById(id) {
    return this.nodes.get(id);
  }
  getNodeByPath(filePath) {
    const normalizedSearch = filePath.replace(/\\/g, "/");
    for (const node of this.nodes.values()) {
      if (node.path.replace(/\\/g, "/") === normalizedSearch) return node;
    }
    return void 0;
  }
  getBacklinks(nodeId) {
    const edges = [];
    const nodeIds = /* @__PURE__ */ new Set();
    for (const edge of this.edges.values()) {
      if (edge.type === "wiki_link" && edge.target === nodeId) {
        edges.push(edge);
        nodeIds.add(edge.source);
      }
    }
    const nodes = Array.from(nodeIds).map((id) => this.nodes.get(id)).filter((n) => n !== void 0);
    return { nodes, edges };
  }
  getOutgoingLinks(nodeId) {
    const edges = [];
    const nodeIds = /* @__PURE__ */ new Set();
    for (const edge of this.edges.values()) {
      if (edge.type === "wiki_link" && edge.source === nodeId) {
        edges.push(edge);
        nodeIds.add(edge.target);
      }
    }
    const nodes = Array.from(nodeIds).map((id) => this.nodes.get(id)).filter((n) => n !== void 0);
    return { nodes, edges };
  }
  getOrphanNodeIds() {
    return Array.from(this.nodes.values()).filter((n) => n.degree === 0).map((n) => n.id);
  }
  resolveTitleToPath(target) {
    const maps = buildLookupMaps(
      Array.from(this.nodes.values()).map((n) => ({
        id: n.id,
        title: n.title,
        path: n.path,
        relativePath: n.relativePath
      }))
    );
    const id = resolveLinkTarget(target, maps);
    if (!id) return null;
    return this.nodes.get(id)?.path || null;
  }
  filterByType(types) {
    const filteredNodes = Array.from(this.nodes.values()).filter((n) => types.includes(n.type));
    const filteredIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = Array.from(this.edges.values()).filter(
      (e) => filteredIds.has(e.source) && filteredIds.has(e.target)
    );
    return {
      nodes: filteredNodes,
      edges: filteredEdges,
      nodeCount: filteredNodes.length,
      edgeCount: filteredEdges.length
    };
  }
  filterByTag(tag) {
    const filteredNodes = Array.from(this.nodes.values()).filter(
      (n) => n.tags.some((t) => t.toLowerCase() === tag.toLowerCase())
    );
    const filteredIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = Array.from(this.edges.values()).filter(
      (e) => filteredIds.has(e.source) && filteredIds.has(e.target)
    );
    return {
      nodes: filteredNodes,
      edges: filteredEdges,
      nodeCount: filteredNodes.length,
      edgeCount: filteredEdges.length
    };
  }
};
var graphEngine = new GraphEngine();

// src/main/config/KerjaPaths.ts
import fs2 from "fs";
import path3 from "path";
var KERJA_REL = {
  home: "00 Home.md",
  dailyDir: "02 Harian",
  kerjaan: "03 Kerjaan",
  arsip: "04 Arsip",
  pegawai: "05 Pegawai",
  pegawaiDb: "05 Pegawai\\00 Daftar Pegawai.md",
  sop: "06 SOP & Pola",
  referensi: "07 Referensi",
  sidebrain: "08 Sidebrain",
  sidebrainIndex: "08 Sidebrain\\00 Index Sidebrain.md",
  templates: "99 Templates",
  zData: "Z:\\1. DATA PEGAWAI",
  zSurat: "Z:\\2. SURAT"
};
function isKerjaVault(rootPath) {
  if (!rootPath) return false;
  const n = rootPath.replace(/\//g, "\\").toLowerCase();
  return n.includes("\\obs\\obs") || n.endsWith("\\obs") || fs2.existsSync(path3.join(rootPath, "00 Home.md")) || fs2.existsSync(path3.join(rootPath, "08 Sidebrain"));
}
var KERJA_CONTEXT_PRIORITY = [
  "08 sidebrain",
  "06 sop",
  "99 templates",
  "00 home",
  "05 pegawai",
  "03 kerjaan",
  "02 harian",
  "rules/",
  "sop/",
  "templates/",
  "prompt/"
];

// src/main/ai/ContextEngine.ts
import path4 from "path";
import fs3 from "fs";
var AGENT_ROLES = {
  general: {
    id: "general",
    name: "General Assistant",
    icon: "\u{1F916}",
    systemInstruction: "You are a general AI Worker inside WorkspaceGraph. Help the user manage knowledge, answer questions, and organize workspace notes accurately."
  },
  writer: {
    id: "writer",
    name: "Writing Agent",
    icon: "\u270D\uFE0F",
    systemInstruction: "You are a specialized Writing Agent. Focus on drafting clear, well-structured Markdown documents, refining prose, adjusting tone, and expanding note outlines."
  },
  researcher: {
    id: "researcher",
    name: "Research Agent",
    icon: "\u{1F50D}",
    systemInstruction: "You are a specialized Research Agent. Synthesize information across workspace notes, identify key themes, create summaries, and highlight evidence."
  },
  curator: {
    id: "curator",
    name: "Knowledge Curator",
    icon: "\u{1F517}",
    systemInstruction: "You are a specialized Knowledge Curator. Identify relationships between documents, suggest new [[WikiLinks]], detect missing connections, and structure knowledge graphs."
  },
  planner: {
    id: "planner",
    name: "Task Planner",
    icon: "\u{1F4CB}",
    systemInstruction: "You are a specialized Task Planner. Break down goals into actionable task checklists (- [ ]), define priorities, deadlines, and project milestones."
  }
};
function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}
var DEFAULT_TOKEN_BUDGET = 2800;
var ContextEngine = class {
  constructor(workspaceEngine2, searchEngine2) {
    this.workspaceEngine = workspaceEngine2;
    this.searchEngine = searchEngine2;
  }
  buildContextPackage(query, activeFilePath, agentRole = "general", tokenBudget = DEFAULT_TOKEN_BUDGET) {
    const relevantFiles = [];
    const citations = [];
    const seenPaths = /* @__PURE__ */ new Set();
    let activeFile;
    let graphNeighbors = [];
    let backlinks = [];
    let usedTokens = 0;
    const addCitation = (title, p) => {
      if (!citations.some((c) => c.path === p)) citations.push({ title, path: p });
    };
    const tryAddSnippet = (title, filePath, tier, maxChars, minPriority) => {
      const norm = filePath.replace(/\\/g, "/");
      if (seenPaths.has(norm)) return false;
      if (activeFilePath && norm === activeFilePath.replace(/\\/g, "/")) return false;
      const remaining = tokenBudget - usedTokens;
      if (remaining < 80) return false;
      try {
        const content = this.workspaceEngine.readFile(filePath);
        const cap = Math.min(maxChars, remaining * 4);
        const snippet = content.slice(0, cap).trim();
        const cost = estimateTokens(snippet) + 20;
        if (cost > remaining && minPriority > 0) return false;
        seenPaths.add(norm);
        relevantFiles.push({ title, path: filePath, snippet, tier });
        addCitation(title, filePath);
        usedTokens += Math.min(cost, remaining);
        return true;
      } catch {
        return false;
      }
    };
    if (activeFilePath) {
      try {
        const content = this.workspaceEngine.readFile(activeFilePath);
        const title = activeFilePath.split(/[/\\]/).pop()?.replace(/\.md$/i, "") || "Untitled";
        const activeCap = Math.min(1800, Math.floor(tokenBudget * 0.35) * 4);
        activeFile = {
          path: activeFilePath,
          title,
          content: content.slice(0, activeCap)
        };
        usedTokens += estimateTokens(activeFile.content) + 40;
        addCitation(title, activeFilePath);
        seenPaths.add(activeFilePath.replace(/\\/g, "/"));
        const activeNode = graphEngine.getNodeByPath(activeFilePath);
        if (activeNode) {
          const neighbors = graphEngine.getNeighbors(activeNode.id, 1);
          graphNeighbors = neighbors.nodes.filter((n) => n.id !== activeNode.id).map((n) => ({ title: n.title, path: n.path, type: n.type }));
          for (const n of graphNeighbors.slice(0, 5)) {
            tryAddSnippet(n.title, n.path, "wikilink", 600, 1);
          }
          const bl = graphEngine.getBacklinks(activeNode.id);
          backlinks = bl.nodes.map((n) => ({ title: n.title, path: n.path }));
          for (const n of bl.nodes.slice(0, 4)) {
            tryAddSnippet(n.title, n.path, "backlink", 500, 1);
          }
        }
      } catch {
      }
    }
    const qLower = (query || "").toLowerCase();
    const roleWantsRules = agentRole === "writer" || agentRole === "researcher" || agentRole === "curator" || agentRole === "planner" || /sop|aturan|rules|template|prosedur|format|surat|cuti|kgb|pegawai/i.test(qLower);
    const rootEarly = this.workspaceEngine.getState().rootPath;
    if (rootEarly && isKerjaVault(rootEarly)) {
      const must = [
        KERJA_REL.home,
        KERJA_REL.sidebrainIndex,
        path4.join(KERJA_REL.dailyDir, (/* @__PURE__ */ new Date()).toISOString().split("T")[0] + ".md")
      ];
      if (/cuti/i.test(qLower)) {
        must.push(path4.join("03 Kerjaan", "Cuti", "00 Index Cuti.md"));
      }
      if (/kgb/i.test(qLower)) {
        must.push(path4.join("03 Kerjaan", "KGB", "00 Index KGB.md"));
      }
      if (/pegawai|asn|nip/i.test(qLower)) {
        must.push(KERJA_REL.pegawaiDb);
      }
      for (const rel of must) {
        const abs = path4.join(rootEarly, rel);
        if (fs3.existsSync(abs)) {
          tryAddSnippet(path4.basename(rel, ".md"), abs, "kerja", 650, 0);
        }
      }
    }
    {
      const systemNotes = this.searchEngine.getSystemFolderNotes();
      const ordered = [...systemNotes].sort(
        (a, b) => this.pathPriority(a.path) - this.pathPriority(b.path)
      );
      const cap = roleWantsRules ? 2 : 1;
      for (const n of ordered.slice(0, cap)) {
        tryAddSnippet(n.title, n.path, "system", 500, 0);
      }
    }
    if (query.trim()) {
      const searchResults = this.searchEngine.search({ query, limit: 5 });
      let added = 0;
      for (const res of searchResults) {
        const prio = this.pathPriority(res.path);
        const maxChars = prio <= 2 ? 600 : 400;
        if (tryAddSnippet(res.title, res.path, "search", maxChars, 2)) added++;
        if (added >= 3 || usedTokens >= tokenBudget * 0.9) break;
      }
    }
    const agent = AGENT_ROLES[agentRole] || AGENT_ROLES.general;
    const root = this.workspaceEngine.getState().rootPath;
    const kerja = isKerjaVault(root);
    const systemRules = [
      agent.systemInstruction,
      "Markdown First: Data is stored as Markdown. Cite with [[WikiLinks]].",
      "User Owns Data: Do not invent facts. If context is insufficient, say so.",
      "Write Back: Prefer clean GitHub-flavored Markdown ready to append to notes.",
      "Never invent names, dates, NIP, or office data not present in workspace context."
    ];
    if (kerja) {
      systemRules.push(
        "Kerja mode (vault Obsidian Diskominfo): ikuti struktur 00 Home, 02 Harian, 03 Kerjaan, 05 Pegawai, 08 Sidebrain, 99 Templates.",
        "Untuk cuti/KGB/surat/pegawai: utamakan Sidebrain + index Kerjaan + 05 Pegawai; jangan invent data ASN.",
        "File resmi PDF/Word/Excel tetap di Z: (DATA PEGAWAI / SURAT), vault hanya note/index Markdown.",
        `Daily path: ${KERJA_REL.dailyDir}/YYYY-MM-DD.md \xB7 Pegawai DB: ${KERJA_REL.pegawaiDb}`
      );
    }
    const parts = [];
    parts.push("=== WORKSPACE CONTEXT ===");
    parts.push(`Token budget ~${tokenBudget}; estimate used ~${usedTokens}`);
    parts.push("System Rules & Persona:");
    for (const r of systemRules) parts.push(`- ${r}`);
    if (activeFile) {
      parts.push(`
[1 ACTIVE] "${activeFile.title}" (${activeFile.path})`);
      parts.push("--- ACTIVE NOTE START ---");
      parts.push(activeFile.content);
      parts.push("--- ACTIVE NOTE END ---");
      if (graphNeighbors && graphNeighbors.length > 0) {
        parts.push("\nOutgoing / graph neighbors:");
        for (const gn of graphNeighbors.slice(0, 12)) {
          parts.push(`- [[${gn.title}]] (${gn.type})`);
        }
      }
      if (backlinks && backlinks.length > 0) {
        parts.push("\nBacklinks:");
        for (const b of backlinks.slice(0, 12)) {
          parts.push(`- [[${b.title}]]`);
        }
      }
    }
    if (relevantFiles.length > 0) {
      parts.push("\nRelated documents (priority order):");
      for (const f of relevantFiles) {
        parts.push(`
[${f.tier.toUpperCase()}] "${f.title}" (${f.path})`);
        parts.push(f.snippet);
      }
    }
    parts.push("=== END OF WORKSPACE CONTEXT ===\n");
    const formattedContext = parts.join("\n");
    return {
      query,
      activeFile,
      graphNeighbors,
      backlinks,
      relevantFiles,
      citations,
      systemRules,
      formattedContext,
      tokenEstimate: estimateTokens(formattedContext)
    };
  }
  pathPriority(p) {
    const lower = p.replace(/\\/g, "/").toLowerCase();
    for (let i = 0; i < KERJA_CONTEXT_PRIORITY.length; i++) {
      if (lower.includes(KERJA_CONTEXT_PRIORITY[i].replace(/\\/g, "/"))) return i;
    }
    if (lower.includes("/rules/")) return 10;
    if (lower.includes("/sop/")) return 11;
    if (lower.includes("/templates/")) return 12;
    if (lower.includes("/prompt/")) return 13;
    return 20;
  }
};

// src/main/engine/WorkspaceEngine.ts
import fs5 from "fs";
import path6 from "path";
import crypto2 from "crypto";
import { app } from "electron";
var WORKSPACE_CONFIG_FILE = ".workspacegraph/workspace.json";
var WORKSPACE_FOLDER = ".workspacegraph";
var STANDARD_FOLDERS = [
  "Knowledge",
  "Projects",
  "Tasks",
  "Templates",
  "Daily",
  "Journal",
  "People",
  "Rules",
  "Prompt",
  "SOP",
  "Documents",
  "Assets",
  "Archive"
];
function fileTypeFromPath(filePath, rootPath) {
  const rel = path6.relative(rootPath, filePath).toLowerCase();
  if (rel.startsWith("knowledge")) return "knowledge";
  if (rel.startsWith("projects")) return "project";
  if (rel.startsWith("tasks")) return "task";
  if (rel.startsWith("daily")) return "daily";
  if (rel.startsWith("templates")) return "template";
  if (rel.startsWith("documents")) return "document";
  if (rel.startsWith("people")) return "people";
  if (rel.startsWith("sop")) return "sop";
  return "other";
}
function generateId(filePath) {
  return crypto2.createHash("sha256").update(filePath).digest("hex").slice(0, 24);
}
function scanDirectory(dirPath, rootPath) {
  const entries = [];
  try {
    const items = fs5.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".")) continue;
      if (item.name === "node_modules") continue;
      const fullPath = path6.join(dirPath, item.name);
      const stats = fs5.statSync(fullPath);
      const relativePath = path6.relative(rootPath, fullPath);
      if (item.isDirectory()) {
        const children = scanDirectory(fullPath, rootPath);
        entries.push({
          id: generateId(fullPath),
          name: item.name,
          path: fullPath,
          relativePath,
          type: "other",
          extension: "",
          size: 0,
          createdAt: stats.birthtime.toISOString(),
          updatedAt: stats.mtime.toISOString(),
          isDirectory: true,
          children
        });
      } else {
        const ext = path6.extname(item.name).toLowerCase();
        entries.push({
          id: generateId(fullPath),
          name: item.name,
          path: fullPath,
          relativePath,
          type: fileTypeFromPath(fullPath, rootPath),
          extension: ext,
          size: stats.size,
          createdAt: stats.birthtime.toISOString(),
          updatedAt: stats.mtime.toISOString(),
          isDirectory: false
        });
      }
    }
  } catch (err) {
    console.error("Error scanning directory:", dirPath, err);
  }
  return entries.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
}
function countFiles(files) {
  let fileCount = 0;
  let folderCount = 0;
  let noteCount = 0;
  for (const f of files) {
    if (f.isDirectory) {
      folderCount++;
      if (f.children) {
        const sub = countFiles(f.children);
        fileCount += sub.files;
        folderCount += sub.folders;
        noteCount += sub.notes;
      }
    } else {
      fileCount++;
      if (f.extension === ".md") noteCount++;
    }
  }
  return { files: fileCount, folders: folderCount, notes: noteCount };
}
var WorkspaceEngine = class {
  state = {
    isOpen: false,
    rootPath: null,
    config: null,
    files: [],
    totalFiles: 0,
    totalFolders: 0,
    totalNotes: 0
  };
  recentWorkspaces = [];
  configDir;
  constructor() {
    this.configDir = path6.join(app.getPath("userData"), "workspacegraph");
    if (!fs5.existsSync(this.configDir)) {
      fs5.mkdirSync(this.configDir, { recursive: true });
    }
    this.loadRecentWorkspaces();
  }
  loadRecentWorkspaces() {
    const filePath = path6.join(this.configDir, "recent.json");
    try {
      if (fs5.existsSync(filePath)) {
        this.recentWorkspaces = JSON.parse(fs5.readFileSync(filePath, "utf-8"));
      }
    } catch {
      this.recentWorkspaces = [];
    }
  }
  saveRecentWorkspaces() {
    const filePath = path6.join(this.configDir, "recent.json");
    fs5.writeFileSync(filePath, JSON.stringify(this.recentWorkspaces, null, 2));
  }
  openWorkspace(workspacePath) {
    if (!fs5.existsSync(workspacePath)) {
      throw new Error(`Workspace path does not exist: ${workspacePath}`);
    }
    const stats = fs5.statSync(workspacePath);
    if (!stats.isDirectory()) {
      throw new Error(`Workspace path must be a directory: ${workspacePath}`);
    }
    const configPath = path6.join(workspacePath, WORKSPACE_CONFIG_FILE);
    const configFolder = path6.join(workspacePath, WORKSPACE_FOLDER);
    if (!fs5.existsSync(configFolder)) {
      fs5.mkdirSync(configFolder, { recursive: true });
    }
    let config;
    if (fs5.existsSync(configPath)) {
      config = JSON.parse(fs5.readFileSync(configPath, "utf-8"));
      config.lastOpenedAt = (/* @__PURE__ */ new Date()).toISOString();
    } else {
      config = {
        name: path6.basename(workspacePath),
        path: workspacePath,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        lastOpenedAt: (/* @__PURE__ */ new Date()).toISOString(),
        settings: {}
      };
      this.initializeWorkspaceStructure(workspacePath);
    }
    fs5.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const files = scanDirectory(workspacePath, workspacePath);
    const counts = countFiles(files);
    this.state = {
      isOpen: true,
      rootPath: workspacePath,
      config,
      files,
      totalFiles: counts.files,
      totalFolders: counts.folders,
      totalNotes: counts.notes
    };
    this.recentWorkspaces = [
      workspacePath,
      ...this.recentWorkspaces.filter((p) => p !== workspacePath)
    ].slice(0, 10);
    this.saveRecentWorkspaces();
    return this.state;
  }
  initializeWorkspaceStructure(workspacePath) {
    const isObsidian = fs5.existsSync(path6.join(workspacePath, ".obsidian")) || fs5.existsSync(path6.join(workspacePath, "00 Home.md")) || fs5.existsSync(path6.join(workspacePath, "08 Sidebrain"));
    if (isObsidian) {
      console.log("[WorkspaceEngine] Obsidian/kerja vault \u2014 skip WG folder scaffold");
      return;
    }
    for (const folder of STANDARD_FOLDERS) {
      const folderPath = path6.join(workspacePath, folder);
      if (!fs5.existsSync(folderPath)) {
        fs5.mkdirSync(folderPath, { recursive: true });
      }
    }
    try {
      const { templateEngine: templateEngine2 } = (init_TemplateEngine(), __toCommonJS(TemplateEngine_exports));
      templateEngine2.seedBuiltinToVault(workspacePath);
    } catch (err) {
      console.error("Failed to seed templates:", err);
    }
  }
  createWorkspace(parentPath, name) {
    const workspacePath = path6.join(parentPath, name);
    if (fs5.existsSync(workspacePath)) {
      throw new Error(`Directory already exists: ${workspacePath}`);
    }
    fs5.mkdirSync(workspacePath, { recursive: true });
    return this.openWorkspace(workspacePath);
  }
  closeWorkspace() {
    this.state = {
      isOpen: false,
      rootPath: null,
      config: null,
      files: [],
      totalFiles: 0,
      totalFolders: 0,
      totalNotes: 0
    };
  }
  getState() {
    return this.state;
  }
  getRecentWorkspaces() {
    return this.recentWorkspaces.filter((p) => fs5.existsSync(p));
  }
  refreshFiles() {
    if (!this.state.rootPath) return [];
    const files = scanDirectory(this.state.rootPath, this.state.rootPath);
    const counts = countFiles(files);
    this.state.files = files;
    this.state.totalFiles = counts.files;
    this.state.totalFolders = counts.folders;
    this.state.totalNotes = counts.notes;
    return files;
  }
  readFile(filePath) {
    return fs5.readFileSync(filePath, "utf-8");
  }
  writeFile(filePath, content) {
    const dir = path6.dirname(filePath);
    if (!fs5.existsSync(dir)) {
      fs5.mkdirSync(dir, { recursive: true });
    }
    fs5.writeFileSync(filePath, content, "utf-8");
  }
  deleteFile(filePath) {
    if (fs5.existsSync(filePath)) {
      const stats = fs5.statSync(filePath);
      if (stats.isDirectory()) {
        fs5.rmSync(filePath, { recursive: true });
      } else {
        fs5.unlinkSync(filePath);
      }
    }
  }
  createFile(filePath, content = "") {
    const dir = path6.dirname(filePath);
    if (!fs5.existsSync(dir)) {
      fs5.mkdirSync(dir, { recursive: true });
    }
    if (!fs5.existsSync(filePath)) {
      fs5.writeFileSync(filePath, content, "utf-8");
    }
  }
  createFolder(folderPath) {
    if (!fs5.existsSync(folderPath)) {
      fs5.mkdirSync(folderPath, { recursive: true });
    }
  }
  renameFile(oldPath, newPath) {
    fs5.renameSync(oldPath, newPath);
  }
  getSettingsPath() {
    return path6.join(this.configDir, "settings.json");
  }
  getSettings() {
    const settingsPath = this.getSettingsPath();
    try {
      if (fs5.existsSync(settingsPath)) {
        const { revealSettingsSecrets: revealSettingsSecrets2 } = (init_SecretsStore(), __toCommonJS(SecretsStore_exports));
        const raw = JSON.parse(fs5.readFileSync(settingsPath, "utf-8"));
        return revealSettingsSecrets2(raw);
      }
    } catch (err) {
      console.error("[WorkspaceEngine] getSettings failed:", err);
    }
    return {};
  }
  /** Raw settings as stored on disk (encrypted secrets) */
  getSettingsRaw() {
    const settingsPath = this.getSettingsPath();
    try {
      if (fs5.existsSync(settingsPath)) {
        return JSON.parse(fs5.readFileSync(settingsPath, "utf-8"));
      }
    } catch {
    }
    return {};
  }
  saveSettings(settings) {
    if (!fs5.existsSync(this.configDir)) {
      fs5.mkdirSync(this.configDir, { recursive: true });
    }
    const settingsPath = this.getSettingsPath();
    const { protectSettingsSecrets: protectSettingsSecrets2 } = (init_SecretsStore(), __toCommonJS(SecretsStore_exports));
    const protectedSettings = protectSettingsSecrets2(settings);
    const json = JSON.stringify(protectedSettings, null, 2);
    const tmp = settingsPath + ".tmp";
    fs5.writeFileSync(tmp, json, "utf-8");
    fs5.renameSync(tmp, settingsPath);
    console.log("[WorkspaceEngine] settings saved \u2192", settingsPath);
    return settingsPath;
  }
};
var workspaceEngine = new WorkspaceEngine();

// src/main/engine/SearchEngine.ts
import Fuse from "fuse.js";

// src/main/engine/IndexDatabase.ts
import fs6 from "fs";
import path7 from "path";
var IndexDatabase = class {
  db = null;
  dbPath = null;
  available = false;
  isOpen() {
    return this.db !== null && this.available;
  }
  getPath() {
    return this.dbPath;
  }
  open(workspaceRoot) {
    this.close();
    try {
      const Database = __require("better-sqlite3");
      const dir = path7.join(workspaceRoot, ".workspacegraph");
      if (!fs6.existsSync(dir)) fs6.mkdirSync(dir, { recursive: true });
      this.dbPath = path7.join(dir, "index.db");
      this.db = new Database(this.dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.migrate();
      this.available = true;
      return true;
    } catch (err) {
      console.error("[IndexDatabase] open failed, Fuse-only mode:", err);
      this.db = null;
      this.available = false;
      return false;
    }
  }
  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
      }
    }
    this.db = null;
    this.dbPath = null;
    this.available = false;
  }
  migrate() {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        relative_path TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        type TEXT NOT NULL DEFAULT 'note',
        headings TEXT NOT NULL DEFAULT '',
        frontmatter TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
      CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(type);

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title,
        content,
        tags,
        relative_path,
        headings,
        content='notes',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, content, tags, relative_path, headings)
        VALUES (new.rowid, new.title, new.content, new.tags, new.relative_path, new.headings);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content, tags, relative_path, headings)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags, old.relative_path, old.headings);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content, tags, relative_path, headings)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags, old.relative_path, old.headings);
        INSERT INTO notes_fts(rowid, title, content, tags, relative_path, headings)
        VALUES (new.rowid, new.title, new.content, new.tags, new.relative_path, new.headings);
      END;
    `);
  }
  clear() {
    if (!this.db) return;
    this.db.exec("DELETE FROM notes");
    try {
      this.db.exec(`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`);
    } catch {
    }
  }
  upsertNote(file) {
    if (!this.db) return;
    const tags = JSON.stringify(file.tags || []);
    const headings = (file.headings || []).map((h) => h.text).join(" ");
    const fm = JSON.stringify(file.frontmatter || {});
    const updated = String(file.frontmatter.updated || file.frontmatter.date || "") || (/* @__PURE__ */ new Date()).toISOString();
    const type = file.frontmatter.type || "note";
    this.db.prepare("DELETE FROM notes WHERE path = ? AND id != ?").run(file.filePath, file.id);
    this.db.prepare(
      `INSERT INTO notes (id, path, relative_path, title, content, tags, type, headings, frontmatter, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path=excluded.path,
           relative_path=excluded.relative_path,
           title=excluded.title,
           content=excluded.content,
           tags=excluded.tags,
           type=excluded.type,
           headings=excluded.headings,
           frontmatter=excluded.frontmatter,
           updated_at=excluded.updated_at`
    ).run(
      file.id,
      file.filePath,
      file.relativePath,
      file.title,
      file.content,
      tags,
      type,
      headings,
      fm,
      updated
    );
  }
  /** Full rebuild from parsed files (transaction) */
  rebuild(parsedFiles) {
    if (!this.db) return 0;
    const run = this.db.transaction(() => {
      this.clear();
      for (const f of parsedFiles) {
        this.upsertNote(f);
      }
      this.db.prepare(
        `INSERT INTO meta(key, value) VALUES('last_rebuild', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      ).run((/* @__PURE__ */ new Date()).toISOString());
      return parsedFiles.length;
    });
    return run();
  }
  removeById(id) {
    if (!this.db) return;
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  }
  removeByPath(filePath) {
    if (!this.db) return;
    this.db.prepare("DELETE FROM notes WHERE path = ?").run(filePath);
  }
  count() {
    if (!this.db) return 0;
    const row = this.db.prepare("SELECT COUNT(*) as c FROM notes").get();
    return row?.c || 0;
  }
  getStats() {
    if (!this.db) {
      return { count: 0, path: this.dbPath, lastRebuild: null, open: false };
    }
    const meta = this.db.prepare(`SELECT value FROM meta WHERE key = 'last_rebuild'`).get();
    return {
      count: this.count(),
      path: this.dbPath,
      lastRebuild: meta?.value || null,
      open: true
    };
  }
  /**
   * FTS5 query. Escapes user input to safe token query (AND of terms).
   */
  searchFts(query, limit = 20) {
    if (!this.db || !query.trim()) return [];
    const terms = query.trim().split(/\s+/).map((t) => t.replace(/["']/g, "")).filter((t) => t.length > 0 && !t.includes(":")).slice(0, 12);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" ");
    try {
      const rows = this.db.prepare(
        `SELECT n.id, n.path, n.relative_path, n.title, n.type, n.tags, n.updated_at,
                  bm25(notes_fts) AS rank,
                  snippet(notes_fts, 1, '\xAB', '\xBB', '\u2026', 12) AS snip
           FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
           WHERE notes_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
      ).all(ftsQuery, limit);
      return rows.map((r) => ({
        id: r.id,
        path: r.path,
        relativePath: r.relative_path,
        title: r.title,
        type: r.type,
        tags: this.parseTags(r.tags),
        updatedAt: r.updated_at,
        rank: typeof r.rank === "number" ? r.rank : 0,
        snippet: (r.snip || "").replace(/\n/g, " ")
      }));
    } catch (err) {
      console.error("[IndexDatabase] FTS query failed:", err);
      return [];
    }
  }
  searchByTag(tag, limit = 50) {
    if (!this.db) return [];
    const needle = tag.toLowerCase();
    const rows = this.db.prepare(`SELECT * FROM notes ORDER BY updated_at DESC LIMIT 2000`).all();
    return rows.filter((r) => this.parseTags(r.tags).some((t) => t.toLowerCase() === needle)).slice(0, limit).map((r) => ({
      id: r.id,
      path: r.path,
      relativePath: r.relative_path,
      title: r.title,
      type: r.type,
      tags: this.parseTags(r.tags),
      updatedAt: r.updated_at,
      rank: 0,
      snippet: this.parseTags(r.tags).join(", ")
    }));
  }
  getRecent(limit = 10) {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT id, path, relative_path, title, type, tags, updated_at, content
         FROM notes ORDER BY updated_at DESC LIMIT ?`
    ).all(limit);
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      relativePath: r.relative_path,
      title: r.title,
      type: r.type,
      tags: this.parseTags(r.tags),
      updatedAt: r.updated_at,
      rank: 0,
      snippet: (r.content || "").slice(0, 100).replace(/\n/g, " ").trim()
    }));
  }
  getByIds(ids) {
    if (!this.db || ids.length === 0) return [];
    const out = [];
    const stmt = this.db.prepare(
      `SELECT id, path, relative_path, title, type, tags, updated_at, content FROM notes WHERE id = ?`
    );
    for (const id of ids) {
      const r = stmt.get(id);
      if (!r) continue;
      out.push({
        id: r.id,
        path: r.path,
        relativePath: r.relative_path,
        title: r.title,
        type: r.type,
        tags: this.parseTags(r.tags),
        updatedAt: r.updated_at,
        rank: 0,
        snippet: (r.content || "").slice(0, 100).replace(/\n/g, " ").trim()
      });
    }
    return out;
  }
  /** Notes under Rules/, SOP/, Templates/, Prompt/ for Context Engine auto-include */
  listSystemNotes(limit = 20) {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT id, path, relative_path, title, type, tags, updated_at, content
         FROM notes
         WHERE lower(relative_path) LIKE 'rules/%'
            OR lower(relative_path) LIKE 'sop/%'
            OR lower(relative_path) LIKE 'templates/%'
            OR lower(relative_path) LIKE 'prompt/%'
         ORDER BY relative_path
         LIMIT ?`
    ).all(limit);
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      relativePath: r.relative_path,
      title: r.title,
      type: r.type,
      tags: this.parseTags(r.tags),
      updatedAt: r.updated_at,
      rank: 0,
      snippet: (r.content || "").slice(0, 400).replace(/\n/g, " ").trim()
    }));
  }
  parseTags(raw) {
    try {
      const arr = JSON.parse(raw || "[]");
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return [];
    }
  }
};
var indexDatabase = new IndexDatabase();

// src/main/engine/SearchEngine.ts
var SearchEngine = class {
  index = /* @__PURE__ */ new Map();
  fuse = null;
  useFts = true;
  initFuse() {
    this.fuse = new Fuse(Array.from(this.index.values()), {
      keys: [
        { name: "title", weight: 0.4 },
        { name: "tags", weight: 0.2 },
        { name: "content", weight: 0.3 },
        { name: "relativePath", weight: 0.1 }
      ],
      includeScore: true,
      includeMatches: true,
      threshold: 0.4,
      ignoreLocation: true
    });
  }
  setUseFts(enabled) {
    this.useFts = enabled;
  }
  buildIndex(parsedFiles) {
    this.index.clear();
    for (const file of parsedFiles) {
      this.addToIndex(file, false, false);
    }
    this.initFuse();
    if (indexDatabase.isOpen()) {
      indexDatabase.rebuild(parsedFiles);
    }
  }
  coerceDate(val) {
    if (val == null || val === "") return void 0;
    if (val instanceof Date) return val.toISOString();
    if (typeof val === "number") return new Date(val).toISOString();
    if (typeof val === "string") return val;
    return String(val);
  }
  addToIndex(file, rebuildFuse = true, writeDb = true) {
    this.index.set(file.id, {
      id: file.id,
      title: file.title,
      path: file.filePath,
      relativePath: file.relativePath,
      content: file.content,
      tags: file.tags,
      type: file.frontmatter.type || "note",
      rawContent: file.content,
      updatedAt: this.coerceDate(file.frontmatter.updated) || this.coerceDate(file.frontmatter.date) || void 0,
      headings: (file.headings || []).map((h) => h.text).join(" ")
    });
    if (writeDb && indexDatabase.isOpen()) {
      indexDatabase.upsertNote(file);
    }
    if (rebuildFuse) {
      this.initFuse();
    }
  }
  removeFromIndex(fileId) {
    this.index.delete(fileId);
    if (indexDatabase.isOpen()) {
      indexDatabase.removeById(fileId);
    }
    this.initFuse();
  }
  rebuildSqliteFromMemory() {
    if (!indexDatabase.isOpen()) return 0;
    const files = Array.from(this.index.values()).map((e) => ({
      id: e.id,
      filePath: e.path,
      relativePath: e.relativePath,
      title: e.title,
      frontmatter: { type: e.type, updated: e.updatedAt },
      content: e.content,
      rawContent: e.rawContent,
      wikiLinks: [],
      tags: e.tags,
      wordCount: 0,
      headings: (e.headings || "").split(/\s+/).filter(Boolean).map((text) => ({ level: 1, text }))
    }));
    return indexDatabase.rebuild(files);
  }
  search(options) {
    const { query, limit = 20, filterType, filterTag } = options;
    const q = (query || "").trim();
    if (!q) {
      return this.getRecentFiles(limit);
    }
    const lower = q.toLowerCase();
    if (lower === "orphan:true" || lower === "is:orphan") {
      return this.searchOrphans(limit);
    }
    const backMatch = q.match(/^backlinks?:(.+)$/i);
    if (backMatch) {
      return this.searchBacklinks(backMatch[1].trim(), limit);
    }
    const pathMatch = q.match(/^path:(.+)$/i);
    if (pathMatch) {
      return this.searchByPathFragment(pathMatch[1].trim(), limit);
    }
    const tagMatch = q.match(/^#([a-zA-Z0-9_/-]+)$/);
    if (tagMatch) {
      return this.searchByTagExact(tagMatch[1], limit);
    }
    const results = [];
    const seen = /* @__PURE__ */ new Set();
    if (this.useFts && indexDatabase.isOpen()) {
      const ftsHits = indexDatabase.searchFts(q, limit);
      for (const hit of ftsHits) {
        if (filterType && hit.type !== filterType) continue;
        if (filterTag && !hit.tags.some((t) => t.toLowerCase() === filterTag.toLowerCase())) continue;
        seen.add(hit.id);
        const score = Math.max(0, Math.min(100, 80 + hit.rank * -2));
        results.push({
          id: hit.id,
          title: hit.title,
          path: hit.path,
          relativePath: hit.relativePath,
          score,
          type: hit.type,
          tags: hit.tags,
          preview: hit.snippet || void 0,
          matchedField: "content",
          source: "fts"
        });
      }
    }
    if (results.length < limit && this.fuse) {
      const fuseResults = this.fuse.search(q);
      for (const res of fuseResults) {
        const entry = res.item;
        if (seen.has(entry.id)) continue;
        if (filterType && entry.type !== filterType) continue;
        if (filterTag && !entry.tags.some((t) => t.toLowerCase() === filterTag.toLowerCase())) continue;
        let preview;
        let matchedField = "content";
        if (res.matches && res.matches.length > 0) {
          const match = res.matches[0];
          if (match.key === "title") matchedField = "title";
          else if (match.key === "tags") matchedField = "tag";
          else if (match.key === "relativePath") matchedField = "path";
          if (match.key === "content" && match.indices && match.indices.length > 0) {
            const matchStart = match.indices[0][0];
            const start = Math.max(0, matchStart - 60);
            const end = Math.min(entry.rawContent.length, matchStart + q.length + 60);
            preview = "..." + entry.rawContent.slice(start, end).replace(/\n/g, " ").trim() + "...";
          }
        }
        if (!preview) {
          preview = entry.rawContent.slice(0, 120).replace(/\n/g, " ").trim();
        }
        results.push({
          id: entry.id,
          title: entry.title,
          path: entry.path,
          relativePath: entry.relativePath,
          score: (1 - (res.score || 0)) * 100,
          type: entry.type,
          tags: entry.tags,
          preview,
          matchedField,
          source: "fuse"
        });
        seen.add(entry.id);
        if (results.length >= limit) break;
      }
    }
    return results.slice(0, limit);
  }
  searchBacklinks(targetTitle, limit = 50) {
    const key = targetTitle.toLowerCase().replace(/\.md$/, "").trim();
    if (!key) return [];
    let targetId = null;
    for (const entry of this.index.values()) {
      if (entry.title.toLowerCase() === key) {
        targetId = entry.id;
        break;
      }
      const base = entry.relativePath.replace(/\\/g, "/").split("/").pop()?.replace(/\.md$/i, "") || "";
      if (base.toLowerCase() === key) {
        targetId = entry.id;
        break;
      }
    }
    if (!targetId) {
      const p = graphEngine.resolveTitleToPath(targetTitle);
      if (p) {
        const node = graphEngine.getNodeByPath(p);
        if (node) targetId = node.id;
      }
    }
    if (targetId) {
      const { nodes } = graphEngine.getBacklinks(targetId);
      if (nodes.length > 0) {
        return nodes.slice(0, limit).map((n) => ({
          id: n.id,
          title: n.title,
          path: n.path,
          relativePath: n.relativePath,
          score: 100,
          type: n.type,
          tags: n.tags,
          matchedField: "backlink",
          preview: `\u2192 links to [[${targetTitle}]]`,
          source: "meta"
        }));
      }
    }
    const wikiRe = /\[\[([^\]]+?)\]\]/g;
    const results = [];
    for (const e of this.index.values()) {
      if (targetId && e.id === targetId) continue;
      if (e.title.toLowerCase() === key) continue;
      const body = (e.content || e.rawContent || "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
      wikiRe.lastIndex = 0;
      let m;
      let hit = false;
      while ((m = wikiRe.exec(body)) !== null) {
        const inner = m[1].replace(/\\\|/g, "|");
        const pipe = inner.indexOf("|");
        let t = (pipe >= 0 ? inner.slice(0, pipe) : inner).split("#")[0].split("^")[0].trim();
        t = t.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
        const base = t.includes("/") ? t.split("/").pop() : t;
        if (t === key || base === key) {
          hit = true;
          break;
        }
      }
      if (hit) {
        results.push({
          id: e.id,
          title: e.title,
          path: e.path,
          relativePath: e.relativePath,
          score: 100,
          type: e.type,
          tags: e.tags,
          matchedField: "backlink",
          preview: `\u2192 links to [[${targetTitle}]]`,
          source: "meta"
        });
        if (results.length >= limit) break;
      }
    }
    return results;
  }
  searchByPathFragment(fragment, limit) {
    const f = fragment.toLowerCase().replace(/\\/g, "/");
    return Array.from(this.index.values()).filter((e) => e.relativePath.toLowerCase().replace(/\\/g, "/").includes(f)).slice(0, limit).map((e) => ({
      id: e.id,
      title: e.title,
      path: e.path,
      relativePath: e.relativePath,
      score: 90,
      type: e.type,
      tags: e.tags,
      matchedField: "path",
      preview: e.relativePath,
      source: "meta"
    }));
  }
  searchByTag(tag) {
    return this.searchByTagExact(tag.replace(/^#/, ""), 50);
  }
  searchByTagExact(tag, limit) {
    if (indexDatabase.isOpen()) {
      return indexDatabase.searchByTag(tag, limit).map((e) => ({
        id: e.id,
        title: e.title,
        path: e.path,
        relativePath: e.relativePath,
        score: 100,
        type: e.type,
        tags: e.tags,
        matchedField: "tag",
        preview: e.tags.join(", "),
        source: "fts"
      }));
    }
    const t = tag.toLowerCase();
    return Array.from(this.index.values()).filter((e) => e.tags.some((x) => x.toLowerCase() === t)).slice(0, limit).map((e) => ({
      id: e.id,
      title: e.title,
      path: e.path,
      relativePath: e.relativePath,
      score: 100,
      type: e.type,
      tags: e.tags,
      matchedField: "tag",
      preview: e.tags.join(", "),
      source: "meta"
    }));
  }
  orphanIds = /* @__PURE__ */ new Set();
  setOrphanIds(ids) {
    this.orphanIds = new Set(ids);
  }
  searchOrphans(limit = 50) {
    return Array.from(this.index.values()).filter((e) => this.orphanIds.has(e.id)).slice(0, limit).map((e) => ({
      id: e.id,
      title: e.title,
      path: e.path,
      relativePath: e.relativePath,
      score: 0,
      type: e.type,
      tags: e.tags,
      matchedField: "title",
      preview: "Orphan note (no graph connections)",
      source: "meta"
    }));
  }
  getRecentFiles(limit = 10) {
    if (indexDatabase.isOpen()) {
      const hits = indexDatabase.getRecent(limit);
      if (hits.length > 0) {
        return hits.map((e) => ({
          id: e.id,
          title: e.title,
          path: e.path,
          relativePath: e.relativePath,
          score: 0,
          type: e.type,
          tags: e.tags,
          matchedField: "title",
          preview: e.snippet,
          source: "fts"
        }));
      }
    }
    return Array.from(this.index.values()).sort((a, b) => {
      const ta = String(a.updatedAt || "");
      const tb = String(b.updatedAt || "");
      if (ta !== tb) return tb.localeCompare(ta);
      return a.title.localeCompare(b.title);
    }).slice(0, limit).map((e) => ({
      id: e.id,
      title: e.title,
      path: e.path,
      relativePath: e.relativePath,
      score: 0,
      type: e.type,
      tags: e.tags,
      matchedField: "title",
      preview: e.rawContent.slice(0, 100).replace(/\n/g, " ").trim(),
      source: "meta"
    }));
  }
  getIndexSize() {
    return this.index.size;
  }
  getIndexStats() {
    return {
      memoryCount: this.index.size,
      sqlite: indexDatabase.getStats()
    };
  }
  getAllTags() {
    const tagMap = /* @__PURE__ */ new Map();
    for (const entry of this.index.values()) {
      for (const tag of entry.tags) {
        tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
      }
    }
    return Array.from(tagMap.entries()).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
  }
  /** Paths under Rules/SOP/Templates for context auto-include */
  getSystemFolderNotes() {
    return Array.from(this.index.values()).filter((e) => {
      const p = e.relativePath.replace(/\\/g, "/").toLowerCase();
      return p.startsWith("rules/") || p.startsWith("sop/") || p.startsWith("templates/") || p.startsWith("prompt/");
    });
  }
  getEntryByPath(filePath) {
    const norm = filePath.replace(/\\/g, "/");
    for (const e of this.index.values()) {
      if (e.path.replace(/\\/g, "/") === norm) return e;
    }
    return void 0;
  }
};
var searchEngine = new SearchEngine();

// src/main/ai/AgentTools.ts
import path9 from "path";
import fs7 from "fs";
import crypto4 from "crypto";

// src/main/engine/MarkdownEngine.ts
import matter from "gray-matter";
import path8 from "path";
import crypto3 from "crypto";
var WIKI_LINK_INNER_REGEX = /\[\[([^\]]+?)\]\]/g;
var TAG_INLINE_REGEX = /#([a-zA-Z0-9_/-]+)/g;
function stripCodeRegions(content) {
  return content.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length)).replace(/`[^`\n]+`/g, (m) => " ".repeat(m.length));
}
function extractWikiLinks(content) {
  const links = [];
  const scan = stripCodeRegions(content);
  let match;
  const regex = new RegExp(WIKI_LINK_INNER_REGEX.source, "g");
  while ((match = regex.exec(scan)) !== null) {
    const inner = match[1];
    const normalized = inner.replace(/\\\|/g, "|");
    const pipe = normalized.indexOf("|");
    const targetPart = pipe >= 0 ? normalized.slice(0, pipe) : normalized;
    const aliasPart = pipe >= 0 ? normalized.slice(pipe + 1).trim() : void 0;
    let target = targetPart.split("#")[0].split("^")[0].trim();
    target = target.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "").trim();
    if (!target) continue;
    const rawText = content.slice(match.index, match.index + match[0].length) || match[0];
    links.push({
      target,
      alias: aliasPart || void 0,
      rawText,
      position: { start: match.index, end: match.index + match[0].length }
    });
  }
  return links;
}
function extractHeadings(content) {
  const headings = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) {
      headings.push({ level: m[1].length, text: m[2].trim() });
    }
  }
  return headings;
}
function extractInlineTags(content) {
  const tags = /* @__PURE__ */ new Set();
  let match;
  const regex = new RegExp(TAG_INLINE_REGEX.source, "g");
  while ((match = regex.exec(content)) !== null) {
    tags.add(match[1]);
  }
  return Array.from(tags);
}
function inferTitle(frontmatter, filePath, content) {
  if (frontmatter.title && typeof frontmatter.title === "string") {
    return frontmatter.title;
  }
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return path8.basename(filePath, path8.extname(filePath));
}
function countWords(text) {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}
function generateId2(filePath) {
  return crypto3.createHash("sha256").update(filePath).digest("hex").slice(0, 24);
}
var MarkdownEngine = class {
  parseFile(filePath, rawContent, rootPath) {
    let parsed;
    try {
      parsed = matter(rawContent);
    } catch {
      parsed = { data: {}, content: rawContent, orig: rawContent };
    }
    const frontmatter = { ...parsed.data };
    for (const key of ["date", "created", "updated"]) {
      const v = frontmatter[key];
      if (Object.prototype.toString.call(v) === "[object Date]") {
        frontmatter[key] = v.toISOString().split("T")[0];
      } else if (typeof v === "number") {
        frontmatter[key] = new Date(v).toISOString().split("T")[0];
      }
    }
    const content = parsed.content;
    const wikiLinks = extractWikiLinks(content);
    const headings = extractHeadings(content);
    const inlineTags = extractInlineTags(content);
    const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [];
    const tags = Array.from(/* @__PURE__ */ new Set([...fmTags, ...inlineTags]));
    const title = inferTitle(frontmatter, filePath, content);
    const relativePath = rootPath ? path8.relative(rootPath, filePath).replace(/\\/g, "/") : filePath;
    return {
      id: generateId2(filePath),
      filePath,
      relativePath,
      title,
      frontmatter,
      content,
      rawContent,
      wikiLinks,
      tags,
      wordCount: countWords(content),
      headings
    };
  }
  resolveWikiLink(target, allFiles) {
    for (const [filePath, title] of allFiles.entries()) {
      if (title.toLowerCase() === target.toLowerCase()) return filePath;
      const baseName = path8.basename(filePath, path8.extname(filePath));
      if (baseName.toLowerCase() === target.toLowerCase()) return filePath;
    }
    return null;
  }
  renderToHtml(content) {
    let html = content.replace(/\[\[([^\]]+?)\]\]/g, (_raw, inner) => {
      const normalized = inner.replace(/\\\|/g, "|");
      const pipe = normalized.indexOf("|");
      let target = (pipe >= 0 ? normalized.slice(0, pipe) : normalized).trim();
      const alias = pipe >= 0 ? normalized.slice(pipe + 1).trim() : "";
      target = target.split("#")[0].split("^")[0].trim().replace(/\\/g, "/").replace(/\/+$/g, "");
      const label = alias || target;
      const safeTarget = target.replace(/"/g, "&quot;");
      return `<span class="wiki-link" data-target="${safeTarget}">${label}</span>`;
    });
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>').replace(/`([^`]+)`/g, "<code>$1</code>").replace(/^###### (.+)$/gm, "<h6>$1</h6>").replace(/^##### (.+)$/gm, "<h5>$1</h5>").replace(/^#### (.+)$/gm, "<h4>$1</h4>").replace(/^### (.+)$/gm, "<h3>$1</h3>").replace(/^## (.+)$/gm, "<h2>$1</h2>").replace(/^# (.+)$/gm, "<h1>$1</h1>").replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/__(.+?)__/g, "<strong>$1</strong>").replace(/_(.+?)_/g, "<em>$1</em>").replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank">$1</a>').replace(/!\[(.+?)\]\((.+?)\)/g, '<img src="$2" alt="$1" />').replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>").replace(/^---+$/gm, "<hr />").replace(/^[\*\-] (.+)$/gm, "<li>$1</li>").replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>").replace(/^\d+\. (.+)$/gm, "<li>$1</li>").replace(/\n\n([^<\n].*)/g, "\n\n<p>$1</p>").replace(/~~(.+?)~~/g, "<del>$1</del>");
    return html;
  }
  buildFrontmatterString(meta) {
    const lines = ["---"];
    for (const [key, val] of Object.entries(meta)) {
      if (val === void 0 || val === null) continue;
      if (Array.isArray(val)) {
        lines.push(`${key}:`);
        for (const v of val) lines.push(`  - ${v}`);
      } else {
        lines.push(`${key}: ${val}`);
      }
    }
    lines.push("---", "");
    return lines.join("\n");
  }
  createNoteTemplate(title, type = "note") {
    const now = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    return `---
title: ${title}
type: ${type}
created: ${now}
updated: ${now}
tags: []
---

# ${title}

`;
  }
  createDailyNoteTemplate(date) {
    return `---
title: ${date}
type: daily
date: ${date}
---

# ${date}

## \u{1F3AF} Today's Focus


## \u{1F4DD} Notes


## \u2705 Tasks

- [ ] 

## \u{1F517} Links


`;
  }
};
var markdownEngine = new MarkdownEngine();

// src/main/ai/AgentTools.ts
init_TemplateEngine();
var WRITE_TOOLS = /* @__PURE__ */ new Set(["write_note", "append_note", "create_note", "create_from_template"]);
var READ_TOOLS = /* @__PURE__ */ new Set(["search", "read_note", "list_dir", "list_templates"]);
var proposals = /* @__PURE__ */ new Map();
function isWriteTool(name) {
  return WRITE_TOOLS.has(name);
}
function isReadTool(name) {
  return READ_TOOLS.has(name);
}
function getProposal(id) {
  return proposals.get(id);
}
var TOOLS_SYSTEM_PROMPT = `
## Workspace Tools (AI Worker)

You MAY call tools by emitting one or more fenced blocks. Use EXACTLY this format:

\`\`\`wg-action
{"tool":"search","args":{"query":"cuti","limit":5}}
\`\`\`

Available tools:
1. search \u2014 args: { query: string, limit?: number }
2. read_note \u2014 args: { path: string }  // absolute or vault-relative path, or note title
3. list_dir \u2014 args: { path?: string }  // relative folder under vault root; default ""
4. write_note \u2014 args: { path: string, content: string }  // overwrite entire file (preserve frontmatter if present in content)
5. append_note \u2014 args: { path: string, content: string }  // append markdown section
6. create_note \u2014 args: { path: string, content: string }  // create new .md (path relative e.g. Knowledge/Foo.md)
7. list_templates \u2014 args: {}  // list built-in + vault templates
8. create_from_template \u2014 args: { templateId: string, title: string, folder?: string }  // MUST prefer this over freeform create when a template fits (project/task/people/sop/daily)

Rules:
- Prefer search + read_note before inventing vault facts (Constitution Law 006).
- For new structured notes (project, task, people, sop, daily): call list_templates then create_from_template.
- For write/create/append/create_from_template: propose once; user must confirm before disk write.
- Paths use vault-relative form when possible (Knowledge/..., Daily/...).
- After tool results arrive, continue answering. Do not invent tool results.
- When finished, write a clear user-facing summary in Markdown with [[WikiLinks]].
`.trim();
function parseToolActions(text) {
  const actions = [];
  const re = /```wg-action\s*([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) {
        for (const a of parsed) {
          if (a && typeof a.tool === "string") actions.push(a);
        }
      } else if (parsed && typeof parsed.tool === "string") {
        actions.push(parsed);
      }
    } catch {
      try {
        const lines = body.split("\n").filter((l) => l.trim().startsWith("{"));
        for (const line of lines) {
          const a = JSON.parse(line);
          if (a?.tool) actions.push(a);
        }
      } catch {
      }
    }
  }
  return actions;
}
function stripToolActions(text) {
  return text.replace(/```wg-action\s*[\s\S]*?```/gi, "").trim();
}
function resolvePath(input) {
  const root = workspaceEngine.getState().rootPath;
  if (!root) return null;
  if (!input || !String(input).trim()) return null;
  let p = String(input).trim();
  if (path9.isAbsolute(p)) {
    const normRoot = path9.resolve(root);
    const normP = path9.resolve(p);
    if (!normP.toLowerCase().startsWith(normRoot.toLowerCase())) {
      return null;
    }
    return normP;
  }
  p = p.replace(/^[/\\]+/, "");
  const abs = path9.resolve(root, p);
  if (!abs.toLowerCase().startsWith(path9.resolve(root).toLowerCase())) return null;
  return abs;
}
function resolveNotePath(input) {
  const direct = resolvePath(input);
  if (direct && fs7.existsSync(direct)) return direct;
  if (direct && !fs7.existsSync(direct) && direct.toLowerCase().endsWith(".md")) {
    return direct;
  }
  const hits = searchEngine.search({ query: input, limit: 5 });
  const exact = hits.find(
    (h) => h.title.toLowerCase() === input.toLowerCase() || h.relativePath.toLowerCase().endsWith(`/${input.toLowerCase()}.md`) || h.relativePath.toLowerCase().endsWith(`${input.toLowerCase()}.md`)
  );
  if (exact) return exact.path;
  if (hits[0]) return hits[0].path;
  const root = workspaceEngine.getState().rootPath;
  if (!root) return null;
  const withMd = input.endsWith(".md") ? input : `${input}.md`;
  const guess = resolvePath(withMd.startsWith("Knowledge") ? withMd : `Knowledge/${withMd}`);
  return guess;
}
function relativeToVault(abs) {
  const root = workspaceEngine.getState().rootPath || "";
  return path9.relative(root, abs).replace(/\\/g, "/");
}
function validateMarkdownContent(content) {
  if (typeof content !== "string") return { ok: false, error: "content must be string" };
  if (content.length > 5e5) return { ok: false, error: "content too large (>500KB)" };
  if (content.startsWith("---")) {
    const end = content.indexOf("\n---", 3);
    if (end === -1) return { ok: false, error: "unclosed frontmatter (---)" };
    return { ok: true, preservesFrontmatter: true };
  }
  return { ok: true, preservesFrontmatter: false };
}
function createProposal(tool, abs, content, mode) {
  const id = crypto4.randomBytes(8).toString("hex");
  const validation = validateMarkdownContent(content);
  const prop = {
    id,
    tool,
    absolutePath: abs,
    relativePath: relativeToVault(abs),
    content,
    mode,
    preview: content.slice(0, 400).replace(/\n/g, " "),
    status: "pending",
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    preservesFrontmatter: validation.preservesFrontmatter
  };
  proposals.set(id, prop);
  return prop;
}
async function executeTool(action) {
  const tool = action.tool;
  const args = action.args || {};
  try {
    if (!workspaceEngine.getState().rootPath) {
      return { tool, ok: false, error: "No workspace open" };
    }
    switch (tool) {
      case "search": {
        const query = String(args.query || "");
        const limit = Number(args.limit) || 8;
        const hits = searchEngine.search({ query, limit });
        return {
          tool,
          ok: true,
          result: hits.map((h) => ({
            title: h.title,
            path: h.relativePath,
            absolutePath: h.path,
            score: h.score,
            preview: h.preview
          }))
        };
      }
      case "read_note": {
        const input = String(args.path || args.title || "");
        const abs = resolveNotePath(input);
        if (!abs || !fs7.existsSync(abs)) {
          return { tool, ok: false, error: `Note not found: ${input}` };
        }
        const raw = workspaceEngine.readFile(abs);
        const root = workspaceEngine.getState().rootPath || "";
        const parsed = markdownEngine.parseFile(abs, raw, root);
        return {
          tool,
          ok: true,
          result: {
            path: relativeToVault(abs),
            absolutePath: abs,
            title: parsed.title,
            tags: parsed.tags,
            content: raw.slice(0, 12e3)
          }
        };
      }
      case "list_dir": {
        const rel = String(args.path || "").replace(/^[/\\]+/, "");
        const abs = resolvePath(rel || ".");
        if (!abs || !fs7.existsSync(abs)) {
          return { tool, ok: false, error: `Directory not found: ${rel || "/"}` };
        }
        const entries = fs7.readdirSync(abs, { withFileTypes: true });
        const items = entries.filter((e) => !e.name.startsWith(".")).slice(0, 100).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
          path: relativeToVault(path9.join(abs, e.name))
        }));
        return { tool, ok: true, result: { path: relativeToVault(abs), items } };
      }
      case "write_note": {
        const input = String(args.path || "");
        const content = String(args.content ?? "");
        const v = validateMarkdownContent(content);
        if (!v.ok) return { tool, ok: false, error: v.error };
        const abs = resolveNotePath(input) || resolvePath(input);
        if (!abs) return { tool, ok: false, error: "Invalid path" };
        let finalContent = content;
        if (fs7.existsSync(abs) && !content.startsWith("---")) {
          try {
            const existing = workspaceEngine.readFile(abs);
            if (existing.startsWith("---")) {
              const end = existing.indexOf("\n---", 3);
              if (end !== -1) {
                finalContent = existing.slice(0, end + 4) + "\n\n" + content.trimStart();
              }
            }
          } catch {
          }
        }
        const prop = createProposal("write_note", abs, finalContent, "overwrite");
        return {
          tool,
          ok: true,
          proposalId: prop.id,
          result: {
            pending: true,
            proposalId: prop.id,
            path: prop.relativePath,
            message: "Write proposal created \u2014 waiting for user confirm"
          }
        };
      }
      case "append_note": {
        const input = String(args.path || "");
        const content = String(args.content ?? "");
        if (!content.trim()) return { tool, ok: false, error: "empty append content" };
        const abs = resolveNotePath(input);
        if (!abs || !fs7.existsSync(abs)) {
          return { tool, ok: false, error: `Note not found for append: ${input}` };
        }
        const existing = workspaceEngine.readFile(abs);
        const merged = existing.replace(/\s*$/, "") + "\n\n" + content.trim() + "\n";
        const prop = createProposal("append_note", abs, merged, "append");
        prop.preview = content.slice(0, 400).replace(/\n/g, " ");
        return {
          tool,
          ok: true,
          proposalId: prop.id,
          result: {
            pending: true,
            proposalId: prop.id,
            path: prop.relativePath,
            message: "Append proposal created \u2014 waiting for user confirm"
          }
        };
      }
      case "create_note": {
        const input = String(args.path || "");
        let content = String(args.content ?? "");
        const abs = resolvePath(input.endsWith(".md") ? input : `${input}.md`);
        if (!abs) return { tool, ok: false, error: "Invalid path" };
        if (fs7.existsSync(abs)) {
          return { tool, ok: false, error: `File already exists: ${relativeToVault(abs)}` };
        }
        if (!content.startsWith("---")) {
          const title = path9.basename(abs, ".md") || "Untitled";
          content = markdownEngine.createNoteTemplate(title, "knowledge") + content;
        }
        const v = validateMarkdownContent(content);
        if (!v.ok) return { tool, ok: false, error: v.error };
        const prop = createProposal("create_note", abs, content, "create");
        return {
          tool,
          ok: true,
          proposalId: prop.id,
          result: {
            pending: true,
            proposalId: prop.id,
            path: prop.relativePath,
            message: "Create proposal created \u2014 waiting for user confirm"
          }
        };
      }
      case "list_templates": {
        const root = workspaceEngine.getState().rootPath;
        const list = templateEngine.listTemplates(root);
        return {
          tool,
          ok: true,
          result: list.map((t) => ({
            id: t.id,
            name: t.name,
            kind: t.kind,
            defaultFolder: t.defaultFolder,
            builtin: t.builtin
          }))
        };
      }
      case "create_from_template": {
        const templateId = String(args.templateId || args.template || "");
        const title = String(args.title || "Untitled");
        const root = workspaceEngine.getState().rootPath;
        if (!root) return { tool, ok: false, error: "No workspace open" };
        const tpl = templateEngine.getTemplate(templateId, root);
        if (!tpl) return { tool, ok: false, error: `Template not found: ${templateId}` };
        const content = templateEngine.render(tpl.body, {
          title,
          filename: title,
          project: String(args.project || ""),
          owner: String(args.owner || ""),
          workspace: path9.basename(root)
        });
        const folder = String(args.folder || tpl.defaultFolder);
        let fileName = `${title.replace(/[<>:"/\\|?*]/g, "-")}.md`;
        if (tpl.kind === "daily") {
          fileName = `${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}.md`;
        }
        const abs = resolvePath(path9.join(folder, fileName));
        if (!abs) return { tool, ok: false, error: "Invalid path" };
        if (fs7.existsSync(abs)) {
          return { tool, ok: false, error: `File already exists: ${relativeToVault(abs)}` };
        }
        const prop = createProposal("create_from_template", abs, content, "create");
        return {
          tool,
          ok: true,
          proposalId: prop.id,
          result: {
            pending: true,
            proposalId: prop.id,
            path: prop.relativePath,
            templateId,
            message: "Template create proposal \u2014 waiting for user confirm"
          }
        };
      }
      default:
        return { tool, ok: false, error: `Unknown tool: ${tool}` };
    }
  } catch (err) {
    return {
      tool,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
function formatToolResultsForModel(results) {
  return "### Tool results (from WorkspaceGraph)\n\n" + results.map((r) => {
    if (!r.ok) return `- **${r.tool}** ERROR: ${r.error}`;
    return `- **${r.tool}** OK:
\`\`\`json
${JSON.stringify(r.result, null, 2).slice(0, 8e3)}
\`\`\``;
  }).join("\n\n") + "\n\nContinue your answer using these results. If write proposals are pending, tell the user to confirm them in the chat panel.";
}

// src/main/ai/AIMiddleware.ts
var MAX_TOOL_ROUNDS = 4;
var AIMiddleware = class {
  providers = /* @__PURE__ */ new Map();
  activeProviderId = "grok";
  contextEngine;
  abortFlags = /* @__PURE__ */ new Map();
  constructor() {
    this.contextEngine = new ContextEngine(workspaceEngine, searchEngine);
    const grok = new GrokProvider();
    const gemini = new GeminiProvider();
    const openai = new OpenAIProvider();
    const claude = new ClaudeProvider();
    const ollama = new OllamaProvider();
    const openrouter = new OpenRouterProvider();
    this.providers.set(grok.id, grok);
    this.providers.set(gemini.id, gemini);
    this.providers.set(openai.id, openai);
    this.providers.set(claude.id, claude);
    this.providers.set(ollama.id, ollama);
    this.providers.set(openrouter.id, openrouter);
  }
  configureProvider(providerId, config) {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Provider not found: ${providerId}`);
    if (provider instanceof GrokProvider) {
      provider.configure({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        defaultModel: config.defaultModel,
        backend: config.backend || "chat",
        useCliSession: config.useCliSession
      });
    } else {
      provider.configure(config);
    }
  }
  /** Import session from Grok CLI (~/.grok/auth.json) — login X via CLI once */
  importGrokFromCli() {
    const imp = importGrokCliAuth();
    if (!imp.ok || !imp.apiKey) {
      return { ok: false, error: imp.error || "Import gagal" };
    }
    this.configureProvider("grok", {
      apiKey: imp.apiKey,
      baseUrl: "https://api.x.ai/v1",
      defaultModel: imp.defaultModel || "grok-4.5",
      backend: "chat",
      useCliSession: true
    });
    this.setActiveProvider("grok");
    return {
      ok: true,
      email: imp.email,
      model: imp.defaultModel || "grok-4.5",
      baseUrl: "https://api.x.ai/v1",
      apiKey: imp.apiKey,
      backend: "chat"
    };
  }
  getGrokProvider() {
    const p = this.providers.get("grok");
    return p instanceof GrokProvider ? p : null;
  }
  setActiveProvider(providerId) {
    if (!this.providers.has(providerId)) throw new Error(`Provider not found: ${providerId}`);
    this.activeProviderId = providerId;
  }
  getActiveProvider() {
    const provider = this.providers.get(this.activeProviderId);
    if (!provider) throw new Error(`Active provider not configured: ${this.activeProviderId}`);
    return provider;
  }
  cancelStream(requestId) {
    this.abortFlags.set(requestId, true);
  }
  isCancelled(requestId) {
    if (!requestId) return false;
    return this.abortFlags.get(requestId) === true;
  }
  clearCancel(requestId) {
    this.abortFlags.delete(requestId);
  }
  async getAllProvidersStatus() {
    const statuses = [];
    for (const provider of this.providers.values()) {
      const configured = provider.isConfigured();
      const models = await provider.listModels().catch(() => []);
      const isConnected = configured ? await provider.healthCheck().catch(() => false) : false;
      statuses.push({
        id: provider.id,
        name: provider.name,
        connected: isConnected,
        configured,
        models,
        defaultModel: provider.getDefaultModel(),
        error: configured ? void 0 : "API key belum di-set"
      });
    }
    return statuses;
  }
  /** Live ping — actually calls the API once (for Settings → Test) */
  async testProvider(providerId) {
    const id = providerId || this.activeProviderId;
    const provider = this.providers.get(id);
    if (!provider) return { ok: false, error: `Provider not found: ${id}` };
    if (!provider.isConfigured()) {
      return { ok: false, error: "API key / base URL belum dikonfigurasi" };
    }
    try {
      const res = await provider.sendMessage({
        model: provider.getDefaultModel(),
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        maxTokens: 16,
        systemPrompt: "You are a connectivity test. Reply only OK."
      });
      return { ok: true, sample: (res.content || "").slice(0, 80) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  buildSystemPrompt(request, activeFilePath, useContext, agentRole, enableTools) {
    let systemPrompt = request.systemPrompt || "";
    let citations = [];
    if (useContext && request.messages.length > 0) {
      const lastUserMsg = request.messages[request.messages.length - 1];
      if (lastUserMsg.role === "user") {
        const ctxPackage = this.contextEngine.buildContextPackage(
          lastUserMsg.content,
          activeFilePath,
          agentRole
        );
        systemPrompt = (systemPrompt ? systemPrompt + "\n\n" : "") + ctxPackage.formattedContext;
        citations = ctxPackage.citations;
      }
    }
    if (enableTools) {
      systemPrompt = (systemPrompt ? systemPrompt + "\n\n" : "") + TOOLS_SYSTEM_PROMPT;
    }
    return { systemPrompt, citations };
  }
  async sendMessage(request, activeFilePath, useContext = true, agentRole = "general") {
    const provider = this.getActiveProvider();
    const { systemPrompt, citations } = this.buildSystemPrompt(
      request,
      activeFilePath,
      useContext,
      agentRole,
      false
    );
    request.systemPrompt = systemPrompt;
    const res = await provider.sendMessage(request);
    return { response: res, citations };
  }
  /**
   * Stream with optional multi-round tool loop (Phase 3).
   */
  async streamMessage(request, onChunk, activeFilePath, useContext = true, agentRole = "general", enableTools = false, requestId) {
    if (requestId) this.clearCancel(requestId);
    let provider;
    try {
      provider = this.getActiveProvider();
    } catch (err) {
      onChunk({
        content: "",
        done: true,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    if (!provider.isConfigured()) {
      onChunk({
        content: "",
        done: true,
        error: `Provider "${provider.name}" belum dikonfigurasi. Buka Settings \u2192 AI Providers, isi API key, lalu Save.`
      });
      return;
    }
    if (!request.model || request.model === "undefined") {
      request.model = provider.getDefaultModel();
    }
    if (provider.id === "gemini" && /gemini-2\.5-pro|gemini-1\.5-pro/i.test(request.model) && process.env.WG_ALLOW_GEMINI_PRO !== "1") {
    }
    const { systemPrompt, citations } = this.buildSystemPrompt(
      request,
      activeFilePath,
      useContext,
      agentRole,
      enableTools
    );
    let messages = [...request.messages];
    if (messages.length === 0) {
      onChunk({ content: "", done: true, error: "No messages in request" });
      return;
    }
    const allProposals = [];
    let lastCitations = citations;
    const started = Date.now();
    const TIMEOUT_MS = 18e4;
    for (let round = 0; round < (enableTools ? MAX_TOOL_ROUNDS : 1); round++) {
      if (requestId && this.isCancelled(requestId)) {
        onChunk({ content: "\n\n*(cancelled)*\n", done: true, citations: lastCitations, proposals: allProposals });
        return;
      }
      if (Date.now() - started > TIMEOUT_MS) {
        onChunk({
          content: "\n\n*(timeout \u2014 stopped tool loop)*\n",
          done: true,
          citations: lastCitations,
          proposals: allProposals
        });
        return;
      }
      let fullText = "";
      let streamError;
      const req = {
        ...request,
        messages,
        systemPrompt,
        stream: true
      };
      await provider.streamMessage(req, (chunk) => {
        if (requestId && this.isCancelled(requestId)) return;
        if (chunk.error) streamError = chunk.error;
        fullText += chunk.content || "";
        if (chunk.error) {
          onChunk({
            content: chunk.content || "",
            done: false,
            error: chunk.error,
            citations: lastCitations,
            round
          });
          return;
        }
        onChunk({
          content: chunk.content,
          done: false,
          citations: lastCitations,
          round
        });
      });
      if (streamError) {
        onChunk({
          content: `

**Error:** ${streamError}`,
          done: true,
          error: streamError,
          citations: lastCitations,
          proposals: allProposals
        });
        return;
      }
      if (!enableTools) {
        onChunk({ content: "", done: true, citations: lastCitations, proposals: allProposals });
        return;
      }
      const actions = parseToolActions(fullText);
      if (actions.length === 0) {
        onChunk({ content: "", done: true, citations: lastCitations, proposals: allProposals });
        return;
      }
      const readActions = actions.filter((a) => isReadTool(a.tool));
      const writeActions = actions.filter((a) => isWriteTool(a.tool));
      const results = [];
      for (const action of writeActions) {
        onChunk({
          content: "",
          done: false,
          toolStatus: `Proposing ${action.tool}\u2026`,
          round
        });
        const r = await executeTool(action);
        results.push(r);
        if (r.proposalId) {
          const prop = getProposal(r.proposalId);
          if (prop) {
            allProposals.push(prop);
            onChunk({
              content: `

\u{1F4DD} **Write proposal** \`${prop.relativePath}\` (${prop.mode}) \u2014 confirm to apply.
`,
              done: false,
              proposals: [prop],
              toolStatus: `Proposal ${prop.id}`,
              round
            });
          }
        }
      }
      for (const action of readActions) {
        onChunk({
          content: "",
          done: false,
          toolStatus: `Running ${action.tool}\u2026`,
          round
        });
        const r = await executeTool(action);
        results.push(r);
        if (r.ok && action.tool === "read_note" && r.result && typeof r.result === "object") {
          const res = r.result;
          if (res.absolutePath && res.title) {
            if (!lastCitations.some((c) => c.path === res.absolutePath)) {
              lastCitations = [...lastCitations, { title: res.title, path: res.absolutePath }];
            }
          }
        }
        if (r.ok && action.tool === "search" && Array.isArray(r.result)) {
          for (const hit of r.result) {
            if (hit.absolutePath && !lastCitations.some((c) => c.path === hit.absolutePath)) {
              lastCitations = [...lastCitations, { title: hit.title, path: hit.absolutePath }];
            }
          }
        }
      }
      if (readActions.length === 0) {
        onChunk({ content: "", done: true, citations: lastCitations, proposals: allProposals });
        return;
      }
      const cleanAssistant = stripToolActions(fullText) || fullText;
      messages = [
        ...messages,
        { role: "assistant", content: cleanAssistant },
        { role: "user", content: formatToolResultsForModel(results) }
      ];
      onChunk({
        content: "\n\n---\n*Tool results applied \u2014 continuing\u2026*\n\n",
        done: false,
        toolStatus: `Round ${round + 1} tools done`,
        citations: lastCitations,
        round
      });
    }
    onChunk({
      content: "\n\n*(max tool rounds reached)*\n",
      done: true,
      citations: lastCitations,
      proposals: allProposals
    });
  }
};
var aiMiddleware = new AIMiddleware();
export {
  AIMiddleware,
  aiMiddleware
};
