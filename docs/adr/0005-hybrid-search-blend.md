# ADR-0005: Hybrid search — blend skala absolut 0.6/0.4 + merge per-doc max

- **Status:** Accepted
- **Tanggal:** 2026-08-10
- **Area:** Search ranking (`src/main/engine/SearchEngine.ts`)

## Context

Temuan audit **WB-12** (Wave B, bukan bug): skor keyword FTS di hybrid hampir selalu ≥ 80, lalu
`minMaxNormalize` memipihkan semuanya ke ~1.0 → **semua hasil keyword mendapat bobot identik** dan
semantic search jarang mengungguli. Ranking jadi kurang diskriminatif.

Opsi: tuning bobot vs terima apa adanya.

## Decision

**Tuning: blend skala absolut, tanpa normalisasi min-max.**

1. **Skala absolut:** keyword (FTS 0–100 / Fuse) × **0.6** + semantic (cosine → 0–100) × **0.4**.
   `minMaxNormalize` dihapus (sumber pemipihan).
2. **Semantic kuat menang atas tail keyword lemah:** semantic ≥ ~0.9 (→ ~36–40 poin) mengungguli
   keyword lemah; **exact keyword tetap memimpin** (FTS 90+ → ~54–60 poin).
3. **Merge per-doc `max()` (fix cacat validasi):** dokumen yang muncul di kedua daftar
   (keyword hit lemah + semantic kuat) mempertahankan sinyal terbaiknya via `semBoost` Map —
   bukan dibuang oleh dedupe keyword-first. Tanpa ini, dokumen paling relevan tenggelam
   (contoh nyata saat validasi: `28_Plugin_SDK` semantic 0.629 → posisi 5; setelah fix → #1).

Parameter 0.6/0.4 adalah nilai awal yang divalidasi empiris (harness `scripts/wb12-validation.ts`),
bukan hasil optimasi menyeluruh — dapat dituning ulang jika ranking berubah kebutuhan.

## Consequences

**Positif:**

- Ranking hybrid diskriminatif: exact keyword memimpin, semantic kuat dihormati, keyword lemah
  tidak memuncaki hasil.
- Per-doc max menghilangkan kelas bug "relevan secara semantic tapi tenggelam karena keyword hit
  lemah" (terverifikasi dengan corpus nyata 37 dokumen + MiniLM asli).

**Trade-off / negatif:**

- Bobot absolut berarti skor keyword dan semantic diinterpretasikan pada skala yang berbeda
  (FTS vs cosine) — pemetaan `cosine → 0–100` mengasumsikan skala cosine ~0–1; semantic di bawah
  ~0.5 praktis tidak berpengaruh (disengaja).
- Validasi asli tidak bisa jalan di vitest (`src/test/setup.ts` me-mock `@xenova/transformers` +
  `better-sqlite3`) — butuh harness tsx di luar vitest + env `WG_NO_SEARCH_WORKER=1` (Fuse lokal
  tanpa worker). Ini ketergantungan proses, bukan desain.

## Referensi

- Komentar inline di `SearchEngine.ts` (semBoost, blend, harness validasi) menyebut `ADR-0005` — sinkron (2026-08-11)
- `src/main/engine/SearchEngine.ts` — blend hybrid (~line 437–470: `semBoost`, `0.4 * …`,
  `0.6 * r.score`)
- `scripts/wb12-validation.ts` — harness validasi vault nyata (6 query, OLD vs NEW)
- `src/main/engine/SearchEngine.test.ts` — test per-doc max rescue (weak-kw + strong-sem → #1)
- `docs/TODO_FIX_2026-08-10.md` — entri WB-12 (keputusan ✅ M6 + validasi + catatan mock)
- `docs/FIX_PLAN_2026-08-10.md` — tabel Gate 0 WB-12 ✅ **SELESAI**
