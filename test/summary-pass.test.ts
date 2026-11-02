import { describe, expect, it } from 'bun:test'
import { Accounts } from '../src/accounts.ts'
import type { AccountDeps } from '../src/accounts-routes.ts'
import type { BuildInvoicing } from '../src/build-invoice.ts'
import { createApp } from '../src/server.ts'
import { Summarizer } from '../src/summarize.ts'
import { PASS_SUMMARIES, SummaryPasses } from '../src/summary-pass.ts'

const SITE = 'https://pit.world'
const DAY = 86_400_000

/** A fake pay.agent that records invoices; tests flip their status. */
function payAgent() {
  let calls = 0
  const records = new Map<string, any>()
  const cfg: BuildInvoicing = {
    payAgentUrl: 'https://pay.agent.pit.world',
    key: 'pa_test',
    fetch: (async (url: any, init: any = {}) => {
      if (init.method === 'POST') {
        calls++
        const b = JSON.parse(init.body)
        const id = `inv-${calls}`
        records.set(id, { id, amount_usd: b.amount_usd, description: b.description, to_email: b.to_email, status: 'sent', url: `https://pay.agent.pit.world/i/${id}` })
        return Response.json(records.get(id))
      }
      if (String(url).endsWith('/api/v1/invoices')) return Response.json({ invoices: [...records.values()] })
      return Response.json(records.get(String(url).split('/').pop()!))
    }) as typeof fetch,
  }
  return { cfg, records, calls: () => calls }
}

function harness() {
  let now = Date.UTC(2026, 10, 2, 12)
  const accounts = new Accounts(':memory:')
  const pay = payAgent()
  const passes = new SummaryPasses(accounts.db, pay.cfg, () => now)
  const me = accounts.signIn({ sub: 'did:key:alice', name: 'alice', email: 'alice@example.com' })
  return { accounts, passes, pay, me, setTime: (t: number) => (now = t), time: () => now }
}

describe('summary pass billing', () => {
  it('grants a week only for the exact paid $1 invoice, once, and stacks weeks', async () => {
    const h = harness()
    await expect(h.passes.buy(h.me.id, 'not an email')).rejects.toThrow('email')
    const url = await h.passes.buy(h.me.id, 'alice@example.com')
    expect(url).toBe('https://pay.agent.pit.world/i/inv-1')
    expect(h.pay.records.get('inv-1')).toMatchObject({ amount_usd: 1, to_email: 'alice@example.com' })
    // Asking again returns the same open invoice instead of making a second one.
    expect(await h.passes.buy(h.me.id, 'alice@example.com')).toBe(url)
    expect(h.pay.calls()).toBe(1)

    await h.passes.tick()
    expect(h.passes.activeUntil(h.me.id)).toBeNull()
    // A tampered amount is never honoured.
    h.pay.records.get('inv-1').status = 'paid'
    h.pay.records.get('inv-1').amount_usd = 0.5
    await h.passes.tick()
    expect(h.passes.activeUntil(h.me.id)).toBeNull()
    h.pay.records.get('inv-1').amount_usd = 1
    await h.passes.tick()
    expect(h.passes.activeUntil(h.me.id)).toBe(h.time() + 7 * DAY)
    // A second sync of the same paid invoice adds nothing.
    await h.passes.tick()
    expect(h.passes.activeUntil(h.me.id)).toBe(h.time() + 7 * DAY)

    // Another week bought while active starts when the first ends.
    await h.passes.buy(h.me.id, 'alice@example.com')
    h.pay.records.get('inv-2').status = 'paid'
    await h.passes.tick()
    expect(h.passes.activeUntil(h.me.id)).toBe(h.time() + 14 * DAY)
    // And it lapses.
    h.setTime(h.time() + 15 * DAY)
    expect(h.passes.activeUntil(h.me.id)).toBeNull()
  })

  it('a lost create response is recovered by matching the exact invoice, never re-created', async () => {
    const h = harness()
    const real = h.pay.cfg.fetch!
    h.pay.cfg.fetch = (async (url: any, init: any) => {
      if (init?.method === 'POST') {
        await real(url, init)
        throw new Error('timeout')
      }
      return real(url, init)
    }) as typeof fetch
    await expect(h.passes.buy(h.me.id, 'alice@example.com')).rejects.toThrow('could not be confirmed')
    await expect(h.passes.buy(h.me.id, 'alice@example.com')).rejects.toThrow('being confirmed')
    expect(h.pay.calls()).toBe(1)
    h.pay.cfg.fetch = real
    await h.passes.tick()
    expect(h.passes.state(h.me.id).openInvoice).toBe('https://pay.agent.pit.world/i/inv-1')
  })

  it('allows 1,000 summaries in any 7 days, then refuses until old ones age out', async () => {
    const h = harness()
    expect(h.passes.use(h.me.id)).toBe('none')
    await h.passes.buy(h.me.id, 'alice@example.com')
    h.pay.records.get('inv-1').status = 'paid'
    await h.passes.tick()
    for (let i = 0; i < PASS_SUMMARIES; i++) expect(h.passes.use(h.me.id)).toBe('ok')
    expect(h.passes.use(h.me.id)).toBe('over')
    expect(h.passes.state(h.me.id).used).toBe(PASS_SUMMARIES)
    // Buy a second week, then move past 7 days: the first 1,000 age out and summaries work again.
    await h.passes.buy(h.me.id, 'alice@example.com')
    h.pay.records.get('inv-2').status = 'paid'
    await h.passes.tick()
    h.setTime(h.time() + 7 * DAY + 1)
    expect(h.passes.use(h.me.id)).toBe('ok')
  })

  it('without pay.agent the pass is shown but cannot be bought', async () => {
    const accounts = new Accounts(':memory:')
    const passes = new SummaryPasses(accounts.db, null)
    expect(passes.sellable).toBe(false)
    await expect(passes.buy('x', 'a@example.com')).rejects.toThrow('unavailable')
  })
})

