import { describe, expect, test } from 'bun:test'
import { extract, keywordsOf, needsRender } from '../src/extract.ts'
import { readSitemapXml } from '../src/fetcher.ts'
import { documentFrom } from '../src/obscura.ts'
import { allows, parseRobots } from '../src/robots.ts'
import { crawlable, isPublicAddress, isPublicHostname, normalizeUrl, siteFromInput, siteOf, urlId } from '../src/url.ts'

describe('addresses', () => {
  test('one page, however it is linked', () => {
    expect(normalizeUrl('/a?utm_source=x&b=1#top', 'https://Example.com:443/x')).toBe('https://example.com/a?b=1')
    expect(normalizeUrl('mailto:a@b.c')).toBeNull()
    expect(normalizeUrl('javascript:alert(1)', 'https://example.com/')).toBeNull()
    expect(normalizeUrl('https://user:pw@example.com/')).toBeNull()
    expect(siteOf('https://www.Example.com/x')).toBe('example.com')
    expect(siteFromInput('WWW.example.com/path')).toBe('example.com')
    expect(urlId('https://example.com/')).not.toContain(':')
  })

  test('never a private network, by name or by number', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', 'db.internal', '::1', 'fd00::1', 'foo'])
      expect(isPublicHostname(h)).toBe(false)
    expect(isPublicHostname('pit.world')).toBe(true)
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false)
    expect(isPublicAddress('23.95.228.174')).toBe(true)
    expect(siteFromInput('http://localhost:8787/')).toBeNull()
  })

  test('media, documents and traps are not pages', () => {
    expect(crawlable('https://e.com/a.pdf')).toBe(false)
    expect(crawlable('https://e.com/wp-login.php')).toBe(true) // a page, but…
    expect(crawlable('https://e.com/wp-admin/x')).toBe(false)
    expect(crawlable('https://e.com/blog?replytocom=5')).toBe(false)
    expect(crawlable('https://e.com/blog/post')).toBe(true)
  })
})

describe('robots.txt', () => {
  const robots = parseRobots(`
User-agent: *
Disallow: /private
Allow: /private/ok
Disallow: /*.json$
Crawl-delay: 4

User-agent: pitbot
User-agent: other
Disallow: /no-pit

Sitemap: https://e.com/sitemap.xml
`)
  test('our own group wins over *, rules match longest first', () => {
    expect(robots.sitemaps).toEqual(['https://e.com/sitemap.xml'])
    expect(allows(robots, '/no-pit/x')).toBe(false)
    // The * group does not apply once a group names us.
    expect(allows(robots, '/private')).toBe(true)
  })
  test('the * group: longest match, Allow on ties, wildcards and anchors, crawl-delay', () => {
    const star = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.json$\nCrawl-delay: 4\n')
    expect(allows(star, '/private/x')).toBe(false)
    expect(allows(star, '/private/ok/y')).toBe(true)
    expect(allows(star, '/data.json')).toBe(false)
    expect(allows(star, '/data.json?x=1')).toBe(true)
    expect(star.crawlDelayMs).toBe(4000)
    expect(allows(parseRobots('User-agent: *\nDisallow:\n'), '/anything')).toBe(true)
  })
})

const PAGE = `<!doctype html><html lang="en-US"><head>
<title>HTML title</title>
<meta name="description" content="A guide to wood-fired pizza ovens.">
<meta property="og:title" content="Wood-fired pizza at home">
<meta property="og:image" content="/img/oven.jpg">
<meta property="og:site_name" content="Oven Notes">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="https://other.example/stolen">
<link rel="alternate" type="application/rss+xml" href="/feed.xml">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","headline":"Wood-fired pizza at home","datePublished":"2026-10-01","author":{"@type":"Person","name":"Ann Baker"}}</script>
<script src="/app.js"></script>
</head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<main><h1>Pizza</h1><p>Pizza ovens need heat. A pizza oven made of brick holds heat for hours, and pizza dough loves it.</p>
<a href="/recipes/dough?utm_campaign=x">Dough</a> <a href="https://friend.example/">Friend</a> <a href="/ad" rel="sponsored">Ad</a></main>
<footer>Copyright</footer></body></html>`

