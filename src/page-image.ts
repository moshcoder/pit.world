/**
 * The picture a result's own page advertises, for rows whose index sent none: most feeds and the web
 * tab carry no image, yet nearly every page names one for link previews (og:image, twitter:image).
 *
 * The visitor never touches that site. pit.world reads the top of the page and hands the picture to /img,
 * so the publisher sees our server, once per page per day, and neither the search nor the visitor.
 */
import { isPublicPageUrl } from './summarize.js'

type Resolve = (host: string) => Promise<string[]>

const TTL_MS = 24 * 3600_000
const MISS_TTL_MS = 6 * 3600_000
const MAX_ENTRIES = 5_000
/** A results page asks for up to twenty at once: enough to fill one, not enough to be a crawler. */
const MAX_READS = 8
/** The tags live in <head>; a page that has not closed it by here is not going to help. */
const MAX_BYTES = 256_000
/** Preference order. secure_url first: it is the https spelling of og:image when a page offers both. */
const WANTED = ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src']

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", '#39': "'", '#x27': "'", lt: '<', gt: '>' }

function attr(tag: string, name: string): string {
  const found = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return (found?.[1] ?? found?.[2] ?? found?.[3] ?? '').replace(/&(amp|quot|apos|#39|#x27|lt|gt);/gi, (_, n: string) => ENTITIES[n.toLowerCase()]!).trim()
}

/** The best preview picture in a page's HTML as an absolute https address, or null. */
export function pagePicture(html: string, base: string): string | null {
  const head = html.slice(0, (html.search(/<\/head\s*>/i) + 1 || html.length + 1) - 1)
  const found = new Map<string, string>()
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(tag, 'property') || attr(tag, 'name')).toLowerCase()
    const value = attr(tag, 'content')
    if (value && WANTED.includes(key) && !found.has(key)) found.set(key, value)
  }
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    if (attr(tag, 'rel').toLowerCase() === 'image_src' && attr(tag, 'href') && !found.has('image_src')) found.set('image_src', attr(tag, 'href'))
  }
  for (const key of [...WANTED, 'image_src']) {
    const value = found.get(key)
    if (!value) continue
    try {
      const url = new URL(value, base)
      // /img only passes https: a page's http:// picture is often the same file on https, so ask for that.
      if (url.protocol === 'http:') url.protocol = 'https:'
      if (url.protocol === 'https:') return url.href
    } catch {}
  }
  return null
}

/** Reads and remembers pages' pictures. In RAM only, keyed by page address, gone on restart. */
export class PageImages {
  private found = new Map<string, { at: number; image: string | null }>()
  private reading = new Map<string, Promise<string | null>>()

  constructor(private options: { fetch?: typeof fetch; resolve?: Resolve } = {}) {}

  async find(page: string): Promise<string | null> {
    const known = this.found.get(page)
    if (known && Date.now() - known.at < (known.image ? TTL_MS : MISS_TTL_MS)) return known.image
    const running = this.reading.get(page)
    if (running) return running
    // Busy is not a miss: remember nothing, so the next person gets the picture.
    if (this.reading.size >= MAX_READS) return null
    const read = this.read(page).finally(() => this.reading.delete(page))
    this.reading.set(page, read)
    const image = await read
    if (this.found.size >= MAX_ENTRIES) this.found.delete(this.found.keys().next().value!)
    this.found.delete(page)
    this.found.set(page, { at: Date.now(), image })
    return image
  }

  private async read(page: string): Promise<string | null> {
    try {
      let url = new URL(page)
      for (let hop = 0; hop < 4; hop++) {
        if (!(await isPublicPageUrl(url, this.options.resolve))) return null
        // threatcrush-disable-next-line js-ssrf-outbound-request  only a signed URL pit.world itself put on a results page, every hop resolved and checked public above
        const response: Response = await (this.options.fetch ?? fetch)(url.href, {
          redirect: 'manual',
          signal: AbortSignal.timeout(5_000),
          headers: { accept: 'text/html', 'user-agent': 'pit.world image proxy (https://pit.world/privacy)' },
        })
        const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
        if (location) {
          url = new URL(location, url)
          continue
        }
        if (!response.ok || !/html/i.test(response.headers.get('content-type') ?? '')) return null
        const reader = response.body?.getReader()
        if (!reader) return null
        const decoder = new TextDecoder()
        let html = ''
        while (html.length < MAX_BYTES && !/<\/head\s*>/i.test(html)) {
          const { done, value } = await reader.read()
          if (done) break
          html += decoder.decode(value, { stream: true })
        }
        reader.cancel().catch(() => {})
        return pagePicture(html, url.href)
      }
    } catch {}
    return null
  }
}
