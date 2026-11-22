import { describe, expect, test } from 'bun:test'
import { AB_COOKIE, BuildAb, isBotUa, newVisitorId, refreshPaid, twoProportionP, validVisitorId, variantFor } from '../src/build-ab.ts'
import { createApp } from '../src/server.ts'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
const cookieOf = (res: Response) => /pit_build_ab=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]

describe('build A/B assignment', () => {
  test('ids are random, valid and assign about half to each side, the same way every time', () => {
    const ids = Array.from({ length: 2000 }, newVisitorId)
    expect(new Set(ids).size).toBe(2000)
    expect(ids.every(validVisitorId)).toBe(true)
    const b = ids.filter((id) => variantFor(id) === 'b').length
    expect(b).toBeGreaterThan(900)
    expect(b).toBeLessThan(1100)
    for (const id of ids.slice(0, 50)) expect(variantFor(id)).toBe(variantFor(id))
    // A new test name reshuffles.
    expect(ids.slice(0, 200).some((id) => variantFor(id, 'other-test') !== variantFor(id))).toBe(true)
  })

  test('bad ids are refused and crawlers are flagged', () => {
    expect(validVisitorId('x')).toBe(false)
    expect(validVisitorId('v<script>alert(1)</script>')).toBe(false)
    expect(isBotUa('Googlebot/2.1')).toBe(true)
    expect(isBotUa('curl/8.5.0')).toBe(true)
    expect(isBotUa('')).toBe(true)
    expect(isBotUa(UA)).toBe(false)
  })

  test('the significance note', () => {
    expect(twoProportionP(0, 10, 0, 10)).toBeNull()
    expect(twoProportionP(5, 0, 1, 10)).toBeNull()
    expect(twoProportionP(10, 100, 10, 100)!).toBeCloseTo(1, 5)
    // 10% vs 25% on 100 a side is about p = 0.005.
    expect(twoProportionP(10, 100, 25, 100)!).toBeGreaterThan(0.003)
    expect(twoProportionP(10, 100, 25, 100)!).toBeLessThan(0.008)
  })
})

