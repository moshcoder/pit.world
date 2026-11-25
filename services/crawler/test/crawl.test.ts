/**
 * A whole crawl over a fake web: a site with robots rules and a sitemap, a
 * JavaScript shell that goes to the renderer, the page cap, publishing to a
 * fake nichedb. No Redis and no network: the in-memory frontier honours the
 * same contract the Redis one does (that one is tested in redis.test.ts).
 */
import { describe, expect, test } from 'bun:test'
import { configFromEnv } from '../src/config.ts'
import { createCrawler, type PageJob, type SiteJob } from '../src/crawler.ts'
import { MemoryFrontier } from '../src/frontier.ts'

const html = (title: string, body: string) => `<html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`

const WEB: Record<string, { status?: number; type?: string; body: string; location?: string }> = {
  'https://shop.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private\nSitemap: https://shop.example/sitemap.xml\n' },
  'https://shop.example/sitemap.xml': {
    type: 'application/xml',
    body: '<urlset><url><loc>https://shop.example/a</loc></url><url><loc>https://shop.example/private/x</loc></url><url><loc>https://elsewhere.example/z</loc></url></urlset>',
  },
  'https://shop.example/': {
    type: 'text/html',
    body: html('Shop home', 'Welcome to the shop of ovens, ovens everywhere. <a href="/a">A</a> <a href="/b">B</a> <a href="/app">App</a> <a href="/private/y">P</a> <a href="https://friend.example/">F</a>'),
  },
  'https://shop.example/a': { type: 'text/html', body: html('Page A', 'Ovens of type A are hot ovens. <a href="/c">C</a>') },
  'https://shop.example/b': { status: 301, body: '', location: 'https://www.shop.example/b2' },
  'https://www.shop.example/b2': { type: 'text/html', body: html('Page B', 'Moved here.') },
  'https://shop.example/app': {
    type: 'text/html',
    body: '<html><head><title>App</title><script src="/1.js"></script><script src="/2.js"></script></head><body><div id="root"></div></body></html>',
  },
}

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input)
  const page = WEB[url]
  if (!page) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } })
  return new Response(page.body, {
    status: page.status ?? 200,
    headers: { 'content-type': page.type ?? 'text/html', ...(page.location ? { location: page.location } : {}) },
  })
}) as typeof fetch

function setup(env: Record<string, string> = {}) {
  const config = configFromEnv({ CRAWL_HOST_DELAY_MS: '0', NICHEDB_URL: 'https://nichedb.test', ...env })
  const frontier = new MemoryFrontier(config.maxPages)
  const queued = { sites: [] as SiteJob[], pages: [] as PageJob[], render: [] as PageJob[] }
  const crawler = createCrawler({
    config,
    frontier,
    fetch: fakeFetch,
    resolver: async () => true,
    renderer: {
      size: 1,
      async render(url) {
        return { url, html: html('Rendered app', 'Client side ovens rendered by a browser, ovens again. <a href="/a">A</a>') }
      },
    },
    enqueue: {
      async sites(jobs) {
        queued.sites.push(...jobs)
      },
      async pages(jobs) {
        queued.pages.push(...jobs)
      },
      async render(job) {
        queued.render.push(job)
      },
    },
  })
  return { config, frontier, queued, crawler }
}

