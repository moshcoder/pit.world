/**
 * The pit.world web server: pages, the JSON API, OpenSearch.
 *
 * Nothing here writes a log line about a request. Errors are reported without
 * the query attached.
 */
import { Hono, type Context } from 'hono'
import { parseBang, BANGS } from './bangs.js'
import { aboutPage, connectPage, homePage, mobileConfig, newsletterPage, offlinePage, openSearchXml, privacyPage, resultsPage } from './html.js'
import { adminAuthorized, Newsletter, resendMailer } from './newsletter.js'
import { looksLikeName, Registry } from './moshpit.js'
import { RateLimiter } from './ratelimit.js'
import { Cache, normalizeQuery, search, SearchUnavailable, type Keys, type SearchResult } from './search.js'

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
}

/** The visitor's address arrives as a binding from serve() (or a test), never from a header the visitor controls. */
type Env = { Bindings: { ip?: string } }

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
  const app = new Hono<Env>()

  app.use('*', async (c, next) => {
    await next()
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value)
    // Belt and braces: nothing on pit.world sets a cookie, and nothing ever will by accident.
    c.res.headers.delete('set-cookie')
  })

  const limited = (c: Context<Env>) => !limiter.take(c.env?.ip || 'unknown')

  async function runSearch(query: string, limit = 10): Promise<{ result: SearchResult | null; error: string | null }> {
    try {
      return { result: await search(query, deps.keys, { cache, limit, ...(deps.fetch ? { fetch: deps.fetch } : {}) }), error: null }
    } catch (error) {
      // No query in the message, and nothing logged.
      return { result: null, error: error instanceof SearchUnavailable ? 'Web results are unavailable for a moment. Try again shortly, or use a bang like !ddg.' : 'Something went wrong fetching results.' }
    }
  }

  const newsletter = deps.newsletter
  app.get('/', async (c) => c.html(homePage(await registry.stats(), { newsletter: newsletter?.enabled ?? false })))

  // --- newsletter (double opt-in) ------------------------------------------------
  app.post('/subscribe', async (c) => {
    if (!newsletter?.enabled) return c.notFound()
    if (limited(c)) return c.html(newsletterPage('limited'), 429, { 'retry-after': '30' })
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
    // The honeypot: a field people never see. A bot that fills it gets the normal answer and nothing else.
    if (typeof form.website === 'string' && form.website !== '') return c.html(newsletterPage('check'))
    const result = await newsletter.signup(form.email)
    const page = result === 'sent' || result === 'already' ? 'check' : result
    return c.html(newsletterPage(page), page === 'check' ? 200 : page === 'failed' ? 503 : 400)
  })
  app.post('/api/subscribe', async (c) => {
    if (!newsletter?.enabled) return c.json({ error: 'The newsletter is not open on this instance.' }, 404)
    if (limited(c)) {
      c.header('retry-after', '30')
      return c.json({ error: 'Too many requests. Try again shortly.' }, 429)
    }
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown }
    const result = await newsletter.signup(body.email)
    if (result === 'sent' || result === 'already') return c.json({ ok: true, status: 'check-inbox' })
    const status = { invalid: 400, undeliverable: 400, failed: 503 }[result]
    return c.json({ ok: false, status: result }, status as 400 | 503)
  })
  app.get('/confirm', (c) => {
    if (!newsletter) return c.notFound()
    return newsletter.confirm(c.req.query('t')) ? c.html(newsletterPage('confirmed')) : c.html(newsletterPage('expired'), 410)
  })
  app.get('/api/admin/subscribers.csv', (c) => {
    if (!newsletter || !adminAuthorized(c.req.header('authorization'), deps.adminToken)) return c.json({ error: 'unauthorized' }, 401)
    return c.body(newsletter.csv(), 200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' })
  })
  app.get('/privacy', (c) => c.html(privacyPage()))
  app.get('/about', (c) => c.html(aboutPage()))
  app.get('/connect', (c) => c.html(connectPage()))
  app.get('/offline', (c) => c.html(offlinePage()))
  app.get('/health', (c) => c.json({ ok: true, providers: Object.keys(deps.keys).filter((k) => deps.keys[k as keyof Keys]) }))
  app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /search\nDisallow: /api/\nAllow: /\nSitemap: https://pit.world/sitemap.xml\n'))
  app.get('/sitemap.xml', (c) =>
    c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/connect', '/about', '/privacy']
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
    if (limited(c)) {
      c.header('retry-after', '30')
      return c.html(resultsPage({ query, result: null, resolution: null, error: 'Too many searches from your connection just now. Give it half a minute.' }), 429)
    }
    const [{ result, error }, resolution] = await Promise.all([runSearch(query), looksLikeName(query) ? registry.resolve(query) : Promise.resolve(null)])
    c.header('cache-control', 'no-store')
    return c.html(resultsPage({ query, result, resolution, error }), result || resolution ? 200 : 503)
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
    const n = Number(c.req.query('n') ?? 10)
    const [{ result, error }, resolution] = await Promise.all([runSearch(query, Number.isFinite(n) ? n : 10), looksLikeName(query) ? registry.resolve(query) : Promise.resolve(null)])
    if (!result) return c.json({ query, error, moshpit: resolution }, 503)
    return c.json({ query: result.query, provider: result.provider, cached: result.cached, results: result.hits, moshpit: resolution })
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

  app.notFound((c) => c.html(homePage(null).replace('<p class="tag">', '<p class="tag">That page does not exist. '), 404))
  return app
}

/** Provider keys from the environment (the deploy writes them from the vault). */
export function keysFromEnv(env: Record<string, string | undefined> = process.env): Keys {
  return {
    serper: env.SERPER_API_KEY,
    bing: env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD ? `${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}` : undefined,
    linkup: env.LINKUP_API_KEY,
    exa: env.EXA_API_KEY,
    perplexity: env.PERPLEXITY_API_KEY,
  }
}

export function serve(options: { port?: number; hostname?: string } = {}) {
  const env = process.env
  const dataDir = env.PIT_DATA_DIR ?? `${env.HOME ?? '.'}/.local/share/pit-world`
  const newsletter = new Newsletter(env.PIT_NEWSLETTER_DB ?? `${dataDir}/newsletter.db`, env.RESEND_API_KEY ? resendMailer(env.RESEND_API_KEY) : null)
  const app = createApp({ keys: keysFromEnv(), newsletter, ...(env.PIT_ADMIN_TOKEN ? { adminToken: env.PIT_ADMIN_TOKEN } : {}) })
  const trustProxy = (process.env.PIT_TRUST_PROXY ?? '1') === '1'
  const server = Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 8787),
    hostname: options.hostname ?? process.env.HOST ?? '127.0.0.1',
    fetch(request, srv) {
      // Behind nginx on loopback the peer is always 127.0.0.1; nginx passes the visitor in X-Real-IP.
      const peer = srv.requestIP(request)?.address ?? ''
      const forwarded = trustProxy && (peer === '127.0.0.1' || peer === '::1') ? request.headers.get('x-real-ip') : null
      return app.fetch(request, { ip: forwarded || peer })
    },
  })
  return server
}

if (import.meta.main) {
  const server = serve()
  console.log(`pit.world listening on http://${server.hostname}:${server.port}`)
}
