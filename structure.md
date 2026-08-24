# WorkspaceGraph — Struktur Komponen & Audit

**Versi:** 1.1.0 · **Stack:** Electron 39 + React 19 + TypeScript 5.9 + Zustand 5 + Vite 7 + CodeMirror 6 + D3 7 + SQLite (better-sqlite3) + Xenova Transformers

---

## 1. Arsitektur Keseluruhan

| Layer | Teknologi | Fungsi |
|---|---|---|
| **App Shell** | Electron 39 (main process) | Window, IPC, CSP, lifecycle |
| **UI** | React 19 + Zustand 5 + Vite 7 | Komponen view, store, routing |
| **Preload** | `contextBridge` | API aman renderer ↔ main |
| **Engines** | TS classes (singleton) | Workspace, Graph, Markdown, Search, dll |
| **AI** | Gemini/Claude/OpenAI/Ollama/OpenRouter/Grok | RAG, streaming, agent tools, failover |
| **Search** | SQLite FTS5 + Fuse.js + all-MiniLM-L6-v2 (ONNX) | Hybrid keyword + semantic |
| **Graph** | D3-force + Canvas 2D + SVG | Force-directed knowledge graph |
| **Editor** | CodeMirror 6 (`@uiw/react-codemirror`) | Markdown live preview + source |
| **Security** | `safeStorage` + `vm` sandbox + path confinement | Enkripsi API key, plugin sandbox |

---

## 2. Struktur Direktori

```
WorkspaceGraph/
├── src/
│   ├── main/                    # Electron main process
│   │   ├── index.ts             # Entry point: bootstrap + createWindow + CSP
│   │   ├── processSafety.ts     # unhandledRejection/uncaughtException net
│   │   ├── ai/                  # AI layer
│   │   │   ├── AIMiddleware.ts  # Orkestrator: stream, failover, tool loop, cost
│   │   │   ├── AgentTools.ts    # Definisi + eksekutor tool (wg-action fences)
│   │   │   ├── EmbeddingEngine.ts  # Vector search (ONNX worker)
│   │   │   ├── ContextEngine.ts    # RAG builder (7 tier context)
│   │   │   ├── PromptRegistry.ts   # Prompt versioned, vault-editable
│   │   │   ├── WorkspaceMemory.ts  # AI Memory scaffold
│   │   │   ├── ConversationStore.ts / CheckpointStore.ts / AIEventLog.ts
│   │   │   ├── autoIngest.ts / CitationVerifier.ts / cost.ts
│   │   │   ├── contextCompaction.ts / providerFailover.ts
│   │   │   ├── providerRegistry.ts
│   │   │   └── providers/       # BaseProvider + 7 implementasi + discovery/retry
│   │   ├── api/                 # InternalAPI.ts (facade untuk plugin/health)
│   │   ├── engine/              # Core engines
│   │   │   ├── WorkspaceEngine.ts / GraphEngine.ts / MarkdownEngine.ts
│   │   │   ├── SearchEngine.ts / IndexDatabase.ts / FileWatcher.ts
│   │   │   ├── GraphLayoutStore.ts / TemplateEngine.ts / DomainEngine.ts
│   │   │   ├── AutomationEngine.ts / markdownCode.ts
│   │   │   └── *.test.ts        # Unit test engine
│   │   ├── ipc/
│   │   │   ├── index.ts         # registerIPCHandlers() — registrasi semua domain
│   │   │   ├── shared.ts        # requireOpenVault, syncWorkspaceData, fileWatcher
│   │   │   └── handlers/        # 13 domain handler
│   │   │       ├── workspace / files / graph / search / ai / chat
│   │   │       ├── checkpoint / templates / domain / automation
│   │   │       ├── plugins / mcp / settings
│   │   ├── mcp/                 # McpClientManager.ts (stdio + HTTP)
│   │   ├── plugin/              # PluginHost + sandbox (vm) + jsRunner + worker
│   │   ├── qa/                  # Test harness e2e/stress/robustness
│   │   ├── security/            # PathSandbox / Permissions / SecretsStore
│   │   ├── utils/               # quarantine.ts (atomicWriteJson)
│   │   ├── workers/             # worker-pool + embedding.worker + search-index.worker
│   │   └── test/                # Test helpers
│   ├── preload/
│   │   ├── index.ts             # contextBridge → window.api (typed)
│   │   └── index.d.ts           # Interface API (593 baris)
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.tsx         # React root + ErrorBoundary + theme pre-paint
│           ├── App.tsx          # AppShell + Toaster + DialogHost
│           ├── components/
│           │   ├── layout/      # AppShell, Sidebar, StatusBar, ViewKeepAlive
│           │   ├── welcome/     # WelcomeScreen
│           │   ├── dashboard/   # DashboardView
│           │   ├── editor/      # MarkdownEditor, MarkdownPreview, BacklinksPanel, MergeDialog
│           │   ├── graph/       # GraphCanvas, GraphFiltersPanel + modul d3/canvas/svg
│           │   ├── chat/        # ChatPanel + helpers (modelPicker, followUp, tokenBudget…)
│           │   ├── search/      # SearchModal
│           │   ├── settings/    # SettingsView + confirm helpers
│           │   ├── systems/     # TemplatePicker
│           │   └── ui/          # CommandPalette, Dialog, Toast, ErrorBoundary, Icons
│           ├── hooks/           # usePanelWidth
│           ├── store/           # workspaceStore, editorStore, graphStore, chatStore
│           ├── styles/          # globals.css, tokens.css
│           └── utils/           # theme, proposalDiff
├── docs/                        # Dokumentasi + screenshots
├── perf-harness/                # Benchmark performa
├── scripts/                     # check-crlf.mjs dll
├── test-fixtures/               # Fixture vault untuk test
├── resources/ build/            # Aset aplikasi
├── 00_Constitution.md … 35_Roadmap.md   # Spesifikasi (36 dokumen)
├── electron.vite.config.ts      # electron-vite config
├── vitest.config.ts             # Vitest config
└── electron-builder.yml         # Packager config
```