describe('a site, start to finish', () => {
  test('scheduling: once per cycle, never a private name', async () => {
    const { crawler, queued } = setup()
    expect(await crawler.scheduleSites(['Shop.example', 'shop.example/', 'localhost'], 'cli')).toEqual({ queued: 1, refused: 2 })
    expect(queued.sites).toEqual([{ site: 'shop.example', source: 'cli' }])
  })

  test('the start reads robots and the sitemap: home and listed pages, never a disallowed or foreign one', async () => {
    const { crawler, queued } = setup()
    const out = await crawler.crawlSite({ site: 'shop.example', source: 'cli' })
    expect(out.outcome).toBe('started')
    expect(queued.pages.map((p) => [p.url, p.depth])).toEqual([
      ['https://shop.example/', 0],
      ['https://shop.example/a', 1],
    ])
  })

  test('pages become records and the next pages; a shell goes to the browser; a redirect within the site is followed', async () => {
    const { crawler, queued, frontier } = setup()
    await crawler.crawlSite({ site: 'shop.example', source: 'cli' })
    expect((await crawler.crawlPage({ url: 'https://shop.example/', site: 'shop.example', depth: 0 })).outcome).toBe('indexed')
    const next = queued.pages.slice(2).map((p) => p.url)
    expect(next).toEqual(['https://shop.example/b', 'https://shop.example/app'])
    // /a was already admitted from the sitemap; /private/y is disallowed.

    expect((await crawler.crawlPage({ url: 'https://shop.example/app', site: 'shop.example', depth: 1 })).outcome).toBe('needs a browser')
    expect(queued.render).toEqual([{ url: 'https://shop.example/app', site: 'shop.example', depth: 1, rendered: true }])
    expect((await crawler.renderPage(queued.render[0]!)).outcome).toBe('indexed')

    expect((await crawler.crawlPage({ url: 'https://shop.example/b', site: 'shop.example', depth: 1 })).outcome).toBe('indexed')
    const records = frontier.outbox.map((r) => JSON.parse(r))
    expect(records.map((r) => r.record.title)).toEqual(['Shop home', 'Rendered app', 'Page B'])
    expect(records[1].enrichment.rendered).toBe(true)
    expect(records[2].record.url).toBe('https://www.shop.example/b2')
    expect(records[0].enrichment.keywords).toContain('ovens')
    // Discovery is off by default: friend.example is not scheduled.
    expect(queued.sites).toEqual([])
    // The log /status shows, newest first.
    const kinds = frontier.events.map((e) => e.kind)
    expect(kinds).toEqual(['page', 'render', 'page', 'site'])
    expect(frontier.events[0]).toMatchObject({ site: 'shop.example', url: 'https://www.shop.example/b2', title: 'Page B' })
    expect(frontier.events.at(-1)!.note).toBe('started: 2 pages queued (2 in sitemaps)')
  })

  test('discovery on: linked sites are scheduled too', async () => {
    const { crawler, queued } = setup({ CRAWL_DISCOVER: '1' })
    await crawler.crawlPage({ url: 'https://shop.example/', site: 'shop.example', depth: 0 })
    expect(queued.sites).toEqual([{ site: 'friend.example', source: 'link' }])
  })

  test('a site start stops hard past 120% of the page backlog cap', async () => {
    const { config, frontier, queued } = setup({ CRAWL_MAX_PAGE_BACKLOG: '100' })
    let backlog = 121
    const crawler = createCrawler({
      config,
      frontier,
      fetch: fakeFetch,
      resolver: async () => true,
      pageBacklog: async () => backlog,
      enqueue: { sites: async () => {}, pages: async (j) => void queued.pages.push(...j), render: async () => {} },
    })
    expect(await crawler.crawlSite({ site: 'shop.example', source: 'opml' })).toEqual({ admitted: 0, outcome: 'waiting for the page backlog', delayMs: 60_000 })
    expect(queued.pages).toEqual([])
    backlog = 120
    expect((await crawler.crawlSite({ site: 'shop.example', source: 'opml' })).outcome).toBe('started')
  })

  test('a resolver that is down delays the start, a name with no address parks the site', async () => {
    const { config, frontier } = setup()
    let dns = false
    let known = false
    const crawler = createCrawler({
      config,
      frontier,
      fetch: fakeFetch,
      resolver: async () => known,
      dnsUp: async () => dns,
      enqueue: { sites: async () => {}, pages: async () => {}, render: async () => {} },
    })
    // DNS itself is down: nothing is parked or claimed, the job comes back in a minute.
    expect(await crawler.crawlSite({ site: 'shop.example', source: 'opml' })).toEqual({ admitted: 0, outcome: 'waiting for DNS', delayMs: 60_000 })
    expect((await frontier.siteState('shop.example')).downMs).toBe(0)
    expect(frontier.events[0]!.note).toContain('DNS is not answering')
    // A page read that fails on the name waits the same way.
    const failing = createCrawler({
      config,
      frontier,
      fetch: (async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND shop.example'), { code: 'ENOTFOUND' })
      }) as unknown as typeof fetch,
      resolver: async () => true,
      dnsUp: async () => dns,
      enqueue: { sites: async () => {}, pages: async () => {}, render: async () => {} },
    })
    // robots.txt already read, so the first lookup is the page's own.
    await frontier.setRobots('shop.example', (await import('../src/robots.ts')).EMPTY)
    expect(await failing.crawlPage({ url: 'https://shop.example/', site: 'shop.example', depth: 0 })).toEqual({ delayMs: 60_000, outcome: 'waiting for DNS' })
    expect((await frontier.siteState('shop.example')).downMs).toBe(0)
    // DNS back and the site answers: the same job starts it (the claim was not spent).
    dns = true
    known = true
    expect((await crawler.crawlSite({ site: 'shop.example', source: 'opml' })).outcome).toBe('started')
    // DNS up and the name has no address: parked for the 30 days, as before.
    known = false
    expect((await crawler.crawlSite({ site: 'gone.example', source: 'opml' })).outcome).toBe('not public')
    expect((await frontier.siteState('gone.example')).downMs).toBeGreaterThan(29 * 86_400_000)
  })

  test('the page cap is exact', async () => {
    const { crawler, queued } = setup({ CRAWL_MAX_PAGES: '2' })
    await crawler.crawlSite({ site: 'shop.example', source: 'cli' })
    await crawler.crawlPage({ url: 'https://shop.example/', site: 'shop.example', depth: 0 })
    expect(queued.pages.map((p) => p.url)).toEqual(['https://shop.example/', 'https://shop.example/a'])
  })

  test('a site inside its request gap asks to wait, it does not fetch', async () => {
    const { crawler } = setup({ CRAWL_HOST_DELAY_MS: '5000' })
    expect((await crawler.crawlPage({ url: 'https://shop.example/', site: 'shop.example', depth: 0 })).outcome).toBe('indexed')
    const second = await crawler.crawlPage({ url: 'https://shop.example/a', site: 'shop.example', depth: 1 })
    expect(second.outcome).toBe('waiting for the site')
    expect(second.delayMs).toBeGreaterThan(4000)
  })
})

