import { describe, expect, it } from 'bun:test'
import { createApp } from '../src/server.ts'

const IMAGE = 'https://cdn.shop.example/shoe.jpg'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff])

/** A pit.world with our own index answering one product, and a small web for /img to fetch from. */
function shop(web: Record<string, () => Response> = {}) {
  const fetched: string[] = []
  const fake = (async (url: string | URL | Request) => {
    const u = String(url)
    fetched.push(u)
    if (u.startsWith('http://index.test/api/v1/search')) {
      return Response.json({ items: [{ url: 'https://shop.example/shoe', title: 'Trail shoe', site: 'shop.example', summary: 'Light.', image: IMAGE, price: '$89.50' }] })
    }
    return web[u]?.() ?? new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })
  }) as typeof fetch
  const app = createApp({
    keys: { pit: 'http://index.test' },
    fetch: fake,
    fingerprintSecret: 'a-test-secret-long-enough',
    // A host is public unless it says it is not.
    resolve: async (host: string) => (host.includes('internal') ? ['10.0.0.5'] : ['93.184.216.34']),
  } as never)
  const request = (path: string) => app.request(path, {}, { ip: '203.0.113.7' })
  const card = async () => {
    const html = await (await request('/search?q=shoes&t=shopping')).text()
    return { html, src: html.match(/src="(\/img\?[^"]+)"/)?.[1]?.replace(/&amp;/g, '&') }
  }
  return { request, card, fetched }
}

describe('product pictures', () => {
  it('a card shows its picture and price, through /img, signed', async () => {
    const { card } = shop()
    const { html, src } = await card()
    expect(html).toContain('$89.50')
    expect(src).toContain(encodeURIComponent(IMAGE))
    expect(src).toContain('&s=')
    expect(html).not.toContain(`src="${IMAGE}"`)
  })

  it('/img fetches what we signed', async () => {
    const { request, card } = shop()
    const { src } = await card()
    const r = await request(src!)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/jpeg')
  })

  it('without our signature the same address is refused, so this is no open proxy', async () => {
    const { request, card, fetched } = shop()
    const { src } = await card()
    const before = fetched.length
    expect((await request(`/img?u=${encodeURIComponent(IMAGE)}`)).status).toBe(400)
    expect((await request(`/img?u=${encodeURIComponent(IMAGE)}&s=wrong`)).status).toBe(400)
    // A real signature on another address is worth nothing.
    const stolen = src!.split('&s=')[1]
    expect((await request(`/img?u=${encodeURIComponent('https://evil.example/x.png')}&s=${stolen}`)).status).toBe(400)
    expect(fetched.length).toBe(before)
  })

  it('a signed picture cannot redirect into a private network', async () => {
    const { request, card, fetched } = shop({
      [IMAGE]: () => new Response(null, { status: 302, headers: { location: 'https://internal.example/secret.png' } }),
    })
    const { src } = await card()
    expect((await request(src!)).status).toBe(502)
    expect(fetched.some((u) => u.includes('internal.example'))).toBe(false)
  })

  it('only pictures: a signed address that answers HTML is refused', async () => {
    const { request, card } = shop({ [IMAGE]: () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) })
    const { src } = await card()
    expect((await request(src!)).status).toBe(502)
  })
})