---

## 3. Pohon Komponen React (Renderer)

```
main.tsx
└─ ErrorBoundary (root)
   └─ App
      ├─ Toaster
      │  └─ ToastEntry ×N
      ├─ DialogHost
      │  └─ DialogView (confirm/alert/prompt)
      └─ AppShell ─────────────────────────────────────────────────── (layout hub)
         ├─ header.app-titlebar
         │  ├─ Brand (logo + nama vault)
         │  └─ Actions (Sidebar toggle, AI toggle, Split, Palette)
         ├─ body
         │  ├─ Sidebar (showSidebar === true)
         │  │  ├─ NavGroup "Utama" → Dashboard | Editor | Graph
         │  │  ├─ NavGroup "Alat" → Cari (Ctrl+K) | Palette (Ctrl+P)
         │  │  ├─ FileTree (recursive FileTreeItemNode)
         │  │  │  └─ FileTreeItemNode (memoized, recursive)
         │  │  ├─ NavGroup "Sistem" → Pengaturan
         │  │  └─ Context Menu (new/rename/delete/restore)
         │  ├─ main-content
         │  │  ├─ [no vault] → WelcomeScreen
         │  │  │  ├─ Buka Vault card
         │  │  │  ├─ Buat Vault card
         │  │  │  └─ Recent Workspaces list
         │  │  ├─ ViewKeepAlive(dashboard) → DashboardView
         │  │  │  ├─ Metric cards (Catatan/Proyek/Tugas/Orang/Checklist/Orphan/Graph/File)
         │  │  │  ├─ SemanticRagCard
         │  │  │  ├─ AiUsageCard
         │  │  │  ├─ SectionHead ×6 | SkeletonRows | EmptyState
         │  │  │  └─ TemplatePicker
         │  │  ├─ ViewKeepAlive(editor) → .split-view
         │  │  │  ├─ ErrorBoundary → MarkdownEditor
         │  │  │  │  ├─ Tab strip (dirty dots, close)
         │  │  │  │  ├─ Toolbar (breadcrumb, Live/Source, format menu)
         │  │  │  │  ├─ CodeMirror (@uiw/react-codemirror + livePreviewExtension)
         │  │  │  │  ├─ BacklinksPanel (inspektor)
         │  │  │  │  └─ MergeDialog (conflict/proposal, portaled)
         │  │  │  └─ ErrorBoundary → GraphCanvas (split mode, embedded)
         │  │  │     ├─ GraphFiltersPanel
         │  │  │     ├─ SVG: SvgEdgeItem · SvgNodeItem · SvgLabelItem
         │  │  │     ├─ Canvas 2D (interactive gestures)
         │  │  │     ├─ PerfSparkChart
         │  │  │     └─ Context Menu (Open/Copy/Pin/Delete)
         │  │  ├─ ViewKeepAlive(graph) → ErrorBoundary → GraphCanvas (full)
         │  │  │  └─ (sama seperti di atas, embedded=false)
         │  │  └─ ViewKeepAlive(settings) → SettingsView
         │  │     ├─ Nav: AI Providers | Search | Security | Automation
         │  │     │      | Plugins | MCP | Appearance | Activity | About
         │  │     ├─ Provider cards (Test/Set default/Refresh/Hapus)
         │  │     ├─ Failover drag-reorder
         │  │     ├─ Security toggles (aiAccess/aiTools/automation/plugins)
         │  │     ├─ Automation rules + logs
         │  │     ├─ Plugin list + commands + permission reset
         │  │     ├─ MCP server cards + add/test
         │  │     ├─ Theme picker (light/dark/system)
         │  │     └─ AI Event log (CSV export, filter, retention)
         │  ├─ ChatPanel (showAIChat === true)
         │  │  ├─ Toolbar (title, status, context chip, New/⋮/Close)
         │  │  ├─ Session sidebar (current + saved history)
         │  │  ├─ Write Proposal dock (inline diff, Apply/Tolak)
         │  │  ├─ Message list
         │  │  │  ├─ ChatMessageBody (dengan citations, images)
         │  │  │  ├─ ReasoningBlock (streaming reasoning)
         │  │  │  ├─ ToolRunList (agent tool calls)
         │  │  │  └─ Per-message actions (Copy/Retry/Regenerate/Follow-up)
         │  │  ├─ Token budget bar
         │  │  ├─ Composer (textarea + slash commands + image attachments)
         │  │  ├─ Portaled: ModelPicker · SlashPicker · ⋮ menu · CiteTooltip
         │  │  └─ MergeDialog (proposal diff, portaled)
         │  └─ StatusBar
         │     └─ EmbeddingBadge (indexing progress)
         │
         ├─ SearchModal (floating, Ctrl+K)
         ├─ TemplatePicker (floating, Ctrl+Shift+N)
         ├─ CommandPalette (floating, Ctrl+P / Ctrl+Shift+?)
         └─ Toaster (redundan — juga di App level)
```

