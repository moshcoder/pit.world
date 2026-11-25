/**
 * Addresses: which ones are worth a request, and which ones are the same page.
 *
 * The crawler runs on a box full of loopback services, so an address that
 * names (or resolves to) a private network is never fetched, at the first hop
 * or after any redirect.
 */
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Query parameters that only say where a click came from. */
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_[a-z]+|igshid|yclid|_hs[a-z]+|ref_src|spm)$/i

/** Paths that are never a page: media, archives, code, documents. */
const NOT_A_PAGE =
  /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp[34]|m4[av]|mov|avi|mkv|webm|ogg|wav|flac|aac|zip|gz|tgz|bz2|xz|7z|rar|tar|dmg|exe|msi|deb|rpm|apk|iso|bin|pdf|docx?|xlsx?|pptx?|odt|ods|csv|json|xml|rss|atom|txt|css|js|mjs|map|woff2?|ttf|otf|eot|wasm)$/i

/** Paths that are an endless calendar, a cart, a login or a search: crawler traps. */
const TRAP = /\/(?:wp-admin|wp-login|cart|checkout|login|logout|signin|signup|register|account|search)(?:\/|$)|[?&](?:replytocom|share|add-to-cart|sort|order|filter|sessionid|sid|PHPSESSID)=/i

/** The page an href stands for: absolute, http(s), no fragment, no tracking parameters. Null when it is not one. */
export function normalizeUrl(href: string, base?: string): string | null {
  let u: URL
  try {
    u = base ? new URL(href.trim(), base) : new URL(href.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  u.hash = ''
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '')
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = ''
  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key)
  if (!u.hostname.includes('.')) return null
  const out = u.toString()
  return out.length > 2000 ? null : out
}

/** A site is its host without www: www.example.com and example.com are one site. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** A bare host typed or pasted ("Example.com/", "https://example.com/x") as a site, or null. */
export function siteFromInput(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  const url = normalizeUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  if (!url) return null
  const site = siteOf(url)
  return isPublicHostname(site) ? site : null
}

export function sameSite(url: string, site: string): boolean {
  return siteOf(url) === site
}

/** Whether a URL is worth a page request at all: not media, not a trap. */
export function crawlable(url: string): boolean {
  try {
    const u = new URL(url)
    return !NOT_A_PAGE.test(u.pathname) && !TRAP.test(`${u.pathname}${u.search}`) && u.search.length < 200
  } catch {
    return false
  }
}

/** A short stable id for an address: BullMQ job ids and Redis set members. Never contains a colon. */
export function urlId(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 20)
}

/** Names that are private by their spelling, before any DNS. */
export function isPublicHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (!h || !h.includes('.') && !isIP(h)) return false
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|test|invalid|onion)$/.test(h)) return false
  if (isIP(h)) return isPublicAddress(h)
  return true
}

export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 192 && b === 0) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    return true
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase()
    if (v === '::' || v === '::1') return false
    if (v.startsWith('::ffff:')) return isPublicAddress(v.slice(7))
    if (/^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v)) return false
    return true
  }
  return false
}

export type Resolver = (host: string) => Promise<boolean>

/** Every address the name resolves to must be public; a name that resolves to none is not fetched. */
export const resolvesPublic: Resolver = async (host) => {
  if (!isPublicHostname(host)) return false
  if (isIP(host)) return isPublicAddress(host)
  try {
    const addresses = await lookup(host, { all: true })
    return addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address))
  } catch {
    return false
  }
}

/** Names that always resolve. When none of them does, it is the resolver that is broken. */
const CANARIES = ['example.com', 'cloudflare.com', 'wikipedia.org']

/**
 * Is DNS itself answering? `resolvesPublic` says false for a name with no address AND for a
 * resolver that is down, and the crawler parks a site with no address for 30 days: on
 * 2026-11-16, after a reboot left the container without DNS, 5.5 million sites were parked
 * in five hours, 91% of which resolved fine afterwards. Asked before anything is parked for
 * DNS. The answer is kept for `ttlMs`, and one check serves every caller waiting on it.
 */
export function resolverCheck(
  lookupImpl: (host: string) => Promise<unknown> = (host) => lookup(host),
  options: { names?: string[]; ttlMs?: number; timeoutMs?: number } = {},
): () => Promise<boolean> {
  const { names = CANARIES, ttlMs = 5_000, timeoutMs = 5_000 } = options
  let at = 0
  let up = true
  let pending: Promise<boolean> | null = null
  return () => {
    if (Date.now() - at < ttlMs) return Promise.resolve(up)
    let timer: ReturnType<typeof setTimeout> | undefined
    pending ??= Promise.race([
      Promise.any(names.map((name) => lookupImpl(name))).then(
        () => true,
        () => false,
      ),
      // A resolver that is down often does not refuse, it just never answers.
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
    ]).then((answer) => {
      clearTimeout(timer)
      up = answer
      at = Date.now()
      pending = null
      return answer
    })
    return pending
  }
}

/** Addresses that look like a product (or a product sitemap) on common shop software. */
export const PRODUCTISH = /product|\/p\/|\/dp\/|\/item[s]?\/|\/buy\//i

/** Product-looking addresses first, the rest after, each in its own order. */
export function productFirst(urls: string[]): string[] {
  return [...urls.filter((u) => PRODUCTISH.test(u)), ...urls.filter((u) => !PRODUCTISH.test(u))]
}
