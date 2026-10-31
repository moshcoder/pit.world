/**
 * Server-side listing admin, run on the box that holds listings.db (it opens the database directly, no API):
 *
 *   bun src/admin.ts seed FILE.json    list businesses pit.world found in public sources (an array of SeedInput)
 *   bun src/admin.ts enrich-nichedb [--force]  refresh exact-domain matches from NicheDB's public company directory
 *   bun src/admin.ts unseed DOMAIN     take one of those back out
 *   bun src/admin.ts views             every directory listing with its view count, as JSON
 *   bun src/admin.ts subscribers [SITE]  newsletter signups per property (confirmed, pending), or the confirmed
 *                                        addresses from one property. Reads PIT_NEWSLETTER_DB, else $PIT_DATA_DIR/newsletter.db.
 *
 * The database path is the server's: PIT_LISTINGS_DB, else $PIT_DATA_DIR/listings.db, else ~/.local/share/pit-world.
 */
import { readFileSync } from 'node:fs'
import { Listings, type SeedInput } from './listings.js'
import { Newsletter, normalizeSource } from './newsletter.js'
import { enrichNicheDb } from './nichedb.js'

export async function admin(args: string[], listings: Listings, out: Pick<Console, 'log' | 'error'> = console, newsletter?: () => Newsletter): Promise<number> {
  const [command, arg] = args
  if (command === 'subscribers' && newsletter) {
    const n = newsletter()
    if (arg) {
      const site = normalizeSource(arg)
      for (const s of site ? n.subscribers(site) : []) out.log(`${s.email}  ${new Date(s.confirmed_at).toISOString().slice(0, 10)}  ${s.sources.join(',')}`)
      return site ? 0 : 1
    }
    out.log(`${'property'.padEnd(40)} confirmed  pending`)
    for (const p of n.byProperty()) out.log(`${p.source.padEnd(40)} ${String(p.confirmed).padStart(9)}  ${String(p.pending).padStart(7)}`)
    out.log(`${'total'.padEnd(40)} ${String(n.count()).padStart(9)}  ${String(n.pendingCount()).padStart(7)}`)
    return 0
  }
  if (command === 'seed' && arg) {
    const rows = JSON.parse(readFileSync(arg, 'utf8')) as SeedInput[]
    let failed = 0
    for (const row of rows) {
      const l = listings.seed(row)
      if (l) out.log(`seeded  ${l.domain}  ${l.name}`)
      else {
        failed++
        out.error(`skipped ${row.domain}: claimed by its owner, or not a valid domain/name`)
      }
    }
    return failed ? 1 : 0
  }
  if (command === 'enrich-nichedb') {
    const result = await enrichNicheDb(listings, fetch, 4, arg === '--force')
    out.log(`NicheDB / OutreachGraph: checked ${result.checked}, matched ${result.matched}, unmatched ${result.unmatched}, failed ${result.failed}`)
    return result.failed ? 1 : 0
  }
  if (command === 'unseed' && arg) {
    const ok = listings.unseed(arg)
    out.log(ok ? `removed ${arg}` : `${arg} is not a listing pit.world wrote`)
    return ok ? 0 : 1
  }
  if (command === 'views') {
    const all = await Promise.all(listings.directoryDomains().map((d) => listings.get(d, { fetchMeta: false })))
    out.log(JSON.stringify(all.filter(Boolean).map((l) => ({ domain: l!.domain, name: l!.name, claimed: l!.claimed, views: l!.views, url: `https://pit.world/b/${l!.domain}` })), null, 2))
    return 0
  }
  out.error('usage: bun src/admin.ts seed FILE.json | enrich-nichedb [--force] | unseed DOMAIN | views | subscribers [SITE]')
  return 2
}

if (import.meta.main) {
  const env = process.env
  const dataDir = env.PIT_DATA_DIR ?? `${env.HOME ?? '.'}/.local/share/pit-world`
  const args = process.argv.slice(2)
  const newsletter = () => new Newsletter(env.PIT_NEWSLETTER_DB ?? `${dataDir}/newsletter.db`, null)
  process.exit(await admin(args, args[0] === 'subscribers' ? (null as unknown as Listings) : new Listings(env.PIT_LISTINGS_DB ?? `${dataDir}/listings.db`), console, newsletter))
}
