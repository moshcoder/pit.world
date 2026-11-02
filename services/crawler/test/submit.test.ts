import { describe, expect, test } from 'bun:test'
import { configFromEnv } from '../src/config.ts'
import { createCrawler, type PageJob, type SiteJob } from '../src/crawler.ts'
import { MemoryFrontier } from '../src/frontier.ts'
import { feedLinks, guessKind, sniff } from '../src/submit.ts'

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
<item><title>A</title><link>https://blog.example/a</link></item>
<item><title>B</title><link><![CDATA[https://blog.example/b?x=1&amp;y=2]]></link></item>
</channel></rss>`
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><link rel="alternate" href="/post/1"/></entry><entry><link href="https://atom.example/post/2"/></entry></feed>`
const JSONFEED = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ url: 'https://json.example/1' }, { external_url: 'https://elsewhere.example/2' }] })
const SITEMAP = '<urlset><url><loc>https://map.example/1</loc></url><url><loc>https://map.example/2</loc></url></urlset>'
const INDEX = '<sitemapindex><sitemap><loc>https://map.example/s2.xml</loc></sitemap></sitemapindex>'
const OPML = '<opml><body><outline xmlUrl="https://feeds.host/x" htmlUrl="https://opml-a.example/"/><outline xmlUrl="https://opml-b.example/rss"/></body></opml>'

const WEB: Record<string, { type: string; body: string; status?: number }> = {
  'https://blog.example/feed': { type: 'application/rss+xml', body: RSS },
  'https://atom.example/atom.xml': { type: 'text/xml', body: ATOM },
  'https://json.example/feed.json': { type: 'application/json', body: JSONFEED },
  'https://map.example/sitemap.xml': { type: 'application/xml', body: SITEMAP },
  'https://map.example/sitemap_index.xml': { type: 'application/xml', body: INDEX },
  'https://map.example/s2.xml': { type: 'application/xml', body: SITEMAP.replace(/\/1</, '/3<') },
  'https://lists.example/feeds.opml': { type: 'text/x-opml', body: OPML },
  'https://page.example/post/42': { type: 'text/html', body: '<html><body>hi</body></html>' },
  // A link that turns out to be a feed is treated as one.
  'https://sneaky.example/updates': { type: 'text/plain', body: RSS.replace(/blog\.example/g, 'sneaky.example') },
  'https://gone.example/x': { type: 'text/html', body: 'no', status: 404 },
}
const fakeFetch = (async (input: string | URL | Request) => {
  const page = WEB[String(input)]
  if (!page) return new Response('missing', { status: 404 })
  return new Response(page.body, { status: page.status ?? 200, headers: { 'content-type': page.type } })
}) as typeof fetch

function setup() {
  const config = configFromEnv({ CRAWL_HOST_DELAY_MS: '0' })
  const frontier = new MemoryFrontier(config.maxPages)
  const queued = { sites: [] as SiteJob[], pages: [] as PageJob[] }
  const forwarded: string[] = []
  const crawler = createCrawler({
    config,
    frontier,
    fetch: fakeFetch,
    resolver: async (host) => host !== '10.0.0.1',
    forwardFeed: async (url) => void forwarded.push(url),
    enqueue: { sites: async (j) => void queued.sites.push(...j), pages: async (j) => void queued.pages.push(...j), render: async () => {} },
  })
  return { crawler, queued, forwarded, frontier }
}

describe('what a submitted address is', () => {
  test('guessed from its spelling for the instant answer', () => {
    expect(guessKind('https://a.example/')).toBe('site')
    expect(guessKind('https://a.example/feed')).toBe('feed')
    expect(guessKind('https://a.example/blog/rss.xml')).toBe('feed')
    expect(guessKind('https://a.example/sitemap.xml')).toBe('sitemap')
    expect(guessKind('https://a.example/sitemap_index.xml')).toBe('sitemap')
    expect(guessKind('https://a.example/subs.opml')).toBe('opml')
    expect(guessKind('https://a.example/post/1')).toBe('page')
  })
  test('known for certain by its first tags', () => {
    expect(sniff(SITEMAP)).toBe('sitemap')
    expect(sniff(INDEX)).toBe('sitemap')
    expect(sniff(RSS)).toBe('feed')
    expect(sniff(ATOM)).toBe('feed')
    expect(sniff(JSONFEED)).toBe('feed')
    expect(sniff(OPML)).toBe('opml')
    expect(sniff('<!doctype html><html>', 'text/html')).toBe('html')
  })
  test('item links of RSS, Atom and JSON Feed', () => {
    expect(feedLinks(RSS, 'https://blog.example/feed')).toEqual(['https://blog.example/a', 'https://blog.example/b?x=1&y=2'])
    expect(feedLinks(ATOM, 'https://atom.example/atom.xml')).toEqual(['https://atom.example/post/1', 'https://atom.example/post/2'])
    expect(feedLinks(JSONFEED, 'https://json.example/feed.json')).toEqual(['https://json.example/1', 'https://elsewhere.example/2'])
  })
})

describe('submitting', () => {
  test('a site is scheduled ahead of the queue, without a fetch', async () => {
    const { crawler, queued } = setup()
    expect(await crawler.submit('example.com')).toEqual({ kind: 'site', sites: 1, pages: 0 })
    expect(queued.sites).toEqual([{ site: 'example.com', source: 'submit', first: true }])
  })

  test('a feed queues its items and is offered to rssamplifier', async () => {
    const { crawler, queued, forwarded } = setup()
    expect(await crawler.submit('https://blog.example/feed')).toEqual({ kind: 'feed', sites: 1, pages: 2 })
    expect(queued.pages.map((p) => [p.url, p.depth])).toEqual([
      ['https://blog.example/a', 0],
      ['https://blog.example/b?x=1&y=2', 0],
    ])
    expect(forwarded).toEqual(['https://blog.example/feed'])
    expect((await crawler.submit('https://json.example/feed.json')).pages).toBe(2)
  })

  test('a sitemap and a sitemap index queue every page they list', async () => {
    const { crawler, queued } = setup()
    expect(await crawler.submit('https://map.example/sitemap.xml')).toEqual({ kind: 'sitemap', sites: 1, pages: 2 })
    expect((await crawler.submit('https://map.example/sitemap_index.xml')).kind).toBe('sitemap')
    // The index's nested sitemap adds page 3; 2 was already admitted.
    expect(queued.pages.map((p) => p.url)).toEqual(['https://map.example/1', 'https://map.example/2', 'https://map.example/3'])
  })

  test('an OPML file schedules every site behind it; a page is read; a link that is really a feed is a feed', async () => {
    const { crawler, queued } = setup()
    expect(await crawler.submit('https://lists.example/feeds.opml')).toEqual({ kind: 'opml', sites: 2, pages: 0 })
    expect(queued.sites.map((s) => s.site)).toEqual(['opml-a.example', 'opml-b.example'])
    expect(await crawler.submit('https://page.example/post/42')).toEqual({ kind: 'page', sites: 1, pages: 1 })
    expect((await crawler.submit('https://sneaky.example/updates')).kind).toBe('feed')
  })

  test('private and unreadable addresses are refused, and counted', async () => {
    const { crawler, frontier } = setup()
    expect((await crawler.submit('http://10.0.0.1/admin')).kind).toBe('refused')
    expect((await crawler.submit('https://gone.example/x')).kind).toBe('unreadable')
    expect(frontier.counters.submitted_feed ?? 0).toBe(0)
  })
})
