/**
 * The pit.world newsletter: double opt-in, and nothing kept that isn't needed.
 *
 * A signup stores a hash of a random token beside the address, for 48 hours at most.
 * Only clicking the link in the confirmation email puts the address on the list. No IP,
 * no browser, no referrer is ever stored. Issues go out through myna, which reads the
 * confirmed list from /api/admin/subscribers.csv and handles unsubscribes.
 *
 * This is also the one newsletter endpoint for every Profullstack property: the
 * @profullstack/footer subscribe form posts here with a hidden `site`, and the property
 * (a bare hostname, never a page or a referrer) is kept beside the address so the list
 * shows where each signup came from. pit.world, *.pit.world and Moshpit names get the
 * pit.world copy; every other property gets the Profullstack copy.
 */
import { Database } from 'bun:sqlite'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { resolveMx } from 'node:dns/promises'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { onPit } from './footer.js'

const PENDING_TTL_MS = 48 * 3600 * 1000
const FROM = 'pit.world <hello@pit.world>'
// The Resend key can only send from pit.world, so the network list keeps the address and changes the name.
const NETWORK_FROM = 'Profullstack <hello@pit.world>'
export const DEFAULT_SOURCE = 'pit.world'

export type Mailer = (message: { to: string; subject: string; text: string; html: string; replyTo?: string; from?: string }) => Promise<void>
export type MxLookup = (domain: string) => Promise<boolean>

/** Syntax only: one @, a dotted domain, no spaces, sane lengths. The confirmation email is the real check. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const email = input.trim().toLowerCase()
  if (email.length < 6 || email.length > 254) return null
  const match = /^([a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64})@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/.exec(email)
  if (!match) return null
  const [, local, domain] = match
  if (local!.startsWith('.') || local!.endsWith('.') || local!.includes('..')) return null
  if (!/\.[a-z]{2,}$/.test(domain!)) return null
  return email
}

/** The property a signup came from, as a bare lowercase hostname (no www.), or null. Accepts a URL or a host. */
export function normalizeSource(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) return null
  let host: string
  try {
    const raw = input.trim()
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return null
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '')
  if (host.length > 253 || !host.includes('.') || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..')) return null
  return host
}

/** Which newsletter a property's signups read as: pit.world's own, or the Profullstack network's. */
export function brandFor(source: string | null | undefined): { name: string; list: string; from: string; pit: boolean } {
  const pit = !source || onPit(source)
  return pit
    ? { name: 'pit.world', list: 'the pit.world newsletter', from: FROM, pit }
    : { name: 'Profullstack', list: 'the Profullstack newsletter', from: NETWORK_FROM, pit }
}

/** Can this domain receive mail at all? A domain with no MX (and no A fallback worth trusting) cannot confirm. */
export const dnsMx: MxLookup = async (domain) => {
  try {
    return (await resolveMx(domain)).some((r) => r.exchange && r.exchange !== '.')
  } catch {
    return false
  }
}

export function resendMailer(apiKey: string, fetchImpl: typeof fetch = fetch): Mailer {
  return async ({ to, subject, text, html, replyTo, from }) => {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: from ?? FROM, to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
    })
    if (!res.ok) throw new Error(`mail provider answered ${res.status}`)
  }
}

