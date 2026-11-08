/**
 * The fleet crawler rule (2026-11-08): 10 s per fetch, 30 s per render, and a slow or
 * broken target is flagged and left alone for 30 days, then rechecked exactly once.
 */
import { describe, expect, test } from 'bun:test'
import { configFromEnv, CRAWL_FETCH_TIMEOUT_MS, CRAWL_RECHECK_MS, CRAWL_RENDER_SETTLE_MS, CRAWL_RENDER_TIMEOUT_MS } from '../src/config.ts'
import { createCrawler, type PageJob, type SiteJob } from '../src/crawler.ts'
import { failureKind, HOST_PAGE_FAILURES, isDue, parkFor, retryAfterMs, statusKind } from '../src/failures.ts'
import { politeGet } from '../src/fetcher.ts'
import { MemoryFrontier } from '../src/frontier.ts'
import { ObscuraClient, ObscuraError, RenderTimeout, SETTLED_EXPRESSION } from '../src/obscura.ts'
import { MemorySiteStore } from '../src/site-store.ts'

const DAY = 86_400_000

describe('the budgets', () => {
  test('10 s per fetch, 30 s per render, a settle of at most 2 s, a 30-day recheck', () => {
    expect(CRAWL_FETCH_TIMEOUT_MS).toBe(10_000)
    expect(CRAWL_RENDER_TIMEOUT_MS).toBe(30_000)
    expect(CRAWL_RENDER_SETTLE_MS).toBeLessThanOrEqual(2_000)
    expect(CRAWL_RECHECK_MS).toBe(30 * DAY)
    expect(SETTLED_EXPRESSION(60_000)).toContain('setTimeout(resolve, 2000)')
  })

  test('one budget covers every redirect hop and the body, not 20 s a hop', async () => {
    let hops = 0
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      hops++
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 40)
        init?.signal?.addEventListener('abort', () => (clearTimeout(t), reject(init.signal!.reason)))
      })
      return new Response('', { status: 301, headers: { location: `https://a.example/${hops}` } })
    }) as unknown as typeof fetch
    const started = Date.now()
    const error = await politeGet('https://a.example/', { userAgent: 't', resolver: async () => true, fetch: slow, timeoutMs: 100 }).catch((e) => e)
    expect(failureKind(error)).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(400)
    expect(hops).toBeLessThanOrEqual(4)
  })

  test('a body that trickles past the budget is a timeout, not a short page', async () => {
    const trickle = (async () => {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('<html>'))
          await new Promise((r) => setTimeout(r, 500))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/html' } })
    }) as unknown as typeof fetch
    const error = await politeGet('https://a.example/', { userAgent: 't', resolver: async () => true, fetch: trickle, timeoutMs: 100 }).catch((e) => e)
    expect(failureKind(error)).toBe('timeout')
  })

  test('a name lookup that hangs is cut off too', async () => {
    const error = await politeGet('https://a.example/', { userAgent: 't', resolver: () => new Promise(() => {}), timeoutMs: 50 }).catch((e) => e)
    expect(failureKind(error)).toBe('timeout')
  })
})

