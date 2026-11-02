/**
 * Where the first sites come from, the backfill: everything nichedb.dev
 * already keeps in /c/sites, the pit.world ring, a file, or names typed.
 * Each becomes a site job once per cycle; the crawl takes it from there.
 */
import { RING } from '../../../src/ring.ts'
import { siteFromInput } from './url.ts'

type Fetch = typeof fetch

/** Every distinct site nichedb's sites collection holds, newest pages first, up to `limit` sites. */
export async function sitesFromNichedb(nichedbUrl: string, options: { limit?: number; fetch?: Fetch; maxPages?: number } = {}): Promise<string[]> {
  const fetchImpl = options.fetch ?? fetch
  const limit = options.limit ?? 50_000
  const found = new Set<string>()
  let before = 0
  for (let page = 0; page < (options.maxPages ?? 2_000) && found.size < limit; page++) {
    const url = `${nichedbUrl}/api/v1/items?collection=sites&limit=200${before ? `&before=${before}` : ''}`
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`nichedb ${url} answered HTTP ${response.status}`)
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

export function sitesFromText(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((t) => siteFromInput(t))
    .filter((s): s is string => Boolean(s))
}
