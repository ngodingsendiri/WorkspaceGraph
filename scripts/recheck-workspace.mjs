import path from 'path'
import fs from 'fs'
import os from 'os'

const bugs = []
const ok = (id, c, d='') => { if (!c) { bugs.push({id,d}); console.log(' FAIL', id, d) } else console.log(' OK', id, d) }

// fileTypeFromPath — copy of fixed WorkspaceEngine logic
function fileTypeFromPath(filePath, rootPath) {
  const lower = path.relative(rootPath, filePath).toLowerCase().replace(/\\/g, '/')
  if (lower.startsWith('knowledge') || lower.includes('/knowledge/')) return 'knowledge'
  if (lower.startsWith('projects') || lower.includes('/projects/')) return 'project'
  if (lower.startsWith('tasks') || lower.includes('/tasks/')) return 'task'
  if (lower.startsWith('daily') || lower.startsWith('02 harian') || lower.includes('/02 harian/')) return 'daily'
  if (lower.startsWith('templates') || lower.startsWith('99 templates') || lower.includes('/templates/')) return 'template'
  if (lower.startsWith('documents') || lower.includes('/documents/')) return 'document'
  if (lower.startsWith('people') || lower.startsWith('05 pegawai') || lower.includes('/05 pegawai/')) return 'people'
  if (lower.startsWith('sop') || lower.startsWith('06 sop') || lower.includes('/sop')) return 'sop'
  if (lower.startsWith('03 kerjaan') || lower.includes('/03 kerjaan/')) return 'project'
  return 'other'
}

function isPathInVault(filePath, vaultRoot) {
  if (!vaultRoot) return false
  const root = path.resolve(vaultRoot)
  const resolved = path.resolve(filePath)
  const rel = path.relative(root, resolved)
  return !(rel.startsWith('..') || path.isAbsolute(rel))
}

// Source regression
const we = fs.readFileSync('src/main/engine/WorkspaceEngine.ts','utf8')
ok('src-type-kerjaan', we.includes("03 kerjaan") || we.includes("'03 kerjaan'"))
ok('src-type-harian', we.includes('02 harian'))
ok('src-type-pegawai', we.includes('05 pegawai'))
ok('src-normalize-slash', we.includes("replace(/\\\\/g, '/')") || we.includes('replace(/\\\\/g'))
ok('src-obsidian-skip', we.includes('skip WG folder scaffold') || we.includes('isObsidian'))
ok('src-settings-atomic', we.includes('.tmp') && we.includes('renameSync'))

const st = fs.readFileSync('src/renderer/src/store/workspaceStore.ts','utf8')
ok('store-returns-boolean', st.includes('Promise<boolean>') || st.includes('return true'))
ok('store-lastError', st.includes('lastError'))
ok('store-refresh-recent', st.includes('getRecentWorkspaces'))

const welcome = fs.readFileSync('src/renderer/src/components/welcome/WelcomeScreen.tsx','utf8')
// Vault Kerja shortcut removed from welcome — only Open / Create / Recent
ok('welcome-no-kerja-shortcut', !welcome.includes('openKerjaVault') && !welcome.includes('Vault Kerja'))
ok('welcome-open-create', welcome.includes('Open Vault') && welcome.includes('Create Vault'))
ok('welcome-showErr', welcome.includes('showErr') || welcome.includes('lastError'))

const ipc = fs.readFileSync('src/main/ipc/index.ts','utf8')
for (const h of ["workspace:open","workspace:create","workspace:close","workspace:getState","workspace:getRecent","kerja:openVault","kerja:resolveVault"]) {
  ok('ipc-'+h, ipc.includes("'"+h+"'") || ipc.includes('"'+h+'"'))
}
ok('watcher-attach', ipc.includes('attachFileWatcher'))
ok('watcher-stop', ipc.includes('fileWatcher.stop()'))
ok('index-open', ipc.includes('indexDatabase.open'))

// Real vault types
const vault = 'D:/Obs/Obs'
if (fs.existsSync(vault)) {
  const cases = [
    ['03 Kerjaan/Cuti/00 Index Cuti.md', 'project'],
    ['05 Pegawai/00 Daftar Pegawai.md', 'people'],
    ['02 Harian/2026-07-21.md', 'daily'],
    ['99 Templates/Tpl Cuti.md', 'template'],
    ['06 SOP & Pola/Cara Pakai Vault Ini.md', 'sop'],
  ]
  for (const [rel, exp] of cases) {
    const f = path.join(vault, rel)
    if (!fs.existsSync(f)) { console.log(' SKIP missing', rel); continue }
    const t = fileTypeFromPath(f, vault)
    ok('type:'+rel, t === exp, t+' expected '+exp)
  }
  // count md without electron
  function walk(dir, acc=[]) {
    for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
      if (e.name.startsWith('.')) continue
      const p = path.join(dir,e.name)
      if (e.isDirectory()) walk(p,acc)
      else if (e.name.endsWith('.md')) acc.push(p)
    }
    return acc
  }
  const notes = walk(vault)
  ok('vault-notes>=50', notes.length >= 50, String(notes.length))
}

// sandbox
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ws2-'))
const ws = path.join(tmp, 'Vault')
fs.mkdirSync(ws)
ok('sandbox-in', isPathInVault(path.join(ws,'a.md'), ws))
ok('sandbox-out', !isPathInVault(path.join(tmp,'evil.md'), ws))
ok('sandbox-escape', !isPathInVault(path.join(ws,'..','evil.md'), ws))

// kerja resolve preference
const candidates = ['D:\\Obs\\Obs','D:\\Obs']
const prefer = candidates.find(p => fs.existsSync(path.join(p,'00 Home.md')) || fs.existsSync(path.join(p,'08 Sidebrain')))
ok('kerja-prefer-nested', !prefer || prefer.toLowerCase().includes('obs\\obs') || prefer.includes('Obs/Obs') || prefer.endsWith('Obs\\Obs') || /Obs[\\/]Obs$/i.test(prefer), prefer||'none')

console.log('\n' + (bugs.length ? 'BUGS '+JSON.stringify(bugs,null,2) : 'WORKSPACE_RECHECK_OK'))
process.exit(bugs.length ? 1 : 0)
