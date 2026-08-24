# ADR-0006: MCP server spawn butuh permission eksplisit

- **Status:** Accepted
- **Tanggal:** 2026-08-24
- **Area:** MCP (`src/main/mcp/McpClientManager.ts`, `src/main/ipc/handlers/mcp.ts`)

## Context

Audit mendalam 2026-08-24 (MCP-2) menemukan `mcp:saveServers`, `mcp:testServer`, dan
`connectAll()` dapat mengonfigurasi & menspawn proses sewenang-wenang (`command` + `env`)
tanpa gate permission `perms.*` — tidak konsisten dengan model permission ADR-0003
(plugins & automation default OFF). Vault dari sumber tak tepercaya berisi
`<vault>/.workspacegraph/mcp.json` akan menspawn proses saat dibuka.

## Decision

- Spawn MCP **di-gate permission eksplisit**: `connectAll()` saat open vault hanya berjalan
  bila permission MCP aktif (diturunkan dari `aiTools`, mengingat MCP = tool AI eksternal).
- `mcp:saveServers` / `mcp:testServer` menolak konfigurasi server baru bila permission
  MCP mati.
- UI Settings → MCP menampilkan status permission + tombol aktifkan (sama dengan
  Security → Automation/Plugins).

## Consequences

- Positif: vault tak tepercaya tidak lagi menspawn proses MCP saat dibuka; konsisten
  dengan postur default-off ADR-0003.
- Negatif: pengguna baru perlu mengaktifkan MCP di Settings sekali (biaya satu klik,
  sepadan dengan keamanan).

## Referensi

- Audit: `docs/AUDIT_MENDALAM_2026-08-24.md` MCP-2
- ADR-0003 (default-off permission)
- Roadmap: `docs/ROADMAP_PENYEMPURNAAN_2026-08-24.md` M8 (diterapkan bersama)
