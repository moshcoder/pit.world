/**
 * Web search, privately.
 *
 * The visitor's browser talks only to pit.world. pit.world asks one provider
 * on their behalf, so the provider sees our server and the words, never the
 * person: no IP, no cookie, no user agent, no referrer.
 *
 * Hybrid results: each query goes to every configured index at once (Google
 * via Serper, Bing via DataForSEO, Brave, Tavily, Ceramic, Exa, Linkup and a
 * local SearXNG), the top 10 from each are fused, and each result says which
 * engines found it, so pages several engines agree on rise. Once one engine has
 * answered the rest get a short leash, so a slow engine means a thinner page,
 * never a slow one. Perplexity, the only one with no free allowance, runs only
 * when every other engine failed. An engine that says it is out of credits is
 * benched for a while instead of being asked on every search. The parsers
 * follow cli-tools' `websearch`.
 */

export type Hit = { url: string; title: string; description: string; host: string; sources?: Provider[] }

export type Provider = 'serper' | 'bing' | 'brave' | 'tavily' | 'ceramic' | 'exa' | 'linkup' | 'searxng' | 'perplexity'

export type Keys = Partial<Record<Provider, string>>

export type SearchResult = {
  query: string
  /** The engine, or engines joined with +, that answered: `serper+bing`, `serper`, `linkup`. */
  provider: string | null
  hits: Hit[]
  /** Providers that were tried and failed, with why. Never shown with the query attached. */
  failures: Array<{ provider: Provider; error: string; credits?: boolean }>
  cached: boolean
}
/** Asked together and merged. Broad indexes first: fusion ties go to the earlier list, and SearXNG already blends five engines. */
// Broad indexes first: fusion ties go to the earlier list, and SearXNG already blends five engines.
export const PRIMARY: Provider[] = ['serper', 'bing', 'searxng', 'brave', 'tavily', 'exa', 'linkup', 'ceramic']
/** Tried one by one, only when every primary failed. */
export const FALLBACK: Provider[] = ['perplexity']
export const ORDER: Provider[] = [...PRIMARY, ...FALLBACK]
/** How long the merge waits for a slower primary once one has answered. */
const SECOND_WAIT_MS = 2_500
/** How many results each engine is asked for, whatever the page shows. */
export const PER_ENGINE = 10
/** How long an engine that said it is out of credits sits out. */
const BENCH_MS = 15 * 60_000
export const LABELS: Record<Provider, string> = {
  serper: 'Google',
  bing: 'Bing',
  brave: 'Brave',
  tavily: 'Tavily',
  ceramic: 'Ceramic',
  exa: 'Exa',
  linkup: 'Linkup',
  searxng: 'SearXNG',
  perplexity: 'Perplexity',
}
export const MAX_QUERY = 512
const TIMEOUT_MS = 8_000

export class SearchUnavailable extends Error {}

/** The provider answered that the account has no credits, quota or funds left. */
export class OutOfCredits extends Error {}

/** Engines out of credits, and until when. In memory only; a restart forgets it. */
const benched = new Map<Provider, number>()

export function clearBench(): void {
  benched.clear()
}

function isBenched(provider: Provider): boolean {
  const until = benched.get(provider)
  if (until === undefined) return false
  if (Date.now() < until) return true
  benched.delete(provider)
  return false
}

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

export function parseBrave(body: any): Hit[] {
  const results: any[] = Array.isArray(body?.web?.results) ? body.web.results : []
  return cleanHits(results.map((r) => ({ url: r?.url, title: stripTags(r?.title), description: stripTags(r?.description) })))
}

export function parseTavily(body: any): Hit[] {
  const results: any[] = Array.isArray(body?.results) ? body.results : []
  return cleanHits(results.map((r) => ({ url: r?.url, title: r?.title, description: r?.content })))
}

/** Ceramic: `result.results[]` of { title, url, description }. */
export function parseCeramic(body: any): Hit[] {
  const results: any[] = Array.isArray(body?.result?.results) ? body.result.results : Array.isArray(body?.results) ? body.results : []
  return cleanHits(results.map((r) => ({ url: r?.url, title: r?.title, description: typeof r?.description === 'string' ? r.description.replace(/\s+/g, ' ') : '' })))
}

export function parseSearxng(body: any): Hit[] {
  const results: any[] = Array.isArray(body?.results) ? body.results : []
  return cleanHits(results.map((r) => ({ url: r?.url, title: r?.title, description: r?.content })))
}

/** Brave marks query words with <strong>; the page escapes everything, so drop the tags here. */
function stripTags(value: unknown): string {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '') : ''
}

export function parsePerplexity(body: any): Hit[] {
  const results: any[] = Array.isArray(body?.results) ? body.results : []
  return cleanHits(results.map((r) => ({ url: r?.url, title: r?.title, description: r?.snippet })))
}

const CREDITS = /credit|funds|quota|payment|balance|top ?up|exceeded/i

