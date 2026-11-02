/**
 * /pass: what the summary pass is, and the /account section and form that buy it.
 *   GET  /pass                    the offer (anyone)
 *   POST /account/summary-pass    signed in, from our own pages: open the $1 CoinPay invoice
 */
import type { Context, Hono } from 'hono'
import type { Account, Accounts } from './accounts.js'
import { SESSION_COOKIE } from './accounts.js'
import { parseCookies } from './accounts-routes.js'
import { docPage, esc } from './html.js'
import { PASS_DAYS, PASS_SUMMARIES, PASS_USD, PassError, type SummaryPasses } from './summary-pass.js'

const day = (t: number) => new Date(t).toISOString().slice(0, 10)

/** The /account section: status, use this week, and the buy form. */
export function passSection(passes: SummaryPasses) {
  return async (me: Account): Promise<string> => {
    const s = passes.state(me.id)
    const status = s.activeUntil
      ? `<p>Active until <strong>${day(s.activeUntil)}</strong> (UTC). ${s.used} of ${s.limit} summaries used in the last ${PASS_DAYS} days.</p>`
      : `<p class="muted">No pass. Signed in, you get 60 free summaries an hour.</p>`
    const pending = s.openInvoice ? `<p class="notice">An invoice is open: <a href="${esc(s.openInvoice)}">pay it on CoinPay</a>. The pass starts a minute or two after it is paid.</p>` : ''
    const buy = passes.sellable
      ? `<form method="post" action="/account/summary-pass"><label>Invoice email <input type="email" name="email" required maxlength="254" autocomplete="email" value="${esc(me.email ?? '')}"></label> <button>${s.activeUntil ? `Add a week for $${PASS_USD}` : `Buy a week for $${PASS_USD}`}</button></form>`
      : '<p class="muted">Checkout is unavailable right now.</p>'
    return `<h2 id="summary-pass">Summary pass</h2>
<p>$${PASS_USD} for ${PASS_DAYS} days of up to ${PASS_SUMMARIES.toLocaleString('en-US')} result summaries, with no hourly limit. Paid by CoinPay invoice; it does not renew by itself, and each week you buy is added after the time you have left. <a href="/pass">More</a></p>
${status}${pending}${buy}`
  }
}

export function mountSummaryPass(app: Hono<any>, d: { passes: SummaryPasses; accounts: Accounts; site: string }) {
  const { passes, accounts } = d
  const origin = new URL(d.site).origin
  const current = (c: Context): Account | null => accounts.sessionAccount(parseCookies(c.req.header('cookie'))[SESSION_COOKIE])
  const sameOrigin = (c: Context) => {
    const fetchSite = c.req.header('sec-fetch-site')
    if (fetchSite) return fetchSite === 'same-origin'
    try {
      return new URL(c.req.header('origin') ?? c.req.header('referer') ?? '').origin === origin
    } catch {
      return false
    }
  }
  const back = (c: Context, message: string) => c.redirect(`/account?ok=${encodeURIComponent(message)}#summary-pass`, 302)

  app.get('/pass', (c) => {
    const me = current(c)
    c.header('cache-control', 'no-store')
    return c.html(
      docPage({
        title: 'Summary pass · pit.world',
        path: '/pass',
        description: `$${PASS_USD} a week for up to ${PASS_SUMMARIES} c0mpute result summaries on pit.world, paid with CoinPay.`,
        body: `<p class="kicker">Summary pass</p>
<h1>$${PASS_USD} a week. Up to ${PASS_SUMMARIES.toLocaleString('en-US')} summaries.</h1>
<p class="lede">Summarize under a search result reads the page and has <a href="https://c0mpute.com/">c0mpute</a> write two or three sentences about it. Free, that is 5 an hour without an account and 60 an hour signed in. A pass lifts the hourly limit: up to ${PASS_SUMMARIES.toLocaleString('en-US')} in any ${PASS_DAYS} days.</p>
<ul>
<li>$${PASS_USD} buys ${PASS_DAYS} days, paid by CoinPay invoice. It starts a minute or two after the invoice is paid.</li>
<li>It does not renew by itself. Buy another week whenever you like; it is added after the time you have left.</li>
<li>A summary someone already asked for is free and does not count.</li>
<li>Searching stays free, without an account.</li>
</ul>
<h2>For bots and agents: x402</h2>
<p>No account needed. Over the free limit, <code>POST /api/summarize</code> answers <code>402</code> with an x402 offer: $${PASS_USD} in USDC for the same pass. Retry with the <code>PAYMENT-SIGNATURE</code> (or <code>X-PAYMENT</code>) header and the summary starts. The response carries your pass token in the <code>x-summary-pass</code> header; send it on later calls. <code>GET /api/summary-pass</code> is the offer on its own, <code>POST</code> with a payment buys a token, and <code>GET</code> with your token shows what is left. Payments are verified and settled by CoinPay.</p>
<p>${me ? '<a class="btn" href="/account#summary-pass">Buy a week →</a>' : '<a class="btn" href="/signin?next=%2Faccount%23summary-pass">Sign in with CoinPay to buy →</a>'}</p>`,
      }),
    )
  })

  app.post('/account/summary-pass', async (c) => {
    const me = current(c)
    if (!me) return c.redirect('/signin?next=/account', 302)
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
    try {
      return c.redirect(await passes.buy(me.id, body.email), 303)
    } catch (e) {
      return back(c, e instanceof PassError ? e.message : 'Checkout did not work. Try again in a minute.')
    }
  })
}
