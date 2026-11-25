/**
 * The Adult (18+) category of pit.world/directory: signed-in members see it, inside the category
 * only; an anonymous caller never sees an adult entry on any surface the directory or search has.
 */
import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Accounts } from '../src/accounts.ts'
import { admin } from '../src/admin.ts'
import { Directory, seedDirectory } from '../src/directory.ts'
import { DirectorySites, siteHost, siteUrl } from '../src/directory-sites.ts'
import { Listings } from '../src/listings.ts'
import { createApp } from '../src/server.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ADULT_HOST = 'adult-example.test'
const ADULT_NAME = 'Velvet Example'
const ADULT_ABOUT = 'An adult studio used in tests'

function world() {
  const listings = new Listings(':memory:')
  const sites = new DirectorySites(listings.db, Date.now, 0)
  listings.setBlocked((d) => sites.isAdult(d))
  sites.add({ name: 'Public Tool', url: 'https://public-tool.test/', description: 'A public tool', tags: ['ai'], path: 'computers/software', source: 'saasrow', sourceUrl: 'https://saasrow.pwa.pit.world/software/1' })
  const seeded = seedDirectory(sites, [{ name: ADULT_NAME, url: `https://www.${ADULT_HOST}/?utm_source=x`, description: ADULT_ABOUT, tags: ['4K', 'vr'] }], 'adult')
  const directory = new Directory({ hosts: () => ['seo.rank.pit.world'], sites })
  const accounts = new Accounts(':memory:')
  const me = accounts.signIn({ sub: 'did:key:member', name: 'Member' })
  const session = accounts.createSession(me.id).token
  const token = accounts.createToken(me.id, 'test')
  const submitted: string[][] = []
  const fake = (async (input: any, init?: any) => {
    const url = String(input)
    if (url.startsWith('https://google.serper.dev'))
      return Response.json({
        organic: [
          { link: `https://${ADULT_HOST}/`, title: ADULT_NAME, snippet: ADULT_ABOUT },
          { link: `https://tour.${ADULT_HOST}/join`, title: `${ADULT_NAME} tour`, snippet: 'subdomain' },
          { link: 'https://public-tool.test/', title: 'Public Tool', snippet: 'A public tool' },
        ],
      })
    if (url.startsWith('http://crawler.test/api/v1/submit')) {
      const urls = JSON.parse(init.body).urls as string[]
      submitted.push(urls)
      return Response.json({ queued: urls.length }, { status: 202 })
    }
    if (url.startsWith('http://crawler.test/api/v1/corpus/stats')) return Response.json({ pages: 2, sites: 2 })
    if (url.startsWith('http://crawler.test/api/v1/corpus'))
      return Response.json({
        items: [
          { id: 1, url: `https://${ADULT_HOST}/scene`, title: ADULT_NAME, site: ADULT_HOST, kind: 'page', language: 'en', fetched_at: '2026-11-02T00:00:00.000Z', text: ADULT_ABOUT },
          { id: 2, url: 'https://public-tool.test/', title: 'Public Tool', site: 'public-tool.test', kind: 'page', language: 'en', fetched_at: '2026-11-02T00:00:00.000Z', text: 'public text' },
        ],
        next_cursor: null,
        resume_cursor: '2',
      })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  const app = createApp({
    keys: { serper: 'K' },
    fetch: fake,
    crawlerUrl: 'http://crawler.test',
    directory,
    directorySites: sites,
    listings,
    accounts: { accounts, site: 'https://pit.world', coinpay: null, bridgeKey: null, admins: ['did:key:member'] },
    adminToken: 'admin-token-for-tests',
  })
  const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers }, { ip: '203.0.113.9' })
  const asMember = { cookie: `pw_session=${session}` }
  return { app, get, asMember, token, sites, listings, directory, seeded, submitted }
}

const leaks = (body: string) => body.includes(ADULT_HOST) || body.includes(ADULT_NAME) || body.includes(ADULT_ABOUT)

