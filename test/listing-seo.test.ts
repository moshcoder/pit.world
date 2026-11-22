import { describe, expect, it } from 'bun:test'
import { classifyBusiness } from '../src/classify.ts'
import { IndexNow } from '../src/indexnow.ts'
import { decodeEntities, Listings, type Verifier } from '../src/listings.ts'
import { listingDescription, listingJsonLd, listingPage, listingTitle, pageJumps, prosPage, schemaType } from '../src/listings-html.ts'
import { listingSitemapCount, LISTINGS_PER_SITEMAP, prosHubPaths, sitemapIndex, urlset } from '../src/sitemap.ts'
import { createApp } from '../src/server.ts'

const PLUMBERSEO_DESC = 'The growth partner built for plumbing, HVAC and electrical contractors. 7.1M+ leads generated for 600+ home service companies over 15 years. Schedule a strategy session.'

function homepages(pages: Record<string, string>): Verifier {
  return { async txt() { return [] }, async homepage(d) { return pages[d] ?? null } }
}

/** A store with the plumberseo.net row as production had it: imported, "podcast" first topic, filed under media. */
function plumber(pages: Record<string, string> = {}) {
  const listings = new Listings(':memory:', homepages(pages))
  listings.importListings([
    { domain: 'plumberseo.net', name: 'Plumbing & HVAC SEO', category: 'media', topics: ['podcast'], sourceUrl: 'https://nichedb.dev/i/780414387' },
    { domain: 'acme-plumbing.com', name: 'Acme Plumbing', category: '', topics: [], sourceUrl: 'https://nichedb.dev/i/2' },
    { domain: 'growthleads.example', name: 'Growth Leads Marketing', category: '', topics: [], sourceUrl: 'https://nichedb.dev/i/3' },
  ])
  listings.db.run("UPDATE listings SET category = 'media', description = ? WHERE domain = 'plumberseo.net'", [PLUMBERSEO_DESC])
  listings.db.run("UPDATE listings SET category = 'marketing', description = 'Lead generation for local businesses.' WHERE domain = 'growthleads.example'")
  return listings
}

describe('classifier: a business by its own words', () => {
  it('files plumberseo.net as marketing, not media, though NicheDB found it through its podcast', () => {
    expect(classifyBusiness({ name: 'Plumbing & HVAC SEO', description: PLUMBERSEO_DESC, domain: 'plumberseo.net', topics: ['podcast'] })).toBe('marketing')
  })
  it('reads trades, churches, shows and topics', () => {
    expect(classifyBusiness({ name: 'Acme Plumbing', description: 'Emergency plumber and water heater repair in Austin.' })).toBe('home-services')
    expect(classifyBusiness({ name: 'Brookside Church', description: 'Find and follow Jesus. Sunday worship.', topics: ['podcast'] })).toBe('community')
    expect(classifyBusiness({ name: 'A Heavy Weight', description: 'A true crime podcast about forgotten cases.', topics: ['podcast'] })).toBe('media')
    expect(classifyBusiness({ name: 'Diario Ahora', description: 'Noticias de Huánuco y Perú.', topics: ['news & media'] })).toBe('media')
    expect(classifyBusiness({ name: 'Bornwild', description: 'Licensed home birth midwife serving Sonoma County.', topics: ['podcast'] })).toBe('health')
    expect(classifyBusiness({ name: 'Quiet Co', description: '', topics: ['software'] })).toBe('software')
    expect(classifyBusiness({ name: 'Quiet Co', description: '', topics: ['google analytics'] })).toBe('')
    // "seo" is a word start, never inside another word.
    expect(classifyBusiness({ name: 'Museo del Prado', description: 'Art museum in Madrid.' })).not.toBe('marketing')
  })
  it('decodes character references read from homepages', () => {
    expect(decodeEntities('F&#229; viden &amp; Fu&szlig;ball &#xE9;t&eacute;')).toBe('Få viden & Fußball été')
    expect(decodeEntities('&bogus; stays')).toBe('&bogus; stays')
  })
})

