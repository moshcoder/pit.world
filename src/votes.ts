/**
 * Anonymous up/down votes on everything that is a listing: web and tab results,
 * the featured box, sponsored slots, PairUX/nixamp promos, RSS Amplifier blogs
 * and business listings.
 *
 * Who voted is a `visitorKey` from @profullstack/browser-fingerprint: a keyed
 * hash of the device's fingerprint, never the fingerprint and never an address.
 * The search a result vote was cast on is kept the same way, as a keyed hash
 * (`qkey`), so a vote can nudge that search without the words being stored.
 *
 * One vote per (visitor, item, search): voting again replaces it, voting the
 * same way again takes it back. Results are nudged a bounded number of places;
 * sponsored and paid slots are never moved, their votes are a quality signal
 * kept for later.
 */
import type { Database } from 'bun:sqlite'
import { createHmac } from 'node:crypto'

export const KINDS = ['result', 'featured', 'ad', 'promo', 'blog', 'listing'] as const
export type VoteKind = (typeof KINDS)[number]
export type Tally = { up: number; down: number; score: number }

/** The prior: every item starts as if it had PRIOR up and PRIOR down votes. */
export const PRIOR = 5
/** Places a result can move on its own search's votes, at most (6 x a score in -0.5..0.5). */
export const QUERY_WEIGHT = 6
/** Places a result can move on its domain's votes across all searches, at most. */
export const DOMAIN_WEIGHT = 2
/** Whatever the votes, a result never moves more than this many places. */
export const MAX_MOVE = 3

/** Bayesian average with a symmetric prior, centred on 0: -0.5 (all down) to +0.5 (all up), 0 with no votes. */
export function score(up: number, down: number): number {
  return (up + PRIOR) / (up + down + 2 * PRIOR) - 0.5
}

const TRACKING = /^(utm_|fbclid$|gclid$|msclkid$|mc_|ref$|ref_src$|igshid$|si$)/i

/** A result's identity: host without www, path without a trailing slash, query minus tracking parameters, no fragment. */
export function normalizeUrl(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 2048) return null
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  if (!host.includes('.')) return null
  const params = [...url.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b))
  const search = params.length ? `?${new URLSearchParams(params).toString()}` : ''
  const path = url.pathname.replace(/\/+$/, '')
  return `${host}${path}${search}`.slice(0, 300)
}

const DOMAIN = /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/**
 * The stored item for a kind and the target a page sent. `result`, `promo` and
 * `blog` are URLs; `listing` is a domain; `featured` is a ring site's host;
 * `ad` is a sponsored slot (`top-1`, `inline`) on a page type (`web`, `images`...).
 */
export function itemFor(kind: unknown, target: unknown): { item: string; kind: VoteKind; domain: string } | null {
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind) || typeof target !== 'string') return null
  const k = kind as VoteKind
  if (k === 'result' || k === 'promo' || k === 'blog') {
    const url = normalizeUrl(target)
    return url ? { item: `${k}:${url}`, kind: k, domain: url.split(/[/?]/)[0]! } : null
  }
  if (k === 'listing' || k === 'featured') {
    const d = target.trim().toLowerCase().replace(/^www\./, '')
    return DOMAIN.test(d) ? { item: `${k}:${d}`, kind: k, domain: d } : null
  }
  // ad: <page type>:<slot>, e.g. web:top-1, images:inline
  return /^[a-z]{2,12}:(top-[1-6]|inline)$/.test(target) ? { item: `ad:${target}`, kind: 'ad', domain: '' } : null
}

/** The item key for a result URL, for rendering. */
export const resultItem = (url: string) => {
  const n = normalizeUrl(url)
  return n ? `result:${n}` : null
}

export class Votes {
  constructor(
    readonly db: Database,
    private readonly secret: string,
    private readonly now = () => Date.now(),
  ) {
    // Additive, like every table in this database: created on startup if missing.
    db.run(`CREATE TABLE IF NOT EXISTS votes (
      visitor TEXT NOT NULL, item TEXT NOT NULL, qkey TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL, domain TEXT NOT NULL DEFAULT '', value INTEGER NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (visitor, item, qkey))`)
    db.run('CREATE INDEX IF NOT EXISTS votes_item_qkey ON votes (item, qkey)')
    db.run('CREATE INDEX IF NOT EXISTS votes_domain ON votes (domain, kind)')
  }