describe('is DNS itself answering', () => {
  test('up when any canary resolves, down when none does or they hang; one check per ttl', async () => {
    const { resolverCheck } = await import('../src/url.ts')
    let calls = 0
    const some = resolverCheck(async (host) => {
      calls++
      if (host !== 'b.example') throw new Error('EAI_AGAIN')
    }, { names: ['a.example', 'b.example'], ttlMs: 60_000 })
    expect(await Promise.all([some(), some()])).toEqual([true, true])
    expect(await some()).toBe(true)
    expect(calls).toBe(2)
    const none = resolverCheck(async () => Promise.reject(new Error('EAI_AGAIN')), { names: ['a.example'], ttlMs: 0 })
    expect(await none()).toBe(false)
    const hung = resolverCheck(() => new Promise(() => {}), { names: ['a.example'], timeoutMs: 20 })
    expect(await hung()).toBe(false)
  })
})

describe('publishing to nichedb', () => {
  test('without a key, records wait in the outbox', async () => {
    const { crawler, frontier } = setup()
    await crawler.crawlPage({ url: 'https://shop.example/', site: 'shop.example', depth: 0 })
    expect(await crawler.publish()).toEqual({ sent: 0, added: 0, rejected: 0, waiting: true })
    expect(frontier.outbox.length).toBe(1)
  })

  test('with a key: batches with the bearer, and a failed call puts them back in order', async () => {
    const calls: Array<{ url: string; auth: string | null; body: any }> = []
    let fail = true
    const nichedb = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (!url.startsWith('https://nichedb.test')) return fakeFetch(input, init)
      calls.push({ url, auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
      if (fail) return new Response('busy', { status: 503 })
      return Response.json({ accepted: 2, added: 2, updated: 0, rejected: [] })
    }) as typeof fetch
    const config = configFromEnv({ CRAWL_HOST_DELAY_MS: '0', NICHEDB_URL: 'https://nichedb.test', NICHEDB_API_KEY: 'k1' })
    const frontier = new MemoryFrontier(1000)
    const noop = async () => {}
    const crawler = createCrawler({ config, frontier, fetch: nichedb, resolver: async () => true, enqueue: { sites: noop, pages: noop, render: noop } })
    await crawler.crawlPage({ url: 'https://shop.example/', site: 'shop.example', depth: 0 })
    await crawler.crawlPage({ url: 'https://shop.example/a', site: 'shop.example', depth: 1 })
    await expect(crawler.publish()).rejects.toThrow('HTTP 503')
    expect(frontier.outbox.map((r) => JSON.parse(r).record.title)).toEqual(['Shop home', 'Page A'])
    fail = false
    expect(await crawler.publish()).toEqual({ sent: 2, added: 2, rejected: 0, waiting: false })
    const last = calls.at(-1)!
    expect(last.url).toBe('https://nichedb.test/api/v1/sites/records')
    expect(last.auth).toBe('Bearer k1')
    expect(last.body.records.map((r: any) => r.record.title)).toEqual(['Shop home', 'Page A'])
    // The full text stays local; nichedb gets the record, excerpt and media.
    expect(last.body.records[0].enrichment.text).toBeUndefined()
    expect(last.body.records[0].enrichment.excerpt).toContain('Welcome')
    expect(frontier.outbox).toEqual([])
    expect(frontier.counters.published).toBe(2)
  })

  test('CRAWL_PUBLISH_PAGES=0: the key is kept but pages go to the local index only', async () => {
    let calls = 0
    const nichedb = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('https://nichedb.test')) calls++
      return fakeFetch(input, init)
    }) as typeof fetch
    const config = configFromEnv({ CRAWL_HOST_DELAY_MS: '0', NICHEDB_URL: 'https://nichedb.test', NICHEDB_API_KEY: 'k1', CRAWL_PUBLISH_PAGES: '0' })
    const frontier = new MemoryFrontier(1000)
    const kept: string[] = []
    const index = { add: (entries: string[]) => (kept.push(...entries), entries.length) }
    const noop = async () => {}
    const crawler = createCrawler({ config, frontier, index, fetch: nichedb, resolver: async () => true, enqueue: { sites: noop, pages: noop, render: noop } })
    await crawler.crawlPage({ url: 'https://shop.example/', site: 'shop.example', depth: 0 })
    expect(await crawler.publish()).toEqual({ sent: 0, added: 0, rejected: 0, waiting: false })
    expect(calls).toBe(0)
    expect(kept.length).toBe(1)
    expect(frontier.outbox).toEqual([])
  })
})

