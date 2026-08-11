# ADR-0004: Kebijakan line ending — LF, normalize sekali + `.gitattributes` + CI guard

- **Status:** Accepted
- **Tanggal:** 2026-08-10
- **Area:** Kebijakan lint/repo (prettier, git, CI)

## Context

Temuan audit **AG-2** (Wave G): **3342 warning `prettier/prettier` (Delete ␍)** — debt CRLF
pre-existing. `npm run lint` gagal karena `--max-warnings 0`, memblokir baseline kebersihan semua
milestone. Opsi:

- **(a) Normalize LF sekali** (satu commit besar).
- **(b) `endOfLine: auto`** di `.prettierrc.yaml` + biarkan CRLF.
- **(c) Terima sebagai non-blocker** (dokumentasikan).

## Decision

**Pilih (a): normalize seluruh repo ke LF sekali + kunci dengan `.gitattributes` + guard CI.**

Fakta yang mengubah keputusan: setelah diukur, hanya **17 file** ber-CRLF
(`src/main/ai/**`, `src/main/mcp/**`, handlers `mcp.ts`/`workspace.ts`, `qa/ipcHandlers.e2e.test.ts`)
— satu commit kecil, bukan rombak repo. Saran awal (b) digantikan oleh fakta baru ini.

Implementasi:

1. **Normalize:** sisa 14 file CRLF di-normalize ke LF (`perl -s/\r$//`). Normalize **tidak
   mengubah git diff** — blob HEAD sudah LF; CRLF hanya artefak checkout `autocrlf=true`. Efeknya
   menyembuhkan lint.
2. **`.gitattributes`:** `* text=auto eol=lf` + pengecualian `*.bat text eol=crlf` (START-APP.bat
   butuh CRLF untuk parsing label/goto cmd.exe); binary (png/ico/icns) tidak tersentuh.
3. **CI guard (tambahan):** `scripts/check-crlf.mjs` + `npm run check:crlf` + job `crlf` di
   `.github/workflows/ci.yml` — scan **semua tracked text file** (lint hanya cover `src/`, jadi
   docs/package.json/fixtures tidak terjangkau lint); skip `*.bat` + binary; gagal dengan pesan fix.
   Jalan di tiap push/PR tanpa `npm ci` (murni git+node).
4. **Bonus saat eksekusi:** setelah CRLF beres, 57 warning pre-existing lain yang tenggelam
   dibersihkan (37 unused `eslint-disable` + 20 `no-explicit-any`) → **`npm run lint` exit=0
   dengan `--max-warnings 0`**.

## Consequences

**Positif:**

- Baseline lint bersih dan **dijaga** — CI guard mencegah CRLF balik (melindungi docs/fixtures
  yang tidak terjangkau eslint), jadi debt tidak kembali.
- Line ending deterministik di semua checkout (LF), terlepas `core.autocrlf` mesin developer.

**Trade-off / negatif:**

- `.gitattributes` mengubah semantik checkout: file yang di-checkout di Windows kini LF (kecuali
  `*.bat`). Ini normal untuk repo modern dan merupakan tujuan keputusan.
- Commit normalize sekali menambah riwayat diff — kecil (17 file) dan sudah terukur.

## Referensi

- `.gitattributes` — `* text=auto eol=lf` + pengecualian `*.bat`
- `scripts/check-crlf.mjs`, `package.json` (`check:crlf`), `.github/workflows/ci.yml` (job `crlf`) — header script menyebut `ADR-0004` (2026-08-11)
- `docs/TODO_FIX_2026-08-10.md` — entri AG-2 (keputusan ✅ + CI guard)
- `docs/FIX_PLAN_2026-08-10.md` — tabel Gate 0 AG-2 ✅ **DIPUTUSKAN: (a)**
