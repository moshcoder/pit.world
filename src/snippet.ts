/**
 * Result snippets: a short, readable line or two under each result.
 *
 * Several engines (Exa, Ceramic, Linkup, our own index) hand back the page's
 * text, not a snippet: thousands of characters that start with the title again
 * and the site's navigation ("Skip to content Search for: ..."). Like any
 * search engine we show the part of it that matches the query instead, cut on
 * a sentence or word boundary. Nothing is invented: when the engines gave no
 * text, the snippet is empty.
 */

/** Target length; a snippet is never longer than MAX plus the ellipsis. */
export const SNIPPET_MAX = 240
const SNIPPET_MIN = 160

/** Navigation, cookie and subscription junk that page dumps start with or are peppered with. */
const BOILERPLATE: RegExp[] = [
  /\bskip to (?:the )?(?:main )?(?:content|navigation|search|footer)\b/gi,
  /\bjump to (?:navigation|search|content)\b/gi,
  /\bsearch for:?(?=\s)/gi,
  /\btoggle (?:navigation|menu|search)\b/gi,
  /\b(?:open|close) (?:menu|navigation|search)\b/gi,
  /\bmain menu\b/gi,
  /\bmenu\s+(?:home|close)\b/gi,
  /\bwe use cookies[^.!?]*[.!?]?/gi,
  /\bthis (?:web)?site uses cookies[^.!?]*[.!?]?/gi,
  /\b(?:accept|reject|manage) (?:all )?cookies\b/gi,
  /\bcookie (?:policy|settings|preferences)\b/gi,
  /\bsubscribe to (?:our|the) newsletter\b/gi,
  /\bsign up for (?:our|the) newsletter\b/gi,
  /\b(?:log ?in|sign ?in|sign ?up|register)\s*(?:\/|\||or)\s*(?:log ?in|sign ?in|sign ?up|register)\b/gi,
  /\bshare (?:on|this|via) (?:facebook|twitter|x|linkedin|email)\b/gi,
  /\b(?:advertisement|sponsored content)\b/gi,
  /\byou are here:?/gi,
  /\bback to top\b/gi,
  /\bread more\b(?:\s*[»›→])?/gi,
]

/** Markdown and markup leftovers: headings, list bullets, image and link syntax, table pipes. */
function plain(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/(^|\s)[*\-+•·|]{1,3}(?=\s)/g, '$1')
    .replace(/[*_`]{2,}/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Query words worth matching: lowercased, no one-letter or stop words. */
export function queryTerms(query: string): string[] {
  const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'how', 'why', 'who', 'are', 'is', 'of', 'to', 'in', 'on', 'a', 'an', 'or', 'by', 'at', 'it', 'be', 'do', 'vs'])
  const out: string[] = []
  for (const word of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 2 || STOP.has(word) || out.includes(word)) continue
    out.push(word)
  }
  return out.slice(0, 12)
}

/** The title again at the very start of the text (often with "| Site" or "- Site" variants), removed. */
function dropLeadingTitle(text: string, title: string): string {
  const t = plain(title)
  if (!t) return text
  let out = text
  // The full title, then its first segment before a separator ("Pricing | Acme" -> "Pricing").
  const variants = [t, t.split(/\s+[|\-–—:·]\s+/)[0] ?? ''].filter((v) => v.length >= 4)
  for (let round = 0; round < 3; round++) {
    let changed = false
    for (const v of variants) {
      if (out.slice(0, v.length).toLowerCase() !== v.toLowerCase()) continue
      const rest = out.slice(v.length)
      // Only a title standing alone: followed by a separator, the end, or a new capitalized phrase,
      // never by the rest of its own sentence ("Rust is a fast language" keeps its "Rust").
      const sep = /^\s*[|\-–—:·.]\s*/.exec(rest)
      if (sep) out = rest.slice(sep[0].length)
      else if (/^\s*$/.test(rest) || /^\s+[\p{Lu}\p{N}"'“]/u.test(rest)) out = rest.trimStart()
      else continue
      changed = true
    }
    if (!changed) break
  }
  return out
}

/** Sentences, kept with their ending punctuation. A very long run with no full stop is cut into ~200-character pieces on spaces. */
function sentences(text: string): string[] {
  const parts = text.match(/[^.!?]+(?:[.!?]+["')\]]?|$)\s*/g) ?? [text]
  const out: string[] = []
  for (const raw of parts) {
    let s = raw.trim()
    while (s.length > 300) {
      const cut = s.lastIndexOf(' ', 220)
      out.push(s.slice(0, cut > 80 ? cut : 220).trim())
      s = s.slice(cut > 80 ? cut : 220).trim()
    }
    if (s) out.push(s)
  }
  return out
}

/** Cut to at most `max` characters on a word boundary, with an ellipsis when anything was dropped. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf(' ', max)
  return `${text.slice(0, cut > max * 0.6 ? cut : max).replace(/[\s,;:\-–—|]+$/, '')}…`
}

/** How many query terms a sentence has, and whether it reads like a sentence rather than a menu. */
function score(sentence: string, terms: string[]): number {
  const lower = sentence.toLowerCase()
  let hits = 0
  for (const term of terms) if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(term)}`, 'u').test(lower)) hits++
  const words = sentence.split(' ').length
  // Menus are short capitalized fragments without a verb-ish shape; real sentences end in punctuation.
  const prose = /[.!?]["')\]]?$/.test(sentence) && words >= 6 ? 0.5 : 0
  return hits * 2 + prose
}

