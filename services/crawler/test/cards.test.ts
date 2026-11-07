import { describe, expect, test } from 'bun:test'
import { configFromEnv } from '../src/config.ts'
import { createCrawler } from '../src/crawler.ts'
import { extract, priceOf } from '../src/extract.ts'
import { MemoryFrontier } from '../src/frontier.ts'
import { IndexStore } from '../src/index-store.ts'

const PRODUCT = `<html><head><title>Trail shoe</title>
<meta property="og:type" content="product"><meta property="og:image" content="https://cdn.shop.example/shoe.jpg">
<script type="application/ld+json">{"@type":"Product","name":"Trail shoe","offers":{"price":"89.50","priceCurrency":"USD"}}</script>
</head><body><main>A very good shoe for trails and for running a long way.</main></body></html>`

describe('prices', () => {
  test('Open Graph first, then JSON-LD offers, in the shop own currency', () => {
    expect(priceOf({ 'product:price:amount': '12.99', 'product:price:currency': 'GBP' }, [])).toBe('£12.99')
    expect(priceOf({}, [{ offers: { price: 89.5, priceCurrency: 'USD' } }])).toBe('$89.5')
    expect(priceOf({}, [{ '@graph': [{ offers: [{ lowPrice: '5', priceCurrency: 'CHF' }] }] }])).toBe('CHF 5')
  })
  test('no price, or nonsense, says nothing rather than something wrong', () => {
    expect(priceOf({}, [])).toBeNull()
    expect(priceOf({ 'product:price:amount': 'call us' }, [])).toBeNull()
    expect(priceOf({}, [{ offers: { price: 0 } }])).toBeNull()
  })
  test('a product page carries both into the record', () => {
    const doc = extract(PRODUCT, 'https://shop.example/shoe', {})
    expect(doc.record.image?.url).toBe('https://cdn.shop.example/shoe.jpg')
    expect(doc.enrichment.price).toBe('$89.50')
  })
})

describe('cards', () => {
  test('a product kept by the crawl has its card; a page that has none is remembered as none', () => {
    const store = new IndexStore(':memory:')
    const doc = extract(PRODUCT, 'https://shop.example/shoe', {})
    store.add([JSON.stringify({ record: { ...doc.record, kind: 'product' }, enrichment: doc.enrichment })])
    expect(store.cards(['https://shop.example/shoe']).get('https://shop.example/shoe')).toEqual({ image: 'https://cdn.shop.example/shoe.jpg', price: '$89.50' })
    expect(store.cards(['https://never.example/']).size).toBe(0)
    store.setCard('https://bare.example/', null, null)
    expect(store.cards(['https://bare.example/']).get('https://bare.example/')).toEqual({ image: null, price: null })
  })

  const crawlerWith = (fetchImpl: typeof fetch) => {
    const store = new IndexStore(':memory:')
    const noop = async () => {}
    const crawler = createCrawler({ config: configFromEnv({}), frontier: new MemoryFrontier(1000), fetch: fetchImpl, resolver: async () => true, index: store as never, enqueue: { sites: noop, pages: noop, render: noop } })
    return { crawler, store }
  }

  test('an older product page is read once and its card kept', async () => {
    const fake = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/robots.txt')) return new Response('', { status: 404 })
      if (String(url).includes('tdmrep')) return new Response('', { status: 404 })
      return new Response(PRODUCT, { headers: { 'content-type': 'text/html' } })
    }) as typeof fetch
    const { crawler, store } = crawlerWith(fake)
    await crawler.fillCards(['https://shop.example/shoe'])
    expect(store.cards(['https://shop.example/shoe']).get('https://shop.example/shoe')?.price).toBe('$89.50')
  })

  test('robots.txt is honoured, and the answer is kept so the site is not asked again', async () => {
    let pages = 0
    const fake = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } })
      if (String(url).includes('tdmrep')) return new Response('', { status: 404 })
      pages++
      return new Response(PRODUCT, { headers: { 'content-type': 'text/html' } })
    }) as typeof fetch
    const { crawler, store } = crawlerWith(fake)
    await crawler.fillCards(['https://shop.example/shoe'])
    expect(pages).toBe(0)
    expect(store.cards(['https://shop.example/shoe']).get('https://shop.example/shoe')).toEqual({ image: null, price: null })
  })
})
