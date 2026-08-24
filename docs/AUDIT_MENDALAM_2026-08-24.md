# AUDIT MENDALAM WORKSPACEGRAPH — Fitur, UI/UX, Kerja Sama Engine

**Tanggal:** 2026-08-24
**Cakupan:** Semua fitur, UI/UX, kerja sama antar engine, kepatuhan terhadap 36 dokumen spesifikasi (00–35), integrasi dengan MiniCore (`D:\git\minicore`).
**Metode:** Pembacaan penuh kode sumber (`src/main`, `src/preload`, `src/renderer`) + dokumen spesifikasi + ADR + MiniCore, diverifikasi silang, terstruktur mengikuti dokumentasi.
**Status audit sebelumnya:** 52 temuan 2026-08-10 SELESAI (5 ADR). Audit ini = temuan BARU + kesenjangan spesifikasi yang belum tercatat.

---

## RINGKASAN EKSEKUTIF

**Konteks penting:** WorkspaceGraph memiliki dokumen spesifikasi yang sangat ambisius (36 dokumen blueprint, seluruhnya berstatus Draft v0.1) namun implementasinya baru mencapai **sebagian kecil** dari yang dispesifikasikan. Banyak dokumen spesifikasi adalah visi masa depan; kode saat ini solid untuk fondasi (vault, editor, graph, search, AI chat) tetapi **sistem domain (Project/Task/People/Daily/Document/Template), Dashboard, Graph View lanjutan, Settings, Automation, dan Plugin SDK berada jauh di bawah spesifikasi.**

**Temuan kunci:**
- **0 CRITICAL** (tidak ada exploit langsung / kehilangan data wajib)
- **29 HIGH** (terkoreksi — ringkasan awal menyebut 13, hitungan aktual 29)
- **66 MEDIUM**
- **38 LOW/INFO**
- Total: **133 temuan** (bukan ~83 seperti ringkasan awal)

**Temuan terbesar:**
1. **MiniCore (runtime AI kernel deterministik, 148 test) BELUM diintegrasikan** — WorkspaceGraph memakai loop tool sendiri di `AIMiddleware.ts` yang kurang: kompaksi berbasis budget antar-round, `force_compact_and_retry`, taksonomi error, semantik finish-reason. Ini peluang integrasi terbesar.
2. **Health check provider cloud PALSU** — `isConfigured()` (key ada) ≠ provider hidup. UI menampilkan "connected" walau key mati.
3. **Race antara background index dan file watcher saat open vault** — update inkremental bisa tertimpa rebuild penuh.
4. **Search tidak mengindeks dokumen non-Markdown** — acceptance criteria Document System gagal.
5. **7 dari 7 sistem domain hanya PARTIAL** — tidak ada satu pun sistem FULL (Project/Task/People/Daily/Document semua tanpa UI pengelolaan).
6. **Automation & Plugin SDK sangat jauh di bawah spesifikasi** — 4/10 trigger, 0/7 kondisi, 3/8 aksi, 1/9 extension point.

---

## DAFTAR ISI