**Leaf komponen yang dipakai di mana-mana:** `Icon` (Material Symbols), `ErrorBoundary`, `toast/confirmDialog/alertDialog/promptDialog`.

---

## 4. Zustand Stores

| Store | State Utama | Actions Kunci |
|---|---|---|
| **workspaceStore** | `isOpen`, `rootPath`, `files: FileItem[]`, `activeView` ('dashboard'/'editor'/'graph'/'settings'/'welcome'), `showSidebar`, `showAIChat`, `recentWorkspaces`, `lastError` | `openWorkspace`, `closeWorkspace` (flush editor + reset chat), `fetchState`, `setActiveView`, `toggleSidebar/AIChat`, `fetchRecentWorkspaces` |
| **editorStore** | `tabs: TabItem[]`, `activeTabId`, `surfaceMode` ('live'/'source'), `showInspector`, `backlinks`, `outgoing`, `mergeDialog` | `openTab` (serialized chain), `closeTab`, `updateContent`, `saveTab` (700ms debounce), `flushSave`, `setSurfaceMode`, `refreshLinks`, `refreshPreview`, `open/close/resolveMergeDialog` |
| **graphStore** | `nodes`, `edges`, `focusedNodeId`, `filterType`, `filterTag`, `openIntent`, `layoutNodes` (x,y,pinned), `layoutCamera`, `graphSettings`, `orphanIds`, `hubIds`, `savedViews` | `fetchGraph` (skeleton→fallback data), `fetchGraphMeta` (parallel orphans/settings/layout/views/hubs), `findPath`, `fetchNeighborhood`, `saveLayoutPositions`, `saveGraphCamera`, `updateGraphSettings`, `save/deleteGraphView`, `setFocusedNode`, `consumeOpenIntent` |
| **chatStore** | `messages[]` (citations/verifications/proposals/images/toolRuns/cost), `providers`, `activeProviderId`, `selectedModelId` ('auto'), `agentRole`, `isGenerating`, `useContext`, `enableTools`, `planMode`, `pendingProposals`, `conversationId`, `activeStreamId`, `followUpMessageId` | `fetchProviders`, `setActiveProvider`, `sendMessage`, `cancelStream`, `resumeStream`, `clearHistory`, `refreshProposals`, `apply/rejectProposal`, `promoteAnswer`, `save/load/switch/deleteChat`, `retryLastMessage`, `rephraseMessage`, `learnWorkspace` |

