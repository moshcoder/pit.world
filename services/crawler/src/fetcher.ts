/**
 * One polite GET: a named user agent, a timeout, a size cap, and redirects
 * followed by hand so every hop is checked against the private-network guard.
 *
 * The timeout is one budget for the whole GET (CRAWL_FETCH_TIMEOUT_MS, 10 s): the name
 * lookup, every redirect hop and the body. It used to be 20 s per hop, so five redirects
 * could hold a worker for over a minute and a slow body was never cut off.
 */
import { CRAWL_FETCH_TIMEOUT_MS } from './config.ts'
import { normalizeUrl, type Resolver } from './url.ts'

export type Fetched = {
  url: string
  /** Where the redirects ended. */
  finalUrl: string
  status: number
  contentType: string
  body: string
  /** Redirected to another site: not read, handed back so that site can be crawled instead. */
  offsite?: string
  /** The page's own opt-out headers (X-Robots-Tag, TDMRep's tdm-reservation), lowercased. */
  optOut?: { robotsTag: string; tdmReservation: string }
  /** Retry-After, as sent (a 429 or 503 may carry one). */
  retryAfter?: string
}

type Fetch = typeof fetch

export const MAX_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5

/** Reject when the signal fires, whatever `work` is waiting on (a name lookup has no signal of its own). */
export function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (v) => {
        signal.removeEventListener('abort', abort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', abort)
        reject(e)
      },
    )
  })
}

export async function readCapped(response: Response, max: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    // A body that trickles in past the budget is a failure, not a short page.
    const { done, value } = signal ? await withSignal(reader.read(), signal).catch(async (error) => {
      await reader.cancel().catch(() => {})
      throw error
    }) : await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      chunks.push(value.subarray(0, value.byteLength - (size - max)))
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks))
}

export async function politeGet(
  url: string,
  options: { userAgent: string; resolver: Resolver; fetch?: Fetch; timeoutMs?: number; accept?: string; site?: string; maxBytes?: number },
): Promise<Fetched> {
  const fetchImpl = options.fetch ?? fetch
  const signal = AbortSignal.timeout(options.timeoutMs ?? CRAWL_FETCH_TIMEOUT_MS)
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = new URL(current).hostname
    if (!(await withSignal(options.resolver(host), signal))) throw new Error(`refused: ${host} is not on the public internet`)
    const response = await fetchImpl(current, {
      redirect: 'manual',
      headers: {
        'user-agent': options.userAgent,
        accept: options.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'accept-language': 'en;q=1, *;q=0.5',
      },
      signal,
    })
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel().catch(() => {})
      const next = normalizeUrl(response.headers.get('location')!, current)
      if (!next) throw new Error('redirect to an address that is not a web page')
      const nextSite = new URL(next).hostname.replace(/^www\./, '')
      if (options.site && nextSite !== options.site) {
        return { url, finalUrl: next, status: response.status, contentType: '', body: '', offsite: nextSite }
      }
      current = next
      continue
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    const textual = /text\/|html|xml|json/.test(contentType) || contentType === ''
    const body = textual ? await readCapped(response, options.maxBytes ?? MAX_BYTES, signal) : ''
    if (!textual) await response.body?.cancel().catch(() => {})
    const optOut = { robotsTag: (response.headers.get('x-robots-tag') ?? '').toLowerCase(), tdmReservation: (response.headers.get('tdm-reservation') ?? '').trim() }
    const retryAfter = response.headers.get('retry-after')
    return { url, finalUrl: current, status: response.status, contentType, body, optOut, ...(retryAfter ? { retryAfter } : {}) }
  }
  throw new Error('too many redirects')
}

/** Page addresses a sitemap (or sitemap index) lists: { urls, sitemaps }. Plain <loc> reading, gzip not handled. */
export function readSitemapXml(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs = (tag: string) =>
    [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<loc>\\s*(?:<!\\[CDATA\\[)?([^<\\]]+?)(?:\\]\\]>)?\\s*</loc>`, 'gi'))].map((m) =>
      (m[1] ?? '').replace(/&amp;/g, '&').trim(),
    )
  return { urls: locs('url'), sitemaps: locs('sitemap') }
}
