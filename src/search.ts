/**
 * Web search, privately.
 *
 * The visitor's browser talks only to pit.world. pit.world asks one provider
 * on their behalf, so the provider sees our server and the words, never the
 * person: no IP, no cookie, no user agent, no referrer.
 *
 * One provider answers each query (Serper, i.e. Google's index, first), and
 * the next one is tried only if it fails. Asking all of them and fusing the
 * results costs five times as much per search for a page that is usually the
 * same; the providers and their parsers follow cli-tools' `websearch`.
 */

export type Hit = { url: string; title: string; description: string; host: string }

export type Provider = 'serper' | 'linkup' | 'exa' | 'perplexity'

export type Keys = Partial<Record<Provider, string>>

export type SearchResult = {
  query: string
  provider: Provider | null
  hits: Hit[]
  /** Providers that were tried and failed, with why. Never shown with the query attached. */
  failures: Array<{ provider: Provider; error: string }>
  cached: boolean
}

export const ORDER: Provider[] = ['serper', 'linkup', 'exa', 'perplexity']
export const MAX_QUERY = 512
const TIMEOUT_MS = 8_000

export class SearchUnavailable extends Error {}

type Fetch = typeof fetch

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Only http(s) links reach a page: a `javascript:` URL from a provider must never become an href. */
export function cleanHits(raw: Array<{ url?: unknown; title?: unknown; description?: unknown }>): Hit[] {
  const seen = new Set<string>()
  const out: Hit[] = []
  for (const item of raw) {
    if (typeof item.url !== 'string') continue
    const url = item.url.trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    out.push({
      url,
      title: (typeof item.title === 'string' && item.title.trim()) || host(url),
      description: typeof item.description === 'string' ? item.description.trim() : '',
      host: host(url),
    })
  }
  return out
}

export function parseSerper(body: any): Hit[] {
  const organic: any[] = Array.isArray(body?.organic) ? body.organic : []
  return cleanHits(organic.map((r) => ({ url: r?.link, title: r?.title, description: r?.snippet })))
}

export function parseLinkup(body: any): Hit[] {
  const results: any[] = Array.isArray(body?.results) ? body.results : []
  return cleanHits(results.map((r) => ({ url: r?.url, title: r?.name ?? r?.title, description: r?.content ?? r?.snippet })))
}

export function parseExa(body: any): Hit[] {
  const results: any[] = Array.isArray(body?.results) ? body.results : []
  return cleanHits(results.map((r) => ({ url: r?.url, title: r?.title, description: r?.text ?? r?.summary ?? '' })))
}

export function parsePerplexity(body: any): Hit[] {
  const results: any[] = Array.isArray(body?.results) ? body.results : []
  return cleanHits(results.map((r) => ({ url: r?.url, title: r?.title, description: r?.snippet })))
}

async function postJson(fetchImpl: Fetch, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return JSON.parse(text)
}

export async function callProvider(provider: Provider, key: string, query: string, limit: number, fetchImpl: Fetch = fetch): Promise<Hit[]> {
  switch (provider) {
    case 'serper':
      return parseSerper(await postJson(fetchImpl, 'https://google.serper.dev/search', { 'x-api-key': key }, { q: query, num: limit })).slice(0, limit)
    case 'linkup':
      return parseLinkup(
        await postJson(fetchImpl, 'https://api.linkup.so/v1/search', { authorization: `Bearer ${key}` }, { q: query, depth: 'standard', outputType: 'searchResults' }),
      ).slice(0, limit)
    case 'exa':
      return parseExa(await postJson(fetchImpl, 'https://api.exa.ai/search', { 'x-api-key': key }, { query, numResults: limit })).slice(0, limit)
    case 'perplexity':
      return parsePerplexity(await postJson(fetchImpl, 'https://api.perplexity.ai/search', { authorization: `Bearer ${key}` }, { query, max_results: limit })).slice(0, limit)
  }
}

/**
 * A small in-memory cache, so a popular query is paid for once every few
 * minutes. It lives in RAM only, is never written to disk, holds no
 * information about who asked, and is gone on restart. The privacy page says so.
 */
export class Cache {
  private entries = new Map<string, { at: number; value: SearchResult }>()
  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 2_000,
  ) {}
  get(key: string): SearchResult | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(key)
      return null
    }
    return { ...entry.value, cached: true }
  }
  set(key: string, value: SearchResult): void {
    if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!)
    this.entries.set(key, { at: Date.now(), value })
  }
}

export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY)
}

export async function search(
  query: string,
  keys: Keys,
  options: { limit?: number; cache?: Cache; fetch?: Fetch; order?: Provider[] } = {},
): Promise<SearchResult> {
  const q = normalizeQuery(query)
  const limit = Math.min(20, Math.max(1, options.limit ?? 10))
  const cacheKey = `${limit}:${q.toLowerCase()}`
  const hit = options.cache?.get(cacheKey)
  if (hit) return hit
  const failures: SearchResult['failures'] = []
  const configured = (options.order ?? ORDER).filter((p) => keys[p])
  if (!configured.length) throw new SearchUnavailable('No search provider is configured.')
  for (const provider of configured) {
    try {
      const hits = await callProvider(provider, keys[provider]!, q, limit, options.fetch)
      const result: SearchResult = { query: q, provider, hits, failures, cached: false }
      options.cache?.set(cacheKey, result)
      return result
    } catch (error) {
      failures.push({ provider, error: error instanceof Error ? error.message : String(error) })
    }
  }
  throw new SearchUnavailable(`Every search provider failed: ${failures.map((f) => `${f.provider} ${f.error}`).join('; ')}`)
}
