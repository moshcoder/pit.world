/**
 * Routes for pit.world accounts (src/accounts.ts):
 *
 *   /signin, /auth/coinpay, /api/v1/coinpay/oauth/callback, /signout   sign in with CoinPay
 *   /account                                                           your account, sites, tokens
 *   /bridge/authorize, /bridge/token, /.well-known/bridge.json         sign-in for *.pit.world sites
 *   /oauth/authorize, /api/v1/oauth/token, /api/v1/me                  the pit CLI (OAuth 2.1, PKCE)
 *
 * These are the only routes on pit.world that set a cookie (server.ts strips
 * Set-Cookie from everything else).
 */
import type { Context, Hono } from 'hono'
import { createBridgeHost, createCoinPayClient, type BridgeClient } from '@profullstack/bridges'
import { bridgeClient, loopbackRedirect, SESSION_COOKIE, type Account, type Accounts } from './accounts.js'
import { docPage, esc } from './html.js'

export type AccountDeps = {
  accounts: Accounts
  /** https://pit.world: where callbacks and links point. */
  site: string
  coinpay: { clientId: string; clientSecret: string; baseUrl?: string } | null
  bridgeKey: string | null
  /** Exact extra hosts allowed to sign in through us, beside social.* and bbs.*. */
  extraClients?: string[]
  /** CoinPay subs with admin rights on our services. */
  admins?: string[]
  /** Tests swap the CoinPay client for a fake. */
  coinpayClient?: BridgeClient
  /** After a CoinPay sign-in: `isNew` on the first one. May return where to go instead of returnTo. */
  onSignIn?: (account: Account, isNew: boolean, returnTo: string) => Promise<string | void>
  /** Extra sections for /account (credits, invites), placed before "Sign out or delete". */
  accountSections?: (account: Account) => Promise<string>
}

const STATE_COOKIE = 'pw_cp_state'
const CALLBACK = '/api/v1/coinpay/oauth/callback'
export const CLI_CLIENT = 'pit-cli'

/** Paths that may set a cookie; server.ts strips Set-Cookie from every other response. */
export const COOKIE_PATHS = /^\/(signin|signout|auth\/|account|api\/v1\/coinpay\/|bridge\/|oauth\/)/

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
    } catch {}
  }
  return out
}
const cookies = (c: Context) => parseCookies(c.req.header('cookie'))

const setCookie = (name: string, value: string, maxAge: number, path = '/') => `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`