describe('/build A/B test', () => {
  const payAgent = (paid: Set<string>) =>
    (async (url: string | URL, init: RequestInit = {}) => {
      const u = String(url)
      if (init.method === 'POST') {
        const n = Math.random().toString(36).slice(2, 8)
        return new Response(JSON.stringify({ id: `inv-${n}`, number: 'INV-1', url: `https://pa.test/i/inv-${n}` }), { status: 201 })
      }
      const id = u.split('/').pop()!
      return new Response(JSON.stringify({ id, status: paid.has(id) ? 'paid' : 'sent' }), { status: 200 })
    }) as typeof fetch

  const setup = () => {
    const ab = new BuildAb()
    const paid = new Set<string>()
    const app = createApp({ keys: {}, buildAb: ab, adminToken: 'admin', buildInvoicing: { payAgentUrl: 'https://pa.test', key: 'pa_test', fetch: payAgent(paid), guard: { minAgeMs: 0 } } })
    const get = (path: string, cookie?: string, ua = UA) => app.request(path, { headers: { 'user-agent': ua, ...(cookie ? { cookie: `${AB_COOKIE}=${cookie}` } : {}) } }, { ip: '198.51.100.7' })
    const post = (path: string, form: Record<string, string>, cookie: string) =>
      app.request(path, { method: 'POST', body: new URLSearchParams(form).toString(), headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded', cookie: `${AB_COOKIE}=${cookie}` } }, { ip: '198.51.100.7' })
    return { ab, app, get, post, paid }
  }

  test('a visitor keeps their variant: the cookie is set once and the same page comes back', async () => {
    const { get, ab } = setup()
    const first = await get('/build')
    const id = cookieOf(first)!
    expect(validVisitorId(id)).toBe(true)
    expect(first.headers.get('set-cookie')).toContain('Path=/build')
    expect(first.headers.get('set-cookie')).toContain('HttpOnly')
    const html = await first.text()
    const variant = variantFor(id)
    expect(html).toContain(variant === 'a' ? 'action="/build/go"' : 'action="/build/plan"')
    for (let i = 0; i < 3; i++) {
      const again = await get('/build', id)
      expect(again.headers.get('set-cookie')).toBeNull()
      expect(await again.text()).toContain(variant === 'a' ? 'Start building' : 'See what you get')
    }
    expect((ab.db.query("SELECT COUNT(*) AS n FROM build_ab_events WHERE step = 'view' AND visitor = ?").get(id) as { n: number }).n).toBe(4)
    expect((ab.db.query('SELECT DISTINCT variant FROM build_ab_events WHERE visitor = ?').all(id) as Array<{ variant: string }>).map((r) => r.variant)).toEqual([variant])
  })

  test('?variant= forces a page for QA and is kept out of the report', async () => {
    const { get, ab } = setup()
    const b = await get('/build?variant=b')
    expect(await b.text()).toContain('Apps these agents built')
    const forced = cookieOf(b)!
    expect(forced.endsWith('~b')).toBe(true)
    // The forced choice sticks without the query.
    expect(await (await get('/build', forced)).text()).toContain('action="/build/plan"')
    const a = await get('/build?variant=a', forced)
    expect(await a.text()).toContain('action="/build/go"')
    expect(cookieOf(a)!.endsWith('~a')).toBe(true)
    expect((ab.db.query('SELECT COUNT(*) AS n FROM build_ab_events WHERE qa = 0').get() as { n: number }).n).toBe(0)
    expect(ab.report().arms.every((arm) => arm.viewed === 0)).toBe(true)
  })

  test('A: Start building is counted, then handed to chovy.com with the variant in ref', async () => {
    const { get, ab } = setup()
    const id = 'vAAAAAAAAAAAAAAAAAA'
    const variant = variantFor(id)
    await get('/build', id)
    await get('/build/seen.gif', id)
    const go = await get(`/build/go?idea=${encodeURIComponent('A booking page for my barbershop')}`, id)
    expect(go.status).toBe(302)
    const to = new URL(go.headers.get('location')!)
    expect(to.origin + to.pathname).toBe('https://chovy.com/start')
    expect(to.searchParams.get('idea')).toBe('A booking page for my barbershop')
    expect(to.searchParams.get('plan')).toBe('starter')
    expect(to.searchParams.get('ref')).toBe(`pitworld-${variant}`)
    const arm = ab.report().arms.find((x) => x.variant === variant)!
    expect(arm).toMatchObject({ viewed: 1, seen: 1, idea: 1, handoff: 1, checkout: 0 })
    expect((await get('/build/go')).headers.get('location')).toBe('/build')
  })

  test('B: the idea stays on pit.world, step 2 asks for an email, the invoice is a checkout, a paid invoice is counted', async () => {
    const { app, get, post, ab, paid } = setup()
    const id = 'vBBBBBBBBBBBBBBBBBBB'
    const forced = `${id}~b`
    // QA-forced rows stay out of the report, so read the raw rows here.
    await get('/build', forced)
    await get('/build/seen.gif', forced)
    const plan = await post('/build/plan', { idea: 'A booking page for my barbershop\nwith reminders' }, forced)
    expect(plan.status).toBe(200)
    const html = await plan.text()
    expect(html).toContain('Here is what you get')
    expect(html).toContain('A booking page for my barbershop')
    expect(html).toContain('action="/build/invoice"')
    expect(html).toContain('name="idea" value="A booking page for my barbershop')
    expect(html).toContain('/build/go?idea=')
    const token = /name="fg_token" value="([^"]+)"/.exec(html)![1]!
    const inv = await post('/build/invoice', { fg_token: token, idea: 'A booking page for my barbershop\nwith reminders', email: 'pat@example.com', name: 'Pat' }, forced)
    expect(inv.status).toBe(302)
    expect(inv.headers.get('location')).toMatch(/^https:\/\/pa\.test\/i\/inv-/)
    const steps = (ab.db.query('SELECT step, variant, qa, ref FROM build_ab_events WHERE visitor = ? ORDER BY id').all(id) as Array<{ step: string; variant: string; qa: number; ref: string | null }>)
    expect(steps.map((s) => s.step)).toEqual(['view', 'seen', 'idea', 'checkout'])
    expect(steps.every((s) => s.variant === 'b' && s.qa === 1)).toBe(true)
    expect(steps[3]!.ref).toMatch(/^inv-/)

    // The same journey unforced is in the report, and the paid check finds the payment.
    const real = Array.from({ length: 50 }, newVisitorId).find((v) => variantFor(v) === 'b')!
    await get('/build', real)
    await get('/build/seen.gif', real)
    const page = await (await post('/build/plan', { idea: 'A shop for my candles' }, real)).text()
    const t2 = /name="fg_token" value="([^"]+)"/.exec(page)![1]!
    const inv2 = await post('/build/invoice', { fg_token: t2, idea: 'A shop for my candles', email: 'sam@example.com' }, real)
    const invoiceId = inv2.headers.get('location')!.split('/').pop()!
    expect((await app.request('/api/admin/build-ab.json')).status).toBe(401)
    let report = await (await app.request('/api/admin/build-ab.json', { headers: { authorization: 'Bearer admin' } })).json()
    expect(report.arms.find((x: any) => x.variant === 'b')).toMatchObject({ viewed: 1, seen: 1, idea: 1, checkout: 1, paid: 0 })
    expect(report.text).toContain('Too early to call')
    paid.add(invoiceId)
    report = await (await app.request('/api/admin/build-ab.json', { headers: { authorization: 'Bearer admin' } })).json()
    expect(report.arms.find((x: any) => x.variant === 'b')).toMatchObject({ checkout: 1, paid: 1 })
    // Paid once is paid once.
    expect(await refreshPaid(ab, 'https://pa.test', payAgent(paid))).toBe(0)
  })

  test('bots: a crawler is recorded as bot and a visitor who never loads the image is not in the denominator', async () => {
    const { get, ab } = setup()
    const crawler = await get('/build', undefined, 'Mozilla/5.0 (compatible; GPTBot/1.2)')
    expect(crawler.status).toBe(200)
    const htmlOnly = 'vCCCCCCCCCCCCCCCCCCC'
    await get('/build', htmlOnly)
    await get(`/build/go?idea=spam`, htmlOnly)
    const r = ab.report()
    expect(r.arms.reduce((n, a) => n + a.viewed, 0)).toBe(1)
    expect(r.arms.reduce((n, a) => n + a.seen + a.idea, 0)).toBe(0)
    expect((ab.db.query('SELECT COUNT(*) AS n FROM build_ab_events WHERE bot = 1').get() as { n: number }).n).toBe(1)
    // The image never errors and never records without a cookie.
    const px = await get('/build/seen.gif')
    expect(px.headers.get('content-type')).toBe('image/gif')
  })

  test('nothing personal is stored', async () => {
    const { get, post, ab } = setup()
    const id = 'vDDDDDDDDDDDDDDDDDDD~b'
    await get('/build', id)
    await post('/build/plan', { idea: 'secret plan for pat@example.com' }, id)
    const dump = JSON.stringify(ab.db.query('SELECT * FROM build_ab_events').all())
    expect(dump).not.toContain('secret')
    expect(dump).not.toContain('example.com')
    expect(dump).not.toContain('198.51.100.7')
  })
})
