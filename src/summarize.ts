/**
 * Result summaries on demand, written by c0mpute (the peer inference network,
 * through Infernet's chat API) and never by a paid provider.
 *
 * A search page never waits for one: the snippet (src/snippet.ts) is the
 * instant answer, and "Summarize" under a result asks for 2-3 plain sentences
 * that land in the card when a node has written them, seconds to minutes later.
 *
 * Privacy: c0mpute is sent the page's text and nothing else: not the query,
 * not who asked. Only pages pit.world itself just returned in a result can be
 * summarized (so this is not a fetch-anything proxy), and a summary is kept by
 * URL so the second request for it is instant and costs nobody anything.
 */
import { Database } from 'bun:sqlite'
import { lookup } from 'node:dns/promises'
import type { Hit } from './search.js'
import { isPublicAddress } from './listings.js'

type Fetch = typeof fetch

export const DEFAULT_C0MPUTE_URL = 'https://infernetprotocol.com'
/** Submit to done. A cold 7B on a CPU node takes minutes; a page must not hang on that, it polls. */
export const SUMMARY_TIMEOUT_MS = 90_000
/** How much page text a node is given: a small model on a CPU reads ~4k characters in reasonable time. */
const MAX_INPUT = 4_000
/** Below this, the engines' text is too thin to summarize; read the page itself. */
const THIN_TEXT = 600

export class C0mputeError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`c0mpute ${status}: ${detail}`)
  }
}

export type C0mputeOptions = { baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: number; fetch?: Fetch }

/**
 * Infernet's chat API, the same way OutreachGraph calls it (packages/ai/src/c0mpute.ts):
 *
 *   POST /api/chat {messages, maxTokens, temperature, p2p_only, modelName?} -> {jobId, source}
 *   GET  /api/chat/stream/<jobId>   server-sent events: meta, token..., done | error
 *
 * `p2p_only` means Infernet never hands the job to its billed hosted fallback; an
 * answer from anything but a peer node is refused anyway.
 */
export async function c0mputeChat(system: string, user: string, options: C0mputeOptions = {}): Promise<{ text: string; model: string }> {
  const base = (options.baseUrl ?? DEFAULT_C0MPUTE_URL).replace(/\/+$/, '')
  const fetchImpl = options.fetch ?? fetch
  const signal = AbortSignal.timeout(options.timeoutMs ?? SUMMARY_TIMEOUT_MS)
  const submit = (modelName: string | undefined) =>
    fetchImpl(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens: 200,
        temperature: 0.3,
        p2p_only: true,
        ...(modelName ? { modelName } : {}),
      }),
      signal,
    })
  try {
    let submitted = await submit(options.model)
    // No live node serves the preferred model right now: any free node will do.
    if (submitted.status === 503 && options.model) submitted = await submit(undefined)
    const job = (await submitted.json().catch(() => ({}))) as { jobId?: string; source?: string; model?: string | null; error?: string }
    if (!submitted.ok || !job.jobId) throw new C0mputeError(submitted.status, job.error ?? 'no job was created')
    if (job.source !== 'p2p') throw new C0mputeError(429, `no c0mpute node took the job (source ${job.source ?? 'unknown'})`)
    const stream = await fetchImpl(`${base}/api/chat/stream/${encodeURIComponent(job.jobId)}`, { headers: { accept: 'text/event-stream' }, signal })
    if (!stream.ok || !stream.body) throw new C0mputeError(stream.status, 'could not read the job stream')
    const { text, model } = await readStream(stream.body)
    return { text, model: model ?? job.model ?? 'p2p' }
  } catch (error) {
    if (error instanceof C0mputeError) throw error
    throw new C0mputeError(0, error instanceof Error ? error.message : String(error))
  }
}

