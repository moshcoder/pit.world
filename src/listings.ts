/**
 * Business listings anyone can claim, Google Business Profile without the tracking.
 *
 * A listing is keyed by domain. Until someone claims it, it shows what the business's own
 * homepage says about itself (title, description). The owner claims it by proving control
 * of the domain, with a DNS TXT record or a meta tag on the homepage, and gets an edit key
 * that is shown once and stored only as a hash. There are no accounts and no cookies.
 */
import { Database } from 'bun:sqlite'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup, resolveTxt } from 'node:dns/promises'
import { isIP } from 'node:net'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { dnsMx, normalizeEmail, type Mailer, type MxLookup } from './newsletter.js'
import { PRICES, categoryOf, cleanServices, normalizeOperator, normalizeWebUrl, ringEligible } from './pros.js'
import { ensurePromotionSchema } from './promotion-schema.js'

export type Listing = {
  domain: string
  name: string
  description: string
  hours: string
  address: string
  phone: string
  links: string[]
  moshpit: string
  /** Who runs it: an agent or person handle (`name@host`) or an https URL (an OpenAgent record, a profile). */
  operator: string
  company: string
  companyUrl: string
  /** One of CATEGORIES (pros.ts), or ''. */
  category: string
  /** Free text: "Bay Area and remote", "within 30 miles of Austin". */
  area: string
  city: string
  region: string
  country: string
  services: string[]
  /** One of PRICES (pros.ts), or ''. */
  price: string
  /** The owner has a confirmed address for quote requests. The address itself is never shown. */
  quotes: boolean
  /** In the pit.world web ring (every claimed listing is, unless the owner opts out). */
  ring: boolean
  /** In the /pros directory (an owner can take a claimed listing out; the page itself stays). */
  listed: boolean
  /** The site's RSS/Atom feed, discovered from its homepage. */
  feed: string
  /** The name only opens on Moshpit DNS (no ICANN address). */
  moshpitOnly: boolean
  claimed: boolean
  /**
   * Listed by pit.world from public records before the owner claimed it (see seed()). Shown in the
   * directory, marked as unclaimed, never routed quote requests. Claiming hands it to the owner.
   */
  seeded: boolean
  /** Editorial order in the directory: higher first. Never sold. */
  featured: number
  /** Paid feature window; expired placements are never marked sponsored. */
  sponsoredUntil?: number | null
  /** A public license the listing was checked against, e.g. "CSLB #349328 (B - General Building)". */
  license: string
  /** When pit.world last saw that license active at the issuer. */
  licenseCheckedAt: number | null
  /** Page views of /b/<domain> by people (crawlers and scripts are not counted). */
  views: number
  updatedAt: number | null
}

/** What pit.world writes when it lists a business itself. Public business facts only: never an email address. */
export type SeedInput = {
  domain: string
  name: string
  description?: string
  phone?: string
  address?: string
  category?: string
  area?: string
  city?: string
  region?: string
  country?: string
  services?: string[]
  links?: string[]
  license?: string
  licenseCheckedAt?: number
  featured?: number
}

export const EDIT_FIELDS = [
  'name', 'description', 'hours', 'address', 'phone', 'links', 'moshpit',
  'operator', 'company', 'companyUrl', 'category', 'area', 'city', 'region', 'country', 'services', 'price', 'ring', 'listed',
] as const

export type ListingEdit = Partial<Pick<Listing, (typeof EDIT_FIELDS)[number]>>

export type RingMember = { domain: string; name: string; description: string; moshpitOnly: boolean; feed: string; joinedAt: number }

export type Verifier = {
  txt(host: string): Promise<string[]>
  homepage(domain: string): Promise<string | null>
  /** Does the name have an ICANN address? False means it only opens on Moshpit DNS. Optional: assumed true. */
  resolves?(domain: string): Promise<boolean>
}

const LIMITS = { name: 80, description: 600, hours: 200, address: 200, phone: 40, link: 300, links: 5, moshpit: 253, company: 100, area: 160, place: 80, license: 120 }
/** Quote requests one listing will pass on: per hour, and per day. */
const QUOTE_LIMITS = { hour: 5, day: 20, siteDay: 400 }
const CONTACT_TTL_MS = 48 * 3600 * 1000
const CLAIM_TTL_MS = 7 * 24 * 3600 * 1000
const META_TTL_MS = 24 * 3600 * 1000
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** `https://www.Acme-Bakery.com/menu` -> `acme-bakery.com`. Hostnames only: no IPs, no single labels, no ports. */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let host = input.trim().toLowerCase()
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0]!.replace(/:\d+$/, '').replace(/\.$/, '')
  host = host.replace(/^www\./, '')
  if (host.length > 253 || isIP(host)) return null
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null
  return host
}

export function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : ''
}

export function cleanLinks(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s+/) : []
  const out: string[] = []
  for (const raw of list) {
    const text = clean(raw, LIMITS.link)
    try {
      const url = new URL(text)
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !out.includes(url.href)) out.push(url.href)
    } catch {}
    if (out.length >= LIMITS.links) break
  }
  return out
}

