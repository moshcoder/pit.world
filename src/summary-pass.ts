/**
 * The summary pass: $1 buys a week of up to 1,000 result summaries for a signed-in account,
 * instead of the free hourly allowance.
 *
 * Paid by CoinPay invoice through pay.agent, the same way featured listings are
 * (src/business-featured.ts): the invoice is reserved locally before the network call, and
 * a week is granted only when the server itself sees pay.agent report the exact invoice paid.
 * Nothing the browser sends is taken as proof of payment. There is no automatic renewal: each
 * paid invoice adds a week, stacked after any time already paid for.
 */
import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { BuildInvoicing } from './build-invoice.js'

export const PASS_USD = 1
export const PASS_DAYS = 7
export const PASS_SUMMARIES = 1000
const WEEK = PASS_DAYS * 86_400_000

type Invoice = { id: string; account_id: string; provider_id: string | null; url: string | null; status: string; description: string; created_at: number }

export class PassError extends Error {}

export type PassState = {
  /** When the paid time ends, or null when there is none. */
  activeUntil: number | null
  /** Summaries started in the last 7 days. */
  used: number
  limit: number
  /** An unpaid invoice to send the buyer back to, if there is one. */
  openInvoice: string | null
}

export class SummaryPasses {
  private running = false
  constructor(
    readonly db: Database,
    private cfg: BuildInvoicing | null,
    private now = Date.now,
  ) {
    db.run('CREATE TABLE IF NOT EXISTS summary_passes (account_id TEXT PRIMARY KEY, paid_until INTEGER NOT NULL)')
    db.run(`CREATE TABLE IF NOT EXISTS summary_pass_invoices (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT UNIQUE, url TEXT, status TEXT NOT NULL,
      description TEXT NOT NULL, created_at INTEGER NOT NULL, paid_at INTEGER, checked_at INTEGER NOT NULL DEFAULT 0)`)
    db.run('CREATE INDEX IF NOT EXISTS summary_pass_invoice_account ON summary_pass_invoices (account_id, status)')
    // Only counts: an account and a time, never the page or the search.
    db.run('CREATE TABLE IF NOT EXISTS summary_pass_usage (account_id TEXT NOT NULL, at INTEGER NOT NULL)')
    db.run('CREATE INDEX IF NOT EXISTS summary_pass_usage_account_at ON summary_pass_usage (account_id, at)')
  }

  /** Checkout needs pay.agent; without it the pass can be shown but not bought. */
  get sellable(): boolean {
    return !!this.cfg
  }

  activeUntil(accountId: string): number | null {
    const row = this.db.query<{ paid_until: number }, [string]>('SELECT paid_until FROM summary_passes WHERE account_id = ?').get(accountId)
    return row && row.paid_until > this.now() ? row.paid_until : null
  }

  private used(accountId: string): number {
    return this.db.query<{ n: number }, [string, number]>('SELECT COUNT(*) AS n FROM summary_pass_usage WHERE account_id = ? AND at > ?').get(accountId, this.now() - WEEK)!.n
  }

  private open(accountId: string): Invoice | null {
    return this.db
      .query<Invoice, [string]>("SELECT * FROM summary_pass_invoices WHERE account_id = ? AND status IN ('creating','open','unknown') ORDER BY created_at DESC LIMIT 1")
      .get(accountId)
  }

  state(accountId: string): PassState {
    return { activeUntil: this.activeUntil(accountId), used: this.used(accountId), limit: PASS_SUMMARIES, openInvoice: this.open(accountId)?.url ?? null }
  }

  /**
   * One summary for a pass holder. 'none' when the account has no paid time (the caller falls back
   * to the free hourly allowance), 'over' when it has used 1,000 in the last 7 days.
   */
  use(accountId: string): 'ok' | 'over' | 'none' {
    if (!this.activeUntil(accountId)) return 'none'
    return this.db.transaction(() => {
      if (this.used(accountId) >= PASS_SUMMARIES) return 'over' as const
      this.db.run('INSERT INTO summary_pass_usage (account_id, at) VALUES (?, ?)', [accountId, this.now()])
      return 'ok' as const
    })()
  }

