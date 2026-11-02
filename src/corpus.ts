/**
 * The training corpus, sold by the page: pit.world's own crawl index as full page text, for
 * anyone training a model. pitbot's local index (services/crawler, loopback) serves the pages
 * and leaves out every page whose publisher reserved AI training; this file meters and sells.
 *
 *   - Profullstack's own harvesters send PIT_CORPUS_INTERNAL_KEY as a bearer: free, unmetered.
 *   - Anyone may preview: 20 pages a day per address, text cut to 500 characters.
 *   - Everyone else pays per page returned, CORPUS_USD_PER_1000 (default $1 per 1,000 pages):
 *       x402 on the request itself (price = limit x per-page price; pages not returned are
 *       kept as credit on a key), or prepaid credits: a key bought over x402
 *       (/api/corpus/credits), or an account balance bought by CoinPay invoice on /account.
 *
 * Payments are verified and settled by CoinPay (x402) or confirmed by pay.agent (invoices),
 * server to server; nothing the caller sends is taken as proof on its own.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { buildOffer, decodePayment, expectedFor, paymentResponseHeader, verifyAndSettle } from '@profullstack/x402-gateway'
import type { BuildInvoicing } from './build-invoice.js'
import type { PassX402 } from './summary-pass.js'

/** The header a bought credit key travels in (or `Authorization: Bearer pck_...`). */
export const CORPUS_HEADER = 'x-corpus-key'
export const CREDITS_PATH = '/api/corpus/credits'
export const FREE_PAGES_PER_DAY = 20
export const PREVIEW_CHARS = 500
/** Invoice sizes offered on /account, in dollars. */
export const INVOICE_USD = [5, 10, 25, 100] as const

export type CorpusPricing = { usdPer1000: number }

/** The price, from PIT_CORPUS_USD_PER_1000 (dollars per 1,000 pages returned). Default $1. */
export function pricingFromEnv(env: Record<string, string | undefined> = process.env): CorpusPricing {
  const n = Number(env.PIT_CORPUS_USD_PER_1000)
  return { usdPer1000: Number.isFinite(n) && n > 0 ? n : 1 }
}

