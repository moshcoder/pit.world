import { describe, expect, it } from 'bun:test'
import { createBridgeClient, type BridgeClient } from '@profullstack/bridges'
import { Accounts, bridgeClient, bridgeSecret, loopbackRedirect, pkceS256, serviceHost } from '../src/accounts.ts'
import { CLI_CLIENT, type AccountDeps } from '../src/accounts-routes.ts'
import { createApp } from '../src/server.ts'
import { Boards, serviceRequest, type ServiceDeps } from '../src/services.ts'

const SITE = 'https://pit.world'
const KEY = 'test-bridge-key-0123456789-abcdefghijklmnop'
const ANTHONY = 'did:key:z6MkjzDfQuDV44duWNNbJrRCu2swsp1h6f417uMa3bLpdYki'

/** CoinPay stand-in: begin() points at a fake consent, complete() hands back whoever we say. */
function fakeCoinPay(user = { sub: ANTHONY, name: 'Anthony', email: 'a@example.com' }): BridgeClient {
  return {
    begin: async ({ returnTo } = {}) => ({ url: `https://coinpayportal.com/oauth/authorize?state=s1`, cookie: `sealed:${returnTo}`, maxAge: 600 }),
    complete: async (params: any, cookie: any) => {
      const q = new URLSearchParams(params)
      const returnTo = String(cookie ?? '').replace(/^sealed:/, '') || '/account'
      return q.get('state') === 's1' && q.get('code') === 'ok' ? { ok: true as const, user, returnTo } : { ok: false as const, error: 'state_mismatch', returnTo, prompt: null }
    },
  }
}

function world(extra: Partial<AccountDeps> = {}) {
  const accounts = new Accounts(':memory:')
  const deps: AccountDeps = { accounts, site: SITE, coinpay: null, bridgeKey: KEY, admins: [ANTHONY], coinpayClient: fakeCoinPay(), ...extra }
  const app = createApp({ keys: {}, fetch: (async () => new Response('{}')) as any, accounts: deps })
  const req = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.cookie) headers.set('cookie', init.cookie)
    return app.request(`${SITE}${path}`, { ...init, headers })
  }
  /** Sign in through the (fake) CoinPay round trip; returns the session cookie. */
  const signIn = async (next = '/account') => {
    const start = await req(`/auth/coinpay?next=${encodeURIComponent(next)}`)
    const state = /pw_cp_state=([^;]+)/.exec(start.headers.get('set-cookie') ?? '')![1]!
    const back = await req('/api/v1/coinpay/oauth/callback?code=ok&state=s1', { cookie: `pw_cp_state=${state}` })
    const session = /pw_session=([^;]+)/.exec(back.headers.getSetCookie().join('\n'))![1]!
    return { cookie: `pw_session=${session}`, location: back.headers.get('location') }
  }
  return { accounts, app, req, signIn }
}

const form = (fields: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: new URLSearchParams(fields) })

describe('names, hosts and secrets', () => {
  it('derives each site secret from one key, and only for our hosts', () => {
    // Fixed vector: the social service and the board provisioner must compute exactly this.
    expect(bridgeSecret('k', 'social.family.ancestry.pit.world')).toBe('PHm4YitxYG7pa8OtIg2tcoNANN-H1yNujUPpReOBO9A')
    expect(bridgeSecret(KEY, 'bbs.a.b.pit.world')).not.toBe(bridgeSecret(KEY, 'bbs.a.c.pit.world'))
    expect(bridgeClient('bbs.family.ancestry.pit.world', KEY)?.redirectUris).toEqual(['https://bbs.family.ancestry.pit.world/auth/bridge/callback'])
    expect(bridgeClient('family.ancestry.pit.world', KEY)).toBeNull()
    expect(bridgeClient('family.ancestry.pit.world', KEY, ['family.ancestry.pit.world'])).not.toBeNull()
    expect(bridgeClient('evil.example', KEY)).toBeNull()
  })

  it('reads social.<name> and bbs.<name> hosts', () => {
    expect(serviceHost('social.family.ancestry.pit.world')).toEqual({ service: 'social', name: 'family.ancestry', host: 'social.family.ancestry.pit.world' })
    expect(serviceHost('BBS.Seo.Rank.pit.world:443')).toEqual({ service: 'bbs', name: 'seo.rank', host: 'bbs.seo.rank.pit.world' })
    expect(serviceHost('social.pit.world')).toBeNull()
    expect(serviceHost('social.hacker.pit.world')).toBeNull() // an ending alone is not a name
    expect(serviceHost('family.ancestry.pit.world')).toBeNull()
    expect(serviceHost('bbs.a_b.c.pit.world')).toBeNull()
    expect(loopbackRedirect('http://127.0.0.1:8765/callback')).toBe(true)
    expect(loopbackRedirect('https://evil.example/cb')).toBe(false)
    expect(loopbackRedirect('http://127.0.0.1/cb')).toBe(false)
  })
})