/** Title and description from a homepage's HTML. Regexes, not a parser: it only needs a few tags. */
export function readMeta(html: string): { name: string; description: string } {
  const attr = (tag: string, name: string) => new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1] ?? ''
  const metas = html.match(/<meta\b[^>]*>/gi) ?? []
  const meta = (key: string) => {
    for (const tag of metas) if ([attr(tag, 'name'), attr(tag, 'property')].some((v) => v.toLowerCase() === key)) return attr(tag, 'content')
    return ''
  }
  const decode = (s: string) =>
    s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, ' ').trim()
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''
  return {
    name: clean(decode(meta('og:site_name') || title), LIMITS.name),
    description: clean(decode(meta('description') || meta('og:description')), LIMITS.description),
  }
}

/**
 * The feed a homepage advertises with <link rel="alternate" type="application/rss+xml|atom+xml" href>,
 * resolved against the page. The first one wins; '' when there is none.
 */
export function discoverFeed(html: string, pageUrl: string): string {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1] ?? ''
    if (!attr('rel').toLowerCase().split(/\s+/).includes('alternate')) continue
    if (!/^application\/(rss|atom)\+xml$/i.test(attr('type').trim())) continue
    try {
      const url = new URL(attr('href').replace(/&amp;/g, '&').trim(), pageUrl)
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href.slice(0, LIMITS.link)
    } catch {}
  }
  return ''
}

/** True for addresses on the public internet; the homepage fetch never goes anywhere else. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number]
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224)
  }
  const v6 = address.toLowerCase()
  if (v6.startsWith('::ffff:')) return isPublicAddress(v6.slice(7))
  return !(v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff'))
}

/** How a Moshpit name is reached: the registry's target, and the root its certificates chain to. */
export type MoshpitAccess = { resolve(name: string): Promise<{ nameRegistered: boolean; target?: string | null } | null>; rootPem: string }

/** A Moshpit name's homepage: connect to the registry's target, present the name as SNI and Host, trust only the Moshpit root. */
async function moshpitHomepage(name: string, access: MoshpitAccess): Promise<string | null> {
  const r = await access.resolve(name).catch(() => null)
  const target = r?.nameRegistered ? normalizeDomain(r.target ?? '') : null
  if (!target) return null
  const addresses = await lookup(target, { all: true })
  const address = addresses.find((a) => isPublicAddress(a.address))
  if (!address || !addresses.every((a) => isPublicAddress(a.address))) return null
  const { request } = await import('node:https')
  return new Promise((resolve) => {
    // threatcrush-disable-next-line js-ssrf-outbound-request  the address is the registry target's, checked public above; TLS must chain to the Moshpit root
    const req = request(
      { host: address.address, port: 443, path: '/', servername: name, ca: access.rootPem, headers: { host: name, accept: 'text/html', 'user-agent': 'pit.world listings (+https://pit.world/b)' }, timeout: 5000 },
      (res) => {
        if ((res.statusCode ?? 0) !== 200 || !String(res.headers['content-type'] ?? '').includes('html')) {
          res.resume()
          return resolve(null)
        }
        let html = ''
        res.on('error', () => resolve(html || null))
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          html += chunk
          if (html.length > 256_000) res.destroy()
        })
        res.on('end', () => resolve(html))
        res.on('close', () => resolve(html || null))
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end()
  })
}

/** The real verifier: DNS TXT, and the homepage over HTTPS (public addresses only, 5 s, 256 KB, no redirects off the domain). */
export function liveVerifier(fetchImpl: typeof fetch = fetch, moshpit?: MoshpitAccess): Verifier {
  return {
    async txt(host) {
      try {
        return (await resolveTxt(host)).map((parts) => parts.join(''))
      } catch {
        return []
      }
    },
    async resolves(domain) {
      return lookup(domain).then(() => true, () => false)
    },
    async homepage(domain) {
      try {
        // Not on the old internet? Then maybe on Moshpit.
        if (moshpit && !(await lookup(domain).then(() => true, () => false))) return await moshpitHomepage(domain, moshpit)
        let url = new URL(`https://${domain}/`)
        let response: Response | null = null
        // Up to three redirects, and only to https pages on this domain or its subdomains (acme.com -> www.acme.com).
        for (let hop = 0; hop < 4; hop++) {
          const addresses = await lookup(url.hostname, { all: true })
          if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) return null
          // threatcrush-disable-next-line js-ssrf-outbound-request  host is a validated public domain (or its subdomain) whose every address was checked above
          response = await fetchImpl(url.href, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { accept: 'text/html', 'user-agent': 'pit.world listings (+https://pit.world/b)' } })
          const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
          if (!location) break
          const next = new URL(location, url)
          if (next.protocol !== 'https:' || (next.hostname !== domain && !next.hostname.endsWith(`.${domain}`))) return null
          url = next
          response = null
        }
        if (!response || !response.ok || !(response.headers.get('content-type') ?? '').includes('html')) return null
        const reader = response.body?.getReader()
        if (!reader) return null
        let html = ''
        const decoder = new TextDecoder()
        while (html.length < 256_000) {
          const { done, value } = await reader.read()
          if (done) break
          html += decoder.decode(value, { stream: true })
        }
        reader.cancel().catch(() => {})
        return html
      } catch {
        return null
      }
    },
  }
}


