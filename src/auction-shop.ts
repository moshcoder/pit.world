/**
 * The Art Auctions House flower shop (auctions.pit.world/shop): drop-shipped plants and flowers,
 * paid by CoinPay invoice through pay.agent, fulfilled by hand.
 *
 * Flow: the buyer picks an item and gives a US shipping address -> we reserve an order, then ask
 * pay.agent for a CoinPay invoice and send the buyer to it -> every minute tick() asks pay.agent
 * whether that exact invoice (id, amount, description) is paid -> on payment the owner gets a
 * PLACE ORDER email with the supplier link and the address, the buyer gets a receipt -> the owner
 * buys it from the supplier, then marks the order placed and shipped in /shop/admin (the buyer is
 * emailed the tracking number). Returning from checkout proves nothing; only pay.agent does.
 */
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { Hono, Context } from 'hono'
import type { Mailer } from './newsletter.js'
import { RateLimiter } from './ratelimit.js'

export type ShopTopic = 'dahlias' | 'mums' | 'roses' | 'other'

export type ShopItem = {
  slug: string
  topic: ShopTopic
  /** Our name and copy; the supplier's listing title stays private. */
  name: string
  blurb: string
  /** Whole dollars the buyer pays, shipping included. */
  priceUsd: number
  supplier: { name: string; url: string; title: string; costUsd: number; shippingUsd: number; shipsFrom: string }
  /** Shown to buyers: when it ships, and where it cannot. */
  season?: string
  restrictions?: string
  /** States the grower will not ship to; checkout refuses them. */
  excludeStates?: string[]
  /** The supplier shows shipping only at checkout; shippingUsd is our estimate. */
  shippingEstimated?: boolean
}

/** Cigar Underground pricing: five times what we pay (item + shipping), ending in 9. */
export const MARKUP = 5
export function retailUsd(costUsd: number, shippingUsd: number): number {
  const raw = Math.ceil((costUsd + shippingUsd) * MARKUP)
  // A round ten drops a dollar ($100 -> $99); anything else rounds up to the next 9.
  return raw % 10 === 0 ? Math.max(9, raw - 1) : Math.ceil((raw - 9) / 10) * 10 + 9
}

export type ShopInvoicing = {
  payAgentUrl: string
  key: string
  mailer?: Mailer | null
  /** Who places the supplier orders. */
  notifyTo?: string
  fetch?: typeof fetch
}

type OrderStatus = 'creating' | 'open' | 'unknown' | 'paid' | 'placed' | 'shipped' | 'cancelled'
export type ShopOrder = {
  id: string
  item_slug: string
  amount_usd: number
  email: string
  name: string
  address1: string
  address2: string
  city: string
  state: string
  zip: string
  note: string
  status: OrderStatus
  provider_id: string | null
  url: string | null
  description: string
  view_key: string
  supplier_ref: string
  tracking: string
  created_at: number
  paid_at: number | null
  placed_at: number | null
  shipped_at: number | null
  checked_at: number
}

export class OrderError extends Error {}

const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ')
const clean = (value: unknown, length: number) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length)

export class AuctionShop {
  private running = false
  private readonly orders = new RateLimiter(3, 1 / 60)

