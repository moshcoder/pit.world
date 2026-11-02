/**
 * Result summaries on demand, written by c0mpute (the peer inference network,
 * through Infernet's chat API) and never by a paid provider.
 *
 * A search page never waits for one: the snippet (src/snippet.ts) is the
 * instant answer, and "Summarize" under a result asks for 2-3 plain sentences
 * that land in the card when a node has written them, seconds to minutes later.
 *
 * The page itself is read every time, never just the engines' snippet: through
 * the TronBrowser `fetch_page` relay (the same page reader Infernet's /chat web
 * search uses: Obscura first, Chromium for JS-heavy pages and bot walls), then
 * pit.world's own direct fetch if the relay is down. The snippet only stands in
 * when no page can be read and it is long enough to say something.
 *
 * Privacy: the relay is sent the page address only; c0mpute is sent the page's
 * text and address and nothing else: not the query, not who asked. Only pages
 * pit.world itself just returned in a result can be summarized (so this is not a
 * fetch-anything proxy), and a summary is kept by URL so the second request for
 * it is instant and costs nobody anything.
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
/** An engine snippet shorter than this is not worth summarizing on its own when the page cannot be read. */
const THIN_TEXT = 600
/** The page reader Infernet's /chat web search uses (keyless MCP, tools/call fetch_page). */
export const DEFAULT_PAGE_RELAY_URL = 'https://tronbrowser.dev/mcp/tron'
/** Obscura gets this long before Chromium takes over; the whole read is cut at PAGE_RELAY_TIMEOUT_MS. */
const PAGE_RELAY_ENGINE_S = 15
const PAGE_RELAY_TIMEOUT_MS = 40_000
/** Rows without one of these were cached before pages were always read, and are rewritten on the next request. */
const SOURCES = new Set(['page', 'snippet'])

export class C0mputeError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`c0mpute ${status}: ${detail}`)
  }
}

export type C0mputeOptions = { baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: number; fetch?: Fetch; /** Share of timeoutMs the first node gets before one retry (default 0.55). */ firstTryShare?: number }

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
  const total = options.timeoutMs ?? SUMMARY_TIMEOUT_MS
  const overall = AbortSignal.timeout(total)
  const started = Date.now()
  // A node that takes the job and never answers must not eat the whole budget: the first try gets
  // a bit over half of it, then one retry on whichever node takes it next gets the rest.
  const firstTry = Math.round(total * (options.firstTryShare ?? 0.55))
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = total - (Date.now() - started)
    if (left < 5_000) break
    const signal = AbortSignal.any([overall, AbortSignal.timeout(attempt === 0 ? Math.min(firstTry, left) : left)])
    try {
      return await c0mputeAttempt(base, fetchImpl, system, user, options, signal)
    } catch (error) {
      lastError = error
      // Refused outright (bad key, bad request): another try gets the same answer.
      if (error instanceof C0mputeError && error.status >= 400 && error.status < 500 && error.status !== 429) break
    }
  }
  if (lastError instanceof C0mputeError) throw lastError
  throw new C0mputeError(0, lastError instanceof Error ? lastError.message : String(lastError ?? 'no answer'))
}

/** General models to fall back to, best first, when a node for the preferred one is not live. Never a fine-tune or an "abliterated" model. */
export const FALLBACK_MODELS = ['qwen2.5:7b', 'qwen3:4b', 'gemma3:4b', 'qwen2.5:3b', 'qwen2.5:1.5b']

/** The best general model from Infernet's list of live ones, other than the one just refused. */
export function pickModel(available: unknown, refused?: string): string | undefined {
  if (!Array.isArray(available)) return undefined
  return FALLBACK_MODELS.find((m) => m !== refused && available.includes(m))
}

async function c0mputeAttempt(
  base: string,
  fetchImpl: Fetch,
  system: string,
  user: string,
  options: C0mputeOptions,
  signal: AbortSignal,
): Promise<{ text: string; model: string }> {
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
    // No live node serves the preferred model right now: the best general model Infernet lists as
    // live, then any free node.
    if (submitted.status === 503 && options.model) {
      const refusal = (await submitted.json().catch(() => ({}))) as { detail?: { availableModels?: unknown } }
      const next = pickModel(refusal.detail?.availableModels, options.model)
      submitted = await submit(next)
      if (submitted.status === 503 && next) submitted = await submit(undefined)
    }
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

type Resolve = (host: string) => Promise<string[]>

/** http(s) on the default ports, no credentials, and every address the host resolves to is public. */
export async function isPublicPageUrl(url: URL, resolve: Resolve = defaultResolve): Promise<boolean> {
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false
  if (url.port && !['80', '443'].includes(url.port)) return false
  const addresses = await resolve(url.hostname).catch(() => [])
  return addresses.length > 0 && addresses.every(isPublicAddress)
}

/**
 * Keep the words of a markdown page: no images, link targets, or the short lines
 * that are menus, buttons and footers rather than content.
 */
export function markdownText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>|]+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    // The relay appends a JSON status line: {"engine":"chromium","url":...}
    .filter((line) => line.length >= 40 && !/^\{"engine":/.test(line))
    .join('\n')
}

