# ADR-0003: Default permission keamanan — plugins & automation OFF untuk instal baru

- **Status:** Accepted
- **Tanggal:** 2026-08-10
- **Area:** Postur keamanan vault (`src/main/security/Permissions.ts`)

## Context

Temuan audit **WC-4** (Wave C): semua permission default **TERBUKA** — `readPermissions`
mengembalikan `p.X !== false`, sehingga saat `settings.permissions` tidak ada (vault/instalasi
baru), `aiAccess`/`aiTools`/`automation`/`plugins` semuanya `true`. Dampak:

- **`plugins`** = eksekusi kode (plugin di-load di main process). Vault dari sumber tak tepercaya
  yang berisi `plugins/` akan **auto-load plugin**.
- **`automation`** = aksi file otomatis. Rule `automation.json` langsung aktif.

Opsi:

- **(a) Default OFF** untuk instal baru (`plugins`/`automation`), aiAccess/aiTools tetap ON.
- **(b)** Pertahankan terbuka tapi tampilkan status jelas di Settings → Security.

## Decision

**Pilih (a): default OFF untuk `plugins` dan `automation`.**

- `DEFAULT_PERMISSIONS` → `automation: false`, `plugins: false`; `aiAccess: true`, `aiTools: true`
  (produk inti tetap berfungsi out-of-the-box).
- `readPermissions` mengubah semantik: `p.x === true` untuk ON (absent/undefined → OFF).
  Sebelumnya `p.x !== false` (absent → ON).
- Settings → Security menampilkan status postur saat pertama kali (toggle tetap bisa
  mengaktifkan — gate AE-3 tidak mengunci UI sendiri).

Postur: fitur berbahaya (eksekusi kode, aksi file otomatis) bersifat **opt-in eksplisit**;
user mengaktifkannya sadar setelah melihat status.

## Consequences

**Positif:**

- Vault/instalasi baru tidak pernah auto-load plugin atau mengaktifkan automation — menghilangkan
  jalur eksekusi kode tak tepercaya secara default.
- Tidak ada perubahan untuk pengguna yang sudah mengaktifkan permission (tersimpan eksplisit
  `true` tetap ON).

**Trade-off / negatif:**

- Pengguna baru yang ingin plugins/automation harus mengaktifkan manual di Settings — biaya satu
  klik demi postur aman; dianggap benar.
- Perubahan semantik absent → OFF: settings lama tanpa field permission kini bermakna OFF untuk
  plugins/automation — ini justru tujuan keputusan (bukan regresi).

## Referensi

- `src/main/security/Permissions.ts` — `DEFAULT_PERMISSIONS`, `readPermissions` (komentar WC-4)
- `src/renderer/src/components/settings/SettingsView.tsx` — Settings → Security
- Komentar inline di `Permissions.ts` & `SettingsView.tsx` (postur default) menyebut `ADR-0003` — sinkron (2026-08-11)
