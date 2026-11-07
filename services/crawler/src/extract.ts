/**
 * One HTML document read the way an index reads it: the OpenSite record
 * (logicsrc.com/opensite: the card a careful reader would draw, og/twitter
 * tags verbatim, JSON-LD), what the crawler learns on top of it (language,
 * keywords, an excerpt of the body text, word and link counts, a hash of the
 * text so an unchanged page is not written again), and the links to follow.
 *
 * Reading order per the spec: JSON-LD, then og:, then twitter:, then HTML.
 */
import { mcpCandidates } from './mcp.ts'
import { createHash } from 'node:crypto'
import { type HTMLElement, parse } from 'node-html-parser'
import { normalizeUrl, sameSite, siteOf } from './url.ts'

export type OpenSiteRecord = {
  opensite: '0.1'
  url: string
  canonical: string
  site: { name: string; web: string }
  kind: string
  title: string
  description: string | null
  image: { url: string; alt?: string } | null
  language: string | null
  author: { name: string } | null
  tags: string[]
  feeds: string[]
  published_at: string | null
  modified_at: string | null
  fetched_at: string
  status: 'live' | 'gone' | 'moved' | 'blocked'
  source: 'read'
  cards: { og: Record<string, string>; twitter: Record<string, string> }
  jsonld: unknown[]
}

/** An image a page shows: where it is and what it says, never the file itself. */
export type ImageRef = { url: string; alt: string; width: number | null; height: number | null }
/** A video a page plays or embeds: its address (a watch page when known), title and thumbnail. */
export type VideoRef = { url: string; title: string; thumbnail: string | null; provider: string | null }

export type Enrichment = {
  /** Whether the publisher left AI training open on this page (src/crawler.ts trainingFor); set when it is accepted. */
  training?: { allowed: boolean; reason: string }
  language: string | null
  keywords: string[]
  excerpt: string
  /** The price the page states, as a shop would write it. */
  price: string | null
  /** The page's main text, up to TEXT_MAX characters: what the local index searches. */
  text: string
  images: ImageRef[]
  videos: VideoRef[]
  words: number
  links: number
  hash: string
  rendered: boolean
  depth: number
  crawler: string
}

export type Extracted = {
  record: OpenSiteRecord
  enrichment: Enrichment
  /** Same-site links to follow (already normalized), unless nofollow. */
  internal: string[]
  /** Sites this page links to. */
  external: string[]
  /** Addresses on the page that look like MCP endpoints (src/mcp.ts); nothing is proved yet. */
  mcp: string[]
  noindex: boolean
  nofollow: boolean
  /** `noai` in meta robots (or a pitbot meta): no AI training on this page. */
  noai: boolean
  /** TDMRep in the page: <meta name="tdm-reservation" content="1">. */
  tdmReserved: boolean
  /** Visible text length, which decides whether the page needs a browser. */
  textLength: number
}

const KIND_BY_TYPE: Record<string, string> = {
  article: 'article',
  newsarticle: 'article',
  blogposting: 'article',
  techarticle: 'article',
  report: 'article',
  socialmediaposting: 'post',
  discussionforumposting: 'post',
  comment: 'post',
  qapage: 'post',
  question: 'post',
  product: 'product',
  offer: 'product',
  person: 'profile',
  profilepage: 'profile',
  organization: 'profile',
  localbusiness: 'profile',
  event: 'event',
  videoobject: 'video',
  'video.other': 'video',
  'video.movie': 'video',
  'video.episode': 'video',
  musicrecording: 'audio',
  'music.song': 'audio',
  podcastseries: 'podcast',
  podcastepisode: 'episode',
  website: 'site',
  profile: 'profile',
  book: 'product',
}

/** JSON-LD types that describe a page's own subject, as opposed to its publisher or its site. */
const CONTENT_TYPES = new Set([
  'socialmediaposting',
  'discussionforumposting',
  'qapage',
  'question',
  'article',
  'newsarticle',
  'blogposting',
  'techarticle',
  'report',
  'product',
  'event',
  'videoobject',
  'musicrecording',
  'podcastseries',
  'podcastepisode',
  'profilepage',
  'person',
  'book',
  'recipe',
  'course',
  'jobposting',
  'softwareapplication',
])

