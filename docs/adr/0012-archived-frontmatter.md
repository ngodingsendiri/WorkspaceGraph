# ADR-0012: Arsip = status frontmatter, bukan pindah folder

- **Status:** Accepted
- **Tanggal:** 2026-08-24
- **Area:** Domain (`DomainEngine.ts`, `WorkspaceEngine.ts`, `GraphEngine.ts`)

## Context

Audit mendalam 2026-08-24 (DOM-1) menemukan folder `Archive/` tidak dipetakan oleh
`fileTypeFromPath` — file yang dipindah ke `Archive/` kehilangan tipe domain (jadi `other`),
hilang dari dashboard. Spesifikasi 12/13/14 mensyaratkan lifecycle `Archived` (tetap dapat
diakses, diklasifikasikan, dan di-dashboard sesuai tipe asal).

## Decision

- **Arsip = status frontmatter** (`status: archived`), bukan pindah folder.
- `DomainEngine.overview` menghitung item `archived` terpisah dari item aktif (dapat
  di-filter toggle di dashboard).
- `fileTypeFromPath` dan `DomainEngine.typeFromParsed` — Archive/ tidak dipetakan khusus;
  folder `Archive/` tidak dihapus tapi tidak lagi menjadi satu-satunya cara "arsip".
- .trash tetap untuk penghapusan (bukan arsip).

## Consequences

- Positif: arsip tidak memutus klasifikasi domain; dashboard bisa menampilkan/menyembunyikan
  item arsip; konsisten dengan lifecycle spec 12/13/14.
- Negatif: perlu update `DomainEngine` + dashboard untuk hormati `status: archived` sebagai
  filter (bukan pengecualian). Folder `Archive/` yang sudah ada tidak otomatis diproses.

## Referensi

- Audit: `docs/AUDIT_MENDALAM_2026-08-24.md` DOM-1, CST-2
- Roadmap: M4a (domain klasifikasi)