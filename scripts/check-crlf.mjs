#!/usr/bin/env node
/**
 * AG-2 guard (ADR-0004): fail CI (and local `npm run check:crlf`) when any
 * tracked text file contains CRLF line endings. This keeps the 3342 prettier
 * "Delete ␍" warnings from ever returning — they fired on CRLF working-tree
 * copies, and only for src/ (docs, package.json, fixtures were outside lint
 * scope, so a lint-only gate would miss CRLF creeping back into those).
 * (ADR-0004: LF policy — normalize once + .gitattributes eol=lf.)
 *
 * Intended exceptions (declared in .gitattributes):
 *  - *.bat  → cmd.exe label/goto parsing needs CRLF (START-APP.bat)
 *  - binary assets (png/ico/icns) → \r bytes are binary content, not EOLs
 *
 * Fix: perl -pi -e 's/\r$//' <file>  (or `npm run format` for prettier files)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const EXCLUDE_EXT = new Set(['.png', '.ico', '.icns', '.bat'])

/** NUL byte in the first 8KB ⇒ binary (skips PNG/ICO/ICNS content safely). */
function isBinary(buf) {
  return buf.subarray(0, 8192).includes(0)
}

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

const bad = []
for (const f of tracked) {
  const ext = f.slice(f.lastIndexOf('.')).toLowerCase()
  if (EXCLUDE_EXT.has(ext)) continue
  if (!fs.existsSync(f)) continue
  const buf = fs.readFileSync(f)
  if (isBinary(buf)) continue
  if (buf.includes(0x0d)) bad.push(f)
}

if (bad.length > 0) {
  console.error(`check:crlf FAIL — CRLF found in ${bad.length} tracked text file(s):`)
  for (const f of bad) console.error(`  ${f}`)
  console.error("\nFix each with:  perl -pi -e 's/\\r$//' <file>")
  console.error('Then re-add (git stores LF via .gitattributes text=auto eol=lf).')
  process.exit(1)
}
console.log(`check:crlf OK — ${tracked.length} tracked files scanned, no CRLF in text files`)