/** Small and deliberate: the words that say nothing about a page, English first since most of the web is. */
const STOP = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just let me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves
  www http https com org net html page pages home site website click here read more menu skip content main search privacy policy terms cookie cookies copyright rights reserved contact login sign log subscribe newsletter share email new get one use using used may like via per see us out all just can will also get got make made way back next previous view top bottom free
  de la le les des et en un une du pour que qui dans est sur pas plus par avec ce il au ou son sa ses der die das und ist nicht mit sich auf für von zu ein eine el los las del se por con para una al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros`.split(
    /\s+/,
  ),
)

export const TEXT_MAX = 10_000
const IMAGES_MAX = 20
const VIDEOS_MAX = 10

const clip = (value: string | null | undefined, max: number): string => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function metaMap(root: HTMLElement): { og: Record<string, string>; twitter: Record<string, string>; name: Record<string, string> } {
  const og: Record<string, string> = {}
  const twitter: Record<string, string> = {}
  const name: Record<string, string> = {}
  for (const m of root.querySelectorAll('meta')) {
    const key = (m.getAttribute('property') ?? m.getAttribute('name') ?? '').trim().toLowerCase()
    const content = m.getAttribute('content')
    if (!key || content == null) continue
    const value = clip(content, 2000)
    if (key.startsWith('og:') || key.startsWith('article:')) og[key] ??= value
    else if (key.startsWith('twitter:')) twitter[key] ??= value
    else name[key] ??= value
  }
  return { og, twitter, name }
}

function jsonLdOf(root: HTMLElement): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(s.rawText.trim())
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [parsed]
      for (const entry of list) if (entry && typeof entry === 'object') out.push(entry)
    } catch {
      // A broken block is somebody else's bug; the page still has its tags.
    }
    if (out.length >= 8) break
  }
  return out
}

const typesOf = (entry: Record<string, unknown>): string[] =>
  ([] as unknown[]).concat(entry['@type'] ?? []).map((t) => String(t).toLowerCase())

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function dateOf(value: string | null): string | null {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** The words that best say what a page is about: frequency, title words counted thrice, no stopwords, no numbers. */
export function keywordsOf(title: string, text: string, max = 12): string[] {
  const counts = new Map<string, number>()
  const add = (source: string, weight: number) => {
    for (const raw of source.toLowerCase().match(/\p{L}[\p{L}\p{M}'’-]{2,29}/gu) ?? []) {
      const word = raw.replace(/['’-]+$/g, '')
      if (word.length < 3 || STOP.has(word)) continue
      counts.set(word, (counts.get(word) ?? 0) + weight)
    }
  }
  add(title, 3)
  add(text.slice(0, 50_000), 1)
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([w]) => w)
}

/** The language a page declares, as a short tag (en, pt-br), or null. */
function languageOf(root: HTMLElement, metas: ReturnType<typeof metaMap>): string | null {
  const declared =
    root.querySelector('html')?.getAttribute('lang') ?? metas.name['content-language'] ?? metas.og['og:locale'] ?? ''
  const tag = declared.trim().toLowerCase().replace('_', '-')
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(tag) ? tag : null
}

const intOrNull = (v: string | undefined | null): number | null => {
  const n = Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** YouTube and Vimeo players as their watch pages; anything else as it is. */
export function videoRefOf(raw: string, base: string): { url: string; provider: string | null; thumbnail: string | null } | null {
  const url = normalizeUrl(raw, base)
  if (!url) return null
  const u = new URL(url)
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '')
  let id: string | null = null
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/)?.[1] ?? (u.pathname === '/watch' ? u.searchParams.get('v') : null)
  } else if (host === 'youtu.be') id = u.pathname.slice(1, 12) || null
  if (id && /^[\w-]{11}$/.test(id)) return { url: `https://www.youtube.com/watch?v=${id}`, provider: 'youtube', thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }
  if (host === 'player.vimeo.com' || host === 'vimeo.com') {
    const vid = u.pathname.match(/(?:\/video)?\/(\d{5,})/)?.[1]
    if (vid) return { url: `https://vimeo.com/${vid}`, provider: 'vimeo', thumbnail: null }
  }
  if (/\.(mp4|webm|m3u8|mov|ogv)($|\?)/i.test(u.pathname + u.search)) return { url, provider: null, thumbnail: null }
  if (host.endsWith('dailymotion.com') || host.endsWith('twitch.tv') || host.endsWith('loom.com') || host.endsWith('wistia.com') || host.endsWith('rumble.com')) return { url, provider: host.split('.').slice(-2, -1)[0] ?? null, thumbnail: null }
  return null
}

