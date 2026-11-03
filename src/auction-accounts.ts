/**
 * Accounts for the Art Auctions House: sign in with CoinPay only, through the pit.world bridge
 * (the same one Daily Stitcher uses). A person is their CoinPay `sub`; email is never an identity.
 * Also: the private per-account settings (a CoinPay pay link for getting paid directly, and an
 * email for auction notices), and the auction bid ledger.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Database } from 'bun:sqlite'

export type Identity = { sub: string; name: string | null }

export const SESSION_COOKIE = 'aa_session'
export const BRIDGE_COOKIE = 'aa_bridge'
export const SESSION_TTL = 30 * 86_400

const sign = (value: string, secret: string) => createHmac('sha256', secret).update(value).digest('base64url')

export function sessionValue(identity: Identity, secret: string, now: number): string {
  const payload = Buffer.from(JSON.stringify({ sub: identity.sub, name: identity.name, exp: now + SESSION_TTL * 1000 })).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

export function readSession(value: string | undefined, secret: string, now: number): Identity | null {
  if (!value || !secret || value.length > 1800) return null
  const [payload, signature, ...extra] = value.split('.')
  if (!payload || !signature || extra.length) return null
  const a = Buffer.from(signature), b = Buffer.from(sign(payload, secret))
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof data.sub !== 'string' || !data.sub || data.sub.length > 300 || !Number.isFinite(data.exp) || data.exp <= now) return null
    return { sub: data.sub, name: typeof data.name === 'string' ? data.name.slice(0, 80) : null }
  } catch {
    return null
  }
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  return Object.fromEntries(String(header ?? '').split(';').flatMap((part) => {
    const i = part.indexOf('=')
    if (i <= 0) return []
    try { return [[part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())]] } catch { return [] }
  }))
}

/** Only same-site paths; anything else returns home. */
export const safeReturn = (value: unknown): string => {
  const v = String(value ?? '')
  return v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') && v.length < 300 ? v : '/'
}

/** Where buyers may be sent to pay an artist directly: CoinPay and pay.agent only. */
const PAY_HOSTS = new Set(['coinpayportal.com', 'www.coinpayportal.com', 'pay.agent.pit.world'])
export function cleanPayLink(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || !PAY_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || raw.length > 300) return null
    return url.href
  } catch {
    return null
  }
}

export type AccountRow = { sub: string; name: string; pay_link: string; email: string; updated_at: number }
export type Bid = { id: number; artwork_id: string; bidder_sub: string; bidder_name: string; amount_usd: number; created_at: number }

/** Each bid must clear the starting bid, or the current high bid by this much. */
export const BID_STEP_USD = 5

export class BidError extends Error {}

export class AuctionLedger {
  constructor(readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS auction_accounts (
      sub TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', pay_link TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auction_bids (
      id INTEGER PRIMARY KEY AUTOINCREMENT, artwork_id TEXT NOT NULL, bidder_sub TEXT NOT NULL, bidder_name TEXT NOT NULL,
      amount_usd INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auction_bids_artwork ON auction_bids(artwork_id, amount_usd DESC);
    CREATE INDEX IF NOT EXISTS auction_bids_bidder ON auction_bids(bidder_sub, created_at DESC);`)
  }

  account(sub: string): AccountRow | null {
    return this.db.query<AccountRow, [string]>('SELECT * FROM auction_accounts WHERE sub = ?').get(sub) ?? null
  }

  /** Record who signed in (the name shown on bids), keeping their settings. */
  touch(identity: Identity, now: number) {
    this.db.query(`INSERT INTO auction_accounts (sub, name, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(sub) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`).run(identity.sub, (identity.name ?? '').slice(0, 80), now)
  }

  saveSettings(sub: string, settings: { payLink: unknown; email: unknown }, now: number) {
    const payLink = cleanPayLink(settings.payLink)
    if (payLink === null) throw new BidError('Use a CoinPay or pay.agent link that starts with https://coinpayportal.com or https://pay.agent.pit.world.')
    const email = String(settings.email ?? '').trim().toLowerCase()
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) throw new BidError('That email address does not look right.')
    this.db.query(`INSERT INTO auction_accounts (sub, pay_link, email, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(sub) DO UPDATE SET pay_link = excluded.pay_link, email = excluded.email, updated_at = excluded.updated_at`).run(sub, payLink, email, now)
  }

  bids(artworkId: string): Bid[] {
    return this.db.query<Bid, [string]>('SELECT * FROM auction_bids WHERE artwork_id = ? ORDER BY amount_usd DESC, created_at ASC').all(artworkId)
  }

  high(artworkId: string): Bid | null {
    return this.db.query<Bid, [string]>('SELECT * FROM auction_bids WHERE artwork_id = ? ORDER BY amount_usd DESC, created_at ASC LIMIT 1').get(artworkId) ?? null
  }

  minimumNext(startingBid: number, artworkId: string): number {
    const high = this.high(artworkId)
    return high ? high.amount_usd + BID_STEP_USD : startingBid
  }

  /** Validated and written in one transaction, so two bids cannot both take the same step. */
  place(auction: { id: string; startingBid: number; endsAt: number; ownerSub: string }, identity: Identity, amount: unknown, now: number): Bid {
    const value = Number(amount)
    if (!Number.isInteger(value) || value <= 0 || value > 1_000_000) throw new BidError('Bid a whole number of dollars.')
    return this.db.transaction(() => {
      if (now >= auction.endsAt) throw new BidError('This auction has ended.')
      if (auction.ownerSub && auction.ownerSub === identity.sub) throw new BidError('You cannot bid on your own piece.')
      const min = this.minimumNext(auction.startingBid, auction.id)
      if (value < min) throw new BidError(`The next bid must be at least $${min}.`)
      const name = (this.account(identity.sub)?.name || identity.name || 'A bidder').slice(0, 80)
      const result = this.db.query('INSERT INTO auction_bids (artwork_id, bidder_sub, bidder_name, amount_usd, created_at) VALUES (?, ?, ?, ?, ?)').run(auction.id, identity.sub, name, value, now)
      return this.db.query<Bid, [number]>('SELECT * FROM auction_bids WHERE id = ?').get(Number(result.lastInsertRowid))!
    })()
  }

  myBids(sub: string): (Bid & { title: string; ends_at: number | null; closed_at: number | null })[] {
    return this.db.query<Bid & { title: string; ends_at: number | null; closed_at: number | null }, [string]>(`SELECT b.*, a.title, a.ends_at, a.closed_at FROM auction_bids b
      JOIN auction_artworks a ON a.id = b.artwork_id WHERE b.bidder_sub = ? ORDER BY b.created_at DESC LIMIT 100`).all(sub)
  }
}
