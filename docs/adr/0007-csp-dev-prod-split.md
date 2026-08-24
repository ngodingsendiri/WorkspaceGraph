# ADR-0007: CSP production dipisah dari dev (tanpa unsafe-eval/inline)

- **Status:** Accepted
- **Tanggal:** 2026-08-24
- **Area:** Security (`src/main/index.ts`)

## Context

Audit mendalam 2026-08-24 (SEC-4) mencatat `script-src 'self' 'unsafe-eval' 'unsafe-inline'`
dipakai untuk semua mode. `unsafe-eval`/`unsafe-inline` dibutuhkan Vite React Refresh di
mode dev, tetapi sama-sama diterapkan di production — melemahkan defense-in-depth bila ada
bug XSS di renderer. Postur saat ini dianggap aman (renderer trusted + XSS markdown
terkendali), tapi prinsip Zero Trust/Defense in Depth (spec 33) mendukung pemisahan.

## Decision

- Pisahkan CSP berdasarkan `app.isPackaged` (atau `is.dev`):
  - **Dev:** `script-src 'self' 'unsafe-eval' 'unsafe-inline'` (Vite HMR/React refresh).
  - **Production:** `script-src 'self'` (tanpa unsafe-eval/inline), `style-src 'self'`,
    `connect-src 'self' https:` (provider AI + HMR tidak relevan di prod),
    `worker-src 'self' blob:`.
- Pertahankan `contextIsolation: true` (sudah); `sandbox: false` tetap (preload contextBridge).

## Consequences

- Positif: production tidak lagi mengizinkan eval/inline — serangan XSS kehilangan vektor utama.
- Negatif: bila ada komponen yang sengaja memakai eval/inline di prod, akan blokir — perlu
  diuji saat rilis; risiko kecil karena renderer memakai React + CSS eksternal.

## Referensi

- Audit: `docs/AUDIT_MENDALAM_2026-08-24.md` SEC-4
- Roadmap: M8
