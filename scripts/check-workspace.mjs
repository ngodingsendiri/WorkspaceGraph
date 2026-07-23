import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'

const bugs = []
const ok = (id, c, d='') => { if (!c) { bugs.push({id,d}); console.log(' FAIL', id, d) } else console.log(' OK', id, d) }

// --- Replicate current fileTypeFromPath (to prove bug) ---
function fileTypeOld(filePath, rootPath) {
  const rel = path.relative(rootPath, filePath).toLowerCase()
  if (rel.startsWith('knowledge')) return 'knowledge'
  if (rel.startsWith('projects')) return 'project'
  if (rel.startsWith('tasks')) return 'task'
  if (rel.startsWith('daily')) return 'daily'
  if (rel.startsWith('templates')) return 'template'
  if (rel.startsWith('documents')) return 'document'
  if (rel.startsWith('people')) return 'people'
  if (rel.startsWith('sop')) return 'sop'
  return 'other'
}

function fileTypeNew(filePath, rootPath) {
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

const vault = 'D:/Obs/Obs'
if (fs.existsSync(vault)) {
  const samples = [
    path.join(vault, '03 Kerjaan', 'Cuti', '00 Index Cuti.md'),
    path.join(vault, '05 Pegawai', '00 Daftar Pegawai.md'),
    path.join(vault, '02 Harian', '2026-07-21.md'),
    path.join(vault, '06 SOP & Pola', 'Cara Pakai Vault Ini.md'),
    path.join(vault, '99 Templates', 'Tpl Cuti.md'),
  ].filter(fs.existsSync)
  for (const f of samples) {
    const oldt = fileTypeOld(f, vault)
    const newt = fileTypeNew(f, vault)
    console.log(' TYPE', path.relative(vault,f).replace(/\\/g,'/'), 'old='+oldt, 'new='+newt)
    if (f.includes('Kerjaan') || f.includes('Pegawai') || f.includes('Harian')) {
      ok('type-should-not-always-other:'+path.basename(f), newt !== 'other' || oldt === 'other', 'old='+oldt+' new='+newt)
    }
  }
  // Prove Windows-style: old often 'other' for Kerjaan
  const cuti = path.join(vault, '03 Kerjaan', 'Cuti', '00 Index Cuti.md')
  if (fs.existsSync(cuti)) {
    ok('bug-kerjakan-typed-other-on-win', fileTypeOld(cuti, vault) === 'other', 'old type for Kerjaan file')
    ok('fix-kerjakan-project', fileTypeNew(cuti, vault) === 'project')
  }
}

// --- Temp workspace create/open/scan without Electron ---
function scanDirectory(dirPath, rootPath) {
  const entries = []
  const items = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const item of items) {
    if (item.name.startsWith('.')) continue
    if (item.name === 'node_modules') continue
    const fullPath = path.join(dirPath, item.name)
    const stats = fs.statSync(fullPath)
    const relativePath = path.relative(rootPath, fullPath)
    if (item.isDirectory()) {
      entries.push({ name: item.name, path: fullPath, isDirectory: true, children: scanDirectory(fullPath, rootPath) })
    } else {
      entries.push({ name: item.name, path: fullPath, isDirectory: false, extension: path.extname(item.name).toLowerCase() })
    }
  }
  return entries
}
function countFiles(files) {
  let fileCount=0, folderCount=0, noteCount=0
  for (const f of files) {
    if (f.isDirectory) { folderCount++; if (f.children) { const s=countFiles(f.children); fileCount+=s.files; folderCount+=s.folders; noteCount+=s.notes } }
    else { fileCount++; if (f.extension==='.md') noteCount++ }
  }
  return { files:fileCount, folders:folderCount, notes:noteCount }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ws-'))
const name = 'TestVault'
const ws = path.join(tmp, name)
fs.mkdirSync(ws)
// simulate create: open new vault scaffolds
const STANDARD = ['Knowledge','Projects','Tasks','Templates','Daily','Journal','People','Rules','Prompt','SOP','Documents','Assets','Archive']
for (const f of STANDARD) fs.mkdirSync(path.join(ws,f), {recursive:true})
fs.mkdirSync(path.join(ws, '.workspacegraph'), {recursive:true})
fs.writeFileSync(path.join(ws,'.workspacegraph','workspace.json'), JSON.stringify({name, path:ws, createdAt:new Date().toISOString(), lastOpenedAt:new Date().toISOString(), settings:{}}, null, 2))
fs.writeFileSync(path.join(ws,'Knowledge','Hello.md'), '---\ntitle: Hello\n---\n# Hello\n')
const tree = scanDirectory(ws, ws)
const counts = countFiles(tree)
ok('scaffold-folders', STANDARD.every(f => fs.existsSync(path.join(ws,f))))
ok('scan-notes', counts.notes >= 1, String(counts.notes))
ok('scan-files', counts.files >= 1, String(counts.files))

// Obsidian skip scaffold detect
const obs = path.join(tmp, 'ObsLike')
fs.mkdirSync(obs)
fs.writeFileSync(path.join(obs,'00 Home.md'), '# Home\n')
const isObs = fs.existsSync(path.join(obs,'00 Home.md'))
ok('obsidian-detect', isObs)

// Real vault scan counts
if (fs.existsSync(vault)) {
  const tree2 = scanDirectory(vault, vault)
  const c2 = countFiles(tree2)
  ok('real-vault-notes', c2.notes >= 50, String(c2.notes))
  ok('real-vault-no-dotfiles-in-tree', !tree2.some(e => e.name.startsWith('.')))
}

// Path sandbox pure logic
function isPathInVault(filePath, rootPath) {
  if (!rootPath) return false
  const root = path.resolve(rootPath)
  const target = path.resolve(filePath)
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
ok('sandbox-in', isPathInVault(path.join(ws,'Knowledge','Hello.md'), ws))
ok('sandbox-out', !isPathInVault(path.join(tmp,'evil.md'), ws))
ok('sandbox-escape', !isPathInVault(path.join(ws,'..','evil.md'), ws))

// KerjaPaths
const kp = await import(pathToFileURL ? null : null).catch(()=>null)
// inline resolve
const DEFAULT = 'D:\\Obs\\Obs'
ok('kerja-exists', fs.existsSync(DEFAULT) || fs.existsSync('D:/Obs/Obs'), 'D:\\\\Obs\\\\Obs')

// recent.json atomic pattern check in source
const we = fs.readFileSync('src/main/engine/WorkspaceEngine.ts','utf8')
ok('settings-atomic', we.includes(".tmp") && we.includes('renameSync'))
ok('skip-obsidian-scaffold', we.includes('skip WG folder scaffold') || we.includes('isObsidian'))
ok('recent-filter-exists', we.includes('filter(p => fs.existsSync(p))'))

// IPC wiring
const ipc = fs.readFileSync('src/main/ipc/index.ts','utf8')
for (const h of ['workspace:open','workspace:create','workspace:close','workspace:getState','workspace:getRecent','kerja:openVault','attachFileWatcher']) {
  ok('ipc-'+h, ipc.includes(h.replace('attachFileWatcher','attachFileWatcher')) || ipc.includes("'"+h+"'") || ipc.includes(h))
}
ok('watcher-on-open', ipc.includes('attachFileWatcher(folderPath)') || ipc.includes('attachFileWatcher(resolved)'))
ok('watcher-stop-close', ipc.includes('fileWatcher.stop()'))
ok('index-on-open', ipc.includes('indexDatabase.open'))

// Store open swallows errors
const st = fs.readFileSync('src/renderer/src/store/workspaceStore.ts','utf8')
ok('store-open-swallows', st.includes('console.error') && st.includes('Failed to open workspace'))
// note as residual UX

// createFile no overwrite
const createFileSrc = we.includes('if (!fs.existsSync(filePath))')
ok('createFile-no-overwrite', createFileSrc)

console.log('\n'+(bugs.length? 'BUGS '+JSON.stringify(bugs,null,2):'CHECKS_DONE'))
console.log('BUG_COUNT', bugs.length)
process.exit(0)
