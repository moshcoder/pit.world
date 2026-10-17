import { describe, expect, it } from 'bun:test'
import { main } from '../src/cli.ts'
import { PitClient } from '../src/client.ts'
import { cleanLinks, isPublicAddress, Listings, normalizeDomain, readMeta, type Verifier } from '../src/listings.ts'
import { looksLikeName } from '../src/moshpit.ts'
import { createApp } from '../src/server.ts'

function fakeVerifier(state: { txt?: Record<string, string[]>; pages?: Record<string, string> } = {}): Verifier & { state: typeof state } {
  return {
    state,
    async txt(host) {
      return state.txt?.[host] ?? []
    },
    async homepage(domain) {
      return state.pages?.[domain] ?? null
    },
  }
}

function harness(pages: Record<string, string> = {}) {
  const verifier = fakeVerifier({ txt: {}, pages: { 'acme-bakery.com': '<html><head><title>Acme Bakery | Fresh bread</title><meta name="description" content="Sourdough &amp; pastries in Oakland."></head></html>', ...pages } })
  const listings = new Listings(':memory:', verifier)
  const app = createApp({ keys: {}, listings })
  const request = (path: string, init: RequestInit = {}, ip = '203.0.113.9') => app.request(path, init, { ip })
  const form = (path: string, fields: Record<string, string>) => request(path, { method: 'POST', body: new URLSearchParams(fields) })
  return { verifier, listings, app, request, form }
}

async function claimByDns(h: ReturnType<typeof harness>, domain: string) {
  const start = h.listings.startClaim(domain)!
  h.verifier.state.txt![start.txtHost] = [start.token]
  const result = await h.listings.verify(start.claimId)
  if (!result.ok) throw new Error('claim failed')
  return result.editKey
}

describe('listings: parsing', () => {
  it('normalizes domains and refuses what is not one', () => {
    expect(normalizeDomain('https://www.Acme-Bakery.com/menu?x=1')).toBe('acme-bakery.com')
    expect(normalizeDomain('seo.rank')).toBe('seo.rank')
    for (const bad of ['', 'localhost', '127.0.0.1', '::1', 'a', 'exa mple.com', '-bad.com', 42]) expect(normalizeDomain(bad)).toBeNull()
  })

  it('reads the title and description a homepage gives itself', () => {
    expect(readMeta('<title>Acme</title><meta property="og:site_name" content="Acme Bakery"><meta name="description" content="Bread &amp; more">')).toEqual({ name: 'Acme Bakery', description: 'Bread & more' })
  })

  it('only ever fetches public addresses', () => {
    for (const a of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPublicAddress(a)).toBe(false)
    for (const a of ['23.95.228.174', '8.8.8.8', '2606:4700::1111']) expect(isPublicAddress(a)).toBe(true)
  })

  it('keeps at most five http(s) links', () => {
    expect(cleanLinks(['javascript:alert(1)', 'https://a.example/', 'https://a.example/', 'ftp://x', 'http://b.example/x'])).toEqual(['https://a.example/', 'http://b.example/x'])
    expect(cleanLinks(Array.from({ length: 9 }, (_, i) => `https://s${i}.example/`))).toHaveLength(5)
  })
})

