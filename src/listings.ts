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

export type Listing = {
  domain: string
  name: string
  description: string
  hours: string
  address: string
  phone: string
  links: string[]
  moshpit: string
  claimed: boolean
  updatedAt: number | null
}

export type ListingEdit = Partial<Pick<Listing, 'name' | 'description' | 'hours' | 'address' | 'phone' | 'links' | 'moshpit'>>

export type Verifier = {
  txt(host: string): Promise<string[]>
  homepage(domain: string): Promise<string | null>
}

const LIMITS = { name: 80, description: 600, hours: 200, address: 200, phone: 40, link: 300, links: 5, moshpit: 253 }
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

function clean(value: unknown, max: number): string {
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

export class Listings {
  private db: Database

  constructor(
    path: string,
    private verifier: Verifier = liveVerifier(),
    private now = () => Date.now(),
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run(`CREATE TABLE IF NOT EXISTS listings (
      domain TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      hours TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      links TEXT NOT NULL DEFAULT '[]', moshpit TEXT NOT NULL DEFAULT '',
      edit_key_hash TEXT, claimed_at INTEGER, updated_at INTEGER, meta_at INTEGER)`)
    this.db.run('CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, domain TEXT NOT NULL, token TEXT NOT NULL, created_at INTEGER NOT NULL)')
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
      claimed: Boolean(row?.claimed_at),
      updatedAt: row?.updated_at ?? null,
    }
  }

  /** A claimed listing as its owner wrote it; otherwise what the homepage says, refreshed once a day. */
  async get(input: unknown, options: { fetchMeta?: boolean } = {}): Promise<Listing | null> {
    const domain = normalizeDomain(input)
    if (!domain) return null
    let row = this.row(domain)
    const stale = !row || (!row.claimed_at && (row.meta_at ?? 0) < this.now() - META_TTL_MS)
    if (stale && options.fetchMeta !== false) {
      const html = await this.verifier.homepage(domain)
      if (html) {
        const meta = readMeta(html)
        if (row) this.db.run('UPDATE listings SET name = ?, description = ?, meta_at = ? WHERE domain = ? AND claimed_at IS NULL', [meta.name, meta.description, this.now(), domain])
        else this.db.run('INSERT INTO listings (domain, name, description, meta_at) VALUES (?, ?, ?, ?)', [domain, meta.name, meta.description, this.now()])
        row = this.row(domain)
      }
    }
    return this.toListing(row, domain)
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
    if ((await this.verifier.txt(`_pit-verify.${claim.domain}`)).some((t) => t.trim() === claim.token || t.trim() === value)) method = 'dns'
    else {
      const html = await this.verifier.homepage(claim.domain)
      const tags = html?.match(/<meta\b[^>]*>/gi) ?? []
      if (tags.some((tag) => /name\s*=\s*["']pit-verify["']/i.test(tag) && new RegExp(`content\\s*=\\s*["']${value}["']`, 'i').test(tag))) method = 'meta'
    }
    if (!method) return { ok: false, reason: 'not-found' }
    const editKey = `pitk_${randomBytes(24).toString('base64url')}`
    if (!this.row(claim.domain)) this.db.run('INSERT INTO listings (domain) VALUES (?)', [claim.domain])
    this.db.run('UPDATE listings SET edit_key_hash = ?, claimed_at = ?, updated_at = ? WHERE domain = ?', [hash(editKey), this.now(), this.now(), claim.domain])
    this.db.run('DELETE FROM claims WHERE domain = ?', [claim.domain])
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
    const next = {
      name: changes.name !== undefined ? clean(changes.name, LIMITS.name) : current.name,
      description: changes.description !== undefined ? clean(changes.description, LIMITS.description) : current.description,
      hours: changes.hours !== undefined ? clean(changes.hours, LIMITS.hours) : current.hours,
      address: changes.address !== undefined ? clean(changes.address, LIMITS.address) : current.address,
      phone: changes.phone !== undefined ? clean(changes.phone, LIMITS.phone) : current.phone,
      links: changes.links !== undefined ? cleanLinks(changes.links) : current.links,
      moshpit: changes.moshpit !== undefined ? clean(changes.moshpit, LIMITS.moshpit).toLowerCase() : current.moshpit,
    }
    if (next.moshpit && !isMoshpitName(next.moshpit)) next.moshpit = ''
    this.db.run('UPDATE listings SET name = ?, description = ?, hours = ?, address = ?, phone = ?, links = ?, moshpit = ?, updated_at = ? WHERE domain = ?', [
      next.name, next.description, next.hours, next.address, next.phone, JSON.stringify(next.links), next.moshpit, this.now(), domain,
    ])
    return this.toListing(this.row(domain), domain)
  }
}
