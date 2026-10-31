import type { Listings, SeedInput } from './listings.js'

/** Sites explicitly submitted for the public professional directory, sourced from their own pages. */
export const PUBLIC_DIRECTORY_SEEDS: SeedInput[] = [
  {
    domain: 'powellind.com',
    name: 'Powell Industries, Inc.',
    description: 'Houston-based manufacturer of engineered electrical power distribution and control systems, including switchgear, integrated power solutions, and services for industrial facilities and data centers.',
    phone: '713-944-6900',
    address: '8550 Mosley Road, Houston, TX 77075',
    category: 'industrial',
    area: 'United States and international markets',
    city: 'Houston',
    region: 'Texas',
    country: 'United States',
    services: [
      'Medium- and low-voltage switchgear',
      'Electrical power distribution systems',
      'Integrated electrical power solutions',
      'Data center and industrial electrical infrastructure',
      'Engineering, commissioning and maintenance',
    ],
    links: ['https://www.powellind.com/'],
  },
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
