# Roadmap Status — WorkspaceGraph

**Diperbarui:** 2026-08-08 · Head: `f4d467b` (R2-4 dynamic provider registry)
**Test:** 963/963 hijau · tsc node+web bersih · lint 0/0 (CI) · build produksi OK
**Verdict audit runtime AI:** 7.5/10 — strong mid-tier, approaching top

> Dokumen ini adalah ringkasan status **hidup** dari `docs/IMPROVEMENT_PLAN.md`
> (detail per item ada di sana). Centang/ubah di sini saat fase R2 dikerjakan.

---

## Ringkasan fase

| Fase | Item | Status |
|------|------|--------|
| **P0 — Bug kritis** | 4/4 | ✅ Selesai |
| **P1 — Kualitas AI context** | 6/6 | ✅ Selesai |
| **P2 — Produk & UX** | 6/6 | ✅ Selesai |
| **P3 — Arsitektur & tech debt** | 7/7 | ✅ Selesai |
| **R0 — Standar industri** | 3/3 | ✅ Selesai |
| **R1 — Kualitas agent** | 4/4 | ✅ Selesai |
| **R2 — Ekosistem** | 2/4 | 🟡 **Sedang berjalan** (R2-1 + R2-2 committed; R2-3 diff inline & R2-4 auto-learning tersisa) |

**Bonus di luar plan (sudah delivered):** runtime model discovery (key + baseUrl →
deteksi semua model + badge gratis), AI observability (prompt registry, AIEventLog,
dashboard usage card, panel activity + ekspor CSV + retensi), AI chat UX overhaul
(tool trail, cite-on-hover, model picker, slash commands, diff preview, follow-up,
reasoning streaming), AI kernel (native function calling, vision attachments,
persisted proposals), failover order UI (drag-reorder di Settings), graph perf
(LOD culling, adaptive throttle, overlay debug), CI flakiness gate (2× run),
dynamic AI provider registry (provider = data — tambah/edit/hapus custom
OpenAI-compatible apa pun, form 3-field nama/baseURL/key + daftar model
auto-fetch, konfirmasi hapus key, reset ke provider bawaan, pilihan model per
provider tersimpan lintas sesi). Catatan: fitur ini memakai label kerja "R2-4"
di beberapa commit/test, **bukan** roadmap R2-4 (auto-learning) di bawah.

---

## FASE P0 — Bug kritis ✅

- [x] **P0-1** Timeout 180s mematikan stream yang hang (watchdog `Promise.race`)
- [x] **P0-2** Listener IPC bocor di `streamAIMessage` (registry + cleanupStream)
- [x] **P0-3** Race save vs delete chat (tombstone + lastSavePromise)
- [x] **P0-4** Duplikasi section "Related documents" di rerank async

## FASE P1 — Kualitas AI context ✅

- [x] **P1-1** Kalibrasi rerank FTS vs semantic (min-max normalize + blend 0.55/0.45)
- [x] **P1-2** Semantic hit boleh naik di atas tier non-search (TIER_BONUS)
- [x] **P1-3** `chunkText` dukung CRLF
- [x] **P1-4** Minor chat store (retryLastMessage, clearHistory, cancel auto-save)
- [x] **P1-5** `mdCache` bounded LRU (cap 200) di ChatPanel
- [x] **P1-6** Enforce token budget pasca-rerank

## FASE P2 — Produk & UX ✅

- [x] **P2-1** Streaming Markdown di chat (renderer progresif, escape HTML)
- [x] **P2-2** Token usage & estimasi biaya (tokensUsed + contextTokens di-plumb)
- [x] **P2-3** Search di history drawer
- [x] **P2-4** Fix re-index tanpa DB di EmbeddingEngine
- [x] **P2-5** Hybrid search BM25 + vector di SearchEngine
- [x] **P2-6** Verifikasi sitasi (anti-halusinasi, CitationVerifier + chip ⚠)

## FASE P3 — Arsitektur & tech debt ✅

- [x] **P3-1** Refactor `GraphCanvas.tsx` monolith (±4.257 baris → 3 modul terpisah)
- [x] **P3-2** Behavioral IPC end-to-end tests (handler nyata vs ipcMain mock)
- [x] **P3-3** Soft-delete / trash (`.trash/` + restore + empty + toggle)
- [x] **P3-4** Scheduled automation (cron interval/harian/hari-minggu + UI Settings)
- [x] **P3-5** Full JS plugin sandbox (vm terkebiri + worker + permission gate)
- [x] **P3-6** Vector RAG untuk dashboard/context (toggle semanticContext + progress)
- [x] **P3-7** Bersihkan lint debt (5444 → 0 error/0 warning, CI `--max-warnings 0`)

