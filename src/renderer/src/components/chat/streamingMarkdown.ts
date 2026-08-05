/**
 * Progressive Markdown renderer for streaming AI output.
 *
 * The completed answer is re-rendered by main-process `markdown:render` for full
 * fidelity (tables, heading anchors, slot-protected wikilinks). This module only
 * makes the *in-flight* text readable without IPC churn per chunk:
 *   1. closes unclosed constructs (`**bold`, fences, brackets) so a partially
 *      typed stream renders as if it were complete markdown;
 *   2. escapes raw HTML FIRST — the AI output is untrusted;
 *   3. renders the common block/inline subset (headings, lists, code, links).
 * The final `done` render replaces this output, so fidelity gaps here are fine.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Make a partially-typed stream look like complete markdown: append the missing
 * closing markers. Only runs on a code-stripped copy so `**` inside `code` or
 * fenced blocks is never counted.
 */
function closeUnclosed(src: string): string {
  let s = src
  const fenceCount = (s.match(/```/g) || []).length
  if (fenceCount % 2 === 1) s += '\n```'
  const noCode = s.replace(/```[\s\S]*?(```|$)/g, '').replace(/`[^`\n]*`/g, '')
  const append: string[] = []
  const odd = (re: RegExp): boolean => (noCode.match(re) || []).length % 2 === 1
  if (odd(/\*\*/g)) append.push('**')
  // Single `*` — ignore the ones already paired up by `**`
  const noBold = noCode.replace(/\*\*/g, '')
  if ((noBold.match(/\*/g) || []).length % 2 === 1) append.push('*')
  if (odd(/~~/g)) append.push('~~')
  if (odd(/`/g)) append.push('`')
  // Nesting: close parens before brackets so `[x](url` → `[x](url)]`
  const po = (noCode.match(/\(/g) || []).length
  const pc = (noCode.match(/\)/g) || []).length
  if (po > pc) append.push(')'.repeat(po - pc))
  const opens = (noCode.match(/\[/g) || []).length
  const closes = (noCode.match(/\]/g) || []).length
  if (opens > closes) append.push(']'.repeat(opens - closes))
  return append.length ? s + append.join('') : s
}

/**
 * Inline formatting on HTML-escaped text. External links are slot-protected
 * first (URLs may contain `*`/`_`), then formatting, then wikilinks, then
 * links are restored — same order as MarkdownEngine's renderMarkdownToHtml.
 */
function renderInline(text: string): string {
  let s = text.length > 20_000 ? text.slice(0, 20_000) : text
  const slots: string[] = []
  s = s.replace(
    /\[([^\]]+?)\]\((https?:[^)\s]+|mailto:[^)\s]+)\)/g,
    (_m, label: string, url: string) => {
      const i = slots.length
      // Values already escaped — do not double-escape (would corrupt &amp;)
      slots.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
      return `\uE000L${i}\uE000`
    }
  )
  s = s.replace(/`([^`\n]+?)`/g, '<code>$1</code>')
  s = s.replace(/\*\*\*([^*]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
  s = s.replace(/__([^_]+?)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~]+?)~~/g, '<del>$1</del>')
  s = s.replace(/==([^=]+?)==/g, '<mark>$1</mark>')
  // Values are ALREADY escaped (renderStreamingMarkdown escapes before blocks) —
  // re-escaping here would corrupt special chars into &amp;quot; etc.
  s = s.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target: string, alias?: string) =>
      `<span class="wiki-link" data-target="${target.trim()}">${(alias || target).trim()}</span>`
  )
  s = s.replace(/\uE000L(\d+)\uE000/g, (_m, i: string) => slots[Number(i)] || '')
  return s
}

/** Block-level render over HTML-escaped, unclosed-closed text. */
function renderBlocks(escaped: string): string {
  const lines = escaped.split('\n')
  const out: string[] = []
  let i = 0

  const flushParagraph = (buf: string[]): void => {
    if (!buf.length) return
    const text = buf.join('\n').trim()
    if (text) out.push(`<p>${renderInline(text.replace(/\n/g, '<br />'))}</p>`)
    buf.length = 0
  }

  // Hard safety: never spin forever even if a branch forgets to advance `i`
  let guard = 0
  const maxSteps = Math.max(lines.length * 4, 64)
  while (i < lines.length) {
    if (++guard > maxSteps) break
    const lineStart = i
    const line = lines[i]

    // Fenced code — may be unclosed while streaming; still render what we have
    if (/^```/.test(line.trim())) {
      const lang = line
        .trim()
        .slice(3)
        .trim()
        .replace(/[^a-zA-Z0-9_+#.-]/g, '')
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // consume closing fence
      const cls = lang ? ` class="language-${lang}"` : ''
      out.push(`<pre><code${cls}>${buf.join('\n').replace(/\n$/, '')}</code></pre>`)
      continue
    }

    // ATX headings
    const hm = /^(#{1,6})\s+(.+)$/.exec(line)
    if (hm) {
      const level = hm[1].length
      const text = hm[2].trim()
      out.push(`<h${level}>${renderInline(text)}</h${level}>`)
      i++
      continue
    }

    // HR
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim()) && line.trim().length >= 3) {
      out.push('<hr />')
      i++
      continue
    }

    // Blockquote
    if (line.startsWith('>')) {
      const q: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) {
        q.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${renderInline(q.join('\n').replace(/\n/g, '<br />'))}</blockquote>`)
      continue
    }

    // Task / unordered / ordered lists
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: string[] = []
      let ordered = /^\s*\d+\.\s+/.test(line)
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const L = lines[i]
        const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(L)
        if (task) {
          ordered = false
          const checked = task[1].toLowerCase() === 'x'
          items.push(
            `<li class="task-list-item"><input type="checkbox" disabled${checked ? ' checked' : ''} /> ${renderInline(task[2])}</li>`
          )
        } else {
          const um = /^\s*[-*+]\s+(.*)$/.exec(L)
          const om = /^\s*\d+\.\s+(.*)$/.exec(L)
          if (um) {
            ordered = false
            items.push(`<li>${renderInline(um[1])}</li>`)
          } else if (om) {
            ordered = true
            items.push(`<li>${renderInline(om[1])}</li>`)
          } else {
            // matched list start but not um/om — force advance
            items.push(`<li>${renderInline(L.trim())}</li>`)
          }
        }
        i++
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.join('')}</${tag}>`)
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
      if (/^```/.test(L.trim())) break
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(L.trim()) && L.trim().length >= 3) break
      buf.push(L)
      i++
    }
    if (buf.length === 0) {
      // Mismatch between outer/inner detectors — emit raw line and advance
      out.push(`<p>${renderInline(line)}</p>`)
      i = lineStart + 1
      continue
    }
    flushParagraph(buf)
  }

  return out.join('\n')
}

/**
 * Render a partially-streamed markdown string to safe HTML.
 * Always escapes raw HTML; never emits script/event-handler markup.
 */
export function renderStreamingMarkdown(src: string): string {
  const text = String(src ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  if (!text.trim()) return ''
  const capped = text.length > 100_000 ? text.slice(0, 100_000) : text
  const closed = closeUnclosed(capped)
  return renderBlocks(escapeHtml(closed))
}