/**
 * A short, query-biased snippet from whatever text an engine returned.
 *
 *  - strips markup, a leading repeat of the title, and navigation/cookie boilerplate
 *  - picks the sentence that best matches the query, plus the following one when there is room
 *  - ends on a sentence or word boundary, with … when it cut something
 */
export function makeSnippet(text: string, options: { title?: string; query?: string; max?: number } = {}): string {
  const max = options.max ?? SNIPPET_MAX
  let body = plain(typeof text === 'string' ? text : '')
  if (!body) return ''
  body = dropLeadingTitle(body, options.title ?? '')
  // A long title repeated further in (after a breadcrumb or a sign-in link) is page chrome too.
  // Both with and without its " - Site" / " | Site" suffix.
  const rawTitle = options.title ?? ''
  for (const t of new Set([plain(rawTitle), plain(rawTitle.replace(/\s+[|\-–—·]\s+[^|\-–—·]+$/, ''))])) {
    if (t.length >= 24) body = body.replace(new RegExp(escapeRe(t), 'gi'), ' ')
  }
  // A heading repeated as the first words of the text ("Climate change Climate change is ..."): once is enough.
  body = body.replace(/^((?:\S+\s+){1,8}?)\1/i, '$1')
  for (const re of BOILERPLATE) body = body.replace(re, ' ')
  body = body.replace(/\s+([,.;:!?])/g, '$1').replace(/\s+/g, ' ').replace(/^[\s,.;:|\-–—]+/, '').trim()
  if (!body) return ''
  // Engines cut their own text mid-sentence: "…" instead of a dangling comma.
  if (body.length <= max) return body.replace(/\s*[,;:\-–—]$/, '…')
  const list = sentences(body)
  const terms = queryTerms(options.query ?? '')
  let best = 0
  let bestScore = -1
  list.forEach((s, i) => {
    const value = score(s, terms) - i * 0.01
    if (value > bestScore) {
      bestScore = value
      best = i
    }
  })
  let out = list[best] ?? ''
  for (let i = best + 1; i < list.length && out.length < SNIPPET_MIN; i++) out = `${out} ${list[i]}`
  // The best sentence was the last: lean on the one before it instead of ending short.
  if (out.length < SNIPPET_MIN && best > 0) out = `${list[best - 1]} ${out}`
  const clipped = clip(out, max)
  // Stopped mid-thought (a run with no full stop, cut into pieces): say so.
  if (!clipped.endsWith('…') && !/[.!?]["')\]]?$/.test(clipped) && body.length > clipped.length) return `${clipped}…`
  return clipped
}