  /** Opens (or returns the open) $1 invoice for one week. Returns the pay.agent invoice URL. */
  async buy(accountId: string, email: unknown): Promise<string> {
    if (!this.cfg) throw new PassError('Checkout is unavailable right now. Try again later.')
    const address = String(email ?? '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) throw new PassError('Enter the email address CoinPay should send the invoice to.')
    const pending = this.open(accountId)
    if (pending?.url) return pending.url
    if (pending) throw new PassError('An invoice is still being confirmed. Wait a minute, then reload this page.')
    const id = randomUUID()
    const description = `pit.world summary pass: ${PASS_SUMMARIES} summaries for ${PASS_DAYS} days — $${PASS_USD} — ${id}`
    // Reserve locally before the network call, so an ambiguous failure cannot sell a second invoice.
    const reserved = this.db.transaction(() => {
      if (this.open(accountId)) return false
      this.db.run("INSERT INTO summary_pass_invoices (id, account_id, status, description, created_at) VALUES (?, ?, 'creating', ?, ?)", [id, accountId, description, this.now()])
      return true
    })()
    if (!reserved) throw new PassError('An invoice is already open for this account.')
    try {
      const data = await this.call('/api/v1/invoices', {
        method: 'POST',
        body: JSON.stringify({ to_email: address, amount_usd: PASS_USD, description, due_date: new Date(this.now()).toISOString().slice(0, 10) }),
      })
      const url = new URL(data.url)
      if (url.protocol !== 'https:' || url.origin !== new URL(this.cfg.payAgentUrl).origin || typeof data.id !== 'string' || !data.id || data.amount_usd !== PASS_USD)
        throw new Error('Invalid invoice response')
      this.db.run("UPDATE summary_pass_invoices SET provider_id = ?, url = ?, status = 'open' WHERE id = ?", [data.id, url.href, id])
      return url.href
    } catch {
      this.db.run("UPDATE summary_pass_invoices SET status = 'unknown' WHERE id = ?", [id])
      throw new PassError('The invoice could not be confirmed. Reload this page in a minute; contact hello@pit.world if it does not appear. Nothing was charged.')
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

  /** Every minute: recover lost create responses, grant a week per invoice pay.agent reports paid, and drop old counts. */
  async tick(): Promise<void> {
    if (this.running || !this.cfg) return
    this.running = true
    try {
      const uncertain = this.db
        .query<Invoice, [number]>("SELECT * FROM summary_pass_invoices WHERE status = 'unknown' OR (status = 'creating' AND created_at < ?) ORDER BY checked_at, created_at LIMIT 25")
        .all(this.now() - 60_000)
      if (uncertain.length) {
        try {
          const found = await this.call('/api/v1/invoices')
          for (const local of uncertain) {
            this.db.run('UPDATE summary_pass_invoices SET checked_at = ? WHERE id = ?', [this.now(), local.id])
            const match = (Array.isArray(found.invoices) ? found.invoices : []).find((i: any) => i.description === local.description && i.amount_usd === PASS_USD)
            if (!match || typeof match.id !== 'string' || typeof match.url !== 'string') {
              // Never made at pay.agent: after an hour, release it so the buyer can try again.
              if (local.created_at < this.now() - 3_600_000) this.db.run("UPDATE summary_pass_invoices SET status = 'failed' WHERE id = ? AND status IN ('unknown','creating')", [local.id])
              continue
            }
            const url = new URL(match.url)
            if (url.protocol !== 'https:' || url.origin !== new URL(this.cfg.payAgentUrl).origin) continue
            this.db.run("UPDATE summary_pass_invoices SET provider_id = ?, url = ?, status = 'open' WHERE id = ? AND status IN ('unknown','creating')", [match.id, url.href, local.id])
          }
        } catch {
          /* Try again next tick; never assume payment. */
        }
      }
      const open = this.db.query<Invoice, []>("SELECT * FROM summary_pass_invoices WHERE status = 'open' ORDER BY checked_at, created_at LIMIT 25").all()
      for (const invoice of open) {
        this.db.run('UPDATE summary_pass_invoices SET checked_at = ? WHERE id = ?', [this.now(), invoice.id])
        try {
          const verified = await this.call(`/api/v1/invoices/${encodeURIComponent(invoice.provider_id!)}`)
          if (verified.id !== invoice.provider_id || verified.amount_usd !== PASS_USD || verified.description !== invoice.description) continue
          if (verified.status === 'paid') this.grant(invoice)
          else if (verified.status === 'cancelled') this.db.run("UPDATE summary_pass_invoices SET status = 'cancelled' WHERE id = ?", [invoice.id])
        } catch {
          /* Leave it open; an outage cannot grant a pass. */
        }
      }
      this.db.run('DELETE FROM summary_pass_usage WHERE at < ?', [this.now() - WEEK])
    } finally {
      this.running = false
    }
  }

  /** One paid invoice: one more week, after any time already paid for. Exactly once per invoice. */
  private grant(invoice: Invoice): void {
    this.db.transaction(() => {
      const row = this.db.query<{ status: string }, [string]>('SELECT status FROM summary_pass_invoices WHERE id = ?').get(invoice.id)
      if (row?.status !== 'open') return
      const until = Math.max(this.now(), this.activeUntil(invoice.account_id) ?? 0) + WEEK
      this.db.run('INSERT INTO summary_passes (account_id, paid_until) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET paid_until = excluded.paid_until', [invoice.account_id, until])
      this.db.run("UPDATE summary_pass_invoices SET status = 'paid', paid_at = ? WHERE id = ?", [this.now(), invoice.id])
    })()
  }
}
