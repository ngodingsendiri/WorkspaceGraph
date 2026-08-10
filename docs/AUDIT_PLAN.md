# AUDIT PLAN — Audit Bertahap per Bagian

**Dibuat:** 2026-08-10
**Tujuan:** audit menyeluruh tapi **scope sempit per sesi** — satu batch = satu modul/fitur, selesai dulu baru lanjut. Menghindari audit lebar yang melelahkan dan dangkal.

## Cara pakai

1. Kerjakan **1 batch per sesi** (jangan lebih — ini kuncinya).
2. Untuk tiap batch: baca kode modulnya, periksa checklist fokus, cari bug/dead code/race/error path yang tak tertangani.
3. Tulis temuan ke **`docs/AUDIT_<tanggal>_<area>.md`** (pola seperti `AUDIT_2026-08-10_save-stop.md`).
4. Setelah selesai: centang status di tabel ini + tautan laporan, lalu jalankan `npm run typecheck` + `npm test` untuk memastikan tidak ada yang rusak.
5. Perbaikan: kumpulkan, kerjakan sebagai commit terpisah, lalu update `docs/TODO_FIX_*.md`.

**Legenda status:** ⬜ belum · 🔄 berjalan · 🔶 sebagian (lihat laporan) · ✅ selesai
**Kedalaman:** 🔹 ringan (baca + cek) · 🔸 sedang (baca + trace alur) · 🔺 dalam (trace penuh + edge cases + usul test)

---

## Wave A — Fondasi (kerjakan dulu: semua bergantung di sini)

| ID | Area | File utama | Fokus audit | Kedalaman | Status |
|----|------|-----------|-------------|-----------|--------|
| AUD-01 | Workspace engine | `src/main/engine/WorkspaceEngine.ts` | open/create/scan; persist settings; recent list; trash path; crash-corruption recovery (commit b4df9db) | 🔸 | 🔶 temuan → `TODO_FIX` WA-3/7/9 |
| AUD-02 | Markdown engine | `src/main/engine/MarkdownEngine.ts` | parse frontmatter/wikilinks/headings; **escape HTML + safeUrl (re-verifikasi XSS CRIT-1)**; template var render | 🔺 | 🔶 temuan → `TODO_FIX` WA-4/5/6/10/11 |
| AUD-03 | File watcher | `src/main/engine/FileWatcher.ts` | event attach/detach; debounce; self-write mark; race saat vault ganti | 🔸 | 🔶 temuan → `TODO_FIX` WA-1/2 |
| AUD-04 | Persistence & settings | `src/main/ipc/shared.ts`, handler `settings.ts` | merge-preserve key; scrub; atomic write; malformed payload | 🔸 | 🔶 temuan → `TODO_FIX` WA-8 (scrub/merge terverifikasi OK) |

## Wave B — Data & Pencarian

| ID | Area | File utama | Fokus audit | Kedalaman | Status |
|----|------|-----------|-------------|-----------|--------|
| AUD-05 | Index DB | `src/main/engine/IndexDatabase.ts` | FTS5 schema; upsert inkremental; rebuild; korupsi DB; thread/worker | 🔸 | 🔶 temuan → `TODO_FIX` WB-1 |
| AUD-06 | Search engine | `src/main/engine/SearchEngine.ts` | hybrid FTS+Fuse; operator `#tag/orphan:/path:/backlink:`; empty→recent; konsistensi hasil | 🔺 | 🔶 temuan → `TODO_FIX` WB-2/5/12 |
| AUD-07 | Graph engine | `GraphEngine.ts`, `GraphLayoutStore.ts` | nodes/edges; tag node; local graph; layout perf; removal degree | 🔸 | 🔶 temuan → `TODO_FIX` WB-3/4/10 |
| AUD-08 | Template & Domain | `TemplateEngine.ts`, `DomainEngine.ts` | seeding template; variabel; project/task/people; checkbox parse | 🔹 | 🔶 temuan → `TODO_FIX` WB-6/7/8/9/11 |

## Wave C — Keamanan (prioritas tinggi)

