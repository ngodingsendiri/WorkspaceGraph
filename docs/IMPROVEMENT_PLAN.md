# Rencana Penyempurnaan — WorkspaceGraph

**Dibuat:** 2026-08-04 · Berbasis audit 2 siklus (ContextEngine/EmbeddingEngine + audit menyeluruh)
**Status baseline:** 329 test lulus · typecheck node+web bersih · build produksi OK

> ✅ **Eksekusi 2026-08-04 (1):** P0 (4/4) + P1 (6/6) + P2-2 + P2-3 + P2-4 + P2-5 **selesai** — 339 test (17 file, 2× stabil), typecheck bersih. Commit `0d6cb6d` di-push.
> ✅ **Eksekusi 2026-08-04 (2):** P2-1 (streaming MD) + P2-6 (verifikasi sitasi) + P3-2 (E2E IPC) **selesai dan tervalidasi** — **362 test lulus (20 file, 2× run stabil), typecheck node+web bersih.**

---

## Ringkasan prioritas

| Fase | Isi | Dampak | Estimasi |
|------|-----|--------|----------|
| **P0 — Bug kritis** | Hang stream, listener leak, race save/delete, duplikasi context | User-facing, langsung terasa | ~0.5–1 hari |
| **P1 — Kualitas AI context** | Kalibrasi rerank, tiering, CRLF, minor chat | Kualitas jawaban + token hemat | ~1 hari |
| **P2 — Produk/UX** | Chat streaming MD, token usage, hybrid search, RAG | Nilai pakai harian naik | ~2–3 hari |
| **P3 — Arsitektur/debt** | Refactor GraphCanvas, E2E IPC, trash, cron, plugin sandbox | Stabilitas & fondasi | ~1 minggu+ |

---

## FASE P0 — Bug kritis (kerjakan duluan)

### P0-1. Timeout 180s tidak mematikan stream yang hang — ✅ FIXED
**File:** `src/main/ai/AIMiddleware.ts` (`runStreamInner`)
**Fix:** watchdog `Promise.race` per round — timer memanggil `controller.abort()` + emit chunk done timeout; guard antar-round tetap. Partial content setelah timeout diabaikan via flag `timedOut`.

### P0-2. Listener IPC bocor di `streamAIMessage` (preload) — ✅ FIXED
**File:** `src/preload/index.ts`
**Fix:** registry `streamWatchdogs` + `cleanupStream()`; watchdog 200s menghapus listener jika tidak ada `done`; `cancelAIStream` ikut cleanup. Konsekuensi (cancel tidak menerima trailing chunk) dikompensasi: `chatStore.cancelStream` kini auto-save transkrip parsial.

### P0-3. Race save vs delete chat — ✅ FIXED
**File:** `src/renderer/src/store/chatStore.ts`
**Fix:** tombstone `deletedChatIds` (blokir save setelah delete) + `lastSavePromise` yang di-await `deleteChat` (delete selalu mendarat setelah save in-flight). 3 test baru di `chatStore.test.ts` (race, tombstone, save normal).

### P0-4. Duplikasi section "Related documents" di rerank async — ✅ FIXED
**File:** `src/main/ai/ContextEngine.ts` (`buildContextPackageAsync`)
**Fix:** `head` di-split pada `'\nRelated documents (priority order):'` (bukan END marker) → section lama terbuang, header `estimate used` di-rebuild sekali dengan nilai final. Test regresi baru: marker & `[SEARCH]` tepat 1×.

---

## FASE P1 — Kualitas AI context

### P1-1. Kalibrasi rerank FTS vs semantic (fix no-op) — ✅ FIXED
**File:** `src/main/ai/ContextEngine.ts` (blok rerank)
**Fix:** `minMaxNormalize()` per sumber (best→1, worst→0) lalu blend 0.55/0.45 — semantic kuat kini bisa ungguli FTS lemah, top FTS tetap unggul (FTS sedikit difavoritkan, sengaja). Test diupdate ke nilai realistis (FTS 80/62, cosine 0.6).

### P1-2. Semantic hit boleh naik di atas tier non-search — ✅ FIXED
**File:** `ContextEngine.ts`
**Fix:** ai-memory + system di-pin di depan (governance); sisanya (wikilink/backlink/search/semantic) dirank bersama dengan `TIER_BONUS` kecil — semantic kuat bisa naik di atas wikilink/backlink tanpa memblok materi sistem.

