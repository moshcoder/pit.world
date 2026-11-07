/**
 * Anonymous up/down votes on everything that is a listing: web and tab results,
 * the featured box, sponsored slots, PairUX/nixamp promos, RSS Amplifier blogs
 * and business listings.
 *
 * Who voted is a `visitorKey` from @profullstack/browser-fingerprint: a keyed
 * hash of the device's fingerprint, never the fingerprint and never an address.
 * The search a result vote was cast on is kept the same way, as a keyed hash
 * (`qkey`), so a vote can nudge that search without its words sitting beside the
 * voter. The words are counted on their own in src/vote-phrases.ts.
 *
 * One vote per (visitor, item, search): voting again replaces it, voting the
 * same way again takes it back. Results are nudged a bounded number of places;
 * sponsored and paid slots are never moved, their votes are a quality signal
 * kept for later.
 */
import type { Engagement } from './engagement.js'
import type { Database } from 'bun:sqlite'
import { createHmac } from 'node:crypto'
import type { ReaderHealth } from './reader-health.js'

export const KINDS = ['result', 'featured', 'ad', 'promo', 'blog', 'listing'] as const
export type VoteKind = (typeof KINDS)[number]
export type Tally = { up: number; down: number; score: number }

/** The prior: every item starts as if it had PRIOR up and PRIOR down votes. */
export const PRIOR = 5
/** Places a result can move on its own search's votes, at most (6 x a score in -0.5..0.5). */
export const QUERY_WEIGHT = 6
/** Places a result can move on its domain's votes across all searches, at most. */
export const DOMAIN_WEIGHT = 2
/** Places a result can move on votes cast on its own shared page (/result/<url>), on every search, at most. */
export const SHARED_WEIGHT = 3
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
  /** Reader health (src/reader-health.ts), when the server has it: one more bounded term in nudges(). */
  health: ReaderHealth | null = null
  /** The use people make of each site (src/engagement.ts); unset, the ranking ignores it. */
  engagement?: Engagement

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
    // The signed-in account a vote was cast from ('' when anonymous), for /account/votes. Additive.
    const cols = db.query('PRAGMA table_info(votes)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'account')) db.run("ALTER TABLE votes ADD COLUMN account TEXT NOT NULL DEFAULT ''")
    db.run("CREATE INDEX IF NOT EXISTS votes_account ON votes (account, at) WHERE account <> ''")
    // The words a signed-in vote was cast on, so its owner can see them. '' when signed out: those stay a hash. Additive.
    if (!cols.some((c) => c.name === 'phrase')) db.run("ALTER TABLE votes ADD COLUMN phrase TEXT NOT NULL DEFAULT ''")
  }

  /**
   * A signed-in account's votes, newest first, with the words each was cast on. Votes from before
   * the words were kept have only their keyed hash, so `phrase` is '' and they say "on a search".
   */
  history(account: string, options: { limit?: number; before?: number } = {}): Array<{ item: string; kind: VoteKind; target: string; qkey: string; phrase: string; value: number; at: number }> {
    if (!account) return []
    const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)))
    const before = options.before ?? Number.MAX_SAFE_INTEGER
    const rows = this.db
      .query("SELECT item, kind, qkey, phrase, value, at FROM votes WHERE account = ? AND account <> '' AND at < ? ORDER BY at DESC LIMIT ?")
      .all(account, before, limit) as Array<{ item: string; kind: VoteKind; qkey: string; phrase: string; value: number; at: number }>
    return rows.map((r) => ({ ...r, target: r.item.slice(r.kind.length + 1) }))
  }

  /** How many votes an account has standing. */
  countFor(account: string): number {
    if (!account) return 0
    return (this.db.query("SELECT COUNT(*) AS n FROM votes WHERE account = ? AND account <> ''").get(account) as { n: number }).n
  }

  /** Takes back one of an account's votes from its history (any device). True when there was one. */
  undo(account: string, item: string, qkey: string): boolean {
    if (!account) return false
    return this.db.query("DELETE FROM votes WHERE account = ? AND account <> '' AND item = ? AND qkey = ?").run(account, item, qkey).changes > 0
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
  cast(o: { visitor: string; kind: VoteKind; item: string; domain: string; value: number; query?: string | null; toggle?: boolean; account?: string | null }): { value: number; qkey: string; firstOnSearch: boolean } & Tally {
    const qkey = o.kind === 'result' ? this.qkey(o.query) : ''
    const prev = this.db.query('SELECT value FROM votes WHERE visitor = ? AND item = ? AND qkey = ?').get(o.visitor, o.item, qkey) as { value: number } | null
    let value = Math.sign(o.value)
    if (o.toggle && prev && prev.value === value) value = 0
    // This device's first vote on this search, whichever result it was on.
    const firstOnSearch =
      o.kind === 'result' &&
      !!qkey &&
      value !== 0 &&
      !this.db.query('SELECT 1 FROM votes WHERE visitor = ? AND qkey = ? LIMIT 1').get(o.visitor, qkey)
    if (value === 0) {
      this.db.query('DELETE FROM votes WHERE visitor = ? AND item = ? AND qkey = ?').run(o.visitor, o.item, qkey)
      // Taken back while signed in: the same vote cast from another device of the account goes too.
      if (o.account) this.undo(o.account, o.item, qkey)
    } else
      this.db
        .query(
          `INSERT INTO votes (visitor, item, qkey, kind, domain, value, at, account, phrase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (visitor, item, qkey) DO UPDATE SET value = excluded.value, at = excluded.at,
             account = CASE WHEN excluded.account <> '' THEN excluded.account ELSE votes.account END,
             phrase = CASE WHEN excluded.phrase <> '' THEN excluded.phrase ELSE votes.phrase END`,
        )
        .run(o.visitor, o.item, qkey, o.kind, o.domain, value, this.now(), o.account ?? '', o.account ? (o.query ?? '').trim().slice(0, 200) : '')
    return { value, qkey, firstOnSearch, ...this.tally(o.item, o.kind === 'result' ? o.query : undefined) }
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

  /** Result tallies from votes cast on the result's shared page, which carry no search (qkey ''). */
  sharedTallies(items: string[]): Map<string, Tally> {
    const unique = [...new Set(items)].slice(0, 200)
    const out = new Map<string, Tally>()
    if (!unique.length) return out
    const rows = this.db
      // threatcrush-disable-next-line sql-template-interpolation  only "?" placeholders are interpolated; every value is bound
      .query(`SELECT item, SUM(value > 0) AS up, SUM(value < 0) AS down FROM votes WHERE kind = 'result' AND qkey = '' AND item IN (${unique.map(() => '?').join(',')}) GROUP BY item`)
      .all(...unique) as Array<{ item: string; up: number; down: number }>
    for (const r of rows) out.set(r.item, { up: r.up, down: r.down, score: score(r.up, r.down) })
    return out
  }

  /**
   * How many places each result moves: QUERY_WEIGHT x its score on this search
   * plus DOMAIN_WEIGHT x its domain's score plus SHARED_WEIGHT x its shared page's score, plus what its
   * site earns from reader health and from people using Summarize and Listen on it, capped at MAX_MOVE either way.
   */
  nudges(urls: string[], query: string): Map<string, number> {
    const items = urls.map((u) => resultItem(u))
    const byItem = this.tallies(items.filter((i): i is string => Boolean(i)), { query })
    const domains = items.map((i) => (i ? i.slice('result:'.length).split(/[/?]/)[0]! : ''))
    const byDomain = this.domainTallies(domains)
    const byShared = this.sharedTallies(items.filter((i): i is string => Boolean(i)))
    // Sites that turn the page reader away (src/reader-health.ts): a separate signal, never a vote.
    const byHealth = this.health?.moves(domains) ?? new Map<string, number>()
    // The use people make of a site (src/engagement.ts): separate again, and only ever up.
    const byUse = this.engagement?.moves(domains) ?? new Map<string, number>()
    const out = new Map<string, number>()
    urls.forEach((url, i) => {
      const item = items[i]
      if (!item) return
      const q = byItem.get(item)?.score ?? 0
      const d = byDomain.get(domains[i]!)?.score ?? 0
      const s = byShared.get(item)?.score ?? 0
      const h = byHealth.get(domains[i]!) ?? 0
      const e = byUse.get(domains[i]!) ?? 0
      const move = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, QUERY_WEIGHT * q + DOMAIN_WEIGHT * d + SHARED_WEIGHT * s + h + e))
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
   * Listing nudges for /pros: the same bounded rule on each listing's votes, reader health and use.
   * The directory applies them only among unpaid, unpromoted listings.
   */
  listingMoves(domains: string[]): Map<string, number> {
    const t = this.tallies(domains.map((d) => `listing:${d}`))
    const byHealth = this.health?.moves(domains) ?? new Map<string, number>()
    const byUse = this.engagement?.moves(domains) ?? new Map<string, number>()
    const out = new Map<string, number>()
    for (const d of domains) {
      const s = t.get(`listing:${d}`)?.score ?? 0
      const move = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, QUERY_WEIGHT * s + (byHealth.get(d) ?? 0) + (byUse.get(d) ?? 0)))
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
