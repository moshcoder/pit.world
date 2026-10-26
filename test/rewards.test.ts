import { describe, expect, it } from 'bun:test'
import type { BridgeClient } from '@profullstack/bridges'
import { Accounts } from '../src/accounts.ts'
import type { AccountDeps } from '../src/accounts-routes.ts'
import { Promoters } from '../src/promoters.ts'
import { readServerOrder, RewardError, Rewards, SERVER_MONTHS } from '../src/rewards.ts'
import { createApp } from '../src/server.ts'
import type { Mailer } from '../src/newsletter.ts'

const SITE = 'https://pit.world'
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE1RmTtHyAUKZ5Yh9lC4D8n6hLwAAAAAAAAAAAAAAAAA you@laptop'

function world(opts: { mailer?: Mailer | null } = {}) {
  let who = { sub: 'did:key:alice', name: 'Alice', email: 'alice@example.com' }
  const coinpay: BridgeClient = {
    begin: async ({ returnTo } = {}) => ({ url: 'https://coinpayportal.com/oauth/authorize?state=s1', cookie: `sealed:${returnTo}`, maxAge: 600 }),
    complete: async (_params: any, cookie: any) => ({ ok: true as const, user: who, returnTo: String(cookie ?? '').replace(/^sealed:/, '') || '/account' }),
  }
  const accounts = new Accounts(':memory:')
  const sent: Parameters<Mailer>[0][] = []
  const mailer: Mailer | null = opts.mailer === undefined ? async (m) => void sent.push(m) : opts.mailer
  const promoters = new Promoters(':memory:')
  const rewards = new Rewards(accounts.db, { mailer, notifyTo: 'builder@example.com', promoterCode: (c) => Boolean(promoters.byCode(c)) })
  const deps: AccountDeps = { accounts, site: SITE, coinpay: null, bridgeKey: null, coinpayClient: coinpay }
  const app = createApp({ keys: {}, fetch: (async () => new Response('{}')) as any, accounts: deps, promoters, rewards })
  const req = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.cookie) headers.set('cookie', init.cookie)
    return app.request(`${SITE}${path}`, { ...init, headers })
  }
  /** Sign in as `sub` through the fake CoinPay round trip, landing on `next`. */
  const signIn = async (sub: string, next = '/account') => {
    who = { sub: `did:key:${sub}`, name: sub, email: `${sub}@example.com` }
    const start = await req(`/auth/coinpay?next=${encodeURIComponent(next)}`)
    const state = /pw_cp_state=([^;]+)/.exec(start.headers.get('set-cookie') ?? '')![1]!
    const back = await req('/api/v1/coinpay/oauth/callback?code=ok&state=s1', { cookie: `pw_cp_state=${state}` })
    const session = /pw_session=([^;]+)/.exec(back.headers.getSetCookie().join('\n'))![1]!
    const account = accounts.db.query<{ id: string }, [string]>('SELECT id FROM accounts WHERE sub = ?').get(`did:key:${sub}`)!
    return { cookie: `pw_session=${session}`, location: back.headers.get('location') ?? '', id: account.id }
  }
  return { accounts, rewards, promoters, app, req, signIn, sent }
}

const post = (fields: Record<string, string>, cookie: string) => ({ method: 'POST', cookie, headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: new URLSearchParams(fields) })
const okOf = (location: string | null) => new URL(location ?? '', SITE).searchParams.get('ok')

