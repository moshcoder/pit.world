/**
 * Reader engagement: which sites people actually use pit.world's Summarize and Listen on.
 *
 * Someone spending a summary or a read-aloud on a result is a stronger signal than a click and
 * a cheaper one than a vote, and until now it taught the ranking nothing. It is the good half of
 * reader health (src/reader-health.ts), which only ever pushes a site down, and like it:
 *
 * - It is NOT a vote: tallies never show it, and it never counts against anyone.
 * - It is per domain, with the same 14-day half-life, so old attention fades on its own.
 * - It is bounded: at most ENGAGE_WEIGHT places up, inside the overall MAX_MOVE cap.
 *
 * It cannot be farmed by repetition: one person counts once per domain per day, and the rows
 * that remember that hold a keyed hash, never who it was or which page, and go after a day.
 */
import type { Database } from 'bun:sqlite'
import { createHmac } from 'node:crypto'
import { domainOf, HALF_LIFE_MS } from './reader-health.js'

/** Places a result can move up for the use people make of its site, at most. */
export const ENGAGE_WEIGHT = 2
/** Uses that earn half of ENGAGE_WEIGHT: one curious person is a whisper, not a verdict. */
export const ENGAGE_PRIOR = 5
const DAY_MS = 24 * 3600_000

export class Engagement {
  constructor(
    readonly db: Database,
    private readonly secret: string,
    private readonly now = () => Date.now(),
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS reader_engagement (domain TEXT PRIMARY KEY, uses REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`)
    db.run(`CREATE TABLE IF NOT EXISTS reader_engagement_seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL)`)
  }

  private decay(at: number): number {
    return Math.pow(0.5, Math.max(0, this.now() - at) / HALF_LIFE_MS)
  }

  /** One person used Summarize or Listen on `url`. `who` is already a stable, opaque id. True when it counted. */
  record(url: string, who: string): boolean {
    const domain = domainOf(url)
    if (!domain || !who) return false
    const now = this.now()
    this.db.query('DELETE FROM reader_engagement_seen WHERE at < ?').run(now - DAY_MS)
    const key = createHmac('sha256', this.secret).update(`${who}|${domain}`).digest('hex')
    const fresh = this.db.query('INSERT OR IGNORE INTO reader_engagement_seen (key, at) VALUES (?, ?)').run(key, now).changes > 0
    if (!fresh) return false
    const row = this.db.query('SELECT uses, updated_at FROM reader_engagement WHERE domain = ?').get(domain) as { uses: number; updated_at: number } | null
    const uses = (row ? row.uses * this.decay(row.updated_at) : 0) + 1
    this.db
      .query('INSERT INTO reader_engagement (domain, uses, updated_at) VALUES (?, ?, ?) ON CONFLICT (domain) DO UPDATE SET uses = excluded.uses, updated_at = excluded.updated_at')
      .run(domain, uses, now)
    return true
  }

  /** Places each domain moves for the use it gets: 0 up to just under ENGAGE_WEIGHT. Domains nobody used are absent. */
  moves(domains: string[]): Map<string, number> {
    const unique = [...new Set(domains.filter(Boolean))].slice(0, 200)
    const out = new Map<string, number>()
    if (!unique.length) return out
    const rows = this.db
      // threatcrush-disable-next-line sql-template-interpolation  only "?" placeholders are interpolated; every value is bound
      .query(`SELECT domain, uses, updated_at FROM reader_engagement WHERE domain IN (${unique.map(() => '?').join(',')})`)
      .all(...unique) as Array<{ domain: string; uses: number; updated_at: number }>
    for (const r of rows) {
      const uses = r.uses * this.decay(r.updated_at)
      out.set(r.domain, (ENGAGE_WEIGHT * uses) / (uses + ENGAGE_PRIOR))
    }
    return out
  }
}