### P1-3. `chunkText` dukung CRLF — ✅ FIXED
**File:** `src/main/ai/EmbeddingEngine.ts` (`chunkText`)
**Fix:** normalisasi `\r\n`→`\n` di awal; test CRLF baru (`\r\n\r\n` → chunk di batas paragraf).

### P1-4. Minor chat store — ✅ FIXED
**File:** `src/renderer/src/store/chatStore.ts`
- `retryLastMessage`: `lastIndexOf` (test baru).
- `clearHistory`: reset `isGenerating` + `activeStreamId` (test baru).
- Bonus: `cancelStream` auto-save transkrip parsial (kompensasi P0-2).

### P1-5. `mdCache` bounded di ChatPanel — ✅ FIXED
**File:** `src/renderer/src/components/chat/ChatPanel.tsx`
**Fix:** LRU cap 200 entri (`mdCacheGet`/`mdCacheSet` dengan refresh recency + eviction).

### P1-6. Enforce token budget pasca-rerank — ✅ FIXED
**File:** `ContextEngine.ts`
**Fix:** loop drop file paling bawah (dari akhir) sampai `tokenEstimate ≤ budget`; tier pin tetap dipertahankan.

---

## FASE P2 — Produk & UX

### P2-1. Streaming Markdown di chat — ✅ FIXED
**File:** `src/renderer/src/components/chat/streamingMarkdown.ts` (+ test)
**Fix:** renderer progresif di thread UI (tanpa IPC churn) — escape HTML dulu (output AI tak tepercaya), tutup konstruk yang belum selesai (`**bold`, fence, bracket), render heading/list/kode/link/wikilink; saat `done` di-replace render penuh via `markdown:render`. Link dibatasi http/https/mailto (no `javascript:`). 9 test baru (escape, progresif, CRLF, wikilink, link aman).

### P2-2. Token usage & estimasi biaya — ✅ FIXED
`AIStreamChunk.tokensUsed` (provider) + `contextTokens` (ContextEngine) di-plumb dari provider → AIMiddleware → preload → chatStore → ChatPanel (ditampilkan di baris role: `· N tok · ctx ~M`). Grok/OpenAI/OpenRouter pakai `stream_options.include_usage`; token di-akumulasi antar tool round.

### P2-3. Search di history drawer — ✅ FIXED
Search box filter judul (case-insensitive) di drawer riwayat; daftar tidak lagi di-slice di fetch (40 dari IPC, slice saat render).

### P2-4. Fix re-index tanpa DB di EmbeddingEngine — ✅ FIXED
**File:** `EmbeddingEngine.indexFile` — saat `db` null kini membandingkan mtime chunk in-memory dan re-index jika berubah.

### P2-5. Hybrid search BM25 + vector di SearchEngine — ✅ FIXED
`search()` async kini memanggil `embeddingEngine.search` saat siap, dedupe by path, min-max normalize per sumber + blend 0.6/0.4, termasuk kasus keyword kosong (semantic-only). `source: 'semantic'` ditambah ke tipe. 3 test baru.

### P2-6. Verifikasi sitasi (anti-halusinasi) — ✅ FIXED
**File:** `src/main/ai/CitationVerifier.ts` (+ test), `AIMiddleware.ts`, `chatStore.ts`, `ConversationStore.ts`, `ChatPanel.tsx`
**Fix:** heuristik grounding pasca-generasi — bandingkan kosakata signifikan jawaban vs isi file tersitasi (score = overlap / total term, threshold 0.08, boost saat judul catatan disebut). Jawaban pendek (<8 term) tak pernah di-flag (hindari false positive). Verifikasi dihitung sekali per stream sebelum done (memoized), budget baca global 60KB agar tidak memblokir main process. UI: chip `refs` yang lemah diberi `⚠` + hint. 5 test baru.

---

## FASE P3 — Arsitektur & tech debt (dari AUDIT.md + temuan)

### P3-1. Refactor `GraphCanvas.tsx` monolith (±4.257 baris) — ✅ FIXED
**File baru:** `graphQuery.ts` (helper murni: group query, spiral seed, force apply), `graphViewData.ts` (`useGraphViewData` + fungsi filter murni + 11 test), `graphSimulation.ts` (`useGraphSimulation`: simRef/nodesRef/linksRef/posCache/spatial + 4 effect), `graphInteraction.ts` (`useGraphInteraction`: hover/tooltip/hit-test + gesture pointer pan/drag/pinch/wheel/path/focus).
**Hasil:** `GraphCanvas.tsx` 4.344 → 3.153 baris; kontrak test `sourceContracts` di-update mengikuti dekomposisi. 373/373 test + typecheck node/web bersih.

