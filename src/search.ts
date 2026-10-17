/**
 * Web search, privately.
 *
 * The visitor's browser talks only to pit.world. pit.world asks one provider
 * on their behalf, so the provider sees our server and the words, never the
 * person: no IP, no cookie, no user agent, no referrer.
 *
 * Each query goes to the Google index (Serper) and the Bing index (DataForSEO)
 * at once, and the two lists are merged: results both engines found rise, each
 * result says which engine found it. Bing gets a short leash, so a slow Bing
 * answer means a Google-only page, never a slow page. Only when both fail do
 * the fallbacks (Linkup, Exa, Perplexity) run, one at a time. The parsers
 * follow cli-tools' `websearch`.
 */

export type Hit = { url: string; title: string; description: string; host: string; sources?: Provider[] }

export type Provider = 'serper' | 'bing' | 'linkup' | 'exa' | 'perplexity'

export type Keys = Partial<Record<Provider, string>>

export type SearchResult = {
  query: string
  /** The engine, or engines joined with +, that answered: `serper+bing`, `serper`, `linkup`. */
  provider: string | null
  hits: Hit[]
  /** Providers that were tried and failed, with why. Never shown with the query attached. */
  failures: Array<{ provider: Provider; error: string }>
  cached: boolean
}

/** Asked together and merged. */
export const PRIMARY: Provider[] = ['serper', 'bing']
/** Tried one by one, only when every primary failed. */
export const FALLBACK: Provider[] = ['linkup', 'exa', 'perplexity']
export const ORDER: Provider[] = [...PRIMARY, ...FALLBACK]
/** How long the merge waits for a slower primary once one has answered. */
const SECOND_WAIT_MS = 2_500
export const LABELS: Record<Provider, string> = { serper: 'Google', bing: 'Bing', linkup: 'Linkup', exa: 'Exa', perplexity: 'Perplexity' }
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

/** DataForSEO SERP (Bing): tasks[0].result[0].items[] of { type, url, title, description }. */
export function parseDataForSeo(body: any): Hit[] {
  const items: any[] = body?.tasks?.[0]?.result?.[0]?.items ?? []
  return cleanHits(items.filter((i) => i?.type === 'organic').map((i) => ({ url: i.url, title: i.title, description: i.description })))
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
  const json = JSON.parse(text)
  // DataForSEO answers HTTP 200 with its own status inside.
  const inner = json?.tasks?.[0]?.status_code
  if (typeof inner === 'number' && inner !== 20000) throw new Error(`provider status ${inner}`)
  return json
}

export async function callProvider(provider: Provider, key: string, query: string, limit: number, fetchImpl: Fetch = fetch): Promise<Hit[]> {
  switch (provider) {
    case 'serper':
      return parseSerper(await postJson(fetchImpl, 'https://google.serper.dev/search', { 'x-api-key': key }, { q: query, num: limit })).slice(0, limit)
    case 'bing':
      // key is "login:password", sent as HTTP basic auth.
      return parseDataForSeo(
        await postJson(
          fetchImpl,
          'https://api.dataforseo.com/v3/serp/bing/organic/live/regular',
          { authorization: `Basic ${Buffer.from(key).toString('base64')}` },
          [{ keyword: query, location_code: 2840, language_code: 'en', depth: Math.max(10, limit) }],
        ),
      ).slice(0, limit)
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
  return Array.from(query.replace(/\s+/g, ' ').trim()).slice(0, MAX_QUERY).join('').trim()
}

/** Normalized for de-duplication: scheme, www, trailing slash and fragment do not make a page different. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase()
  } catch {
    return url
  }
}

/**
 * Reciprocal-rank fusion: each list scores 1/(60 + rank) per result, summed.
 * A page both engines rank well beats one either ranks alone.
 */
export function mergeResults(lists: Array<{ provider: Provider; hits: Hit[] }>, limit: number): Hit[] {
  const merged = new Map<string, { hit: Hit; score: number; sources: Provider[] }>()
  for (const { provider, hits } of lists) {
    hits.forEach((hit, index) => {
      const key = urlKey(hit.url)
      const entry = merged.get(key) ?? { hit, score: 0, sources: [] }
      entry.score += 1 / (60 + index + 1)
      if (!entry.sources.includes(provider)) entry.sources.push(provider)
      // Keep the longer snippet: one engine often truncates where the other does not.
      if (hit.description.length > entry.hit.description.length) entry.hit = { ...entry.hit, description: hit.description }
      merged.set(key, entry)
    })
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, sources }) => ({ ...hit, sources }))
}

/** Settles with whatever the primaries returned: the first answer, plus any other that lands within SECOND_WAIT_MS of it. */
async function askPrimaries(
  providers: Provider[],
  keys: Keys,
  q: string,
  limit: number,
  fetchImpl: Fetch | undefined,
  failures: SearchResult['failures'],
): Promise<Array<{ provider: Provider; hits: Hit[] }>> {
  const answers: Array<{ provider: Provider; hits: Hit[] }> = []
  let firstAnswer: () => void = () => {}
  const first = new Promise<void>((resolve) => (firstAnswer = resolve))
  const calls = providers.map((provider) =>
    callProvider(provider, keys[provider]!, q, limit, fetchImpl).then(
      (hits) => {
        answers.push({ provider, hits })
        firstAnswer()
      },
      (error) => failures.push({ provider, error: error instanceof Error ? error.message : String(error) }),
    ),
  )
  const all = Promise.all(calls)
  await Promise.race([all, first])
  if (answers.length && answers.length < providers.length) {
    await Promise.race([all, new Promise((resolve) => setTimeout(resolve, SECOND_WAIT_MS))])
  }
  // Keep the configured order so fusion ties break the same way every time.
  return [...answers].sort((a, b) => providers.indexOf(a.provider) - providers.indexOf(b.provider))
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
  // Answer with the caller's words: echoing the first asker's would tell this one what someone else searched.
  if (hit) return { ...hit, query: q }
  const failures: SearchResult['failures'] = []
  const order = (options.order ?? ORDER).filter((p) => keys[p])
  if (!order.length) throw new SearchUnavailable('No search provider is configured.')
  const primaries = order.filter((p) => PRIMARY.includes(p))
  const fallbacks = order.filter((p) => !PRIMARY.includes(p))

  if (primaries.length) {
    const answers = await askPrimaries(primaries, keys, q, limit, options.fetch, failures)
    if (answers.length) {
      const result: SearchResult = {
        query: q,
        provider: answers.map((a) => a.provider).join('+'),
        hits: mergeResults(answers, limit),
        failures,
        cached: false,
      }
      // A partial answer (one engine timed out or failed) is not cached, so the next asker gets both.
      if (answers.length === primaries.length) options.cache?.set(cacheKey, result)
      return result
    }
  }
  for (const provider of fallbacks) {
    try {
      const hits = (await callProvider(provider, keys[provider]!, q, limit, options.fetch)).map((h) => ({ ...h, sources: [provider] }))
      const result: SearchResult = { query: q, provider, hits, failures, cached: false }
      options.cache?.set(cacheKey, result)
      return result
    } catch (error) {
      failures.push({ provider, error: error instanceof Error ? error.message : String(error) })
    }
  }
  throw new SearchUnavailable(`Every search provider failed: ${failures.map((f) => `${f.provider} ${f.error}`).join('; ')}`)
}
