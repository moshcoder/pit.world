import type { Listings, SeedInput } from './listings.js'

/** Sites explicitly submitted for the public professional directory, sourced from their own pages. */
export const PUBLIC_DIRECTORY_SEEDS: SeedInput[] = [
  {
    domain: 'trialstack.davidts.ai',
    name: 'Trial Stack AI',
    description: 'Tracks 200+ AI x Bio companies across drug discovery and development, mapped by what they do and the steps where they work.',
    category: 'software',
  },
]

/** Add submitted records once. A claimed or already listed page is left in its current state. */
export function ensurePublicDirectorySeeds(listings: Pick<Listings, 'toPublic' | 'seed'>): number {
  let added = 0
  for (const row of PUBLIC_DIRECTORY_SEEDS) {
    if (listings.toPublic(row.domain)) continue
    if (listings.seed(row)) added++
  }
  return added
}
