/**
 * The tabs above the results: All (the web search in search.ts), Images,
 * Videos, Music, Live, Shopping, News, Books, Podcasts, Blogs, Places and
 * Scholar. Images, videos, shopping, news, places and scholar come from Google
 * through Serper's own endpoints; Music is a web search kept to music sites;
 * Live is a video search for streams. Scholar falls back to OpenAlex (free, no
 * key). Our own directories answer where we have
 * one: Blogs from rssamplifier.com, Podcasts from p0dcasters.com. Books come
 * from Open Library (free, no key). News falls back to rssamplifier.com's
 * newsrooms when Google is not configured or does not answer. Every one is
 * asked by pit.world, never by the visitor's browser. Our own live and
 * on-demand video (promoted.ts) sits on top of Videos, Music and Live.
 */
import { Cache, normalizeQuery, SearchUnavailable, type Keys } from './search.js'

type Fetch = typeof fetch

export type Vertical = 'web' | 'images' | 'videos' | 'music' | 'live' | 'shopping' | 'news' | 'books' | 'podcasts' | 'blogs' | 'places' | 'scholar'

export const VERTICALS: Array<{ id: Vertical; label: string }> = [
  { id: 'web', label: 'All' },
  { id: 'images', label: 'Images' },
  { id: 'videos', label: 'Videos' },
  { id: 'music', label: 'Music' },
  { id: 'live', label: 'Live' },
  { id: 'shopping', label: 'Shopping' },
  { id: 'news', label: 'News' },
  { id: 'books', label: 'Books' },
  { id: 'podcasts', label: 'Podcasts' },
  { id: 'blogs', label: 'Blogs' },
  { id: 'places', label: 'Places' },
  { id: 'scholar', label: 'Scholar' },
]

/** The tabs only Google answers (through Serper); without a Serper key they say so instead of guessing. */
const SERPER_ONLY: Vertical[] = ['images', 'videos', 'music', 'live', 'shopping', 'places']

type SerperVertical = Exclude<Vertical, 'web' | 'books' | 'podcasts' | 'blogs'>

export function parseVertical(value: string | undefined | null): Vertical {
  return VERTICALS.some((v) => v.id === value) ? (value as Vertical) : 'web'
}

/** A picture, a video, a product, a book, a show, a post or a place. `thumbnail` is a URL we may fetch for the visitor (see /img), or a data: URI. */
export type Media = {
  url: string
  title: string
  host: string
  thumbnail?: string
  description?: string
  duration?: string
  date?: string
  channel?: string
  width?: number
  height?: number
  /** Shopping: as the shop wrote it, "$12.99". */
  price?: string
  rating?: number
  reviews?: number
  /** Books: the authors; podcasts: who makes it; scholar: where it was published. */
  author?: string
  /** Places: the street address. */
  address?: string
  /** One more short fact: "41 episodes · weekly", "35 editions", "Cited by 120". */
  extra?: string
}

export type MediaProvider = 'serper' | 'rssamplifier' | 'p0dcasters' | 'openlibrary' | 'openalex'

export type MediaResult = {
  query: string
  vertical: Exclude<Vertical, 'web'>
  provider: MediaProvider
  hits: Media[]
  /** Blogs: the blogs themselves (their rssamplifier.com pages), beside the posts in `hits`. */
  sites?: Media[]
  cached: boolean
}

/** Where each provider's results come from, as the page says it. */
export const MEDIA_SOURCES: Record<MediaProvider, string> = {
  serper: 'the Google index',
  rssamplifier: 'the RSS Amplifier directory (rssamplifier.com)',
  p0dcasters: 'the p0dcasters.com directory',
  openlibrary: 'Open Library',
  openalex: 'OpenAlex',
}

export const MUSIC_SITES = ['bandcamp.com', 'soundcloud.com', 'open.spotify.com', 'music.apple.com', 'music.youtube.com', 'audiomack.com', 'mixcloud.com']

/**
 * Thumbnail hosts /img will fetch on a visitor's behalf. A fixed list, so the
 * proxy can't be pointed anywhere else (no internal addresses, no open relay).
 */
