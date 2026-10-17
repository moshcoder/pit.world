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

  categories(): Promise<{ categories: Array<Category & { count: number }>; prices: Array<{ slug: string; label: string }> }> {
    return this.get('/api/pros/categories')
  }

  /** The pit.world web ring. */
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
