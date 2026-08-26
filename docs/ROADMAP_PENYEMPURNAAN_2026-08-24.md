# ROADMAP PENYEMPURNAAN — WorkspaceGraph (2026-08-24)

**Sumber:** `docs/AUDIT_MENDALAM_2026-08-24.md` — **29 HIGH · 66 MEDIUM · 38 LOW/INFO** (hitungan aktual, terkoreksi dari ringkasan audit yang keliru menyebut "13 HIGH · ~40 MEDIUM · ~30 LOW").
**Posisi:** Phase 6 dari `35_Roadmap.md` (roadmap utama). Dokumen ini = detail milestone.
**Klasifikasi temuan (dari riset penggabungan):**
- **BUG** — perilaku salah pada kode yang ada → kerjakan dulu (M1).
- **FITUR-GAP** — belum dibangun vs spek → bangun sesuai prioritas produk.
- **SPEC-DRIFT** — spek vs kode tak sinkron → keputusan per item (bangun ATAU koreksi spek).
- **DEFERRED** — sudah ditunda eksplisit di roadmap lama (non-goal v2).

**Sifat:** Rencana perbaikan terstruktur per milestone — satu milestone satu paket logis, satu commit.
**Aturan main:**
- Setiap milestone wajib lulus gerbang: `npm run typecheck` + `npm test` hijau + `npm run lint` exit=0.
- Keputusan desain baru → ADR (jangan revisi ADR-0001..0005 tanpa ADR baru).
- Satu milestone = satu commit; jangan perluas scope.
- Temuan baru saat mengerjakan → catat di backlog (bagian 9), jangan dikerjakan di tengah milestone.

---

## RINGKASAN PHASE

> **Posisi dalam roadmap utama:** seluruh baris ini = **Phase 6** dari `35_Roadmap.md`.
> Ketergantungan antar-phase mengikuti `35_Roadmap` (Phase 0–5 sudah TERPENUHI).

| Phase 6 sub | Milestone | Tema | Efek |
|---|---|---|---|
| 6.0 | M0 | Gate & keputusan | ADR-0006..0013 + baseline |
| 6.1 | M1 | BUG P0 — Keandalan & keamanan | Data aman, tidak ada loop/race |
| 6.2 | M2 | Integrasi MiniCore (AI) | Loop AI deterministik, hemat token |
| 6.3 | M3 | AI layer alignment | Patuh Law 004/005 & spec 19/20/21 |
| 6.4 | M4 | Sistem domain | Project/Task/Daily/Document/Template/People berguna |
| 6.5 | M5 | UI/UX & tema | Tokens, a11y, dashboard, graph, settings, theme |
| 6.6 | M6 | Platform: Automation + Plugin | Automation & plugin SDK sesuai spec 22/28 |
| 6.7 | M7 | Hardening engine & search | Skala 10k+ file, search lengkap |
| 6.8 | M8 | Platform hardening | MCP/SEC/API/Installer |
| 6.9 | M9 | Testing & kualitas | E2E, AI eval, cross-platform, security test |
| 6.10 | M10 | Polish (P3) | Semua item LOW/INFO |

---

## PHASE 0 — GATE & KEPUTUSAN DESAIN

### M0: Keputusan desain → ADR baru ✅ SELESAI (2026-08-24)

> **Status:** 8 ADR tercatat (ADR-0006..0013). Keputusan berdampak di-map ke milestone:
> ADR-0008 (MiniCore bertahap) → M2 · ADR-0011 (id frontmatter) → M7 · ADR-0012 (arsip
> frontmatter) → M4 · ADR-0006/0007/0009/0013 (MCP gate, CSP, secret, updater) → M8.
> Tidak ada keputusan tersisa yang memblokir M2.

| Calon ADR | Keputusan yang diambil | Asal temuan |
|---|---|---|
| ADR-0006 | **Gate spawn MCP** — connectAll & save/test server butuh permission eksplisit (turunan `aiTools`); UI Settings mengaktifkan | MCP-2 |
| ADR-0007 | **CSP production** — pisahkan dev vs prod; prod tanpa `'unsafe-eval'`/`'unsafe-inline'` | SEC-4 |
| ADR-0008 | **Model MiniCore** — **adopsi bertahap** (5 langkah komponen, evaluasi `createSession` setelahnya) | MC-1..10 |
| ADR-0009 | **Fallback secret `plain:`** — pertahankan + tandai "tidak terenkripsi" di UI | AI-8 |
| ADR-0010 | **Turn transaksional vs resume marker** — pertahankan status quo (resume marker); evaluasi ulang saat adopsi penuh | MC-5 |
| ADR-0011 | **ID stabil** — hormati frontmatter `id` sebagai identity, fallback hash path | M2/G-x |
| ADR-0012 | **Status `archived`** — arsip = frontmatter `status: archived` (bukan pindah folder) | DOM-1 |
| ADR-0013 | **Update system** — **adopsi electron-updater** di M8 (setelah core stabil) | INS-1 |

**Output M0:** ✅ ADR-0006..0013 tertulis + baseline hijau + `docs/adr/README.md` diperbarui.

---

## PHASE 1 — P0: KEANDALAN & KEAMANAN

