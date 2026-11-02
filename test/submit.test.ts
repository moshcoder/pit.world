import { describe, expect, it } from 'bun:test'
import { createApp } from '../src/server.ts'
import { guessKind, privateBySpelling } from '../src/submit-kinds.ts'

function app(options: { down?: boolean } = {}) {
  const sent: string[][] = []
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === 'http://crawler.test/api/v1/submit') {
      if (options.down) throw new Error('ECONNREFUSED')
      const urls = JSON.parse(String(init?.body)).urls as string[]
      sent.push(urls)
      return Response.json({ queued: urls.length }, { status: 202 })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  return { app: createApp({ keys: {}, crawlerUrl: 'http://crawler.test', fetch: fake }), sent }
}

const form = (fields: Record<string, string | File>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

describe('pit.world/submit', () => {
  it('shows the form: a list of up to 1,000, a file, every kind explained, the API', async () => {
    const page = await (await app().app.request('/submit')).text()
    expect(page).toContain('<textarea id="submit-input" name="input"')
    expect(page).toContain('name="file" type="file"')
    expect(page).toContain('up to 1,000')
    for (const k of ['Site', 'Page', 'Feed', 'Sitemap', 'OPML']) expect(page).toContain(`<b>${k}</b>`)
    expect(page).toContain('/api/submit')
  })

  it('a pasted list of mixed kinds: sorted, private and junk refused, the rest sent to the crawler', async () => {
    const { app: a, sent } = app()
    const input = ['example.com', 'https://example.com/feed.xml', 'https://example.com/sitemap.xml', 'https://example.com/post/1', 'http://127.0.0.1/', 'localhost:8080', 'mailto:x@y.z', 'example.com'].join('\n')
    const r = await a.request('/submit', { method: 'POST', body: form({ input }) })
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(sent).toEqual([['https://example.com/', 'https://example.com/feed.xml', 'https://example.com/sitemap.xml', 'https://example.com/post/1']])
    expect(html).toContain('4 queued.')
    for (const k of ['kind-site', 'kind-feed', 'kind-sitemap', 'kind-page']) expect(html).toContain(k)
    expect(html).toContain('a private or internal address')
    expect(html).toContain('not a web address')
  })

  it('an uploaded file: a plain list, OPML read for its feeds, a saved sitemap read for its pages', async () => {
    const { app: a, sent } = app()
    const list = new File(['one.example\ntwo.example/rss\n'], 'sites.txt', { type: 'text/plain' })
    await a.request('/submit', { method: 'POST', body: form({ input: '', file: list }) })
    const opml = new File(['<opml><body><outline xmlUrl="https://three.example/feed"/></body></opml>'], 'subs.opml', { type: 'text/x-opml' })
    await a.request('/submit', { method: 'POST', body: form({ input: '', file: opml }) })
    const sitemap = new File(['<?xml version="1.0"?><urlset><url><loc>https://four.example/a?x=1&amp;y=2</loc></url><url><loc><![CDATA[https://four.example/b]]></loc></url></urlset>'], 'sitemap.xml', { type: 'application/xml' })
    await a.request('/submit', { method: 'POST', body: form({ input: '', file: sitemap }) })
    expect(sent).toEqual([['https://one.example/', 'https://two.example/rss'], ['https://three.example/feed'], ['https://four.example/a?x=1&y=2', 'https://four.example/b']])
  })

  it('takes the first 1,000 and says so', async () => {
    const { app: a, sent } = app()
    const input = Array.from({ length: 1_200 }, (_, i) => `site${i}.example`).join('\n')
    const html = await (await a.request('/submit', { method: 'POST', body: form({ input }) })).text()
    expect(sent[0]).toHaveLength(1_000)
    expect(html).toContain('Only the first 1,000 were taken')
  })

  it('a crawler that does not answer is said plainly, with a 503', async () => {
    const r = await app({ down: true }).app.request('/submit', { method: 'POST', body: form({ input: 'example.com' }) })
    expect(r.status).toBe(503)
    expect(await r.text()).toContain('not taking submissions right now')
  })

  it('POST /api/submit speaks the shared submit contract', async () => {
    const { app: a, sent } = app()
    const r = await a.request('/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urls: ['example.com', 'https://example.com/feed', 'http://10.0.0.1/'] }) })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toMatchObject({ ok: true, queued: 2, statusUrl: 'https://pit.world/status' })
    expect(body.accepted.map((x: { kind: string }) => x.kind)).toEqual(['site', 'feed'])
    expect(body.rejected).toEqual([{ url: 'http://10.0.0.1/', error: 'blocked-host' }])
    expect(sent).toEqual([['https://example.com/', 'https://example.com/feed']])
    const single = await (await a.request('/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'one.example' }) })).json()
    expect(single.queued).toBe(1)
  })

  it('the footer and sitemap link it', async () => {
    const { app: a } = app()
    expect(await (await a.request('/about')).text()).toContain('href="/submit"')
    expect(await (await a.request('/sitemap.xml')).text()).toContain('https://pit.world/submit')
  })

  it('kind and private-address checks', () => {
    expect(guessKind('https://x.example/feed.json')).toBe('feed')
    for (const u of ['http://127.0.0.1/', 'http://[::1]/', 'http://192.168.1.1/', 'http://localhost/', 'http://db.internal/', 'http://intranet/']) expect(privateBySpelling(u)).toBe(true)
    expect(privateBySpelling('https://example.com/')).toBe(false)
  })
})
