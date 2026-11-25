/**
 * Directory entries that are not *.pit.world hosts: sites imported from the sister directories
 * (SaaSRow, pwamart, built.indie; src/sister-import.ts) and the Adult (18+) category, which staff
 * seed by hand (bun src/admin.ts directory-seed).
 *
 * One row per normalised host, kept in listings.db beside the import cursors. A row filed under
 * `adult` is an adult entry, and nothing else makes one adult. Adult entries are shown to signed-in
 * members inside /directory/adult only; every other reader of this store asks for `all()`, which
 * never returns them.
 */
import type { Database } from 'bun:sqlite'

/** The Adult category's key and label, the same on all four directories. */
export const ADULT = { slug: 'adult', name: 'Adult (18+)' } as const
export const ADULT_NOTICE = 'Adult content. You must be 18 or older.'
export const ADULT_SIGN_IN = 'The Adult category needs a signed-in account.'

export type DirectorySite = {
  host: string
  url: string
  name: string
  about: string
  tags: string[]
  /** "category/sub" as in src/directory.ts, or "adult". */
  path: string
  /** saasrow, pwamart, built.indie, or staff. */
  source: string
  /** The listing's page on the sister directory, when it came from one. */
  sourceUrl: string
  added: number
}

export type SiteInput = { name?: unknown; url?: unknown; description?: unknown; tags?: unknown; path: string; source: string; sourceUrl?: unknown }

const text = (value: unknown, max: number) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** A site's host as the directory keys it: lower case, no `www.`, a real public name. Null when it is not one. */
export function siteHost(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let host = input.trim().toLowerCase()
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      const u = new URL(host)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
      host = u.hostname
    } catch {
      return null
    }
  } else host = host.split(/[/?#]/)[0]!.replace(/:\d+$/, '')
  host = host.replace(/\.$/, '').replace(/^www\./, '')
  if (host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)) return null
  return host
}

/** The address to link and to crawl: http(s), no credentials, no fragment, no campaign parameters. */
export function siteUrl(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 2000) return null
  try {
    const u = new URL(input.trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (!siteHost(u.href)) return null
    u.username = ''
    u.password = ''
    u.hash = ''
    for (const key of [...u.searchParams.keys()]) if (/^(utm_|ref$|ref_|via$|source$|fbclid$|gclid$)/i.test(key)) u.searchParams.delete(key)
    return u.href
  } catch {
    return null
  }
}

export const isAdultPath = (path: string) => path === ADULT.slug || path.startsWith(`${ADULT.slug}/`)