export function mountAccounts(app: Hono<any>, d: AccountDeps) {
  const { accounts, site } = d
  const origin = new URL(site).origin
  const coinpay =
    d.coinpayClient ??
    (d.coinpay
      ? createCoinPayClient({ clientId: d.coinpay.clientId, clientSecret: d.coinpay.clientSecret, redirectUri: `${site}${CALLBACK}`, ...(d.coinpay.baseUrl ? { baseUrl: d.coinpay.baseUrl } : {}) })
      : null)
  const replayStore = accounts.replayStore()

  const current = (c: Context): Account | null => accounts.sessionAccount(cookies(c)[SESSION_COOKIE])
  const isAdmin = (a: Account) => (d.admins ?? []).includes(a.sub)
  /** Only our own pages: a path, or an absolute URL on this origin turned back into one. */
  const safeNext = (raw: unknown): string => {
    const value = String(raw ?? '')
    if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) return value.slice(0, 4000)
    try {
      const u = new URL(value)
      // Same host on either scheme: behind nginx our own URLs arrive as http://.
      if (u.host === new URL(origin).host && (u.protocol === 'https:' || u.protocol === 'http:')) return `${u.pathname}${u.search}`.slice(0, 4000)
    } catch {}
    return '/account'
  }
  /** Forms post only from our own pages. */
  const sameOrigin = (c: Context) => {
    const fetchSite = c.req.header('sec-fetch-site')
    if (fetchSite) return fetchSite === 'same-origin'
    const from = c.req.header('origin') ?? c.req.header('referer') ?? ''
    try {
      return new URL(from).origin === origin
    } catch {
      return false
    }
  }
  const page = (c: Context, title: string, body: string, status = 200) => {
    c.header('cache-control', 'no-store')
    return c.html(docPage({ title: `${title} · pit.world`, description: 'Your pit.world account: one sign-in for every *.pit.world site.', path: '/account', noindex: true, body }), status as 200)
  }
  const form = async (c: Context): Promise<Record<string, string>> => {
    const body = await c.req.parseBody().catch(() => ({}))
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : '']))
  }

  // ---- sign in with CoinPay ----------------------------------------------------

  app.get('/signin', (c) => {
    const next = safeNext(c.req.query('next'))
    if (current(c)) return c.redirect(next, 302)
    const error = c.req.query('error')
    return page(
      c,
      'Sign in',
      `<h1>One account for every pit.world site</h1>
${error ? `<p class="notice">Sign-in did not finish (${esc(error)}). Try again.</p>` : ''}
<p>Sign in once and you are signed in on <code>social.&lt;name&gt;.pit.world</code> and <code>bbs.&lt;name&gt;.pit.world</code> for every Moshpit name: no new account per site, no new password.</p>
${coinpay ? `<p><a class="btn" href="/auth/coinpay?next=${encodeURIComponent(next)}">Sign in with CoinPay</a></p>` : '<p class="notice">Sign-in is not set up on this instance.</p>'}
<p class="muted">CoinPay signs you in with OAuth 2.1. We keep your CoinPay id, your name and email as CoinPay gives them, and the list of pit.world sites you used, nothing else. Search on pit.world never reads your sign-in. You can delete the account at any time.</p>`,
    )
  })

  app.get('/auth/coinpay', async (c) => {
    if (!coinpay) return c.redirect('/signin?error=not_configured', 302)
    const started = await coinpay.begin({ returnTo: safeNext(c.req.query('next')) })
    c.header('set-cookie', setCookie(STATE_COOKIE, started.cookie, started.maxAge, '/api/v1/coinpay'))
    c.header('cache-control', 'no-store')
    return c.redirect(started.url, 302)
  })

  app.get(CALLBACK, async (c) => {
    if (!coinpay) return c.redirect('/signin?error=not_configured', 302)
    const result = await coinpay.complete(new URL(c.req.url).searchParams, cookies(c)[STATE_COOKIE])
    c.header('set-cookie', setCookie(STATE_COOKIE, '', 0, '/api/v1/coinpay'), { append: true })
    if (!result.ok) return c.redirect(`/signin?error=${encodeURIComponent(result.error)}&next=${encodeURIComponent(safeNext(result.returnTo))}`, 302)
    const isNew = !accounts.db.query('SELECT 1 FROM accounts WHERE sub = ?').get(String(result.user.sub ?? '').trim())
    const account = accounts.signIn(result.user)
    const session = accounts.createSession(account.id)
    c.header('set-cookie', setCookie(SESSION_COOKIE, session.token, session.maxAge), { append: true })
    c.header('cache-control', 'no-store')
    let to = safeNext(result.returnTo)
    if (d.onSignIn) to = safeNext((await d.onSignIn(account, isNew, to).catch(() => undefined)) || to)
    return c.redirect(to, 302)
  })

  app.post('/signout', (c) => {
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    accounts.endSession(cookies(c)[SESSION_COOKIE])
    c.header('set-cookie', setCookie(SESSION_COOKIE, '', 0))
    return c.redirect('/', 302)
  })

  // ---- your account --------------------------------------------------------------

  app.get('/account', async (c) => {
    const me = current(c)
    if (!me) return c.redirect('/signin?next=/account', 302)
    const grants = accounts.grants(me.id)
    const tokens = accounts.tokens(me.id)
    const day = (t: number) => new Date(t).toISOString().slice(0, 10)
    const ok = c.req.query('ok')
    const extra = d.accountSections ? await d.accountSections(me) : ''
    return page(
      c,
      'Your account',
      `<h1>Your pit.world account</h1>
${ok ? `<p class="notice">${esc(ok)}</p>` : ''}
<table class="facts"><tr><th>Name</th><td>${esc(me.name ?? '(none)')}</td></tr><tr><th>CoinPay id</th><td><code>${esc(me.sub)}</code></td></tr>${me.email ? `<tr><th>Email</th><td>${esc(me.email)} <span class="muted">(from CoinPay; never used to link accounts)</span></td></tr>` : ''}<tr><th>Since</th><td>${day(me.created_at)}</td></tr>${isAdmin(me) ? '<tr><th>Role</th><td>pit.world admin</td></tr>' : ''}</table>
<form method="post" action="/account/name" class="inline"><label>Display name <input name="name" value="${esc(me.name ?? '')}" maxlength="120"></label> <button>Save</button></form>
<h2>Sites you use with this account</h2>
<p>Every Moshpit name has a social feed at <code>social.&lt;name&gt;.pit.world</code> and a board at <code>bbs.&lt;name&gt;.pit.world</code>. They all sign you in with this account.</p>
${
  grants.length
    ? `<ul class="plain">${grants.map((g) => `<li><a href="https://${esc(g.client_id)}/">${esc(g.client_id)}</a> <span class="muted">since ${day(g.first_at)}, last ${day(g.last_at)}</span> <form method="post" action="/account/sites/forget" class="inline"><input type="hidden" name="client_id" value="${esc(g.client_id)}"><button class="link">Forget</button></form></li>`).join('')}</ul><p class="muted">Forgetting a site removes it from this list; sign out on that site too. What you posted there stays on that site.</p>`
    : '<p class="muted">None yet. Try <a href="https://social.family.ancestry.pit.world/">social.family.ancestry.pit.world</a> or <a href="https://bbs.family.ancestry.pit.world/">bbs.family.ancestry.pit.world</a>.</p>'
}
<h2>CLI and API tokens</h2>
<p><code>pit login</code> opens this page and makes a token for the CLI (OAuth 2.1 with PKCE, nothing to paste).</p>
${tokens.length ? `<ul class="plain">${tokens.map((t) => `<li>${esc(t.label)} <span class="muted">made ${day(t.created_at)}${t.last_used_at ? `, last used ${day(t.last_used_at)}` : ''}</span> <form method="post" action="/account/tokens/revoke" class="inline"><input type="hidden" name="id" value="${esc(t.id)}"><button class="link">Revoke</button></form></li>`).join('')}</ul>` : '<p class="muted">No tokens.</p>'}
${extra}
<h2>Sign out or delete</h2>
<form method="post" action="/signout" class="inline"><button>Sign out</button></form>
<details><summary>Delete my pit.world account</summary><form method="post" action="/account/delete"><p>This removes your account, sessions, tokens and site list here. Posts you made on a board or social site stay there unless you delete them on that site.</p><label><input type="checkbox" name="confirm" value="yes" required> Yes, delete it</label> <button class="danger">Delete account</button></form></details>`,
    )
  })

  const signedInPost = (path: string, handler: (c: Context, me: Account, body: Record<string, string>) => string) =>
    app.post(path, async (c) => {
      const me = current(c)
      if (!me) return c.redirect('/signin?next=/account', 302)
      if (!sameOrigin(c)) return c.text('Forbidden', 403)
      const message = handler(c, me, await form(c))
      return c.redirect(message === '' ? '/' : `/account?ok=${encodeURIComponent(message)}`, 302)
    })
  signedInPost('/account/name', (_c, me, body) => (accounts.rename(me.id, body.name ?? ''), 'Saved.'))
  signedInPost('/account/sites/forget', (_c, me, body) => (accounts.forgetGrant(me.id, body.client_id ?? ''), 'Forgotten.'))
  signedInPost('/account/tokens/revoke', (_c, me, body) => (accounts.revokeToken(me.id, body.id ?? ''), 'Token revoked.'))
  signedInPost('/account/delete', (c, me, body) => {
    if (body.confirm !== 'yes') return 'Tick the box to delete.'
    accounts.remove(me.id)
    c.header('set-cookie', setCookie(SESSION_COOKIE, '', 0))
    return ''
  })

  // ---- sign-in for *.pit.world sites (@profullstack/bridges host) --------------

  /** One client per request: its secret is derived, so no site is ever registered by hand. */
  const hostFor = (clientId: string) => {
    if (!d.bridgeKey) return null
    const client = bridgeClient(clientId, d.bridgeKey, d.extraClients ?? [])
    if (!client) return null
    return createBridgeHost({
      clients: { [clientId.toLowerCase()]: client },
      replayStore,
      getUser: async (request) => {
        const me = accounts.sessionAccount(parseCookies(request.headers.get('cookie'))[SESSION_COOKIE])
        if (!me) return null
        accounts.recordGrant(me.id, clientId.toLowerCase())
        return { sub: me.sub, ...(me.name ? { name: me.name } : {}), ...(me.email ? { email: me.email, email_verified: false } : {}) }
      },
      // Behind nginx the request URL says http://; come back to the same path on our public origin.
      loginUrl: (returnTo) => {
        const u = new URL(returnTo)
        return `${site}/signin?next=${encodeURIComponent(`${u.pathname}${u.search}`)}`
      },
    })
  }

  app.get('/bridge/authorize', async (c) => {
    const host = hostFor(c.req.query('client_id') ?? '')
    c.header('cache-control', 'no-store')
    if (!host) return page(c, 'Unknown site', '<h1>Unknown site</h1><p>Only pit.world sites can sign in with a pit.world account.</p>', 400)
    return host.authorize(c.req.raw)
  })

  app.post('/bridge/token', async (c) => {
    const peek = c.req.raw.clone()
    let clientId = ''
    const basic = peek.headers.get('authorization')
    if (basic?.startsWith('Basic ')) clientId = decodeURIComponent(atob(basic.slice(6)).split(':')[0] ?? '')
    else {
      const text = await peek.text()
      clientId = (peek.headers.get('content-type') ?? '').includes('json') ? String((JSON.parse(text || '{}') as any).client_id ?? '') : (new URLSearchParams(text).get('client_id') ?? '')
    }
    const host = hostFor(clientId)
    if (!host) return c.json({ error: 'invalid_client' }, 401)
    return host.token(c.req.raw)
  })

  app.get('/.well-known/bridge.json', (c) =>
    c.json({
      issuer: site,
      authorization_endpoint: `${site}/bridge/authorize`,
      token_endpoint: `${site}/bridge/token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      prompt_values_supported: ['none', 'login'],
      client_id: 'your site host, e.g. social.family.ancestry.pit.world',
      redirect_uri: 'https://<client_id>/auth/bridge/callback',
    }),
  )

  // ---- the pit CLI: OAuth 2.1, public client, loopback redirect, PKCE S256 -----

  const cliParams = (q: (k: string) => string | undefined) => ({
    client_id: q('client_id') ?? '',
    redirect_uri: q('redirect_uri') ?? '',
    state: q('state') ?? '',
    code_challenge: q('code_challenge') ?? '',
    code_challenge_method: q('code_challenge_method') ?? '',
    response_type: q('response_type') ?? '',
  })
  const cliProblem = (p: ReturnType<typeof cliParams>) =>
    p.client_id !== CLI_CLIENT ? 'unknown client_id' : !loopbackRedirect(p.redirect_uri) ? 'redirect_uri must be a loopback http address' : p.response_type !== 'code' ? 'response_type must be code' : p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge) ? 'PKCE S256 is required' : null

  app.get('/oauth/authorize', (c) => {
    const p = cliParams((k) => c.req.query(k))
    const problem = cliProblem(p)
    if (problem) return page(c, 'Cannot sign in', `<h1>Cannot sign in</h1><p>${esc(problem)}.</p>`, 400)
    const me = current(c)
    if (!me) return c.redirect(`/signin?next=${encodeURIComponent(`/oauth/authorize?${new URL(c.req.url).searchParams}`)}`, 302)
    return page(
      c,
      'Allow the pit CLI',
      `<h1>Allow the pit CLI?</h1><p>The <code>pit</code> command on your computer asks to act as <b>${esc(me.name ?? me.sub)}</b>. It gets a token you can revoke on <a href="/account">your account</a>.</p>
<form method="post" action="/oauth/authorize">${Object.entries(p).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('')}<button>Allow</button> <a href="/account">Cancel</a></form>`,
    )
  })

  app.post('/oauth/authorize', async (c) => {
    const me = current(c)
    if (!me) return c.redirect('/signin', 302)
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    const body = await form(c)
    const p = cliParams((k) => body[k])
    const problem = cliProblem(p)
    if (problem) return page(c, 'Cannot sign in', `<h1>Cannot sign in</h1><p>${esc(problem)}.</p>`, 400)
    const back = new URL(p.redirect_uri)
    back.searchParams.set('code', accounts.createCode(me.id, p.redirect_uri, p.code_challenge))
    if (p.state) back.searchParams.set('state', p.state)
    return c.redirect(back.toString(), 302)
  })

  app.post('/api/v1/oauth/token', async (c) => {
    const type = c.req.header('content-type') ?? ''
    const body: Record<string, string> = type.includes('json') ? ((await c.req.json().catch(() => ({}))) as Record<string, string>) : await form(c)
    if (body.grant_type !== 'authorization_code') return c.json({ error: 'unsupported_grant_type' }, 400)
    if (body.client_id !== CLI_CLIENT) return c.json({ error: 'invalid_client' }, 401)
    const out = accounts.exchangeCode(String(body.code ?? ''), String(body.redirect_uri ?? ''), String(body.code_verifier ?? ''), String(body.label ?? 'pit CLI'))
    if (!out) return c.json({ error: 'invalid_grant' }, 400)
    return c.json({ access_token: out.token, token_type: 'Bearer', account: accountOut(out.account) })
  })

  app.post('/api/v1/oauth/revoke', async (c) => {
    const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (bearer) accounts.revokeTokenValue(bearer)
    return c.json({ ok: true })
  })

  app.get('/api/v1/me', (c) => {
    const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const me = accounts.tokenAccount(bearer)
    if (!me) return c.json({ error: 'sign in: pit login' }, 401)
    return c.json({ account: accountOut(me), admin: isAdmin(me), sites: accounts.grants(me.id) })
  })
}

const accountOut = (a: Account) => ({ id: a.id, sub: a.sub, name: a.name, email: a.email, created_at: a.created_at })
