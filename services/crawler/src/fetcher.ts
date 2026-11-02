/**
 * One polite GET: a named user agent, a timeout, a size cap, and redirects
 * followed by hand so every hop is checked against the private-network guard.
 */
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
}

type Fetch = typeof fetch

export const MAX_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5

async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
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
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = new URL(current).hostname
    if (!(await options.resolver(host))) throw new Error(`refused: ${host} is not on the public internet`)
    const response = await fetchImpl(current, {
      redirect: 'manual',
      headers: {
        'user-agent': options.userAgent,
        accept: options.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'accept-language': 'en;q=1, *;q=0.5',
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
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
    const body = textual ? await readCapped(response, options.maxBytes ?? MAX_BYTES) : ''
    if (!textual) await response.body?.cancel().catch(() => {})
    return { url, finalUrl: current, status: response.status, contentType, body }
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
