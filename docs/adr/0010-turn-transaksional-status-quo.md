# ADR-0010: Turn transaksional MiniCore — status quo (resume marker) untuk sekarang

- **Status:** Accepted
- **Tanggal:** 2026-08-24
- **Area:** AI (`src/main/ai/AIMiddleware.ts`, `CheckpointStore.ts`)

## Context

Audit mendalam 2026-08-24 (MC-5) mencatat perbedaan model turn:
- MiniCore: turn gagal/abort/timeout **dibuang** dari riwayat (turn transaksional).
- WorkspaceGraph: konten parsial diakumulasi + marker `*(cancelled)*` ditulis ke transcript
  (by design — mendukung resume dari checkpoint `R2-2`).

## Decision

- **Pertahankan status quo (resume marker)** untuk sekarang — model WorkspaceGraph memenuhi
  kebutuhan produk (resume stream yang dipotong, kontinuitas percakapan), dan transisi ke
  model transaksional penuh berisiko kehilangan konteks resume yang sudah dipakai.
- Evaluasi ulang hanya bila adopsi penuh `createSession` (ADR-0008 step 6) terbukti menjaga
  fungsi resume; jika ya, resume memakai checkpoint yang disimpan secara eksplisit
  (bukan marker di transcript).

## Consequences

- Positif: resume tetap berfungsi; tidak ada regresi UX percakapan.
- Negatif: transcript bisa memuat marker cancel yang bukan pesan user/assistant asli —
  diterima; tidak ada orphan tool_call karena proposal/execution selalu berpasangan.

## Referensi

- Audit: `docs/AUDIT_MENDALAM_2026-08-24.md` MC-5
- ADR-0008 (MiniCore bertahap)