describe('listing page: title, description, structured data, content', () => {
  it('re-files imported listings once with the new rules', () => {
    const listings = plumber()
    expect(listings.recategorizeImported(classifyBusiness, 'test')).toBeGreaterThan(0)
    expect(listings.toPublic('plumberseo.net')!.category).toBe('marketing')
    expect(listings.recategorizeImported(classifyBusiness, 'test')).toBe(0)
  })

  it('leads the title with the name and domain, adds the category, stays short and unique', () => {
    const listings = plumber()
    listings.recategorizeImported(classifyBusiness, 'test')
    const l = listings.toPublic('plumberseo.net')!
    const title = listingTitle(l)
    expect(title).toBe('Plumbing & HVAC SEO (plumberseo.net) – Marketing & SEO | pit.world')
    expect(title.length).toBeLessThanOrEqual(70)
    expect(title).not.toMatch(/review|rating/i)
    const description = listingDescription(l)
    expect(description).toStartWith('Plumbing & HVAC SEO (plumberseo.net) · Marketing & SEO.')
    expect(description).toContain('Claim this listing free')
    expect(description.length).toBeLessThanOrEqual(165)
  })

  it('a name that is only the domain is not repeated', () => {
    const listings = new Listings(':memory:', homepages({}))
    listings.seed({ domain: 'acme.com', name: 'acme.com', category: 'retail' })
    expect(listingTitle(listings.toPublic('acme.com')!)).toBe('acme.com – Shops & retail | pit.world')
  })

  it('emits a valid JSON-LD graph: the business type, breadcrumbs, FAQ; no invented address or phone', () => {
    const listings = plumber()
    listings.recategorizeImported(classifyBusiness, 'test')
    const l = listings.toPublic('plumberseo.net')!
    const ld = JSON.parse(listingJsonLd(l))
    expect(ld['@context']).toBe('https://schema.org')
    const types = ld['@graph'].map((n: any) => n['@type'])
    expect(types).toEqual(['OnlineBusiness', 'BreadcrumbList', 'WebPage', 'FAQPage'])
    const biz = ld['@graph'][0]
    expect(biz.name).toBe('Plumbing & HVAC SEO')
    expect(biz.url).toBe('https://plumberseo.net/')
    expect(biz.sameAs).toContain('https://plumberseo.net/')
    expect(biz.address).toBeUndefined()
    expect(biz.telephone).toBeUndefined()
    expect(biz.email).toBeUndefined()
    const crumbs = ld['@graph'][1].itemListElement
    expect(crumbs.map((c: any) => c.name)).toEqual(['pit.world', 'Business directory', 'Marketing & SEO', 'Plumbing & HVAC SEO'])
    expect(crumbs.map((c: any) => c.position)).toEqual([1, 2, 3, 4])
    const faq = ld['@graph'][3].mainEntity
    expect(faq.map((q: any) => q.name)).toContain("Is this Plumbing & HVAC SEO's official page?")
    for (const q of faq) expect(q.acceptedAnswer.text.length).toBeGreaterThan(10)
  })

  it('uses LocalBusiness types for local trades and placed businesses, with only the address parts it holds', () => {
    const listings = new Listings(':memory:', homepages({}))
    listings.seed({ domain: 'builder.example', name: 'Builder Co', category: 'construction', city: 'Los Gatos', region: 'CA', area: 'South Bay' })
    listings.seed({ domain: 'pipes.example', name: 'Pipes Plumbing', category: 'home-services' })
    listings.seed({ domain: 'agency.example', name: 'Agency', category: 'marketing', city: 'Austin' })
    const b = JSON.parse(listingJsonLd(listings.toPublic('builder.example')!))['@graph'][0]
    expect(b['@type']).toBe('GeneralContractor')
    expect(b.address).toEqual({ '@type': 'PostalAddress', addressLocality: 'Los Gatos', addressRegion: 'CA' })
    expect(schemaType(listings.toPublic('pipes.example')!)).toBe('Plumber')
    expect(schemaType(listings.toPublic('agency.example')!)).toBe('ProfessionalService')
  })

  it('puts the claim button above the fold, then the summary, similar businesses and a factual FAQ', () => {
    const listings = plumber()
    listings.recategorizeImported(classifyBusiness, 'test')
    const l = listings.toPublic('plumberseo.net')!
    const html = listingPage(l, { similar: listings.similar('plumberseo.net') })
    const cta = html.indexOf('class="claim-cta"')
    expect(cta).toBeGreaterThan(-1)
    expect(cta).toBeLessThan(html.indexOf('About Plumbing &amp; HVAC SEO'))
    expect(html).toContain('<title>Plumbing &amp; HVAC SEO (plumberseo.net) – Marketing &amp; SEO | pit.world</title>')
    expect(html).toContain('application/ld+json')
    expect(html).toContain('Similar Marketing &amp; SEO businesses')
    expect(html).toContain('href="/b/growthleads.example"')
    expect(html).toContain('Questions about Plumbing &amp; HVAC SEO')
    expect(html).toContain('How does the owner of plumberseo.net claim this listing?')
    expect(html).toContain('aria-label="Breadcrumb"')
    expect(html).not.toMatch(/★|stars?\b|rated \d/i)
    expect(html).not.toContain('noindex')
  })

  it('a thin listing stays noindex and carries no structured data', () => {
    const listings = plumber()
    const html = listingPage(listings.toPublic('acme-plumbing.com')!)
    expect(html).toContain('noindex')
    expect(html).not.toContain('application/ld+json')
    expect(html).toContain('class="claim-cta"')
  })
})

