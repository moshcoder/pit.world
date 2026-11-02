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
import { connect, createRuntime, snapshot } from '../src/queues.ts'

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

  test('the site lease spaces requests; sites are scheduled once per cycle', async () => {
    const frontier = new RedisFrontier(redis, 5, 60_000)
    for (let i = 0; i < 4; i++) await frontier.admit('slow.example', `https://slow.example/${i}`)
    expect(await frontier.lease('slow.example', 2_000)).toEqual({ waitMs: 0, pending: 0 })
    const busy = await frontier.lease('slow.example', 2_000)
    expect(busy.waitMs).toBeGreaterThan(1_000)
    // Four admitted, one fetched: three still waiting for their turn.
    expect(busy.pending).toBe(3)
    const twice = await Promise.all([frontier.noteSite('once.example', 10, 60_000), frontier.noteSite('once.example', 10, 60_000)])
    expect(twice.filter(Boolean).length).toBe(1)
    expect(await frontier.noteSite('once.example', 10, 0)).toBe(true)
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
      const snap = await snapshot(runtime)
      expect(snap.queues.site?.waiting).toBe(1)
      expect(snap.queues.page?.prioritized).toBe(1)
      expect(snap.stats.sites).toBe(1)
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