/** Images and videos a page shows, as references. Read before the text pass, which drops iframes. */
const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' }
const priced = (amount: unknown, currency: unknown): string | null => {
  const value = typeof amount === 'number' ? String(amount) : typeof amount === 'string' ? amount.trim() : ''
  if (!/^\d[\d,]*(\.\d+)?$/.test(value) || Number(value.replace(/,/g, '')) <= 0) return null
  const code = typeof currency === 'string' ? currency.trim().toUpperCase().slice(0, 3) : ''
  return SYMBOLS[code] ? `${SYMBOLS[code]}${value}` : code ? `${code} ${value}` : `$${value}`
}

/** The price a product page states: Open Graph first, then JSON-LD offers. Null when it states none. */
export function priceOf(og: Record<string, string>, jsonld: unknown[]): string | null {
  const fromOg = priced(og['product:price:amount'] ?? og['og:price:amount'], og['product:price:currency'] ?? og['og:price:currency'])
  if (fromOg) return fromOg
  const nodes = jsonld.flatMap((e: any) => (Array.isArray(e?.['@graph']) ? e['@graph'] : [e]))
  for (const node of nodes) {
    const offers: any[] = [node?.offers].flat().filter(Boolean)
    for (const offer of offers) {
      const found = priced(offer?.price ?? offer?.lowPrice, offer?.priceCurrency)
      if (found) return found
    }
  }
  return null
}

export function mediaOf(root: HTMLElement, url: string, metas: { og: Record<string, string>; twitter: Record<string, string> }, jsonld: Array<Record<string, unknown>>): { images: ImageRef[]; videos: VideoRef[] } {
  const images = new Map<string, ImageRef>()
  const addImage = (raw: string | undefined | null, alt: string, width: number | null, height: number | null) => {
    if (!raw || images.size >= IMAGES_MAX || /^data:/i.test(raw.trim())) return
    const src = normalizeUrl(raw.trim().split(/\s+/)[0] ?? '', url)
    if (!src || images.has(src)) return
    // Pixels, spacers and icons are not content.
    if ((width !== null && width < 64) || (height !== null && height < 64)) return
    if (/(?:pixel|spacer|blank|tracking|1x1|favicon|sprite)[^/]*$/i.test(new URL(src).pathname)) return
    images.set(src, { url: src, alt: clip(alt, 300), width, height })
  }
  const og = metas.og['og:image'] ?? metas.og['og:image:url'] ?? metas.twitter['twitter:image']
  if (og) addImage(og, metas.og['og:image:alt'] ?? '', intOrNull(metas.og['og:image:width']), intOrNull(metas.og['og:image:height']))
  for (const img of root.querySelectorAll('img')) {
    const raw = img.getAttribute('src') ?? img.getAttribute('data-src') ?? img.getAttribute('data-lazy-src') ?? img.getAttribute('srcset') ?? img.getAttribute('data-srcset')
    addImage(raw, img.getAttribute('alt') ?? img.getAttribute('title') ?? '', intOrNull(img.getAttribute('width')), intOrNull(img.getAttribute('height')))
  }

  const videos = new Map<string, VideoRef>()
  const addVideo = (raw: string | undefined | null, title: string, thumb: string | null = null) => {
    if (!raw || videos.size >= VIDEOS_MAX) return
    const ref = videoRefOf(raw.trim(), url)
    if (!ref || videos.has(ref.url)) return
    const thumbnail = ref.thumbnail ?? (thumb ? normalizeUrl(thumb, url) : null)
    videos.set(ref.url, { url: ref.url, title: clip(title, 300), thumbnail, provider: ref.provider })
  }
  for (const e of jsonld) {
    if (!typesOf(e).includes('videoobject')) continue
    const thumb = ([] as unknown[]).concat(e.thumbnailUrl ?? []).map(String)[0] ?? null
    addVideo(str(e.contentUrl) ?? str(e.embedUrl), str(e.name) ?? '', thumb)
  }
  addVideo(metas.og['og:video:secure_url'] ?? metas.og['og:video:url'] ?? metas.og['og:video'] ?? metas.twitter['twitter:player'], metas.og['og:title'] ?? '', og ?? null)
  const pageTitle = root.querySelector('title')?.textContent ?? ''
  for (const f of root.querySelectorAll('iframe')) addVideo(f.getAttribute('src') ?? f.getAttribute('data-src'), f.getAttribute('title') ?? pageTitle)
  for (const v of root.querySelectorAll('video')) {
    const src = v.getAttribute('src') ?? v.querySelector('source')?.getAttribute('src')
    addVideo(src, v.getAttribute('title') ?? v.getAttribute('aria-label') ?? pageTitle, v.getAttribute('poster'))
  }
  for (const a of root.querySelectorAll('a[href]')) {
    if (videos.size >= VIDEOS_MAX) break
    const href = a.getAttribute('href') ?? ''
    if (/youtu\.?be|vimeo\.com\/\d/.test(href)) addVideo(href, a.textContent ?? '')
  }
  return { images: [...images.values()], videos: [...videos.values()] }
}

