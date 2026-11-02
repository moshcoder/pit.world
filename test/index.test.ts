import { RING } from '../src/ring.ts'
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

describe('footer', () => {
  it('links the crawler status and pitbot pages, and the sitemap lists them', async () => {
    const app = createApp({ keys: {} })
    const home = await (await app.request('/about')).text()
    expect(home).toContain('href="/status"')
    expect(home).toContain('href="/bot"')
    const sitemap = await (await app.request('/sitemap.xml')).text()
    expect(sitemap).toContain('https://pit.world/status')
    expect(sitemap).toContain('https://pit.world/bot')
  })
})

describe('sponsored listings', () => {
  const search = async () => {
    const app = createApp({
      keys: { serper: 'k' },
      fetch: (async () => Response.json({ organic: [1, 2, 3, 4, 5].map((i) => ({ link: `https://r${i}.example/`, title: `R${i}`, snippet: 's' })) })) as unknown as typeof fetch,
    })
    return (await app.request('/search?q=pizza')).text()
  }
  it('sit above the organic results, three frames, never told the query', async () => {
    const page = await search()
    const top = page.indexOf('class="sponsored-top"')
    expect(top).toBeGreaterThan(-1)
    expect(top).toBeLessThan(page.indexOf('<ol class="hits"'))
    expect(page.match(/format=text_link&amp;pos=\d/g)).toHaveLength(3)
    const frames = page.match(/crawlproof\.com\/api\/ads\/frame[^"]*/g) ?? []
    expect(frames.length).toBe(4)
    for (const f of frames) expect(f).not.toContain('pizza')
  })
  it('never on the home page', async () => {
    const app = createApp({ keys: {} })
    expect(await (await app.request('/')).text()).not.toContain('sponsored-top')
  })
})

import { FEATURED_TOP, featureNetwork, hostsFrom, W3bsNetwork } from '../src/w3bs-network.ts'

describe('W3BS network sites are featured', () => {
  it('reads the registry names and /net links, both spellings, never released names', () => {
    const hosts = hostsFrom(
      { names: [{ name: 'knox.agent', status: 'active' }, { name: 'gone.agent', status: 'released' }] },
      '<a href="https://alt.2600.w3bs.org/">x</a><a href="https://seo.rank.pit.world">y</a><a href="https://github.com/x">z</a>',
    )
    for (const h of ['knox.agent.pit.world', 'knox.agent.w3bs.org', 'alt.2600.pit.world', 'alt.2600.w3bs.org', 'seo.rank.w3bs.org', 'w3bs.org']) expect(hosts.has(h)).toBe(true)
    expect(hosts.has('gone.agent.pit.world')).toBe(false)
    expect(hosts.has('github.com')).toBe(false)
  })

  it('badges network hits and leads with one; the rest keep their place, badged; the cached result is untouched', () => {
    const net = new W3bsNetwork(fetch, ['a.agent.pit.world', 'b.bbs.pit.world', 'c.x.pit.world', 'd.y.pit.world'])
    const hit = (host: string) => ({ url: `https://${host}/`, title: host, description: '', host })
    const result = { query: 'q', provider: 'serper', failures: [], cached: false, hits: ['nyt.com', 'a.agent.pit.world', 'cnn.com', 'b.bbs.pit.world', 'c.x.pit.world', 'd.y.pit.world'].map(hit) }
    const out = featureNetwork(result, net)
    expect(out.hits.map((h) => h.host)).toEqual(['a.agent.pit.world', 'nyt.com', 'cnn.com', 'b.bbs.pit.world', 'c.x.pit.world', 'd.y.pit.world'])
    expect(out.hits.filter((h) => h.featured)).toHaveLength(4)
    expect(FEATURED_TOP).toBe(1)
    expect(result.hits[0]!.host).toBe('nyt.com')
    expect(result.hits.some((h) => 'featured' in h)).toBe(false)
  })

  it('the results page shows the Featured badge, and the API carries the flag', async () => {
    const app = createApp({
      keys: { serper: 'k' },
      network: new W3bsNetwork(fetch, ['seo.rank.pit.world']),
      fetch: (async () => Response.json({ organic: [{ link: 'https://nyt.com/a', title: 'NYT', snippet: 's' }, { link: 'https://seo.rank.pit.world/', title: 'seo.rank', snippet: 'audit' }] })) as unknown as typeof fetch,
    })
    const page = await (await app.request('/search?q=seo+audit+tool')).text()
    const first = page.indexOf('class="featured-hit"')
    expect(first).toBeGreaterThan(-1)
    expect(first).toBeLessThan(page.indexOf('nyt.com/a'))
    expect(page).toContain('>Featured</span>')
    const api = await (await app.request('/api/search?q=seo+audit+tool')).json()
    expect(api.results[0]).toMatchObject({ host: 'seo.rank.pit.world', featured: true })
  })
})

import { networkPagesFromIndex } from '../src/w3bs-network.ts'

describe('featured slots filled from our own index', () => {
  const net = new W3bsNetwork(fetch, ['seo.rank.pit.world', 'family.ancestry.pit.world', 'alt.2600.pit.world'])
  const hit = (url: string) => ({ url, title: url, description: 'd', host: new URL(url).hostname })
  const base = { query: 'q', provider: 'serper', failures: [], cached: false }

  it('fills the slot from the index only when the engines brought no network site, never a page already shown, never off the network', () => {
    const lead = featureNetwork({ ...base, hits: [hit('https://semrush.com/'), hit('https://seo.rank.pit.world/')] }, net, [hit('https://alt.2600.pit.world/')])
    // The engines brought one: it leads, the index adds nothing.
    expect(lead.hits.map((h) => h.url)).toEqual(['https://seo.rank.pit.world/', 'https://semrush.com/'])
    const result = { ...base, hits: [hit('https://semrush.com/'), hit('https://seo.rank.pit.world/x')] }
    const fromIndex = [hit('https://outside.example/'), hit('https://family.ancestry.pit.world/famous')]
    const none = { ...base, hits: [hit('https://semrush.com/'), hit('https://nyt.com/')] }
    const out = featureNetwork(none, net, [hit('https://semrush.com/'), ...fromIndex])
    expect(out.hits.map((h) => h.url)).toEqual(['https://family.ancestry.pit.world/famous', 'https://semrush.com/', 'https://nyt.com/'])
    expect(out.hits[0]).toMatchObject({ featured: true, sources: ['pit'] })
    expect(featureNetwork(result, net, fromIndex).hits[0]!.url).toBe('https://seo.rank.pit.world/x')
  })

  it('asks the index for 50 and keeps only network pages; a failing index adds nothing', async () => {
    let asked = ''
    const ok = (async (input: string | URL | Request) => {
      asked = String(input)
      return Response.json({ items: [{ url: 'https://outside.example/', title: 'o' }, { url: 'https://alt.2600.pit.world/x', title: 'x', summary: 's' }] })
    }) as unknown as typeof fetch
    const pages = await networkPagesFromIndex('hacker zines', 'http://127.0.0.1:8807', net, ok)
    expect(asked).toContain('limit=50')
    expect(pages.map((p) => p.url)).toEqual(['https://alt.2600.pit.world/x'])
    const broken = (async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    expect(await networkPagesFromIndex('x', 'http://127.0.0.1:8807', net, broken)).toEqual([])
    expect(await networkPagesFromIndex('x', undefined, net, ok)).toEqual([])
  })

  it('end to end: a query no engine answers with a network site still leads with one', async () => {
    const fake = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('http://index.test')) return Response.json({ items: [{ url: 'https://family.ancestry.pit.world/', title: 'family.ancestry', summary: 'Your family tree' }] })
      return Response.json({ organic: [{ link: 'https://familysearch.org/', title: 'FamilySearch', snippet: 's' }] })
    }) as unknown as typeof fetch
    const app = createApp({ keys: { serper: 'k', pit: 'http://index.test' }, network: net, fetch: fake })
    const api = await (await app.request('/api/search?q=family+tree')).json()
    expect(api.results[0]).toMatchObject({ host: 'family.ancestry.pit.world', featured: true })
  })
})

