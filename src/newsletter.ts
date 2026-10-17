/**
 * The pit.world newsletter: double opt-in, and nothing kept that isn't needed.
 *
 * A signup stores a hash of a random token beside the address, for 48 hours at most.
 * Only clicking the link in the confirmation email puts the address on the list. No IP,
 * no browser, no referrer is ever stored. Issues go out through myna, which reads the
 * confirmed list from /api/admin/subscribers.csv and handles unsubscribes.
 */
import { Database } from 'bun:sqlite'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { resolveMx } from 'node:dns/promises'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const PENDING_TTL_MS = 48 * 3600 * 1000
const FROM = 'pit.world <hello@pit.world>'

export type Mailer = (message: { to: string; subject: string; text: string; html: string; replyTo?: string }) => Promise<void>
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

/** Can this domain receive mail at all? A domain with no MX (and no A fallback worth trusting) cannot confirm. */
export const dnsMx: MxLookup = async (domain) => {
  try {
    return (await resolveMx(domain)).some((r) => r.exchange && r.exchange !== '.')
  } catch {
    return false
  }
}

export function resendMailer(apiKey: string, fetchImpl: typeof fetch = fetch): Mailer {
  return async ({ to, subject, text, html, replyTo }) => {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
    })
    if (!res.ok) throw new Error(`mail provider answered ${res.status}`)
  }
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export type SignupResult = 'sent' | 'invalid' | 'undeliverable' | 'already' | 'failed'

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
  }

  get enabled(): boolean {
    return this.mailer !== null
  }

  private sweep() {
    this.db.run('DELETE FROM pending WHERE created_at < ?', [this.now() - PENDING_TTL_MS])
  }

  /** Start a signup. Callers show the same page for every outcome but 'invalid', so the list cannot be probed. */
  async signup(input: unknown): Promise<SignupResult> {
    const email = normalizeEmail(input)
    if (!email) return 'invalid'
    this.sweep()
    if (this.db.query('SELECT 1 FROM subscribers WHERE email = ?').get(email)) return 'already'
    if (!this.mailer) return 'failed'
    if (!(await this.mx(email.split('@')[1]!))) return 'undeliverable'
    const token = randomBytes(24).toString('base64url')
    this.db.run('DELETE FROM pending WHERE email = ?', [email])
    this.db.run('INSERT INTO pending (token_hash, email, created_at) VALUES (?, ?, ?)', [hash(token), email, this.now()])
    const link = `${this.site}/confirm?t=${token}`
    try {
      await this.mailer({
        to: email,
        subject: 'Confirm your pit.world newsletter signup',
        text: `Someone (hopefully you) asked to get the pit.world newsletter at this address.\n\nConfirm: ${link}\n\nIf it wasn't you, ignore this email: without a click, the address is forgotten in 48 hours.\n\npit.world: private search, and the doorway to the Moshpit network.`,
        html: `<p>Someone (hopefully you) asked to get the pit.world newsletter at this address.</p><p><a href="${link}">Confirm my signup</a></p><p>If it wasn't you, ignore this email: without a click, the address is forgotten in 48 hours.</p><p>pit.world: private search, and the doorway to the Moshpit network.</p>`,
      })
      return 'sent'
    } catch {
      this.db.run('DELETE FROM pending WHERE token_hash = ?', [hash(token)])
      return 'failed'
    }
  }

  /** The link in the email. Returns the confirmed address, or null for an unknown or expired token. */
  confirm(token: unknown): string | null {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null
    this.sweep()
    const row = this.db.query('SELECT email FROM pending WHERE token_hash = ?').get(hash(token)) as { email: string } | null
    if (!row) return null
    this.db.run('INSERT OR IGNORE INTO subscribers (email, confirmed_at) VALUES (?, ?)', [row.email, this.now()])
    this.db.run('DELETE FROM pending WHERE email = ?', [row.email])
    return row.email
  }

  /** Confirmed subscribers as CSV, for `myna newsletter subscribers import`. */
  csv(): string {
    const rows = this.db.query('SELECT email, confirmed_at FROM subscribers ORDER BY confirmed_at').all() as Array<{ email: string; confirmed_at: number }>
    return ['email,confirmed_at', ...rows.map((r) => `${r.email},${new Date(r.confirmed_at).toISOString()}`)].join('\n') + '\n'
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
