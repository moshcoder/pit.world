/** Refresh only existing unclaimed directory companies from their own homepage.
 * Uses Listings' SSRF-checked verifier, bounded concurrency, and a 24h TTL.
 * No people scraping or unsolicited outreach.
 */
import type { Listings } from './listings.js'
import { parseCompanyHomepage } from './company-metadata.js'

export async function enrichOfficialCompanySites(
  listings: Pick<Listings, 'directoryDomains' | 'toPublic' | 'needsCompanyMetadataRefresh' | 'companyHomepage' | 'setCompanyMetadata'>,
  concurrency = 3,
): Promise<{ checked: number; enriched: number; failed: number }> {
  const domains = listings.directoryDomains().filter(d => listings.toPublic(d)?.seeded && listings.needsCompanyMetadataRefresh(d))
  let next = 0, enriched = 0, failed = 0
  const workers = Array.from({length: Math.min(4, Math.max(1, Math.trunc(concurrency) || 1))}, async () => {
    while (next < domains.length) {
      const domain = domains[next++]
      if (!domain) return
      try {
        const html = await listings.companyHomepage(domain)
        if (html === null) { failed++; continue }
        const facts = parseCompanyHomepage(html, domain)
        if (facts && listings.setCompanyMetadata(domain, facts)) enriched++
      } catch { failed++ }
    }
  })
  await Promise.all(workers)
  return { checked: domains.length, enriched, failed }
}