---

## 5. State Flow & Event Bridge

```
[UI Event / Shortcut]
      │  window.dispatchEvent('wg:*')  ← bridge antar komponen
      ▼
[React Component]  →  [Zustand Store Action]  →  [window.api.* (IPC invoke)]
                                                          │
                                                          ▼
                                            [IPC Handler + PathSandbox + Permissions]
                                                          │
                                                          ├─ Engine (GraphEngine, dll)
                                                          └─ webContents.send (push)
                                                          │
                                                          ▼
                                            [Store update → React re-render]
```

**Custom DOM events (`wg:*`):** `wg:open-search`, `wg:open-palette`, `wg:open-template`, `wg:new-note`, `wg:new-daily`, `wg:toggle-split`, `wg:graph-command`.

**Shortcut global (Ctrl/⌘):** `K` search · `P` palette · `Shift+?` shortcuts · `B` sidebar · `J` AI chat · `N` new note · `Shift+N` template · `Shift+D` daily · `S` save · `E` editor.

---

## 6. IPC Channel Catalog (80+ channel)

| Domain | Channel |
|---|---|
| **Workspace** | `dialog:openFolder`, `workspace:open/create/close/getState/getRecent` |
| **Files** | `file:read/write/delete/restore/emptyTrash/create/createFolder/rename/openExternal`, `markdown:render` |
| **Graph** | `graph:getData/getSkeleton/getNeighbors/getPath/getNeighborhood/getLocal/getOrphans/getHubs/getLayout/saveLayout/getSettings/saveSettings/savePng/listViews/saveView/deleteView/filterByType/filterByTag/getBacklinks/getOutgoing/resolveLink` |
| **Search** | `search:query/recentNotes/byTag/getTags/getStats/rebuildIndex` |
| **AI** | `ai:embeddingStatus/getProviderConfigs/saveProviderConfigs/setProviderDefaultModel/resetProviderConfigs/getProviders/testProvider/refreshProviderModels/importGrokCli/configure/setActiveProvider/sendMessage/streamMessage/cancelStream/streamPipeline/applyProposal/rejectProposal/listProposals/promoteKnowledge/getProposal/ensureMemory/listMemory/listAIEvents/getAIEventStats/clearAIEvents/exportAIEventsCSV` |
| **Chat** | `chat:save/list/load/delete/newId` |
| **Checkpoint** | `checkpoint:save/list/load/delete` |
| **Template** | `template:list/render/createNote/seed` |
| **Domain** | `domain:overview/list` |
| **Automation** | `automation:get/save/setEnabled/runRule` |
| **Plugin** | `plugins:list/commands/reload/runCommand/revoke`, `api:health`, `security:status` |
| **MCP** | `mcp:getServers/saveServers/testServer/getTools` |
| **Settings** | `settings:get` (scrubbed) / `settings:save` (secret-preserving) |
| **Window** | `window:setTitleBarTheme` |

