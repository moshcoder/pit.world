import { describe, expect, it } from 'bun:test'
import { AuctionHouse, createAuctionApp, isAuctionHost, sniffVideo } from '../src/auctions.js'
import { createApp } from '../src/server.js'

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

    const href = /<link rel="stylesheet" href="([^"]+)"/.exec(landing)![1]
    expect(href).toMatch(/^\/style\.css\?v=[0-9a-f]{12}$/)
    const styled = await app.fetch(new Request(`https://auctions.pit.world${href}`))
    expect(styled.headers.get('cache-control')).toContain('immutable')
    const css = await styled.text()
    expect(css).toContain('[data-theme=blue]')
    // :root (the warm default) and [data-theme=blue] tie on specificity, so blue must be declared after it.
    expect(css.indexOf('html[data-theme=blue]{')).toBeGreaterThan(css.indexOf(':root,[data-theme=warm]{'))

    for (const back of ['https://evil.example/', '//evil.example/', '/\\evil.example']) {
      const res = await app.fetch(new Request(`https://auctions.pit.world/theme/warm?back=${encodeURIComponent(back)}`))
      expect(res.headers.get('location')).toBe('/')
    }
    const bogus = await app.fetch(new Request('https://auctions.pit.world/theme/neon'))
    expect(bogus.headers.get('set-cookie')).toBeNull()
    house.db.close()
  })

  it('lets the theme cookie through the pit.world app, and only on the auction theme route', async () => {
    const house = new AuctionHouse()
    const app = createApp({ keys: {}, auctions: house })
    const pick = await app.fetch(new Request('https://auctions.pit.world/theme/blue?back=%2F', { headers: { host: 'auctions.pit.world' } }))
    expect(pick.status).toBe(303)
    expect(pick.headers.get('set-cookie')).toContain('aa_theme=blue')
    const page = await app.fetch(new Request('https://auctions.pit.world/', { headers: { host: 'auctions.pit.world', cookie: 'aa_theme=blue' } }))
    expect(page.headers.get('set-cookie')).toBeNull()
    expect(await page.text()).toContain('data-theme="blue"')
    house.db.close()
  })

  it('accepts the Origin: null a browser sends under no-referrer, only for same-origin posts', async () => {
    const house = new AuctionHouse()
    const app = createAuctionApp(house)
    const post = (headers: Record<string, string>, ip: string) => {
      const form = new FormData()
      form.set('title', 'Logo')
      form.set('artist', 'Ada Artist')
      form.set('permission', 'yes')
      form.set('image', new File([png], 'logo.png', { type: 'image/png' }))
      return app.fetch(new Request('https://auctions.pit.world/new', { method: 'POST', headers, body: form }), { ip })
    }
    expect((await post({ origin: 'null', 'sec-fetch-site': 'same-origin' }, '203.0.113.20')).status).toBe(303)
    expect((await post({ origin: 'null', 'sec-fetch-site': 'cross-site' }, '203.0.113.21')).status).toBe(403)
    expect((await post({ origin: 'null' }, '203.0.113.22')).status).toBe(403)
    expect(house.list()).toHaveLength(1)
    house.db.close()
  })

  it('accepts a phone video, sniffs its real type and serves byte ranges', async () => {
    const house = new AuctionHouse()
    const app = createAuctionApp(house)
    // A minimal ISO BMFF header: [size]ftyp + brand, then padding.
    const mp4 = new Uint8Array(64)
    mp4.set([0, 0, 0, 0x18], 0)
    mp4.set([...'ftypqt  '].map((ch) => ch.charCodeAt(0)), 4)
    expect(sniffVideo(mp4)).toBe('video/quicktime')
    const form = new FormData()
    form.set('title', 'Dahlia timelapse')
    form.set('artist', 'Ada Artist')
    form.set('permission', 'yes')
    form.set('image', new File([mp4], 'IMG_0001.MOV', { type: '' }))
    const res = await app.fetch(new Request('https://auctions.pit.world/new', { method: 'POST', headers: { origin: 'https://auctions.pit.world' }, body: form }), { ip: '203.0.113.30' })
    expect(res.status).toBe(303)
    const id = res.headers.get('location')!.split('/').at(-1)!
    const page = await (await app.fetch(new Request(`https://auctions.pit.world/art/${id}`))).text()
    expect(page).toContain('<video class="detail-image"')
    const home = await (await app.fetch(new Request('https://auctions.pit.world/'))).text()
    expect(home).toContain('<video src="/image/')
    const ranged = await app.fetch(new Request(`https://auctions.pit.world/image/${id}`, { headers: { range: 'bytes=0-15' } }))
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 0-15/64')
    expect(ranged.headers.get('content-type')).toBe('video/quicktime')
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(mp4.slice(0, 16))
    const bad = new FormData()
    bad.set('title', 'Fake')
    bad.set('artist', 'Ada Artist')
    bad.set('permission', 'yes')
    bad.set('image', new File(['<html>'], 'fake.mp4', { type: 'video/mp4' }))
    expect((await app.fetch(new Request('https://auctions.pit.world/new', { method: 'POST', headers: { origin: 'https://auctions.pit.world' }, body: bad }), { ip: '203.0.113.31' })).status).toBe(415)
    house.db.close()
  })

  it('files a piece under a topic, lists topic pages and shows placeholders for empty ones', async () => {
    const house = new AuctionHouse()
    const app = createAuctionApp(house)
    const home0 = await (await app.fetch(new Request('https://auctions.pit.world/'))).text()
    for (const slug of ['landscapes', 'seacliffs', 'mountains', 'ceramics']) expect(home0).toContain(`href="/topics/${slug}"`)
    expect(home0).not.toContain('href="/topics/dahlias"')
    const index = await (await app.fetch(new Request('https://auctions.pit.world/topics'))).text()
    for (const slug of ['dahlias', 'mums', 'roses', 'seacliffs', 'forests', 'wildlife', 'houses', 'ceramics', 'textiles']) expect(index).toContain(`href="/topics/${slug}"`)
    expect(index.indexOf('id="nature"')).toBeLessThan(index.indexOf('id="flowers-and-gardens"'))
    const mountains = await (await app.fetch(new Request('https://auctions.pit.world/topics/mountains'))).text()
    expect(mountains).toContain('Your mountain here')
    expect(mountains).toContain('k-peaks ph-mountains')
    expect(mountains).toContain('href="/topics/forests"')
    const css = await (await app.fetch(new Request('https://auctions.pit.world/style.css'))).text()
    expect(css).toContain('.ph-mountains{--sky1:')
    const empty = await (await app.fetch(new Request('https://auctions.pit.world/topics/roses'))).text()
    expect(empty).toContain('Your rose here')
    expect(empty).toContain('href="/new?topic=roses"')
    expect((await (await app.fetch(new Request('https://auctions.pit.world/topics/seacliffs'))).text())).toContain('Your sea cliff here')
    expect(await (await app.fetch(new Request('https://auctions.pit.world/new?topic=mums'))).text()).toContain('value="mums" selected')

    const form = new FormData()
    form.set('title', 'Cafe au lait')
    form.set('artist', 'Ada Artist')
    form.set('topic', 'dahlias')
    form.set('permission', 'yes')
    form.set('image', new File([png], 'dahlia.png', { type: 'image/png' }))
    const res = await app.fetch(new Request('https://auctions.pit.world/new', { method: 'POST', headers: { origin: 'https://auctions.pit.world' }, body: form }), { ip: '203.0.113.40' })
    expect(res.status).toBe(303)
    const dahlias = await (await app.fetch(new Request('https://auctions.pit.world/topics/dahlias'))).text()
    expect(dahlias).toContain('Cafe au lait')
    expect(dahlias).not.toContain('Your dahlia here')
    expect(await (await app.fetch(new Request('https://auctions.pit.world/topics/mums'))).text()).not.toContain('Cafe au lait')
    expect(await (await app.fetch(new Request(`https://auctions.pit.world${res.headers.get('location')}`))).text()).toContain('href="/topics/dahlias"')
    expect((await app.fetch(new Request('https://auctions.pit.world/topics/tulips'))).status).toBe(404)
    expect((await app.fetch(new Request('https://auctions.pit.world/topics'))).status).toBe(200)

    const bogus = new FormData()
    bogus.set('title', 'Sneaky')
    bogus.set('artist', 'Ada Artist')
    bogus.set('topic', '<script>')
    bogus.set('permission', 'yes')
    bogus.set('image', new File([png], 'x.png', { type: 'image/png' }))
    expect((await app.fetch(new Request('https://auctions.pit.world/new', { method: 'POST', headers: { origin: 'https://auctions.pit.world' }, body: bogus }), { ip: '203.0.113.41' })).status).toBe(303)
    expect(house.list().find((w) => w.title === 'Sneaky')!.topic).toBe('')
    house.db.close()
  })

  it('adds the topic column to a database made before topics existed', () => {
    const { Database } = require('bun:sqlite')
    const path = `${require('node:os').tmpdir()}/auctions-migrate-${process.pid}.db`
    const old = new Database(path, { create: true })
    old.exec("CREATE TABLE auction_artworks (id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, medium TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', image_type TEXT NOT NULL, image BLOB NOT NULL, created_at INTEGER NOT NULL)")
    old.query("INSERT INTO auction_artworks VALUES ('a', 'Logo', 'Ada', '', '', 'image/png', x'00', 1)").run()
    old.close()
    const house = new AuctionHouse(path)
    expect(house.get('a')!.topic).toBe('')
    house.db.close()
    require('node:fs').rmSync(path, { force: true }); require('node:fs').rmSync(`${path}-wal`, { force: true }); require('node:fs').rmSync(`${path}-shm`, { force: true })
  })


  it('archives and removes the requested test post once', async () => {
    const { Database } = require('bun:sqlite')
    const fs = require('node:fs')
    const path = require('node:os').tmpdir() + '/auctions-remove-test-post-' + process.pid + '.db'
    const id = '0RZW_lLDiS_z_1lM'
    const originalImage = Uint8Array.from([1, 2, 3, 4])
    const old = new Database(path, { create: true })
    old.exec("CREATE TABLE auction_artworks (id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, medium TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', image_type TEXT NOT NULL, image BLOB NOT NULL, topic TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)")
    old.query('INSERT INTO auction_artworks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'Test post', 'Anthony', 'PNG', 'test artwork', 'image/png', originalImage, '', 1)
    old.close()

    const house = new AuctionHouse(path)
    expect(house.get(id)).toBeNull()
    expect(house.image(id)).toBeNull()
    const archived = house.db.query<{ title: string; artist: string; image: Uint8Array; reason: string }, [string]>(
      'SELECT title, artist, image, reason FROM auction_artwork_archive WHERE id = ?',
    ).get(id)!
    expect(archived).toMatchObject({ title: 'Test post', artist: 'Anthony', reason: 'Anthony requested removal of this test post' })
    expect(new Uint8Array(archived.image)).toEqual(originalImage)

    const app = createAuctionApp(house)
    const home = await (await app.fetch(new Request('https://auctions.pit.world/'))).text()
    expect(home).not.toContain('Test post')
    expect((await app.fetch(new Request('https://auctions.pit.world/art/' + id))).status).toBe(404)
    expect((await app.fetch(new Request('https://auctions.pit.world/image/' + id))).status).toBe(404)
    house.db.close()

    const reopened = new AuctionHouse(path)
    expect(reopened.get(id)).toBeNull()
    expect(reopened.db.query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM auction_artwork_archive WHERE id = ?').get(id)?.count).toBe(1)
    reopened.db.close()
    fs.rmSync(path, { force: true }); fs.rmSync(path + '-wal', { force: true }); fs.rmSync(path + '-shm', { force: true })
  })
})