const THUMB_HOSTS = [
  /^encrypted-tbn\d\.gstatic\.com$/,
  /^i\.ytimg\.com$/,
  /^i\d?\.vimeocdn\.com$/,
  /^i\.vimeocdn\.com$/,
  /^tbn\d\.gstatic\.com$/,
  // Open Library covers: covers.openlibrary.org redirects to archive.org, which redirects to an ia<N> node.
  /^covers\.openlibrary\.org$/,
  /^archive\.org$/,
  /^ia\d+\.us\.archive\.org$/,
]

export function thumbAllowed(raw: string): URL | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null
    return THUMB_HOSTS.some((re) => re.test(url.hostname)) ? url : null
  } catch {
    return null
  }
}

/** How a thumbnail is put on the page: inline when it already is data, via /img when allowed, otherwise not at all. */
export function thumbSrc(raw: string | undefined): string | null {
  if (!raw) return null
  if (/^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(raw) && raw.length < 64_000) return raw
  return thumbAllowed(raw) ? `/img?u=${encodeURIComponent(raw)}` : null
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}/.test(str(v)) ? str(v).slice(0, 10) : str(v) || undefined)
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
const httpUrl = (v: unknown) => (/^https?:\/\//i.test(str(v)) ? str(v) : '')

/** rssamplifier.com hands back feed titles as the feed wrote them, entities and all; the page escapes on output. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, name: string) => {
    const n = name.toLowerCase()
    if (n.startsWith('#x')) return safeChar(parseInt(n.slice(2), 16), whole)
    if (n.startsWith('#')) return safeChar(parseInt(n.slice(1), 10), whole)
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[n] ?? whole
  })
}

function safeChar(code: number, fallback: string): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback
}

export function parseSerperImages(body: any): Media[] {
  const rows: any[] = Array.isArray(body?.images) ? body.images : []
  return rows.flatMap((r) => {
    const url = httpUrl(r?.link)
    if (!url) return []
    return [
      {
        url,
        title: str(r?.title) || host(url),
        host: str(r?.domain) || host(url),
        thumbnail: str(r?.thumbnailUrl) || undefined,
        width: typeof r?.imageWidth === 'number' ? r.imageWidth : undefined,
        height: typeof r?.imageHeight === 'number' ? r.imageHeight : undefined,
      },
    ]
  })
}

export function parseSerperVideos(body: any): Media[] {
  const rows: any[] = Array.isArray(body?.videos) ? body.videos : []
  return rows.flatMap((r) => {
    const url = httpUrl(r?.link)
    if (!url) return []
    return [
      {
        url,
        title: str(r?.title) || host(url),
        host: str(r?.source) || host(url),
        thumbnail: str(r?.imageUrl) || undefined,
        description: str(r?.snippet) || undefined,
        duration: str(r?.duration) || undefined,
        date: str(r?.date) || undefined,
        channel: str(r?.channel) || undefined,
      },
    ]
  })
}

export function parseSerperWeb(body: any): Media[] {
  const rows: any[] = Array.isArray(body?.organic) ? body.organic : []
  return rows.flatMap((r) => {
    const url = httpUrl(r?.link)
    if (!url) return []
    return [{ url, title: str(r?.title) || host(url), host: host(url), description: str(r?.snippet) || undefined, date: str(r?.date) || undefined }]
  })
}

export function parseSerperShopping(body: any): Media[] {
  const rows: any[] = Array.isArray(body?.shopping) ? body.shopping : []
  return rows.flatMap((r) => {
    const url = httpUrl(r?.link)
    if (!url) return []
    return [
      {
        url,
        title: str(r?.title) || host(url),
        host: str(r?.source) || host(url),
        thumbnail: str(r?.imageUrl) || undefined,
        price: str(r?.price) || undefined,
        rating: num(r?.rating),
        reviews: num(r?.ratingCount),
        extra: str(r?.delivery) || undefined,
      },
    ]
  })
}

export function parseSerperNews(body: any): Media[] {
  const rows: any[] = Array.isArray(body?.news) ? body.news : []
  return rows.flatMap((r) => {
    const url = httpUrl(r?.link)
    if (!url) return []
    return [
      {
        url,
        title: str(r?.title) || host(url),
        host: host(url),
        thumbnail: str(r?.imageUrl) || undefined,
        description: str(r?.snippet) || undefined,
        date: str(r?.date) || undefined,
        channel: str(r?.source) || undefined,
      },
    ]
  })
}

/** A place links to its own site, else to OpenStreetMap at its pin, never to a Google Maps page. */
export function parseSerperPlaces(body: any): Media[] {
  const rows: any[] = Array.isArray(body?.places) ? body.places : []
  return rows.flatMap((r) => {
    const lat = num(r?.latitude)
    const lon = num(r?.longitude)
    const site = httpUrl(r?.website)
    const osm = lat !== undefined && lon !== undefined ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}` : ''
    const url = site || osm
    const title = str(r?.title)
    if (!url || !title) return []
    return [
      {
        url,
        title,
        host: site ? host(url) : 'openstreetmap.org',
        address: str(r?.address) || undefined,
        channel: str(r?.category) || undefined,
        rating: num(r?.rating),
        reviews: num(r?.ratingCount),
        extra: str(r?.phoneNumber) || undefined,
      },
    ]
  })
}

export function parseSerperScholar(body: any): Media[] {
  const rows: any[] = Array.isArray(body?.organic) ? body.organic : []
  return rows.flatMap((r) => {
    const url = httpUrl(r?.link) || httpUrl(r?.pdfUrl)
    if (!url) return []
    const cited = num(r?.citedBy)
    return [
      {
        url,
        title: str(r?.title) || host(url),
        host: host(url),
        description: str(r?.snippet) || undefined,
        author: str(r?.publicationInfo) || undefined,
        date: num(r?.year) || str(r?.year) ? String(r.year) : undefined,
        extra: cited ? `Cited by ${cited.toLocaleString('en-US')}` : undefined,
      },
    ]
  })
}

/** OpenAlex /works (free, no key): Scholar when Google is not configured or does not answer. */
export function parseOpenAlex(body: any): Media[] {
  const rows: any[] = Array.isArray(body?.results) ? body.results : []
  return rows.flatMap((w) => {
    const url = httpUrl(w?.doi) || httpUrl(w?.primary_location?.landing_page_url) || httpUrl(w?.id)
    const title = str(w?.display_name)
    if (!url || !title) return []
    const authors: string[] = Array.isArray(w?.authorships) ? w.authorships.map((a: any) => str(a?.author?.display_name)).filter(Boolean) : []
    const venue = str(w?.primary_location?.source?.display_name)
    const cited = num(w?.cited_by_count)
    const year = num(w?.publication_year)
    return [
      {
        url,
        title,
        host: host(url),
        description: abstract(w?.abstract_inverted_index) || undefined,
        author: [authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''), venue].filter(Boolean).join(' - ') || undefined,
        date: year ? String(year) : undefined,
        extra: cited ? `Cited by ${cited.toLocaleString('en-US')}` : undefined,
      },
    ]
  })
}

/** OpenAlex ships an abstract as { word: [positions] }; the first forty words are plenty for a snippet. */
function abstract(index: unknown): string {
  if (!index || typeof index !== 'object') return ''
  const words: string[] = []
  let longer = false
  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue
    for (const p of positions) {
      if (typeof p !== 'number' || p < 0) continue
      if (p < 40) words[p] = word
      else longer = true
    }
  }
  const text = words.filter(Boolean).join(' ')
  return text ? `${text}${longer ? '…' : ''}` : ''
}

/** Open Library's search.json: one row per work. Covers go through /img like every other picture. */
export function parseOpenLibrary(body: any): Media[] {
  const docs: any[] = Array.isArray(body?.docs) ? body.docs : []
  return docs.flatMap((d) => {
    const key = str(d?.key)
    const title = str(d?.title)
    if (!/^\/works\/OL\d+W$/.test(key) || !title) return []
    const authors: string[] = Array.isArray(d?.author_name) ? d.author_name.filter((a: unknown) => typeof a === 'string') : []
    const cover = num(d?.cover_i)
    const editions = num(d?.edition_count)
    const year = num(d?.first_publish_year)
    return [
      {
        url: `https://openlibrary.org${key}`,
        title,
        host: 'openlibrary.org',
        author: authors.slice(0, 3).join(', ') || undefined,
        date: year ? String(year) : undefined,
        thumbnail: cover && cover > 0 ? `https://covers.openlibrary.org/b/id/${Math.trunc(cover)}-M.jpg` : undefined,
        extra: editions ? `${editions.toLocaleString('en-US')} edition${editions === 1 ? '' : 's'}` : undefined,
      },
    ]
  })
}

