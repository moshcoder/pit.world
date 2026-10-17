import { describe, expect, it } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import { parseBang } from '../src/bangs.ts'
import { main } from '../src/cli.ts'
import { PitClient } from '../src/client.ts'
import { esc } from '../src/html.ts'
import { looksLikeName, MOSHPIT_ROOT_SHA256, Registry } from '../src/moshpit.ts'
import { RateLimiter } from '../src/ratelimit.ts'
import { Cache, cleanHits, mergeResults, parseDataForSeo, parseSerper, search, SearchUnavailable } from '../src/search.ts'
import { pick } from '../src/promoted.ts'
import { createApp } from '../src/server.ts'
import { initialState, onKey } from '../src/tui.ts'

/** A fake upstream: Serper, the registry, and a record of every request made to the outside. */
function upstream(options: { serperFails?: boolean } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input)
    const headers: Record<string, string> = {}
    new Headers(init.headers ?? {}).forEach((value, key) => (headers[key] = value))
    calls.push({ url, headers, body: String(init.body ?? '') })
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (url.startsWith('https://google.serper.dev')) {
      if (options.serperFails) return json({ message: 'nope' }, 500)
      if (url.endsWith('/images'))
        return json({
          images: [
            { title: 'A cat', link: 'https://cats.example/page', domain: 'cats.example', thumbnailUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:abc' },
            { title: 'Tracker', link: 'https://x.example/', thumbnailUrl: 'https://tracker.example/pixel.gif' },
          ],
        })
      if (url.endsWith('/videos'))
        return json({
          videos: [{ title: 'Cat video', link: 'https://www.youtube.com/watch?v=x', source: 'YouTube', channel: 'Cats', duration: '3:01', imageUrl: 'https://i.ytimg.com/vi/x/hq.jpg' }],
        })
      return json({
        organic: [
          { title: 'Moshpit <b>network</b>', link: 'https://moshcode.sh/', snippet: 'An internet beside the internet' },
          { title: 'Evil', link: 'javascript:alert(1)', snippet: 'must not render' },
          { title: 'Dup', link: 'https://moshcode.sh/', snippet: 'duplicate' },
        ],
      })
    }
    if (url.startsWith('https://api.linkup.so')) return json({ results: [{ name: 'From Linkup', url: 'https://linkup.example/', content: 'fallback' }] })
    if (url.includes('/api/moshpit/resolve')) {
      const name = new URL(url).searchParams.get('name')
      if (name === 'chovy.hacker') return json({ name, registered: true, name_registered: true, target: 'dev.profullstack.com', mode: 'clearnet' })
      // The ending is claimed, the name under it is not.
      if (name === 'free.eggs') return json({ name, registered: true, name_registered: false })
      return json({ name, registered: false })
    }
    if (url.includes('/api/moshpit/tlds')) return json({ total: 17609, tlds: [] })
    if (url.includes('/api/moshpit/log')) {
      const since = new URL(url).searchParams.get('since')
      return since ? json({ entries: [{ seq: 1, tld: 'eggs', action: 'register', at: Date.now() - 60_000 }] }) : json({ total: 19547, entries: [] })
    }
    if (url.startsWith('https://pairux.com/api/live')) return json({ data: [{ join_code: 'abc123', subject: 'Cat stream', is_live: true, viewer_count: 4, channel_name: 'Chovy TV' }] })
    if (url.startsWith('https://pairux.com/api/channels/directory'))
      return json({ data: [{ handle: 'chovy', name: 'Chovy TV', is_live: false, subscriber_count: 12, description: 'Cats and code' }] })
    if (url.startsWith('https://nixamp.com/api/directory'))
      return json({ streams: [{ name: 'server1', url: 'https://server1.chovy.nixamp.com:4321/view/k', playing: true, nowPlaying: 'Cat radio', tracks: 5719, channels: ['CNN'] }] })
    if (url.startsWith('https://i.ytimg.com/')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } })
    if (url.includes('/api/moshpit/market')) return json({ tlds: [{ tld: 'stations', price_usd: 2, for_sale: true }] })
    return json({}, 404)
  }) as typeof fetch
  return { calls, fetchImpl }
}

