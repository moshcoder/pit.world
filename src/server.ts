/**
 * The pit.world web server: pages, the JSON API, OpenSearch.
 *
 * Nothing here writes a log line about a request. Errors are reported without
 * the query attached.
 */
import { mountSubmit } from './submit-routes.js'
import { featureNetwork, networkPagesFromIndex, W3bsNetwork } from './w3bs-network.js'
import { type CrawlStatus, createCrawlStatus } from './crawl-status.js'
import { FOOTER_SCRIPT_SRC, ringFooterCss, startRingFooterRefresh } from './ring-footer.js'
import { Hono, type Context } from 'hono'
import { parseBang, BANGS } from './bangs.js'
import { aboutPage, sharedResultPage, shareMissingPage, whyPage, botPage, statusPage, buildPage, startPage, connectPage, errorPage, homePage, mediaPage, mobileConfig, newsletterPage, offlinePage, subscribersAdminPage, openSearchXml, privacyPage, resultsPage, ringOpml, ringPage } from './html.js'
import { adminAuthorized, brandFor, Newsletter, normalizeSource, resendMailer } from './newsletter.js'
import { createFormGuard } from '@profullstack/form-guard'
import { looksLikeSpam, orderByInvoice, OrderError, readOrder, type BuildInvoicing } from './build-invoice.js'
import { looksLikeName, Registry } from './moshpit.js'
import { RateLimiter } from './ratelimit.js'
import { snippetFor } from './footer.js'
import { neighbors, randomSite, ringJson, ringSites, siteHref, useListings } from './ring.js'
import { RingSync } from './ring-sync.js'
import { liveCerts, proxiedName, proxyRequest, registrySweep, Targets } from './proxy.js'
import { backfillFor, featuredFor } from './featured.js'
import { Promoted } from './promoted.js'
import { listingCard } from './listings-html.js'
import { FeaturedBusinesses } from './business-featured.js'
import { mountBusinessFeatured } from './business-featured-routes.js'
import { mountListings } from './listings-routes.js'
import { liveVerifier, Listings } from './listings.js'
import { ensurePublicDirectorySeeds } from './directory-seeds.js'
import { enrichNicheDb } from './nichedb.js'
import { resultPath, Shares } from './shares.js'
import { CATEGORY_RULES_VERSION, categoryFor, importNicheDb } from './nichedb-import.js'
import { enrichOfficialCompanySites } from './official-company-sites.js'
import { readFileSync } from 'node:fs'
import { Accounts, serviceHost } from './accounts.js'
import { COOKIE_PATHS, mountAccounts, parseCookies, type AccountDeps } from './accounts-routes.js'
import { SESSION_COOKIE, type Account } from './accounts.js'
import { PASS_DAYS, PASS_HEADER, PASS_LIMITS, PASS_RESOURCE_PATH, PASS_SUMMARIES, PASS_USD, SummaryPasses } from './summary-pass.js'
import { paymentRequiredHeader } from '@profullstack/x402-gateway'
import { dayRange, nightlyStats } from './admin-stats.js'
import { mountSummaryPass, passSection } from './summary-pass-routes.js'
import { createCrawlGate, type CrawlGate } from './crawl-gate.js'
import { Promotion } from './promotion.js'
import { mountPromotion } from './promotion-routes.js'
import { Promoters } from './promoters.js'
import { mountPromote } from './promoters-routes.js'
import { Rewards } from './rewards.js'
import { mountRewards, rewardsOnSignIn, rewardsSections } from './rewards-routes.js'
import { Boards, serviceRequest } from './services.js'
import { createDailyStitcher, DAILY_STITCHER_HOST } from './daily-stitcher.js'
import { Cache, normalizeQuery, search, SearchUnavailable, type Keys, type SearchResult } from './search.js'
import { parseVertical, searchMedia, thumbAllowed, type MediaResult, type Vertical } from './verticals.js'
import { AudioRegistry, embedHosts, FIXED_FRAME_HOSTS, proxyAudio, showEpisodes, showPage } from './players.js'
import { readableText, Speech, SpeechClient } from './speech.js'
import { summaryKey } from './summarize.js'
import { Summarizer, SummaryStore } from './summarize.js'
import { createThrottle } from '@profullstack/throttle'
import { CorpusBilling, pricingFromEnv } from './corpus.js'
import { corpusSection, mountCorpus } from './corpus-routes.js'
import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { clientSource, CLIENT_HEADERS } from '@profullstack/browser-fingerprint/source'
import { itemFor, KINDS, Votes, type VoteKind } from './votes.js'
import { ReaderHealth } from './reader-health.js'
import { VoteRewards } from './vote-rewards.js'
import { playerCss, playerJs } from './player-bundle.js'
import { accountOf, mountVoteHistory, voteHistorySection } from './vote-history-routes.js'
import { fingerprintSecret, VisitorGate, type WriteAction } from './visitor.js'
import { itemsOf, type VoteView } from './vote-html.js'
import { AuctionHouse, AUCTION_HOST, AUCTION_HOSTS, createAuctionApp, isAuctionHost } from './auctions.js'
import { AD_SLOT, esc, featuredTarget, TOP_ADS, votePage } from './html.js'

export type Deps = {
  keys: Keys
  registry?: Registry
  cache?: Cache
  limiter?: RateLimiter
  fetch?: typeof fetch
  publicDir?: string
  newsletter?: Newsletter
  /** Bearer token for /api/admin/*; unset means the admin API is off. */
  adminToken?: string
  /** The W3BS network's sites, featured in results; defaults to the live list from w3bs.org. */
  network?: Pick<W3bsNetwork, 'has'>
  /** The crawler's loopback base for /submit; defaults to CRAWLER_STATUS_URL. */
  crawlerUrl?: string
  /** pitbot's status for /status; defaults to the crawler's loopback /stats (CRAWLER_STATUS_URL). */
  crawlStatus?: () => Promise<CrawlStatus>
  /** PairUX + nixamp listings for the Videos, Music and Live tabs. */
  promoted?: Promoted
  /** Claimable business listings (/b); unset means the feature is off. */
  listings?: Listings
  /** Mirrors the ring to rssamplifier.com; unset means no mirror. */
  ringSync?: RingSync
  /** pit.world accounts (sign in with CoinPay, sign-in for *.pit.world sites); unset means off. */
  accounts?: AccountDeps
  /** Promotion campaigns over the listings (needs listings); unset means off. */
  promotion?: Promotion
  /** Promoter/affiliate program (needs accounts); unset means off. */
  promoters?: Promoters
  /** /build by pay.agent invoice; unset means only the chovy.com checkout. */
  featuredBusinesses?: FeaturedBusinesses
  buildInvoicing?: BuildInvoicing
  /** Credit codes (server months) and invites on accounts (needs accounts); unset means off. */
  rewards?: Rewards
  /** Addresses whose visits are ours, excluded from promotion measurement. */
  internalIps?: string[]
  /** The x402 crawl gateway (src/crawl-gate.ts); unset means training crawlers read free. */
  crawlGate?: CrawlGate | null
  /** Result summaries by c0mpute (src/summarize.ts); unset or keyless means the Summarize button is off. */
  summarizer?: Summarizer
  /** Summaries a visitor may start per hour: anonymous per address, signed in per account, and all anonymous visitors together. */
  summaryLimits?: { anon: number; signedIn: number; anonTotal: number }
  /** The $1/week summary pass (src/summary-pass.ts; needs accounts); unset means off. */
  summaryPasses?: SummaryPasses
  /** Public art submissions for auctions.pit.world and art.auctions.pit.world. */
  auctions?: AuctionHouse
  /** Keys every visitor hash and search hash (src/visitor.ts); a random one per process when unset (tests). */
  fingerprintSecret?: string
  /** Anonymous votes; defaults to a table in the listings database (or memory without one). */
  votes?: Votes
  /** Which sites turn the page reader away (src/reader-health.ts); defaults to the votes database. */
  readerHealth?: ReaderHealth
  /** Points for signed-in votes (src/vote-rewards.ts); defaults to the votes database, no payout rate. */
  voteRewards?: VoteRewards
  /** Audio files /audio may stream (players.ts); a fresh in-memory registry by default. */
  audio?: AudioRegistry
  /** Listen (read aloud) and Transcript through c0mpute's speech workers (src/speech.ts); off without a gateway. */
  speech?: Speech
  /** Free read-alouds and transcript previews a visitor may start per hour. */
  speechLimits?: { listenAnon: number; listenSignedIn: number; transcriptAnon: number; transcriptSignedIn: number; anonTotal: number }
  /** The training corpus's billing (src/corpus.ts); defaults to an in-memory one with the default price and no payments. */
  corpus?: CorpusBilling
  /** DNS for /audio's public-address check; injectable for tests. */
  resolve?: (host: string) => Promise<string[]>
}

/** The visitor's address arrives as a binding from serve() (or a test), never from a header the visitor controls. */
type Env = { Bindings: { ip?: string } }

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    `default-src 'none'; script-src 'self' https://crawlproof.com ${FOOTER_SCRIPT_SRC}; style-src 'self'; img-src 'self' data: https://built.indie.pit.world https://pwamart.com https://profullstack.com https://logicsrc.com; connect-src 'self' https://pit.world https://crawlproof.com; frame-src https://crawlproof.com ${FIXED_FRAME_HOSTS.join(' ')}; media-src 'self'; manifest-src 'self'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'`,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'interest-cohort=(), browsing-topics=(), camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
}

