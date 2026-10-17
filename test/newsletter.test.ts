import { describe, expect, it } from 'bun:test'
import { main } from '../src/cli.ts'
import { PitClient } from '../src/client.ts'
import { adminAuthorized, Newsletter, normalizeEmail, resendMailer, type Mailer } from '../src/newsletter.ts'
import { createApp } from '../src/server.ts'

function harness(options: { mxOk?: boolean; mailFails?: boolean; now?: () => number } = {}) {
  const sent: Array<{ to: string; subject: string; text: string }> = []
  const mailer: Mailer = async (m) => {
    if (options.mailFails) throw new Error('provider down')
    sent.push(m)
  }
  const newsletter = new Newsletter(':memory:', mailer, async () => options.mxOk ?? true, 'https://pit.world', options.now ?? Date.now)
  const app = createApp({ keys: {}, newsletter, adminToken: 'ADMIN-TOKEN' })
  const form = (fields: Record<string, string>, ip = '203.0.113.7') =>
    app.request('/subscribe', { method: 'POST', body: new URLSearchParams(fields) }, { ip })
  const tokenFrom = (text: string) => /confirm\?t=([A-Za-z0-9_-]+)/.exec(text)![1]!
  return { app, newsletter, sent, form, tokenFrom }
}

describe('newsletter', () => {
  it('normalizes addresses and refuses things that are not one', () => {
    expect(normalizeEmail('  Someone@Example.COM ')).toBe('someone@example.com')
    for (const bad of ['', 'a@b', 'no-at.example.com', 'two@@example.com', 'x@example', '.dot@example.com', 'a..b@example.com', 'sp ace@example.com', `${'a'.repeat(65)}@example.com`, 42, null])
      expect(normalizeEmail(bad)).toBeNull()
  })

  it('emails a link, and only the click puts the address on the list', async () => {
    const { app, newsletter, sent, form, tokenFrom } = harness()
    const res = await form({ email: 'Reader@Example.com' })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Check your inbox')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('reader@example.com')
    expect(newsletter.count()).toBe(0)

    const confirm = await app.request(`/confirm?t=${tokenFrom(sent[0]!.text)}`)
    expect(confirm.status).toBe(200)
    expect(await confirm.text()).toContain('on the list')
    expect(newsletter.count()).toBe(1)
    expect(newsletter.pendingCount()).toBe(0)

    // The link works once.
    expect((await app.request(`/confirm?t=${tokenFrom(sent[0]!.text)}`)).status).toBe(410)
  })

  it('answers the same for a new address and one already on the list', async () => {
    const { app, sent, form, tokenFrom } = harness()
    await form({ email: 'me@example.com' })
    await app.request(`/confirm?t=${tokenFrom(sent[0]!.text)}`)
    const again = await form({ email: 'me@example.com' })
    expect(again.status).toBe(200)
    expect(await again.text()).toContain('Check your inbox')
    expect(sent).toHaveLength(1)
  })

  it('stores a hash of the token, never the token, and forgets unconfirmed signups after 48h', async () => {
    let now = 1_000_000
    const { app, newsletter, sent, form, tokenFrom } = harness({ now: () => now })
    await form({ email: 'late@example.com' })
    const token = tokenFrom(sent[0]!.text)
    expect(newsletter.csv()).not.toContain(token)
    now += 49 * 3600 * 1000
    expect((await app.request(`/confirm?t=${token}`)).status).toBe(410)
    expect(newsletter.pendingCount()).toBe(0)
  })

  it('refuses bad syntax and domains that cannot receive mail, and says why', async () => {
    expect((await harness().form({ email: 'nope' })).status).toBe(400)
    const noMx = await harness({ mxOk: false }).form({ email: 'a@no-mail.example' })
    expect(noMx.status).toBe(400)
    expect(await noMx.text()).toContain('receive email')
  })

  it('drops the pending row when the provider refuses the mail', async () => {
    const { newsletter, form } = harness({ mailFails: true })
    expect((await form({ email: 'x@example.com' })).status).toBe(503)
    expect(newsletter.pendingCount()).toBe(0)
  })

  it('gives a bot that fills the honeypot the normal page and sends nothing', async () => {
    const { sent, form } = harness()
    const res = await form({ email: 'bot@example.com', website: 'https://spam.example' })
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(0)
  })

  it('serves the JSON API, and the admin CSV only with the token', async () => {
    const { app, sent, tokenFrom } = harness()
    const api = await app.request('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'api@example.com' }) }, { ip: '198.51.100.1' })
    expect(await api.json()).toEqual({ ok: true, status: 'check-inbox' })
    await app.request(`/confirm?t=${tokenFrom(sent[0]!.text)}`)
    expect((await app.request('/api/admin/subscribers.csv')).status).toBe(401)
    expect((await app.request('/api/admin/subscribers.csv', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    const csv = await (await app.request('/api/admin/subscribers.csv', { headers: { authorization: 'Bearer ADMIN-TOKEN' } })).text()
    expect(csv.split('\n')[0]).toBe('email,confirmed_at')
    expect(csv).toContain('api@example.com,')
    expect(adminAuthorized('Bearer x', undefined)).toBe(false)
  })

  it('shows the form on the home page only when sending is configured', async () => {
    const on = await (await harness().app.request('/')).text()
    expect(on).toContain('action="/subscribe"')
    const off = createApp({ keys: {}, newsletter: new Newsletter(':memory:', null) })
    expect(await (await off.request('/')).text()).not.toContain('action="/subscribe"')
    expect((await off.request('/subscribe', { method: 'POST', body: new URLSearchParams({ email: 'a@example.com' }) })).status).toBe(404)
  })

  it('sends through Resend as hello@pit.world', async () => {
    const calls: Array<{ url: string; body: any }> = []
    const mail = resendMailer('RK', (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return new Response('{}', { status: 200 })
    }) as typeof fetch)
    await mail({ to: 'a@example.com', subject: 's', text: 't', html: 'h' })
    expect(calls[0]!.url).toBe('https://api.resend.com/emails')
    expect(calls[0]!.body).toMatchObject({ from: 'pit.world <hello@pit.world>', to: ['a@example.com'] })
  })

  it('pit subscribe talks to the API', async () => {
    const { app } = harness()
    const client = new PitClient('https://pit.world', ((url: any, init: any) => app.request(new URL(String(url)).pathname, init, { ip: '192.0.2.5' })) as typeof fetch)
    const lines: string[] = []
    const code = await main(['subscribe', 'cli@example.com'], { log: (t) => lines.push(t), error: (t) => lines.push(t) }, client)
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('Check your inbox')
  })
})