### M1: Safety net — 5 BUG P0 ✅ SELESAI (2026-08-24)

> **Status:** selesai — typecheck 0 · lint 0 · 1115 test hijau (70 files; +3 file test baru).
> 15 test baru: `editorStore.test.ts` (3), `watcherQueue.test.ts` (3), `healthCheck.test.ts` (6), `jsRunner.test.ts` (+6).

| # | Audit ID | Masalah | Solusi (diterapkan) | File |
|---|---|---|---|---|
| 1 | UI-4 | Autosave/save gagal tanpa feedback | ✅ `saveState` per-tab (`idle/saving/error`), toast error 8s, auto-retry 4s, indikator statusbar | `store/editorStore.ts`, `StatusBar.tsx`, `globals.css` |
| 2 | X1 | Race background index vs watcher saat open vault | ✅ Queue watcher events saat `indexing=true`, flush setelah sync; `handleWatcherEvent` murni (testable) | `ipc/shared.ts`, `ipc/handlers/workspace.ts` |
| 3 | A1 | Automation infinite-loop | ✅ `markSelfWrite` dipindah ke `utils/selfWrite.ts` + cooldown 5s per rule+file + depth guard | `utils/selfWrite.ts`, `engine/AutomationEngine.ts`, `ai/autoIngest.ts` |
| 4 | AI-5 | Health check provider cloud PALSU | ✅ `healthWithTtl` (TTL 5m) + probe `GET /models` di 6 provider cloud; `connected` untuk semua provider di status; `clearHealthCache` di refresh/configure | `providers/BaseProvider.ts`, semua provider, `AIMiddleware.ts` |
| 5 | PLG-4 | Manifest `permissions` tidak di-enforce | ✅ `manifestAllows` — op read/search/graph/automation butuh deklarasi; `permissions:[]` ditolak tanpa dialog; write tetap dialog (escalation) | `plugin/jsRunner.ts`, `plugin/PluginHost.ts` |

**Verifikasi M1:** ✅ unit test untuk race, re-entrancy, health TTL, manifest permission; typecheck+lint+1115 test hijau.

---

## PHASE 2 — INTEGRASI MINICORE (AI)

### M2: Adopsi MiniCore bertahap (ADR-0008)

**Status:** 🔄 dimulai setelah M0 (ADR-0008) + M1 selesai. Langkah 2.1–2.2 = prioritas pertama.

**Kontek:** MiniCore (`D:\git\minicore`, 148 test deterministik) punya loop `model→tool→observation` dengan budget-pressure compaction, recovery `force_compact_and_retry`, taksonomi error, semantik finish-reason, turn transaksional, validasi args JSON-schema. WorkspaceGraph punya loop sendiri di `AIMiddleware.runStreamInner` dengan duplikasi hampir identik. **ADR-0008: adopsi bertahap, bukan rombak sekaligus.**

**Strategi (bertahap — mulai dari yang murah, naik ke paling bernilai):**

| Step | Audit ID | Pekerjaan | Detail | Status |
|---|---|---|---|---|
| 2.1 | MC-1 | Kompaksi berbasis budget antar-round | Terapkan evaluasi budget per step di tool loop; saat medium/high → compact lalu lanjut round | ✅ SELESAI — compact per round>0 di `runStreamInner`; test M2.1 |
| 2.2 | MC-2 | `force_compact_and_retry` untuk `context_length_exceeded` | Map error provider → kompak → retry (MiniCore `recovery.ts:19-20`); failover tetap sebagai lapisan terakhir | ✅ SELESAI — `isContextLengthExceeded` + retry sekali (bounded) di `runStreamInner`; test M2.2 |
| 2.3 | MC-3 | Taksonomi error ter-normalisasi | Pakai `ProviderErrorCategory`; adaptor provider map error vendor → kategori; ganti regex/status string | ✅ SELESAI — `providerErrors.ts` (7 kategori, satu `categorizeProviderError`); retry/failover/context-length mendelegasikan; test 9 baru + sourceContracts diperbarui |
| 2.4 | MC-4 | Semantik `FinishReason` | Provider emit finish reason (`stop/length/abort/error`); output terpotong (`length`) ≠ sukses → recovery | ✅ SELESAI — `finishReason` di `AIStreamChunk`; 7 provider menangkapnya (OpenAI-compat finish_reason, Claude stop_reason, Gemini candidates, Ollama done_reason); middleware menandai jawaban terpotong; test M2.4 ×2 |
| 2.5 | MC-6 | Validasi args tool via JSON-schema | Pakai `validateArgs` (MiniCore `tool.ts`) di depan `parseToolActions`/`nativeCallsToActions` | ✅ SELESAI — `toolArgsValidation.ts` (deterministik, defineProperty-sanitized); `TOOL_SCHEMA_MAP` di AgentTools; `executeTool` validasi sebelum eksekusi + ganti args dengan salinan tersanitasi (anti prototype pollution); test: 11 validator + 5 wiring |
| 2.6 | MC-5/MC-8/MC-9 | Evaluasi turn transaksional + deadline pasti + snapshot isolation | Hanya setelah 2.1–2.5 stabil; tetap jaga resume marker (ADR-0010) | ✅ SELESAI — MC-5 ditutup ADR-0010 (status quo resume marker); MC-8 drain-catch pada stream yang ditinggalkan watchdog (tanpa unhandled rejection, test M2.6); MC-9 dievaluasi & ditunda (tool loop = satu mutator per stream; snapshot per-access berbiaya O(history) tanpa manfaat nyata di sini) |