function visibleText(root: HTMLElement): { all: string; main: string } {
  const body = root.querySelector('body') ?? root
  for (const el of body.querySelectorAll('script, style, noscript, template, svg, iframe')) el.remove()
  const main = body.querySelector('main, article, [role="main"]')
  const chrome = (el: HTMLElement) => {
    const copy = parse(el.outerHTML)
    for (const c of copy.querySelectorAll('nav, header, footer, aside, form, [role="navigation"], [aria-hidden="true"]')) c.remove()
    return copy.structuredText
  }
  const all = body.structuredText.replace(/\s+/g, ' ').trim()
  const focused = (main ? chrome(main) : chrome(body)).replace(/\s+/g, ' ').trim()
  return { all, main: focused || all }
}

export function extract(
  html: string,
  url: string,
  options: { fetchedAt?: Date; rendered?: boolean; depth?: number; crawler?: string } = {},
): Extracted {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true, pre: true } })
  const metas = metaMap(root)
  const jsonld = jsonLdOf(root)
  const site = siteOf(url)
  const origin = (() => {
    try {
      return new URL(url).origin
    } catch {
      return ''
    }
  })()

  // Canonical: only one on the same site counts, or a page could claim another site's address.
  const canonicalHref = root.querySelector('link[rel~="canonical"]')?.getAttribute('href')
  const canonicalUrl = canonicalHref ? normalizeUrl(canonicalHref, url) : null
  const canonical = canonicalUrl && sameSite(canonicalUrl, site) ? canonicalUrl : url

  // JSON-LD speaks for the page only when it describes the page's own content. The
  // publisher's Organization, the WebSite and the breadcrumbs ride on every page of a
  // site; taking their name as the title would title every page after the company.
  const ld: Record<string, unknown> = jsonld.find((e) => typesOf(e).some((t) => CONTENT_TYPES.has(t))) ?? {}
  const ldType = typesOf(ld).find((t) => KIND_BY_TYPE[t])
  const ogType = (metas.og['og:type'] ?? '').toLowerCase()
  const root_ = new URL(canonical).pathname === '/'
  const declared = (ldType && KIND_BY_TYPE[ldType]) || KIND_BY_TYPE[ogType] || null
  // og:type=website rides on every page of most sites: only the home page is the site.
  const kind = declared && declared !== 'site' ? declared : root_ ? 'site' : 'page'

  const htmlTitle = root.querySelector('title')?.textContent ?? ''
  const h1 = root.querySelector('h1')?.textContent ?? ''
  const title = clip(str(ld.headline) ?? str(ld.name) ?? metas.og['og:title'] ?? metas.twitter['twitter:title'] ?? (htmlTitle || h1), 300)
  const description =
    clip(str(ld.description) ?? metas.og['og:description'] ?? metas.twitter['twitter:description'] ?? metas.name.description ?? '', 1000) || null

  const imageRaw = metas.og['og:image'] ?? metas.og['og:image:url'] ?? metas.twitter['twitter:image'] ?? null
  const imageUrl = imageRaw ? normalizeUrl(imageRaw, url) : null
  const authorName = (() => {
    const a = ld.author as unknown
    const first = Array.isArray(a) ? a[0] : a
    if (first && typeof first === 'object') return str((first as Record<string, unknown>).name)
    return str(first) ?? metas.name.author ?? null
  })()

  const robotsMeta = `${metas.name.robots ?? ''} ${metas.name[`pitbot`] ?? ''}`.toLowerCase()
  const noindex = /\bnoindex\b|\bnone\b/.test(robotsMeta)
  const nofollow = /\bnofollow\b|\bnone\b/.test(robotsMeta)
  const noai = /(^|[\s,;:])noai\b/.test(robotsMeta)
  const tdmMeta = (metas.name['tdm-reservation'] ?? '').trim() === '1'

  const feeds = root
    .querySelectorAll('link[rel~="alternate"]')
    .filter((l) => /rss|atom|feed\+json/i.test(l.getAttribute('type') ?? ''))
    .map((l) => normalizeUrl(l.getAttribute('href') ?? '', url))
    .filter((u): u is string => Boolean(u))
    .slice(0, 5)

  const internal = new Set<string>()
  const external = new Set<string>()
  let linkCount = 0
  for (const a of root.querySelectorAll('a[href]')) {
    linkCount++
    if (/\bnofollow\b|\bsponsored\b|\bugc\b/i.test(a.getAttribute('rel') ?? '')) continue
    const href = normalizeUrl(a.getAttribute('href') ?? '', url)
    if (!href) continue
    if (sameSite(href, site)) internal.add(href)
    else {
      const other = siteOf(href)
      if (other) external.add(other)
    }
  }

  const language = languageOf(root, metas)
  const media = mediaOf(root, url, metas, jsonld)
  const { all, main } = visibleText(root)
  const words = main ? main.split(/\s+/).length : 0
  const keywords = keywordsOf(title, main)
  const fetchedAt = (options.fetchedAt ?? new Date()).toISOString()

  const record: OpenSiteRecord = {
    opensite: '0.1',
    url,
    canonical,
    site: { name: clip(metas.og['og:site_name'] ?? site, 120) || site, web: origin },
    kind,
    title: title || site,
    description,
    image: imageUrl ? { url: imageUrl, ...(metas.og['og:image:alt'] ? { alt: clip(metas.og['og:image:alt'], 300) } : {}) } : null,
    language,
    author: authorName ? { name: clip(authorName, 120) } : null,
    tags: keywords.slice(0, 8),
    feeds,
    published_at: dateOf(str(ld.datePublished) ?? metas.og['article:published_time'] ?? null),
    modified_at: dateOf(str(ld.dateModified) ?? metas.og['article:modified_time'] ?? metas.og['og:updated_time'] ?? null),
    fetched_at: fetchedAt,
    status: 'live',
    source: 'read',
    cards: { og: metas.og, twitter: metas.twitter },
    jsonld: jsonld.slice(0, 5),
  }

  return {
    record,
    enrichment: {
      language,
      keywords,
      excerpt: clip(main, 1000),
      price: priceOf(metas.og, jsonld),
      text: main.length > TEXT_MAX ? main.slice(0, TEXT_MAX) : main,
      images: media.images,
      videos: media.videos,
      words,
      links: linkCount,
      hash: createHash('sha1').update(`${title}\n${description ?? ''}\n${main}`).digest('hex'),
      rendered: options.rendered === true,
      depth: options.depth ?? 0,
      crawler: options.crawler ?? 'pitbot',
    },
    internal: nofollow ? [] : [...internal],
    external: nofollow ? [] : [...external],
    mcp: nofollow ? [] : mcpCandidates(html),
    noindex,
    nofollow,
    noai,
    tdmReserved: tdmMeta,
    textLength: all.length,
  }
}

/**
 * Whether the HTML is a shell a browser fills in: next to no text, and the
 * tell-tales of a client-rendered app (an empty mount point, a bundle, a
 * noscript asking for JavaScript). A server-rendered page with little text
 * (a landing page) is left alone.
 */
export function needsRender(html: string, textLength: number): boolean {
  if (textLength > 600) return false
  const mount = /<div[^>]+id=["'](?:root|app|__next|__nuxt|svelte|main-app|q-app)["'][^>]*>\s*<\/div>/i.test(html)
  const asksForJs = /<noscript[^>]*>[^<]*(?:enable|requires?|need)[^<]*javascript/i.test(html)
  const bundles = (html.match(/<script[^>]+src=/gi) ?? []).length
  return mount || asksForJs || (textLength < 200 && bundles >= 2)
}