describe('the featured lead goes to the site whose keywords match', () => {
  const net = new W3bsNetwork(fetch, ['seo.rank.pit.world', 'built.indie.pit.world'])
  const hit = (url: string) => ({ url, title: url, description: 'd', host: new URL(url).hostname })
  const base = { query: 'seo audit tool', provider: 'serper', failures: [], cached: false }
  const seoRank = RING.find((s) => s.name === 'seo.rank')!

  it('its page from the engines first, else from our index, else its home page', () => {
    const fromEngines = featureNetwork({ ...base, hits: [hit('https://semrush.com/'), hit('https://seo.rank.pit.world/check')] }, net, [hit('https://built.indie.pit.world/p/seo')], seoRank)
    expect(fromEngines.hits.map((h) => h.url)).toEqual(['https://seo.rank.pit.world/check', 'https://semrush.com/'])
    const fromIndex = featureNetwork({ ...base, hits: [hit('https://semrush.com/')] }, net, [hit('https://built.indie.pit.world/p/seo'), hit('https://seo.rank.pit.world/docs')], seoRank)
    expect(fromIndex.hits[0]).toMatchObject({ url: 'https://seo.rank.pit.world/docs', featured: true })
    const home = featureNetwork({ ...base, hits: [hit('https://semrush.com/')] }, net, [hit('https://built.indie.pit.world/p/seo')], seoRank)
    expect(home.hits[0]).toMatchObject({ url: 'https://seo.rank.pit.world/', featured: true, description: seoRank.about })
    expect(home.hits.map((h) => h.url)).toEqual(['https://seo.rank.pit.world/', 'https://semrush.com/'])
  })

  it('on the page: seo.rank leads "seo audit", and the box above does not repeat it', async () => {
    const fake = (async (input: string | URL | Request) => {
      if (String(input).startsWith('http://index.test')) return Response.json({ items: [{ url: 'https://built.indie.pit.world/p/seo', title: 'built.indie: seo.rank', summary: 's' }] })
      return Response.json({ organic: [{ link: 'https://semrush.com/', title: 'Semrush', snippet: 's' }] })
    }) as unknown as typeof fetch
    const app = createApp({ keys: { serper: 'k', pit: 'http://index.test' }, network: net, fetch: fake })
    const api = await (await app.request('/api/search?q=seo+audit')).json()
    expect(api.results[0]).toMatchObject({ host: 'seo.rank.pit.world', featured: true })
    const page = await (await app.request('/search?q=seo+audit')).text()
    expect(page).not.toContain('class="promo featured"')
  })
})