**Push events (webContents.send):** `workspace:updated`, `graph:updated`, `embedding:progress`, `ai:providerStatus`, `ai:stream:<requestId>`, `plugin:notify`.

---

## 7. Engine Layer (Main)

| Engine | Tanggung Jawab |
|---|---|
| **WorkspaceEngine** | Vault lifecycle (open/create/close), file CRUD, settings (atomic, secret-protected, versioned), rename + wiki-link rewrite vault-wide, deteksi Obsidian vault |
| **GraphEngine** | Grafik in-memory (nodes: note/ghost/tag/attachment; edges: wiki_link/tag/star), shortest path, orphan/hub, backlink, resolveTitleToPath (basename unik/path suffix/alias) |
| **MarkdownEngine** | Parser (frontmatter, wikiLinks, tags, headings) + pure-TS HTML renderer (GFM tables, task list, code fence § protection) |
| **SearchEngine** | Hybrid: SQLite FTS5 + Fuse.js (worker) + semantic blend, debounced delta index (WB-2) |
| **EmbeddingEngine** | all-MiniLM-L6-v2 (ONNX), worker-backed, vektor BLOB di SQLite, progress callback |
| **ContextEngine** | RAG 7-tier: active note → wikilink neighbors → backlinks → AI Memory → Rules/SOP → FTS → semantic; role-based token budget |
| **IndexDatabase** | SQLite WAL, FTS5 triggers, table `note_tags` + `embedding_chunks`, corrupt-file recovery |
| **FileWatcher** | Chokidar, ignore dotfiles/node_modules/index.db, self-write echo suppression |
| **GraphLayoutStore** | Layout/camera/settings/views persistence (graph-layout.json, graph-views.json) |
| **TemplateEngine** | 8 template kind (knowledge/project/task/people/daily/sop/document/meeting), `{{var}}` substitution, per-workspace scan cache |
| **DomainEngine** | Overview Proyek/Tugas/Orang, checkbox parsing |
| **AutomationEngine** | Rule deklaratif (file_created/updated/deleted, workspace_opened, manual, schedule), 60s scheduler tick |
| **PluginHost** | Plugin deklaratif + JS, sandbox vm, whitelist permission |
| **McpClientManager** | MCP client stdio + streamable HTTP, 60s timeout, read/write permission per role |

---

## 8. Keamanan

| Aspek | Implementasi |
|---|---|
| **API Keys** | `safeStorage` encrypt (`enc:v1:` prefix) → scrub di renderer → hanya `apiKeySet` |
| **Path confinement** | `assertPathInVault` + `reverifyPathInVault` (realpath symlink-safe, TOCTOU-safe) |
| **Plugin sandbox** | `vm` tanpa require/process/Buffer/fetch; worker per invocation; write ops → dialog gate |
| **Permissions** | `aiAccess`/`aiTools`/`automation`/`plugins` — automation & plugins default OFF (ADR-0003) |
| **CSP** | `default-src 'self'`, `connect-src https:` + localhost, `worker-src 'self' blob:`, Google Fonts allowlist |
| **Main-process safety** | `processSafety.ts`, size caps (write ≤5MB, render ≤500KB), debounce emit, stream watchdog 200s |

---

## 9. RAG Pipeline

```
User query
    │
    ├─► Active note (prioritas tertinggi)
    ├─► WikiLink neighbors (graph traversal)
    ├─► Backlinks
    ├─► AI Memory notes (long-term workspace knowledge)
    ├─► Semantic search (vector similarity — all-MiniLM-L6-v2)
    └─► FTS keyword search (SQLite FTS5)
            │
            ▼
    Context package → AI Provider → Streaming response
```