describe('describing the backlog and telling IndexNow', () => {
  it('reads unread homepages, files them from their own words and reports newly indexable listings', async () => {
    const listings = plumber({ 'acme-plumbing.com': '<title>Acme Plumbing</title><meta name="description" content="Emergency plumber &amp; drain cleaning in Austin.">' })
    const changed: string[] = []
    listings.onChange((d) => changed.push(d))
    const r = await listings.describeBacklog(10, 2)
    expect(r.checked).toBe(3)
    expect(r.described).toBe(1)
    const l = listings.toPublic('acme-plumbing.com')!
    expect(l.description).toBe('Emergency plumber & drain cleaning in Austin.')
    expect(l.category).toBe('home-services')
    expect(changed).toEqual(['acme-plumbing.com'])
    // Read once: a site that did not answer is not asked again by the backlog.
    expect(listings.describeRemaining()).toBe(0)
    expect((await listings.describeBacklog(10)).checked).toBe(0)
  })

  it('replaces a podcast title with the homepage name when it reads the homepage again', async () => {
    const listings = new Listings(':memory:', homepages({ 'brookes.example': '<title>Oxford Brookes University</title><meta name="description" content="A modern university in Oxford.">' }))
    listings.importListings([{ domain: 'brookes.example', name: 'Brokenness and Repair Podcast', topics: ['podcast'], sourceUrl: 'https://nichedb.dev/i/9' }])
    await listings.describeBacklog(5)
    expect(listings.toPublic('brookes.example')).toMatchObject({ name: 'Oxford Brookes University', category: 'education' })
    expect(listings.repairImported('v1').requeued).toBe(1)
    expect(listings.repairImported('v1').requeued).toBe(0)
  })

  it('queues our own URLs, batches them into one POST with the key, and ignores other hosts', async () => {
    const posts: any[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) })
      return new Response('', { status: 202 })
    }) as unknown as typeof fetch
    const now = new IndexNow('abcdef0123456789abcdef0123456789', { fetchImpl, delayMs: 10_000 })
    now.queue('https://pit.world/b/a.example')
    now.queue('https://pit.world/b/a.example')
    now.queue('https://pit.world/b/b.example')
    now.queue('https://evil.example/b/c')
    expect(now.queued).toBe(2)
    const r = await now.flush()
    expect(r).toEqual({ sent: 2, statuses: [202] })
    expect(posts[0].url).toBe('https://api.indexnow.org/indexnow')
    expect(posts[0].body).toEqual({ host: 'pit.world', key: 'abcdef0123456789abcdef0123456789', keyLocation: 'https://pit.world/abcdef0123456789abcdef0123456789.txt', urlList: ['https://pit.world/b/a.example', 'https://pit.world/b/b.example'] })
  })

  it('serves the key file', async () => {
    const indexNow = new IndexNow('abcdef0123456789abcdef0123456789')
    const app = createApp({ keys: {}, listings: plumber(), indexNow })
    const res = await app.request('/abcdef0123456789abcdef0123456789.txt', {}, { ip: '203.0.113.9' })
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe('abcdef0123456789abcdef0123456789')
  })
})

