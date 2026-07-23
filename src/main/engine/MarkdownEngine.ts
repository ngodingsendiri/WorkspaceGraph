import matter from 'gray-matter'
import path from 'path'
import crypto from 'crypto'

// NOTE: do NOT use remark/remark-gfm in the Electron main bundle —
// electron-vite/rollup mangles their ESM plugin exports into empty presets
// ("Expected usable value but received an empty preset"). Tables/GFM are
// handled by a pure-TS renderer below instead.

export interface ParsedFrontmatter {
  title?: string
  type?: string
  status?: string
  tags?: string[]
  owner?: string
  project?: string
  priority?: string
  date?: string
  created?: string
  updated?: string
  aliases?: string[]
  [key: string]: unknown
}

export interface WikiLink {
  target: string
  alias?: string
  rawText: string
  position: { start: number; end: number }
}

export interface ParsedMarkdown {
  id: string
  filePath: string
  relativePath: string
  title: string
  frontmatter: ParsedFrontmatter
  content: string
  rawContent: string
  wikiLinks: WikiLink[]
  tags: string[]
  wordCount: number
  headings: { level: number; text: string }[]
}

// Match full [[...]] then split alias on unescaped | (Obsidian table cells use \|)
const WIKI_LINK_INNER_REGEX = /\[\[([^\]]+?)\]\]/g
const TAG_INLINE_REGEX = /#([a-zA-Z0-9_/-]+)/g