export function createApp(deps: Deps) {
  const registry = deps.registry ?? new Registry(undefined, deps.fetch)
  const cache = deps.cache ?? new Cache()
  const limiter = deps.limiter ?? new RateLimiter()
  const promoted = deps.promoted ?? new Promoted(deps.fetch)
  const network = deps.network ?? new W3bsNetwork(deps.fetch).start()
  const crawlStatus = deps.crawlStatus ?? createCrawlStatus(process.env.CRAWLER_STATUS_URL ?? 'http://127.0.0.1:8807')
  const app = new Hono<Env>()

  // Training crawlers buy a day pass before anything else, and ahead of the header
  // middleware below, which would strip the pass and checkout cookies it sets.
  const crawlGate = deps.crawlGate
  if (crawlGate) {
    app.use('*', async (c, next) => {
      if (isAuctionHost(c.req.header('host'))) {
        await next()
        return
      }
      const sold = await crawlGate.handle(c.req.raw)
      if (sold) return sold
      await next()
    })
  }

  app.use('*', async (c, next) => {
    await next()
    // A page with PeerTube players names their instances (x-frame-hosts, never sent on); only those join frame-src.
    const frames = (c.res.headers.get('x-frame-hosts') ?? '').split(' ').filter((h) => /^https:\/\/[a-z0-9.-]+$/i.test(h))
    c.res.headers.delete('x-frame-hosts')
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      c.header(name, name === 'content-security-policy' && frames.length ? value.replace('frame-src ', `frame-src ${frames.join(' ')} `) : value)
    // Belt and braces: only the sign-in and account routes set a cookie, and only after you press Sign in.
    // The one exception is the auction house's color theme choice (aa_theme), set when a visitor picks it.
    const auctionTheme = isAuctionHost(c.req.header('host')) && c.req.path.startsWith('/theme/')
    if (!auctionTheme && (!deps.accounts || !COOKIE_PATHS.test(c.req.path))) c.res.headers.delete('set-cookie')
  })

  const auctionApp = deps.auctions ? createAuctionApp(deps.auctions) : null
  if (auctionApp) {
    app.use('*', async (c, next) => {
      if (isAuctionHost(c.req.header('host'))) return auctionApp.fetch(c.req.raw, c.env)
      await next()
    })
  }

  const limited = (c: Context<Env>) => !limiter.take(c.env?.ip || 'unknown')

  // --- who is writing: browser fingerprints, not addresses (src/visitor.ts) --------
  const fpSecret = deps.fingerprintSecret ?? randomBytes(32).toString('base64url')
  const visitors = new VisitorGate(fpSecret, (ip) => limiter.take(ip || 'unknown'))
  const votes = deps.votes ?? new Votes(deps.listings?.db ?? new Database(':memory:'), fpSecret)
  const readerHealth = deps.readerHealth ?? votes.health ?? new ReaderHealth(votes.db)
  votes.health = readerHealth
  const voteRewards = deps.voteRewards ?? new VoteRewards(votes.db)
  // Shared results (src/shares.ts): written only when someone clicks Share, in the votes database.
  const shares = new Shares(votes.db, fpSecret)
  // Summarize and Listen both read pages through the summarizer: every read it makes is a reader-health sample.
  deps.summarizer?.observeReads((url, state) => readerHealth.record(url, state))
  deps.listings?.setVoteMoves((domains) => votes.listingMoves(domains))
  const fpOf = (c: Context<Env>, body?: Record<string, unknown> | null): unknown => c.req.header('x-fingerprint') || body?.fp || null
  /** True when an anonymous write is over its limit (or comes from a bot-scored browser). */
  const writeLimited = async (c: Context<Env>, action: WriteAction, body?: Record<string, unknown> | null, fallback?: (ip: string) => boolean) => {
    const gate = fallback ? new VisitorGate(fpSecret, fallback, visitors.guard) : visitors
    const verdict = await gate.write(action, fpOf(c, body), c.env?.ip || '', c.req.header('user-agent') ?? '')
    if (!verdict.ok && verdict.retryAfterMs) c.header('retry-after', String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))))
    return !verdict.ok
  }
  /** Tallies for the items a page shows, and where the no-JavaScript vote page links back to. */
  const voteView = (pairs: Array<[VoteKind, string | undefined | null]>, back: string, query?: string): VoteView => ({
    counts: votes.tallies(itemsOf(pairs), { query: query ?? null }),
    back,
  })

  // An affiliate link (/?ref=CODE, no query) lands on /join, a promoter's on /promote. No cookie either way.
  if (deps.rewards && deps.accounts) {
    app.use('/', async (c, next) => {
      const ref = c.req.query('ref')
      if (c.req.method !== 'GET' || !ref || c.req.query('q') || !/^[A-Za-z0-9_-]{4,40}$/.test(ref)) return next()
      return c.redirect(deps.promoters?.byCode(ref) ? `/promote?ref=${encodeURIComponent(ref)}` : `/join?ref=${encodeURIComponent(ref)}`, 302)
    })
  }

  async function runSearch(query: string, limit = 20): Promise<{ result: SearchResult | null; error: string | null }> {
    try {
      // Our index's network pages are asked alongside the engines (loopback, capped at 1.5 s).
      const fromIndex = networkPagesFromIndex(query, deps.keys.pit, network, deps.fetch)
      const result = await search(query, deps.keys, {
        cache,
        limit,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.summarizer ? { onText: (hits) => deps.summarizer!.remember(hits) } : {}),
      })
      logFailures(result.failures)
      const preferred = featuredFor(query, 1)[0]
      return { result: featureNetwork(result, network, await fromIndex, preferred), error: null }
    } catch (error) {
      // No query in the message or the log.
      if (error instanceof SearchUnavailable) console.warn(`search: ${error.message}`)
      return { result: null, error: error instanceof SearchUnavailable ? 'Web results are unavailable for a moment. Try again shortly, or use a bang like !ddg.' : 'Something went wrong fetching results.' }
    }
  }

  async function runMedia(vertical: Exclude<Vertical, 'web'>, query: string, limit?: number): Promise<{ result: MediaResult | null; error: string | null }> {
    try {
      return { result: await searchMedia(vertical, query, deps.keys, { cache, ...(limit ? { limit } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) }), error: null }
    } catch (error) {
      // No query in the message, and nothing logged.
      return { result: null, error: error instanceof SearchUnavailable ? 'These results are unavailable for a moment. Try again shortly.' : 'Something went wrong fetching results.' }
    }
  }


  const newsletter = deps.newsletter
  app.get('/', async (c) => {
    const businesses = deps.listings?.directory({ limit: 6 }).listings ?? []
    return c.html(homePage(await registry.stats(), { newsletter: newsletter?.enabled ?? false, businesses, votes: voteView(businesses.map((l) => ['listing', l.domain]), '/') }))
  })

  // --- newsletter (double opt-in) ------------------------------------------------
  // The one signup endpoint for every Profullstack property: the @profullstack/footer form posts here with a
  // hidden `site` (its hostname), plain HTML, no script. The answer is a page that says to check the inbox
  // and links back to that site.
  const origin = (site: unknown) => {
    const source = normalizeSource(site)
    return { source, pit: brandFor(source).pit }
  }
  app.get('/subscribe', (c) => {
    if (!newsletter?.enabled) return c.notFound()
    return c.html(newsletterPage('form', origin(c.req.query('site'))))
  })
  app.post('/subscribe', async (c) => {
    if (!newsletter?.enabled) return c.notFound()
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
    const from = origin(form.site ?? c.req.query('site'))
    if (await writeLimited(c, 'subscribe', form)) return c.html(newsletterPage('limited', from), 429, { 'retry-after': '30' })
    // The honeypot: a field people never see. A bot that fills it gets the normal answer and nothing else.
    if (typeof form.website === 'string' && form.website !== '') return c.html(newsletterPage('check', from))
    const result = await newsletter.signup(form.email, from.source)
    const page = result === 'sent' || result === 'already' ? 'check' : result
    return c.html(newsletterPage(page, from), page === 'check' ? 200 : page === 'failed' ? 503 : 400)
  })
  // JSON for scripts and other sites' pages (CORS: any origin may post an address; nothing is read back).
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }
  app.options('/api/subscribe', (c) => c.body(null, 204, { ...cors, 'access-control-allow-headers': 'content-type, x-fingerprint' }))
  app.post('/api/subscribe', async (c) => {
    for (const [k, v] of Object.entries(cors)) c.header(k, v)
    if (!newsletter?.enabled) return c.json({ error: 'The newsletter is not open on this instance.' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; site?: unknown; fp?: unknown }
    if (await writeLimited(c, 'subscribe', body)) {
      c.header('retry-after', '30')
      return c.json({ error: 'Too many requests. Try again shortly.' }, 429)
    }
    const result = await newsletter.signup(body.email, body.site)
    if (result === 'sent' || result === 'already') return c.json({ ok: true, status: 'check-inbox' })
    const status = { invalid: 400, undeliverable: 400, failed: 503 }[result]
    return c.json({ ok: false, status: result }, status as 400 | 503)
  })
  app.get('/confirm', (c) => {
    if (!newsletter) return c.notFound()
    const done = newsletter.confirm(c.req.query('t'))
    return done ? c.html(newsletterPage('confirmed', origin(done.source))) : c.html(newsletterPage('expired'), 410)
  })
  // Subscribers by property, for an admin: bearer token, or a signed-in pit.world admin account in a browser.
  const subscriberAdmin = (c: Context<Env>) => {
    if (adminAuthorized(c.req.header('authorization'), deps.adminToken)) return true
    const a = deps.accounts
    const me = a ? a.accounts.sessionAccount(parseCookies(c.req.header('cookie'))[SESSION_COOKIE]) : null
    return Boolean(me && (a!.admins ?? []).includes(me.sub))
  }
  // The nightly report's numbers for one UTC day (src/admin-stats.ts): counts only. Default yesterday.
  app.get('/api/admin/stats.json', (c) => {
    if (!subscriberAdmin(c)) return c.json({ error: 'unauthorized' }, 401)
    const day = c.req.query('day') ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    if (!dayRange(day)) return c.json({ error: 'day must be YYYY-MM-DD' }, 400)
    c.header('cache-control', 'no-store')
    return c.json(
      nightlyStats(
        {
          ...(deps.accounts ? { accounts: deps.accounts.accounts } : {}),
          ...(deps.summarizer ? { summarizer: deps.summarizer } : {}),
          ...(deps.summaryPasses ? { passes: deps.summaryPasses } : {}),
          ...(deps.listings ? { listings: deps.listings } : {}),
          ...(newsletter ? { newsletter } : {}),
          ...(deps.votes ? { votesDb: deps.votes.db } : {}),
        },
        day,
      ),
    )
  })
  app.get('/api/admin/subscribers.json', (c) => {
    if (!newsletter || !subscriberAdmin(c)) return c.json({ error: 'unauthorized' }, 401)
    const source = normalizeSource(c.req.query('site')) ?? undefined
    c.header('cache-control', 'no-store')
    return c.json({ total: newsletter.count(), pending: newsletter.pendingCount(), properties: newsletter.byProperty(), ...(c.req.query('list') !== undefined || source ? { subscribers: newsletter.subscribers(source) } : {}) })
  })
  app.get('/admin/subscribers', (c) => {
    if (!newsletter) return c.notFound()
    if (!subscriberAdmin(c)) return c.html('<!doctype html><title>Sign in</title><p>Sign in as a pit.world admin: <a href="/signin?next=/admin/subscribers">sign in</a>.</p>', 401)
    const source = normalizeSource(c.req.query('site')) ?? undefined
    c.header('cache-control', 'no-store')
    return c.html(subscribersAdminPage(newsletter.byProperty(), newsletter.subscribers(source), { total: newsletter.count(), pending: newsletter.pendingCount(), ...(source ? { site: source } : {}) }))
  })
  app.get('/api/admin/subscribers.csv', (c) => {
    if (!newsletter || !subscriberAdmin(c)) return c.json({ error: 'unauthorized' }, 401)
    return c.body(newsletter.csv(normalizeSource(c.req.query('site')) ?? undefined), 200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' })
  })
  app.get('/privacy', (c) => c.html(privacyPage()))
  app.get('/about', (c) => c.html(aboutPage()))
  app.get('/why', (c) => c.html(whyPage()))
  // Share: check the signed result, keep it, and send the reader to its own page.
  app.get('/share', (c) => {
    const slug = shares.save({ u: c.req.query('u'), t: c.req.query('t'), d: c.req.query('d'), i: c.req.query('i'), s: c.req.query('s') })
    if (!slug) return c.html(shareMissingPage('That share link does not check out', 'It is broken or was changed. Search again and use Share under the result.'), 400)
    return c.redirect(resultPath(slug), 303)
  })
  app.get('/result/*', (c) => {
    let slug = ''
    try {
      slug = decodeURIComponent(c.req.path.slice('/result/'.length))
    } catch {}
    const shared = slug ? shares.get(slug) : null
    if (!shared) return c.html(shareMissingPage('Not shared yet', 'Nobody has shared that result. Search for it, then use Share under it.'), 404)
    const back = resultPath(shared.slug)
    const view = voteView([['result', shared.url]], back, '')
    const listing = deps.listings?.toPublic(shared.host) ? shared.host : null
    return c.html(sharedResultPage(shared, view, listing))
  })
  app.get('/bot', (c) => c.html(botPage()))
  // Sites, pages, feeds, sitemaps and OPML into our own index (src/submit-routes.ts).
  mountSubmit(app, { crawlerUrl: deps.crawlerUrl ?? process.env.CRAWLER_STATUS_URL ?? 'http://127.0.0.1:8807', limited, writeLimited: (c, body) => writeLimited(c, 'submit', body), ...(deps.fetch ? { fetch: deps.fetch } : {}) })
  // pitbot's live status: the crawler is its own service, read over loopback.
  app.get('/status', async (c) => {
    c.header('cache-control', 'no-store')
    return c.html(statusPage(await crawlStatus()))
  })
  app.get('/api/status', async (c) => {
    c.header('cache-control', 'no-store')
    c.header('access-control-allow-origin', '*')
    return c.json(await crawlStatus())
  })
  app.get('/connect', (c) => c.html(connectPage()))
  // The house form guard on the invoice form: a signed token minted with the page (a bot that POSTs
  // without rendering /build has none), a fill-time floor and the honeypot. Rate limiting stays ours.
  const orderGuard = deps.buildInvoicing
    ? createFormGuard({
        secret: deps.buildInvoicing.guard?.secret || deps.buildInvoicing.key,
        binding: 'build-invoice',
        honeypotField: 'website',
        rateLimit: false,
        ...(deps.buildInvoicing.guard?.minAgeMs !== undefined ? { minAgeMs: deps.buildInvoicing.guard.minAgeMs } : {}),
      })
    : null
  const guardHtml = async () => (orderGuard ? orderGuard.hiddenHTML(await orderGuard.issue(), { className: 'hp' }) : undefined)
  app.get('/build', async (c) => {
    c.header('cache-control', 'no-store')
    return c.html(buildPage({ invoicing: Boolean(deps.buildInvoicing), guard: await guardHtml() }))
  })
  // /build by invoice: two pay.agent invoices ($49 now, $2 a month from day 31), then the buyer sees the first.
  const orderLimit = new RateLimiter(3, 0.2)
  app.post('/build/invoice', async (c) => {
    const cfg = deps.buildInvoicing
    if (!cfg || !orderGuard) return c.redirect('/build')
    const form = (await c.req.parseBody()) as Record<string, string>
    const again = async (error: string, status: 400 | 429 | 502) => c.html(buildPage({ invoicing: true, error, values: form, guard: await guardHtml() }), status)
    if (await writeLimited(c, 'order', form, (ip) => orderLimit.take(ip || 'unknown'))) return again('Too many orders from you just now. Try again in a few minutes.', 429)
    // No token, a forged one or a filled honeypot: told it worked (back to /build), no invoice, no email.
    // A stale page or a too-fast submit is a person often enough to get the form back instead.
    const verdict = await orderGuard.check({ fields: form, ip: c.env?.ip || null })
    if (verdict.action === 'drop') {
      console.log('build order: dropped by form guard:', verdict.reason)
      return c.redirect('/build')
    }
    if (verdict.action === 'retry') return again('That page had been open a while. Please send it again.', 400)
    try {
      const order = readOrder(form)
      // Stock contact-form spam is answered like the honeypot: back to /build, no invoice, no email.
      if (looksLikeSpam(order)) {
        console.log('build order: spam ignored from', order.email)
        return c.redirect('/build')
      }
      const { build } = await orderByInvoice(cfg, order)
      return c.redirect(build.url)
    } catch (e) {
      return again(e instanceof Error ? e.message : String(e), e instanceof OrderError && !e.message.startsWith('pay.agent') ? 400 : 502)
    }
  })
  app.get('/start', (c) => c.html(startPage()))
  // /promote and its sub-routes are mounted by mountPromote when accounts are on.

  // The global footer every fleet site fetches server-side and prints last in <body> (footer.ts).
  app.get('/snippets/:file{footer\\.(html|tmpl)}', (c) => {
    const html = snippetFor(c.req.query('site'))
    if (html === null) return c.text('?site=<your host> is required', 400)
    // Sites with the shared Profullstack footer get no second network footer.
    // Other Moshpit sites get the pit.world one; clearnet members get the neutral one.
    return c.body(html, 200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' })
  })

  // --- the pit.world ring ----------------------------------------------------------
  useListings(deps.listings ? () => deps.listings!.ringMembers() : null)
  app.get('/ring', (c) => c.html(ringPage({ mirror: deps.ringSync?.last ?? null })))
  app.get('/api/ring', (c) =>
    // Member sites fetch this server-side; the CORS header lets a browser-only site use it too.
    c.json(ringJson(), 200, { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' }),
  )
  app.get('/ring/opml', (c) => c.body(ringOpml(ringSites()), 200, { 'content-type': 'text/x-opml; charset=utf-8', 'cache-control': 'public, max-age=900' }))
  app.get('/ring/:to{next|prev|previous|random}', (c) => {
    // ?from= is the house shape; ?host=, ?url= and ?via= are what other rings send; the Referer is the last resort.
    const from = c.req.query('from') ?? c.req.query('host') ?? c.req.query('url') ?? c.req.query('via') ?? c.req.header('referer')
    const to = c.req.param('to')
    const site = to === 'random' ? randomSite(from) : neighbors(from)[to === 'next' ? 'next' : 'prev']
    c.header('cache-control', 'no-store')
    return c.redirect(siteHref(site, c.req.query('direct') === '1'), 302)
  })
  app.get('/offline', (c) => c.html(offlinePage()))
  app.get('/health', (c) => c.json({ ok: true, providers: Object.keys(deps.keys).filter((k) => deps.keys[k as keyof Keys]) }))
  // pwamart.com store listing: ownership proof for https://pit.world
  app.get('/.well-known/pwamart.txt', (c) => c.body('19278327af99806655813c4a\n', 200, { 'content-type': 'text/plain; charset=utf-8' }))
  app.get('/robots.txt', (c) =>
    c.body('User-agent: *\nDisallow: /search\nDisallow: /share\nDisallow: /api/\nAllow: /\nSitemap: https://pit.world/sitemap.xml\n', 200, { 'content-type': 'text/plain; charset=utf-8' }),
  )
  app.get('/sitemap.xml', (c) =>
    c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/connect', '/start', '/build', '/api', ...(deps.promoters ? ['/promote'] : []), '/ring', '/pros', '/b', '/featured', '/why', '/about', '/privacy', '/submit', '/status', '/bot', ...(deps.listings ? deps.listings.sitemapDomains().map((d) => `/b/${encodeURIComponent(d)}`) : []), ...shares.slugs().map(resultPath)]
        .map((p) => `<url><loc>https://pit.world${esc(p)}</loc></url>`)
        .join('')}</urlset>`,
      200,
      { 'content-type': 'application/xml; charset=utf-8' },
    ),
  )
  app.get('/llms.txt', (c) =>
    c.body(
      `# pit.world

> Private web search, the Moshpit network's front door, and an open training corpus of pit.world's own crawl index.

- [API docs](https://pit.world/api): JSON, CORS open, no key for search.
- [Search API](https://pit.world/api#search): GET /api/search?q=
- [Training corpus](https://pit.world/api#corpus): GET /api/corpus?q=saas,business,crypto&limit=100&cursor= (full page text, keyset paging; commas = any of the terms). Free preview 20 pages a day, then $1 per 1,000 pages by x402 (per request or credit pack) or CoinPay invoice. GET /api/corpus/stats is free.
- [Training opt-outs](https://pit.world/api#corpus-policy): pages with noai (X-Robots-Tag or meta robots), TDMRep reservations, or robots.txt rules against AI-training crawlers are never in the corpus.
- [pitbot](https://pit.world/bot): the crawler, and how to keep it out.
- MCP: \`claude mcp add pit -- pit mcp\` (tools: search, corpus, summarize, submit_urls, moshpit_resolve, ...)
`,
      200,
      { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    ),
  )
  app.get('/opensearch.xml', (c) => c.body(openSearchXml(), 200, { 'content-type': 'application/opensearchdescription+xml; charset=utf-8' }))

  // Suggestions cost nothing and call nobody: bangs, and a Moshpit name as typed.
  app.get('/suggest', (c) => {
    const q = normalizeQuery(c.req.query('q') ?? '')
    const out: string[] = []
    const last = q.split(' ').pop() ?? ''
    if (last.startsWith('!')) for (const bang of BANGS) for (const alias of bang.aliases ?? []) if (`!${alias}`.startsWith(last.toLowerCase())) out.push(`${q.slice(0, q.length - last.length)}!${alias}`)
    return c.json([q, out.slice(0, 8)], 200, { 'cache-control': 'no-store' })
  })

  app.get('/search', async (c) => {
    const query = normalizeQuery(c.req.query('q') ?? '')
    if (!query) return c.redirect('/', 302)
    const bang = parseBang(query)
    if (bang) return c.redirect(bang.url, 302)
    // A browser searches a typed w3bs://chovy.hacker because it cannot load the scheme; open it.
    if (/^w3bs:\/\//i.test(query)) return c.redirect(`https://w3bs.org/browse?q=${encodeURIComponent(query)}`, 302)
    if (limited(c)) {
      c.header('retry-after', '30')
      return c.html(resultsPage({ query, result: null, resolution: null, error: 'Too many searches from your connection just now. Give it half a minute.' }), 429)
    }
    const vertical = parseVertical(c.req.query('t'))
    c.header('cache-control', 'no-store')
    const back = `/search?q=${encodeURIComponent(query)}${vertical === 'web' ? '' : `&t=${vertical}`}`
    if (vertical !== 'web') {
      const [{ result, error }, promos] = await Promise.all([runMedia(vertical, query), promoted.for(query, vertical)])
      if (result) result.hits = votes.rerank(result.hits, query)
      const mediaFeatured = featuredFor(query)
      const mediaBackfill = mediaFeatured.length ? undefined : backfillFor(query)
      const view = voteView(
        [
          ...(result?.hits ?? []).map((m): [VoteKind, string] => ['result', m.url]),
          ...promos.map((p): [VoteKind, string] => ['promo', p.url]),
          ...(result?.sites ?? []).map((s): [VoteKind, string] => ['blog', s.url]),
          ...[...mediaFeatured, ...(mediaBackfill ? [mediaBackfill] : [])].map((s): [VoteKind, string] => ['featured', featuredTarget(s)]),
          ...adPairs(vertical),
        ],
        back,
        query,
      )
      const frameHosts = embedHosts(result?.hits.map((h) => h.player) ?? [])
      if (frameHosts.length) c.header('x-frame-hosts', frameHosts.join(' '))
      return c.html(mediaPage({ query, vertical, result, promos, error, featured: mediaFeatured, votes: view, speech: !!deps.speech?.enabled, ...(mediaBackfill ? { backfill: mediaBackfill } : {}) }), result || promos.length ? 200 : 503)
    }
    const [{ result, error }, resolution] = await Promise.all([runSearch(query), looksLikeName(query) ? registry.resolve(query) : Promise.resolve(null)])
    // Votes nudge the order a bounded number of places; the featured network site leading the results keeps its place.
    if (result) result.hits = votes.rerank(result.hits, query, (h) => Boolean(h.featured))
    const claimed = deps.listings?.claimedOnly(query)
    // The site leading the results already says "Featured": the box above them does not repeat it.
    const leadHost = result?.hits[0]?.featured ? result.hits[0].host : null
    const featured = featuredFor(query).filter((s) => !leadHost || new URL(siteHref(s, false)).hostname !== leadHost)
    const backfill = featured.length || leadHost ? undefined : backfillFor(query)
    const view = voteView(
      [
        ...(result?.hits ?? []).map((h): [VoteKind, string] => ['result', h.url]),
        ...[...featured, ...(backfill ? [backfill] : [])].map((s): [VoteKind, string] => ['featured', featuredTarget(s)]),
        ...(claimed ? [['listing', claimed.domain] as [VoteKind, string]] : []),
        ...adPairs('web'),
      ],
      back,
      query,
    )
    return c.html(resultsPage({ query, result, resolution, error, featured, votes: view, share: (h) => shares.href(h), summaries: !!deps.summarizer?.enabled, listen: !!deps.speech?.enabled, ...(backfill ? { backfill } : {}), ...(claimed ? { card: listingCard(claimed, view) } : {}) }), result || resolution || claimed || featured.length ? 200 : 503)
  })

  // --- votes -------------------------------------------------------------------
  // The fingerprint script, from our own origin (script-src 'self'): @profullstack/browser-fingerprint's client.
  app.get('/fp.js', (c) => c.body(clientSource(), 200, CLIENT_HEADERS))
  // A short-lived token the browser must hold before a vote counts; bound to the visitor's network.
  const challengeLimit = new RateLimiter(60, 30)
  app.get('/api/fp/challenge', async (c) => {
    c.header('cache-control', 'no-store')
    if (!challengeLimit.take(c.env?.ip || 'unknown')) return c.json({ error: 'rate limited' }, 429, { 'retry-after': '30' })
    return c.json({ token: await visitors.challenge(c.env?.ip || '') })
  })
  type VoteBody = { kind?: unknown; target?: unknown; value?: unknown; v?: unknown; q?: unknown; toggle?: unknown; fp?: unknown; back?: unknown }
  async function castVote(c: Context<Env>, body: VoteBody) {
    const target = itemFor(body.kind, body.target)
    const value = Math.trunc(Number(body.value ?? body.v ?? NaN))
    if (!target || ![-1, 0, 1].includes(value)) return { status: 400 as const, json: { ok: false, error: 'bad-vote', message: 'kind must be one of ' + KINDS.join(', ') + '; value 1, -1 or 0.' } }
    const gate = await visitors.vote(fpOf(c, body as Record<string, unknown>), c.env?.ip || '', c.req.header('user-agent') ?? '')
    if (!gate.ok) {
      if (gate.retryAfterMs) c.header('retry-after', String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))))
      const status = gate.reason === 'limited' ? 429 : gate.reason === 'bot' ? 403 : 400
      return { status: status as 400 | 403 | 429, json: { ok: false, error: gate.reason } }
    }
    const query = typeof body.q === 'string' ? normalizeQuery(body.q) : ''
    // Signed in, the vote is also the account's: it shows in /account/votes and can earn a point.
    const account = deps.accounts ? accountOf(deps.accounts.accounts, c)?.id ?? null : null
    const { qkey, ...result } = votes.cast({ visitor: gate.visitor, ...target, value, query, toggle: body.toggle === true || body.toggle === '1', account })
    const points = voteRewards.onVote(account, target.item, qkey, result.value)
    return { status: 200 as const, json: { ok: true, item: target.item, ...result, ...(account ? { signedIn: true, points } : {}) } }
  }
  app.post('/api/vote', async (c) => {
    c.header('cache-control', 'no-store')
    const body = (await c.req.json().catch(() => ({}))) as VoteBody
    const { status, json } = await castVote(c, body)
    return c.json(json, status)
  })
  // The form behind every ▲ ▼: without JavaScript there is no fingerprint, so the vote is refused politely.
  app.post('/vote', async (c) => {
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, string>
    const back = typeof form.back === 'string' && /^\/(?!\/)[^\s]{0,600}$/.test(form.back) ? form.back : '/'
    if (!fpOf(c, form)) return c.html(votePage('needs-js', back), 400)
    const q = back.startsWith('/search?') ? new URLSearchParams(back.slice(8)).get('q') ?? '' : ''
    const { status, json } = await castVote(c, { ...form, q })
    if (status === 200) return c.redirect(back, 303)
    return c.html(votePage((json as { error: string }).error as 'needs-js' | 'stale' | 'bot' | 'limited' | 'bad-vote', back), status)
  })

  // --- JSON API ---------------------------------------------------------------
  app.use('/api/*', async (c, next) => {
    await next()
    c.header('access-control-allow-origin', '*')
    // The corpus sets its own (stats are cacheable, paid pages are private).
    if (!c.req.path.startsWith('/api/corpus') || !c.res.headers.has('cache-control')) c.header('cache-control', 'no-store')
  })

  app.get('/api/search', async (c) => {
    const query = normalizeQuery(c.req.query('q') ?? '')
    if (!query) return c.json({ error: 'q is required' }, 400)
    if (limited(c)) {
      c.header('retry-after', '30')
      return c.json({ error: 'rate limited' }, 429)
    }
    const raw = Math.trunc(Number(c.req.query('n') ?? 10))
    const n = Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 20) : 10
    const vertical = parseVertical(c.req.query('t'))
    const featured = featuredFor(query).map((s) => ({ name: s.name, url: siteHref(s, false), about: s.about }))
    if (vertical !== 'web') {
      const [{ result, error }, promos] = await Promise.all([runMedia(vertical, query, n), promoted.for(query, vertical)])
      if (!result) return c.json({ query, type: vertical, error, featured, promoted: promos }, 503)
      result.hits = votes.rerank(result.hits, query)
      return c.json({ query, type: vertical, provider: result.provider, featured, results: result.hits, promoted: promos })
    }
    const [{ result, error }, resolution] = await Promise.all([runSearch(query, n), looksLikeName(query) ? registry.resolve(query) : Promise.resolve(null)])
    if (!result) return c.json({ query, error, featured, moshpit: resolution }, 503)
    result.hits = votes.rerank(result.hits, query, (h) => Boolean(h.featured))
    return c.json({ query, provider: result.provider, featured, results: result.hits, moshpit: resolution })
  })

  app.get('/api/resolve', async (c) => {
    const name = (c.req.query('name') ?? '').trim()
    if (!looksLikeName(name)) return c.json({ error: 'name must look like label.ending' }, 400)
    const resolution = await registry.resolve(name)
    return resolution ? c.json(resolution) : c.json({ error: 'registry unavailable' }, 503)
  })

  app.get('/api/network', async (c) => {
    const stats = await registry.stats()
    return stats ? c.json(stats) : c.json({ error: 'registry unavailable' }, 503)
  })

  app.get('/api/bangs', (c) => c.json(BANGS.map((b) => ({ name: b.name, bangs: b.aliases, url: b.url }))))

  // --- the training corpus: pitbot's index as full text, opt-outs excluded (src/corpus-routes.ts) ---
  const corpusBilling = deps.corpus ?? new CorpusBilling(new Database(':memory:'), { usdPer1000: 1 })
  mountCorpus(app, {
    billing: corpusBilling,
    crawlerUrl: deps.crawlerUrl ?? process.env.CRAWLER_STATUS_URL ?? 'http://127.0.0.1:8807',
    accounts: deps.accounts?.accounts ?? null,
    site: deps.accounts?.site ?? process.env.PIT_SITE ?? 'https://pit.world',
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  })

  // --- summaries (src/summarize.ts) ------------------------------------------------
  // POST starts one (throttled; a cached summary is free and instant), GET polls it. Never blocks a search.
  const summarizer = deps.summarizer
  const summaryLimits = deps.summaryLimits ?? { anon: 5, signedIn: 60, anonTotal: 300 }
  // Each counts against `x-pit-who`, set below from the address or the account; none multiplies by headroom.
  const hourly = (limit: number) =>
    createThrottle({ limit, windowSeconds: 3600, headroom: 1, credential: false, subresources: false, identify: (r) => r.headers.get('x-pit-who') })
  const anonPerIp = hourly(summaryLimits.anon)
  const anonIpCeiling = hourly(summaryLimits.anon * 3)
  const anonTotal = hourly(summaryLimits.anonTotal)
  const perAccount = hourly(summaryLimits.signedIn)
  const over = async (throttle: ReturnType<typeof hourly>, who: string) =>
    !!(await throttle.handle(new Request('http://pit.world/api/summarize', { method: 'POST', headers: { 'x-pit-who': who } })))
  const summaryAccount = (c: Context<Env>) => {
    const a = deps.accounts?.accounts
    if (!a) return null
    const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    return (bearer ? a.tokenAccount(bearer) : null) ?? a.sessionAccount(parseCookies(c.req.header('cookie'))[SESSION_COOKIE])
  }
  const summaryUrl = (raw: unknown): string | null => {
    if (typeof raw !== 'string' || raw.length > 2000) return null
    try {
      const u = new URL(raw.trim())
      return /^https?:$/.test(u.protocol) ? u.href : null
    } catch {
      return null
    }
  }

  app.get('/api/summarize', (c) => {
    if (!summarizer?.enabled) return c.json({ error: 'Summaries are off on this server.' }, 503)
    const url = summaryUrl(c.req.query('url'))
    if (!url) return c.json({ error: 'url must be an http(s) address' }, 400)
    return c.json(summarizer.status(url))
  })

  /** The summary pass's x402 offer as a 402 (body and PAYMENT-REQUIRED header), or a plain 429 when x402 is off. */
  const paymentRequired = (c: Context<Env>, url: string, error: string, extra: Record<string, unknown> = {}) => {
    const offer = deps.summaryPasses?.offer()
    if (!offer) return c.json({ status: 'limited', url, error, ...extra }, 429)
    c.header('payment-required', paymentRequiredHeader(offer, { error }))
    c.header('access-control-expose-headers', `PAYMENT-REQUIRED, PAYMENT-RESPONSE, ${PASS_HEADER}`)
    return c.json({ ...offer, error, status: 'limited', url, pass: '/pass', passHeader: PASS_HEADER, ...extra }, 402)
  }

  // The pass alone, for agents: GET (or POST without proof) is the 402 offer; POST with a proof returns the token.
  const sellPass = async (c: Context<Env>) => {
    const passes = deps.summaryPasses
    if (!passes?.x402Enabled) return c.json({ error: 'x402 is not enabled on this server. Signed-in people can buy the pass at /pass.' }, 404)
    const token = c.req.header(PASS_HEADER)
    if (token) {
      const state = await passes.stateOfToken(token)
      if (state) return c.json({ status: 'active', header: PASS_HEADER, ...state })
    }
    const proof = c.req.header('payment-signature') || c.req.header('x-payment')
    if (!proof) return paymentRequired(c, '', `$${PASS_USD} buys ${PASS_SUMMARIES.toLocaleString('en-US')} summaries in ${PASS_DAYS} days.`)
    const sale = await passes.sell(proof, c.req.header('user-agent') ?? '')
    if (!sale.ok) return paymentRequired(c, '', sale.error)
    if (sale.paymentResponse) c.header('payment-response', sale.paymentResponse)
    c.header('access-control-expose-headers', `PAYMENT-RESPONSE, ${PASS_HEADER}`)
    c.header(PASS_HEADER, sale.token)
    return c.json({ status: 'active', token: sale.token, header: PASS_HEADER, expiresAt: new Date(sale.expiresAt).toISOString(), days: PASS_DAYS, limit: PASS_SUMMARIES })
  }
  app.get(PASS_RESOURCE_PATH, sellPass)
  app.post(PASS_RESOURCE_PATH, sellPass)

  app.post('/api/summarize', async (c) => {
    if (!summarizer?.enabled) return c.json({ error: 'Summaries are off on this server.' }, 503)
    const type = c.req.header('content-type') ?? ''
    const body: any = type.includes('json') ? await c.req.json().catch(() => ({})) : await c.req.parseBody().catch(() => ({}))
    const url = summaryUrl(body?.url ?? c.req.query('url'))
    if (!url) return c.json({ error: 'url must be an http(s) address' }, 400)
    const now = summarizer.status(url)
    // Already written or being written: free.
    if (now.status === 'done') return c.json(now)
    if (now.status === 'pending') return c.json(now, 202)
    if (!summarizer.known(url)) return c.json({ status: 'refused', url, error: 'Only a page from a recent pit.world result can be summarized. Search for it first.' }, 404)
    const passes = deps.summaryPasses
    // x402, for bots and agents: a payment proof buys the $1 pass on this very request, and a pass
    // token (x-summary-pass) is counted against its 1,000 instead of any hourly limit.
    let token = c.req.header(PASS_HEADER) || null
    const proof = c.req.header('payment-signature') || c.req.header('x-payment')
    let sold = false
    if (proof && passes?.x402Enabled) {
      const sale = await passes.sell(proof, c.req.header('user-agent') ?? '')
      if (!sale.ok) return paymentRequired(c, url, sale.error)
      token = sale.token
      sold = true
      c.header(PASS_HEADER, sale.token)
      if (sale.paymentResponse) c.header('payment-response', sale.paymentResponse)
    }
    if (token && passes?.x402Enabled) {
      const used = await passes.useToken(token)
      if (used === 'over') return c.json({ status: 'limited', url, error: `That is ${PASS_SUMMARIES.toLocaleString('en-US')} summaries in ${PASS_DAYS} days, this pass's limit. Buy another pass for more.` }, 429)
      if (used === 'none') return paymentRequired(c, url, 'That summary pass is not valid or has ended.')
      return c.json({ ...summarizer.start(url), ...(sold ? { pass: { token, header: PASS_HEADER, days: PASS_DAYS, limit: PASS_SUMMARIES } } : {}) }, 202)
    }
    const me = summaryAccount(c)
    // A paid pass replaces the hourly allowance with 1,000 a week (src/summary-pass.ts).
    const pass = me && deps.summaryPasses ? deps.summaryPasses.use(me.id) : 'none'
    if (pass === 'over') {
      return c.json({ status: 'limited', url, pass: '/account#summary-pass', error: `That is ${PASS_SUMMARIES.toLocaleString('en-US')} summaries in ${PASS_DAYS} days, your pass's limit. Older ones free up as they pass 7 days.` }, 429)
    }
    if (me && pass === 'none') {
      if (await over(perAccount, `acct:${me.id}`)) {
        c.header('retry-after', '3600')
        return c.json(
          { status: 'limited', url, ...(deps.summaryPasses ? { pass: '/pass' } : {}), error: `That is ${summaryLimits.signedIn} summaries this hour. More in an hour${deps.summaryPasses ? `, or $${PASS_USD} a week for ${PASS_SUMMARIES.toLocaleString('en-US')}` : ''}.` },
          429,
        )
      }
    } else if (!me) {
      const ip = c.env?.ip || 'unknown'
      // Per device when the browser sent its fingerprint (src/visitor.ts), with the address as a looser
      // ceiling; per address otherwise, as before. A bot-scored browser gets nothing.
      const v = await visitors.guard.verify({ payload: fpOf(c, body), ip, userAgent: c.req.header('user-agent') ?? '' })
      if (v.reason === 'bot') return c.json({ status: 'refused', url, error: 'That looked automated.' }, 403)
      const who = v.ok ? `fp:${v.visitorKey}` : `ip:${ip}`
      if ((await over(anonPerIp, who)) || (v.ok && (await over(anonIpCeiling, `ip:${ip}`))) || (await over(anonTotal, 'anon'))) {
        c.header('retry-after', '3600')
        // A 402 with the x402 offer when it is on (a paying agent retries with PAYMENT-SIGNATURE), else a 429.
        return paymentRequired(c, url, `Free summaries are ${summaryLimits.anon} an hour without an account. Sign in for ${summaryLimits.signedIn} an hour, or pay $${PASS_USD} over x402 for ${PASS_SUMMARIES.toLocaleString('en-US')} in ${PASS_DAYS} days.`, { signIn: '/signin' })
      }
    }
    return c.json(summarizer.start(url), 202)
  })

  // Vote tallies: read-only, no fingerprint needed. ?kind=&target= (one), or ?item=kind:target repeated; ?q= for results on one search.
  app.get('/api/votes', (c) => {
    const q = normalizeQuery(c.req.query('q') ?? '')
    const items = [...(c.req.queries('item') ?? [])]
    const one = itemFor(c.req.query('kind'), c.req.query('target'))
    if (one) items.unshift(one.item)
    const parsed = items.map((i) => {
      const at = i.indexOf(':')
      if (at <= 0) return null
      const kind = i.slice(0, at)
      const target = i.slice(at + 1)
      // Stored result items have no scheme (result:example.com/page); accept them either way.
      return itemFor(kind, ['result', 'promo', 'blog'].includes(kind) && !/^https?:\/\//i.test(target) ? `https://${target}` : target)
    })
    const valid = parsed.filter((x): x is NonNullable<typeof x> => Boolean(x)).slice(0, 100)
    if (!valid.length) return c.json({ error: 'give kind and target, or item=<kind>:<target> (kinds: ' + KINDS.join(', ') + ')' }, 400)
    const counts = votes.tallies(valid.map((v) => v.item), { query: q || null })
    return c.json({
      query: q || null,
      prior: { up: 5, down: 5 },
      items: valid.map((v) => {
        const t = counts.get(v.item)!
        return { item: v.item, kind: v.kind, up: t.up, down: t.down, score: Number(t.score.toFixed(4)) }
      }),
    })
  })
  // Sites that turn pit.world's page reader away (Summarize and Listen), decayed to now. Never says who searched.
  app.get('/api/reader-health', (c) => {
    const domain = (c.req.query('domain') ?? '').trim().toLowerCase().replace(/^www\./, '')
    const round = (h: NonNullable<ReturnType<ReaderHealth['get']>>) => ({
      domain: h.domain,
      blocked: Number(h.blocked.toFixed(3)),
      ok: Number(h.ok.toFixed(3)),
      share: Number(h.share.toFixed(4)),
      blocksReaders: readerHealth.blocks(h),
      lastBlockedAt: h.lastBlockedAt ? new Date(h.lastBlockedAt).toISOString() : null,
      lastOkAt: h.lastOkAt ? new Date(h.lastOkAt).toISOString() : null,
    })
    if (domain) {
      const h = readerHealth.get(domain)
      return c.json(h ? round(h) : { domain, blocked: 0, ok: 0, share: 0, blocksReaders: false, lastBlockedAt: null, lastOkAt: null })
    }
    const n = Number(c.req.query('n') ?? 50)
    return c.json({ items: readerHealth.worst(Number.isFinite(n) ? n : 50).map(round) })
  })
  app.get('/api/votes/top', (c) => {
    const kind = c.req.query('kind') ?? 'result'
    if (!(KINDS as readonly string[]).includes(kind)) return c.json({ error: 'kind must be one of ' + KINDS.join(', ') }, 400)
    const order = c.req.query('order') === 'worst' ? 'worst' : 'best'
    const limit = Number(c.req.query('n') ?? c.req.query('limit') ?? 20)
    const min = Number(c.req.query('min') ?? 1)
    return c.json({ kind, order, items: votes.top(kind as VoteKind, { limit, order, min }).map((t) => ({ ...t, score: Number(t.score.toFixed(4)) })), totals: votes.totals() })
  })

  // Thumbnails for the Images/Videos/Live/Shopping/News tabs and Open Library's book covers, fetched by us so
  // the visitor's browser never talks to Google, YouTube or Open Library. Only the hosts in thumbAllowed():
  // a redirect is followed by hand (covers.openlibrary.org -> archive.org -> ia<N>.us.archive.org), and every
  // hop must pass the same allowlist, so a redirect can never lead the proxy anywhere else.
  app.get('/img', async (c) => {
    let url = thumbAllowed(c.req.query('u') ?? '')
    if (!url) return c.body(null, 400)
    try {
      let upstream: Response | null = null
      for (let hop = 0; hop < 4; hop++) {
        // threatcrush-disable-next-line js-ssrf-outbound-request  fixed allowlist of public thumbnail hosts (thumbAllowed), https only, every redirect hop re-checked
        const response: Response = await (deps.fetch ?? fetch)(url.href, { redirect: 'manual', signal: AbortSignal.timeout(6_000), headers: { 'user-agent': 'pit.world image proxy (https://pit.world/privacy)' } })
        if (response.status < 300 || response.status >= 400) {
          upstream = response
          break
        }
        const next: URL | null = thumbAllowed(new URL(response.headers.get('location') ?? '', url).href)
        if (!next) return c.body(null, 502)
        url = next
      }
      if (!upstream) return c.body(null, 502)
      const type = upstream.headers.get('content-type') ?? ''
      if (!upstream.ok || !/^image\/(jpeg|png|gif|webp|avif)/.test(type)) return c.body(null, 502)
      const body = await upstream.arrayBuffer()
      if (body.byteLength > 2_000_000) return c.body(null, 502)
      return c.body(body, 200, { 'content-type': type, 'cache-control': 'public, max-age=86400' })
    } catch {
      return c.body(null, 502)
    }
  })

  // --- Listen and Transcript (src/speech.ts) ------------------------------------------
  // Free: a few an hour (transcripts as a five-minute preview). The $1/week pass lifts that to its own weekly
  // counts (summary-pass.ts PASS_LIMITS). Anything already written is free and instant for everyone.
  const speech = deps.speech
  const speechLimits = deps.speechLimits ?? { listenAnon: 3, listenSignedIn: 10, transcriptAnon: 2, transcriptSignedIn: 6, anonTotal: 120 }
  const listenAnon = hourly(speechLimits.listenAnon)
  const listenAcct = hourly(speechLimits.listenSignedIn)
  const transcriptAnon = hourly(speechLimits.transcriptAnon)
  const transcriptAcct = hourly(speechLimits.transcriptSignedIn)
  const speechAnonTotal = hourly(speechLimits.anonTotal)
  /** Who is asking and what they hold: an x402 pass token, a signed-in account's pass, or nothing. */
  const speechHolder = async (c: Context<Env>) => {
    const passes = deps.summaryPasses
    const token = c.req.header(PASS_HEADER) || null
    if (token && passes?.x402Enabled && (await passes.tokenHolder(token))) return { kind: 'token' as const, token, me: null }
    const me = summaryAccount(c)
    if (me && passes?.holds(me.id)) return { kind: 'pass' as const, token: null, me }
    return { kind: 'free' as const, token: null, me }
  }
  /** Counts one use against the pass, or the free hourly allowance. Returns a response when refused. */
  const speechAllowance = async (c: Context<Env>, what: 'listen' | 'transcript', holder: Awaited<ReturnType<typeof speechHolder>>) => {
    const passes = deps.summaryPasses
    const noun = what === 'listen' ? 'read-alouds' : 'whole transcripts'
    if (holder.kind !== 'free' && passes) {
      const used = holder.kind === 'token' ? await passes.useToken(holder.token, what) : passes.use(holder.me!.id, what)
      if (used === 'over') return c.json({ status: 'limited', error: `That is ${PASS_LIMITS[what]} ${noun} in ${PASS_DAYS} days, the pass's limit. Older ones free up as they pass 7 days.` }, 429)
      return null
    }
    const offer = deps.summaryPasses ? `, or $${PASS_USD} a week for ${PASS_LIMITS[what]}` : ''
    if (holder.me) {
      if (await over(what === 'listen' ? listenAcct : transcriptAcct, `${what}:acct:${holder.me.id}`)) {
        c.header('retry-after', '3600')
        return c.json({ status: 'limited', pass: '/pass', error: `That is the free ${what === 'listen' ? 'read-alouds' : 'transcript previews'} for this hour. More in an hour${offer}.` }, 429)
      }
      return null
    }
    const ip = c.env?.ip || 'unknown'
    if ((await over(what === 'listen' ? listenAnon : transcriptAnon, `${what}:ip:${ip}`)) || (await over(speechAnonTotal, 'speech:anon'))) {
      c.header('retry-after', '3600')
      return c.json({ status: 'limited', pass: '/pass', signIn: '/account', error: `That is the free ${what === 'listen' ? 'read-alouds' : 'transcript previews'} for this hour. Sign in for more${offer}.` }, 429)
    }
    return null
  }

  app.get('/api/listen', (c) => {
    if (!speech?.enabled) return c.json({ error: 'Listen is off on this server.' }, 503)
    const url = summaryUrl(c.req.query('url'))
    if (!url) return c.json({ error: 'url must be an http(s) address' }, 400)
    return c.json(speech.listenStatus(url, summaryKey(url)))
  })
  app.post('/api/listen', async (c) => {
    if (!speech?.enabled) return c.json({ error: 'Listen is off on this server.' }, 503)
    const body: any = (c.req.header('content-type') ?? '').includes('json') ? await c.req.json().catch(() => ({})) : await c.req.parseBody().catch(() => ({}))
    const url = summaryUrl(body?.url ?? c.req.query('url'))
    if (!url) return c.json({ error: 'url must be an http(s) address' }, 400)
    const key = summaryKey(url)
    const now = speech.listenStatus(url, key)
    if (now.status === 'done') return c.json(now)
    if (now.status === 'pending') return c.json(now, 202)
    if (!summarizer?.known(url)) return c.json({ status: 'refused', url, error: 'Only a page from a recent pit.world result can be read aloud. Search for it first.' }, 404)
    const refused = await speechAllowance(c, 'listen', await speechHolder(c))
    if (refused) return refused
    const title = summarizer.title(url) ?? ''
    const state = speech.startListen(url, key, async () => {
      // The summary when one is written; otherwise the start of the page itself.
      const written = summarizer.status(url)
      if (written.status === 'done') return { text: readableText(title, written.summary), source: 'summary' }
      const page = await summarizer.pageText(url)
      if (page.replace(/\s+/g, ' ').length < 80) throw new Error('could not read the page')
      return { text: readableText(title, page), source: 'page' }
    })
    return c.json(state, state.status === 'done' ? 200 : 202)
  })
  app.get('/api/listen/audio/:file', async (c) => {
    const file = speech?.listenFile(c.req.param('file'))
    if (!file || !(await file.exists())) return c.notFound()
    const size = file.size
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '')
    const headers = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400' }
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start >= size || start > end) return c.body(null, 416, { 'content-range': `bytes */${size}` })
      return c.body(await file.slice(start, end + 1).arrayBuffer(), 206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) })
    }
    return c.body(await file.arrayBuffer(), 200, { ...headers, 'content-length': String(size) })
  })

  const transcriptAudio = (raw: unknown): string | null => (typeof raw === 'string' && raw.length < 2000 && audio.allowed(raw) ? raw : null)
  app.get('/api/transcript', (c) => {
    if (!speech?.enabled) return c.json({ error: 'Transcripts are off on this server.' }, 503)
    const src = c.req.query('audio')
    if (typeof src !== 'string' || src.length > 2000) return c.json({ error: 'audio must be an episode address' }, 400)
    return c.json(speech.transcriptStatus(src))
  })
  app.post('/api/transcript', async (c) => {
    if (!speech?.enabled) return c.json({ error: 'Transcripts are off on this server.' }, 503)
    const body: any = (c.req.header('content-type') ?? '').includes('json') ? await c.req.json().catch(() => ({})) : await c.req.parseBody().catch(() => ({}))
    const src = transcriptAudio(body?.audio ?? c.req.query('audio'))
    if (!src) return c.json({ status: 'refused', error: 'Only an episode pit.world is playing can be transcribed. Open its episodes first.' }, 404)
    const holder = await speechHolder(c)
    const full = holder.kind !== 'free'
    // Already written, or being written, as far as this visitor may read: free.
    if (speech.transcriptCovered(src, full)) return c.json({ ...speech.transcriptStatus(src), pass: full })
    const refused = await speechAllowance(c, 'transcript', holder)
    if (refused) return refused
    return c.json({ ...speech.startTranscript(src, full), pass: full }, 202)
  })

  // --- players (src/players.ts) ----------------------------------------------------
  // Podcast episodes and song previews play through pit.world, so the publisher never sees the visitor. Only
  // files pit.world handed out: an iTunes preview, or an episode from a p0dcasters playlist it just read.
  const audio = deps.audio ?? new AudioRegistry()
  const episodeCache = new Map<string, { at: number; episodes: Array<{ title: string; seconds?: number; src: string }> }>()
  app.get('/api/episodes', async (c) => {
    const show = showPage(c.req.query('show') ?? '')
    if (!show) return c.json({ error: 'show must be a p0dcasters.com/podcast/<name> page' }, 400)
    const hit = episodeCache.get(show)
    if (hit && Date.now() - hit.at < 3600_000) {
      for (const e of hit.episodes) audio.add(decodeURIComponent(e.src.slice('/audio?u='.length)))
      return c.json({ show, episodes: hit.episodes })
    }
    if (limited(c)) return c.json({ error: 'Too many requests. Try again in a minute.' }, 429)
    try {
      const episodes = (await showEpisodes(show, audio, deps.fetch)).map((e) => ({ title: e.title, ...(e.seconds ? { seconds: e.seconds } : {}), src: `/audio?u=${encodeURIComponent(e.url)}` }))
      episodeCache.set(show, { at: Date.now(), episodes })
      while (episodeCache.size > 2_000) episodeCache.delete(episodeCache.keys().next().value!)
      return c.json({ show, episodes })
    } catch {
      return c.json({ error: 'That show\'s episodes could not be read right now.' }, 502)
    }
  })
  app.get('/audio', async (c) => {
    const u = c.req.query('u') ?? ''
    if (!audio.allowed(u)) return c.body(null, 403)
    try {
      return await proxyAudio(u, c.req.header('range') ?? null, { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.resolve ? { resolve: deps.resolve } : {}) })
    } catch {
      return c.body(null, 502)
    }
  })

  // --- static -------------------------------------------------------------------
  // The @profullstack/footer stylesheet, from the same template as the footer markup.
  app.get('/pfs-footer.css', (c) =>
    c.body(ringFooterCss(), 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' }),
  )
  // @profullstack/player, bundled once on first use (src/player-bundle.ts); app.js loads it only to play something.
  app.get('/pf-player.js', async (c) => {
    try {
      return c.body(await playerJs(), 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' })
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      return c.text('player unavailable', 503)
    }
  })
  app.get('/pf-player.css', (c) => c.body(playerCss(), 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' }))
  const dir = deps.publicDir ?? new URL('../public/', import.meta.url).pathname
  const TYPES: Record<string, string> = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json' }
  app.get('/:file{[a-z0-9-]+\\.(css|js|svg|png|webmanifest)}', async (c) => {
    const file = Bun.file(`${dir}${c.req.param('file')}`)
    if (!(await file.exists())) return c.notFound()
    const ext = c.req.param('file').split('.').pop()!
    // The service worker must be re-checked on every visit, or an old one lingers for an hour.
    const cacheControl = c.req.param('file') === 'sw.js' ? 'no-cache' : 'public, max-age=3600'
    return c.body(await file.arrayBuffer(), 200, { 'content-type': TYPES[ext]!, 'cache-control': cacheControl })
  })

  // The Moshpit root, the same file the registry publishes, and an Apple profile that carries it.
  const rootPem = () => Bun.file(`${dir}moshpit-root-ca.crt`).text()
  app.get('/moshpit-root-ca.crt', async (c) =>
    c.body(await rootPem(), 200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="moshpit-root-ca.crt"', 'cache-control': 'public, max-age=86400' }),
  )
  app.get('/moshpit.mobileconfig', async (c) =>
    c.body(mobileConfig(await rootPem()), 200, { 'content-type': 'application/x-apple-aspen-config', 'content-disposition': 'attachment; filename="moshpit.mobileconfig"', 'cache-control': 'public, max-age=86400' }),
  )

  if (deps.accounts) {
    const rewards = deps.rewards
    const passes = deps.summaryPasses
    // /account shows the rewards section, then the summary pass.
    const sections = [voteHistorySection(votes, voteRewards), rewards ? rewardsSections(rewards) : null, passes ? passSection(passes) : null, deps.corpus ? corpusSection(deps.corpus) : null].filter((s) => s !== null)
    const accountSections = deps.accounts.accountSections ?? (sections.length ? async (me: Account) => (await Promise.all(sections.map((s) => s(me)))).join('\n') : undefined)
    mountAccounts(app, {
      ...deps.accounts,
      ...(rewards ? { onSignIn: deps.accounts.onSignIn ?? rewardsOnSignIn(rewards) } : {}),
      ...(accountSections ? { accountSections } : {}),
    })
    mountVoteHistory(app, { votes, rewards: voteRewards, accounts: deps.accounts.accounts, site: deps.accounts.site, ...(deps.accounts.admins ? { admins: deps.accounts.admins } : {}), ...(deps.adminToken ? { adminToken: deps.adminToken } : {}) })
    if (rewards) mountRewards(app, { rewards, accounts: deps.accounts.accounts, site: deps.accounts.site })
    if (passes) mountSummaryPass(app, { passes, accounts: deps.accounts.accounts, site: deps.accounts.site })
  }
  if (deps.promoters && deps.accounts) mountPromote(app, { promoters: deps.promoters, accounts: deps.accounts.accounts, site: deps.accounts.site })
  const promoHooks =
    deps.listings && deps.promotion
      ? mountPromotion(app, {
          promo: deps.promotion,
          listings: deps.listings,
          ...(deps.adminToken ? { adminToken: deps.adminToken } : {}),
          ...(deps.internalIps ? { internalIps: deps.internalIps } : {}),
          isAdmin: (c) => {
            const a = deps.accounts
            const me = a ? a.accounts.sessionAccount(parseCookies(c.req.header('cookie'))[SESSION_COOKIE]) : null
            return Boolean(me && (a!.admins ?? []).includes(me.sub))
          },
        })
      : null
  if (deps.listings) mountBusinessFeatured(app, deps.listings, deps.featuredBusinesses, limited, deps.accounts?.site ?? 'https://pit.world')
  if (deps.listings)
    mountListings(app, deps.listings, limited, looksLikeName, {
      ringChanged: () => deps.ringSync?.soon(ringSites),
      writeLimited: (c, action, body, fallback) => writeLimited(c, action, body, fallback),
      voteView: (domains, back) => voteView(domains.map((d) => ['listing', d]), back),
      ...(promoHooks ?? {}),
    })

  app.notFound((c) =>
    c.req.path.startsWith('/api/')
      ? c.json({ error: 'not found' }, 404)
      : c.html(homePage(null).replace('<p class="tag">', '<p class="tag">That page does not exist. ').replace(/<link rel="canonical"[^>]*>/, '<meta name="robots" content="noindex">'), 404),
  )
  // Nothing about the request is logged, the query least of all.
  app.onError((_error, c) =>
    c.req.path.startsWith('/api/') ? c.json({ error: 'Something went wrong.' }, 500) : c.html(errorPage(), 500),
  )
  return app
}

/** The sponsored slots a results page renders (html.ts sponsoredTop/adUnit), as vote targets. */
function adPairs(page: string): Array<[VoteKind, string]> {
  if (AD_SLOT === 'off') return []
  return [...Array.from({ length: TOP_ADS }, (_, i): [VoteKind, string] => ['ad', `${page}:top-${i + 1}`]), ['ad', `${page}:inline`]]
}

const logged = new Map<string, number>()

/** Which engine failed and why, at most once per engine and reason every ten minutes. Never the query. */
function logFailures(failures: SearchResult['failures']): void {
  const now = Date.now()
  for (const { provider, error } of failures) {
    const key = `${provider} ${error}`
    if (now - (logged.get(key) ?? 0) < 10 * 60_000) continue
    logged.set(key, now)
    console.warn(`search: ${key}`)
  }
}

/** Provider keys from the environment (the deploy writes them from the vault). */
export function keysFromEnv(env: Record<string, string | undefined> = process.env): Keys {
  return {
    serper: env.SERPER_API_KEY,
    bing: env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD ? `${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}` : undefined,
    brave: env.BRAVE_API_KEY,
    tavily: env.TAVILY_API_KEY,
    ceramic: env.CERAMIC_API_KEY,
    linkup: env.LINKUP_API_KEY,
    exa: env.EXA_API_KEY,
    // Not a key: the base URL of a SearXNG instance on loopback, e.g. http://127.0.0.1:8888.
    searxng: env.SEARXNG_URL,
    // Not a key either: our own index, "<base URL>[ <api key>]". By default the crawler's local
    // search mirror on loopback (milliseconds); PIT_INDEX_URL=https://nichedb.dev searches the
    // published copy instead (slower); PIT_INDEX_URL=off turns it off.
    pit:
      env.PIT_INDEX_URL === 'off'
        ? undefined
        : `${env.PIT_INDEX_URL ?? env.CRAWLER_STATUS_URL ?? 'http://127.0.0.1:8807'}${env.PIT_INDEX_KEY ? ` ${env.PIT_INDEX_KEY}` : ''}`,
    perplexity: env.PERPLEXITY_API_KEY,
  }
}

export function serve(options: { port?: number; hostname?: string } = {}) {
  const env = process.env
  const dataDir = env.PIT_DATA_DIR ?? `${env.HOME ?? '.'}/.local/share/pit-world`
  const auctions = new AuctionHouse(env.PIT_AUCTIONS_DB ?? `${dataDir}/auctions.db`)
  const newsletter = new Newsletter(env.PIT_NEWSLETTER_DB ?? `${dataDir}/newsletter.db`, env.RESEND_API_KEY ? resendMailer(env.RESEND_API_KEY) : null)
  const registry = new Registry()
  const rootPem = readFileSync(new URL('../public/moshpit-root-ca.crt', import.meta.url), 'utf8')
  const mailer = env.RESEND_API_KEY ? resendMailer(env.RESEND_API_KEY) : null
  const listings = new Listings(env.PIT_LISTINGS_DB ?? `${dataDir}/listings.db`, liveVerifier(fetch, { resolve: (name) => registry.resolve(name), rootPem }), undefined, { mailer })
  ensurePublicDirectorySeeds(listings)
  const ringSync = env.RSSAMPLIFIER_API_KEY
    ? new RingSync({ apiKey: env.RSSAMPLIFIER_API_KEY, ...(env.RSSAMPLIFIER_URL ? { base: env.RSSAMPLIFIER_URL } : {}), ...(env.RSSAMPLIFIER_RING ? { slug: env.RSSAMPLIFIER_RING } : {}) })
    : undefined
  const site = env.PIT_SITE ?? 'https://pit.world'
  const accounts: AccountDeps = {
    accounts: new Accounts(env.PIT_ACCOUNTS_DB ?? `${dataDir}/accounts.db`),
    site,
    coinpay: env.PIT_COINPAY_CLIENT_ID && env.PIT_COINPAY_CLIENT_SECRET ? { clientId: env.PIT_COINPAY_CLIENT_ID, clientSecret: env.PIT_COINPAY_CLIENT_SECRET } : null,
    bridgeKey: env.PIT_BRIDGE_KEY ?? null,
    extraClients: [...new Set([...((env.PIT_BRIDGE_CLIENTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)), DAILY_STITCHER_HOST])],
    admins: (env.PIT_ADMIN_SUBS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  }
  const promotion = new Promotion(listings, site)
  const promoters = new Promoters(env.PIT_PROMOTERS_DB ?? `${dataDir}/promoters.db`)
  const internalIps = (env.PIT_INTERNAL_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const buildInvoicing: BuildInvoicing | undefined = env.PIT_PAYAGENT_KEY
    ? { payAgentUrl: env.PIT_PAYAGENT_URL ?? 'https://pay.agent.pit.world', key: env.PIT_PAYAGENT_KEY, mailer, notifyTo: env.PIT_BUILD_NOTIFY ?? 'ettinger@gmail.com' }
    : undefined
  const featuredBusinesses = buildInvoicing ? new FeaturedBusinesses(listings, buildInvoicing) : undefined
  if (featuredBusinesses) {
    const tick = () => void featuredBusinesses.tick().catch(() => console.error('Featured billing sync failed'))
    setTimeout(tick, 5_000).unref()
    setInterval(tick, 60_000).unref()
  }
  // The $1/week summary pass: sold through the same pay.agent key; shown but not sellable without it.
  const summaryPasses = new SummaryPasses(accounts.accounts.db, buildInvoicing ?? null, Date.now, env.COINPAY_X402_KEY && env.CRAWL_PAY_TO ? { apiKey: env.COINPAY_X402_KEY, payTo: env.CRAWL_PAY_TO, site: env.PIT_SITE || 'https://pit.world' } : null)
  if (buildInvoicing) {
    const tick = () => void summaryPasses.tick().catch(() => console.error('Summary pass billing sync failed'))
    setTimeout(tick, 7_000).unref()
    setInterval(tick, 60_000).unref()
  }
  // The training corpus: $1 per 1,000 pages (PIT_CORPUS_USD_PER_1000), free and unmetered with PIT_CORPUS_INTERNAL_KEY.
  const corpus = new CorpusBilling(accounts.accounts.db, pricingFromEnv(env), {
    internalKey: env.PIT_CORPUS_INTERNAL_KEY ?? null,
    invoicing: buildInvoicing ?? null,
    x402: env.COINPAY_X402_KEY && env.CRAWL_PAY_TO ? { apiKey: env.COINPAY_X402_KEY, payTo: env.CRAWL_PAY_TO, site: env.PIT_SITE || 'https://pit.world' } : null,
  })
  if (buildInvoicing) {
    const tick = () => void corpus.tick().catch(() => console.error('Corpus credits billing sync failed'))
    setTimeout(tick, 9_000).unref()
    setInterval(tick, 60_000).unref()
  }
  const rewards = new Rewards(accounts.accounts.db, { mailer, notifyTo: env.PIT_BUILD_NOTIFY ?? 'ettinger@gmail.com', promoterCode: (code) => Boolean(promoters.byCode(code)) })
  // c0mpute only (AGENTS.md): no key, no summaries; never a paid provider.
  const summarizer = new Summarizer({
    ...(env.C0MPUTE_API_KEY ? { apiKey: env.C0MPUTE_API_KEY } : {}),
    model: env.C0MPUTE_MODEL ?? 'qwen2.5:7b',
    ...(env.C0MPUTE_URL ? { baseUrl: env.C0MPUTE_URL } : {}),
    // Pages are read through Infernet's page reader (the TronBrowser fetch_page relay); set it empty to fetch directly only.
    ...(env.PIT_PAGE_RELAY_URL !== undefined ? { pageRelayUrl: env.PIT_PAGE_RELAY_URL } : {}),
    store: new SummaryStore(env.PIT_SUMMARIES_DB ?? `${dataDir}/summaries.db`),
  })
  // Listen and Transcript: c0mpute's speech gateway (on dev2, 127.0.0.1:8818, the c0mpute-speech compose project).
  const speech = new Speech(env.C0MPUTE_SPEECH_URL && env.C0MPUTE_SPEECH_TOKEN ? new SpeechClient(env.C0MPUTE_SPEECH_URL, env.C0MPUTE_SPEECH_TOKEN) : null, {
    dbPath: env.PIT_SPEECH_DB ?? `${dataDir}/speech.db`,
    dir: env.PIT_SPEECH_DIR ?? `${dataDir}/speech`,
    ...(env.PIT_FFMPEG ? { ffmpeg: env.PIT_FFMPEG } : {}),
  })
  const fpSecret = fingerprintSecret(dataDir)
  const app = createApp({ keys: keysFromEnv(), summarizer, summaryPasses, corpus, speech, auctions, crawlGate: createCrawlGate(), fingerprintSecret: fpSecret, votes: new Votes(listings.db, fpSecret), voteRewards: new VoteRewards(listings.db, { usdPerPoint: Number(env.PIT_VOTE_POINT_USD) || null }), newsletter, listings, accounts, promotion, promoters, rewards, internalIps, ...(buildInvoicing ? { buildInvoicing, featuredBusinesses } : {}), ...(ringSync ? { ringSync } : {}), ...(env.PIT_ADMIN_TOKEN ? { adminToken: env.PIT_ADMIN_TOKEN } : {}) })
  // Every hour: start measurement windows that are ready, mark ended ones due and write their reports and drafts. Sends nothing.
  const hourly = () => {
    try {
      promotion.tick()
    } catch {}
  }
  setTimeout(hourly, 90_000).unref()
  setInterval(hourly, 3600 * 1000).unref()
  // Once a day: re-read every claimed site (its feed, whether it has an ICANN address), then mirror the ring.
  const daily = async () => {
    await listings.checkSites().catch(() => 0)
    await ringSync?.run(ringSites)
  }
  setTimeout(daily, 60_000).unref()
  setInterval(daily, 24 * 3600 * 1000).unref()
  // Refresh public company topics once a day; the importer accepts exact domain matches only.
  const refreshDirectoryResearch = () => void enrichNicheDb(listings)
    .then((r) => console.log(`NicheDB / OutreachGraph: checked ${r.checked}, matched ${r.matched}, unmatched ${r.unmatched}, failed ${r.failed}`))
    .catch(() => console.error('NicheDB / OutreachGraph refresh failed'))
  // Corporate contacts and team links are read from the company's own public site,
  // never from OutreachGraph's private prospect database.
  const refreshCompanyMetadata = () => void enrichOfficialCompanySites(listings)
    .then((r) => console.log(`Official company metadata: checked ${r.checked}, enriched ${r.enriched}, failed ${r.failed}`))
    .catch(() => console.error('Official company metadata refresh failed'))
  setTimeout(refreshCompanyMetadata, 30_000).unref()
  setInterval(refreshCompanyMetadata, 24 * 3600 * 1000).unref()
  setTimeout(refreshDirectoryResearch, 10_000).unref()
  setInterval(refreshDirectoryResearch, 24 * 3600 * 1000).unref()
  // Companies from NicheDB's directory (OutreachGraph's public half) become unclaimed listings, a few
  // pages a run: every 5 minutes while behind, hourly once caught up. One run at a time.
  if (env.PIT_DIRECTORY_IMPORT !== 'off') {
    let running = false
    const importDirectory = async () => {
      if (running) return
      running = true
      let caughtUp = false
      try {
        const r = await importNicheDb(listings, { pages: Number(env.PIT_DIRECTORY_IMPORT_PAGES ?? 10) || 10 })
        caughtUp = r.caughtUp
        console.log(`NicheDB directory import: read ${r.read}, companies ${r.candidates}, resolving ${r.resolved}, written ${r.imported}, after id ${r.cursor ?? 0}${r.caughtUp ? ', caught up' : ''}`)
      } catch (err) {
        console.error(`NicheDB directory import failed: ${(err as Error).message}`)
      } finally {
        running = false
        setTimeout(importDirectory, caughtUp ? 3600_000 : 5 * 60_000).unref()
      }
    }
    try {
      const n = listings.recategorizeImported(categoryFor, CATEGORY_RULES_VERSION)
      if (n) console.log(`NicheDB directory import: re-categorised ${n} imported listings`)
    } catch (err) {
      console.error(`NicheDB directory re-categorise failed: ${(err as Error).message}`)
    }
    setTimeout(importDirectory, 90_000).unref()
  }
  const trustProxy = (process.env.PIT_TRUST_PROXY ?? '1') === '1'
  // Last good target per name, on disk: the relay keeps serving names while the registry is down.
  const certs = liveCerts()
  const proxyDeps = { access: { resolve: (name: string) => registry.resolve(name), rootPem }, certs, targets: new Targets(`${dataDir}/relay-targets.json`) }
  // This is a pit.world-owned exact host, not a claimed Moshpit registry name.
  // Provision its dedicated multi-label certificate before HSTS browsers connect.
  if (import.meta.main && !certs.has(DAILY_STITCHER_HOST)) certs.issue(DAILY_STITCHER_HOST)
  // These are pit.world-owned hosts with explicit app routes, including the
  // one-label auctions.pit.world host that does not represent a Moshpit name.
  if (import.meta.main) for (const host of AUCTION_HOSTS) if (!certs.has(host)) certs.issue(host)
  // Certificates for every reachable name before its first visit (HSTS browsers never make the http one).
  if (env.PIT_CERT_SWEEP !== 'off') {
    const sweep = registrySweep(proxyDeps.access, proxyDeps.certs, undefined, proxyDeps.targets)
    const run = () =>
      sweep()
        .then((r) => {
          if (r.missing.length) console.log(`cert sweep: ${r.names} names, missing ${r.missing.join(' ')}, asked ${r.asked.length}`)
        })
        .catch((err) => console.error(`cert sweep failed: ${(err as Error).message}`))
    setTimeout(run, 20_000).unref()
    setInterval(run, 15 * 60_000).unref()
  }
  const serviceDeps = {
    ...proxyDeps,
    socialUrl: env.PIT_SOCIAL_URL === 'off' ? null : (env.PIT_SOCIAL_URL ?? 'http://127.0.0.1:8794'),
    boards: env.PIT_BBS === 'off' ? null : new Boards(env.PIT_BOARDS_DB ?? `${dataDir}/boards.db`, { max: Number(env.PIT_BBS_MAX ?? 100) }),
  }
  const dailyStitcher = createDailyStitcher({
    dbPath: env.STITCHER_DB ?? `${dataDir}/daily-stitcher.db`,
    ownerSub: env.STITCHER_OWNER_SUB ?? null,
    bridgeKey: env.PIT_BRIDGE_KEY ?? null,
  })
  const server = Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 8787),
    hostname: options.hostname ?? process.env.HOST ?? '127.0.0.1',
    // Proxied sites take uploads (family.ancestry photos) and can be slow to answer.
    idleTimeout: 120,
    maxRequestBodySize: 32 * 1024 * 1024,
    fetch(request, srv) {
      // Behind nginx on loopback the peer is always 127.0.0.1; nginx passes the visitor in X-Real-IP.
      const peer = srv.requestIP(request)?.address ?? ''
      const local = trustProxy && (peer === '127.0.0.1' || peer === '::1')
      const forwarded = local ? request.headers.get('x-real-ip') : null
      const proto = (local && request.headers.get('x-forwarded-proto')) || 'http'
      const host = String(request.headers.get('host') ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
      if (isAuctionHost(host)) {
        const url = new URL(request.url)
        url.protocol = 'https:'
        url.host = AUCTION_HOST
        if (proto !== 'https' || host !== AUCTION_HOST) return Response.redirect(url, 301)
        // threatcrush-disable-next-line js-ssrf-outbound-request  not an outbound request: Hono's in-process dispatch of the incoming auction house request
        return app.fetch(request, { ip: forwarded || peer })
      }
      if (host === DAILY_STITCHER_HOST) {
        if (proto !== 'https') {
          const url = new URL(request.url)
          url.protocol = 'https:'
          url.host = DAILY_STITCHER_HOST
          return Response.redirect(url, 301)
        }
        // threatcrush-disable-next-line js-ssrf-outbound-request  not an outbound request: Hono's in-process dispatch of the incoming storefront request
        return dailyStitcher.app.fetch(request)
      }
      // social.<name>.pit.world and bbs.<name>.pit.world are ours (src/services.ts), checked before the relay.
      const svc = serviceHost(request.headers.get('host'))
      if (svc) return serviceRequest(request, svc, forwarded || peer, proto, serviceDeps)
      // <name>.pit.world is a Moshpit name relayed to the old internet (src/proxy.ts), not pit.world itself.
      const name = proxiedName(request.headers.get('host'))
      if (name) return proxyRequest(request, name, forwarded || peer, (local && request.headers.get('x-forwarded-proto')) || 'http', proxyDeps)
      // threatcrush-disable-next-line js-ssrf-outbound-request  not an outbound request: Hono's in-process dispatch of the incoming request
      return app.fetch(request, { ip: forwarded || peer })
    },
  })
  return server
}

if (import.meta.main) {
  const server = serve()
  startRingFooterRefresh()
  console.log(`pit.world listening on http://${server.hostname}:${server.port}`)
}
