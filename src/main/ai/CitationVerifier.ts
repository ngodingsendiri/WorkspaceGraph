/**
 * Post-generation citation verification (anti-hallucination heuristic).
 *
 * ContextEngine already assembles the citation list (files injected into the
 * prompt). This module checks whether the model's ANSWER actually draws on each
 * cited file: it compares the significant vocabulary of the answer against the
 * file content and flags citations with little lexical overlap as weak.
 *
 * This is a cheap heuristic, not proof — it never blocks output, it only
 * annotates the refs row in the UI (⚠ = "klaim lemah terhadap isi catatan").
 */

export interface CitationVerification {
  path: string
  title: string
  /** true = plausibly grounded; false = answer shares almost no vocabulary */
  supported: boolean
  /** 0..1 — fraction of answer's significant terms found in the cited file */
  score: number
}

/** Very common filler words that say nothing about topical grounding. */
const STOPWORDS = new Set([
  'yang',
  'dan',
  'atau',
  'dengan',
  'untuk',
  'dari',
  'ini',
  'itu',
  'pada',
  'ke',
  'di',
  'adalah',
  'akan',
  'tidak',
  'juga',
  'karena',
  'setelah',
  'sebuah',
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'have',
  'are',
  'was',
  'your',
  'you',
  'not',
  'but',
  'they',
  'there',
  'about',
  'what',
  'when',
  'them',
  'then',
  'than',
  'just',
  'would',
  'could',
  'should',
  'these'
])

/**
 * Answers with fewer significant terms cannot be verified fairly — a concise
 * summary that happens not to lexically overlap its source would be falsely
 * flagged. Only substantial answers get the ⚠ treatment.
 */
const MIN_ANSWER_TERMS = 8
const SUPPORT_THRESHOLD = 0.08

const MAX_FILE_CHARS = 30_000
/** Stop reading files after this many chars — verification must stay cheap on
 * the main-process event loop (runs right before the final done chunk). */
const TOTAL_READ_CAP = 60_000

function significantTerms(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((t) => t.trim())
        .filter((t) => t.length >= 4 && !STOPWORDS.has(t))
    )
  )
}

/**
 * @param answer        Full streamed assistant text (pre-markdown).
 * @param citations     Citation list built by ContextEngine.
 * @param readContent   Read a file's content (throws when unreadable).
 * @param maxFiles      Cap file reads so a huge citation list stays cheap.
 */
export function verifyCitations(
  answer: string,
  citations: { title: string; path: string }[],
  readContent: (filePath: string) => string,
  maxFiles = 8
): CitationVerification[] {
  if (!answer || citations.length === 0) return []
  const ansTerms = significantTerms(answer)
  if (ansTerms.length < MIN_ANSWER_TERMS) {
    // Too little to verify — never falsely flag on a short/empty reply.
    return citations
      .slice(0, maxFiles)
      .map((c) => ({ path: c.path, title: c.title, supported: true, score: 1 }))
  }
  const ansSet = new Set(ansTerms)

  const out: CitationVerification[] = []
  let totalRead = 0
  for (const c of citations.slice(0, maxFiles)) {
    let content: string
    try {
      content = readContent(c.path)
    } catch {
      // Unreadable/deleted — assume OK rather than flag a real note.
      out.push({ path: c.path, title: c.title, supported: true, score: 1 })
      continue
    }
    if (!content) {
      out.push({ path: c.path, title: c.title, supported: true, score: 1 })
      continue
    }
    // Global byte budget: once exhausted, remaining files are assumed OK so a
    // huge vault cannot stall the main process at reply completion.
    if (totalRead >= TOTAL_READ_CAP) {
      out.push({ path: c.path, title: c.title, supported: true, score: 1 })
      continue
    }
    const piece = content.slice(0, MAX_FILE_CHARS)
    totalRead += piece.length
    const fileTerms = new Set(significantTerms(piece))
    let matched = 0
    for (const t of ansSet) if (fileTerms.has(t)) matched++
    const score = matched / ansSet.size

    // Explicitly naming the note's title is a strong signal the model used it,
    // even when the content overlap is thin (summaries, redirects).
    const titleTerms = significantTerms(c.title)
    const titleMentioned = titleTerms.some((t) => ansSet.has(t))

    out.push({
      path: c.path,
      title: c.title,
      supported: titleMentioned || score >= SUPPORT_THRESHOLD,
      score: Number(score.toFixed(3))
    })
  }
  return out
}
