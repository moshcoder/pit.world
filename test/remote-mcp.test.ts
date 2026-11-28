import { afterEach, describe, expect, it } from 'bun:test'
import { createApp } from '../src/server.ts'
import { createMcpServer, PUBLIC_MCP_DENY } from '../src/mcp.ts'

const rpc = (method: string, params: unknown = {}, id = 1) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
})

const toolNames = (server: any): string[] => Object.keys(server._registeredTools ?? {})

describe('remote MCP at /mcp', () => {
  const saved = process.env.PIT_ADMIN_TOKEN
  afterEach(() => {
    if (saved === undefined) delete process.env.PIT_ADMIN_TOKEN
    else process.env.PIT_ADMIN_TOKEN = saved
  })

  it('the public server offers no writes and no promo tools, even with an admin token set', () => {
    process.env.PIT_ADMIN_TOKEN = 'x'
    const pub = toolNames(createMcpServer(undefined, { public: true }))
    expect(pub).toContain('search')
    expect(pub).toContain('summarize')
    for (const name of PUBLIC_MCP_DENY) expect(pub).not.toContain(name)
    expect(pub.some((n) => n.startsWith('promo_'))).toBe(false)
    const local = toolNames(createMcpServer())
    expect(local).toContain('edit_listing')
    expect(local).toContain('promo_campaigns')
  })

  it('answers initialize and tools/list over Streamable HTTP, statelessly', async () => {
    const app = createApp({ keys: {}, fetch: (async () => new Response('{}')) as any })
    const init = await app.request('/mcp', rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }))
    expect(init.status).toBe(200)
    expect(init.headers.get('mcp-session-id')).toBeNull()
    expect(((await init.json()) as any).result.serverInfo.name).toBe('pit.world')
    const list = await app.request('/mcp', rpc('tools/list', {}, 2))
    expect(list.status).toBe(200)
    const names = ((await list.json()) as any).result.tools.map((t: any) => t.name)
    expect(names).toContain('search')
    expect(names).not.toContain('edit_listing')
    expect((await app.request('/mcp')).status).toBe(405)
  })
})