/** Reads `meta`, `token` and `done` events until `done` or an `error`. */
export async function readStream(body: ReadableStream<Uint8Array>): Promise<{ text: string; model?: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let model: string | undefined
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: true })
    let cut: number
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim()
      const raw = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!event || !raw) continue
      let data: Record<string, unknown>
      try {
        data = JSON.parse(raw) as Record<string, unknown>
      } catch {
        continue
      }
      if (event === 'meta' && typeof data.model === 'string') model = data.model
      else if (event === 'token' && typeof data.text === 'string') text += data.text
      else if (event === 'done') {
        await reader.cancel().catch(() => undefined)
        return { text: typeof data.text === 'string' && data.text ? data.text : text, ...(model ? { model } : {}) }
      } else if (event === 'error') {
        await reader.cancel().catch(() => undefined)
        throw new C0mputeError(502, String(data.message ?? data.error ?? 'job failed'))
      }
    }
    if (done) break
  }
  throw new C0mputeError(502, text ? 'the stream ended before the answer finished' : 'the stream ended without an answer')
}

export const SUMMARY_SYSTEM =
  'You summarize web pages for a search engine. Write 2 or 3 plain sentences saying what the page is and what it offers. No preamble, no lists, no markdown, no opinions, no links. If the text is only navigation or too thin to tell, reply exactly: NO SUMMARY'