describe('sitemaps and hubs', () => {
  it('serves an index of child sitemaps; listings carry lastmod; hubs list category pages', async () => {
    const listings = plumber()
    listings.recategorizeImported(classifyBusiness, 'test')
    listings.seed({ domain: 'acme-builders.com', name: 'Acme Builders', description: 'Custom homes.', category: 'construction' })
    const app = createApp({ keys: {}, listings })
    const get = async (path: string) => (await app.request(path, {}, { ip: '203.0.113.9' })).text()
    const index = await get('/sitemap.xml')
    expect(index).toContain('<sitemapindex')
    for (const child of ['pages.xml', 'pros.xml', 'listings-1.xml']) expect(index).toContain(`<loc>https://pit.world/sitemaps/${child}</loc>`)
    expect(index).not.toContain('listings-2.xml')
    const one = await get('/sitemaps/listings-1.xml')
    expect(one).toContain('<loc>https://pit.world/b/acme-builders.com</loc><lastmod>')
    expect(one).toContain('<loc>https://pit.world/b/plumberseo.net</loc>')
    expect(one).not.toContain('acme-plumbing.com')
    const pros = await get('/sitemaps/pros.xml')
    expect(pros).toContain('<loc>https://pit.world/pros/marketing</loc>')
    expect(pros).toContain('<loc>https://pit.world/pros/construction</loc>')
    expect((await app.request('/sitemaps/listings-2.xml', {}, { ip: '203.0.113.9' })).status).toBe(404)
    expect(await get('/robots.txt')).toContain('Sitemap: https://pit.world/sitemap.xml')
  })

  it('splits listings into files of at most 40,000 and pages hubs to the indexable end', () => {
    expect(listingSitemapCount(0)).toBe(1)
    expect(listingSitemapCount(LISTINGS_PER_SITEMAP)).toBe(1)
    expect(listingSitemapCount(LISTINGS_PER_SITEMAP + 1)).toBe(2)
    expect(prosHubPaths({ retail: 45, legal: 0 }, 20, 2000, ['retail', 'legal'])).toEqual(['/pros', '/pros/retail', '/pros/retail?page=2', '/pros/retail?page=3'])
    expect(urlset([{ loc: '/a?b=1&c=2', lastmod: Date.UTC(2026, 10, 22) }])).toContain('<loc>https://pit.world/a?b=1&amp;c=2</loc><lastmod>2026-11-22T00:00:00Z</lastmod>')
    expect(sitemapIndex([{ loc: '/sitemaps/pages.xml' }])).toContain('<sitemap><loc>https://pit.world/sitemaps/pages.xml</loc></sitemap>')
  })

  it('later directory pages are indexable with their own canonical, and link far pages in a few jumps', () => {
    expect(pageJumps(1, 500)).toEqual([1, 2, 3, 10, 20, 30, 100, 200, 300, 500])
    expect(pageJumps(250, 500)).toContain(300)
    const html = prosPage({ listings: [], total: 900, category: 'retail', near: '', q: '', page: 3, perPage: 20, counts: {} })
    expect(html).toContain('noindex') // an empty page is never indexed
    const listings = plumber()
    listings.recategorizeImported(classifyBusiness, 'test')
    const page = prosPage({ listings: [listings.toPublic('plumberseo.net')!], total: 900, category: 'marketing', near: '', q: '', page: 3, perPage: 20, counts: {} })
    expect(page).toContain('<link rel="canonical" href="https://pit.world/pros/marketing?page=3">')
    expect(page).toContain('href="/pros/marketing?page=10"')
    expect(page).not.toContain('noindex')
  })

  it('the *.pit.world directory links the business directory hubs', async () => {
    const { directoryHome } = await import('../src/directory.ts')
    const html = directoryHome({ entries: [], filed: new Map() } as any)
    expect(html).toContain('href="/pros/marketing"')
  })
})