  constructor(readonly db: Database, readonly catalog: ShopItem[], private cfg: ShopInvoicing | null, private now = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS shop_orders (
      id TEXT PRIMARY KEY, item_slug TEXT NOT NULL, amount_usd INTEGER NOT NULL,
      email TEXT NOT NULL, name TEXT NOT NULL, address1 TEXT NOT NULL, address2 TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL, state TEXT NOT NULL, zip TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL, provider_id TEXT UNIQUE, url TEXT, description TEXT NOT NULL, view_key TEXT NOT NULL,
      supplier_ref TEXT NOT NULL DEFAULT '', tracking TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, paid_at INTEGER, placed_at INTEGER, shipped_at INTEGER, checked_at INTEGER NOT NULL DEFAULT 0
    ); CREATE INDEX IF NOT EXISTS shop_orders_status ON shop_orders(status, checked_at);`)
  }

  get open(): boolean {
    return Boolean(this.cfg)
  }

  item(slug: string): ShopItem | undefined {
    return this.catalog.find((i) => i.slug === slug)
  }

  get(id: string): ShopOrder | null {
    return this.db.query<ShopOrder, [string]>('SELECT * FROM shop_orders WHERE id = ?').get(id) ?? null
  }

  /** The buyer's own view of an order: only with the key from their email. */
  view(id: string, key: string): ShopOrder | null {
    const order = this.get(id)
    if (!order || !key) return null
    const a = createHash('sha256').update(order.view_key).digest(), b = createHash('sha256').update(key).digest()
    return timingSafeEqual(a, b) ? order : null
  }

  list(limit = 100): ShopOrder[] {
    return this.db.query<ShopOrder, [number]>("SELECT * FROM shop_orders WHERE status != 'creating' ORDER BY created_at DESC LIMIT ?").all(limit)
  }

  allow(ip: string): boolean {
    return this.orders.take(ip)
  }

  /** Validate the form, reserve the order, then create its invoice. Returns the order and where to pay. */
  async start(slug: string, form: Record<string, unknown>): Promise<{ order: ShopOrder; payUrl: string }> {
    if (!this.cfg) throw new OrderError('Checkout is not open yet. Please check back soon.')
    const item = this.item(slug)
    if (!item) throw new OrderError('That item is not in the shop.')
    const email = clean(form.email, 254).toLowerCase()
    const name = clean(form.name, 100)
    const address1 = clean(form.address1, 120)
    const address2 = clean(form.address2, 120)
    const city = clean(form.city, 80)
    const state = clean(form.state, 2).toUpperCase()
    const zip = clean(form.zip, 10)
    const note = clean(form.note, 300)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new OrderError('Enter the email address for your receipt and tracking.')
    if (!name || !address1 || !city) throw new OrderError('Enter the name and full shipping address.')
    if (!US_STATES.includes(state)) throw new OrderError('Choose a US state. The shop ships to US addresses only.')
    if (item.excludeStates?.includes(state)) throw new OrderError(`This grower cannot ship to ${state}. Please choose another item or address.`)
    if (!/^\d{5}(-\d{4})?$/.test(zip)) throw new OrderError('Enter a 5-digit US ZIP code.')
    if (form.agree !== 'yes') throw new OrderError('Please confirm the shipping terms.')
    const id = randomUUID()
    const description = `auctions.pit.world shop: ${item.name} — $${item.priceUsd} — ${id}`
    const viewKey = randomBytes(18).toString('base64url')
    this.db.query(`INSERT INTO shop_orders (id,item_slug,amount_usd,email,name,address1,address2,city,state,zip,note,status,description,view_key,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'creating',?,?,?)`).run(id, item.slug, item.priceUsd, email, name, address1, address2, city, state, zip, note, description, viewKey, this.now())
    try {
      const data = await this.call('/api/v1/invoices', {
        method: 'POST',
        body: JSON.stringify({ to_email: email, amount_usd: item.priceUsd, description, due_date: new Date(this.now()).toISOString().slice(0, 10) }),
      })
      const url = new URL(data.url)
      if (url.protocol !== 'https:' || url.origin !== new URL(this.cfg.payAgentUrl).origin || typeof data.id !== 'string' || !data.id || data.amount_usd !== item.priceUsd)
        throw new Error('Invalid invoice response')
      this.db.query("UPDATE shop_orders SET provider_id=?, url=?, status='open' WHERE id=?").run(data.id, url.href, id)
      const order = this.get(id)!
      await this.mail(email, `Your order: ${item.name}`, `Thanks for your order of ${item.name} ($${item.priceUsd}, shipping included).\n\nPay here: ${url.href}\nOrder status: https://auctions.pit.world/shop/order/${id}?k=${viewKey}\n\nWe place your order with the grower as soon as the payment confirms, and email you the tracking number when it ships.`)
      return { order, payUrl: url.href }
    } catch {
      this.db.query("UPDATE shop_orders SET status='unknown' WHERE id=?").run(id)
      throw new OrderError('Checkout could not be confirmed. Please email hello@pit.world before trying again; you have not been charged.')
    }
  }

  private async call(path: string, init: RequestInit = {}): Promise<any> {
    const cfg = this.cfg!
    const response = await (cfg.fetch ?? fetch)(`${cfg.payAgentUrl.replace(/\/+$/, '')}${path}`, {
      ...init,
      redirect: 'error',
      headers: { authorization: `Bearer ${cfg.key}`, accept: 'application/json', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error('Invoice provider unavailable')
    return response.json()
  }

  private async mail(to: string, subject: string, text: string) {
    const mailer = this.cfg?.mailer
    if (!mailer || !to) return
    const html = `<pre style="font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`
    await mailer({ to, subject, text, html }).catch(() => console.error('Shop email failed'))
  }

  /** Mark an order paid exactly once, then tell the owner what to buy and where to ship it. */
  private async paid(order: ShopOrder) {
    const changed = this.db.query("UPDATE shop_orders SET status='paid', paid_at=? WHERE id=? AND status='open'").run(this.now(), order.id)
    if (!changed.changes) return
    const item = this.item(order.item_slug)
    const address = [order.name, order.address1, order.address2, `${order.city}, ${order.state} ${order.zip}`].filter(Boolean).join('\n')
    await this.mail(this.cfg?.notifyTo ?? '', `PLACE ORDER: ${item?.name ?? order.item_slug} ($${order.amount_usd} paid)`,
      `A shop order is paid. Buy it from the supplier and ship it to the buyer.\n\nItem: ${item?.name ?? order.item_slug}\nSupplier: ${item?.supplier.name ?? '?'} — ${item?.supplier.title ?? ''}\nBuy here: ${item?.supplier.url ?? '?'}\nOur cost: $${item ? (item.supplier.costUsd + item.supplier.shippingUsd).toFixed(2) : '?'}  Paid: $${order.amount_usd}\n\nShip to:\n${address}\n\nBuyer email: ${order.email}${order.note ? `\nNote: ${order.note}` : ''}\n\nThen mark it placed and shipped: https://auctions.pit.world/shop/admin (order ${order.id})`)
    await this.mail(order.email, `Payment received: ${item?.name ?? 'your order'}`, `Your payment of $${order.amount_usd} is confirmed. We are placing your order with the grower now and will email the tracking number when it ships.\n\nOrder status: https://auctions.pit.world/shop/order/${order.id}?k=${order.view_key}`)
  }

  async tick() {
    if (this.running || !this.cfg) return
    this.running = true
    try {
      // A lost create response: recover only an exact invoice match, never issue a second one.
      const uncertain = this.db.query<ShopOrder, [number]>("SELECT * FROM shop_orders WHERE status='unknown' OR (status='creating' AND created_at<?) ORDER BY checked_at, created_at LIMIT 25").all(this.now() - 60_000)
      if (uncertain.length) {
        try {
          const found = await this.call('/api/v1/invoices')
          for (const local of uncertain) {
            this.db.query('UPDATE shop_orders SET checked_at=? WHERE id=?').run(this.now(), local.id)
            const match = (Array.isArray(found.invoices) ? found.invoices : []).find((i: any) => i.description === local.description && i.amount_usd === local.amount_usd)
            if (!match || typeof match.id !== 'string' || typeof match.url !== 'string') continue
            const url = new URL(match.url)
            if (url.protocol !== 'https:' || url.origin !== new URL(this.cfg.payAgentUrl).origin) continue
            this.db.query("UPDATE shop_orders SET provider_id=?, url=?, status='open' WHERE id=? AND status IN ('unknown','creating')").run(match.id, url.href, local.id)
          }
        } catch { /* next tick */ }
      }
      const pending = this.db.query<ShopOrder, []>("SELECT * FROM shop_orders WHERE status='open' ORDER BY checked_at, created_at LIMIT 25").all()
      for (const order of pending) {
        this.db.query('UPDATE shop_orders SET checked_at=? WHERE id=?').run(this.now(), order.id)
        try {
          const verified = await this.call(`/api/v1/invoices/${encodeURIComponent(order.provider_id!)}`)
          if (verified.id !== order.provider_id || verified.amount_usd !== order.amount_usd || verified.description !== order.description) continue
          if (verified.status === 'paid') await this.paid(order)
          else if (verified.status === 'cancelled') this.db.query("UPDATE shop_orders SET status='cancelled' WHERE id=? AND status='open'").run(order.id)
        } catch { /* a provider outage never marks anything paid */ }
      }
    } finally {
      this.running = false
    }
  }

  /** Owner actions from /shop/admin. */
  async markPlaced(id: string, supplierRef: string) {
    const r = this.db.query("UPDATE shop_orders SET status='placed', placed_at=?, supplier_ref=? WHERE id=? AND status='paid'").run(this.now(), clean(supplierRef, 120), id)
    if (!r.changes) throw new OrderError('Only a paid order can be marked placed.')
  }

  async markShipped(id: string, tracking: string) {
    const t = clean(tracking, 120)
    if (!t) throw new OrderError('Enter the tracking number.')
    const r = this.db.query("UPDATE shop_orders SET status='shipped', shipped_at=?, tracking=? WHERE id=? AND status IN ('paid','placed')").run(this.now(), t, id)
    if (!r.changes) throw new OrderError('Only a paid or placed order can be marked shipped.')
    const order = this.get(id)!
    const item = this.item(order.item_slug)
    await this.mail(order.email, `Shipped: ${item?.name ?? 'your order'}`, `Your order has shipped.\n\nTracking: ${t}\n\nOrder status: https://auctions.pit.world/shop/order/${order.id}?k=${order.view_key}`)
  }
}

export const SHOP_STATES = US_STATES

/** Constant-time check of the admin token typed into /shop/admin. */
export function adminOk(expected: string | undefined, given: unknown): boolean {
  if (!expected || typeof given !== 'string' || !given) return false
  const a = createHash('sha256').update(expected).digest(), b = createHash('sha256').update(given).digest()
  return timingSafeEqual(a, b)
}

export type { Hono, Context }
