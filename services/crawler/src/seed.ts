/**
 * Where the first sites come from, the backfill: everything nichedb.dev
 * already keeps in /c/sites, the pit.world ring, shops (c0upons.com's stores,
 * Wikidata's online shops and retail chains), a file, or names typed.
 * Each becomes a site job once per cycle; the crawl takes it from there.
 */
import { RING } from '../../../src/ring.ts'
import { siteFromInput } from './url.ts'

type Fetch = typeof fetch

/**
 * Every distinct site nichedb's sites collection holds, newest pages first, up to `limit`
 * sites. Reading it is metered now, and an unauthenticated run answers 402 a few pages in
 * (2026-11-05), so this sends the same key the publisher uses -- it is our own collection.
 */
export async function sitesFromNichedb(nichedbUrl: string, options: { limit?: number; fetch?: Fetch; maxPages?: number; key?: string } = {}): Promise<string[]> {
  const fetchImpl = options.fetch ?? fetch
  const limit = options.limit ?? 50_000
  const found = new Set<string>()
  let before = 0
  for (let page = 0; page < (options.maxPages ?? 2_000) && found.size < limit; page++) {
    const url = `${nichedbUrl}/api/v1/items?collection=sites&limit=200${before ? `&before=${before}` : ''}`
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    })
    // Keep what it did hand over: a seed of the first few thousand sites is worth more than
    // an error, and the next run carries on from a fuller collection anyway.
    if (!response.ok) {
      if (found.size) break
      throw new Error(`nichedb ${url} answered HTTP ${response.status}${response.status === 402 && !options.key ? ' (metered: NICHEDB_API_KEY is not set)' : ''}`)
    }
    const body = (await response.json()) as { items?: Array<{ id: number; url?: string; tags?: string[] }> }
    const items = body.items ?? []
    if (!items.length) break
    for (const item of items) {
      const tagged = item.tags?.find((t) => t.startsWith('site:'))?.slice(5)
      const site = siteFromInput(tagged ?? item.url ?? '')
      if (site) found.add(site)
    }
    const last = items[items.length - 1]!.id
    if (!last || last === before) break
    before = last
  }
  return [...found].slice(0, limit)
}

/** The ring's members: ICANN hosts as they are, Moshpit names through their pit.world relay. */
export function sitesFromRing(): string[] {
  return RING.map((s) => (s.moshpit ? `${s.name}.pit.world` : s.name))
}

/** Directories whose whole list we publish as OPML: every site behind every feed. */
export const OPML_SOURCES: Record<string, string> = {
  rssamplifier: 'https://rssamplifier.com/opml',
  p0dcasters: 'https://p0dcasters.com/opml',
}

/**
 * The sites behind an OPML file's feeds. The site is the outline's htmlUrl (the
 * blog or the show's own page); the feed's xmlUrl is used only when there is no
 * htmlUrl, because feeds are often hosted elsewhere (Buzzsprout, Libsyn).
 */
export function sitesFromOpml(xml: string): string[] {
  const found = new Set<string>()
  for (const m of xml.matchAll(/<outline\b[^>]*>/g)) {
    const tag = m[0]
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1]?.replace(/&amp;/g, '&')
    const site = siteFromInput(attr('htmlUrl') || attr('xmlUrl') || '')
    if (site) found.add(site)
  }
  return [...found]
}

export async function opmlText(source: string, fetchImpl: Fetch = fetch): Promise<string> {
  const url = OPML_SOURCES[source] ?? source
  if (!/^https?:\/\//.test(url)) return Bun.file(url).text()
  const response = await fetchImpl(url, { headers: { accept: 'text/x-opml, application/xml;q=0.9, */*;q=0.1' }, signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  return response.text()
}

export function sitesFromText(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((t) => siteFromInput(t))
    .filter((s): s is string => Boolean(s))
}

/** c0upons.com's store list (public, keyless; c0upons.com redirects to the pwa host). */
export const C0UPONS_STORES = 'https://c0upons.pwa.pit.world/api/stores'

/**
 * Every shop c0upons.com lists: its `website`, or the domain c0upons built the
 * favicon URL from when the website is missing. Shops are what the product
 * graph needs: their product pages state prices in JSON-LD.
 */
export function sitesFromC0uponsStores(rows: unknown): string[] {
  const found = new Set<string>()
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = row as { website?: unknown; logo_url?: unknown }
    let site = typeof r.website === 'string' ? siteFromInput(r.website) : null
    if (!site && typeof r.logo_url === 'string') {
      try {
        const domain = new URL(r.logo_url).searchParams.get('domain')
        if (domain) site = siteFromInput(domain)
      } catch {}
    }
    if (site) found.add(site)
  }
  return [...found]
}

export async function sitesFromC0upons(fetchImpl: Fetch = fetch): Promise<string[]> {
  const response = await fetchImpl(C0UPONS_STORES, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${C0UPONS_STORES} answered HTTP ${response.status}`)
  return sitesFromC0uponsStores(await response.json())
}

/**
 * Wikidata classes whose members are shops (CC0): online shop, retail chain,
 * supermarket chain, department store chain, electronics retailer. Direct
 * instances only (wdt:P31, no subclass walk), so the query stays inside the
 * public endpoint's 60 s; about 4,000 with an official website (2026-11-14).
 */
export const SHOP_CLASSES = ['Q4382945', 'Q507619', 'Q18043413', 'Q2549179', 'Q76214980']

export function shopsSparql(classes = SHOP_CLASSES): string {
  return `SELECT DISTINCT ?w WHERE { VALUES ?c { ${classes.map((c) => `wd:${c}`).join(' ')} } ?s wdt:P31 ?c ; wdt:P856 ?w . }`
}

export function sitesFromSparql(body: unknown): string[] {
  const rows = (body as { results?: { bindings?: Array<{ w?: { value?: string } }> } })?.results?.bindings ?? []
  const found = new Set<string>()
  for (const b of rows) {
    const site = siteFromInput(b.w?.value ?? '')
    if (site) found.add(site)
  }
  return [...found]
}

export async function sitesFromWikidataShops(fetchImpl: Fetch = fetch): Promise<string[]> {
  const url = `https://query.wikidata.org/sparql?${new URLSearchParams({ query: shopsSparql() })}`
  const response = await fetchImpl(url, {
    // Wikidata asks every client for a descriptive User-Agent.
    headers: { accept: 'application/sparql-results+json', 'user-agent': 'pitbot/0.1 (+https://pit.world/bot)' },
    signal: AbortSignal.timeout(90_000),
  })
  if (!response.ok) throw new Error(`Wikidata SPARQL answered HTTP ${response.status}`)
  return sitesFromSparql(await response.json())
}