export class DirectorySites {
  private cache: { at: number; rows: DirectorySite[]; open: DirectorySite[]; adult: DirectorySite[] } | null = null

  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
    /** How long a read is trusted: the admin CLI writes from another process. */
    private readonly ttl = 30_000,
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS directory_sites (
      host TEXT PRIMARY KEY, url TEXT NOT NULL, name TEXT NOT NULL, about TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
      path TEXT NOT NULL, source TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL)`)
    db.run('CREATE INDEX IF NOT EXISTS directory_sites_path ON directory_sites (path)')
    // What each sister feed has already handed over, so a listing is read once.
    db.run('CREATE TABLE IF NOT EXISTS directory_feed_seen (source TEXT NOT NULL, id TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (source, id))')
  }

  private read() {
    if (this.cache && this.now() - this.cache.at < this.ttl) return this.cache
    const rows = (this.db.query('SELECT host, url, name, about, tags, path, source, source_url, added_at FROM directory_sites ORDER BY name COLLATE NOCASE, host').all() as any[]).map(
      (r): DirectorySite => {
        let tags: string[] = []
        try {
          tags = (JSON.parse(r.tags) as unknown[]).filter((t): t is string => typeof t === 'string')
        } catch {}
        return { host: r.host, url: r.url, name: r.name, about: r.about, tags, path: r.path, source: r.source, sourceUrl: r.source_url, added: r.added_at }
      },
    )
    this.cache = { at: this.now(), rows, open: rows.filter((r) => !isAdultPath(r.path)), adult: rows.filter((r) => isAdultPath(r.path)) }
    return this.cache
  }

  private rows(): DirectorySite[] {
    return this.read().rows
  }

  /** Every entry anyone may see. Adult entries are never in here. */
  all(): DirectorySite[] {
    return this.read().open
  }

  /** The Adult category. Callers show it to signed-in members only. */
  adult(): DirectorySite[] {
    return this.read().adult
  }

  get(input: unknown): DirectorySite | null {
    const host = siteHost(input)
    return host ? (this.rows().find((r) => r.host === host) ?? null) : null
  }

  has(input: unknown): boolean {
    return this.get(input) !== null
  }

  /** Is this host, or the site it is a subdomain of, filed under Adult? Takes a host or a URL. */
  isAdult(input: unknown): boolean {
    const host = siteHost(input)
    if (!host) return false
    for (const r of this.read().adult) if (r.host === host || host.endsWith(`.${r.host}`)) return true
    return false
  }

  /**
   * File one site. A host that is already filed is left where it is, with one exception: filing it
   * under Adult moves it there (staff moving a listing in). Nothing here ever moves an entry out of
   * Adult; that is `move`.
   */
  add(input: SiteInput): 'added' | 'moved' | 'exists' | 'invalid' {
    const url = siteUrl(input.url)
    const host = url ? siteHost(url) : null
    const name = text(input.name, 120) || host
    if (!url || !host || !name || !input.path) return 'invalid'
    const have = this.db.query('SELECT path FROM directory_sites WHERE host = ?').get(host) as { path: string } | null
    const tags = [...new Set((Array.isArray(input.tags) ? input.tags : []).map((t) => text(t, 40).toLowerCase()).filter(Boolean))].slice(0, 12)
    const sourceUrl = siteUrl(input.sourceUrl) ?? ''
    if (isAdultPath(input.path)) this.dropBusinessListing(host)
    if (have) {
      if (!isAdultPath(input.path) || isAdultPath(have.path)) return 'exists'
      this.db.run('UPDATE directory_sites SET path = ?, url = ?, name = ?, about = ?, tags = ?, source = ?, source_url = ? WHERE host = ?', [
        input.path, url, name, text(input.description, 300), JSON.stringify(tags), input.source, sourceUrl, host,
      ])
      this.cache = null
      return 'moved'
    }
    this.db.run('INSERT INTO directory_sites (host, url, name, about, tags, path, source, source_url, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      host, url, name, text(input.description, 300), JSON.stringify(tags), input.path, input.source, sourceUrl, this.now(),
    ])
    this.cache = null
    return 'added'
  }

  /**
   * A site filed under Adult has no page in the business directory (/b, /pros): an unclaimed one is
   * removed, a claimed one (its owner's words) is taken out of the lists and the ring instead.
   */
  private dropBusinessListing(host: string): void {
    try {
      this.db.run('DELETE FROM listings WHERE domain = ? AND claimed_at IS NULL', [host])
      this.db.run('UPDATE listings SET directory_opt_out = 1, ring_opt_out = 1 WHERE domain = ? AND claimed_at IS NOT NULL', [host])
    } catch {
      // Not the listings database (a test's own store): nothing to drop.
    }
  }

  /** Staff: file an entry somewhere else (into or out of Adult). */
  move(input: unknown, path: string): boolean {
    const host = siteHost(input)
    if (!host || !path) return false
    if (isAdultPath(path)) this.dropBusinessListing(host)
    const changed = this.db.run('UPDATE directory_sites SET path = ? WHERE host = ?', [path, host]).changes > 0
    this.cache = null
    return changed
  }

  remove(input: unknown): boolean {
    const host = siteHost(input)
    if (!host) return false
    const changed = this.db.run('DELETE FROM directory_sites WHERE host = ?', [host]).changes > 0
    this.cache = null
    return changed
  }

  seen(source: string, id: string): boolean {
    return this.db.query('SELECT 1 FROM directory_feed_seen WHERE source = ? AND id = ?').get(source, id) !== null
  }

  markSeen(source: string, ids: string[]): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO directory_feed_seen (source, id, seen_at) VALUES (?, ?, ?)')
    this.db.transaction(() => {
      for (const id of ids) insert.run(source, id, this.now())
    })()
  }

  /** Entries per source, adult ones counted apart. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.rows()) {
      const key = isAdultPath(r.path) ? ADULT.slug : r.source
      out[key] = (out[key] ?? 0) + 1
    }
    return out
  }
}
