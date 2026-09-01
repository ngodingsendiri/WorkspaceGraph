# Contributing to WorkspaceGraph

Terima kasih sudah ingin berkontribusi! Dokumen ini berisi alur kerja pengembangan,
kualitas yang wajib dijaga (CI gates), dan cara rilis installer otomatis (tag → release),
termasuk persyaratan secret untuk code signing.

Detail lengkap rilis & signing: **[docs/RELEASE.md](docs/RELEASE.md)**.

---

## 1. Memulai

**Prasyarat:** Node.js v20+ (CI memakai 22) dan Git.

```bash
git clone https://github.com/ngodingsendiri/WorkspaceGraph.git
cd WorkspaceGraph
npm install
npm run dev          # mode development dengan HMR (Electron)
```

Perintah yang sering dipakai:

| Perintah | Fungsi |
|----------|--------|
| `npm run dev` | Jalankan app dalam mode development (HMR) |
| `npm run typecheck` | TypeScript check (node + web) |
| `npm test` | Seluruh suite Vitest (unit + integration + e2e + QA contracts) |
| `npm run test:flaky` | Suite dijalankan **2× berturut-turut** (guard flakiness R1-4) |
| `npm run lint` | ESLint (0 warning wajib) |
| `npm run check:crlf` | Guard LF-only untuk semua file teks ter-track (ADR-0004 / AG-2) |
| `npm run build` | Production build electron-vite (`out/`) |
| `npm run build:win` / `build:mac` / `build:linux` | Packaging installer lokal (`dist/`) |

> **LF-only.** Repo ini menerapkan kebijakan CRLF → LF (ADR-0004). Editor harus
> disetel ke LF dan jangan pernah meng-commit baris `\r\n` — guard `check:crlf`
> memblokir PR yang membawa CRLF (sejarah: 3342 warning lint dari debt
> prettier "Delete ␍").

---

## 2. Alur kerja pengembangan

1. **Buat branch** dari `main` (contoh: `feat/...`, `fix/...`). Jangan commit
   langsung ke `main`/`develop`.
2. **Commit dengan Conventional Commits** — gaya yang dipakai repo ini:
   - `feat(ui): ...`, `fix(engine): ...`, `refactor(...)`, `docs: ...`,
     `test(qa): ...`, `ci: ...`, `chore: ...`
   - Satu perubahan logis = satu commit; pesan menjelaskan **kenapa**, bukan cuma apa.
3. **Sebelum push / buka PR**, pastikan lokal hijau:
   ```bash
   npm run typecheck && npm run lint && npm run check:crlf && npm test
   ```
   (opsional: `npm run test:flaky` untuk regresi race antar-file)
4. **Buka PR** ke `main` — CI akan menjalankan gate (lihat §3).

**Jangan** mengubah dokumen keputusan secara diam-diam: keputusan desain yang
sudah tercatat di `docs/adr/` hanya bisa direvisi lewat ADR baru. Kalau perubahan
menyentuh domain/kontrak yang dikunci test QA, perbarui juga kontraknya
(`src/main/qa/sourceContracts.test.ts`) — jangan hanya menambah fitur.

---

## 3. Quality gates (CI)

Workflow **`.github/workflows/ci.yml`** berjalan untuk push ke `main`/`develop`
dan setiap PR. Semua job wajib hijau sebelum merge:

| Job | Perintah | Menjaga |
|-----|----------|---------|
| **TypeCheck** | `npm run typecheck` | Tidak ada error TS (node + web) |
| **Lint** | `npm run lint` | 0 warning ESLint (baseline bersih) |
| **CRLF Guard** | `npm run check:crlf` | Tidak ada CRLF di file teks ter-track (ADR-0004) |
| **Unit Tests** | `npx vitest run --coverage` | Seluruh suite + coverage |
| **Flaky (2×)** | `npm run test:flaky` | Race lintas-file tidak lolos (R1-4) |
| **Build** | `npm run build` | Production build jadi (`out/`) — berjalan setelah 4 job di atas |

Kalau job merah: baca log, perbaiki, push ulang. Jangan `--no-verify` dan jangan
menonaktifkan guard hanya karena "bentar, mau merge dulu".

---

## 4. Alur rilis (tag → release)

Installer dibuat otomatis oleh **`.github/workflows/release.yml`** saat tag semver
di-push. **Tidak perlu build manual di mesin sendiri.**

```bash
# 1. Pastikan version di package.json adalah versi yang mau dirilis
node -p "require('./package.json').version"

# 2. Bump bila perlu, commit, push main
npm version patch   # atau manual edit package.json + package-lock.json
git push origin main

# 3. Buat tag + push — workflow Release terpicu
git tag vX.Y.Z
git push origin vX.Y.Z
```

**Aturan wajib:** tag **harus cocok** dengan `version` di `package.json` —
`artifactName` electron-builder memakai `${version}`, jadi tag yang tidak cocok
menghasilkan release bernama beda dari installer-nya.

Yang terjadi setelah tag di-push (3 job):

