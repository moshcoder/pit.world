import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ENGAGE_PRIOR, ENGAGE_WEIGHT, Engagement } from '../src/engagement.ts'
import { HALF_LIFE_MS, ReaderHealth } from '../src/reader-health.ts'
import { MAX_MOVE, Votes } from '../src/votes.ts'

const DAY = 24 * 3600_000
const URL_A = 'https://www.good.example/a'

function setup() {
  let at = 1_800_000_000_000
  const db = new Database(':memory:')
  const engagement = new Engagement(db, 'test-secret', () => at)
  return { db, engagement, advance: (ms: number) => (at += ms) }
}

describe('Engagement', () => {
  test('one person counts once per domain per day, however many pages they read', () => {
    const { engagement, advance } = setup()
    expect(engagement.record(URL_A, 'alice')).toBe(true)
    expect(engagement.record(URL_A, 'alice')).toBe(false)
    expect(engagement.record('https://good.example/other', 'alice')).toBe(false)
    expect(engagement.record(URL_A, 'bob')).toBe(true)
    advance(DAY + 1)
    expect(engagement.record(URL_A, 'alice')).toBe(true)
  })

  test('the move grows with people and never reaches the weight', () => {
    const { engagement } = setup()
    for (let i = 0; i < ENGAGE_PRIOR; i++) engagement.record(URL_A, `p${i}`)
    expect(engagement.moves(['good.example']).get('good.example')).toBeCloseTo(ENGAGE_WEIGHT / 2)
    for (let i = 0; i < 500; i++) engagement.record(URL_A, `q${i}`)
    const move = engagement.moves(['good.example']).get('good.example')!
    expect(move).toBeGreaterThan(ENGAGE_WEIGHT * 0.9)
    expect(move).toBeLessThan(ENGAGE_WEIGHT)
  })

  test('old attention fades', () => {
    const { engagement, advance } = setup()
    for (let i = 0; i < 5; i++) engagement.record(URL_A, `p${i}`)
    const before = engagement.moves(['good.example']).get('good.example')!
    advance(HALF_LIFE_MS)
    expect(engagement.moves(['good.example']).get('good.example')!).toBeLessThan(before)
  })

  test('remembers no person and no page', () => {
    const { db, engagement } = setup()
    engagement.record(URL_A, 'alice')
    const rows = JSON.stringify(db.query('SELECT * FROM reader_engagement_seen').all())
    expect(rows).not.toContain('alice')
    expect(rows).not.toContain('good.example')
  })

  test('an address that is not a web page does not count', () => {
    const { engagement } = setup()
    expect(engagement.record('not a url', 'alice')).toBe(false)
    expect(engagement.record(URL_A, '')).toBe(false)
  })
})

describe('the ranking', () => {
  function ranked() {
    const { db, engagement } = setup()
    const votes = new Votes(db, 'test-secret')
    votes.health = new ReaderHealth(db)
    votes.engagement = engagement
    return { votes, engagement }
  }

  test('a used site climbs a result list, with no vote cast', () => {
    const { votes, engagement } = ranked()
    for (let i = 0; i < 40; i++) engagement.record(URL_A, `p${i}`)
    const hits = [{ url: 'https://one.example/' }, { url: 'https://two.example/' }, { url: URL_A }]
    // Forty people earn 1.78 places: third to second, not first.
    expect(votes.rerank(hits, 'q').map((h) => h.url)).toEqual(['https://one.example/', URL_A, 'https://two.example/'])
    expect(votes.tally('result:good.example/a').up).toBe(0)
  })

  test('listings move on use, and a site that refuses readers still loses', () => {
    const { votes, engagement } = ranked()
    for (let i = 0; i < 40; i++) engagement.record(URL_A, `p${i}`)
    expect(votes.listingMoves(['good.example']).get('good.example')!).toBeGreaterThan(1)
    for (let i = 0; i < 30; i++) votes.health!.record('https://walled.example/', 'blocked')
    expect(votes.listingMoves(['walled.example']).get('walled.example')!).toBeLessThan(-1)
  })

  test('use and votes together stay inside MAX_MOVE', () => {
    const { votes, engagement } = ranked()
    for (let i = 0; i < 400; i++) engagement.record(URL_A, `p${i}`)
    for (let i = 0; i < 200; i++) votes.cast({ visitor: `v${i}`, kind: 'listing', item: 'listing:good.example', domain: 'good.example', value: 1 })
    expect(votes.listingMoves(['good.example']).get('good.example')).toBe(MAX_MOVE)
  })
})