describe('reading a page', () => {
  const doc = extract(PAGE, 'https://www.ovens.example/pizza', { depth: 2 })
  test('the record is the card a reader would draw', () => {
    const r = doc.record
    expect(r.title).toBe('Wood-fired pizza at home')
    expect(r.kind).toBe('article')
    // A canonical on another site is a claim, not a fact.
    expect(r.canonical).toBe('https://www.ovens.example/pizza')
    expect(r.description).toBe('A guide to wood-fired pizza ovens.')
    expect(r.image?.url).toBe('https://www.ovens.example/img/oven.jpg')
    expect(r.site.name).toBe('Oven Notes')
    expect(r.author?.name).toBe('Ann Baker')
    expect(r.published_at).toBe('2026-10-01T00:00:00.000Z')
    expect(r.feeds).toEqual(['https://www.ovens.example/feed.xml'])
    expect(r.cards.twitter['twitter:card']).toBe('summary_large_image')
    expect(r.language).toBe('en-us')
  })
  test('the enrichment: keywords, excerpt from main, a hash, the links', () => {
    expect(doc.enrichment.keywords[0]).toBe('pizza')
    expect(doc.enrichment.excerpt).toStartWith('Pizza Pizza ovens need heat.')
    expect(doc.enrichment.excerpt).not.toContain('Copyright')
    expect(doc.enrichment.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(doc.enrichment.depth).toBe(2)
    expect(doc.internal).toContain('https://www.ovens.example/recipes/dough')
    expect(doc.internal).not.toContain('https://www.ovens.example/ad')
    expect(doc.external).toEqual(['friend.example'])
    expect(doc.noindex).toBe(false)
  })
  test('noindex and nofollow are obeyed', () => {
    const d = extract('<html><head><meta name="robots" content="noindex, nofollow"></head><body><a href="/x">x</a></body></html>', 'https://e.com/')
    expect(d.noindex).toBe(true)
    expect(d.internal).toEqual([])
  })
  test('keywords skip stopwords, need to recur, and title words count thrice', () => {
    expect(keywordsOf('The best ovens', 'ovens ovens the and of bread once')).toEqual(['ovens', 'best'])
  })
})

describe('which pages need a browser', () => {
  test('an empty app shell does; a short server-rendered page does not', () => {
    const shell = '<html><head><script src="/a.js"></script><script src="/b.js"></script></head><body><div id="root"></div></body></html>'
    expect(needsRender(shell, extract(shell, 'https://e.com/').textLength)).toBe(true)
    expect(needsRender(PAGE, extract(PAGE, 'https://e.com/').textLength)).toBe(false)
    const noscript = '<html><body><noscript>You need to enable JavaScript to run this app.</noscript></body></html>'
    expect(needsRender(noscript, 40)).toBe(true)
  })
  test('what Obscura reads back is a document the extractor reads like any other', () => {
    const html = documentFrom({
      lang: 'en',
      head: '<head><title>App</title><meta property="og:title" content="Rendered app"></head>',
      text: 'ignored when main exists',
      main: 'Line one about <rendering>\nLine two',
      links: [
        ['https://e.com/next', ''],
        ['https://e.com/paid', 'sponsored'],
      ],
    })
    const doc = extract(html, 'https://e.com/', { rendered: true })
    expect(doc.record.title).toBe('Rendered app')
    expect(doc.enrichment.excerpt).toBe('Line one about <rendering> Line two')
    expect(doc.enrichment.rendered).toBe(true)
    expect(doc.internal).toEqual(['https://e.com/next'])
  })
})

test('sitemaps and sitemap indexes', () => {
  const index = readSitemapXml('<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>')
  expect(index).toEqual({ urls: [], sitemaps: ['https://e.com/s1.xml'] })
  const set = readSitemapXml('<urlset><url><loc><![CDATA[https://e.com/a?x=1&amp;y=2]]></loc></url><url><loc> https://e.com/b </loc><lastmod>x</lastmod></url></urlset>')
  expect(set.urls).toEqual(['https://e.com/a?x=1&y=2', 'https://e.com/b'])
})

test("a publisher's JSON-LD never titles the page", () => {
  const html = `<html><head><title>Topic: example · RSS Amplifier</title>
<meta property="og:title" content="Topic: example"><meta property="og:type" content="website">
<script type="application/ld+json">{"@type":"Organization","name":"Profullstack, Inc.","url":"https://profullstack.com"}</script>
<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
</head><body><p>x</p></body></html>`
  const doc = extract(html, 'https://rssamplifier.com/topics/example')
  expect(doc.record.title).toBe('Topic: example')
  expect(doc.record.kind).toBe('page')
  expect(doc.record.jsonld).toHaveLength(2)
})

import { sitesFromNichedb, sitesFromOpml } from '../src/seed.ts'

test('OPML: the site behind each feed, htmlUrl first, once each, never a private host', () => {
  const xml = `<opml><body>
<outline text="A" type="rss" xmlUrl="https://feeds.buzzsprout.com/1.rss" htmlUrl="https://www.Show-One.example/" />
<outline text="B" type="rss" xmlUrl="https://blog.example/feed" />
<outline text="C" type="rss" xmlUrl="https://feeds.buzzsprout.com/2.rss" htmlUrl="https://show-one.example/ep?a=1&amp;b=2" />
<outline text="D" type="rss" xmlUrl="http://localhost/feed" />
<outline text="group"><outline text="E" xmlUrl="https://e.example/rss" htmlUrl="" /></outline>
</body></opml>`
  expect(sitesFromOpml(xml)).toEqual(['show-one.example', 'blog.example', 'e.example'])
})

describe('seeding from nichedb, which meters its reads', () => {
  const page = (ids: number[]) => Response.json({ items: ids.map((id) => ({ id, url: `https://s${id}.example/a`, tags: [`site:s${id}.example`] })) })

  test('sends the publisher key, so a metered collection answers', async () => {
    const auth: Array<string | null> = []
    const fake = (async (input: string | URL, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get('authorization'))
      return auth.length === 1 ? page([2, 1]) : Response.json({ items: [] })
    }) as typeof fetch
    expect(await sitesFromNichedb('https://nichedb.test', { fetch: fake, key: 'k1' })).toEqual(['s2.example', 's1.example'])
    expect(auth[0]).toBe('Bearer k1')
  })

  test('keeps the sites it did get when the meter cuts in part way', async () => {
    let calls = 0
    const fake = (async () => (++calls === 1 ? page([2, 1]) : new Response('payment required', { status: 402 }))) as unknown as typeof fetch
    expect(await sitesFromNichedb('https://nichedb.test', { fetch: fake, key: 'k1' })).toEqual(['s2.example', 's1.example'])
  })

  test('with nothing to keep it says what went wrong, and names a missing key', async () => {
    const paywalled = (async () => new Response('payment required', { status: 402 })) as unknown as typeof fetch
    await expect(sitesFromNichedb('https://nichedb.test', { fetch: paywalled })).rejects.toThrow('NICHEDB_API_KEY is not set')
    await expect(sitesFromNichedb('https://nichedb.test', { fetch: paywalled, key: 'k1' })).rejects.toThrow('answered HTTP 402')
  })
})

