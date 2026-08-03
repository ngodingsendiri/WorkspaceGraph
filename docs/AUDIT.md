# WorkspaceGraph — Full Audit

**Tanggal:** 2026-08-03 (update setelah siklus perbaikan kritis)  
**Path:** `C:\code\WorkspaceGraph`  
**Stack:** Electron 39 + electron-vite + React 19 + TypeScript + Zustand + CodeMirror + D3 + multi-provider AI  

**Hierarki spek:**  
1. `00_Constitution.md` … `35_Roadmap.md` = hukum / produk  
2. `docs/BLUEPRINT_AUDIT_SYNC.md` = sinkron blueprint ↔ kode  
3. Dokumen ini = **fakta implementasi** (bukan spek)  
4. UI: **clean seperti Obsidian**

**Verifikasi otomatis (2026-08-03, dijalankan ulang):**
| Pemeriksaan | Hasil aktual |
|---|---|
| `npm run typecheck` | ✅ bersih |
| `npm test` (vitest) | ✅ **132 passed / 132** (6 file: Workspace, Markdown, Graph, Search, Embedding, Secrets) |
| `npm run qa` | ✅ **semua fase hijau** (runtime · engines · phase2–5 · graph-view · adversarial, exit 0) |
| `npm run lint` | ⚠️ 2 errors + 5.534 warnings (5.230 fixable prettier) — **debt kualitas, bukan blocker** |
| `npm run build` | ✅ production build sukses (diverifikasi sebelumnya) |

> **Catatan penting:** klaim versi dokumen lama (`126/126 QA`, `0 errors, 175 warnings`) **tidak lagi akurat** — `npm run qa` sempat merah (2 kegagalan + fase-fase tersembunyi di balik crash rantai), dan sekarang sudah hijau kembali setelah perbaikan 2026-08-03 (lihat §2).

---

## 1. Ringkasan eksekutif

| Aspek | Status | Skor |
|-------|--------|------|
| Fondasi Electron/React | Solid | **8.5/10** |
| Vault Markdown | Open/create, tree CRUD, templates | **8/10** |
| Graph + backlinks/outgoing | Engine + panel + local graph | **8/10** |
| Search (FTS5 + Fuse + operators) | empty→recent, `#tag`, `orphan:true`, `backlink:` | **7.5/10** |
| AI multi-provider | Keys persist (encrypted) + load on startup | **8/10** |
| Context retrieval | Search + active + neighbors; Rules/SOP priority | **6.5/10** |
| UX Obsidian-feel (Phase 1) | Editor/preview/inspector/hotkeys/ctx menu | **7.5/10** |
| **Phase 2+ (index.db, agent tools, projects)** | Roadmap debt — **bukan bug** | — |
| **Siap ganti Obsidian full?** | Core vault harian **ya**; AI worker write-back & vector **belum** | **7/10** |

---

## 2. Perbaikan kritis 2026-08-03 (dari audit mendalam)

### CRIT-1 — QA suite merah → hijau ✅
`npm run qa` gagal 2 kasus di `scripts/qa-runtime.mjs` (padahal dokumen lama mengklaim 126/126):
1. **`graph nodes=5 got 9`** — `buildFromParsedFiles()` sekarang selalu membangun tag node; asersi QA lama tidak diupdate.
2. **Crash `TypeError`** — `search.search()` async dipanggil tanpa `await` di script QA.

Karena crash di fase pertama, seluruh rantai `&&` berhenti → angka "126/126" tidak pernah terverifikasi ulang. Diperbaiki: `await` ditambahkan, asersi memakai `realNodeCount`, dan kegagalan tersembunyi di fase berikutnya ikut dituntaskan (`qa-phase2` "backlink operator" regex `backlinks?:`, 3 asersi statis usang di `qa-graph-view`).

### CRIT-2 — API key plaintext bocor ke renderer → ditutup total ✅
`settings:get` sebelumnya mengembalikan **key terdekripsi** ke proses renderer. Sekarang:
- `settings:get` men-scrub semua key → hanya `apiKeySet: true/false`.
- `settings:save` melakukan **merge-preserve** (key lama dipertahankan saat field kosong; marker internal dibersihkan sebelum persist).
- **Renderer tidak pernah menerima key tersimpan** — UI menampilkan placeholder "saved" dan hanya mengirim key baru saat user mengetiknya.
- Regression tests baru: `src/main/security/SecretsStore.test.ts` (5 test).