describe('what counts as slow or broken', () => {
  test("Bun's fetch errors, by kind", () => {
    expect(failureKind({ name: 'TimeoutError', message: 'The operation timed out.' })).toBe('timeout')
    expect(failureKind({ name: 'TypeError', code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x.invalid' })).toBe('dns')
    expect(failureKind(new Error('refused: x.example is not on the public internet'))).toBe('dns')
    expect(failureKind({ name: 'TypeError', code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self signed certificate' })).toBe('tls')
    expect(failureKind({ name: 'TypeError', code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' })).toBe('tls')
    expect(failureKind({ name: 'TypeError', code: 'ECONNREFUSED', message: 'ECONNREFUSED: Unable to connect.' })).toBe('connection')
    expect(failureKind(new RenderTimeout('https://a.example/', 30_000))).toBe('timeout')
    expect(failureKind(new Error('obscura browser_navigate: net::ERR_NAME_NOT_RESOLVED'))).toBe('dns')
  })

  test('our own trouble and plain bugs are not the target', () => {
    expect(failureKind(new ObscuraError('obscura unreachable: ECONNREFUSED'))).toBeNull()
    expect(failureKind(new ObscuraError('obscura HTTP 502'))).toBeNull()
    expect(failureKind(new Error('too many redirects'))).toBeNull()
    expect(failureKind(new TypeError("undefined is not an object"))).toBeNull()
    expect(failureKind(null)).toBeNull()
  })

  test('5xx and 429 fail; every other status keeps its meaning', () => {
    expect(statusKind(500)).toBe('http5xx')
    expect(statusKind(503)).toBe('http5xx')
    expect(statusKind(429)).toBe('http429')
    expect(statusKind(404)).toBeNull()
    expect(statusKind(403)).toBeNull()
    expect(statusKind(200)).toBeNull()
  })

  test('Retry-After is honoured but capped at 30 days; absent, a day', () => {
    const now = Date.parse('2026-11-08T00:00:00Z')
    expect(retryAfterMs('120', now)).toBe(120_000)
    expect(retryAfterMs('1', now)).toBe(60_000)
    expect(retryAfterMs(String(365 * 86_400), now)).toBe(30 * DAY)
    expect(retryAfterMs('Mon, 09 Nov 2026 00:00:00 GMT', now)).toBe(DAY)
    expect(retryAfterMs(null, now)).toBe(DAY)
    expect(retryAfterMs('soon', now)).toBe(DAY)
    expect(parkFor('timeout')).toBe(30 * DAY)
    expect(parkFor('http429', '600')).toBe(600_000)
  })

  test('due again only when the cycle AND the flag have run out: exactly one recheck', () => {
    const now = Date.now()
    expect(isDue({ scheduledAt: now - 31 * DAY, retryAfter: null }, 30 * DAY, now)).toBe(true)
    expect(isDue({ scheduledAt: now - 31 * DAY, retryAfter: now + DAY }, 30 * DAY, now)).toBe(false)
    expect(isDue({ scheduledAt: now - 31 * DAY, retryAfter: now - 1 }, 30 * DAY, now)).toBe(true)
    expect(isDue({ scheduledAt: now - DAY, retryAfter: now - 1 }, 30 * DAY, now)).toBe(false)
    expect(isDue({ scheduledAt: null, retryAfter: null }, 30 * DAY, now)).toBe(false)
  })
})

describe('the site store flag', () => {
  test('a flagged site is skipped by the recrawl until retry_after, rechecked once, cleared on success', async () => {
    const store = new MemorySiteStore()
    await store.add([{ site: 'dead.example', source: 'x' }, { site: 'fine.example', source: 'x' }], true)
    for (const row of store.rows.values()) row.scheduledAt = Date.now() - 31 * DAY
    await store.flag('dead.example', 'timeout: robots.txt', Date.now() + 30 * DAY)
    expect((await store.flagOf('dead.example'))?.lastError).toBe('timeout: robots.txt')
    expect(await store.takeDue(30 * DAY, 10)).toEqual(['fine.example'])
    // 30 days on: one recheck, and only one.
    store.rows.get('dead.example')!.flag!.retryAfter = Date.now() - 1
    expect(await store.takeDue(30 * DAY, 10)).toEqual(['dead.example'])
    expect(await store.takeDue(30 * DAY, 10)).toEqual([])
    await store.clearFlag('dead.example')
    expect(await store.flagOf('dead.example')).toBeNull()
  })
})

const text = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } })
const page = (body: string) => new Response(`<html><head><title>t</title></head><body><main>${body}</main></body></html>`, { headers: { 'content-type': 'text/html' } })

function setup(web: (url: string) => Promise<Response> | Response, renderer?: { size: number; render(url: string): Promise<{ url: string; html: string }> }) {
  const config = configFromEnv({ CRAWL_HOST_DELAY_MS: '0' })
  const frontier = new MemoryFrontier(config.maxPages)
  const sites = new MemorySiteStore()
  const calls: string[] = []
  const queued = { sites: [] as SiteJob[], pages: [] as PageJob[], render: [] as PageJob[] }
  const crawler = createCrawler({
    config,
    frontier,
    sites,
    resolver: async () => true,
    fetch: (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      calls.push(url)
      return web(url)
    }) as typeof fetch,
    renderer: renderer ?? null,
    enqueue: {
      async sites(jobs) {
        queued.sites.push(...jobs)
      },
      async pages(jobs) {
        queued.pages.push(...jobs)
      },
      async render(job) {
        queued.render.push(job)
      },
    },
  })
  return { crawler, frontier, sites, calls, queued }
}

const timeout = () => Promise.reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))

describe('a slow or broken host in the crawl', () => {
  test('robots.txt timing out parks the host 30 days instead of reading it as "no rules"', async () => {
    const { crawler, frontier, sites, calls, queued } = setup((url) => (url.endsWith('/robots.txt') ? timeout() : page('hi')))
    expect((await crawler.crawlSite({ site: 'slow.example', source: 'x' })).outcome).toBe('robots.txt unavailable')
    expect(queued.pages).toEqual([])
    const flag = await sites.flagOf('slow.example')
    expect(flag?.lastError).toMatch(/^timeout: robots.txt/)
    expect(flag!.retryAfter - Date.now()).toBeGreaterThan(29 * DAY)
    expect((await frontier.siteState('slow.example')).downMs).toBeGreaterThan(29 * DAY)
    // Its queued pages are dropped without a single request.
    calls.length = 0
    expect((await crawler.crawlPage({ url: 'https://slow.example/a', site: 'slow.example', depth: 1 })).outcome).toBe('host parked')
    expect(calls).toEqual([])
  })

  test('robots.txt 5xx parks the host; a 429 parks it for its Retry-After; a 404 is still "no rules"', async () => {
    const a = setup((url) => (url.endsWith('/robots.txt') ? text('down', 503) : page('hi')))
    expect((await a.crawler.crawlSite({ site: 'five.example', source: 'x' })).outcome).toBe('robots.txt unavailable')
    expect((await a.sites.flagOf('five.example'))?.lastError).toBe('http5xx: robots.txt answered HTTP 503')

    const b = setup((url) => (url.endsWith('/robots.txt') ? text('slow down', 429, { 'retry-after': '600' }) : page('hi')))
    await b.crawler.crawlSite({ site: 'busy.example', source: 'x' })
    const down = (await b.frontier.siteState('busy.example')).downMs
    expect(down).toBeGreaterThan(590_000)
    expect(down).toBeLessThanOrEqual(600_000)
    // A short park is waited out, not dropped.
    expect((await b.crawler.crawlPage({ url: 'https://busy.example/a', site: 'busy.example', depth: 1 })).delayMs).toBeGreaterThan(0)

    const c = setup((url) => (url.endsWith('/robots.txt') ? text('nope', 404) : page('hi')))
    expect((await c.crawler.crawlSite({ site: 'ok.example', source: 'x' })).outcome).toBe('started')
    expect(await c.sites.flagOf('ok.example')).toBeNull()
  })

  test('a page that times out is flagged, not thrown for BullMQ to retry; enough of them park the host', async () => {
    const { crawler, frontier, sites } = setup((url) => (url.endsWith('/robots.txt') ? text('') : url.includes('/slow') ? timeout() : page('hi')))
    const job = (n: number) => ({ url: `https://big.example/slow${n}`, site: 'big.example', depth: 1 })
    expect((await crawler.crawlPage(job(0))).outcome).toBe('page parked: timeout')
    expect((await frontier.siteState('big.example', job(0).url)).pageDown).toBe(true)
    expect((await crawler.crawlPage(job(0))).outcome).toBe('page parked')
    expect(await sites.flagOf('big.example')).toBeNull()
    for (let i = 1; i < HOST_PAGE_FAILURES; i++) await crawler.crawlPage(job(i))
    expect((await sites.flagOf('big.example'))?.lastError).toMatch(/pages failed within the hour/)
    expect((await crawler.crawlPage({ url: 'https://big.example/fine', site: 'big.example', depth: 1 })).outcome).toBe('host parked')
  })

  test('a connection failure on a page parks the host at once; a 5xx parks the page', async () => {
    const refused = () => Promise.reject(Object.assign(new TypeError('ECONNREFUSED: Unable to connect.'), { code: 'ECONNREFUSED' }))
    const a = setup((url) => (url.endsWith('/robots.txt') ? text('') : refused()))
    expect((await a.crawler.crawlPage({ url: 'https://gone.example/a', site: 'gone.example', depth: 1 })).outcome).toBe('host parked: connection')
    expect((await a.sites.flagOf('gone.example'))?.lastError).toMatch(/^connection:/)

    const b = setup((url) => (url.endsWith('/robots.txt') ? text('') : text('oops', 502)))
    expect((await b.crawler.crawlPage({ url: 'https://flaky.example/a', site: 'flaky.example', depth: 1 })).outcome).toBe('page parked: http5xx')
  })

  test('a bug is still thrown (and retried): only target failures are swallowed', async () => {
    const { crawler } = setup((url) => (url.endsWith('/robots.txt') ? text('') : Promise.reject(new Error('something else'))))
    await expect(crawler.crawlPage({ url: 'https://x.example/a', site: 'x.example', depth: 1 })).rejects.toThrow('something else')
  })

  test('the recheck clears the flag when the host answers again', async () => {
    let dead = true
    const { crawler, frontier, sites } = setup((url) => (dead ? timeout() : url.endsWith('/robots.txt') ? text('') : page('hi')))
    await crawler.crawlSite({ site: 'back.example', source: 'x' })
    expect(await sites.flagOf('back.example')).not.toBeNull()
    // 30 days later: the flag, the Redis park and the cycle claim have all run out.
    sites.rows.get('back.example')!.scheduledAt = Date.now() - 31 * DAY
    sites.rows.get('back.example')!.flag!.retryAfter = Date.now() - 1
    frontier.down.delete('back.example')
    frontier.started.delete('back.example')
    expect(await crawler.recrawl()).toBe(1)
    expect(await crawler.recrawl()).toBe(0)
    dead = false
    expect((await crawler.crawlSite({ site: 'back.example', source: 'recrawl' })).outcome).toBe('started')
    expect(await sites.flagOf('back.example')).toBeNull()
  })
})

describe('the browser budget', () => {
  test('a render out of its 30 s is a timeout to flag, never a page', async () => {
    const hang = (async (_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch
    const client = new ObscuraClient('http://obscura.test/mcp', 't', hang, 80, 10)
    const error = await client.render('https://slow.example/').catch((e) => e)
    expect(error).toBeInstanceOf(RenderTimeout)
    expect(failureKind(error)).toBe('timeout')
  })

  test("navigates to load, never networkidle, and reads back after a bounded settle", async () => {
    const sent: any[] = []
    const ok = (async (_: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      sent.push(body)
      const result = body.method === 'tools/call' && body.params.name === 'browser_evaluate' ? { content: [{ text: JSON.stringify({ url: 'https://a.example/', text: 'hi' }) }] } : { content: [] }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 's' } })
    }) as unknown as typeof fetch
    await new ObscuraClient('http://obscura.test/mcp', 't', ok).render('https://a.example/')
    const nav = sent.find((b) => b.params?.name === 'browser_navigate')
    expect(nav.params.arguments.waitUntil).toBe('load')
    const evaluate = sent.find((b) => b.params?.name === 'browser_evaluate')
    expect(evaluate.params.arguments.timeoutMs).toBeLessThanOrEqual(CRAWL_RENDER_TIMEOUT_MS)
    expect(evaluate.params.arguments.expression).toContain('setTimeout(resolve, 1500)')
  })

  test('Obscura being down is our trouble: the page is retried, the host never parked', async () => {
    const down = (async () => {
      throw Object.assign(new TypeError('ECONNREFUSED: Unable to connect.'), { code: 'ECONNREFUSED' })
    }) as unknown as typeof fetch
    const client = new ObscuraClient('http://obscura.test/mcp', 't', down)
    const { crawler, sites } = setup((url) => (url.endsWith('/robots.txt') ? text('') : page('')), { size: 1, render: (u) => client.render(u) })
    await expect(crawler.renderPage({ url: 'https://js.example/', site: 'js.example', depth: 0, rendered: true })).rejects.toBeInstanceOf(ObscuraError)
    expect(await sites.flagOf('js.example')).toBeNull()
  })

  test('a render timeout parks the page', async () => {
    const { crawler, frontier } = setup((url) => (url.endsWith('/robots.txt') ? text('') : page('')), { size: 1, render: (u) => Promise.reject(new RenderTimeout(u, 30_000)) })
    expect((await crawler.renderPage({ url: 'https://js.example/', site: 'js.example', depth: 0, rendered: true })).outcome).toBe('page parked: timeout')
    expect((await frontier.siteState('js.example', 'https://js.example/')).pageDown).toBe(true)
  })
})