**Agent loop:** stream → tool calls (search/read/write/plan/subagent) → proposals (approve/reject UI) → maks 4 round → cost estimation → AI event log → auto-ingest ke AI Memory.

---

## 10. Statistik

| Metrik | Nilai |
|---|---|
| Total tests | 1000+ passed |
| IPC channels | 80+ |
| AI providers | 6 + OpenAI-compat adapter |
| Komponen React | ~30 utama |
| Zustand stores | 4 |
| Engine/service | 18 |
| Worker threads | 2 (embedding, search-index) + 1 per plugin call |
| Dokumen spesifikasi | 36 (00–35) |

---

## 11. Kritik & Saran Mendalam

### 11.1 Arsitektur & Code Smell

| # | Temuan | Tingkat | Saran |
|---|---|---|---|
| C1 | **God components** — `GraphCanvas.tsx` (5.120 baris), `SettingsView.tsx` (2.531), `ChatPanel.tsx` (1.952) | 🔴 Tinggi | Pecah per tanggung jawab. Contoh: GraphCanvas → `GraphCanvas` (orchestrasi) + `GraphStage` (d3) + `GraphSvgLayer` + `GraphInteraction` + `GraphToolbar`. Pola hook `useGraphSimulation`/`useGraphInteraction`. God component = sulit di-test, sulit di-review, rawan merge conflict. |
| C2 | **Singleton di mana-mana** — seluruh engine (`workspaceEngine`, `graphEngine`, `markdownEngine`, …) adalah singleton global dengan state mutable | 🟠 Sedang | Membuat pengujian paralel rapuh & menghalangi multi-vault/multi-window di masa depan. Pertimbangkan factory (mis. `createWorkspaceEngine()`) yang di-inject, atau repository pattern agar state testable via dependency injection. |
| C3 | **Toaster & DialogHost di-render dua kali** — di `App.tsx` dan lagi di `AppShell.tsx` | 🟢 Rendah | Hapus salah satu. Duplikasi mount berarti dua host toast (entry ganda, z-index ambiguity). |
| C4 | **Dead code `MarkdownPreview`** — hanya dipakai untuk `headingSlug` oleh BacklinksPanel; mode split sudah tidak merender komponen ini | 🟠 Sedang | Pilih salah satu: aktifkan kembali sebagai reading-pane di editor (sesuai spesifikasi `24_UX_Flow`) atau hapus + pindahkan `headingSlug` ke util. Code yang tidak ter-render = spesifikasi vs kode sudah drift. |

### 11.2 State Management

| # | Temuan | Tingkat | Saran |
|---|---|---|---|
| C5 | **Circular dependency antar store** — `workspaceStore.closeWorkspace` pakai `import()` dinamis untuk memanggil `editorStore`/`chatStore` | 🟠 Sedang | `import()` dinamis adalah "tambalan" circular import. Pisahkan orkestrasi: buat `sessionService` (modul netral) yang memegang urutan flush/reset lintas store, sehingga store tetap acyclic dan bisa di-render dalam urutan apa pun. |
| C6 | **Tidak ada session/tab restore** — `tabs` editorStore murni in-memory; restart app = semua tab hilang | 🟠 Sedang | Obsidian/VS Code restore tab. Simpan `openTabs[]` (path + activeTabId + surfaceMode) ke `.workspacegraph/ui-state.json` via IPC `settings` atau channel baru; restore saat `openVaultFlow`. |
| C7 | **`chatStore.sendMessage` sangat monolitik** — bercampur stream management, history windowing, checkpoint, dan proposal | 🟠 Sedang | Ekstrak `streamRuntime` (status mesin state), `historyWindow`, `checkpointWriter` sebagai unit terpisah yang bisa di-test tanpa mock IPC. |
| C8 | **Tanpa middleware Zustand** — tidak ada `devtools`/`persist`/`logger` | 🟢 Rendah | Tambahkan `zustand/middleware devtools` (production-safe) untuk debugging; `persist` terbatas untuk UI-pref saja (graphStore sudah via IPC — konsistenkan). |

