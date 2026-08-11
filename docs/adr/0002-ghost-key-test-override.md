# ADR-0002: Ghost key — pertahankan override Test, tampilkan label jujur, reset saat Save

- **Status:** Accepted
- **Tanggal:** 2026-08-10
- **Area:** Settings AI provider — alur paste → Test → Save (`SettingsView.tsx`, `src/main/ipc/handlers/ai.ts`)

## Context

Temuan audit **MED-2** (save-stop): saat user paste API key lalu klik **Test**, key tersebut
di-patch ke provider di memori. Jika user lalu **Save tanpa key** (kartu sudah tampil
"configured"), key override tetap aktif untuk chat sungguhan sampai restart / save key baru —
**ghost key**. Kartu tampil "configured" padahal tidak ada key yang tersimpan.

Opsi yang dipertimbangkan:

- **(a) Revert setelah ping** — snapshot config, restore di `finally`. Trade-off: daftar model
  pasca-Test memakai key lama (user yang baru paste key tidak melihat model yang sebenarnya).
- **(b) Pertahankan + komunikasikan** — flash/catatan "key aktif — belum disimpan, Save untuk
  menyimpan".
- **(c) Reset saat Save tanpa key** — `handleSaveProviderRow` tanpa key me-reset override runtime
  ke key tersimpan.

## Decision

**Gabungkan (b) + (c):**

1. **Pertahankan override Test** — alur paste → Test → chat tetap intuitif; user langsung dapat
   memakai key yang baru diuji tanpa save terpisah.
2. **Tampilkan label jujur di kartu** — saat key terketik belum di-save, kartu menampilkan
   `· key baru — belum disimpan` (`SettingsView.tsx`). Tidak ada lagi kartu yang terlihat
   "configured" padahal hanya override di memori.
3. **Save tanpa key me-reset override** — menutup jalur ghost key: setelah Save apa pun, provider
   runtime dibangun ulang dari key yang tersimpan.

**Temuan implementasi M1:** opsi (c) **sudah ter-cover arsitektur** — setiap row-Save memanggil
`ai:saveProviderConfigs` → `rebuildProviders` membuat instance provider **baru tanpa key**, lalu
`loadSettingsIntoProviders` hanya menerapkan key yang tersimpan. Jadi override Test otomatis hilang
setelah Save apa pun; tidak perlu IPC baru. Implementasi M1 cukup label jujur (b) + verifikasi test.

## Consequences

**Positif:**

- Alur Test → chat tanpa save tetap berfungsi (UX inti Settings AI).
- Tidak ada lagi kondisi membingungkan "configured tanpa key tersimpan" — ghost key tertutup.
- Tidak ada IPC/perilaku baru yang perlu dipelihara untuk (c) — memanfaatkan arsitektur yang ada.

**Trade-off / negatif:**

- Key yang di-test tapi belum di-save tetap aktif untuk chat sampai Save — ini **disengaja**
  (bagian dari keputusan (b)) dan kini dikomunikasikan lewat label, bukan disembunyikan.
- Daftar model pasca-Test memakai key baru (konsekuensi (a) yang ditolak): user yang paste key
  melihat model yang sebenarnya — dianggap keuntungan, bukan kerugian.

## Referensi

- `src/renderer/src/components/settings/SettingsView.tsx` — label `· key baru — belum disimpan`
- `src/main/ipc/handlers/ai.ts` — `ai:testProvider` (override + `patched:true`)
- `src/main/ipc/shared.ts` — `loadSettingsIntoProviders` (hanya key tersimpan yang diterapkan)
- `docs/AUDIT_2026-08-10_save-stop.md` — temuan MED-2 (opsi a/b/c)
- `docs/TODO_FIX_2026-08-10.md` — entri MED-2 (keputusan ✅, M1)
- `docs/FIX_PLAN_2026-08-10.md` — tabel Gate 0 MED-2 ✅ **DIPUTUSKAN: (b)+(c)**