function app(options: { serperFails?: boolean; limiter?: RateLimiter; keys?: Record<string, string> } = {}) {
  const up = upstream(options)
  const instance = createApp({
    keys: options.keys ?? { serper: 'SERPER-KEY', linkup: 'LINKUP-KEY' },
    registry: new Registry('https://registry.test', up.fetchImpl),
    fetch: up.fetchImpl,
    ...(options.limiter ? { limiter: options.limiter } : {}),
  })
  const request = (path: string, ip = '203.0.113.7') => instance.request(path, {}, { ip })
  return { ...up, request }
}

describe('search core', () => {
  it('keeps only http(s) links, once each', () => {
    expect(cleanHits([{ url: 'javascript:alert(1)' }, { url: 'https://a.example/x', title: '' }, { url: 'https://a.example/x' }])).toEqual([
      { url: 'https://a.example/x', title: 'a.example', description: '', host: 'a.example' },
    ])
    expect(parseSerper({ organic: [{ link: 'data:text/html,hi' }] })).toEqual([])
  })

  it('sends the provider the words and the key, nothing about the visitor', async () => {
    const { calls, fetchImpl } = upstream()
    await search('moshpit network', { serper: 'K' }, { fetch: fetchImpl })
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]!.body)).toEqual({ q: 'moshpit network', num: 10 })
    expect(Object.keys(calls[0]!.headers).sort()).toEqual(['content-type', 'x-api-key'])
  })

  it('falls back to the next provider, and caches in memory', async () => {
    const { calls, fetchImpl } = upstream({ serperFails: true })
    const cache = new Cache()
    const first = await search('x', { serper: 'K', linkup: 'L' }, { fetch: fetchImpl, cache })
    expect(first.provider).toBe('linkup')
    expect(first.failures[0]!.provider).toBe('serper')
    const second = await search('X', { serper: 'K', linkup: 'L' }, { fetch: fetchImpl, cache })
    expect(second.cached).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('says so when nothing is configured', async () => {
    await expect(search('x', {})).rejects.toBeInstanceOf(SearchUnavailable)
  })
})

describe('bangs and names', () => {
  it('finds a bang anywhere, and leaves unknown ones as words', () => {
    expect(parseBang('!gh hqtui')?.url).toBe('https://github.com/search?q=hqtui')
    expect(parseBang('rust lifetimes !so')?.url).toBe('https://stackoverflow.com/search?q=rust%20lifetimes')
    expect(parseBang('!pit chovy.hacker')?.url).toBe('https://pit.moshcode.sh/n/chovy.hacker')
    expect(parseBang('this is !important')).toBeNull()
  })

  it('recognises dotted names, not sentences', () => {
    expect(looksLikeName('chovy.hacker')).toBe(true)
    expect(looksLikeName('seo.rank.')).toBe(true)
    expect(looksLikeName('what is moshpit')).toBe(false)
    expect(looksLikeName('localhost')).toBe(false)
  })
})

describe('bug fixes (sweep 2026-10-17)', () => {
  it('lets the search form follow a bang to another site', async () => {
    const { request } = app()
    expect((await request('/')).headers.get('content-security-policy')).toContain("form-action 'self' https:")
  })

  it('says a free name under a claimed ending is free, on the page and in the CLI', async () => {
    const { request } = app()
    const html = await (await request('/search?q=free.eggs')).text()
    expect(html).toContain('Not registered yet')
    expect(html).not.toContain('Registered on the Moshpit network')
    const lines: string[] = []
    const client = new PitClient('https://pit.world', ((url: any) => request(new URL(String(url)).pathname + new URL(String(url)).search)) as typeof fetch)
    await main(['resolve', 'free.eggs'], { log: (t) => lines.push(t), error: (t) => lines.push(t) }, client)
    expect(lines.join('')).toContain('is not registered')
  })

  it('never cuts a query inside an emoji (was a 500)', async () => {
    const { request } = app()
    const res = await request('/search?q=' + 'a'.repeat(511) + encodeURIComponent('🤘'))
    expect(res.status).toBe(200)
  })

  it("answers a cache hit with the caller's own words, and does not say it was cached", async () => {
    const { request } = app()
    await request('/api/search?q=' + encodeURIComponent('Secret Phrase'))
    const second = await (await request('/api/search?q=' + encodeURIComponent('secret PHRASE'), '198.51.100.20')).json()
    expect(second.query).toBe('secret PHRASE')
    expect(second).not.toHaveProperty('cached')
  })

  it('serves robots.txt as text, unknown API paths as JSON, and clamps n', async () => {
    const { request } = app()
    expect((await request('/robots.txt')).headers.get('content-type')).toContain('text/plain')
    const missing = await request('/api/nope')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not found' })
    expect((await (await request('/api/search?q=x&n=0')).json()).results.length).toBeGreaterThan(0)
  })

  it('keeps -n on a bare-words search', async () => {
    let asked = ''
    const client = { search: async (_q: string, n: number) => ((asked = String(n)), { query: _q, provider: 'serper', results: [], moshpit: null }) } as unknown as PitClient
    await main(['hello', 'world', '-n', '2'], { log: () => {}, error: () => {} }, client)
    expect(asked).toBe('2')
  })
})

