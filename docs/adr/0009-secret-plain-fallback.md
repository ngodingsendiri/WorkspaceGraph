# ADR-0009: Fallback secret `plain:` tetap, ditandai "tidak terenkripsi" di UI

- **Status:** Accepted
- **Tanggal:** 2026-08-24
- **Area:** Security (`src/main/security/SecretsStore.ts`)

## Context

Audit mendalam 2026-08-24 (AI-8) mencatat `SecretsStore.encryptSecret` memakai fallback
`'plain:' + plain` saat `safeStorage.isEncryptionAvailable()` false (OS tanpa keychain —
mis. beberapa Linux headless). Ini menyimpan API key plaintext di `settings.json` dengan
marker. Spec 18:109 "Credential tidak boleh plaintext" secara harfiah dilanggar. Opsi:
(a) tolak persist, (b) kunci file lokal, (c) terima + tandai UI.

## Decision

- **Pertahankan fallback `plain:`** (opsi c) — menolak persist akan memblokir pengguna Linux
  tanpa keychain dari fitur inti AI.
- **Tandai eksplisit di UI**: Settings → AI menunjukkan status enkripsi per key
  ("Terenkripsi (aman)" vs "Tidak terenkripsi — OS keychain tidak tersedia") dan peringatan
  bahwa file settings.json berisi kunci terbaca.
- `security:status` sudah mengekspos info; UI memakai `apiKeySet` + status enkripsi.

## Consequences

- Positif: pengguna tetap bisa memakai AI di Linux tanpa keychain; risiko key tercetak jelas
  dikomunikasikan (bukan silent).
- Negatif: key plaintext masih mungkin ada di disk untuk lingkungan tanpa safeStorage —
  diterima, didokumentasikan, dan diberi label jujur (selaras ADR-0002).

## Referensi

- Audit: `docs/AUDIT_MENDALAM_2026-08-24.md` AI-8
- ADR-0002 (label jujur untuk state tak tersimpan)
