/**
 * One-shot codemod: add explicit return types to every function flagged by
 * @typescript-eslint/explicit-function-return-type, using the return type
 * inferred by the TypeScript checker (zero behavior change).
 *
 * Usage: node scripts/add-return-types.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()

// 1) Ask eslint for every explicit-function-return-type occurrence.
const eslintOut = execFileSync(
  process.execPath,
  [
    'node_modules/eslint/bin/eslint.js',
    'src',
    '--no-cache',
    '--format',
    'json'
  ],
  { cwd: ROOT, encoding: 'utf8' }
)
const reports = JSON.parse(eslintOut)
const flagged = new Map() // file -> [{ line, column }]
for (const r of reports) {
  for (const m of r.messages) {
    if (m.ruleId !== '@typescript-eslint/explicit-function-return-type') continue
    const file = path.resolve(ROOT, r.filePath)
    if (!flagged.has(file)) flagged.set(file, [])
    flagged.get(file).push({ line: m.line, column: m.column })
  }
}
console.log('flagged files:', flagged.size)
let total = 0
for (const [, list] of flagged) total += list.length
console.log('flagged functions:', total)

// 2) Build TS programs from the real tsconfigs (node + web) so module
// resolution / libs / jsx match the project; patch via whichever program
// contains the file.
function buildPrograms() {
  const programs = []
  for (const c of ['tsconfig.node.json', 'tsconfig.web.json']) {
    const cfgPath = path.join(ROOT, c)
    if (!fs.existsSync(cfgPath)) continue
    const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(cfgPath))
    const host = ts.createCompilerHost(parsed.options)
    const program = ts.createProgram(parsed.fileNames, parsed.options, host)
    programs.push({ program, checker: program.getTypeChecker() })
  }
  // Fallback program: every flagged file (test files are excluded from both
  // tsconfigs), using node-style options so checker inference still works.
  const flaggedFiles = [...flagged.keys()]
  const options = {
    strict: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    skipLibCheck: true,
    allowJs: false,
    types: []
  }
  const host = ts.createCompilerHost(options)
  const program = ts.createProgram(flaggedFiles, options, host)
  programs.push({ program, checker: program.getTypeChecker(), fallback: true })
  return programs
}
const programs = buildPrograms()

const edits = new Map() // file -> [{ start, insert }]

function addEdit(file, start, text) {
  if (!edits.has(file)) edits.set(file, [])
  edits.get(file).push({ start, text })
}

function sameLine(fn, line) {
  const sf = fn.getSourceFile()
  const pos = fn.getStart(sf)
  const lc = sf.getLineAndCharacterOfPosition(pos)
  return lc.line + 1 === line
}

let patched = 0
let skipped = 0
const skipReasons = new Map()
function noteSkip(reason) {
  skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1)
}
for (const [file, list] of flagged) {
  const hostProg = programs.find((p) => p.program.getSourceFile(file))
  if (!hostProg) {
    skipped += list.length
    noteSkip('no-program')
    continue
  }
  const sf = hostProg.program.getSourceFile(file)
  for (const { line, column } of list) {
    let found = null
    const visit = (node) => {
      if (found) return
      if (
        (ts.isArrowFunction(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isMethodDeclaration(node)) &&
        node.type === undefined &&
        sameLine(node, line)
      ) {
        found = node
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    if (!found) {
      // Fallback: first untyped function on this line (eslint sometimes anchors
      // the identifier while the node start differs).
      const byLine = []
      const scan = (node) => {
        if (
          (ts.isArrowFunction(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isMethodDeclaration(node)) &&
          node.type === undefined &&
          sameLine(node, line)
        )
          byLine.push(node)
        ts.forEachChild(node, scan)
      }
      scan(sf)
      if (byLine.length === 0) {
        skipped++
        noteSkip('no-node-match line ' + line + ':' + column)
        continue
      }
      found = byLine[0]
    }
    const fn = found
    const sig = hostProg.checker.getSignatureFromDeclaration(fn)
    if (!sig) {
      skipped++
      noteSkip('no-signature')
      continue
    }
    const ret = sig.getReturnType()
    let typeStr = hostProg.checker.typeToString(ret, fn, ts.TypeFormatFlags.NoTruncation)
    // Never emit `any` (would trip no-explicit-any) or import() forms (invalid inline).
    if (/[<(]any[)>]/.test(typeStr) || /import\(/.test(typeStr) || typeStr.length > 220) {
      skipped++
      noteSkip('type-unemittable: ' + typeStr.slice(0, 60))
      continue
    }
    // Insert point: before `=>` for arrows, before body `{` for declarations/methods.
    let insertAt
    if (ts.isArrowFunction(fn)) {
      insertAt = fn.equalsGreaterThanToken.getStart(sf)
    } else {
      insertAt = fn.body.getStart(sf)
    }
    addEdit(file, insertAt, `: ${typeStr} `)
    patched++
  }
}

// 3) Apply edits from END of file to START so offsets stay valid.
let changedFiles = 0
for (const [file, list] of edits) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const byLine = new Map()
  for (const e of list) {
    const sf = ts.createSourceFile(file, lines.join('\n'), ts.ScriptTarget.Latest, true)
    const lc = sf.getLineAndCharacterOfPosition(e.start)
    if (!byLine.has(lc.line)) byLine.set(lc.line, [])
    byLine.get(lc.line).push({ char: lc.character, text: e.text })
  }
  const out = []
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const inserts = byLine.get(i)
    if (inserts) {
      for (const ins of [...inserts].sort((a, b) => a.char - b.char)) {
        line = line.slice(0, ins.char) + ins.text + line.slice(ins.char)
      }
    }
    out.push(line)
  }
  fs.writeFileSync(file, out.join('\n'))
  changedFiles++
}

console.log('patched:', patched, 'skipped:', skipped, 'files changed:', changedFiles)
console.log('skip reasons:', Object.fromEntries(skipReasons))
