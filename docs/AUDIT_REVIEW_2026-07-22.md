# WorkspaceGraph — Audit Review

**Tanggal:** 2026-07-22  
**Path:** `C:\code\WorkspaceGraph`  
**Mode:** Read-only audit sebelum perbaikan

## Ringkasan

WorkspaceGraph adalah prototype advanced untuk knowledge workspace berbasis Electron, React, TypeScript, Markdown, graph, search, dan multi-provider AI. Fondasi produk sudah kuat, tetapi belum production-grade.

| Area | Nilai | Catatan |
|---|---:|---|
| Arsitektur Electron/React | 7.5/10 | Struktur cukup jelas, boundary IPC terlalu longgar |
| Workspace/Markdown | 7/10 | Fondasi baik, preview HTML belum aman |
| Graph/Search | 7/10 | Fitur inti ada, satu QA graph gagal |
| AI/Agent Tools | 7/10 | Proposal write-back ada, validasi permission belum konsisten |
| Security | 5.5/10 | XSS dan sandbox path tidak konsisten |
| Testing/QA | 5.5/10 | QA luas, belum test framework formal |
| Code quality | 4/10 | Typecheck bersih, lint menghasilkan terlalu banyak noise |
| **Keseluruhan** | **6.3/10** | Advanced prototype/internal beta |

## Temuan Prioritas Tinggi

### HIGH-1 — XSS melalui preview Markdown

File: `src/main/engine/MarkdownEngine.ts`, `src/renderer/src/components/editor/MarkdownPreview.tsx`

HTML dibangun dari konten Markdown menggunakan regex lalu dipasang melalui `dangerouslySetInnerHTML`. Input vault dapat menyisipkan HTML, event handler, `javascript:` URL, atau elemen berbahaya.

**Dampak:** vault eksternal atau catatan tersinkron dapat mengeksekusi JavaScript di renderer Electron dan berpotensi memanfaatkan bridge IPC.

**Rekomendasi:** escape input sebelum membuat markup internal, gunakan allowlist tag/attribute, blokir `javascript:`, `data:`, `iframe`, `script`, `style`, dan event handler. Tambahkan regression tests.

### HIGH-2 — Sandbox path IPC tidak konsisten

File: `src/main/ipc/index.ts`

`file:createFolder` dan `file:rename` tidak memvalidasi path terhadap vault. Beberapa handler hanya memvalidasi jika `root` tersedia, sehingga kondisi tanpa workspace berpotensi meneruskan operasi filesystem arbitrary. `path.resolve()` juga perlu diperkuat terhadap symlink/junction.

**Dampak:** create, rename, write, atau delete dapat keluar dari scope vault.

**Rekomendasi:** semua operasi memerlukan workspace terbuka; validasi setiap source/destination dengan helper terpusat; periksa realpath target untuk mencegah symlink escape.

## Temuan Menengah

### MED-1 — QA gagal

`npm run qa` menghasilkan `49 passed, 1 failed` pada invariant `neighbors of Alpha include self+linked`. Implementasi `getNeighbors()` sengaja tidak mengembalikan node pusat, sedangkan assertion lama mengharapkan self.

**Rekomendasi:** tetapkan kontrak API dengan jelas dan ubah test agar sesuai perilaku LocalGraph, atau ubah implementasi bila semua caller membutuhkan center node.

### MED-2 — Lint tidak memiliki scope yang benar

`npm run lint` menghasilkan 7.808 problem, termasuk 951 errors dan 6.857 warnings. ESLint masih membaca artefak generated seperti `scripts/.tmp-*` dan file sementara.

**Rekomendasi:** ignore `build`, `scripts/.tmp-*`, cache, generated output; pisahkan lint source dan formatting check.

### MED-3 — Input IPC belum divalidasi secara runtime

`settings:save`, automation config, graph settings, plugin manifest, conversation payload, dan AI request menerima object dari renderer tanpa schema validation.

**Rekomendasi:** tambahkan validator runtime, batas ukuran, enum, struktur nested, dan batas jumlah item.

### MED-4 — Settings AI tidak selalu reload provider

`ai:configure` memanggil reload provider, tetapi `settings:save` tidak. Perubahan AI melalui general settings dapat tidak tercermin pada provider in-memory.

**Rekomendasi:** gunakan satu fungsi sinkronisasi settings untuk semua jalur penyimpanan.

### MED-5 — Permission `aiAutoWrite` belum ditegakkan

Flag tersedia dalam permissions, tetapi enforcement proposal write-back belum sepenuhnya menggunakannya.

**Rekomendasi:** proposal confirmation wajib jika false; auto-apply hanya bila eksplisit true dan tetap membatasi overwrite/delete.

### MED-6 — Test formal belum terlihat

QA berupa skrip `.mjs`; belum ada test framework proyek yang jelas untuk unit/security/IPC tests.

**Rekomendasi:** tambahkan test framework dan prioritaskan PathSandbox, SecretsStore, Markdown rendering, GraphEngine, AgentTools, dan IPC file handlers.

## Temuan Arsitektur

### ARCH-1 — `src/main/ipc/index.ts` terlalu besar

File mencampur dialog, workspace, filesystem, graph, search, AI, chat, template, domain, automation, plugin, security, dan settings.

**Rekomendasi:** pecah menjadi handler module per domain dan jadikan `index.ts` hanya registrar.

### ARCH-2 — Filesystem sinkron di main process

Scan, read, write, rebuild, dan watcher synchronization menggunakan operasi sync. Vault besar dapat membuat UI freeze.

**Rekomendasi:** gunakan async API/worker untuk indexing besar, progress event, dan debounce burst watcher.

### ARCH-3 — Dokumentasi status tidak sinkron

`docs/AUDIT.md` menyatakan Phase 2–5 delivered, sementara `docs/BLUEPRINT_AUDIT_SYNC.md` masih menyatakan beberapa area belum/partial. Selain itu QA aktual masih gagal.

**Rekomendasi:** tetapkan `docs/AUDIT.md` sebagai status aktual dan update setelah verifikasi green.

## Prioritas Perbaikan

### P0

1. Sanitasi/escape seluruh preview Markdown.
2. Kunci semua IPC filesystem dengan `requireOpenVault()` dan `assertPathInVault()`.
3. Perkuat sandbox terhadap symlink/junction.
4. Perbaiki QA graph sampai green.
5. Tambahkan security regression tests.

### P1

1. Rapikan scope ESLint.
2. Tambahkan runtime validation IPC.
3. Sinkronkan seluruh settings ke subsystem terkait.
4. Pecah `ipc/index.ts`.
5. Tambahkan test framework formal.
6. Uji vault besar dan burst file watcher.

### P2

1. Soft-delete/trash.
2. Audit trail AI write-back dan automation.
3. Native provider tool calling.
4. Vector/hybrid retrieval jika diperlukan.
5. Plugin permission enforcement granular.
6. Packaging test di clean Windows machine.

## Kesimpulan

WorkspaceGraph sudah memiliki fondasi yang layak untuk advanced prototype/internal beta. Sebelum dipakai dengan vault eksternal atau dipublikasikan sebagai production app, blocker utama adalah XSS preview Markdown dan validasi sandbox path IPC. Status dokumentasi harus mengikuti hasil command aktual, bukan klaim audit sebelumnya.