/** Dollars for display: $0.001, $0.02, $1.00. */
export function usd(cents: number): string {
  const dollars = cents / 100
  return Number.isInteger(cents) ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(6).replace(/0+$/, '').replace(/\.(\d)$/, '.$10')}`
}

type Invoice = { id: string; account_id: string; provider_id: string | null; url: string | null; status: string; description: string; amount_usd: number; pages: number; created_at: number }

export class CorpusError extends Error {}

export type Settled = { ok: true; ref: string; payer: string | null; paymentResponse: string | null } | { ok: false; error: string }

export class CorpusBilling {
  private running = false
  private readonly internal: Buffer | null
  /** Free preview pages by HMAC(address, today's salt): nothing that can be turned back into an address. */
  private preview = { day: '', salt: randomBytes(32), used: new Map<string, number>() }

  constructor(
    readonly db: Database,
    readonly pricing: CorpusPricing,
    private opts: { internalKey?: string | null; invoicing?: BuildInvoicing | null; x402?: PassX402 | null; now?: () => number } = {},
  ) {
    this.internal = opts.internalKey && opts.internalKey.length >= 24 ? createHash('sha256').update(opts.internalKey).digest() : null
    db.run('CREATE TABLE IF NOT EXISTS corpus_balances (holder TEXT PRIMARY KEY, pages INTEGER NOT NULL)')
    db.run('CREATE TABLE IF NOT EXISTS corpus_keys (key_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL)')
    db.run('CREATE TABLE IF NOT EXISTS corpus_x402 (ref TEXT PRIMARY KEY, product TEXT NOT NULL, pages INTEGER NOT NULL, payer TEXT, key_hash TEXT, created_at INTEGER NOT NULL)')
    db.run(`CREATE TABLE IF NOT EXISTS corpus_invoices (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT UNIQUE, url TEXT, status TEXT NOT NULL,
      description TEXT NOT NULL, amount_usd REAL NOT NULL, pages INTEGER NOT NULL, created_at INTEGER NOT NULL, paid_at INTEGER, checked_at INTEGER NOT NULL DEFAULT 0)`)
    db.run('CREATE INDEX IF NOT EXISTS corpus_invoice_account ON corpus_invoices (account_id, status)')
    // Counts only, for the nightly numbers: a day, a mode and pages. Never the query.
    db.run('CREATE TABLE IF NOT EXISTS corpus_usage (day TEXT NOT NULL, mode TEXT NOT NULL, pages INTEGER NOT NULL, requests INTEGER NOT NULL, PRIMARY KEY (day, mode))')
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  /** Cents for `pages` pages (fractions of a cent allowed: x402 prices in USDC base units). */
  priceCents(pages: number): number {
    return Math.round(pages * this.pricing.usdPer1000 * 100) / 1000
  }

  get x402Enabled(): boolean {
    return !!this.opts.x402
  }

  get sellable(): boolean {
    return !!this.opts.invoicing
  }

  /** The internal bearer, compared in constant time. */
  isInternal(bearer: string | null | undefined): boolean {
    if (!this.internal || !bearer) return false
    return timingSafeEqual(createHash('sha256').update(bearer).digest(), this.internal)
  }

  // ---- free preview -------------------------------------------------------------------

  private previewDay() {
    const day = new Date(this.now()).toISOString().slice(0, 10)
    if (this.preview.day !== day) this.preview = { day, salt: randomBytes(32), used: new Map() }
    return this.preview
  }

  previewLeft(ip: string): number {
    const p = this.previewDay()
    return Math.max(0, FREE_PAGES_PER_DAY - (p.used.get(createHmac('sha256', p.salt).update(ip).digest('base64url')) ?? 0))
  }

  usePreview(ip: string, pages: number): void {
    const p = this.previewDay()
    const key = createHmac('sha256', p.salt).update(ip).digest('base64url')
    p.used.set(key, (p.used.get(key) ?? 0) + pages)
    if (p.used.size > 200_000) p.used.delete(p.used.keys().next().value!)
  }

  // ---- balances --------------------------------------------------------------------------

  /** A bought key's holder id, or null when this server never sold it. */
  keyHolder(key: string | null | undefined): string | null {
    if (!key || !/^pck_[A-Za-z0-9_-]{20,80}$/.test(key)) return null
    const hash = createHash('sha256').update(key).digest('base64url')
    return this.db.query('SELECT 1 FROM corpus_keys WHERE key_hash = ?').get(hash) ? `key:${hash}` : null
  }

  balance(holder: string): number {
    return (this.db.query<{ pages: number }, [string]>('SELECT pages FROM corpus_balances WHERE holder = ?').get(holder)?.pages ?? 0)
  }

  credit(holder: string, pages: number): void {
    if (pages <= 0) return
    this.db.run('INSERT INTO corpus_balances (holder, pages) VALUES (?, ?) ON CONFLICT(holder) DO UPDATE SET pages = pages + excluded.pages', [holder, pages])
  }

  /** Takes up to `pages` from the balance; returns how many it took. */
  spend(holder: string, pages: number): number {
    return this.db.transaction(() => {
      const have = this.balance(holder)
      const take = Math.max(0, Math.min(have, pages))
      if (take) this.db.run('UPDATE corpus_balances SET pages = pages - ? WHERE holder = ?', [take, holder])
      return take
    })()
  }

  /** A new key holding `pages`. */
  mintKey(pages: number): { key: string; holder: string } {
    const key = `pck_${randomBytes(24).toString('base64url')}`
    const hash = createHash('sha256').update(key).digest('base64url')
    this.db.run('INSERT INTO corpus_keys (key_hash, created_at) VALUES (?, ?)', [hash, this.now()])
    this.credit(`key:${hash}`, pages)
    return { key, holder: `key:${hash}` }
  }

  record(mode: string, pages: number): void {
    const day = new Date(this.now()).toISOString().slice(0, 10)
    this.db.run('INSERT INTO corpus_usage (day, mode, pages, requests) VALUES (?, ?, ?, 1) ON CONFLICT(day, mode) DO UPDATE SET pages = pages + excluded.pages, requests = requests + 1', [day, mode, pages])
  }

  // ---- x402 --------------------------------------------------------------------------------

  /** An x402 offer for `pages` pages at `resource`. */
  offer(pages: number, resource: string, description: string) {
    if (!this.opts.x402) return null
    return buildOffer({ payTo: this.opts.x402.payTo, priceCents: this.priceCents(pages), resource: `${this.opts.x402.site.replace(/\/+$/, '')}${resource}`, description })
  }

  /**
   * Verifies and settles an x402 payment for `pages` pages through CoinPay. A proof already
   * used is refused: each payment buys its pages once.
   */
  async settle(proofHeader: string, pages: number, resource: string, product: string, userAgent = ''): Promise<Settled> {
    const x = this.opts.x402
    const offer = this.offer(pages, resource, product)
    if (!x || !offer) return { ok: false, error: 'x402 is not enabled on this server.' }
    const payment = decodePayment(proofHeader) as any
    if (!payment) return { ok: false, error: 'The payment proof is not base64 JSON.' }
    const ref = String(payment?.payload?.authorization?.nonce ?? payment?.payload?.nonce ?? payment?.payload?.hash ?? payment?.payload?.block?.hash ?? '')
    if (ref && this.db.query('SELECT 1 FROM corpus_x402 WHERE ref = ?').get(ref)) return { ok: false, error: 'That payment was already used.' }
    const expected = expectedFor(payment, offer)
    if (!expected) return { ok: false, error: `Pay ${usd(this.priceCents(pages))} with one of the networks in the offer.` }
    const result = await verifyAndSettle(payment, expected, {
      apiKey: x.apiKey,
      baseUrl: (x.baseUrl ?? 'https://coinpayportal.com').replace(/\/+$/, ''),
      ...(x.fetch ? { fetch: x.fetch } : {}),
      metadata: { property: 'pit.world', resource_path: resource, product, pages, user_agent: userAgent.slice(0, 300) },
    })
    if (!result.ok) return { ok: false, error: result.reason || 'Payment could not be settled.' }
    const key = ref || result.ref || result.txHash || randomUUID()
    const fresh = this.db.run('INSERT OR IGNORE INTO corpus_x402 (ref, product, pages, payer, created_at) VALUES (?, ?, ?, ?, ?)', [key, product, pages, result.payer, this.now()])
    if (!fresh.changes) return { ok: false, error: 'That payment was already used.' }
    return { ok: true, ref: key, payer: result.payer ?? null, paymentResponse: paymentResponseHeader({ transaction: result.txHash, network: result.network, payer: result.payer }) }
  }

  // ---- CoinPay invoices for accounts (pay.agent, like the summary pass) -------------------

  private open(accountId: string): Invoice | null {
    return this.db
      .query<Invoice, [string]>("SELECT * FROM corpus_invoices WHERE account_id = ? AND status IN ('creating','open','unknown') ORDER BY created_at DESC LIMIT 1")
      .get(accountId)
  }

  openInvoice(accountId: string): string | null {
    return this.open(accountId)?.url ?? null
  }

  pagesFor(amountUsd: number): number {
    return Math.floor((amountUsd * 1000) / this.pricing.usdPer1000)
  }

  /** Opens (or returns the open) invoice for `amountUsd` of pages. Returns the pay.agent invoice URL. */
  async buy(accountId: string, email: unknown, amount: unknown): Promise<string> {
    const cfg = this.opts.invoicing
    if (!cfg) throw new CorpusError('Checkout is unavailable right now. Try again later.')
    const amountUsd = Number(amount)
    if (!(INVOICE_USD as readonly number[]).includes(amountUsd)) throw new CorpusError(`Choose one of ${INVOICE_USD.map((n) => `$${n}`).join(', ')}.`)
    const address = String(email ?? '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) throw new CorpusError('Enter the email address CoinPay should send the invoice to.')
    const pending = this.open(accountId)
    if (pending?.url) return pending.url
    if (pending) throw new CorpusError('An invoice is still being confirmed. Wait a minute, then reload this page.')
    const id = randomUUID()
    const pages = this.pagesFor(amountUsd)
    const description = `pit.world corpus credits: ${pages.toLocaleString('en-US')} pages — $${amountUsd} — ${id}`
    const reserved = this.db.transaction(() => {
      if (this.open(accountId)) return false
      this.db.run("INSERT INTO corpus_invoices (id, account_id, status, description, amount_usd, pages, created_at) VALUES (?, ?, 'creating', ?, ?, ?, ?)", [id, accountId, description, amountUsd, pages, this.now()])
      return true
    })()
    if (!reserved) throw new CorpusError('An invoice is already open for this account.')
    try {
      const data = await this.call('/api/v1/invoices', {
        method: 'POST',
        body: JSON.stringify({ to_email: address, amount_usd: amountUsd, description, due_date: new Date(this.now()).toISOString().slice(0, 10) }),
      })
      const url = new URL(data.url)
      if (url.protocol !== 'https:' || url.origin !== new URL(cfg.payAgentUrl).origin || typeof data.id !== 'string' || !data.id || data.amount_usd !== amountUsd) throw new Error('Invalid invoice response')
      this.db.run("UPDATE corpus_invoices SET provider_id = ?, url = ?, status = 'open' WHERE id = ?", [data.id, url.href, id])
      return url.href
    } catch {
      this.db.run("UPDATE corpus_invoices SET status = 'unknown' WHERE id = ?", [id])
      throw new CorpusError('The invoice could not be confirmed. Reload this page in a minute; contact hello@pit.world if it does not appear. Nothing was charged.')
    }
  }

  private async call(path: string, init: RequestInit = {}): Promise<any> {
    const cfg = this.opts.invoicing!
    const response = await (cfg.fetch ?? fetch)(`${cfg.payAgentUrl.replace(/\/+$/, '')}${path}`, {
      ...init,
      redirect: 'error',
      headers: { authorization: `Bearer ${cfg.key}`, accept: 'application/json', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error('Invoice provider unavailable')
    return response.json()
  }

  /** Every minute: recover lost create responses, credit each invoice pay.agent reports paid (once). */
  async tick(): Promise<void> {
    if (this.running || !this.opts.invoicing) return
    this.running = true
    const cfg = this.opts.invoicing
    try {
      const uncertain = this.db
        .query<Invoice, [number]>("SELECT * FROM corpus_invoices WHERE status = 'unknown' OR (status = 'creating' AND created_at < ?) ORDER BY checked_at, created_at LIMIT 25")
        .all(this.now() - 60_000)
      if (uncertain.length) {
        try {
          const found = await this.call('/api/v1/invoices')
          for (const local of uncertain) {
            this.db.run('UPDATE corpus_invoices SET checked_at = ? WHERE id = ?', [this.now(), local.id])
            const match = (Array.isArray(found.invoices) ? found.invoices : []).find((i: any) => i.description === local.description && i.amount_usd === local.amount_usd)
            if (!match || typeof match.id !== 'string' || typeof match.url !== 'string') {
              if (local.created_at < this.now() - 3_600_000) this.db.run("UPDATE corpus_invoices SET status = 'failed' WHERE id = ? AND status IN ('unknown','creating')", [local.id])
              continue
            }
            const url = new URL(match.url)
            if (url.protocol !== 'https:' || url.origin !== new URL(cfg.payAgentUrl).origin) continue
            this.db.run("UPDATE corpus_invoices SET provider_id = ?, url = ?, status = 'open' WHERE id = ? AND status IN ('unknown','creating')", [match.id, url.href, local.id])
          }
        } catch {
          /* next tick; never assume payment */
        }
      }
      const open = this.db.query<Invoice, []>("SELECT * FROM corpus_invoices WHERE status = 'open' ORDER BY checked_at, created_at LIMIT 25").all()
      for (const invoice of open) {
        this.db.run('UPDATE corpus_invoices SET checked_at = ? WHERE id = ?', [this.now(), invoice.id])
        try {
          const verified = await this.call(`/api/v1/invoices/${encodeURIComponent(invoice.provider_id!)}`)
          if (verified.id !== invoice.provider_id || verified.amount_usd !== invoice.amount_usd || verified.description !== invoice.description) continue
          if (verified.status === 'paid') this.grant(invoice)
          else if (verified.status === 'cancelled') this.db.run("UPDATE corpus_invoices SET status = 'cancelled' WHERE id = ?", [invoice.id])
        } catch {
          /* leave it open */
        }
      }
    } finally {
      this.running = false
    }
  }

  private grant(invoice: Invoice): void {
    this.db.transaction(() => {
      const row = this.db.query<{ status: string }, [string]>('SELECT status FROM corpus_invoices WHERE id = ?').get(invoice.id)
      if (row?.status !== 'open') return
      this.credit(`acct:${invoice.account_id}`, invoice.pages)
      this.db.run("UPDATE corpus_invoices SET status = 'paid', paid_at = ? WHERE id = ?", [this.now(), invoice.id])
    })()
  }
}