### CRIT-3 — Dynamic `require` TemplateEngine → static import ✅
`WorkspaceEngine.ts` memakai `require('./TemplateEngine')` yang gagal diam-diam di vitest. Diubah ke static import; efek sampingnya seeding template kini benar-benar berjalan (test `getAllMarkdownPaths` diupdate dari hitungan absolut → inklusi/eksklusi).

### Regresi yang terbongkar & diperbaiki
- `WorkspaceEngine.test.ts`: asersi usang yang mengasumsikan seeding template gagal.
- `scripts/qa-phase2.mjs`, `scripts/qa-graph-view.mjs`: asersi statis tidak sinkron dengan kode pasca-refactor `GraphCanvas`.

---

## 3. Bug ditemukan & diperbaiki (siklus sebelumnya)

| # | Bug / gap | Status |
|---|-----------|--------|
| 1 | Frontmatter date → `Date` object crash `localeCompare` di recent notes | ✅ fixed `coerceDate` |
| 2 | Create vault tidak attach file watcher listeners | ✅ `attachFileWatcher` shared |
| 3 | API keys AI tidak persist / tidak load saat startup | ✅ `loadSettingsIntoProviders` + save on configure |
| 4 | Chat history mengirim user message ganda + stub assistant kosong | ✅ `historyForApi` |
| 5 | Klik file di tree tidak pindah ke Editor view | ✅ `setActiveView('editor')` |
| 6 | New note tanpa frontmatter template | ✅ template knowledge/daily |
| 7 | Recent notes hanya frontmatter (abaikan mtime file) | ✅ `stampMtime` |
| 8 | `removeNode` tidak turunkan degree neighbor | ✅ fixed |
| 9 | Context snippet terlalu pendek; Rules/SOP tidak diprioritaskan | ✅ cap + priority path |
| 10 | File tree tanpa context menu rename/delete/new | ✅ ctx menu |
| 11 | Inspector tanpa outline headings | ✅ Outline section |
| 12 | Hotkeys incomplete (N / daily / P / E) | ✅ AppShell |
| 13 | Status bar tanpa word count / dirty | ✅ fixed |
| 14 | Settings hanya API key (no theme/Ollama URL) | ✅ Appearance + Ollama base URL |
| 15 | Dashboard metrics stale setelah edit | ✅ `onGraphUpdated` refresh |
| 16 | Demo path hardcoded salah | ✅ dihapus (create vault) |
| 17 | XSS: Markdown preview menerima HTML mentah | ✅ `escapeHtml()` + `safeUrl()` allowlist |
| 18 | Sandbox: `file:createFolder` tanpa validasi vault | ✅ `requireOpenVault()` + `assertPathInVault()` |
| 19 | Sandbox: `file:rename` tanpa validasi vault | ✅ validasi `oldPath` + `newPath` |
| 20 | Sandbox: `file:read` hanya validasi jika `root` ada | ✅ `requireOpenVault()` wajib |
| 21 | Sandbox: symlink/junction escape vault | ✅ `realpathSync.native()` check |
| 22 | QA: `getNeighbors` assertion keliru (ekspektasi self) | ✅ assertion diperbaiki sesuai kontrak API |
| 23 | QA: regression test XSS tidak ada | ✅ added `escape unsafe markdown HTML` + `block unsafe markdown URLs` |
| 24 | Lint: lint scan seluruh project (7.808 noise) | ✅ scope ke `src/` + ignore generated |
| 25 | **QA runtime crash (async tanpa await) + asersi tag-node usang** | ✅ 2026-08-03 |
| 26 | **API key terdekripsi dikirim via `settings:get`** | ✅ 2026-08-03 scrub + merge-preserve + tests |
| 27 | **Dynamic `require` TemplateEngine error di vitest** | ✅ 2026-08-03 static import |

---

## 4. Matriks fungsi (uji berurutan)

| Fungsi | Hasil audit |
|--------|-------------|
| Open vault | ✅ |
| Create vault + standard folders | ✅ |
| File tree open / ctx new-rename-delete | ✅ |
| Markdown parse / write / autosave | ✅ |
| Split preview + wikilink click | ✅ |
| Backlinks / outgoing / outline | ✅ |
| Graph global + filter + local | ✅ |
| Search fuzzy / tag / orphan / recent / backlink | ✅ |
| Daily note create | ✅ |
| Dashboard metrics (notes vs files, orphans) | ✅ |
| AI configure persist + context inject | ✅ |
| Chat append to note | ✅ |
| Theme dark/light/system | ✅ tokens |
| Keamanan key AI (encrypted, scrub, merge-preserve) | ✅ 2026-08-03 |

