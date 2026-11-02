import { Database } from 'bun:sqlite'
import { createBridgeClient, type BridgeClient } from '@profullstack/bridges'
import { Hono } from 'hono'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { bridgeSecret } from './accounts.js'

export const DAILY_STITCHER_HOST = 'daily.stitcher.pit.world'
const PIT_ORIGIN = 'https://pit.world'
const SESSION_COOKIE = 'daily_stitcher_session'
const BRIDGE_COOKIE = 'daily_stitcher_bridge'
const SESSION_TTL = 8 * 60 * 60

type Identity = { sub: string; name?: string | null }
type Story = {
  id: string
  title: string
  body: string
  status: 'pending' | 'published' | 'rejected'
  created_at: number
  approved_at: number | null
}

type DailyStitcherOptions = {
  dbPath?: string
  ownerSub?: string | null
  bridgeKey?: string | null
  fetch?: typeof fetch
  bridge?: BridgeClient
  resolveBearer?: (token: string) => Promise<Identity | null>
  now?: () => number
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const attr = esc
const parseCookies = (header: string | null) => Object.fromEntries((header ?? '').split(';').flatMap((part) => {
  const i = part.indexOf('=')
  if (i <= 0) return []
  try { return [[part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())]] } catch { return [] }
}))

function signed(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

function sessionValue(identity: Identity, secret: string, now: number) {
  const payload = Buffer.from(JSON.stringify({ sub: identity.sub, name: identity.name ?? null, exp: now + SESSION_TTL * 1000 })).toString('base64url')
  return `${payload}.${signed(payload, secret)}`
}

function readSession(value: string | undefined, secret: string, now: number): Identity | null {
  if (!value || value.length > 1800) return null
  const [payload, signature, ...extra] = value.split('.')
  if (!payload || !signature || extra.length) return null
  const expected = signed(payload, secret)
  const left = Buffer.from(signature)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof data.sub !== 'string' || !data.sub || data.sub.length > 300 || !Number.isFinite(data.exp) || data.exp <= now) return null
    return { sub: data.sub, name: typeof data.name === 'string' ? data.name : null }
  } catch {
    return null
  }
}

const css = readFileSync(new URL('../public/daily-stitcher.css', import.meta.url), 'utf8')
const quilt = readFileSync(new URL('../public/daily-stitcher-quilt.jpg', import.meta.url))

