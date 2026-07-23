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
import fs from "fs";
import path from "path";
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
        const dir = path.join(workspaceRoot, "Templates");
        if (!fs.existsSync(dir)) return list;
        try {
          const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
          for (const f of files) {
            const full = path.join(dir, f);
            const body = fs.readFileSync(full, "utf-8");
            const name = path.basename(f, ".md");
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
        const dir = path.join(workspaceRoot, "Templates");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        let n = 0;
        for (const t of this.getBuiltinTemplates()) {
          const file = path.join(dir, `${t.name.replace(/\s+/g, "-")}.md`);
          if (!fs.existsSync(file)) {
            fs.writeFileSync(file, t.body, "utf-8");
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

// src/main/ai/AgentTools.ts
import path6 from "path";
import fs4 from "fs";
import crypto4 from "crypto";

// src/main/engine/WorkspaceEngine.ts
import fs2 from "fs";
import path2 from "path";
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
  const lower = path2.relative(rootPath, filePath).toLowerCase().replace(/\\/g, "/");
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
function generateId(filePath) {
  return crypto2.createHash("sha256").update(filePath).digest("hex").slice(0, 24);
}
function scanDirectory(dirPath, rootPath) {
  const entries = [];
  try {
    const items = fs2.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".")) continue;
      if (item.name === "node_modules") continue;
      const fullPath = path2.join(dirPath, item.name);
      const stats = fs2.statSync(fullPath);
      const relativePath = path2.relative(rootPath, fullPath);
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
        const ext = path2.extname(item.name).toLowerCase();
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
    this.configDir = path2.join(app.getPath("userData"), "workspacegraph");
    if (!fs2.existsSync(this.configDir)) {
      fs2.mkdirSync(this.configDir, { recursive: true });
    }
    this.loadRecentWorkspaces();
  }
  loadRecentWorkspaces() {
    const filePath = path2.join(this.configDir, "recent.json");
    try {
      if (fs2.existsSync(filePath)) {
        this.recentWorkspaces = JSON.parse(fs2.readFileSync(filePath, "utf-8"));
      }
    } catch {
      this.recentWorkspaces = [];
    }
  }
  saveRecentWorkspaces() {
    const filePath = path2.join(this.configDir, "recent.json");
    fs2.writeFileSync(filePath, JSON.stringify(this.recentWorkspaces, null, 2));
  }
  openWorkspace(workspacePath) {
    if (!fs2.existsSync(workspacePath)) {
      throw new Error(`Workspace path does not exist: ${workspacePath}`);
    }
    const stats = fs2.statSync(workspacePath);
    if (!stats.isDirectory()) {
      throw new Error(`Workspace path must be a directory: ${workspacePath}`);
    }
    const configPath = path2.join(workspacePath, WORKSPACE_CONFIG_FILE);
    const configFolder = path2.join(workspacePath, WORKSPACE_FOLDER);
    if (!fs2.existsSync(configFolder)) {
      fs2.mkdirSync(configFolder, { recursive: true });
    }
    let config;
    if (fs2.existsSync(configPath)) {
      config = JSON.parse(fs2.readFileSync(configPath, "utf-8"));
      config.lastOpenedAt = (/* @__PURE__ */ new Date()).toISOString();
    } else {
      config = {
        name: path2.basename(workspacePath),
        path: workspacePath,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        lastOpenedAt: (/* @__PURE__ */ new Date()).toISOString(),
        settings: {}
      };
      this.initializeWorkspaceStructure(workspacePath);
    }
    fs2.writeFileSync(configPath, JSON.stringify(config, null, 2));
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
    const isObsidian = fs2.existsSync(path2.join(workspacePath, ".obsidian")) || fs2.existsSync(path2.join(workspacePath, "00 Home.md")) || fs2.existsSync(path2.join(workspacePath, "08 Sidebrain"));
    if (isObsidian) {
      console.log("[WorkspaceEngine] Obsidian/kerja vault \u2014 skip WG folder scaffold");
      return;
    }
    for (const folder of STANDARD_FOLDERS) {
      const folderPath = path2.join(workspacePath, folder);
      if (!fs2.existsSync(folderPath)) {
        fs2.mkdirSync(folderPath, { recursive: true });
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
    const workspacePath = path2.join(parentPath, name);
    if (fs2.existsSync(workspacePath)) {
      throw new Error(`Directory already exists: ${workspacePath}`);
    }
    fs2.mkdirSync(workspacePath, { recursive: true });
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
    return this.recentWorkspaces.filter((p) => fs2.existsSync(p));
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
    return fs2.readFileSync(filePath, "utf-8");
  }
  writeFile(filePath, content) {
    const dir = path2.dirname(filePath);
    if (!fs2.existsSync(dir)) {
      fs2.mkdirSync(dir, { recursive: true });
    }
    fs2.writeFileSync(filePath, content, "utf-8");
  }
  deleteFile(filePath) {
    if (fs2.existsSync(filePath)) {
      const stats = fs2.statSync(filePath);
      if (stats.isDirectory()) {
        fs2.rmSync(filePath, { recursive: true });
      } else {
        fs2.unlinkSync(filePath);
      }
    }
  }
  createFile(filePath, content = "") {
    const dir = path2.dirname(filePath);
    if (!fs2.existsSync(dir)) {
      fs2.mkdirSync(dir, { recursive: true });
    }
    if (!fs2.existsSync(filePath)) {
      fs2.writeFileSync(filePath, content, "utf-8");
    }
  }
  createFolder(folderPath) {
    if (!fs2.existsSync(folderPath)) {
      fs2.mkdirSync(folderPath, { recursive: true });
    }
  }
  renameFile(oldPath, newPath) {
    fs2.renameSync(oldPath, newPath);
  }
  getSettingsPath() {
    return path2.join(this.configDir, "settings.json");
  }
  getSettings() {
    const settingsPath = this.getSettingsPath();
    try {
      if (fs2.existsSync(settingsPath)) {
        const { revealSettingsSecrets: revealSettingsSecrets2 } = (init_SecretsStore(), __toCommonJS(SecretsStore_exports));
        const raw = JSON.parse(fs2.readFileSync(settingsPath, "utf-8"));
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
      if (fs2.existsSync(settingsPath)) {
        return JSON.parse(fs2.readFileSync(settingsPath, "utf-8"));
      }
    } catch {
    }
    return {};
  }
  saveSettings(settings) {
    if (!fs2.existsSync(this.configDir)) {
      fs2.mkdirSync(this.configDir, { recursive: true });
    }
    const settingsPath = this.getSettingsPath();
    const { protectSettingsSecrets: protectSettingsSecrets2 } = (init_SecretsStore(), __toCommonJS(SecretsStore_exports));
    const protectedSettings = protectSettingsSecrets2(settings);
    const json = JSON.stringify(protectedSettings, null, 2);
    const tmp = settingsPath + ".tmp";
    fs2.writeFileSync(tmp, json, "utf-8");
    fs2.renameSync(tmp, settingsPath);
    console.log("[WorkspaceEngine] settings saved \u2192", settingsPath);
    return settingsPath;
  }
};
var workspaceEngine = new WorkspaceEngine();

// src/main/engine/SearchEngine.ts
import Fuse from "fuse.js";

// src/main/engine/IndexDatabase.ts
import fs3 from "fs";
import path3 from "path";
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
      const dir = path3.join(workspaceRoot, ".workspacegraph");
      if (!fs3.existsSync(dir)) fs3.mkdirSync(dir, { recursive: true });
      this.dbPath = path3.join(dir, "index.db");
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

// src/main/engine/GraphEngine.ts
import path4 from "path";
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
    const baseName = path4.basename(file.path, path4.extname(file.path));
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
        title: path4.basename(file.filePath, path4.extname(file.filePath)),
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
    const displayTitle = parsedFile.title && parsedFile.title.length <= 48 ? parsedFile.title : path4.basename(parsedFile.filePath, path4.extname(parsedFile.filePath));
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

// src/main/engine/MarkdownEngine.ts
import matter from "gray-matter";
import path5 from "path";
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
  return path5.basename(filePath, path5.extname(filePath));
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
    const relativePath = rootPath ? path5.relative(rootPath, filePath).replace(/\\/g, "/") : filePath;
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
      const baseName = path5.basename(filePath, path5.extname(filePath));
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
function listPendingProposals() {
  return Array.from(proposals.values()).filter((p) => p.status === "pending");
}
function rejectProposal(id) {
  const p = proposals.get(id);
  if (!p || p.status !== "pending") return false;
  p.status = "rejected";
  return true;
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
  if (path6.isAbsolute(p)) {
    const normRoot = path6.resolve(root);
    const normP = path6.resolve(p);
    if (!normP.toLowerCase().startsWith(normRoot.toLowerCase())) {
      return null;
    }
    return normP;
  }
  p = p.replace(/^[/\\]+/, "");
  const abs = path6.resolve(root, p);
  if (!abs.toLowerCase().startsWith(path6.resolve(root).toLowerCase())) return null;
  return abs;
}
function resolveNotePath(input) {
  const direct = resolvePath(input);
  if (direct && fs4.existsSync(direct)) return direct;
  if (direct && !fs4.existsSync(direct) && direct.toLowerCase().endsWith(".md")) {
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
  return path6.relative(root, abs).replace(/\\/g, "/");
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
        if (!abs || !fs4.existsSync(abs)) {
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
        if (!abs || !fs4.existsSync(abs)) {
          return { tool, ok: false, error: `Directory not found: ${rel || "/"}` };
        }
        const entries = fs4.readdirSync(abs, { withFileTypes: true });
        const items = entries.filter((e) => !e.name.startsWith(".")).slice(0, 100).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
          path: relativeToVault(path6.join(abs, e.name))
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
        if (fs4.existsSync(abs) && !content.startsWith("---")) {
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
        if (!abs || !fs4.existsSync(abs)) {
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
        if (fs4.existsSync(abs)) {
          return { tool, ok: false, error: `File already exists: ${relativeToVault(abs)}` };
        }
        if (!content.startsWith("---")) {
          const title = path6.basename(abs, ".md") || "Untitled";
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
          workspace: path6.basename(root)
        });
        const folder = String(args.folder || tpl.defaultFolder);
        let fileName = `${title.replace(/[<>:"/\\|?*]/g, "-")}.md`;
        if (tpl.kind === "daily") {
          fileName = `${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}.md`;
        }
        const abs = resolvePath(path6.join(folder, fileName));
        if (!abs) return { tool, ok: false, error: "Invalid path" };
        if (fs4.existsSync(abs)) {
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
function applyProposal(id) {
  const p = proposals.get(id);
  if (!p) return { ok: false, error: "Proposal not found" };
  if (p.status !== "pending") return { ok: false, error: `Proposal already ${p.status}` };
  try {
    const root = workspaceEngine.getState().rootPath;
    if (!root) return { ok: false, error: "No workspace open" };
    const abs = path6.resolve(p.absolutePath);
    if (!abs.toLowerCase().startsWith(path6.resolve(root).toLowerCase())) {
      return { ok: false, error: "Path outside vault rejected" };
    }
    if (p.mode === "create" && fs4.existsSync(abs)) {
      return { ok: false, error: "File already exists" };
    }
    const dir = path6.dirname(abs);
    if (!fs4.existsSync(dir)) fs4.mkdirSync(dir, { recursive: true });
    workspaceEngine.writeFile(abs, p.content);
    p.status = "applied";
    return { ok: true, path: abs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
export {
  TOOLS_SYSTEM_PROMPT,
  applyProposal,
  executeTool,
  formatToolResultsForModel,
  getProposal,
  isReadTool,
  isWriteTool,
  listPendingProposals,
  parseToolActions,
  rejectProposal,
  stripToolActions
};
