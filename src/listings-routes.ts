/** Routes for business listings: /b pages and /api/listing. Mounted by createApp when a Listings store is given. */
import type { Context, Hono } from 'hono'
import { claimPage, editPage, listingPage, listingsIndexPage, verifiedPage, verifyFailedPage } from './listings-html.js'
import { normalizeDomain, type ClaimStart, type ListingEdit, type Listings } from './listings.js'

type Env = { Bindings: { ip?: string } }

const EDIT_FIELDS = ['name', 'description', 'hours', 'address', 'phone', 'links', 'moshpit'] as const

function rebuild(listings: Listings, claimId: string): ClaimStart | null {
  const claim = listings.claimFor(claimId)
  if (!claim) return null
  const value = claim.token.slice('pit-verify='.length)
  return { claimId, token: claim.token, txtHost: `_pit-verify.${claim.domain}`, meta: `<meta name="pit-verify" content="${value}">` }
}

function edits(source: Record<string, unknown>): ListingEdit {
  const out: Record<string, unknown> = {}
  for (const key of EDIT_FIELDS) if (source[key] !== undefined) out[key] = source[key]
  if (typeof out.links === 'string') out.links = (out.links as string).split(/\s+/).filter(Boolean)
  return out as ListingEdit
}

export function mountListings(app: Hono<Env>, listings: Listings, limited: (c: Context<Env>) => boolean, isMoshpitName: (name: string) => boolean) {
  const tooMany = (c: Context<Env>) => {
    c.header('retry-after', '30')
    return c.json({ error: 'Too many requests. Try again shortly.' }, 429)
  }

  // --- pages ---------------------------------------------------------------------
  app.get('/b', (c) => {
    const domain = normalizeDomain(c.req.query('domain'))
    return domain ? c.redirect(`/b/${encodeURIComponent(domain)}`, 302) : c.html(listingsIndexPage())
  })

  app.get('/b/:domain', async (c) => {
    const listing = await listings.get(c.req.param('domain'))
    if (!listing) return c.notFound()
    if (listing.domain !== c.req.param('domain')) return c.redirect(`/b/${encodeURIComponent(listing.domain)}`, 301)
    return c.html(listingPage(listing))
  })

  app.post('/b/:domain/claim', (c) => {
    if (limited(c)) return c.text('Too many requests. Try again shortly.', 429, { 'retry-after': '30' })
    const start = listings.startClaim(c.req.param('domain'))
    return start ? c.redirect(`/b/${encodeURIComponent(normalizeDomain(c.req.param('domain'))!)}/claim/${start.claimId}`, 303) : c.notFound()
  })

  app.get('/b/:domain/claim/:id', (c) => {
    const start = rebuild(listings, c.req.param('id'))
    const domain = normalizeDomain(c.req.param('domain'))
    if (!domain) return c.notFound()
    if (!start) return c.html(verifyFailedPage(domain, null), 410)
    return c.html(claimPage(domain, start), 200, { 'cache-control': 'no-store' })
  })

  app.post('/b/:domain/verify', async (c) => {
    if (limited(c)) return c.text('Too many requests. Try again shortly.', 429, { 'retry-after': '30' })
    const domain = normalizeDomain(c.req.param('domain'))
    if (!domain) return c.notFound()
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
    const claimId = String(form.claim ?? '')
    const result = await listings.verify(claimId)
    if (result.ok) return c.html(verifiedPage(domain, result.editKey, result.method), 200, { 'cache-control': 'no-store' })
    return c.html(verifyFailedPage(domain, rebuild(listings, claimId)), result.reason === 'unknown-claim' ? 410 : 400)
  })

  app.get('/b/:domain/edit', async (c) => {
    const listing = await listings.get(c.req.param('domain'), { fetchMeta: false })
    return listing ? c.html(editPage(listing)) : c.notFound()
  })

  app.post('/b/:domain/edit', async (c) => {
    if (limited(c)) return c.text('Too many requests. Try again shortly.', 429, { 'retry-after': '30' })
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
    const saved = listings.edit(c.req.param('domain'), form.key, edits(form), isMoshpitName)
    if (saved) return c.html(editPage(saved, 'Saved.'))
    const listing = await listings.get(c.req.param('domain'), { fetchMeta: false })
    return listing ? c.html(editPage(listing, 'That edit key does not match this listing.'), 403) : c.notFound()
  })

  // --- API -----------------------------------------------------------------------
  app.get('/api/listing', async (c) => {
    const listing = await listings.get(c.req.query('domain'))
    return listing ? c.json(listing) : c.json({ error: 'domain must be a hostname like example.com' }, 400)
  })

  app.post('/api/listing/claim', async (c) => {
    if (limited(c)) return tooMany(c)
    const body = (await c.req.json().catch(() => ({}))) as { domain?: unknown }
    const start = listings.startClaim(body.domain)
    if (!start) return c.json({ error: 'domain must be a hostname like example.com' }, 400)
    const domain = normalizeDomain(body.domain)!
    return c.json({ domain, ...start, page: `https://pit.world/b/${domain}/claim/${start.claimId}` })
  })

  app.post('/api/listing/verify', async (c) => {
    if (limited(c)) return tooMany(c)
    const body = (await c.req.json().catch(() => ({}))) as { claim?: unknown }
    const result = await listings.verify(body.claim)
    return result.ok ? c.json(result) : c.json(result, result.reason === 'unknown-claim' ? 410 : 400)
  })

  app.post('/api/listing', async (c) => {
    if (limited(c)) return tooMany(c)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const key = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const saved = listings.edit(body.domain, key, edits(body), isMoshpitName)
    return saved ? c.json(saved) : c.json({ error: 'unauthorized: send the edit key as Authorization: Bearer <key>' }, 401)
  })
}
