/**
 * Encrypt sensitive settings (API keys) using Electron safeStorage when available.
 * Fallback: base64 marker (dev) — never claim plaintext is "encrypted".
 */
import { safeStorage } from 'electron'

const ENC_PREFIX = 'enc:v1:'

export function encryptSecret(plain: string): string {
  if (!plain) return plain
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(plain)
      return ENC_PREFIX + buf.toString('base64')
    }
  } catch {
    /* fall through */
  }
  // Soft marker so we know it's intentional plaintext fallback
  return 'plain:' + plain
}

export function decryptSecret(stored: string): string {
  if (!stored) return stored
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')
        return safeStorage.decryptString(buf)
      }
    } catch {
      return ''
    }
    return ''
  }
  if (stored.startsWith('plain:')) return stored.slice(6)
  // Legacy plaintext API keys
  return stored
}

export function isEncryptedForm(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(ENC_PREFIX)
}

/** Encrypt all apiKey fields under settings.ai */
export function protectSettingsSecrets(settings: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
  const ai = clone.ai as Record<string, Record<string, string>> | undefined
  if (ai && typeof ai === 'object') {
    for (const id of Object.keys(ai)) {
      if (
        ai[id]?.apiKey &&
        !ai[id].apiKey.startsWith(ENC_PREFIX) &&
        !ai[id].apiKey.startsWith('plain:')
      ) {
        ai[id].apiKey = encryptSecret(ai[id].apiKey)
      } else if (ai[id]?.apiKey && ai[id].apiKey.startsWith('plain:')) {
        // re-encrypt if safeStorage now available
        const plain = decryptSecret(ai[id].apiKey)
        ai[id].apiKey = encryptSecret(plain)
      }
    }
  }
  return clone
}

/** Decrypt secrets for in-memory use (providers) */
export function revealSettingsSecrets(settings: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
  const ai = clone.ai as Record<string, Record<string, string>> | undefined
  if (ai && typeof ai === 'object') {
    for (const id of Object.keys(ai)) {
      if (ai[id]?.apiKey) {
        ai[id].apiKey = decryptSecret(ai[id].apiKey)
      }
    }
  }
  return clone
}
