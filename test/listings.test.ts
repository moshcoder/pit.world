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
