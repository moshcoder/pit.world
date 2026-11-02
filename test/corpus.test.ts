/**
 * /api/corpus end to end over a real (in-memory) pitbot index: the free preview and its 402,
 * the internal key, x402 per request and credit packs, cursor paging, comma lists and opt-outs.
 */
import { describe, expect, it } from 'bun:test'
import { Accounts } from '../src/accounts.ts'
import { CorpusBilling } from '../src/corpus.ts'
import { createApp } from '../src/server.ts'
import { IndexStore } from '../services/crawler/src/index-store.ts'

const SITE = 'https://pit.world'
const PAY_TO = '0x46E9000000000000000000000000000000006C79'
const INTERNAL = 'internal-key-for-tests-0123456789abcdef'
const OPEN = { allowed: true, reason: 'no reservation' }

const page = (url: string, text: string, training: { allowed: boolean; reason: string } | null = OPEN) => ({
  record: { url, canonical: url, title: `Title ${url}`, description: null, kind: 'page', language: 'en', fetched_at: '2026-11-02T00:00:00.000Z' },
  enrichment: { keywords: [], excerpt: text.slice(0, 100), text, ...(training ? { training } : {}) },
})

function site(options: { pages?: number } = {}) {
  const store = new IndexStore(':memory:')
  const long = 'lorem '.repeat(300)
  store.add(Array.from({ length: options.pages ?? 60 }, (_, i) => page(`https://s${i % 4}.example/${i}`, `${i % 2 ? 'crypto' : 'saas'} page ${i} ${long}`)))
  store.add([
    page('https://reserved.example/a', `saas reserved ${long}`, { allowed: false, reason: 'meta robots: noai' }),
    page('https://legacy.example/a', `saas legacy ${long}`, null),
  ])
  const settled = new Set<string>()
  const coinpay = (async (input: any, init: any) => {
    const body = JSON.parse(init.body)
    if (String(input).endsWith('/api/x402/verify')) {
      const ok = body.expected.payTo === PAY_TO && body.payment.payload.authorization.value === body.expected.amount
      return Response.json(ok ? { valid: true, payment: { from: '0xpayer' } } : { valid: false, error: 'amount does not match' })
    }
    const nonce = body.payment.payload.authorization.nonce
    if (settled.has(nonce)) return Response.json({ settled: false, error: 'already settled' })
    settled.add(nonce)
    return Response.json({ settled: true, txHash: `0xtx${nonce}`, network: 'eip155:8453' })
  }) as typeof fetch
  const crawler = (async (input: any) => {
    const u = new URL(String(input))
    if (u.origin !== 'http://crawler.test') return new Response('no', { status: 404 })
    if (u.pathname === '/api/v1/corpus/stats') return Response.json(store.corpusStats())
    const p = u.searchParams
    return Response.json(
      store.corpus({ q: p.get('q') ?? '', site: p.get('site') ?? '', limit: Number(p.get('limit')), cursor: Number(p.get('cursor') ?? 0), textMax: Number(p.get('text_max')) }),
    )
  }) as typeof fetch
  const accounts = new Accounts(':memory:')
  const billing = new CorpusBilling(accounts.db, { usdPer1000: 1 }, { internalKey: INTERNAL, x402: { apiKey: 'cp_live_x', payTo: PAY_TO, site: SITE, fetch: coinpay } })
  const app = createApp({ keys: {}, corpus: billing, crawlerUrl: 'http://crawler.test', fetch: crawler })
  const get = (path: string, headers: Record<string, string> = {}, ip = '9.9.9.9') => app.request(`${SITE}${path}`, { headers }, { ip })
  return { app, billing, store, get }
}

const proof = (nonce: string, value: string) =>
  Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { signature: '0xsig', authorization: { from: '0xpayer', to: PAY_TO, value, nonce } } })).toString('base64')

