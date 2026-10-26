import { afterAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { rmSync } from 'node:fs'
import { main } from '../src/cli.ts'
import { PitClient } from '../src/client.ts'
import { discoverFeed, Listings, type Verifier } from '../src/listings.ts'
import { looksLikeName } from '../src/moshpit.ts'
import type { Mailer } from '../src/newsletter.ts'
import { categoryOf, cleanServices, normalizeOperator, normalizeWebUrl } from '../src/pros.ts'
import { neighbors, ringSites, useListings } from '../src/ring.ts'
import { RingSync } from '../src/ring-sync.ts'
import { createApp } from '../src/server.ts'

type Sent = Parameters<Mailer>[0]

function harness(options: { pages?: Record<string, string>; noIcann?: string[] } = {}) {
  const txt: Record<string, string[]> = {}
  const pages: Record<string, string> = { ...options.pages }
  const verifier: Verifier = {
    txt: async (host) => txt[host] ?? [],
    homepage: async (domain) => pages[domain] ?? null,
    resolves: async (domain) => !(options.noIcann ?? []).includes(domain),
  }
  const sent: Sent[] = []
  const mailer: Mailer = async (m) => {
    sent.push(m)
  }
  const listings = new Listings(':memory:', verifier, undefined, { mailer, mx: async () => true })
  const app = createApp({ keys: {}, listings })
  const request = (path: string, init: RequestInit = {}, ip = '203.0.113.9') => app.request(path, init, { ip })
  const form = (path: string, fields: Record<string, string>, ip?: string) => request(path, { method: 'POST', body: new URLSearchParams(fields) }, ip)
  const claim = async (domain: string) => {
    const start = listings.startClaim(domain)!
    txt[start.txtHost] = [start.token]
    const r = await listings.verify(start.claimId)
    if (!r.ok) throw new Error('claim failed')
    return r.editKey
  }
  /** Set and confirm a contact address the way an owner would: through the mailed link. */
  const confirmContact = async (domain: string, key: string, email: string) => {
    expect(await listings.setContact(domain, key, email)).toBe('pending')
    const link = /https:\/\/pit\.world(\/b\/[^\s]+\/contact\?t=[A-Za-z0-9_-]+)/.exec(sent.at(-1)!.text)![1]!
    expect((await request(link)).status).toBe(200)
  }
  return { listings, app, request, form, claim, sent, pages, confirmContact }
}

afterAll(() => useListings(null))

describe('pros: field rules', () => {
  it('accepts an operator handle or an https URL, and nothing else', () => {
    expect(normalizeOperator('RiotCoder@Profullstack.com')).toBe('riotcoder@profullstack.com')
    expect(normalizeOperator('@riotcoder@profullstack.com')).toBe('riotcoder@profullstack.com')
    expect(normalizeOperator('https://profullstack.com/agents/riotcoder.json')).toBe('https://profullstack.com/agents/riotcoder.json')
    for (const bad of ['riotcoder', '@riotcoder', 'javascript:alert(1)', 'http://insecure.example/', 'a@b', 'x@localhost', 42]) expect(normalizeOperator(bad)).toBeNull()
  })

  it('normalizes company URLs, services and categories', () => {
    expect(normalizeWebUrl('profullstack.com')).toBe('https://profullstack.com/')
    expect(normalizeWebUrl('javascript:alert(1)')).toBeNull()
    expect(cleanServices('Leak repair\nleak repair\n  Drain cleaning  ;Water heaters')).toEqual(['Leak repair', 'Drain cleaning', 'Water heaters'])
    expect(cleanServices(Array.from({ length: 20 }, (_, i) => `s${i}`))).toHaveLength(12)
    expect(categoryOf('LEGAL')?.slug).toBe('legal')
    expect(categoryOf('Software & dev agencies')?.slug).toBe('software')
    expect(categoryOf('spam')).toBeNull()
  })

  it('finds the feed a homepage advertises', () => {
    const html = '<link rel="stylesheet" href="/a.css"><link type="application/atom+xml" rel="alternate" href="/feed.atom?x=1&amp;y=2">'
    expect(discoverFeed(html, 'https://acme.com/')).toBe('https://acme.com/feed.atom?x=1&y=2')
    expect(discoverFeed('<link rel="alternate" type="application/rss+xml" href="https://feeds.example/acme">', 'https://acme.com/')).toBe('https://feeds.example/acme')
    expect(discoverFeed('<link rel="alternate" hreflang="de" href="/de/">', 'https://acme.com/')).toBe('')
    expect(discoverFeed('<link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">', 'https://acme.com/')).toBe('')
  })
})

describe('pros: listing fields', () => {
  it('owners set operator, company and directory fields; the page shows them, escaped', async () => {
    const h = harness()
    const key = await h.claim('acme-plumbing.com')
    const saved = await h.form('/b/acme-plumbing.com/edit', {
      key,
      name: 'Acme Plumbing',
      operator: 'riotcoder@profullstack.com',
      company: 'Profullstack, Inc.',
      companyUrl: 'https://profullstack.com',
      category: 'home-services',
      services: 'Leak repair\nDrain cleaning\n<script>x</script>',
      area: 'East Bay',
      city: 'Oakland',
      region: 'CA',
      country: 'US',
      price: '$$',
      ring: 'in',
    })
    expect(saved.status).toBe(200)
    const html = await (await h.request('/b/acme-plumbing.com')).text()
    expect(html).toContain('Operated by')
    expect(html).toContain('riotcoder@profullstack.com')
    expect(html).not.toContain('mailto:riotcoder')
    expect(html).toContain('href="https://profullstack.com/" rel="noreferrer noopener">Profullstack, Inc.</a>')
    expect(html).toContain('href="/pros/home-services"')
    expect(html).toContain('East Bay · Oakland, CA, US')
    expect(html).toContain('$$ · moderate')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
    const api = await (await h.request('/api/listing?domain=acme-plumbing.com')).json()
    expect(api).toMatchObject({ operator: 'riotcoder@profullstack.com', company: 'Profullstack, Inc.', companyUrl: 'https://profullstack.com/', category: 'home-services', services: ['Leak repair', 'Drain cleaning', '<script>x</script>'], price: '$$', ring: false, quotes: false })
  })

  it('drops values that are not allowed rather than storing them', async () => {
    const h = harness()
    const key = await h.claim('acme-plumbing.com')
    const l = h.listings.edit('acme-plumbing.com', key, { operator: 'not a handle', category: 'casino', price: 'cheap', companyUrl: 'ftp://x' }, looksLikeName)!
    expect(l).toMatchObject({ operator: '', category: '', price: '', companyUrl: '' })
  })

  it('edits through the API with the key as a bearer token; the contact address never comes back', async () => {
    const h = harness()
    const key = await h.claim('acme-plumbing.com')
    const res = await h.request('/api/listing', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'acme-plumbing.com', company: 'Acme LLC', contactEmail: 'owner@acme-plumbing.com' }),
    })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ company: 'Acme LLC', contactStatus: 'pending', contactResult: 'pending', quotes: false })
    expect(JSON.stringify(body)).not.toContain('owner@acme-plumbing.com')
    expect(h.sent.at(-1)!.to).toBe('owner@acme-plumbing.com')
    const unauthorized = await h.request('/api/listing', { method: 'POST', headers: { authorization: 'Bearer pitk_nope', 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'acme-plumbing.com', company: 'x' }) })
    expect(unauthorized.status).toBe(401)
  })
})

