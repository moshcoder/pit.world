/**
 * Routes for promotion campaigns.
 *
 * Public: /roundup/<slug>, /b/<domain>/go (the website link, counted once, then a redirect to the
 * listing's own site and nowhere else), POST /b/<domain>/e (the phone-tap beacon) and /r/<token> (a
 * business's shared report, also .md and .json).
 *
 * Operator: /api/v1/promotion/* with Authorization: Bearer $PIT_ADMIN_TOKEN, and /admin/promo/* for a
 * signed-in pit.world admin. The CLI, the TUI and the MCP tools call the same API.
 */
import type { Context, Hono } from 'hono'
import { normalizeDomain, type Listings } from './listings.js'
import { isPerson } from './listings-routes.js'
import { adminAuthorized } from './newsletter.js'
import { adminMemberPage, adminPage, reportMarkdown, reportPage, roundupPage, sharedReport } from './promotion-html.js'
import { PromoError, type Promotion } from './promotion.js'
import { RateLimiter } from './ratelimit.js'

type Env = { Bindings: { ip?: string } }

export type PromotionDeps = {
  promo: Promotion
  listings: Listings
  /** Bearer token for the API; unset means the API answers 401. */
  adminToken?: string
  /** A signed-in pit.world admin (for the web dashboard). */
  isAdmin?: (c: Context<Env>) => boolean
  /** Addresses whose traffic is ours (PIT_INTERNAL_IPS): recorded as excluded. */
  internalIps?: string[]
}

/** Why an event does not count, if it does not: the request itself is never stored. */
export function exclusionOf(c: Context<Env>, internal: string[]): string {
  const ua = c.req.header('user-agent')
  if (!isPerson(ua)) return 'bot'
  const purpose = `${c.req.header('sec-purpose') ?? ''} ${c.req.header('purpose') ?? ''} ${c.req.header('x-moz') ?? ''}`.toLowerCase()
  if (purpose.includes('prefetch') || purpose.includes('prerender')) return 'prefetch'
  if (c.env?.ip && internal.includes(c.env.ip)) return 'internal'
  return ''
}

const isTest = (c: Context<Env>) => c.req.query('pt') === 'test' || c.req.header('x-pit-test') === '1'

