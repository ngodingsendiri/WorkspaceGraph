import matter from 'gray-matter'
import path from 'path'
import crypto from 'crypto'
import { stripCodeRegions, fenceMarkerOf } from './markdownCode'

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
  // WA-5: skip headings inside fenced code (``` or ~~~) — they are code, not outline.
  let fence: '```' | '~~~' | null = null
  for (const line of lines) {
    const marker = fenceMarkerOf(line)
    if (marker) {
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    if (fence !== null) continue
    const m = line.match(/^(#{1,6})\s+(.+)$/)
    if (m) {
      headings.push({ level: m[1].length, text: m[2].trim() })
    }
  }
  return headings
}

function extractInlineTags(content: string): string[] {
  // WA-4: #tag inside code (fenced or inline) is code, not a tag node.
  const scan = stripCodeRegions(content)
  const tags = new Set<string>()
  let match: RegExpExecArray | null
  const regex = new RegExp(TAG_INLINE_REGEX.source, 'g')
  while ((match = regex.exec(scan)) !== null) {
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

/**
 * WA-11: render a frontmatter value as a YAML scalar without ever corrupting
 * the document. Plain-safe values stay unquoted; anything containing YAML
 * metacharacters (:, #, quotes, newlines, leading -/.) is double-quoted via
 * JSON.stringify (a valid YAML double-quoted scalar).
 */
function yamlScalar(value: unknown): string {
  const s = String(value)
  if (/^[A-Za-z0-9_ ./#+()'-]+$/.test(s) && !/^[-.]/.test(s)) return s
  return JSON.stringify(s)
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
  if (!t || t.startsWith('```') || t.startsWith('~~~') || t.startsWith('#')) return false
  if (!(t.startsWith('|') || t.endsWith('|'))) return false
  return t.split('|').length >= 3
}

/**
 * Split table row on `|`, Obsidian-compatible:
 * - `\|` → literal pipe in cell
 * - `[[target|alias]]` must NOT split on the alias pipe (Obsidian table parser)
 */
function splitGfmCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  let i = 0
  while (i < t.length) {
    // Obsidian/GFM: \| → literal pipe in cell
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|'
      i += 2
      continue
    }
    // Keep [[...|...]] intact so alias pipe is not a column boundary
    if (t[i] === '[' && t[i + 1] === '[') {
      const end = t.indexOf(']]', i + 2)
      if (end !== -1) {
        cur += t.slice(i, end + 2)
        i = end + 2
        continue
      }
    }
    if (t[i] === '|') {
      cells.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += t[i]
    i++
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
  // WA-6: escape literal placeholder-like text so user content can never
  // collide with our internal slot tokens (§§CODE/§§WIKI/§§EXT). § is mapped to
  // a PUA character that no engine pattern can match, and any pre-existing PUA
  // char is shifted one step further — fully reversible at the end.
  let src = normalized.replace(/\uE000/g, '\uE001').replace(/§/g, '\uE000')

  // 1) Fenced code FIRST — so [[wiki]] / | inside code stay literal.
  //    WA-10: GFM allows both ``` and ~~~ fences (backreference = same marker).
  const codeBlocks: string[] = []
  src = src.replace(
    /(```|~~~)([^\n]*)\n([\s\S]*?)\1/g,
    (_m, _fence: string, langRaw: string, body: string) => {
      const lang = String(langRaw || '')
        .trim()
        .replace(/[^a-zA-Z0-9_+#.-]/g, '')
      const i = codeBlocks.length
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ''
      codeBlocks.push(`<pre><code${cls}>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`)
      return `\n§§CODE${i}§§\n`
    }
  )

  // 2) Protect wikilinks (incl. \| alias in tables) outside code
  const wikiSlots: { target: string; label: string }[] = []
  src = src.replace(/!?\[\[([^\]]+?)\]\]/g, (_raw, inner: string) => {
    const normalized = String(inner).replace(/\\\|/g, '|')
    const pipe = normalized.indexOf('|')
    let target = (pipe >= 0 ? normalized.slice(0, pipe) : normalized).trim()
    const alias = pipe >= 0 ? normalized.slice(pipe + 1).trim() : ''
    target = target.split('#')[0].split('^')[0].trim().replace(/\\/g, '/').replace(/\/+$/g, '')
    const label = alias || target
    const idx = wikiSlots.length
    wikiSlots.push({ target, label })
    return `§§WIKI${idx}§§`
  })

  // 3) Protect external images & links so URLs with _ or * don't get corrupted by inline formatting
  const extSlots: string[] = []
  src = src.replace(
    /!\[([^\]]*?)\]\((https?:[^)\s]+|mailto:[^)\s]+)\)/gi,
    (_m, alt: string, url: string) => {
      const idx = extSlots.length
      extSlots.push(`<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" />`)
      return `§§EXT${idx}§§`
    }
  )
  src = src.replace(
    /\[([^\]]+?)\]\((https?:[^)\s]+|mailto:[^)\s]+)\)/gi,
    (_m, label: string, url: string) => {
      const idx = extSlots.length
      extSlots.push(
        `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
      )
      return `§§EXT${idx}§§`
    }
  )

  // M7.6b (M3/M4): LOCAL images & links — spec 06 lists Image + Link as
  // supported; previously only http(s)/mailto were rendered.
  // Local image: ![alt](assets/pic.png) — src restricted to safe values
  // (relative path or data:image/*); javascript:/data:text rejected.
  const isSafeLocalSrc = (u: string): boolean =>
    !/^\s*(javascript|vbscript|data:text)/i.test(u) && !/[<>"]/.test(u)
  src = src.replace(/!\[([^\]]*?)\]\(([^)]+)\)/gi, (m, alt: string, url: string) => {
    const trimmed = url.trim()
    if (/^(https?:|mailto:)/i.test(trimmed)) return m // already handled above
    if (!isSafeLocalSrc(trimmed)) return m
    const idx = extSlots.length
    extSlots.push(
      `<img class="md-img-local" src="${escapeHtml(trimmed)}" alt="${escapeHtml(alt)}" loading="lazy" />`
    )
    return `§§EXT${idx}§§`
  })
  // Local link to a note (.md) → wiki-link span (existing click handler opens
  // it); other local paths → inert styled span with the target as title.
  src = src.replace(
    /\[([^\]]+?)\]\(([^)#]+\.md)(#[^)]*)?\)/gi,
    (m, label: string, target: string) => {
      const trimmed = target.trim()
      if (/^(https?:|mailto:)/i.test(trimmed)) return m
      if (!isSafeLocalSrc(trimmed)) return m
      const idx = wikiSlots.length
      wikiSlots.push({ target: trimmed, label })
      return `§§WIKI${idx}§§`
    }
  )

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
      out.push(
        `<blockquote>${renderInline(escapeHtml(q.join('\n')).replace(/\n/g, '<br />'))}</blockquote>`
      )
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
      if (i + 1 < lines.length && isGfmTableRow(L) && isGfmSepRow(lines[i + 1])) {
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

  // Restore external links & images
  html = html.replace(/§§EXT(\d+)§§/g, (_m, n: string) => {
    return extSlots[Number(n)] || ''
  })

  // WA-6: restore user-literal § (all engine slots already substituted above —
  // they were created AFTER the escape, so this pass only touches user text).
  html = html.replace(/\uE001/g, '\uE000').replace(/\uE000/g, '§')

  // M7 M1: footnote rendering — `[^label]` inline refs + `[^label]: text` definitions.
  // Two passes: (1) collect definitions, (2) replace inline refs with sup links,
  // (3) append a footnotes <section> at the bottom if any refs were resolved.
  {
    const defs = new Map<string, string>()
    html = html.replace(/<p>(\[\^([^\]]+)\]: .+?)<\/p>/g, (_m, def: string, label: string) => {
      defs.set(label, def.replace(/^\[\^[^\]]+\]:\s*/, ''))
      return '' // strip definition paragraph from body
    })
    if (defs.size > 0) {
      let fnIdx = 0
      const footnotes: string[] = []
      html = html.replace(/\[\^([^\]]+)\]/g, (m, label: string) => {
        const text = defs.get(label)
        if (!text) return m // unresolvable → keep literal
        fnIdx++
        const anchor = `fn-${fnIdx}-${label.replace(/[^a-zA-Z0-9-]/g, '')}`
        footnotes.push(`<li id="${anchor}">${escapeHtml(text)}</li>`)
        return `<sup class="footnote-ref"><a href="#${anchor}">[${fnIdx}]</a></sup>`
      })
      if (footnotes.length > 0) {
        html += `\n<section class="footnotes"><hr><ol>${footnotes.join('\n')}</ol></section>`
      }
    }
  }

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
    // M7 M2 (ADR-0011): honor frontmatter `id` as the node identity when
    // present and clean — rename-safe. Fallback stays the path hash.
    const fmId = typeof frontmatter.id === 'string' ? frontmatter.id.trim() : ''
    const canonicalId = fmId && /^[a-zA-Z0-9_-]{1,64}$/.test(fmId) ? fmId : generateId(filePath)
    // for Date normalization
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
        id: canonicalId,
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
      id: canonicalId,
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
        for (const v of val) lines.push(`  - ${yamlScalar(v)}`)
      } else {
        lines.push(`${key}: ${yamlScalar(val)}`)
      }
    }
    lines.push('---', '')
    return lines.join('\n')
  }

  createNoteTemplate(title: string, type: string = 'note'): string {
    const now = new Date().toISOString().split('T')[0]
    // WA-11: title is user input — quote it so `:`/`#`/newline can never corrupt
    // the YAML frontmatter; flatten newlines in the H1 body heading too.
    const flatTitle = title.replace(/\n/g, ' ')
    return `---
title: ${yamlScalar(title)}
type: ${yamlScalar(type)}
created: ${now}
updated: ${now}
tags: []
---

# ${flatTitle}

`
  }

  createDailyNoteTemplate(date: string): string {
    // M7 T2: aligned with builtin-daily (TemplateEngine) so every daily-note
    // entry point produces the SAME structure — frontmatter tags:[daily] and
    // identical sections. One canonical shape, no per-entrypoint drift.
    return `---
title: ${date}
type: daily
date: ${date}
tags: [daily]
---

# ${date}

## Focus

- [ ] 

## Notes


## Tasks

- [ ] 

## Links

- 
`
  }
}

export const markdownEngine = new MarkdownEngine()
