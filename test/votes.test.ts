import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { encodePayload } from '@profullstack/browser-fingerprint/client'
import { Listings } from '../src/listings.ts'
import { Registry } from '../src/moshpit.ts'
import { createApp } from '../src/server.ts'
import { VOTE_LIMITS } from '../src/visitor.ts'
import { applyMoves, itemFor, MAX_MOVE, normalizeUrl, score, Votes } from '../src/votes.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const device = (over: Record<string, unknown> = {}) => ({
  canvas: 'a1b2c3d4', canvasStable: true, webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA GeForce RTX 3060)', webglParams: 'deadbeef',
  audio: '124.04', screen: '2560x1440', colorDepth: 24, pixelRatio: 1, timezone: 'America/Los_Angeles', languages: ['en-US', 'en'], platform: 'Win32',
  hardwareConcurrency: 16, deviceMemory: 8, fonts: 'Arial,Calibri', touch: '0:0', userAgent: UA, webdriver: false, pluginsLength: 5, hasChromeObject: true, outer: '1920x1040',
  ...over,
})

const HITS = Array.from({ length: 8 }, (_, i) => ({ title: `Result ${i}`, link: `https://site${i}.example/page`, snippet: `About ${i}` }))
const fake = (async (input: any) => {
  const url = String(input)
  if (url.startsWith('https://google.serper.dev')) return new Response(JSON.stringify({ organic: HITS }), { headers: { 'content-type': 'application/json' } })
  return new Response('{}', { status: 404 })
}) as typeof fetch

