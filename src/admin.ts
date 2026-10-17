/**
 * Server-side listing admin, run on the box that holds listings.db (it opens the database directly, no API):
 *
 *   bun src/admin.ts seed FILE.json    list businesses pit.world found in public records (an array of SeedInput)
 *   bun src/admin.ts unseed DOMAIN     take one of those back out
 *   bun src/admin.ts views             every directory listing with its view count, as JSON
 *
 * The database path is the server's: PIT_LISTINGS_DB, else $PIT_DATA_DIR/listings.db, else ~/.local/share/pit-world.
 */
import { readFileSync } from 'node:fs'
import { Listings, type SeedInput } from './listings.js'

export async function admin(args: string[], listings: Listings, out: Pick<Console, 'log' | 'error'> = console): Promise<number> {
  const [command, arg] = args
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
  out.error('usage: bun src/admin.ts seed FILE.json | unseed DOMAIN | views')
  return 2
}

if (import.meta.main) {
  const env = process.env
  const dataDir = env.PIT_DATA_DIR ?? `${env.HOME ?? '.'}/.local/share/pit-world`
  process.exit(await admin(process.argv.slice(2), new Listings(env.PIT_LISTINGS_DB ?? `${dataDir}/listings.db`)))
}
