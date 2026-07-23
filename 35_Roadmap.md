# 35_Roadmap.md

# WorkspaceGraph Roadmap

Version: 0.1  
**Acuan:** Constitution `00` + PRD `03` + Architecture `04` + engines `05–10` + UI `23–26`  
**UI constraint (user):** tampilan **clean seperti Obsidian** (flat, content-first, chrome tenang)  
**Status kode:** lihat `docs/AUDIT.md` + `docs/BLUEPRINT_AUDIT_SYNC.md`

------------------------------------------------------------------------

# North Star

WorkspaceGraph = **AI Workspace Operating System** berbasis Markdown + Graph, di mana AI adalah **pekerja** yang baca-konteks-tulis-kembali ke Vault — bukan chat app, bukan lock-in model.

Pengguna dapat meninggalkan Obsidian sebagai app harian **setelah** core vault + AI worker + search index cukup kuat.

------------------------------------------------------------------------

# Principles for every phase

1. Markdown = Source of Truth (Law 001).  
2. DB/index = cache saja (Law 009).  
3. AI tidak invent data vault (Law 006).  
4. Write-back ke Markdown (Law 007).  
5. UI: **Obsidian-clean** — quiet chrome, editor luas, sidebar rapat, accent subtle.  
6. Offline-first; AI online optional (Law 012).

------------------------------------------------------------------------

# Phase 0 — Align & Hygiene (1–3 hari)

**Tujuan:** Spek + kode tidak saling menipu.

- [x] Blueprint 00–34 di root (user)  
- [x] Audit kode `docs/AUDIT.md`  
- [x] Sync matrix `docs/BLUEPRINT_AUDIT_SYNC.md`  
- [x] Isi/maintain `35_Roadmap.md` (dokumen ini)  
- [x] README mengarah ke Constitution + Vision (partial — README singkat)  
- [x] Fix demo vault path di Welcome  
- [ ] Hapus / wire `better-sqlite3` & `flexsearch` secara sadar (pakai atau buang) → Phase 2 index.db  
- [x] Baseline design: dark tokens Obsidian-flat + light theme tokens

**Exit:** Dev setuju blueprint = hukum; UI direction jelas.

------------------------------------------------------------------------

# Phase 1 — Vault Core “Obsidian-feel” (MVP UX)

**Blueprint:** 05, 06, 23, 24, 25 (subset), 26 (subset), 27 (subset)

**Tujuan:** Buka vault → edit MD → graph → search → daily terasa nyaman seperti Obsidian (tanpa plugin).

### Must

- [x] File tree: context menu (new note/folder, rename, delete)  
- [x] Wikilink click → buka note  
- [x] **Backlinks panel** (inspector kanan, quiet)  
- [x] Editor: split **source | preview** yang layak  
- [x] Outline headings (inspector)  
- [x] Command palette / search polish (Ctrl+K, Ctrl+P)  
- [x] Hotkeys: new note, save, toggle sidebar, toggle AI, daily note  
- [x] Daily notes: path `Daily/YYYY-MM-DD.md` + open today  
- [x] Create workspace wizard (bukan hanya open folder)  
- [x] Dashboard: metrics MD-only + recent + orphans + quick actions — **flat lists, no card soup**  
- [x] Settings: theme dark/light/system (+ AI keys persist); default folders = scaffold on create  

### UI polish (Obsidian-clean)

- [x] Titlebar + sidebar density seperti Obsidian  
- [x] Tabs note ringkas  
- [x] Tidak ada animasi mengganggu  
- [x] Status bar: path, word count, dirty state  

**Exit:** User bisa pakai vault harian tanpa Obsidian untuk baca/tulis/cari/graph dasar. **→ TERPENUHI (2026-07-22 bughunt).**

------------------------------------------------------------------------

# Phase 2 — Search Index + Context (AI readiness)

**Blueprint:** 07, 09, Law 005/009  
**Status:** Core delivered 2026-07-22 (`IndexDatabase` + hybrid Search + Context v2)

**Tujuan:** Search & context AI memakai **index**, bukan Fuse-saja.

- [x] Cache DB di `.workspacegraph/index.db` (FTS5 / sqlite)  
- [x] Index: body, title, tags, frontmatter, headings, paths  
- [x] Incremental reindex on watch (upsert/delete single note)  
- [x] Rebuild index command (Settings → Search Index + IPC)  
- [x] Backlink queries di search API (`backlink:Title`) + path:  
- [x] Context Engine: aktif → wikilinks → backlinks → Rules/SOP → search  
- [x] Token budget + dedupe context  
- [x] Auto-include `Rules/`, `SOP/`, `Templates/`, `Prompt/` (budget-capped)  
- [ ] (Optional phase 2b) Embeddings lokal (Ollama) + hybrid vector — later  