describe('/api/corpus', () => {
  it('previews 20 pages a day per address with short text, then answers a self-explanatory 402', async () => {
    const s = site()
    const first = await s.get('/api/corpus?q=saas&limit=15')
    expect(first.status).toBe(200)
    const body = await first.json()
    expect(body.items).toHaveLength(15)
    expect(body.items[0].text.length).toBeLessThanOrEqual(501)
    expect(body.access).toMatchObject({ mode: 'preview', free_pages_left_today: 5, text_truncated_to: 500 })
    expect(Object.keys(body.items[0]).sort()).toEqual(['fetched_at', 'kind', 'language', 'site', 'text', 'title', 'url'])
    // Asks for 10, gets the 5 left, and the cursor follows what was served.
    const second = await (await s.get(`/api/corpus?q=saas&limit=10&cursor=${body.next_cursor}`)).json()
    expect(second.items).toHaveLength(5)
    const third = await s.get('/api/corpus?q=saas&limit=10')
    expect(third.status).toBe(402)
    const offer = await third.json()
    expect(offer).toMatchObject({ x402Version: 2, status: 'payment_required', price: { usd_per_1000_pages: 1, pages: 10, this_request: '$0.01' }, free_preview: { pages_per_day: 20 } })
    expect(offer.accepts[0]).toMatchObject({ amount: '10000', payTo: PAY_TO })
    expect(offer.how_to_pay.x402).toContain('PAYMENT-SIGNATURE')
    expect(offer.how_to_pay.credits_coinpay).toContain('/account#corpus-credits')
    expect(third.headers.get('payment-required')).toBeTruthy()
    // Another address still has its preview; stats are always free.
    expect((await s.get('/api/corpus?q=saas', {}, '8.8.8.8')).status).toBe(200)
    const stats = await s.get('/api/corpus/stats', {}, '9.9.9.9')
    expect(stats.status).toBe(200)
    expect(stats.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await stats.json()).toMatchObject({ pages: 60, excluded: 1, unknown: 1, price: { usd_per_1000_pages: 1 } })
  })

  it('the internal key reads full text with no metering; paging covers every open page once', async () => {
    const s = site()
    const auth = { authorization: `Bearer ${INTERNAL}` }
    const urls: string[] = []
    let cursor: string | null = ''
    do {
      const r = await (await s.get(`/api/corpus?q=saas&limit=7${cursor ? `&cursor=${cursor}` : ''}`, auth)).json()
      expect(r.access).toEqual({ mode: 'internal', pages_charged: 0 })
      expect(r.items.every((i: any) => i.text.length > 1000)).toBe(true)
      urls.push(...r.items.map((i: any) => i.url))
      cursor = r.next_cursor
    } while (cursor)
    // 30 saas pages, never the reserved or the unjudged one.
    expect(urls).toHaveLength(30)
    expect(new Set(urls).size).toBe(30)
    expect(urls.some((u) => u.includes('reserved') || u.includes('legacy'))).toBe(false)
    // A wrong key is just an anonymous caller.
    expect((await (await s.get('/api/corpus?q=saas', { authorization: 'Bearer nope' })).json()).access.mode).toBe('preview')
  })

  it('comma lists are any of the terms; punctuation never errors', async () => {
    const s = site()
    const auth = { authorization: `Bearer ${INTERNAL}` }
    const both = await (await s.get('/api/corpus?q=saas,crypto&limit=100', auth)).json()
    expect(both.items).toHaveLength(60)
    for (const q of ['foo(bar', 'a:b', '"', 'NEAR(x)', '-', ',,,'].map(encodeURIComponent)) expect((await s.get(`/api/corpus?q=${q}`, auth)).status).toBe(200)
    expect((await s.get('/api/corpus?cursor=abc', auth)).status).toBe(400)
    expect((await s.get('/api/corpus?limit=0', auth)).status).toBe(400)
  })

  it('x402 on the request pays limit x price and serves full text; a proof is used once; leftover becomes a key', async () => {
    const s = site({ pages: 6 })
    const paid = await s.get('/api/corpus?q=saas&limit=10', { 'payment-signature': proof('n1', '10000') })
    expect(paid.status).toBe(200)
    const body = await paid.json()
    expect(body.items).toHaveLength(3)
    expect(body.items[0].text.length).toBeGreaterThan(1000)
    expect(body.access).toMatchObject({ mode: 'x402', pages_charged: 3, credited: 7 })
    const key = paid.headers.get('x-corpus-key')!
    expect(key).toStartWith('pck_')
    expect(await (await s.get('/api/corpus/credits', { 'x-corpus-key': key })).json()).toMatchObject({ balance: 7 })
    expect((await s.get('/api/corpus?q=saas&limit=10', { 'payment-signature': proof('n1', '10000') })).status).toBe(402)
    // Underpaying is refused.
    expect((await s.get('/api/corpus?q=saas&limit=10', { 'payment-signature': proof('n2', '5000') })).status).toBe(402)
    // The key spends per page returned.
    const spent = await (await s.get('/api/corpus?q=crypto&limit=2', { 'x-corpus-key': key })).json()
    expect(spent.access).toMatchObject({ mode: 'key', pages_charged: 2, balance: 5 })
  })

  it('credit packs over x402: the offer, then a key', async () => {
    const s = site()
    const offer = await s.get('/api/corpus/credits?pages=2000')
    expect(offer.status).toBe(402)
    expect((await offer.json()).accepts[0].amount).toBe('2000000')
    const bought = await s.app.request(`${SITE}/api/corpus/credits?pages=2000`, { method: 'POST', headers: { 'payment-signature': proof('p1', '2000000') } }, { ip: '1.1.1.1' })
    expect(bought.status).toBe(200)
    const { key, balance } = await bought.json()
    expect(balance).toBe(2000)
    const r = await (await s.get('/api/corpus?q=saas&limit=50', { authorization: `Bearer ${key}` })).json()
    expect(r.access).toMatchObject({ mode: 'key', pages_charged: 30, balance: 1970 })
  })

  it('/api documents the price and the opt-out policy', async () => {
    const html = await (await site().get('/api')).text()
    for (const words of ['$1.00 per 1,000 pages', 'noai', 'tdm-reservation', 'GPTBot', 'q=saas,business,crypto', 'next_cursor']) expect(html).toContain(words)
  })
})

