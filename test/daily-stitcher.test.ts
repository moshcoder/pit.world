import { describe, expect, test } from 'bun:test'
import type { BridgeClient } from '@profullstack/bridges'
import { createDailyStitcher } from '../src/daily-stitcher.js'

const ownerToken = `pw_${'o'.repeat(30)}`
const guestToken = `pw_${'g'.repeat(30)}`
const identities = async (token: string) => token === ownerToken ? { sub: 'did:coinpay:owner' } : token === guestToken ? { sub: 'did:coinpay:guest' } : null

function app(ownerSub: string | null = 'did:coinpay:owner') {
  return createDailyStitcher({
    ownerSub,
    bridgeKey: 'test-bridge-key-that-is-long-enough-for-hmac',
    resolveBearer: identities,
    now: () => Date.UTC(2026, 10, 2),
  }).app
}

describe('Daily Stitcher storefront', () => {
  test('serves only the supplied quilt photograph and truthful coming-soon copy', async () => {
    const site = app()
    const response = await site.request('/')
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain('A home for handmade quilts and the stories behind the stitches.')
    expect(html).toContain('No quilts are listed for sale')
    expect(html).toContain('A channel has not been connected to this site yet.')
    expect(html).not.toContain('mailto:')
    expect(html).not.toContain('price="$')
    expect(html).not.toContain('youtube.com')

    const image = await site.request('/daily-stitcher-quilt.jpg')
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/jpeg')
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(100_000)
  })

  test('starts a CoinPay-backed bridge login for the exact host and fixed callback', async () => {
    const site = app()
    const response = await site.request('/owner/signin')
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe('https://pit.world')
    expect(location.pathname).toBe('/bridge/authorize')
    expect(location.searchParams.get('client_id')).toBe('daily.stitcher.pit.world')
    expect(location.searchParams.get('redirect_uri')).toBe('https://daily.stitcher.pit.world/auth/bridge/callback')
    expect(location.searchParams.get('prompt')).toBe('login')
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax')
  })

  test('keeps publishing closed until the owner CoinPay DID is configured', async () => {
    const site = app(null)
    const response = await site.request('/api/owner/proposals', {
      headers: { authorization: `Bearer ${ownerToken}` },
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'owner_identity_not_configured' })
  })

  test('requires the configured CoinPay owner to approve a journal proposal', async () => {
    const site = app()
    const proposed = await site.request('/api/owner/proposals', {
      method: 'POST',
      headers: { authorization: `Bearer ${guestToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'At the cutting table', body: 'A new note from the studio.' }),
    })
    expect(proposed.status).toBe(201)
    const { story } = await proposed.json() as { story: { id: string } }

    const denied = await site.request(`/api/owner/proposals/${story.id}/approve`, {
      method: 'POST', headers: { authorization: `Bearer ${guestToken}` },
    })
    expect(denied.status).toBe(403)

    const approved = await site.request(`/api/owner/proposals/${story.id}/approve`, {
      method: 'POST', headers: { authorization: `Bearer ${ownerToken}` },
    })
    expect(approved.status).toBe(200)
    expect(await approved.json()).toMatchObject({ ok: true, status: 'published' })
    expect(await (await site.request('/')).text()).toContain('A new note from the studio.')
  })

  test('bridges a signed-in CoinPay DID into an owner session without exposing its token', async () => {
    const bridge: BridgeClient = {
      begin: async () => ({ url: 'https://pit.world/bridge/authorize?client_id=daily.stitcher.pit.world', cookie: 'sealed-state', maxAge: 600 }),
      complete: async (_callback, cookie) => cookie === 'sealed-state'
        ? { ok: true, user: { sub: 'did:coinpay:owner', name: 'Owner' }, returnTo: '/owner' }
        : { ok: false, error: 'expired_state', returnTo: '/owner', prompt: 'login' },
    }
    const site = createDailyStitcher({ ownerSub: 'did:coinpay:owner', bridgeKey: 'test-bridge-key-that-is-long-enough-for-hmac', bridge }).app
    const started = await site.request('/owner/signin')
    const stateCookie = started.headers.get('set-cookie')!.split(';', 1)[0]!
    const callback = await site.request('/auth/bridge/callback?code=opaque&state=state', { headers: { cookie: stateCookie } })
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/owner')
    const session = callback.headers.get('set-cookie')!.split(', ').find((v) => v.startsWith('daily_stitcher_session='))!
    const sessionCookie = session.split(';', 1)[0]!
    const ownerPage = await site.request('/owner', { headers: { cookie: sessionCookie } })
    expect(ownerPage.status).toBe(200)
    expect(await ownerPage.text()).toContain('Review the stories.')
    expect(sessionCookie).not.toContain('did:coinpay:owner')
  })
})
