/**
 * Routes for credit codes and invites (src/rewards.ts):
 *
 *   /i/:code                    an invite: what pit.world is, sign in to accept (new accounts only)
 *   /join?ref=CODE              a member's affiliate link; /?ref=CODE lands here too
 *   POST /account/redeem        "Have a code?" on /account
 *   POST /account/server        spend a server month: the order goes out like a paid one
 *   /account/invites            your invites (3), who joined, your affiliate link
 *   POST /api/v1/redeem         the same for the CLI (Bearer pw_ token): pit redeem CODE
 *   GET|POST /api/v1/invites    pit invites, pit invite [NOTE]
 *
 * Nothing here sets a cookie. The invite or ref rides the sign-in `next` URL and is read once,
 * in the CoinPay callback (onSignIn), and only a brand-new account takes it.
 */
import type { Context, Hono } from 'hono'
import { SESSION_COOKIE, type Account, type Accounts } from './accounts.js'
import { parseCookies } from './accounts-routes.js'
import { docPage, esc } from './html.js'
import { RateLimiter } from './ratelimit.js'
import { INVITES_PER_ACCOUNT, plural, readServerOrder, RewardError, SERVER_USD, type Rewards } from './rewards.js'

export type RewardDeps = { rewards: Rewards; accounts: Accounts; site: string }

const INVITE_RE = /^[A-Za-z0-9-]{6,40}$/
const REF_RE = /^[A-Za-z0-9_-]{4,40}$/
const day = (t: number) => new Date(t).toISOString().slice(0, 10)

/**
 * The CoinPay callback hook: a NEW account that arrived through /i/<code> spends that invite, and
 * one that arrived through ?ref= is attributed to that member. Returns where to go next.
 */
export function rewardsOnSignIn(rewards: Rewards) {
  return async (account: Account, isNew: boolean, returnTo: string): Promise<string | void> => {
    const u = new URL(returnTo, 'https://pit.world')
    const invite = u.searchParams.get('invite')
    const ref = u.searchParams.get('ref')
    if (!invite && !ref) return
    u.searchParams.delete('invite')
    u.searchParams.delete('ref')
    let message = ''
    if (invite && INVITE_RE.test(invite)) {
      message = isNew ? (await rewards.acceptInvite(invite, account.id)).message : 'You already had an account, so the invite is still unused: pass it on to someone new.'
    }
    if (ref && REF_RE.test(ref) && isNew) await rewards.attribute(ref, account.id).catch(() => false)
    if (message) u.searchParams.set('ok', message)
    return `${u.pathname}${u.search}`
  }
}

/** The /account sections: credits ("Have a code?", spend a server month) and invites. */
export function rewardsSections(rewards: Rewards) {
  return async (me: Account): Promise<string> => {
    const months = await rewards.serverMonths(me.id)
    const quota = await rewards.affiliates.quota(me.id)
    const order =
      months >= 1
        ? rewards.ordersOpen
          ? `<details open><summary>Use a month on a Moshpit server</summary>
<form method="post" action="/account/server">
<p class="muted">The same order as a $${SERVER_USD} month paid on <a href="/start">/start</a>: we set up your account on the Moshpit server, point each name at it with its certificate, and reply when it is ready. Then <code>moshcode deploy &lt;name&gt; --user &lt;username&gt;</code>.</p>
<label>Moshpit names to serve <input name="names" placeholder="shop.yourname blog.yourname" required maxlength="2000"></label>
<label>Username <input name="username" placeholder="yourname" required maxlength="32" pattern="[a-z][a-z0-9-]{1,30}"></label>
<label>SSH public key <textarea name="ssh_key" rows="3" required placeholder="ssh-ed25519 AAAA... you@laptop"></textarea></label>
<label>Anything else <input name="note" maxlength="500"></label>
<button>Use 1 month</button>
</form></details>`
          : '<p class="muted">Server orders are not open on this instance yet.</p>'
        : ''
    return `<h2>Credits</h2>
<p>Server months: <b>${months}</b> <span class="muted">(one month of a <a href="/start">Moshpit server</a>, $${SERVER_USD} value, unlimited sites)</span></p>
${order}
<form method="post" action="/account/redeem" class="inline"><label>Have a code? <input name="code" placeholder="CR-XXXX-XXXX-XXXX-XXXX" maxlength="64" autocomplete="off" required></label> <button>Redeem</button></form>
<h2>Invites</h2>
<p>You have <b>${plural(quota.left, 'invite')}</b> left of ${quota.total}. <a href="/account/invites">Your invites and affiliate link →</a></p>`
  }
}

