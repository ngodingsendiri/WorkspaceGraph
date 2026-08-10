# WorkspaceGraph — Audit Mendalam: Save/Test Provider + Two-Step Stop

**Tanggal:** 2026-08-10
**Scope:** Commit `8de0361` (`fix: honest provider save/test flows + two-step stream stop`) + alur terkait — `SettingsView.tsx`, `ai.ts` (IPC), `AIMiddleware.ts`, `ChatPanel.tsx`, `chatCancelConfirm.ts`, `providerSaveKeyConfirm.ts`, `shared.ts`, QA (`ipcHandlers.e2e.test.ts`, `sourceContracts.test.ts`).
**Mode:** Read-only review terhadap kode hasil commit (post-push). Tidak ada perubahan kode dari audit ini.

## Ringkasan

| Area | Verdict |
|---|---:|
| Klaim "Test tidak pernah persist key" | ✅ Terverifikasi benar |
| Isolasi data e2e test | ✅ Terverifikasi aman |
| Tema CSS (`--color-error`) | ✅ Terverifikasi ada di light + dark |
| Fokus keyboard & reduced-motion | ✅ Terverifikasi |
| Temuan severity tinggi | — Tidak ada |
| Temuan menengah | 3 |
| Temuan rendah / nit | 10 |

**Verdict:** Kualitas keseluruhan baik dan layak di-push; tidak ada bug yang merusak data atau keamanan. Namun ada **1 bug UX nyata (MED-1: pesan "disimpan — tes otomatis" tidak pernah tampil)** dan **2 desain yang perlu keputusan (MED-2 ghost key, MED-3 key add-provider hilang)**.

---

## Yang Terverifikasi Benar (positif)

1. **`configureProvider` memang in-memory only.** `AIMiddleware.configureProvider()` hanya memanggil `provider.configure()` pada runtime map — tidak menyentuh `workspaceEngine.saveSettings()`. Override key dari `ai:testProvider` tidak pernah ditulis ke disk. Klaim komentar di handler benar.
2. **Isolasi e2e test aman.** `ipcHandlers.e2e.test.ts` me-mock modul `electron` dengan `userDataDir` unik per-run di `/tmp`, vault sementara (`mkdtempSync`), dan `safeStorage` palsu. Reset settings di test baru hanya mengenai data uji, bukan data pengguna nyata.
3. **`--color-error` didefinisikan di kedua tema** (`tokens.css` line 32 light, line 207 dark) — tombol stop aman di semua tema.
4. **`cancelStream` masih ada dan dipakai** (`ChatPanel.tsx` line 258/612) — penggantian tombol tidak meninggalkan referensi mati.
5. **Global `:focus-visible` ada** (globals.css line 119, 5254) — tombol stop baru mendapat gaya fokus keyboard otomatis.
6. **Reduced-motion ditangani** — `.chat-stop-btn.is-armed { animation: none }` di dalam media query.
7. **Disarm idempotent + cleanup unmount** — tidak ada kebocoran interval.
8. **File baru prettier-clean** (LF), file lama mengikuti konvensi CRLF repo (pre-existing).

---

## Temuan Menengah

### MED-1 — Pesan "disimpan — tes otomatis…" tidak pernah terlihat di jalur key (bug UX nyata)

File: `src/renderer/src/components/settings/SettingsView.tsx` (`handleSaveProviderRow`, `autoVerifyProvider`, `handleTest`, `flash`)

`flash()` bersifat **replace** (`setSavedStatus(msg)` + clear 3s). Di jalur dengan key:

```
flash(buildRowSaveFlash(def, true, { ok: true }))   // "…disimpan — tes otomatis…"
if (key) await autoVerifyProvider(def.id)           // handleTest → flash("Testing gemini…")
```

`handleTest` memanggil `flash('Testing …')` secara sinkron sebelum await pertamanya, sehingga dalam batch render yang sama pesan "disimpan" langsung tertimpa. Pengguna hanya melihat "Testing gemini…" → "OK/FAIL …". Kontrak pure-builder (`providerSaveKeyConfirm.ts`) teruji dan benar, tetapi **pesan yang dibangun untuk alur itu tidak pernah dirender** di jalur yang paling penting (paste → Save).

