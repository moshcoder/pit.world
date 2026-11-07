/**
 * A summary with no model: the sentences of a page that say most about it. Reading a page takes under a second;
 * c0mpute took 21 s on 800 characters and timed out past 40 s on 3,000 (measured 2026-11-07). So this answers at
 * once, and the model's version replaces it when it arrives, if it does.
 */

const MAX_CHARS = 480
const SENTENCES = 3
/** Page furniture that survives stripping the markup. */
const NOISE = /\b(cookies?|subscribe|sign (?:up|in)|log ?in|newsletter|copyright|all rights reserved|javascript|advertisement|read more|click here|privacy policy|terms of (?:use|service)|share this|follow us)\b/i

const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []) as string[]

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    const n = name.toLowerCase()
    const code = n.startsWith('#x') ? parseInt(n.slice(2), 16) : n.startsWith('#') ? parseInt(n.slice(1), 10) : NaN
    if (Number.isFinite(code)) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
    return NAMED[n] ?? whole
  })
}

/** Ends of sentences, but not "U.S." or "Dr." */
const SENTENCE_END = /(?<![\s.][A-Z]|\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|No|Gov|Sen|Rep|Gen|Lt|Col))(?<=[.!?。！？]["”’)]?)\s+(?=[\p{Lu}\p{Lo}"“‘])/u

/** How much of a sentence's words another already says. */
function overlap(a: string, b: string): number {
  const mine = new Set(words(a))
  if (!mine.size) return 0
  const theirs = new Set(words(b))
  return [...mine].filter((w) => theirs.has(w)).length / mine.size
}

/** Two or three sentences from a page's text, in page order. '' when it has none worth showing. */
export function quickSummary(raw: string, title = ''): string {
  const heading = title.replace(/\s+/g, ' ').trim()
  const lines = decode(raw).slice(0, 20_000).split('\n').map((line) => line.replace(/\s+/g, ' ').trim())
  if (heading && lines[0]?.startsWith(heading)) lines[0] = lines[0].slice(heading.length).trim()
  const text = lines.join(' ')
  const sentences = lines
    .flatMap((line) => line.split(SENTENCE_END))
    .map((s) => s.trim())
    .filter((s) => s.length >= 50 && s.length <= 320 && !NOISE.test(s) && /[.!?。！？]["”’)]?$/.test(s) && /^[\p{Lu}\p{Lo}\p{N}"“‘]/u.test(s))
  if (!sentences.length) return ''
  const counts = new Map<string, number>()
  for (const w of words(text)) counts.set(w, (counts.get(w) ?? 0) + 1)
  const scored = sentences.map((sentence, index) => {
    const own = [...new Set(words(sentence))]
    const weight = own.reduce((sum, w) => sum + Math.min(counts.get(w) ?? 0, 8), 0) / Math.sqrt(own.length || 1)
    // A page says what it is about near the top, the meta description first of all.
    return { sentence, index, score: weight * (index === 0 ? 2 : index < 4 ? 1.4 : 1) }
  })
  const picked: typeof scored = []
  for (const row of scored.sort((a, b) => b.score - a.score)) {
    if (picked.length < SENTENCES && !picked.some((p) => overlap(row.sentence, p.sentence) > 0.6)) picked.push(row)
  }
  picked.sort((a, b) => a.index - b.index)
  let out = ''
  for (const { sentence } of picked) {
    if (out && out.length + sentence.length + 1 > MAX_CHARS) break
    out = out ? `${out} ${sentence}` : sentence
  }
  return out
}
