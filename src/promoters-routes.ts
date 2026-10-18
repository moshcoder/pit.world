/**
 * Routes for the pit.world promoter program (src/promoters.ts):
 *
 *   /promote                 the offer (public, indexable); shows your link if you joined
 *   /r/:code                 a promoter's short share link -> /promote?ref=code
 *   POST /promote/join       become a promoter (signed in)
 *   /promote/start           start a free 30-day trial, attributing the referrer
 *   /promote/dashboard       your link, referrals and accrued commission (signed in)
 *
 * Attribution rides the URL (?ref=code) through sign-in, so no tracking cookie
 * is set — consistent with pit.world setting a cookie only on the account
 * routes. These routes read the session cookie but never set one.
 */
import type { Context, Hono } from 'hono'
import { SESSION_COOKIE, type Account, type Accounts } from './accounts.js'
import { parseCookies } from './accounts-routes.js'
import { docPage, esc } from './html.js'
import { COMMISSION_RATE, type Promoters } from './promoters.js'

export type PromoteDeps = {
  promoters: Promoters
  accounts: Accounts
  /** https://pit.world: where share links point. */
  site: string
}

const PCT = `${Math.round(COMMISSION_RATE * 100)}%`
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`
const refLink = (site: string, code: string) => `${site}/r/${code}`

export function mountPromote(app: Hono<any>, d: PromoteDeps) {
  const { promoters, accounts, site } = d
  const origin = new URL(site).origin

  const current = (c: Context): Account | null => accounts.sessionAccount(parseCookies(c.req.header('cookie'))[SESSION_COOKIE])
  const cleanRef = (raw: unknown): string | null => (promoters.byCode(String(raw ?? '')) ? String(raw) : null)
  const sameOrigin = (c: Context) => {
    const fetchSite = c.req.header('sec-fetch-site')
    if (fetchSite) return fetchSite === 'same-origin'
    try {
      return new URL(c.req.header('origin') ?? c.req.header('referer') ?? '').origin === origin
    } catch {
      return false
    }
  }
  const page = (c: Context, title: string, body: string, opts: { noindex?: boolean; status?: number } = {}) => {
    c.header('cache-control', opts.noindex ? 'no-store' : 'public, max-age=300')
    return c.html(docPage({ title: `${title} · pit.world`, description: `Bring people to the Mosh Pit and keep ${PCT} of everything they spend. Free 30-day trial, then $2 a month.`, path: '/promote', ...(opts.noindex ? { noindex: true } : {}), body }), (opts.status ?? 200) as 200)
  }
  const form = async (c: Context): Promise<Record<string, string>> => {
    const body = await c.req.parseBody().catch(() => ({}))
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : '']))
  }

  // ---- the offer (public) --------------------------------------------------------

  app.get('/promote', (c) => {
    const me = current(c)
    const ref = cleanRef(c.req.query('ref'))
    const mine = me ? promoters.byAccount(me.id) : null

    const invited = ref
      ? `<p class="notice">You were invited by a promoter. Your 30-day trial is free. <a class="btn" href="/promote/start?ref=${esc(ref)}">Start free trial →</a></p>`
      : ''

    let cta: string
    if (mine) {
      cta = `<h2>Your promoter link</h2>
<p>Share this. Everyone who joins through it is yours, for as long as they stay.</p>
<pre><code>${esc(refLink(site, mine.code))}</code></pre>
<p><a class="btn" href="/promote/dashboard">Your dashboard →</a></p>`
    } else if (me) {
      cta = `<h2>Become a promoter</h2>
<form method="post" action="/promote/join"><button class="btn" type="submit">Get my promoter link →</button></form>
<p class="muted">You get a link, a dashboard, and ${PCT} of everything the people you bring spend.</p>`
    } else {
      cta = `<h2>Become a promoter</h2>
<p><a class="btn" href="/signin?next=${encodeURIComponent('/promote')}">Sign in to get your link →</a></p>
<p class="muted">Sign in with CoinPay. No card, no password.</p>`
    }

    return page(
      c,
      `Promoter program: keep ${PCT} of everything your people spend`,
      `<p class="kicker">Promoter program</p>
<h1>Bring people to the Mosh Pit. Keep ${PCT} of everything they spend.</h1>
<p class="lede">pit.world charges a cover because you are not the product — no big-tech trackers, no profile, no selling your moves. Send people in and you keep ${PCT} of everything they spend here, for as long as they stay: builds, hosting, Moshpit names, memberships. $2 a month in, your best month out.</p>
${invited}
<div class="prices">
  <div><b>Free</b><span>for 30 days, then $2/mo</span><p>Access the Mosh Pit as a business, promoter or influencer. Paid in crypto through CoinPay. No card.</p></div>
  <div><b>${PCT}</b><span>of everything your people spend</span><p>Not ${PCT} of one sub — ${PCT} across the whole catalog, every month they stay. Your ceiling is how good you are.</p></div>
