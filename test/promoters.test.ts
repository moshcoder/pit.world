import { describe, expect, it } from 'bun:test'
import { Accounts } from '../src/accounts.js'
import { createApp } from '../src/server.js'
import { CODE_RE, COMMISSION_RATE, Promoters, TRIAL_MS } from '../src/promoters.js'

function app() {
  const promoters = new Promoters(':memory:')
  const accounts: Accounts = new Accounts(':memory:')
  const hono = createApp({ keys: {}, promoters, accounts: { accounts, site: 'https://pit.world', coinpay: null, bridgeKey: null } })
  const get = (path: string, ip = '203.0.113.7') => hono.request(path, {}, { ip })
  const post = (path: string, ip = '203.0.113.7') => hono.request(path, { method: 'POST' }, { ip })
  return { promoters, get, post }
}

describe('Promoters', () => {
  it('join is idempotent and issues a readable code', () => {
    const p = new Promoters(':memory:')
    const a = p.join('acc-1')
    const b = p.join('acc-1')
    expect(a.code).toBe(b.code)
    expect(CODE_RE.test(a.code)).toBe(true)
    expect(p.count()).toBe(1)
  })

  it('byCode rejects malformed codes without a DB hit', () => {
    const p = new Promoters(':memory:')
    expect(p.byCode('not a code')).toBeNull()
    expect(p.byCode('')).toBeNull()
  })

  it('starts a 30-day trial and attributes a valid referrer exactly once', () => {
    const now = Date.UTC(2026, 0, 1)
    const p = new Promoters(':memory:', () => now)
    const promoter = p.join('promoter-1')
    const m = p.startMembership('visitor-1', promoter.code)
    expect(m.status).toBe('trialing')
    expect(m.trial_end).toBe(now + TRIAL_MS)
    expect(m.referred_by).toBe(promoter.code)
    // Idempotent: a second start keeps the first attribution.
    expect(p.startMembership('visitor-1', 'anothercode').referred_by).toBe(promoter.code)
  })

  it('never attributes a self-referral or an unknown code', () => {
    const p = new Promoters(':memory:')
    const promoter = p.join('promoter-1')
    expect(p.startMembership('promoter-1', promoter.code).referred_by).toBeNull()
    expect(p.startMembership('visitor-2', 'boguscode').referred_by).toBeNull()
  })

  it('accrues 20% commission only for a referred member and only on spend', () => {
    const p = new Promoters(':memory:')
    const promoter = p.join('promoter-1')
    p.startMembership('visitor-1', promoter.code)
    expect(p.recordSpend('visitor-1', 4900, 'build')).toBe(Math.round(4900 * COMMISSION_RATE)) // $49 build -> $9.80
    p.recordSpend('visitor-1', 200, 'hosting') // $2/mo -> $0.40
    const stats = p.stats('promoter-1')!
    expect(stats.referred).toBe(1)
    expect(stats.commission_cents).toBe(980 + 40)
    // An un-referred member earns the promoter nothing.
    p.startMembership('visitor-3', null)
    expect(p.recordSpend('visitor-3', 10000)).toBe(0)
  })
})

describe('/promote routes', () => {
  it('serves the public offer page with the rate and prices', async () => {
    const { get } = app()
    const res = await get('/promote')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('20%')
    expect(html).toContain('Promoter program')
    expect(html).toContain('30 days')
  })

  it('requires sign-in to become a promoter', async () => {
    const { post } = app()
    const res = await post('/promote/join')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/signin')
  })

  it('redirects an unknown short link to the offer', async () => {
    const { get } = app()
    const res = await get('/r/zzzzzzzz')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/promote')
  })
})
