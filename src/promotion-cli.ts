/**
 * `pit promo ...`: promotion campaigns from the terminal. Every command calls the promotion API with
 * PIT_ADMIN_TOKEN, the same methods the web dashboard and the MCP tools use.
 */
import { readFileSync } from 'node:fs'
import type { PitClient } from './client.js'
import { localMyna, workOnce } from './promotion-worker.js'

export const PROMO_HELP = `pit promo: promotion campaigns (operators; needs PIT_ADMIN_TOKEN)

  pit promo campaigns                       every campaign
  pit promo create --source-ref cmp_... --name N --slug S --title T [--intro TEXT]
  pit promo show ID                         overview: members, holds, posts, windows, reports
  pit promo configure ID --json '{"spotlightAccounts":[...]}'
  pit promo import ID SNAPSHOT.json [--dry-run]
                                            a complete OutreachGraph snapshot
                                            (scripts/outreachgraph-campaign-export.sh)
  pit promo imports ID                      import runs and their totals
  pit promo rows IMPORT_ID                  every source row and its disposition
  pit promo roster ID [--limit N --offset N]
                                            the businesses, first: lead ids, site, listing, action
  pit promo member ID DOMAIN                one business: leads, hold, windows
  pit promo set ID DOMAIN [--order N] [--priority on|off] [--prior-contact TEXT] [--attest TEXT]
  pit promo exclude ID DOMAIN|LEAD --reason TEXT
  pit promo reverify ID                     re-check members against their listings
  pit promo preview ID                      what launch would do, and its version
  pit promo launch ID --version V           create the roundup and the calendar
  pit promo pause|resume|stop ID
  pit promo placements ID [--state S] [--domain D]
  pit promo retry PLACEMENT_ID
  pit promo test-tracking ID [DOMAIN ...]   marked test view + click per business, then check
  pit promo worker ID [--once] [--every 10m]
                                            post due spotlights with myna and verify them
  pit promo tick                            run the hourly pass now
  pit promo periods ID                      measurement windows
  pit promo results ID DOMAIN               one business's numbers so far
  pit promo reports ID [--generate]         reports (generate due ones)
  pit promo report REPORT_ID [--md|--html]
  pit promo csv ID                          the comparison, as CSV
  pit promo drafts ID                       outreach drafts
  pit promo draft REPORT_ID                 make the draft for a report
  pit promo deliver DRAFT_ID                send it (only if sending is authorized)
  pit promo gap ID --kind K --from ISO [--to ISO] [--domain D] [--note TEXT]
  pit promo audit ID
  pit promo tui ID                          browse it in the terminal
`

type Out = { log(text: string): void; error(text: string): void }

function flags(args: string[]): { f: Record<string, string>; rest: string[] } {
  const f: Record<string, string> = {}
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(args[i]!)
    if (!m) rest.push(args[i]!)
    else if (m[2] !== undefined) f[m[1]!] = m[2]
    else if (args[i + 1] === undefined || args[i + 1]!.startsWith('--')) f[m[1]!] = 'true'
    else f[m[1]!] = args[++i]!
  }
  return { f, rest }
}

const e = encodeURIComponent
const day = (ms: number | null) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '-')

