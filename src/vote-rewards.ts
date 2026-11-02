/**
 * Points for helping the ranking: a signed-in account earns a point for each distinct thing it votes
 * on (a result on a search, a listing, a blog...), up to DAILY_CAP a day.
 *
 * Built so it cannot be farmed by clicking:
 * - one point per (account, item, search), ever: voting again, or the other way, earns nothing more;
 * - a vote taken back the same UTC day takes its point back (no toggle farming); taken back later,
 *   the point stays, because changing your mind once a site is fixed is exactly what we want;
 * - only signed-in votes earn, and the vote itself already passed the fingerprint and bot gate.
 *
 * Points are a ledger, not money. Turning them into CoinPay payouts needs a rate per point
 * (PIT_VOTE_POINT_USD) and an operator approving each payout; neither is set here. Until both are,
 * people see their points and that payouts are coming, and nothing is paid.
 */
import type { Database } from 'bun:sqlite'

/** Points an account can earn in one UTC day. */
export const DAILY_CAP = 25

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10)

export type PointsSummary = { points: number; today: number; cap: number; paid: number; unpaid: number; usdPerPoint: number | null; unpaidUsd: number | null }

export class VoteRewards {
  constructor(
    readonly db: Database,
    private readonly options: { usdPerPoint?: number | null; now?: () => number } = {},
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS vote_points (
      account TEXT NOT NULL, item TEXT NOT NULL, qkey TEXT NOT NULL DEFAULT '',
      day TEXT NOT NULL, points INTEGER NOT NULL, at INTEGER NOT NULL, paid_at INTEGER,
      PRIMARY KEY (account, item, qkey))`)
    db.run('CREATE INDEX IF NOT EXISTS vote_points_day ON vote_points (account, day)')
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  get usdPerPoint(): number | null {
    const r = this.options.usdPerPoint
    return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null
  }

  /**
   * After a vote: `value` 1/-1 earns a point once, within the daily cap; 0 (taken back) returns the
   * point if it was earned today and not paid. Returns the points this changed (+1, -1 or 0).
   */
  onVote(account: string | null | undefined, item: string, qkey: string, value: number): number {
    if (!account) return 0
    const now = this.now()
    const today = utcDay(now)
    if (value === 0) {
      const r = this.db.query('DELETE FROM vote_points WHERE account = ? AND item = ? AND qkey = ? AND day = ? AND paid_at IS NULL').run(account, item, qkey, today)
      return r.changes > 0 ? -1 : 0
    }
    const earned = (this.db.query('SELECT COALESCE(SUM(points), 0) AS n FROM vote_points WHERE account = ? AND day = ?').get(account, today) as { n: number }).n
    if (earned >= DAILY_CAP) return 0
    const r = this.db.query('INSERT OR IGNORE INTO vote_points (account, item, qkey, day, points, at) VALUES (?, ?, ?, ?, 1, ?)').run(account, item, qkey, today, now)
    return r.changes > 0 ? 1 : 0
  }

  summary(account: string): PointsSummary {
    const today = utcDay(this.now())
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(points), 0) AS points,
                COALESCE(SUM(CASE WHEN day = ? THEN points ELSE 0 END), 0) AS today,
                COALESCE(SUM(CASE WHEN paid_at IS NOT NULL THEN points ELSE 0 END), 0) AS paid
         FROM vote_points WHERE account = ?`,
      )
      .get(today, account) as { points: number; today: number; paid: number }
    const unpaid = row.points - row.paid
    const rate = this.usdPerPoint
    return { points: row.points, today: row.today, cap: DAILY_CAP, paid: row.paid, unpaid, usdPerPoint: rate, unpaidUsd: rate === null ? null : Math.round(unpaid * rate * 100) / 100 }
  }

  /** Unpaid balances, largest first, for an operator deciding payouts. Account ids only. */
  balances(limit = 100): Array<{ account: string; unpaid: number; since: string }> {
    return this.db
      .query('SELECT account, SUM(points) AS unpaid, MIN(day) AS since FROM vote_points WHERE paid_at IS NULL GROUP BY account ORDER BY unpaid DESC LIMIT ?')
      .all(Math.max(1, Math.min(1000, Math.trunc(limit)))) as Array<{ account: string; unpaid: number; since: string }>
  }

  /** Marks an account's unpaid points paid (after a CoinPay payout went through). Returns the points marked. */
  markPaid(account: string, at = this.now()): number {
    return this.db.query('UPDATE vote_points SET paid_at = ? WHERE account = ? AND paid_at IS NULL').run(at, account).changes
  }
}
