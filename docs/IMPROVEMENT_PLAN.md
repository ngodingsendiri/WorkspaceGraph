# Rencana Penyempurnaan — WorkspaceGraph

**Dibuat:** 2026-08-04 · Berbasis audit 2 siklus (ContextEngine/EmbeddingEngine + audit menyeluruh)
**Status baseline:** 329 test lulus · typecheck node+web bersih · build produksi OK

> ✅ **Eksekusi 2026-08-04:** P0 (4/4) + P1 (6/6) + P2-2 + P2-3 + P2-4 + P2-5 **selesai dan tervalidasi** — 339 test lulus (17 file, 2× run stabil), typecheck bersih.
> Sisa: P2-1 (streaming MD), P2-6 (verifikasi sitasi), dan P3 (fitur & arsitektur besar) — lihat bagian masing-masing.

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

### P2-1. Streaming Markdown di chat
Saat ini pesan streaming dirender plain (pre-wrapped) untuk hindari IPC churn; hasil akhir baru di-markdown-kan. Penyempurnaan: render markdown parsial ringan (bold/italic/code) via library kecil di renderer (mis. `marked` + sanitizer) untuk streaming, fallback ke `markdown:render` saat done.

### P2-2. Token usage & estimasi biaya — ✅ FIXED
`AIStreamChunk.tokensUsed` (provider) + `contextTokens` (ContextEngine) di-plumb dari provider → AIMiddleware → preload → chatStore → ChatPanel (ditampilkan di baris role: `· N tok · ctx ~M`). Grok/OpenAI/OpenRouter pakai `stream_options.include_usage`; token di-akumulasi antar tool round.

### P2-3. Search di history drawer — ✅ FIXED
Search box filter judul (case-insensitive) di drawer riwayat; daftar tidak lagi di-slice di fetch (40 dari IPC, slice saat render).

### P2-4. Fix re-index tanpa DB di EmbeddingEngine — ✅ FIXED
**File:** `EmbeddingEngine.indexFile` — saat `db` null kini membandingkan mtime chunk in-memory dan re-index jika berubah.

### P2-5. Hybrid search BM25 + vector di SearchEngine — ✅ FIXED
`search()` async kini memanggil `embeddingEngine.search` saat siap, dedupe by path, min-max normalize per sumber + blend 0.6/0.4, termasuk kasus keyword kosong (semantic-only). `source: 'semantic'` ditambah ke tipe. 3 test baru.

### P2-6. Verifikasi sitasi (anti-halusinasi)
Context sudah menyediakan citations; tambahkan heuristik: klaim model tanpa bukti dari context ditandai "(tidak didukung context)" — atau minimal tool `search` menambahkan citation otomatis (sudah ada sebagian).

---

## FASE P3 — Arsitektur & tech debt (dari AUDIT.md + temuan)

### P3-1. Refactor `GraphCanvas.tsx` monolith (±4.257 baris)
Pecah ke modul: physics (forces), render (d3), interaksi (pan/zoom/click), UI overlay (filter/search/legend). Target: komponen <800 baris + hook `useGraphSimulation`/`useGraphInteraction`.

### P3-2. Behavioral IPC end-to-end tests
`qa-api-sequential.mjs` dihapus saat migrasi vitest; alur handler nyata via `InternalAPI` kini manual. Pulihkan sebagai test vitest dengan mock `ipcMain` atau test terpisah `electron-mock-ipc`.

### P3-3. Soft-delete / trash
Folder `.trash/` + tombol restore di file tree; delete pindah ke trash dulu (bisa di-skip config).

### P3-4. Scheduled automation (cron)
`AutomationEngine` sudah ada trigger manual; tambah scheduler (interval/day-of-week) + UI.

### P3-5. Full JS plugin sandbox
`PluginHost` deklaratif; tambah runner plugin JS dengan sandbox (vm2/isolated-vm) + permission prompt.

### P3-6. Vector RAG untuk dashboard/context
Embedding sudah jalan (index + search); integrasikan sebagai sumber context "semantic tier" yang bisa di-toggle user + progress badge (status sudah ada).

### P3-7. Bersihkan lint debt (299 warnings)
Bukan blocker, tapi target bertahap: 0 error + warning turun ke <50 dalam 2 siklus.

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