**Dampak:** konfirmasi "tersimpan" hilang; pengguna hanya tahu dari hasil Test. Kecil, tapi membatalkan tujuan fitur "honest flash".

**Rekomendasi:** jalankan `autoVerifyProvider` lebih dulu dengan flash yang tidak menimpa (mis. parameter `silent` pada `handleTest`), lalu `flash(buildRowSaveFlash(...))` **setelah** verifikasi selesai — pesan terakhir menyampaikan keduanya ("disimpan — tes otomatis OK/FAIL"). Sinkronkan juga assertion `sourceContracts.test.ts` dengan urutan baru.

---

### MED-2 — Override Test tidak pernah di-revert: key yang belum disimpan jadi AKTIF di memori

File: `src/main/ipc/handlers/ai.ts` (`ai:testProvider`), `src/main/ipc/shared.ts` (`loadSettingsIntoProviders`)

Setelah `paste → Test`, key override di-patch ke runtime provider dan **tidak dikembalikan**. Konsekuensi:

- Chat berikutnya (di panel mana pun) memakai key yang belum disimpan — "Test" yang seharusnya probing malah meng-aktivasi key.
- Jika pengguna lalu Save **tanpa** key (atau mengosongkan field), `loadSettingsIntoProviders` sengaja tidak membersihkan apiKey ("Never pass empty apiKey — that would wipe an in-memory key after Save"). Runtime tetap memegang ghost key → kartu menampilkan "configured" padahal **tidak ada yang tersimpan**. Hingga restart atau save key baru, chat memakai key hantu.

**Dampak:** state menyesatkan ("configured" tanpa key tersimpan); key aktif tanpa sepengetahuan eksplisit. Bukan kebocoran data (key sudah di memori renderer), tapi semantik "Test" kabur.

**Rekomendasi (pilih salah satu, putuskan secara eksplisit):**
- **(a) Revert setelah ping:** snapshot config sebelum patch di `ai:testProvider`, restore di `finally`. Konsekuensi: daftar model pasca-Test memakai key lama (trade-off dengan MED-2b di bawah).
- **(b) Pertahankan tapi komunikasikan:** setelah Test dengan override, flash menambahkan "key belum disimpan — Save untuk menyimpan", dan kartu menandai status "aktif (belum disimpan)".
- **(c)** Pada `handleSaveProviderRow` tanpa key, minta main me-reset apiKey runtime provider itu — tapi ini bentrok dengan guard `loadSettingsIntoProviders`; perlu flag eksplisit, bukan perubahan global.

Catatan: perilaku saat ini (key ter-patch tetap aktif) membuat daftar model pasca-Test merefleksikan key baru — itu sisi yang disukai. Opsi (b) menjaga itu sambil menghilangkan kebingungan.

---

### MED-3 — Gagal-simpan key di form tambah provider membuang key yang diketik; pesan menyuruh "Save untuk ulang" tapi field kosong

File: `src/renderer/src/components/settings/SettingsView.tsx` (`handleAddProvider`)

Di jalur `hadKey` + `configure` gagal: form ditutup, `providerDraft` dikosongkan (termasuk key), lalu flash: *"Provider X ditambahkan, tapi key GAGAL disimpan: … — buka kartu & Save untuk ulang"*. Namun `apiKeys[finalId]` **tidak pernah diisi** oleh form tambah (form memakai `providerDraft`, bukan `apiKeys`), jadi Save di kartu tidak punya key — pengguna harus mengetik ulang dari nol.

**Dampak:** instruksi di pesan tidak akurat; key yang sudah diketik hilang. Recoverable tapi kasar.

**Rekomendasi:** sebelum menutup form di cabang gagal, salin key ke map kartu:

```ts
setApiKeys((prev) => ({ ...prev, [finalId]: providerDraft.apiKey.trim() }))
```

Lalu pesan menjadi benar-benar berlaku: key sudah menunggu di kartu, cukup klik Save.

---

## Temuan Rendah

### LOW-1 — Test mengabaikan baseUrl yang diedit-belum-disimpan jika tidak ada key baru