/** A model's answer, tidied: no "Summary:" lead-in, no markdown, one paragraph, at most ~600 characters. */
export function cleanSummary(text: string): string {
  let out = text
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/^\s*(?:here(?: is|'s) (?:a |the )?summary[^:]*:|summary:)\s*/i, '')
    .replace(/[*_#`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^no summary\.?$/i.test(out)) return ''
  if (out.length > 600) {
    const cut = out.lastIndexOf('. ', 600)
    out = cut > 200 ? out.slice(0, cut + 1) : `${out.slice(0, out.lastIndexOf(' ', 600))}…`
  }
  return out
}

/** Visible text of an HTML page: no scripts, styles, navigation, headers or footers. */
export function htmlText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''
  const meta = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ?? ''
  const body = html
    .replace(/<(head|title|script|style|noscript|svg|nav|header|footer|form|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  return [title, meta, body]
    .join('\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** A public web page's text: http(s) only, every address public (re-checked on each redirect), 6 s, 512 KB. */
export async function fetchPageText(raw: string, fetchImpl: Fetch = fetch, resolve: (host: string) => Promise<string[]> = defaultResolve): Promise<string> {
  let url = new URL(raw)
  for (let hop = 0; hop < 4; hop++) {
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return ''
    if (url.port && !['80', '443'].includes(url.port)) return ''
    const addresses = await resolve(url.hostname).catch(() => [])
    if (!addresses.length || !addresses.every(isPublicAddress)) return ''
    // threatcrush-disable-next-line js-ssrf-outbound-request  only a URL pit.world returned as a search result, every hop resolved and checked public above
    const response = await fetchImpl(url.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(6_000),
      headers: { accept: 'text/html', 'user-agent': 'pit.world summaries (+https://pit.world/privacy)' },
    })
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    if (location) {
      url = new URL(location, url)
      continue
    }
    if (!response.ok || !/html|text\/plain/i.test(response.headers.get('content-type') ?? '')) return ''
    const reader = response.body?.getReader()
    if (!reader) return ''
    const decoder = new TextDecoder()
    let html = ''
    while (html.length < 512_000) {
      const { done, value } = await reader.read()
      if (done) break
      html += decoder.decode(value, { stream: true })
    }
    reader.cancel().catch(() => {})
    return htmlText(html)
  }
  return ''
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((a) => a.address)
}

/** Summaries by URL, on disk, so a page is summarized once. */
export class SummaryStore {
  private db: Database
  constructor(path = ':memory:') {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('CREATE TABLE IF NOT EXISTS summaries (url TEXT PRIMARY KEY, summary TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL)')
  }
  get(url: string): { summary: string; model: string; createdAt: number } | null {
    const row = this.db.query('SELECT summary, model, created_at FROM summaries WHERE url = ?').get(url) as { summary: string; model: string; created_at: number } | null
    return row ? { summary: row.summary, model: row.model, createdAt: row.created_at } : null
  }
  set(url: string, summary: string, model: string): void {
    this.db.query('INSERT OR REPLACE INTO summaries (url, summary, model, created_at) VALUES (?, ?, ?, ?)').run(url, summary, model, Date.now())
  }
}

export type SummaryState =
  | { status: 'done'; url: string; summary: string; model: string; cached: boolean }
  | { status: 'pending'; url: string }
  | { status: 'failed'; url: string; error: string }
  | { status: 'unknown'; url: string }

/** Normalized so http/https, www, a trailing slash and a fragment are one page. */
export function summaryKey(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`
  } catch {
    return url
  }
}

export type SummarizerOptions = C0mputeOptions & {
  store?: SummaryStore
  /** Page fetcher for results whose engine text is thin; injectable for tests. */
  pageText?: (url: string) => Promise<string>
  /** How long a result stays summarizable after pit.world showed it. */
  textTtlMs?: number
}

export class Summarizer {
  readonly store: SummaryStore
  private texts = new Map<string, { url: string; text: string; at: number }>()
  private jobs = new Map<string, Promise<void>>()
  private failures = new Map<string, { error: string; at: number }>()
  constructor(private readonly options: SummarizerOptions = {}) {
    this.store = options.store ?? new SummaryStore()
  }

  get enabled(): boolean {
    return !!this.options.apiKey
  }

  /** Remember what the engines said about each result, so its summary can be asked for. In RAM only. */
  remember(hits: Hit[]): void {
    const now = Date.now()
    for (const hit of hits) {
      const key = summaryKey(hit.url)
      const prev = this.texts.get(key)
      const text = (hit.description ?? '').length >= (prev?.text.length ?? 0) ? hit.description ?? '' : prev!.text
      this.texts.delete(key)
      this.texts.set(key, { url: hit.url, text: `${hit.title}\n${text}`, at: now })
    }
    while (this.texts.size > 20_000) this.texts.delete(this.texts.keys().next().value!)
  }

  /** Whether pit.world recently returned this URL in a result. */
  known(url: string): boolean {
    const entry = this.texts.get(summaryKey(url))
    return !!entry && Date.now() - entry.at < (this.options.textTtlMs ?? 6 * 3600_000)
  }

  status(url: string): SummaryState {
    const key = summaryKey(url)
    const done = this.store.get(key)
    if (done) return { status: 'done', url, summary: done.summary, model: done.model, cached: true }
    if (this.jobs.has(key)) return { status: 'pending', url }
    const failed = this.failures.get(key)
    if (failed && Date.now() - failed.at < 10 * 60_000) return { status: 'failed', url, error: failed.error }
    return { status: 'unknown', url }
  }

  /** Starts a summary unless one exists or is being written. Returns at once; poll status(). */
  start(url: string): SummaryState {
    const key = summaryKey(url)
    const now = this.status(url)
    if (now.status === 'done' || now.status === 'pending') return now
    this.failures.delete(key)
    const job = this.run(key, url)
      .catch((error) => {
        this.failures.set(key, { error: error instanceof C0mputeError ? 'The summarizer did not answer. Try again in a minute.' : 'No summary this time. Try again in a minute.', at: Date.now() })
        // No URL or query in the log.
        console.warn(`summarize: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => this.jobs.delete(key))
    this.jobs.set(key, job)
    return { status: 'pending', url }
  }

  /** For tests and the CLI: start and wait. */
  async wait(url: string): Promise<SummaryState> {
    this.start(url)
    await this.jobs.get(summaryKey(url))
    return this.status(url)
  }

  private async run(key: string, url: string): Promise<void> {
    let text = this.texts.get(key)?.text ?? ''
    if (text.length < THIN_TEXT) {
      const page = await (this.options.pageText ?? ((u: string) => fetchPageText(u, this.options.fetch)))(url).catch(() => '')
      if (page.length > text.length) text = page
    }
    if (text.replace(/\s+/g, ' ').trim().length < 80) throw new Error('page text too thin to summarize')
    const answer = await c0mputeChat(SUMMARY_SYSTEM, `Page: ${url}\n\nText:\n${text.slice(0, MAX_INPUT)}`, this.options)
    const summary = cleanSummary(answer.text)
    if (!summary) throw new Error('the model found nothing to summarize')
    this.store.set(key, summary, answer.model)
  }
}
