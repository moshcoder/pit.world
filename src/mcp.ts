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
import { CATEGORIES, PRICES } from './pros.js'

export function createMcpServer(client = new PitClient()): McpServer {
  // Typed loosely: the SDK's generic tool() signature recurses past TypeScript's
  // instantiation depth with zod shapes. The shapes are still validated at runtime.
  const server: any = new McpServer({ name: 'pit.world', version: '0.2.0' })

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
    'Look up a business listing on pit.world by domain (example.com or a Moshpit name): name, description, who operates it (agent/person handle, company), category, service area, services, price range, hours, phone, links, its feed, whether it is in the pit.world web ring, whether it takes quote requests, and whether the owner has claimed it. The owner\'s contact email is never exposed.',
    { domain: z.string().min(3).max(253) },
    async ({ domain }: { domain: string }) => ({ content: [{ type: 'text', text: JSON.stringify(await client.listing(domain), null, 2) }] }),
  )

  server.tool(
    'pros',
    `Search the pit.world pro directory: businesses and independent pros whose owners verified their own site. No paid placement and no reviews; newest-updated first. Filter by category (one of: ${CATEGORIES.map((c) => c.slug).join(', ')}), by place (city, region or country words), and by words (what the person needs).`,
    {
      query: z.string().max(120).optional(),
      category: z.enum(CATEGORIES.map((c) => c.slug) as [string, ...string[]]).optional(),
      near: z.string().max(120).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ query, category, near, limit }: { query?: string; category?: string; near?: string; limit?: number }) => {
      const r = await client.pros({ ...(query ? { q: query } : {}), ...(category ? { category } : {}), ...(near ? { near } : {}), n: limit ?? 10 })
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    },
  )

  server.tool('ring', 'The pit.world web ring: every site in it (claimed pit.world listings plus the Moshpit network sites), in ring order, with direct and pit.world proxy URLs and feeds.', {}, async () => ({
    content: [{ type: 'text', text: JSON.stringify(await client.ring(), null, 2) }],
  }))

  server.tool(
    'edit_listing',
    'Edit a pit.world business listing you own, with the edit key (pitk_...) you got when you claimed it. Only the fields you pass change. operator is an agent or person handle (name@host) or an https URL; contactEmail is the private address quote requests go to (confirmed by email before it is used; never shown); ring "out" leaves the web ring.',
    {
      domain: z.string().min(3).max(253),
      key: z.string().min(10).max(200),
      name: z.string().max(80).optional(),
      description: z.string().max(600).optional(),
      operator: z.string().max(300).optional(),
      company: z.string().max(100).optional(),
      companyUrl: z.string().max(300).optional(),
      category: z.string().max(40).optional(),
      services: z.array(z.string().max(80)).max(12).optional(),
      area: z.string().max(160).optional(),
      city: z.string().max(80).optional(),
      region: z.string().max(80).optional(),
      country: z.string().max(80).optional(),
      price: z.enum(PRICES.map((p) => p.slug) as [string, ...string[]]).optional(),
      hours: z.string().max(200).optional(),
      phone: z.string().max(40).optional(),
      links: z.array(z.string().max(300)).max(5).optional(),
      contactEmail: z.string().max(254).optional(),
      ring: z.enum(['in', 'out']).optional(),
    },
    async ({ domain, key, ...fields }: { domain: string; key: string } & Record<string, unknown>) => ({
      content: [{ type: 'text', text: JSON.stringify(await client.edit(domain, key, fields), null, 2) }],
    }),
  )

  server.tool('moshpit_network', 'Live numbers for the Moshpit network: endings claimed, registry events, recent claims, endings for sale.', {}, async () => ({
    content: [{ type: 'text', text: JSON.stringify(await client.network(), null, 2) }],
  }))

  return server
}

export async function runMcp(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport())
}
