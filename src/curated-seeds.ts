/** One-time editorial listing imports, separate from owner-controlled listings.
 * Each domain is applied only once, so an operator can unseed it without it
 * reappearing at the next restart. Claiming always takes precedence.
 */
import { readFileSync } from 'node:fs'
import { normalizeDomain, type Listings, type SeedInput } from './listings.js'

export function readCuratedSeeds(file: URL): SeedInput[] {
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(data)) throw new Error('Curated business listings must be a JSON array')
  for (const entry of data) {
    const row = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
    if (!row || !normalizeDomain(row.domain) || typeof row.name !== 'string' || !row.name.trim()) {
      throw new Error('Invalid entry in curated business listings')
    }
  }
  return data as SeedInput[]
}

export function applyCuratedSeeds(listings: Listings, seeds: readonly SeedInput[]): number {
  listings.db.run('CREATE TABLE IF NOT EXISTS curated_seed_imports (domain TEXT PRIMARY KEY, processed_at INTEGER NOT NULL)')
  const seen = listings.db.query('SELECT 1 FROM curated_seed_imports WHERE domain = ?')
  let added = 0
  for (const item of seeds) {
    const domain = normalizeDomain(item.domain)
    if (!domain || !item.name?.trim()) throw new Error('Invalid curated business listing')
    if (seen.get(domain)) continue
    // A claimed or already-seeded listing is never overwritten by editorial data.
    const existing = listings.toPublic(domain)
    if (!existing) {
      const result = listings.seed(item)
      if (!result && !listings.claimedOnly(domain)) throw new Error('Could not seed listing: ' + domain)
      if (result) added++
    }
    // Keep this marker even when the listing is later removed with unseed.
    listings.db.run('INSERT OR IGNORE INTO curated_seed_imports (domain, processed_at) VALUES (?, ?)', [domain, Date.now()])
  }
  return added
}