describe('credit codes: months of a Moshpit server', () => {
  it('redeems a minted code on /account, once', async () => {
    const w = world()
    const { code } = await w.rewards.credits.mint({ grant: { unit: SERVER_MONTHS, amount: 2 }, label: 'test' })
    const a = await w.signIn('alice')
    let page = await (await w.req('/account', { cookie: a.cookie })).text()
    expect(page).toContain('Have a code?')
    expect(page).toContain('Server months: <b>0</b>')
    const r = await w.req('/account/redeem', post({ code }, a.cookie))
    expect(okOf(r.headers.get('location'))).toBe('Redeemed: 2 months of a Moshpit server.')
    page = await (await w.req('/account', { cookie: a.cookie })).text()
    expect(page).toContain('Server months: <b>2</b>')
    expect(page).toContain('Use a month on a Moshpit server')
    expect(okOf((await w.req('/account/redeem', post({ code }, a.cookie))).headers.get('location'))).toBe('You already redeemed that code.')
    expect(okOf((await w.req('/account/redeem', post({ code: 'CR-NOPE-NOPE-NOPE-NOPE' }, a.cookie))).headers.get('location'))).toBe('That code is not valid.')
    // A single-use code is used up for the next person.
    const b = await w.signIn('bob')
    expect(okOf((await w.req('/account/redeem', post({ code }, b.cookie))).headers.get('location'))).toBe('That code has been used.')
  })

  it('refuses a form from another site and a signed-out visitor', async () => {
    const w = world()
    const a = await w.signIn('alice')
    const cross = await w.req('/account/redeem', { ...post({ code: 'x' }, a.cookie), headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' } })
    expect(cross.status).toBe(403)
    expect((await w.req('/account/redeem', { method: 'POST' })).headers.get('location')).toStartWith('/signin')
  })

  it('spends a month through the same server order a paid month makes, and refunds it if the order cannot go out', async () => {
    const w = world()
    const { code } = await w.rewards.credits.mint({ grant: { unit: SERVER_MONTHS, amount: 1 } })
    const a = await w.signIn('alice')
    await w.req('/account/redeem', post({ code }, a.cookie))
    const bad = await w.req('/account/server', post({ names: 'not a name', username: 'alice', ssh_key: KEY }, a.cookie))
    expect(okOf(bad.headers.get('location'))).toContain('is not a Moshpit name')
    expect(await w.rewards.serverMonths(a.id)).toBe(1)
    const r = await w.req('/account/server', post({ names: 'shop.alice blog.alice', username: 'alice', ssh_key: KEY }, a.cookie))
    expect(okOf(r.headers.get('location'))).toBe('Ordered: a Moshpit server month for shop.alice blog.alice. We reply when it is ready.')
    expect(await w.rewards.serverMonths(a.id)).toBe(0)
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.to).toBe('builder@example.com')
    expect(w.sent[0]!.text).toContain('paid with a pit.world credit')
    expect(w.sent[0]!.text).toContain('Names: shop.alice blog.alice')
    expect(w.sent[0]!.text).toContain(KEY)
    expect(okOf((await w.req('/account/server', post({ names: 'shop.alice', username: 'alice', ssh_key: KEY }, a.cookie))).headers.get('location'))).toBe('You have no server months. Redeem a code first.')

    const down = world({ mailer: async () => { throw new Error('resend down') } })
    const b = await down.signIn('bob')
    await down.rewards.credits.grant(b.id, { unit: SERVER_MONTHS, amount: 1 }, 'test')
    const failed = await down.req('/account/server', post({ names: 'shop.bob', username: 'bob', ssh_key: KEY }, b.cookie))
    expect(okOf(failed.headers.get('location'))).toContain('your month is back')
    expect(await down.rewards.serverMonths(b.id)).toBe(1)
  })

  it('reads a server order strictly', () => {
    expect(readServerOrder({ names: 'Shop.Alice, shop.alice', username: 'alice', ssh_key: KEY }).names).toEqual(['shop.alice'])
    expect(() => readServerOrder({ names: 'shop.alice', username: '1x', ssh_key: KEY })).toThrow(RewardError)
    expect(() => readServerOrder({ names: 'shop.alice', username: 'alice', ssh_key: 'hello' })).toThrow('SSH public key')
  })

  it('redeems from the CLI with a pit login token', async () => {
    const w = world()
    const a = await w.signIn('alice')
    const token = w.accounts.createToken(a.id, 'pit CLI')
    const { code } = await w.rewards.credits.mint({ grant: { unit: SERVER_MONTHS, amount: 3 } })
    const r = await w.req('/api/v1/redeem', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
    expect(await r.json()).toMatchObject({ ok: true, server_months: 3 })
    expect((await w.req('/api/v1/redeem', { method: 'POST', body: '{}' })).status).toBe(401)
    expect(await (await w.req('/api/v1/credits', { headers: { authorization: `Bearer ${token}` } })).json()).toMatchObject({ server_months: 3 })
  })
})

describe('invites: three each, for new accounts only', () => {
  it('makes three invites, a new account spends one on sign-in, an existing account cannot', async () => {
    const w = world()
    const a = await w.signIn('alice')
    const made = await (await w.req('/account/invites', post({ note: 'for Carol' }, a.cookie))).text()
    const link = /https:\/\/pit\.world\/i\/(INV-[A-Z0-9-]+)/.exec(made)!
    expect(link).toBeTruthy()
    expect(made).toContain('<b>2 invites</b> left of 3')

    // The landing sets no cookie and sends the invite through sign-in.
    const landing = await w.req(`/i/${link[1]}`)
    expect(landing.headers.get('set-cookie')).toBeNull()
    const html = await landing.text()
    const next = decodeURIComponent(/href="\/signin\?next=([^"]+)"/.exec(html)![1]!.replace(/&amp;/g, '&'))
    expect(next).toBe(`/account?invite=${link[1]}`)

    // An existing account keeps the invite unused.
    await w.signIn('bob')
    const bobAgain = await w.signIn('bob', next)
    expect(okOf(bobAgain.location)).toContain('the invite is still unused')
    expect(await w.rewards.affiliates.invitedBy(bobAgain.id)).toBeNull()

    // A new one spends it.
    const carol = await w.signIn('carol', next)
    expect(okOf(carol.location)).toBe('Invite accepted. Welcome in.')
    expect(new URL(carol.location, SITE).searchParams.get('invite')).toBeNull()
    expect(await w.rewards.affiliates.invitedBy(carol.id)).toBe(a.id)
    // ...and only once.
    const dave = await w.signIn('dave', next)
    expect(okOf(dave.location)).toBe('That invite has already been used.')
    // No bonus: an invite is only the way in.
    expect(await w.rewards.serverMonths(carol.id)).toBe(0)
    expect(await w.rewards.serverMonths(a.id)).toBe(0)

    await w.req('/account/invites', post({}, a.cookie))
    await w.req('/account/invites', post({}, a.cookie))
    const none = await (await w.req('/account/invites', post({}, a.cookie))).text()
    expect(none).toContain('You have used all your invites.')
    expect(none).toContain('1 person joined on yours')
  })

  it('makes and lists invites from the CLI', async () => {
    const w = world()
    const a = await w.signIn('alice')
    const token = w.accounts.createToken(a.id, 'pit CLI')
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const made = (await (await w.req('/api/v1/invites', { method: 'POST', headers: auth, body: JSON.stringify({ note: 'x' }) })).json()) as any
    expect(made.link).toStartWith('https://pit.world/i/INV-')
    expect(made.left).toBe(2)
    const list = (await (await w.req('/api/v1/invites', { headers: auth })).json()) as any
    expect(list.quota).toEqual({ total: 3, used: 1, left: 2 })
    expect(list.affiliate_link).toStartWith('https://pit.world/join?ref=')
  })
})

describe('?ref= affiliate links', () => {
  it('lands on /join without a cookie and attributes only a new account, first touch', async () => {
    const w = world()
    const a = await w.signIn('alice')
    const code = await w.rewards.affiliates.affiliateCode(a.id)
    const home = await w.req(`/?ref=${code}`)
    expect(home.status).toBe(302)
    expect(home.headers.get('location')).toBe(`/join?ref=${code}`)
    const join = await w.req(`/join?ref=${code}`)
    expect(join.headers.get('set-cookie')).toBeNull()
    expect(await join.text()).toContain(encodeURIComponent(`/account?ref=${code}`))

    const erin = await w.signIn('erin', `/account?ref=${code}`)
    expect(erin.location).toBe('/account')
    expect(await w.rewards.affiliates.affiliateOf(erin.id)).toBe(a.id)
    await w.signIn('bob')
    const bob = await w.signIn('bob', `/account?ref=${code}`)
    expect(await w.rewards.affiliates.affiliateOf(bob.id)).toBeNull()
  })

  it('leaves promoter codes to the promoter program', async () => {
    const w = world()
    const a = await w.signIn('alice')
    const promoter = w.promoters.join(a.id)
    expect((await w.req(`/?ref=${promoter.code}`)).headers.get('location')).toBe(`/promote?ref=${promoter.code}`)
    const frank = await w.signIn('frank', `/account?ref=${promoter.code}`)
    expect(await w.rewards.affiliates.affiliateOf(frank.id)).toBeNull()
    // A search with a ref is still a search.
    expect((await w.req(`/?q=hello&ref=${promoter.code}`)).status).not.toBe(302)
  })
})
