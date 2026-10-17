/**
 * `pit mcp`: pit.world as an MCP server on stdio, so an agent can search the
 * web privately and look up Moshpit names.
 *
 *   claude mcp add pit -- pit mcp
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { PitClient } from './client.js'

export function createMcpServer(client = new PitClient()): McpServer {
  // Typed loosely: the SDK's generic tool() signature recurses past TypeScript's
  // instantiation depth with zod shapes. The shapes are still validated at runtime.
  const server: any = new McpServer({ name: 'pit.world', version: '0.1.2' })

  server.tool(
    'search',
    'Search the web through pit.world: no logs, no tracking. Also resolves Moshpit names (label.ending) through the Moshpit registry.',
    { query: z.string().min(1).max(512), limit: z.number().int().min(1).max(20).optional() },
    async ({ query, limit }: { query: string; limit?: number }) => {
      const result = await client.search(query, limit ?? 10)
      const lines = result.results.map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}${hit.description ? `\n   ${hit.description}` : ''}`)
      const mosh = result.moshpit?.nameRegistered ? `Moshpit name ${result.moshpit.name} is registered${result.moshpit.target ? ` (points at ${result.moshpit.target})` : ''}: ${result.moshpit.page}\n\n` : ''
      return { content: [{ type: 'text', text: `${mosh}${lines.join('\n') || 'No results.'}` }] }
    },
  )

  server.tool(
    'moshpit_resolve',
    'Look up a Moshpit network name (for example chovy.hacker) in the Moshpit registry: whether it is registered and where it points.',
    { name: z.string().min(3).max(253) },
    async ({ name }: { name: string }) => ({ content: [{ type: 'text', text: JSON.stringify(await client.resolve(name), null, 2) }] }),
  )

  server.tool(
    'listing',
    'Look up a business listing on pit.world by domain (example.com or a Moshpit name): name, description, hours, address, phone, links, and whether the owner has claimed it.',
    { domain: z.string().min(3).max(253) },
    async ({ domain }: { domain: string }) => ({ content: [{ type: 'text', text: JSON.stringify(await client.listing(domain), null, 2) }] }),
  )

  server.tool('moshpit_network', 'Live numbers for the Moshpit network: endings claimed, registry events, recent claims, endings for sale.', {}, async () => ({
    content: [{ type: 'text', text: JSON.stringify(await client.network(), null, 2) }],
  }))

  return server
}

export async function runMcp(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport())
}
