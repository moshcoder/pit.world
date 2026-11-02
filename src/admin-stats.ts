/**
 * GET /api/admin/stats.json?day=YYYY-MM-DD (admin bearer): the numbers behind the pit-nightly
 * email (profullstack/scripts bin/pit-nightly) for one UTC day, plus running totals.
 *
 * Counts only. No email address, URL, search, domain or account id leaves here: pit.world keeps
 * no searches at all, so there is nothing to count about them.
 */
import type { Database } from 'bun:sqlite'
import type { Accounts } from './accounts.js'
import type { Listings } from './listings.js'
import type { Newsletter } from './newsletter.js'
import type { Summarizer } from './summarize.js'
import { PASS_USD, type SummaryPasses } from './summary-pass.js'
import { FEATURED_USD } from './business-featured.js'

export type StatsDeps = { accounts?: Accounts; summarizer?: Summarizer; passes?: SummaryPasses; listings?: Listings; newsletter?: Newsletter; votesDb?: Database }

const DAY_MS = 86_400_000

/** [start, end) of a UTC day, or null for anything that is not YYYY-MM-DD. */
export function dayRange(day: string): [number, number] | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const from = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(from) ? [from, from + DAY_MS] : null
}

const one = (db: Database, sql: string, ...params: Array<string | number>): number =>
  (db.query(sql).get(...params) as { n: number | null } | null)?.n ?? 0
const has = (db: Database, table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)

export function nightlyStats(d: StatsDeps, day: string) {
  const range = dayRange(day)
  if (!range) throw new Error('day must be YYYY-MM-DD')
  const [from, to] = range
  const out: Record<string, unknown> = { day, generatedAt: new Date().toISOString() }

  const a = d.accounts?.db
  if (a) {
    out.accounts = {
      total: one(a, 'SELECT COUNT(*) AS n FROM accounts WHERE created_at < ?', to),
      new: one(a, 'SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ? AND created_at < ?', from, to),
      // Last seen is overwritten each visit, so this is "seen that day and not since" for an old day; exact for yesterday.
      active: one(a, 'SELECT COUNT(*) AS n FROM accounts WHERE last_seen_at >= ? AND last_seen_at < ?', from, to),
      signIns: one(a, 'SELECT COUNT(*) AS n FROM sessions WHERE created_at >= ? AND created_at < ?', from, to),
      apiTokens: has(a, 'api_tokens') ? one(a, 'SELECT COUNT(*) AS n FROM api_tokens WHERE created_at >= ? AND created_at < ?', from, to) : 0,
    }
  }

  if (d.summarizer) out.summaries = d.summarizer.store.stats(from, to)

  const p = d.passes?.db
  if (p && has(p, 'summary_pass_invoices')) {
    const invoicePaid = one(p, "SELECT COUNT(*) AS n FROM summary_pass_invoices WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?", from, to)
    const x402Sold = has(p, 'summary_pass_x402') ? one(p, 'SELECT COUNT(*) AS n FROM summary_pass_x402 WHERE created_at >= ? AND created_at < ?', from, to) : 0
    out.pass = {
      soldByInvoice: invoicePaid,
      soldByX402: x402Sold,
      revenueUsd: (invoicePaid + x402Sold) * PASS_USD,
      invoicesOpened: one(p, 'SELECT COUNT(*) AS n FROM summary_pass_invoices WHERE created_at >= ? AND created_at < ?', from, to),
      invoicesOpen: one(p, "SELECT COUNT(*) AS n FROM summary_pass_invoices WHERE status IN ('creating','open','unknown')"),
      activeAccounts: one(p, 'SELECT COUNT(*) AS n FROM summary_passes WHERE paid_until > ?', to),
      activeTokens: has(p, 'summary_pass_x402') ? one(p, 'SELECT COUNT(*) AS n FROM summary_pass_x402 WHERE expires_at > ? AND created_at < ?', to, to) : 0,
      summariesOnPasses: one(p, 'SELECT COUNT(*) AS n FROM summary_pass_usage WHERE at >= ? AND at < ?', from, to),
      allTimeUsd: (one(p, "SELECT COUNT(*) AS n FROM summary_pass_invoices WHERE status = 'paid' AND paid_at < ?", to) + (has(p, 'summary_pass_x402') ? one(p, 'SELECT COUNT(*) AS n FROM summary_pass_x402 WHERE created_at < ?', to) : 0)) * PASS_USD,
    }
  }

  const l = d.listings?.db
  if (l) {
    const featuredPaid = has(l, 'featured_invoices') ? one(l, "SELECT COUNT(*) AS n FROM featured_invoices WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?", from, to) : 0
    out.listings = {
      total: one(l, 'SELECT COUNT(*) AS n FROM listings'),
      claimed: one(l, 'SELECT COUNT(*) AS n FROM listings WHERE claimed_at IS NOT NULL'),
      claimedToday: one(l, 'SELECT COUNT(*) AS n FROM listings WHERE claimed_at >= ? AND claimed_at < ?', from, to),
      featuredActive: one(l, 'SELECT COUNT(*) AS n FROM listings WHERE featured_paid_until > ?', to),
      featuredSold: featuredPaid,
      featuredUsd: featuredPaid * FEATURED_USD,
      quoteRequests: has(l, 'quote_log') ? one(l, 'SELECT COUNT(*) AS n FROM quote_log WHERE at >= ? AND at < ?', from, to) : 0,
    }
  }

  if (d.newsletter) {
    const rows = d.newsletter.subscribers()
    out.newsletter = { total: rows.filter((r) => r.confirmed_at < to).length, new: rows.filter((r) => r.confirmed_at >= from && r.confirmed_at < to).length, pending: d.newsletter.pendingCount() }
  }

  if (d.votesDb && has(d.votesDb, 'votes')) {
    out.votes = {
      cast: one(d.votesDb, 'SELECT COUNT(*) AS n FROM votes WHERE at >= ? AND at < ?', from, to),
      up: one(d.votesDb, 'SELECT COUNT(*) AS n FROM votes WHERE at >= ? AND at < ? AND value > 0', from, to),
      down: one(d.votesDb, 'SELECT COUNT(*) AS n FROM votes WHERE at >= ? AND at < ? AND value < 0', from, to),
    }
  }

  const sold = (out.pass as { revenueUsd?: number } | undefined)?.revenueUsd ?? 0
  const featured = (out.listings as { featuredUsd?: number } | undefined)?.featuredUsd ?? 0
  out.revenueUsd = sold + featured
  return out
}