describe('adult directory: the store', () => {
  it('keys a site by its host and strips campaign parameters', () => {
    expect(siteHost('https://WWW.Example.com/x?y')).toBe('example.com')
    expect(siteHost('localhost')).toBeNull()
    expect(siteHost('ftp://example.com/')).toBeNull()
    expect(siteUrl('https://example.com/?utm_source=a&ref=b&keep=1#frag')).toBe('https://example.com/?keep=1')
    expect(siteUrl('javascript:alert(1)')).toBeNull()
  })

  it('files adult entries apart, and a subdomain of one is adult too', () => {
    const { sites, seeded } = world()
    expect(seeded).toMatchObject({ category: 'adult', added: 1, invalid: 0 })
    expect(sites.all().map((s) => s.host)).toEqual(['public-tool.test'])
    expect(sites.adult().map((s) => s.host)).toEqual([ADULT_HOST])
    expect(sites.adult()[0]!.url).toBe(`https://www.${ADULT_HOST}/`)
    expect(sites.isAdult(`https://tour.${ADULT_HOST}/x`)).toBe(true)
    expect(sites.isAdult('public-tool.test')).toBe(false)
    expect(sites.isAdult(`not${ADULT_HOST}`)).toBe(false)
  })

  it('moves a filed site into Adult when staff seed it there, and never out by a re-import', () => {
    const { sites } = world()
    expect(seedDirectory(sites, [{ name: 'Public Tool', url: 'https://public-tool.test/' }], 'adult')).toMatchObject({ moved: 1 })
    expect(sites.all()).toEqual([])
    expect(sites.add({ name: 'Public Tool', url: 'https://public-tool.test/', path: 'computers/software', source: 'saasrow' })).toBe('exists')
    expect(sites.isAdult('public-tool.test')).toBe(true)
    expect(sites.move('public-tool.test', 'computers/software')).toBe(true)
    expect(sites.isAdult('public-tool.test')).toBe(false)
  })

  it('refuses a category that does not exist', () => {
    const { sites } = world()
    expect(seedDirectory(sites, [], 'nope/nothing')).toBeNull()
    expect(seedDirectory(sites, [{ name: 'X', url: 'https://x-tool.test' }], 'computers/ai')).toMatchObject({ category: 'computers/ai', added: 1 })
  })

  it('seeds from the admin CLI, adult by default', async () => {
    const listings = new Listings(':memory:')
    const file = join(mkdtempSync(join(tmpdir(), 'pit-adult-')), 'seeds.json')
    writeFileSync(file, JSON.stringify([{ name: ADULT_NAME, url: `https://${ADULT_HOST}`, description: ADULT_ABOUT, tags: ['hq'] }, { name: 'bad', url: 'not a url' }]))
    const lines: string[] = []
    const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) }
    expect(await admin(['directory-seed', file], listings, out)).toBe(1)
    expect(lines.join('\n')).toContain('adult: added 1, moved 0, already there 0, invalid 1')
    expect(new DirectorySites(listings.db).adult().map((s) => s.host)).toEqual([ADULT_HOST])
    expect(await admin(['directory-move', ADULT_HOST, 'computers/software'], listings, out)).toBe(0)
    expect(await admin(['directory-remove', ADULT_HOST], listings, out)).toBe(0)
  })

  it('takes an adult site out of the business directory', () => {
    const listings = new Listings(':memory:')
    const sites = new DirectorySites(listings.db, Date.now, 0)
    listings.setBlocked((d) => sites.isAdult(d))
    expect(listings.seed({ domain: ADULT_HOST, name: ADULT_NAME, category: 'software' })).not.toBeNull()
    expect(listings.toPublic(ADULT_HOST)).not.toBeNull()
    seedDirectory(sites, [{ name: ADULT_NAME, url: `https://${ADULT_HOST}` }], 'adult')
    expect(listings.toPublic(ADULT_HOST)).toBeNull()
    expect(listings.seed({ domain: ADULT_HOST, name: ADULT_NAME, category: 'software' })).toBeNull()
    expect(listings.startClaim(ADULT_HOST)).toBeNull()
    expect(listings.importListings([{ domain: ADULT_HOST, name: ADULT_NAME, category: 'software', country: '', topics: [], sourceUrl: 'https://nichedb.dev/i/1' }])).toBe(0)
  })
})

