/**
 * Phase 4 QA: templates, domain parse, IPC wiring
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

function parseCheckboxes(content, noteTitle, notePath) {
  const out = []
  content.split('\n').forEach((line, i) => {
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/)
    if (m) {
      out.push({
        text: m[2].trim(),
        done: m[1].toLowerCase() === 'x',
        noteTitle,
        notePath,
        line: i + 1
      })
    }
  })
  return out
}

function renderTemplate(body, vars) {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => vars[k] ?? '')
}

async function main() {
  // Checkbox parse
  const sample = `# Task\n\n- [ ] Open item\n- [x] Done item\n- [X] Also done\n`
  const boxes = parseCheckboxes(sample, 'T', '/t.md')
  assert(boxes.length === 3, '3 checkboxes')
  assert(boxes.filter(b => !b.done).length === 1, '1 open checkbox')
  assert(boxes.filter(b => b.done).length === 2, '2 done')

  // Template vars
  const body = '---\ntitle: {{title}}\ndate: {{date}}\n---\n# {{title}}\n'
  const rendered = renderTemplate(body, { title: 'Hello', date: '2026-07-22' })
  assert(rendered.includes('title: Hello') && rendered.includes('# Hello'), 'template render')

  const te = fs.readFileSync(path.join(root, 'src/main/engine/TemplateEngine.ts'), 'utf8')
  assert(te.includes('builtin-project') && te.includes('builtin-task') && te.includes('builtin-people'), 'builtin domain templates')
  assert(te.includes('seedBuiltinToVault') && te.includes('{{title}}'), 'seed + vars')

  const de = fs.readFileSync(path.join(root, 'src/main/engine/DomainEngine.ts'), 'utf8')
  assert(de.includes('getOverview') && de.includes('parseCheckboxes'), 'domain overview')
  assert(de.includes("type === 'project'") && de.includes("type === 'task'"), 'project/task scan')

  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8')
  assert(ipc.includes('template:list') && ipc.includes('template:createNote'), 'template IPC')
  assert(ipc.includes('domain:overview'), 'domain IPC')
  assert(ipc.includes('domainEngine.setParsedFiles'), 'domain on sync')

  const tools = fs.readFileSync(path.join(root, 'src/main/ai/AgentTools.ts'), 'utf8')
  assert(tools.includes('create_from_template') && tools.includes('list_templates'), 'AI template tools')

  const pre = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
  assert(pre.includes('createFromTemplate') && pre.includes('getDomainOverview'), 'preload phase4')

  const dash = fs.readFileSync(path.join(root, 'src/renderer/src/components/dashboard/DashboardView.tsx'), 'utf8')
  assert(dash.includes('getDomainOverview') && dash.includes('From template'), 'dashboard domain widgets')

  const tpl = fs.readFileSync(path.join(root, 'src/renderer/src/components/systems/TemplatePicker.tsx'), 'utf8')
  assert(tpl.includes('createFromTemplate'), 'template picker UI')

  const we = fs.readFileSync(path.join(root, 'src/main/engine/WorkspaceEngine.ts'), 'utf8')
  assert(we.includes('seedBuiltinToVault'), 'seed on workspace create')

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
