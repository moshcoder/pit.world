import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Listings, type Verifier } from '../src/listings.ts'
import { listingPage } from '../src/listings-html.ts'
import { categoryFor, importCandidate, importNicheDb, IMPORT_SOURCE } from '../src/nichedb-import.ts'
import { createApp } from '../src/server.ts'

const verifier: Verifier = { async txt() { return [] }, async homepage() { return null } }

const item = (id: number, url: string, extra: { kind?: string; topics?: string[]; name?: string } = {}) => ({
  id,
  kind: extra.kind ?? 'company',
  url,
  title: extra.name ?? url,
  page: `https://nichedb.dev/i/${id}`,
  data: { row: { kind: extra.kind ?? 'company', name: extra.name ?? '', topics: extra.topics ?? [], country: null } },
})

function store() {
  const listings = new Listings(':memory:', verifier)
  listings.seed({ domain: 'acme-builders.com', name: 'Acme Builders', description: 'Custom homes.', category: 'construction' })
  return listings
}

describe('nichedb import: candidates', () => {
  it('maps industries to categories', () => {
    expect(categoryFor('news & media')).toBe('media')
    expect(categoryFor('podcast')).toBe('media')
    expect(categoryFor('AI tooling')).toBe('software')
    expect(categoryFor('Construction & remodeling')).toBe('construction')
    expect(categoryFor('e-commerce')).toBe('retail')
    expect(categoryFor('petroleum industry')).toBe('industrial')
    expect(categoryFor('wordpress')).toBe('')
    expect(categoryFor('google analytics')).toBe('')
    expect(categoryFor('google tag manager')).toBe('')
    expect(categoryFor('shopify')).toBe('retail')
    expect(categoryFor('software')).toBe('software')
  })

  it('takes companies with a domain and a NicheDB record; refuses people, sites, pit.world names and adult businesses', () => {
    expect(importCandidate(item(1, 'https://www.zaol.hu/', { topics: ['news & media'], name: 'Zaol' }))).toEqual({
      domain: 'zaol.hu', name: 'Zaol', category: 'media', country: '', topics: ['news & media'], sourceUrl: 'https://nichedb.dev/i/1',
    })
    expect(importCandidate(item(2, 'https://lanius.dev', { kind: 'site' }))).toBeNull()
    expect(importCandidate(item(3, 'https://someone.example', { kind: 'person' }))).toBeNull()
    expect(importCandidate(item(4, 'https://seo.rank.pit.world'))).toBeNull()
    expect(importCandidate(item(5, 'https://x.example', { topics: ['pornography industry'] }))).toBeNull()
    expect(importCandidate(item(6, 'https://bestcasino.example'))).toBeNull()
    expect(importCandidate({ ...item(7, 'https://ok.example'), page: 'https://evil.example/i/7' })).toBeNull()
  })
})

describe('nichedb import: runs', () => {
  it('pages by id after the saved cursor, lists only domains that resolve, and stops when caught up', async () => {
    const listings = store()
    const asked: string[] = []
    const pages: Record<string, unknown[]> = {
      '0': Array.from({ length: 200 }, (_, i) => item(i + 1, `https://co${i + 1}.example`, { topics: ['software'], name: `Co ${i + 1}` })),
      '200': [item(201, 'https://dead.example'), item(202, 'https://acme-builders.com', { name: 'Not Acme' }), item(203, 'https://late.example', { topics: ['retail'] })],
    }
    const fetchImpl = (async (input: URL) => {
      const after = new URL(String(input)).searchParams.get('after') ?? '0'
      asked.push(String(input))
      return new Response(JSON.stringify({ items: pages[after] ?? [] }))
    }) as typeof fetch
    const resolves = async (d: string) => d !== 'dead.example'
    const r = await importNicheDb(listings, { fetchImpl, resolves, pages: 5 })
    expect(asked[0]).toBe('https://nichedb.dev/api/v1/items?collection=directory&sort=id&order=asc&limit=200')
    expect(asked[1]).toContain('after=200')
    expect(r).toMatchObject({ read: 203, candidates: 203, resolved: 202, caughtUp: true, cursor: '203' })
    expect(listings.importCursor(IMPORT_SOURCE)).toBe('203')
    expect(listings.toPublic('dead.example')).toBeNull()
    // A listing pit.world wrote keeps what it wrote.
    expect(listings.toPublic('acme-builders.com')).toMatchObject({ name: 'Acme Builders', seeded: true, imported: false, source: 'pit' })
    expect(listings.toPublic('late.example')).toMatchObject({ imported: true, source: 'nichedb', category: 'retail', claimed: false, researchUrl: 'https://nichedb.dev/i/203' })
    expect(listings.sourceCounts()).toEqual({ claimed: 0, seeded: 1, imported: 201, importedIndexable: 0 })
  })
})

