import { describe, expect, it } from 'bun:test'
import { AuctionHouse, createAuctionApp, isAuctionHost } from '../src/auctions.js'

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l0sAAAAASUVORK5CYII=', 'base64'))

describe('Art Auctions House', () => {
  it('serves only its two exact hostnames', () => {
    expect(isAuctionHost('AUCTIONS.PIT.WORLD:443')).toBe(true)
    expect(isAuctionHost('art.auctions.pit.world')).toBe(true)
    expect(isAuctionHost('other.auctions.pit.world')).toBe(false)
    expect(isAuctionHost('auctions.pit.world.example')).toBe(false)
  })

  it('accepts a mobile multipart artwork submission and serves the saved image', async () => {
    const house = new AuctionHouse()
    const app = createAuctionApp(house)
    const landing = await app.fetch(new Request('https://auctions.pit.world/'))
    expect(landing.status).toBe(200)
    expect(await landing.text()).toContain('Good art deserves')

    const form = new FormData()
    form.set('title', 'Small morning')
    form.set('artist', 'Ada Artist')
    form.set('medium', 'Watercolor')
    form.set('description', 'A quiet study.')
    form.set('permission', 'yes')
    form.set('image', new File([png], 'morning.png', { type: 'image/png' }))
    const response = await app.fetch(new Request('https://auctions.pit.world/new', {
      method: 'POST',
      headers: { origin: 'https://auctions.pit.world' },
      body: form,
    }), { ip: '203.0.113.8' })

    expect(response.status).toBe(303)
    const location = response.headers.get('location')!
    expect(location).toMatch(/^\/art\/[A-Za-z0-9_-]+$/)

    const detail = await app.fetch(new Request(`https://auctions.pit.world${location}`))
    expect(detail.status).toBe(200)
    expect(await detail.text()).toContain('Ada Artist')
    const id = location.split('/').at(-1)!
    const image = await app.fetch(new Request(`https://auctions.pit.world/image/${id}`))
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png)
    house.db.close()
  })

  it('rejects submissions from another origin and images with mismatched content', async () => {
    const house = new AuctionHouse()
    const app = createAuctionApp(house)
    const foreign = new FormData()
    const csrf = await app.fetch(new Request('https://auctions.pit.world/new', {
      method: 'POST',
      headers: { origin: 'https://example.net' },
      body: foreign,
    }), { ip: '203.0.113.9' })
    expect(csrf.status).toBe(403)

    const form = new FormData()
    form.set('title', 'Not a picture')
    form.set('artist', 'Ada Artist')
    form.set('permission', 'yes')
    form.set('image', new File(['<script>'], 'bad.png', { type: 'image/png' }))
    const invalid = await app.fetch(new Request('https://auctions.pit.world/new', {
      method: 'POST',
      headers: { origin: 'https://auctions.pit.world' },
      body: form,
    }), { ip: '203.0.113.10' })
    expect(invalid.status).toBe(415)
    expect(house.list()).toHaveLength(0)
    house.db.close()
  })

  it('defaults to the warm theme and lets a visitor switch to the blue theme', async () => {
    const house = new AuctionHouse()
    const app = createAuctionApp(house)
    const landing = await (await app.fetch(new Request('https://auctions.pit.world/'))).text()
    expect(landing).toContain('data-theme="warm"')
    expect(landing).toContain('href="/theme/blue?back=%2F"')

    const pick = await app.fetch(new Request('https://auctions.pit.world/theme/blue?back=%2Fnew'))
    expect(pick.status).toBe(303)
    expect(pick.headers.get('location')).toBe('/new')
    const cookie = pick.headers.get('set-cookie')!
    expect(cookie).toContain('aa_theme=blue')

    const warm = await (await app.fetch(new Request('https://auctions.pit.world/new', { headers: { cookie: 'aa_theme=blue' } }))).text()
    expect(warm).toContain('data-theme="blue"')
    expect(warm).toContain('content="#eef3fa"')

    const css = await (await app.fetch(new Request('https://auctions.pit.world/style.css'))).text()
    expect(css).toContain('[data-theme=blue]')

    for (const back of ['https://evil.example/', '//evil.example/', '/\\evil.example']) {
      const res = await app.fetch(new Request(`https://auctions.pit.world/theme/warm?back=${encodeURIComponent(back)}`))
      expect(res.headers.get('location')).toBe('/')
    }
    const bogus = await app.fetch(new Request('https://auctions.pit.world/theme/neon'))
    expect(bogus.headers.get('set-cookie')).toBeNull()
    house.db.close()
  })
})
