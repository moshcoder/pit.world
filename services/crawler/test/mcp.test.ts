import { describe, expect, test } from 'bun:test'
import { configFromEnv } from '../src/config.ts'
import { createCrawler } from '../src/crawler.ts'
import { MemoryFrontier } from '../src/frontier.ts'
import { endpointsIn, handshake, type McpJob, mcpCandidates, mcpRecord, searchMcps } from '../src/mcp.ts'

const INIT = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'acme', version: '1.0.0' }, instructions: 'Acme tools.' }

/** A scripted MCP server: every method it was asked, kept in `methods`. */
function server(overrides: { sse?: boolean } = {}) {
  const methods: string[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const msg = JSON.parse(String(init?.body))
    methods.push(msg.method)
    if (!msg.id) return new Response(null, { status: 202 })
    const result = msg.method === 'initialize' ? INIT : { tools: [{ name: 'search', description: 'Find things' }, { description: 'no name' }] }
    const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })
    return overrides.sse ? new Response(`event: message\ndata: ${body}\n\n`, { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' } }) : new Response(body, { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetchImpl, methods }
}

const proveWith = (fetchImpl: typeof fetch) => handshake('https://acme.example/mcp', { userAgent: 'pitbot', resolver: async () => true, fetch: fetchImpl })

describe('finding candidates', () => {
  test('links, config blocks and CLI lines, not docs and not listings', () => {
    const html = `
      <a href="https://acme.example/mcp">connect</a>
      <pre>{ "mcpServers": { "x": { "url": "https://api.other.example/v1/mcp" } } }</pre>
      <code>claude mcp add --transport http y https://mcp.third.example/</code>
      <script>{"u":"https:\\/\\/json.example\\/mcp"}</script>
      <a href="https://github.com/acme/mcp">source</a>
      <a href="https://mcp.docs.example/guide/start">docs</a>
      <a href="https://acme.example/blog/what-is-mcp">post</a>
      <a href="http://plain.example/mcp">not https</a>
      <img src="https://cdn.example/mcp.png">`
    expect(mcpCandidates(html).sort()).toEqual(['https://acme.example/mcp', 'https://api.other.example/v1/mcp', 'https://json.example/mcp', 'https://mcp.third.example/'])
  })
  test('a page that never says mcp costs nothing, and one page cannot queue a thousand', () => {
    expect(mcpCandidates('<a href="https://acme.example/">home</a>')).toEqual([])
    const flood = Array.from({ length: 50 }, (_, i) => `https://s${i}.example/mcp`).join(' ')
    expect(mcpCandidates(flood)).toHaveLength(10)
  })
  test('descriptors name their endpoint in several ways', () => {
    expect(endpointsIn({ openmcp: '0.1', mcp: 'https://a.example/mcp' })).toEqual(['https://a.example/mcp'])
    expect(endpointsIn({ remotes: [{ url: 'https://b.example/sse' }] })).toEqual(['https://b.example/sse'])
    expect(endpointsIn({ mcp: 'http://insecure.example/mcp' })).toEqual([])
    expect(endpointsIn('nope')).toEqual([])
  })
})

describe('the handshake', () => {
  test('proves a server, over JSON or an event stream, and only ever lists its tools', async () => {
    for (const sse of [false, true]) {
      const { fetchImpl, methods } = server({ sse })
      const proof = await proveWith(fetchImpl)
      expect(proof).toMatchObject({ serverName: 'acme', version: '1.0.0', auth: 'none' })
      expect(proof!.tools).toEqual([{ name: 'search', description: 'Find things' }])
      expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    }
  })
  test('a web page at /mcp, a 404 or a redirect is not a server', async () => {
    const html = (async () => new Response('<html>MCP docs</html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    expect(await proveWith(html)).toBeNull()
    expect(await proveWith((async () => new Response('no', { status: 404 })) as unknown as typeof fetch)).toBeNull()
    expect(await proveWith((async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })) as unknown as typeof fetch)).toBeNull()
  })
  test('JSON-RPC that is not an MCP initialize is not a server', async () => {
    const other = (async () => Response.json({ jsonrpc: '2.0', id: 1, result: { ok: true } })) as unknown as typeof fetch
    expect(await proveWith(other)).toBeNull()
  })
  test("a 401 counts only with MCP's own auth challenge", async () => {
    const challenge = (async () => new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://acme.example/.well-known/oauth-protected-resource"' } })) as unknown as typeof fetch
    expect(await proveWith(challenge)).toMatchObject({ auth: 'required', tools: [] })
    expect(await proveWith((async () => new Response('', { status: 401, headers: { 'www-authenticate': 'Basic' } })) as unknown as typeof fetch)).toBeNull()
  })
  test('an address off the public internet is never asked', async () => {
    let asked = false
    const proof = await handshake('https://internal.example/mcp', {
      userAgent: 'pitbot',
      resolver: async () => false,
      fetch: (async () => {
        asked = true
        return new Response('')
      }) as unknown as typeof fetch,
    })
    expect(proof).toBeNull()
    expect(asked).toBe(false)
  })
})

describe('the crawl', () => {
  const setup = (nichedb = true) => {
    const config = { ...configFromEnv({ ...(nichedb ? { NICHEDB_API_KEY: 'k' } : {}), CRAWL_HOST_DELAY_MS: '0' }) }
    const frontier = new MemoryFrontier(1000)
    const jobs: McpJob[] = []
    const pushed: string[] = []
    const { fetchImpl } = server()
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/api/v1/mcp/records')) {
        pushed.push(String(init?.body))
        return Response.json({ accepted: 1 })
      }
      if (u.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /private/\n', { headers: { 'content-type': 'text/plain' } })
      if (init?.method === 'POST') return fetchImpl(url, init)
      return new Response('', { status: 404 })
    }) as typeof fetch
    const noop = async () => {}
    const crawler = createCrawler({ config, frontier, fetch: fake, resolver: async () => true, enqueue: { sites: noop, pages: noop, render: noop, mcp: async (j) => void jobs.push(...j) } })
    return { crawler, frontier, jobs, pushed }
  }

  test('a proved server is stored and sent to nichedb; each address is asked once a cycle', async () => {
    const { crawler, frontier, pushed } = setup()
    const job = { endpoint: 'https://acme.example/mcp', foundOn: 'https://acme.example/docs' }
    await crawler.probeMcp(job)
    const [kept] = await frontier.listMcp()
    expect(kept).toMatchObject({ mcp: job.endpoint, name: 'acme', foundOn: job.foundOn })
    expect(JSON.parse(pushed[0]!).records[0].mcp).toBe(job.endpoint)
    expect(await frontier.claimMcp(job.endpoint, 1_000)).toBe(true)
    expect(await frontier.claimMcp(job.endpoint, 1_000)).toBe(false)
  })

  test('robots.txt keeps pitbot off a disallowed endpoint', async () => {
    const { crawler, frontier } = setup()
    await crawler.probeMcp({ endpoint: 'https://acme.example/private/mcp', foundOn: 'https://acme.example/' })
    expect(await frontier.listMcp()).toEqual([])
  })
})

test('search matches tools too, and most tools come first', () => {
  const make = (name: string, tools: string[]) => mcpRecord({ endpoint: `https://${name}.example/mcp`, foundOn: '' }, { serverName: name, version: '', protocolVersion: '', description: '', tools: tools.map((t) => ({ name: t, description: null })), auth: 'none' })
  const all = [make('small', ['weather']), make('big', ['weather', 'tides'])]
  expect(searchMcps(all, 'weather').map((r) => r.name)).toEqual(['big', 'small'])
  expect(searchMcps(all, 'tides').map((r) => r.name)).toEqual(['big'])
  expect(searchMcps(all, '')).toHaveLength(2)
})
