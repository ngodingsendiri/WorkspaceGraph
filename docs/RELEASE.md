# Release & Code Signing — WorkspaceGraph

Panduan rilis installer otomatis (`.github/workflows/release.yml`) dan cara
mengaktifkan code signing Windows + notarisasi macOS.

---

## 1. Alur release

1. **Tag versi** → push tag `v*` (mis. `v1.0.0`):
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
2. Workflow `Release` terpicu — 3 job paralel/berurutan:
   - `build-win` (windows-latest) → `electron-builder --win` → `dist/*.exe` (NSIS x64)
   - `build-mac` (macos-latest) → `electron-builder --mac --x64 --arm64` →
     **dua** DMG: `WorkspaceGraph-<version>-x64.dmg` + `-arm64.dmg`
   - `release` (ubuntu-latest) → unduh semua artifact → publish **satu** GitHub
     Release dengan `generate_release_notes: true`

   Kedua job build juga **memverifikasi artifact** sebelum di-upload (lihat
   §7a) — build gagal otomatis bila installer tidak lolos cek.
3. Installer ter-attach ke release, siap diunduh.

**Aturan wajib:** tag **harus cocok** dengan `version` di `package.json` —
`artifactName` electron-builder memakai `${version}`, jadi tag yang tidak cocok
akan menghasilkan release bernama beda dari installer-nya.

---

## 2. Status verifikasi

| Tanggal | Tag | Hasil |
|---------|-----|-------|
| 2026-08-11 | `v1.0.0` | ✅ Run #31460817403 sukses end-to-end — `WorkspaceGraph-1.0.0-setup.exe` (181 MB) + `WorkspaceGraph-1.0.0.dmg` (216 MB) ter-attach ke release. **Keduanya unsigned** (belum ada secret). |
| 2026-08-11 | `v1.1.0` | ✅ Run #31476233843 sukses end-to-end — **dual-arch terverifikasi**: `WorkspaceGraph-1.1.0-setup.exe` (173 MB) + `WorkspaceGraph-1.1.0-x64.dmg` (211,5 MB) + `WorkspaceGraph-1.1.0-arm64.dmg` (206,3 MB), step verifikasi artifact hijau di kedua job. Run #31475676465 (pertama) **gagal** — menemukan bug electron-builder `empty CSC_LINK → "<projectDir> not a file"` → diperbaiki (unset guard, commit `d12d475`). Kedua tag + release percobaan **dihapus** setelah verifikasi. |

---

## 3. Code signing Windows (NSIS)

electron-builder menandatangani executable + installer secara **otomatis** saat
dua env berikut ada di job `build-win`:

| Secret GitHub | Isi |
|---------------|-----|
| `WIN_CSC_LINK` | Sertifikat `.pfx` di-encode **base64** |
| `WIN_CSC_KEY_PASSWORD` | Password `.pfx` |

**Langkah setup:**

1. Dapatkan sertifikat code signing Windows (EV lebih baik — langsung trusted;
   OV memicu SmartScreen). Ekspor ke `.pfx` (termasuk private key).
2. Encode ke base64:
   ```bash
   base64 -w0 cert.pfx   # Linux/macOS — tempel hasilnya ke secret
   ```
3. Repo → **Settings → Secrets and variables → Actions** → tambah
   `WIN_CSC_LINK` dan `WIN_CSC_KEY_PASSWORD`.
4. Push tag berikutnya → installer otomatis ter-sign. Verifikasi: klik kanan
   `.exe` → Properties → Digital Signatures.

**Build lokal** (opsional): ganti env dengan config di `electron-builder.yml`
(`win.certificateFile` / `win.certificatePassword`) — **jangan commit** file
sertifikat atau password. Env CI tetap cara yang dianjurkan.

---

## 4. Code signing + notarisasi macOS

### 4a. Signing

| Secret GitHub | Isi |
|---------------|-----|
| `CSC_LINK` | Identitas signing `.p12` di-encode **base64** |
| `CSC_KEY_PASSWORD` | Password `.p12` |
| `CSC_NAME` | Nama identity (opsional, bila ada beberapa) |

`CSC_IDENTITY_AUTO_DISCOVERY=false` dipasang di job agar identity lokal runner
tidak pernah terpakai — tanpa `CSC_LINK`, build tetap **ad-hoc unsigned**.

**Penting (gotcha):** saat secret tidak di-set, GitHub mengisi env `CSC_LINK`
dengan string **kosong** — dan electron-builder memperlakukan `""` sebagai
path sertifikat yang sah, lalu `importCertificate("")` me-resolve-nya ke
project dir → crash `⨯ <projectDir> not a file` (terjadi di trial v1.1.0).
Step build di `release.yml` meng-`unset CSC_LINK` (plus password/name) bila
kosong sebelum memanggil electron-builder, sehingga variabel benar-benar
`undefined` → jalur ad-hoc. Jangan pernah set `CSC_LINK=""` secara eksplisit
saat uji lokal — hapus variable-nya saja.

### 4b. Notarisasi

Notarisasi butuh keanggotaan Apple Developer ($99/thn):

| Secret GitHub | Isi |
|---------------|-----|
| `APPLE_ID` | Apple ID (email) developer |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-Specific Password (Apple ID → Sign-In & Security → App-Specific Passwords) |
| `APPLE_TEAM_ID` | Team ID (developer.apple.com → Membership) |