### P3-2. Behavioral IPC end-to-end tests — ✅ FIXED
**File:** `src/main/qa/ipcHandlers.e2e.test.ts`
**Fix:** register handler NYATA (files, chat, search, workspace) terhadap mock `ipcMain` capture-only (via `vi.hoisted`), lalu invoke berurutan seperti renderer: `workspace:getState` → `file:create`/`file:read` → `file:write` (+ konflik mtime) → `markdown:render` (escape) → `search:query` → siklus `chat:newId/save/list/load/delete` → PathSandbox tolak akses luar vault. 7 test.

### P3-3. Soft-delete / trash — ✅ FIXED
**File:** `WorkspaceEngine.ts` (`moveToTrash`/`restoreFromTrash`/`emptyTrash` + `TRASH_FOLDER`/`isTrashPath`), `shared.ts` (trash di-exclude dari graph/search/embedding/automation), `files.ts` (`file:delete` → trash, `file:restore`, `file:emptyTrash`), `Sidebar.tsx` (folder `.trash` di tree, menu Pulihkan / Hapus permanen / Kosongkan trash, toast), `SettingsView.tsx` (toggle `trashEnabled`), preload + `index.d.ts`.
**Fix:** delete pindah ke `.trash/` (relative path dipertahankan, collision di-suffix); restore balik ke lokasi asli (collision → `Nama (1).md`); empty trash; config `trashEnabled` default true; `.trash` tampil di file tree tapi di-exclude dari metrik/index. 10 test engine + 1 test E2E round-trip.

### P3-4. Scheduled automation (cron) — ✅ FIXED
**File:** `AutomationEngine.ts` (trigger `'schedule'` + `AutomationSchedule`), `automation.ts` (status scheduler + validasi save), `workspace.ts` (start/stop lifecycle), `SettingsView.tsx` (status scheduler + ringkasan ⏰ per rule + form tambah rule terjadwal).
**Fix:** trigger baru `schedule` dengan `{ every+unit (menit/jam/hari) }` ATAU `{ atTime HH:MM }` + opsional `daysOfWeek` (0=Minggu…6=Sabtu). Tick tiap 60 detik (`setInterval` + `unref`); interval di-seed dari waktu load (interval penuh sebelum fire pertama), rule harian yang slotnya sudah lewat saat load di-mark agar tidak double-fire; `daysOfWeek` memblokir fire di hari lain (interval catch-up di hari pertama yang diizinkan — time-of-day bisa bergeser, intentional). `nextFireTime()` (day-advance untuk hari terblokir, bukan iterasi ratusan kali) + `getSchedulerInfo()` untuk UI; `validateConfig` menolak schedule invalid saat save (atTime invalid, every non-integer/0, keduanya terisi, daysOfWeek di luar 0–6, dan schedule kosong/no-op). UI Settings: status scheduler (aktif/berhenti + next fire), ringkasan ⏰ per rule, form tambah rule terjadwal (interval/harian + hari + aksi log/append). Catatan: `{{date}}` di template tetap UTC (`toISOString`) — konsisten dengan konvensi daily note Ctrl+Shift+D (AppShell), jadi rule harian pagi-pagi di TZ negatif menulis ke catatan tanggal UTC sebelumnya; documented, sengaja tidak diubah. 13 test baru (fake timers): interval, harian 1×/hari, daysOfWeek, seed anti-double-fire, stop, engine/rule disabled, nextFireTime (+day-advance), validate (7 kasus), append_to_note terjadwal.

