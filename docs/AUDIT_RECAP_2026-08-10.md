# AUDIT RECAP — Rekap Akhir Semua Temuan (2026-08-10)

**Tanggal:** 2026-08-10
**Sumber:** `docs/AUDIT_PLAN.md` (7 wave, 32 batch) + `docs/TODO_FIX_2026-08-10.md` (backlog per item)
**Total:** **52 temuan** — 1 risiko crash (P1) · 12 P2 · 34 P3/Nit · 5 keputusan desain (butuh user)
**Verifikasi:** typecheck ✅ · **1001/1001 test** ✅ · preview hidup di `http://[::1]:5173/` ✅

> **Koreksi jumlah:** ringkasan sebelumnya menyebut "42" — angka itu hanya item berformat daftar. Hitungan persis: 11 temuan audit save-stop (MED/LOW/NIT) + 41 temuan wave (WA/WB/WC/AD/AE/AF/AG) = **52**.

---

## Cara pakai (1 batch per sesi)

1. Kerjakan **satu batch** di bawah (jangan lebih — tiap batch ≤ 1 sesi).
2. Centang item di `docs/TODO_FIX_2026-08-10.md` saat selesai (tanggal + catatan).
3. Setiap batch berakhir: `npm run typecheck` + `npm test` hijau.
4. Ukuran effort: **S** ≤ 30 mnt · **M** ≤ 2 jam · **L** setengah hari+.

---

## Batch 1 — Quick wins (dampak nyata, effort kecil, aman) 🟢

| ID | Masalah | Effort |
|----|---------|--------|
| **WA-1** | FileWatcher `emit('error')` tanpa listener → crash main | S |
| **MED-1** | Flash "disimpan — tes otomatis" tertimpa "Testing…" → tak pernah tampil | M |
| **MED-3** | Add-provider: key hilang saat configure gagal; pesan "Save untuk ulang" menyesatkan | M |
| **AE-1** | Rename tidak re-sync file wikilink-berubah → index basi (ghost link) | M |
| **AG-1** | electron-builder tidak exclude `.freebuff/`, `.github/` → bloat asar | S |
| **AE-3** | `automation:setEnabled` tanpa gate `perms.automation` | S |
| **AD-3** | `prompts.json` ditulis non-atomic | S |
| **AD-4** | `request.model` di-mutasi in-place | S |
| **WC-5** | Field `aiAutoWrite` mati — hapus atau wire dengan sengaja | S |
| **WC-6** | Tidak ada kontrak "handler tidak boleh return getSettings() mentah" | S |
| **WA-9** | `workspace.json` ditulis non-atomic di `openWorkspace` | S |
| **LOW-6** | `catch` di `ai:testProvider` mencampur error configure vs test | S |

## Batch 2 — Konsistensi data & konten (P2, effort M) 🟡

| ID | Masalah | Effort |
|----|---------|--------|
| **WA-2** | Hapus folder (`unlinkDir`) tidak cascade → node anak stale | M |
| **WA-3** | Rename menulis ulang `[[link]]` di dalam code fence → korupsi kode | M |
| **WA-4** | `#tag` di dalam code fence → tag node hantu | M |
| **WA-5** | Heading di dalam code fence → outline palsu | M |
| **WA-6** | Placeholder `§§WIKIn§§`/`§§EXTn§§`/`§§CODEn§§` bentrok dengan teks user | M |
| **WB-1** | `searchByTag` hanya 2000 catatan terbaru → tag match hilang | M |
| **WB-4** | `getHubNodeIds` memakai degree yang mencampur edge tag | S |
| **AF-2** | `file:read` light → wordCount 0/headings [] — verifikasi outline | M |
| **WB-7** | Checkbox `+ [ ]` (GFM) tidak dihitung | S |
| **WA-7** | `renameFile` update link sebelum rename; gagal → dangling | M |
| **WA-8** | `decryptSecret` kembalikan `''` diam-diam saat safeStorage off | M |
| **WA-10** | Fence `~~~` belum didukung renderer | S |
| **WA-11** | Title mentah di frontmatter → YAML rusak (`:`/newline) | M |

## Batch 3 — Perf skala: "scan/rebuild penuh per-edit" (P2, effort M–L) 🔶

