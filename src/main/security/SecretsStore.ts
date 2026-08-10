/**
 * Encrypt sensitive settings (API keys) using Electron safeStorage when available.
 * Fallback: base64 marker (dev) — never claim plaintext is "encrypted".
 */
import { safeStorage } from 'electron'

const ENC_PREFIX = 'enc:v1:'

// WA-8: warn ONCE per stored value — a permanently undecryptable key (device /
// keychain changed) must never look like a silent "empty key" on every read.
const warnedDecryptFailures = new Set<string>()

function warnDecryptFailure(stored: string, reason: string): void {
  if (warnedDecryptFailures.has(stored)) return
  warnedDecryptFailures.add(stored)
  console.warn(
    `[SecretsStore] API key cannot be decrypted (${reason}) — treated as missing. ` +
      'Re-enter the key in Settings to restore it.'
  )
}

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
        const plain = safeStorage.decryptString(buf)
        if (plain) return plain
        throw new Error('decrypted value is empty')
      }
    } catch (_err) {
      warnDecryptFailure(stored, 'safeStorage error')
      return ''
    }
    warnDecryptFailure(stored, 'safeStorage unavailable')
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

/**
 * Strip all API keys before sending settings to the renderer (never ship secrets).
 * Keeps a non-secret marker `apiKeySet` so the UI can show “saved” without the raw key.
 */
export function scrubSettingsSecrets(settings: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
  const ai = clone.ai as Record<string, Record<string, unknown>> | undefined
  if (ai && typeof ai === 'object') {
    for (const id of Object.keys(ai)) {
      if (ai[id] && typeof ai[id] === 'object') {
        const cfg = ai[id] as Record<string, unknown>
        const hasKey = Boolean(cfg.apiKey)
        cfg.apiKey = ''
        cfg.apiKeySet = hasKey
      }
    }
  }
  return clone
}

/**
 * Merge renderer-sent settings over current stored settings, preserving API keys
 * whenever the incoming payload leaves apiKey empty/absent (renderer only sees scrubbed
 * settings via settings:get, so a round-trip must never wipe the real stored key).
 */
export function mergeSettingsPreservingSecrets(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current, ...incoming }
  const curAi = (current.ai || {}) as Record<string, Record<string, unknown>>
  const inAi = incoming.ai
  if (inAi === undefined || inAi === null || typeof inAi !== 'object' || Array.isArray(inAi)) {
    return merged
  }

  const incomingAi = inAi as Record<string, Record<string, unknown>>
  const mergedAi: Record<string, Record<string, unknown>> = {}
  const ids = new Set([...Object.keys(curAi), ...Object.keys(incomingAi)])
  for (const id of ids) {
    const cur = curAi[id] || {}
    const inc = incomingAi[id] || {}
    // Renderer sends apiKey:'' when it has no new key — keep the stored one
    const apiKey = inc.apiKey ? inc.apiKey : cur.apiKey
    const { apiKeySet: _marker, ...incClean } = inc
    mergedAi[id] = { ...cur, ...incClean, apiKey }
  }
  merged.ai = mergedAi
  return merged
}
