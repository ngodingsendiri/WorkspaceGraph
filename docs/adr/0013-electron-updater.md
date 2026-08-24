# ADR-0013: Adopsi electron-updater untuk update otomatis (v2)

- **Status:** Accepted
- **Tanggal:** 2026-08-24
- **Area:** Installer (`electron-builder.yml`, `.github/workflows/release.yml`)

## Context

Audit mendalam 2026-08-24 (INS-1) mencatat tidak ada update system — installer statis per
tag GitHub Release. Spesifikasi 31 mensyaratkan update manual/auto/background/delta/rollback.
Roadmap lama menunda ini.

## Decision

- **Adopsi electron-updater + publish config** untuk v2 (setelah core stabil).
- Prioritas: implementasi di M8 (platform hardening), setelah M1..M7 selesai — update system
  bukan blokir untuk fitur lain.
- `electron-builder.yml` ditambah `publish: { provider: github }` + `electron-updater`
  dependency.
- Rollback: electron-updater mendukung `allowDowngrade` + artefak versi lama di GitHub Releases.
- Delta: NSIS Web Installer + macOS blockmap untuk delta update.

## Consequences

- Positif: pengguna mendapat update otomatis; rollback saat gagal; delta update hemat bandwidth.
- Negatif: effort signifikan (M8 ~3-4 sesi); perlu pengujian cross-platform; signing wajib
  untuk update otomatis di macOS (sudah ada stubs). Update system tidak akan ada sebelum M8.

## Referensi

- Audit: `docs/AUDIT_MENDALAM_2026-08-24.md` INS-1
- Roadmap: M8