| ID | Area | File utama | Fokus audit | Kedalaman | Status |
|----|------|-----------|-------------|-----------|--------|
| AUD-09 | Path sandbox | `src/main/security/PathSandbox.ts` | semua handler file/AI wajib `assertPathInVault`; symlink/junction; path traversal; kasus tanpa vault | 🔺 | ✅ cakupan terverifikasi (temuan minor → WC-7) |
| AUD-10 | Secrets store | `src/main/security/SecretsStore.ts` | safeStorage encrypt; key tak pernah ke renderer; scrub; merge-preserve; gagal-decrypt | 🔺 | ✅ terverifikasi (temuan → WC-6, WA-8) |
| AUD-11 | Permissions | `src/main/security/Permissions.ts` | gate aiAccess/aiTools di SEMUA handler; konsistensi pesan; bypass via preload | 🔸 | 🔶 temuan → `TODO_FIX` WC-4/5 |

## Wave D — AI (risiko tertinggi, perlu sesi dalam)

| ID | Area | File utama | Fokus audit | Kedalaman | Status |
|----|------|-----------|-------------|-----------|--------|
| AUD-12 | Provider layer | `providers/*.ts`, `modelDiscovery.ts`, `providerRetry.ts`, `providerFailover.ts` | 6 provider; timeouts; retry; failover; model cache TTL; error mapping | 🔺 | ✅ solid (abort bersih semua provider) |
| AUD-13 | AI middleware | `src/main/ai/AIMiddleware.ts` | stream; tool loop; cancel/abort; **resume checkpoint (R2-2)**; pipeline; konteks injeksi | 🔺 | ✅ solid (temuan minor → AD-1/4) |
| AUD-14 | Agent tools | `src/main/ai/AgentTools.ts` | proposal write-back; sandbox; citation; duplicate action; apply/reject | 🔺 | 🔶 temuan → `TODO_FIX` AD-2 |
| AUD-15 | Konteks & memori | `ContextEngine.ts`, `contextCompaction.ts`, `WorkspaceMemory.ts`, `PromptRegistry.ts` | token budget; prioritas Rules/SOP; kompaksi; scaffold memori | 🔸 | ✅ solid (nit → AD-3) |
| AUD-16 | Percakapan & checkpoint | `ConversationStore.ts`, `CheckpointStore.ts`, handler `chat.ts`/`checkpoint.ts` | simpan/muat; resume; skala besar (stressChat); korupsi file chat | 🔺 | ✅ solid (sanitize id + atomic + quarantine) |
| AUD-17 | Logging & biaya | `AIEventLog.ts`, `cost.ts` | event trail; statistik; ekspor CSV; akurasi cost | 🔹 | ✅ solid |

## Wave E — IPC & Preload (kontrak dua arah)

| ID | Area | File utama | Fokus audit | Kedalaman | Status |
|----|------|-----------|-------------|-----------|--------|
| AUD-18 | Preload bridge | `src/preload/index.ts` + `index.d.ts` | semua 77+ channel ter-tipe; argumen vs handler; validasi; sinkronisasi d.ts | 🔸 | ✅ solid (paritas di-cover sourceContracts; nit → AE-4) |
| AUD-19 | Handler file/workspace/search/graph | `handlers/files.ts`, `workspace.ts`, `search.ts`, `graph.ts` | path sandbox; error path; payload malformed; race vault | 🔺 | 🔶 temuan → `TODO_FIX` AE-1/2/5 |
| AUD-20 | Handler AI/chat/checkpoint | `handlers/ai.ts`, `chat.ts`, `checkpoint.ts` | save/test/add flow (MED-1..3); stream; resume; cancel; ghost key | 🔺 | ✅ (MED-1..3 + Wave D; tidak ada temuan baru) |
| AUD-21 | Platform IPC | `handlers/mcp.ts`, `plugins.ts`, `automation.ts`, `src/main/api/`, `mcp/`, `plugin/` | MCP lifecycle; plugin host; automation rules; InternalAPI health | 🔸 | 🔶 temuan → `TODO_FIX` AE-3/6 |

## Wave F — UI (renderer)

