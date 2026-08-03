/**
 * Shared QA helper — concatenated source of every .ts file under src/main/ipc.
 *
 * IPC handlers live in multiple modules (registrar index.ts + handlers/*.ts +
 * shared.ts). QA assertions on channel strings must survive module splits, so
 * instead of reading src/main/ipc/index.ts we read the whole directory.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function readIpcSource() {
  const dir = path.join(__dirname, '..', 'src', 'main', 'ipc')
  let out = ''
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.ts')) out += fs.readFileSync(p, 'utf8') + '\n'
    }
  }
  walk(dir)
  return out
}