### 11.3 Backend / Engines

| # | Temuan | Tingkat | Saran |
|---|---|---|---|
| C9 | **Kontrak IPC tidak ter-generate** — `index.d.ts` (593 baris) ditulis manual; 80+ channel berisiko drift dari handler | 🔴 Tinggi | Bangun satu sumber kebenaran: tipe request/response di file shared (`src/shared/ipc.ts`) yang diimpor BOTH main handler & preload. Gunakan skrip `typecheck` + lint untuk memastikan tidak ada drift. Ini adalah proteksi terbesar terhadap bug tak terduga. |
| C10 | **Quit tidak flush editor buffer** — `window-all-closed → app.quit()` tanpa drain `flushSave`; penutupan cepat bisa kehilangan perubahan 700ms-debounce | 🔴 Tinggi | Di main: hook `before-quit`/`will-quit` → kirim `ui:flush-before-quit` (invoke dengan timeout), tunggu semua tab flush selesai, baru quit. Juga pertimbangkan autosave interval (30s) sebagai jaring pengaman. |
| C11 | **Embedding reindex per file-change** — tiap event chokidar memicu reindex embedding file itu (ditambah Fuse delta debounce) | 🟠 Sedang | Batch/queue embedding jobs (mis. flush tiap 5s / idle), throttle saat banyak file berubah (git checkout, folder copy). Prioritaskan: file yang terlihat (open tab) > tersembunyi. |
| C12 | **Automation scheduler 60s tick polling** — untuk trigger `schedule` | 🟢 Rendah | Ganti polling dengan `setTimeout` bertingkat ke next fire time; hemat resource dan lebih akurat. |
| C13 | **SearchEngine & EmbeddingEngine dua indeks terpisah** | 🟠 Sedang | Sudah ada `note_tags` normalisasi — pertahankan satu `IndexDatabase` sebagai source of truth metadata; pastikan rebuild dua-phase (drop-then-rebuild) atomic agar tidak ada window FTS hidup + embedding kosong. |
| C14 | **`ai:stream:<requestId>` channel dinamis per request** — watchdog 200s membersihkan listener | 🟢 Rendah | Sudah bagus. Pertahankan; tambahkan heartbeat streaming agar request yang hang (bukan 200s) tetap terdeteksi. |

### 11.4 Frontend / Performa

| # | Temuan | Tingkat | Saran |
|---|---|---|---|
| C15 | **Selective subscribe manual di AppShell** — hanya `openTab`/`flushSave`/`activeTabId` yang di-selector | 🟢 Rendah | Bagus (hindari re-render per keystroke). Standarkan pola ini ke komponen besar lain (Sidebar sudah). Konsistensikan: DashboardView/StatusBar subscribe penuh → bisa re-render berat. |
| C16 | **CodeMirror size-gating** (24k chars / 600 lines highlight; 80k/2000 preview) | 🟢 Rendah | Bagus. Pertahankan; tambahkan indikator "file terlalu besar — highlighting dinonaktifkan" agar user tidak bingung. |
| C17 | **UI language hardcoded Indonesia** di tooltip/label, campur dengan English | 🟠 Sedang | Tanpa i18n, pasar non-ID terhalang. Minimal: pisahkan semua string ke `locales/id.ts` + `locales/en.ts` + `useT()`; default `id`. |
| C18 | **Loading/skeleton untuk fetch state di semua view** sudah ada (SkeletonRows/EmptyState) | 🟢 Rendah | Konsisten — pertahankan. Tambahkan skeleton juga di ChatPanel saat loadChat. |

### 11.5 Keamanan