describe('the web app', () => {
  it('serves the home page with live network numbers, and no cookie', async () => {
    const { request } = app()
    const res = await request('/')
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain('17,609')
    expect(html).toContain('.eggs')
    expect(html).toContain('.stations')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'")
  })

  it('renders results escaped, without the javascript: link, plus the Moshpit card', async () => {
    const { request } = app()
    const html = await (await request('/search?q=chovy.hacker')).text()
    expect(html).toContain('Moshpit &lt;b&gt;network&lt;/b&gt;')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('dev.profullstack.com')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('<meta name="robots" content="noindex">')
  })

  it('redirects bangs without touching a provider', async () => {
    const { request, calls } = app()
    const res = await request('/search?q=' + encodeURIComponent('!w moshing'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://en.wikipedia.org/w/index.php?search=moshing')
    expect(calls).toHaveLength(0)
  })

  it('rate limits per visitor, and answers 429 with Retry-After', async () => {
    const { request } = app({ limiter: new RateLimiter(2, 0) })
    expect((await request('/api/search?q=a')).status).toBe(200)
    expect((await request('/api/search?q=b')).status).toBe(200)
    const third = await request('/api/search?q=c')
    expect(third.status).toBe(429)
    expect(third.headers.get('retry-after')).toBe('30')
    expect((await request('/api/search?q=d', '198.51.100.9')).status).toBe(200)
  })

  it('serves the JSON API, OpenSearch and suggestions', async () => {
    const { request } = app()
    const api = await (await request('/api/search?q=moshpit&n=5')).json()
    expect(api).toMatchObject({ query: 'moshpit', provider: 'serper', results: [{ url: 'https://moshcode.sh/' }] })
    expect(await (await request('/api/resolve?name=chovy.hacker')).json()).toMatchObject({ registered: true, target: 'dev.profullstack.com' })
    expect((await request('/api/resolve?name=not a name')).status).toBe(400)
    expect(await (await request('/opensearch.xml')).text()).toContain('https://pit.world/search?q={searchTerms}')
    expect(await (await request('/suggest?q=rust%20!g')).json()).toEqual(['rust !g', ['rust !g', 'rust !gh']])
  })

  it('degrades to a friendly page when every provider is down', async () => {
    const { request } = app({ keys: {} })
    const res = await request('/search?q=anything')
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('unavailable for a moment')
  })

  it('is an installable PWA whose worker never stores a search', async () => {
    const { request } = app()
    const home = await (await request('/')).text()
    expect(home).toContain('<link rel="manifest" href="/manifest.webmanifest">')
    const manifest = await request('/manifest.webmanifest')
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json')
    const json = await manifest.json()
    expect(json).toMatchObject({ start_url: '/', display: 'standalone', share_target: { action: '/search', params: { text: 'q' } } })
    for (const icon of json.icons) expect((await request(icon.src)).status).toBe(200)
    const sw = await request('/sw.js')
    expect(sw.headers.get('cache-control')).toBe('no-cache')
    const code = await sw.text()
    expect(code).not.toContain("'/search'")
    expect(code).not.toContain('/api/')
    expect(await (await request('/offline')).text()).toContain("You're offline")
  })

  it('links CSS and JS by content hash, so a deploy is never hidden behind a cache', async () => {
    const { request } = app()
    const home = await (await request('/')).text()
    const css = home.match(/href="(\/style\.css\?v=[0-9a-f]{10})"/)?.[1]
    const js = home.match(/src="(\/app\.js\?v=[0-9a-f]{10})"/)?.[1]
    expect(css).toBeDefined()
    expect(js).toBeDefined()
    const sheet = await request(css!)
    expect(sheet.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await sheet.text()).toContain('.newsletter')
    expect((await request(js!)).status).toBe(200)
    expect(await (await request('/sw.js')).text()).not.toContain("'pit-shell-v1'")
  })

  it('explains every way onto the Moshpit network, linked from the home page', async () => {
    const { request } = app()
    expect(await (await request('/')).text()).toContain('href="/connect"')
    const html = await (await request('/connect')).text()
    for (const id of ['moshcode', 'tron', 'browser', 'apple', 'windows', 'android', 'ca', 'check', 'undo']) expect(html).toContain(`id="${id}"`)
    expect(html).toContain('https://dns.moshcode.sh/dns-query')
    expect(html).toContain(MOSHPIT_ROOT_SHA256)
    expect(await (await request('/sitemap.xml')).text()).toContain('https://pit.world/connect')
  })

  it('serves the Moshpit root it documents, and an Apple profile carrying it', async () => {
    const { request } = app()
    const pem = await (await request('/moshpit-root-ca.crt')).text()
    const cert = new X509Certificate(pem)
    expect(cert.fingerprint256).toBe(MOSHPIT_ROOT_SHA256)
    expect(cert.subject).toContain('CN=Moshpit Root CA')
    const profile = await request('/moshpit.mobileconfig')
    expect(profile.headers.get('content-type')).toBe('application/x-apple-aspen-config')
    const xml = await profile.text()
    expect(xml).toContain('<string>https://dns.moshcode.sh/dns-query</string>')
    const der = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')
    expect(xml).toContain(`<data>${der}</data>`)
  })

  it('escapes everything it echoes', () => {
    expect(esc('<script>"\'&')).toBe('&lt;script&gt;&quot;&#39;&amp;')
  })
})

describe('categories: images, videos, music, live', () => {
  it('shows the tabs on every results page and keeps the tab on a new search', async () => {
    const { request } = app()
    const web = await (await request('/search?q=cats')).text()
    expect(web).toContain('<nav class="tabs"')
    expect(web).toContain('href="/search?q=cats&t=images"')
    const images = await (await request('/search?q=cats&t=images')).text()
    expect(images).toContain('<a href="/search?q=cats&t=images" aria-current="page">Images</a>')
    expect(images).toContain('<input type="hidden" name="t" value="images">')
  })

  it('shows images with thumbnails loaded through pit.world, never straight from Google', async () => {
    const { request, calls } = app()
    const html = await (await request('/search?q=cats&t=images')).text()
    expect(calls.some((c) => c.url === 'https://google.serper.dev/images')).toBe(true)
    expect(html).toContain('src="/img?u=https%3A%2F%2Fencrypted-tbn0.gstatic.com%2Fimages%3Fq%3Dtbn%3Aabc"')
    // A thumbnail host outside the allowlist gets no <img> at all.
    expect(html).not.toContain('tracker.example/pixel')
    expect(html).not.toMatch(/src="https:\/\//)
  })

  it('puts PairUX first, then nixamp, above live results', async () => {
    const { request, calls } = app()
    const html = await (await request('/search?q=cats&t=live')).text()
    expect(calls.find((c) => c.url === 'https://google.serper.dev/videos')?.body).toContain('cats live stream')
    const pairux = html.indexOf('pairux.com/l/abc123')
    const nixamp = html.indexOf('server1.chovy.nixamp.com')
    const web = html.indexOf('youtube.com/watch')
    expect(pairux).toBeGreaterThan(0)
    expect(pairux).toBeLessThan(nixamp)
    expect(nixamp).toBeLessThan(web)
    expect(html).toContain('https://pairux.com/@chovy')
  })

  it('keeps room for nixamp however many PairUX channels there are', () => {
    const channels = Array.from({ length: 60 }, (_, i) => ({ source: 'pairux' as const, title: `Channel ${i}`, url: `https://pairux.com/@c${i}`, line: '', live: false }))
    const stream = { source: 'nixamp' as const, title: 'server1', url: 'https://server1.chovy.nixamp.com:4321/view/k', line: '5,719 on demand', live: false }
    const live = pick([...channels, stream], 'coding', 'live')
    expect(live.at(-1)).toEqual(stream)
    expect(live[0]!.source).toBe('pairux')
    expect(pick([...channels, stream], 'coding', 'videos')).toEqual([stream])
  })

  it('keeps music to music sites and to nixamp', async () => {
    const { request, calls } = app()
    const html = await (await request('/search?q=cats&t=music')).text()
    expect(calls.find((c) => c.url === 'https://google.serper.dev/search')?.body).toContain('site:bandcamp.com')
    expect(html).toContain('Listen on nixamp')
    expect(html).not.toContain('pairux.com/l/abc123')
  })

  it('serves the same through the API', async () => {
    const { request } = app()
    const json: any = await (await request('/api/search?q=cats&t=videos')).json()
    expect(json.type).toBe('videos')
    expect(json.results[0]).toMatchObject({ url: 'https://www.youtube.com/watch?v=x', duration: '3:01' })
    expect(json.promoted[0].url).toContain('pairux.com')
  })

  it('proxies only allowlisted thumbnail hosts', async () => {
    const { request } = app()
    const ok = await request(`/img?u=${encodeURIComponent('https://i.ytimg.com/vi/x/hq.jpg')}`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/jpeg')
    for (const bad of ['https://tracker.example/x.png', 'http://i.ytimg.com/vi/x.jpg', 'https://127.0.0.1/x', 'https://i.ytimg.com:8443/x', 'nope']) {
      expect((await request(`/img?u=${encodeURIComponent(bad)}`)).status).toBe(400)
    }
  })

  it('treats an unknown tab as All', async () => {
    const { request } = app()
    const html = await (await request('/search?q=cats&t=evil')).text()
    expect(html).toContain('aria-current="page">All</a>')
  })
})

describe('CLI and TUI', () => {
  const client = () => {
    const { request } = app()
    return new PitClient('https://pit.test', (async (input: any) => request(String(input).replace('https://pit.test', ''))) as typeof fetch)
  }

  it('searches and resolves through the API', async () => {
    const lines: string[] = []
    const out = { log: (t: string) => lines.push(t), error: (t: string) => lines.push(`ERR ${t}`) }
    expect(await main(['search', 'chovy.hacker'], out, client())).toBe(0)
    expect(lines.join('\n')).toContain('◉ Moshpit: chovy.hacker → dev.profullstack.com')
    expect(lines.join('\n')).toContain('https://moshcode.sh/')
    lines.length = 0
    expect(await main(['resolve', 'chovy.hacker', '--json'], out, client())).toBe(0)
    expect(JSON.parse(lines[0]!)).toMatchObject({ registered: true })
    lines.length = 0
    expect(await main(['network'], out, client())).toBe(0)
    expect(lines[0]).toContain('17,609 endings')
  })

  it('handles keys: type, search, move, open, quit', () => {
    const state = initialState()
    for (const ch of 'hi') expect(onKey(state, { name: ch, key: ch, char: ch })).toBeNull()
    expect(state.query).toBe('hi')
    expect(onKey(state, { name: 'enter', key: 'enter' })).toBe('search')
    state.result = { query: 'hi', provider: 'serper', cached: false, moshpit: null, results: [{ url: 'https://a/', title: 'a', description: '', host: 'a' }, { url: 'https://b/', title: 'b', description: '', host: 'b' }] }
    expect(onKey(state, { name: 'down', key: 'down' })).toBeNull()
    expect(state.typing).toBe(false)
    onKey(state, { name: 'down', key: 'down' })
    expect(state.selected).toBe(1)
    expect(onKey(state, { name: 'enter', key: 'enter' })).toBe('open')
    expect(onKey(state, { name: 'q', key: 'q', char: 'q' })).toBe('quit')
    expect(onKey(state, { name: 'c', key: 'ctrl+c' })).toBe('quit')
  })
})

describe('Google + Bing', () => {
  const serper = { organic: [{ title: 'Both', link: 'https://both.example/', snippet: 'g' }, { title: 'Google only', link: 'https://g.example/', snippet: 'g' }] }
  const bing = {
    status_code: 20000,
    tasks: [{ status_code: 20000, result: [{ items: [
      { type: 'organic', title: 'Bing only', url: 'https://b.example/', description: 'b' },
      { type: 'organic', title: 'Both', url: 'https://www.both.example', description: 'a longer snippet from bing' },
      { type: 'paid', title: 'Ad', url: 'https://ad.example/' },
    ] }] }],
  }
  const fake = (options: { bingDelay?: number; bingFails?: boolean } = {}) =>
    (async (input: any, init: any = {}) => {
      const url = String(input)
      if (url.startsWith('https://google.serper.dev')) return Response.json(serper)
      if (url.startsWith('https://api.dataforseo.com')) {
        expect(new Headers(init.headers).get('authorization')).toBe(`Basic ${Buffer.from('login:pw').toString('base64')}`)
        if (options.bingDelay) await new Promise((r) => setTimeout(r, options.bingDelay))
        return options.bingFails ? Response.json({ status_code: 40100, tasks: [{ status_code: 40100 }] }) : Response.json(bing)
      }
      return Response.json({ results: [{ name: 'L', url: 'https://linkup.example/' }] })
    }) as typeof fetch

  it('parses DataForSEO organic results only', () => {
    expect(parseDataForSeo(bing).map((h) => h.url)).toEqual(['https://b.example/', 'https://www.both.example'])
  })

  it('merges both engines, puts agreement first, and tags the source', async () => {
    const result = await search('q', { serper: 'K', bing: 'login:pw' }, { fetch: fake() })
    expect(result.provider).toBe('serper+bing')
    expect(result.hits[0]).toMatchObject({ title: 'Both', sources: ['serper', 'bing'], description: 'a longer snippet from bing' })
    expect(result.hits.map((h) => h.title).sort()).toEqual(['Bing only', 'Both', 'Google only'])
  })

  it('serves Google alone when Bing fails, and does not cache the partial page', async () => {
    const cache = new Cache()
    const result = await search('q', { serper: 'K', bing: 'login:pw' }, { fetch: fake({ bingFails: true }), cache })
    expect(result.provider).toBe('serper')
    expect(result.failures[0]).toMatchObject({ provider: 'bing' })
    expect(cache.get('10:q')).toBeNull()
  })

  it('does not wait long for a slow Bing', async () => {
    const started = Date.now()
    const result = await search('q', { serper: 'K', bing: 'login:pw' }, { fetch: fake({ bingDelay: 6_000 }) })
    expect(result.provider).toBe('serper')
    expect(Date.now() - started).toBeLessThan(4_000)
  }, 10_000)

  it('dedupes across www and trailing slashes', () => {
    const merged = mergeResults(
      [
        { provider: 'serper', hits: [{ url: 'https://www.a.example/x/', title: 'A', description: '', host: 'a.example' }] },
        { provider: 'bing', hits: [{ url: 'https://a.example/x', title: 'A', description: 'more', host: 'a.example' }] },
      ],
      10,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]!.sources).toEqual(['serper', 'bing'])
  })
})

describe('/build', () => {
  it('hands the idea to chovy.com on the Starter plan, credited to pit.world, linked from home', async () => {
    const { request } = app()
    const html = await (await request('/build')).text()
    expect(html).toContain('action="https://chovy.com/start"')
    expect(html).toContain('name="plan" value="starter"')
    expect(html).toContain('name="ref" value="pitworld"')
    expect(html).toContain('$49')
    expect(html).toContain('$2')
    expect(await (await request('/')).text()).toContain('href="/build"')
    expect(await (await request('/sitemap.xml')).text()).toContain('https://pit.world/build')
  })
})
