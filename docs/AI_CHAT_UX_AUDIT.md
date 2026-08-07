# AI Chat UX Audit — WorkspaceGraph vs Cursor / Claude Code

**Date:** 2026-08-06
**Scope:** Alur chat AI Kernel (ChatPanel + chatStore + AIMiddleware) vs praktik
terkini Cursor (Agent/Composer, 2026) dan Claude Code (REPL, 2026).
**Status baseline:** P-A1..P-C1 terpasang (native function calling, proposal
persistence, vision, regenerate/rephrase). Suite **600/600**.

---

## Ringkasan eksekutif

Fondasi sudah kuat: streaming markdown, tool loop dengan fallback fence,
proposal (tulis = konfirmasi), citation + verifikasi kelemahan, vision,
regenerate/rephrase, persistensi. Gap terbesar bukan di *kemampuan* tetapi di
**visibilitas proses** — pengguna tidak bisa melihat *apa yang sedang dikerjakan
agent* dengan baik (satu baris status `▸ list_dir`), tidak ada *hover* untuk
bukti jawaban, dan tidak ada kontrol konteks/biaya. Tiga P1 pertama semuanya
menyentuh area itu.

| Prioritas | Gap | Nilai | Effort | Reuse yang ada |
|-----------|-----|-------|--------|----------------|
| **P1-1** | Streaming status **per tool** (list kolapsibel) | Tinggi | S | `chunk.toolStatus` sudah per-round |
| **P1-2** | Cite-on-hover (tooltip preview catatan) | Tinggi | M | `graphTooltipPreview` cache |
| **P1-3** | Model switcher inline di komposer (+ Auto) | Sedang | S | select provider/model yang ada |
| **P2-1** | Chat `/commands` (compact/plan/learn) | Sedang | S | CommandPalette registry |
| **P2-2** | Context/token budget bar (per sesi) | Sedang | S | `contextTokens` + `tokensUsed` |
| **P2-3** | Visibilitas *reasoning/thinking* streaming | Sedang | M | chunk delta reasoning_content |
| **P2-4** | Syntax highlighting kode blok di chat | Sedang | M | CodeMirror tokenizer / hljs ringan |
| **P2-5** | Diff preview di kartu proposal (overwrite/append) | Sedang | S | `MergeDialog` |
| **P3-1** | Auto-compact konteks dengan ringkasan AI | Rendah | L | middleware summary prompt |
| **P3-2** | Tier permission eksplisit per tool | Rendah | M | Permissions.ts |
| **P3-3** | Sidebar multi-session / conversation tree | Rendah | L | ConversationStore |

---

## P1 — Dikerjakan dulu (nilai tinggi, effort rendah–sedang)

### P1-1. Streaming status per tool — list kolapsibel

**Cursor/Claude Code:** setiap tool call muncul sebagai *item* real-time
(`Reading src/auth.ts…`, `Bash (npm test)`) dengan status spinner → selesai →
kompak jadi pill yang bisa di-expand untuk melihat args/stdout/diff.

**Kita:** satu baris `chat-tool-status` dengan spinner yang menampilkan
`lastToolStatus` (hanya yang terakhir; round lama hilang). Setelah selesai tidak
ada jejak tool yang dijalankan.

**Gap:** pengguna tidak bisa melihat urutan kerja agent, tool apa yang gagal,
atau membuka detail hasil. Ini gap #1 karena menyentuh kepercayaan ("apa yang
baru saja dilakukan?").

**Usul:**
- chatStore: ganti `lastToolStatus: string` menjadi `toolRuns: ToolRun[]`
  (`{ id, tool, summary, status: 'running'|'done'|'error', round }`), akumulasi
  dari `chunk.toolStatus` yang sudah dikirim middleware per-round (P-B1 sudah
  menguji ini).
- ChatPanel: render list kolapsibel di bawah toolbar saat `isGenerating` —
  item running dengan spinner, item selesai jadi pill berlabel tool + argumen
  singkat; klik expand → `read_note` hasil snippet / `list_dir` daftar.
- Sejarah per message: simpan `toolRuns` di `ChatMessage` agar jejak tool
  tetap terlihat setelah selesai (bukan hanya saat generating).

### P1-2. Cite-on-hover — tooltip preview catatan

**Cursor:** pill file/ref punya hover-card (path, line, preview kode).

**Kita:** citation chip `[[title]]` + tanda ⚠ verifikasi lemah, klik membuka
tab. Tidak ada preview tanpa navigasi.

**Gap:** memverifikasi klaim butuh klik + pindah view.

**Usul:** hover chip → tooltip snippet (2–3 baris markdown polos + path) —
**reuse `graphTooltipPreview`** (`TooltipPreviewCache` + `markdownToPlainText`
+ `previewLines`, sudah dipakai tooltip graph) via IPC `readFile`. Chip yang
lemah tetap ditandai ⚠ di tooltip.