/** p0dcasters.com /api/search: shows, each linked to its p0dcasters page (which links the publisher and the feed). */
export function parseP0dcasters(body: any): Media[] {
  const shows: any[] = Array.isArray(body?.shows) ? body.shows : []
  return shows.flatMap((s) => {
    const url = httpUrl(s?.page) || httpUrl(s?.site)
    const title = str(s?.title)
    if (!url || !title) return []
    const episodes = num(s?.episodes)
    return [
      {
        url,
        title,
        host: str(s?.host) || host(url),
        thumbnail: str(s?.image) || undefined,
        description: str(s?.description) || undefined,
        author: str(s?.author) || undefined,
        channel: str(s?.category) || undefined,
        date: day(s?.newestAt),
        extra: [episodes ? `${episodes.toLocaleString('en-US')} episodes` : '', str(s?.cadence)].filter(Boolean).join(' · ') || undefined,
      },
    ]
  })
}

/** rssamplifier.com /api/search: `posts` (the writing, linked to the original) and the feeds themselves. A feed listed twice repeats a post. */
export function parseRssAmplifier(body: any): { posts: Media[]; sites: Media[] } {
  const rawPosts: any[] = Array.isArray(body?.posts) ? body.posts : []
  const seen = new Set<string>()
  const posts = rawPosts.flatMap((p) => {
    const url = httpUrl(p?.url)
    if (!url || seen.has(url)) return []
    seen.add(url)
    return [
      {
        url,
        title: decodeEntities(str(p?.title)) || host(url),
        host: host(url),
        description: decodeEntities(str(p?.summary)) || undefined,
        channel: decodeEntities(str(p?.blog)) || undefined,
        date: day(p?.publishedAt),
      },
    ]
  })
  const feeds: any[] = Array.isArray(body?.blogs) ? body.blogs : Array.isArray(body?.news) ? body.news : []
  const sites = feeds.flatMap((b) => {
    const url = httpUrl(b?.page)
    const title = decodeEntities(str(b?.title))
    if (!url || !title) return []
    return [{ url, title, host: 'rssamplifier.com', description: decodeEntities(str(b?.description)) || undefined }]
  })
  return { posts, sites }
}

