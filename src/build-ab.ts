/**
 * The /build A/B test: which page gets a typed idea, a checkout and a payment.
 *
 * Assignment is ours and server-side. A visitor gets a random first-party id in
 * a cookie scoped to /build (no third-party SDK, no fingerprint), and the
 * variant is a hash of the test name and that id, so the same browser always
 * sees the same page and a new test name reshuffles everyone. `?variant=a|b`
 * forces a page for QA; forced visits are recorded as qa and left out of the
 * report.
 *
 * Every funnel step is a row here, with its variant:
 *
 *   view      /build rendered (server side, every request)
 *   seen      the page's 1x1 image loaded: a browser that renders images.
 *             The report's denominator, because bots that fetch HTML only
 *             never load it and the raw views are two thirds bots.
 *   idea      the visitor typed an idea and sent it: A's "Start building"
 *             (through /build/go, then on to chovy.com) or B's "See what you
 *             get" (to /build/plan). The primary metric.
 *   handoff   sent on to chovy.com (A, or B's secondary link)
 *   checkout  a $49 invoice was made (either variant's invoice form)
 *   paid      that invoice is paid (checked against pay.agent by the report)
 *
 * A row keeps the random visitor id, the variant, the step and the time.
 * No idea text, email, address or user agent is kept here.
 */
import { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'

export const BUILD_TEST = 'build-2026-11'
export const AB_COOKIE = 'pit_build_ab'
export const AB_COOKIE_MAX_AGE = 180 * 86_400
export type Variant = 'a' | 'b'
export const VARIANTS: readonly Variant[] = ['a', 'b']
export const STEPS = ['view', 'seen', 'idea', 'handoff', 'checkout', 'paid'] as const
export type Step = (typeof STEPS)[number]

const ID = /^v[A-Za-z0-9_-]{16,32}$/

export const newVisitorId = (): string => `v${randomBytes(12).toString('base64url')}`
export const validVisitorId = (id: string | undefined | null): id is string => typeof id === 'string' && ID.test(id)

/** 50/50 and sticky: the low bit of sha256(test:id). */
export function variantFor(id: string, test = BUILD_TEST): Variant {
  return (createHash('sha256').update(`${test}:${id}`).digest()[0]! & 1) === 0 ? 'a' : 'b'
}

export const forcedVariant = (q: string | undefined | null): Variant | null => (q === 'a' || q === 'b' ? q : null)

/** Self-declared crawlers and tools. Headless browsers that lie get through, and the seen pixel and the form guard catch most of those. */
const BOT_UA = /bot|crawl|spider|slurp|fetch|scan|curl|wget|python|httpx|aiohttp|go-http|java\/|okhttp|axios|node-fetch|undici|headless|phantom|puppeteer|playwright|selenium|lighthouse|preview|facebookexternalhit|embedly|monitor|uptime|pingdom|validator|feed|rss|archive|ahrefs|semrush|mj12|dotbot|petal|bytespider|gptbot|claude|perplexity|ccbot|amazonbot|applebot|bingpreview|yandex|baidu|duckduck|^$/i
export const isBotUa = (ua: string | undefined | null): boolean => BOT_UA.test((ua ?? '').trim())

export type Arm = {
  variant: Variant
  /** Distinct visitors whose page was rendered (bots by user agent left out). */
  viewed: number
  /** Distinct visitors whose browser loaded the page's image: the denominator. */
  seen: number
  /** Of those, how many reached each step. */
  idea: number
  handoff: number
  checkout: number
  paid: number
}

export type Report = {
  test: string
  since: string
  arms: Arm[]
  /** Two-sided p-value for idea / seen, A vs B (two-proportion z-test), or null when it cannot be computed. */
  ideaP: number | null
  verdict: string
}

export class BuildAb {
  readonly db: Database

  constructor(
    db: Database | string = ':memory:',
    readonly test = BUILD_TEST,
    private readonly now = () => Date.now(),
    readonly readonly = false,
  ) {
    this.db = typeof db === 'string' ? (readonly ? new Database(db, { readonly: true }) : new Database(db, { create: true })) : db
    if (readonly) return
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run(`CREATE TABLE IF NOT EXISTS build_ab_events (
      id INTEGER PRIMARY KEY,
      test TEXT NOT NULL,
      visitor TEXT NOT NULL,
      variant TEXT NOT NULL,
      step TEXT NOT NULL,
      at INTEGER NOT NULL,
      bot INTEGER NOT NULL DEFAULT 0,
      qa INTEGER NOT NULL DEFAULT 0,
      ref TEXT
    )`)
    this.db.run('CREATE INDEX IF NOT EXISTS build_ab_events_test ON build_ab_events (test, step, at)')
    this.db.run('CREATE INDEX IF NOT EXISTS build_ab_events_visitor ON build_ab_events (visitor)')
  }

  /** One funnel step. `ref` is an invoice id for checkout/paid, nothing else. */
  record(visitor: string, variant: Variant, step: Step, o: { bot?: boolean; qa?: boolean; ref?: string } = {}): void {
    if (!validVisitorId(visitor)) return
    this.db
      .query('INSERT INTO build_ab_events (test, visitor, variant, step, at, bot, qa, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.test, visitor, variant, step, this.now(), o.bot ? 1 : 0, o.qa ? 1 : 0, o.ref ?? null)
  }

  /** Invoices made by the test and not yet known paid: the report asks pay.agent about these. */
  unpaidCheckouts(): Array<{ visitor: string; variant: Variant; ref: string }> {
    return this.db
      .query(
        `SELECT visitor, variant, ref FROM build_ab_events c WHERE test = ? AND step = 'checkout' AND ref IS NOT NULL AND qa = 0
         AND NOT EXISTS (SELECT 1 FROM build_ab_events p WHERE p.test = c.test AND p.step = 'paid' AND p.ref = c.ref)`,
      )
      .all(this.test) as Array<{ visitor: string; variant: Variant; ref: string }>
  }

  report(sinceMs = 0): Report {
    // Later steps count only visitors whose browser loaded the page image (step 'seen'), so HTML-only bots fall out.
    const viewedQ = this.db.query(`SELECT COUNT(DISTINCT visitor) AS n FROM build_ab_events WHERE test = ?1 AND variant = ?2 AND at >= ?3 AND step = 'view' AND bot = 0 AND qa = 0`)
    const reachedQ = this.db.query(
      `SELECT COUNT(DISTINCT visitor) AS n FROM build_ab_events WHERE test = ?1 AND variant = ?2 AND at >= ?3 AND step = ?4 AND qa = 0
       AND visitor IN (SELECT visitor FROM build_ab_events WHERE test = ?1 AND variant = ?2 AND at >= ?3 AND step = 'seen' AND bot = 0 AND qa = 0)`,
    )
    const arms = VARIANTS.map((variant): Arm => {
      const reached = (step: Step) => (reachedQ.get(this.test, variant, sinceMs, step) as { n: number }).n
      return {
        variant,
        viewed: (viewedQ.get(this.test, variant, sinceMs) as { n: number }).n,
        seen: reached('seen'),
        idea: reached('idea'),
        handoff: reached('handoff'),
        checkout: reached('checkout'),
        paid: reached('paid'),
      }
    })
    const [a, b] = arms as [Arm, Arm]
    const ideaP = twoProportionP(a.idea, a.seen, b.idea, b.seen)
    return { test: this.test, since: new Date(sinceMs).toISOString(), arms, ideaP, verdict: verdict(a, b, ideaP) }
  }
}

/** Standard normal CDF (Abramowitz and Stegun 7.1.26), good to about 1e-7. */
function phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2)
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2
}

