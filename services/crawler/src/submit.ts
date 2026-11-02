/**
 * What people submit at pit.world/submit (Anthony 2026-11-02: "a promote submit site
 * (rss, link, sitemap.xml, et.al. types)", "multiple sites input form up to 1k").
 *
 * Anything goes in one list: a site, a page, a feed (RSS, Atom, JSON Feed), a
 * sitemap or sitemap index, an OPML file. The kind is guessed from the address for
 * the instant answer, then known for certain here, by reading it:
 *
 *   site     its home page, robots.txt and sitemaps, ahead of the queue
 *   page     read now (and its site scheduled)
 *   sitemap  every page it lists (nested sitemaps followed a level), and their sites
 *   feed     every item's link, and the feed is offered to rssamplifier.com too
 *   opml     every site behind every feed in it
 */
import { SUBMIT_MAX } from '../../../src/submit-kinds.ts'
import { normalizeUrl } from './url.ts'

export { guessKind, SUBMIT_MAX, type SubmitKind } from '../../../src/submit-kinds.ts'

/** What a fetched document is, by its first tags rather than its content type (servers lie). */
export function sniff(body: string, contentType = ''): 'sitemap' | 'feed' | 'opml' | 'html' | 'other' {
  const head = body.slice(0, 2_000).toLowerCase()
  if (/<urlset\b|<sitemapindex\b/.test(head)) return 'sitemap'
  if (/<opml\b/.test(head)) return 'opml'
  if (/<rss\b|<feed\b[^>]*xmlns|<rdf:rdf\b/.test(head)) return 'feed'
  if (/^\s*\{/.test(head) && /jsonfeed\.org\/version/.test(head)) return 'feed'
  if (/html/.test(contentType) || /<html\b|<!doctype html/.test(head)) return 'html'
  return 'other'
}

/** Item links of an RSS, Atom or JSON feed, resolved against the feed's address. */
export function feedLinks(body: string, base: string, max = SUBMIT_MAX): string[] {
  const out = new Set<string>()
  const add = (raw: string | undefined) => {
    if (!raw || out.size >= max) return
    const url = normalizeUrl(raw.replace(/&amp;/g, '&').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim(), base)
    if (url) out.add(url)
  }
  if (/^\s*\{/.test(body)) {
    try {
      const json = JSON.parse(body) as { items?: Array<{ url?: string; external_url?: string }> }
      for (const item of json.items ?? []) add(item.url ?? item.external_url)
    } catch {
      // not JSON after all
    }
    return [...out]
  }
  for (const item of body.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const block = item[0]
    const rssLink = block.match(/<link>([\s\S]*?)<\/link>/i)?.[1]
    const atomLink =
      block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
      block.match(/<link\b(?![^>]*rel=["'](?!alternate))[^>]*href=["']([^"']+)["']/i)?.[1]
    add(rssLink ?? atomLink ?? block.match(/<guid\b[^>]*isPermaLink=["']true["'][^>]*>([^<]+)</i)?.[1])
  }
  return [...out]
}
