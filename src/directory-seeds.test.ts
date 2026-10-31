import { describe, expect, test } from 'bun:test'
import { Listings } from './listings.js'
import { ensurePublicDirectorySeeds, PUBLIC_DIRECTORY_SEEDS } from './directory-seeds.js'

describe('public directory seeds', () => {
  test('includes Powell Industries and retains existing entries', () => {
    expect(PUBLIC_DIRECTORY_SEEDS.some((s) => s.domain === 'trialstack.davidts.ai')).toBe(true)
    const powell = PUBLIC_DIRECTORY_SEEDS.find((s) => s.domain === 'powellind.com')
    expect(powell?.name).toBe('Powell Industries, Inc.')
    expect(powell?.category).toBe('industrial')
    expect(powell?.links).toContain('https://www.powellind.com/')
  })

  test('seeds listings as unclaimed and does not overwrite existing records', () => {
    const listings = new Listings(':memory:')
    expect(ensurePublicDirectorySeeds(listings)).toBeGreaterThanOrEqual(2)
    const powell = listings.toPublic('powellind.com')
    expect(powell?.seeded).toBe(true)
    expect(powell?.claimed).toBe(false)
    expect(powell?.category).toBe('industrial')
    expect(ensurePublicDirectorySeeds(listings)).toBe(0)
  })
})
