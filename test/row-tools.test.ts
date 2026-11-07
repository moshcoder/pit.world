import { describe, expect, it } from 'bun:test'
import { createApp } from '../src/server.ts'
import { PageImages, pagePicture } from '../src/page-image.ts'
import { parseGdelt, VERTICALS } from '../src/verticals.ts'

const page = (head: string) => new Response(`<html><head>${head}</head><body>x</body></html>`, { headers: { 'content-type': 'text/html' } })
const PUBLIC = async (host: string) => (host.includes('internal') ? ['10.0.0.5'] : ['93.184.216.34'])

describe('pagePicture', () => {
  const base = 'https://news.example/a/story'
  it('takes og:image in either attribute order, relative and with entities', () => {
    expect(pagePicture(`<meta property="og:image" content="https://cdn.example/a.jpg">`, base)).toBe('https://cdn.example/a.jpg')
    expect(pagePicture(`<meta content='/b.jpg?x=1&amp;y=2' property='og:image'>`, base)).toBe('https://news.example/b.jpg?x=1&y=2')
  })
  it('falls back to twitter:image and image_src, and prefers secure_url', () => {
    expect(pagePicture(`<meta name="twitter:image" content="https://cdn.example/t.jpg">`, base)).toBe('https://cdn.example/t.jpg')
    expect(pagePicture(`<link rel="image_src" href="/l.png">`, base)).toBe('https://news.example/l.png')
    expect(pagePicture(`<meta property="og:image" content="http://cdn.example/a.jpg"><meta property="og:image:secure_url" content="https://s.example/a.jpg">`, base)).toBe('https://s.example/a.jpg')
  })
  it('upgrades http, refuses other schemes, ignores the body', () => {
    expect(pagePicture(`<meta property="og:image" content="http://cdn.example/a.jpg">`, base)).toBe('https://cdn.example/a.jpg')
    expect(pagePicture(`<meta property="og:image" content="data:image/png;base64,AAAA">`, base)).toBeNull()
    expect(pagePicture(`</head><body><meta property="og:image" content="https://cdn.example/a.jpg">`, base)).toBeNull()
  })
})

describe('PageImages', () => {
  it('reads a page once and remembers misses too', async () => {
    let reads = 0
    const images = new PageImages({ resolve: PUBLIC, fetch: (async () => (reads++, page(''))) as never })
    expect(await images.find('https://a.example/')).toBeNull()
    expect(await images.find('https://a.example/')).toBeNull()
    expect(reads).toBe(1)
  })
  it('never reads a private address, nor a redirect to one', async () => {
    const fetched: string[] = []
    const fake = (async (u: string) => (fetched.push(u), new Response(null, { status: 302, headers: { location: 'https://internal.example/' } }))) as never
    const images = new PageImages({ resolve: PUBLIC, fetch: fake })
    expect(await images.find('https://internal.example/')).toBeNull()
    expect(fetched).toEqual([])
    expect(await images.find('https://a.example/')).toBeNull()
    expect(fetched).toEqual(['https://a.example/'])
  })
})

it('GDELT rows keep their social image', () => {
  expect(parseGdelt({ articles: [{ url: 'https://a.example/x', title: 'X', socialimage: 'https://a.example/x.jpg' }] })[0]!.thumbnail).toBe('https://a.example/x.jpg')
})

/** Every tab answers one row with no picture, the way a feed does. */
function pit() {
  const remembered: string[] = []
  const row = { url: 'https://site.example/row', title: 'A row', site: 'site.example', summary: 'Words about it.', endpoint: 'https://site.example/mcp' }
  const fake = (async (url: string | URL | Request) => {
    const u = String(url)
    if (u.startsWith('https://site.example/row')) return page('<meta property="og:image" content="https://cdn.example/p.jpg">')
    if (u.startsWith('https://cdn.example/')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } })
    if (u.startsWith('http://index.test/')) return Response.json({ items: [row], mcps: [row], results: [row] })
    if (u.includes('rssamplifier.com/api/search')) return Response.json({ posts: [{ url: row.url, title: row.title, summary: row.summary, blog: 'A blog' }] })
    return Response.json({})
  }) as typeof fetch
  const app = createApp({
    keys: { pit: 'http://index.test' },
    fetch: fake,
    fingerprintSecret: 'a-test-secret-long-enough',
    resolve: PUBLIC,
    summarizer: { enabled: true, remember: (hits: Array<{ url: string }>) => remembered.push(...hits.map((h) => h.url)), observeReads() {} },
    speech: { enabled: true },
  } as never)
  return { request: (path: string) => app.request(path, {}, { ip: '203.0.113.7' }), remembered }
}

describe('every tab', () => {
  it.each(['news', 'blogs'])('%s rows get a picture, Summarize and Listen, and can be summarized', async (t) => {
    const { request, remembered } = pit()
    const html = await (await request(`/search?q=row&t=${t}`)).text()
    expect(html).toContain('class="summarize"')
    expect(html).toContain('class="listen"')
    expect(html).toMatch(/class="thumb page-image" src="\/page-image\?u=/)
    expect(remembered).toContain('https://site.example/row')
  })

  it('no tab is left out of the markup', async () => {
    const source = await Bun.file('src/html.ts').text()
    const list = source.slice(source.indexOf('function mediaList('), source.indexOf('/** Blogs: the blogs that write'))
    // One return per layout; each must carry the actions.
    expect(list.match(/mediaActions\(m, tools\)/g)!.length).toBe(list.match(/return `(<ul|<ol|<p class="muted)/g)!.length)
    expect(VERTICALS.length).toBeGreaterThan(10)
  })

  it('/page-image follows a signed link to the page picture, through /img', async () => {
    const { request } = pit()
    const html = await (await request('/search?q=row&t=news')).text()
    const src = html.match(/src="(\/page-image\?[^"]+)"/)![1]!.replace(/&amp;/g, '&')
    const hop = await request(src)
    expect(hop.status).toBe(302)
    const location = hop.headers.get('location')!
    expect(location).toContain(encodeURIComponent('https://cdn.example/p.jpg'))
    const image = await request(location)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/jpeg')
  })

  it('/page-image refuses a page it did not sign', async () => {
    const { request } = pit()
    expect((await request('/page-image?u=https%3A%2F%2Fsite.example%2Frow&s=forged')).status).toBe(400)
  })
})
