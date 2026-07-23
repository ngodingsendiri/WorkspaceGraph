import fs from 'fs'
import matter from 'gray-matter'

const raw = fs.readFileSync('D:/Obs/Obs/05 Pegawai/00 Daftar Pegawai.md', 'utf8')
const content = matter(raw).content
console.log('content lines', content.split('\n').length, 'len', content.length)

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInline(text) {
  let s = text
  s = s.replace(
    /!\[([^\]]*?)\]\((https?:[^)\s]+|mailto:[^)\s]+)\)/gi,
    () => '<img>'
  )
  s = s.replace(
    /\[([^\]]+?)\]\((https?:[^)\s]+|mailto:[^)\s]+)\)/gi,
    (_m, label) => '<a>' + label + '</a>'
  )
  s = s.replace(/`([^`\n]+?)`/g, '<code>$1</code>')
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>')
  s = s.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>')
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>')
  s = s.replace(/==(.+?)==/g, '<mark>$1</mark>')
  return s
}

function isGfmSepRow(line) {
  const t = line.trim()
  if (!t.includes('-') || !t.includes('|')) return false
  return /^[\s|:=-]+$/.test(t) && /:-|-+/.test(t)
}

function isGfmTableRow(line) {
  const t = line.trim()
  if (!t || t.startsWith('```') || t.startsWith('#')) return false
  if (!(t.startsWith('|') || t.endsWith('|'))) return false
  return t.split('|').length >= 3
}

// wiki protect
let src = content.replace(/!?\[\[([^\]]+?)\]\]/g, () => 'WIKI')
const lines = src.split('\n')
console.log('after wiki, lines', lines.length)

// Test each line renderInline
for (let i = 0; i < lines.length; i++) {
  const t0 = Date.now()
  renderInline(escapeHtml(lines[i]))
  const dt = Date.now() - t0
  if (dt > 50) {
    console.log('SLOW inline line', i, 'ms', dt, 'len', lines[i].length, lines[i].slice(0, 80))
  }
}
console.log('all inline ok')

// simulate main loop with progress
let i = 0
let steps = 0
const tStart = Date.now()
while (i < lines.length) {
  steps++
  if (steps > 5000) {
    console.log('INFINITE LOOP at i=', i, 'line=', JSON.stringify(lines[i]?.slice(0, 100)))
    process.exit(3)
  }
  if (steps % 50 === 0) console.log('step', steps, 'i', i)
  const line = lines[i]
  if (i + 1 < lines.length && isGfmTableRow(line) && isGfmSepRow(lines[i + 1])) {
    let j = i + 2
    while (j < lines.length && isGfmTableRow(lines[j]) && !isGfmSepRow(lines[j])) j++
    console.log('table i', i, '->', j, 'rows', j - (i + 2))
    i = j
    continue
  }
  const hm = /^(#{1,6})\s+(.+)$/.exec(line)
  if (hm) {
    i++
    continue
  }
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim()) && line.trim().length >= 3) {
    i++
    continue
  }
  if (line.startsWith('>')) {
    while (i < lines.length && lines[i].startsWith('>')) i++
    continue
  }
  if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
    while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) i++
    continue
  }
  if (!line.trim()) {
    i++
    continue
  }
  // paragraph
  const buf = []
  while (i < lines.length) {
    const L = lines[i]
    if (!L.trim()) break
    if (/^(#{1,6})\s+/.test(L)) break
    if (L.startsWith('>')) break
    if (/^\s*([-*+]|\d+\.)\s+/.test(L)) break
    if (i + 1 < lines.length && isGfmTableRow(L) && isGfmSepRow(lines[i + 1])) break
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(L.trim()) && L.trim().length >= 3) break
    buf.push(L)
    i++
  }
  if (buf.length === 0) {
    console.log(
      'ZERO ADVANCE at i',
      i,
      JSON.stringify(line.slice(0, 120)),
      'isRow',
      isGfmTableRow(line),
      'nextSep',
      i + 1 < lines.length && isGfmSepRow(lines[i + 1])
    )
    process.exit(4)
  }
  renderInline(escapeHtml(buf.join('\n')))
}
console.log('done steps', steps, 'ms', Date.now() - tStart)