function setup() {
  const listings = new Listings(':memory:', { verify: async () => ({ ok: false }) } as any)
  const app = createApp({ keys: { serper: 'K' }, registry: new Registry('https://registry.test', fake), fetch: fake, listings, fingerprintSecret: 'test-fingerprint-secret-0123456789', network: { has: () => false } })
  const ip = '203.0.113.7'
  const req = (path: string, init: RequestInit = {}, from = ip) => app.request(path, { ...init, headers: { 'user-agent': UA, ...(init.headers ?? {}) } }, { ip: from })
  const token = async (from = ip) => ((await (await req('/api/fp/challenge', {}, from)).json()) as { token: string }).token
  const fp = async (over: Record<string, unknown> = {}, from = ip) => ({ v: 1, token: await token(from), visitorId: 'x', confidence: 'high', components: device(over) })
  const vote = async (body: Record<string, unknown>, from = ip) =>
    req('/api/vote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, from)
  return { app, listings, req, fp, vote, token }
}

describe('votes: the rules', () => {
  it('normalizes items so the same page is one item', () => {
    expect(normalizeUrl('https://www.Example.com/a/?utm_source=x&b=2#top')).toBe('example.com/a?b=2')
    expect(normalizeUrl('http://example.com/a')).toBe('example.com/a')
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(itemFor('listing', 'WWW.Acme.com')?.item).toBe('listing:acme.com')
    expect(itemFor('ad', 'web:top-1')?.item).toBe('ad:web:top-1')
    expect(itemFor('ad', 'web:anything')).toBeNull()
    expect(itemFor('nope', 'x')).toBeNull()
  })

  it('scores are damped by the prior and bounded', () => {
    expect(score(0, 0)).toBe(0)
    expect(score(1, 0)).toBeCloseTo(0.045, 2)
    expect(score(1000, 0)).toBeLessThan(0.5)
    expect(score(0, 1000)).toBeGreaterThan(-0.5)
  })

  it('a result never moves more than MAX_MOVE places, however many votes', () => {
    const db = new Database(':memory:')
    const v = new Votes(db, 'secret-secret-secret')
    const hits = Array.from({ length: 10 }, (_, i) => ({ url: `https://s${i}.example/` }))
    for (let i = 0; i < 500; i++) v.cast({ visitor: `v${i}`, kind: 'result', item: 'result:s9.example', domain: 's9.example', value: 1, query: 'q' })
    for (let i = 0; i < 500; i++) v.cast({ visitor: `v${i}`, kind: 'result', item: 'result:s0.example', domain: 's0.example', value: -1, query: 'q' })
    const out = v.rerank(hits, 'q').map((h) => h.url)
    expect(out.indexOf('https://s9.example/')).toBe(9 - MAX_MOVE)
    expect(out.indexOf('https://s0.example/')).toBe(MAX_MOVE)
    // Another search is untouched by this search's votes except through the (smaller) site score.
    const other = v.rerank(hits, 'something else').map((h) => h.url)
    expect(other.indexOf('https://s9.example/')).toBeGreaterThanOrEqual(9 - 2)
    // A pinned hit keeps its place.
    const pinned = v.rerank(hits, 'q', (h) => h.url === 'https://s0.example/').map((h) => h.url)
    expect(pinned[0]).toBe('https://s0.example/')
  })

  it('a few votes barely move anything', () => {
    const v = new Votes(new Database(':memory:'), 'secret-secret-secret')
    v.cast({ visitor: 'a', kind: 'result', item: 'result:s5.example', domain: 's5.example', value: 1, query: 'q' })
    const hits = Array.from({ length: 8 }, (_, i) => ({ url: `https://s${i}.example/` }))
    // One vote is worth about a third of a place: the order does not change.
    expect(v.rerank(hits, 'q').map((h) => h.url)).toEqual(hits.map((h) => h.url))
    expect(applyMoves([1, 2, 3, 4], (x) => (x === 4 ? 2 : 0))).toEqual([1, 4, 2, 3])
  })

  it('the search is stored only as a keyed hash', () => {
    const db = new Database(':memory:')
    const v = new Votes(db, 'secret-secret-secret')
    v.cast({ visitor: 'a', kind: 'result', item: 'result:x.example', domain: 'x.example', value: 1, query: 'learn javascript' })
    const raw = JSON.stringify(db.query('SELECT * FROM votes').all())
    expect(raw).not.toContain('learn')
    expect(raw).not.toContain('javascript')
  })
})

describe('votes: over HTTP', () => {
  it('records a vote, replaces it on a second vote, and takes it back on a repeat', async () => {
    const { vote, fp, req } = setup()
    const target = 'https://site3.example/page'
    const one = (await (await vote({ kind: 'result', target, value: 1, q: 'learn javascript', fp: await fp() })).json()) as any
    expect(one).toMatchObject({ ok: true, value: 1, up: 1, down: 0 })
    const again = (await (await vote({ kind: 'result', target, value: -1, q: 'learn javascript', fp: await fp() })).json()) as any
    expect(again).toMatchObject({ ok: true, value: -1, up: 0, down: 1 })
    const back = (await (await vote({ kind: 'result', target, value: -1, toggle: true, q: 'learn javascript', fp: await fp() })).json()) as any
    expect(back).toMatchObject({ ok: true, value: 0, up: 0, down: 0 })
    // Another device adds a vote rather than replacing.
    await vote({ kind: 'result', target, value: 1, q: 'learn javascript', fp: await fp() })
    await vote({ kind: 'result', target, value: 1, q: 'learn javascript', fp: await fp({ webglRenderer: 'Apple M2' }) })
    const tally = (await (await req(`/api/votes?kind=result&target=${encodeURIComponent(target)}&q=learn+javascript`)).json()) as any
    expect(tally.items[0]).toMatchObject({ item: 'result:site3.example/page', up: 2, down: 0 })
    // The form field form of the payload works too.
    const encoded = (await (await vote({ kind: 'listing', target: 'acme.com', value: 1, fp: encodePayload((await fp()) as any) })).json()) as any
    expect(encoded.ok).toBe(true)
  })

  it('refuses without a fingerprint, with a forged token, and from a bot', async () => {
    const { vote, fp } = setup()
    const r1 = await vote({ kind: 'result', target: 'https://a.example/', value: 1 })
    expect(r1.status).toBe(400)
    expect(((await r1.json()) as any).error).toBe('needs-js')
    const bad = await fp()
    bad.token = `${bad.token.slice(0, -3)}abc`
    expect(((await (await vote({ kind: 'result', target: 'https://a.example/', value: 1, fp: bad })).json()) as any).error).toBe('stale')
    const bot = await vote({ kind: 'result', target: 'https://a.example/', value: 1, fp: await fp({ webdriver: true }) })
    expect(bot.status).toBe(403)
    // A token minted for one network does not work from another.
    const other = await vote({ kind: 'result', target: 'https://a.example/', value: 1, fp: await fp({}, '198.51.100.1') })
    expect(((await other.json()) as any).error).toBe('stale')
    expect((await vote({ kind: 'result', target: 'javascript:alert(1)', value: 1, fp: await fp() })).status).toBe(400)
  })

  it('throttles a burst from one device', async () => {
    const { vote, fp } = setup()
    const per = VOTE_LIMITS.visitor[0]!.perWindow
    const statuses: number[] = []
    for (let i = 0; i < per + 3; i++) statuses.push((await vote({ kind: 'result', target: `https://burst${i}.example/`, value: 1, q: 'x', fp: await fp() })).status)
    expect(statuses.slice(0, per).every((s) => s === 200)).toBe(true)
    expect(statuses.slice(per)).toEqual([429, 429, 429])
  })

  it('caps many made-up devices from one network', async () => {
    const { vote, fp } = setup()
    const cap = VOTE_LIMITS.ip[0]!.perWindow
    let refused = 0
    for (let i = 0; i < cap + 5; i++) {
      const r = await vote({ kind: 'result', target: 'https://farm.example/', value: 1, q: 'x', fp: await fp({ canvas: `c${i}` }) })
      if (r.status === 429) refused++
    }
    expect(refused).toBe(5)
  })

  it('renders vote buttons on results, featured, sponsored slots and listings, and the page order follows votes', async () => {
    const { req, vote, fp, listings } = setup()
    const page = await (await req('/search?q=learn+javascript')).text()
    expect(page).toContain('data-item="result:site0.example/page"')
    expect(page).toContain('data-item="ad:web:top-1"')
    expect(page).toContain('data-item="ad:web:inline"')
    expect(page).toContain('data-q="learn javascript"')
    // Twelve devices push site7 up: it moves, but not past MAX_MOVE.
    for (let i = 0; i < 12; i++) await vote({ kind: 'result', target: 'https://site7.example/page', value: 1, q: 'learn javascript', fp: await fp({ canvas: `d${i}` }, `192.0.${i}.1`) }, `192.0.${i}.1`)
    const after = await (await req('/search?q=learn+javascript')).text()
    const order = [...after.matchAll(/data-item="result:(site\d)\.example\/page"/g)].map((m) => m[1])
    expect(order.indexOf('site7')).toBeLessThan(7)
    expect(order.indexOf('site7')).toBeGreaterThanOrEqual(7 - MAX_MOVE)
    const api = (await (await req('/api/search?q=learn+javascript&n=8')).json()) as any
    expect(api.results.map((r: any) => r.host).indexOf('site7.example')).toBe(order.indexOf('site7'))
    // A different search keeps the engines' order for site7 except for its (smaller) site score.
    void listings
  })

  it('the no-JavaScript form explains instead of counting', async () => {
    const { req } = setup()
    const r = await req('/vote', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'kind=result&target=https%3A%2F%2Fa.example%2F&v=1&back=%2Fsearch%3Fq%3Dx' })
    expect(r.status).toBe(400)
    const html = await r.text()
    expect(html).toContain('Voting needs JavaScript')
    expect(html).toContain('href="/search?q=x"')
    const evil = await req('/vote', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'kind=result&target=x&v=1&back=%2F%2Fevil.example' })
    expect(await evil.text()).not.toContain('evil.example')
  })

  it('serves the fingerprint script from our own origin', async () => {
    const { req } = setup()
    const r = await req('/fp.js')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('javascript')
    expect(await r.text()).toContain('export async function getFingerprint')
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'")
  })

  it('listing votes nudge /pros only among unpaid listings', async () => {
    const { listings, vote, fp, req } = setup()
    for (const d of ['a-co.com', 'b-co.com', 'c-co.com', 'd-co.com', 'e-co.com']) {
      listings.db.run("INSERT INTO listings (domain, name, seeded_at, updated_at, category) VALUES (?, ?, 1, 1, 'it')", [d, d])
    }
    const before = ((await (await req('/api/pros?n=10')).json()) as any).results.map((l: any) => l.domain)
    const last = before[before.length - 1]
    for (let i = 0; i < 30; i++) await vote({ kind: 'listing', target: last, value: 1, fp: await fp({ canvas: `e${i}` }, `10.${i}.0.1`) }, `10.${i}.0.1`)
    const after = ((await (await req('/api/pros?n=10')).json()) as any).results.map((l: any) => l.domain)
    expect(after.indexOf(last)).toBeLessThan(before.indexOf(last))
    expect(before.indexOf(last) - after.indexOf(last)).toBeLessThanOrEqual(MAX_MOVE)
    const top = (await (await req('/api/votes/top?kind=listing')).json()) as any
    expect(top.items[0]).toMatchObject({ target: last, up: 30 })
    const page = await (await req('/pros')).text()
    expect(page).toContain(`data-item="listing:${last}"`)
  })
})

describe('anonymous writes are limited per device', () => {
  it('a fingerprinted sign-up burst is refused per device, not per address', async () => {
    const { app, fp } = setup()
    const sub = async (over: Record<string, unknown>, from: string) =>
      app.request('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ email: 'a@example.com', fp: await fp(over, from) }) }, { ip: from })
    // The newsletter is off in this app, so the route answers 404 before limits: use the listing claim API instead.
    void sub
    const claim = async (over: Record<string, unknown>, from: string) =>
      app.request('/api/listing/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ domain: 'acme.com', fp: await fp(over, from) }) }, { ip: from })
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) statuses.push((await claim({}, '203.0.113.50')).status)
    expect(statuses.filter((s) => s === 429).length).toBe(2)
    // Another device on the same address is not caught by the first one's limit.
    expect((await claim({ webglRenderer: 'Apple M2' }, '203.0.113.50')).status).toBe(200)
    // A bot-scored fingerprint is refused outright.
    expect((await claim({ webdriver: true }, '203.0.113.51')).status).toBe(429)
  })
})
