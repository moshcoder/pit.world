/**
 * pit.world/submit: put sites into pit.world's own index. One address or a list of up
 * to SUBMIT_MAX, pasted or uploaded (a text list, an OPML file), of any kind: sites,
 * pages, RSS/Atom/JSON feeds, sitemaps, OPML. Free; ranking is not for sale here (paid
 * placement is ad.network, and says so).
 *
 * The page and POST /api/submit speak @profullstack/submit-feed's contract, so the same
 * client, CLI and agent tool work against pit.world as against rssamplifier.com. The
 * reading happens in the crawler's queue (services/crawler): a list of a thousand is
 * answered at once with what each line looks like, and /status shows the work.
 */
import type { Context, Hono } from 'hono'
import { parseSubmission, submitReply, wantsHtml } from '@profullstack/submit-feed/core'
import { submitPage, submitResultPage, type SubmitOutcome } from './html.js'
import { guessKind, privateBySpelling, SUBMIT_MAX } from './submit-kinds.js'

type Fetch = typeof fetch

export type SubmitDeps = {
  /** The crawler's loopback base (CRAWLER_STATUS_URL), which takes POST /api/v1/submit. */
  crawlerUrl: string
  /** True when the caller is over the rate limit. */
  limited: (c: Context<any>) => boolean
  fetch?: Fetch
}

/** Read whatever came in (JSON, a form with a pasted list, an uploaded file) into the outcome. */
export async function handleSubmission(body: unknown, deps: Pick<SubmitDeps, 'crawlerUrl' | 'fetch'>): Promise<SubmitOutcome> {
  const parsed = await parseSubmission(body as any, { maxEntries: SUBMIT_MAX })
  const accepted: SubmitOutcome['accepted'] = []
  const rejected: SubmitOutcome['rejected'] = parsed.invalid.slice(0, 200).map((url: string) => ({ url, error: 'invalid-url' }))
  for (const url of parsed.urls as string[]) {
    if (privateBySpelling(url)) rejected.push({ url, error: 'blocked-host' })
    else accepted.push({ url, kind: guessKind(url) })
  }
  let queued = 0
  let error: string | null = null
  if (accepted.length) {
    try {
      // threatcrush-disable-next-line js-ssrf-outbound-request  fixed loopback crawler address from configuration, never from a request
      const response = await (deps.fetch ?? fetch)(`${deps.crawlerUrl.replace(/\/+$/, '')}/api/v1/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls: accepted.map((a) => a.url) }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      queued = ((await response.json()) as { queued?: number }).queued ?? 0
    } catch {
      error = 'The crawler is not taking submissions right now. Nothing was lost on your side: try again in a few minutes.'
    }
  }
  return { accepted, rejected, queued, truncated: Boolean(parsed.truncated), error }
}

/** A form's fields as submit-feed reads them: the pasted list, plus an uploaded file as a list or as OPML. */
async function formBody(c: Context<any>): Promise<Record<string, string>> {
  const form = await c.req.parseBody()
  const out: Record<string, string> = { input: String(form.input ?? form.urls ?? form.url ?? '') }
  const file = form.file
  if (file instanceof File && file.size > 0) {
    if (file.size > 5 * 1024 * 1024) throw new RangeError('too-large')
    const text = await file.text()
    const head = text.slice(0, 2_000)
    if (/<opml\b/i.test(head)) out.opml = text
    else if (/<urlset\b|<sitemapindex\b/i.test(head)) {
      // A saved sitemap: its <loc> addresses, as a list.
      const locs = [...text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, '&'))
      out.input = `${out.input}\n${locs.join('\n')}`
    } else out.input = `${out.input}\n${text}`
  }
  return out
}

export function mountSubmit(app: Hono<any>, deps: SubmitDeps): void {
  app.get('/submit', (c) => c.html(submitPage()))

  app.post('/submit', async (c) => {
    if (deps.limited(c)) return c.html(submitPage({ error: 'Too many submissions from here in a short time. Wait a minute and try again.' }), 429)
    let body: Record<string, string>
    try {
      body = await formBody(c)
    } catch {
      return c.html(submitPage({ error: 'That file is too large: up to 5 MB, a thousand addresses.' }), 413)
    }
    const outcome = await handleSubmission(body, deps)
    if (!outcome.accepted.length && !outcome.rejected.length) return c.html(submitPage({ error: 'Paste at least one address, or choose a file.' }), 400)
    return c.html(submitResultPage(outcome), outcome.error ? 503 : 200)
  })

  app.post('/api/submit', async (c) => {
    if (deps.limited(c)) return c.json({ ok: false, error: 'rate-limited', retryAfterSeconds: 60 }, 429)
    const type = c.req.header('content-type') ?? ''
    let body: unknown
    try {
      body = /json/i.test(type) ? await c.req.json() : await formBody(c)
    } catch (error) {
      return c.json({ ok: false, error: error instanceof RangeError ? 'too-large' : 'invalid-body' }, error instanceof RangeError ? 413 : 400)
    }
    const outcome = await handleSubmission(body, deps)
    if (wantsHtml(c.req.header('accept') ?? '')) return c.redirect('/status', 303)
    // The contract's accepted entry is a feed directory's (slug, page, existing); ours adds what it looks like.
    const accepted = outcome.accepted.map((a) => ({ url: a.url, kind: a.kind, slug: '', page: 'https://pit.world/status', existing: false }))
    const reply = submitReply({ accepted, rejected: outcome.rejected, queued: outcome.queued, statusUrl: 'https://pit.world/status' })
    return c.json(outcome.error ? { ...reply, ok: false, error: 'unavailable', message: outcome.error } : { ...reply, truncated: outcome.truncated }, outcome.error ? 503 : 200)
  })
}