function page(title: string, content: string, options: { private?: boolean } = {}) {
  const privateMeta = options.private ? '<meta name="robots" content="noindex,nofollow">' : ''
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f5f0e7">
  <meta name="description" content="Handmade quilts and the stories behind the stitches.">
  ${privateMeta}
  <title>${esc(title)} · Daily Stitcher</title>
  <link rel="stylesheet" href="/daily-stitcher.css">
</head>
<body>
${content}
</body>
</html>`
}

function paragraphs(text: string) {
  return text.split(/\n\s*\n/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
}

export function createDailyStitcher(options: DailyStitcherOptions = {}) {
  const now = options.now ?? Date.now
  const dbPath = options.dbPath ?? ':memory:'
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS daily_stitcher_stories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'rejected')),
      author_sub TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      reviewed_by TEXT,
      reviewed_at INTEGER,
      approved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS daily_stitcher_stories_status_date
      ON daily_stitcher_stories(status, created_at DESC);
  `)

  const fetchImpl = options.fetch ?? fetch
  const bridgeKey = options.bridgeKey?.trim() || ''
  const clientSecret = bridgeKey ? bridgeSecret(bridgeKey, DAILY_STITCHER_HOST) : ''
  const bridge = options.bridge ?? (clientSecret ? createBridgeClient({
    authorizeUrl: `${PIT_ORIGIN}/bridge/authorize`,
    tokenUrl: `${PIT_ORIGIN}/bridge/token`,
    clientId: DAILY_STITCHER_HOST,
    clientSecret,
    redirectUri: `https://${DAILY_STITCHER_HOST}/auth/bridge/callback`,
    fetch: fetchImpl,
  }) : null)
  const ownerSub = options.ownerSub?.trim() || ''
  const identityForBearer = options.resolveBearer ?? (async (token: string): Promise<Identity | null> => {
    try {
      const response = await fetchImpl(`${PIT_ORIGIN}/api/v1/me`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return null
      const body = await response.json() as { account?: { sub?: string; name?: string | null } }
      const sub = body.account?.sub
      return typeof sub === 'string' && sub ? { sub, name: body.account?.name ?? null } : null
    } catch {
      return null
    }
  })

  const app = new Hono()
  app.use('*', async (c, next) => {
    await next()
    const path = new URL(c.req.url).pathname
    if (path === '/owner' || path.startsWith('/owner/') || path.startsWith('/api/owner/')) c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Frame-Options', 'DENY')
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://pit.world; base-uri 'none'; frame-ancestors 'none'")
  })

  const signedIn = async (request: Request): Promise<{ identity: Identity; via: 'cookie' | 'bearer' } | null> => {
    if (!clientSecret) return null
    const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(pw_[A-Za-z0-9_-]{20,})$/i)?.[1]
    if (bearer) {
      const identity = await identityForBearer(bearer)
      return identity ? { identity, via: 'bearer' } : null
    }
    const identity = readSession(parseCookies(request.headers.get('cookie'))[SESSION_COOKIE], clientSecret, now())
    return identity ? { identity, via: 'cookie' } : null
  }

  const sameOrigin = (request: Request) => {
    const origin = request.headers.get('origin')
    if (!origin) return false
    try { return new URL(origin).origin === `https://${DAILY_STITCHER_HOST}` } catch { return false }
  }

  const ownerRequired = (identity: Identity | null) => {
    if (!identity) return { error: 'sign_in_required', status: 401 as const }
    if (!ownerSub) return { error: 'owner_identity_not_configured', status: 409 as const }
    if (identity.sub !== ownerSub) return { error: 'owner_only', status: 403 as const }
    return null
  }

  const stories = (status: Story['status'] | null = null) => status
    ? db.query<Story, [string]>('SELECT id, title, body, status, created_at, approved_at FROM daily_stitcher_stories WHERE status = ? ORDER BY created_at DESC, id DESC').all(status)
    : db.query<Story, []>('SELECT id, title, body, status, created_at, approved_at FROM daily_stitcher_stories ORDER BY created_at DESC, id DESC').all()

  const newProposal = (title: string, body: string, sub: string): Story | null => {
    const cleanTitle = title.trim()
    const cleanBody = body.trim()
    if (!cleanTitle || cleanTitle.length > 100 || !cleanBody || cleanBody.length > 1800) return null
    const pending = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM daily_stitcher_stories WHERE status = 'pending' AND author_sub = ?").get(sub)?.n ?? 0
    if (pending >= 20) return null
    const item: Story = { id: randomUUID(), title: cleanTitle, body: cleanBody, status: 'pending', created_at: now(), approved_at: null }
    db.query('INSERT INTO daily_stitcher_stories (id, title, body, status, author_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(item.id, item.title, item.body, item.status, sub, item.created_at)
    return item
  }

  app.get('/health', (c) => c.json({ ok: true, site: DAILY_STITCHER_HOST }))
  app.get('/daily-stitcher.css', (c) => {
    c.header('Cache-Control', 'public, max-age=3600')
    return c.text(css, 200, { 'content-type': 'text/css; charset=utf-8' })
  })
  app.get('/daily-stitcher-quilt.jpg', (c) => {
    c.header('Cache-Control', 'public, max-age=86400, immutable')
    return c.body(new Uint8Array(quilt), 200, { 'content-type': 'image/jpeg' })
  })

  app.get('/', (c) => {
    c.header('Cache-Control', 'no-store')
    const published = stories('published')
    const journal = published.length
      ? published.map((story) => `<article class="journal-entry"><p class="eyebrow">${new Date(story.approved_at ?? story.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</p><h3>${esc(story.title)}</h3>${paragraphs(story.body)}</article>`).join('')
      : '<p class="quiet-note">Studio notes will find their way here soon.</p>'
    return c.html(page('Handmade quilts & studio stories', `
<div class="page-shell">
  <header class="site-header">
    <a class="wordmark" href="/" aria-label="Daily Stitcher home"><span class="mark" aria-hidden="true">✳</span><span>daily stitcher</span></a>
    <nav aria-label="Main navigation"><a href="#work">The work</a><a href="#journal">Journal</a><a href="#shop">Shop note</a></nav>
  </header>

  <main>
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="eyebrow">A maker’s corner · stitched by hand</p>
        <h1 id="hero-title">One stitch,<br><em>then another.</em></h1>
        <p class="intro">A home for handmade quilts and the stories behind the stitches.</p>
        <a class="text-link" href="#work">Take a closer look <span aria-hidden="true">↘</span></a>
      </div>
      <figure class="hero-art">
        <img src="/daily-stitcher-quilt.jpg" alt="A red-edged patchwork quilt on display, with star blocks, stripes and fireworks details">
        <figcaption><span>From the work on display</span><span class="caption-mark">✳</span></figcaption>
      </figure>
      <span class="hero-stamp" aria-hidden="true">made<br>with care</span>
    </section>

    <section class="work-section" id="work">
      <div class="section-heading"><p class="eyebrow">01 / The work</p><h2>Patchwork, with a point of view.</h2></div>
      <div class="work-copy"><p>This quilt brings together star blocks, stripes, floral fabric and a bright red edge. Each piece adds its own little rhythm.</p><p class="muted">The photograph is from a quilt display supplied for this site.</p></div>
    </section>

    <section class="journal-section" id="journal">
      <div class="section-heading"><p class="eyebrow">02 / The journal</p><h2>Notes from the making.</h2></div>
      <div class="journal-list">${journal}</div>
      <p class="journal-footnote">New stories appear here only after the maker approves them.</p>
    </section>

    <section class="shop-section" id="shop">
      <div class="shop-card"><p class="eyebrow">03 / The shop</p><h2>Getting the details just right.</h2><p>The shop is being prepared. No quilts are listed for sale, and no prices or order terms are published yet.</p><span class="coming-soon">Shop opening soon</span></div>
      <div class="vlog-card"><p class="eyebrow">Along the way</p><h2>Little glimpses of the process.</h2><p>Video stories are planned. A channel has not been connected to this site yet.</p><span class="coming-soon">Vlog coming soon</span></div>
    </section>
  </main>

  <footer class="site-footer"><a class="wordmark" href="/"><span class="mark" aria-hidden="true">✳</span><span>daily stitcher</span></a><p>Handmade quilts. Stories in progress.</p><a class="owner-link" href="/owner">Owner sign-in</a></footer>
</div>`, { private: false }))
  })

  app.get('/owner/signin', async (c) => {
    if (!bridge || !clientSecret) return c.html(page('Owner sign-in', '<main class="owner-shell"><p class="eyebrow">Daily Stitcher · owner</p><h1>Owner sign-in is being configured.</h1><p>The CoinPay identity bridge is not available on this server yet.</p><a class="text-link" href="/">Back to the storefront</a></main>', { private: true }), 503)
    const started = await bridge.begin({ returnTo: '/owner', prompt: 'login' })
    c.header('Set-Cookie', `${BRIDGE_COOKIE}=${encodeURIComponent(started.cookie)}; Path=/; Max-Age=${started.maxAge}; HttpOnly; Secure; SameSite=Lax`)
    c.header('Cache-Control', 'no-store')
    return c.redirect(started.url, 302)
  })

  app.get('/auth/bridge/callback', async (c) => {
    if (!bridge || !clientSecret) return c.redirect('/owner?error=not_configured', 302)
    const state = parseCookies(c.req.header('cookie') ?? null)[BRIDGE_COOKIE]
    const result = await bridge.complete(c.req.url, state)
    c.header('Set-Cookie', `${BRIDGE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
    c.header('Cache-Control', 'no-store')
    if (!result.ok) return c.redirect(`/owner?error=${encodeURIComponent(result.error)}`, 302)
    const cookie = sessionValue({ sub: result.user.sub, name: result.user.name ?? null }, clientSecret, now())
    c.header('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(cookie)}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; Secure; SameSite=Lax`, { append: true })
    return c.redirect('/owner', 302)
  })

  app.post('/owner/signout', (c) => {
    if (!sameOrigin(c.req.raw)) return c.text('Forbidden', 403)
    c.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
    return c.redirect('/owner', 303)
  })

  app.get('/owner', async (c) => {
    const auth = await signedIn(c.req.raw)
    const error = c.req.query('error')
    const notice = c.req.query('notice')
    if (!auth) {
      return c.html(page('Owner publishing', `<main class="owner-shell"><a class="back-link" href="/">← Back to Daily Stitcher</a><p class="eyebrow">Owner publishing</p><h1>Every story gets a human yes.</h1><p>Sign in with the maker’s pit.world account, backed by CoinPay OAuth 2.1. Signing in only confirms identity; it does not authorize a payment.</p>${error ? `<p class="notice">Sign-in could not be completed (${esc(error)}). Try again.</p>` : ''}<a class="button-link" href="/owner/signin">Continue with CoinPay</a><div class="cli-note"><p class="eyebrow">Prefer the terminal?</p><p>Run <code>pit login</code> to sign in with CoinPay OAuth 2.1 and PKCE, then use the Daily Stitcher CLI for proposals and approvals.</p><p><code>bun bin/stitcher status</code></p></div></main>`, { private: true }))
    }
    const isOwner = Boolean(ownerSub) && auth.identity.sub === ownerSub
    if (!ownerSub) {
      return c.html(page('Owner setup', `<main class="owner-shell"><a class="back-link" href="/">← Back to Daily Stitcher</a><p class="eyebrow">Owner setup</p><h1>The approval gate is waiting for its owner.</h1><p>You are signed in with CoinPay. The site has not been told which CoinPay DID may approve publishing.</p><div class="did-card"><span>Your CoinPay DID</span><code>${esc(auth.identity.sub)}</code></div><p>Set <code>STITCHER_OWNER_SUB</code> to the maker’s DID in the pit.world production environment. Email is not used to identify the owner.</p><p>Until that is set, pending stories stay private and cannot be published.</p><form method="post" action="/owner/signout"><button class="quiet-button">Sign out</button></form></main>`, { private: true }))
    }
    if (!isOwner) {
      return c.html(page('Owner access', `<main class="owner-shell"><a class="back-link" href="/">← Back to Daily Stitcher</a><p class="eyebrow">Owner publishing</p><h1>This CoinPay account cannot approve stories.</h1><p>Ask the configured owner to sign in, or use the account authorized for Daily Stitcher.</p><form method="post" action="/owner/signout"><button class="quiet-button">Sign out</button></form></main>`, { private: true }), 403)
    }
    const all = stories()
    return c.html(page('Owner publishing', `<main class="owner-shell"><a class="back-link" href="/">← Back to Daily Stitcher</a><p class="eyebrow">Owner publishing</p><h1>Review the stories.</h1><p>Only approved journal notes appear on the public site. This queue cannot create product listings, prices, orders or payment links.</p>${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
      <form class="proposal-form" method="post" action="/owner/proposals"><label for="story-title">Propose a journal title</label><input id="story-title" name="title" maxlength="100" required><label for="story-body">Story text</label><textarea id="story-body" name="body" maxlength="1800" rows="6" required></textarea><button class="button-link" type="submit">Add to approval queue</button></form>
      <div class="proposal-list">${all.length ? all.map((story) => `<article class="proposal"><div><p class="eyebrow">${esc(story.status)} · ${new Date(story.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</p><h2>${esc(story.title)}</h2>${paragraphs(story.body)}</div>${story.status === 'pending' ? `<div class="proposal-actions"><form method="post" action="/owner/proposals/${encodeURIComponent(story.id)}/approve"><button class="approve-button">Approve & publish</button></form><form method="post" action="/owner/proposals/${encodeURIComponent(story.id)}/reject"><button class="quiet-button">Reject</button></form></div>` : ''}</article>`).join('') : '<p class="quiet-note">Nothing is waiting for review.</p>'}</div>
      <div class="cli-note"><p class="eyebrow">Command line approvals</p><p><code>pit login</code>, then <code>bun bin/stitcher proposals</code>, <code>bun bin/stitcher approve &lt;id&gt;</code> or <code>bun bin/stitcher reject &lt;id&gt;</code>.</p></div><form method="post" action="/owner/signout"><button class="quiet-button">Sign out</button></form></main>`, { private: true }))
  })

  app.post('/owner/proposals', async (c) => {
    if (!sameOrigin(c.req.raw)) return c.text('Forbidden', 403)
    const auth = await signedIn(c.req.raw)
    if (!auth) return c.redirect('/owner?error=sign_in_required', 303)
    const form = await c.req.parseBody().catch(() => ({})) as Record<string, string | File>
    const item = newProposal(String(form.title ?? ''), String(form.body ?? ''), auth.identity.sub)
    if (!item) return c.redirect('/owner?notice=The+draft+was+empty+or+too+long.', 303)
    return c.redirect('/owner?notice=Added+to+the+approval+queue.', 303)
  })

  const formDecision = (decision: 'published' | 'rejected') => app.post(`/owner/proposals/:id/${decision === 'published' ? 'approve' : 'reject'}`, async (c) => {
    if (!sameOrigin(c.req.raw)) return c.text('Forbidden', 403)
    const auth = await signedIn(c.req.raw)
    const denied = ownerRequired(auth?.identity ?? null)
    if (denied) return c.redirect(`/owner?error=${encodeURIComponent(denied.error)}`, 303)
    const id = c.req.param('id')
    const reviewedAt = now()
    const result = db.query('UPDATE daily_stitcher_stories SET status = ?, reviewed_by = ?, reviewed_at = ?, approved_at = ? WHERE id = ? AND status = \'pending\'')
      .run(decision, auth!.identity.sub, reviewedAt, decision === 'published' ? reviewedAt : null, id)
    return c.redirect(`/owner?notice=${result.changes ? (decision === 'published' ? 'Story+published.' : 'Story+rejected.') : 'No+pending+story+matched.'}`, 303)
  })
  formDecision('published')
  formDecision('rejected')

  app.get('/api/owner/status', async (c) => {
    const auth = await signedIn(c.req.raw)
    if (!auth) return c.json({ error: 'sign_in_required', sign_in: '/owner/signin', cli: 'pit login' }, 401)
    return c.json({ signed_in: true, owner_configured: Boolean(ownerSub), can_approve: Boolean(ownerSub) && auth.identity.sub === ownerSub, coinpay_sub: auth.identity.sub })
  })

  app.post('/api/owner/proposals', async (c) => {
    const auth = await signedIn(c.req.raw)
    if (!auth) return c.json({ error: 'sign_in_required', sign_in: '/owner/signin', cli: 'pit login' }, 401)
    if (auth.via === 'cookie' && !sameOrigin(c.req.raw)) return c.json({ error: 'same_origin_required' }, 403)
    const body = await c.req.json().catch(() => ({})) as { title?: unknown; body?: unknown }
    const item = newProposal(typeof body.title === 'string' ? body.title : '', typeof body.body === 'string' ? body.body : '', auth.identity.sub)
    if (!item) return c.json({ error: 'title and body are required; title max 100 characters, body max 1,800; up to 20 pending stories per account' }, 400)
    return c.json({ story: item }, 201)
  })

  app.get('/api/owner/proposals', async (c) => {
    const auth = await signedIn(c.req.raw)
    const denied = ownerRequired(auth?.identity ?? null)
    if (denied) return c.json({ error: denied.error, setup: '/owner' }, denied.status)
    return c.json({ stories: stories() })
  })

  for (const [action, status] of [['approve', 'published'], ['reject', 'rejected']] as const) {
    app.post(`/api/owner/proposals/:id/${action}`, async (c) => {
      const auth = await signedIn(c.req.raw)
      const denied = ownerRequired(auth?.identity ?? null)
      if (denied) return c.json({ error: denied.error, setup: '/owner' }, denied.status)
      if (auth!.via === 'cookie' && !sameOrigin(c.req.raw)) return c.json({ error: 'same_origin_required' }, 403)
      const id = c.req.param('id')
      const reviewedAt = now()
      const result = db.query('UPDATE daily_stitcher_stories SET status = ?, reviewed_by = ?, reviewed_at = ?, approved_at = ? WHERE id = ? AND status = \'pending\'')
        .run(status, auth!.identity.sub, reviewedAt, status === 'published' ? reviewedAt : null, id)
      if (!result.changes) return c.json({ error: 'pending_story_not_found' }, 404)
      return c.json({ ok: true, id, status })
    })
  }

  app.notFound((c) => c.html(page('Not found', '<main class="owner-shell"><p class="eyebrow">Daily Stitcher</p><h1>This page isn’t here.</h1><a class="text-link" href="/">Return to the storefront</a></main>'), 404))
  return { app, db }
}
