/**
 * /build by invoice: the same $49 + $2 a month, billed through pay.agent.
 *
 * pay.agent sends real CoinPay invoices as profullstack (its API key lives in
 * the pit.world vault): one for $49 (the build and the first 30 days) and one
 * for $2 that CoinPay repeats monthly from day 31. We keep nothing; the order
 * goes to the builder by email and the buyer goes to their $49 invoice.
 */
import { scoreSubmission, substance } from '@profullstack/form-guard'
import type { Mailer } from './newsletter.js'

export const BUILD_USD = 49
export const HOSTING_USD = 2

export type BuildInvoicing = {
  /** https://pay.agent.pit.world, or a local instance. */
  payAgentUrl: string
  /** profullstack's pay.agent key (pa_…). */
  key: string
  mailer?: Mailer | null
  /** Who hears about each order. */
  notifyTo?: string
  fetch?: typeof fetch
}

export type BuildOrder = { email: string; name: string; idea: string }

export class OrderError extends Error {}

type Invoice = { id: string; number: string; url: string; warning?: string }

const day = (d: Date) => d.toISOString().slice(0, 10)

/** Form fields to an order, or the reason they are not one. */
export function readOrder(form: Record<string, unknown>): BuildOrder {
  const str = (k: string, max: number) => String(form[k] ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max)
  const email = str('email', 254).toLowerCase()
  const idea = str('idea', 2000)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new OrderError('Which email should the invoice go to?')
  if (idea.length < 10) throw new OrderError('Tell us what the app should do, in a sentence or two.')
  return { email, name: str('name', 80), idea }
}

/** Selling to us, not buying: no idea that mentions these is an app. */
const SELLING = /\b(guest post|backlinks?|seo services|rank (your|on) (website|google))\b/i
/** Stock enquiry sentences form-guard does not know (it knows the pricing/availability/process one). */
const CANNED = [/interested in (scheduling|booking) a (brief|quick|short) (consultation|call)/i]

/**
 * Contact-form spam: the stock "questions about pricing, availability, and the
 * general process of working with you" note sent to every form on the web.
 * It is spam only when nothing is left once its stock sentences and
 * pleasantries are taken out (form-guard's substance()), so a real buyer who
 * opens with the same line and then describes an app still gets an invoice.
 */
export function looksLikeSpam(order: BuildOrder): boolean {
  if (SELLING.test(order.idea)) return true
  const canned = scoreSubmission({ message: order.idea }).signals.includes('contentless_request') || CANNED.some((re) => re.test(order.idea))
  if (!canned) return false
  const rest = substance(order.idea)
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !CANNED.some((re) => re.test(s)))
    .join(' ')
  return rest.length < 20
}

export async function orderByInvoice(cfg: BuildInvoicing, order: BuildOrder, now = new Date()): Promise<{ build: Invoice; hosting: Invoice }> {
  const doFetch = cfg.fetch ?? fetch
  const base = cfg.payAgentUrl.replace(/\/+$/, '')
  const send = async (body: Record<string, unknown>): Promise<Invoice> => {
    const res = await doFetch(`${base}/api/v1/invoices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ to_email: order.email, ...(order.name ? { to_name: order.name } : {}), ...body }),
      signal: AbortSignal.timeout(45_000),
    })
    const data = (await res.json().catch(() => ({}))) as Partial<Invoice> & { error?: string }
    if (!res.ok || !data.id || !data.url) throw new OrderError(data.error ? `pay.agent: ${data.error}` : `pay.agent answered ${res.status}`)
    return { id: data.id, number: data.number ?? '', url: data.url, ...(data.warning ? { warning: data.warning } : {}) }
  }
  const summary = order.idea.split('\n')[0]!.slice(0, 120)
  const build = await send({ amount_usd: BUILD_USD, description: `App build, including the first 30 days online: ${summary}`, due_date: day(now) })
  const hosting = await send({
    amount_usd: HOSTING_USD,
    description: `Hosting, $${HOSTING_USD} a month after the first 30 days: ${summary}`,
    due_date: day(new Date(now.getTime() + 30 * 86_400_000)),
    recurrence: 'monthly',
  })
  if (cfg.mailer && cfg.notifyTo) {
    const text = `New pit.world build, by invoice.\n\nFrom: ${order.name || '(no name)'} <${order.email}>\n\nIdea:\n${order.idea}\n\n$${BUILD_USD} build: ${build.url} (${build.number})\n$${HOSTING_USD}/mo hosting from day 31: ${hosting.url} (${hosting.number})\n\nStart the build on chovy.com once the $${BUILD_USD} is paid.`
    await cfg.mailer({ to: cfg.notifyTo, subject: `pit.world build: ${summary.slice(0, 60)}`, text, html: `<pre>${text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!)}</pre>`, replyTo: order.email }).catch((e) => console.error('build order email:', e instanceof Error ? e.message : e))
  }
  return { build, hosting }
}