### P3-5. Full JS plugin sandbox — ✅ FIXED
**File baru:** `src/main/plugin/sandbox.ts` (vm `createContext`/`runInContext` dengan global terkebiri: tanpa `require`/`process`/`Buffer`/`fetch`), `runtime.ts` (jembatan `api.*` postMessage → main), `js-plugin.worker.ts` (worker thread per eksekusi), `jsRunner.ts` (spawn worker + `execApi` vault-scoped + permission gate dialog).
**File diubah:** `PluginHost.ts` (deteksi `manifest.main` → JS plugin, `runCommand` untuk `action:'js'` + `handler`, `revokePermissions`, contoh plugin `example-hello-js`), `plugins.ts` (`plugins:runCommand`, `plugins:revoke`), `electron.vite.config.ts` (entry worker baru), preload + `index.d.ts` (`runPluginCommand`, `revokePluginPermissions`, `onPluginNotify`), `InternalAPI.ts` (flag `js`), `SettingsView.tsx` (badge **JS sandbox**, tombol **Run** per command JS, **Reset izin**), `AppShell.tsx` (`plugin:notify` → toast). `host.ts` lama (import() langsung, tidak aman) dihapus.
**Model keamanan (defense in depth):** vm realm terkebiri → worker thread (terminate saat timeout 15s) → `resolveVaultRelative`/`assertPathInVault` untuk semua akses path → permission prompt dialog untuk op tulis (`vault.write`/`vault.delete`/`automation.runRule`) dengan "Selalu izinkan" per sesi; op baca auto-izinkan. API: `vault.read/write/delete/exists/list`, `search.query`, `graph.getNeighbors/getBacklinks`, `automation.listRules/runRule`, `settings.get` (scrubbed), `ui.notify`. **Hardening (2 siklus review, diverifikasi empiris):** semua builtin host DIHAPUS dari sandbox (host `Promise`/`Math`/`console`/`setTimeout` bisa bocor via `x.constructor('return process')()`) — `module`/`exports`/`api`/`console` dibangun IN-realm via bootstrap dengan sink host tersembunyi di closure + `delete`; handler dipanggil in-realm via `callHandler` dengan ctx JSON-parse dalam realm (plugin tak pernah menerima objek host, bahkan sebagai argumen); bridge api mengembalikan realm promise. 20 test baru: escape require/process/Buffer/constructor (vm-realm + host-builtin + module/exports/api/promise/ctx), timeout loop sinkron (vm) + hang async (worker), baca auto-allow, tulis prompt/deny/always, path luar vault diblokir, handler missing, throw, gate dialog, realm-safe ctx.

### P3-6. Vector RAG untuk dashboard/context — ✅ FIXED
**File:** `ContextEngine.ts` (gate `semanticContext` di `buildContextPackageAsync`), `ai.ts` (broadcast `embeddingEngine.onProgress` → `embedding:progress` ke semua window), preload + `index.d.ts` (`onEmbeddingProgress`), `SettingsView.tsx` (toggle **Semantic context** di section Search Index, simpan `settings.semanticContext`), `DashboardView.tsx` (`SemanticRagCard`: status badge + progress bar live % saat indexing + meta chunk/file + state nonaktif), `globals.css` (`.dash-rag`).
**Fix:** semantic tier (yang sudah ada di rerank async) kini bisa dimatikan user via `settings.semanticContext` (default true) — ContextEngine skip `embeddingEngine.search` saat false; dashboard menampilkan badge progress live (push event, bukan polling) dengan bar persen, dan state nonaktif bila toggle off (hint ke Settings). 2 test ContextEngine baru (off → tanpa semantic tier + search tidak dipanggil; unset → tetap jalan) + kontrak test (`semanticContext`, `onEmbeddingProgress`, push channel `embedding:progress` di-exclude dari parity).
**Review (final):** (1) race snapshot-stale di `SemanticRagCard` — `sawProgress` flag: sekali event progress tiba, snapshot `getEmbeddingStatus` mount-time diabaikan (stream push selalu lebih baru); (2) `registerAIHandlers` di-guard idempoten (`wireEmbeddingProgressBroadcast`) agar double-registration (startup + harness e2e) tidak menumpuk listener onProgress; (3) gap kosmetik indexing-tanpa-progress — bar/`%` pakai `indexedFiles` sebagai lower bound sampai tick pertama.