describe('nichedb import: directory, pages and sitemap', () => {
  function filled() {
    const listings = store()
    listings.importListings(
      Array.from({ length: 30 }, (_, i) => ({ domain: `shop${String(i).padStart(2, '0')}.example`, name: `Shop ${i}`, category: i % 2 ? 'retail' : '', topics: ['retail'], sourceUrl: `https://nichedb.dev/i/${i + 1}` })),
    )
    listings.db.run("UPDATE listings SET description = 'A real shop.' WHERE domain = 'shop01.example'")
    return listings
  }

  it('lists curated first, then imported a page at a time with filters in SQL', () => {
    const listings = filled()
    const first = listings.directory({ limit: 20 })
    expect(first.total).toBe(31)
    expect(first.listings[0]!.domain).toBe('acme-builders.com')
    // The indexable one (description + category) leads the imported ones.
    expect(first.listings[1]!.domain).toBe('shop01.example')
    const second = listings.directory({ limit: 20, offset: 20 })
    expect(second.listings).toHaveLength(11)
    expect(new Set([...first.listings, ...second.listings].map((l) => l.domain)).size).toBe(31)
    expect(listings.directory({ category: 'retail', limit: 100 }).total).toBe(15)
    expect(listings.directory({ q: 'shop 2', limit: 100 }).listings.map((l) => l.domain)).toContain('shop02.example')
    expect(listings.directory({ q: 'shop_', limit: 100 }).total).toBe(0)
    expect(listings.directory({ source: 'pit', limit: 100 }).total).toBe(1)
    expect(listings.directory({ source: 'nichedb', limit: 100 }).total).toBe(30)
    expect(listings.directory({ claimedOnly: true }).total).toBe(0)
    expect(listings.categoryCounts().retail).toBe(15)
  })

  it('indexes only imported listings with a description and a category; every one has claim and vote buttons and the source note', () => {
    const listings = filled()
    const thin = listingPage(listings.toPublic('shop03.example')!)
    expect(thin).toContain('<meta name="robots" content="noindex">')
    expect(thin).toContain('Claim this listing')
    expect(thin).toContain('Unclaimed listing, data from <a href="https://nichedb.dev/i/4"')
    const rich = listingPage(listings.toPublic('shop01.example')!)
    expect(rich).not.toContain('noindex')
    expect(listings.sitemapDomains()).toEqual(['acme-builders.com', 'shop01.example'])
    expect(listings.directoryDomains()).toEqual(['acme-builders.com'])
  })

  it('serves imported listings on /b, /pros, the API and the sitemap', async () => {
    const listings = filled()
    const app = createApp({ keys: {}, listings })
    const page = await app.request('/b/shop03.example', {}, { ip: '203.0.113.9' })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('noindex')
    expect(html).toContain('data-item="listing:shop03.example"')
    expect(html).toContain('Claim this listing')
    const pros = await (await app.request('/pros/retail', {}, { ip: '203.0.113.9' })).text()
    expect(pros).toContain('shop01.example')
    expect(pros).toContain('Unclaimed listing, data from')
    const api = (await (await app.request('/api/pros?source=pit&n=100', {}, { ip: '203.0.113.9' })).json()) as { total: number }
    expect(api.total).toBe(1)
    const sitemap = await (await app.request('/sitemap.xml', {}, { ip: '203.0.113.9' })).text()
    expect(sitemap).toContain('/b/shop01.example')
    expect(sitemap).not.toContain('/b/shop03.example')
  })

  it('claiming an imported listing hands it to the owner', async () => {
    const listings = filled()
    const v = { txt: {} as Record<string, string[]> }
    const owned = new Listings(':memory:', { async txt(h) { return v.txt[h] ?? [] }, async homepage() { return null } })
    owned.importListings([{ domain: 'mine.example', name: 'Mine', category: 'retail', sourceUrl: 'https://nichedb.dev/i/9' }])
    const start = owned.startClaim('mine.example')!
    v.txt[start.txtHost] = [start.token]
    expect((await owned.verify(start.claimId)).ok).toBe(true)
    expect(owned.toPublic('mine.example')).toMatchObject({ claimed: true, imported: false, source: 'pit' })
    expect(owned.directory({ source: 'nichedb' }).total).toBe(0)
    expect(listings.sourceCounts().imported).toBe(30)
  })

  it('re-categorises imported listings once when the rules change, never curated ones', () => {
    const listings = store()
    listings.importListings([
      { domain: 'church.example', name: 'Church', category: 'software', topics: ['google analytics'], sourceUrl: 'https://nichedb.dev/i/1' },
      { domain: 'store.example', name: 'Store', category: '', topics: ['shopify'], sourceUrl: 'https://nichedb.dev/i/2' },
    ])
    expect(listings.recategorizeImported(categoryFor, '2')).toBe(2)
    expect(listings.toPublic('church.example')!.category).toBe('')
    expect(listings.toPublic('store.example')!.category).toBe('retail')
    expect(listings.toPublic('acme-builders.com')!.category).toBe('construction')
    expect(listings.recategorizeImported(categoryFor, '2')).toBe(0)
  })

  it('reopens an existing database without re-adding the generated quality column (0.23.0 crash loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pit-listings-'))
    try {
      const path = join(dir, 'listings.db')
      const first = new Listings(path, verifier)
      first.importListings([{ domain: 'kept.example', name: 'Kept', category: 'retail', sourceUrl: 'https://nichedb.dev/i/1' }])
      first.db.close()
      const again = new Listings(path, verifier)
      expect(again.toPublic('kept.example')).toMatchObject({ imported: true, category: 'retail' })
      again.db.close()
      expect(() => new Listings(path, verifier).db.close()).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