/** Strip fenced/inline code so [[links]] inside code do not create graph edges (Obsidian behavior). */
function stripCodeRegions(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]+`/g, (m) => ' '.repeat(m.length))
}

/**
 * Parse Obsidian wikilinks:
 *  [[Note]] [[path/Note]] [[Note|alias]] [[path/Note\|alias]] (escaped pipe in tables)
 *  [[Note#Heading]] [[Note^block]]
 *  ![[embed]] still counts as a link (Obsidian graph connects embeds)
 */
function extractWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = []
  // Work on code-stripped text but keep positions aligned (spaces preserve indices)
  const scan = stripCodeRegions(content)
  let match: RegExpExecArray | null
  const regex = new RegExp(WIKI_LINK_INNER_REGEX.source, 'g')
  while ((match = regex.exec(scan)) !== null) {
    const inner = match[1]
    // Obsidian tables escape alias pipe as \| — treat it as normal | delimiter
    const normalized = inner.replace(/\\\|/g, '|')
    const pipe = normalized.indexOf('|')
    const targetPart = pipe >= 0 ? normalized.slice(0, pipe) : normalized
    const aliasPart = pipe >= 0 ? normalized.slice(pipe + 1).trim() : undefined

    // Drop heading/block anchors; normalize path separators
    let target = targetPart.split('#')[0].split('^')[0].trim()
    target = target
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .trim()
    if (!target) continue

    // Prefer rawText from original content
    const rawText = content.slice(match.index, match.index + match[0].length) || match[0]

    links.push({
      target,
      alias: aliasPart || undefined,
      rawText,
      position: { start: match.index, end: match.index + match[0].length }
    })
  }
  return links
}

function extractHeadings(content: string): { level: number; text: string }[] {
  const headings: { level: number; text: string }[] = []
  const lines = content.split('\n')
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+)$/)
    if (m) {
      headings.push({ level: m[1].length, text: m[2].trim() })
    }
  }
  return headings
}

function extractInlineTags(content: string): string[] {
  const tags = new Set<string>()
  let match: RegExpExecArray | null
  const regex = new RegExp(TAG_INLINE_REGEX.source, 'g')
  while ((match = regex.exec(content)) !== null) {
    tags.add(match[1])
  }
  return Array.from(tags)
}

function inferTitle(frontmatter: ParsedFrontmatter, filePath: string, content: string): string {
  if (frontmatter.title && typeof frontmatter.title === 'string') {
    return frontmatter.title
  }
  // Try first H1
  const h1 = content.match(/^#\s+(.+)$/m)
  if (h1) return h1[1].trim()
  // Fallback to filename
  return path.basename(filePath, path.extname(filePath))
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length
}

/**
 * Windows vault notes are CRLF. JS `.` does NOT match `\r`, so patterns like
 * `/^(#{1,6})\s+(.+)$/` fail on `"# Title\r"` while weaker checks still match —
 * the HTML render loop then never advances and freezes the main process forever.
 */
function normalizeNewlines(text: string): string {
  if (!text) return ''
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function generateId(filePath: string): string {
  // Use SHA-256 hash of full path to avoid ID collisions.
  // Normalize separators + case so Windows D:\ vs d:\ map to the same node id.
  const key = filePath.replace(/\\/g, '/').toLowerCase()
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function headingId(raw: string): string {
  return (
    raw
      .replace(/<[^>]+>/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^\w\u00C0-\u024f\s-]/gi, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'h'
  )
}

function isGfmSepRow(line: string): boolean {
  const t = line.trim()
  if (!t.includes('-') || !t.includes('|')) return false
  return /^[\s|:=-]+$/.test(t) && /:-|-+/.test(t)
}

function isGfmTableRow(line: string): boolean {
  const t = line.trim()
  if (!t || t.startsWith('```') || t.startsWith('#')) return false
  if (!(t.startsWith('|') || t.endsWith('|'))) return false
  return t.split('|').length >= 3
}

/** Split table row on `|`, respecting GFM/Obsidian escaped `\|` inside cells. */
function splitGfmCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    // Obsidian/GFM: \| → literal pipe in cell
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (t[i] === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += t[i]
  }
  cells.push(cur.trim())
  return cells
}

function parseGfmAligns(sep: string): Array<'left' | 'center' | 'right' | null> {
  return splitGfmCells(sep).map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

/** Inline markdown (after HTML-escape of outer text, wiki placeholders already injected). */
function renderInline(text: string): string {
  // Cap pathological lines — prevents rare ReDoS-style lag in main process
  let s = text.length > 20_000 ? text.slice(0, 20_000) : text
  // images / links (URL already limited)
  s = s.replace(
    /!\[([^\]]*?)\]\((https?:[^)\s]+|mailto:[^)\s]+)\)/gi,
    (_m, alt: string, url: string) =>
      `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" />`
  )
  s = s.replace(
    /\[([^\]]+?)\]\((https?:[^)\s]+|mailto:[^)\s]+)\)/gi,
    (_m, label: string, url: string) =>
      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
  )
  s = s.replace(/`([^`\n]+?)`/g, '<code>$1</code>')
  s = s.replace(/\*\*\*([^*]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
  // Single *italic* — avoid lookbehind catastrophic backtracking on long * runs
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
  s = s.replace(/__([^_]+?)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~]+?)~~/g, '<del>$1</del>')
  s = s.replace(/==([^=]+?)==/g, '<mark>$1</mark>')
  return s
}

/**
 * Pure-TS Markdown → HTML with GFM tables (Obsidian-compatible).
 * No remark/unified — those break under electron-vite main bundling.
 */
function renderMarkdownToHtml(content: string): string {
  // Normalize CRLF first — see normalizeNewlines() (infinite loop on Windows notes)
  const normalized = normalizeNewlines(content)

  // 1) Fenced code FIRST — so [[wiki]] / | inside code stay literal
  const codeBlocks: string[] = []
  let src = normalized.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, langRaw: string, body: string) => {
    const lang = String(langRaw || '')
      .trim()
      .replace(/[^a-zA-Z0-9_+#.-]/g, '')
    const i = codeBlocks.length
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ''
    codeBlocks.push(`<pre><code${cls}>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`)
    return `\n§§CODE${i}§§\n`
  })

  // 2) Protect wikilinks (incl. \| alias in tables) outside code
  const wikiSlots: { target: string; label: string }[] = []
  src = src.replace(/!?\[\[([^\]]+?)\]\]/g, (_raw, inner: string) => {
    const normalized = String(inner).replace(/\\\|/g, '|')
    const pipe = normalized.indexOf('|')
    let target = (pipe >= 0 ? normalized.slice(0, pipe) : normalized).trim()
    const alias = pipe >= 0 ? normalized.slice(pipe + 1).trim() : ''
    target = target
      .split('#')[0]
      .split('^')[0]
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/g, '')
    const label = alias || target
    const idx = wikiSlots.length
    wikiSlots.push({ target, label })
    return `§§WIKI${idx}§§`
  })

  const lines = src.split('\n')
  const out: string[] = []
  let i = 0

  const flushParagraph = (buf: string[]): void => {
    if (!buf.length) return
    const text = buf.join('\n').trim()
    if (text) out.push(`<p>${renderInline(escapeHtml(text).replace(/\n/g, '<br />'))}</p>`)
    buf.length = 0
  }

  // Hard safety: never spin forever even if a branch forgets to advance `i`
  let guard = 0
  const maxSteps = Math.max(lines.length * 4, 64)
  while (i < lines.length) {
    if (++guard > maxSteps) {
      console.warn('[MarkdownEngine] render aborted: step guard (possible loop)')
      break
    }
    const lineStart = i
    const line = lines[i]

    // Code block placeholder
    const codePh = /^§§CODE(\d+)§§$/.exec(line.trim())
    if (codePh) {
      out.push(codeBlocks[Number(codePh[1])] || '')
      i++
      continue
    }

    // GFM table: header + separator + rows
    if (i + 1 < lines.length && isGfmTableRow(line) && isGfmSepRow(lines[i + 1])) {
      const header = splitGfmCells(line)
      const aligns = parseGfmAligns(lines[i + 1])
      const body: string[][] = []
      let j = i + 2
      while (j < lines.length && isGfmTableRow(lines[j]) && !isGfmSepRow(lines[j])) {
        body.push(splitGfmCells(lines[j]))
        j++
      }
      const ths = header
        .map((c, idx) => {
          const a = aligns[idx]
          const align = a ? ` align="${a}"` : ''
          return `<th${align}>${renderInline(escapeHtml(c))}</th>`
        })
        .join('')
      const trs = body
        .map((row) => {
          const cols = Math.max(header.length, row.length)
          let cells = ''
          for (let c = 0; c < cols; c++) {
            const a = aligns[c]
            const align = a ? ` align="${a}"` : ''
            cells += `<td${align}>${renderInline(escapeHtml(row[c] ?? ''))}</td>`
          }
          return `<tr>${cells}</tr>`
        })
        .join('')
      out.push(`<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`)
      i = j
      continue
    }

    // ATX headings
    const hm = /^(#{1,6})\s+(.+)$/.exec(line)
    if (hm) {
      const level = hm[1].length
      const text = hm[2].trim()
      const id = headingId(text)
      out.push(`<h${level} id="${id}">${renderInline(escapeHtml(text))}</h${level}>`)
      i++
      continue
    }

    // HR
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim()) && line.trim().length >= 3) {
      out.push('<hr />')
      i++
      continue
    }

    // Blockquote (simple single-line / consecutive)
    if (line.startsWith('>')) {
      const q: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) {
        q.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${renderInline(escapeHtml(q.join('\n')).replace(/\n/g, '<br />'))}</blockquote>`)
      continue
    }

    // Task / unordered / ordered lists
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: { ordered: boolean; html: string }[] = []
      let ordered = /^\s*\d+\.\s+/.test(line)
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const L = lines[i]
        const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(L)
        if (task) {
          ordered = false
          const checked = task[1].toLowerCase() === 'x'
          items.push({
            ordered: false,
            html: `<li class="task-list-item"><input type="checkbox" disabled${checked ? ' checked' : ''} /> ${renderInline(escapeHtml(task[2]))}</li>`
          })
        } else {
          const um = /^\s*[-*+]\s+(.*)$/.exec(L)
          const om = /^\s*\d+\.\s+(.*)$/.exec(L)
          if (um) {
            ordered = false
            items.push({ ordered: false, html: `<li>${renderInline(escapeHtml(um[1]))}</li>` })
          } else if (om) {
            ordered = true
            items.push({ ordered: true, html: `<li>${renderInline(escapeHtml(om[1]))}</li>` })
          } else {
            // matched list start but not um/om — force advance
            items.push({ ordered: false, html: `<li>${renderInline(escapeHtml(L.trim()))}</li>` })
          }
        }
        i++
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.map((x) => x.html).join('')}</${tag}>`)
      continue
    }

    // Blank line
    if (!line.trim()) {
      i++
      continue
    }

    // Paragraph (gather until blank / special)
    const buf: string[] = []
    while (i < lines.length) {
      const L = lines[i]
      if (!L.trim()) break
      if (/^(#{1,6})\s+/.test(L)) break
      if (L.startsWith('>')) break
      if (/^\s*([-*+]|\d+\.)\s+/.test(L)) break
      if (/^§§CODE\d+§§$/.test(L.trim())) break
      if (
        i + 1 < lines.length &&
        isGfmTableRow(L) &&
        isGfmSepRow(lines[i + 1])
      ) {
        break
      }
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(L.trim()) && L.trim().length >= 3) break
      buf.push(L)
      i++
    }
    if (buf.length === 0) {
      // Mismatch between outer/inner detectors — emit raw line and advance
      out.push(`<p>${renderInline(escapeHtml(line))}</p>`)
      i = lineStart + 1
      continue
    }
    flushParagraph(buf)
  }

  let html = out.join('\n')

  // Restore wikilinks
  html = html.replace(/§§WIKI(\d+)§§/g, (_m, n: string) => {
    const slot = wikiSlots[Number(n)]
    if (!slot) return '[[?]]'
    return `<span class="wiki-link" data-target="${escapeHtml(slot.target)}">${escapeHtml(slot.label)}</span>`
  })

  return html
}

export class MarkdownEngine {
  /**
   * @param opts.light — skip wiki/heading/tag scans (fast path for editor open)
   */
  parseFile(
    filePath: string,
    rawContent: string,
    rootPath: string,
    opts?: { light?: boolean }
  ): ParsedMarkdown {
    // Normalize before gray-matter so heading/wiki scans work on Windows CRLF vaults
    const rawNorm = normalizeNewlines(rawContent)
    let parsed: matter.GrayMatterFile<string>
    try {
      parsed = matter(rawNorm)
    } catch {
      parsed = { data: {}, content: rawNorm, orig: rawNorm } as matter.GrayMatterFile<string>
    }

    const frontmatter = { ...(parsed.data as ParsedFrontmatter) }
    // gray-matter/js-yaml may parse bare dates as Date objects — normalize for UI/index
    for (const key of ['date', 'created', 'updated'] as const) {
      const v: unknown = frontmatter[key]
      if (Object.prototype.toString.call(v) === '[object Date]') {
        frontmatter[key] = (v as Date).toISOString().split('T')[0]
      } else if (typeof v === 'number') {
        frontmatter[key] = new Date(v).toISOString().split('T')[0]
      }
    }
    const content = normalizeNewlines(parsed.content)
    const relativePath = rootPath ? path.relative(rootPath, filePath).replace(/\\/g, '/') : filePath
    const title = inferTitle(frontmatter, filePath, content)
    const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : []

    // Light: editor open — skip expensive scans (hangs on dense pegawai notes)
    if (opts?.light) {
      return {
        id: generateId(filePath),
        filePath,
        relativePath,
        title,
        frontmatter,
        content,
        rawContent: rawNorm,
        wikiLinks: [],
        tags: fmTags,
        wordCount: 0,
        headings: []
      }
    }

    const wikiLinks = extractWikiLinks(content)
    const headings = extractHeadings(content)
    const inlineTags = extractInlineTags(content)
    const tags = Array.from(new Set([...fmTags, ...inlineTags]))

    return {
      id: generateId(filePath),
      filePath,
      relativePath,
      title,
      frontmatter,
      content,
      rawContent: rawNorm,
      wikiLinks,
      tags,
      wordCount: countWords(content),
      headings
    }
  }

  resolveWikiLink(target: string, allFiles: Map<string, string>): string | null {
    // Try exact match first
    for (const [filePath, title] of allFiles.entries()) {
      if (title.toLowerCase() === target.toLowerCase()) return filePath
      const baseName = path.basename(filePath, path.extname(filePath))
      if (baseName.toLowerCase() === target.toLowerCase()) return filePath
    }
    return null
  }

  /**
   * Obsidian/GFM-compatible HTML (pure TS — safe in electron-vite main bundle).
   * Supports: GFM tables, task lists, strikethrough, wikilinks, headings, code, lists.
   */
  renderToHtml(content: string): string {
    return renderMarkdownToHtml(content)
  }

  buildFrontmatterString(meta: ParsedFrontmatter): string {
    const lines = ['---']
    for (const [key, val] of Object.entries(meta)) {
      if (val === undefined || val === null) continue
      if (Array.isArray(val)) {
        lines.push(`${key}:`)
        for (const v of val) lines.push(`  - ${v}`)
      } else {
        lines.push(`${key}: ${val}`)
      }
    }
    lines.push('---', '')
    return lines.join('\n')
  }

  createNoteTemplate(title: string, type: string = 'note'): string {
    const now = new Date().toISOString().split('T')[0]
    return `---
title: ${title}
type: ${type}
created: ${now}
updated: ${now}
tags: []
---

# ${title}

`
  }

  createDailyNoteTemplate(date: string): string {
    return `---
title: ${date}
type: daily
date: ${date}
---

# ${date}

## 🎯 Today's Focus


## 📝 Notes


## ✅ Tasks

- [ ] 

## 🔗 Links


`
  }
}

export const markdownEngine = new MarkdownEngine()
