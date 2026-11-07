import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Votes } from '../src/votes.ts'
import { DAILY_CAP, VoteRewards } from '../src/vote-rewards.ts'

const item = (i: number) => `result:site${i}.example/page`

const votes = () => new Votes(new Database(':memory:'), 's')

describe('Votes: the words they were cast on', () => {
  test('a signed-in vote keeps its search phrase, for its owner', () => {
    const v = votes()
    v.cast({ visitor: 'dev1', kind: 'result', item: item(1), domain: 'site1.example', value: 1, query: 'best films', account: 'acct-1' })
    v.cast({ visitor: 'dev1', kind: 'ad', item: 'ad:web:top-1', domain: '', value: 1, query: 'best films', account: 'acct-1' })
    expect(v.history('acct-1').map((r) => r.phrase)).toEqual(['best films', 'best films'])
  })
  test('a signed-out vote stores no words', () => {
    const v = votes()
    v.cast({ visitor: 'dev2', kind: 'result', item: item(2), domain: 'site2.example', value: 1, query: 'private words' })
    const rows = (v as any).db.query('SELECT phrase, qkey FROM votes').all() as Array<{ phrase: string; qkey: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.phrase).toBe('')
    expect(rows[0]!.qkey).not.toBe('')
  })
  test('undo deletes the words with the vote', () => {
    const v = votes()
    const { qkey } = v.cast({ visitor: 'dev1', kind: 'result', item: item(3), domain: 'site3.example', value: 1, query: 'gone soon', account: 'acct-1' })
    v.undo('acct-1', item(3), qkey)
    expect(((v as any).db.query('SELECT COUNT(*) AS n FROM votes').get() as { n: number }).n).toBe(0)
  })
})

describe('Votes: account history and undo', () => {
  test('signed-in votes show in history, anonymous ones do not', () => {
    const v = new Votes(new Database(':memory:'), 's')
    v.cast({ visitor: 'dev1', kind: 'result', item: item(1), domain: 'site1.example', value: -1, query: 'films', account: 'acct-1' })
    v.cast({ visitor: 'dev2', kind: 'result', item: item(2), domain: 'site2.example', value: 1, query: 'films' })
    const h = v.history('acct-1')
    expect(h).toHaveLength(1)
    expect(h[0]!.target).toBe('site1.example/page')
    expect(h[0]!.value).toBe(-1)
    expect(h[0]!.qkey).not.toBe('')
    expect(v.history('')).toHaveLength(0)
    expect(v.countFor('acct-1')).toBe(1)
  })

  test('undo from history removes the vote from the tally on every device of the account', () => {
    const v = new Votes(new Database(':memory:'), 's')
    const a = v.cast({ visitor: 'phone', kind: 'result', item: item(1), domain: 'site1.example', value: -1, query: 'q', account: 'acct-1' })
    v.cast({ visitor: 'laptop', kind: 'result', item: item(1), domain: 'site1.example', value: -1, query: 'q', account: 'acct-1' })
    expect(v.tally(item(1), 'q').down).toBe(2)
    expect(v.undo('acct-1', item(1), a.qkey)).toBe(true)
    expect(v.tally(item(1), 'q').down).toBe(0)
    expect(v.undo('acct-1', item(1), a.qkey)).toBe(false)
  })

  test('a vote taken back while signed in clears it everywhere', () => {
    const v = new Votes(new Database(':memory:'), 's')
    v.cast({ visitor: 'phone', kind: 'listing', item: 'listing:acme.example', domain: 'acme.example', value: 1, account: 'acct-1' })
    v.cast({ visitor: 'laptop', kind: 'listing', item: 'listing:acme.example', domain: 'acme.example', value: 1, account: 'acct-1' })
    v.cast({ visitor: 'laptop', kind: 'listing', item: 'listing:acme.example', domain: 'acme.example', value: 0, account: 'acct-1' })
    expect(v.tally('listing:acme.example').up).toBe(0)
  })

  test('an anonymous re-vote keeps the account the vote was cast with', () => {
    const v = new Votes(new Database(':memory:'), 's')
    v.cast({ visitor: 'dev1', kind: 'listing', item: 'listing:acme.example', domain: 'acme.example', value: 1, account: 'acct-1' })
    v.cast({ visitor: 'dev1', kind: 'listing', item: 'listing:acme.example', domain: 'acme.example', value: -1 })
    expect(v.history('acct-1')[0]!.value).toBe(-1)
  })
})

describe('VoteRewards: points that cannot be farmed', () => {
  test('one point per distinct item, none for anonymous or repeat votes', () => {
    const r = new VoteRewards(new Database(':memory:'))
    expect(r.onVote(null, item(1), 'q', 1)).toBe(0)
    expect(r.onVote('a', item(1), 'q', 1)).toBe(1)
    expect(r.onVote('a', item(1), 'q', -1)).toBe(0)
    expect(r.onVote('a', item(1), 'other-search', 1)).toBe(1)
    expect(r.summary('a').points).toBe(2)
  })

  test('taking a vote back the same day takes the point back; toggling earns nothing', () => {
    const r = new VoteRewards(new Database(':memory:'))
    for (let i = 0; i < 10; i++) {
      r.onVote('a', item(1), 'q', 1)
      r.onVote('a', item(1), 'q', 0)
    }
    expect(r.summary('a').points).toBe(0)
  })

  test('a vote taken back on a later day keeps its point', () => {
    let now = Date.parse('2026-11-02T12:00:00Z')
    const r = new VoteRewards(new Database(':memory:'), { now: () => now })
    r.onVote('a', item(1), 'q', -1)
    now += 2 * 86_400_000
    expect(r.onVote('a', item(1), 'q', 0)).toBe(0)
    expect(r.summary('a').points).toBe(1)
  })

  test('daily cap', () => {
    const r = new VoteRewards(new Database(':memory:'))
    for (let i = 0; i < DAILY_CAP + 10; i++) r.onVote('a', item(i), '', 1)
    expect(r.summary('a')).toMatchObject({ points: DAILY_CAP, today: DAILY_CAP })
  })

  test('no rate means no dollar figure; with a rate, unpaid USD and markPaid', () => {
    const db = new Database(':memory:')
    expect(new VoteRewards(db).summary('a').unpaidUsd).toBeNull()
    const r = new VoteRewards(db, { usdPerPoint: 0.01 })
    for (let i = 0; i < 5; i++) r.onVote('a', item(i), '', 1)
    expect(r.summary('a').unpaidUsd).toBe(0.05)
    expect(r.balances()[0]).toMatchObject({ account: 'a', unpaid: 5 })
    expect(r.markPaid('a')).toBe(5)
    expect(r.summary('a')).toMatchObject({ paid: 5, unpaid: 0 })
    // Paid points are never clawed back by an undo.
    expect(r.onVote('a', item(0), '', 0)).toBe(0)
  })
})