describe('sign in with CoinPay', () => {
  it('makes one account per CoinPay id, with a session only after sign-in', async () => {
    const w = world()
    const home = await w.req('/')
    expect(home.headers.get('set-cookie')).toBeNull()
    expect((await w.req('/account')).headers.get('location')).toBe('/signin?next=/account')
    const { cookie, location } = await w.signIn('/account')
    expect(location).toBe('/account')
    const page = await (await w.req('/account', { cookie })).text()
    expect(page).toContain(ANTHONY)
    expect(page).toContain('pit.world admin')
    await w.signIn()
    expect(w.accounts.db.query('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 1 })
    // Search never sets or needs a cookie, signed in or not.
    expect((await w.req('/about', { cookie })).headers.get('set-cookie')).toBeNull()
  })

  it('refuses a forged callback and a cross-site form', async () => {
    const w = world()
    const bad = await w.req('/api/v1/coinpay/oauth/callback?code=ok&state=wrong', { cookie: 'pw_cp_state=sealed:/account' })
    expect(bad.headers.get('location')).toStartWith('/signin?error=state_mismatch')
    const { cookie } = await w.signIn()
    const cross = await w.req('/account/delete', { ...form({ confirm: 'yes' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' }, cookie })
    expect(cross.status).toBe(403)
    expect(w.accounts.db.query('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 1 })
    await w.req('/account/delete', { ...form({ confirm: 'yes' }), cookie })
    expect(w.accounts.db.query('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 0 })
  })

  it('only sends you back to pit.world itself', async () => {
    const w = world()
    expect((await w.signIn('https://evil.example/x')).location).toBe('/account')
    expect((await w.signIn('//evil.example/x')).location).toBe('/account')
    expect((await w.signIn(`${SITE}/bridge/authorize?client_id=x`)).location).toBe('/bridge/authorize?client_id=x')
    // Behind nginx our own URLs arrive as http://pit.world/...: still ours.
    expect((await w.signIn('http://pit.world/bridge/authorize?client_id=y')).location).toBe('/bridge/authorize?client_id=y')
  })
})

describe('sign-in for *.pit.world sites', () => {
  it('a board signs you in with your pit.world account, end to end', async () => {
    const w = world()
    const clientId = 'bbs.family.ancestry.pit.world'
    // The board side, exactly as tsbb runs it, with its fetch pointed at our app.
    const board = createBridgeClient({
      authorizeUrl: `${SITE}/bridge/authorize`,
      tokenUrl: `${SITE}/bridge/token`,
      clientId,
      clientSecret: bridgeSecret(KEY, clientId),
      redirectUri: `https://${clientId}/auth/bridge/callback`,
      fetch: ((input: any, init: any) => w.app.request(String(input), init)) as typeof fetch,
    })

    // Signed out and asked to answer silently: login_required, no page shown.
    const silent = await board.begin({ prompt: 'none', returnTo: '/f/general' })
    const quiet = await w.req(new URL(silent.url).pathname + new URL(silent.url).search)
    expect(new URL(quiet.headers.get('location')!).searchParams.get('error')).toBe('login_required')

    // Signed out, normal: off to sign in, then back to the same authorize request.
    const started = await board.begin({ returnTo: '/f/general' })
    const authorizePath = new URL(started.url).pathname + new URL(started.url).search
    // As production sees it: nginx terminates TLS, so the request URL is http://.
    const toSignin = await w.app.request(`http://pit.world${authorizePath}`)
    expect(toSignin.headers.get('location')).toBe(`${SITE}/signin?next=${encodeURIComponent(authorizePath)}`)
    const { cookie, location } = await w.signIn(new URL(toSignin.headers.get('location')!).searchParams.get('next')!)
    expect(location).toBe(authorizePath)
    const answered = await w.req(location!, { cookie })
    const callback = answered.headers.get('location')!
    expect(callback).toStartWith(`https://${clientId}/auth/bridge/callback?code=`)

    const result = await board.complete(callback, started.cookie)
    expect(result).toMatchObject({ ok: true, returnTo: '/f/general', user: { sub: ANTHONY, name: 'Anthony' } })
    expect((result as any).user.email_verified).not.toBe(true)
    // Once only.
    expect((await board.complete(callback, started.cookie)).ok).toBe(false)
    expect(w.accounts.grants(w.accounts.signIn({ sub: ANTHONY }).id).map((g) => g.client_id)).toEqual([clientId])
    expect(await (await w.req('/account', { cookie })).text()).toContain(clientId)
  })

  it('refuses hosts that are not ours and a wrong secret', async () => {
    const w = world()
    const evil = await w.req(`/bridge/authorize?client_id=evil.example&redirect_uri=https://evil.example/cb&response_type=code&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`)
    expect(evil.status).toBe(400)
    const forged = await w.req('/bridge/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'social.seo.rank.pit.world', client_secret: 'x'.repeat(43), grant_type: 'authorization_code', code: 'x' }) })
    expect(forged.status).toBe(401)
  })
})

describe('the pit CLI (OAuth 2.1, PKCE, loopback)', () => {
  it('signs in, gets a token, and the token works until revoked', async () => {
    const w = world()
    const { cookie } = await w.signIn()
    const verifier = 'v'.repeat(50)
    const redirect = 'http://127.0.0.1:8765/callback'
    const params = { response_type: 'code', client_id: CLI_CLIENT, redirect_uri: redirect, code_challenge: pkceS256(verifier), code_challenge_method: 'S256', state: 'xyz' }
    const consent = await w.req(`/oauth/authorize?${new URLSearchParams(params)}`, { cookie })
    expect(await consent.text()).toContain('Allow the pit CLI')
    const allowed = await w.req('/oauth/authorize', { ...form(params), cookie })
    const back = new URL(allowed.headers.get('location')!)
    expect(back.origin + back.pathname).toBe(redirect)
    expect(back.searchParams.get('state')).toBe('xyz')
    const tokenFor = (code: string, v = verifier) => w.req('/api/v1/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id: CLI_CLIENT, code, redirect_uri: redirect, code_verifier: v }) })
    expect((await tokenFor(back.searchParams.get('code')!, 'w'.repeat(50))).status).toBe(400)
    // A failed attempt spends the code, so a stolen code cannot be retried.
    expect((await tokenFor(back.searchParams.get('code')!)).status).toBe(400)

    const again = new URL((await w.req('/oauth/authorize', { ...form(params), cookie })).headers.get('location')!)
    const ok = (await (await tokenFor(again.searchParams.get('code')!)).json()) as any
    expect(ok.access_token).toStartWith('pw_')
    const me = (await (await w.req('/api/v1/me', { headers: { authorization: `Bearer ${ok.access_token}` } })).json()) as any
    expect(me).toMatchObject({ account: { sub: ANTHONY }, admin: true })
    await w.req('/api/v1/oauth/revoke', { method: 'POST', headers: { authorization: `Bearer ${ok.access_token}` } })
    expect((await w.req('/api/v1/me', { headers: { authorization: `Bearer ${ok.access_token}` } })).status).toBe(401)
    expect((await w.req(`/oauth/authorize?${new URLSearchParams({ ...params, redirect_uri: 'https://evil.example/cb' })}`, { cookie })).status).toBe(400)
  })
})

describe('social.<name> and bbs.<name>', () => {
  const access = (registered: string[]) => ({ resolve: async (name: string) => ({ name, nameRegistered: registered.includes(name) }) as any, rootPem: '' })
  const certs = (have: string[] = []) => {
    const asked: string[] = []
    return { asked, has: (h: string) => have.includes(h), issue: (h: string) => (asked.push(h), true) }
  }
  const req = (host: string, path = '/') => new Request(`http://127.0.0.1:8787${path}`, { headers: { host, cookie: 'pw_session=leak?' } })

  it('forwards social.<name> to the shared service with the name, never pit.world cookies wrongly', async () => {
    const seen: { url: string; headers: Headers }[] = []
    const deps: ServiceDeps = { access: access(['family.ancestry']), certs: certs(), socialUrl: 'http://127.0.0.1:8794', boards: null, fetch: (async (url: any, init: any) => (seen.push({ url: String(url), headers: new Headers(init.headers) }), new Response('feed', { headers: { 'content-encoding': 'gzip' } }))) as any }
    const res = await serviceRequest(req('social.family.ancestry.pit.world', '/t/genealogy?x=1'), serviceHost('social.family.ancestry.pit.world')!, '203.0.113.9', 'https', deps)
    expect(await res.text()).toBe('feed')
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(seen[0]!.url).toBe('http://127.0.0.1:8794/t/genealogy?x=1')
    expect(seen[0]!.headers.get('x-pit-name')).toBe('family.ancestry')
    expect(seen[0]!.headers.get('host')).toBe('social.family.ancestry.pit.world')
    expect(seen[0]!.headers.get('x-real-ip')).toBe('203.0.113.9')
    const missing = await serviceRequest(req('social.nope.ancestry.pit.world'), serviceHost('social.nope.ancestry.pit.world')!, '203.0.113.9', 'https', deps)
    expect(missing.status).toBe(404)
  })

  it('one certificate per name covers its social and bbs hosts', async () => {
    const c = certs()
    const deps: ServiceDeps = { access: access(['seo.rank']), certs: c, socialUrl: null, boards: null }
    const res = await serviceRequest(req('bbs.seo.rank.pit.world'), serviceHost('bbs.seo.rank.pit.world')!, '1.2.3.4', 'http', deps)
    expect(res.status).toBe(503)
    expect(c.asked).toEqual(['seo.rank.pit.world'])
    const ready = await serviceRequest(req('bbs.seo.rank.pit.world', '/f'), serviceHost('bbs.seo.rank.pit.world')!, '1.2.3.4', 'http', { ...deps, certs: certs(['bbs.seo.rank.pit.world']) })
    expect(ready.status).toBe(301)
    expect(ready.headers.get('location')).toBe('https://bbs.seo.rank.pit.world/f')
  })

  it('makes a board on the first visit, then forwards to it', async () => {
    const boards = new Boards(':memory:', { command: '/nonexistent/pit-bbs-provision', max: 2 })
    let up = false
    const deps: ServiceDeps = { access: access(['family.ancestry', 'seo.rank', 'chovy.hacker']), certs: certs(), socialUrl: null, boards, fetch: (async (url: any) => (up ? new Response(`board at ${url}`) : Promise.reject(new Error('ECONNREFUSED')))) as any }
    const first = await serviceRequest(req('bbs.family.ancestry.pit.world'), serviceHost('bbs.family.ancestry.pit.world')!, '1.2.3.4', 'https', deps)
    expect(first.status).toBe(503)
    expect(await first.text()).toContain('Setting up the board for family.ancestry')
    expect(boards.board('family.ancestry')?.port).toBe(9100)
    up = true
    expect(await (await serviceRequest(req('bbs.family.ancestry.pit.world', '/f/1'), serviceHost('bbs.family.ancestry.pit.world')!, '1.2.3.4', 'https', deps)).text()).toBe('board at http://127.0.0.1:9100/f/1')
    boards.provision('seo.rank')
    const capped = await serviceRequest(req('bbs.chovy.hacker.pit.world'), serviceHost('bbs.chovy.hacker.pit.world')!, '1.2.3.4', 'https', deps)
    expect(await capped.text()).toContain('as many boards as it can')
    expect(boards.list().map((b) => [b.name, b.port])).toEqual([['family.ancestry', 9100], ['seo.rank', 9101]])
  })
})