describe('pros: quote requests', () => {
  it('only goes to an address that confirmed, and the address is never shown', async () => {
    const h = harness()
    const key = await h.claim('acme-plumbing.com')
    await h.listings.setContact('acme-plumbing.com', key, 'owner@acme-plumbing.com')
    expect((await h.listings.get('acme-plumbing.com'))!.quotes).toBe(false)
    expect(await h.listings.requestQuote('acme-plumbing.com', { name: 'Sam', email: 'sam@example.org', message: 'Leaking sink, need help' })).toBe('unavailable')
    // A wrong token does nothing.
    expect((await h.request('/b/acme-plumbing.com/contact?t=AAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status).toBe(410)
    const link = /\/b\/acme-plumbing\.com\/contact\?t=[A-Za-z0-9_-]+/.exec(h.sent.at(-1)!.text)![0]
    expect((await h.request(link)).status).toBe(200)
    // Works once.
    expect((await h.request(link)).status).toBe(410)
    const page = await (await h.request('/b/acme-plumbing.com')).text()
    expect(page).toContain('id="quote"')
    expect(page).toContain('name="website"')
    expect(page).not.toContain('owner@acme-plumbing.com')
    expect(h.listings.contactStatus('acme-plumbing.com', key)).toBe('confirmed')
  })

  it('mails the owner with the sender as Reply-To; a bot that fills the honeypot sends nothing', async () => {
    const h = harness()
    const key = await h.claim('acme-plumbing.com')
    await h.confirmContact('acme-plumbing.com', key, 'owner@acme-plumbing.com')
    const before = h.sent.length
    const trap = await h.form('/b/acme-plumbing.com/quote', { name: 'Bot', email: 'bot@example.org', message: 'Buy my stuff now please', website: 'https://spam.example' })
    expect(trap.status).toBe(200)
    expect(h.sent.length).toBe(before)
    const ok = await h.form('/b/acme-plumbing.com/quote', { name: 'Sam <b>', email: 'Sam@Example.org', phone: '555-0100', message: 'Kitchen sink leaks under the cabinet.' })
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('Sent.')
    const mail = h.sent.at(-1)!
    expect(mail).toMatchObject({ to: 'owner@acme-plumbing.com', replyTo: 'sam@example.org' })
    expect(mail.html).toContain('Sam &lt;b&gt;')
    expect(mail.html).not.toContain('<b>Sam <b>')
  })

  it('refuses link-stuffed messages, and limits each visitor and each listing', async () => {
    const h = harness()
    const key = await h.claim('acme-plumbing.com')
    await h.confirmContact('acme-plumbing.com', key, 'owner@acme-plumbing.com')
    const spam = await h.listings.requestQuote('acme-plumbing.com', { name: 'X', email: 'x@example.org', message: 'http://a.example http://b.example http://c.example http://d.example' })
    expect(spam).toBe('invalid')
    // One visitor: three an hour, across listings.
    for (let i = 0; i < 3; i++) expect((await h.form('/b/acme-plumbing.com/quote', { name: 'Sam', email: 'sam@example.org', message: `Request number ${i} for a quote` }, '198.51.100.7')).status).toBe(200)
    expect((await h.form('/b/acme-plumbing.com/quote', { name: 'Sam', email: 'sam@example.org', message: 'One more request for a quote' }, '198.51.100.7')).status).toBe(429)
    // One listing: five an hour, whoever is asking.
    for (let i = 0; i < 2; i++) expect(await h.listings.requestQuote('acme-plumbing.com', { name: 'Kim', email: 'kim@example.org', message: `Another request ${i} here` })).toBe('sent')
    expect(await h.listings.requestQuote('acme-plumbing.com', { name: 'Lee', email: 'lee@example.org', message: 'And one more request here' })).toBe('limited')
  })

  it('has a JSON endpoint and a CLI command, one listing per request', async () => {
    const h = harness()
    const key = await h.claim('acme-plumbing.com')
    await h.confirmContact('acme-plumbing.com', key, 'owner@acme-plumbing.com')
    const client = new PitClient('https://pit.world', ((url: any, init: any) => h.app.request(new URL(String(url)).pathname + new URL(String(url)).search, init, { ip: '192.0.2.50' })) as typeof fetch)
    const lines: string[] = []
    const out = { log: (t: string) => lines.push(t), error: (t: string) => lines.push(t) }
    expect(await main(['quote', 'acme-plumbing.com', '--name', 'Sam', '--email', 'sam@example.org', '--message', 'Need a water heater installed'], out, client)).toBe(0)
    expect(lines.join('\n')).toContain('Sent.')
    const nobody = await h.request('/api/listing/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'unclaimed.example', name: 'Sam', email: 'sam@example.org', message: 'hello there friend' }) }, '192.0.2.51')
    expect(nobody.status).toBe(404)
  })
})

describe('pros: the directory', () => {
  async function seeded() {
    const h = harness()
    const a = await h.claim('acme-plumbing.com')
    h.listings.edit('acme-plumbing.com', a, { name: 'Acme Plumbing', category: 'home-services', city: 'Oakland', region: 'CA', services: ['Leak repair'] }, looksLikeName)
    const b = await h.claim('lawyer.example')
    h.listings.edit('lawyer.example', b, { name: 'Smith Law', category: 'legal', city: 'Austin', region: 'TX', description: 'Estate planning and wills.' }, looksLikeName)
    await h.request('/b/unclaimed.example')
    return h
  }

  it('browses by category and place, and searches words', async () => {
    const h = await seeded()
    const all = await (await h.request('/pros')).text()
    expect(all).toContain('<a href="/b/acme-plumbing.com">')
    expect(all).toContain('<a href="/b/lawyer.example">')
    const legal = await (await h.request('/pros/legal')).text()
    expect(legal).toContain('<a href="/b/lawyer.example">')
    expect(legal).not.toContain('<a href="/b/acme-plumbing.com">')
    expect((await h.request('/pros?c=legal&near=austin')).headers.get('location')).toBe('/pros/legal?near=austin')
    const near = await (await h.request('/pros?near=oakland')).text()
    expect(near).toContain('<a href="/b/acme-plumbing.com">')
    expect(near).not.toContain('<a href="/b/lawyer.example">')
    const words = await (await h.request('/pros?q=wills')).text()
    expect(words).toContain('<a href="/b/lawyer.example">')
    expect(words).not.toContain('<a href="/b/acme-plumbing.com">')
    expect((await h.request('/pros/casino')).status).toBe(404)
  })

  it('serves the directory and categories as JSON and through the CLI', async () => {
    const h = await seeded()
    const r = await (await h.request('/api/pros?c=home-services')).json()
    expect(r.total).toBe(1)
    expect(r.results[0]).toMatchObject({ domain: 'acme-plumbing.com', category: 'home-services' })
    expect((await h.request('/api/pros?c=casino')).status).toBe(400)
    const cats = await (await h.request('/api/pros/categories')).json()
    expect(cats.categories.find((c: any) => c.slug === 'legal').count).toBe(1)
    const client = new PitClient('https://pit.world', ((url: any, init: any) => h.app.request(new URL(String(url)).pathname + new URL(String(url)).search, init, { ip: '192.0.2.60' })) as typeof fetch)
    const lines: string[] = []
    const out = { log: (t: string) => lines.push(t), error: (t: string) => lines.push(t) }
    expect(await main(['pros', 'leak', '--near', 'oakland'], out, client)).toBe(0)
    expect(lines.join('\n')).toContain('Acme Plumbing')
    expect(lines.join('\n')).not.toContain('Smith Law')
  })

  it('publishes claimed listings as an Atom feed, and never unclaimed ones', async () => {
    const h = await seeded()
    const res = await h.request('/b/feed.xml')
    expect(res.headers.get('content-type')).toContain('atom+xml')
    const xml = await res.text()
    expect(xml).toContain('<link href="https://pit.world/b/acme-plumbing.com"/>')
    expect(xml).not.toContain('unclaimed.example')
  })
})

describe('the pit.world ring: claimed listings join it', () => {
  it('a *.pit.world claim joins the ring, after the core sites; opting out leaves it', async () => {
    const h = harness({ pages: { 'acme.pit.world': '<link rel="alternate" type="application/rss+xml" href="/rss.xml">' } })
    const key = await h.claim('acme.pit.world')
    await h.claim('acme-plumbing.com')
    const ring = await (await h.request('/api/ring')).json()
    const names = ring.sites.map((s: any) => s.name)
    // Its own .com is in /pros, never in the ring.
    expect(names).not.toContain('acme-plumbing.com')
    expect((await h.listings.get('acme-plumbing.com'))!.ring).toBe(false)
    expect(await (await h.request('/b/acme-plumbing.com/edit')).text()).not.toContain('Leave the ring')
    expect(names.slice(0, 11)).toEqual([
      'pit.world',
      'seo.rank',
      'family.ancestry',
      'pay.agent',
      'built.indie',
      'deadman.switch',
      'watch.wallet',
      'resident.alerts',
      'search.peptides',
      'ad.network.pit.world',
      'group.call.pit.world',
    ])
    expect(ring.sites.at(-1)).toMatchObject({ name: 'acme.pit.world', listing: true, moshpit: false, feed: 'https://acme.pit.world/rss.xml' })
    expect((await h.request('/ring/next?from=https%3A%2F%2Fgroup.call.pit.world%2F&direct=1')).headers.get('location')).toBe('https://acme.pit.world/')
    expect((await h.request('/ring/next?from=acme.pit.world')).headers.get('location')).toBe('https://pit.world/')
    expect((await h.request('/ring/prev', { headers: { referer: 'https://www.acme.pit.world/about' } })).headers.get('location')).toBe('https://group.call.pit.world/')
    expect((await h.request('/ring/random?from=acme.pit.world')).headers.get('cache-control')).toBe('no-store')
    const page = await (await h.request('/ring')).text()
    expect(page).toContain('href="/b/acme.pit.world"')
    expect(await (await h.request('/ring/opml')).text()).toContain('xmlUrl="https://acme.pit.world/rss.xml"')
    h.listings.edit('acme.pit.world', key, { ring: 'out' as never }, looksLikeName)
    expect(ringSites().map((s) => s.name)).not.toContain('acme.pit.world')
    expect((await h.listings.get('acme.pit.world'))!.ring).toBe(false)
  })

  it('a Moshpit-only name links through the pit.world proxy; the verified page hands out the links', async () => {
    const h = harness({ noIcann: ['acme.bakery'] })
    const start = h.listings.startClaim('acme.bakery')!
    const res = await h.form('/b/acme.bakery/verify', { claim: start.claimId })
    expect(res.status).toBe(400)
    h.pages['acme.bakery'] = `<html><head>${start.meta}</head></html>`
    const ok = await (await h.form('/b/acme.bakery/verify', { claim: start.claimId })).text()
    expect(ok).toContain('pit.world/ring/next?from=https%3A%2F%2Facme.bakery%2F')
    expect(ok).toContain('https://rssamplifier.com/ring/pit-world')
    expect(neighbors('group.call.pit.world').next).toMatchObject({ name: 'acme.bakery', moshpit: true })
  })
})

describe('listings: the schema grows in place', () => {
  it('adds the new columns to a database from the first release, keeping its rows', () => {
    const path = `${import.meta.dir}/.migrate-test.db`
    rmSync(path, { force: true })
    const old = new Database(path, { create: true })
    old.run(`CREATE TABLE listings (domain TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', hours TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '[]', moshpit TEXT NOT NULL DEFAULT '', edit_key_hash TEXT, claimed_at INTEGER, updated_at INTEGER, meta_at INTEGER)`)
    old.run("INSERT INTO listings (domain, name, claimed_at, updated_at) VALUES ('shop.pit.world', 'shop.pit.world', 1, 1)")
    old.close()
    try {
      const l = new Listings(path, { txt: async () => [], homepage: async () => null })
      expect(l.claimedOnly('shop.pit.world')).toMatchObject({ name: 'shop.pit.world', operator: '', ring: true, services: [] })
      expect(l.ringMembers().map((m) => m.domain)).toEqual(['shop.pit.world'])
    } finally {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
    }
  })
})

describe('ring sync to rssamplifier', () => {
  /** A tiny rssamplifier: one ring, a directory of known feeds, keyed writes only. */
  function fakeRss(known: string[]) {
    let ring: { members: Array<{ url: string; slug: string; feed: string }> } | null = null
    const calls: string[] = []
    const fetchImpl = (async (input: any, init: any = {}) => {
      const url = new URL(String(input))
      const body = init.body ? JSON.parse(init.body) : {}
      calls.push(`${init.method ?? 'GET'} ${url.pathname}`)
      const authed = init.headers?.authorization === 'Bearer rsa_test_key'
      const slug = (feed: string) => new URL(feed).hostname.replace(/\./g, '-')
      if (url.pathname === '/api/rings/pit-world' && (init.method ?? 'GET') === 'GET') return ring ? Response.json({ members: ring.members }) : Response.json({ error: 'not-found' }, { status: 404 })
      if (url.pathname === '/api/submit') return Response.json({ ok: true })
      if (!authed) return Response.json({ error: 'sign-in-required' }, { status: 401 })
      const found = (list: string[]) => list.filter((f) => known.includes(f))
      if (url.pathname === '/api/rings') {
        const f = found(body.members)
        if (!f.length) return Response.json({ error: 'members-required', missing: body.members }, { status: 400 })
        ring = { members: f.map((feed) => ({ url: `https://${new URL(feed).hostname}/`, slug: slug(feed), feed })) }
        return Response.json({ ok: true, slug: 'pit-world', added: f.length, missing: body.members.filter((m: string) => !f.includes(m)) }, { status: 201 })
      }
      if (url.pathname === '/api/rings/pit-world/members') {
        if (body.action === 'remove') {
          const before = ring!.members.length
          ring!.members = ring!.members.filter((m) => m.slug !== body.member)
          return Response.json({ ok: ring!.members.length < before })
        }
        const f = found(body.members)
        ring!.members.push(...f.map((feed) => ({ url: `https://${new URL(feed).hostname}/`, slug: slug(feed), feed })))
        return Response.json({ ok: true, added: f.length, missing: body.members.filter((m: string) => !f.includes(m)) })
      }
      return Response.json({ error: 'not-found' }, { status: 404 })
    }) as typeof fetch
    return { fetchImpl, calls, ring: () => ring }
  }

  const site = (name: string, feed?: string, moshpit = false) => ({ name, about: '', moshpit, listing: true, ...(feed ? { feed } : {}) })

  it('creates the ring, adds what the directory knows, and removes members that left; running twice changes nothing', async () => {
    const rss = fakeRss(['https://pit.world/b/feed.xml', 'https://acme.com/rss.xml'])
    const sync = new RingSync({ apiKey: 'rsa_test_key', base: 'https://rss.test', fetch: rss.fetchImpl })
    const sites = [site('pit.world', 'https://pit.world/b/feed.xml'), site('seo.rank', 'https://seo.rank/feed.xml', true), site('acme.com', 'https://acme.com/rss.xml'), site('nofeed.com'), site('new.com', 'https://new.com/feed')]
    expect(RingSync.wanted(sites).map((w) => w.feed)).toEqual(['https://pit.world/b/feed.xml', 'https://acme.com/rss.xml', 'https://new.com/feed'])
    const first = await sync.sync(sites)
    expect(first).toMatchObject({ ok: true, created: true, added: 2, missing: ['https://new.com/feed'] })
    // Not crawled yet: still missing, and asked for again next time.
    const second = await sync.sync(sites)
    expect(second).toMatchObject({ ok: true, created: false, added: 0, removed: 0, missing: ['https://new.com/feed'] })
    // acme.com opts out.
    const third = await sync.sync(sites.filter((s) => s.name !== 'acme.com'))
    expect(third).toMatchObject({ ok: true, removed: 1 })
    expect(rss.ring()!.members.map((m) => m.feed)).toEqual(['https://pit.world/b/feed.xml'])
  })

  it('waits when nothing is in the directory yet, and reports a refused key', async () => {
    const rss = fakeRss([])
    const sync = new RingSync({ apiKey: 'rsa_test_key', base: 'https://rss.test', fetch: rss.fetchImpl })
    expect(await sync.sync([site('pit.world', 'https://pit.world/b/feed.xml')])).toMatchObject({ ok: true, created: false, missing: ['https://pit.world/b/feed.xml'] })
    const bad = new RingSync({ apiKey: 'rsa_wrong', base: 'https://rss.test', fetch: fakeRss(['https://pit.world/b/feed.xml']).fetchImpl })
    const r = await bad.sync([site('pit.world', 'https://pit.world/b/feed.xml')])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('401')
  })
})