const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escHtml = (v: string) => v.replace(/[&<>"']/g, (c) => HTML_ESC[c]!)
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export type SignupResult = 'sent' | 'invalid' | 'undeliverable' | 'already' | 'failed'
export type PropertyCount = { source: string; confirmed: number; pending: number }
export type SubscriberRow = { email: string; confirmed_at: number; source: string; sources: string[] }

export class Newsletter {
  private db: Database

  constructor(
    path: string,
    private mailer: Mailer | null,
    private mx: MxLookup = dnsMx,
    private site = 'https://pit.world',
    private now = () => Date.now(),
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('CREATE TABLE IF NOT EXISTS pending (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL)')
    this.db.run('CREATE TABLE IF NOT EXISTS subscribers (email TEXT PRIMARY KEY, confirmed_at INTEGER NOT NULL)')
    // The property each signup came from. Rows from before sources existed came from pit.world's own form.
    for (const table of ['pending', 'subscribers']) {
      const cols = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'source')) this.db.run(`ALTER TABLE ${table} ADD COLUMN source TEXT NOT NULL DEFAULT '${DEFAULT_SOURCE}'`)
    }
    // Every property an address confirmed from (one address can sign up on several sites).
    this.db.run('CREATE TABLE IF NOT EXISTS subscriber_sources (email TEXT NOT NULL, source TEXT NOT NULL, confirmed_at INTEGER NOT NULL, PRIMARY KEY (email, source))')
    this.db.run(`INSERT OR IGNORE INTO subscriber_sources (email, source, confirmed_at) SELECT email, source, confirmed_at FROM subscribers`)
  }

  get enabled(): boolean {
    return this.mailer !== null
  }

  private sweep() {
    this.db.run('DELETE FROM pending WHERE created_at < ?', [this.now() - PENDING_TTL_MS])
  }

  /**
   * Start a signup. Callers show the same page for every outcome but 'invalid' and 'undeliverable', so the
   * list cannot be probed. An address already on the list gets a confirmation email too (its click records
   * the new property), so nobody is left waiting for a message that never comes.
   */
  async signup(input: unknown, sourceInput?: unknown): Promise<SignupResult> {
    const email = normalizeEmail(input)
    if (!email) return 'invalid'
    const source = normalizeSource(sourceInput) ?? DEFAULT_SOURCE
    this.sweep()
    const already = Boolean(this.db.query('SELECT 1 FROM subscribers WHERE email = ?').get(email))
    if (!this.mailer) return 'failed'
    if (!already && !(await this.mx(email.split('@')[1]!))) return 'undeliverable'
    const token = randomBytes(24).toString('base64url')
    this.db.run('DELETE FROM pending WHERE email = ?', [email])
    this.db.run('INSERT INTO pending (token_hash, email, created_at, source) VALUES (?, ?, ?, ?)', [hash(token), email, this.now(), source])
    const link = `${this.site}/confirm?t=${token}`
    const brand = brandFor(source)
    const via = source === DEFAULT_SOURCE ? '' : ` on ${source}`
    const lead = already
      ? `This address is already on ${brand.list}. Someone (hopefully you) signed up again${via}; confirm to note it, or ignore this.`
      : `Someone (hopefully you) asked to get ${brand.list} at this address${via}.`
    const tail = brand.pit ? 'pit.world: private search, and the doorway to the Moshpit network.' : 'Profullstack: the network of sites at profullstack.com/list.'
    try {
      await this.mailer({
        to: email,
        from: brand.from,
        subject: already ? `You're already on ${brand.list}` : `Confirm your ${brand.name} newsletter signup`,
        text: `${lead}\n\nConfirm: ${link}\n\nIf it wasn't you, ignore this email: without a click, nothing changes and the link expires in 48 hours.\n\n${tail}`,
        html: `<p>${escHtml(lead)}</p><p><a href="${link}">Confirm my signup</a></p><p>If it wasn't you, ignore this email: without a click, nothing changes and the link expires in 48 hours.</p><p>${escHtml(tail)}</p>`,
      })
      return already ? 'already' : 'sent'
    } catch {
      this.db.run('DELETE FROM pending WHERE token_hash = ?', [hash(token)])
      return 'failed'
    }
  }

  /** The link in the email. Returns the confirmed address and its property, or null for an unknown or expired token. */
  confirm(token: unknown): { email: string; source: string } | null {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null
    this.sweep()
    const row = this.db.query('SELECT email, source FROM pending WHERE token_hash = ?').get(hash(token)) as { email: string; source: string } | null
    if (!row) return null
    const at = this.now()
    this.db.run('INSERT OR IGNORE INTO subscribers (email, confirmed_at, source) VALUES (?, ?, ?)', [row.email, at, row.source])
    this.db.run('INSERT OR IGNORE INTO subscriber_sources (email, source, confirmed_at) VALUES (?, ?, ?)', [row.email, row.source, at])
    this.db.run('DELETE FROM pending WHERE email = ?', [row.email])
    return { email: row.email, source: row.source }
  }

  /** Confirmed subscribers, oldest first: `source` is the first property, `sources` every property confirmed from. */
  subscribers(source?: string): SubscriberRow[] {
    const rows = this.db.query('SELECT email, confirmed_at, source FROM subscribers ORDER BY confirmed_at').all() as Array<{ email: string; confirmed_at: number; source: string }>
    const all = this.db.query('SELECT email, source FROM subscriber_sources ORDER BY confirmed_at').all() as Array<{ email: string; source: string }>
    const by = new Map<string, string[]>()
    for (const r of all) by.set(r.email, [...(by.get(r.email) ?? []), r.source])
    const out = rows.map((r) => ({ ...r, sources: by.get(r.email) ?? [r.source] }))
    return source ? out.filter((r) => r.sources.includes(source)) : out
  }

  /** Confirmed and pending signups per property, most confirmed first. */
  byProperty(): PropertyCount[] {
    this.sweep()
    const counts = new Map<string, PropertyCount>()
    const get = (source: string) => counts.get(source) ?? (counts.set(source, { source, confirmed: 0, pending: 0 }), counts.get(source)!)
    for (const r of this.db.query('SELECT source, COUNT(*) AS n FROM subscriber_sources GROUP BY source').all() as Array<{ source: string; n: number }>) get(r.source).confirmed = r.n
    for (const r of this.db.query('SELECT source, COUNT(*) AS n FROM pending GROUP BY source').all() as Array<{ source: string; n: number }>) get(r.source).pending = r.n
    return [...counts.values()].sort((a, b) => b.confirmed - a.confirmed || b.pending - a.pending || a.source.localeCompare(b.source))
  }

  /** Confirmed subscribers as CSV, for `myna newsletter subscribers import`. `source` is the first property, `sources` all of them. */
  csv(source?: string): string {
    const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    return ['email,confirmed_at,source,sources', ...this.subscribers(source).map((r) => [r.email, new Date(r.confirmed_at).toISOString(), r.source, r.sources.join(' ')].map(q).join(','))].join('\n') + '\n'
  }

  count(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM subscribers').get() as { n: number }).n
  }

  pendingCount(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM pending').get() as { n: number }).n
  }
}

/** Constant-time comparison of the admin bearer token. */
export function adminAuthorized(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice(7))
  const want = Buffer.from(expected)
  return given.length === want.length && timingSafeEqual(given, want)
}