### P3-7. Bersihkan lint debt — ✅ FIXED
**File:** `eslint.config.mjs` (react-hooks compiler rules `immutability/set-state-in-effect/preserve-manual-memoization` di-scope **hanya ke `src/renderer/src/components/graph/**`** — kanvas imperatif memakainya secara disengaja, sementara komponen biasa tetap dapat proteksi penuh sebagai `warn`; `react-hooks/refs` off global — latest-ref sync pattern; `no-explicit-any` off untuk `preload/index.d.ts` — boundary IPC; `allowConstantExport` react-refresh), `scripts/add-return-types.mjs` (codemod: 149 return type inferred dari TS checker, zero behavior change), `package.json` (`lint: eslint --cache src --max-warnings 0`).
**Fix:** 5444 lint problems (1 error + 5443 warning) → **0 error + 0 warning** (validasi: `npm run typecheck` + `npm run lint` + 414/414 test + `npm run build` hijau). 5112 auto-fix (prettier), ~330 manual: no-control-regex sentinel `\u0000`→`\uE000` (PUA, bukan control char), ~90 no-empty `catch {}` → `/* ignore */`, 4 no-unused-vars (`_err`, hapus import), 2 ban-ts-comment (deskripsi), 159 explicit-function-return-type via codemod + 10 manual (ParsedMarkdown/React.JSX.Element/string), 14 explicit-module-boundary-types (InternalAPI lengkap dengan tipe konkret/`ReturnType`), 55 no-explicit-any (fallbackEmbedder di-type proper di EmbeddingEngine + worker, resolve worker-pool typed, test casts), 10 exhaustive-deps (3 deps unnecessary dihapus, 7 pola kanvas imperatif/init-once di-disable dengan alasan), 7 react-refresh (disable per-baris dengan alasan — API publik helper di file komponen), 9 React Compiler di luar graph (2 reorder deklarasi anti-TDZ di Dashboard/Settings, 7 reset-on-open/sync-derived-state di-disable dengan alasan). **Review final → 4 fix:** (1) build produksi diverifikasi; (2) `scripts/eslint-report.mjs` (scratch) dihapus; (3) compiler rules di-scope ke graph dir saja (bukan global) — proteksi tetap untuk komponen baru; (4) komentar PUSH_ONLY diperjelas (hanya `plugin:notify` yang benar-benar di luar scope scan). CI lint job sekarang fail on any warning via `--max-warnings 0`.

---

## Definisi selesai per fase

| Fase | Kriteria |
|------|----------|
| P0 | Semua 4 item fixed + test regresi (duplikasi, timeout, leak, race) · `npm test` hijau · typecheck bersih |
| P1 | Rerank menghasilkan urutan yang benar-benar campur pada nilai realistis · test CRLF · minor chat fixed |
| P2 | Fitur terpakai: streaming MD, token usage, search history · hybrid search live |
| P3 | GraphCanvas terpecah · E2E IPC hijau di vitest · trash/cron/plugin sandbox delivered |

**Validasi tiap milestone:** `npm run typecheck` + `npm test` (subset dulu via `qa:ai`, `qa:engines`, lalu penuh) + `npm run build` sebelum dianggap selesai.

---

## Urutan eksekusi yang disarankan

1. **P0-1 + P0-2** (hang + leak — satu solusi terpadu: watchdog di middleware + preload)
2. **P0-3** (race delete)
3. **P0-4** (duplikasi rerank) + test regresi
4. **P1-1 + P1-2 + P1-6** (rerank: kalibrasi, tiering, budget) — satu paket
5. **P1-3 s/d P1-5** (minor batch)
6. **P2**, lalu **P3** sesuai prioritas produk

---

# Rencana Penyempurnaan — Runtime AI + Ekosistem

**Dibuat:** 2026-08-07 · Berbasis audit runtime AI (vs standar Cursor / Claude Code / Windsurf / Obsidian)
**Status baseline:** 802 test lulus · verdict **7.5/10 — strong mid-tier, approaching top**

> Skor pilar saat ini: Provider 8.5 · Agent loop 6.5 · Context/RAG 8.0 · Memory 6.5 · Security 9.0 · Observability 9.0 · UI/UX AI 7.5 · Reliability 6.5 · Ekosistem 5.5 · Testing 9.0

## Ringkasan prioritas

| Fase | Isi | Dampak | Estimasi |
|------|-----|--------|----------|
| **R0 — Standar industri** | MCP client, parallel read tools, retry/backoff 429+5xx | Setara Cursor/Claude Code | ~3–4 hari |
| **R1 — Kualitas agent** | Auto compaction, provider failover, sub-agent/plan mode | Obrolan panjang + keandalan | ~3 hari |
| **R2 — Ekosistem** | Cost tracking, resume stream, streaming diff, auto-learning | Nilai pakai harian | ~2–3 hari |

---

## FASE R0 — Standar industri (penghalang klaim "top tier")

