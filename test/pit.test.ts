import { describe, expect, it } from 'bun:test'
import { parseBang } from '../src/bangs.ts'
import { main } from '../src/cli.ts'
import { PitClient } from '../src/client.ts'
import { esc } from '../src/html.ts'
import { looksLikeName, Registry } from '../src/moshpit.ts'
import { RateLimiter } from '../src/ratelimit.ts'
import { Cache, cleanHits, parseSerper, search, SearchUnavailable } from '../src/search.ts'
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
      return json(name === 'chovy.hacker' ? { name, registered: true, name_registered: true, target: 'dev.profullstack.com', mode: 'clearnet' } : { name, registered: false })
    }
    if (url.includes('/api/moshpit/tlds')) return json({ total: 17609, tlds: [] })
    if (url.includes('/api/moshpit/log')) {
      const since = new URL(url).searchParams.get('since')
      return since ? json({ entries: [{ seq: 1, tld: 'eggs', action: 'register', at: Date.now() - 60_000 }] }) : json({ total: 19547, entries: [] })
    }
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

  it('escapes everything it echoes', () => {
    expect(esc('<script>"\'&')).toBe('&lt;script&gt;&quot;&#39;&amp;')
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
