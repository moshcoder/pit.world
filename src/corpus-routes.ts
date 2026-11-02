/**
 * The corpus API (src/corpus.ts sells it, pitbot's loopback index serves it):
 *
 *   GET  /api/corpus                 pages as full text, keyset-paged; metered per page
 *   GET  /api/corpus/stats           how big it is (free)
 *   GET  /api/corpus/credits         a key's balance, or the x402 offer for a credit pack
 *   POST /api/corpus/credits         x402 payment proof in, credit key out
 *   POST /account/corpus-credits     signed in: open a CoinPay invoice for credits
 *   GET  /api                        the API docs (all endpoints), incl. the corpus policy
 */
import type { Context, Hono } from 'hono'
import { createThrottle } from '@profullstack/throttle'
import { paymentRequiredHeader } from '@profullstack/x402-gateway'
import type { Account, Accounts } from './accounts.js'
import { SESSION_COOKIE } from './accounts.js'
import { parseCookies } from './accounts-routes.js'
import { CORPUS_HEADER, CorpusBilling, CorpusError, CREDITS_PATH, FREE_PAGES_PER_DAY, INVOICE_USD, PREVIEW_CHARS, usd } from './corpus.js'
import { docPage, esc } from './html.js'

type Env = { Bindings: { ip?: string } }

export type CorpusDeps = {
  billing: CorpusBilling
  /** pitbot's loopback base (CRAWLER_STATUS_URL), which answers /api/v1/corpus. */
  crawlerUrl: string
  accounts?: Accounts | null
  site: string
  fetch?: typeof fetch
  /** Requests a minute per address, and for everyone together (the internal key is exempt). */
  limits?: { perIp: number; global: number }
}

const MAX_LIMIT = 100
/** Characters of text per item for paying and internal callers. */
const TEXT_MAX = 24_000
const PACK_DEFAULT = 10_000
const PACK_MIN = 1_000
const PACK_MAX = 1_000_000

type Upstream = {
  items: Array<{ id: number; url: string; title: string; site: string; kind: string; language: string | null; fetched_at: string; text: string }>
  next_cursor: string | null
  resume_cursor: string
  total_matches: number | null
  total_capped: boolean
}

