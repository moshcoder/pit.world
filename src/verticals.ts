/**
 * The tabs above the results: All (the web search in search.ts), Images,
 * Videos, Music and Live. Images and videos come from Google through Serper's
 * own endpoints; Music is a web search kept to music sites; Live is a video
 * search for streams. Our own live and on-demand video (promoted.ts) sits on
 * top of Videos, Music and Live.
 */
import { Cache, normalizeQuery, SearchUnavailable, type Keys } from './search.js'

type Fetch = typeof fetch

export type Vertical = 'web' | 'images' | 'videos' | 'music' | 'live'

export const VERTICALS: Array<{ id: Vertical; label: string }> = [
  { id: 'web', label: 'All' },
  { id: 'images', label: 'Images' },
  { id: 'videos', label: 'Videos' },
  { id: 'music', label: 'Music' },
  { id: 'live', label: 'Live' },
]

export function parseVertical(value: string | undefined | null): Vertical {
  return VERTICALS.some((v) => v.id === value) ? (value as Vertical) : 'web'
}

/** A picture or a video. `thumbnail` is a URL we may fetch for the visitor (see /img), or a data: URI. */
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
}

export type MediaResult = { query: string; vertical: Exclude<Vertical, 'web'>; provider: 'serper'; hits: Media[]; cached: boolean }

export const MUSIC_SITES = ['bandcamp.com', 'soundcloud.com', 'open.spotify.com', 'music.apple.com', 'music.youtube.com', 'audiomack.com', 'mixcloud.com']

/**
 * Thumbnail hosts /img will fetch on a visitor's behalf. A fixed list, so the
 * proxy can't be pointed anywhere else (no internal addresses, no open relay).
 */
const THUMB_HOSTS = [/^encrypted-tbn\d\.gstatic\.com$/, /^i\.ytimg\.com$/, /^i\d?\.vimeocdn\.com$/, /^i\.vimeocdn\.com$/, /^tbn\d\.gstatic\.com$/]

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
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
const httpUrl = (v: unknown) => (/^https?:\/\//i.test(str(v)) ? str(v) : '')

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

/** What Serper is asked for each tab. */
export function serperRequest(vertical: Exclude<Vertical, 'web'>, q: string, limit: number): { endpoint: string; body: Record<string, unknown> } {
  switch (vertical) {
    case 'images':
      return { endpoint: 'images', body: { q, num: limit } }
    case 'videos':
      return { endpoint: 'videos', body: { q, num: limit } }
    case 'live':
      return { endpoint: 'videos', body: { q: `${q} live stream`, num: limit } }
    case 'music':
      return { endpoint: 'search', body: { q: `${q} (${MUSIC_SITES.map((s) => `site:${s}`).join(' OR ')})`, num: limit } }
  }
}

export async function searchMedia(
  vertical: Exclude<Vertical, 'web'>,
  query: string,
  keys: Keys,
  options: { limit?: number; cache?: Cache; fetch?: Fetch } = {},
): Promise<MediaResult> {
  const q = normalizeQuery(query)
  const limit = Math.min(vertical === 'images' ? 40 : 20, Math.max(1, options.limit ?? (vertical === 'images' ? 30 : 10)))
  const key = keys.serper
  if (!key) throw new SearchUnavailable(`${vertical} search needs the Google index, which is not configured.`)
  const cacheKey = `${vertical}:${limit}:${q.toLowerCase()}`
  const cached = options.cache?.getMedia<MediaResult>(cacheKey)
  if (cached) return { ...cached, query: q, cached: true }
  const { endpoint, body } = serperRequest(vertical, q, limit)
  let json: any
  try {
    const response = await (options.fetch ?? fetch)(`https://google.serper.dev/${endpoint}`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    json = await response.json()
  } catch (error) {
    throw new SearchUnavailable(`The ${vertical} index did not answer: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parse = endpoint === 'images' ? parseSerperImages : endpoint === 'videos' ? parseSerperVideos : parseSerperWeb
  const result: MediaResult = { query: q, vertical, provider: 'serper', hits: parse(json).slice(0, limit), cached: false }
  options.cache?.setMedia(cacheKey, result)
  return result
}