describe('listings: claim and edit', () => {
  it('shows an unclaimed listing from the homepage, not indexed, with a claim button', async () => {
    const h = harness()
    const html = await (await h.request('/b/acme-bakery.com')).text()
    expect(html).toContain('Acme Bakery | Fresh bread')
    expect(html).toContain('Sourdough &amp; pastries in Oakland.')
    expect(html).toContain('action="/b/acme-bakery.com/claim"')
    expect(html).toContain('<meta name="robots" content="noindex">')
  })

  it('claims by DNS TXT record, then edits with the key shown once', async () => {
    const h = harness()
    const claim = await h.form('/b/acme-bakery.com/claim', {})
    expect(claim.status).toBe(303)
    const claimPath = claim.headers.get('location')!
    const page = await (await h.request(claimPath)).text()
    const token = /pit-verify=[0-9a-f]{32}/.exec(page)![0]
    const claimId = claimPath.split('/').pop()!
    // Not there yet.
    expect((await h.form('/b/acme-bakery.com/verify', { claim: claimId })).status).toBe(400)
    h.verifier.state.txt!['_pit-verify.acme-bakery.com'] = [token]
    const ok = await h.form('/b/acme-bakery.com/verify', { claim: claimId })
    const okHtml = await ok.text()
    expect(ok.status).toBe(200)
    const key = /pitk_[A-Za-z0-9_-]+/.exec(okHtml)![0]

    expect((await h.form('/b/acme-bakery.com/edit', { key: 'pitk_wrong', name: 'Hacked' })).status).toBe(403)
    const saved = await h.form('/b/acme-bakery.com/edit', { key, name: 'Acme Bakery', hours: 'Tue–Sun 7–3', links: 'https://instagram.com/acme javascript:alert(1)', moshpit: 'acme.bakery' })
    expect(saved.status).toBe(200)
    const listing = await (await h.request('/api/listing?domain=acme-bakery.com')).json()
    expect(listing).toMatchObject({ claimed: true, name: 'Acme Bakery', hours: 'Tue–Sun 7–3', links: ['https://instagram.com/acme'], moshpit: 'acme.bakery' })
  })

  it('claims by a meta tag on the homepage', async () => {
    const h = harness()
    const start = h.listings.startClaim('acme-bakery.com')!
    h.verifier.state.pages!['acme-bakery.com'] = `<html><head>${start.meta}</head></html>`
    const result = await h.listings.verify(start.claimId)
    expect(result).toMatchObject({ ok: true, method: 'meta' })
  })

  it('a new claim replaces the old edit key, and claimed text is never overwritten by the homepage', async () => {
    const h = harness()
    const first = await claimByDns(h, 'acme-bakery.com')
    h.listings.edit('acme-bakery.com', first, { name: 'Owner Name' }, looksLikeName)
    const second = await claimByDns(h, 'acme-bakery.com')
    expect(h.listings.authorized('acme-bakery.com', first)).toBe(false)
    expect(h.listings.authorized('acme-bakery.com', second)).toBe(true)
    expect((await h.listings.get('acme-bakery.com'))!.name).toBe('Owner Name')
  })

  it('escapes whatever an owner writes', async () => {
    const h = harness()
    const key = await claimByDns(h, 'acme-bakery.com')
    h.listings.edit('acme-bakery.com', key, { name: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>' }, looksLikeName)
    const html = await (await h.request('/b/acme-bakery.com')).text()
    expect(html).not.toContain('<script>alert(1)')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;')
  })

  it('shows a claimed listing beside search results for its domain', async () => {
    const h = harness()
    const key = await claimByDns(h, 'acme-bakery.com')
    h.listings.edit('acme-bakery.com', key, { name: 'Acme Bakery', description: 'Bread.' }, looksLikeName)
    const html = await (await h.request('/search?q=acme-bakery.com')).text()
    expect(html).toContain('class="card listing"')
    expect(html).toContain('✓ verified owner')
  })

  it('claim and verify work from the CLI against the API', async () => {
    const h = harness()
    const client = new PitClient('https://pit.world', ((url: any, init: any) => h.app.request(new URL(String(url)).pathname + new URL(String(url)).search, init, { ip: '192.0.2.44' })) as typeof fetch)
    const lines: string[] = []
    const out = { log: (t: string) => lines.push(t), error: (t: string) => lines.push(t) }
    expect(await main(['claim', 'acme-bakery.com'], out, client)).toBe(0)
    const text = lines.join('\n')
    const claimId = /pit verify (\S+)/.exec(text)![1]!
    const token = /pit-verify=[0-9a-f]{32}/.exec(text)![0]
    h.verifier.state.txt!['_pit-verify.acme-bakery.com'] = [token]
    lines.length = 0
    expect(await main(['verify', claimId], out, client)).toBe(0)
    expect(lines.join('\n')).toMatch(/pitk_/)
    lines.length = 0
    await main(['listing', 'acme-bakery.com'], out, client)
    expect(lines.join('\n')).toContain('claimed by the owner')
  })
})

describe('listings: listed by pit.world (seeded)', () => {
  const BROWSER = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15' }
  const seedAcme = (h: ReturnType<typeof harness>, extra: Partial<Parameters<Listings['seed']>[0]> = {}) =>
    h.listings.seed({ domain: 'acme-builders.com', name: 'Acme Builders, Inc.', description: 'Custom homes in Los Gatos.', phone: '(408) 555-0100', category: 'construction', area: 'Los Gatos and the South Bay', city: 'Los Gatos', region: 'CA', country: 'USA', services: ['Custom homes', 'Remodels'], license: 'CSLB #123456 (B - General Building)', licenseCheckedAt: Date.UTC(2026, 9, 17), ...extra })

  it('shows in /pros, marked unclaimed, indexable, with a claim button and the license', async () => {
    const h = harness()
    expect(seedAcme(h)).toMatchObject({ seeded: true, claimed: false, quotes: false, ring: false, listed: true })
    const pros = await (await h.request('/pros/construction')).text()
    expect(pros).toContain('Acme Builders, Inc.')
    expect(pros).toContain('unclaimed')
    expect(pros).toContain('Yours? Claim it')
    const page = await (await h.request('/b/acme-builders.com', { headers: BROWSER })).text()
    expect(page).not.toContain('noindex')
    expect(page).toContain('listed by pit.world · unclaimed')
    expect(page).toContain('Is this your business? Claim it')
    expect(page).toContain('action="/b/acme-builders.com/claim"')
    expect(page).toContain('CSLB #123456 (B - General Building) · active when pit.world checked on 2026-10-17')
    expect(page).toContain('(408) 555-0100')
    expect(page).not.toContain('id="quote"')
    expect(await (await h.request('/sitemap.xml')).text()).toContain('/b/acme-builders.com')
  })

  it('keeps what pit.world wrote instead of the homepage, never sends quotes, and stays out of the ring and the claims feed', async () => {
    const h = harness({ 'acme-builders.com': '<title>Home | Template</title>' })
    seedAcme(h)
    expect((await h.listings.get('acme-builders.com'))!.name).toBe('Acme Builders, Inc.')
    expect(await h.listings.requestQuote('acme-builders.com', { name: 'A', email: 'a@example.com', message: 'Please quote me a kitchen.' })).toBe('unavailable')
    expect(h.listings.ringMembers().map((m) => m.domain)).not.toContain('acme-builders.com')
    expect(await (await h.request('/b/feed.xml')).text()).not.toContain('acme-builders.com')
  })

  it('puts featured listings first, then claimed ones, then the rest', async () => {
    const h = harness()
    seedAcme(h)
    h.listings.seed({ domain: 'first-builders.com', name: 'First Builders', category: 'construction', featured: 10 })
    const key = await claimByDns(h, 'acme-bakery.com')
    h.listings.edit('acme-bakery.com', key, { category: 'construction' }, looksLikeName)
    expect(h.listings.directory({ category: 'construction' }).listings.map((l) => l.domain)).toEqual(['first-builders.com', 'acme-bakery.com', 'acme-builders.com'])
    expect(h.listings.categoryCounts().construction).toBe(3)
  })

  it('counts views from people, not crawlers or scripts', async () => {
    const h = harness()
    seedAcme(h)
    await h.request('/b/acme-builders.com', { headers: BROWSER })
    await h.request('/b/acme-builders.com', { headers: BROWSER })
    await h.request('/b/acme-builders.com', { headers: { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' } })
    await h.request('/b/acme-builders.com', { headers: { 'user-agent': 'curl/8.5.0' } })
    await h.request('/b/acme-builders.com')
    expect((await h.listings.get('acme-builders.com', { fetchMeta: false }))!.views).toBe(2)
    // A bare unclaimed page is not counted (nothing to report to anyone).
    await h.request('/b/acme-bakery.com', { headers: BROWSER })
    expect((await h.listings.get('acme-bakery.com', { fetchMeta: false }))!.views).toBe(0)
  })

  it('the owner claims it and takes over; pit.world can never write to it again; the owner can leave the directory', async () => {
    const h = harness()
    seedAcme(h)
    await h.request('/b/acme-builders.com', { headers: BROWSER })
    const key = await claimByDns(h, 'acme-builders.com')
    const claimed = (await h.listings.get('acme-builders.com'))!
    expect(claimed).toMatchObject({ claimed: true, seeded: false, name: 'Acme Builders, Inc.', views: 1 })
    expect(h.listings.seed({ domain: 'acme-builders.com', name: 'Overwritten' })).toBeNull()
    expect(h.listings.unseed('acme-builders.com')).toBe(false)
    h.listings.edit('acme-builders.com', key, { listed: false }, looksLikeName)
    expect(h.listings.directory().listings.map((l) => l.domain)).not.toContain('acme-builders.com')
    expect((await h.request('/b/acme-builders.com')).status).toBe(200)
  })

  it('unseed removes it; seed refuses a listing without a name, and never stores an email', async () => {
    const h = harness()
    seedAcme(h)
    expect(h.listings.unseed('acme-builders.com')).toBe(true)
    expect(h.listings.directory().total).toBe(0)
    expect(h.listings.seed({ domain: 'acme-builders.com', name: '' })).toBeNull()
    const l = h.listings.seed({ domain: 'acme-builders.com', name: 'Acme', contactEmail: 'owner@acme-builders.com' } as any)!
    expect(JSON.stringify(l)).not.toContain('owner@')
  })

  it('seeds from a JSON file with the admin command and reports views', async () => {
    const { admin } = await import('../src/admin.ts')
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const dir = mkdtempSync(`${process.env.TMPDIR ?? '/tmp'}/pit-admin-`)
    writeFileSync(`${dir}/seed.json`, JSON.stringify([{ domain: 'acme-builders.com', name: 'Acme Builders', category: 'construction' }]))
    const h = harness()
    const lines: string[] = []
    const out = { log: (t: string) => lines.push(t), error: (t: string) => lines.push(t) }
    expect(await admin(['seed', `${dir}/seed.json`], h.listings, out)).toBe(0)
    expect(lines[0]).toContain('seeded  acme-builders.com')
    lines.length = 0
    expect(await admin(['views'], h.listings, out)).toBe(0)
    expect(JSON.parse(lines[0]!)).toEqual([{ domain: 'acme-builders.com', name: 'Acme Builders', claimed: false, views: 0, url: 'https://pit.world/b/acme-builders.com' }])
  })
})

describe('listings: website link', () => {
  it('links the site on its own domain when it only answers on www or http', async () => {
    const h = harness()
    h.listings.seed({ domain: 'old-builders.com', name: 'Old Builders', links: ['http://www.old-builders.com/', 'https://houzz.com/pro/old'] })
    const page = await (await h.request('/b/old-builders.com')).text()
    // The page links /go, which redirects to the site's own www/http address and nowhere else.
    expect(page).toContain('href="/b/old-builders.com/go"')
    expect(page).not.toContain('href="https://old-builders.com/"')
    expect(page).toContain('houzz.com/pro/old')
    const go = await h.request('/b/old-builders.com/go?to=https://evil.example/')
    expect(go.status).toBe(302)
    expect(go.headers.get('location')).toBe('http://www.old-builders.com/')
    expect((await h.request('/b/not-listed.example/go')).status).toBe(404)
  })
})