### P1-3. Model switcher inline di komposer (+ Auto)

**Cursor:** selector model ada langsung di input bar composer, plus mode Auto.

**Kita:** provider/model/role di toolbar atas panel; saat chat panjang, mengganti
model butuh scroll ke atas.

**Gap:** konteks komposer — model yang dipakai berjarak dari tempat mengetik.

**Usul:** chip kompak (nama model) di footer komposer di samping toggle
Context/Tools; klik → dropdown inline (daftar model provider aktif, format
`model · provider`). Opsi "Auto" = model default provider (tanpa routing
cerdas — cukup default).

---

## P2 — Nilai bagus, effort menengah

### P2-1. Chat `/commands`
Claude Code: `/compact`, `/clear`, `/context`, `/init`. Kita punya
CommandPalette app-level tapi tidak ada command di dalam komposer chat.
Usul: parse `/` di awal input → saring registry CommandPalette
(`wg:*` events) + aksi chat lokal (`/learn`, `/memory`, `/clear`, `/compact`,
`/plan`). S kecil karena registry sudah ada.

### P2-2. Context/token budget bar
Claude Code `/context` menampilkan breakdown token. Kita sudah menampilkan
`tokensUsed` + `ctx ~N` per pesan dan `contextTokens` per stream.
Usul: bar tipis di bawah toolbar menampilkan estimasi total token sesi vs
budget (mis. 8k/32k/200k sesuai model `contextWindow` dari provider) + akumulasi
biaya perkiraan. Semua data sudah tersedia — tinggal agregasi + UI.

### P2-3. Visibilitas reasoning/thinking streaming
Cursor/Claude Code menampilkan alur berpikir (collapsible). Beberapa model
(Grok, DeepSeek, Gemini thinking, O-series) meng-stream `reasoning_content`/
`delta.thinking`. Kita hanya `working…`.
Usul: tangkap `reasoning_content` delta di provider OpenAI-compat → `AIStreamChunk.reasoning` → render blok "🧠 thinking" kolapsibel di atas konten (dengan cap panjang; final done tidak perlu disimpan). Effort M karena menyentuh provider + middleware + UI.

### P2-4. Syntax highlighting kode blok
Blok code di chat/note di-render `<pre><code>` polos (tanpa highlight; hanya
`--note-highlight` untuk `<mark>`). Cursor/Claude Code mewarnai sintaks.
Usul: highlighter ringan (regex tokenizer kecil atau hljs yang di-bundle)
diterapkan di `MarkdownEngine.renderMarkdownToHtml` + `renderStreamingMarkdown`.
Hati-hati performa di vault besar — terapkan hanya di render final, cache
per-doc.

### P2-5. Diff preview di proposal
Proposal `overwrite`/`append` hanya preview teks polos. Cursor menampilkan diff
sebelum apply.
Usul: untuk mode `overwrite`/`append`, tampilkan diff (baris tambah/hapus) di
kartu proposal — reuse logika `MergeDialog` yang sudah ada. S.

---

## P3 — Polish / defer

- **P3-1 Auto-compact:** ringkas turn yang di-drop oleh history windowing
  (8 turn / 60k) dengan panggilan model, sisipkan sebagai pesan `system`.
  Effort L; risiko biaya tersembunyi — default off.
- **P3-2 Tier permission:** read auto, tulis proposal (sudah aman), tambah
  allowlist per-tool (mis. selalu setujui `list_dir` untuk sesi ini). Sempurnakan
  `Permissions.ts`; bukan blocker.
- **P3-3 Sidebar multi-session:** ConversationStore sudah persist; buat daftar
  sesi paralel + lanjutkan chat lama tanpa menutup sesi aktif. Effort L.

---

## Catatan non-gap (sudah setara atau lebih baik)

- **Tulis = proposal** (apply/reject sebelum menyentuh disk) — lebih aman dari
  auto-edit Cursor di mode default.
- **Verifikasi citation ⚠** — grounding check per klaim; Cursor/Claude Code
  tidak punya setara otomatis.
- **Regenerate/Rephrase + Vision + Persistensi proposal** — P-C1/P-A2/P-B2.
- **Watcher + reindex otomatis setelah apply** — graph/search konsisten.

---

## Rekomendasi urutan eksekusi

1. **P1-1** (per-tool streaming) — dampak kepercayaan terbesar, effort kecil.
2. **P1-3** (model switcher komposer) — cepat, dirasakan setiap interaksi.
3. **P1-2** (cite-on-hover) — reuse tooltip graph, bukti jawaban tanpa navigasi.
4. **P2-1** (/commands) + **P2-2** (token bar) — kecil, melengkapi kontrol.
5. **P2-3..P2-5** — sesuai prioritas produk.
6. **P3** — setelah P1/P2 stabil.

Target: seluruh P1 + P2-1/P2-2 bisa selesai dalam ~3–4 batch kecil tanpa
menyentuh arsitektur inti.
