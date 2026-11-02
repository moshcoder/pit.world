/**
 * What a submitted address looks like, from its spelling alone: the instant answer on
 * pit.world/submit. The crawler (services/crawler/src/submit.ts) reads each one and
 * acts on what it really is; this is shared so both say the same thing.
 */
import { isBlockedAddress, isInternalName, isIPv4, isIPv6 } from '@profullstack/submit-feed/core'

export type SubmitKind = 'site' | 'page' | 'feed' | 'sitemap' | 'opml'

export const SUBMIT_MAX = 1_000

export const KIND_LABELS: Record<SubmitKind, string> = {
  site: 'Site',
  page: 'Page',
  feed: 'Feed',
  sitemap: 'Sitemap',
  opml: 'OPML',
}

export function guessKind(url: string): SubmitKind {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'page'
  }
  const path = u.pathname.toLowerCase()
  if ((path === '/' || path === '') && !u.search) return 'site'
  if (/\.opml$/.test(path)) return 'opml'
  if (/sitemap[^/]*\.xml(\.gz)?$|\/sitemap\/?$/.test(path)) return 'sitemap'
  if (/(\/feed\/?|\/rss\/?|\/atom\/?|\.rss|\.atom|(rss|atom|feed|index)\.xml|feed\.json|\.rss\.xml)$/.test(path) || u.searchParams.has('feed') || u.searchParams.get('format') === 'rss') return 'feed'
  return 'page'
}

/** Private by spelling: loopback, private and link-local numbers, internal names. DNS is the crawler's check. */
export function privateBySpelling(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return true
  }
  if (isIPv4(host) || isIPv6(host)) return isBlockedAddress(host)
  return host === 'localhost' || host.endsWith('.localhost') || isInternalName(host) || !host.includes('.')
}
