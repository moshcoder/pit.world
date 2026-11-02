import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readPageChecked, Summarizer } from '../src/summarize.ts'
import { HALF_LIFE_MS, HEALTH_WEIGHT, ReaderHealth, domainOf } from '../src/reader-health.ts'
import { MAX_MOVE, Votes } from '../src/votes.ts'

const resolve = async () => ['93.184.216.34']
const RELAY = 'https://relay.example/mcp'
const PAGE = 'A real page with plenty of words in it. '.repeat(10)

/** A relay and a site, each scripted. relay: 'ok' | 'wall' | 'tool-error' | 'down'; site: an HTTP status or 'wall' or 'throw'. */
function world(relay: 'ok' | 'wall' | 'tool-error' | 'down', site: number | 'wall' | 'throw') {
  return (async (url: string | URL | Request) => {
    const u = String(url)
    if (u === RELAY) {
      if (relay === 'down') return new Response('bad gateway', { status: 502 })
      if (relay === 'tool-error') return Response.json({ result: { isError: true, content: [{ type: 'text', text: 'navigation failed' }] } })
      const text = relay === 'wall' ? 'Just a moment... verifying you are human' : PAGE
      return Response.json({ result: { content: [{ type: 'text', text }] } })
    }
    if (site === 'throw') throw new TypeError('fetch failed')
    if (site === 'wall') return new Response('<html><body>Attention Required! | Cloudflare</body></html>', { headers: { 'content-type': 'text/html' } })
    return new Response(site === 200 ? `<html><body><p>${PAGE}</p></body></html>` : 'no', { status: site, headers: { 'content-type': 'text/html' } })
  }) as typeof fetch
}

const read = (relay: Parameters<typeof world>[0], site: Parameters<typeof world>[1]) =>
  readPageChecked('https://site.example/page', { relayUrl: RELAY, fetch: world(relay, site), resolve })

describe('readPageChecked: only the site refusing counts as blocked', () => {
  test('relay reads it: ok', async () => {
    expect((await read('ok', 403)).state).toBe('ok')
  })
  test('relay hits a bot wall, site refuses directly: blocked', async () => {
    expect((await read('wall', 403)).state).toBe('blocked')
    expect((await read('tool-error', 'wall')).state).toBe('blocked')
    expect((await read('wall', 'throw')).state).toBe('blocked')
  })
  test('relay walled but the direct fetch reads it: ok', async () => {
    expect((await read('wall', 200)).state).toBe('ok')
  })
  test('relay down: never blocked, even if the direct fetch is refused', async () => {
    expect((await read('down', 403)).state).toBe('down')
    expect((await read('down', 'throw')).state).toBe('down')
  })
  test('a private address is private, not blocked', async () => {
    const r = await readPageChecked('http://intranet.example/', { relayUrl: RELAY, fetch: world('wall', 403), resolve: async () => ['10.0.0.5'] })
    expect(r.state).toBe('private')
  })
  test('relay switched off: the direct fetch alone decides', async () => {
    const r = await readPageChecked('https://site.example/', { relayUrl: '', fetch: world('down', 403), resolve })
    expect(r.state).toBe('blocked')
  })
})

describe('ReaderHealth', () => {
  test('ignores down and private reads', () => {
    const h = new ReaderHealth(new Database(':memory:'))
    h.record('https://imdb.com/title/tt1', 'down')
    h.record('https://imdb.com/title/tt1', 'private')
    expect(h.get('imdb.com')).toBeNull()
  })

  test('one blocked read pushes the domain down at once; www and paths share a domain', () => {
    const h = new ReaderHealth(new Database(':memory:'))
    h.record('https://www.imdb.com/title/tt1', 'blocked')
    const move = h.moves(['imdb.com']).get('imdb.com')!
    expect(move).toBeLessThan(-1)
    expect(move).toBeGreaterThanOrEqual(-HEALTH_WEIGHT)
    expect(h.blocks(h.get('imdb.com'))).toBe(false)
    h.record('https://imdb.com/title/tt2', 'blocked')
    expect(h.blocks(h.get('imdb.com'))).toBe(true)
  })

  test('good reads pull it back, and old refusals fade', () => {
    let now = 1_000_000
    const h = new ReaderHealth(new Database(':memory:'), () => now)
    h.record('https://imdb.com/a', 'blocked')
    h.record('https://imdb.com/b', 'blocked')
    const before = h.get('imdb.com')!.share
    h.record('https://imdb.com/c', 'ok')
    expect(h.get('imdb.com')!.share).toBeLessThan(before)
    now += 4 * HALF_LIFE_MS
    expect(h.get('imdb.com')!.blocked).toBeLessThan(0.2)
  })

  test('domainOf matches how votes count a domain', () => {
    expect(domainOf('https://www.IMDB.com/title/x?y=1')).toBe('imdb.com')
    expect(domainOf('ftp://x.com/')).toBeNull()
  })
})

describe('ranking: reader health is a bounded term, separate from votes', () => {
  const hits = ['https://a.example/1', 'https://imdb.com/title/tt1', 'https://c.example/1', 'https://d.example/1', 'https://e.example/1'].map((url) => ({ url }))

  test('a site that blocks readers moves down, by at most MAX_MOVE, with no votes cast', () => {
    const db = new Database(':memory:')
    const votes = new Votes(db, 'secret')
    votes.health = new ReaderHealth(db)
    for (let i = 0; i < 20; i++) votes.health.record(`https://imdb.com/title/tt${i}`, 'blocked')
    const out = votes.rerank(hits, 'some film').map((h) => h.url)
    const at = out.indexOf('https://imdb.com/title/tt1')
    expect(at).toBeGreaterThan(1)
    expect(at - 1).toBeLessThanOrEqual(MAX_MOVE)
    // No human tally was touched.
    expect(votes.totals().votes).toBe(0)
  })

  test('human upvotes still count against it', () => {
    const db = new Database(':memory:')
    const votes = new Votes(db, 'secret')
    votes.health = new ReaderHealth(db)
    votes.health.record('https://imdb.com/title/tt1', 'blocked')
    const down = votes.nudges(['https://imdb.com/title/tt1'], 'q').get('https://imdb.com/title/tt1')!
    for (let i = 0; i < 8; i++)
      votes.cast({ visitor: `v${i}`, kind: 'result', item: 'result:imdb.com/title/tt1', domain: 'imdb.com', value: 1, query: 'q' })
    const after = votes.nudges(['https://imdb.com/title/tt1'], 'q').get('https://imdb.com/title/tt1') ?? 0
    expect(after).toBeGreaterThan(down)
  })
})

describe('Summarizer reports every page read', () => {
  test('observeReads sees the verdict', async () => {
    const seen: string[] = []
    const s = new Summarizer({ pageRelayUrl: RELAY, fetch: world('wall', 403) })
    s.observeReads((url, state) => seen.push(`${new URL(url).hostname}:${state}`))
    // resolve is not injectable through Summarizer; site.example resolves nowhere, so expect private or blocked, never ok.
    await s.pageText('https://site.example/x')
    expect(seen.length).toBe(1)
    expect(seen[0]).not.toContain(':ok')
  })
})