**Exit:** AI mendapat Context Package sesuai 09; search FTS + Fuse. **→ TERPENUHI (minus vector 2b).**

------------------------------------------------------------------------

# Phase 3 — AI Worker (bukan chat ornament)

**Blueprint:** 10, 19, 20, 21, Law 003–007  
**Status:** Core delivered 2026-07-22 (`AgentTools` + tool loop + proposals + chat cache)

**Tujuan:** AI bisa **mengerjakan** workspace dengan izin user.

- [x] Tool definitions: `search`, `read_note`, `list_dir`, `write_note`, `append_note`, `create_note`  
- [x] Permission + confirm sebelum write (proposal panel Apply/Reject)  
- [x] Response validation (Markdown size + frontmatter; preserve FM on overwrite body-only)  
- [x] Write-back pipeline → `applyProposal` → graph + search reindex  
- [x] Agent roles (general/writer/researcher/curator/planner) + tools prompt  
- [x] Persist conversations di `.workspacegraph/chats/` (cache, bukan SoT)  
- [x] Citations klik → buka note  
- [x] Streaming cancel + timeout tool loop (~3 min)  
- [ ] Native provider function-calling (optional polish; sekarang via `wg-action` blocks)  
- [ ] Delete tool + confirm (optional)  

**Exit:** User minta ringkasan → AI search/read → **proposal** create/write → user Apply. **→ TERPENUHI.**

------------------------------------------------------------------------

# Phase 4 — Knowledge Systems (domain structure)

**Blueprint:** 11–17, 15 templates, 08 graph enrich  
**Status:** Core delivered 2026-07-22 (`TemplateEngine` + `DomainEngine` + dashboard)

- [x] Knowledge / Project / Task / People / Document / SOP / Meeting / Daily templates  
- [x] Template engine: vars `{{title}}` `{{date}}`… + seed `Templates/` + UI picker  
- [x] AI tools `list_templates` / `create_from_template` (wajib prefer template)  
- [x] Task statuses frontmatter + open `- [ ]` scan di dashboard  
- [x] People notes as type + graph type people (link via wikilink)  
- [x] Graph: filter type/tag + local graph di editor (sudah Phase 1)  
- [x] Dashboard widgets: projects, open tasks, people, checkboxes (flat, clean)  

**Exit:** Second Brain structure usable. **→ TERPENUHI.**

------------------------------------------------------------------------

# Phase 5 — Platform

**Blueprint:** 22, 28, 29, 30, 31, 33, 34  
**Status:** Core delivered 2026-07-22

- [x] Automation rules (file events → log/append/tag; `automation.json`)  
- [x] Plugin host declarative (`manifest.json` commands only — no arbitrary JS)  
- [x] Theme dark/light/system (tokens)  
- [x] Internal API facade + `api:health`  
- [x] Installer Windows polish (`electron-builder.yml` NSIS WorkspaceGraph)  
- [x] Security: safeStorage secrets, path sandbox, permission flags  
- [x] Automated tests (`npm run qa` P1–P5)  
- [ ] Full plugin JS sandbox / marketplace (later)  
- [ ] Scheduled automation cron (later)  

------------------------------------------------------------------------

# Explicitly later / non-goals (03 + 01)

- Real-time collab  
- Built-in cloud sync marketplace  
- Mobile app  
- Replace MS Office / IDE  
- Full Obsidian plugin compatibility  
- Train own foundation model  

------------------------------------------------------------------------

# Suggested near-term order (coding)

```
Phase 0 hygiene
    → Phase 1 vault UX (Obsidian-clean)
        → Phase 2 index + context
            → Phase 3 AI tools + write-back
                → Phase 4 systems (project/task/people)
                    → Phase 5 platform
```

Jangan mulai plugin marketplace sebelum Phase 3.

------------------------------------------------------------------------

# Definition of “bisa ganti Obsidian” (user success)

Pengguna dapat:

1. Buka vault yang sama (atau migrasi MD).  
2. Edit, link, graph, search setara kenyamanan harian.  
3. Chat AI yang **baca vault** dan **tulis hasil** ke note.  
4. Offline edit/search tanpa AI.  
5. Backup = copy folder Markdown.

------------------------------------------------------------------------

# Tracking

| Phase | Status |
|-------|--------|
| 0 Align | 🔄 in progress |
| 1 Vault UX Obsidian-clean | ⬜ |
| 2 Search + Context | ⬜ |
| 3 AI Worker | ⬜ |
| 4 Knowledge systems | ⬜ |
| 5 Platform | ⬜ |

------------------------------------------------------------------------

# Closing

Roadmap ini mengikat **blueprint sebagai hukum** dan **kode sebagai hutang teknis yang dilunasi bertahap**, dengan UI yang **tenang dan bersih seperti Obsidian**, sambil AI tetap pekerja — bukan pemilik pengetahuan.
