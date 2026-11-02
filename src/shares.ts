/**
 * Shared results: every web result carries a Share link.
 *
 * Every Share link leads to the result's own page on pit.world, /result/<url>: its details, its
 * ▲ ▼ (votes cast there are the "shared" votes that nudge that URL on every search, src/votes.ts
 * SHARED_WEIGHT), and a link to pass on. A result pitbot indexed also has an open record at
 * nichedb.dev, and its page links straight to it. (Share links do not go to nichedb.dev directly:
 * nothing there takes votes, and its record pages were timing out at 40 s on 2026-11-02.)
 *
 * Nothing is stored while you search. The Share link carries the result (url, title, snippet) and
 * an HMAC of them, and only a click on it writes the result down, so pit.world never keeps a list
 * of what it showed you, and nobody can mint a /result page with a title the engines never gave.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { normalizeUrl } from './votes.js'

export type SharedResult = { slug: string; url: string; title: string; description: string; host: string; indexed: boolean }
export type Shareable = { url: string; title: string; description: string; host: string; sources?: string[] }

const MAX_TITLE = 200
const MAX_DESCRIPTION = 400
const DAY = 86_400_000

/** pitbot's public record for a page it indexed (the same link /status gives). */
export const nichedbRecord = (url: string) => `https://nichedb.dev/c/sites/${url.replace(/^https?:\/\//, '')}`

/** A shared result's page path. The slug can hold "?" and "&" (a result's query string), so it is encoded; /result/* decodes it. */
export const resultPath = (slug: string) => `/result/${encodeURI(slug).replace(/\?/g, '%3F').replace(/#/g, '%23')}`

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)

export class Shares {
  constructor(
    readonly db: Database,
    private readonly secret: string,
    private readonly now = () => Date.now(),
  ) {
    // Additive: created on startup if missing. `day` is the day it was first shared, nothing finer.
    db.run(`CREATE TABLE IF NOT EXISTS shared_results (
      slug TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT '', indexed INTEGER NOT NULL DEFAULT 0, day INTEGER NOT NULL)`)
  }

  private sign(url: string, title: string, description: string, indexed: boolean): string {
    return createHmac('sha256', this.secret).update(`share|${url}|${title}|${description}|${indexed ? 1 : 0}`).digest('base64url').slice(0, 22)
  }

  /** A result's Share link: the signed hop that keeps it and lands on /result/<url>. */
  href(h: Shareable): string {
    const indexed = (h.sources ?? []).includes('pit')
    const title = clip(h.title, MAX_TITLE)
    const description = clip(h.description, MAX_DESCRIPTION)
    const p = new URLSearchParams({ u: h.url, t: title, d: description, ...(indexed ? { i: '1' } : {}), s: this.sign(h.url, title, description, indexed) })
    return `/share?${p.toString()}`
  }

  /** Check a Share click and keep the result. Returns its slug, or null when the link was not one pit.world signed. */
  save(params: { u?: string | null; t?: string | null; d?: string | null; i?: string | null; s?: string | null }): string | null {
    const url = params.u ?? ''
    const title = params.t ?? ''
    const description = params.d ?? ''
    const indexed = params.i === '1'
    const slug = normalizeUrl(url)
    if (!slug || !title || title.length > MAX_TITLE || description.length > MAX_DESCRIPTION || !params.s) return null
    const want = Buffer.from(this.sign(url, title, description, indexed))
    const got = Buffer.from(params.s)
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null
    let host = ''
    try {
      host = new URL(url).hostname.replace(/^www\./, '')
    } catch {}
    this.db
      .query(
        `INSERT INTO shared_results (slug, url, title, description, host, indexed, day) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (slug) DO UPDATE SET url = excluded.url, title = excluded.title, description = excluded.description,
           host = excluded.host, indexed = MAX(shared_results.indexed, excluded.indexed)`,
      )
      .run(slug, url, title, description, host, indexed ? 1 : 0, Math.floor(this.now() / DAY))
    return slug
  }

  /** Every shared result's slug, newest first, for the sitemap. */
  slugs(limit = 20_000): string[] {
    return (this.db.query('SELECT slug FROM shared_results ORDER BY day DESC, slug LIMIT ?').all(limit) as Array<{ slug: string }>).map((r) => r.slug)
  }

  get(slug: string): SharedResult | null {
    const row = this.db.query('SELECT slug, url, title, description, host, indexed FROM shared_results WHERE slug = ?').get(slug) as
      | (Omit<SharedResult, 'indexed'> & { indexed: number })
      | null
    return row ? { ...row, indexed: row.indexed === 1 } : null
  }
}