| ID | Masalah | Effort |
|----|---------|--------|
| **WB-2** | `addToIndex` rebuild penuh Fuse worker per perubahan file | M |
| **WB-3** | `updateNodeAndEdges` rebuild semua edge wiki per perubahan | L |
| **WB-6** | `getTemplate`→`listTemplates` baca semua file Templates per panggilan | M |
| **WB-8** | `getOverview()` DomainEngine hitung ulang penuh per panggilan | M |
| **WB-5** | Duplikasi ±150 baris `searchSync` vs `search` (risiko drift) | M |

> Tema tunggal: **delta update / debounce**. WB-2 + WB-3 + WB-8 bisa jadi satu paket refactor.

## Batch 4 — Keputusan desain (butuh user; jangan dikerjakan tanpa keputusan) 🟠

| ID | Keputusan | Opsi |
|----|-----------|------|
| **MED-2** | Ghost key: override Test aktif di memori | (a) revert setelah ping · (b) pertahankan + komunikasikan "aktif — belum disimpan" · (c) reset saat Save tanpa key |
| **WC-4** | Default permission semua terbuka (plugins/automation ON) | (a) default OFF untuk instal baru · (b) pertahankan + tampilkan jelas di Settings |
| **AG-2** | Lint debt CRLF (3342 warning prettier) | (a) normalize LF (satu commit besar) · (b) `endOfLine: auto` · (c) terima sebagai non-blocker |
| **WB-12** | Skor FTS semua ≥80 → normalisasi hybrid pipih; semantic jarang unggul | tuning bobot (bukan bug) |
| **AD-2** | Dedup `parseToolActions` global vs "consecutive" (komentar vs perilaku) | samakan perilaku atau dokumentasikan |

## Batch 5 — Aksesibilitas & hardening (P3) 🔵

| ID | Masalah | Effort |
|----|---------|--------|
| **LOW-2** | Stop gate tanpa jalan keluar: Esc tidak me-disarm | M |
| **LOW-3** | `aria-live` countdown berisik (17 update/detik) | M |
| **WC-7** | TOCTOU path sandbox (opsional) | L |
| **AD-1** | Tidak ada handler `unhandledRejection`/`uncaughtException` | M |
| **AE-2** | Duplikasi ±25 baris setup vault `open` vs `create` | M |
| **AE-6** | `mcp:testServer` persist+restore dua kali | M |
| **AE-4** | `window.electron` ekspos raw `ipcRenderer` — dokumentasikan | S |
| **AE-5** | `syncWorkspaceData` fire-and-forget (index parsial setelah buka) | M |
| **LOW-4** | sourceContracts terikat kata komentar (`'intentionally NOT cleared'`) | M |
| **LOW-5** | Label pesan inkonsisten + logika duplikat | M |
| **WB-9** | Sort Domain: tanpa `updated`/`date` terurut PALING ATAS | S |
| **WB-11** | Heuristik `inferKindFromName` bisa salah klasifikasi | M |
| **NIT-1** | `{ok:true}` literal vs `cfg` di `handleSaveProviderRow` | S |
| **NIT-2** | `cancelConfirmLabel(0)` → "Stop? 1" transien | S |

## Batch 6 — Refactor besar (terpisah, butuh perencanaan) 🟣

| ID | Masalah | Effort |
|----|---------|--------|
| **AF-1** | GraphCanvas monolith (±4.3k baris) + aksesibilitas graf minimal | L |
| **WB-3** | (lihat Batch 3) rebuild edge inkremental | L |

---

## Lampiran — Daftar lengkap 52 temuan (urut wave)