describe('corpus credits by CoinPay invoice', () => {
  it('opens one pay.agent invoice and credits the account once it is paid', async () => {
    const accounts = new Accounts(':memory:')
    let status = 'open'
    let created: any = null
    const payAgent = (async (input: any, init: any = {}) => {
      const u = new URL(String(input))
      if (init.method === 'POST') {
        created = JSON.parse(init.body)
        return Response.json({ id: 'inv_1', url: 'https://pay.agent.pit.world/i/inv_1', amount_usd: created.amount_usd })
      }
      if (u.pathname === '/api/v1/invoices/inv_1') return Response.json({ id: 'inv_1', amount_usd: created.amount_usd, description: created.description, status })
      return Response.json({ invoices: [] })
    }) as typeof fetch
    const billing = new CorpusBilling(accounts.db, { usdPer1000: 1 }, { invoicing: { payAgentUrl: 'https://pay.agent.pit.world', key: 'k', mailer: null, notifyTo: 'x@example.com', fetch: payAgent } as any })
    await expect(billing.buy('acct1', 'a@example.com', 7)).rejects.toThrow('Choose one of')
    expect(await billing.buy('acct1', 'a@example.com', 10)).toBe('https://pay.agent.pit.world/i/inv_1')
    expect(created).toMatchObject({ amount_usd: 10, to_email: 'a@example.com' })
    await billing.tick()
    expect(billing.balance('acct:acct1')).toBe(0)
    status = 'paid'
    await billing.tick()
    await billing.tick()
    expect(billing.balance('acct:acct1')).toBe(10_000)
  })
})
