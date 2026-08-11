# Architecture Decision Records (ADR)

Keputusan desain yang sudah diputuskan dan **tidak boleh direvisi ulang** tanpa alasan kuat.
Audit berikutnya (mis. `improve-codebase-architecture`) harus membaca daftar ini sebelum
menyarankan perubahan yang bertentangan dengan keputusan yang sudah tercatat.

| ADR | Judul | Status | Tanggal |
|-----|-------|--------|---------|
| [ADR-0001](0001-global-dedup-parsetoolactions.md) | Global dedup `parseToolActions` adalah perilaku yang disengaja (AD-2) | Accepted | 2026-08-10 |
| [ADR-0002](0002-ghost-key-test-override.md) | Ghost key: pertahankan override Test + label jujur + reset saat Save (MED-2, b+c) | Accepted | 2026-08-10 |
| [ADR-0003](0003-default-off-permissions.md) | Default permission keamanan: plugins & automation OFF untuk instal baru (WC-4, a) | Accepted | 2026-08-10 |
| [ADR-0004](0004-crlf-lf-policy.md) | Kebijakan line ending: LF + normalize sekali + `.gitattributes` + CI guard (AG-2, a) | Accepted | 2026-08-10 |
| [ADR-0005](0005-hybrid-search-blend.md) | Hybrid search: blend skala absolut 0.6/0.4 + merge per-doc max (WB-12) | Accepted | 2026-08-10 |

## Format

Mengikuti gaya Michael Nygard (Context / Decision / Consequences) — lihat ADR-0001 sebagai contoh.
Nomor berurutan; satu keputusan per ADR.
