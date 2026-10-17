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
  const server: any = new McpServer({ name: 'pit.world', version: '0.5.0' })

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
    `Search the pit.world pro directory: businesses and independent pros. claimed=true means the owner verified their own site; seeded=true means pit.world listed it from public records (e.g. a CSLB contractor license, shown in license) and the owner has not claimed it yet. No paid placement and no reviews; a few featured listings first, then verified owners by latest edit. Filter by category (one of: ${CATEGORIES.map((c) => c.slug).join(', ')}), by place (city, region or country words), and by words (what the person needs).`,
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

  // Promotion campaigns, for operators: the same API (and so the same timing rules, budgets and
  // recipient checks) as the CLI and the dashboard. Only offered when PIT_ADMIN_TOKEN is in the environment.
  if (process.env.PIT_ADMIN_TOKEN) registerPromoTools(server, client)
  return server
}

function registerPromoTools(server: any, client: PitClient): void {
  const promo = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, headers?: Record<string, string>) =>
    client.promo(method, path, body, headers).then((r) => ({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) }] }))
  const e = encodeURIComponent
  const cid = { campaign: z.string().min(3).max(80).describe('promotion campaign id (pcm_...) or its OutreachGraph campaign id') }
  const member = { ...cid, domain: z.string().min(3).max(253) }
  server.tool('promo_campaigns', 'Promotion campaigns (operators): list them.', {}, () => promo('GET', '/campaigns'))
  server.tool('promo_overview', 'A promotion campaign at a glance: members by state, outreach holds, placements by state, measurement windows, reports, drafts, spend.', cid, ({ campaign }: any) => promo('GET', `/campaigns/${e(campaign)}`))
  server.tool('promo_roster', 'The campaign roster: every business, its source lead ids, website, listing URL, verification status and planned action, plus unresolved leads. Private (contains lead ids).', { ...cid, limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() }, ({ campaign, limit, offset }: any) =>
    promo('GET', `/campaigns/${e(campaign)}/businesses?limit=${limit ?? 500}&offset=${offset ?? 0}`),
  )
  server.tool('promo_import', 'Import a complete or partial campaign snapshot (the JSON scripts/outreachgraph-campaign-export.sh writes). dryRun shows every row disposition without writing. Re-importing the same snapshot changes nothing.', { ...cid, snapshot: z.any(), dryRun: z.boolean().optional() }, ({ campaign, snapshot, dryRun }: any) =>
    promo('POST', `/campaigns/${e(campaign)}/imports${dryRun ? '?dryRun=1' : ''}`, { snapshot }, dryRun ? {} : { 'idempotency-key': `import-${snapshot?.snapshotAt ?? Date.now()}` }),
  )
  server.tool('promo_member', 'One campaign business: leads, outreach hold, verification, windows.', member, ({ campaign, domain }: any) => promo('GET', `/campaign-businesses/${e(`${campaign}:${domain}`)}`))
  server.tool(
    'promo_update_member',
    'Resolve a campaign business: displayOrder (campaign order, null to clear), priority (false removes its directory priority without touching the listing), priorContact (a documented earlier contact, which makes the draft a follow-up), holdAttestation (an operator attests upstream outreach is held).',
    { ...member, displayOrder: z.number().int().nullable().optional(), priority: z.boolean().optional(), priorContact: z.string().max(500).optional(), holdAttestation: z.string().max(500).optional() },
    ({ campaign, domain, ...changes }: any) => promo('PATCH', `/campaign-businesses/${e(`${campaign}:${domain}`)}`, changes),
  )
  server.tool('promo_exclude', 'Exclude a business (domain) or a lead (lead id) from the campaign, with a reason.', { ...cid, subject: z.string().min(3), reason: z.string().min(3) }, ({ campaign, subject, reason }: any) => promo('POST', `/campaigns/${e(campaign)}/exclusions`, { subject, reason }))
  server.tool('promo_preview', 'Preview a launch: which businesses launch, which are blocked and why, every planned post with its text and time, and the version launch needs.', cid, ({ campaign }: any) => promo('POST', `/campaigns/${e(campaign)}/preview`, {}))
  server.tool('promo_launch', 'Launch with the version from promo_preview: publishes the roundup and creates the posting calendar. Refuses a stale preview.', { ...cid, version: z.string().min(8) }, ({ campaign, version }: any) =>
    promo('POST', `/campaigns/${e(campaign)}/launch`, { version }, { 'idempotency-key': `launch-${version}` }),
  )
  server.tool('promo_pause', 'Pause (no new posts or sends; reports and listings stay), resume (active) or stop a campaign.', { ...cid, state: z.enum(['paused', 'active', 'stopped']) }, ({ campaign, state }: any) => promo('POST', `/campaigns/${e(campaign)}/pause`, { state }))
  server.tool('promo_placements', 'Posts and pages of a campaign with state (scheduled, published, verified, failed, uncertain...), public URL, evidence and error.', { ...cid, state: z.string().optional(), domain: z.string().optional() }, ({ campaign, state, domain }: any) => {
    const q = new URLSearchParams({ limit: '500' })
    if (state) q.set('state', state)
    if (domain) q.set('domain', domain)
    return promo('GET', `/campaigns/${e(campaign)}/placements?${q}`)
  })
  server.tool('promo_retry_placement', 'Put a failed placement back in line (at most three attempts).', { placement: z.string().min(6) }, ({ placement }: any) => promo('POST', `/placements/${e(placement)}/retry`, {}))
  server.tool('promo_results', 'One business: its measurement windows and the numbers so far (views, website clicks, phone taps, views from campaign links), with the latest report.', member, ({ campaign, domain }: any) => promo('GET', `/campaign-businesses/${e(`${campaign}:${domain}`)}/results`))
  server.tool('promo_reports', 'Reports of a campaign; generate=true first runs the hourly pass and writes reports for every window that has ended.', { ...cid, generate: z.boolean().optional() }, async ({ campaign, generate }: any) => {
    if (generate) await client.promo('POST', `/campaigns/${e(campaign)}/reports`, {})
    return promo('GET', `/campaigns/${e(campaign)}/reports`)
  })
  server.tool('promo_report', 'One report (frozen snapshot, versioned) as JSON or Markdown.', { report: z.string().min(6), format: z.enum(['json', 'md']).optional() }, ({ report, format }: any) => promo('GET', `/reports/${e(report)}${format === 'md' ? '.md' : ''}`))
  server.tool('promo_drafts', 'Outreach drafts of a campaign (written from reports after windows end; never sent unless sending is authorized).', cid, ({ campaign }: any) => promo('GET', `/campaigns/${e(campaign)}/drafts`))
  server.tool('promo_create_draft', 'Write the outreach draft for a report (one per report version).', { report: z.string().min(6) }, ({ report }: any) => promo('POST', `/reports/${e(report)}/outreach-draft`, {}))
  server.tool('promo_deliver', 'Send one draft. Refused unless the campaign authorizes sending, the window has ended, the report is current and the recipient is not suppressed upstream.', { draft: z.string().min(6) }, ({ draft }: any) => promo('POST', `/drafts/${e(draft)}/deliver`, {}))
}

export async function runMcp(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport())
}