| # | ID | Wave | Severity | Effort | Ringkas |
|---|----|------|----------|--------|---------|
| 1 | MED-1 | save-stop | P1 | M | Flash "disimpan" tertimpa |
| 2 | MED-2 | save-stop | P1·desain | M | Ghost key aktif di memori |
| 3 | MED-3 | save-stop | P1 | M | Key hilang saat add-provider gagal |
| 4 | LOW-1 | save-stop | P2 | M | Test abaikan baseUrl editan (tanpa key) |
| 5 | LOW-2 | save-stop | P3 | M | Stop gate tanpa Esc |
| 6 | LOW-3 | save-stop | P3 | M | aria-live berisik |
| 7 | LOW-4 | save-stop | P3 | M | sourceContracts terikat komentar |
| 8 | LOW-5 | save-stop | P3 | M | Label pesan duplikat |
| 9 | LOW-6 | save-stop | P3 | S | catch campur error configure/test |
| 10 | NIT-1 | save-stop | Nit | S | `{ok:true}` literal |
| 11 | NIT-2 | save-stop | Nit | S | "Stop? 1" transien |
| 12 | WA-1 | A | **P1** | S | **Crash: watcher error tanpa listener** |
| 13 | WA-2 | A | P2 | M | unlinkDir tidak cascade |
| 14 | WA-3 | A | P2 | M | Link rewrite menabrak code fence |
| 15 | WA-4 | A | P2 | M | Tag di dalam code fence |
| 16 | WA-5 | A | P2 | M | Heading di dalam code fence |
| 17 | WA-6 | A | P2 | M | Placeholder collision |
| 18 | WA-7 | A | P3 | M | Rename non-atomic vs link update |
| 19 | WA-8 | A | P3 | M | Decrypt gagal diam-diam |
| 20 | WA-9 | A | P3 | S | workspace.json non-atomic |
| 21 | WA-10 | A | P3 | S | Fence `~~~` tidak didukung |
| 22 | WA-11 | A | P3 | M | Title mentah → YAML rusak |
| 23 | WB-1 | B | P2 | M | Tag search cap 2000 |
| 24 | WB-2 | B | P2 | M | Fuse rebuild per-edit |
| 25 | WB-3 | B | P2 | L | Edge rebuild per-edit |
| 26 | WB-4 | B | P2 | S | Hub degree campur tag |
| 27 | WB-5 | B | P3 | M | Duplikasi searchSync/search |
| 28 | WB-6 | B | P3 | M | Template list baca semua per call |
| 29 | WB-7 | B | P3 | S | Checkbox `+ [ ]` tidak dihitung |
| 30 | WB-8 | B | P3 | M | Domain overview recompute penuh |
| 31 | WB-9 | B | P3 | S | Sort domain tanpa date di atas |
| 32 | WB-10 | B | P3 | S | Rename .png→.md tidak konversi node |
| 33 | WB-11 | B | P3 | M | inferKind heuristik |
| 34 | WB-12 | B | P3 | M | Hybrid score pipih (tuning) |
| 35 | WC-4 | C | P1·desain | M | Default permission terbuka |
| 36 | WC-5 | C | P3 | S | aiAutoWrite mati |
| 37 | WC-6 | C | P3 | S | Kontrak "jangan return getSettings()" |
| 38 | WC-7 | C | P3 | L | TOCTOU sandbox |
| 39 | AD-1 | D | P3 | M | Tidak ada unhandledRejection handler |
| 40 | AD-2 | D | P3 | M | Dedup global vs komentar |
| 41 | AD-3 | D | P3 | S | prompts.json non-atomic |
| 42 | AD-4 | D | P3 | S | request.model mutasi in-place |
| 43 | AE-1 | E | **P2** | M | **Index stale setelah rename** |
| 44 | AE-2 | E | P3 | M | Duplikasi setup vault open/create |
| 45 | AE-3 | E | P3 | S | automation:setEnabled tanpa gate |
| 46 | AE-4 | E | P3 | S | raw ipcRenderer terekspos (doc) |
| 47 | AE-5 | E | P3 | M | Index fire-and-forget |
| 48 | AE-6 | E | P3 | M | mcp:testServer write 2× |
| 49 | AF-1 | F | P3 | L | GraphCanvas monolith + a11y |
| 50 | AF-2 | F | P3 | M | light parse wordCount/headings |
| 51 | AG-1 | G | P3 | S | Installer exclude .freebuff |
| 52 | AG-2 | G | P3·desain | M | Kebijakan CRLF lint debt |

---

## Rekomendasi eksekusi

1. **Batch 1 dulu** (12 item, ~1–2 hari) — termasuk satu-satunya risiko crash (WA-1) dan bug UX nyata (MED-1, MED-3).
2. **Batch 2** (konsistensi konten — WA-2..6 saling terkait, bisa satu paket "strip-code + cascade").
3. **Batch 3** (perf skala — satu paket refactor delta-update).
4. **Batch 4** — ambil keputusan desain; jangan dikerjakan sebelum diputuskan.
5. **Batch 5 & 6** — saat ada waktu; AF-1 (GraphCanvas) butuh rencana terpisah.

**Setiap batch selesai → centang di `docs/TODO_FIX_2026-08-10.md` → jalankan typecheck + test → commit terpisah.**