/** Two-sided p-value that two conversion rates differ, or null with no visitors or no conversions at all. */
export function twoProportionP(x1: number, n1: number, x2: number, n2: number): number | null {
  if (n1 <= 0 || n2 <= 0) return null
  const pooled = (x1 + x2) / (n1 + n2)
  if (pooled === 0 || pooled === 1) return null
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
  const z = (x1 / n1 - x2 / n2) / se
  return 2 * (1 - phi(Math.abs(z)))
}

const pct = (x: number, n: number) => (n ? `${((100 * x) / n).toFixed(1)}%` : '-')

function verdict(a: Arm, b: Arm, p: number | null): string {
  const ideas = a.idea + b.idea
  if (a.seen < 30 || b.seen < 30 || ideas < 10)
    return `Too early to call: ${a.seen} + ${b.seen} visitors and ${ideas} ideas so far. Wait for at least 30 visitors and 10 ideas in total before reading anything into it, and about 100 visitors a side to see a 10-point lift.`
  if (p === null) return 'No difference can be computed yet.'
  const lead = a.idea / a.seen >= b.idea / b.seen ? 'A' : 'B'
  return p < 0.05
    ? `${lead} leads on ideas (${pct(a.idea, a.seen)} vs ${pct(b.idea, b.seen)}), p = ${p.toFixed(3)}: unlikely to be chance.`
    : `No clear winner yet (${pct(a.idea, a.seen)} vs ${pct(b.idea, b.seen)}), p = ${p.toFixed(3)}. Keep it running.`
}

/** The report as text, for the CLI and the admin page. */
export function formatReport(r: Report): string {
  const rows = r.arms.map(
    (a) =>
      `  ${a.variant.toUpperCase()}  ${String(a.viewed).padStart(6)}  ${String(a.seen).padStart(6)}  ${String(a.idea).padStart(5)} ${pct(a.idea, a.seen).padStart(6)}  ${String(a.handoff).padStart(7)}  ${String(a.checkout).padStart(8)}  ${String(a.paid).padStart(4)}`,
  )
  return [
    `/build A/B test ${r.test}, since ${r.since.slice(0, 10)}`,
    '  A = the page as it was (Start building goes to chovy.com); B = 3 live example apps, idea stays on pit.world, email for the invoice',
    '         viewed    seen  ideas   rate  handoff  checkout  paid',
    ...rows,
    `  idea rate p-value: ${r.ideaP === null ? 'n/a' : r.ideaP.toFixed(3)}`,
    `  ${r.verdict}`,
    '  (viewed = rendered, bots by user agent excluded; seen = the browser loaded the page image; later steps count only seen visitors; QA visits excluded)',
  ].join('\n')
}

/** Ask pay.agent whether each open checkout has been paid, and record the ones that have. Returns how many were newly paid. */
export async function refreshPaid(ab: BuildAb, payAgentUrl: string, doFetch: typeof fetch = fetch): Promise<number> {
  let paid = 0
  for (const c of ab.unpaidCheckouts()) {
    const res = await doFetch(`${payAgentUrl.replace(/\/+$/, '')}/api/v1/invoices/${encodeURIComponent(c.ref)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }).catch(() => null)
    const data = res?.ok ? ((await res.json().catch(() => null)) as { status?: string } | null) : null
    if (data?.status === 'paid') {
      ab.record(c.visitor, c.variant, 'paid', { ref: c.ref })
      paid++
    }
  }
  return paid
}