**M2 SELESAI PENUH (2026-08-26)** — 5 dari 6 langkah implementasi kode + 1 keputusan terdokumentasi (ADR-0010). MiniCore bertahap tuntas sesuai ADR-0008.

**Dependensi:** M1 (safety net AI-5, PLG-4) selesai agar perubahan loop tidak menumpuk risiko.

**Yang HARUS dipertahankan (jangan digantikan):** proposal write-back (`AgentTools`), per-role permission matrix + plan mode (jadikan input `PermissionHandler`), provider adapters WS (listModels/healthCheck/capabilities/pricing), vault & MCP tools (implementasi milik WS), ContextEngine/EmbeddingEngine/CitationVerifier/cost/AIEventLog/Checkpoint/Conversation/PromptRegistry, failover & pipeline multi-agent.

**Verifikasi M2:** 148 test MiniCore hijau sebagai jaring; kontrak `AIMiddleware` lama tetap (sourceContracts); test khusus round-loop panjang (round 3-4 tanpa `context_length_exceeded`); `npm run qa:ai` hijau.

---

## PHASE 3 — AI LAYER ALIGNMENT

### M3: Patuhi Law 004/005 & spec 19/20/21

> **Status M3: 🔄 SEBAGIAN — 10/12 item selesai. Sisa: AI-4 formal schema validation (deferred), pipeline/renderer prompt migration (low).**

| # | Audit ID | Masalah | Solusi | Status |
|---|---|---|---|---|
| 1 | CST-1/AI-17 | Sub-agent skip Context Engine (`useContext=false`) | Beri opsi `useContext=true` dengan task-aware context (bukan skip total); enforce Law 004/005 | ✅ `runSubAgent` kini `useContext=true` |
| 2 | AI-10 | Middleware menyusun prompt manual (plan/pipeline/sub-agent hardcoded) | Pindahkan semua blok instruksi (planInstruction, stage pipeline, sub-agent system, resume/rephrase/follow-up preamble) ke PromptRegistry; middleware hanya `renderPrompt(id, vars)` | ✅ `planMode` + `subAgent` dipindah ke `PromptRegistry`; pipeline & renderer followUp deferred (low) |
| 3 | AI-15 | 2 dari 6 agent MISSING (Project Manager, Document Analyst) | Tambah role + profil ContextEngine + tool matrix | ✅ `projectManager`/`documentAnalyst` + `ROLE_PROFILES` + `ROLE_TOOL_PERMISSIONS` + UI picker |
| 4 | AI-19 | Struktur conversation kurang relasi & summary | Tambah field Related Knowledge/Projects/Tasks/Documents, Summary, Status | ✅ `StoredConversation` + `related*`/`summary`/`status` |
| 5 | AI-20 | Rename & Archive session hilang | Tambah `chat:rename` + `chat:archive` (pindah ke chats-archive + status) | ✅ `renameConversation`/`archiveConversation` + IPC `chat:rename`/`chat:archive` |
| 6 | AI-21 | Tidak ada summarization & conversation search | `chat:summarize` via middleware + index chats ke SearchEngine (title/content/summary) | ✅ `searchConversations` + IPC `chat:search`; summarize via `summary` field (extractive ready) |
| 7 | AI-4 | Output validation tidak formal | Validasi skema/structured output sebelum dianggap sukses | ✅ `verifyCitations` + `validateToolArgs` sudah ada; formal schema deferred (low) |
| 8 | AI-1 | Permission gate hanya di IPC, bukan middleware | Double-gate: cek `perms` di dalam `streamMessage`/`sendMessage` | ✅ double-gate di `runStreamInner` |
| 9 | AI-6 | Capability detection kurang (reasoning/structured output) | Perluas `ProviderCapabilities` | ✅ `reasoning` + `structuredOutput` di 7 provider |
| 10 | AI-11/13/14 | PromptEntry kurang field; versioning tanpa history; kategori prompt minim | Field Name/Author/Description/Status/LastUpdated; snapshot versi + rollback; kategori Writing/Research/Knowledge/Project/Task/Search/Automation/Agent | ✅ fields + categories + `snapshotPromptHistory`/`getPromptHistory`; UI rollback deferred (low) |
| 11 | AI-22 | Export conversation tidak ada | `chat:export` (Markdown/JSON) | ✅ `exportConversation` + IPC `chat:export` |
| 12 | AI-2 | Timeout hardcoded | Ambil dari settings/ProviderConfig, fallback default | ✅ `STREAM_TIMEOUT_MS` via `settings.aiStreamTimeoutMs` |

**Verifikasi M3:** test konteks sub-agent (ContextEngine terpanggil), test PromptRegistry (semua blok prompt via registry, tidak ada string hardcoded yang lolos lint custom), test conversation (rename/archive/search/summarize).

---

## PHASE 4 — SISTEM DOMAIN

### M4: Bangun sistem domain yang bisa dikelola (bukan hanya template + list)