  /** A keyed hash of the normalized search, so per-search tallies need no stored words. '' for no search. */
  qkey(query: string | null | undefined): string {
    const q = (query ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
    return q ? createHmac('sha256', this.secret).update(`q|${q}`).digest('base64url').slice(0, 22) : ''
  }

  /**
   * Cast, change or take back a vote. `value` 1 or -1; 0 (or the same value
   * again with `toggle`) removes it. Only result votes carry a search.
   */
  cast(o: { visitor: string; kind: VoteKind; item: string; domain: string; value: number; query?: string | null; toggle?: boolean }): { value: number } & Tally {
    const qkey = o.kind === 'result' ? this.qkey(o.query) : ''
    const prev = this.db.query('SELECT value FROM votes WHERE visitor = ? AND item = ? AND qkey = ?').get(o.visitor, o.item, qkey) as { value: number } | null
    let value = Math.sign(o.value)
    if (o.toggle && prev && prev.value === value) value = 0
    if (value === 0) this.db.query('DELETE FROM votes WHERE visitor = ? AND item = ? AND qkey = ?').run(o.visitor, o.item, qkey)
    else
      this.db
        .query('INSERT INTO votes (visitor, item, qkey, kind, domain, value, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (visitor, item, qkey) DO UPDATE SET value = excluded.value, at = excluded.at')
        .run(o.visitor, o.item, qkey, o.kind, o.domain, value, this.now())
    return { value, ...this.tally(o.item, o.kind === 'result' ? o.query : undefined) }
  }

  /** One item's tally: on one search when `query` is given (results), else across everything. */
  tally(item: string, query?: string | null): Tally {
    const row = (
      query
        ? this.db.query('SELECT COALESCE(SUM(value > 0), 0) AS up, COALESCE(SUM(value < 0), 0) AS down FROM votes WHERE item = ? AND qkey = ?').get(item, this.qkey(query))
        : this.db.query('SELECT COALESCE(SUM(value > 0), 0) AS up, COALESCE(SUM(value < 0), 0) AS down FROM votes WHERE item = ?').get(item)
    ) as { up: number; down: number }
    return { up: row.up, down: row.down, score: score(row.up, row.down) }
  }

  /** Tallies for many items at once (one page), on one search for results, plus the visitor's own votes when known. */
  tallies(items: string[], options: { query?: string | null; visitor?: string | null } = {}): Map<string, Tally & { mine: number }> {
    const out = new Map<string, Tally & { mine: number }>()
    const unique = [...new Set(items)].slice(0, 200)
    if (!unique.length) return out
    const qkey = this.qkey(options.query)
    const marks = unique.map(() => '?').join(',')
    // A result's tally is its votes on this search; anything else counts every vote it has.
    const rows = this.db
      .query(
        `SELECT item, SUM(value > 0) AS up, SUM(value < 0) AS down FROM votes
         WHERE item IN (${marks}) AND (kind <> 'result' OR qkey = ?) GROUP BY item`,
      )
      .all(...unique, qkey) as Array<{ item: string; up: number; down: number }>
    const mine = new Map<string, number>()
    if (options.visitor) {
      for (const r of this.db
        // threatcrush-disable-next-line sql-template-interpolation  only "?" placeholders are interpolated; every value is bound
        .query(`SELECT item, value FROM votes WHERE visitor = ? AND item IN (${marks}) AND (kind <> 'result' OR qkey = ?)`)
        .all(options.visitor, ...unique, qkey) as Array<{ item: string; value: number }>)
        mine.set(r.item, r.value)
    }
    for (const item of unique) out.set(item, { up: 0, down: 0, score: 0, mine: mine.get(item) ?? 0 })
    for (const r of rows) out.set(r.item, { up: r.up, down: r.down, score: score(r.up, r.down), mine: mine.get(r.item) ?? 0 })
    return out
  }

  /**
   * Per-domain tallies over result votes on every search, counting each visitor
   * once per domain (the sign of their votes there), so one person voting a
   * site up on fifty searches is one vote for the site.
   */
  domainTallies(domains: string[]): Map<string, Tally> {
    const unique = [...new Set(domains.filter(Boolean))].slice(0, 200)
    const out = new Map<string, Tally>()
    if (!unique.length) return out
    const rows = this.db
      .query(
        `SELECT domain, SUM(s > 0) AS up, SUM(s < 0) AS down FROM (
           SELECT domain, visitor, SUM(value) AS s FROM votes WHERE kind = 'result' AND domain IN (${unique.map(() => '?').join(',')}) GROUP BY domain, visitor
         ) GROUP BY domain`,
      )
      .all(...unique) as Array<{ domain: string; up: number; down: number }>
    for (const r of rows) out.set(r.domain, { up: r.up, down: r.down, score: score(r.up, r.down) })
    return out
  }

  /**
   * How many places each result moves: QUERY_WEIGHT x its score on this search
   * plus DOMAIN_WEIGHT x its domain's score, capped at MAX_MOVE either way.
   */
  nudges(urls: string[], query: string): Map<string, number> {
    const items = urls.map((u) => resultItem(u))
    const byItem = this.tallies(items.filter((i): i is string => Boolean(i)), { query })
    const byDomain = this.domainTallies(items.map((i) => (i ? i.slice('result:'.length).split(/[/?]/)[0]! : '')))
    const out = new Map<string, number>()
    urls.forEach((url, i) => {
      const item = items[i]
      if (!item) return
      const q = byItem.get(item)?.score ?? 0
      const d = byDomain.get(item.slice('result:'.length).split(/[/?]/)[0]!)?.score ?? 0
      const move = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, QUERY_WEIGHT * q + DOMAIN_WEIGHT * d))
      if (move) out.set(url, move)
    })
    return out
  }

  /**
   * Reorder results by their nudges: each one's position becomes (index - move),
   * ties keep the engines' order. `pinned` items (featured, sponsored) keep their places.
   */
  rerank<T extends { url: string }>(hits: T[], query: string, pinned: (hit: T) => boolean = () => false): T[] {
    if (hits.length < 2) return hits
    const moves = this.nudges(hits.map((h) => h.url), query)
    if (!moves.size) return hits
    const free = hits.map((h, i) => ({ h, i })).filter(({ h }) => !pinned(h))
    const order = applyMoves(free.map(({ h }) => h), (h) => moves.get(h.url) ?? 0)
    const out = hits.slice()
    free.forEach(({ i }, k) => {
      out[i] = order[k]!
    })
    return out
  }

  /**
   * Listing nudges for /pros: the same bounded rule on each listing's votes.
   * The directory applies them only among unpaid, unpromoted listings.
   */
  listingMoves(domains: string[]): Map<string, number> {
    const t = this.tallies(domains.map((d) => `listing:${d}`))
    const out = new Map<string, number>()
    for (const d of domains) {
      const s = t.get(`listing:${d}`)?.score ?? 0
      const move = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, QUERY_WEIGHT * s))
      if (move) out.set(d, move)
    }
    return out
  }

  /** The best- (or worst-) voted items of a kind, for the API and operators. Never says who voted. */
  top(kind: VoteKind, options: { limit?: number; order?: 'best' | 'worst'; min?: number } = {}): Array<{ item: string; target: string } & Tally> {
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 20)))
    const min = Math.max(1, Math.trunc(options.min ?? 1))
    const rows = this.db
      .query(`SELECT item, SUM(value > 0) AS up, SUM(value < 0) AS down FROM votes WHERE kind = ? GROUP BY item HAVING COUNT(*) >= ?`)
      .all(kind, min) as Array<{ item: string; up: number; down: number }>
    const scored = rows.map((r) => ({ item: r.item, target: r.item.slice(kind.length + 1), up: r.up, down: r.down, score: score(r.up, r.down) }))
    scored.sort((a, b) => (options.order === 'worst' ? a.score - b.score : b.score - a.score) || b.up + b.down - (a.up + a.down))
    return scored.slice(0, limit)
  }

  /** Totals for /status-style summaries. */
  totals(): { votes: number; items: number; visitors: number } {
    return this.db.query('SELECT COUNT(*) AS votes, COUNT(DISTINCT item) AS items, COUNT(DISTINCT visitor) AS visitors FROM votes').get() as any
  }
}

/**
 * Re-order a list by (index - move), keeping the original order otherwise.
 */
export function applyMoves<T>(list: T[], moveOf: (x: T) => number): T[] {
  return list
    .map((x, j) => {
      const move = moveOf(x)
      // Up-movers win a tie with what they pass, down-movers lose it: a move of 3 is exactly three places.
      return { x, at: j - move, moved: -Math.sign(move), j }
    })
    .sort((a, b) => a.at - b.at || a.moved - b.moved || a.j - b.j)
    .map(({ x }) => x)
}