</div>
${cta}
<h2>How it works</h2>
<ol>
<li><b>Join.</b> Sign in with CoinPay and get your link.</li>
<li><b>Share it.</b> Anyone who joins through your link is attributed to you — recorded only when they join, never tracked click by click.</li>
<li><b>Earn.</b> ${PCT} of what they spend accrues on your dashboard and pays out monthly in crypto.</li>
</ol>
<h2>Questions</h2>
<h3>What does it cost?</h3>
<p>Nothing for 30 days, then $2 a month for Mosh Pit access. The promoter program itself is free.</p>
<h3>How is ${PCT} calculated?</h3>
<p>${PCT} of everything a person you referred spends across pit.world and the Moshpit catalog, for as long as they stay a paying member.</p>
<h3>How do I get paid?</h3>
<p>In crypto through <a href="https://coinpayportal.com">CoinPay</a>. Commission accrues on your dashboard and is paid monthly.</p>`,
    )
  })

  // A promoter's short share link.
  app.get('/r/:code', (c) => {
    const code = c.req.param('code')
    return c.redirect(promoters.byCode(code) ? `/promote?ref=${encodeURIComponent(code)}` : '/promote', 302)
  })

  // ---- become a promoter ---------------------------------------------------------

  app.post('/promote/join', async (c) => {
    const me = current(c)
    if (!me) return c.redirect(`/signin?next=${encodeURIComponent('/promote')}`, 302)
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    promoters.join(me.id)
    return c.redirect('/promote/dashboard', 302)
  })

  // ---- start a free trial (attributes the referrer) ------------------------------

  app.get('/promote/start', (c) => {
    const me = current(c)
    const ref = cleanRef(c.req.query('ref'))
    const nextTo = `/promote/start${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`
    if (!me) return c.redirect(`/signin?next=${encodeURIComponent(nextTo)}`, 302)
    const existing = promoters.member(me.id)
    if (existing) return c.redirect('/promote/dashboard', 302)
    return page(
      c,
      'Start your free trial',
      `<h1>Start your free 30-day trial</h1>
${ref ? `<p class="muted">Invited by a promoter.</p>` : ''}
<p>30 days free, then $2 a month for Mosh Pit access, paid in crypto through CoinPay. Cancel any time before the trial ends and you are never charged.</p>
<form method="post" action="/promote/start">${ref ? `<input type="hidden" name="ref" value="${esc(ref)}">` : ''}<button class="btn" type="submit">Start my free trial →</button></form>`,
      { noindex: true },
    )
  })

  app.post('/promote/start', async (c) => {
    const me = current(c)
    if (!me) return c.redirect(`/signin?next=${encodeURIComponent('/promote/start')}`, 302)
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    const ref = cleanRef((await form(c)).ref)
    promoters.startMembership(me.id, ref)
    return c.redirect('/promote/dashboard', 302)
  })

  // ---- your dashboard ------------------------------------------------------------

  app.get('/promote/dashboard', (c) => {
    const me = current(c)
    if (!me) return c.redirect(`/signin?next=${encodeURIComponent('/promote/dashboard')}`, 302)
    const stats = promoters.stats(me.id)
    if (!stats) {
      return page(
        c,
        'Promoter dashboard',
        `<h1>Become a promoter first</h1>
<p>You do not have a promoter link yet.</p>
<form method="post" action="/promote/join"><button class="btn" type="submit">Get my promoter link →</button></form>`,
        { noindex: true },
      )
    }
    const trial =
      stats.trial_end && stats.trial_end > Date.now()
        ? `Free trial — ${Math.ceil((stats.trial_end - Date.now()) / 86_400_000)} days left`
        : stats.member_status
          ? 'Trial ended'
          : 'Not a member yet'
    return page(
      c,
      'Promoter dashboard',
      `<h1>Your promoter dashboard</h1>
<h2>Your link</h2>
<pre><code>${esc(refLink(site, stats.code))}</code></pre>
<p class="muted">Share it anywhere. People who join through it are attributed to you.</p>
<table class="facts">
<tr><th>People referred</th><td>${stats.referred}</td></tr>
<tr><th>Commission accrued</th><td>${money(stats.commission_cents)} <span class="muted">(${PCT} of their spend, paid monthly in crypto)</span></td></tr>
<tr><th>Your membership</th><td>${esc(trial)}</td></tr>
</table>
${stats.member_status ? '' : `<p><a class="btn" href="/promote/start">Start your own free trial →</a></p>`}`,
      { noindex: true },
    )
  })
}
