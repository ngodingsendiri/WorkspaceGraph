/**
 * Self-write marker — prevents chokidar echo from double-processing a file
 * that the main process itself just wrote.
 *
 * Placed in its own module to avoid circular imports: both shared.ts (watcher)
 * and AutomationEngine need to call markSelfWrite, but shared.ts imports
 * AutomationEngine (for automation event dispatch).
 */
const selfWriteIgnore = new Map<string, number>()

export function markSelfWrite(filePath: string): void {
  selfWriteIgnore.set(filePath.replace(/\\/g, '/').toLowerCase(), Date.now())
}

export function isSelfWriteEcho(filePath: string, windowMs = 2500): boolean {
  const key = filePath.replace(/\\/g, '/').toLowerCase()
  const t = selfWriteIgnore.get(key)
  if (t == null) return false
  if (Date.now() - t > windowMs) {
    selfWriteIgnore.delete(key)
    return false
  }
  return true
}

/**
 * M7 FW1: purge expired markers — called periodically (vault open / watcher
 * attach) so the Map cannot grow unbounded across a long-lived session.
 */
export function pruneSelfWrites(maxAgeMs = 60_000): void {
  const now = Date.now()
  for (const [key, ts] of selfWriteIgnore) {
    if (now - ts > maxAgeMs) selfWriteIgnore.delete(key)
  }
}