Prioritas berdasar dampak & ketergantungan. **M4a** = perbaikan klasifikasi (blokir semua), **M4b** = minimal viable management, **M4c** = fitur spesifikasi lanjutan.

### M4a: Perbaikan klasifikasi & konsistensi (dulu — semua bergantung) ✅ SELESAI (2026-08-26)

| # | Audit ID | Masalah | Solusi | Status |
|---|---|---|---|---|
| 1 | DOM-1 | Folder `Archive/` merusak klasifikasi → entitas hilang dari dashboard | Petakan `archive/` ke tipe asal ATAU hormati status `archived` di frontmatter (keputusan ADR-0012) | ✅ `fileTypeFromPath` Archive/ → tipe asal + Journal/Rules/Prompt → knowledge |
| 2 | DOM-6 | Ctrl+Shift+D error bila daily note sudah ada | Pakai `createFromTemplate`/open-existing seperti Dashboard | ✅ `AppShell.createDailyNote` via `createFromTemplate` |
| 3 | DOM-7 | 3 struktur daily note berbeda (Dashboard/AppShell/TemplatePicker) | Satu jalur pembuatan daily terpusat | ✅ `AppShell` kini 1 jalur (`createFromTemplate` + fallback) |
| 4 | DOM-11 | Context menu "Note baru" di folder Projects/Tasks/People buat type `note` | Deteksi folder → pilih template/type yang sesuai | ✅ `Sidebar.handleNewNote` deteksi folder → template/type |
| 5 | DOM-5 | Task `archived` dihitung open di dashboard, done di engine | Samakan semantik archived (DashboardView vs DomainEngine) | ✅ `DashboardView` filter `archived` |
| 6 | DOM-12 | Priority task free-text | Enum Critical/High/Medium/Low + validasi | ✅ `DomainEngine` normalisasi priority enum |
| 7 | CST-2 | `fileTypeFromPath` tidak petakan Journal/Rules/Prompt/Archive | Lengkapi pemetaan folder standar | ✅ `fileTypeFromPath` + `Journal/Rules/Prompt` |

### M4b: Minimal viable management per sistem — 5/6 selesai (daily timeline deferred)

| # | Audit ID | Sistem | Solusi minimal | Status |
|---|---|---|---|---|
| 1 | DOM-3 (proyek) | Project | Dashboard project: status breakdown (`projectsByStatus` — DOM-15 sudah hitung tapi tak ditampilkan), progress checklist, daftar task terkait | ✅ pills + progress % |
| 2 | DOM-3 (task) | Task | Task Center: status breakdown Inbox/To Do/In Progress/Review/Done, overdue, per-prioritas | ✅ status pills |
| 3 | DOM-3 (daily) | Daily | Timeline harian sederhana (daftar harian kronologis + filter minggu/bulan) | ⬜ deferred (butuh UI baru) |
| 4 | DOM-3 (people) | People | Wire `peopleLinkedTo` (dead code) ke UI: timeline per orang | ✅ IPC `domain:peopleLinkedTo` + preload |
| 5 | DOM-2/DOM-4 | Document | Index attachment by name/path; metadata panel (MIME/size) minimal | ✅ search index attachment |
| 6 | DOM-10/11 | Template | TemplatePicker: input owner/project per kind; context menu pakai template folder | ✅ owner/project inputs |

### M4c: Fitur spesifikasi lanjutan (roadmap)

| # | Audit ID | Fitur |
|---|---|---|
| 1 | DOM-3 | Milestone project (nama/status/target/task pendukung) |
| 2 | DOM-3 | Subtask tak terbatas + parent + dependency (blocked by / blocks) |
| 3 | DOM-8 | Variabel `{{username}}` |
| 4 | DOM-9 | Plugin dapat menambah template |
| 5 | DOM-13 | Template built-in dapat di-override lewat file seed |
| 6 | DOM-16 | Dokumentasikan/batasi tipe sop/plan/meeting |

**Verifikasi M4:** test klasifikasi (file di folder standar → type benar), test daily (satu struktur), test dashboard (archived tidak dihitung open), test DomainEngine status breakdown.

---

## PHASE 5 — UI/UX & TEMA

> **Status M5: ✅ SELESAI sebagian — 7/8 high/medium selesai. Sisa: Custom theme plugin API (deferred, low) + widget drag/drop + graph layout 6/7 (deferred).**

### M5a: Design tokens & styling — ✅

| # | Audit ID | Masalah | Solusi | Status |
|---|---|---|---|---|
| 1 | UI-1 | ±100 font-size px mentah (<10px) + warna hex + z-index inline | Migrasi ke token; hapus zIndex 9999; ganti font <10px | ✅ zIndex + file-tree a11y; sisa font/hex deferred (100+ tempat, low) |
| 2 | UI-2 | Token kategori hilang | Tambah --color-secondary, --opacity-*, --border-w-*, skala typography | ✅ 3 token kategori + typography Display/Heading |
| 3 | UI-1 (graph) | Palet node/edge diduplikasi di TS | Satu sumber warna via CSS var + theme observer | ⬜ deferred (TS→CSS var, low) |
| 4 | UI-29 | Debug leak data-theme di Settings | Sembunyikan | ⬜ low |

### M5b: A11y & feedback — ✅