describe('adult directory: an anonymous visitor', () => {
  it('sees no adult entry, count or category on any directory page', async () => {
    const { get } = world()
    for (const path of ['/directory', '/directory/new', '/directory/computers', '/directory/computers/software', '/directory?q=velvet', '/directory?q=studio', '/directory?q=adult']) {
      const res = await get(path)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(leaks(body)).toBe(false)
      expect(body).not.toContain('Adult (18+)')
      expect(body).not.toContain('/directory/adult')
      if (path.includes('?q=')) expect(body).toContain('Site Matches (0)')
    }
    // Searching for the host itself echoes the words typed and finds nothing.
    const byHost = await (await get(`/directory?q=${ADULT_HOST}`)).text()
    expect(byHost).toContain('Site Matches (0)')
    expect(byHost.includes(ADULT_NAME) || byHost.includes(ADULT_ABOUT)).toBe(false)
    const home = await (await get('/directory')).text()
    expect(home).toContain('2 sites')
    expect(await (await get('/directory/computers/software')).text()).toContain('Public Tool')
  })

  it('is sent to sign in by the category page, and back to it afterwards, never a 404', async () => {
    const { get } = world()
    for (const path of ['/directory/adult', '/directory/adult?q=velvet', '/directory/adult/sites']) {
      const res = await get(path)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/signin?next=%2Fdirectory%2Fadult')
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(res.headers.get('cache-control')).toBe('private, no-store')
    }
    expect((await get('/signin?next=%2Fdirectory%2Fadult')).status).toBe(200)
  })

  it('gets no adult entry from the JSON API, and a 401 for category=adult', async () => {
    const { get } = world()
    const res = await get('/api/directory')
    const json = (await res.json()) as any
    expect(json.count).toBe(2)
    expect(leaks(JSON.stringify(json))).toBe(false)
    expect(json.categories.some((c: any) => c.slug === 'adult')).toBe(false)
    expect(json.sites.find((s: any) => s.host === 'public-tool.test')).toMatchObject({ source: 'saasrow', categories: ['computers/software'] })
    const anonymous: Array<Record<string, string>> = [{}, { authorization: 'Bearer pw_not-a-real-token' }, { cookie: 'pw_session=forged' }]
    for (const headers of anonymous) {
      const gated = await get('/api/directory?category=adult', headers)
      expect(gated.status).toBe(401)
      const body = await gated.text()
      expect(body).toContain('The Adult category needs a signed-in account.')
      expect(leaks(body)).toBe(false)
      expect(gated.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    }
  })

  it('finds no adult site in web search, on any tab, or in the corpus', async () => {
    const { get } = world()
    const api = await get('/api/search?q=velvet+example')
    expect(api.status).toBe(200)
    const json = (await api.json()) as any
    expect(json.results.map((r: any) => r.host)).toEqual(['public-tool.test'])
    expect(leaks(JSON.stringify(json))).toBe(false)
    const page = await (await get('/search?q=velvet+studio')).text()
    expect(page).toContain('public-tool.test')
    expect(page.includes(ADULT_HOST) || page.includes(ADULT_ABOUT)).toBe(false)
    const corpus = await get('/api/corpus?q=studio')
    const text = await corpus.text()
    expect(text).toContain('public-tool.test')
    expect(leaks(text)).toBe(false)
  })

  it('finds no adult path in the sitemaps, robots keeps crawlers out, and suggestions say nothing', async () => {
    const { get } = world()
    for (const path of ['/sitemap.xml', '/sitemaps/pages.xml', '/sitemaps/pros.xml', '/b/feed.xml', '/pros', '/', '/ring', '/api/ring', '/api/pros', '/featured']) {
      const body = await (await get(path)).text()
      expect(leaks(body)).toBe(false)
      expect(body).not.toContain('/directory/adult')
    }
    expect(await (await get('/sitemaps/pages.xml')).text()).toContain('/directory/computers/software')
    expect(await (await get('/robots.txt')).text()).toContain('Disallow: /directory/adult')
    expect(leaks(await (await get('/suggest?q=velvet')).text())).toBe(false)
  })

  it('cannot open, claim or read a business listing for an adult site', async () => {
    const { get, app } = world()
    for (const path of [`/b/${ADULT_HOST}`, `/b/${ADULT_HOST}/openprofile.md`, `/b/${ADULT_HOST}/go`, `/b/www.${ADULT_HOST}/edit`]) {
      const res = await get(path)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/signin?next=%2Fdirectory%2Fadult')
    }
    const api = await get(`/api/listing?domain=${ADULT_HOST}`)
    expect(api.status).toBe(401)
    const claim = await app.request('/api/listing/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: ADULT_HOST }) }, { ip: '203.0.113.9' })
    expect(claim.status).toBe(401)
    expect((await get('/b/public-tool.test')).status).not.toBe(302)
  })

  it('cannot submit an adult site to the crawler, or seed the category', async () => {
    const { app, submitted } = world()
    const res = await app.request('/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urls: [`https://${ADULT_HOST}/`, 'https://public-tool.test/'] }) }, { ip: '203.0.113.9' })
    const json = (await res.json()) as any
    expect(json.rejected).toEqual([{ url: `https://${ADULT_HOST}/`, error: 'blocked-host' }])
    expect(submitted).toEqual([['https://public-tool.test/']])
    const seed = await app.request('/api/admin/directory/seed?category=adult', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' }, { ip: '203.0.113.9' })
    expect(seed.status).toBe(401)
  })
})

describe('adult directory: a signed-in member', () => {
  it('sees Adult (18+) among the categories and opens the category', async () => {
    const { get, asMember } = world()
    const home = await get('/directory', asMember)
    expect(home.headers.get('cache-control')).toBe('private, no-store')
    const homeBody = await home.text()
    expect(homeBody).toContain('<a href="/directory/adult" rel="nofollow">Adult (18+)</a> <small>(1)</small>')
    expect(leaks(homeBody)).toBe(false)
    const res = await get('/directory/adult', asMember)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const body = await res.text()
    expect(body).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(body).toContain('Adult content. You must be 18 or older.')
    expect(body).toContain(`<a href="https://www.${ADULT_HOST}/" rel="nofollow noopener noreferrer">${ADULT_NAME}</a>`)
    expect(body).toContain('4k, vr')
    expect(body).not.toContain('Public Tool')
  })

  it('searches inside the category only', async () => {
    const { get, asMember } = world()
    expect(await (await get('/directory/adult?q=velvet', asMember)).text()).toContain(ADULT_NAME)
    expect(await (await get('/directory/adult?q=nothing-here', asMember)).text()).not.toContain(ADULT_NAME)
    for (const path of ['/directory?q=velvet', '/directory/new', '/directory/computers/software', '/api/directory', '/api/search?q=velvet', '/sitemaps/pages.xml']) {
      expect(leaks(await (await get(path, asMember)).text())).toBe(false)
    }
  })

  it('lists the category over the API with a session or an account token, on category=adult only', async () => {
    const { get, asMember, token } = world()
    for (const headers of [asMember, { authorization: `Bearer ${token}` }]) {
      const res = await get('/api/directory?category=adult', headers)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      const json = (await res.json()) as any
      expect(json.category).toMatchObject({ slug: 'adult', name: 'Adult (18+)' })
      expect(json.sites).toHaveLength(1)
      expect(json.sites[0]).toMatchObject({ host: ADULT_HOST, name: ADULT_NAME, tags: ['4k', 'vr'] })
      expect(leaks(await (await get('/api/directory', headers)).text())).toBe(false)
    }
  })

  it('is sent to the category from an adult site business page', async () => {
    const { get, asMember } = world()
    const res = await get(`/b/${ADULT_HOST}`, asMember)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/directory/adult')
  })
})

describe('adult directory: staff seeding over the admin API', () => {
  it('files a JSON array under Adult for the admin token, and for an admin account', async () => {
    const { app, sites, asMember } = world()
    const post = (headers: Record<string, string>, body: unknown, query = '?category=adult') =>
      app.request(`/api/admin/directory/seed${query}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, { ip: '203.0.113.9' })
    const res = await post({ authorization: 'Bearer admin-token-for-tests' }, [{ name: 'Second', url: 'https://second-adult.test', description: 'd', tags: ['ai'] }])
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ category: 'adult', added: 1 })
    expect((await post(asMember, { category: 'adult', entries: [{ name: 'Third', url: 'https://third-adult.test' }] }, '')).status).toBe(200)
    expect(sites.adult().map((s) => s.host).sort()).toEqual([ADULT_HOST, 'second-adult.test', 'third-adult.test'])
    expect((await post({ authorization: 'Bearer admin-token-for-tests' }, [], '?category=nope')).status).toBe(400)
  })
})

describe('directory: filed sites', () => {
  it('pages a large subcategory and previews it on the category page', async () => {
    const db = new Database(':memory:')
    const sites = new DirectorySites(db, Date.now, 0)
    for (let i = 0; i < 130; i++) sites.add({ name: `Tool ${String(i).padStart(3, '0')}`, url: `https://tool-${i}.test/`, path: 'computers/software', source: 'pwamart' })
    const app = createApp({ keys: {}, directory: new Directory({ hosts: () => [], sites }) })
    const first = await (await app.request('/directory/computers/software')).text()
    expect(first).toContain('Tool 099')
    expect(first).not.toContain('Tool 100')
    expect(first).toContain('Page 1 of 2')
    expect(first).toContain('via <a href="https://pwamart.com/">pwamart</a>')
    const second = await (await app.request('/directory/computers/software?page=2')).text()
    expect(second).toContain('Tool 129')
    expect(second).not.toContain('Tool 099')
    const category = await (await app.request('/directory/computers')).text()
    expect(category).toContain('All 130 sites in Software')
    expect(category).not.toContain('Tool 030')
    const fresh = await (await app.request('/directory/new')).text()
    expect(fresh).toContain('New from our sister directories')
  })
})