| Job | Runner | Output |
|-----|--------|--------|
| `build-win` | `windows-latest` | `WorkspaceGraph-<v>-setup.exe` (NSIS x64) |
| `build-mac` | `macos-latest` | **Dua** DMG: `WorkspaceGraph-<v>-x64.dmg` + `-arm64.dmg` |
| `release` | `ubuntu-latest` | Unduh artifact → publish **satu** GitHub Release |

Setiap job build **memverifikasi artifact-nya sebelum upload** (gagal = job merah,
release tidak terbit): pola nama dikunci (tepat 1 `*-setup.exe` di Windows; tepat
2 DMG `*-x64`/`*-arm64` di macOS), ukuran minimum 50 MB, dan saat ter-notarisasi
`xcrun stapler validate` + `spctl -a -vv` dijalankan per DMG. Detail: `docs/RELEASE.md` §7a.

Panduan lengkap (rollback, uji lokal, troubleshooting): **[docs/RELEASE.md](docs/RELEASE.md)**.

---

## 5. Persyaratan secret (code signing)

Installers **unsigned** secara default — repo ini tidak memiliki sertifikat.
Signing hanya aktif bila secret berikut di-set di **Settings → Secrets and
variables → Actions**. Tanpa secret, build tetap sukses (unsigned/ad-hoc).

### Windows (NSIS)

| Secret | Isi |
|--------|-----|
| `WIN_CSC_LINK` | Sertifikat `.pfx` di-encode **base64** |
| `WIN_CSC_KEY_PASSWORD` | Password `.pfx` |

### macOS — signing

| Secret | Isi |
|--------|-----|
| `CSC_LINK` | Identitas signing `.p12` di-encode **base64** |
| `CSC_KEY_PASSWORD` | Password `.p12` |
| `CSC_NAME` | Nama identity (opsional, bila ada beberapa) |

### macOS — notarisasi (butuh Apple Developer, $99/thn)

| Secret | Isi |
|--------|-----|
| `APPLE_ID` | Apple ID (email) developer |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-Specific Password |
| `APPLE_TEAM_ID` | Team ID (Membership) |

Notarisasi **hanya aktif bila ketiga secret Apple ada** — step build menambahkan
`-c.mac.notarize=true` saat itu; selainnya DMG tetap dibangun un-notarized.

### ⚠️ Gotcha penting — jangan set secret kosong

Saat secret **tidak** di-set, GitHub mengisi env-nya dengan string **kosong**.
Untuk macOS ini berbahaya: electron-builder memperlakukan `CSC_LINK=""` sebagai
path sertifikat yang sah, lalu crash `⨯ <projectDir> not a file` (bug yang
ditemukan di trial v1.1.0). Workflow sudah meng-`unset` env signing saat kosong —
**jangan** meng-override dengan `CSC_LINK=""` secara manual di build lokal; biarkan
variable tidak ter-definisi. Detail: `docs/RELEASE.md` §4a.

---

## 6. Matriks perilaku CI

### Berdasarkan secret

| Secret | Ada | Tidak ada |
|--------|-----|-----------|
| `WIN_CSC_LINK` + password | `.exe` ter-sign | `.exe` unsigned (default) |
| `CSC_LINK` + password | `.app`/DMG ter-sign | env di-`unset` → ad-hoc unsigned |
| `APPLE_ID` + app-specific pw + team | DMG ter-notarisasi | DMG un-notarized (build tetap sukses) |

Semua kombinasi **tidak membuat build gagal** — secret hanya menaikkan kualitas
artefak. Ini disengaja: pipeline rilis tidak boleh bergantung pada secret yang
belum di-set.

### Berdasarkan trigger

| Trigger | Workflow | Menjalankan |
|---------|----------|-------------|
| Push / PR ke `main`, `develop` | `ci.yml` | typecheck, lint, CRLF guard, test, test 2×, build |
| Tag `v*` | `release.yml` | build NSIS + dual-arch DMG + verifikasi + publish release |

---

## 7. Dokumentasi & jejak audit

Repo ini menjaga jejak audit yang wajib diikuti saat berkontribusi:

- **`docs/STATUS_2026-08-24.md`** — status proyek terkini (apa selesai, apa tersisa).
- **`docs/adr/`** — Architecture Decision Records (keputusan yang tidak boleh
  direvisi tanpa ADR baru).
- **`docs/AUDIT_MENDALAM_2026-08-24.md`** — audit mendalam terbaru: temuan
  (severity + file:line + saran) & prioritas perbaikan P0–P3.
- **`docs/ROADMAP_PENYEMPURNAAN_2026-08-24.md`** — rencana perbaikan terstruktur
  per milestone (M0–M10) — kerjakan satu milestone per commit.
- **`src/main/qa/`** — test QA lintas-lapis, termasuk `sourceContracts.test.ts`
  yang mengunci kontrak modul/UI — jangan lolos dari pembaruan saat mengubah kontrak.

Kalau perubahan layak dicatat (fitur baru, keputusan desain, perubahan alur
rilis), perbarui STATUS dan tambah ADR bila perlu — jangan biarkan jejak basi.