| # | Audit ID | Masalah | Solusi | Status |
|---|---|---|---|---|
| 1 | UI-6 | File tree & context menu tidak keyboard-accessible | role/tabIndex/onKeyDown + Shift+F10 | ✅ |
| 2 | UI-12 | Dialog tanpa focus trap / restore focus / aria-labelledby | Focus trap + restore + Esc | ✅ |
| 3 | UI-13 | Dashboard list items div onClick | role/tabIndex atau <button> | ✅ |
| 4 | UI-5 | Dashboard load gagal diam | Inline error + tombol Retry | ✅ |
| 5 | UI-7 | Search error tampil "Tidak ada hasil" | State error + Retry | ✅ |
| 6 | UI-9 | Tidak ada undo (rename/apply proposal/clear log) | Toast + undo 5 detik | ⬜ deferred (butuh toast action infra, low) |
| 7 | UI-10 | StatusBar "Siap" saat indexing | Tone warning saat indexing/loading model | ⬜ low |
| 8 | UI-14 | Toast error hilang 3.5s tanpa aksi | Error duration lebih lama + tombol aksi opsional | ⬜ low |
| 9 | UI-15 | Graph animation tidak di-gate reduced-motion | Gate zoom tween/entry animation | ⬜ low |

### M5c: Dashboard — ✅
### M5d: Graph View — ✅ (edge types 3→7)
### M5e: Settings — ✅ (General + Backup)
### M5f: Theme — ✅ High Contrast; Custom deferred

### M5c: Dashboard (spec 25)

| # | Audit ID | Masalah | Solusi |
|---|---|---|---|
| 1 | UI-16 | 7 dari 10 widget MISSING | Tambah Today, Automation Monitor, Graph Snapshot, Quick Actions; lengkapi Recent (AI/Automation activity), Task Center (breakdown), Knowledge Insights (broken links/duplicate/missing metadata) |
| 2 | UI-17 | Widget tidak customizable | Sistem widget dasar: sembunyikan/urutkan/pindahkan (persist ke localStorage) |
| 3 | UI-18 | Tanpa lazy load | Lazy load per widget + refresh parsial |
| 4 | UI-19 | AI entry points MISSING | Morning Brief / Daily Summary / Weekly Review |

### M5d: Graph View (spec 26)

| # | Audit ID | Masalah | Solusi |
|---|---|---|---|
| 1 | UI-20 | 6 dari 7 layout algorithm MISSING | Tambah minimal Hierarchical + Circular + Grid (bisa sebagai mode preset yang memetakan posisi statis), sisanya roadmap |
| 2 | UI-21 | 3 dari 7 edge type MISSING | Backlink/Parent/Child/Reference/Dependency/Related sebagai tipe edge terdeklarasi |
| 3 | UI-22 | Search tidak center kamera / tampil jalur | Center camera ke match; path highlight dari hasil search |
| 4 | UI-23 | Clustering komunitas tidak ada | Community detection sederhana (mis. label propagation) atau hide-detail-sementara |

### M5e: Settings (spec 27)

| # | Audit ID | Masalah | Solusi |
|---|---|---|---|
| 1 | UI-25 | Section MISSING: General, Backup & Restore, Keyboard Shortcuts, Experimental | Tambah section (mulai yang paling diminta: General + Backup & Restore) |
| 2 | UI-26 | 5 lapis config tidak ada | Modelkan Global/Workspace/User/Plugin/Experimental (bertahap) |
| 3 | UI-27 | Appearance partial | Font Size, UI Density, Accent Color, Reduced Motion toggle |
| 4 | UI-28 | Privacy & Security partial | Local-only mode, telemetry toggle, data deletion |

### M5f: Theme (spec 29)

| # | Audit ID | Masalah | Solusi |
|---|---|---|---|
| 1 | UI-30 | High Contrast theme tidak ada | Tambah token block `[data-theme='hc']` |
| 2 | UI-31 | Custom theme & plugin theme API tidak ada | `registerTheme`/`useToken` + import custom CSS |
| 3 | UI-32 | Reduced Motion tanpa toggle | Toggle di Appearance |
| 4 | UI-33 | Adjustable font size tidak ada | Setting skala font UI |

**Verifikasi M5:** component test (a11y: keyboard nav sidebar/dialog), snapshot test theme (HC/custom), test widget (customize persist), lint token (script scan nilai hardcoded di CSS).

---

## PHASE 6 — PLATFORM: AUTOMATION + PLUGIN

> **Status M6: 🔄 SEBAGIAN — M6a 5/8, M6b 4/7. High-priority selesai; sisa medium/low.**

### M6a: Automation (spec 22)

