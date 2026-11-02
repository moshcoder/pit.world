import { describe, expect, it } from 'bun:test'
import { createCrawlStatus, type CrawlerReport, describe as describeCrawl } from '../src/crawl-status.ts'
import { callProvider, LABELS, parsePitIndex, PRIMARY } from '../src/search.ts'
import { createApp, keysFromEnv } from '../src/server.ts'

describe('our own index as one of the engines', () => {
  it('reads nichedb search items: url, title, summary; never a non-web link', () => {
    expect(
      parsePitIndex({
        items: [
          { url: 'javascript:alert(1)', title: 'bad' },
          { url: 'https://ovens.example/pizza', title: 'Wood-fired pizza', summary: 'How to build one.' },
        ],
      }),
    ).toEqual([{ url: 'https://ovens.example/pizza', title: 'Wood-fired pizza', description: 'How to build one.', host: 'ovens.example' }])
  })

  it('asks the sites collection, with a bearer only when one is configured', async () => {
    const asked: Array<{ url: string; auth: string | null }> = []
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') })
      return Response.json({ items: [{ url: 'https://a.example/', title: 'A', summary: '' }] })
    }) as typeof fetch
    expect(await callProvider('pit', 'https://nichedb.test/', 'pizza ovens', 10, fake)).toHaveLength(1)
    await callProvider('pit', 'https://nichedb.test k1', 'x', 5, fake)
    expect(asked[0]).toEqual({ url: 'https://nichedb.test/api/v1/search?q=pizza+ovens&collection=sites&limit=10', auth: null })
    expect(asked[1]!.auth).toBe('Bearer k1')
  })

  it('is on by default, last among the primaries, and can be turned off', () => {
    expect(PRIMARY.at(-1)).toBe('pit')
    expect(LABELS.pit).toBe('pit.world index')
    expect(keysFromEnv({}).pit).toBe('http://127.0.0.1:8807')
    expect(keysFromEnv({ PIT_INDEX_URL: 'https://nichedb.dev' }).pit).toBe('https://nichedb.dev')
    expect(keysFromEnv({ PIT_INDEX_URL: 'http://127.0.0.1:3010', PIT_INDEX_KEY: 'k' }).pit).toBe('http://127.0.0.1:3010 k')
    expect(keysFromEnv({ PIT_INDEX_URL: 'off' }).pit).toBeUndefined()
  })

  it('/bot says who pitbot is and how to keep it out', async () => {
    const app = createApp({ keys: {} })
    const page = await (await app.request('/bot')).text()
    expect(page).toContain('User-agent: pitbot')
    expect(page).toContain('nichedb.dev/c/sites')
    expect(await (await app.request('/privacy')).text()).toContain('href="/bot"')
  })
})

const report = (over: Partial<CrawlerReport> = {}): CrawlerReport => ({
  ok: true,
  version: '0.1.0',
  stats: { sites: 3, outbox: 12, pages_indexed: 40, pages_rendered: 2, published: 30 },
  queues: { site: { waiting: 0 }, page: { prioritized: 500, delayed: 20 }, render: { waiting: 1 }, publish: { delayed: 2 } },
  activity: {
    lastHour: { pages_indexed: 30, pages_rendered: 2, published: 30, pages_failed: 1 },
    lastDay: { pages_indexed: 40, pages_rendered: 2, published: 30, sites_started: 3, pages_failed: 1 },
    hours: [{ at: '2026-11-02T04:00:00.000Z', counts: { pages_indexed: 30, pages_failed: 1 } }],
  },
  log: [{ at: '2026-11-02T04:35:00.000Z', kind: 'page', site: 'shop.example', url: 'https://shop.example/a', title: 'A <b>page</b>', note: '300 words' }],
  settings: { maxPages: 1000, maxDepth: 6, concurrency: 16, hostDelayMs: 1500, recrawlDays: 30, renderers: 2, discover: false, publishing: true },
  generatedAt: new Date().toISOString(),
  ...over,
})

describe('crawler status', () => {
  it('healthy, stalled, idle, offline: the verdict a visitor needs', () => {
    const ok = describeCrawl(report())
    expect(ok.health).toBe('healthy')
    expect(ok.jobs.find((j) => j.key === 'pages')).toMatchObject({ state: 'working', backlog: 520, clearsInHours: 16.8 })
    const stuck = describeCrawl(report({ activity: { lastHour: {}, lastDay: {}, hours: [] } }))
    expect(stuck.health).toBe('stalled')
    const idle = describeCrawl(report({ queues: {}, stats: { sites: 3 }, activity: { lastHour: {}, lastDay: {}, hours: [] } }))
    expect(idle.health).toBe('idle')
    expect(describeCrawl(null).health).toBe('offline')
  })

  it('/status draws it, escaped, refreshing; /api/status is the same as JSON', async () => {
    const app = createApp({ keys: {}, crawlStatus: async () => describeCrawl(report()) })
    const page = await (await app.request('/status')).text()
    expect(page).toContain('Crawler status')
    expect(page).toContain('<meta http-equiv="refresh" content="15">')
    expect(page).toContain('A &lt;b&gt;page&lt;/b&gt;')
    expect(page).toContain('https://nichedb.dev/c/sites/shop.example/a')
    expect(page).toContain('crawl-health-healthy')
    const json = await (await app.request('/api/status')).json()
    expect(json.totals.pagesIndexed).toBe(42)
    expect(json.health).toBe('healthy')
  })

  it('a crawler that does not answer is shown as offline, not as an error page', async () => {
    const down = createCrawlStatus('http://127.0.0.1:9', (async () => {
      throw new Error('refused')
    }) as unknown as typeof fetch)
    const app = createApp({ keys: {}, crawlStatus: down })
    const r = await app.request('/status')
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('crawl-health-offline')
  })
})
