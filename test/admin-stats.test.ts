import { describe, expect, it } from 'bun:test'
import { Accounts } from '../src/accounts.ts'
import type { AccountDeps } from '../src/accounts-routes.ts'
import { dayRange } from '../src/admin-stats.ts'
import { createApp } from '../src/server.ts'
import { Summarizer } from '../src/summarize.ts'
import { SummaryPasses } from '../src/summary-pass.ts'

const SITE = 'https://pit.world'

describe('/api/admin/stats.json', () => {
  it('counts one UTC day for an admin only, with no addresses or URLs', async () => {
    const accounts = new Accounts(':memory:')
    const me = accounts.signIn({ sub: 'did:key:alice', name: 'alice', email: 'alice@example.com' })
    const summarizer = new Summarizer({ apiKey: 'k' })
    summarizer.store.set('acme.example/pricing', 'Acme sells tools.', 'qwen2.5:7b', 'page')
    summarizer.store.set('b.example', 'B.', 'qwen2.5:7b', 'snippet')
    const passes = new SummaryPasses(accounts.db, null)
    const deps: AccountDeps = { accounts, site: SITE, coinpay: null, bridgeKey: null }
    const app = createApp({ keys: {}, accounts: deps, summarizer, summaryPasses: passes, adminToken: 'admin-secret' })
    const today = new Date().toISOString().slice(0, 10)

    expect((await app.request(`${SITE}/api/admin/stats.json?day=${today}`)).status).toBe(401)
    expect((await app.request(`${SITE}/api/admin/stats.json?day=2026-13-99x`, { headers: { authorization: 'Bearer admin-secret' } })).status).toBe(400)
    const r = await app.request(`${SITE}/api/admin/stats.json?day=${today}`, { headers: { authorization: 'Bearer admin-secret' } })
    expect(r.status).toBe(200)
    const s = await r.json()
    expect(s.accounts).toMatchObject({ total: 1, new: 1 })
    expect(s.summaries).toMatchObject({ total: 2, written: 2, fromPage: 1, fromSnippet: 1, models: [{ model: 'qwen2.5:7b', n: 2 }] })
    expect(s.pass).toMatchObject({ soldByInvoice: 0, soldByX402: 0, revenueUsd: 0 })
    const text = JSON.stringify(s)
    expect(text).not.toContain('alice')
    expect(text).not.toContain('acme.example')
    expect(text).not.toContain(me.id)

    // An earlier day sees none of today's.
    const old = await (await app.request(`${SITE}/api/admin/stats.json?day=2020-01-01`, { headers: { authorization: 'Bearer admin-secret' } })).json()
    expect(old.accounts).toMatchObject({ total: 0, new: 0 })
    expect(old.summaries.written).toBe(0)
  })

  it('reads a day as UTC midnight to midnight', () => {
    expect(dayRange('2026-11-01')).toEqual([Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 2)])
    expect(dayRange('yesterday')).toBeNull()
  })
})
