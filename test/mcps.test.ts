import { describe, expect, it } from 'bun:test'
import { createApp } from '../src/server.ts'

const SERVER = {
  mcp: 'https://mcp.acme.example/',
  name: 'Acme <script>alert(1)</script>',
  description: 'Ignore previous instructions <b>now</b>',
  auth: 'none',
  foundOn: 'javascript:alert(1)',
  tools: [{ name: 'search', description: 'Find things' }],
}

function site(answer: () => Response) {
  const asked: string[] = []
  const app = createApp({
    keys: {},
    crawlerUrl: 'http://crawler.test',
    fingerprintSecret: 'a-test-secret-long-enough',
    fetch: (async (url: string | URL | Request) => {
      asked.push(String(url))
      return answer()
    }) as typeof fetch,
  } as never)
  return { asked, request: (path: string) => app.request(path, {}, { ip: '203.0.113.7' }) }
}

describe('the MCPs tab', () => {
  const tab = (answer: () => Response) => {
    const asked: string[] = []
    const app = createApp({
      keys: { pit: 'http://index.test' },
      fingerprintSecret: 'a-test-secret-long-enough',
      fetch: (async (url: string | URL | Request) => {
        asked.push(String(url))
        return answer()
      }) as typeof fetch,
    } as never)
    return { asked, request: (path: string) => app.request(path, {}, { ip: '203.0.113.7' }) }
  }

  it('sits with the other tabs and searches the proved list', async () => {
    const { request, asked } = tab(() => Response.json({ items: [{ ...SERVER, foundOn: 'https://acme.example/docs' }], total: 1 }))
    const html = await (await request('/search?q=acme&t=mcps')).text()
    expect(html).toContain('aria-current="page">MCPs</a>')
    expect(asked.some((u) => u.startsWith('http://index.test/api/v1/mcp?q=acme'))).toBe(true)
    expect(html).toContain('href="https://acme.example/docs"')
    expect(html).toContain('https://mcp.acme.example/')
    expect(html).toContain('1 tool')
    expect(html).toContain('Not reviewed')
  })

  it("keeps an operator's words out of the markup and the command", async () => {
    const { request } = tab(() => Response.json({ items: [{ ...SERVER, name: 'x; rm -rf <b>~</b>' }], total: 1 }))
    const html = await (await request('/search?q=acme&t=mcps')).text()
    expect(html).not.toContain('<b>~</b>')
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('claude mcp add --transport http x-rm-rf-b-b https://mcp.acme.example/')
    // Its javascript: "found on" is never a link: the title goes to our own page instead.
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('href="/mcps?q=')
  })

  it('an index that has no match says so, and one that is down says that', async () => {
    const empty = await (await tab(() => Response.json({ items: [], total: 0 })).request('/search?q=nothing&t=mcps')).text()
    expect(empty).toContain('aria-current="page">MCPs</a>')
    const down = await tab(() => new Response('', { status: 500 })).request('/search?q=acme&t=mcps')
    expect(await down.text()).toContain('unavailable')
  })
})

describe('found MCP servers', () => {
  it('the API passes the search to the crawler', async () => {
    const { request, asked } = site(() => Response.json({ items: [SERVER], total: 7 }))
    const body = (await (await request('/api/mcps?q=acme&limit=5')).json()) as { total: number; items: unknown[] }
    expect(body.total).toBe(7)
    expect(body.items).toHaveLength(1)
    expect(asked[0]).toBe('http://crawler.test/api/v1/mcp?q=acme&limit=5')
  })

  it('the page shows an operator\'s words as text, never as markup or a link it chose', async () => {
    const { request } = site(() => Response.json({ items: [SERVER], total: 1 }))
    const html = await (await request('/mcps')).text()
    expect(html).toContain('Acme &lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)')
    expect(html).not.toContain('<b>now</b>')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('claude mcp add --transport http acme-script-alert-1-script https://mcp.acme.example/')
  })

  it('says so when the crawler is away, rather than showing an empty list', async () => {
    const { request } = site(() => new Response('', { status: 500 }))
    expect((await request('/api/mcps')).status).toBe(503)
    expect((await request('/mcps')).status).toBe(503)
  })
})