| ID | Area | File utama | Fokus audit | Kedalaman | Status |
|----|------|-----------|-------------|-----------|--------|
| AUD-22 | Editor | `components/editor/*` | CodeMirror; autosave; preview; inspect/backlinks/outline; hotkey tab | 🔸 | 🔶 solid (nit → AF-2) |
| AUD-23 | Graph view | `components/graph/*` (GraphCanvas ±4.2k baris) | canvas2D perf (graphPerf); LOD; hot set; **refactor monolith (utang)**; aksesibilitas | 🔺 | 🔶 temuan → `TODO_FIX` AF-1 (utang + a11y) |
| AUD-24 | Chat panel | `components/chat/*` | streaming; stop gate (LOW-2/3); resume "Lanjutkan"; citations; follow-up; model picker; slash commands | 🔺 | ✅ solid (save-stop + Wave D; XSS aman) |
| AUD-25 | Settings | `components/settings/*` | semua section; save flows; flash ordering (MED-1); add provider (MED-3); tema | 🔸 | 🔶 (MED-1..3 + LOW sudah tercatat) |
| AUD-26 | Shell & dashboard | `layout/*`, `dashboard/*`, `welcome/*`, `search/*` | AppShell hotkeys; bootTheme; welcome; search modal; status bar; dashboard widget | 🔸 | ✅ solid (skim penuh, tidak ada temuan) |
| AUD-27 | Store & hooks | `store/*.ts`, `hooks/*` | chatStore/editorStore/graphStore/workspaceStore; stale closure; unsubscribe | 🔺 | ✅ solid (race handling exemplary) |
| AUD-28 | Styling & aksesibilitas | `styles/globals.css`, `tokens.css` | variabel tema; focus-visible; reduced-motion; responsif; kontras; CRLF/prettier debt | 🔸 | ✅ solid (tema + focus + reduced-motion OK) |

## Wave G — Kualitas & Produk

| ID | Area | File utama | Fokus audit | Kedalaman | Status |
|----|------|-----------|-------------|-----------|--------|
| AUD-29 | QA suites | `src/main/qa/*` | e2e IPC; sourceContracts (brittleness LOW-4); stress; robustness; flaky | 🔸 | ✅ solid (1001 test hijau; anti-flaky by design) |
| AUD-30 | Build, lint, perf | `package.json`, `electron.vite.config.ts`, `graphPerf.test.ts` | lint debt (CRLF); bundle size; startup; CWV | 🔸 | 🔶 temuan → `TODO_FIX` AG-2 (CRLF debt) |
| AUD-31 | Alur produk end-to-end | seluruh app (manual/EDR) | create vault → catatan → graph → search → AI chat → tools → settings; cek UI hidup | 🔹 manual | 🔶 boot+render terverifikasi via preview; alur penuh manual |
| AUD-32 | Installer & packaging | `electron-builder.yml`, `scripts/`, `build/` | NSIS; icon; asar; updater; clean install | 🔹 | 🔶 temuan → `TODO_FIX` AG-1 (exclude .freebuff) |

---

## Urutan yang disarankan

1. **Wave C dulu (keamanan)** — AUD-09/10/11: meski sudah pernah diperbaiki, re-verifikasi murah dan dampaknya paling tinggi.
2. **Wave D AI** — AUD-13 (middleware) + AUD-20 (handler AI/chat): area paling kompleks & paling sering disentuh; lanjutkan dari temuan AUD_2026-08-10 (MED-1..3).
3. **Wave A fondasi** — AUD-02 (XSS re-verifikasi) + AUD-01.
4. **Wave B, E, F, G** — urut sesuai waktu; mulai dari yang paling dipakai harian (AUD-24 chat, AUD-22 editor, AUD-26 shell).

> Alasan urutan: keamanan & AI = risiko tertinggi; fondasi = semua bergantung; UI = paling terlihat tapi paling murah menunda. Sesuaikan kalau ada area yang sedang disentuh fitur baru.

## Kriteria selesai per batch

- [ ] Semua item di kolom **Fokus audit** diperiksa (bukan dibaca sekilas).
- [ ] Temuan (jika ada) dicatat ke `docs/AUDIT_<tanggal>_<area>.md` dengan severity + file + solusi.
- [ ] Status di tabel ini di-update + tautan laporan ditambahkan.
- [ ] `npm run typecheck` dan `npm test` hijau sebelum pindah batch berikutnya.

## Referensi audit yang sudah ada

| Dokumen | Cakupan | Status |
|---------|---------|--------|
| `docs/AUDIT.md` (2026-08-03) | Audit penuh + CRIT-1..3 + 27 bug fixed | ✅ historis |
| `docs/FEATURE_AUDIT.md` (2026-07-22) | 70 fitur PASS / 9 MANUAL | ✅ historis |
| `docs/AUDIT_REVIEW_2026-07-22.md` | Audit lama (HIGH/MED) | ✅ historis |
| `docs/AUDIT_2026-08-10_save-stop.md` | Save/Test provider + two-step stop (commit 8de0361) | ✅ selesai |
| `docs/TODO_FIX_2026-08-10.md` | Backlog masalah yang harus diselesaikan | ⏳ terbuka |
