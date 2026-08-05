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