export function mountPromotion(app: Hono<Env>, d: PromotionDeps) {
  const { promo, listings } = d
  const internal = d.internalIps ?? []
  const beaconLimiter = new RateLimiter(30, 0.5)

  /** Record an event for this request, if the business is in a campaign. Never throws: measurement must not break a page. */
  const track = (c: Context<Env>, type: Parameters<Promotion['record']>[0]['type'], domain: string | null, extra: { campaignId?: string; id?: string; via?: string | null } = {}) => {
    try {
      promo.record({
        type,
        domain,
        via: extra.via ?? c.req.query('via') ?? null,
        referer: c.req.header('referer') ?? null,
        ip: c.env?.ip ?? '',
        userAgent: c.req.header('user-agent') ?? '',
        test: isTest(c),
        excluded: exclusionOf(c, internal),
        ...(extra.campaignId ? { campaignId: extra.campaignId } : {}),
        ...(extra.id ? { id: extra.id } : {}),
      })
    } catch {}
  }

  // --- public ---------------------------------------------------------------------------
  app.get('/roundup/:slug', (c) => {
    const r = promo.roundup(c.req.param('slug'))
    if (!r) return c.notFound()
    if (c.req.method === 'GET') track(c, 'roundup_view', null, { campaignId: r.campaign.id })
    return c.html(roundupPage({ title: r.campaign.config.title, intro: r.campaign.config.intro, slug: r.campaign.config.slug, placementId: r.placementId, listings: r.listings, updatedAt: r.campaign.launchedAt }))
  })

  // Taps on the phone link, from public/listing.js. Only this event type; the client's id deduplicates retries.
  app.post('/b/:domain/e', async (c) => {
    if (!beaconLimiter.take(c.env?.ip || 'unknown')) return c.body(null, 204)
    const listing = listings.toPublic(c.req.param('domain'))
    const body = (await c.req.json().catch(() => ({}))) as { type?: unknown; id?: unknown; via?: unknown }
    if (listing && body.type === 'phone_click') track(c, 'phone_click', listing.domain, { id: typeof body.id === 'string' ? body.id : undefined, via: typeof body.via === 'string' ? body.via : null })
    return c.body(null, 204)
  })

  app.get('/r/:token', (c) => {
    const raw = c.req.param('token')
    const [token, ext] = raw.includes('.') ? [raw.slice(0, raw.lastIndexOf('.')), raw.slice(raw.lastIndexOf('.') + 1)] : [raw, 'html']
    const report = promo.reportByToken(token!)
    if (!report) return c.notFound()
    c.header('cache-control', 'no-store')
    c.header('x-robots-tag', 'noindex')
    if (ext === 'json') return c.json({ version: report.version, superseded: report.superseded, ...sharedReport(report.data) })
    if (ext === 'md') return c.body(reportMarkdown(report.data, report.version, true), 200, { 'content-type': 'text/markdown; charset=utf-8' })
    return c.html(reportPage(report.data, report.version, true))
  })

  // --- API ------------------------------------------------------------------------------
  const authed = (c: Context<Env>) => {
    if (adminAuthorized(c.req.header('authorization'), d.adminToken)) return true
    return d.isAdmin?.(c) ?? false
  }
  const api = (handler: (c: Context<Env>) => unknown | Promise<unknown>) => async (c: Context<Env>) => {
    if (!authed(c)) return c.json({ error: 'unauthorized: Authorization: Bearer <PIT_ADMIN_TOKEN>' }, 401)
    try {
      const out = await handler(c)
      return out instanceof Response ? out : c.json(out as object)
    } catch (error) {
      if (error instanceof PromoError) return c.json({ error: error.message, code: error.code }, error.status)
      throw error
    }
  }
  const body = async (c: Context<Env>) => ((await c.req.json().catch(() => ({}))) as Record<string, any>)
  const actor = (c: Context<Env>) => (c.req.header('x-pit-actor') ?? 'api').slice(0, 60)
  const page = (c: Context<Env>) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100) || 100))
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)
    return { limit, offset }
  }
  /** `<campaign id>:<domain>`, the id of a campaign business. */
  const member = (c: Context<Env>) => {
    const raw = c.req.param('id') ?? ''
    const at = raw.indexOf(':')
    if (at < 0) throw new PromoError(400, 'bad_id', 'a campaign business id is <campaign id>:<domain>')
    return { campaignId: raw.slice(0, at), domain: normalizeDomain(raw.slice(at + 1)) ?? '' }
  }
  const V = '/api/v1/promotion'

  app.get(`${V}/campaigns`, api(() => ({ campaigns: promo.campaigns().map((x) => ({ id: x.id, name: x.name, state: x.state, source: `${x.source}:${x.sourceRef}`, slug: x.config.slug })) })))
  app.post(`${V}/campaigns`, api(async (c) => {
    const b = await body(c)
    return { id: promo.createCampaign({ name: String(b.name ?? ''), source: String(b.source ?? 'outreachgraph'), sourceRef: String(b.sourceRef ?? ''), config: b.config ?? {} }, actor(c)) }
  }))
  app.get(`${V}/campaigns/:id`, api((c) => promo.overview(c.req.param('id')!)))
  app.patch(`${V}/campaigns/:id`, api(async (c) => ({ config: promo.configure(c.req.param('id')!, (await body(c)).config ?? {}, actor(c)) })))
  app.post(`${V}/campaigns/:id/imports`, api(async (c) => {
    const b = await body(c)
    const dryRun = c.req.query('dryRun') === '1' || b.dryRun === true
    const snapshot = b.snapshot ?? b
    if (dryRun) return promo.import(c.req.param('id')!, snapshot, { dryRun: true })
    const job = promo.job('import', `import:${c.req.header('idempotency-key') ?? crypto.randomUUID()}`, c.req.param('id')!)
    const result = promo.idempotent(c.req.header('idempotency-key'), `import:${c.req.param('id')}`, () => promo.import(c.req.param('id')!, snapshot, { actor: actor(c) }))
    promo.db.run("UPDATE promo_jobs SET state = 'done', result = ?, updated_at = ? WHERE id = ?", [JSON.stringify(result), Date.now(), job.id])
    return { jobId: job.id, status: 'done', ...result }
  }))
  app.get(`${V}/campaigns/:id/imports`, api((c) => ({ imports: promo.imports(c.req.param('id')!) })))
  app.get(`${V}/imports/:id/rows`, api((c) => ({ rows: promo.importRows(c.req.param('id')!) })))
  app.get(`${V}/campaigns/:id/businesses`, api((c) => promo.roster(c.req.param('id')!, page(c))))
  app.post(`${V}/campaigns/:id/exclusions`, api(async (c) => {
    const b = await body(c)
    promo.exclude(c.req.param('id')!, String(b.subject ?? ''), String(b.reason ?? ''), actor(c))
    return { ok: true }
  }))
  app.post(`${V}/campaigns/:id/reverify`, api((c) => promo.reverify(c.req.param('id')!, actor(c))))
  app.get(`${V}/campaign-businesses/:id`, api((c) => {
    const m = member(c)
    return promo.member(m.campaignId, m.domain)
  }))
  app.patch(`${V}/campaign-businesses/:id`, api(async (c) => {
    const m = member(c)
    return promo.updateMember(m.campaignId, m.domain, await body(c), actor(c))
  }))
  app.get(`${V}/campaign-businesses/:id/results`, api((c) => {
    const m = member(c)
    return promo.results(m.campaignId, m.domain)
  }))
  app.post(`${V}/campaign-businesses/:id/restart`, api(async (c) => {
    const m = member(c)
    return { periodId: promo.restartPeriod(m.campaignId, m.domain, String((await body(c)).reason ?? ''), actor(c)) }
  }))
  app.post(`${V}/campaigns/:id/preview`, api((c) => promo.preview(c.req.param('id')!)))
  app.post(`${V}/campaigns/:id/launch`, api(async (c) => {
    const b = await body(c)
    if (!c.req.header('idempotency-key')) throw new PromoError(400, 'idempotency_key', 'launch needs an Idempotency-Key header')
    return promo.idempotent(c.req.header('idempotency-key'), `launch:${c.req.param('id')}`, () => promo.launch(c.req.param('id')!, String(b.version ?? ''), actor(c)))
  }))
  app.post(`${V}/campaigns/:id/pause`, api(async (c) => {
    const state = String((await body(c)).state ?? 'paused')
    if (!['paused', 'active', 'stopped'].includes(state)) throw new PromoError(400, 'bad_state', 'state is paused, active or stopped')
    return { state: promo.setState(c.req.param('id')!, state as 'paused', actor(c)) }
  }))
  app.get(`${V}/campaigns/:id/placements`, api((c) => promo.placements(c.req.param('id')!, { ...page(c), ...(c.req.query('state') ? { state: c.req.query('state')! } : {}), ...(c.req.query('domain') ? { domain: c.req.query('domain')! } : {}) })))
  app.get(`${V}/placements/:id`, api((c) => promo.placement(c.req.param('id')!)))
  app.post(`${V}/campaigns/:id/lease`, api(async (c) => {
    const b = await body(c)
    return promo.lease(c.req.param('id')!, String(b.owner ?? 'worker').slice(0, 60), Math.min(50, Number(b.max ?? 20) || 20))
  }))
  app.post(`${V}/placements/:id/report`, api(async (c) => promo.report(c.req.param('id')!, (await body(c)) as any, actor(c))))
  app.post(`${V}/placements/:id/retry`, api((c) => promo.retry(c.req.param('id')!, actor(c))))
  app.post(`${V}/campaigns/:id/tracking-check`, api(async (c) => promo.checkTracking(c.req.param('id')!, (await body(c)).domains, actor(c))))
  app.post(`${V}/campaigns/:id/gaps`, api(async (c) => ({ id: promo.recordGap(c.req.param('id')!, (await body(c)) as any, actor(c)) })))
  app.get(`${V}/campaigns/:id/periods`, api((c) => ({ periods: promo.periods(c.req.param('id')!) })))
  app.post(`${V}/campaigns/:id/reports`, api((c) => {
    promo.tick()
    return promo.generateDue(c.req.param('id')!)
  }))
  app.get(`${V}/campaigns/:id/reports`, api((c) => ({ reports: promo.reports(c.req.param('id')!).map((r) => ({ id: r.id, domain: r.domain, version: r.version, superseded: r.superseded, shareUrl: r.shareUrl })) })))
  app.get(`${V}/campaigns/:id/reports.csv`, api((c) => c.body(promo.comparisonCsv(c.req.param('id')!), 200, { 'content-type': 'text/csv; charset=utf-8' })))
  app.get(`${V}/reports/:id`, api((c) => {
    const raw = c.req.param('id')!
    const [rid, ext] = raw.includes('.') ? [raw.slice(0, raw.lastIndexOf('.')), raw.slice(raw.lastIndexOf('.') + 1)] : [raw, 'json']
    const r = promo.reportById(rid!)
    if (ext === 'md') return c.body(reportMarkdown(r.data, r.version, false), 200, { 'content-type': 'text/markdown; charset=utf-8' })
    if (ext === 'html') return c.html(reportPage(r.data, r.version, false))
    return r
  }))
  app.post(`${V}/reports/:id/outreach-draft`, api((c) => promo.createDraft(c.req.param('id')!)))
  app.get(`${V}/campaigns/:id/drafts`, api((c) => ({ drafts: promo.drafts(c.req.param('id')!) })))
  app.post(`${V}/drafts/:id/deliver`, api((c) => promo.deliver(c.req.param('id')!, actor(c))))
  app.post(`${V}/tick`, api(() => promo.tick()))
  app.get(`${V}/jobs/:id`, api((c) => promo.jobStatus(c.req.param('id')!)))
  app.get(`${V}/campaigns/:id/audit`, api((c) => ({ audit: promo.auditLog(c.req.param('id')!, page(c).limit) })))

  // --- web dashboard -------------------------------------------------------------------------
  /** Forms post only from our own pages: the browser says so, or the Origin is ours. */
  const sameOrigin = (c: Context<Env>) => {
    const site = c.req.header('sec-fetch-site')
    if (site) return site === 'same-origin'
    const origin = c.req.header('origin')
    return Boolean(origin) && origin === new URL(promo.site).origin
  }
  const guard = (c: Context<Env>) => (d.isAdmin?.(c) ? null : c.html('<!doctype html><title>Sign in</title><p>Sign in as a pit.world admin: <a href="/signin?next=/admin/promo">sign in</a>.</p>', 401))
  app.get('/admin/promo', (c) => {
    const denied = guard(c)
    if (denied) return denied
    const list = promo.campaigns()
    if (list.length === 1) return c.redirect(`/admin/promo/${encodeURIComponent(list[0]!.id)}`, 302)
    return c.html(`<!doctype html><meta charset="utf-8"><title>Promotion campaigns</title><link rel="stylesheet" href="/style.css"><main class="prose"><h1>Promotion campaigns</h1><ul>${list.map((x) => `<li><a href="/admin/promo/${encodeURIComponent(x.id)}">${x.name.replace(/[<&]/g, '')}</a> (${x.state})</li>`).join('')}</ul></main>`)
  })
  app.get('/admin/promo/:id', (c) => guard(c) ?? c.html(adminPage(promo, c.req.param('id'))))
  app.get('/admin/promo/:id/b/:domain', (c) => guard(c) ?? c.html(adminMemberPage(promo, c.req.param('id'), normalizeDomain(c.req.param('domain')) ?? '')))
  const post = (path: string, run: (c: Context<Env>) => string) =>
    app.post(path, (c) => {
      const denied = guard(c)
      if (denied) return denied
      if (!sameOrigin(c)) return c.text('Forms post only from pit.world pages.', 403)
      try {
        return c.html(adminPage(promo, c.req.param('id')!, run(c)))
      } catch (error) {
        return c.html(adminPage(promo, c.req.param('id')!, error instanceof Error ? error.message : String(error)), 400)
      }
    })
  post('/admin/promo/:id/pause', (c) => `Campaign ${promo.setState(c.req.param('id')!, 'paused', 'web')}.`)
  post('/admin/promo/:id/resume', (c) => `Campaign ${promo.setState(c.req.param('id')!, 'active', 'web')}.`)
  post('/admin/promo/:id/tick', () => {
    const t = promo.tick()
    return `Hourly pass: ${t.started} windows started, ${t.due} due, ${t.reviewed} reviewed.`
  })
  post('/admin/promo/:id/reports', (c) => `${promo.generateDue(c.req.param('id')!).reports.length} reports current.`)
  post('/admin/promo/:id/placements/:pid/retry', (c) => `Placement ${promo.retry(c.req.param('pid')!, 'web').state}.`)

  // What the listing routes call: a page view and a sent quote request.
  return {
    viewed: (c: Context<Env>, domain: string) => track(c, 'listing_view', domain),
    clicked: (c: Context<Env>, domain: string) => track(c, 'website_click', domain),
    quoted: (c: Context<Env>, domain: string) => track(c, 'inquiry_sent', domain, { via: null }),
  }
}
