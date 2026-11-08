/**
 * The Redis frontier and the BullMQ wiring against a real Redis, and the
 * Obscura client against a real Obscura. Each part runs only when its
 * server is named, so `bun test` on a laptop passes without either:
 *
 *   CRAWL_TEST_REDIS=redis://127.0.0.1:6399/15 OBSCURA_TEST_URL=http://127.0.0.1:3301/mcp OBSCURA_TEST_TOKEN=… bun test
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { configFromEnv } from '../src/config.ts'
import { extract } from '../src/extract.ts'
import { RedisFrontier } from '../src/frontier.ts'
import { ObscuraClient } from '../src/obscura.ts'
import { connect, createRuntime, feedParked, migrateSitesFromRedis, publishSiteCounts, snapshot } from '../src/queues.ts'
import { PgSiteStore } from '../src/site-store.ts'

const REDIS = process.env.CRAWL_TEST_REDIS
const OBSCURA = process.env.OBSCURA_TEST_URL

describe.skipIf(!REDIS)('on a real Redis', () => {
  const redis = connect(REDIS ?? 'redis://127.0.0.1:1')
  afterAll(async () => {
    await redis.flushdb()
    redis.disconnect()
  })

  test('admission is exact under a race, and the cap holds', async () => {
    await redis.flushdb()
    const frontier = new RedisFrontier(redis, 5, 60_000)
    const urls = Array.from({ length: 20 }, (_, i) => `https://race.example/${i % 8}`)
    const verdicts = await Promise.all(urls.map((u) => frontier.admit('race.example', u)))
    expect(verdicts.filter((v) => v === 'new').length).toBe(5)
    expect(verdicts.filter((v) => v === 'full').length).toBe(3)
    expect(await redis.pttl('pitcrawl:seen:race.example')).toBeGreaterThan(0)
    // Sliding: every new page pushes the expiry out again.
    await redis.pexpire('pitcrawl:seen:race.example', 1_000)
    await frontier.admit('race.example', 'https://race.example/new')
    expect(await redis.pttl('pitcrawl:seen:race.example')).toBeGreaterThan(50_000)
  })

  test('the site lease spaces requests', async () => {
    const frontier = new RedisFrontier(redis, 5, 60_000)
    for (let i = 0; i < 4; i++) await frontier.admit('slow.example', `https://slow.example/${i}`)
    expect(await frontier.lease('slow.example', 2_000)).toEqual({ waitMs: 0, pending: 0 })
    const busy = await frontier.lease('slow.example', 2_000)
    expect(busy.waitMs).toBeGreaterThan(1_000)
    // Four admitted, one fetched: three still waiting for their turn.
    expect(busy.pending).toBe(3)
  })

  test('counters land in the hour and the day; the log is newest first and bounded', async () => {
    await redis.flushdb()
    const frontier = new RedisFrontier(redis, 5, 60_000)
    await frontier.bump('pages_indexed', 3)
    await frontier.bump('pages_indexed')
    const activity = await frontier.activity()
    expect(activity.lastHour.pages_indexed).toBe(4)
    expect(activity.lastDay.pages_indexed).toBe(4)
    expect(activity.hours).toHaveLength(24)
    expect(activity.hours.at(-1)!.counts.pages_indexed).toBe(4)
    for (let i = 0; i < 205; i++) await frontier.log({ kind: 'page', note: String(i) })
    const recent = await frontier.recent(500)
    expect(recent).toHaveLength(200)
    expect(recent[0]!.note).toBe('204')
  })

  test('the outbox keeps order through a give-back and is bounded', async () => {
    const frontier = new RedisFrontier(redis, 5, 60_000)
    await frontier.push([1, 2, 3, 4], 3)
    const taken = await frontier.take(2)
    expect(taken).toEqual(['2', '3'])
    await frontier.giveBack(taken)
    expect(await frontier.take(10)).toEqual(['2', '3', '4'])
  })

  test('queues: page jobs dedupe by address and carry depth as priority; stats answer', async () => {
    await redis.flushdb()
    const runtime = createRuntime(configFromEnv({ CRAWL_REDIS_URL: REDIS }), () => {})
    try {
      expect(await runtime.crawler.scheduleSites(['queue.example'], 'test')).toEqual({ queued: 1, refused: 0 })
      const page = { url: 'https://queue.example/', site: 'queue.example', depth: 0 }
      const enqueue = runtime.queues.page
      await enqueue.addBulk([{ name: 'page', data: page, opts: { jobId: 'p-x', priority: 1 } }])
      await enqueue.addBulk([{ name: 'page', data: page, opts: { jobId: 'p-x', priority: 1 } }])
      // The site gate copies the frontier's size into the Redis stats every 30 s.
      await publishSiteCounts(runtime)
      const snap = await snapshot(runtime)
      expect(snap.queues.site?.waiting).toBe(1)
      expect(snap.queues.page?.prioritized).toBe(1)
      expect(snap.stats.sites).toBe(1)
    } finally {
      await runtime.close()
    }
  })

  test('a deep site queue parks new sites (in memory without Postgres) and feeds them back in order', async () => {
    await redis.flushdb()
    const config = configFromEnv({ CRAWL_REDIS_URL: REDIS, CRAWL_SITE_QUEUE_HIGH: '4', CRAWL_INDEX_PATH: ':memory:' })
    const runtime = createRuntime(config, () => {})
    const waiting = async () => (await runtime.queues.site.getWaiting(0, -1)).map((j) => j.data.site)
    try {
      const sites = Array.from({ length: 10 }, (_, i) => `s${i}.example`)
      expect(await runtime.crawler.scheduleSites(sites.slice(0, 6), 'link')).toEqual({ queued: 6, refused: 0 })
      // The queue is deep now: the next four are recorded, parked, not queued.
      expect(await runtime.crawler.scheduleSites(sites.slice(6), 'link')).toEqual({ queued: 4, refused: 0 })
      expect(await runtime.crawler.scheduleSites(sites.slice(6), 'link')).toEqual({ queued: 0, refused: 4 })
      expect(await waiting()).toEqual(sites.slice(0, 6))
      await publishSiteCounts(runtime)
      expect((await snapshot(runtime)).stats).toMatchObject({ sites: 10, sites_parked: 4 })
      // A `first` site never parks.
      await runtime.crawler.scheduleSites(['vip.example'], 'submit', { first: true })
      expect(await waiting()).toContain('vip.example')
      expect(await feedParked(runtime, config)).toBe(0)
      for (const j of await runtime.queues.site.getWaiting(0, -1)) await j.remove()
      expect(await feedParked(runtime, config)).toBe(4)
      expect(await waiting()).toEqual(sites.slice(6))
    } finally {
      await runtime.close()
    }
  })

})

describe('Obscura over MCP', () => {
  test('a fake server: session, navigate, evaluate, a document back', async () => {
    const seen: string[] = []
    const fake = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const headers = new Headers(init?.headers)
      seen.push(`${body.method}${body.params?.name ? `:${body.params.name}` : ''}|${headers.get('authorization')}|${headers.get('mcp-session-id') ?? ''}`)
      if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 's1' } })
      if (!body.id) return new Response(null, { status: 202 })
      const text =
        body.params.name === 'browser_evaluate'
          ? JSON.stringify({ url: 'https://spa.example/', lang: 'en', head: '<head><title>SPA</title></head>', text: 'Hello from the client', main: '', links: [['https://spa.example/x', '']] })
          : 'Navigated'
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] } })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
    const client = new ObscuraClient('http://obscura.test/mcp', 'tok', fake)
    const out = await client.render('https://spa.example/')
    expect(out.url).toBe('https://spa.example/')
    expect(out.html).toContain('<title>SPA</title>')
    expect(out.html).toContain('<p>Hello from the client</p>')
    expect(out.html).toContain('href="https://spa.example/x"')
    expect(seen).toEqual([
      'initialize|Bearer tok|',
      'notifications/initialized|Bearer tok|s1',
      'tools/call:browser_navigate|Bearer tok|s1',
      'tools/call:browser_evaluate|Bearer tok|s1',
    ])
  })

  test.skipIf(!OBSCURA)('a real Obscura renders a client-side page', async () => {
    const client = new ObscuraClient(OBSCURA!, process.env.OBSCURA_TEST_TOKEN ?? '')
    const out = await client.render('https://react.dev/')
    const doc = extract(out.html, out.url, { rendered: true })
    expect(doc.record.title).toBe('React')
    expect(doc.internal.length).toBeGreaterThan(10)
    expect(doc.enrichment.words).toBeGreaterThan(200)
  }, 60_000)
})

const PG = process.env.CRAWL_TEST_PG

describe.skipIf(!PG)('on a real Postgres', () => {
  test('the site store: new only, parked in order, forced, due again, counted, the limit holds', async () => {
    const store = new PgSiteStore(PG!)
    try {
      await store.add([{ site: 'warm.example', source: 'x' }], false)
      await (store as unknown as { sql: { unsafe(q: string): Promise<unknown> } }).sql.unsafe('truncate sites; update counts set n = 0')
      const rows = (names: string[], source = 'link') => names.map((site) => ({ site, source }))
      expect(await store.add(rows(['a.example', 'b.example', 'a.example', 'q"uote\\.example']), false)).toEqual(['a.example', 'b.example', 'q"uote\\.example'])
      expect(await store.add(rows(['b.example', 'c.example']), true)).toEqual(['c.example'])
      expect(await store.resync()).toEqual({ known: 4, parked: 3 })
      // Concurrent writers: each new site is counted once.
      const many = Array.from({ length: 50 }, (_, i) => `m${i}.example`)
      const got = await Promise.all([store.add(rows(many), false), store.add(rows(many), false), store.add(rows(many), false)])
      expect(got.flat().length).toBe(50)
      // force: a parked site becomes scheduled, a new one known and scheduled.
      await store.force(rows(['b.example', 'z.example'], 'submit'))
      const parked = await store.takeParked(3)
      expect(parked.map((r) => r.site)).toEqual(['a.example', 'q"uote\\.example', 'm0.example'])
      const exact = await store.resync()
      expect(exact).toEqual({ known: 55, parked: 49 })
      // The counters agree with the exact count after concurrent adds, a force and a take.
      expect(await store.counts()).toEqual(exact)
      expect(await store.takeDue(60_000, 10)).toEqual([])
      expect((await store.takeDue(0, 100)).length).toBe(6)
    } finally {
      await store.close()
    }
  })

  test.skipIf(!REDIS)('the Redis frontier moves into Postgres: parked stay parked and in order, the rest scheduled', async () => {
    const redis = connect(REDIS!)
    await redis.flushdb()
    const runtime = createRuntime(configFromEnv({ CRAWL_REDIS_URL: REDIS, CRAWL_DATABASE_URL: PG, CRAWL_INDEX_PATH: ':memory:' }), () => {})
    try {
      await runtime.sites.add([{ site: 'warm.example', source: 'x' }], false)
      await (runtime.sites as unknown as { sql: { unsafe(q: string): Promise<unknown> } }).sql.unsafe('truncate sites; update counts set n = 0')
      const old = Date.now() - 40 * 86_400_000
      await redis.zadd('pitcrawl:sites', old, 'done.example', Date.now(), 'p1.example', Date.now(), 'p2.example')
      await redis.rpush('pitcrawl:pending', 'rssamplifier p1.example', 'link p2.example')
      expect(await migrateSitesFromRedis(runtime, { drop: true }, () => {})).toEqual({ known: 3, parked: 2 })
      expect(await redis.exists('pitcrawl:sites', 'pitcrawl:pending')).toBe(0)
      expect(await runtime.sites.takeParked(5)).toEqual([
        { site: 'p1.example', source: 'rssamplifier' },
        { site: 'p2.example', source: 'link' },
      ])
      expect(await runtime.sites.takeDue(30 * 86_400_000, 10)).toEqual(['done.example'])
    } finally {
      await runtime.close()
      await redis.flushdb()
      redis.disconnect()
    }
  })
})