export type ClaimStart = { claimId: string; token: string; txtHost: string; meta: string }
export type VerifyResult = { ok: true; method: 'dns' | 'meta'; editKey: string } | { ok: false; reason: 'unknown-claim' | 'not-found' }
export type ContactResult = 'pending' | 'cleared' | 'unchanged' | 'invalid' | 'undeliverable' | 'unauthorized' | 'unavailable' | 'failed'
export type ContactStatus = 'none' | 'pending' | 'confirmed'
export type QuoteInput = { name?: unknown; email?: unknown; phone?: unknown; message?: unknown }
export type QuoteResult = 'sent' | 'invalid' | 'undeliverable' | 'unavailable' | 'limited' | 'failed'
export type DirectoryQuery = { category?: unknown; near?: unknown; q?: unknown; limit?: number; offset?: number; claimedOnly?: boolean }

/**
 * Columns added after the first release. Each statement is written out whole, never assembled, so the
 * schema can only ever be what is in this file.
 */
const MIGRATIONS: Array<[string, string]> = [
  ['operator', "ALTER TABLE listings ADD COLUMN operator TEXT NOT NULL DEFAULT ''"],
  ['company', "ALTER TABLE listings ADD COLUMN company TEXT NOT NULL DEFAULT ''"],
  ['company_url', "ALTER TABLE listings ADD COLUMN company_url TEXT NOT NULL DEFAULT ''"],
  ['category', "ALTER TABLE listings ADD COLUMN category TEXT NOT NULL DEFAULT ''"],
  ['area', "ALTER TABLE listings ADD COLUMN area TEXT NOT NULL DEFAULT ''"],
  ['city', "ALTER TABLE listings ADD COLUMN city TEXT NOT NULL DEFAULT ''"],
  ['region', "ALTER TABLE listings ADD COLUMN region TEXT NOT NULL DEFAULT ''"],
  ['country', "ALTER TABLE listings ADD COLUMN country TEXT NOT NULL DEFAULT ''"],
  ['services', "ALTER TABLE listings ADD COLUMN services TEXT NOT NULL DEFAULT '[]'"],
  ['price', "ALTER TABLE listings ADD COLUMN price TEXT NOT NULL DEFAULT ''"],
  ['contact_email', "ALTER TABLE listings ADD COLUMN contact_email TEXT NOT NULL DEFAULT ''"],
  ['contact_pending', "ALTER TABLE listings ADD COLUMN contact_pending TEXT NOT NULL DEFAULT ''"],
  ['contact_token_hash', 'ALTER TABLE listings ADD COLUMN contact_token_hash TEXT'],
  ['contact_requested_at', 'ALTER TABLE listings ADD COLUMN contact_requested_at INTEGER'],
  ['ring_opt_out', 'ALTER TABLE listings ADD COLUMN ring_opt_out INTEGER NOT NULL DEFAULT 0'],
  ['ring_joined_at', 'ALTER TABLE listings ADD COLUMN ring_joined_at INTEGER'],
  ['feed_url', "ALTER TABLE listings ADD COLUMN feed_url TEXT NOT NULL DEFAULT ''"],
  ['site_checked_at', 'ALTER TABLE listings ADD COLUMN site_checked_at INTEGER'],
  ['moshpit_only', 'ALTER TABLE listings ADD COLUMN moshpit_only INTEGER NOT NULL DEFAULT 0'],
  ['seeded_at', 'ALTER TABLE listings ADD COLUMN seeded_at INTEGER'],
  ['featured', 'ALTER TABLE listings ADD COLUMN featured INTEGER NOT NULL DEFAULT 0'],
  ['featured_paid_until', 'ALTER TABLE listings ADD COLUMN featured_paid_until INTEGER'],
  ['license', "ALTER TABLE listings ADD COLUMN license TEXT NOT NULL DEFAULT ''"],
  ['license_checked_at', 'ALTER TABLE listings ADD COLUMN license_checked_at INTEGER'],
  ['views', 'ALTER TABLE listings ADD COLUMN views INTEGER NOT NULL DEFAULT 0'],
  ['directory_opt_out', 'ALTER TABLE listings ADD COLUMN directory_opt_out INTEGER NOT NULL DEFAULT 0'],
]

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)
const words = (value: unknown) => clean(value, 120).toLowerCase().split(/\s+/).filter(Boolean)

export class Listings {
  /** Shared with the promotion store (src/promotion.ts), whose membership the directory orders by. */
  readonly db: Database
  private mailer: Mailer | null
  private mx: MxLookup
  private site: string

