/**
 * The pit.world promoter program: bring people to the Mosh Pit, keep 20% of
 * everything they spend.
 *
 * It fits pit.world's no-tracking posture. Nothing is logged per click — a
 * referral is recorded only at the moment a person *converts* (starts a
 * membership), and the promoter code rides the URL through sign-in, so no
 * tracking cookie is ever set. A promoter is just an account that joined; the
 * code is its public, shareable id.
 *
 * Billing is staged: a membership starts as a free 30-day trial here. The $2/mo
 * charge after the trial and the 20% payout execution are a separate CoinPay
 * integration (none exists in this repo yet). Commission is accrued in a ledger
 * the moment a referred account spends — recordCommission() — so the dashboard
 * is honest from day one even before payouts are automated.
 */
import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Promoter = { account_id: string; code: string; created_at: number }
export type Membership = { status: string; trial_end: number | null; referred_by: string | null }
export type PromoterStats = {
  code: string
  referred: number
  commission_cents: number
  trial_end: number | null
  member_status: string | null
}

/** Trial length before the $2/mo membership would begin. */
export const TRIAL_MS = 30 * 24 * 60 * 60 * 1000
/** The house commission rate, applied to everything a referral spends. */
export const COMMISSION_RATE = 0.2

// No vowels and no ambiguous glyphs, so a code is safe to read aloud and type.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
export const CODE_RE = /^[a-hj-km-np-z2-9]{8}$/

export class Promoters {
  readonly db: Database

  constructor(path = ':memory:', private now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run(
      `CREATE TABLE IF NOT EXISTS promoters (
        account_id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL)`,
    )
    this.db.run(
      `CREATE TABLE IF NOT EXISTS members (
        account_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        trial_end INTEGER,
        referred_by TEXT,
        created_at INTEGER NOT NULL)`,
    )
    // One row per attributed spend, so a payout run is a sum over a promoter.
    this.db.run(
      `CREATE TABLE IF NOT EXISTS commissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        promoter_code TEXT NOT NULL,
        referred_account_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL)`,
    )
    this.db.run('CREATE INDEX IF NOT EXISTS idx_members_ref ON members(referred_by)')
    this.db.run('CREATE INDEX IF NOT EXISTS idx_commissions_code ON commissions(promoter_code)')
  }

  private genCode(): string {
    for (;;) {
      let code = ''
      for (const b of randomBytes(8)) code += CODE_ALPHABET[b % CODE_ALPHABET.length]
      if (!this.byCode(code)) return code
    }
  }

  /** Make this account a promoter, or return the one it already is. Idempotent. */
  join(accountId: string): Promoter {
    const existing = this.byAccount(accountId)
    if (existing) return existing
    const promoter: Promoter = { account_id: accountId, code: this.genCode(), created_at: this.now() }
    this.db.run('INSERT INTO promoters (account_id, code, created_at) VALUES (?, ?, ?)', [promoter.account_id, promoter.code, promoter.created_at])
    return promoter
  }

  byAccount(accountId: string): Promoter | null {
    return this.db.query<Promoter, [string]>('SELECT account_id, code, created_at FROM promoters WHERE account_id = ?').get(accountId) ?? null
  }

  byCode(code: string): Promoter | null {
    if (!CODE_RE.test(code)) return null
    return this.db.query<Promoter, [string]>('SELECT account_id, code, created_at FROM promoters WHERE code = ?').get(code) ?? null
  }

  member(accountId: string): Membership | null {
    return this.db.query<Membership, [string]>('SELECT status, trial_end, referred_by FROM members WHERE account_id = ?').get(accountId) ?? null
  }

  /**
   * Start a membership on a free 30-day trial, or return the existing one. The
   * referrer is attributed exactly once, here, and only when the code is real
   * and is not the member's own.
   */
  startMembership(accountId: string, refCode?: string | null): Membership {
    const existing = this.member(accountId)
    if (existing) return existing
    let referred_by: string | null = null
    if (refCode) {
      const promoter = this.byCode(refCode)
      if (promoter && promoter.account_id !== accountId) referred_by = promoter.code
    }
    const now = this.now()
    const membership: Membership = { status: 'trialing', trial_end: now + TRIAL_MS, referred_by }
    this.db.run('INSERT INTO members (account_id, status, trial_end, referred_by, created_at) VALUES (?, ?, ?, ?, ?)', [accountId, membership.status, membership.trial_end, referred_by, now])
    return membership
  }

  /**
   * Accrue commission owed to a promoter for a referred account's spend. Called
   * when a charge lands (staged billing); 20% of the amount by house rate.
   */
  recordSpend(referredAccountId: string, amountCents: number, note = ''): number {
    const m = this.member(referredAccountId)
    if (!m?.referred_by) return 0
    const commission = Math.round(amountCents * COMMISSION_RATE)
    if (commission <= 0) return 0
    this.db.run('INSERT INTO commissions (promoter_code, referred_account_id, amount_cents, note, created_at) VALUES (?, ?, ?, ?, ?)', [m.referred_by, referredAccountId, commission, note, this.now()])
    return commission
  }

  stats(accountId: string): PromoterStats | null {
    const promoter = this.byAccount(accountId)
    if (!promoter) return null
    const referred = this.db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM members WHERE referred_by = ?').get(promoter.code)?.n ?? 0
    const commission_cents = this.db.query<{ s: number }, [string]>('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM commissions WHERE promoter_code = ?').get(promoter.code)?.s ?? 0
    const m = this.member(accountId)
    return { code: promoter.code, referred, commission_cents, trial_end: m?.trial_end ?? null, member_status: m?.status ?? null }
  }

  count(): number {
    return this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM promoters').get()?.n ?? 0
  }
}