| # | Audit ID | Masalah | Solusi | Status |
|---|---|---|---|---|
| 1 | PLT-1 | 4 trigger MISSING (project_created/task_completed/daily_note_created/ai_response_generated) | Pancarkan event dari sumbernya (TemplateEngine/DomainEngine/AIMiddleware → automationEngine.handleEvent) | ✅ wired di `template:createNote` + `stream_end` |
| 2 | PLT-2 | Conditions TIDAK ADA | Tambah `conditions?: AutomationCondition[]` + evaluator (File Type/Tags/Metadata dulu — murah) | ✅ `AutomationCondition` + `conditionsMatch` + test |
| 3 | PLT-3 | Actions terbatas (3/8) | Prioritaskan `notify` (channel ada) + `create_task`/`create_knowledge` via engine; lalu `run_agent`, `add_backlink`, `archive` | ✅ `notify` + `create_note` (5/8 total); run_agent/archive deferred |
| 4 | PLT-4 | Workflow engine tidak ada | Minimal retry (count + backoff) per action; multi-step/branch/parallel sebagai roadmap | ✅ retry 1x per action |
| 5 | PLT-5 | Scheduling tidak lengkap | `onceAt` + `monthly` | ✅ onceAt (auto-disable) + dayOfMonth |
| 6 | PLT-6 | Logging in-memory | Persist ke `.workspacegraph/logs/automation-events.jsonl` + field trigger/status/durasi/error/hasil | ✅ persist jsonl |
| 7 | PLT-8 | `save()` non-atomic; aksi typo gagal senyap | Atomic write + validasi `action.type` + default branch log error | ✅ atomicWriteJson + validateConfig tolak typo |
| 8 | PLT-7 | Plugin tidak bisa memperluas Automation | Mulai action `plugin.run <id> <command>` | ⬜ |

### M6b: Plugin SDK (spec 28)

| # | Audit ID | Masalah | Solusi | Status |
|---|---|---|---|---|
| 1 | PLG-1 | Hanya 1/9 extension point | Mulai 1-2 berdampak: Context Menu + Search Provider (bisa declarative di manifest tanpa UI SDK penuh) | ⬜ deferred (butuh UI SDK) |
| 2 | PLG-2 | Lifecycle 8 tahap tidak lengkap | Dokumentasikan "folder = install"; tambah validasi SDK version + event lifecycle | 🔶 SDK gate ✅; lifecycle event deferred |
| 3 | PLG-3 | Manifest kurang dependencies/minimumSdkVersion | Tambah field + `minSdk` gate | ✅ `minSdkVersion`/`dependencies` + semver gate + PLUGIN_SDK_VERSION |
| 4 | PLG-5 | SDK APIs jauh dari spesifikasi | Tambah read-only Project/Task/Knowledge (via DomainEngine) + `settings.set` + Event subscribe | ✅ `domain.list` read-only (settings.set/event deferred) |
| 5 | PLG-6 | Event system TIDAK ADA | Minimal `events.subscribe(channel, cb)` dibatasi event yang ada | ⬜ deferred |
| 6 | PLG-7 | Resource limits tanpa cap memori | `resourceLimits: { maxOldGenerationSizeMb }` pada Worker | ✅ 256MB old / 64MB young |
| 7 | PLG-8 | Contoh plugin `enabled: true` | Ubah ke `false` (konsisten ADR-0003) | ✅ |

**Verifikasi M6:** test automation (trigger baru, conditions, persist log, re-entrancy masih aman), test plugin (permission enforcement — PLG-4 di M1 — + extension point baru + minSdk gate + resource limit).

---

> **Status M7: 🔄 SEBAGIAN — 16/20 selesai. Sisa: W2 async scan (invasif), S6 low, G3 deferred, M1/M2 footnote/id, L1/L2 low.**

### M7: Skala & kualitas engine (spec 05-09)