  constructor(
    path: string,
    private verifier: Verifier = liveVerifier(),
    private now = () => Date.now(),
    options: { mailer?: Mailer | null; mx?: MxLookup; site?: string } = {},
  ) {
    this.mailer = options.mailer ?? null
    this.mx = options.mx ?? dnsMx
    this.site = options.site ?? 'https://pit.world'
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run(`CREATE TABLE IF NOT EXISTS listings (
      domain TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      hours TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      links TEXT NOT NULL DEFAULT '[]', moshpit TEXT NOT NULL DEFAULT '',
      edit_key_hash TEXT, claimed_at INTEGER, updated_at INTEGER, meta_at INTEGER)`)
    this.db.run('CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, domain TEXT NOT NULL, token TEXT NOT NULL, created_at INTEGER NOT NULL)')
    const have = new Set((this.db.query('PRAGMA table_info(listings)').all() as Array<{ name: string }>).map((c) => c.name))
    for (const [column, statement] of MIGRATIONS) if (!have.has(column)) this.db.run(statement)
    // Listings claimed before the ring existed join it in the order they were claimed.
    this.db.run('UPDATE listings SET ring_joined_at = claimed_at WHERE claimed_at IS NOT NULL AND ring_joined_at IS NULL')
    // Quote requests are counted, never kept: a domain and a time, so the per-listing limit survives a restart.
    this.db.run('CREATE TABLE IF NOT EXISTS quote_log (domain TEXT NOT NULL, at INTEGER NOT NULL)')
    this.db.run('CREATE INDEX IF NOT EXISTS quote_log_domain_at ON quote_log (domain, at)')
    ensurePromotionSchema(this.db)
  }

  /** Quote requests need somewhere to send from. */
  get mailEnabled(): boolean {
    return this.mailer !== null
  }

  private row(domain: string): any {
    return this.db.query('SELECT * FROM listings WHERE domain = ?').get(domain)
  }

  private toListing(row: any, domain: string): Listing {
    return {
      domain,
      name: row?.name ?? '',
      description: row?.description ?? '',
      hours: row?.hours ?? '',
      address: row?.address ?? '',
      phone: row?.phone ?? '',
      links: row ? JSON.parse(row.links) : [],
      moshpit: row?.moshpit ?? '',
      operator: row?.operator ?? '',
      company: row?.company ?? '',
      companyUrl: row?.company_url ?? '',
      category: row?.category ?? '',
      area: row?.area ?? '',
      city: row?.city ?? '',
      region: row?.region ?? '',
      country: row?.country ?? '',
      services: row?.services ? JSON.parse(row.services) : [],
      price: row?.price ?? '',
      quotes: Boolean(row?.claimed_at && row?.contact_email),
      ring: Boolean(row?.claimed_at && !row?.ring_opt_out && ringEligible(domain, Boolean(row?.moshpit_only))),
      listed: Boolean((row?.claimed_at || row?.seeded_at) && !row?.directory_opt_out),
      feed: row?.feed_url ?? '',
      moshpitOnly: Boolean(row?.moshpit_only),
      claimed: Boolean(row?.claimed_at),
      seeded: Boolean(row?.seeded_at && !row?.claimed_at),
      featured: row?.featured ?? 0,
      sponsoredUntil: (row?.featured_paid_until ?? 0) > this.now() ? row.featured_paid_until : null,
      license: row?.license ?? '',
      licenseCheckedAt: row?.license_checked_at ?? null,
      views: row?.views ?? 0,
      updatedAt: row?.updated_at ?? null,
    }
  }

  /** A claimed listing as its owner wrote it; otherwise what the homepage says, refreshed once a day. */
  async get(input: unknown, options: { fetchMeta?: boolean } = {}): Promise<Listing | null> {
    const domain = normalizeDomain(input)
    if (!domain) return null
    let row = this.row(domain)
    // A listing pit.world wrote itself keeps what it wrote; only bare unclaimed ones follow the homepage.
    const stale = !row || (!row.claimed_at && !row.seeded_at && (row.meta_at ?? 0) < this.now() - META_TTL_MS)
    if (stale && options.fetchMeta !== false) {
      const html = await this.verifier.homepage(domain)
      if (html) {
        const meta = readMeta(html)
        if (row) this.db.run('UPDATE listings SET name = ?, description = ?, meta_at = ? WHERE domain = ? AND claimed_at IS NULL AND seeded_at IS NULL', [meta.name, meta.description, this.now(), domain])
        else this.db.run('INSERT INTO listings (domain, name, description, meta_at) VALUES (?, ?, ?, ?)', [domain, meta.name, meta.description, this.now()])
        row = this.row(domain)
      }
    }
    return this.toListing(row, domain)
  }

  /** A listing that is in the directory, without touching the network; null otherwise. */
  toPublic(input: unknown): Listing | null {
    const domain = normalizeDomain(input)
    const row = domain ? this.row(domain) : null
    return row && (row.claimed_at || row.seeded_at) && !row.directory_opt_out ? this.toListing(row, domain!) : null
  }

  /** Claimed listings only, without touching the network: the search results card. */
  claimedOnly(input: unknown): Listing | null {
    const domain = normalizeDomain(input)
    if (!domain) return null
    const row = this.row(domain)
    return row?.claimed_at ? this.toListing(row, domain) : null
  }

