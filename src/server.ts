/**
 * The pit.world web server: pages, the JSON API, OpenSearch.
 *
 * Nothing here writes a log line about a request. Errors are reported without
 * the query attached.
 */
import { FOOTER_SCRIPT_SRC, startRingFooterRefresh } from './ring-footer.js'
import { Hono, type Context } from 'hono'
import { parseBang, BANGS } from './bangs.js'
import { aboutPage, buildPage, startPage, connectPage, errorPage, homePage, mediaPage, mobileConfig, newsletterPage, offlinePage, subscribersAdminPage, openSearchXml, privacyPage, resultsPage, ringOpml, ringPage } from './html.js'
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
import { mountListings } from './listings-routes.js'
import { liveVerifier, Listings } from './listings.js'
import { readFileSync } from 'node:fs'
import { Accounts, serviceHost } from './accounts.js'
import { COOKIE_PATHS, mountAccounts, parseCookies, type AccountDeps } from './accounts-routes.js'
import { SESSION_COOKIE } from './accounts.js'
import { createCrawlGate, type CrawlGate } from './crawl-gate.js'
import { Promotion } from './promotion.js'
import { mountPromotion } from './promotion-routes.js'
import { Promoters } from './promoters.js'
import { mountPromote } from './promoters-routes.js'
import { Rewards } from './rewards.js'
import { mountRewards, rewardsOnSignIn, rewardsSections } from './rewards-routes.js'
import { Boards, serviceRequest } from './services.js'
import { Cache, normalizeQuery, search, SearchUnavailable, type Keys, type SearchResult } from './search.js'
import { parseVertical, searchMedia, thumbAllowed, type MediaResult, type Vertical } from './verticals.js'

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
  buildInvoicing?: BuildInvoicing
  /** Credit codes (server months) and invites on accounts (needs accounts); unset means off. */
  rewards?: Rewards
  /** Addresses whose visits are ours, excluded from promotion measurement. */
  internalIps?: string[]
  /** The x402 crawl gateway (src/crawl-gate.ts); unset means training crawlers read free. */
  crawlGate?: CrawlGate | null
}