### R0-1. MCP client support — P0 ✅ (selesai)
**File:** `src/main/mcp/McpClientManager.ts` (baru) + `src/main/ipc/handlers/mcp.ts` + `AgentTools.ts` + `AIMiddleware.ts` + `SettingsView.tsx`
**Scope:**
- Registrasi server MCP via `.workspacegraph/mcp.json` (stdio: command/args/env + HTTP streamable) + UI Settings (tambah/form/test/hapus, toggle enabled + allowWriteTools)
- Handshake SDK `initialize` → `tools/list` → cache tool per server (timeout connect 15s / call 60s, reconnect, cleanup child saat gagal)
- Tool MCP diekspos sebagai **native tools** + fence docs dengan penamaan `mcp__server__tool`; read (`readOnlyHint`) jalan semua role, selain itu = write → gate role (researcher tak pernah write) + toggle `allowWriteTools` (defense-in-depth, tanpa proposal karena efek eksternal)
- IPC `mcp:getServers/saveServers/testServer/getTools` + preload bridge + lifecycle vault (connectAll/disconnectAll)
**Kriteria:** server MCP nyata (stdio test server) terhubung, tool dipanggil model (integrasi middleware), write tool diblokir saat toggle off / role researcher, prune koneksi saat server dihapus, semua hijau (17 test MCP + 2 integrasi) + QA contract.

### R0-2. Parallel eksekusi read tools — P0
**File:** `src/main/ai/AIMiddleware.ts` (`runStreamInner`)
**Scope:**
- `readPending` dieksekusi paralel (`Promise.all` dgn batch limit ~4) — pertahankan urutan toolRun event & citation collect
- Write tetap sekuensial (proposal perlu urutan deterministik)
**Kriteria:** 4 read serentak (sebelumnya serial ~1s × N) — test mengukur urutan event stabil.

### R0-3. Retry/backoff 429+5xx per provider — P0
**File:** `src/main/ai/providers/BaseProvider.ts` (wrapper bersama) + tiap provider
**Scope:**
- Wrapper `withRetry(attempts=2, backoff base 500ms, jitter)` utk `sendMessage`/`streamMessage` pada status 429/5xx (Retry-After dihormati)
- Gagal total → error chunk jelas (bukan hang); AIEventLog mencatat retries
**Kriteria:** test retry pada 429 (sukses di percobaan ke-2), backoff tidak menembus batas.

---

## FASE R1 — Kualitas agent

### R1-1. Auto context compaction — P1 ✅ (selesai)
**File:** `src/main/ai/contextCompaction.ts` (baru) + `AIMiddleware.ts`
**Scope:**
- Estimasi token per pesan (chars/4 + overhead tool/images); saat history >80% budget model (contextWindow dari map keluarga model − context − 4k reserve) → lipat pesan tertua jadi blok `[Compacted]` **ekstraktif** (satu baris per pesan + topik awal, tanpa panggil model)
- Tail `KEEP_RECENT=8` selalu dipertahankan; boundary lipat tak pernah memecah pasangan assistant `tool_calls` + hasil `tool` (tanpa orphan tool message)
- Chunk status "Context di-compact (N pesan, ±token)" dikirim ke UI
**Kriteria:** 200+ pesan tidak mentok; tail + pasangan tool utuh; test unit (10) + integrasi middleware (2) + QA contract. — catatan: ringkasan berbasis LLM (opsional) bisa menyusul sbg upgrade kualitas, versi ini deterministik & gratis.

### R1-2. Provider failover otomatis — P1 ✅ (selesai)
**File:** `src/main/ai/providerFailover.ts` (baru) + `AIMiddleware.ts` + `AIEventLog.ts`
**Scope:**
- Saat provider aktif gagal terminal (429 habis retry / 401 / 5xx), coba provider terkonfigurasi berikutnya (urutan preferensi dari settings `aiFailoverOrder`, else urutan registrasi; Ollama tidak pernah jadi kandidat — daemon lokal bukan cloud outage)
- Helper murni: `shouldFailoverError` (status 401/403/429/5xx + keyword message; 400/404/422 tidak pernah failover) + `resolveFailoverCandidates`/`failoverCandidatesFor`
- `runStreamWithFailover` (middleware): chain [active, ...kandidat] — tiap attempt restore `request.model` (provider default), error chunk failed attempt di-swallow (diganti nota `*(⚠ failover: X gagal → mencoba Y)*`), aktif provider di-restore di `finally` (failover per-stream, bukan ubah pilihan user); stream_end mencatat provider yang benar-benar melayani
- AIEventLog: kind `failover` baru + field `target` (from→to)
- Wire ke `streamMessage` + tiap stage `runPipelineInner`
**Kriteria (terpenuhi):** 15 unit (klasifikasi, urutan, ollama/unconfigured exclude, order invalid) + 5 integrasi (A 429→B sukses + nota + log + restore; A&B gagal → error B; 400 tidak failover; tanpa kandidat; cancel tak pernah failover) + QA contract. Test: 20 baru, total suite 869/869 hijau, tsc + lint + build bersih.