---

## 5. Phase 2 (delivered) — Search Index + Context

| Item | Status |
|------|--------|
| `.workspacegraph/index.db` FTS5 | ✅ `IndexDatabase.ts` |
| Hybrid search FTS + Fuse | ✅ `SearchEngine` |
| Operators `#tag` `orphan:true` `backlink:` `path:` | ✅ |
| Incremental upsert on watch | ✅ |
| Rebuild + stats in Settings | ✅ |
| Context: priority + token budget + Rules/SOP | ✅ |
| Vector embeddings (2b) | ❌ later |

## 6. Phase 3 (delivered) — AI Worker

| Item | Status |
|------|--------|
| Tools search/read/list/write/append/create | ✅ `AgentTools.ts` |
| Write proposals + Apply/Reject UI | ✅ |
| Tool loop multi-round (max 4) | ✅ `AIMiddleware` |
| Path sandbox (no escape vault) | ✅ |
| Chat cache `.workspacegraph/chats/` | ✅ |
| Citations click-to-open | ✅ |
| Cancel stream + timeout | ✅ |
| Native tool_calling APIs | ❌ optional (uses `wg-action` JSON) |

## 7. Phase 4 (delivered) — Domain + Templates

| Item | Status |
|------|--------|
| Builtin templates (project/task/people/…) | ✅ |
| Seed `Templates/` on create vault | ✅ (kini benar-benar bekerja, lihat CRIT-3) |
| Template picker UI + Ctrl+Shift+N | ✅ |
| Domain overview (counts, lists, checkboxes) | ✅ |
| Dashboard widgets domain | ✅ |
| AI create_from_template | ✅ |

## 8. Phase 5 (delivered) — Platform

| Item | Status |
|------|--------|
| AutomationEngine + automation.json | ✅ |
| Declarative PluginHost | ✅ |
| Path sandbox on file/AI paths | ✅ |
| safeStorage API key encryption | ✅ |
| Permissions (ai/tools/automation/plugins) | ✅ |
| InternalAPI + health | ✅ |
| electron-builder NSIS polish | ✅ |
| Full JS plugin runtime | ❌ later |
| Vector RAG 2b | ❌ later |

---

## 9. Utang residual

- Soft-delete trash
- Vector hybrid search
- Scheduled automation
- Full plugin code sandbox
- Monolith: `src/main/ipc/index.ts` (±1.280 baris) & `GraphCanvas.tsx` (±4.257 baris) → refactor ke modul/hook
- Migrasi `scripts/qa-*.mjs` ke vitest (dua sistem test paralel mudah melenceng — lihat CRIT-1)

Lihat `35_Roadmap.md`.

---

## 10. Cara verifikasi

```bash
cd C:\code\WorkspaceGraph
npm run typecheck   # ✅ bersih
npm test            # ✅ 132 passed / 132 (6 file)
npm run qa          # ✅ semua fase hijau, exit 0 (runtime · engines · phase2–5 · graph-view · adversarial)
npm run lint        # ⚠️ 2 errors + 5.534 warnings (debt prettier/strict, bukan blocker)
npm run build       # ✅ production build sukses
# optional installer:
# npm run build:win
```

Settings → Security / Automation / Plugins.
`.workspacegraph/automation.json` · `plugins/*/manifest.json`

---

## 11. Verdict

| Pertanyaan | Jawaban |
|------------|---------|
| Typecheck bersih? | **Ya** |
| QA P0–P5? | **Ya** (semua fase hijau, exit 0) |
| Lint bersih? | **Tidak** — 2 errors + 5.534 warnings (debt prettier) |
| Build produksi? | **Ya** |
| Path sandbox konsisten? | **Ya** (semua IPC file terkunci) |
| XSS preview tertangani? | **Ya** (escape + allowlist URL) |
| API key aman dari renderer? | **Ya** (scrub + merge-preserve + regression tests) |
| Blueprint roadmap core? | **Phase 0–5 core delivered** |
| Siap pakai harian? | **Ya** (vault + AI worker + domain + platform) |

Residual: vector RAG, soft-delete, JS plugin sandbox, cron, refactor monolith, migrasi QA ke vitest.
