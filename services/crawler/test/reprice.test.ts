/**
 * The product graph's two crawler halves: product pages still reach nichedb when
 * every-page publishing is off (CRAWL_PUBLISH_PAGES=0, as on dev2), and the daily
 * reprice re-reads known product pages without following their links.
 */
import { describe, expect, test } from 'bun:test'
import { configFromEnv } from '../src/config.ts'
import { createCrawler, PRODUCT_LINE, type PageJob } from '../src/crawler.ts'
import { MemoryFrontier } from '../src/frontier.ts'
import { pageOpts } from '../src/queues.ts'

const productPage = (price: string) => `<html lang="en"><head><title>Kettle</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Kettle","gtin13":"4006381333931","offers":{"@type":"Offer","price":"${price}","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script>
</head><body><main>A kettle that boils water fast, a good kettle. <a href="/more">More kettles</a> <a href="https://other.example/">Other</a></main></body></html>`

const plainPage = '<html lang="en"><head><title>About</title></head><body><main>About this shop and its kettles.</main></body></html>'

function setup(env: Record<string, string>, web: Record<string, string>, nichedb: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; body: any; auth: string | null }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('https://nichedb.test')) {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get('authorization') })
      return nichedb(url, init)
    }
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n', { headers: { 'content-type': 'text/plain' } })
    const body = web[url]
    return body ? new Response(body, { headers: { 'content-type': 'text/html' } }) : new Response('no', { status: 404, headers: { 'content-type': 'text/html' } })
  }) as typeof fetch
  const config = configFromEnv({ CRAWL_HOST_DELAY_MS: '0', NICHEDB_URL: 'https://nichedb.test', NICHEDB_API_KEY: 'k1', ...env })
  const frontier = new MemoryFrontier(1000)
  const queued: PageJob[] = []
  const index = { add: (entries: string[]) => entries.length }
  const noop = async () => {}
  const crawler = createCrawler({
    config,
    frontier,
    index,
    fetch: fetchImpl,
    resolver: async () => true,
    enqueue: { sites: noop, pages: async (jobs) => void queued.push(...jobs), render: noop },
  })
  return { crawler, frontier, calls, queued }
}

describe('product pages reach the graph with every-page publishing off', () => {
  test('only the product page is sent, slimmed, to /api/v1/products/records', async () => {
    const { crawler, calls, frontier } = setup(
      { CRAWL_PUBLISH_PAGES: '0' },
      { 'https://shop.example/kettle': productPage('30.00'), 'https://shop.example/about': plainPage },
      () => Response.json({ accepted: 1, offers: 1, removed: 0 }),
    )
    await crawler.crawlPage({ url: 'https://shop.example/kettle', site: 'shop.example', depth: 1 })
    await crawler.crawlPage({ url: 'https://shop.example/about', site: 'shop.example', depth: 1 })
    await crawler.publish()
    expect(calls.map((c) => c.url)).toEqual(['https://nichedb.test/api/v1/products/records'])
    expect(calls[0]!.auth).toBe('Bearer k1')
    const [sent] = calls[0]!.body.records
    expect(sent.record.url).toBe('https://shop.example/kettle')
    expect(sent.record.jsonld[0]['@type']).toBe('Product')
    expect(sent.enrichment).toBeUndefined()
    expect(frontier.counters.products_published).toBe(1)
    expect(frontier.counters.offers_published).toBe(1)
  })

  test('a failed send is counted and logged, never thrown (the page is already indexed)', async () => {
    const { crawler, frontier } = setup({ CRAWL_PUBLISH_PAGES: '0' }, { 'https://shop.example/kettle': productPage('30.00') }, () => new Response('down', { status: 503 }))
    await crawler.crawlPage({ url: 'https://shop.example/kettle', site: 'shop.example', depth: 1 })
    expect((await crawler.publish()).sent).toBe(0)
    expect(frontier.counters.products_failed).toBe(1)
    expect(frontier.outbox).toEqual([])
  })

  test('CRAWL_PUBLISH_PRODUCTS=0 sends nothing', async () => {
    const { crawler, calls } = setup({ CRAWL_PUBLISH_PAGES: '0', CRAWL_PUBLISH_PRODUCTS: '0' }, { 'https://shop.example/kettle': productPage('30.00') }, () => Response.json({}))
    await crawler.crawlPage({ url: 'https://shop.example/kettle', site: 'shop.example', depth: 1 })
    await crawler.publish()
    expect(calls).toEqual([])
  })

  test('PRODUCT_LINE: kind product or a JSON-LD Product node', () => {
    expect(PRODUCT_LINE.test('{"record":{"kind":"product"}}')).toBe(true)
    expect(PRODUCT_LINE.test('{"jsonld":[{"@type":"ProductGroup"}]}')).toBe(true)
    expect(PRODUCT_LINE.test('{"jsonld":[{"@type":["Thing","Product"]}]}')).toBe(true)
    expect(PRODUCT_LINE.test('{"jsonld":[{"@type":"Article","name":"Product review"}]}')).toBe(false)
  })
})