/** The visitor's address arrives as a binding from serve() (or a test), never from a header the visitor controls. */
type Env = { Bindings: { ip?: string } }

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    `default-src 'none'; script-src 'self' https://crawlproof.com ${FOOTER_SCRIPT_SRC}; style-src 'self'; img-src 'self' data: https://built.indie.pit.world https://pwamart.com; connect-src 'self' https://pit.world https://crawlproof.com; frame-src https://crawlproof.com; manifest-src 'self'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'`,
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
  const app = new Hono<Env>()

  // Training crawlers buy a day pass before anything else, and ahead of the header
  // middleware below, which would strip the pass and checkout cookies it sets.
  const crawlGate = deps.crawlGate
  if (crawlGate) {
    app.use('*', async (c, next) => {
      const sold = await crawlGate.handle(c.req.raw)
      if (sold) return sold
      await next()
    })
  }

  app.use('*', async (c, next) => {
    await next()
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value)
    // Belt and braces: only the sign-in and account routes set a cookie, and only after you press Sign in.
    if (!deps.accounts || !COOKIE_PATHS.test(c.req.path)) c.res.headers.delete('set-cookie')
  })

  const limited = (c: Context<Env>) => !limiter.take(c.env?.ip || 'unknown')

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
      const result = await search(query, deps.keys, { cache, limit, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
      logFailures(result.failures)
      return { result, error: null }
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
  app.get('/', async (c) => c.html(homePage(await registry.stats(), { newsletter: newsletter?.enabled ?? false })))

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
    if (limited(c)) return c.html(newsletterPage('limited', from), 429, { 'retry-after': '30' })
    // The honeypot: a field people never see. A bot that fills it gets the normal answer and nothing else.
    if (typeof form.website === 'string' && form.website !== '') return c.html(newsletterPage('check', from))
    const result = await newsletter.signup(form.email, from.source)
    const page = result === 'sent' || result === 'already' ? 'check' : result
    return c.html(newsletterPage(page, from), page === 'check' ? 200 : page === 'failed' ? 503 : 400)
  })
  // JSON for scripts and other sites' pages (CORS: any origin may post an address; nothing is read back).
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }
  app.options('/api/subscribe', (c) => c.body(null, 204, cors))
  app.post('/api/subscribe', async (c) => {
    for (const [k, v] of Object.entries(cors)) c.header(k, v)
    if (!newsletter?.enabled) return c.json({ error: 'The newsletter is not open on this instance.' }, 404)
    if (limited(c)) {
      c.header('retry-after', '30')
      return c.json({ error: 'Too many requests. Try again shortly.' }, 429)
    }
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; site?: unknown }
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
    if (!orderLimit.take(c.env?.ip || 'unknown')) return again('Too many orders from you just now. Try again in a few minutes.', 429)
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
    // pit.world and Moshpit sites get the pit.world footer, every other site the clearnet one.
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
  app.get('/robots.txt', (c) =>
    c.body('User-agent: *\nDisallow: /search\nDisallow: /api/\nAllow: /\nSitemap: https://pit.world/sitemap.xml\n', 200, { 'content-type': 'text/plain; charset=utf-8' }),
  )
  app.get('/sitemap.xml', (c) =>
    c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/connect', '/start', '/build', ...(deps.promoters ? ['/promote'] : []), '/ring', '/pros', '/b', '/about', '/privacy', ...(deps.listings ? deps.listings.directoryDomains().map((d) => `/b/${encodeURIComponent(d)}`) : [])]
        .map((p) => `<url><loc>https://pit.world${p}</loc></url>`)
        .join('')}</urlset>`,
      200,
      { 'content-type': 'application/xml; charset=utf-8' },
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
    if (vertical !== 'web') {
      const [{ result, error }, promos] = await Promise.all([runMedia(vertical, query), promoted.for(query, vertical)])
      const mediaFeatured = featuredFor(query)
      const mediaBackfill = mediaFeatured.length ? undefined : backfillFor(query)
      return c.html(mediaPage({ query, vertical, result, promos, error, featured: mediaFeatured, ...(mediaBackfill ? { backfill: mediaBackfill } : {}) }), result || promos.length ? 200 : 503)
    }
    const [{ result, error }, resolution] = await Promise.all([runSearch(query), looksLikeName(query) ? registry.resolve(query) : Promise.resolve(null)])
    const claimed = deps.listings?.claimedOnly(query)
    const featured = featuredFor(query)
    const backfill = featured.length ? undefined : backfillFor(query)
    return c.html(resultsPage({ query, result, resolution, error, featured, ...(backfill ? { backfill } : {}), ...(claimed ? { card: listingCard(claimed) } : {}) }), result || resolution || claimed || featured.length ? 200 : 503)
  })

  // --- JSON API ---------------------------------------------------------------
  app.use('/api/*', async (c, next) => {
    await next()
    c.header('access-control-allow-origin', '*')
    c.header('cache-control', 'no-store')
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
      return c.json({ query, type: vertical, provider: result.provider, featured, results: result.hits, promoted: promos })
    }
    const [{ result, error }, resolution] = await Promise.all([runSearch(query, n), looksLikeName(query) ? registry.resolve(query) : Promise.resolve(null)])
    if (!result) return c.json({ query, error, featured, moshpit: resolution }, 503)
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

  // Thumbnails for the Images/Videos/Live tabs, fetched by us so the visitor's
  // browser never talks to Google or YouTube. Only the hosts in thumbAllowed().
  app.get('/img', async (c) => {
    const url = thumbAllowed(c.req.query('u') ?? '')
    if (!url) return c.body(null, 400)
    try {
      // threatcrush-disable-next-line js-ssrf-outbound-request  fixed allowlist of public thumbnail hosts (thumbAllowed), https only
      const upstream = await (deps.fetch ?? fetch)(url.href, { redirect: 'error', signal: AbortSignal.timeout(6_000) })
      const type = upstream.headers.get('content-type') ?? ''
      if (!upstream.ok || !/^image\/(jpeg|png|gif|webp|avif)/.test(type)) return c.body(null, 502)
      const body = await upstream.arrayBuffer()
      if (body.byteLength > 2_000_000) return c.body(null, 502)
      return c.body(body, 200, { 'content-type': type, 'cache-control': 'public, max-age=86400' })
    } catch {
      return c.body(null, 502)
    }
  })

  // --- static -------------------------------------------------------------------
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
    mountAccounts(app, rewards ? { ...deps.accounts, onSignIn: deps.accounts.onSignIn ?? rewardsOnSignIn(rewards), accountSections: deps.accounts.accountSections ?? rewardsSections(rewards) } : deps.accounts)
    if (rewards) mountRewards(app, { rewards, accounts: deps.accounts.accounts, site: deps.accounts.site })
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
  if (deps.listings) mountListings(app, deps.listings, limited, looksLikeName, { ringChanged: () => deps.ringSync?.soon(ringSites), ...(promoHooks ?? {}) })

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
    perplexity: env.PERPLEXITY_API_KEY,
  }
}

export function serve(options: { port?: number; hostname?: string } = {}) {
  const env = process.env
  const dataDir = env.PIT_DATA_DIR ?? `${env.HOME ?? '.'}/.local/share/pit-world`
  const newsletter = new Newsletter(env.PIT_NEWSLETTER_DB ?? `${dataDir}/newsletter.db`, env.RESEND_API_KEY ? resendMailer(env.RESEND_API_KEY) : null)
  const registry = new Registry()
  const rootPem = readFileSync(new URL('../public/moshpit-root-ca.crt', import.meta.url), 'utf8')
  const mailer = env.RESEND_API_KEY ? resendMailer(env.RESEND_API_KEY) : null
  const listings = new Listings(env.PIT_LISTINGS_DB ?? `${dataDir}/listings.db`, liveVerifier(fetch, { resolve: (name) => registry.resolve(name), rootPem }), undefined, { mailer })
  const ringSync = env.RSSAMPLIFIER_API_KEY
    ? new RingSync({ apiKey: env.RSSAMPLIFIER_API_KEY, ...(env.RSSAMPLIFIER_URL ? { base: env.RSSAMPLIFIER_URL } : {}), ...(env.RSSAMPLIFIER_RING ? { slug: env.RSSAMPLIFIER_RING } : {}) })
    : undefined
  const site = env.PIT_SITE ?? 'https://pit.world'
  const accounts: AccountDeps = {
    accounts: new Accounts(env.PIT_ACCOUNTS_DB ?? `${dataDir}/accounts.db`),
    site,
    coinpay: env.PIT_COINPAY_CLIENT_ID && env.PIT_COINPAY_CLIENT_SECRET ? { clientId: env.PIT_COINPAY_CLIENT_ID, clientSecret: env.PIT_COINPAY_CLIENT_SECRET } : null,
    bridgeKey: env.PIT_BRIDGE_KEY ?? null,
    extraClients: (env.PIT_BRIDGE_CLIENTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    admins: (env.PIT_ADMIN_SUBS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  }
  const promotion = new Promotion(listings, site)
  const promoters = new Promoters(env.PIT_PROMOTERS_DB ?? `${dataDir}/promoters.db`)
  const internalIps = (env.PIT_INTERNAL_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const buildInvoicing: BuildInvoicing | undefined = env.PIT_PAYAGENT_KEY
    ? { payAgentUrl: env.PIT_PAYAGENT_URL ?? 'https://pay.agent.pit.world', key: env.PIT_PAYAGENT_KEY, mailer, notifyTo: env.PIT_BUILD_NOTIFY ?? 'ettinger@gmail.com' }
    : undefined
  const rewards = new Rewards(accounts.accounts.db, { mailer, notifyTo: env.PIT_BUILD_NOTIFY ?? 'ettinger@gmail.com', promoterCode: (code) => Boolean(promoters.byCode(code)) })
  const app = createApp({ keys: keysFromEnv(), crawlGate: createCrawlGate(), newsletter, listings, accounts, promotion, promoters, rewards, internalIps, ...(buildInvoicing ? { buildInvoicing } : {}), ...(ringSync ? { ringSync } : {}), ...(env.PIT_ADMIN_TOKEN ? { adminToken: env.PIT_ADMIN_TOKEN } : {}) })
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
  const trustProxy = (process.env.PIT_TRUST_PROXY ?? '1') === '1'
  // Last good target per name, on disk: the relay keeps serving names while the registry is down.
  const proxyDeps = { access: { resolve: (name: string) => registry.resolve(name), rootPem }, certs: liveCerts(), targets: new Targets(`${dataDir}/relay-targets.json`) }
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