export function mountCorpus(app: Hono<Env>, d: CorpusDeps) {
  const { billing } = d
  const doFetch = d.fetch ?? fetch
  const base = d.crawlerUrl.replace(/\/+$/, '')
  const limits = d.limits ?? { perIp: 60, global: 1200 }
  const minute = (limit: number) => createThrottle({ limit, windowSeconds: 60, headroom: 1, credential: false, subresources: false, identify: (r) => r.headers.get('x-pit-who') })
  const perIp = minute(limits.perIp)
  const global = minute(limits.global)
  const over = async (t: ReturnType<typeof minute>, who: string) => !!(await t.handle(new Request('http://pit.world/api/corpus', { headers: { 'x-pit-who': who } })))

  let statsCache: { at: number; value: Record<string, any> } | null = null
  const stats = async (): Promise<Record<string, any> | null> => {
    if (statsCache && Date.now() - statsCache.at < 300_000) return statsCache.value
    try {
      const r = await doFetch(`${base}/api/v1/corpus/stats`, { signal: AbortSignal.timeout(20_000) })
      if (!r.ok) return statsCache?.value ?? null
      statsCache = { at: Date.now(), value: (await r.json()) as Record<string, any> }
      return statsCache.value
    } catch {
      return statsCache?.value ?? null
    }
  }

  const bearer = (c: Context<Env>) => (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim() || null
  const docs = `${d.site.replace(/\/+$/, '')}/api#corpus`
  const priceBlock = (pages: number) => ({
    usd_per_1000_pages: billing.pricing.usdPer1000,
    usd_per_page: billing.priceCents(1) / 100,
    pages,
    this_request: usd(billing.priceCents(pages)),
  })
  const howToPay = (pages: number) => ({
    x402: billing.x402Enabled
      ? `Retry this exact request with a PAYMENT-SIGNATURE (or X-PAYMENT) header paying ${usd(billing.priceCents(pages))} in USDC for up to ${pages} pages (the offer is in this body and the PAYMENT-REQUIRED header). Pages not returned stay as credit on a key sent back in ${CORPUS_HEADER}.`
      : 'x402 is not enabled on this server.',
    credits_x402: billing.x402Enabled ? `GET ${d.site}${CREDITS_PATH}?pages=${PACK_DEFAULT} for the offer, POST it with the payment: the response holds a key; send it as ${CORPUS_HEADER}: <key> (or Authorization: Bearer <key>).` : null,
    credits_coinpay: `${d.site}/account#corpus-credits (sign in with CoinPay, pay an invoice by CoinPay in any coin; then send your pit login token as Authorization: Bearer).`,
  })

  /** A self-explanatory 402: price, the x402 offer (body + PAYMENT-REQUIRED), and the other ways to pay. */
  const paymentRequired = (c: Context<Env>, pages: number, error: string, extra: Record<string, unknown> = {}) => {
    const offer = billing.offer(pages, '/api/corpus', `pit.world corpus: up to ${pages} pages of full text (${usd(billing.priceCents(1))} a page)`)
    if (offer) {
      c.header('payment-required', paymentRequiredHeader(offer, { error, url: `${d.site}${c.req.path}?${new URL(c.req.url).searchParams}` }))
      c.header('access-control-expose-headers', `PAYMENT-REQUIRED, PAYMENT-RESPONSE, ${CORPUS_HEADER}`)
    }
    c.header('cache-control', 'no-store')
    return c.json({ ...(offer ?? {}), status: 'payment_required', error, price: priceBlock(pages), free_preview: { pages_per_day: FREE_PAGES_PER_DAY, text_chars: PREVIEW_CHARS }, how_to_pay: howToPay(pages), docs, ...extra }, 402)
  }

  const upstream = async (c: Context<Env>, limit: number): Promise<Upstream | Response> => {
    const params = new URLSearchParams()
    for (const name of ['q', 'site', 'kind', 'lang', 'since', 'cursor']) {
      const v = c.req.query(name)
      if (v) params.set(name, v)
    }
    params.set('limit', String(limit))
    params.set('text_max', String(TEXT_MAX))
    try {
      const r = await doFetch(`${base}/api/v1/corpus?${params}`, { signal: AbortSignal.timeout(15_000) })
      const body = (await r.json().catch(() => ({}))) as any
      if (r.status === 400) return c.json({ error: body?.error ?? 'bad request', docs }, 400)
      if (!r.ok || !Array.isArray(body?.items)) return c.json({ error: 'The corpus is unavailable for a moment. Try again shortly.' }, 503)
      return body as Upstream
    } catch {
      return c.json({ error: 'The corpus is unavailable for a moment. Try again shortly.' }, 503)
    }
  }

  const shape = async (page: Upstream, served: number, textChars: number | null) => {
    const items = page.items.slice(0, served)
    const truncated = served < page.items.length
    const s = await stats()
    const share = s && s.pages_indexed ? Number(s.pages) / Number(s.pages_indexed) : null
    const total_estimate =
      page.total_matches === null ? (s ? Number(s.pages) : null) : share === null ? page.total_matches : Math.round(page.total_matches * share)
    return {
      total_estimate,
      total_estimate_capped: page.total_capped,
      next_cursor: truncated ? String(items.at(-1)!.id) : page.next_cursor,
      resume_cursor: truncated ? String(items.at(-1)!.id) : page.resume_cursor,
      items: items.map((i) => ({
        url: i.url,
        title: i.title,
        site: i.site,
        kind: i.kind,
        language: i.language,
        fetched_at: i.fetched_at,
        text: textChars !== null && i.text.length > textChars ? `${i.text.slice(0, textChars)}…` : i.text,
      })),
    }
  }

  app.get('/api/corpus/stats', async (c) => {
    const s = await stats()
    if (!s) return c.json({ error: 'The corpus is unavailable for a moment.' }, 503)
    c.header('cache-control', 'public, max-age=300')
    return c.json({ ...s, price: { usd_per_1000_pages: billing.pricing.usdPer1000 }, free_preview: { pages_per_day: FREE_PAGES_PER_DAY, text_chars: PREVIEW_CHARS }, docs })
  })

  app.get('/api/corpus', async (c) => {
    const vary = `authorization, ${CORPUS_HEADER}, payment-signature, x-payment`
    c.header('vary', vary)
    const raw = Math.trunc(Number(c.req.query('limit') ?? 20))
    if (!Number.isFinite(raw) || raw < 1) return c.json({ error: `limit must be 1 to ${MAX_LIMIT}`, docs }, 400)
    const limit = Math.min(raw, MAX_LIMIT)
    const cursor = c.req.query('cursor')
    if (cursor !== undefined && !/^\d{1,15}$/.test(cursor)) return c.json({ error: 'cursor must be a next_cursor this API returned', docs }, 400)
    const ip = c.env?.ip || 'unknown'
    const token = bearer(c)
    const internal = billing.isInternal(token)
    if (!internal) {
      if (await over(perIp, `ip:${ip}`)) {
        c.header('retry-after', '60')
        return c.json({ error: `Rate limited: ${limits.perIp} requests a minute per address.`, docs }, 429)
      }
      if (await over(global, 'all')) {
        c.header('retry-after', '30')
        return c.json({ error: 'The corpus is busy. Try again in half a minute.', docs }, 429)
      }
    }
    if (internal) {
      const page = await upstream(c, limit)
      if (page instanceof Response) return page
      billing.record('internal', page.items.length)
      c.header('cache-control', 'private, no-store')
      return c.json({ ...(await shape(page, page.items.length, null)), access: { mode: 'internal', pages_charged: 0 } })
    }

    // A key or an account with prepaid pages.
    const key = c.req.header(CORPUS_HEADER) || (token?.startsWith('pck_') ? token : null)
    const keyHolder = billing.keyHolder(key)
    if (key && !keyHolder) return paymentRequired(c, limit, 'That corpus key is not valid.')
    const account = !keyHolder && token && d.accounts ? d.accounts.tokenAccount(token) : !keyHolder && d.accounts ? d.accounts.sessionAccount(parseCookies(c.req.header('cookie'))[SESSION_COOKIE]) : null
    const holder = keyHolder ?? (account ? `acct:${account.id}` : null)

    // x402 on the request: pays for `limit` pages now.
    const proof = c.req.header('payment-signature') || c.req.header('x-payment')
    if (proof) {
      const sale = await billing.settle(proof, limit, '/api/corpus', 'corpus-pages', c.req.header('user-agent') ?? '')
      if (!sale.ok) return paymentRequired(c, limit, sale.error)
      if (sale.paymentResponse) c.header('payment-response', sale.paymentResponse)
      c.header('access-control-expose-headers', `PAYMENT-RESPONSE, ${CORPUS_HEADER}`)
      const page = await upstream(c, limit)
      // Paid and the index failed: the whole payment becomes credit.
      const served = page instanceof Response ? 0 : page.items.length
      const left = limit - served
      const minted = left > 0 ? (holder ? (billing.credit(holder, left), null) : billing.mintKey(left)) : null
      if (minted) c.header(CORPUS_HEADER, minted.key)
      if (page instanceof Response) return page
      billing.record('x402', served)
      c.header('cache-control', 'private, no-store')
      return c.json({ ...(await shape(page, served, null)), access: { mode: 'x402', pages_charged: served, ...(left > 0 ? { credited: left, ...(minted ? { key: minted.key, key_header: CORPUS_HEADER } : {}) } : {}) } })
    }

    if (holder && billing.balance(holder) > 0) {
      const want = Math.min(limit, billing.balance(holder))
      const page = await upstream(c, want)
      if (page instanceof Response) return page
      const served = billing.spend(holder, page.items.length)
      billing.record(keyHolder ? 'key' : 'account', served)
      c.header('cache-control', 'private, no-store')
      return c.json({ ...(await shape(page, served, null)), access: { mode: keyHolder ? 'key' : 'account', pages_charged: served, balance: billing.balance(holder) } })
    }

    // The free preview: 20 pages a day per address, text cut short.
    const left = billing.previewLeft(ip)
    if (left <= 0)
      return paymentRequired(
        c,
        limit,
        `The free preview is ${FREE_PAGES_PER_DAY} pages a day (text cut to ${PREVIEW_CHARS} characters), and this address has used them. Full text is ${usd(billing.priceCents(1000))} per 1,000 pages.`,
        holder ? { balance: 0 } : {},
      )
    const page = await upstream(c, Math.min(limit, left))
    if (page instanceof Response) return page
    billing.usePreview(ip, page.items.length)
    billing.record('preview', page.items.length)
    c.header('cache-control', 'private, max-age=60')
    return c.json({
      ...(await shape(page, page.items.length, PREVIEW_CHARS)),
      access: {
        mode: 'preview',
        pages_charged: 0,
        free_pages_left_today: billing.previewLeft(ip),
        text_truncated_to: PREVIEW_CHARS,
        full_text: `${usd(billing.priceCents(1000))} per 1,000 pages: ${docs}`,
      },
    })
  })

  // Credit packs over x402: a key holding `pages` pages, for agents with no account.
  const packSize = (c: Context<Env>) => {
    const n = Math.trunc(Number(c.req.query('pages') ?? PACK_DEFAULT))
    return Number.isFinite(n) ? Math.min(PACK_MAX, Math.max(PACK_MIN, Math.ceil(n / 1000) * 1000)) : PACK_DEFAULT
  }
  const credits = async (c: Context<Env>) => {
    c.header('cache-control', 'no-store')
    const key = c.req.header(CORPUS_HEADER) || bearer(c)
    const holder = billing.keyHolder(key)
    if (holder && c.req.method === 'GET') return c.json({ status: 'active', balance: billing.balance(holder), header: CORPUS_HEADER })
    const pages = packSize(c)
    if (!billing.x402Enabled) return c.json({ error: 'x402 is not enabled on this server. Buy credits at /account#corpus-credits.' }, 404)
    const proof = c.req.header('payment-signature') || c.req.header('x-payment')
    const offerFor = (error: string) => {
      const offer = billing.offer(pages, `${CREDITS_PATH}?pages=${pages}`, `pit.world corpus credits: ${pages.toLocaleString('en-US')} pages of full text`)!
      c.header('payment-required', paymentRequiredHeader(offer, { error }))
      c.header('access-control-expose-headers', `PAYMENT-REQUIRED, PAYMENT-RESPONSE, ${CORPUS_HEADER}`)
      return c.json({ ...offer, status: 'payment_required', error, price: priceBlock(pages), how_to_pay: howToPay(pages), docs }, 402)
    }
    if (!proof) return offerFor(`${usd(billing.priceCents(pages))} buys a key holding ${pages.toLocaleString('en-US')} pages. ?pages=${PACK_MIN} to ${PACK_MAX}.`)
    const sale = await billing.settle(proof, pages, `${CREDITS_PATH}?pages=${pages}`, 'corpus-credits', c.req.header('user-agent') ?? '')
    if (!sale.ok) return offerFor(sale.error)
    const minted = holder ? (billing.credit(holder, pages), { key: key!, holder }) : billing.mintKey(pages)
    if (sale.paymentResponse) c.header('payment-response', sale.paymentResponse)
    c.header('access-control-expose-headers', `PAYMENT-RESPONSE, ${CORPUS_HEADER}`)
    c.header(CORPUS_HEADER, minted.key)
    return c.json({ status: 'active', key: minted.key, header: CORPUS_HEADER, balance: billing.balance(minted.holder) })
  }
  app.get(CREDITS_PATH, credits)
  app.post(CREDITS_PATH, credits)

  // Humans: a CoinPay invoice from /account.
  if (d.accounts) {
    const accounts = d.accounts
    const origin = new URL(d.site).origin
    app.post('/account/corpus-credits', async (c) => {
      const me = accounts.sessionAccount(parseCookies(c.req.header('cookie'))[SESSION_COOKIE])
      if (!me) return c.redirect('/signin?next=/account', 302)
      const fetchSite = c.req.header('sec-fetch-site')
      let same = fetchSite ? fetchSite === 'same-origin' : false
      if (!fetchSite) {
        try {
          same = new URL(c.req.header('origin') ?? c.req.header('referer') ?? '').origin === origin
        } catch {}
      }
      if (!same) return c.text('Forbidden', 403)
      const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
      try {
        return c.redirect(await billing.buy(me.id, body.email, body.amount), 303)
      } catch (e) {
        return c.redirect(`/account?ok=${encodeURIComponent(e instanceof CorpusError ? e.message : 'Checkout did not work. Try again in a minute.')}#corpus-credits`, 302)
      }
    })
  }

  app.get('/api', (c) => {
    c.header('cache-control', 'public, max-age=600')
    return c.html(apiDocsPage(billing))
  })
}

/** The /account section: balance, how to use it, and the invoice form. */
export function corpusSection(billing: CorpusBilling) {
  return async (me: Account): Promise<string> => {
    const balance = billing.balance(`acct:${me.id}`)
    const open = billing.openInvoice(me.id)
    const options = INVOICE_USD.map((n) => `<option value="${n}">$${n}: ${billing.pagesFor(n).toLocaleString('en-US')} pages</option>`).join('')
    return `<h2 id="corpus-credits">Corpus credits</h2>
<p>Full page text from pit.world's own crawl index, for training models: ${usd(billing.priceCents(1000))} per 1,000 pages returned. Pages whose publishers opted out of AI training are never included. <a href="/api#corpus">How it works</a></p>
<p>Balance: <strong>${balance.toLocaleString('en-US')} pages</strong>. Use it with your <code>pit login</code> token: <code>curl -H "Authorization: Bearer $PIT_TOKEN" 'https://pit.world/api/corpus?q=saas&amp;limit=100'</code></p>
${open ? `<p class="notice">An invoice is open: <a href="${esc(open)}">pay it on CoinPay</a>. Credits arrive a minute or two after it is paid.</p>` : ''}
${billing.sellable ? `<form method="post" action="/account/corpus-credits"><label>Amount <select name="amount">${options}</select></label> <label>Invoice email <input type="email" name="email" required maxlength="254" autocomplete="email" value="${esc(me.email ?? '')}"></label> <button>Buy credits</button></form>` : '<p class="muted">Checkout is unavailable right now.</p>'}`
  }
}

export function apiDocsPage(billing: CorpusBilling): string {
  const per1000 = usd(billing.priceCents(1000))
  return docPage({
    title: 'API · pit.world',
    path: '/api',
    description: 'The pit.world JSON API: private web search, Moshpit names, and the training corpus of pit.world\'s own crawl index.',
    body: `<h1>The pit.world API</h1>
<p class="lede">JSON over HTTPS, CORS open. The same API is the <code>pit</code> CLI and the <code>pit mcp</code> server (<a href="/about#api">install</a>).</p>
<h2 id="search">Search and names (free)</h2>
<pre><code>GET /api/search?q=&lt;words&gt;&amp;n=10&amp;t=web|images|videos|music|live
GET /api/resolve?name=chovy.hacker
GET /api/network
GET /api/status          pitbot, the crawler, live
GET /api/corpus/stats    the training corpus, below</code></pre>

<h2 id="corpus">Training corpus: <code>/api/corpus</code></h2>
<p>Full page text from pit.world's own crawl index (pages <a href="/bot">pitbot</a> read), queryable and paged, for training models. It grows as pitbot crawls.</p>
<pre><code>GET /api/corpus?q=&lt;words&gt;&amp;site=&amp;kind=&amp;lang=&amp;since=&amp;limit=1..100&amp;cursor=
GET /api/corpus/stats

{ "total_estimate": 1234, "next_cursor": "48213",
  "items": [ { "url", "title", "site", "kind", "language", "fetched_at", "text" } ],
  "access": { "mode": "preview|key|account|x402", "pages_charged": 20, ... } }</code></pre>
<ul>
<li><b>q</b>: words, all of which must appear. <b>Commas separate alternatives</b>: <code>q=saas,business,crypto</code> is pages with any of the three; <code>q=open source,self hosted</code> is (open and source) or (self and hosted). Punctuation is ignored, never an error: q is not a query language. Empty q pages through everything.</li>
<li><b>site</b> (host, <code>www.</code> ignored), <b>kind</b> (page, article, product, profile, site, ...), <b>lang</b> (<code>en</code> matches en-us too), <b>since</b> (ISO date: fetched at or after).</li>
<li><b>Paging</b>: results come in index order (oldest first), not by relevance. Pass <code>next_cursor</code> back as <code>cursor</code> until it is <code>null</code>. Cursors never expire and pages never shift: keep <code>resume_cursor</code> and come back later for pages added since. A page can come back with fewer items than <code>limit</code> (a rare match is scanned in slices); keep following the cursor.</li>
<li><code>text</code> is the page's main text, up to 10,000 characters as pitbot stores it.</li>
<li><code>total_estimate</code>: matching pages after opt-outs, estimated (counted up to 10,000 matches, then scaled).</li>
</ul>

<h3 id="corpus-price">Price</h3>
<ul>
<li><b>Free preview</b>: ${FREE_PAGES_PER_DAY} pages a day per address, <code>text</code> cut to ${PREVIEW_CHARS} characters, so you can see what is there. <code>/api/corpus/stats</code> is always free.</li>
<li><b>Full text: ${per1000} per 1,000 pages returned</b> (${usd(billing.priceCents(1))} a page). Only pages actually returned are charged.</li>
<li>Over the preview, <code>/api/corpus</code> answers <code>402 Payment Required</code> with the price, an x402 offer (in the body and the <code>PAYMENT-REQUIRED</code> header) and these ways to pay:</li>
</ul>
<ol>
<li><b>x402, per request</b> (agents): retry the same request with <code>PAYMENT-SIGNATURE</code> (or <code>X-PAYMENT</code>) paying <code>limit</code> x ${usd(billing.priceCents(1))} in USDC. Pages the request did not return stay as credit on a key, sent back in <code>${CORPUS_HEADER}</code>.</li>
<li><b>x402 credit pack</b>: <code>GET ${CREDITS_PATH}?pages=10000</code> is the offer (${usd(billing.priceCents(10_000))}); <code>POST</code> it with the payment and get a key. Send it as <code>${CORPUS_HEADER}: pck_...</code> or <code>Authorization: Bearer pck_...</code>; <code>GET ${CREDITS_PATH}</code> with it shows the balance.</li>
<li><b>CoinPay invoice</b> (people): sign in, then <a href="/account#corpus-credits">/account</a> → Corpus credits ($${INVOICE_USD.join(', $')}; any coin CoinPay takes). Use the balance with your <code>pit login</code> token as <code>Authorization: Bearer</code>.</li>
</ol>
<p>x402 payments are verified and settled by CoinPay; invoices are confirmed with pay.agent server to server. Rate limit: 60 requests a minute per address (429 with <code>Retry-After</code>).</p>

<h3 id="corpus-policy">Training opt-outs: what is never in the corpus</h3>
<p>Reading a page for search is not permission to train on it. A page is in the corpus only when its publisher left AI training open. pitbot records these signals for every page it reads, and any one of them keeps the page out:</p>
<ul>
<li><code>X-Robots-Tag</code> or <code>&lt;meta name="robots"&gt;</code> (or a <code>pitbot</code> meta) containing <code>noai</code>. (<code>noimageai</code> alone is about images, and the corpus is text.)</li>
<li>TDMRep (W3C): a <code>tdm-reservation: 1</code> header, <code>&lt;meta name="tdm-reservation" content="1"&gt;</code>, or a <code>/.well-known/tdmrep.json</code> rule reserving the path.</li>
<li>robots.txt keeping any AI-training crawler off the path: GPTBot, Google-Extended, CCBot, ClaudeBot, anthropic-ai, Claude-Web, cohere-ai, cohere-training-data-crawler, Bytespider, PerplexityBot, Applebot-Extended, meta-externalagent, Amazonbot, omgilibot, Diffbot, ImagesiftBot, Timpibot, AI2Bot, YouBot (each by its own group, or <code>User-agent: *</code> when it has none).</li>
<li>Unknown is out: a robots.txt that could not be fetched (a 404 is an answer: no rules), and pages read before these signals were recorded until they are judged. Those older pages are judged on robots.txt and tdmrep.json alone, and on their own headers and meta when pitbot reads them again (every 30 days).</li>
</ul>
<p><code>/api/corpus/stats</code> reports how many pages each rule kept out (<code>excluded_by</code>). Publishers: see <a href="/bot">pitbot</a> for how to keep pages out of search as well.</p>
<pre><code>curl 'https://pit.world/api/corpus?q=saas,business,crypto&amp;limit=20'
curl 'https://pit.world/api/corpus/stats'
pit corpus "saas,crypto" --limit 20 [--cursor N]
# MCP: the corpus tool</code></pre>`,
  })
}
