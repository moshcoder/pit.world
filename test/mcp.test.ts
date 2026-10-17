/**
 * `pit mcp` over real stdio, against an in-process pit.world: what an agent sees.
 */
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createApp } from '../src/server.ts'
import { Registry } from '../src/moshpit.ts'

let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  const fake = (async (input: any) => {
    const url = String(input)
    if (url.includes('/api/moshpit/resolve')) return Response.json({ name: 'chovy.hacker', registered: true, name_registered: true, target: 'dev.profullstack.com' })
    if (url.startsWith('https://google.serper.dev')) return Response.json({ organic: [{ title: 'hqtui', link: 'https://hqtui.com/', snippet: 'terminal UI' }] })
    return Response.json({ total: 1, entries: [], tlds: [] })
  }) as typeof fetch
  const app = createApp({ keys: { serper: 'K' }, registry: new Registry('https://registry.test', fake), fetch: fake })
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => app.fetch(request, { ip: '127.0.0.9' }) })
})
afterAll(() => server.stop(true))

it('lists the tools and answers search and moshpit_resolve', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../bin/pit', import.meta.url).pathname, 'mcp'],
    env: { ...process.env, PIT_URL: `http://127.0.0.1:${server.port}` } as Record<string, string>,
  })
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(transport)
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toEqual(['moshpit_network', 'moshpit_resolve', 'search'])
    const resolved: any = await client.callTool({ name: 'moshpit_resolve', arguments: { name: 'chovy.hacker' } })
    expect(resolved.content[0].text).toContain('dev.profullstack.com')
    const searched: any = await client.callTool({ name: 'search', arguments: { query: 'hqtui', limit: 3 } })
    expect(searched.content[0].text).toContain('https://hqtui.com/')
  } finally {
    await client.close()
  }
}, 20_000)