Notarisasi **hanya aktif bila ketiganya ada** — job `build-mac` mengecek
ketiganya dan menambahkan `-c.mac.notarize=true` saat itu; `electron-builder.yml`
tetap `notarize: false` sebagai default aman agar build tanpa secret tidak gagal.

Saat ter-notarisasi, step verifikasi di CI **otomatis menjalankan
`xcrun stapler validate`** pada tiap DMG dan **`spctl -a -vv`** pada `.app` di
dalamnya (DMG di-mount dulu) — jadi release hanya terbit bila staple valid dan
Gatekeeper lolos. Build un-notarized melewati cek ini (log: "skipping
stapler/spctl").

**Prasyarat teknis (sudah terpasang):**
- `hardenedRuntime: true` di `electron-builder.yml` — wajib untuk notarisasi.
- `build/entitlements.mac.plist` — entitlement JIT/unsigned-executable-memory
  yang dibutuhkan runtime Electron.

### 4c. Arsitektur (dual-arch)

Workflow membangun **dua DMG terpisah** (`--x64 --arm64`), masing-masing bernama
`WorkspaceGraph-<version>-x64.dmg` / `-arm64.dmg` (via `${arch}` di
`dmg.artifactName`) — tidak saling menimpa. Dipilih daripada `--universal`
karena universal menggabungkan modul native (better-sqlite3) lintas arch, yang
lebih rawan gagal; dua DMG terpisah = dua build single-arch biasa yang
deterministik.

**Langkah setup:** tambah 6 secret (3 signing + 3 Apple) di Settings → Secrets,
lalu push tag. Verifikasi: `xcrun stapler validate WorkspaceGraph-1.0.0.dmg`
atau buka DMG di Mac — tanpa peringatan Gatekeeper "unidentified developer".

---

## 5. Matriks perilaku CI

| Secret | Ada | Tidak ada |
|--------|-----|-----------|
| `WIN_CSC_LINK` + password | `.exe` ter-sign | `.exe` unsigned (default sekarang) |
| `CSC_LINK` + password | `.app`/DMG ter-sign | env di-`unset` step build → ad-hoc unsigned |
| `APPLE_ID` + app-specific pw + team | DMG ter-notarisasi | DMG tidak dinotarisasi (build tetap sukses) |

Semua kombinasi **tidak membuat build gagal** — secret hanya menambah kualitas
artefak. Ini disengaja: pipeline release tidak boleh bergantung pada secret
yang belum di-set.

---

## 6. Uji lokal

```bash
# Windows signing (base64 cert di env)
WIN_CSC_LINK="$(base64 -w0 cert.pfx)" WIN_CSC_KEY_PASSWORD='***' \
  npx electron-builder --win --publish never

# macOS signing + notarization (dual-arch: --x64 --arm64)
CSC_LINK="$(base64 -w0 identity.p12)" CSC_KEY_PASSWORD='***' CSC_NAME='Developer ID Application: X (TEAM)' \
APPLE_ID='dev@example.com' APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx' APPLE_TEAM_ID='TEAMID' \
  npx electron-builder --mac --x64 --arm64 -c.mac.notarize=true --publish never
```

Catatan: `npm run build` (electron-vite) harus jalan dulu — output ada di
`out/`, packaging electron-builder di `dist/`.

---

## 7. Rollback / troubleshooting

### 7a. Verifikasi artifact di CI

Sebelum upload, kedua job build memverifikasi artifact (gagal = job merah,
release tidak terbit):

| Cek | build-win | build-mac |
|-----|-----------|-----------|
| Nama sesuai pola | tepat 1 `WorkspaceGraph-*-setup.exe` | tepat 2 DMG: `WorkspaceGraph-*-x64.dmg` + `*-arm64.dmg` |
| Ukuran minimum | ≥ 50 MB (`wc -c`) | ≥ 50 MB per DMG (`wc -c`) |
| Stapler + Gatekeeper | — | hanya saat ter-notarisasi: `xcrun stapler validate` tiap DMG + `spctl -a -vv` pada `.app` dalam DMG ter-mount |

- **Release salah** → hapus di GitHub (Releases → ⋯ → Delete); tag dihapus
  dengan `git push origin :refs/tags/vX.Y.Z` + `git tag -d vX.Y.Z`.
- **Build mac gagal di notarisasi** → cek 3 secret Apple benar; pastikan
  app-specific password (bukan password akun); Team ID cocok dengan Developer
  ID certificate.
- **SmartScreen "Windows protected your PC"** → EV cert diutamakan; OV butuh
  reputasi yang dibangun dari unduhan & signature time-stamping (otomatis oleh
  electron-builder).
- **`spctl` menolak DMG** → pastikan `hardenedRuntime: true` + entitlement
  JIT ada (sudah default di repo ini) dan build benar-benar ter-notarisasi
  (`stapler validate`).
- **`⨯ <projectDir> not a file` saat build mac** → `CSC_LINK` ter-set ke string
  kosong (secret belum ada / env `CSC_LINK=""` eksplisit). Workflow sudah
  meng-`unset`-nya otomatis; untuk build lokal, jangan set `CSC_LINK=""` —
  biarkan variable tidak ter-definisi.
