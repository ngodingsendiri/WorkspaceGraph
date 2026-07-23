/**
 * Verify CRLF hang fix for MarkdownEngine (open/save path).
 * Run after: esbuild MarkdownEngine.ts → MarkdownEngine.mjs
 */
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { performance } from 'perf_hooks'

const enginePath = path.join(process.cwd(), 'scripts/.tmp-engines/MarkdownEngine.mjs')
const m = await import(pathToFileURL(enginePath).href)
const e = m.markdownEngine

let failed = 0
function ok(label, cond, detail = '') {
  if (cond) console.log('  PASS', label, detail ? `— ${detail}` : '')
  else {
    failed++
    console.log('  FAIL', label, detail ? `— ${detail}` : '')
  }
}

function timed(fn, maxMs) {
  const t0 = performance.now()
  const result = fn()
  const ms = performance.now() - t0
  return { result, ms, slow: ms > maxMs }
}

console.log('\n=== 1) CRLF synthetic (the original hang pattern) ===')
{
  const crlf = '# Judul\r\n\r\nParagraf **bold** dan *italic*\r\n\r\n| A | B |\r\n|---|---|\r\n| 1 | [[Note\\|alias]] |\r\n'
  const { result: h, ms, slow } = timed(() => e.renderToHtml(crlf), 200)
  ok('render finishes <200ms', !slow && ms < 200, `${ms.toFixed(2)}ms`)
  ok('has h1', h.includes('<h1'))
  ok('has table', h.includes('<table>'))
  ok('has strong', h.includes('<strong>'))
  ok('has wiki', h.includes('wiki-link') || h.includes('data-target'))

  const p = e.parseFile('t.md', crlf, '')
  ok('parse heads >= 1', p.headings.length >= 1, `heads=${p.headings.length}`)
  ok('raw has no CR', !p.rawContent.includes('\r'))
  ok('content has no CR', !p.content.includes('\r'))
}

console.log('\n=== 2) Pathological: many headings only CRLF (loop stress) ===')
{
  const lines = []
  for (let i = 0; i < 200; i++) lines.push(`# Heading ${i}\r`)
  const doc = lines.join('\n') + '\n'
  const { result: h, ms, slow } = timed(() => e.renderToHtml(doc), 500)
  ok('200 CRLF headings <500ms', !slow, `${ms.toFixed(2)}ms len=${h.length}`)
  ok('produces h1 tags', (h.match(/<h1/g) || []).length >= 200)
}

console.log('\n=== 3) Real vault: 00 Daftar Pegawai.md ===')
{
  const f = 'D:/Obs/Obs/05 Pegawai/00 Daftar Pegawai.md'
  if (!fs.existsSync(f)) {
    console.log('  SKIP file missing')
  } else {
    const raw = fs.readFileSync(f, 'utf8')
    const hasCr = raw.includes('\r')
    console.log(`  file size ${raw.length}, CRLF=${hasCr}`)

    const { result: light, ms: msL } = timed(
      () => e.parseFile(f, raw, 'D:/Obs/Obs', { light: true }),
      100
    )
    ok('light parse <100ms', msL < 100, `${msL.toFixed(2)}ms`)

    const { result: full, ms: msF } = timed(() => e.parseFile(f, raw, 'D:/Obs/Obs'), 200)
    ok('full parse <200ms', msF < 200, `${msF.toFixed(2)}ms`)
    ok('headings found', full.headings.length > 0, `heads=${full.headings.length}`)
    ok('wikis found', full.wikiLinks.length > 0, `wikis=${full.wikiLinks.length}`)

    const { result: html, ms: msH, slow } = timed(() => e.renderToHtml(full.content), 200)
    ok('render <200ms (was infinite)', !slow && msH < 200, `${msH.toFixed(2)}ms`)
    ok('html table', html.includes('<table>'))
    ok('html h1/h2', html.includes('<h1') || html.includes('<h2'))

    // 20x stress — must not hang
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) e.renderToHtml(full.content)
    const multi = performance.now() - t0
    ok('20x render <1s', multi < 1000, `${multi.toFixed(2)}ms`)
  }
}

console.log('\n=== 4) Real vault: sample pegawai person note ===')
{
  const f = 'D:/Obs/Obs/05 Pegawai/Riko Febrianto.md'
  if (!fs.existsSync(f)) {
    console.log('  SKIP file missing')
  } else {
    const raw = fs.readFileSync(f, 'utf8')
    const p = e.parseFile(f, raw, 'D:/Obs/Obs')
    const { result: html, ms } = timed(() => e.renderToHtml(p.content), 100)
    ok('person render <100ms', ms < 100, `${ms.toFixed(2)}ms heads=${p.headings.length}`)
    ok('person tables', html.includes('<table>'))
  }
}

console.log('\n=== 5) Light open path shape (file:read) ===')
{
  const f = 'D:/Obs/Obs/05 Pegawai/Riko Febrianto.md'
  if (fs.existsSync(f)) {
    const raw = fs.readFileSync(f, 'utf8')
    const p = e.parseFile(f, raw, 'D:/Obs/Obs', { light: true })
    ok('light: empty wiki scan', p.wikiLinks.length === 0)
    ok('light: empty headings', p.headings.length === 0)
    ok('light: has content', p.content.length > 0)
    ok('light: title set', Boolean(p.title))
  }
}

console.log('\n=== 6) openTab-related store checks (static) ===')
{
  const storePath = path.join(process.cwd(), 'src/renderer/src/store/editorStore.ts')
  const src = fs.readFileSync(storePath, 'utf8')
  ok('openTab does not await flushSave', !/await get\(\)\.flushSave\(prev\)/.test(src))
  ok('saveTab does not await renderHtml', !/await renderHtml\(snapshot\)/.test(src))
  ok('openTab uses setTimeout refreshLinks', /setTimeout\(\(\) => \{\s*void get\(\)\.refreshLinks/.test(src))
}

console.log('\n' + (failed === 0 ? 'ALL CHECKS PASSED' : `FAILED: ${failed} check(s)`))
process.exit(failed === 0 ? 0 : 1)