export async function promoMain(args: string[], out: Out, client: PitClient, json: boolean): Promise<number> {
  const [command, ...more] = args
  const { f, rest } = flags(more)
  const id = rest[0] ?? ''
  const show = (value: unknown, text?: () => void) => {
    if (json || !text) out.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    else text()
    return 0
  }
  const need = (ok: unknown, usage: string) => {
    if (!ok) throw Object.assign(new Error(`usage: pit promo ${usage}`), { usage: true })
  }
  switch (command) {
    case undefined:
    case 'help':
      out.log(PROMO_HELP)
      return 0
    case 'campaigns': {
      const r = await client.promo('GET', '/campaigns')
      return show(r, () => r.campaigns.forEach((c: any) => out.log(`${c.id}  ${c.state.padEnd(8)} ${c.name}  (${c.source}, /roundup/${c.slug})`)))
    }
    case 'create': {
      need(f['source-ref'] && f.name && f.slug && f.title, 'create --source-ref cmp_... --name N --slug S --title T [--intro TEXT]')
      return show(await client.promo('POST', '/campaigns', { name: f.name, source: f.source ?? 'outreachgraph', sourceRef: f['source-ref'], config: { slug: f.slug, title: f.title, intro: f.intro ?? '' } }))
    }
    case 'show': {
      need(id, 'show ID')
      const o = await client.promo('GET', `/campaigns/${e(id)}`)
      return show(o, () => {
        out.log(`${o.campaign.name}  ${o.campaign.state}  ${o.campaign.source}`)
        for (const k of ['members', 'holds', 'placements', 'periods', 'drafts']) out.log(`  ${k.padEnd(11)} ${Object.entries(o[k]).map(([a, n]) => `${a} ${n}`).join(' · ') || 'none'}`)
        out.log(`  tracking   ${o.trackingTested} tested · ${o.events} counted events · ${o.reports} reports`)
      })
    }
    case 'configure': {
      need(id && f.json, `configure ID --json '{...}'`)
      return show(await client.promo('PATCH', `/campaigns/${e(id)}`, { config: JSON.parse(f.json!) }))
    }
    case 'import': {
      need(id && rest[1], 'import ID SNAPSHOT.json [--dry-run]')
      const snapshot = JSON.parse(readFileSync(rest[1]!, 'utf8'))
      const r = await client.promo('POST', `/campaigns/${e(id)}/imports${f['dry-run'] ? '?dryRun=1' : ''}`, { snapshot }, f['dry-run'] ? {} : { 'idempotency-key': `import-${snapshot.snapshotAt}` })
      return show(r, () => out.log(`${r.repeated ? 'already imported' : f['dry-run'] ? 'dry run' : `imported ${r.importId}`}: ${r.sourceRows} rows = ${r.matched} matched + ${r.merged} merged into the same business + ${r.unresolved} unresolved + ${r.excluded} excluded; ${r.businesses} businesses (${r.verified} verified, ${r.unverified} need a listing fix), ${r.holdConflicts} hold conflicts. ${r.complete ? 'Complete snapshot.' : 'Partial snapshot: nothing removed.'}`))
    }
    case 'imports':
      need(id, 'imports ID')
      return show(await client.promo('GET', `/campaigns/${e(id)}/imports`))
    case 'rows':
      need(id, 'rows IMPORT_ID')
      return show(await client.promo('GET', `/imports/${e(id)}/rows`))
    case 'roster': {
      need(id, 'roster ID')
      const r = await client.promo('GET', `/campaigns/${e(id)}/businesses?limit=${f.limit ?? 500}&offset=${f.offset ?? 0}`)
      return show(r, () => {
        out.log('Source lead IDs | Business | Website | Listing | Verification | Planned action')
        for (const b of r.businesses) out.log(`${b.leadIds.join(' ')} | ${b.business} | ${b.website} | ${b.listingUrl ?? '(none)'} | ${b.verification}${b.reason ? ` (${b.reason})` : ''} | ${b.plannedAction}`)
        for (const u of r.unresolvedLeads) out.log(`${u.leadId} | ${u.name} | - | - | unresolved (${u.reason}) | resolve identity first`)
        out.log(`${r.total} businesses${r.unresolvedLeads.length ? ` + ${r.unresolvedLeads.length} unresolved leads` : ''}`)
      })
    }
    case 'member':
      need(id && rest[1], 'member ID DOMAIN')
      return show(await client.promo('GET', `/campaign-businesses/${e(`${id}:${rest[1]}`)}`))
    case 'set': {
      need(id && rest[1], 'set ID DOMAIN [--order N] [--priority on|off] [--prior-contact TEXT] [--attest TEXT]')
      const changes: Record<string, unknown> = {}
      if (f.order !== undefined) changes.displayOrder = f.order === 'none' ? null : Number(f.order)
      if (f.priority !== undefined) changes.priority = f.priority === 'on'
      if (f['prior-contact'] !== undefined) changes.priorContact = f['prior-contact']
      if (f.attest !== undefined) changes.holdAttestation = f.attest
      return show(await client.promo('PATCH', `/campaign-businesses/${e(`${id}:${rest[1]}`)}`, changes))
    }
    case 'exclude':
      need(id && rest[1] && f.reason, 'exclude ID DOMAIN|LEAD --reason TEXT')
      return show(await client.promo('POST', `/campaigns/${e(id)}/exclusions`, { subject: rest[1], reason: f.reason }))
    case 'reverify':
      need(id, 'reverify ID')
      return show(await client.promo('POST', `/campaigns/${e(id)}/reverify`, {}))
    case 'preview': {
      need(id, 'preview ID')
      const p = await client.promo('POST', `/campaigns/${e(id)}/preview`, {})
      return show(p, () => {
        out.log(`version ${p.version}: ${p.launchable.length} businesses launch, ${p.blocked.length} blocked, ${p.placements.length} placements`)
        for (const b of p.blocked) out.log(`  blocked ${b.domain}: ${b.reason}`)
        for (const x of p.placements.slice(0, 8)) out.log(`  ${x.plannedAt}  ${x.kind.padEnd(12)} ${x.account}\n      ${x.body.replace(/\n+/g, ' / ')}`)
        if (p.placements.length > 8) out.log(`  ... ${p.placements.length - 8} more (--json for all)`)
        out.log(`launch: pit promo launch ${id} --version ${p.version}`)
      })
    }
    case 'launch':
      need(id && f.version, 'launch ID --version V')
      return show(await client.promo('POST', `/campaigns/${e(id)}/launch`, { version: f.version }, { 'idempotency-key': `launch-${f.version}` }))
    case 'pause':
    case 'resume':
    case 'stop':
      need(id, `${command} ID`)
      return show(await client.promo('POST', `/campaigns/${e(id)}/pause`, { state: command === 'resume' ? 'active' : command === 'stop' ? 'stopped' : 'paused' }))
    case 'placements': {
      need(id, 'placements ID [--state S] [--domain D]')
      const q = new URLSearchParams({ limit: f.limit ?? '500' })
      if (f.state) q.set('state', f.state)
      if (f.domain) q.set('domain', f.domain)
      const r = await client.promo('GET', `/campaigns/${e(id)}/placements?${q}`)
      return show(r, () => r.placements.forEach((p: any) => out.log(`${p.id}  ${day(p.plannedAt)}  ${p.state.padEnd(10)} ${p.kind.padEnd(12)} ${p.account}  ${p.publicUrl || ''}${p.error ? `  ! ${p.error}` : ''}`)))
    }
    case 'retry':
      need(id, 'retry PLACEMENT_ID')
      return show(await client.promo('POST', `/placements/${e(id)}/retry`, {}))
    case 'test-tracking': {
      need(id, 'test-tracking ID [DOMAIN ...]')
      let domains = rest.slice(1)
      if (!domains.length) domains = (await client.promo('GET', `/campaigns/${e(id)}/businesses?limit=500`)).businesses.filter((b: any) => b.verification === 'verified').map((b: any) => new URL(b.website).hostname)
      const ua = 'Mozilla/5.0 (X11; Linux x86_64) pit-promo-tracking-test'
      for (const d of domains) {
        await fetch(`${client.base}/b/${e(d)}?pt=test`, { headers: { 'user-agent': ua, 'x-pit-test': '1' } })
        await fetch(`${client.base}/b/${e(d)}/go?pt=test`, { headers: { 'user-agent': ua, 'x-pit-test': '1' }, redirect: 'manual' })
      }
      const r = await client.promo('POST', `/campaigns/${e(id)}/tracking-check`, { domains })
      return show(r, () => {
        out.log(`tracking test passed for ${r.passed.length} of ${domains.length}`)
        for (const x of r.failed) out.log(`  failed ${x.domain}: missing ${x.missing.join(', ')}`)
      }) || (r.failed.length ? 1 : 0)
    }
    case 'worker': {
      need(id, 'worker ID [--once] [--every 10m]')
      const myna = localMyna()
      const every = Math.max(60, Number(/^(\d+)m$/.exec(f.every ?? '10m')?.[1] ?? 10) * 60) * 1000
      for (;;) {
        const results = await workOnce(client, id, myna)
        for (const r of results) out.log(`${new Date().toISOString()}  ${r.placement}  ${r.action}${r.state ? ` -> ${r.state}` : ''}${r.detail ? `  ${r.detail}` : ''}`)
        if (f.once) return results.some((r) => r.action === 'error') ? 1 : 0
        await new Promise((resolve) => setTimeout(resolve, every))
      }
    }
    case 'tick':
      return show(await client.promo('POST', '/tick', {}))
    case 'periods':
      need(id, 'periods ID')
      return show(await client.promo('GET', `/campaigns/${e(id)}/periods`))
    case 'results':
      need(id && rest[1], 'results ID DOMAIN')
      return show(await client.promo('GET', `/campaign-businesses/${e(`${id}:${rest[1]}`)}/results`))
    case 'reports':
      need(id, 'reports ID [--generate]')
      if (f.generate) await client.promo('POST', `/campaigns/${e(id)}/reports`, {})
      return show(await client.promo('GET', `/campaigns/${e(id)}/reports`))
    case 'report':
      need(id, 'report REPORT_ID [--md|--html]')
      return show(await client.promo('GET', `/reports/${e(id)}${f.md ? '.md' : f.html ? '.html' : ''}`))
    case 'csv':
      need(id, 'csv ID')
      out.log(await client.promo('GET', `/campaigns/${e(id)}/reports.csv`))
      return 0
    case 'drafts':
      need(id, 'drafts ID')
      return show(await client.promo('GET', `/campaigns/${e(id)}/drafts`))
    case 'draft':
      need(id, 'draft REPORT_ID')
      return show(await client.promo('POST', `/reports/${e(id)}/outreach-draft`, {}))
    case 'deliver':
      need(id, 'deliver DRAFT_ID')
      return show(await client.promo('POST', `/drafts/${e(id)}/deliver`, {}))
    case 'gap':
      need(id && f.kind && f.from, 'gap ID --kind K --from ISO [--to ISO] [--domain D] [--note TEXT]')
      return show(await client.promo('POST', `/campaigns/${e(id)}/gaps`, { kind: f.kind, from: Date.parse(f.from!), ...(f.to ? { to: Date.parse(f.to) } : {}), ...(f.domain ? { domain: f.domain } : {}), note: f.note ?? '' }))
    case 'audit':
      need(id, 'audit ID')
      return show(await client.promo('GET', `/campaigns/${e(id)}/audit`))
    case 'tui':
      need(id, 'tui ID')
      await (await import('./promotion-tui.js')).runPromoTui(client, id)
      return 0
    default:
      out.error(`pit promo: unknown command ${command}\n\n${PROMO_HELP}`)
      return 64
  }
}
