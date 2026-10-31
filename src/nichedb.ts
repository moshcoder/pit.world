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

/** Query only the sites already in pit.world's directory and attach exact hostname matches. */
export async function enrichNicheDb(
  listings: Pick<Listings, 'directoryDomains' | 'enrichWebResearch' | 'needsWebResearchRefresh'>,
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
      const url = new URL(SEARCH)
      url.searchParams.set('q', domain)
      url.searchParams.set('collection', 'directory')
      url.searchParams.set('limit', '10')
      try {
        // threatcrush-disable-next-line js-ssrf-outbound-request  fixed NicheDB host; q is a validated directory hostname
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(12_000), headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`NicheDB returned ${response.status}`)
        const record = exactCompany(await response.json(), domain)
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