describe('summary pass on the site', () => {
  const url = 'https://acme.example/pricing'
  const infernet = (async (input: any) => {
    const u = String(input)
    if (u.endsWith('/api/chat')) return Response.json({ jobId: 'j', source: 'p2p' })
    return new Response('event: done\ndata: {"text":"Acme sells tools."}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const site = (signedIn = 1) => {
    const h = harness()
    const summarizer = new Summarizer({ apiKey: 'k', fetch: infernet, pageText: async () => 'A page about tools for small teams, long enough to summarize. '.repeat(3) })
    for (let i = 0; i < 5; i++) summarizer.remember([{ url: `${url}${i}`, title: 'Acme', description: '', host: 'acme.example' }])
    const deps: AccountDeps = { accounts: h.accounts, site: SITE, coinpay: null, bridgeKey: null }
    const app = createApp({ keys: {}, accounts: deps, summarizer, summaryPasses: h.passes, summaryLimits: { anon: 1, signedIn, anonTotal: 100 } })
    const cookie = `pw_session=${h.accounts.createSession(h.me.id).token}`
    const post = (u: string) =>
      app.request(`${SITE}/api/summarize`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ url: u }) }, { ip: '1.2.3.4' })
    return { ...h, app, cookie, post }
  }

  it('the hourly limit points to the pass, and a paid pass lifts it', async () => {
    const s = site(1)
    expect((await s.post(`${url}0`)).status).toBe(202)
    const limited = await s.post(`${url}1`)
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ pass: '/pass', error: expect.stringContaining('$1 a week') })
    await s.passes.buy(s.me.id, 'alice@example.com')
    s.pay.records.get('inv-1').status = 'paid'
    await s.passes.tick()
    expect((await s.post(`${url}1`)).status).toBe(202)
    expect((await s.post(`${url}2`)).status).toBe(202)
    expect(s.passes.state(s.me.id).used).toBe(2)
  })

  it('/account shows the pass and buys it from our own page only', async () => {
    const s = site()
    const page = await (await s.app.request(`${SITE}/account`, { headers: { cookie: s.cookie } })).text()
    expect(page).toContain('id="summary-pass"')
    expect(page).toContain('Buy a week for $1')
    expect(page).toContain('value="alice@example.com"')
    const form = (site: string) =>
      s.app.request(`${SITE}/account/summary-pass`, { method: 'POST', headers: { cookie: s.cookie, 'sec-fetch-site': site, 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=alice%40example.com' })
    expect((await form('cross-site')).status).toBe(403)
    expect(s.pay.calls()).toBe(0)
    const ok = await form('same-origin')
    expect(ok.status).toBe(303)
    expect(ok.headers.get('location')).toBe('https://pay.agent.pit.world/i/inv-1')
    const after = await (await s.app.request(`${SITE}/account`, { headers: { cookie: s.cookie } })).text()
    expect(after).toContain('An invoice is open')
  })

  it('/pass explains it to anyone', async () => {
    const s = site()
    const page = await (await s.app.request(`${SITE}/pass`)).text()
    expect(page).toContain('$1 a week')
    expect(page).toContain('Sign in with CoinPay to buy')
  })
})

describe('summary pass over x402 (bots and agents)', () => {
  const PAY_TO = '0x46E9000000000000000000000000000000006C79'
  const url = 'https://acme.example/pricing'
  /** A fake CoinPay facilitator: verifies a proof only for the offer's amount and payee, settles each nonce once. */
  const coinpay = () => {
    const settled = new Set<string>()
    const seen: any[] = []
    const fetchImpl = (async (input: any, init: any) => {
      const body = JSON.parse(init.body)
      seen.push({ path: new URL(String(input)).pathname, body, key: new Headers(init.headers).get('x-api-key') })
      if (String(input).endsWith('/api/x402/verify')) {
        const ok = body.expected.amount === '1000000' && body.expected.payTo === PAY_TO && body.payment.payload.authorization.value === '1000000'
        return Response.json(ok ? { valid: true, payment: { from: '0xpayer' } } : { valid: false, error: 'amount does not match' })
      }
      const nonce = body.payment.payload.authorization.nonce
      if (settled.has(nonce)) return Response.json({ settled: false, error: 'already settled' })
      settled.add(nonce)
      return Response.json({ settled: true, txHash: `0xtx${nonce}`, network: 'eip155:8453' })
    }) as typeof fetch
    return { fetchImpl, seen }
  }
  const proof = (nonce: string, value = '1000000') =>
    Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { signature: '0xsig', authorization: { from: '0xpayer', to: PAY_TO, value, nonce } } })).toString('base64')

  const site = () => {
    let now = Date.UTC(2026, 10, 2, 12)
    const accounts = new Accounts(':memory:')
    const cp = coinpay()
    const passes = new SummaryPasses(accounts.db, null, () => now, { apiKey: 'cp_live_x', payTo: PAY_TO, site: SITE, fetch: cp.fetchImpl })
    const summarizer = new Summarizer({
      apiKey: 'k',
      fetch: (async (input: any) =>
        String(input).endsWith('/api/chat') ? Response.json({ jobId: 'j', source: 'p2p' }) : new Response('event: done\ndata: {"text":"Acme sells tools."}\n\n')) as typeof fetch,
      pageText: async () => 'A page about tools for small teams, long enough to summarize. '.repeat(3),
    })
    for (let i = 0; i < 6; i++) summarizer.remember([{ url: `${url}${i}`, title: 'Acme', description: '', host: 'acme.example' }])
    const app = createApp({ keys: {}, summarizer, summaryPasses: passes, summaryLimits: { anon: 1, signedIn: 60, anonTotal: 100 } })
    const post = (u: string, headers: Record<string, string> = {}) =>
      app.request(`${SITE}/api/summarize`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'my-agent/1.0', ...headers }, body: JSON.stringify({ url: u }) }, { ip: '7.7.7.7' })
    return { app, passes, cp, post, setTime: (t: number) => (now = t), time: () => now }
  }

  it('over the free limit a bot gets a standard x402 402 for the $1 pass', async () => {
    const s = site()
    expect((await s.post(`${url}0`)).status).toBe(202)
    const r = await s.post(`${url}1`)
    expect(r.status).toBe(402)
    const body = await r.json()
    expect(body).toMatchObject({ x402Version: 2, status: 'limited', passHeader: 'x-summary-pass', signIn: '/signin' })
    expect(body.accepts[0]).toMatchObject({ scheme: 'exact', network: 'eip155:8453', amount: '1000000', payTo: PAY_TO, resource: `${SITE}/api/summary-pass` })
    const header = JSON.parse(Buffer.from(r.headers.get('payment-required')!, 'base64').toString())
    expect(header.accepts[0].amount).toBe('1000000')
  })

  it('paying on the retry starts the summary and hands back a token that lifts the limit', async () => {
    const s = site()
    await s.post(`${url}0`)
    const paid = await s.post(`${url}1`, { 'payment-signature': proof('n1') })
    expect(paid.status).toBe(202)
    const token = paid.headers.get('x-summary-pass')!
    expect(token).toStartWith('cp_')
    expect(paid.headers.get('payment-response')).toBeTruthy()
    expect((await paid.json()).pass).toMatchObject({ token, header: 'x-summary-pass', limit: 1000, days: 7 })
    expect(s.cp.seen.map((x) => x.path)).toEqual(['/api/x402/verify', '/api/x402/settle'])
    expect(s.cp.seen[0].key).toBe('cp_live_x')
    // The token, not another payment, from here on.
    for (const i of [2, 3, 4]) expect((await s.post(`${url}${i}`, { 'x-summary-pass': token })).status).toBe(202)
    expect(s.cp.seen).toHaveLength(2)
    // The same proof again returns the same token without settling twice.
    const again = await s.post(`${url}5`, { 'payment-signature': proof('n1') })
    expect(again.status).toBe(202)
    expect(again.headers.get('x-summary-pass')).toBe(token)
    expect(s.cp.seen).toHaveLength(2)
    expect(await (await s.app.request(`${SITE}/api/summary-pass`, { headers: { 'x-summary-pass': token } })).json()).toMatchObject({ status: 'active', used: 5, limit: 1000 })
    // After 7 days the token has ended: asking about it gets a fresh offer.
    s.setTime(s.time() + 7 * DAY + 1000)
    expect(await s.passes.useToken(token)).toBe('none')
    expect((await s.app.request(`${SITE}/api/summary-pass`, { headers: { 'x-summary-pass': token } })).status).toBe(402)
  })

  it('refuses an underpayment and a forged token', async () => {
    const s = site()
    const cheap = await s.post(`${url}0`, { 'payment-signature': proof('n2', '1000') })
    expect(cheap.status).toBe(402)
    expect((await cheap.json()).error).toContain('amount')
    expect((await s.post(`${url}0`, { 'x-summary-pass': 'cp_eyJ2IjoxfQ.forged' })).status).toBe(402)
  })

  it('/api/summary-pass sells the pass on its own', async () => {
    const s = site()
    expect((await s.app.request(`${SITE}/api/summary-pass`)).status).toBe(402)
    const bought = await s.app.request(`${SITE}/api/summary-pass`, { method: 'POST', headers: { 'x-payment': proof('n3') } })
    expect(bought.status).toBe(200)
    const b = await bought.json()
    expect(b).toMatchObject({ status: 'active', header: 'x-summary-pass', limit: 1000, days: 7 })
    expect(await s.passes.useToken(b.token)).toBe('ok')
  })

  it('without x402 keys the old 429 stays', async () => {
    const accounts = new Accounts(':memory:')
    const passes = new SummaryPasses(accounts.db, null)
    expect(passes.offer()).toBeNull()
    const summarizer = new Summarizer({ apiKey: 'k', pageText: async () => '' })
    summarizer.remember([{ url: `${url}0`, title: 'A', description: '', host: 'acme.example' }, { url: `${url}1`, title: 'A', description: '', host: 'acme.example' }])
    const app = createApp({ keys: {}, summarizer, summaryPasses: passes, summaryLimits: { anon: 1, signedIn: 60, anonTotal: 100 } })
    const ask = (u: string) => app.request(`${SITE}/api/summarize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: u }) }, { ip: '8.8.8.8' })
    expect((await ask(`${url}0`)).status).toBe(202)
    expect((await ask(`${url}1`)).status).toBe(429)
    expect((await app.request(`${SITE}/api/summary-pass`)).status).toBe(404)
  })
})