describe('the daily reprice', () => {
  test('pages come from nichedb, keyset paged, deduped, as reprice jobs at depth 0', async () => {
    const lists: Record<string, unknown> = {
      '0': { pages: ['https://shop.example/kettle', 'https://shop.example/kettle', 'http://localhost/x'], next: 7 },
      '7': { pages: ['https://other.example/p/1', 'https://shop.example/kettle'], next: null },
    }
    const { crawler, queued, calls } = setup({ CRAWL_REPRICE_HOURS: '18' }, {}, (url) => Response.json(lists[new URL(url).searchParams.get('after')!]))
    expect(await crawler.reprice()).toEqual({ pages: 2, sites: 2 })
    expect(queued).toEqual([
      { url: 'https://shop.example/kettle', site: 'shop.example', depth: 0, reprice: true },
      { url: 'https://other.example/p/1', site: 'other.example', depth: 0, reprice: true },
    ])
    expect(calls[0]!.url).toContain('/api/v1/products/pages?after=0&limit=5000&olderThanHours=18')
    expect(calls[0]!.auth).toBe('Bearer k1')
  })

  test('a reprice page is read and published but follows none of its links', async () => {
    const { crawler, queued } = setup({}, { 'https://shop.example/kettle': productPage('24.99') }, () => Response.json({ added: 0 }))
    const out = await crawler.crawlPage({ url: 'https://shop.example/kettle', site: 'shop.example', depth: 0, reprice: true })
    expect(out.outcome).toBe('indexed')
    expect(queued).toEqual([])
  })

  test('job ids: one per page per UTC day for a reprice, top priority; crawl jobs unchanged', () => {
    const day = new Date('2026-11-14T23:00:00Z')
    expect(pageOpts({ url: 'https://shop.example/kettle', site: 'shop.example', depth: 0, reprice: true }, day).jobId).toMatch(/^r-2026-11-14-/)
    expect(pageOpts({ url: 'https://shop.example/kettle', site: 'shop.example', depth: 0, reprice: true }, day).priority).toBe(1)
    expect(pageOpts({ url: 'https://shop.example/kettle', site: 'shop.example', depth: 3 }, day)).toMatchObject({ priority: 4 })
    expect(pageOpts({ url: 'https://shop.example/kettle', site: 'shop.example', depth: 3 }, day).jobId).toMatch(/^p-/)
  })

  test('claimOnce: the first claim of a day wins', async () => {
    const f = new MemoryFrontier(10)
    expect(await f.claimOnce('reprice:2026-11-14', 60_000)).toBe(true)
    expect(await f.claimOnce('reprice:2026-11-14', 60_000)).toBe(false)
    expect(await f.claimOnce('reprice:2026-11-15', 60_000)).toBe(true)
  })
})