### R1-3. Sub-agent / plan mode — P1 ✅ (selesai)
**File:** `src/main/ai/AgentTools.ts` (`delegate_subagent` + `create_plan` + `PLAN_TOOLS` + `buildAllowedTools`), `AIMiddleware.ts` (`runSubAgent` + interception loop + `planMode`), `chatStore.ts` + `ChatPanel.tsx` (toggle Plan + /plan) + `handlers/ai.ts` + preload (`planMode`)
**Scope:**
- **Pipeline dinamis**: tool `delegate_subagent {role, task}` — model mendelegasikan sub-task ke sub-agent dengan role-nya sendiri (nested stream; per-role tool gate berlaku pada advertisement DAN eksekusi). Output sub-agent kembali sebagai tool result; proposal + citation yang dibuat sub-agent naik ke parent stream (dock + grounding tetap lengkap). Rekursi dicegah: nested stream selalu `excludeDelegate` → tool delegate tidak pernah diiklankan ke sub-agent
- **Plan mode**: toggle **Plan** di komposer (atau `/plan`). Write tool vault + MCP diblokir di advertisement DAN gate eksekusi; model hanya: (1) analisis, (2) daftar langkah bernomor, (3) panggil `create_plan {title, goal, steps, notes?}` → proposal `Planning/<title>.md` (dock + diff + Apply normal). Kontrak PLAN MODE ada di system prompt round-0 DAN lean prompt (round 1+ tetap plan)
- **Anti-drift**: `buildAllowedTools(role, {planMode, excludeDelegate})` dipakai bersama oleh schema builder, fence builder, DAN executor gate — apa yang model lihat == apa yang boleh dieksekusi
**Kriteria (terpenuhi):** 7 unit AgentTools (toolset plan, anti-rekursi, create_plan proposal + validasi, deny write plan mode, create_plan di luar plan mode ditolak, delegate ke executor statis gagal) + 5 integrasi middleware (filter tools plan, create_plan proposal + stream stop, fence write denial, delegate nested stream dengan role + anti-rekursi, bad role tanpa nested) + QA contract. File terpengaruh: 102/102 test hijau, tsc node+web bersih.

### R1-4. Stabilkan suite paralel — shared fixture + MCP stdio — ✅ FIXED
**File:** `src/test/setup.ts` (userData per-worker)
**Akar masalah:** Semua worker vitest memakai SATU `userData` (mock electron → `test-fixtures/userData`) → `settings.json` + `recent.json` di-tulis paralel oleh beberapa test file → race baca/tulis acak (test berbeda gagal tiap run, lolos saat isolasi). Flake yang tampak "MCP stdio" (McpClientManager + AIMiddleware) sebenarnya dari race yang sama: AIMiddleware membaca `settings.json` via `workspaceEngine` saat file itu sedang ditulis worker lain — bukan dari singleton (vitest mengisolasi module registry per test file, jadi `mcpManager` tidak pernah di-share antar file).
**Fix:**
- `app.getPath('userData')` → `os.tmpdir()/wg-test-userdata-<pid>-<threadId>` — unik per worker (forks pool → pid unik per file; threads pool → threadId unik per worker thread). Setiap test file punya settings/recent sendiri — nol race, nol kebocoran antar file
- Cleanup `afterAll` per worker (tmpdir best-effort)
- MCP stdio memang sudah terisolasi per file (mkdtemp per file + disconnectAll di afterEach/finally) — tidak ada perubahan kode MCP yang dibutuhkan
**Kriteria (terpenuhi):** full suite `893/893` hijau **3× berturut-turut** (sebelumnya: test berbeda gagal tiap run paralel), MCP 73/73 stabil 3×, tsc node+web bersih, lint 0/0. `test-fixtures/userData` tidak lagi dimodifikasi oleh test.

