# ADR-0001: Global dedup `parseToolActions` adalah perilaku yang disengaja

- **Status:** Accepted
- **Tanggal:** 2026-08-10
- **Area:** AI agent tools (`src/main/ai/AgentTools.ts`)

## Context

`parseToolActions` mengekstrak aksi tool dari output model (fence `wg-action`/`json`/`javascript`
atau objek JSON telanjang) dan mengembalikan daftar `ToolAction`. Read tools dieksekusi langsung;
write tools menghasilkan proposal yang hanya diterapkan setelah konfirmasi user.

Temuan audit **AD-2** (audit 2026-08-10) menandai ketidaksesuaian antara
**komentar** dan **perilaku**:

- Komentar lama berbunyi "Dedupe consecutive identical tool+args" (dedup hanya berurutan).
- Implementasi meng-dedup **global** — `Set` `seen` menjangkau seluruh daftar, sehingga
  panggilan berulang tetap dibuang meski ada aksi lain di antara dua salinannya.

Perilaku yang diamati: model sesekali mengulang tool call dengan argumen identik di tengah stream
(mis. membaca file yang sama untuk verifikasi, atau mengirim write yang sama dua kali).
Dengan dedup global, duplikat tersebut menghasilkan **satu** proposal write / **satu** sitasi read,
bukan dua.

## Decision

**Pertahankan dedup global sebagai perilaku yang disengaja. Jangan ubah ke consecutive-only.**

Alasan:

1. **Manfaat produk:** duplikat write tidak memunculkan proposal ganda yang membingungkan;
   duplikat read tidak memunculkan sitasi ganda. Mengubah ke consecutive-only hanya membuat
   duplikat muncul kembali tanpa manfaat apa pun.
2. **Risiko regresi:** `AIMiddleware.test.ts` (baris 551) sengaja mengandalkan dedup
   non-berurutan (duplikat `create_note` yang dipisah `read_note` → satu proposal). Mengubah
   perilaku akan mematahkan kontrak yang sudah diuji.
3. **Deterministik:** dedup independen dari urutan aksi di antaranya, sehingga output stabil
   untuk input yang sama.

Yang diperbaiki hanya **dokumentasi** (bukan perilaku):

- Komentar di `parseToolActions` → `// Dedupe identical tool+args GLOBALLY (AD-2) ...`
- Test baru yang menegaskan perilaku:
  - `dedupes identical actions globally (not only when adjacent)` — `search, list_dir, search`
    → 2 aksi.
  - `keeps distinct actions that only overlap in tool name` — `search(x), search(y)` → 2 aksi.

## Consequences

**Positif:**

- Tidak ada proposal/sitasi duplikat di UI untuk write/read yang diulang model.
- Perilaku tercatat eksplisit (komentar + test), jadi tidak akan "diperbaiki" keliru oleh
  kontributor berikutnya.

**Trade-off / negatif:**

- Jika model *berniat* mengeksekusi write identik dua kali (mis. `append_note` konten sama dua
  kali), panggilan kedua diam-diam dibuang. Diterima — user dapat mengonfirmasi/mengulang secara
  eksplisit; kasus ini tidak teramati sebagai kebutuhan nyata.
- Kunci dedup `tool:JSON.stringify(args)` berbasis kesetaraan nilai setelah parse (urutan kunci
  objek ternormalisasi oleh JSON.parse), bukan kesetaraan teks mentah. Ini perilaku yang wajar
  dan diinginkan.

## Referensi

- `src/main/ai/AgentTools.ts` — `parseToolActions` (~line 470, blok dedup ~line 507)
- `src/main/ai/AgentTools.test.ts` — test non-consecutive dedup
- `src/main/ai/AIMiddleware.test.ts:551` — kontrak yang bergantung pada dedup global
- `src/main/ai/AgentTools.ts` komentar dedup menyebut `(ADR-0001 / AD-2)` — sinkron dengan ADR ini (2026-08-11)
