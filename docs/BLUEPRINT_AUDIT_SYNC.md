# Blueprint ↔ Code ↔ Audit — Sinkronisasi

**Tanggal:** 2026-07-22  
**Acuan utama:** Blueprint `00`–`35` di root project  
**Acuan tampilan (request user):** **clean seperti Obsidian** (tanpa meniru plugin ecosystem)  
**Audit teknis:** `docs/AUDIT.md` (status kode sekarang)

---

## 1. Hierarki keputusan

```
00_Constitution.md     ← HUKUM TERTINGGI (selalu menang)
01–03 Vision/Philosophy/PRD
04 Architecture + 05–22 Engines/Systems
23–27 UI/UX/Dashboard/Graph/Settings
28–34 Plugin/Theme/API/Installer/Security/Testing
35_Roadmap.md          ← urutan kerja (diisi dari blueprint + gap kode)
docs/AUDIT.md          ← fakta implementasi hari ini (bukan law)
User request UI        ← “clean kayak Obsidian” = interpretasi visual 23+24
```

Jika audit/kode bertentangan dengan Constitution → **ikuti Constitution**.

---

## 2. Constitution (Laws) vs kode sekarang

| Law | Isi | Kode sekarang | Status |
|-----|-----|---------------|--------|
| 001 Markdown First | MD = SoT | Vault MD, gray-matter | ✅ |
| 002 User Owns Data | Tidak proprietary lock | Folder lokal | ✅ |
| 003 AI Is A Worker | Bukan pusat | Chat panel samping | ⚠️ Chat OK, belum “worker” write-back |
| 004 Workspace First | Konteks dulu | ContextEngine | ⚠️ Partial |
| 005 Read Before Think | Scan SOP/template/rules | Hanya search top-5 + active | ❌ Belum pipeline penuh |
| 006 Never Invent Data | Pakai vault | Prompt bilang jangan invent | ⚠️ Lemah enforce |
| 007 Write Back | Hasil ke MD | Append manual user | ❌ Belum auto write-back |
| 008 Graph Integrity | Wikilink → edge | GraphEngine + inspector backlinks | ✅ |
| 009 DB Is Cache | Index/cache only | `.workspacegraph/index.db` FTS5 + memory Fuse | ✅ |
| 010 AI Independence | Multi model | 5 providers | ✅ |
| 011 Human Readable | MD biasa | Ya | ✅ |
| 012 Offline First | Tanpa net | Editor/graph/search offline | ✅ AI online optional |
| 013 Plugin First | Extensible | Blueprint 28, kode ❌ | ❌ |
| 014 Preserve Knowledge | No silent delete | Delete file ada, soft-delete ❌ | ⚠️ |
| 015 Long-term | Portabel | MD vault | ✅ |

---

## 3. PRD (03) MVP vs kode

| FR | Blueprint | Kode | Gap |
|----|-----------|------|-----|
| FR-001 Workspace | multi vault open/create | open/recent/create UI + watcher | ✅ |
| FR-002 Markdown Engine | full + watch | parse/write/watch + backlinks panel | Safe write rules (Phase 2) |
| FR-003 AI Workspace Scan | template/SOP/rules | search snippets only | Full scan pipeline 05+09 |
| FR-004 Knowledge Graph | auto + update | D3 + wiki/tag edges | Layout modes, filters penuh |
| FR-005 Search | title/body/tag/meta/backlink | Fuse fuzzy | FTS + backlink search; later semantic |
| FR-006 Projects | overview/tasks/notes | Folder scaffold only | Project system UI |
| FR-007 Tasks | status/priority MD | ❌ | Task system |
| FR-008 Templates | AI wajib pakai | Folder Templates, no engine | Template System 15 |
| FR-009 Daily Notes | daily context | Tombol create Daily/ | Calendar/strip |
| FR-010 AI Chat | cite + write back | stream + cite + append | Write-back agent, persist chat |
| FR-011 Plugin | extend core | ❌ | SDK later |

**MVP blueprint:** Workspace, MD, AI Chat, Graph, Search, Projects, Tasks, Templates, Daily, Settings.  
**MVP kode aktual:** Workspace + MD + AI Chat + Graph + Search + Settings (partial) + Daily create.  
**Projects/Tasks/Templates system = scaffold folder only.**

---

## 4. Arsitektur (04) vs kode

| Blueprint layer | Kode | Catatan |
|-----------------|------|---------|
| UI Layer | renderer/components | OK struktur |
| Application Layer | stores + views | Belum module Project/Task/Template penuh |
| AI Middleware | AIMiddleware | Ada; kurang validator + markdown writer |
| Context Builder | ContextEngine | Ada; kurang prioritization penuh 09 |
| Core engines | Workspace/Markdown/Graph/Search/Watcher | Ada |
| Storage: MD + **Cache DB** | MD only; sqlite unused | **P0: index.db** |
| AI Engine | multi API (bukan hanya Gemini CLI) | Lebih maju dari draf “Gemini CLI default” — **OK, selaras Law 010** |

