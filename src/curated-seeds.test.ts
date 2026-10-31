import { expect, test } from 'bun:test'
import { Listings, type SeedInput } from './listings.js'
import { applyCuratedSeeds, readCuratedSeeds } from './curated-seeds.js'

const item: SeedInput = { domain: 'example-industrial.com', name: 'Example Industrial', category: 'industrial', services: ['Switchgear'] }

test('editorial listing is seeded once, unclaimed, and not reinserted after unseed', () => {
  const store = new Listings(':memory:')
  expect(applyCuratedSeeds(store, [item])).toBe(1)
  expect(store.toPublic(item.domain)?.seeded).toBe(true)
  expect(store.toPublic(item.domain)?.category).toBe('industrial')
  expect(applyCuratedSeeds(store, [item])).toBe(0)
  expect(store.unseed(item.domain)).toBe(true)
  expect(applyCuratedSeeds(store, [item])).toBe(0)
  expect(store.toPublic(item.domain)).toBeNull()
})

test('Powell listing is valid editorial seed data', () => {
  const seeds = readCuratedSeeds(new URL('../data/curated-listings.json', import.meta.url))
  const powell = seeds.find((x) => x.domain === 'powellind.com')
  expect(powell?.name).toBe('Powell Industries, Inc.')
  expect(powell?.featured).toBe(0)
  const store = new Listings(':memory:')
  expect(applyCuratedSeeds(store, seeds)).toBeGreaterThan(0)
  expect(store.toPublic('powellind.com')?.seeded).toBe(true)
})
