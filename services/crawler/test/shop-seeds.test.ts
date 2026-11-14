import { describe, expect, test } from 'bun:test'
import { C0UPONS_STORES, SHOP_CLASSES, shopsSparql, sitesFromC0upons, sitesFromC0uponsStores, sitesFromSparql } from '../src/seed.ts'
import { productFirst } from '../src/url.ts'

describe('shop seeds', () => {
  test("c0upons stores: the website, else the favicon's domain, once each", () => {
    const sites = sitesFromC0uponsStores([
      { name: '32 Degrees', website: 'https://32degrees.com', logo_url: 'https://www.google.com/s2/favicons?domain=32degrees.com&sz=128' },
      { name: 'Adorama', website: 'https://www.adorama.com/', logo_url: null },
      { name: 'No site', website: null, logo_url: 'https://www.google.com/s2/favicons?domain=acmetools.com&sz=128' },
      { name: '7-Eleven', website: null, logo_url: null },
      { name: 'Dup', website: 'https://32degrees.com/' },
    ])
    expect(sites).toEqual(['32degrees.com', 'adorama.com', 'acmetools.com'])
    expect(sitesFromC0uponsStores({ error: 'nope' })).toEqual([])
  })

  test('c0upons is asked at its public store list', async () => {
    const asked: string[] = []
    const fake = (async (url: string | URL | Request) => {
      asked.push(String(url))
      return Response.json([{ website: 'https://shop.example' }])
    }) as typeof fetch
    expect(await sitesFromC0upons(fake)).toEqual(['shop.example'])
    expect(asked).toEqual([C0UPONS_STORES])
  })

  test('Wikidata: the five shop classes, official websites as sites', () => {
    const q = shopsSparql()
    for (const c of SHOP_CLASSES) expect(q).toContain(`wd:${c}`)
    expect(q).toContain('wdt:P856')
    expect(
      sitesFromSparql({ results: { bindings: [{ w: { value: 'https://www.ikea.com/' } }, { w: { value: 'http://www.lidl.de' } }, { w: { value: 'not a url' } }, { w: { value: 'https://www.ikea.com/us/en/' } }] } }),
    ).toEqual(['ikea.com', 'lidl.de'])
  })
})

describe('product pages first', () => {
  test('product sitemaps and product-looking pages lead, the rest keep their order', () => {
    expect(
      productFirst([
        'https://s.example/sitemap_pages_1.xml',
        'https://s.example/sitemap_products_1.xml?from=1',
        'https://s.example/blogs/news',
        'https://s.example/p/123',
        'https://s.example/collections/all',
        'https://s.example/dp/B000123',
      ]),
    ).toEqual([
      'https://s.example/sitemap_products_1.xml?from=1',
      'https://s.example/p/123',
      'https://s.example/dp/B000123',
      'https://s.example/sitemap_pages_1.xml',
      'https://s.example/blogs/news',
      'https://s.example/collections/all',
    ])
  })
})
