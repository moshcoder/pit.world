import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { Votes } from '../src/votes'
import { MIN_PUBLIC_VOTES, VotePhrases, votablePhrase } from '../src/vote-phrases'

const NOW = Date.parse('2026-11-07T12:00:00Z')
const DAY = 86_400_000

describe('votablePhrase', () => {
  test('tidies a subject', () => {
    expect(votablePhrase('  Midterm   RESULTS ')).toBe('midterm results')
  })
  test('leaves out what looks like a person, a link or a lookup', () => {
    for (const q of ['me@example.com', 'https://a.example/x', 'example.com', 'call 4155550123', 'isbn:9780140328721', 'x']) {
      expect(votablePhrase(q)).toBeNull()
    }
  })
  test('leaves out a long paste', () => {
    expect(votablePhrase('one two three four five six seven eight nine')).toBeNull()
  })
})

describe('VotePhrases', () => {
  const fresh = (now = NOW) => new VotePhrases(new Database(':memory:'), () => now)

  test('stores a count and nothing that points at a voter', () => {
    const phrases = fresh()
    phrases.record('blue wave')
    const cols = (phrases.db.query('PRAGMA table_info(vote_phrases)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toEqual(['day', 'phrase', 'votes'])
  })

  test('one person is never published', () => {
    const phrases = fresh()
    for (let i = 1; i < MIN_PUBLIC_VOTES; i++) phrases.record('my private worry')
    expect(phrases.top()).toEqual([])
    phrases.record('my private worry')
    expect(phrases.top()).toEqual([{ phrase: 'my private worry', votes: MIN_PUBLIC_VOTES, prior_votes: 0 }])
  })

  test('this week is set against the week before', () => {
    const db = new Database(':memory:')
    const earlier = new VotePhrases(db, () => NOW - 8 * DAY)
    earlier.record('blue wave')
    const later = new VotePhrases(db, () => NOW)
    for (let i = 0; i < 3; i++) later.record('blue wave')
    expect(later.top()[0]).toEqual({ phrase: 'blue wave', votes: 3, prior_votes: 1 })
  })

  test('old days are dropped', () => {
    const db = new Database(':memory:')
    new VotePhrases(db, () => NOW - 100 * DAY).record('long gone')
    new VotePhrases(db, () => NOW).record('today')
    expect(db.query('SELECT COUNT(*) AS n FROM vote_phrases').get()).toEqual({ n: 1 })
  })
})

describe('Votes.cast', () => {
  const item = { kind: 'result' as const, item: 'result:a.example/', domain: 'a.example' }
  const other = { kind: 'result' as const, item: 'result:b.example/', domain: 'b.example' }

  test('a device counts once for a search, however it votes', () => {
    const votes = new Votes(new Database(':memory:'), 'secret')
    const vote = (target: typeof item, value: number, visitor = 'v1') =>
      votes.cast({ visitor, ...target, value, query: 'blue wave' }).firstOnSearch
    expect(vote(item, 1)).toBe(true)
    expect(vote(item, -1)).toBe(false)
    expect(vote(other, 1)).toBe(false)
    expect(vote(item, 1, 'v2')).toBe(true)
  })

  test('taking a vote back is not a vote', () => {
    const votes = new Votes(new Database(':memory:'), 'secret')
    expect(votes.cast({ visitor: 'v1', ...item, value: 0, query: 'blue wave' }).firstOnSearch).toBe(false)
  })
})