---

## FASE R0 — Standar industri ✅

- [x] **R0-1** MCP client support (stdio + HTTP, tools native + permission gate, UI)
- [x] **R0-2** Parallel eksekusi read tools (batch ~4, urutan event stabil)
- [x] **R0-3** Retry/backoff 429+5xx per provider (`withProviderRetry` di 5 provider)

## FASE R1 — Kualitas agent ✅

- [x] **R1-1** Auto context compaction (`[Compacted]` ekstraktif, boundary tool-pair aman)
- [x] **R1-2** Provider failover otomatis (401/403/429/5xx → kandidat berikutnya, AIEventLog `failover`)
- [x] **R1-3** Sub-agent / plan mode (`delegate_subagent` + `create_plan` + toggle Plan)
- [x] **R1-4** Stabilkan suite paralel (userData per-worker + e2e per-run + CI 2× flakiness gate)

---

## FASE R2 — Ekosistem 🟡 (checklist hidup)

### R2-1. Cost tracking — P2

- [x] `src/main/ai/cost.ts` — utilitas harga per model (OpenRouter pricing runtime; lainnya tabel statis)
- [x] Estimasi $ per stream (input/output token × harga)
- [x] Akumulasi per sesi → tampil di budget bar & status line
- [x] Test + QA contract

### R2-2. Resume stream terputus — P2

- [x] Checkpoint state stream (message index + round + contextTokens + proposals) ke `.workspacegraph/checkpoints/` (`CheckpointStore.ts` — satu JSON per pesan terpotong)
- [x] Tombol **Lanjutkan** di pesan terpotong (cancelled/timeout/error) — resume menambahkan ke pesan yang sama, tool loop lanjut dari round checkpoint (`resumeFrom`), proposal pending ikut jadi konteks prompt
- [x] Test + QA contract (8 unit CheckpointStore, 9 unit chatStore, integrasi middleware resume round, e2e IPC lifecycle, kontrak source)

### R2-3. Streaming diff inline di chat — P2

- [ ] Kartu proposal menampilkan diff live di tempat (reuse `diffLines`) tanpa buka dialog
- [ ] Tombol Expand tetap buka MergeDialog
- [ ] Test + QA contract

### R2-4. Auto-learning loop — P2 *(masih terbuka — label "R2-4" di commit
provider registry merujuk fitur bonus di atas, bukan item ini)*

- [ ] Ingest episodik (setelah N pesan atau harian)
- [ ] Ringkas pola/aturan baru → append ke AI Memory/ (L1) tanpa duplikasi
- [ ] Test + QA contract

**Kriteria fase R2:** harga $ per sesi terlihat · resume stream test · diff inline ·
AI Memory terisi otomatis.

**Validasi tiap milestone:** `npx tsc --noEmit` (node+web) + `npx vitest run`
(subset lalu penuh) + `npx electron-vite build`.

---

## Riwayat commit utama

| Commit | Isi |
|--------|-----|
| `f4d467b` | Dynamic provider registry: provider = data, add/edit/delete, reset builtin, simpan model default per provider |
| `088fd6d` | R2-1 per-session AI cost tracking dengan runtime pricing |
| `13af322` | R2-2 resume stream terputus dari checkpoint |
| `d7efc9c` | CI 2× flakiness gate (`test:flaky`) |
| `ad23c5b` | R1-3 sub-agent + plan mode |
| `506b40b` | Failover order UI (drag-reorder) |
| `1ed83d9` | e2e userData per-run |
| `031066f` | Fix flakiness: userData per-worker |
| `6e01aff` | AI resilience: parallel reads, retry, MCP, compaction, failover |
| `bda79e6` | Runtime model discovery (free-tier badges) |
| `e581ffc` | AI observability: prompt registry, event log, usage dashboard |
| `b502516` | AI chat UX overhaul (tool trail, cite, model picker, slash, diff, reasoning) |
| `19434ff` | AI kernel: native function calling, vision, persisted proposals |
| `3edcfa8` | P3 batch: graph refactor, trash, scheduler, plugin sandbox, semantic RAG |
