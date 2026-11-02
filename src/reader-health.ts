/**
 * Reader health: which sites turn pit.world's page reader away.
 *
 * Summarize and Listen read the page itself (src/summarize.ts readPageChecked). When a site answers
 * that read with a bot wall, a 401/403/429/451/503 or no text, Summarize falls back to the engine's
 * snippet and Listen fails. People were downvoting those results by hand ("imdb.com didn't allow our
 * bot"); this does it for them, at once and on every search, as its own signal:
 *
 * - It is NOT a vote. Human votes stay what they were, each person can still vote a site up or down
 *   or take their vote back, and nobody's tally shows machine votes.
 * - Only the site's own refusals count (`blocked`). Our relay being down, a timeout, or c0mpute not
 *   answering never counts against anyone (`down` is ignored).
 * - It is per domain, with exponential decay (HALF_LIFE_MS), so a site that starts letting readers
 *   in climbs back on its own: every good read after a bad one pulls it up.
 * - In the ranking (Votes.nudges) it is one more bounded term: at most HEALTH_WEIGHT places down,
 *   and the overall MAX_MOVE cap still holds.
 */
import type { Database } from 'bun:sqlite'
import type { ReadState } from './summarize.js'

/** A blocked read counts half as much after this long, a good read too. */
export const HALF_LIFE_MS = 14 * 24 * 3600_000
/** Prior good reads every domain starts with, so one refusal is a nudge and not a verdict. */
export const PRIOR_OK = 1
/** Places a result can move down for its site turning readers away, at most. */
export const HEALTH_WEIGHT = 3
/** A domain is called "blocks readers" (shown to people) at this share with at least BLOCKED_MIN reads refused. */
export const BLOCKED_SHARE = 0.6
export const BLOCKED_MIN = 1.5

export type Health = { domain: string; blocked: number; ok: number; share: number; lastBlockedAt: number | null; lastOkAt: number | null }

/** The domain a result's URL belongs to, as votes.ts counts it: host without www. */
export function domainOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
    return host.includes('.') ? host : null
  } catch {
    return null
  }
}

/** Share of reads refused, with the prior: 0 (always readable) up to just under 1. */
export function blockedShare(blocked: number, ok: number): number {
  return blocked / (blocked + ok + PRIOR_OK)
}

export class ReaderHealth {
  constructor(
    readonly db: Database,
    private readonly now = () => Date.now(),
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS reader_health (
      domain TEXT PRIMARY KEY, blocked REAL NOT NULL DEFAULT 0, ok REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, last_blocked_at INTEGER, last_ok_at INTEGER)`)
  }

  private decay(at: number): number {
    return Math.pow(0.5, Math.max(0, this.now() - at) / HALF_LIFE_MS)
  }

  /** Records how a read of `url` went. `down` and `private` are ignored: they say nothing about the site. */
  record(url: string, state: ReadState): void {
    if (state !== 'ok' && state !== 'blocked') return
    const domain = domainOf(url)
    if (!domain) return
    const now = this.now()
    const row = this.db.query('SELECT blocked, ok, updated_at FROM reader_health WHERE domain = ?').get(domain) as { blocked: number; ok: number; updated_at: number } | null
    const k = row ? this.decay(row.updated_at) : 0
    const blocked = (row?.blocked ?? 0) * k + (state === 'blocked' ? 1 : 0)
    const ok = (row?.ok ?? 0) * k + (state === 'ok' ? 1 : 0)
    this.db
      .query(
        `INSERT INTO reader_health (domain, blocked, ok, updated_at, last_blocked_at, last_ok_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (domain) DO UPDATE SET blocked = excluded.blocked, ok = excluded.ok, updated_at = excluded.updated_at,
           last_blocked_at = COALESCE(excluded.last_blocked_at, reader_health.last_blocked_at),
           last_ok_at = COALESCE(excluded.last_ok_at, reader_health.last_ok_at)`,
      )
      .run(domain, blocked, ok, now, state === 'blocked' ? now : null, state === 'ok' ? now : null)
  }

  /** Health for many domains at once, decayed to now. Domains never read are absent. */
  many(domains: string[]): Map<string, Health> {
    const unique = [...new Set(domains.filter(Boolean))].slice(0, 200)
    const out = new Map<string, Health>()
    if (!unique.length) return out
    const rows = this.db
      .query(`SELECT domain, blocked, ok, updated_at, last_blocked_at, last_ok_at FROM reader_health WHERE domain IN (${unique.map(() => '?').join(',')})`)
      .all(...unique) as Array<{ domain: string; blocked: number; ok: number; updated_at: number; last_blocked_at: number | null; last_ok_at: number | null }>
    for (const r of rows) {
      const k = this.decay(r.updated_at)
      const blocked = r.blocked * k
      const ok = r.ok * k
      out.set(r.domain, { domain: r.domain, blocked, ok, share: blockedShare(blocked, ok), lastBlockedAt: r.last_blocked_at, lastOkAt: r.last_ok_at })
    }
    return out
  }

  get(domain: string): Health | null {
    return this.many([domain]).get(domain) ?? null
  }

  /** Places each domain moves for its reader health: 0 down to -HEALTH_WEIGHT. */
  moves(domains: string[]): Map<string, number> {
    const out = new Map<string, number>()
    for (const [d, h] of this.many(domains)) {
      const move = -HEALTH_WEIGHT * h.share
      if (move < -0.01) out.set(d, move)
    }
    return out
  }

  /** Whether to tell people a site blocks page readers (so they need not press Summarize to find out). */
  blocks(h: Health | null | undefined): boolean {
    return !!h && h.blocked >= BLOCKED_MIN && h.share >= BLOCKED_SHARE
  }

  /** The sites that refuse readers most, for /api/reader-health and operators. */
  worst(limit = 50): Health[] {
    const rows = this.db.query('SELECT domain FROM reader_health WHERE blocked > 0.05 ORDER BY last_blocked_at DESC LIMIT 200').all() as Array<{ domain: string }>
    return [...this.many(rows.map((r) => r.domain)).values()].sort((a, b) => b.share - a.share || b.blocked - a.blocked).slice(0, Math.max(1, Math.min(200, limit)))
  }
}