**Data flow blueprint (write-back + graph update after AI):** kode belum menyelesaikan langkah 7–8 otomatis.

---

## 5. Engines — ringkas

| Engine | Blueprint target | Sekarang | Next |
|--------|------------------|----------|------|
| Workspace | scan, manifest `.workspacegraph/`, context provider | scan + config userData | Manifest di vault `.workspacegraph/` + index.db |
| Markdown | backlinks, safe write, attachments | parse/write basic | Backlink index, link resolve UI |
| Search | FTS, meta, backlink, ranking | Hybrid FTS5 + Fuse + operators | Semantic/vector = Phase 2b |
| Graph | real-time, multi edge types | wiki+tag, force layout | Layout modes |
| Context | prioritization, token limits, package | active→links→backlinks→Rules/SOP→search + budget | ✅ core |
| AI Middleware | tools, validate, write | multi-provider stream | Tool loop + write-back |

Semantic/vector di blueprint 07 = **Future**, bukan syarat MVP search — tapi untuk “AI full” user, **hybrid search** tetap prioritas roadmap.

---

## 6. UI: Blueprint 23–26 + request “clean Obsidian”

### Blueprint bilang
- Clarity over decoration, content first, tokens, sidebar + workspace + inspector, command palette, light **dan** dark.

### Request user
- **Tampilan clean kayak Obsidian** (bukan fitur plugin Obsidian 1:1).

### Interpretasi desain (wajib diikuti ke depan)

| Prinsip Obsidian-clean | Arti di WG |
|------------------------|------------|
| Flat surfaces | Sedikit border/shadow; panel solid |
| Content first | Editor luas; chrome tipis |
| Quiet chrome | Titlebar/sidebar muted, bukan “dashboard SaaS” |
| Density | Compact tree & tabs (mirip tokens sekarang) |
| Accent subtle | Satu accent violet/blue, bukan multi-neon |
| No card soup | Dashboard: list + metrics flat, bukan banyak card marketing |
| Keyboard first | Ctrl+K, Ctrl+P style |

**Yang sudah dekat:** `tokens.css` dark flat + AppShell sidebar.  
**Yang dijauhkan:** widget-dashboard berlebihan, animasi berat, panel AI yang “chatbot SaaS”.

**Inspector panel** (backlinks / outline) — ada di 23 layout, **belum di kode** → P1 UX.

Vision 01 bilang “bukan pengganti Obsidian”; product goal user **switch dari Obsidian** = **WG menjadi primary workspace**, tanpa meniru marketplace plugin. Tidak konflik jika: WG = OS pengetahuan AI-native, UX terasa akrab seperti Obsidian.

---

## 7. Matriks “sudah / partial / belum”

### ✅ Sudah selaras blueprint (inti / Phase 1)
- Markdown SoT, open/create vault, file tree + context menu, editor CM, split preview, inspector (outline/backlinks/outgoing)
- Graph, fuzzy search + operators, multi AI keys persist, context inject (Rules/SOP priority partial), daily note, dark+light tokens, file watcher, hotkeys, status word count
- `npm run qa` runtime engines

### ⚠️ Partial
- Context pipeline (Rules/SOP priority by path; belum auto-load full folder)
- Dashboard (metrics flat; belum widget system 25 penuh)
- Graph (force only, bukan multi-layout 26)
- Agents (roles di chat, bukan lifecycle + tools 20)
- Settings (AI + theme; belum full 27)
- Write-back (manual append — belum agent tools)

### ❌ Belum = utang Phase 2–5 (bukan bug Phase 1)
- Cache DB / index.db (Law 009)
- Project/Task/People/Document systems (11–17)
- Template engine AI-wajib (15)
- Automation (22)
- Plugin SDK (28)
- Installer polish (31)
- Semantic search (future 07)
- Soft-delete (Law 014 full)

---

## 8. Roadmap acuan (lihat `35_Roadmap.md`)

Diisi agar:
1. Hormati **MVP 03**  
2. Tutup gap **Law 003–007** (AI worker + write-back)  
3. Search index kuat (09/07)  
4. UI **Obsidian-clean** (23 + request)  
5. Domain work (People/SOP/Documents) belakangan, setelah core vault AI

---

## 9. Aturan untuk Grok / dev ke depan

1. Baca `00_Constitution` sebelum fitur besar.  
2. Implementasi mengikuti nomor blueprint terkait (mis. search → 07).  
3. UI selalu: **content-first, flat, compact** — “Obsidian quiet”.  
4. Jangan simpan knowledge di SQLite sebagai SoT.  
5. Jangan AI jawab tanpa Context Engine bila vault terbuka.  
6. Audit.md = status, bukan spek.

---

## 10. Closing

Blueprint = **apa yang harus jadi**.  
Kode = **prototype 40–55% core vault+AI**.  
Audit = **jembatan jujur**.  
UI direction = **Obsidian-clean**, bukan clone fitur.

Sinkronisasi ini menjadi acuan sebelum coding sprint berikutnya.
