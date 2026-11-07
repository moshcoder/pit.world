/**
 * The pit.world API, as a client. The CLI, the TUI and the MCP server all use
 * this, so none of them need provider keys: they ask pit.world, privately,
 * like the page does. PIT_URL points them at another instance.
 */
import type { Hit } from './search.js'
import type { NetworkStats, Resolution } from './moshpit.js'
import type { Listing } from './listings.js'
import type { Category } from './pros.js'

export type ApiSearch = {
  query: string
  provider: string | null
  /** Older servers only; pit.world no longer says whether an answer came from its cache. */
  cached?: boolean
  results: Hit[]
  moshpit: Resolution | null
}

export type CorpusItem = { url: string; title: string; site: string; kind: string; language: string | null; fetched_at: string; text: string }
export type CorpusPage = {
  total_estimate: number | null
  next_cursor: string | null
  resume_cursor?: string
  items: CorpusItem[]
  access?: Record<string, unknown>
}
export type CorpusOptions = { site?: string; kind?: string; lang?: string; since?: string; limit?: number; cursor?: string; key?: string }

export type VoteTally = { item: string; kind?: string; up: number; down: number; score: number }

export class PitClient {
  constructor(
    readonly base = (process.env.PIT_URL ?? 'https://pit.world').replace(/\/+$/, ''),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.base}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    const body = (await response.json().catch(() => ({}))) as any
    if (!response.ok) {
      const retry = response.headers.get('retry-after')
      throw new Error(`${body?.error ?? `HTTP ${response.status}`}${retry ? ` (retry in ${retry}s)` : ''}`)
    }
    return body as T
  }

  search(query: string, n = 10): Promise<ApiSearch> {
    return this.get(`/api/search?q=${encodeURIComponent(query)}&n=${n}`)
  }

  resolve(name: string): Promise<Resolution> {
    return this.get(`/api/resolve?name=${encodeURIComponent(name)}`)
  }

  /**
   * A page of the training corpus (pit.world's own crawl index as full text). Free: 20 short
   * pages a day; with `key` (a corpus credit key, a pit login token, or the internal key) full text.
   * A 402 throws with the price and how to pay.
   */
  async corpus(query: string, options: CorpusOptions = {}): Promise<CorpusPage> {
    const params = new URLSearchParams()
    if (query) params.set('q', query)
    for (const k of ['site', 'kind', 'lang', 'since', 'cursor'] as const) if (options[k]) params.set(k, String(options[k]))
    params.set('limit', String(options.limit ?? 20))
    const key = options.key ?? process.env.PIT_CORPUS_KEY
    const response = await this.fetchImpl(`${this.base}/api/corpus?${params}`, {
      headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    })
    const body = (await response.json().catch(() => ({}))) as any
    if (response.status === 402) throw new Error(`${body?.error ?? 'Payment required.'} ${body?.price?.this_request ? `This request: ${body.price.this_request}.` : ''} See ${body?.docs ?? `${this.base}/api#corpus`}`.trim())
    if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
    return body as CorpusPage
  }

  corpusStats(): Promise<Record<string, unknown>> {
    return this.get('/api/corpus/stats')
  }

  network(): Promise<NetworkStats> {
    return this.get('/api/network')
  }

  /** A business listing: the owner's words if claimed, else what the site's homepage says. */
  listing(domain: string): Promise<Listing> {
    return this.get(`/api/listing?domain=${encodeURIComponent(domain)}`)
  }

  private async post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await response.json().catch(() => ({}))) as any
    if (!response.ok && response.status !== 400) throw new Error(data?.error ?? `HTTP ${response.status}`)
    return data as T
  }

  /**
   * A c0mpute summary of a page pit.world returned in a result: starts one, then polls until a node has
   * written it (up to `waitMs`). `token` (from `pit login`) lifts the anonymous hourly allowance.
   */
  async summarize(url: string, options: { token?: string; waitMs?: number; pollMs?: number } = {}): Promise<{ status: string; url: string; summary?: string; model?: string; error?: string }> {
    const auth: Record<string, string> = options.token ? { authorization: `Bearer ${options.token}` } : {}
    const response = await this.fetchImpl(`${this.base}/api/summarize`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(20_000),
    })
    let body = (await response.json().catch(() => ({}))) as any
    if (!response.ok && response.status !== 202) throw new Error(body?.error ?? `HTTP ${response.status}`)
    const until = Date.now() + (options.waitMs ?? 150_000)
    while (body?.status === 'pending' && Date.now() < until) {
      await new Promise((r) => setTimeout(r, options.pollMs ?? 3_000))
      body = await this.get(`/api/summarize?url=${encodeURIComponent(url)}`)
    }
    return body
  }

  /** Put sites, pages, feeds, sitemaps or OPML into pit.world's own index (up to 1,000). */
  submit(urls: string[]): Promise<{ ok: boolean; accepted: Array<{ url: string; kind: string }>; rejected: Array<{ url: string; error: string }>; queued: number; message?: string }> {
    return this.post('/api/submit', { urls })
  }

  /** Start claiming a listing: returns the TXT record / meta tag to publish and a claim id. */
  claim(domain: string): Promise<{ domain: string; claimId: string; token: string; txtHost: string; meta: string; page: string }> {
    return this.post('/api/listing/claim', { domain })
  }

  /** Check the record or tag; on success the edit key comes back, once. */
  verify(claimId: string): Promise<{ ok: boolean; method?: string; editKey?: string; reason?: string }> {
    return this.post('/api/listing/verify', { claim: claimId })
  }

  /** The pro directory: claimed listings and ones pit.world listed (seeded), filtered by category, place and words. */
  pros(options: { category?: string; near?: string; q?: string; n?: number; page?: number } = {}): Promise<{ total: number; page: number; results: Listing[] }> {
    const params = new URLSearchParams()
    if (options.category) params.set('c', options.category)
    if (options.near) params.set('near', options.near)
    if (options.q) params.set('q', options.q)
    if (options.n) params.set('n', String(options.n))
    if (options.page) params.set('page', String(options.page))
    return this.get(`/api/pros?${params}`)
  }

  /** Vote tallies (read-only): one item, or several `kind:target` items; `query` scopes result votes to one search. */
  votes(items: Array<{ kind: string; target: string }>, query?: string): Promise<{ query: string | null; prior: { up: number; down: number }; items: VoteTally[] }> {
    const params = new URLSearchParams()
    for (const { kind, target } of items) params.append('item', `${kind}:${target}`)
    if (query) params.set('q', query)
    return this.get(`/api/votes?${params}`)
  }

  /** Best- or worst-voted items of a kind. */
  topVotes(kind: string, options: { order?: 'best' | 'worst'; n?: number; min?: number } = {}): Promise<{ kind: string; order: string; items: Array<VoteTally & { target: string }>; totals: { votes: number; items: number; visitors: number } }> {
    const params = new URLSearchParams({ kind })
    if (options.order) params.set('order', options.order)
    if (options.n) params.set('n', String(options.n))
    if (options.min) params.set('min', String(options.min))
    return this.get(`/api/votes/top?${params}`)
  }

  categories(): Promise<{ categories: Array<Category & { count: number }>; prices: Array<{ slug: string; label: string }> }> {
    return this.get('/api/pros/categories')
  }

  /** The pit.world web ring. */
  /** MCP servers pitbot found on the web and proved with a handshake. Their text is the operators' own. */
  mcps(query = '', limit = 20): Promise<{ items: Array<{ mcp: string; name: string; description?: string; auth?: string; foundOn?: string; tools?: Array<{ name: string; description?: string | null }> }>; total: number }> {
    return this.get(`/api/mcps?${new URLSearchParams({ q: query, limit: String(limit) })}`)
  }

  ring(): Promise<{ name: string; home: string; mirror: string; count: number; sites: Array<{ name: string; about: string; moshpit: boolean; listing: boolean; feed?: string; url: string; proxyUrl: string }> }> {
    return this.get('/api/ring')
  }

  /** Edit a claimed listing with its edit key. `contactEmail` sets the private quote-request address ('' clears it). */
  async edit(domain: string, key: string, fields: Record<string, unknown>): Promise<Listing & { contactStatus?: string; contactResult?: string }> {
    const response = await this.fetchImpl(`${this.base}/api/listing`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...fields, domain }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await response.json().catch(() => ({}))) as any
    if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
    return data
  }

  /** Send one quote request to one listing's owner (their address stays private). */
  async quote(domain: string, form: { name: string; email: string; phone?: string; message: string }): Promise<{ ok: boolean; status: string }> {
    const response = await this.fetchImpl(`${this.base}/api/listing/quote`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ ...form, domain }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await response.json().catch(() => ({}))) as any
    if (response.status === 429) throw new Error(data?.error ?? 'Too many requests. Try again later.')
    return { ok: Boolean(data?.ok), status: String(data?.status ?? `HTTP ${response.status}`) }
  }

  /**
   * The promotion API (/api/v1/promotion), for operators: PIT_ADMIN_TOKEN is the bearer. Text responses
   * (CSV, Markdown) come back as strings.
   */
  async promo<T = any>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const token = process.env.PIT_ADMIN_TOKEN
    if (!token) throw new Error('set PIT_ADMIN_TOKEN (the pit.world admin token) for promotion commands')
    const response = await this.fetchImpl(`${this.base}/api/v1/promotion${path}`, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'x-pit-actor': process.env.PIT_ACTOR ?? 'cli', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    })
    const type = response.headers.get('content-type') ?? ''
    if (!type.includes('json')) {
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return text as T
    }
    const data = (await response.json().catch(() => ({}))) as any
    if (!response.ok) throw new Error(`${data?.error ?? `HTTP ${response.status}`}${data?.code ? ` (${data.code})` : ''}`)
    return data as T
  }

  /** Start a newsletter signup; the address only joins after the emailed link is clicked. */
  async subscribe(email: string): Promise<{ ok: boolean; status: string }> {
    const response = await this.fetchImpl(`${this.base}/api/subscribe`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await response.json().catch(() => ({}))) as any
    if (response.status === 429 || response.status === 404) throw new Error(body?.error ?? `HTTP ${response.status}`)
    return { ok: Boolean(body?.ok), status: String(body?.status ?? `HTTP ${response.status}`) }
  }
}