---

## FASE R2 — Ekosistem

### R2-1. Cost tracking — P2
**File:** `src/main/ai/cost.ts` (baru) + `AIMiddleware.ts` + `chatTokenBudget.ts`
**Scope:** utilitas harga per model (OpenRouter pricing runtime; lainnya tabel statis) → estimasi $ per stream (input/output token × harga) + akumulasi per sesi; tampil di budget bar & status line.

### R2-2. Resume stream terputus — P2 ✅ (selesai)
**File:** `src/main/ai/CheckpointStore.ts` (baru) + `AIMiddleware.ts` + `chatStore.ts` + `ChatPanel.tsx` + `handlers/checkpoint.ts` (baru) + preload
**Scope:**
- Checkpoint state stream (**message index + round + contextTokens** + model/role/toggles + proposals) ke **`.workspacegraph/checkpoints/`** (satu JSON per pesan asisten yang terpotong — pola vault-cache sama seperti chats/proposals; `checkpointIdFor` = `{conversationId}_{messageId}` tersanitasi, path-traversal ditolak)
- Ditulis saat stream berakhir **terpotong** (done chunk dgn error / marker `*(cancelled)*` / `*(timeout…)*`) DAN saat user **Cancel** (renderer listener drop → store menulis sendiri dari `activeAssistantMsgId` + `activeStreamRound`)
- Tombol **Lanjutkan** di pesan terpotong (hanya jika ada konten parsial riil setelah marker dibuang): `resumeStream()` memotong ekor percakapan, menambahkan stream ke **pesan yang sama**, mengirim `resumeFrom { round, contextTokens }` → middleware lanjut tool loop dari round checkpoint (`startRound`) alih-alih mulai 0 (round yang sudah terpakai tidak di-billing ulang)
- **Restore state:** toolRuns tetap di pesan (UI), proposal pending dari run yang terputus ikut di-preamble ke prompt (preamble P3-1), checkpoint di-persist via `saveCurrentChat` → tombol bertahan setelah restart
- Checkpoint dihapus saat reply **selesai**, **retry** (mulai ulang), **rephrase** (pesan diganti), atau **clear history**
**Kriteria (terpenuhi):** 8 unit CheckpointStore (persist/load/list/delete/overwrite/traversal/corrupt/no-vault) + 9 unit chatStore (checkpoint error/timeout/cancel, resumeStream append + resumeFrom + tail-drop + proposal preamble + guard, persist/restore, delete saat rephrase) + integrasi middleware (resumeFrom round 3 → 1 panggilan provider vs fresh 4) + e2e IPC lifecycle + kontrak QA. Suite penuh **928/928 hijau**, tsc node+web bersih.

### R2-3. Streaming diff inline di chat — P2
**File:** `src/renderer/src/components/chat/ChatPanel.tsx` + `MergeDialog.tsx`
**Scope:** kartu proposal menampilkan diff live di tempat (reuse diffLines) tanpa buka dialog; tombol Expand tetap buka MergeDialog.

### R2-4. Auto-learning loop — P2
**File:** `src/main/ai/WorkspaceMemory.ts` + `AutomationEngine.ts`
**Scope:** ingest episodik (setelah N pesan atau harian): ringkas pola/aturan baru → append ke AI Memory/ (L1), tanpa duplikasi.

---

## Kriteria tiap fase

| Fase | Kriteria |
|------|----------|
| R0 | MCP tools live di agent loop · parallel reads (event order stabil) · retry 429/5xx berhasil di test · semua hijau + typecheck + build |
| R1 | Obrolan 200+ pesan tanpa timeout · failover test hijau · plan mode tanpa write tool |
| R2 | Harga $ per sesi terlihat · resume stream test · diff inline · AI Memory terisi otomatis |

**Validasi tiap milestone:** `npx tsc --noEmit` (node+web) + `npx vitest run` (subset lalu penuh) + `npx electron-vite build`.

## Urutan eksekusi yang disarankan

1. **R0-2 + R0-3** (parallel reads + retry — lokal di middleware/provider, cepat menang)
2. **R0-1 MCP client** (fitur terbesar — satu batch tersendiri)
3. **R1-1 auto compaction** (butuh data token yg sudah ada)
4. **R1-2 failover + R1-3 plan mode** (satu paket pipeline)
5. **R2-1 s/d R2-4** sesuai prioritas produk
