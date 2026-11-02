/**
 * /account/votes: a signed-in account's votes, with Undo, and the points they earned (src/vote-rewards.ts).
 * /api/account/votes is the same as JSON (session cookie or a CLI/API bearer token).
 * /api/admin/vote-points lists unpaid balances for an operator deciding CoinPay payouts.
 *
 * History never shows the words searched: a result vote keeps only a keyed hash of its search.
 */
import type { Context, Hono } from 'hono'
import type { Account, Accounts } from './accounts.js'
import { parseCookies } from './accounts-routes.js'
import { SESSION_COOKIE } from './accounts.js'
import { docPage, esc } from './html.js'
import { adminAuthorized } from './newsletter.js'
import type { VoteRewards } from './vote-rewards.js'
import type { Votes } from './votes.js'

export type VoteHistoryDeps = {
  votes: Votes
  rewards: VoteRewards
  accounts: Accounts
  site: string
  admins?: string[]
  adminToken?: string
}

const KIND_LABEL: Record<string, string> = { result: 'Result', featured: 'Featured site', ad: 'Sponsored slot', promo: 'Pick', blog: 'Blog', listing: 'Business' }

/** Who is asking: a CLI/API bearer token, else the session cookie. */
export function accountOf(accounts: Accounts, c: Context): Account | null {
  const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
  return (bearer ? accounts.tokenAccount(bearer) : null) ?? accounts.sessionAccount(parseCookies(c.req.header('cookie'))[SESSION_COOKIE])
}

const link = (kind: string, target: string) => {
  if (kind === 'result' || kind === 'promo' || kind === 'blog') {
    const href = `https://${target}`
    return `<a href="${esc(href)}" rel="noopener nofollow">${esc(target.length > 90 ? `${target.slice(0, 87)}…` : target)}</a>`
  }
  if (kind === 'listing') return `<a href="/b/${encodeURIComponent(target)}">${esc(target)}</a>`
  return esc(target)
}

/** The /account section: a line and a link. */
export function voteHistorySection(votes: Votes, rewards: VoteRewards) {
  return async (me: Account): Promise<string> => {
    const n = votes.countFor(me.id)
    const p = rewards.summary(me.id)
    return `<h2>Your votes</h2>
<p>${n ? `${n.toLocaleString('en-US')} vote${n === 1 ? '' : 's'} standing, ${p.points.toLocaleString('en-US')} point${p.points === 1 ? '' : 's'} earned.` : 'No votes yet. Vote ▲ ▼ on results while signed in and they show here.'} <a href="/account/votes">Vote history</a></p>`
  }
}

export function mountVoteHistory(app: Hono<any>, d: VoteHistoryDeps): void {
  const origin = new URL(d.site).origin
  const sameOrigin = (c: Context) => {
    const fetchSite = c.req.header('sec-fetch-site')
    if (fetchSite) return fetchSite === 'same-origin'
    try {
      return new URL(c.req.header('origin') ?? c.req.header('referer') ?? '').origin === origin
    } catch {
      return false
    }
  }
  const pointsLine = (me: Account) => {
    const p = d.rewards.summary(me.id)
    const pay =
      p.usdPerPoint === null
        ? 'Payouts through CoinPay start once the rate per point is set; your points are kept until then.'
        : `At $${p.usdPerPoint} a point that is $${(p.unpaidUsd ?? 0).toFixed(2)} unpaid, paid through CoinPay (each payout approved by hand).`
    return `<p><b>${p.points.toLocaleString('en-US')} points</b> (${p.unpaid.toLocaleString('en-US')} unpaid), ${p.today} of ${p.cap} today. ${pay}</p>`
  }

  app.get('/account/votes', (c) => {
    const me = accountOf(d.accounts, c)
    if (!me) return c.redirect('/signin?next=/account/votes', 302)
    const before = Number(c.req.query('before') ?? '') || undefined
    const rows = d.votes.history(me.id, { limit: 100, ...(before ? { before } : {}) })
    const ok = c.req.query('ok')
    c.header('cache-control', 'no-store')
    const body = `<h1>Your votes</h1>
${ok ? `<p class="notice">${esc(ok)}</p>` : ''}
${pointsLine(me)}
<p class="muted">Votes you cast while signed in, newest first. Undo takes a vote back on every device. A result vote moves that result on the search you voted on; pit.world keeps only a hash of that search, so it is not shown here. <a href="/about#votes">How votes move results</a>.</p>
${
  rows.length
    ? `<table class="facts"><tr><th>When</th><th>What</th><th>Vote</th><th></th></tr>${rows
        .map(
          (r) => `<tr><td>${new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')}</td><td>${esc(KIND_LABEL[r.kind] ?? r.kind)}: ${link(r.kind, r.target)}${r.qkey ? ' <span class="muted">(on a search)</span>' : ''}</td><td>${r.value > 0 ? '▲' : '▼'}</td><td><form method="post" action="/account/votes/undo" class="inline"><input type="hidden" name="item" value="${esc(r.item)}"><input type="hidden" name="qkey" value="${esc(r.qkey)}"><button class="link">Undo</button></form></td></tr>`,
        )
        .join('')}</table>${rows.length === 100 ? `<p><a href="/account/votes?before=${rows[rows.length - 1]!.at}">Older</a></p>` : ''}`
    : '<p class="muted">No votes yet.</p>'
}
<p><a href="/account">Back to your account</a></p>`
    return c.html(docPage({ title: 'Your votes · pit.world', description: 'Your pit.world votes and points.', path: '/account/votes', noindex: true, body }))
  })

  app.post('/account/votes/undo', async (c) => {
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    const me = accountOf(d.accounts, c)
    if (!me) return c.redirect('/signin?next=/account/votes', 302)
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
    const item = typeof form.item === 'string' ? form.item.slice(0, 400) : ''
    const qkey = typeof form.qkey === 'string' ? form.qkey.slice(0, 64) : ''
    const done = item ? d.votes.undo(me.id, item, qkey) : false
    if (done) d.rewards.onVote(me.id, item, qkey, 0)
    return c.redirect(`/account/votes?ok=${encodeURIComponent(done ? 'Vote taken back.' : 'That vote was already gone.')}`, 303)
  })

  app.get('/api/account/votes', (c) => {
    c.header('cache-control', 'no-store')
    const me = accountOf(d.accounts, c)
    if (!me) return c.json({ error: 'sign in, or send a pit.world API token as a bearer token' }, 401)
    const before = Number(c.req.query('before') ?? '') || undefined
    const limit = Number(c.req.query('n') ?? 50)
    const rows = d.votes.history(me.id, { limit: Number.isFinite(limit) ? limit : 50, ...(before ? { before } : {}) })
    return c.json({
      points: d.rewards.summary(me.id),
      votes: rows.map((r) => ({ item: r.item, kind: r.kind, target: r.target, onSearch: Boolean(r.qkey), value: r.value, at: new Date(r.at).toISOString() })),
    })
  })

  app.get('/api/admin/vote-points', (c) => {
    c.header('cache-control', 'no-store')
    const me = accountOf(d.accounts, c)
    const admin = adminAuthorized(c.req.header('authorization'), d.adminToken) || Boolean(me && (d.admins ?? []).includes(me.sub))
    if (!admin) return c.json({ error: 'unauthorized' }, 401)
    return c.json({ usdPerPoint: d.rewards.usdPerPoint, balances: d.rewards.balances(Number(c.req.query('n') ?? 100)) })
  })
}