import { videoRefOf } from '../src/extract.ts'

describe('content and media references', () => {
  const long = 'Lorem ipsum dolor sit amet. '.repeat(60) + 'The word zebracorn appears only deep in the text.'
  const page = `<html><head><title>Ovens on video</title>
<meta property="og:image" content="/og.jpg"><meta property="og:image:alt" content="An oven">
<meta property="og:video" content="https://player.vimeo.com/video/123456789">
<script type="application/ld+json">{"@type":"VideoObject","name":"Firing the oven","contentUrl":"https://cdn.example/fire.mp4","thumbnailUrl":"https://cdn.example/fire.jpg"}</script>
</head><body><main>
<p>${long}</p>
<img src="/a.jpg" alt="Brick dome" width="800" height="600">
<img src="/pixel.gif" width="1" height="1"><img src="data:image/png;base64,xx" alt="inline">
<img data-src="/lazy.webp" alt="Lazy loaded">
<img srcset="/s-480.jpg 480w, /s-960.jpg 960w" alt="Srcset">
<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0" title="Our build"></iframe>
<video poster="/poster.jpg"><source src="/clips/door.webm"></video>
<iframe src="https://ads.example/frame"></iframe>
</main></body></html>`
  const doc = extract(page, 'https://ovens.example/video')

  test('the full main text is kept for the index, the excerpt stays short', () => {
    expect(doc.enrichment.text).toContain('zebracorn')
    expect(doc.enrichment.excerpt).not.toContain('zebracorn')
    expect(doc.enrichment.excerpt.length).toBeLessThanOrEqual(1000)
  })

  test('images by reference: og first, real images, never pixels or inline data', () => {
    expect(doc.enrichment.images.map((i) => [i.url, i.alt])).toEqual([
      ['https://ovens.example/og.jpg', 'An oven'],
      ['https://ovens.example/a.jpg', 'Brick dome'],
      ['https://ovens.example/lazy.webp', 'Lazy loaded'],
      ['https://ovens.example/s-480.jpg', 'Srcset'],
    ])
    expect(doc.enrichment.images[1]).toMatchObject({ width: 800, height: 600 })
  })

  test('videos by reference: JSON-LD, og:video, embeds as watch pages, <video>; never an ad frame', () => {
    expect(doc.enrichment.videos.map((v) => [v.url, v.provider])).toEqual([
      ['https://cdn.example/fire.mp4', null],
      ['https://vimeo.com/123456789', 'vimeo'],
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
      ['https://ovens.example/clips/door.webm', null],
    ])
    expect(doc.enrichment.videos[0]!.thumbnail).toBe('https://cdn.example/fire.jpg')
    expect(doc.enrichment.videos[2]).toMatchObject({ title: 'Our build', thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' })
    expect(doc.enrichment.videos[3]!.thumbnail).toBe('https://ovens.example/poster.jpg')
  })

  test('YouTube in all its spellings is one watch page', () => {
    for (const u of ['https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=3', 'https://www.youtube.com/shorts/dQw4w9WgXcQ'])
      expect(videoRefOf(u, 'https://x.example/')?.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(videoRefOf('https://example.com/page', 'https://x.example/')).toBeNull()
  })
})