/** A bot check served instead of the page ("Just a moment", "verify you are human"): its text would only mislead the model. */
const INTERSTITIAL = /(not a (ro)?bot|verify(ing)? you are human|just a moment|enable javascript and cookies|attention required)/i

/**
 * A public page's text through the TronBrowser relay (MCP tools/call fetch_page), which renders
 * JavaScript and gets past most bot walls. "" when the address is not public, the relay fails, or
 * all it got was a bot check.
 */
export async function relayPageText(raw: string, options: { relayUrl?: string; fetch?: Fetch; resolve?: Resolve } = {}): Promise<string> {
  const url = new URL(raw)
  if (!(await isPublicPageUrl(url, options.resolve))) return ''
  const response = await (options.fetch ?? fetch)(options.relayUrl || DEFAULT_PAGE_RELAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'fetch_page', arguments: { url: url.href, format: 'markdown', max_chars: 60_000, timeout_s: PAGE_RELAY_ENGINE_S } },
    }),
    signal: AbortSignal.timeout(PAGE_RELAY_TIMEOUT_MS),
  })
  if (!response.ok) return ''
  const body = (await response.json().catch(() => null)) as { error?: unknown; result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> } } | null
  if (!body || body.error || body.result?.isError) return ''
  const markdown = (body.result?.content ?? [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
  const text = markdownText(markdown)
  return INTERSTITIAL.test(text.slice(0, 600)) ? '' : text
}

/** The page's text: the relay first, pit.world's own direct fetch when the relay is off, down or got little. */
export async function readPage(url: string, options: { relayUrl?: string; fetch?: Fetch; resolve?: Resolve } = {}): Promise<string> {
  const viaRelay = options.relayUrl === '' ? '' : await relayPageText(url, options).catch(() => '')
  if (viaRelay.length >= 200) return viaRelay
  const direct = await fetchPageText(url, options.fetch, options.resolve).catch(() => '')
  return direct.length > viaRelay.length ? direct : viaRelay
}

/** A public web page's text: http(s) only, every address public (re-checked on each redirect), 6 s, 512 KB. */
export async function fetchPageText(raw: string, fetchImpl: Fetch = fetch, resolve: Resolve = defaultResolve): Promise<string> {
  let url = new URL(raw)
  for (let hop = 0; hop < 4; hop++) {
    if (!(await isPublicPageUrl(url, resolve))) return ''
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
    const text = htmlText(html)
    return INTERSTITIAL.test(text.slice(0, 600)) ? '' : text
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
    // What a summary was written from: 'page' or 'snippet'. Rows from before this column (NULL) were mostly
    // written from the engines' snippet alone, so they are rewritten from the page on the next request.
    const columns = this.db.query('PRAGMA table_info(summaries)').all() as Array<{ name: string }>
    if (!columns.some((c) => c.name === 'source')) this.db.exec('ALTER TABLE summaries ADD COLUMN source TEXT')
    // One-time: from 2026-11-02 11:00 UTC the TronBrowser relay could hand concurrent reads each other's
    // page (fixed in tronbrowser.dev #176), so summaries written since may describe another result.
    // They are dropped once and rewritten on the next request.
    this.db.exec('CREATE TABLE IF NOT EXISTS store_migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL)')
    if (!this.db.query("SELECT 1 FROM store_migrations WHERE name = 'relay-crosstalk-2026-11-02'").get()) {
      this.db.query('DELETE FROM summaries WHERE created_at >= ?').run(Date.UTC(2026, 10, 2, 11, 0))
      this.db.query("INSERT INTO store_migrations (name, at) VALUES ('relay-crosstalk-2026-11-02', ?)").run(Date.now())
    }
  }
  get(url: string): { summary: string; model: string; createdAt: number; source: string | null } | null {
    const row = this.db.query('SELECT summary, model, created_at, source FROM summaries WHERE url = ?').get(url) as { summary: string; model: string; created_at: number; source: string | null } | null
    return row ? { summary: row.summary, model: row.model, createdAt: row.created_at, source: row.source } : null
  }
  /** Counts for the nightly report: all summaries, and those written in [from, to) by source and model. No URLs. */
  stats(from: number, to: number): { total: number; written: number; fromPage: number; fromSnippet: number; models: Array<{ model: string; n: number }> } {
    const total = (this.db.query('SELECT COUNT(*) AS n FROM summaries').get() as { n: number }).n
    const by = this.db.query('SELECT source, COUNT(*) AS n FROM summaries WHERE created_at >= ? AND created_at < ? GROUP BY source').all(from, to) as Array<{ source: string | null; n: number }>
    const models = this.db.query('SELECT model, COUNT(*) AS n FROM summaries WHERE created_at >= ? AND created_at < ? GROUP BY model ORDER BY n DESC LIMIT 5').all(from, to) as Array<{ model: string; n: number }>
    const of = (s: string) => by.find((r) => r.source === s)?.n ?? 0
    return { total, written: by.reduce((a, r) => a + r.n, 0), fromPage: of('page'), fromSnippet: of('snippet'), models }
  }
  set(url: string, summary: string, model: string, source: 'page' | 'snippet' = 'page'): void {
    this.db.query('INSERT OR REPLACE INTO summaries (url, summary, model, created_at, source) VALUES (?, ?, ?, ?, ?)').run(url, summary, model, Date.now(), source)
  }
}

export type SummaryState =
  | { status: 'done'; url: string; summary: string; model: string; cached: boolean; source: 'page' | 'snippet' }
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
  /** Reads the page every summary is written from (default readPage); injectable for tests. */
  pageText?: (url: string) => Promise<string>
  /** The fetch_page relay (default DEFAULT_PAGE_RELAY_URL); '' reads pages directly only. */
  pageRelayUrl?: string
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

  /** The title pit.world showed for a recent result, or null. */
  title(url: string): string | null {
    const entry = this.texts.get(summaryKey(url))
    return entry ? (entry.text.split('\n')[0] ?? '').trim() || null : null
  }

  /** Whether pit.world recently returned this URL in a result. */
  known(url: string): boolean {
    const entry = this.texts.get(summaryKey(url))
    return !!entry && Date.now() - entry.at < (this.options.textTtlMs ?? 6 * 3600_000)
  }

  status(url: string): SummaryState {
    const key = summaryKey(url)
    const done = this.store.get(key)
    if (done?.source && SOURCES.has(done.source))
      return { status: 'done', url, summary: done.summary, model: done.model, cached: true, source: done.source as 'page' | 'snippet' }
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
        const message =
          error instanceof C0mputeError
            ? 'The summarizer did not answer. Try again in a minute.'
            : error instanceof Error && error.message === 'could not read the page'
              ? 'Could not read that page to summarize it.'
              : 'No summary this time. Try again in a minute.'
        this.failures.set(key, { error: message, at: Date.now() })
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

  /** A page's text, read the way summaries read it (the relay, then a direct fetch). "" when it cannot be read. */
  async pageText(url: string): Promise<string> {
    const read =
      this.options.pageText ??
      ((u: string) =>
        readPage(u, {
          ...(this.options.pageRelayUrl !== undefined ? { relayUrl: this.options.pageRelayUrl } : {}),
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        }))
    return (await read(url).catch(() => '')).trim()
  }

  private async run(key: string, url: string): Promise<void> {
    const snippet = (this.texts.get(key)?.text ?? '').replace(/\s+/g, ' ').trim()
    const page = await this.pageText(url)
    // The page is what gets summarized. The snippet stands in only when no page could be read.
    let text: string
    let source: 'page' | 'snippet'
    if (page.replace(/\s+/g, ' ').length >= 80) {
      text = page
      source = 'page'
    } else if (snippet.length >= THIN_TEXT) {
      text = snippet
      source = 'snippet'
    } else throw new Error('could not read the page')
    const answer = await c0mputeChat(SUMMARY_SYSTEM, `Page: ${url}\n\nText:\n${text.slice(0, MAX_INPUT)}`, this.options)
    const summary = cleanSummary(answer.text)
    if (!summary) throw new Error('the model found nothing to summarize')
    this.store.set(key, summary, answer.model, source)
  }
}
