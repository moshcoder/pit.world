/** Enrich existing pit.world directory entries from NicheDB's public OutreachGraph mirror. */
import type { Listings } from './listings.js'
import { normalizeDomain } from './listings.js'

const SEARCH = 'https://nichedb.dev/api/v1/search'
type JsonFetch = (input: URL, init?: RequestInit) => Promise<Response>

type NicheItem = {
  kind?: unknown
  url?: unknown
  page?: unknown
  data?: { row?: { kind?: unknown; topics?: unknown } }
}

function exactCompany(payload: unknown, domain: string): { topics: string[]; sourceUrl: string } | null {
  const items = (payload as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return null
  for (const item of items as NicheItem[]) {
    if (item.kind !== 'company' || item.data?.row?.kind !== 'company') continue
    if (normalizeDomain(typeof item.url === 'string' ? item.url : '') !== domain) continue
    let sourceUrl = ''
    try {
      const url = new URL(String(item.page ?? ''))
      if (url.protocol === 'https:' && url.hostname === 'nichedb.dev' && /^\/i\/\d+$/.test(url.pathname)) sourceUrl = url.href
    } catch {}
    if (!sourceUrl) continue
    const topics = Array.isArray(item.data?.row?.topics)
      ? item.data.row.topics.filter((topic): topic is string => typeof topic === 'string')
      : []
    return { topics, sourceUrl }
  }
  return null
}

/**
 * The hostnames OutreachGraph (and so NicheDB) may file a pit.world listing under, best first.
 * OutreachGraph's pit-world lead source keys a Moshpit-only name by its relay host
 * `<name>.pit.world`, and every other site by its registrable domain, so a listing on a
 * subdomain (trialstack.davidts.ai) is the company at davidts.ai. The listing's own hostname
 * is always tried first; the parent is only a fallback, and never a bare public suffix.
 */
export function directoryKeys(domain: string, moshpitOnly = false): string[] {
  const keys = [domain]
  if (moshpitOnly && !domain.endsWith('.pit.world')) keys.push(`${domain}.pit.world`)
  else if (!domain.endsWith('.pit.world')) {
    const labels = domain.split('.')
    if (labels.length >= 3) {
      const parent = labels.slice(-2)
      // co.uk, com.au, org.br ...: a two-letter TLD under a short second level is a suffix, not a company.
      const suffixLike = parent[1]!.length === 2 && parent[0]!.length <= 3
      const host = (suffixLike ? labels.slice(-3) : parent).join('.')
      if (host !== domain) keys.push(host)
    }
  }
  return keys
}

/** Query only the sites already in pit.world's directory and attach exact hostname matches. */
export async function enrichNicheDb(
  listings: Pick<Listings, 'directoryDomains' | 'enrichWebResearch' | 'needsWebResearchRefresh'> & Partial<Pick<Listings, 'toPublic'>>,
  fetchImpl: JsonFetch = fetch,
  concurrency = 4,
  force = false,
): Promise<{ checked: number; matched: number; unmatched: number; failed: number }> {
  const domains = listings.directoryDomains().filter((domain) => force || listings.needsWebResearchRefresh(domain))
  let cursor = 0
  let matched = 0
  let unmatched = 0
  let failed = 0
  const workers = Array.from({ length: Math.max(1, Math.min(8, Math.trunc(concurrency) || 1)) }, async () => {
    while (true) {
      const index = cursor++
      const domain = domains[index]
      if (!domain) return
      try {
        let record: { topics: string[]; sourceUrl: string } | null = null
        for (const key of directoryKeys(domain, Boolean(listings.toPublic?.(domain)?.moshpitOnly))) {
          const url = new URL(SEARCH)
          url.searchParams.set('q', key)
          url.searchParams.set('collection', 'directory')
          url.searchParams.set('limit', '10')
          // A cold NicheDB search over the directory takes ~10 s; 12 s timed out a few listings every run.
          // threatcrush-disable-next-line js-ssrf-outbound-request  fixed NicheDB host; q is a validated directory hostname
          const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`NicheDB returned ${response.status}`)
          record = exactCompany(await response.json(), key)
          if (record) break
        }
        if (record && listings.enrichWebResearch(domain, { topics: record.topics, sourceUrl: record.sourceUrl })) matched++
        else unmatched++
      } catch {
        failed++
      }
    }
  })
  await Promise.all(workers)
  return { checked: domains.length, matched, unmatched, failed }
}
