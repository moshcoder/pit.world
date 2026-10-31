/** Paid directory placement. CoinPay invoices through pay.agent; no browser-supplied payment proof. */
import { randomUUID } from 'node:crypto'
import type { Listings } from './listings.js'
import type { BuildInvoicing } from './build-invoice.js'

export const FEATURED_USD = 19
const RENEW_AHEAD = 3 * 86_400_000
export function calendarMonth(time: number): number {
  const date = new Date(time), day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + 1)
  const end = new Date(date.getTime()); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0)
  date.setUTCDate(Math.min(day, end.getUTCDate()))
  return date.getTime()
}

type Invoice = { id: string; domain: string; provider_id: string | null; url: string | null; status: string; description: string }
export class FeaturedBusinesses {
  private running = false
  constructor(readonly listings: Listings, private cfg: BuildInvoicing, private now = Date.now) {
    listings.db.run(`CREATE TABLE IF NOT EXISTS featured_memberships (
      domain TEXT PRIMARY KEY, email TEXT NOT NULL, renew INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`)
    listings.db.run(`CREATE TABLE IF NOT EXISTS featured_invoices (
      id TEXT PRIMARY KEY, domain TEXT NOT NULL, provider_id TEXT UNIQUE, url TEXT, status TEXT NOT NULL,
      description TEXT NOT NULL, created_at INTEGER NOT NULL, paid_at INTEGER)`)
    listings.db.run('CREATE INDEX IF NOT EXISTS featured_invoice_domain ON featured_invoices(domain, status)')
  }
  private current(domain: string): Invoice | null {
    return this.listings.db.query<Invoice, [string]>("SELECT * FROM featured_invoices WHERE domain = ? AND status IN ('creating','open','unknown') ORDER BY created_at DESC LIMIT 1").get(domain)
  }
  status(domain: string) {
    const row = this.listings.db.query<{ featured_paid_until: number | null }, [string]>('SELECT featured_paid_until FROM listings WHERE domain = ?').get(domain)
    const membership = this.listings.db.query<{ renew: number }, [string]>('SELECT renew FROM featured_memberships WHERE domain = ?').get(domain)
    return { activeUntil: (row?.featured_paid_until ?? 0) > this.now() ? row!.featured_paid_until : null, renew: Boolean(membership?.renew) }
  }
  manage(domain: string, key: unknown, renew: boolean) {
    if (!this.listings.authorized(domain, key)) throw Error('Use the edit key for this verified listing.')
    const membership = this.listings.db.query('SELECT domain FROM featured_memberships WHERE domain = ?').get(domain)
    if (!membership) throw Error('There is no featured plan for this listing yet.')
    this.listings.db.run('UPDATE featured_memberships SET renew = ? WHERE domain = ?', [renew ? 1 : 0, domain])
    return this.status(domain)
  }
  async start(domain: string, key: unknown, email: unknown): Promise<string> {
    if (!this.listings.authorized(domain, key)) throw Error('Claim this listing first, then use its edit key.')
    const address = String(email ?? '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) throw Error('Enter the email address for monthly invoices.')
    const pending = this.current(domain)
    if (pending?.url) return pending.url
    if (pending) throw Error('An invoice request is awaiting confirmation. Please contact hello@pit.world before requesting another.')
    if (this.status(domain).activeUntil) throw Error('This listing is already featured. Use the renewal controls below.')
    this.listings.db.run('INSERT INTO featured_memberships(domain,email,renew,created_at) VALUES(?,?,1,?) ON CONFLICT(domain) DO UPDATE SET email=excluded.email,renew=1', [domain, address, this.now()])
    return this.issue(domain, address)
  }
  private async issue(domain: string, email: string): Promise<string> {
    const id = randomUUID(), description = `pit.world featured business: ${domain} — $19/month — ${id}`
    // Reserve locally before the network call; an ambiguous failure cannot sell a second invoice.
    const reserved = this.listings.db.transaction(() => {
      if (this.current(domain)) return false
      this.listings.db.run("INSERT INTO featured_invoices(id,domain,status,description,created_at) VALUES(?,?,'creating',?,?)", [id,domain,description,this.now()])
      return true
    })()
    if (!reserved) throw Error('An invoice is already pending for this listing.')
    try {
      const data = await this.call('/api/v1/invoices', {
        method: 'POST', body: JSON.stringify({ to_email: email, amount_usd: FEATURED_USD, description, due_date: new Date(this.now()).toISOString().slice(0,10) }),
      })
      const url = new URL(data.url)
      if (url.protocol !== 'https:' || url.origin !== new URL(this.cfg.payAgentUrl).origin || typeof data.id !== 'string' || !data.id || data.amount_usd !== FEATURED_USD)
        throw Error('Invalid invoice response')
      this.listings.db.run("UPDATE featured_invoices SET provider_id=?,url=?,status='open' WHERE id=?", [data.id,url.href,id])
      return url.href
    } catch {
      this.listings.db.run("UPDATE featured_invoices SET status='unknown' WHERE id=?", [id])
      throw Error('Invoice creation could not be confirmed. Please contact hello@pit.world before retrying; no placement has been activated.')
    }
  }
  private async call(path: string, init: RequestInit = {}): Promise<any> {
    const response = await (this.cfg.fetch ?? fetch)(`${this.cfg.payAgentUrl.replace(/\/+$/, '')}${path}`, {
      ...init, redirect: 'error', headers: { authorization: `Bearer ${this.cfg.key}`, accept: 'application/json', 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw Error('Invoice provider unavailable')
    return response.json()
  }
  async tick() {
    if (this.running) return
    this.running = true
    try {
      // A timeout or restart can lose the create response. Recover only an exact merchant
      // invoice match, never create a replacement while the outcome is ambiguous.
      const uncertain = this.listings.db.query<Invoice,[number]>("SELECT * FROM featured_invoices WHERE status='unknown' OR (status='creating' AND created_at<?) LIMIT 25").all(this.now()-60_000)
      if (uncertain.length) {
        try {
          const found = await this.call('/api/v1/invoices')
          for (const local of uncertain) {
            const match = (Array.isArray(found.invoices) ? found.invoices : []).find((i:any) => i.description===local.description && i.amount_usd===FEATURED_USD)
            if (!match || typeof match.id!=='string' || typeof match.url!=='string') continue
            const url = new URL(match.url)
            if (url.protocol!=='https:' || url.origin!==new URL(this.cfg.payAgentUrl).origin) continue
            this.listings.db.run("UPDATE featured_invoices SET provider_id=?,url=?,status='open' WHERE id=? AND status IN ('unknown','creating')",[match.id,url.href,local.id])
          }
        } catch { /* Try reconciliation on the next tick; never assume payment. */ }
      }
      const pending = this.listings.db.query<Invoice, []>("SELECT * FROM featured_invoices WHERE status = 'open' ORDER BY created_at LIMIT 25").all()
      for (const invoice of pending) {
        try {
          const verified = await this.call(`/api/v1/invoices/${encodeURIComponent(invoice.provider_id!)}`)
          if (verified.id !== invoice.provider_id || verified.amount_usd !== FEATURED_USD || verified.description !== invoice.description) continue
          if (verified.status === 'paid') {
            this.listings.db.transaction(() => {
              const row = this.listings.db.query<{status:string},[string]>('SELECT status FROM featured_invoices WHERE id=?').get(invoice.id)
              if (row?.status !== 'open') return
              const listing = this.listings.db.query<{featured_paid_until:number|null},[string]>('SELECT featured_paid_until FROM listings WHERE domain=?').get(invoice.domain)
              const until = calendarMonth(Math.max(this.now(), listing?.featured_paid_until ?? 0))
              this.listings.db.run('UPDATE listings SET featured_paid_until=? WHERE domain=?', [until,invoice.domain])
              this.listings.db.run("UPDATE featured_invoices SET status='paid',paid_at=? WHERE id=?", [this.now(),invoice.id])
            })()
          } else if (verified.status === 'cancelled') this.listings.db.run("UPDATE featured_invoices SET status='cancelled' WHERE id=?", [invoice.id])
        } catch { /* Leave pending; a provider outage cannot grant a paid placement. */ }
      }
      const renewals = this.listings.db.query<{domain:string;email:string},[number]>(`SELECT m.domain,m.email FROM featured_memberships m JOIN listings l ON l.domain=m.domain
        WHERE m.renew=1 AND l.claimed_at IS NOT NULL AND l.directory_opt_out=0 AND l.featured_paid_until>0 AND l.featured_paid_until<=?
        AND NOT EXISTS(SELECT 1 FROM featured_invoices i WHERE i.domain=m.domain AND i.status IN ('creating','open','unknown')) LIMIT 25`).all(this.now()+RENEW_AHEAD)
      for (const member of renewals) await this.issue(member.domain,member.email).catch(() => {})
    } finally { this.running = false }
  }
}