| # | Temuan | Tingkat | Saran |
|---|---|---|---|
| C19 | **`sandbox: false` + `'unsafe-eval'` di CSP (dev)** | 🟠 Sedang | `sandbox:false` dibutuhkan preload `contextBridge` biasa — tapi sudah benar `contextIsolation` tidak dimatikan. Verifikasi `nodeIntegration:false` eksplisit. Untuk production, coba hilangkan `'unsafe-eval'` (React refresh hanya di dev; bisa dipisah via env). |
| C20 | **Google Fonts allowlist** di CSP | 🟢 Rendah | Pertimbangkan self-host font penuh agar benar-benar offline (README mengklaim "local-first"; fonts.googleapis.com adalah pengecualian yang wajar tapi catat di 33_Security). |
| C21 | **Plugin sandbox sudah kuat** (vm + worker + dialog gate) | 🟢 Rendah | Pertahankan. Tambahkan test injection: plugin mencoba `process`, `fetch`, `require`, path escape — pastikan semua blocked (sekarang hanya `jsRunner.test.ts`). |

### 11.6 Testing & Kualitas

| # | Temuan | Tingkat | Saran |
|---|---|---|---|
| C22 | **1000+ test tapi komponen raksasa tidak di-cover** — GraphCanvas/SettingsView/ChatPanel/AppShell hampir tanpa React test; hanya modul util yang di-test | 🔴 Tinggi | Ini gap terbesar. Pecah god component dulu (C1) lalu tulis test per subkomponen (rendering, interaksi, state). Prioritas: graphStore action flow + ChatPanel stream state machine + AppShell routing/shortcuts. |
| C23 | **E2E hanya di main (qa/)** — tidak ada Playwright/webdriver test untuk renderer | 🟠 Sedang | Tambahkan `@playwright/test` E2E: buka vault fixture, buat note, link wiki, render graph, kirim chat (mock provider). Ini menangkap regression yang tak terlihat unit test. |
| C24 | **Dokumen spesifikasi (36 dokumen) vs kode drift** — e.g. MarkdownPreview | 🟠 Sedang | Tambahkan check CI `scripts/check-docs-drift.mjs` atau ADR bahwa setiap perubahan di engine harus update dokumen terkait (link di commit). |
| C25 | **Coverage gate** di CI | 🟢 Rendah | README bilang "with coverage" — pastikan threshold (`lines >= 70%`) diekspor di vitest config supaya regresi coverage menolak build. |

### 11.7 Produk / UX

| # | Temuan | Tingkat | Saran |
|---|---|---|---|
| C26 | **Tanpa sistem plugin UI** — plugin hanya command-based | 🟠 Sedang | Sesuai 28_Plugin_SDK; pertimbangkan minimal plugin view slots (mirip Obsidian) — tapi hanya jika roadmap membutuhkan. |
| C27 | **Notifikasi embedding progress bagus** (badge StatusBar) | 🟢 Rendah | Tambahkan tooltip detail (jumlah chunk, ETA) dan auto-hide saat idle. |
| C28 | **Checkpoint/resume AI sudah kuat** | 🟢 Rendah | Pertahankan; expose di UI sebagai "Lanjutkan sesi" yang jelas (sudah ada per-message action). |
| C29 | **Auto-ingest AI Memory** tanpa kontrol user langsung | 🟠 Sedang | Beri toggle di Settings (sudah ada automation/aiAccess permission) — pastikan user bisa matikan jika AI menulis terlalu banyak. |

---

### 11.8 Prioritas Rekomendasi (Roadmap Singkat)

| Prioritas | Item | Alasan |
|---|---|---|
| 🔴 P0 | C9 (typed shared IPC contract) + C10 (flush before quit) | Mencegah kehilangan data & bug drift kontrak |
| 🔴 P0 | C1 (pecah god components) + C22 (test subkomponen) | Maintenability + jaring pengaman paling lemah saat ini |
| 🟠 P1 | C5 (decouple cross-store) + C6 (tab restore) | Stabilitas session & UX |
| 🟠 P1 | C2 (DI untuk engine) + C17 (i18n) | Testability & pasar |
| 🟠 P1 | C11 (batch embedding) + C12 (scheduler event-based) | Skalabilitas vault besar |
| 🟢 P2 | C3 (hapus duplikat toast), C4 (MarkdownPreview), C8 (devtools middleware), C23 (E2E renderer), C25 (coverage gate) | Polishing & kualitas |
