# ADR-0011: Frontmatter `id` menjadi identity node (fallback hash path)

- **Status:** Accepted
- **Tanggal:** 2026-08-24
- **Area:** Graph/Markdown/Workspace (`GraphEngine.ts`, `MarkdownEngine.ts`, `WorkspaceEngine.ts`)

## Context

Audit mendalam 2026-08-24 (M2/G-x) mencatat frontmatter field `id` (spec 06) tidak dibaca —
identity node selalu hash path. Konsekuensi: rename file = ganti id → backlink/edge lama
terputus, dan `[[Alias]]` resolusi tidak stabil terhadap rename. Spec 08 menuntut node id
stabil; spec 06 mencontohkan `id: project-alpha`.

## Decision

- **Hormati frontmatter `id` bila ada** sebagai identity node (kanonik).
- Fallback: hash path (perilaku saat ini) bila `id` kosong — kompatibel mundur.
- `MarkdownEngine.parseFile` mengisi `frontmatter.id` (string, sanitasi, tanpa spasi/path).
- `generateId(filePath)` tetap dipakai untuk path-hash; resolusi id memakai `maps.id → node`.
- Rename file dengan `id` stabil → node id TIDAK berubah; graph/backlink/search kontinu.

## Consequences

- Positif: rename-safe identity; backlink bertahan; selaras spec 06/08.
- Negatif: dua sumber id (frontmatter vs path) — perlu aturan prioritas tegas (frontmatter
  menang) + test kontrak agar tidak drift (lihat X2: satu helper bersama).

## Referensi

- Audit: `docs/AUDIT_MENDALAM_2026-08-24.md` M2, X2
- Roadmap: M7 (engine hardening)