/** What Serper is asked for each tab. */
export function serperRequest(vertical: SerperVertical, q: string, limit: number): { endpoint: string; body: Record<string, unknown> } {
  switch (vertical) {
    case 'images':
      return { endpoint: 'images', body: { q, num: limit } }
    case 'videos':
      return { endpoint: 'videos', body: { q, num: limit } }
    case 'live':
      return { endpoint: 'videos', body: { q: `${q} live stream`, num: limit } }
    case 'music':
      return { endpoint: 'search', body: { q: `${q} (${MUSIC_SITES.map((s) => `site:${s}`).join(' OR ')})`, num: limit } }
    case 'shopping':
      return { endpoint: 'shopping', body: { q, num: limit } }
    case 'news':
      return { endpoint: 'news', body: { q, num: limit } }
    case 'places':
      return { endpoint: 'places', body: { q } }
    case 'scholar':
      return { endpoint: 'scholar', body: { q, num: limit } }
  }
}

const PARSERS: Record<string, (body: any) => Media[]> = {
  images: parseSerperImages,
  videos: parseSerperVideos,
  shopping: parseSerperShopping,
  news: parseSerperNews,
  places: parseSerperPlaces,
  scholar: parseSerperScholar,
  search: parseSerperWeb,
}

/** How many results a tab shows by default, and at most. */
const LIMITS: Partial<Record<Vertical, { max: number; default: number }>> = {
  images: { max: 40, default: 30 },
  shopping: { max: 40, default: 20 },
  books: { max: 40, default: 20 },
  podcasts: { max: 40, default: 20 },
  blogs: { max: 30, default: 20 },
}

/** Our own requests say who we are and nothing about who asked. */
const OURS = { 'user-agent': 'pit.world search (https://pit.world/privacy)', accept: 'application/json' }