  /** Start a claim: the token goes in a TXT record at _pit-verify.<domain>, or in a meta tag on the homepage. */
  startClaim(input: unknown): ClaimStart | null {
    const domain = normalizeDomain(input)
    if (!domain) return null
    this.db.run('DELETE FROM claims WHERE created_at < ?', [this.now() - CLAIM_TTL_MS])
    const claimId = randomBytes(12).toString('base64url')
    const token = `pit-verify=${randomBytes(16).toString('hex')}`
    this.db.run('INSERT INTO claims (id, domain, token, created_at) VALUES (?, ?, ?, ?)', [claimId, domain, token, this.now()])
    return { claimId, token, txtHost: `_pit-verify.${domain}`, meta: `<meta name="pit-verify" content="${token.slice('pit-verify='.length)}">` }
  }

  claimFor(claimId: unknown): { domain: string; token: string } | null {
    if (typeof claimId !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(claimId)) return null
    const row = this.db.query('SELECT domain, token, created_at FROM claims WHERE id = ?').get(claimId) as { domain: string; token: string; created_at: number } | null
    return row && row.created_at >= this.now() - CLAIM_TTL_MS ? { domain: row.domain, token: row.token } : null
  }

  /** Check the TXT record, then the meta tag. Success hands out a new edit key; any earlier key stops working. */
  async verify(claimId: unknown): Promise<VerifyResult> {
    const claim = this.claimFor(claimId)
    if (!claim) return { ok: false, reason: 'unknown-claim' }
    const value = claim.token.slice('pit-verify='.length)
    let method: 'dns' | 'meta' | null = null
    let html: string | null = null
    if ((await this.verifier.txt(`_pit-verify.${claim.domain}`)).some((t) => t.trim() === claim.token || t.trim() === value)) method = 'dns'
    else {
      html = await this.verifier.homepage(claim.domain)
      const tags = html?.match(/<meta\b[^>]*>/gi) ?? []
      if (tags.some((tag) => /name\s*=\s*["']pit-verify["']/i.test(tag) && new RegExp(`content\\s*=\\s*["']${value}["']`, 'i').test(tag))) method = 'meta'
    }
    if (!method) return { ok: false, reason: 'not-found' }
    const editKey = `pitk_${randomBytes(24).toString('base64url')}`
    if (!this.row(claim.domain)) this.db.run('INSERT INTO listings (domain) VALUES (?)', [claim.domain])
    // Claiming joins the ring; a re-claim keeps the place it already had.
    this.db.run('UPDATE listings SET edit_key_hash = ?, claimed_at = ?, updated_at = ?, ring_joined_at = COALESCE(ring_joined_at, ?) WHERE domain = ?', [
      hash(editKey), this.now(), this.now(), this.now(), claim.domain,
    ])
    this.db.run('DELETE FROM claims WHERE domain = ?', [claim.domain])
    await this.checkSite(claim.domain, html).catch(() => {})
    return { ok: true, method, editKey }
  }

  authorized(input: unknown, editKey: unknown): boolean {
    const domain = normalizeDomain(input)
    if (!domain || typeof editKey !== 'string' || !editKey) return false
    const stored = this.row(domain)?.edit_key_hash as string | undefined
    if (!stored) return false
    const a = Buffer.from(stored)
    const b = Buffer.from(hash(editKey))
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** Owner edits. Every field is trimmed, length-capped and stripped of control characters; links must be http(s). */
  edit(input: unknown, editKey: unknown, changes: ListingEdit, isMoshpitName: (name: string) => boolean): Listing | null {
    const domain = normalizeDomain(input)
    if (!domain || !this.authorized(domain, editKey)) return null
    const current = this.toListing(this.row(domain), domain)
    const pick = <K extends keyof ListingEdit>(key: K, fix: (v: unknown) => Listing[K]): Listing[K] => (changes[key] !== undefined ? fix(changes[key]) : current[key])
    const next = {
      name: pick('name', (v) => clean(v, LIMITS.name)),
      description: pick('description', (v) => clean(v, LIMITS.description)),
      hours: pick('hours', (v) => clean(v, LIMITS.hours)),
      address: pick('address', (v) => clean(v, LIMITS.address)),
      phone: pick('phone', (v) => clean(v, LIMITS.phone)),
      links: pick('links', (v) => cleanLinks(v)),
      moshpit: pick('moshpit', (v) => clean(v, LIMITS.moshpit).toLowerCase()),
      operator: pick('operator', (v) => normalizeOperator(v) ?? ''),
      company: pick('company', (v) => clean(v, LIMITS.company)),
      companyUrl: pick('companyUrl', (v) => normalizeWebUrl(v) ?? ''),
      category: pick('category', (v) => categoryOf(v)?.slug ?? ''),
      area: pick('area', (v) => clean(v, LIMITS.area)),
      city: pick('city', (v) => clean(v, LIMITS.place)),
      region: pick('region', (v) => clean(v, LIMITS.place)),
      country: pick('country', (v) => clean(v, LIMITS.place)),
      services: pick('services', (v) => cleanServices(v)),
      price: pick('price', (v) => (PRICES.some((p) => p.slug === v) ? String(v) : '')),
      ring: pick('ring', (v) => v !== false && v !== 'out' && v !== 'false' && v !== '0'),
      listed: pick('listed', (v) => v !== false && v !== 'out' && v !== 'false' && v !== '0'),
    }
    if (next.moshpit && !isMoshpitName(next.moshpit)) next.moshpit = ''
    this.db.run(
      'UPDATE listings SET name = ?, description = ?, hours = ?, address = ?, phone = ?, links = ?, moshpit = ?, operator = ?, company = ?, company_url = ?, category = ?, area = ?, city = ?, region = ?, country = ?, services = ?, price = ?, ring_opt_out = ?, directory_opt_out = ?, updated_at = ? WHERE domain = ?',
      [
        next.name, next.description, next.hours, next.address, next.phone, JSON.stringify(next.links), next.moshpit,
        next.operator, next.company, next.companyUrl, next.category, next.area, next.city, next.region, next.country, JSON.stringify(next.services), next.price,
        next.ring ? 0 : 1, next.listed ? 0 : 1, this.now(), domain,
      ],
    )
    return this.toListing(this.row(domain), domain)
  }

  /** Whether quote requests have somewhere to go, without saying where. Owners only. */
  contactStatus(input: unknown, editKey: unknown): ContactStatus | null {
    const domain = normalizeDomain(input)
    if (!domain || !this.authorized(domain, editKey)) return null
    const row = this.row(domain)
    if (row.contact_pending && (row.contact_requested_at ?? 0) >= this.now() - CONTACT_TTL_MS) return 'pending'
    return row.contact_email ? 'confirmed' : 'none'
  }

  /**
   * Set (or clear, with '') the private address quote requests are sent to. A new address only takes
   * effect when someone clicks the link mailed to it, so a listing can never point pit.world's mail at
   * an inbox that did not ask for it.
   */
  async setContact(input: unknown, editKey: unknown, email: unknown): Promise<ContactResult> {
    const domain = normalizeDomain(input)
    if (!domain || !this.authorized(domain, editKey)) return 'unauthorized'
    if (email === '' || email === null) {
      this.db.run("UPDATE listings SET contact_email = '', contact_pending = '', contact_token_hash = NULL WHERE domain = ?", [domain])
      return 'cleared'
    }
    const address = normalizeEmail(email)
    if (!address) return 'invalid'
    const row = this.row(domain)
    if (address === row.contact_email) return 'unchanged'
    if (!this.mailer) return 'unavailable'
    if (!(await this.mx(address.split('@')[1]!))) return 'undeliverable'
    const token = randomBytes(24).toString('base64url')
    this.db.run('UPDATE listings SET contact_pending = ?, contact_token_hash = ?, contact_requested_at = ? WHERE domain = ?', [address, hash(token), this.now(), domain])
    const link = `${this.site}/b/${encodeURIComponent(domain)}/contact?t=${token}`
    try {
      await this.mailer({
        to: address,
        subject: `Confirm quote requests for ${domain} on pit.world`,
        text: `The owner of the ${domain} listing on pit.world asked for quote requests to be sent to this address.\n\nConfirm: ${link}\n\nThe address is never shown on the listing. If this wasn't you, ignore this email and nothing will be sent here.`,
        html: `<p>The owner of the <b>${escHtml(domain)}</b> listing on pit.world asked for quote requests to be sent to this address.</p><p><a href="${escHtml(link)}">Confirm this address</a></p><p>The address is never shown on the listing. If this wasn't you, ignore this email and nothing will be sent here.</p>`,
      })
      return 'pending'
    } catch {
      this.db.run("UPDATE listings SET contact_pending = '', contact_token_hash = NULL WHERE domain = ?", [domain])
      return 'failed'
    }
  }

  /** The link in the confirmation email. */
  confirmContact(input: unknown, token: unknown): boolean {
    const domain = normalizeDomain(input)
    if (!domain || typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return false
    const row = this.row(domain)
    if (!row?.contact_pending || !row.contact_token_hash || (row.contact_requested_at ?? 0) < this.now() - CONTACT_TTL_MS) return false
    const a = Buffer.from(String(row.contact_token_hash))
    const b = Buffer.from(hash(token))
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false
    this.db.run("UPDATE listings SET contact_email = contact_pending, contact_pending = '', contact_token_hash = NULL, updated_at = ? WHERE domain = ?", [this.now(), domain])
    return true
  }

  /**
   * One quote request, to one listing, from one person. The listing's address is never revealed: the mail
   * goes from pit.world with the sender's address as Reply-To. Limits per listing (hourly, daily) and for
   * the whole site; per-visitor limits are the caller's (see listings-routes). Nothing about the request
   * is stored beyond the time it was sent.
   */
  async requestQuote(input: unknown, form: QuoteInput): Promise<QuoteResult> {
    const domain = normalizeDomain(input)
    const row = domain ? this.row(domain) : null
    if (!domain || !row?.claimed_at || !row.contact_email || !this.mailer) return 'unavailable'
    const name = clean(form.name, 80)
    const email = normalizeEmail(form.email)
    const phone = clean(form.phone, 40)
    const message = clean(typeof form.message === 'string' ? form.message.replace(/\r\n?/g, '\n') : form.message, 3000)
    if (!name || !email || message.length < 10) return 'invalid'
    // A message that is mostly links is an advert, not a request for a quote.
    if ((message.match(/https?:\/\//gi) ?? []).length > 3) return 'invalid'
    const now = this.now()
    this.db.run('DELETE FROM quote_log WHERE at < ?', [now - 24 * 3600 * 1000])
    const hourCount = (this.db.query('SELECT COUNT(*) AS n FROM quote_log WHERE domain = ? AND at >= ?').get(domain, now - 3600 * 1000) as { n: number }).n
    const dayCount = (this.db.query('SELECT COUNT(*) AS n FROM quote_log WHERE domain = ?').get(domain) as { n: number }).n
    const siteCount = (this.db.query('SELECT COUNT(*) AS n FROM quote_log').get() as { n: number }).n
    if (hourCount >= QUOTE_LIMITS.hour || dayCount >= QUOTE_LIMITS.day || siteCount >= QUOTE_LIMITS.siteDay) return 'limited'
    if (!(await this.mx(email.split('@')[1]!))) return 'undeliverable'
    this.db.run('INSERT INTO quote_log (domain, at) VALUES (?, ?)', [domain, now])
    const title = row.name || domain
    const page = `${this.site}/b/${encodeURIComponent(domain)}`
    try {
      await this.mailer({
        to: row.contact_email,
        replyTo: email,
        subject: `Quote request for ${title} from ${name}`,
        text: `${name} <${email}>${phone ? `, ${phone}` : ''} sent this through your pit.world listing (${page}):\n\n${message}\n\n--\nReply to this email to answer ${name} directly. pit.world did not share your address with them, and keeps no copy of this message.`,
        html: `<p><b>${escHtml(name)}</b> &lt;${escHtml(email)}&gt;${phone ? `, ${escHtml(phone)}` : ''} sent this through your <a href="${escHtml(page)}">pit.world listing</a>:</p><blockquote style="white-space:pre-wrap">${escHtml(message)}</blockquote><p style="color:#666">Reply to this email to answer ${escHtml(name)} directly. pit.world did not share your address with them, and keeps no copy of this message.</p>`,
      })
      return 'sent'
    } catch {
      return 'failed'
    }
  }

  /** Claimed listings for the directory, newest edits first. Text matching is every word, anywhere. */
  directory(query: DirectoryQuery = {}): { total: number; listings: Listing[] } {
    const category = categoryOf(query.category)?.slug ?? ''
    const near = words(query.near)
    const terms = words(query.q)
    // Businesses a running promotion campaign features come first (in the campaign's order, then featured,
    // then by name); then featured (an editorial pick, never paid), owner-verified listings by latest edit,
    // and the ones pit.world listed itself. Filters below keep this order and pagination slices after them,
    // so every page, the API and the mobile view agree. claimedOnly leaves seeded ones out (the feed of claims).
    const rows = this.db
      .query(
        query.claimedOnly
          ? 'SELECT * FROM listings WHERE claimed_at IS NOT NULL ORDER BY updated_at DESC'
          : `SELECT *, (SELECT MIN(COALESCE(m.display_order, 1000000)) FROM promo_members m JOIN promo_campaigns pc ON pc.id = m.campaign_id
                       WHERE m.domain = listings.domain AND m.priority = 1 AND m.state = 'verified' AND pc.state IN ('active', 'paused')) AS promo_rank
             FROM listings WHERE (claimed_at IS NOT NULL OR seeded_at IS NOT NULL) AND directory_opt_out = 0
             ORDER BY CASE WHEN featured_paid_until > ? THEN 0 ELSE 1 END, promo_rank IS NULL, promo_rank, featured DESC, CASE WHEN promo_rank IS NULL THEN '' ELSE lower(name) END, claimed_at IS NULL, updated_at DESC, domain`,
      )
      .all(...(query.claimedOnly ? [] : [this.now()])) as any[]
    const matched = rows
      .map((row) => this.toListing(row, row.domain))
      .filter((l) => !category || l.category === category)
      .filter((l) => {
        if (!near.length) return true
        const place = [l.area, l.city, l.region, l.country, l.address].join(' ').toLowerCase()
        return near.every((w) => place.includes(w))
      })
      .filter((l) => {
        if (!terms.length) return true
        const text = [l.domain, l.name, l.description, l.company, l.services.join(' '), categoryOf(l.category)?.label ?? ''].join(' ').toLowerCase()
        return terms.every((w) => text.includes(w))
      })
    const offset = Math.max(0, Math.trunc(query.offset ?? 0))
    const limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? 20)))
    return { total: matched.length, listings: matched.slice(offset, offset + limit) }
  }

  /** How many directory listings (claimed or listed by pit.world) each category has. */
  categoryCounts(): Record<string, number> {
    const rows = this.db.query("SELECT category, COUNT(*) AS n FROM listings WHERE (claimed_at IS NOT NULL OR seeded_at IS NOT NULL) AND directory_opt_out = 0 AND category <> '' GROUP BY category").all() as Array<{ category: string; n: number }>
    return Object.fromEntries(rows.map((r) => [r.category, r.n]))
  }

  /** The pit.world web ring: every claimed *.pit.world or Moshpit listing that has not opted out, in the order they joined. */
  ringMembers(): RingMember[] {
    const rows = this.db
      .query(`SELECT domain, name, description, moshpit_only, feed_url, ring_joined_at FROM listings WHERE claimed_at IS NOT NULL AND ring_opt_out = 0 AND (moshpit_only = 1 OR domain LIKE '%.pit.world') ORDER BY ring_joined_at, domain`)
      .all() as any[]
    return rows.map((r) => ({ domain: r.domain, name: r.name || r.domain, description: r.description, moshpitOnly: Boolean(r.moshpit_only), feed: r.feed_url, joinedAt: r.ring_joined_at ?? 0 }))
  }

  /**
   * List a business pit.world found in public records (a contractor's license, its own website), before
   * its owner has claimed it. Refuses a claimed listing: once the owner has it, pit.world never writes to
   * it again. Re-seeding the same domain updates what pit.world wrote and keeps its view count.
   */
  seed(input: SeedInput): Listing | null {
    const domain = normalizeDomain(input.domain)
    const name = clean(input.name, LIMITS.name)
    if (!domain || !name) return null
    const row = this.row(domain)
    if (row?.claimed_at) return null
    const values = [
      name,
      clean(input.description, LIMITS.description),
      clean(input.phone, LIMITS.phone),
      clean(input.address, LIMITS.address),
      JSON.stringify(cleanLinks(input.links ?? [])),
      categoryOf(input.category)?.slug ?? '',
      clean(input.area, LIMITS.area),
      clean(input.city, LIMITS.place),
      clean(input.region, LIMITS.place),
      clean(input.country, LIMITS.place),
      JSON.stringify(cleanServices(input.services ?? [])),
      clean(input.license, LIMITS.license),
      input.licenseCheckedAt ?? null,
      Math.trunc(Number(input.featured ?? 0)) || 0,
    ]
    if (!row) this.db.run('INSERT INTO listings (domain) VALUES (?)', [domain])
    this.db.run(
      'UPDATE listings SET name = ?, description = ?, phone = ?, address = ?, links = ?, category = ?, area = ?, city = ?, region = ?, country = ?, services = ?, license = ?, license_checked_at = ?, featured = ?, seeded_at = COALESCE(seeded_at, ?), updated_at = ? WHERE domain = ? AND claimed_at IS NULL',
      [...values, this.now(), this.now(), domain],
    )
    return this.toListing(this.row(domain), domain)
  }

  /** Take a listing pit.world wrote back out of the directory (an owner asked, or a license lapsed). */
  unseed(input: unknown): boolean {
    const domain = normalizeDomain(input)
    if (!domain) return false
    return this.db.run('DELETE FROM listings WHERE domain = ? AND claimed_at IS NULL AND seeded_at IS NOT NULL', [domain]).changes > 0
  }

  /** Count one view of a listing that is in the directory. Bare unclaimed pages are not counted. */
  view(input: unknown): void {
    const domain = normalizeDomain(input)
    if (domain) this.db.run('UPDATE listings SET views = views + 1 WHERE domain = ? AND (claimed_at IS NOT NULL OR seeded_at IS NOT NULL)', [domain])
  }

  /** Every listing in the directory, for the sitemap. */
  directoryDomains(): string[] {
    return (this.db.query('SELECT domain FROM listings WHERE (claimed_at IS NOT NULL OR seeded_at IS NOT NULL) AND directory_opt_out = 0 ORDER BY featured DESC, domain').all() as Array<{ domain: string }>).map((r) => r.domain)
  }

  /** Read a claimed site's homepage again: its feed, and whether it has an ICANN address at all. */
  async checkSite(domain: string, html: string | null = null): Promise<void> {
    const resolves = this.verifier.resolves ? await this.verifier.resolves(domain) : true
    const page = html ?? (await this.verifier.homepage(domain))
    if (page === null) this.db.run('UPDATE listings SET moshpit_only = ?, site_checked_at = ? WHERE domain = ?', [resolves ? 0 : 1, this.now(), domain])
    else this.db.run('UPDATE listings SET moshpit_only = ?, feed_url = ?, site_checked_at = ? WHERE domain = ?', [resolves ? 0 : 1, discoverFeed(page, `https://${domain}/`), this.now(), domain])
  }

  /** The daily pass: every claimed listing not checked in the last day, one at a time. */
  async checkSites(maxAgeMs = 24 * 3600 * 1000): Promise<number> {
    const due = this.db.query('SELECT domain FROM listings WHERE claimed_at IS NOT NULL AND (site_checked_at IS NULL OR site_checked_at < ?)').all(this.now() - maxAgeMs) as Array<{ domain: string }>
    for (const { domain } of due) await this.checkSite(domain).catch(() => {})
    return due.length
  }
}