async function readJson(response: Response): Promise<any> {
  const text = await response.text()
  if (!response.ok) {
    // Serper says 400, Linkup 429, Exa 402: the words are the only common ground.
    if ([400, 402, 403, 429, 432].includes(response.status) && CREDITS.test(text)) throw new OutOfCredits(`HTTP ${response.status} out of credits`)
    throw new Error(`HTTP ${response.status}`)
  }
  const json = JSON.parse(text)
  // DataForSEO answers HTTP 200 with its own status inside.
  const inner = json?.tasks?.[0]?.status_code
  if (typeof inner === 'number' && inner !== 20000) throw new Error(`provider status ${inner}`)
  return json
}

async function postJson(fetchImpl: Fetch, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  return readJson(
    await fetchImpl(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  )
}

async function getJson(fetchImpl: Fetch, url: string, headers: Record<string, string>): Promise<any> {
  return readJson(await fetchImpl(url, { headers: { ...headers, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) }))
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
    case 'brave':
      return parseBrave(
        await getJson(fetchImpl, `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(Math.min(20, limit)) })}`, {
          'x-subscription-token': key,
        }),
      ).slice(0, limit)
    case 'tavily':
      return parseTavily(await postJson(fetchImpl, 'https://api.tavily.com/search', { authorization: `Bearer ${key}` }, { query, max_results: limit, search_depth: 'basic' })).slice(0, limit)
    case 'ceramic':
      return parseCeramic(await postJson(fetchImpl, 'https://api.ceramic.ai/search', { authorization: `Bearer ${key}` }, { query })).slice(0, limit)
    case 'searxng':
      // key is the instance's base URL, e.g. http://127.0.0.1:8888, reached over loopback.
      return parseSearxng(await getJson(fetchImpl, `${key.replace(/\/+$/, '')}/search?${new URLSearchParams({ q: query, format: 'json' })}`, {})).slice(0, limit)
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
  // The Images/Videos/Music/Live tabs (verticals.ts), under the same rules.
  private media = new Map<string, { at: number; value: unknown }>()
  getMedia<T>(key: string): T | null {
    const entry = this.media.get(key)
    if (!entry) return null
    if (Date.now() - entry.at > this.ttlMs) {
      this.media.delete(key)
      return null
    }
    return entry.value as T
  }
  setMedia(key: string, value: unknown): void {
    if (this.media.size >= this.max) this.media.delete(this.media.keys().next().value!)
    this.media.set(key, { at: Date.now(), value })
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
): Promise<{ answers: Array<{ provider: Provider; hits: Hit[] }>; settled: boolean }> {
  const answers: Array<{ provider: Provider; hits: Hit[] }> = []
  let done = 0
  let firstAnswer: () => void = () => {}
  const first = new Promise<void>((resolve) => (firstAnswer = resolve))
  const calls = providers.map((provider) =>
    callProvider(provider, keys[provider]!, q, limit, fetchImpl).then(
      (hits) => {
        done++
        answers.push({ provider, hits })
        firstAnswer()
      },
      (error) => {
        done++
        fail(failures, provider, error)
      },
    ),
  )
  const all = Promise.all(calls)
  await Promise.race([all, first])
  if (answers.length && answers.length < providers.length) {
    await Promise.race([all, new Promise((resolve) => setTimeout(resolve, SECOND_WAIT_MS))])
  }
  // Keep the configured order so fusion ties break the same way every time.
  const sorted = [...answers].sort((a, b) => providers.indexOf(a.provider) - providers.indexOf(b.provider))
  // Settled: nobody is still running, and every failure was one the next search would hit too.
  return { answers: sorted, settled: done === providers.length && failures.every((f) => f.credits) }
}

function fail(failures: SearchResult['failures'], provider: Provider, error: unknown): void {
  const credits = error instanceof OutOfCredits
  if (credits) benched.set(provider, Date.now() + BENCH_MS)
  failures.push({ provider, error: error instanceof Error ? error.message : String(error), ...(credits ? { credits: true } : {}) })
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
  const configured = (options.order ?? ORDER).filter((p) => keys[p])
  if (!configured.length) throw new SearchUnavailable('No search provider is configured.')
  // When every engine is benched, ask anyway: someone may have topped one up.
  const awake = configured.filter((p) => !isBenched(p))
  const order = awake.length ? awake : configured
  const primaries = order.filter((p) => PRIMARY.includes(p))
  const fallbacks = order.filter((p) => !PRIMARY.includes(p))

  if (primaries.length) {
    const { answers, settled } = await askPrimaries(primaries, keys, q, Math.max(PER_ENGINE, limit), options.fetch, failures)
    if (answers.length) {
      const result: SearchResult = {
        query: q,
        provider: answers.map((a) => a.provider).join('+'),
        hits: mergeResults(answers, limit),
        failures,
        cached: false,
      }
      // A partial answer (an engine timed out or failed) is not cached, so the next asker gets them all.
      // An engine out of credits will not be back in ten minutes, so it does not hold the cache up.
      if (settled) options.cache?.set(cacheKey, result)
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
      fail(failures, provider, error)
    }
  }
  throw new SearchUnavailable(`Every search provider failed: ${failures.map((f) => `${f.provider} ${f.error}`).join('; ')}`)
}
