/** Routes for business listings (/b, /pros, /api/listing, /api/pros). Mounted by createApp when a Listings store is given. */
import type { Context, Hono } from 'hono'
import {
  claimPage, contactConfirmedPage, hasOpenProfile, editPage, listingPage, listingsFeed, listingsIndexPage, prosPage, siteUrl, verifiedPage, verifyFailedPage, type QuoteState,
} from './listings-html.js'
import { EDIT_FIELDS, normalizeDomain, type ClaimStart, type ContactResult, type ListingEdit, type Listings } from './listings.js'
import { CATEGORIES, categoryOf, PRICES } from './pros.js'
import { listingOpenProfile, openProfilePath, openProfileUrl } from './listing-openprofile.js'
import { RateLimiter } from './ratelimit.js'

type Env = { Bindings: { ip?: string } }

export type ListingHooks = {
  /** Something about ring membership may have changed (a claim, an edit). */
  ringChanged?: () => void
  /** A listing page was served (promotion measurement; src/promotion-routes.ts decides what counts). */
  viewed?: (c: Context<Env>, domain: string) => void
  /** A quote request went to the owner. */
  quoted?: (c: Context<Env>, domain: string) => void
  /** Someone followed a listing's website link. */
  clicked?: (c: Context<Env>, domain: string) => void
}

/** A campaign's tracking id (?via=plc_...) carried from the page to its website link and phone beacon. */
const viaOf = (c: Context<Env>) => {
  const via = c.req.query('via') ?? ''
  return /^plc_[A-Za-z0-9_-]{6,20}$/.test(via) ? via : ''
}

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

const CONTACT_MESSAGES: Record<ContactResult, string> = {
  pending: 'Check that inbox: quote requests start once the link pit.world just sent there is clicked.',
  cleared: 'Quote requests are off, and the address is forgotten.',
  unchanged: '',
  invalid: "The quote-request address doesn't look like an email address; it was not changed.",
  undeliverable: "The quote-request address's domain can't receive mail; it was not changed.",
  unauthorized: '',
  unavailable: 'This pit.world instance cannot send mail, so quote requests are off.',
  failed: "pit.world couldn't send the confirmation email just now; try saving again in a few minutes.",
}

/** Crawlers, link previews and scripts: their visits are not views. A missing user agent is not a person either. */
const NOT_A_PERSON = /bot|crawl|spider|slurp|preview|fetch|curl|wget|python|httpx|go-http|java\/|node|bun\/|axios|headless|lighthouse|monitor|scan|check|facebookexternalhit|embedly|whatsapp|telegram|discord|slack/i
export const isPerson = (userAgent: string | undefined) => Boolean(userAgent) && !NOT_A_PERSON.test(userAgent!)

const pageNumber = (raw: string | undefined) => {
  const n = Math.trunc(Number(raw ?? 1))
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 500) : 1
}