| # | Audit ID | Masalah | Solusi | Status |
|---|---|---|---|---|
| 1 | W2 | scanDirectory sinkron + statSync → UI freeze di 10k+ file | Async scan / batas waktu / background | ⬜ (invasif — defer) |
| 2 | S1 | Metadata search tidak ada | Frontmatter masuk FTS atau tabel key-value; query `metadata:` | ✅ `metadata:key value` operator di specialSearch |
| 3 | S3 | Ranking tanpa backlink-count/graph proximity/status | Tambah sinyal ranking dari graph + domain | ✅ backlink-count boost (cap +15%, saturasi 15); proximity/status deferred |
| 4 | S4 | Tasks tidak diindeks | Parse checkbox → index | ✅ `extractOpenTasks` → Fuse headings + FTS level-6 synthetic |
| 5 | S7 | `rebuildSqliteFromMemory` kata-per-heading → noise | Simpan heading string asli | ✅ satu entri heading gabungan; FTS text sama tanpa noise |
| 6 | S6 | Kontradiksi template (listSystemNotes) | Sinkronkan kebijakan Templates/ | ✅ templates/ dibuang dari system-folder filter |
| 7 | G1/G2 | Node/edge attrs Created/Updated/Color MISSING | Tambah metadata temporal + color category | 🔶 created/updated node attrs ✅; color category deferred |
| 8 | G3 | Edge `folder` dideklarasikan tak pernah dibuat | Buat folder edges | ⬜ deferred (risiko edge explosion) |
| 9 | G4 | Tag nodes terisolasi di jalur produksi | Selalu buat note→#tag edges | ✅ guard basi pre-WB-3 dihapus + regression test produksi |
| 10 | G5 | Update single-file rebuild penuh tag/degree | Incremental (hanya node tersentuh) | ✅ incremental tagnode edges per node tersentuh |
| 11 | G7 | getNeighbors O(depth×nodes×edges) | Adjacency list | ✅ adjacency O(E)/panggilan + BFS O(V+E) |
| 12 | G8 | resolveLinkTarget O(links×keys) | Index path→id | ✅ suffix index prebuilt, O(1)/link; ambiguous suffix ditolak |
| 13 | C1 | User selection tidak didukung | Parameter selection di buildContextPackage | ✅ `AIRequest.selection` + sync/async path + injeksi verbatim |
| 14 | C2 | Context package tanpa Project/Tasks | Lookup project/task terkait dokumen aktif | ✅ neighbors Projects//Tasks/ → Related projects/tasks |
| 15 | C3 | Path sinkron tidak memangkas budget | Truncate di path sinkron juga | ✅ hard-cap budget×4 chars di batas baris |
| 16 | T1 | `{{title}}` tanpa YAML-escape | Sanitasi setelah merge vars | ✅ extraVars tak bisa menimpa title/filename + collapse newline |
| 17 | M1/M2/M3/M4 | Footnote/id/Image lokal/link lokal | Implementasikan per spec 06 | 🔶 M3 image lokal + M4 link lokal .md ✅ (safe-src guard); M1 footnote/M2 id deferred |
| 18 | W1/W3 | Manifest tidak lengkap; tanpa validateWorkspaceStructure | Lengkapi manifest + validasi | ✅ manifest sub-struktur (logs/cache/plugins.json) + `validateWorkspaceStructure()` method |
| 19 | S2/S5/S8/S9 | Link search parsial, recent tanpa "dibuka", O(N) path, token `:` dibuang | Perbaikan parsial | 🔶 S8 byPath Map O(1) ✅ · S9 colon strip ✅; sisanya low |
| 20 | C4/C5/C6, D1/D2, T2/T3, L1/L2, FW1 | Polish kecil | 🔶 C4 cap read ✅ · C5 lowercase ✅ · C6 dedupe ✅ · D1 mapping ✅ · T2 daily selaras ✅ · T3 markSelfWrite ✅ · FW1 prune ✅; sisanya low |

**Verifikasi M7:** full suite 1168 hijau; test graph 31 ✅ · search 30 ✅ · automation 23 ✅.

---

## PHASE 8 — PLATFORM HARDENING

> **Status M8: 🔄 SEBAGIAN — 7/17 selesai (MCP penuh + CSP + API + env redaction). Sisa: SEC audit-log/backup, API kontrak, Installer.**

### M8: MCP, Security, API, Installer, File Structure

| # | Audit ID | Masalah | Solusi | Status |
|---|---|---|---|---|
| 1 | MCP-2 | Spawn MCP tanpa gate permission | Gate (ADR-0006) + jangan connectAll sebelum user aktifkan | ✅ handler gate aiTools; connectAll gate |
| 2 | MCP-3 | Secrets MCP plaintext | Enkripsi env dengan safeStorage / sanitasi response | ✅ env redacted di getServers; Save merge env lama |
| 3 | MCP-1 | Handler tanpa validasi array | `Array.isArray` guard | ✅ handler + saveServers |
| 4 | MCP-4 | Error connectAll di-swallow | Log + set errors map | ✅ per-server console.warn |
| 5 | SEC-1 | Audit logging tidak lengkap (config/plugin/security) | Perluas jadi event log umum (`audit.jsonl`) | ✅ `security/AuditLog.ts` — settings/plugin/automation/MCP/denial di-audit |
| 6 | SEC-2 | Backup protection tidak ada | Backup folder manual + checksum + restore point | ✅ `security/Backup.ts` + IPC backup:create/list + Settings UI; terjadwal deferred |
| 7 | SEC-3 | Enkripsi hanya API keys AI | Terapkan ke env MCP (dengan MCP-3) | ✅ redaction; safeStorage deferred (env di disk tetap, tak terekspos ke renderer) |
| 8 | SEC-4 | CSP lemah + sandbox off | Pisahkan dev/prod CSP (ADR-0007); verifikasi contextIsolation | ✅ prod tanpa unsafe-eval/inline |
| 9 | API-1 | InternalAPI bukan kontrak | Migrasi bertahap handler ke InternalAPI (read-only dulu) | 🔶 plugins handler sudah via InternalAPI; search handler tipis; full migration bertahap |
| 10 | API-2 | Versioning tidak nyata | Sinkronkan apiVersion dengan app | ✅ '2.0.0' |
| 11 | API-3 | IPC tidak typed | Kurangi `any`; validasi bentuk di handler | 🔶 sebagian (MCP handlers divalidasi) |
| 12 | API-4/5 | Error handling 3 gaya; type basi | Envelope `{ok,data?,error?}`; hapus resolveKerjaVault/openKerjaVault | ✅ type basi dihapus |
| 13 | INS-1 | Tidak ada update system | electron-updater + publish config ATAU ADR non-goal | 📋 ADR-0013: adopsi di v2 |
| 14 | INS-2 | Migrasi tanpa backup config | Snapshot sebelum migrasi + validasi hasil | ⬜ |
| 15 | INS-3 | Uninstall tanpa pilihan | Custom NSIS page | ⬜ |
| 16 | INS-4 | Tanpa checksum publik | Generate + publish sha256 per artifact | ✅ SHA256SUMS di release workflow |
| 17 | FST-1/2/3 | Struktur root tidak sesuai spec 32 | Sub-struktur Cache/Backups/Temp; pindah index.db ke Cache/ | ⬜ |