import { spreadDelay } from '../src/crawler.ts'

describe('waiting for a busy site', () => {
  test('a page waits for the slot plus a random share of the site backlog, capped', () => {
    expect(spreadDelay(800, 0, 1500, () => 0.99)).toBe(800)
    expect(spreadDelay(800, 1, 1500, () => 0.99)).toBe(800)
    expect(spreadDelay(800, 101, 1500, () => 0)).toBe(800)
    expect(spreadDelay(800, 101, 1500, () => 0.5)).toBe(800 + 50 * 1500)
    expect(spreadDelay(800, 1000, 3000, () => 0.99)).toBe(30 * 60_000)
  })

  test('so a site with a long queue wakes about one page per gap, not all of them', () => {
    const wakes = new Map<number, number>()
    for (let i = 0; i < 200; i++) {
      const slot = Math.floor(spreadDelay(0, 200, 1500) / 1500)
      wakes.set(slot, (wakes.get(slot) ?? 0) + 1)
    }
    expect(Math.max(...wakes.values())).toBeLessThan(10)
  })
})

test('page reads wait while the outbox is over its high-water mark', async () => {
  const config = configFromEnv({ CRAWL_HOST_DELAY_MS: '0', CRAWL_OUTBOX_HIGH: '2' })
  const frontier = new MemoryFrontier(1000)
  const noop = async () => {}
  const crawler = createCrawler({ config, frontier, fetch: fakeFetch, resolver: async () => true, enqueue: { sites: noop, pages: noop, render: noop } })
  await frontier.push([1, 2, 3], 100)
  const out = await crawler.crawlPage({ url: 'https://shop.example/', site: 'shop.example', depth: 0 })
  expect(out.outcome).toBe('waiting for publishing to catch up')
  expect(out.delayMs).toBeGreaterThanOrEqual(20_000)
  await frontier.take(3)
  expect((await crawler.crawlPage({ url: 'https://shop.example/', site: 'shop.example', depth: 0 })).outcome).toBe('indexed')
})

describe('seed --first', () => {
  test('re-schedules a waiting site ahead of the queue; whichever copy comes up second skips', async () => {
    const { crawler, queued } = setup()
    expect(await crawler.scheduleSites(['shop.example'], 'opml')).toEqual({ queued: 1, refused: 0 })
    expect(await crawler.scheduleSites(['shop.example'], 'w3bs')).toEqual({ queued: 0, refused: 1 })
    expect(await crawler.scheduleSites(['shop.example'], 'w3bs', { first: true })).toEqual({ queued: 1, refused: 0 })
    expect(queued.sites).toEqual([
      { site: 'shop.example', source: 'opml' },
      { site: 'shop.example', source: 'w3bs', first: true },
    ])
    expect((await crawler.crawlSite(queued.sites[1]!)).outcome).toBe('started')
    expect((await crawler.crawlSite(queued.sites[0]!)).outcome).toBe('already started this cycle')
  })
})
