/**
 * pit.world's sitemaps: /sitemap.xml is an index of child sitemaps, so the business listings (there can
 * be hundreds of thousands) fit under the 50,000-URL limit per file.
 *
 *   /sitemaps/pages.xml        the site's own pages and the *.pit.world directory
 *   /sitemaps/pros.xml         the business directory hubs: each category and its pages
 *   /sitemaps/listings-N.xml   every indexable /b/<domain> listing, LISTINGS_PER_SITEMAP each, with lastmod
 *   /sitemaps/results.xml      shared search results
 */

export const SITE = 'https://pit.world'
/** Listing URLs per child sitemap (the protocol allows 50,000). */
export const LISTINGS_PER_SITEMAP = 40_000

export type SitemapUrl = { loc: string; lastmod?: number | null }

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
/** W3C datetime, to the second. */
const w3c = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const lastmodTag = (ms: number | null | undefined) => (ms && ms > 0 ? `<lastmod>${w3c(ms)}</lastmod>` : '')

/** A child sitemap. Relative locs are made absolute on pit.world. */
export function urlset(urls: SitemapUrl[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((u) => `<url><loc>${xml(u.loc.startsWith('http') ? u.loc : `${SITE}${u.loc}`)}</loc>${lastmodTag(u.lastmod)}</url>`)
    .join('')}</urlset>`
}

/** The sitemap index. */
export function sitemapIndex(maps: SitemapUrl[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${maps
    .map((m) => `<sitemap><loc>${xml(m.loc.startsWith('http') ? m.loc : `${SITE}${m.loc}`)}</loc>${lastmodTag(m.lastmod)}</sitemap>`)
    .join('')}</sitemapindex>`
}

/** How many listing sitemaps `count` listings need (at least one, so the index never points nowhere). */
export const listingSitemapCount = (count: number) => Math.max(1, Math.ceil(count / LISTINGS_PER_SITEMAP))

/**
 * The /pros hub pages worth listing: /pros, each category with indexable listings, and that
 * category's later pages (?page=N) up to where its indexable listings end.
 */
export function prosHubPaths(indexableByCategory: Record<string, number>, perPage: number, maxPage: number, categories: string[]): string[] {
  const out = ['/pros']
  for (const slug of categories) {
    const n = indexableByCategory[slug] ?? 0
    if (!n) continue
    out.push(`/pros/${encodeURIComponent(slug)}`)
    const pages = Math.min(maxPage, Math.ceil(n / perPage))
    for (let page = 2; page <= pages; page++) out.push(`/pros/${encodeURIComponent(slug)}?page=${page}`)
  }
  return out
}

/** A small time-boxed cache: sitemaps are read by crawlers in bursts and rebuilt from SQL. */
export class SitemapCache {
  private store = new Map<string, { at: number; body: string }>()
  constructor(private ttlMs = 10 * 60_000, private now = () => Date.now()) {}
  get(key: string, build: () => string): string {
    const hit = this.store.get(key)
    if (hit && hit.at > this.now() - this.ttlMs) return hit.body
    const body = build()
    this.store.set(key, { at: this.now(), body })
    return body
  }
}