**Verifikasi M8:** security test (MCP gate, secret leak), test backup/restore, test API kontrak, test installer (checksum hadir di release).

---

## PHASE 9 — TESTING & KUALITAS

### M9: E2E, AI eval, cross-platform, security testing (spec 34)

| # | Audit ID | Masalah | Solusi |
|---|---|---|---|
| 1 | TST-1 | Tidak ada E2E renderer | Playwright/Electron E2E: buka vault fixture → buat note → link wiki → graph → chat (mock provider) |
| 2 | TST-2 | AI evaluation tidak ada | Golden-set kecil untuk prompt template + konsistensi output + token efficiency |
| 3 | TST-3 | Cross-platform tidak di CI | Job `windows-latest` untuk test (path + safeStorage) |
| 4 | TST-4 | Security testing tidak ada kategori | Fuzz IPC input + leak-sweep otomatis + `npm audit` job |
| 5 | TST-5 | Performance tanpa baseline gate | 2-3 metrik dengan threshold longgar sebagai gate |
| 6 | TST-6 | Coverage tanpa threshold | `coverage.thresholds` di vitest.config + job security CI |

**Verifikasi M9:** CI hijau dengan job baru; E2E menangkap regression alur penuh.

---

## PHASE 10 — POLISH (P3)

### M10: Semua item LOW/INFO

Dari audit bagian 8 P3: W1, W3, M4, M5, S5, S8, S9, G2, G6, G9, L1, L2, FW1, C4, C5, C6, T2, T3, D1, D2, A2, A3, A4, X2-X5, DOM-14..17, UI-3/10/11/14/15/29, PLG-8, MCP-1/4, API-4/5, SEC-4, INS-5, FST-2/3, TST-5/6.

Prioritas dalam P3 (dampak > biaya):
1. **X2 (ID 3× duplikat)** — satu helper `generateId` bersama (pencegahan bug jangka panjang).
2. **M5 (resolveWikiLink duplikat)** — delegasikan ke GraphEngine.
3. **A2 (tags multi-baris YAML duplikat key)** — parse via gray-matter.
4. **A3 (automation save non-atomic)** — atomicWriteJson.
5. **FW1 (leak selfWriteIgnore)** — bersihkan Map.
6. **UI-11 (palette plugin command toast)** — wire atau sembunyikan.
7. **D1 (typeFromParsed)** — ikut keputusan M4a.
8. Sisanya bertahap sesuai backlog.

---

## BACKLOG TEMUAN BARU (dicatat selama eksekusi)

> Saat mengerjakan, temuan baru dicatat di sini — TIDAK dikerjakan di tengah milestone.

| Tanggal | Area | Temuan | Milestone saat ditemukan |
|---|---|---|---|
| | | | |

---

## DEFINISI SELESAI

- [ ] Semua temuan M0..M10 (audit 2026-08-24: 29 HIGH · 66 MEDIUM · 38 LOW/INFO) ditutup eksplisit atau dijadikan ADR/non-goal.
- [ ] Setiap BUG (M1) punya test yang gagal sebelum fix (reproduksi) dan hijau setelahnya.
- [ ] `npm run typecheck` 0 error · `npm test` hijau · `npm run lint` exit=0 · `check:crlf` bersih.
- [ ] MiniCore terintegrasi (M2) atau dijadikan ADR-0008 non-goal — tidak ada duplikasi loop tanpa keputusan.
- [ ] Semua ADR baru (ADR-0006..0013) tercatat di `docs/adr/`.
- [ ] Item SPEC-DRIFT memiliki keputusan tertulis (bangun ATAU koreksi spek) — tidak dibiarkan ambigu.
- [ ] `35_Roadmap.md` Phase 6 tracking + `docs/STATUS_2026-08-24.md` diperbarui per milestone selesai — jejak tidak basi.

---

## CATATAN RILIS

| Milestone | Estimasi (sesi) | Risiko utama | Mitigasi |
|---|---|---|---|
| M0 (ADR) | 1 | Keputusan salah arah | Konsultasi dokumen 00-35 + adr/ |
| M1 (P0) | 2-3 | Mengubah perilaku simpan | Test autosave + re-entrancy dulu |
| M2 (MiniCore) | 4-6 | Regresi loop AI | 148 test MC + sourceContracts + qa:ai |
| M3 (AI layer) | 3-4 | Prompt drift | PromptRegistry + golden-set (M9) |
| M4 (Domain) | 4-6 | Klasifikasi berubah | Test klasifikasi + dashboard |
| M5 (UI/UX) | 4-6 | Styling regresi | Component test + token lint |
| M6 (Platform) | 3-4 | Automation loop baru | Guard re-entrancy (M1) dulu |
| M7 (Engine) | 3-4 | Perf regresi | Benchmark sebelum/sesudah |
| M8 (Hardening) | 3-4 | Postur keamanan | ADR-0006/0007 dulu |
| M9 (Testing) | 2-3 | CI lambat | Job paralel |
| M10 (Polish) | 2-3 | Scope creep | Satu item satu commit |
