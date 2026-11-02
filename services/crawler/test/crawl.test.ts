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
    expect(frontier.outbox).toEqual([])
    expect(frontier.counters.published).toBe(2)
  })
})