export function mountRewards(app: Hono<any>, d: RewardDeps) {
  const { rewards, accounts, site } = d
  const origin = new URL(site).origin
  const tries = new RateLimiter(10, 1)

  const current = (c: Context): Account | null => accounts.sessionAccount(parseCookies(c.req.header('cookie'))[SESSION_COOKIE])
  const bearer = (c: Context): Account | null => accounts.tokenAccount((c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''))
  const sameOrigin = (c: Context) => {
    const fetchSite = c.req.header('sec-fetch-site')
    if (fetchSite) return fetchSite === 'same-origin'
    try {
      return new URL(c.req.header('origin') ?? c.req.header('referer') ?? '').origin === origin
    } catch {
      return false
    }
  }
  const page = (c: Context, title: string, body: string, status = 200) => {
    c.header('cache-control', 'no-store')
    return c.html(docPage({ title: `${title} · pit.world`, description: 'pit.world: private search and the Moshpit network.', path: c.req.path, noindex: true, body }), status as 200)
  }
  const form = async (c: Context): Promise<Record<string, string>> => {
    const body = await c.req.parseBody().catch(() => ({}))
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : '']))
  }
  const back = (c: Context, message: string, path = '/account') => c.redirect(`${path}?ok=${encodeURIComponent(message)}`, 302)
  const signinTo = (next: string) => `/signin?next=${encodeURIComponent(next)}`
  const pitch = `<p>pit.world is private search plus the Moshpit network: names nobody can take from you, a free <code>name.pit.world</code> copy of every site, and a <a href="/start">$${SERVER_USD} server</a> for all of them. No trackers, no profile, no ads in your results.</p>`

  // ---- arriving through an invite or an affiliate link ---------------------------

  app.get('/i/:code', (c) => {
    const code = c.req.param('code')
    if (!INVITE_RE.test(code)) return page(c, 'Not an invite', '<h1>Not an invite</h1><p>That invite link is not right. Check it with whoever sent it.</p>', 404)
    if (current(c)) return page(c, 'You are already in', `<h1>You are already in</h1><p>Invites are for people new to pit.world, and you have an account. Pass this one on to someone who does not: it is still unused.</p><p><a class="btn" href="/account/invites">Your own invites →</a></p>`)
    return page(
      c,
      'You are invited',
      `<p class="kicker">Invite only</p>
<h1>Someone wants you in the pit.</h1>
${pitch}
<p>Invites are scarce: every account gets ${INVITES_PER_ACCOUNT}. Sign in with CoinPay to take this one. It works once, for a new account.</p>
<p><a class="btn" href="${esc(signinTo(`/account?invite=${code}`))}">Sign in to accept →</a></p>
<p class="muted">Sign-in is CoinPay (OAuth 2.1): no password, no card. pit.world sets no cookie until you press Sign in.</p>`,
    )
  })

  app.get('/join', (c) => {
    const ref = c.req.query('ref') ?? ''
    const next = REF_RE.test(ref) ? `/account?ref=${ref}` : '/account'
    return page(
      c,
      'Join pit.world',
      `<h1>Join pit.world</h1>
${REF_RE.test(ref) ? '<p class="muted">A member sent you.</p>' : ''}
${pitch}
<p><a class="btn" href="${esc(signinTo(next))}">Sign in with CoinPay →</a></p>
<p class="muted">The member who sent you is credited only if you make a new account, and only once. Nothing tracks you before you sign in.</p>`,
    )
  })

  // ---- credits ----------------------------------------------------------------------

  app.post('/account/redeem', async (c) => {
    const me = current(c)
    if (!me) return c.redirect(signinTo('/account'), 302)
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    if (!tries.take(`redeem:${me.id}`)) return back(c, 'Too many tries. Wait a few minutes.')
    try {
      return back(c, await rewards.redeem(me.id, (await form(c)).code ?? ''))
    } catch (e) {
      return back(c, e instanceof RewardError ? e.message : 'That code did not work.')
    }
  })

  app.post('/account/server', async (c) => {
    const me = current(c)
    if (!me) return c.redirect(signinTo('/account'), 302)
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    try {
      const order = readServerOrder(await form(c))
      await rewards.orderServer(me, order)
      return back(c, `Ordered: a Moshpit server month for ${order.names.join(' ')}. We reply when it is ready.`)
    } catch (e) {
      return back(c, e instanceof RewardError ? e.message : 'The order did not go through.')
    }
  })

  // ---- invites ---------------------------------------------------------------------

  const invitesPage = async (c: Context, me: Account, flash = '', link = '') => {
    const v = await rewards.invitesOf(me.id, site)
    return page(
      c,
      'Your invites',
      `<h1>Your invites</h1>
${flash ? `<p class="notice">${esc(flash)}</p>` : ''}
${link ? `<p>Send this link. It works once, for someone new, and only shows here now:</p><pre><code>${esc(link)}</code></pre>` : ''}
<p>You have <b>${plural(v.quota.left, 'invite')}</b> left of ${v.quota.total}. ${plural(v.joined, 'person', 'people')} joined on yours.</p>
${v.quota.left > 0 ? `<form method="post" action="/account/invites" class="inline"><label>Who is it for? <input name="note" maxlength="80" placeholder="optional, only you see it"></label> <button>Make an invite</button></form>` : ''}
${
  v.invites.length
    ? `<table class="facts"><tr><th>Made</th><th>For</th><th>State</th></tr>${v.invites
        .map((i) => `<tr><td>${day(i.createdAt)}</td><td>${esc(i.note || '')}</td><td>${i.usedAt ? `used ${day(i.usedAt)}` : i.revokedAt ? 'withdrawn' : i.expiresAt && i.expiresAt < Date.now() ? 'expired' : `open until ${i.expiresAt ? day(i.expiresAt) : 'used'}`}</td></tr>`)
        .join('')}</table>`
    : ''
}
<p class="muted">An invite gives nothing but the way in: no credit, no bonus. Codes are stored only as hashes, so a lost link cannot be shown again.</p>
<h2>Your affiliate link</h2>
<pre><code>${esc(v.affiliateLink)}</code></pre>
<p class="muted">Open to anyone, unlimited. A new account made through it is credited to you, first touch, once. For 20% of what your people spend, see the <a href="/promote">promoter program</a>.</p>
<p><a href="/account">← Your account</a></p>`,
    )
  }

  app.get('/account/invites', async (c) => {
    const me = current(c)
    if (!me) return c.redirect(signinTo('/account/invites'), 302)
    return invitesPage(c, me)
  })

  app.post('/account/invites', async (c) => {
    const me = current(c)
    if (!me) return c.redirect(signinTo('/account/invites'), 302)
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    try {
      const made = await rewards.createInvite(me.id, (await form(c)).note ?? '', site)
      return invitesPage(c, me, '', made.link)
    } catch (e) {
      return invitesPage(c, me, e instanceof RewardError ? e.message : 'Could not make an invite.')
    }
  })

  // ---- API for the CLI (pw_ tokens from pit login) -------------------------------------

  app.post('/api/v1/redeem', async (c) => {
    const me = bearer(c)
    if (!me) return c.json({ error: 'sign in: pit login' }, 401)
    if (!tries.take(`redeem:${me.id}`)) return c.json({ error: 'Too many tries. Wait a few minutes.' }, 429)
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown }
    try {
      const message = await rewards.redeem(me.id, String(body.code ?? ''))
      return c.json({ ok: true, message, server_months: await rewards.serverMonths(me.id) })
    } catch (e) {
      return c.json({ ok: false, error: e instanceof RewardError ? e.message : 'That code did not work.' }, 400)
    }
  })

  app.get('/api/v1/credits', async (c) => {
    const me = bearer(c)
    if (!me) return c.json({ error: 'sign in: pit login' }, 401)
    return c.json({ server_months: await rewards.serverMonths(me.id), history: await rewards.credits.history(me.id) })
  })

  app.get('/api/v1/invites', async (c) => {
    const me = bearer(c)
    if (!me) return c.json({ error: 'sign in: pit login' }, 401)
    const v = await rewards.invitesOf(me.id, site)
    return c.json({ quota: v.quota, joined: v.joined, affiliate_link: v.affiliateLink, invites: v.invites.map((i) => ({ id: i.id, note: i.note, created_at: new Date(i.createdAt).toISOString(), expires_at: i.expiresAt ? new Date(i.expiresAt).toISOString() : null, used: Boolean(i.usedAt), revoked: Boolean(i.revokedAt) })) })
  })

  app.post('/api/v1/invites', async (c) => {
    const me = bearer(c)
    if (!me) return c.json({ error: 'sign in: pit login' }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { note?: unknown }
    try {
      const made = await rewards.createInvite(me.id, String(body.note ?? ''), site)
      return c.json({ link: made.link, code: made.code, expires_at: made.expiresAt ? new Date(made.expiresAt).toISOString() : null, left: made.left }, 201)
    } catch (e) {
      return c.json({ error: e instanceof RewardError ? e.message : 'Could not make an invite.' }, 400)
    }
  })
}
