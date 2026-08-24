# ADR-0008: Integrasi MiniCore bertahap (bukan rombak inti loop)

- **Status:** Accepted
- **Tanggal:** 2026-08-24
- **Area:** AI (`src/main/ai/`), integrasi dengan `D:\git\minicore`

## Context

MiniCore (`D:\git\minicore`) adalah kernel loop `model→tool→observation` deterministik
(148 test) dengan budget-pressure compaction, `force_compact_and_retry`, taksonomi error,
semantik finish-reason, turn transaksional, dan validasi args JSON-schema. WorkspaceGraph
punya loop sendiri di `AIMiddleware.runStreamInner` dengan duplikasi hampir identik
(compaction, retry, timeout). Audit MC-1..MC-10 mencatat fitur yang hilang/lebih baik di
MiniCore. Dua opsi: adopsi penuh `createSession` (rombak besar, risiko regresi) vs bertahap.

## Decision

- **Adopsi bertahap** — setiap komponen MiniCore diadopsi sebagai unit terpisah tanpa
  mengganti inti loop sekaligus, dengan urutan:
  1. Budget-pressure compaction antar-round (menutup MC-1)
  2. `force_compact_and_retry` untuk `context_length_exceeded` (menutup MC-2)
  3. Taksonomi error `ProviderErrorCategory` (menutup MC-3)
  4. Semantik finish-reason (menutup MC-4)
  5. Validasi args JSON-schema `validateArgs` (menutup MC-6)
  6. (Evaluasi lanjutan) turn transaksional `createSession` bila kelima langkah stabil.
- Provider adapters WS (`BaseProvider` + subclass), proposal write-back, per-role permission,
  vault/MCP tools, ContextEngine, EmbeddingEngine, AIEventLog, PromptRegistry — **tidak digantikan**.
- Sumber kode: salin modul MiniCore yang diperlukan ke `src/main/ai/minicore/` dengan lisensi
  tercatat (MiniCore MIT), bukan menambah dependency runtime.

## Consequences

- Positif: nilai terbesar (kompaksi budget, compact-on-length) cepat didapat; risiko rendah;
  148 test MiniCore jadi jaring pengaman.
- Negatif: untuk sementara ada duplikasi kecil antara modul MiniCore yang disalin dan kode
  lama; dibersihkan saat loop penuh diadopsi.

## Referensi

- Audit: `docs/AUDIT_MENDALAM_2026-08-24.md` MC-1..MC-10, §7.4
- Roadmap: M2
