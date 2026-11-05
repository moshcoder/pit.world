/**
 * Where the first sites come from, the backfill: everything nichedb.dev
 * already keeps in /c/sites, the pit.world ring, a file, or names typed.
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