async function fetchJson(fetchImpl: Fetch, url: string, init: RequestInit = {}): Promise<any> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function askSerper(fetchImpl: Fetch, key: string, vertical: SerperVertical, q: string, limit: number): Promise<Media[]> {
  const { endpoint, body } = serperRequest(vertical, q, limit)
  const json = await fetchJson(fetchImpl, `https://google.serper.dev/${endpoint}`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return PARSERS[endpoint]!(json)
}

async function askRssAmplifier(fetchImpl: Fetch, kind: 'blogs' | 'news', q: string): Promise<{ posts: Media[]; sites: Media[] }> {
  return parseRssAmplifier(await fetchJson(fetchImpl, `https://rssamplifier.com/api/search?${new URLSearchParams({ q, kind })}`, { headers: OURS }))
}

export async function searchMedia(
  vertical: Exclude<Vertical, 'web'>,
  query: string,
  keys: Keys,
  options: { limit?: number; cache?: Cache; fetch?: Fetch } = {},
): Promise<MediaResult> {
  const q = normalizeQuery(query)
  const bounds = LIMITS[vertical] ?? { max: 20, default: 10 }
  const limit = Math.min(bounds.max, Math.max(1, options.limit ?? bounds.default))
  const key = keys.serper
  if (!key && SERPER_ONLY.includes(vertical)) throw new SearchUnavailable(`${vertical} search needs the Google index, which is not configured.`)
  const cacheKey = `${vertical}:${limit}:${q.toLowerCase()}`
  const cached = options.cache?.getMedia<MediaResult>(cacheKey)
  if (cached) return { ...cached, query: q, cached: true }
  const fetchImpl = options.fetch ?? fetch
  const make = (provider: MediaProvider, hits: Media[], sites?: Media[]): MediaResult => ({
    query: q,
    vertical,
    provider,
    hits: hits.slice(0, limit),
    ...(sites?.length ? { sites: sites.slice(0, 6) } : {}),
    cached: false,
  })
  let result: MediaResult
  try {
    switch (vertical) {
      case 'books': {
        const params = new URLSearchParams({ q, limit: String(limit), fields: 'key,title,author_name,first_publish_year,cover_i,edition_count' })
        result = make('openlibrary', parseOpenLibrary(await fetchJson(fetchImpl, `https://openlibrary.org/search.json?${params}`, { headers: OURS })))
        break
      }
      case 'podcasts':
        result = make('p0dcasters', parseP0dcasters(await fetchJson(fetchImpl, `https://p0dcasters.com/api/search?${new URLSearchParams({ q, limit: String(limit) })}`, { headers: OURS })))
        break
      case 'blogs': {
        const { posts, sites } = await askRssAmplifier(fetchImpl, 'blogs', q)
        result = make('rssamplifier', posts, sites)
        break
      }
      case 'news': {
        // Google's news index first; our own directory of newsrooms when it is not configured or does not answer.
        const google = key ? await askSerper(fetchImpl, key, 'news', q, limit).catch(() => null) : null
        result = google ? make('serper', google) : make('rssamplifier', (await askRssAmplifier(fetchImpl, 'news', q)).posts)
        break
      }
      case 'scholar': {
        // Google Scholar first; OpenAlex (free, no key) when Google is not configured or does not answer.
        const google = key ? await askSerper(fetchImpl, key, 'scholar', q, limit).catch(() => null) : null
        if (google) result = make('serper', google)
        else {
          const params = new URLSearchParams({
            search: q,
            'per-page': String(limit),
            select: 'id,display_name,publication_year,cited_by_count,doi,primary_location,authorships,abstract_inverted_index',
          })
          result = make('openalex', parseOpenAlex(await fetchJson(fetchImpl, `https://api.openalex.org/works?${params}`, { headers: OURS })))
        }
        break
      }
      default:
        result = make('serper', await askSerper(fetchImpl, key!, vertical, q, limit))
    }
  } catch (error) {
    throw new SearchUnavailable(`The ${vertical} index did not answer: ${error instanceof Error ? error.message : String(error)}`)
  }
  options.cache?.setMedia(cacheKey, result)
  return result
}