1. [Konstitusi & Visi (00–04)](#1-konstitusi--visi-0004)
2. [Core Engines (05–09)](#2-core-engines-0509)
3. [AI Layer (10, 18, 19, 20, 21)](#3-ai-layer--integrasi-minicore)
4. [Sistem Domain (11–17)](#4-sistem-domain-1117)
5. [UI/UX & Tema (23, 24, 25, 26, 27, 29)](#5-uiux--tema)
6. [Platform (22, 28, 30–34)](#6-platform--automation-plugin-api-security)
7. [Integrasi MiniCore](#7-integrasi-minicore)
8. [Prioritas Rekomendasi](#8-prioritas-rekomendasi)

---

## 1. KONSTITUSI & VISI (00–04)

### Verifikasi Kepatuhan Constitution (15 Laws)

| Law | Status | Catatan |
|---|---|---|
| 001 Markdown First | ✅ | File .md = source of truth; DB hanya cache |
| 002 User Owns Data | ✅ | Vault = folder markdown biasa, portabel |
| 003 AI Is A Worker | ✅ | AI baca-konteks-tulis-kembali via proposal |
| 004 Workspace First | ⚠️ | AI pakai Context Engine, tapi sub-agent skip (lihat 3) |
| 005 Read Before Think | ⚠️ | Tidak ada enforcement eksplisit urutan baca (identifikasi proyek→template→SOP→Rules→Daily) — hanya heuristik ContextEngine |
| 006 Never Invent Existing Data | ✅ | AI pakai tool search/read_note; tidak ada akses file mentah |
| 007 Write Back | ✅ | Proposal + persetujuan → apply → reindex |
| 008 Graph Integrity | ✅ | Wiki link → backlink → edge |
| 009 Database Is Cache | ✅ | index.db dibangun ulang dari Markdown |
| 010 AI Independence | ⚠️ | 7 provider adapters bagus, tapi MiniCore tidak dipakai (bisa jadi fondasi AI-independent) |
| 011 Human Readable | ✅ | Frontmatter YAML + markdown standar |
| 012 Offline First | ⚠️ | Editor/search/graph offline ✅; AI online hanya fitur tambahan ✅; tapi CSS masih panggil Google Fonts (CSP) |
| 013 Plugin First | ⚠️ | Plugin host ada tapi hanya 1/9 extension point (lihat 6) |
| 014 Preserve Knowledge | ✅ | Hapus via .trash (soft delete) + restore |
| 015 Long-Term Compatibility | ⚠️ | Markdown aman; tapi API/versioning belum dimodelkan (lihat 6) |

**FR-003 (AI wajib konteks dapat dijelaskan):** ⚠️ Context badge di ChatPanel menunjukkan token/context, tetapi tidak ada penjelasan per-tier mana yang dipakai (dokumen apa yang masuk konteks).

### Temuan Konstitusi

- **CST-1 [HIGH]** **Law 004/005 tidak ter-enforce untuk sub-agent** — `AIMiddleware.runSubAgent` memakai `useContext=false` (`AIMiddleware.ts:1267`). Sub-agent AI bekerja tanpa konteks workspace (hanya task teks), melanggar "Agent selalu menggunakan Context Engine" dan Law 004/005.
- **CST-2 [MEDIUM]** **`fileTypeFromPath` tidak memetakan folder standar Journal/Rules/Prompt/Archive** (`WorkspaceEngine.ts:108-119`) → semua file di folder standar itu ber-type `other`, tidak masuk domain/graph/dashboard dengan benar.
- **CST-3 [MEDIUM]** **Law 012 dilanggar sebagian** — CSP mengizinkan `fonts.googleapis.com`/`fonts.gstatic.com` (`src/main/index.ts`). Aplikasi "offline-first" bergantung pada jaringan untuk font di mode tertentu.
- **CST-4 [LOW]** **Dokumen spesifikasi seluruhnya Draft v0.1** — tidak ada nomor persyaratan formal (R-xx). Sulit melakukan traceability requirements↔test. Saran: nomori FR/AC dan kaitkan dengan test.

---

## 2. CORE ENGINES (05–09)

### 2.1 Workspace Engine (05)

- **W1 [LOW]** Manifest `.workspacegraph/` tidak lengkap — spec butuh `workspace.json`, `settings.json`, `plugins.json`, `index.db`, `cache/`, `logs/`. Hanya `workspace.json` + `index.db` yang dibuat saat init (`WorkspaceEngine.ts:90-106`). `plugins.json`, `cache/`, `logs/` tidak pernah dibuat default.
- **W2 [MEDIUM]** **`scanDirectory` sinkron + `statSync` di main process** (`WorkspaceEngine.ts:127-176`), dipanggil 2× saat open vault (`syncWorkspaceData`). Spec 05 target ribuan file tanpa penurunan performa. UI membeku pada 10k+ file.
- **W3 [LOW]** Tidak ada `validateWorkspaceStructure()` untuk memvalidasi struktur vault lama saat dibuka.

### 2.2 Markdown Engine (06)

- **M1 [MEDIUM]** **Footnote TIDAK diimplementasikan** — spec 06 mencantumkan Footnote sebagai fitur wajib; `renderMarkdownToHtml` (`MarkdownEngine.ts:277-517`) tidak menangani `[^1]`/`[^1]:`.
- **M2 [MEDIUM]** **Frontmatter field `id` tidak dibaca/dipakai** — spec 06 mencontohkan `id: project-alpha`; `ParsedFrontmatter` (`MarkdownEngine.ts:11-24`) tidak punya field id. Identity node = hash path, jadi rename file = ganti id (melanggar stabilitas ID spec 08).
- **M3 [MEDIUM]** **Image lokal tidak dirender** — regex eksternal (`MarkdownEngine.ts:318-335`) hanya `https?:`/`mailto:`. `![](assets/gambar.png)` dirender sebagai teks. Spec 06 mencantumkan Image.
- **M4 [LOW]** Link lokal `[a](docs/file.md)` juga tidak dirender (hanya http/mailto).
- **M5 [LOW]** `resolveWikiLink` (`MarkdownEngine.ts:590-598`) linear scan O(N) per link, **duplikasi logika** dengan `GraphEngine.resolveLinkTarget`, saat ini hanya dead code untuk test.

### 2.3 Search Engine (07)

- **S1 [HIGH]** **Metadata Search TIDAK ada** — spec 07: 7 tipe search (fulltext/file/tag/metadata/link/backlink/recent). `specialSearch` (`SearchEngine.ts:318-336`) hanya `orphan:`/`backlinks:`/`path:`/`#tag`. Tidak ada `metadata:`/`frontmatter:` query. Akar: FTS5 hanya mengindeks `title, content, tags, relative_path, headings` (`IndexDatabase.ts:157-166`), frontmatter lain disimpan JSON tak terindeks.
- **S2 [MEDIUM]** **Link Search hanya parsial** — hanya backlink search; spec membedakan Link vs Backlink.
- **S3 [MEDIUM]** **Ranking tidak penuh** — spec: judul>isi>tag>metadata>**backlink-count**>**graph proximity**>project status>updated. Implementasi hanya FTS bm25 + Fuse weights. Backlink-count/graph proximity/status proyek TIDAK dipakai → dokumen berpengaruh tidak naik.
- **S4 [MEDIUM]** **Search source "Tasks" tidak diindeks** — tidak ada parsing checkbox/task dalam search.
- **S5 [LOW]** Recent search hanya `updated_at`, bukan "dibuka" (spec: diubah **atau dibuka**).
- **S6 [MEDIUM]** **Kontradiksi template** — `getSystemFolderNotes`/`listSystemNotes` menyertakan `templates/` sebagai context, bertentangan dengan `isTemplateDir` yang mengecualikan Templates/ dari index → hasil kosong.
- **S7 [MEDIUM]** `rebuildSqliteFromMemory` mengubah **setiap kata** heading menjadi objek heading — mengotori kolom `headings` (noise setelah rebuild).
- **S8 [LOW]** `getEntryByPath` O(N) linear scan per hit semantik (`SearchEngine.ts:748-754`). Saran: Map.
- **S9 [LOW]** `searchFts` membuang token ber-`:` (`IndexDatabase.ts:331-333`) — query `status:active` kehilangan komponen.

### 2.4 Graph Engine (08)

- **G1 [MEDIUM]** **Node attrs `Created`, `Updated`, `Color Category` TIDAK ada** (`GraphEngine.ts:4-54` hanya ID/Title/Type/Path/Tags/Degree). Spec 08: + Created, Updated, Color Category. Metadata temporal hilang dari graph.
- **G2 [LOW]** Edge attr `Created` tidak ada.
- **G3 [MEDIUM]** **Edge type `folder` dideklarasikan tapi tidak pernah dibuat** — `GraphEngine.ts:73` `'wiki_link'|'tag'|'folder'`; tidak ada kode yang menghasilkan edge folder. Spec 08: "Folder Relationship" adalah sumber edge.
- **G4 [MEDIUM]** **Tag nodes terisolasi pada jalur produksi** — `syncWorkspaceData` memanggil `buildFromParsedFiles(parsed, true)` (includeCoTagEdges=true). Di `rebuildTagNodes` (`GraphEngine.ts:349-378`), edge note→#tag hanya dibuat jika `!includeCoTagEdges`. Akibat: dengan setting default, semua node `#tag` berdiri sendiri degree 0 (pulau tak terhubung) saat user filter Tags.
- **G5 [MEDIUM]** **Update single-file tidak "hanya bagian berubah"** — `updateNodeAndEdges` (`GraphEngine.ts:956-958`) tetap `rebuildTagNodes()` + `recomputeDegrees()` penuh per edit. Spec 08: incremental. Target 10k/50k terancam.
- **G6 [LOW]** `getGraphData()` memanggil `pruneGhostEdges` yang **memutasi state** — getter dengan side-effect.
- **G7 [MEDIUM]** `getNeighbors`/`getLocalGraph` O(depth × nodes × edges) — loop `edges.values()` per node per depth. Dipanggil ContextEngine per dokumen aktif.
- **G8 [MEDIUM]** `resolveLinkTarget` untuk path scan penuh `maps.unique` per link; `rebuildWikiEdgesFromOutLinks` per outlink → O(links × keys). Vault besar lambat.
- **G9 [LOW]** `findShortestPath` pakai `shift()` O(n) per dequeue (bounded 256, minor).

### 2.5 GraphLayoutStore

- **L1 [LOW]** `saveGraphLayout` read-modify-write — race antar window/aksi bisa kehilangan posisi node.
- **L2 [LOW]** `upsertGraphView` cap 40 view (`slice(-40)`) — view terlama hilang tanpa peringatan.

### 2.6 FileWatcher

- **FW1 [LOW]** `selfWriteIgnore` (`shared.ts:266-279`) tidak pernah dibersihkan untuk path yang di-mark tapi tak pernah event → leak Map kecil.

### 2.7 Context Engine (09)

- **C1 [MEDIUM]** **"User Selection" tidak didukung** — spec prioritas #2 = dokumen yang dipilih user; `buildContextPackage` (`ContextEngine.ts:159-164`) tidak punya parameter selection.
- **C2 [MEDIUM]** **Context Package 9 item tidak lengkap** — ada Primary/Related/Backlinks/Outbound/Rules/Token. **Project Information ✗, Relevant Tasks ✗** (tidak ada lookup project/task terkait dokumen aktif).
- **C3 [MEDIUM]** **Path sinkron `buildContextPackage` menghitung usedTokens tapi tidak memangkas** `formattedContext` final bila overshoot (header + daftar melebihi budget). Hanya path async yang ketat.
- **C4 [LOW]** `tryAddSnippet` membaca **seluruh file** per kandidat (`workspaceEngine.readFile`) lalu slice — I/O besar untuk banyak kandidat.
- **C5 [LOW]** `pathPriority` case-sensitive 'ai memory' dua varian.
- **C6 [LOW]** Duplikasi konstanta 'ai memory' antara ContextEngine dan WorkspaceMemory — risk drift.

### 2.8 Template Engine

- **T1 [MEDIUM]** `render()` substitusi `{{title}}` **mentah tanpa YAML-escape** (`TemplateEngine.ts:463-468`); `extraVars` di-spread setelah `safeTitle` bisa menimpa → judul berisi `:`/`#` merusak frontmatter.
- **T2 [LOW]** Dua sumber "daily template" divergen: `MarkdownEngine.createDailyNoteTemplate` vs `builtin-daily` — frontmatter tidak identik.
- **T3 [LOW]** `seedBuiltinToVault` menulis tanpa `markSelfWrite` → watcher echo → `syncSingleFile` 8×.

### 2.9 Domain Engine

- **D1 [LOW]** `typeFromParsed` tidak memetakan Journal/Rules/Prompt/Archive → `other` (konsisten tapi keliru vs spesifikasi).
- **D2 [LOW]** `parseCheckboxes` hanya list item level-1; checkbox dalam blockquote/list bersarang terlewat.

### 2.10 Automation Engine (lihat juga bagian 6)

- **A1 [MEDIUM]** **Re-entrancy / infinite loop risk** — aksi automation menulis file via `workspaceEngine.writeFile` **tanpa `markSelfWrite`** → watcher `change` → `handleEvent('file_updated')`. Rule `file_updated` + aksi `append_to_note` ke file yang sama = loop tak berujung. Tidak ada guard re-entrancy.
- **A2 [MEDIUM]** `set_frontmatter_tag` regex `tags:\s*\[([^\]]*)\]` hanya array inline (`AutomationEngine.ts:280-287`). Frontmatter tags multi-baris → branch else menambah baris `tags:` kedua → **duplikat key YAML** (key terakhir menang, data lama bisa tertimpa).
- **A3 [LOW]** `save()` menulis `automation.json` non-atomik.
- **A4 [LOW]** `nextFireTime` tidak mensimulasikan drift dengan benar setelah hari terblokir (diakui intentional).

### 2.11 Integrasi lintas-engine

- **X1 [HIGH]** **Race antara background index dan watcher saat open** — `openVaultFlow` (`ipc/handlers/workspace.ts:34-48`) jalankan `syncWorkspaceData` async (fire-and-forget), lalu `attachFileWatcher`. Jika file berubah **selama** initial index, `syncSingleFile` memperbarui graph/search, lalu `buildFromParsedFiles` di dalam `syncWorkspaceData` **clear semua node/edges** → update inkremental hilang/tertimpa. `indexing` flag hanya untuk UI, bukan serialisasi. **Saran: antre watcher events selama initial sync, atau pasang watcher setelah sync.**
- **X2 [MEDIUM]** **ID generation diduplikasi 3×** — `WorkspaceEngine.generateId` (121-125), `MarkdownEngine.generateId` (151-156), `shared.filePathId` (98-102). Satu perubahan = id divergen antar engine (graph/search/domain pecah).
- **X3 [LOW]** `templates:createNote` dan `template:seed` tidak `markSelfWrite` → chokidar echo dobel.
- **X4 [LOW]** `handleDirRemove` memanggil `getGraphData()` (serialisasi penuh graph + side-effect prune) hanya untuk kumpulkan path md.
- **X5 [LOW]** Duplikasi daily template (T2) & `getSystemFolderNotes` vs `listSystemNotes` (S6).

---

## 3. AI LAYER & INTEGRASI MINICORE (10, 18, 19, 20, 21)

### 3.1 AI Middleware (10)

- **Gerbang tunggal:** ✅ Sebagian besar. Semua panggilan LLM melalui `aiMiddleware` (satu-satunya titik di `ipc/handlers/ai.ts:309,357,439`). **Pengecualian:** `EmbeddingEngine` dipanggil langsung `ContextEngine.buildContextPackageAsync` (`ContextEngine.ts:400`) — embedding lokal, LOW, tapi melanggar harfiah "tidak ada modul lain memanggil model AI langsung".
- **AI-1 [MEDIUM] Permission gate di luar middleware** — cek `perms.aiAccess/aiTools` ada di lapisan IPC (`ai.ts:304,338-349`), bukan di dalam `AIMiddleware.streamMessage`. Pemanggil programatik (`runStreamInner`/`runSubAgent`) melewati gate. Saran: double-gate.
- **AI-2 [LOW] Timeout hardcoded** — 180s per stream (`AIMiddleware.ts:1441`), 30s per tool, 60s MCP. Tidak konfigurabel per-provider.
- **AI-3 [LOW]** Logging `AIEventLog` ✅ tidak pernah mencatat konten/API key; rotasi + prune + CSV injection guard. Solid.
- **AI-4 [MEDIUM]** **Output validation tidak formal** — hanya `verifyCitations` (heuristic non-blokir) + parse tool action. Tidak ada validation skema/structured output. (spec 10 langkah 8: "validasi output").

### 3.2 Provider Layer (18)

- **AI-5 [HIGH]** **Health check PALSU** — hanya Ollama probe nyata (`OllamaProvider.ts:31-38`); semua provider cloud `healthCheck() === isConfigured()` (key ada = "connected") (`OpenAIProvider.ts:102-104`, `ClaudeProvider.ts:47-49`, `GeminiProvider.ts:53-55`, `GrokProvider.ts:154-156`, `OpenRouterProvider.ts:81-83`). Kode sendiri mengakuinya (`AIMiddleware.ts:441-446`). UI menampilkan "connected" padahal key mati/server down. **Saran: probe GET /models dengan TTL.**
- **AI-6 [MEDIUM]** **Capability detection kurang** — `ProviderCapabilities` hanya `{chat, streaming, vision, toolCalling, embeddings}` (`BaseProvider.ts:79-85`). Spec 18: + **Reasoning, Structured Output, File Input, Image Generation**. Reasoning dialirkan di chunk tapi tidak dideklarasikan.
- **AI-7 [LOW]** Model registry per-provider cache TTL (baik), tapi tidak ada per-model capability/version/availability global.
- **AI-8 [MEDIUM]** **Credential fallback `plain:` = plaintext di disk** (`SecretsStore.ts:33`) saat `safeStorage` tak tersedia. Spec 18:109: "Credential tidak boleh plaintext". Saran: tolak persist atau kunci file lokal + tandai UI "not encrypted".
- **AI-9 [LOW]** Interface 7 metode terpenuhi implisit (`configure`=Initialize/Authenticate, dst); saran nama eksplisit.

### 3.3 Prompt System (19)

- **AI-10 [HIGH]** **Middleware MENYUSUN PROMPT SECARA MANUAL** — melanggar spec 19:177 "Middleware tidak menyusun prompt secara manual". Hardcoded: `planInstruction` (`AIMiddleware.ts:651-661`), prompt stage pipeline (`:947-952`), systemPrompt sub-agent (`:1243`), `buildSystemPrompt` deprecated manual (`:667-710`), plus renderer: `chatStore.ts:833-848` (learnWorkspace), `:1028-1033` (resume), `:1103-1109` (rephrase), `chatFollowUp.ts` preamble. **Saran: semua blok instruksi jadi entry PromptRegistry; middleware hanya panggil `renderPrompt(id, vars)`.**
- **AI-11 [MEDIUM]** `PromptEntry` kurang field: Name/Author/Description/Status/Last Updated (`PromptRegistry.ts:29-33`).
- **AI-12 [LOW]** Placeholder `{{project}}`/`{{knowledge}}`/`{{task}}`/`{{context}}` tidak di-resolve otomatis; hanya lewat jika caller isi vars.
- **AI-13 [MEDIUM]** **Versioning tanpa history/rollback** — hanya aturan "versi file ≥ default"; tidak ada snapshot versi lama.
- **AI-14 [LOW]** Hanya 4 prompt (`kernel`, `bootstrap`, `toolsHead`, `toolsTail`); tidak ada kategori Writing/Research/Knowledge/Project/Task/Search/Automation/Agent (spec 19:70-84).

### 3.4 Agent (20)

- **AI-15 [MEDIUM]** **2 dari 6 agent spesifikasi HILANG** — role ada: `general/writer/researcher/curator/planner` (`ContextEngine.ts:8,17-53`). **Project Manager** dan **Document Analyst** tidak ada.
- **AI-16 [LOW]** Lifecycle 7 langkah ter-align loose; fase Plan implisit (tidak ada event `agent:plan`).
- **AI-17 [MEDIUM]** **Sub-agent skip Context Engine** (`AIMiddleware.ts:1267` `useContext=false`) — melanggar spec 20:31 "Agent selalu menggunakan Context Engine" dan Law 004/005.
- **AI-18 [LOW]** Orkestrasi parallel antar-agent TIDAK ada (hanya batch read tool dalam satu round). Spec: Research∥Curator∥Writer.
- **Permission:** ✅ Per-role tool matrix (`AgentTools.ts:110-134`), plan mode, MCP write gate, defence-in-depth, semua write = proposal persetujuan. Kuat.

### 3.5 Conversation (21)

- **AI-19 [MEDIUM]** **Struktur conversation kurang relasi & summary** — `StoredConversation` hanya `{id,title,createdAt,updatedAt,agentRole,messages}` (`ConversationStore.ts:22-29`). Spec: + Related Knowledge/Projects/Tasks/Documents, Summary, Status.
- **AI-20 [MEDIUM]** **Rename & Archive session HILANG** — hanya list/resume/delete; tidak ada `chat:rename`/`chat:archive` (`chat.ts:13-34`).
- **AI-21 [MEDIUM]** **Tidak ada AI summarization percakapan** dan **tidak ada conversation search** (judul/isi/ringkasan/entitas) — tidak ada FTS di chats.
- **AI-22 [LOW/MEDIUM]** Export conversation tidak ada (hanya export CSV event log).
- **Context switching & Knowledge promotion:** ✅ PASS (`switchChat` save-then-load; `promoteToKnowledge` via proposal).

---

## 4. SISTEM DOMAIN (11–17)

**Temuan arsitektural:** Seluruh 7 sistem domain = "template + frontmatter type + daftar datar di dashboard + node graph". **Tidak ada satu pun sistem FULL.** Tidak ada view khusus per sistem (project detail, kanban task, kalender daily, timeline people, galeri dokumen). Semua pengelolaan entitas hanya lewat editing markdown manual.

| Sistem | Status | Keterangan |
|---|---|---|
| Knowledge | **PARTIAL** | Capture/Organize/Connect/Expand ✓; Review/Archive ✗; lifecycle tanpa UI |
| Project | **PARTIAL** | Template dasar ✓; ID/Description/Documents ✗; milestone ✗; dashboard project ✗ |
| Task | **PARTIAL** | Template dasar ✓; subtask/parent/dependency ✗; Inbox/Review ✗; dashboard terbatas |
| Daily | **PARTIAL** | Satu note/hari ✓; section Summary/Meetings/Journal/Ideas/References ✗; timeline ✗ |
| Template | **PARTIAL** | Built-in+User ✓; Team/Plugin/Inheritance/Versioning ✗; User Name ✗ |
| People | **PARTIAL** | Template+daftar ✓; timeline ✗ (dead code); meeting auto-link ✗; privacy/export ✗ |
| Document | **PARTIAL→MISSING** | Non-md hanya node attachment graph; MIME/size/tags/preview/search ✗ |

### Temuan penting per sistem

- **DOM-1 [HIGH]** **Folder `Archive/` merusak klasifikasi** — `DomainEngine.ts:66-74`, `WorkspaceEngine.ts:108-119`, `GraphEngine.ts:104-115` tidak memetakan `archive/` → apa pun yang dipindah ke `Archive/` jadi type `other`, **hilang dari dashboard**. Lifecycle Archived (spec 12/13/14) tidak bisa dijalankan tanpa memutus klasifikasi. **Saran: hormati status `archived` di frontmatter / petakan archive/.**
- **DOM-2 [HIGH]** **Attachment non-md tidak masuk search index** — `SearchEngine.buildIndex` (`SearchEngine.ts:142-174`) hanya `.md`; attachment hanya node graph (`shared.ts:156-170`). Search dokumen (acceptance criteria 17) GAGAL. **Saran: index attachment by name/path/metadata.**
- **DOM-3 [HIGH]** **Fitur inti Task/Project spec MISSING total** — milestone, subtask/parent, dependency blocked-by/blocks tidak ada di kode mana pun.
- **DOM-4 [HIGH]** **Metadata dokumen hampir tidak ada** — `GraphAttachmentMeta` (`GraphEngine.ts:56-62`) hanya id/path/relativePath/title. Tanpa MIME, size, tags, related notes. Tidak ada preview/thumbnail (hanya `file:openExternal`).
- **DOM-5 [MEDIUM]** **Task `archived` dihitung open di dashboard, done di engine** — `DashboardView.tsx:477-478` vs `DomainEngine.ts:170`. Statistik "Tugas terbuka" salah.
- **DOM-6 [MEDIUM]** **Ctrl+Shift+D error bila daily note sudah ada** — `AppShell.tsx:163` → `WorkspaceEngine.createFile` throw "File already exists" (`WorkspaceEngine.ts:578-579`), alih-alih membuka note. DashboardView menangani, AppShell tidak.
- **DOM-7 [MEDIUM]** **3 struktur daily note berbeda** — Dashboard (builtin-daily), AppShell (frontmatter minimal hardcode `AppShell.tsx:139-167`), TemplatePicker. Inkonsisten.
- **DOM-8 [MEDIUM]** **Variabel `{{username}}` TIDAK ada** — spec 15 mensyaratkan User Name; grep `username|userInfo` kosong.
- **DOM-9 [MEDIUM]** **Plugin tidak bisa menambah template** — acceptance criteria 15 gagal.
- **DOM-10 [MEDIUM]** **TemplatePicker hanya input judul** — var `owner`/`project`/folder tidak pernah diisi (`TemplatePicker.tsx:40-56`) → project/task dibuat dengan owner/project kosong.
- **DOM-11 [MEDIUM]** **Context menu "Note baru" di folder Projects/Tasks/People buat type `note`** (`Sidebar.tsx:515-517` + `noteTemplate` type default note) → entitas tak terklasifikasi.
- **DOM-12 [MEDIUM]** **Priority task free-text tanpa enum** (`TemplateEngine.ts:156`) — spec Critical/High/Medium/Low.
- **DOM-13 [MEDIUM]** **Template "built-in di-seed ke vault tapi tidak dapat diedit lewat UI"** — `listTemplates` men-skip file yang namanya sama builtin (`TemplateEngine.ts:424`) → user mengedit file seed tidak terlihat sebagai template custom.
- **DOM-14 [LOW]** `peopleLinkedTo` dead code (`DomainEngine.ts:232-242`, tak ada caller).
- **DOM-15 [LOW]** `projectsByStatus` dihitung (`DomainEngine.ts:162-163`) tapi tidak pernah ditampilkan di dashboard.
- **DOM-16 [LOW]** Tipe `sop`/`plan`/`meeting` tambahan di luar spesifikasi 7 sistem — tidak terdokumentasi.
- **DOM-17 [LOW]** `domain:list`/`listDomain` API ada tapi tidak ada caller di renderer.

---

## 5. UI/UX & TEMA (23, 24, 25, 26, 27, 29)

### 5.1 Design Tokens (23)

- **UI-1 [HIGH]** **Banyak nilai hardcoded di luar token** — ±100 `font-size: Npx` mentah (termasuk `8px`, `9px`, `9.5px`, `10.5px` — di bawah batas keterbacaan a11y), warna hex mentah (`#c4923a`, `#9aa0b0`, `#8b7cf6`, `#fff`, `#000`, `rgba(...)`) tersebar di globals.css; palet node/edge diduplikasi di TS (`graphShared.ts:71-128` `TYPE_NODE_COLORS`) bukan CSS var (penyebab repaint saat ganti tema); `GraphFiltersPanel.tsx:257-264` 8 swatch hex mentah; `Sidebar.tsx:478` `zIndex: 9999` inline (token tertinggi `--z-toast:300`).
- **UI-2 [MEDIUM]** **Token kategori hilang** — tidak ada `--color-secondary`, `--opacity-*`, `--border-w-*`, skala typography semantik (Display/Heading/Title/Body/Caption).
- **UI-3 [LOW]** Z-index token ada tapi urutan `--z-overlay:90` < `--z-modal:100` tidak tipikal; beberapa z mentah.

### 5.2 UX Flow (24)

- **UI-4 [HIGH]** **Autosave/save editor gagal tanpa feedback** — `editorStore.ts:459-461` `catch { console.error('saveTab failed') }`. User tidak tahu autosave gagal; risiko kehilangan data tanpa disadari. **Saran: toast error + retry otomatis.**
- **UI-5 [HIGH]** **Dashboard load gagal diam** — `DashboardView.tsx:298-300` `catch { console.error }` tanpa indikasi ke user; widget tampak kosong. Melanggar 24 Error Recovery (jelaskan→solusi→retry).
- **UI-6 [HIGH]** **File tree & context menu tidak keyboard-accessible** — `Sidebar.tsx:55-60` item `<div onClick>` tanpa role/tabIndex/onKeyDown; context menu hanya `onContextMenu` (`Sidebar.tsx:322-326`) tanpa Shift+F10/menu key. Melanggar 24 "Keyboard-only workflow" dan 23 a11y.
- **UI-7 [MEDIUM]** **Search error tampil "Tidak ada hasil"** — `SearchModal.tsx:64-66` catch → setResults([]). Saran: state error + Retry.
- **UI-8 [MEDIUM]** **WelcomeScreen tanpa langkah "konfigurasi dasar" & "indeks"** — spec 24 First Launch: Welcome→pilih/buat→**konfigurasi**→**indeks awal**→dashboard. Implementasi langsung open→dashboard; indeks berjalan background tak terlihat.
- **UI-9 [MEDIUM]** **Tidak ada undo** untuk rename file, buat file, apply proposal AI (`ChatPanel.tsx:907-923` langsung tulis disk), clear log AI, perubahan setting. Spec 24 Feedback: "Undo bila memungkinkan".
- **UI-10 [LOW]** StatusBar "Siap · Vault aktif & terindeks" selalu tampil walau embedding masih `indexing`/`loading_model` (`StatusBar.tsx:129-133`) — menyesatkan.
- **UI-11 [LOW]** CommandPalette plugin command hanya toast "belum tersedia" (`CommandPalette.tsx:251-254`).

### 5.3 A11y

- **UI-12 [MEDIUM]** **Dialog tanpa focus trap / restore focus** — `Dialog.tsx:105-111` fokus ke OK/input tapi tidak ada focus trap; focus tidak kembali ke pemanggil saat tutup; tidak ada `aria-labelledby`; Esc dalam dialog tidak menutup (keydown di overlay, `e.stopPropagation` di wg-dialog:137).
- **UI-13 [MEDIUM]** Dashboard list items `<div onClick>` tanpa role/tabIndex (`DashboardView.tsx:468,591`).
- **UI-14 [LOW]** Toast semua varian (termasuk error) hilang 3500ms tanpa tombol aksi (`Toast.tsx:42-50`) — error penting bisa lewat.
- **UI-15 [LOW]** Graph zoom tween/entry animation tidak di-gate reduced-motion (`GraphCanvas.tsx:121`, NODE_ENTRY_MS).

### 5.4 Dashboard (25)

- **UI-16 [HIGH]** **7 dari 10 widget MISSING** — yang ada: Workspace Overview (partial), Recent (partial, tanpa AI/Automation activity), Active Projects (partial), Task Center (partial), Knowledge Insights (partial — hanya orphan), AI Panel (partial). **MISSING total: Today, Automation Monitor, Graph Snapshot, Quick Actions.**
- **UI-17 [HIGH]** **Widget TIDAK customizable** — spec 25: widget bisa dipindah/ubah ukuran/disembunyikan/dikunci/dikustomisasi. Layout `dash-grid` statis, tanpa sistem widget.
- **UI-18 [MEDIUM]** **Tanpa lazy load / refresh parsial** — `loadDashboardData` muat semua sekaligus.
- **UI-19 [MEDIUM]** **AI entry points MISSING** — Morning Brief / Daily Summary / Weekly Review / Workspace Health Report tidak ada.

### 5.5 Graph View (26)

- **UI-20 [HIGH]** **6 dari 7 layout algorithm MISSING** — hanya Force Directed (presets) `graphShared.ts:266`. Hierarchical/Radial/Circular/Timeline/Grid/Manual tidak ada.
- **UI-21 [HIGH]** **3 dari 7 edge type MISSING** — hanya `wikilink/tag/folder/attachment`; Backlink/Parent/Child/Reference/Dependency/Related tidak ada sebagai tipe edge.
- **UI-22 [MEDIUM]** **Search integration tidak penuh** — spotlight/highlight ✓, path manual ✓; tapi **"memusatkan kamera" dari hasil search ✗**, "menampilkan jalur relasi" dari search ✗ (path hanya manual Shift+klik).
- **UI-23 [MEDIUM]** **Clustering komunitas TIDAK ada** — hanya preset force "clustered" + color groups query manual; tidak ada community detection/hub grouping/hide-detail-sementara.
- **UI-24 [LOW]** A11y graph: keyboard nav ✅ sangat lengkap; sr-only list ✅; legend ✅; reduced-motion sebagian (zoom tween tidak di-gate); color-safe sebagian (mode type hanya beda hue, tanpa bentuk sekunder).

### 5.6 Settings (27)

- **UI-25 [HIGH]** **Section Settings MISSING: General, Backup & Restore, Keyboard Shortcuts (rebind), Experimental** — sections ada: ai/index/security/automation/plugins/mcp/appearance/logs/about (`SettingsView.tsx:947-957`).
- **UI-26 [MEDIUM]** **5 lapis arsitektur config tidak ada** — semua setting flat/global, tidak dimodelkan Global/Workspace/User/Plugin/Experimental.
- **UI-27 [MEDIUM]** **Appearance partial** — hanya theme dark/light/system; MISSING Font Size, UI Density, Accent Color, Reduced Motion toggle.
- **UI-28 [MEDIUM]** **Privacy & Security partial** — ada encryption status/credential storage/secrets; MISSING local-only mode, telemetry toggle, session management, data deletion.
- **UI-29 [LOW]** "Debug leak data-theme" di Settings Appearance (`SettingsView.tsx:2327-2332`) — info teknis untuk user.

### 5.7 Theme (29)

- **UI-30 [HIGH]** **High Contrast theme TIDAK ada** — `theme.ts:3` hanya `'dark'|'light'|'system'`; tokens.css tanpa block HC.
- **UI-31 [HIGH]** **Custom theme & Plugin theme API TIDAK ada** — tidak ada `registerTheme`/`addTheme`/`useToken`; tidak ada import custom CSS.
- **UI-32 [MEDIUM]** **Reduced Motion hanya via OS `prefers-reduced-motion`** — tidak ada toggle di Appearance.
- **UI-33 [MEDIUM]** **Adjustable Font Size TIDAK ada** — `--note-font-size: 15px` statis (`tokens.css:55`).
- **Theme engine load/ganti real-time/inherit/fallback:** ✅ (`applyTheme`/`bootTheme`/`subscribeThemePreferenceChange`).

---

## 6. PLATFORM — AUTOMATION, PLUGIN, API, SECURITY, INSTALLER, TESTING (22, 28, 30–34)

### 6.1 Automation (22) — gap terbesar kedua

- **PLT-1 [HIGH]** **4/10 trigger spesifikasi MISSING** — ada `file_created/updated/deleted/workspace_opened/manual/schedule` (`AutomationEngine.ts:10-11`). **Tidak ada `project_created`, `task_completed`, `daily_note_created`, `ai_response_generated`** — tidak ada event dipancarkan dari sumbernya.
- **PLT-2 [HIGH]** **Conditions TIDAK ADA** — spec 22:65-76 (Project Status/Task Priority/File Type/Tags/Metadata/User Confirmation/Custom). `AutomationRule` hanya `{id,name,enabled,trigger,actions}` tanpa field conditions. Semua rule unconditional.
- **PLT-3 [HIGH]** **Actions sangat terbatas (3/8)** — hanya `log/append_to_note/set_frontmatter_tag` (`AutomationEngine.ts:38-41`). Tidak ada create Task/Knowledge, update metadata, add backlink, jalankan AI Agent, notifikasi, jalankan Plugin, arsip.
- **PLT-4 [HIGH]** **Workflow engine TIDAK ada** — hanya eksekusi sequential linear (`AutomationEngine.ts:215-227`); tidak ada multi-step/branch/parallel/retry/rollback (spec 22:109-119).
- **PLT-5 [MEDIUM]** **Scheduling tidak lengkap** — ada interval + slot harian; tidak ada one-shot/bulanan/mingguan eksplisit.
- **PLT-6 [MEDIUM]** **Logging in-memory, tidak persisten** — entry `{at,ruleId,message,ok}` tanpa trigger/status/durasi/error/hasil; hilang saat restart, tanpa rotasi (bandingkan AIEventLog).
- **PLT-7 [MEDIUM]** Plugin tidak bisa memperluas Automation (hanya list/run).
- **PLT-8 [LOW]** `save()` non-atomic; aksi tak dikenal gagal senyap (tanpa default branch log error).
- **CATATAN:** `AutomationEngine.ts:246-252,291` tulis file **tanpa `markSelfWrite`** → infinite loop risk (lihat A1 bagian 2.10).

### 6.2 Plugin SDK (28)

- **PLG-1 [HIGH]** **Hanya 1 dari 9 extension points** — satu-satunya mekanisme `manifest.commands` (`PluginHost.ts:11-19`); command palette hanya menampilkan command untuk discoverability, eksekusi → toast "belum tersedia". Tidak ada Sidebar/Dashboard Widget/Search Provider/Graph View/AI Agents/Automation Actions/Settings/Context Menu.
- **PLG-2 [MEDIUM]** **Lifecycle 8 tahap tidak lengkap** — ada Load/Validate(parsial)/Run/Disable; tidak ada Install flow, Update, Uninstall, Initialize hook, event lifecycle.
- **PLG-3 [MEDIUM]** **Manifest kurang `dependencies` & `minimumSdkVersion`** — tidak ada semver check.
- **PLG-4 [HIGH]** **Manifest `permissions` TIDAK DIENFORCE** — `PluginHost.ts:72-75` hanya memfilter string dikenal, hasilnya tidak pernah dibandingkan dengan operasi. Gate runtime terpisah dialog-based (`jsRunner.ts:103-142`), tidak membaca manifest. Plugin `permissions: []` tetap bisa menulis setelah prompt. **Saran: manifest.permissions = capability awal; dialog = escalation.**
- **PLG-5 [MEDIUM]** **SDK APIs jauh dari spesifikasi** — ada `vault.*/search/graph/automation/settings.get/ui.notify`; tidak ada Knowledge/Project/Task/AI/Event/settings.set.
- **PLG-6 [MEDIUM]** **Event system TIDAK ADA** — plugin tidak bisa subscribe perubahan workspace.
- **PLG-7 [MEDIUM]** **Resource limits tanpa cap memori** — `new Worker(script,{workerData})` tanpa `resourceLimits` (`jsRunner.ts:236-250`); plugin OOM menekan process.
- **PLG-8 [LOW]** Contoh plugin ditulis `enabled: true` di vault baru (`PluginHost.ts:134,163`) — aman karena gate permission, tapi membingungkan vs ADR-0003.

### 6.3 MCP — area paling solid

- **MCP-1 [MEDIUM]** Handler `mcp:saveServers` tanpa validasi array → `servers.filter` melempar TypeError pada payload malformed (`mcp.ts:18-23`, `McpClientManager.ts:218`).
- **MCP-2 [MEDIUM]** **Spawn proses MCP tanpa gate permission** — `mcp:saveServers`/`mcp:testServer`/`connectAll` menspawn proses sewenang-wenang (`command`) tanpa gate `perms.*` (bandingkan plugins/automation yang di-gate). Vault tak tepercaya berisi `mcp.json` akan menspawn saat dibuka. Saran: gate + jangan `connectAll` sebelum user aktifkan.
- **MCP-3 [MEDIUM]** **Secrets MCP (env) plaintext di vault** — `McpServerConfig.env` (`McpClientManager.ts:43`) ditulis mentah ke `.workspacegraph/mcp.json` dan **dikirim balik ke renderer** via `getServers()`. Melanggar spec 33. Saran: enkripsi safeStorage / sanitasi response.
- **MCP-4 [LOW]** Error `connectAll` di-swallow `.catch(()=>{})` (`McpClientManager.ts:518-523`).

### 6.4 API System (30)

- **API-1 [MEDIUM]** **InternalAPI bukan kontrak antar modul** — hanya 3 call site (health + plugin listing). Semua modul import engine langsung. Spec 30:53-77 tidak terpenuhi.
- **API-2 [MEDIUM]** **Versioning tidak nyata** — `InternalAPI.version: '0.5.0'` tidak sinkron app `1.1.0`; tidak ada per-endpoint versioning/deprecation.
- **API-3 [MEDIUM]** **IPC tidak "typed & tervalidasi" menyeluruh** — banyak `any` di `index.d.ts` (`openWorkspace: Promise<any>`, `searchQuery options: any`); handler menerima objek tanpa validasi bentuk (`search.ts:8-10`, `domain.ts:13-14`).
- **API-4 [LOW]** Error handling campur 3 gaya (throw / `{ok:false}` / return mentah) — tidak standar envelope.
- **API-5 [LOW]** **Type declarations basi** — `resolveKerjaVault`/`openKerjaVault` dideklarasikan di `index.d.ts:5-12` tapi tidak ada di implementasi.

### 6.5 Security (33)

- **SEC-1 [MEDIUM]** **Audit logging tidak lengkap** — AI ✅ (`AIEventLog`); Automation ⚠️ in-memory (AUT-6); **config change ✗** (`settings:save` tidak dicatat); **plugin activity ✗** (`plugins:runCommand`/reload/permission grant tidak dicatat); **security error ✗** (tidak ada log terpusat). Saran: perluas AIEventLog jadi event log umum.
- **SEC-2 [MEDIUM]** **Backup protection TIDAK ADA** — spec 33:158-166 + 32:136-147. Tidak ada backup manual/scheduled/versioned/restore point. Safety net hanya `.trash`.
- **SEC-3 [MEDIUM]** **Encryption hanya API keys AI** — credential lain (env MCP, token mcp.json) plaintext (MCP-3).
- **SEC-4 [LOW]** **CSP lemah + sandbox renderer off** — `script-src 'self' 'unsafe-eval' 'unsafe-inline'` (`src/main/index.ts:117`), `sandbox: false` (`:90`). Renderer trusted (AE-4) + XSS terkendali, tapi defense-in-depth kurang; CSP tidak dipisah dev/prod.
- **SEC-5 [INFO]** 8 lapisan sebagian besar hadir; auth (Local Session/API Key) tidak relevan untuk app lokal — sarankan ADR.
- **Verifikasi positif:** PathSandbox ✅ (semua handler file `assertPathInVault` + TOCTOU `reverifyPathInVault`); Secrets scrub ✅; Permissions ADR-0003 default-off ✅; sandbox vm + worker + timeout 15s ✅; MCP write gate berlapis ✅.

### 6.6 Installer (31)

- **INS-1 [HIGH]** **Tidak ada update system** — tidak ada `electron-updater`/`publish` config; installer statis per tag. Tidak ada manual/auto/background/delta/rollback.
- **INS-2 [MEDIUM]** **Migrasi data vault tidak ada** — migrasi settings ada (v0→v1) + backfill DB, tapi tanpa backup config sebelum migrasi + validasi integritas hasil.
- **INS-3 [MEDIUM]** **Uninstall tanpa dialog pilihan** — NSIS default; tidak ada opsi hapus cache/config/data terpisah.
- **INS-4 [MEDIUM]** **Package integrity tanpa checksum publik** — release verifikasi nama+ukuran saja; tidak ada sha256 di rilis; signing opsional.
- **INS-5 [LOW]** Recovery N/A (ikutan INS-1).

### 6.7 File Structure (32)

- **FST-1 [MEDIUM]** **Struktur root tidak mengikuti spec 32** — spec: `Workspace/ Config/ Cache/ Logs/ Plugins/ Themes/ Backups/ Temp/`. Kenyataan: semua config + runtime di `.workspacegraph/` + settings di `userData/`. Tidak ada `Themes/`, `Backups/`, `Temp/`.
- **FST-2 [LOW]** `index.db` di dalam folder config yang sama; user tidak bisa "hapus cache saja".
- **FST-3 [LOW]** Tidak ada `Backups/` (terkait SEC-2).
- **FST-4 [INFO]** Pemisahan Workspace vs Config sudah benar semangatnya (`.workspacegraph` di-scan-skip).

### 6.8 Testing (34)

- **TST-1 [MEDIUM]** **Tidak ada E2E sungguhan** — `qa/ipcHandlers.e2e.test.ts` integration-level main-process; renderer tidak di-E2E.
- **TST-2 [MEDIUM]** **AI evaluation TIDAK ADA** — tidak ada golden-set/context accuracy/prompt regression/output consistency/token efficiency.
- **TST-3 [MEDIUM]** **Cross-platform tidak diverifikasi di CI** — semua job `ubuntu-latest`; Windows path/safeStorage/CRLF hanya teruji saat release.
- **TST-4 [MEDIUM]** **Security testing tidak ada sebagai kategori** — tidak ada fuzz IPC, leak-sweep otomatis, `npm audit` job.
- **TST-5 [LOW]** Performance test informational tanpa threshold gate.
- **TST-6 [LOW]** Coverage tanpa threshold; tidak ada job security di CI.
- **TST-7 [INFO]** Pyramid unit+integration kuat; E2E kosong. Test data repeatable ✅ (test-fixtures + per-worker userData).

---

## 7. INTEGRASI MINICORE

### 7.1 Status saat ini
**MiniCore TIDAK terintegrasi sama sekali** dengan WorkspaceGraph (grep `minicore|createSession|AgentRuntime` di `src/` dan `package.json` = 0 hasil). MiniCore adalah proyek mandiri (`D:\git\minicore`, zero-dependency kernel, 16 file core, ~1.4k baris, 148 test deterministik) — loop `model → tool → observation` dengan budget/compact/recovery/retry/timeout/snapshot.

### 7.2 Overlap / duplikasi

| Fitur | WorkspaceGraph | MiniCore | Duplikasi |
|---|---|---|---|
| Kompaksi deterministik | `contextCompaction.ts` (threshold 0.8, KEEP_RECENT 8) | `compact.ts` `mechanicalCompaction` | **YA — hampir identik** |
| Retry/backoff | `providerRetry.ts` (429/5xx, cap 4000ms) | `recovery.ts` (kategori error, cap 8000ms) | **YA** (MC lebih lengkap) |
| Tool loop | `runStreamInner` rounds | `loop.ts` | **YA** (MC lebih deterministik) |
| Timeout/cancel | watchdog 180s + abortControllers | `session.ts` joinSignals + withAbort | **YA** (MC menjamin settle) |
| Token estimation | tersebar di 4 modul | `tokens.ts` 1 API | **YA** |
| Event | StreamEvent/AIEventLog | EventBus (turn/step/execution) | Parsial komplementer |
| Permission | ROLE_TOOL_PERMISSIONS statis | `PermissionHandler` hook dinamis | Komplementer |
| Validasi args tool | Loose (JSON.parse + cast) | `validateArgs` JSON-schema deterministik | **GAP di WS** |

### 7.3 Fitur MiniCore yang TIDAK ada di AIMiddleware

- **MC-1 [HIGH]** **Tidak ada kompaksi berbasis budget antar-round** — MC evaluasi budget tiap step (`loop.ts:38-53`) + recompact saat medium/high/critical. WS hanya kompak sekali di awal stream (`AIMiddleware.ts:1398-1414`); round loop yang memanjang tidak pernah recompact → risiko `context_length_exceeded` di round 3-4.
- **MC-2 [HIGH]** **Tidak ada `force_compact_and_retry` untuk `context_length_exceeded`** — MC (`recovery.ts:19-20`) kompak lalu retry. WS hanya failover ke provider lain (`providerFailover.ts:20-35`) yang kemungkinan gagal juga.
- **MC-3 [MEDIUM]** **Taksonomi error tidak ter-normalisasi** — MC `ProviderErrorCategory`; WS pakai regex/status string (`isRetryableProviderError`/`shouldFailoverError`) — rapuh terhadap pesan non-standar.
- **MC-4 [MEDIUM]** **Semantik `FinishReason` hilang** — MC memerlukan event `finish`, stream tanpa finish / finish `length` → recovery. WS semua provider selalu emit `done:true`; finish-reason tidak dibedakan → output terpotong dianggap sukses.
- **MC-5 [MEDIUM]** **Turn transaksional** — MC turn gagal/abort/timeout dibuang, tidak bocor ke riwayat (`session.ts:193-218`). WS akumulasi konten parsial + marker `*(cancelled)*` (by design untuk resume) — model berbeda; MC lebih aman dari orphan tool_call.
- **MC-6 [MEDIUM]** **Validasi args tool via JSON-schema tidak ada** — args model dipakai langsung (`nativeCallsToActions`, `parseToolActions`). Prototype-pollution/type-drift berisiko.
- **MC-7 [LOW]** Truncation hasil tool berbasis token (WS chars 8000/12000 tanpa batas token).
- **MC-8 [LOW]** Deadline timeout dijamin walau tool/provider abaikan abort (`withAbort`, `session.ts:278-300`).
- **MC-9 [LOW]** Snapshot isolation (state defensif) vs WS state mutable bersama.
- **MC-10 [LOW]** Isolasi handler event (observer crash tidak putus loop) vs WS callback langsung.

### 7.4 Rekomendasi integrasi konkret

**BISA DIGANTIKAN / DIPAKAI MINICORE:**
1. `contextCompaction.ts` → `compact.ts` + nyalakan evaluasi budget per-round (menutup MC-1/MC-2).
2. `providerRetry.ts` → `recovery.ts` + `ProviderError` (adaptor map error→kategori; failover tetap di lapisan WS).
3. **Inti tool loop `runStreamInner` → `createSession` + `session.run()`** — penggantian paling bernilai:
   - Bungkus `BaseProvider` dengan `ModelProvider` (map `AIStreamChunk` → `ProviderEvent` + finish reason + extension reasoning).
   - Ekspos tool vault + MCP sebagai `Tool` dengan `validateArgs`.
   - `PermissionHandler` membungkus ROLE_TOOL_PERMISSIONS + planMode + MCP write gate.
   - `timeoutMs: 180_000`, `maxSteps: 4` (MAX_TOOL_ROUNDS), `keepRecentTurns` disesuaikan, recovery default.
   - EventBus → translate ke StreamEvent/ToolRunEvent/AIEventLog.
   - Hasil: turn transaksional, kompaksi bertekanan budget, retry compact-on-length, event terisolasi — **dengan 148 test MiniCore sebagai jaring pengaman**.

**HARUS DIPERTAHANKAN (jangan digantikan):**
1. **Proposal write-back** (`AgentTools.ts`) — MiniCore tidak punya konsep write-back/approval.
2. **Per-role permission matrix + plan mode** — jadikan input bagi `PermissionHandler`.
3. **Provider adapters WS** (`BaseProvider` + 7 subclass) — punya listModels/healthCheck/capabilities/pricing/modelDiscovery yang tidak ada di `ModelProvider` MiniCore.
4. **Vault tools & MCP tools** — implementasi aktual milik WS.
5. **ContextEngine/EmbeddingEngine/CitationVerifier/cost/AIEventLog/CheckpointStore/ConversationStore/PromptRegistry** — fitur aplikasi di luar cakupan MiniCore.
6. **Failover & pipeline multi-agent** — MC single-provider; jadikan wrapper membuat sesi MC baru per provider/stage.

---

## 8. PRIORITAS REKOMENDASI

### P0 — Kehilangan data & keamanan (kerjakan dulu)

| ID | Masalah | Solusi |
|---|---|---|
| UI-4 | Autosave gagal tanpa feedback | Toast + retry + indikasi error |
| X1 | Race background index vs watcher | Antre events selama initial sync |
| A1 | Automation infinite loop (tanpa markSelfWrite) | Mark self-write + guard re-entrancy |
| AI-5 | Health check provider palsu | Probe nyata + TTL |
| PLG-4 | Manifest permissions tidak di-enforce | Wire manifest ke permission gate |

### P1 — Gap spesifikasi HIGH

| ID | Masalah |
|---|---|
| CST-1/AI-17 | Sub-agent skip Context Engine (Law 004/005) |
| AI-10 | Middleware menyusun prompt manual (spec 19) |
| DOM-1 | Archive/ merusak klasifikasi domain |
| DOM-2 | Attachment tidak di-index → search dokumen gagal |
| DOM-3 | Milestone/subtask/dependency MISSING |
| UI-1 | Hardcoded styling di luar token |
| UI-6 | File tree/context menu tidak keyboard-accessible |
| UI-16/17 | Dashboard 7 widget missing + tidak customizable |
| UI-20/21 | Graph 6/7 layout + 3/7 edge type missing |
| UI-25 | Settings General/Backup&Restore/Shortcuts/Experimental missing |
| UI-30/31 | High Contrast/Custom/Plugin theme missing |
| PLT-1..4 | Automation 4 trigger/0 kondisi/3 aksi/tanpa workflow |
| PLG-1 | Plugin 1/9 extension point |
| INS-1 | Tidak ada update system |
| MC-1/MC-2 | Kompaksi budget antar-round + force_compact_and_retry (MiniCore) |

### P2 — MEDIUM (bertahap)

| ID | Masalah |
|---|---|
| W2 | scanDirectory sinkron → UI freeze |
| S1/S3/S4 | Metadata search / ranking / tasks index |
| G1/G3/G4/G5 | Node attrs / folder edge / tag isolated / rebuild penuh |
| C1/C2/C3 | Context selection / project-tasks / budget sinkron |
| T1 | Title tanpa YAML-escape |
| DOM-5..13 | Archived statistik, daily 3 struktur, Ctrl+Shift+D, username, plugin template, template picker, context menu, priority enum, template override |
| UI-5/7/8/9/12/13/26-28/32/33 | Feedback dashboard, search error, first-launch, undo, dialog focus trap, settings 5-lapis, appearance, privacy, font size |
| MCP-2/3 | Gate spawn + secrets enkripsi |
| SEC-1/2/3 | Audit log lengkap, backup, enkripsi non-AI |
| INS-2/3/4 | Migrasi, uninstall, checksum |
| API-1/2/3 | Kontrak API, versioning, IPC typed |
| MC-3/4/5/6 | Taksonomi error, finish-reason, turn transaksional, validasi args |

### P3 — LOW / polish

W1, W3, M4, M5, S5, S8, S9, G2, G6, G9, L1, L2, FW1, C4, C5, C6, T2, T3, D1, D2, A2, A3, A4, X2-X5, DOM-14..17, UI-3/10/11/14/15/29, PLG-8, MCP-1/4, API-4/5, SEC-4, INS-5, FST-2/3, TST-5/6.

---

## LAMPIRAN — Verifikasi Positif (dikonfirmasi kuat, tanpa aksi)

- **Path sandbox**: semua handler file (8 operasi) `assertPathInVault` + TOCTOU `reverifyPathInVault` ✅
- **Secrets**: `settings:get` scrub; `security:status` hanya read raw terenkripsi; merge-preserve round-trip aman ✅
- **Permissions**: ADR-0003 default-off plugins/automation terimplementasi ✅
- **MCP**: lifecycle + timeout + write gate berlapis (server `allowWriteTools` + role gate `AgentTools.ts:988-1002`) ✅
- **Plugin sandbox**: vm realm + worker thread + escape test + timeout 15s + terminate ✅
- **AI audit trail**: AIEventLog lengkap (rotasi, prune, CSV, retention) ✅
- **CI**: typecheck/lint/crlf/test/test-flaky/build; flaky gate 2× run ✅
- **Editor**: CodeMirror undo/redo, mtime conflict detection, merge dialog, ViewKeepAlive (keep-alive antar view) ✅
- **Graph**: spatial hash, LOD, delta-frame, throttled SVG commit, keyboard nav lengkap ✅
- **Atomic write**: settings/recent/proposals/checkpoints via `atomicWriteJson` + quarantine ✅

---

## TAUTAN TERKAIT

- **Roadmap utama (tergabung):** `35_Roadmap.md` — Phase 6 = perbaikan hasil audit ini,
  dengan peta temuan per kategori (BUG / FITUR-GAP / SPEC-DRIFT / DEFERRED).
- **Rencana perbaikan per milestone:** `docs/ROADMAP_PENYEMPURNAAN_2026-08-24.md` (M0–M10,
  satu milestone satu commit, gerbang typecheck+test+lint per milestone).
- **Status terkini:** `docs/STATUS_2026-08-24.md`.
- **Keputusan desain:** `docs/adr/` (ADR-0001..0005; calon ADR-0006..0013 di roadmap M0).
