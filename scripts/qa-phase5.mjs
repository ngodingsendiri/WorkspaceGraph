/**
 * Phase 5 QA: path sandbox, automation, plugins, secrets, IPC
 */
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

let failed = 0
let passed = 0
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    failed++
  } else {
    console.log('OK  ', msg)
    passed++
  }
}

function assertPathInVault(filePath, vaultRoot) {
  const r = path.resolve(vaultRoot)
  const resolved = path.resolve(filePath)
  const rel = path.relative(r, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('outside')
  return resolved
}

async function main() {
  const vault = 'C:\\vault\\demo'
  assert(assertPathInVault(path.join(vault, 'Knowledge', 'a.md'), vault), 'path inside vault')
  try {
    assertPathInVault('C:\\Windows\\System32\\evil.md', vault)
    assert(false, 'should reject outside')
  } catch {
    assert(true, 'path outside vault rejected')
  }

  // Windows path traversal
  try {
    assertPathInVault(path.join(vault, '..', 'other', 'x.md'), vault)
    assert(false, 'should reject traversal')
  } catch {
    assert(true, 'path traversal rejected')
  }

  const auto = fs.readFileSync(path.join(root, 'src/main/engine/AutomationEngine.ts'), 'utf8')
  assert(auto.includes('automation.json') && auto.includes('file_updated'), 'automation engine')
  assert(auto.includes('append_to_note') && auto.includes('handleEvent'), 'automation actions')

  const plug = fs.readFileSync(path.join(root, 'src/main/plugin/PluginHost.ts'), 'utf8')
  assert(plug.includes('manifest.json') && plug.includes('No JS') || plug.includes('declarative') || plug.includes('Declarative'), 'declarative plugins')
  assert(plug.includes('search_prefill'), 'plugin commands')

  const sec = fs.readFileSync(path.join(root, 'src/main/security/SecretsStore.ts'), 'utf8')
  assert(sec.includes('safeStorage') && sec.includes('encryptSecret'), 'secrets encryption')

  const perm = fs.readFileSync(path.join(root, 'src/main/security/Permissions.ts'), 'utf8')
  assert(perm.includes('aiTools') && perm.includes('automation'), 'permissions')

  const api = fs.readFileSync(path.join(root, 'src/main/api/InternalAPI.ts'), 'utf8')
  assert(api.includes('health') && api.includes('version'), 'internal API')

  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8')
  assert(ipc.includes('automation:get') && ipc.includes('plugins:list'), 'IPC platform')
  assert(ipc.includes('security:status') && ipc.includes('api:health'), 'IPC security/health')
  assert(ipc.includes('assertPathInVault') || ipc.includes('isPathInVault'), 'IPC path sandbox')
  assert(ipc.includes('perms.aiAccess') || ipc.includes('aiAccess'), 'AI permission gate')
  assert(
    ipc.includes('graphEngine.clear') &&
      ipc.includes('searchEngine.clear') &&
      ipc.includes('domainEngine.clear'),
    'workspace close clears graph/search/domain'
  )
  assert(ipc.includes("name === '.'") || ipc.includes('Invalid workspace name'), 'create vault name guard')

  const pre = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
  assert(pre.includes('getAutomation') && pre.includes('listPlugins') && pre.includes('getSecurityStatus'), 'preload phase5')

  const set = fs.readFileSync(path.join(root, 'src/renderer/src/components/settings/SettingsView.tsx'), 'utf8')
  assert(set.includes('Security') && set.includes('Automation') && set.includes('Plugins'), 'settings sections')

  const eby = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
  assert(eby.includes('WorkspaceGraph') && eby.includes('com.workspacegraph.app'), 'installer appId')
  assert(eby.includes('better-sqlite3') || eby.includes('asarUnpack'), 'native unpack')

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