`handleTest` mengirim override hanya saat `typedKey` ada. Jika pengguna mengubah Base URL saja (mis. pindah proxy) lalu klik Test, ping memakai baseUrl lama yang tersimpan → kegagalan membingungkan. **Rekomendasi:** kirim override baseUrl juga ketika `def.baseUrl` berbeda dari versi tersimpan (perlu snapshot def saat `loadAll`), atau selalu sertakan `baseUrl` pada override.

### LOW-2 — Stop gate tidak punya jalan keluar: Esc / klik-luar tidak me-disarm

Setelah ter-arm, satu-satunya jalan keluar non-destruktif adalah menunggu 2,5 dtk. ChatPanel sudah punya pola Esc untuk model picker & menu ⋮ (line 464, 518) — tambahkan Esc-to-disarm dengan pola yang sama. (Klik kedua sengaja = cancel; Esc adalah affordance yang tepat, jangan ubah kontrak klik.)

### LOW-3 — `aria-live` countdown berisik untuk screen reader

Label "Stop? 3 / Stop? 2 / Stop? 1" diperbarui tiap tick (~17× dalam 2,5 dtk) di region `aria-live="polite"`. **Rekomendasi:** umumkan sekali saat arm ("Stop — klik lagi dalam 3 detik untuk berhenti"), update visual tetap diam; atau gunakan region live terpisah yang hanya berubah saat state arm flip.

### LOW-4 — sourceContracts test terikat pada kata-kata komentar

`set.includes('intentionally NOT cleared')` — mengubah/merapikan komentar mematahkan build. **Rekomendasi:** kontrak difokuskan pada token kode; cek komentar dihapus atau dibuat toleran (regex yang tidak sensitif reword).

### LOW-5 — Inkonsistensi label pesan

`handleTest`/`handleSetDefault`/`handleRefreshModels` memakai `providerId`, `handleSaveProviderRow` memakai nama tampilan; logika label `def.name?.trim() ? … : def.id` diduplikasi di `buildRowSaveFlash` dan flash inline. **Rekomendasi:** satu helper label bersama.

### LOW-6 — `catch` di `ai:testProvider` mencampur error configure dengan error test

Error dari `configureProvider` (mis. "Provider not found") terbaca sebagai kegagalan test. **Rekomendasi:** pisahkan blok try: patch vs ping.

---

## Nit (opsional)

- **NIT-1:** `handleSaveProviderRow` meneruskan `{ ok: true }` literal, bukan `cfg` — benar karena sudah dicek, tapi redundant.
- **NIT-2:** `cancelConfirmLabel(0)` → "Stop? 1" transien sebelum ticker disarm — tidak berbahaya.
- **NIT-3:** Test e2e baru me-reset seluruh blok `ai` settings; di lingkungan terisolasi itu deterministik dan aman.
- **NIT-4:** `title` tombol stop memuat instruksi "klik 2×"; pastikan konsisten dengan label `aria-label` (sudah sinkron).

---

## Rekomendasi Prioritas

1. **MED-1** — perbaiki urutan flash (perubahan kecil, dampak UX nyata, ada test kontrak yang ikut disesuaikan).
2. **MED-3** — salin key ke `apiKeys[finalId]` di cabang gagal add-provider (perubahan kecil, pesan jadi jujur).
3. **MED-2** — keputusan desain eksplisit: revert-vs-pertahankan override; jika mempertahankan, komunikasikan "aktif belum disimpan".
4. **LOW-2, LOW-3** — Esc-to-disarm + aria-live sekali-umumkan (aksesibilitas).
5. **LOW-1, LOW-4, LOW-5, LOW-6** — penyempurnaan kecil saat menyentuh area terkait.

## Lampiran — Alur yang Diaudit

- **paste → Test → Save (row):** key diketik → `apiKeys[id]` → Test kirim override → ping memakai key baru (in-memory) → Save persist defs → `ai:configure` persist key → `setApiKeys` hapus salinan → auto-verify → flash. (Bug flash: MED-1; ghost key: MED-2.)
- **Add provider + key:** persist def → configure key → gagal? pesan + form ditutup (key hilang: MED-3).
- **Two-step Stop:** arm (ref + state) → ticker 150ms → cancel/rearm per kontrak pure. (Esc: LOW-2; aria: LOW-3.)
