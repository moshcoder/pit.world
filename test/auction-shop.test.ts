import { describe, expect, it } from 'bun:test'
import { AuctionHouse, createAuctionApp } from '../src/auctions.js'
import { AuctionShop, retailUsd, type ShopItem } from '../src/auction-shop.js'
import { SHOP_CATALOG } from '../src/shop-catalog.js'

const item: ShopItem = {
  slug: 'cafe-au-lait-dahlia', topic: 'dahlias', name: 'Café au Lait dahlia tuber', blurb: 'Dinner-plate blooms in blush and cream.', priceUsd: 99,
  supplier: { name: 'grower', url: 'https://www.ebay.com/itm/1', title: 'Cafe au lait tuber', costUsd: 14, shippingUsd: 6, shipsFrom: 'Salem, OR' }, season: 'Ships in spring',
}

function fakePayAgent() {
  const invoices = new Map<string, any>()
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    if (init?.method === 'POST' && path === '/api/v1/invoices') {
      const body = JSON.parse(String(init.body))
      const id = `inv_${invoices.size + 1}`
      invoices.set(id, { id, url: `https://pay.agent.test/i/${id}`, amount_usd: body.amount_usd, description: body.description, status: 'open' })
      return Response.json(invoices.get(id))
    }
    const m = /^\/api\/v1\/invoices\/(.+)$/.exec(path)
    if (m) return Response.json(invoices.get(decodeURIComponent(m[1]!)))
    return Response.json({ invoices: [...invoices.values()] })
  }) as unknown as typeof globalThis.fetch
  return { invoices, fetch }
}

const order = (fields: Record<string, string>, headers: Record<string, string> = { origin: 'https://auctions.pit.world' }) => {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return new Request('https://auctions.pit.world/shop/cafe-au-lait-dahlia', { method: 'POST', headers, body: form })
}
const good = { name: 'Maile', email: 'buyer@example.com', address1: '1 Cliff Dr', city: 'Capitola', state: 'CA', zip: '95010', agree: 'yes' }

describe('Art Auctions flower shop', () => {
  it('prices at five times cost ending in 9', () => {
    expect(retailUsd(14, 6)).toBe(99)
    expect(retailUsd(10, 0)).toBe(49)
    expect(retailUsd(12.5, 5)).toBe(89)
  })

  it('sells, waits for a verified payment, notifies, and ships', async () => {
    const house = new AuctionHouse()
    const pay = fakePayAgent()
    const mail: { to: string; subject: string; text: string }[] = []
    const shop = new AuctionShop(house.db, [item], { payAgentUrl: 'https://pay.agent.test', key: 'pa_test', fetch: pay.fetch, notifyTo: 'owner@example.com', mailer: async (m) => { mail.push(m) } })
    const app = createAuctionApp(house, { shop, adminToken: 'admin-secret' })

    expect(await (await app.fetch(new Request('https://auctions.pit.world/shop'))).text()).toContain('Café au Lait dahlia tuber')
    expect(await (await app.fetch(new Request('https://auctions.pit.world/topics/dahlias'))).text()).toContain('href="/shop#dahlias"')

    expect((await app.fetch(order(good, { origin: 'https://evil.example' }), { ip: '1' })).status).toBe(403)
    expect((await app.fetch(order({ ...good, state: 'ON' }), { ip: '2' })).status).toBe(400)

    const res = await app.fetch(order(good), { ip: '3' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('https://pay.agent.test/i/inv_1')
    const [saved] = shop.list()
    expect(saved!.status).toBe('open')
    expect(saved!.amount_usd).toBe(99)
    expect(mail.at(-1)!.to).toBe('buyer@example.com')

    await shop.tick()
    expect(shop.get(saved!.id)!.status).toBe('open')
    pay.invoices.get('inv_1').status = 'paid'
    await shop.tick()
    await shop.tick()
    expect(shop.get(saved!.id)!.status).toBe('paid')
    const placeOrder = mail.filter((m) => m.subject.startsWith('PLACE ORDER'))
    expect(placeOrder).toHaveLength(1)
    expect(placeOrder[0]!.to).toBe('owner@example.com')
    expect(placeOrder[0]!.text).toContain('https://www.ebay.com/itm/1')
    expect(placeOrder[0]!.text).toContain('Capitola, CA 95010')

    expect((await app.fetch(new Request(`https://auctions.pit.world/shop/order/${saved!.id}?k=wrong`))).status).toBe(404)
    const status = await (await app.fetch(new Request(`https://auctions.pit.world/shop/order/${saved!.id}?k=${saved!.view_key}`))).text()
    expect(status).toContain('Paid, ordering from the grower')

    const admin = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return app.fetch(new Request('https://auctions.pit.world/shop/admin', { method: 'POST', headers: { origin: 'https://auctions.pit.world' }, body: f })) }
    expect((await admin({ token: 'nope' })).status).toBe(403)
    const list = await (await admin({ token: 'admin-secret' })).text()
    expect(list).toContain('1 Cliff Dr')
    await admin({ token: 'admin-secret', id: saved!.id, action: 'placed', ref: 'EB-123' })
    await admin({ token: 'admin-secret', id: saved!.id, action: 'shipped', tracking: '1Z999' })
    expect(shop.get(saved!.id)!.status).toBe('shipped')
    expect(mail.at(-1)!.subject).toStartWith('Shipped')
    expect(mail.at(-1)!.text).toContain('1Z999')
    house.db.close()
  })

  it('never marks an order paid when the invoice amount or description differs', async () => {
    const house = new AuctionHouse()
    const pay = fakePayAgent()
    const shop = new AuctionShop(house.db, [item], { payAgentUrl: 'https://pay.agent.test', key: 'pa_test', fetch: pay.fetch })
    const app = createAuctionApp(house, { shop })
    await app.fetch(order(good), { ip: '4' })
    Object.assign(pay.invoices.get('inv_1'), { status: 'paid', amount_usd: 1 })
    await shop.tick()
    expect(shop.list()[0]!.status).toBe('open')
    house.db.close()
  })

  it('shows the shop but refuses checkout when pay.agent is not configured', async () => {
    const house = new AuctionHouse()
    const app = createAuctionApp(house, { shop: new AuctionShop(house.db, [item], null) })
    expect(await (await app.fetch(new Request('https://auctions.pit.world/shop/cafe-au-lait-dahlia'))).text()).toContain('Checkout opens soon')
    expect((await app.fetch(order(good), { ip: '5' })).status).toBe(400)
    house.db.close()
  })

  it('refuses a state the grower will not ship to, and the real catalog is sane', async () => {
    const house = new AuctionHouse()
    const pay = fakePayAgent()
    const mum = SHOP_CATALOG.find((i) => i.slug === 'coffee-heirloom-mums')!
    const shop = new AuctionShop(house.db, [mum], { payAgentUrl: 'https://pay.agent.test', key: 'pa_test', fetch: pay.fetch })
    await expect(shop.start(mum.slug, { ...good })).rejects.toThrow('cannot ship to CA')
    expect(pay.invoices.size).toBe(0)
    expect(new Set(SHOP_CATALOG.map((i) => i.slug)).size).toBe(SHOP_CATALOG.length)
    for (const i of SHOP_CATALOG) {
      expect(i.priceUsd % 10).toBe(9)
      expect(i.priceUsd).toBeGreaterThan(i.supplier.costUsd + i.supplier.shippingUsd)
      expect(new URL(i.supplier.url).protocol).toBe('https:')
    }
    house.db.close()
  })
})