export function mountListings(
  app: Hono<Env>,
  listings: Listings,
  limited: (c: Context<Env>) => boolean,
  isMoshpitName: (name: string) => boolean,
  hooks: ListingHooks = {},
) {
  const tooMany = (c: Context<Env>) => {
    c.header('retry-after', '30')
    return c.json({ error: 'Too many requests. Try again shortly.' }, 429)
  }
  // Quote requests: three an hour from one visitor, whatever listings they are for.
  const quoteLimiter = new RateLimiter(3, 3 / 60)
  const quoteLimited = (c: Context<Env>) => limited(c) || !quoteLimiter.take(c.env?.ip || 'unknown')
  const ringChanged = () => hooks.ringChanged?.()

  /** Save an edit, and the private contact address when one was sent. */
  async function save(domain: string, key: unknown, body: Record<string, unknown>) {
    const saved = listings.edit(domain, key, edits(body), isMoshpitName)
    if (!saved) return null
    let contact: ContactResult | null = null
    if (body.contactRemove === '1' || body.contactRemove === true || body.contactEmail === '') contact = await listings.setContact(domain, key, '')
    else {
      const email = body.contactEmail ?? body.contact
      if (typeof email === 'string' && email.trim()) contact = await listings.setContact(domain, key, email)
    }
    ringChanged()
    return { saved: (await listings.get(domain, { fetchMeta: false }))!, contact, status: listings.contactStatus(domain, key) }
  }

  // --- pages ---------------------------------------------------------------------
  app.get('/b', (c) => {
    const domain = normalizeDomain(c.req.query('domain'))
    return domain ? c.redirect(`/b/${encodeURIComponent(domain)}`, 302) : c.html(listingsIndexPage())
  })

  app.get('/b/feed.xml', (c) =>
    c.body(listingsFeed(listings.directory({ limit: 50, claimedOnly: true }).listings), 200, { 'content-type': 'application/atom+xml; charset=utf-8', 'cache-control': 'public, max-age=900' }),
  )

  app.get('/b/:domain', async (c) => {
    const listing = await listings.get(c.req.param('domain'))
    if (!listing) return c.notFound()
    if (listing.domain !== c.req.param('domain')) return c.redirect(`/b/${encodeURIComponent(listing.domain)}`, 301)
    if (c.req.method === 'GET' && isPerson(c.req.header('user-agent'))) listings.view(listing.domain)
    if (c.req.method === 'GET') hooks.viewed?.(c, listing.domain)
    if (hasOpenProfile(listing)) c.header('link', `<${openProfilePath(listing.domain)}>; rel="openprofile"; type="text/markdown"`)
    return c.html(listingPage(listing, { via: viaOf(c) }))
  })

  // The listing as an OpenProfile.md (Kind organization), for directory listings only: a bare unclaimed
  // page is just the homepage's own title, nothing pit.world vouches for. Not a view.
  app.get('/b/:domain/openprofile.md', (c) => {
    const listing = listings.toPublic(c.req.param('domain'))
    if (!listing) return c.notFound()
    return c.body(listingOpenProfile(listing), 200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=900', 'access-control-allow-origin': '*' })
  })

  // A directory listing's website link. The destination is the listing's own site, never a parameter,
  // so this cannot be used as an open redirect.
  app.get('/b/:domain/go', (c) => {
    const listing = listings.toPublic(c.req.param('domain'))
    if (!listing) return c.notFound()
    hooks.clicked?.(c, listing.domain)
    c.header('cache-control', 'no-store')
    c.header('x-robots-tag', 'noindex, nofollow')
    return c.redirect(siteUrl(listing), 302)
  })

  app.post('/b/:domain/claim', async (c) => {
    if (limited(c)) return c.text('Too many requests. Try again shortly.', 429, { 'retry-after': '30' })
    // Honeypot: a filled hidden website field is a bot. Back to the listing, no claim started.
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
    if (typeof form.website === 'string' && form.website !== '') return c.redirect(`/b/${encodeURIComponent(c.req.param('domain'))}`, 303)
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
    if (typeof form.website === 'string' && form.website !== '') return c.redirect(`/b/${encodeURIComponent(domain)}`, 303)
    const claimId = String(form.claim ?? '')
    const result = await listings.verify(claimId)
    if (result.ok) {
      ringChanged()
      return c.html(verifiedPage(domain, result.editKey, result.method, listings.claimedOnly(domain)?.ring ?? false), 200, { 'cache-control': 'no-store' })
    }
    return c.html(verifyFailedPage(domain, rebuild(listings, claimId)), result.reason === 'unknown-claim' ? 410 : 400)
  })

  app.get('/b/:domain/edit', async (c) => {
    const listing = await listings.get(c.req.param('domain'), { fetchMeta: false })
    return listing ? c.html(editPage(listing)) : c.notFound()
  })

  app.post('/b/:domain/edit', async (c) => {
    if (limited(c)) return c.text('Too many requests. Try again shortly.', 429, { 'retry-after': '30' })
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
    const domain = normalizeDomain(c.req.param('domain'))
    const result = domain ? await save(domain, form.key, form) : null
    if (result) return c.html(editPage(result.saved, ['Saved.', result.contact ? CONTACT_MESSAGES[result.contact] : ''].filter(Boolean).join(' '), result.status))
    const listing = await listings.get(c.req.param('domain'), { fetchMeta: false })
    return listing ? c.html(editPage(listing, 'That edit key does not match this listing.'), 403) : c.notFound()
  })

  app.get('/b/:domain/contact', (c) => {
    const domain = normalizeDomain(c.req.param('domain'))
    if (!domain) return c.notFound()
    const ok = listings.confirmContact(domain, c.req.query('t'))
    return c.html(contactConfirmedPage(domain, ok), ok ? 200 : 410, { 'cache-control': 'no-store' })
  })

  app.post('/b/:domain/quote', async (c) => {
    const listing = await listings.get(c.req.param('domain'), { fetchMeta: false })
    if (!listing?.claimed) return c.notFound()
    const show = (state: QuoteState, status: 200 | 400 | 429 | 503 = 200) => c.html(listingPage(listing, { quote: state }), status, { 'cache-control': 'no-store' })
    if (quoteLimited(c)) return show('limited', 429)
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
    // The honeypot: a field people never see. A bot that fills it is told it worked, and nothing is sent.
    if (typeof form.website === 'string' && form.website !== '') return show('sent')
    const result = await listings.requestQuote(listing.domain, form)
    if (result === 'sent') hooks.quoted?.(c, listing.domain)
    return show(result, result === 'sent' ? 200 : result === 'limited' ? 429 : result === 'failed' ? 503 : 400)
  })

  const directory = (c: Context<Env>, category: string | undefined) => {
    const perPage = 20
    const page = pageNumber(c.req.query('page'))
    const q = (c.req.query('q') ?? '').trim().slice(0, 120)
    const near = (c.req.query('near') ?? '').trim().slice(0, 120)
    const { total, listings: found } = listings.directory({ category, q, near, limit: perPage, offset: (page - 1) * perPage })
    return c.html(prosPage({ listings: found, total, category: category ?? '', q, near, page, perPage, counts: listings.categoryCounts() }))
  }
  app.get('/pro', (c) => c.redirect('/pros', 301))
  app.get('/pros', (c) => {
    const cat = categoryOf(c.req.query('c') ?? c.req.query('category'))
    if (cat) {
      const params = new URLSearchParams()
      for (const k of ['q', 'near', 'page']) if (c.req.query(k)) params.set(k, c.req.query(k)!)
      const s = params.toString()
      return c.redirect(`/pros/${cat.slug}${s ? `?${s}` : ''}`, 301)
    }
    return directory(c, undefined)
  })
  app.get('/pros/:category', (c) => (categoryOf(c.req.param('category')) ? directory(c, c.req.param('category')) : c.notFound()))

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
    if (result.ok) ringChanged()
    return result.ok ? c.json(result) : c.json(result, result.reason === 'unknown-claim' ? 410 : 400)
  })

  app.post('/api/listing', async (c) => {
    if (limited(c)) return tooMany(c)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const key = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const domain = normalizeDomain(body.domain)
    const result = domain ? await save(domain, key, body) : null
    if (!result) return c.json({ error: 'unauthorized: send the edit key as Authorization: Bearer <key>' }, 401)
    return c.json({ ...result.saved, contactStatus: result.status, ...(result.contact ? { contactResult: result.contact } : {}) })
  })

  app.post('/api/listing/quote', async (c) => {
    if (quoteLimited(c)) return tooMany(c)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    if (typeof body.website === 'string' && body.website !== '') return c.json({ ok: true, status: 'sent' })
    const result = await listings.requestQuote(body.domain, body)
    if (result === 'sent' && typeof body.domain === 'string') hooks.quoted?.(c, normalizeDomain(body.domain) ?? body.domain)
    const status = { sent: 200, invalid: 400, undeliverable: 400, unavailable: 404, limited: 429, failed: 503 }[result] as 200 | 400 | 404 | 429 | 503
    return c.json({ ok: result === 'sent', status: result }, status)
  })

  app.get('/api/pros', (c) => {
    const raw = Math.trunc(Number(c.req.query('n') ?? 20))
    const n = Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 100) : 20
    const page = pageNumber(c.req.query('page'))
    const category = c.req.query('c') ?? c.req.query('category') ?? ''
    if (category && !categoryOf(category)) return c.json({ error: 'unknown category; see GET /api/pros/categories' }, 400)
    const { total, listings: results } = listings.directory({ category, q: c.req.query('q'), near: c.req.query('near'), limit: n, offset: (page - 1) * n })
    return c.json({ total, page, results: results.map((l) => ({ ...l, openprofile: openProfileUrl(l.domain) })) })
  })

  app.get('/api/pros/categories', (c) => {
    const counts = listings.categoryCounts()
    return c.json({ categories: CATEGORIES.map((cat) => ({ ...cat, count: counts[cat.slug] ?? 0 })), prices: PRICES })
  })
}
