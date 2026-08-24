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
| [ADR-0006](0006-mcp-spawn-permission.md) | MCP server spawn butuh permission eksplisit (MCP-2) | Accepted | 2026-08-24 |
| [ADR-0007](0007-csp-dev-prod-split.md) | CSP production dipisah dari dev, tanpa unsafe-eval/inline (SEC-4) | Accepted | 2026-08-24 |
| [ADR-0008](0008-minicore-bertahap.md) | Integrasi MiniCore bertahap, bukan rombak inti loop (MC-1..10) | Accepted | 2026-08-24 |
| [ADR-0009](0009-secret-plain-fallback.md) | Fallback secret `plain:` tetap, ditandai "tidak terenkripsi" di UI (AI-8) | Accepted | 2026-08-24 |
| [ADR-0010](0010-turn-transaksional-status-quo.md) | Turn transaksional: pertahankan resume marker (MC-5) | Accepted | 2026-08-24 |
| [ADR-0011](0011-id-frontmatter.md) | Frontmatter `id` jadi identity node, fallback hash path (M2/X2) | Accepted | 2026-08-24 |
| [ADR-0012](0012-archived-frontmatter.md) | Arsip = status frontmatter, bukan pindah folder (DOM-1) | Accepted | 2026-08-24 |
| [ADR-0013](0013-electron-updater.md) | Adopsi electron-updater untuk update otomatis v2 (INS-1) | Accepted | 2026-08-24 |

## Format

Mengikuti gaya Michael Nygard (Context / Decision / Consequences) — lihat ADR-0001 sebagai contoh.
Nomor berurutan; satu keputusan per ADR.
