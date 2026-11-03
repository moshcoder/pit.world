import { describe, expect, it } from 'bun:test'
import type { BridgeClient } from '@profullstack/bridges'
import { AuctionHouse, createAuctionApp } from '../src/auctions.js'
import { cleanPayLink, readSession, sessionValue } from '../src/auction-accounts.js'

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l0sAAAAASUVORK5CYII=', 'base64'))
const SECRET = 'test-session-secret'
const ORIGIN = { origin: 'https://auctions.pit.world' }

function fakeBridge(users: Record<string, { sub: string; name: string }>): BridgeClient {
  return {
    async begin(o) { return { url: `https://pit.world/bridge/authorize?return=${encodeURIComponent(o?.returnTo ?? '/')}`, cookie: `state:${o?.returnTo ?? '/'}`, maxAge: 600 } },
    async complete(callback, cookie) {
      const who = new URL(String(callback)).searchParams.get('who') ?? ''
      const returnTo = String(cookie ?? '').replace(/^state:/, '') || '/'
      return users[who] ? { ok: true, user: users[who]!, returnTo } : { ok: false, error: 'denied', returnTo, prompt: null }
    },
  } as BridgeClient
}

describe('Art Auctions accounts and bidding', () => {
  it('signs in with CoinPay through the bridge and returns to the page', async () => {
    const house = new AuctionHouse()
    const app = createAuctionApp(house, { bridge: fakeBridge({ ada: { sub: 'did:coinpay:ada', name: 'Ada' } }), sessionSecret: SECRET })
    const start = await app.fetch(new Request('https://auctions.pit.world/signin?return=%2Fart%2Fabc'))
    expect(start.status).toBe(302)
    expect(start.headers.get('location')).toStartWith('https://pit.world/bridge/authorize')
    const bridgeCookie = start.headers.get('set-cookie')!.split(';')[0]!
    const back = await app.fetch(new Request('https://auctions.pit.world/auth/bridge/callback?who=ada', { headers: { cookie: bridgeCookie } }))
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/art/abc')
    expect(back.headers.getSetCookie().some((c) => c.startsWith('aa_session='))).toBe(true)
    const evil = await app.fetch(new Request('https://auctions.pit.world/signin?return=https%3A%2F%2Fevil.example'))
    expect(decodeURIComponent(evil.headers.get('location')!)).toContain('return=/')
    expect(readSession('forged.payload', SECRET, Date.now())).toBeNull()
    house.db.close()
  })

  it('runs an auction: starting bid, $5 steps, no self-bids, admin can list a piece, close shows the winner', async () => {
    let clock = 1_800_000_000_000
    const house = new AuctionHouse()
    const app = createAuctionApp(house, { sessionSecret: SECRET, adminSubs: ['did:coinpay:anthony'], now: () => clock })
    const as = (sub: string, name: string) => ({ cookie: `aa_session=${encodeURIComponent(sessionValue({ sub, name }, SECRET, clock))}` })
    const artist = as('did:coinpay:nan', 'Nan')
    house.ledger.touch({ sub: 'did:coinpay:nan', name: 'Nan' }, clock)
    house.ledger.saveSettings('did:coinpay:nan', { payLink: 'https://coinpayportal.com/pay/nan', email: 'nan@example.com' }, clock)

    const form = new FormData()
    form.set('title', 'Roses for Anthony')
    form.set('artist', 'Nan')
    form.set('topic', 'roses')
    form.set('starting_bid', '20')
    form.set('days', '7')
    form.set('permission', 'yes')
    form.set('image', new File([png], 'rose.png', { type: 'image/png' }))
    const res = await app.fetch(new Request('https://auctions.pit.world/new', { method: 'POST', headers: { ...ORIGIN, ...artist }, body: form }), { ip: '1' })
    expect(res.status).toBe(303)
    const id = res.headers.get('location')!.split('/').at(-1)!
    expect(house.get(id)!.owner_sub).toBe('did:coinpay:nan')
    expect(await (await app.fetch(new Request(`https://auctions.pit.world/art/${id}`))).text()).toContain('Starting bid <b>$20</b>')

    const bid = (who: Record<string, string>, amount: number, headers: Record<string, string> = ORIGIN) => {
      const f = new FormData(); f.set('amount', String(amount))
      return app.fetch(new Request(`https://auctions.pit.world/art/${id}/bid`, { method: 'POST', headers: { ...headers, ...who }, body: f }))
    }
    const bob = as('did:coinpay:bob', 'Bob'), cy = as('did:coinpay:cy', 'Cy')
    expect(await (await bid(bob, 15)).text()).toContain('at least $20')
    expect(await (await bid(artist, 30)).text()).toContain('cannot bid on your own piece')
    expect((await bid(bob, 20, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await bid({}, 20)).headers.get('location')).toStartWith('/signin?return=')
    expect(await (await bid(bob, 20)).text()).toContain('Your bid of $20 is in')
    expect(await (await bid(cy, 24)).text()).toContain('at least $25')
    expect(await (await bid(cy, 25)).text()).toContain('Current bid <b>$25</b> by Cy')

    // Terms are fixed once bids are in; nobody but the artist or an admin can change them.
    const change = (who: Record<string, string>) => { const f = new FormData(); f.set('starting_bid', '5'); f.set('days', '3'); return app.fetch(new Request(`https://auctions.pit.world/art/${id}/auction`, { method: 'POST', headers: { ...ORIGIN, ...who }, body: f })) }
    expect(await (await change(bob)).text()).toContain('Only the artist or the house')
    expect(await (await change(artist)).text()).toContain('already has bids')

    clock += 8 * 86_400_000
    const closed = house.closeDue(clock)
    expect(closed.map((p) => p.id)).toEqual([id])
    const won = await (await app.fetch(new Request(`https://auctions.pit.world/art/${id}`, { headers: cy }))).text()
    expect(won).toContain('Sold for <b>$25</b> to Cy')
    expect(won).toContain('https://coinpayportal.com/pay/nan')
    expect(await (await app.fetch(new Request('https://auctions.pit.world/account', { headers: cy }))).text()).toContain('you won')

    // An admin can put a piece nobody owns up for auction (a piece uploaded for someone else).
    const plain = house.add({ title: 'Rose study', artist: 'Nan', medium: '', description: '', imageType: 'image/png', image: png }, clock)
    const f = new FormData(); f.set('starting_bid', '20'); f.set('days', '7')
    const admin = as('did:coinpay:anthony', 'Anthony')
    expect(await (await app.fetch(new Request(`https://auctions.pit.world/art/${plain}/auction`, { method: 'POST', headers: { ...ORIGIN, ...admin }, body: f }))).text()).toContain('Starting bid <b>$20</b>')
    house.db.close()
  })

  it('only accepts CoinPay and pay.agent links for getting paid, and owners can delete pieces with no bids', async () => {
    expect(cleanPayLink('https://coinpayportal.com/pay/x')).toBe('https://coinpayportal.com/pay/x')
    expect(cleanPayLink('https://pay.agent.pit.world/nan')).toBe('https://pay.agent.pit.world/nan')
    expect(cleanPayLink('http://coinpayportal.com/pay/x')).toBeNull()
    expect(cleanPayLink('https://evil.example/pay')).toBeNull()
    expect(cleanPayLink('')).toBe('')
    const house = new AuctionHouse()
    const app = createAuctionApp(house, { sessionSecret: SECRET })
    const id = house.add({ title: 'Mine', artist: 'Ada', medium: '', description: '', imageType: 'image/png', image: png, ownerSub: 'did:coinpay:ada' })
    const ada = { cookie: `aa_session=${encodeURIComponent(sessionValue({ sub: 'did:coinpay:ada', name: 'Ada' }, SECRET, Date.now()))}` }
    const other = { cookie: `aa_session=${encodeURIComponent(sessionValue({ sub: 'did:coinpay:zed', name: 'Zed' }, SECRET, Date.now()))}` }
    expect(await (await app.fetch(new Request(`https://auctions.pit.world/art/${id}/delete`, { method: 'POST', headers: { ...ORIGIN, ...other } }))).text()).toContain('Only the artist or the house')
    const gone = await app.fetch(new Request(`https://auctions.pit.world/art/${id}/delete`, { method: 'POST', headers: { ...ORIGIN, ...ada } }))
    expect(gone.status).toBe(303)
    expect(house.get(id)).toBeNull()
    house.db.close()
  })
})
