/**
 * Play, listen and read without leaving the results.
 *
 * A result can carry a `player`: an embed (YouTube, Vimeo, PeerTube, the Internet Archive, Spotify,
 * SoundCloud), a plain audio file (an iTunes preview), or a podcast's episodes. Nothing is loaded until the
 * visitor presses Play: the page shows a button that says which site the player comes from, so no outside
 * site sees the visitor just because a result was listed (pit.world/privacy#players).
 *
 * Audio files never come straight from the publisher: /audio streams them through pit.world, and only
 * files pit.world itself handed out (an iTunes preview it listed, an episode from a p0dcasters playlist it
 * read), so /audio is not a fetch-anything proxy.
 */
import { isPublicPageUrl } from './summarize.js'

type Fetch = typeof fetch
type Resolve = (host: string) => Promise<string[]>

export type PlayerShape = 'video' | 'audio' | 'book'

export type Player =
  /** An https page made to be framed. `host` is who the visitor's browser will talk to once they press Play. */
  | { kind: 'embed'; src: string; host: string; shape: PlayerShape }
  /** An audio file streamed through /audio. `host` is the publisher, named for the record; the browser only talks to pit.world. */
  | { kind: 'audio'; src: string; host: string }
  /** A p0dcasters show: the page asks /api/episodes for its newest episodes, each one an `audio` player. */
  | { kind: 'episodes'; show: string; host: string }

/** Embed hosts the page may frame on every response. PeerTube instances are added per response (embedHosts). */
export const FIXED_FRAME_HOSTS = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'https://archive.org', 'https://open.spotify.com', 'https://w.soundcloud.com']

const YT_ID = /^[A-Za-z0-9_-]{11}$/
const IA_ID = /^[A-Za-z0-9._-]{1,100}$/

/**
 * The embed for a page on one of the fixed players, or null. Never guesses: an address that is not one of
 * these exact shapes gets no player.
 */
export function embedFor(raw: string): Player | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '')
  const parts = url.pathname.split('/').filter(Boolean)
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtu.be') {
    const id =
      host === 'youtu.be'
        ? parts[0]
        : parts[0] === 'watch'
          ? url.searchParams.get('v')
          : parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed'
            ? parts[1]
            : null
    if (!id || !YT_ID.test(id)) return null
    return { kind: 'embed', src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`, host: 'youtube-nocookie.com', shape: 'video' }
  }
  if (host === 'vimeo.com' && parts.length === 1 && /^\d{1,12}$/.test(parts[0]!)) {
    return { kind: 'embed', src: `https://player.vimeo.com/video/${parts[0]}?dnt=1&autoplay=1`, host: 'vimeo.com', shape: 'video' }
  }
  if (host === 'archive.org' && parts[0] === 'details' && parts[1] && IA_ID.test(parts[1])) {
    return { kind: 'embed', src: `https://archive.org/embed/${parts[1]}`, host: 'archive.org', shape: 'video' }
  }
  if (host === 'open.spotify.com') {
    const p = /^intl-[a-z-]+$/i.test(parts[0] ?? '') ? parts.slice(1) : parts
    if (p.length === 2 && /^(track|album|playlist|episode|show|artist)$/.test(p[0]!) && /^[A-Za-z0-9]{22}$/.test(p[1]!)) {
      return { kind: 'embed', src: `https://open.spotify.com/embed/${p[0]}/${p[1]}`, host: 'open.spotify.com', shape: 'audio' }
    }
    return null
  }
  if (host === 'soundcloud.com' && parts.length >= 2 && parts.length <= 3 && parts.every((s) => /^[A-Za-z0-9_-]{1,100}$/.test(s)) && !['discover', 'search', 'you', 'charts', 'stations'].includes(parts[0]!)) {
    const track = `https://soundcloud.com/${parts.join('/')}`
    return { kind: 'embed', src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(track)}&auto_play=true&visual=false`, host: 'soundcloud.com', shape: 'audio' }
  }
  return null
}

/** PeerTube: https://<instance>/w/<id> or /videos/watch/<uuid> plays at /videos/embed/<id> on the same instance. */
export function peertubeEmbed(raw: string): Player | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null
  const m = /^\/(?:w|videos\/watch)\/([A-Za-z0-9-]{8,40})\/?$/.exec(url.pathname)
  if (!m || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)) return null
  return { kind: 'embed', src: `https://${url.hostname.toLowerCase()}/videos/embed/${m[1]}?autoplay=1&warningTitle=0`, host: url.hostname.toLowerCase(), shape: 'video' }
}

/** A book scan on the Internet Archive, opened in its reader. */
export function bookReader(identifier: string): Player | null {
  return IA_ID.test(identifier) ? { kind: 'embed', src: `https://archive.org/embed/${identifier}`, host: 'archive.org', shape: 'book' } : null
}

/** The origins a page must be allowed to frame for these players: the fixed ones are always allowed, so only the rest. */
export function embedHosts(players: Array<Player | undefined>): string[] {
  const out = new Set<string>()
  for (const p of players) {
    if (p?.kind !== 'embed') continue
    const origin = new URL(p.src).origin
    if (!FIXED_FRAME_HOSTS.includes(origin)) out.add(origin)
  }
  return [...out]
}

// --- books ---------------------------------------------------------------------

/**
 * Open Library lists every scan of a work in `ia`, borrowable and public alike. Only scans outside the
 * lending collections can be read by anyone, so one Internet Archive search sorts them: the first readable
 * scan of each work wins, older public-domain scans (Gutenberg, Google, library digitisations) before the
 * modern Better World Books ones.
 */
export async function readableScans(works: Map<string, string[]>, fetchImpl: Fetch, timeoutMs = 5_000): Promise<Map<string, string>> {
  const all = [...new Set([...works.values()].flatMap((ids) => ids.filter((id) => IA_ID.test(id)).slice(0, 8)))].slice(0, 150)
  if (!all.length) return new Map()
  const params = new URLSearchParams({
    q: `identifier:(${all.join(' OR ')}) AND mediatype:texts AND NOT collection:(inlibrary OR printdisabled OR lendinglibrary)`,
    rows: String(all.length),
    output: 'json',
  })
  params.append('fl[]', 'identifier')
  const response = await fetchImpl(`https://archive.org/advancedsearch.php?${params}`, {
    headers: { 'user-agent': 'pit.world search (https://pit.world/privacy)', accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = (await response.json()) as { response?: { docs?: Array<{ identifier?: unknown }> } }
  const readable = new Set((body.response?.docs ?? []).map((d) => (typeof d.identifier === 'string' ? d.identifier : '')).filter(Boolean))
  const modern = (id: string) => (/^bwb_|0000/.test(id) ? 1 : 0)
  const out = new Map<string, string>()
  for (const [work, ids] of works) {
    const pick = ids.filter((id) => readable.has(id)).sort((a, b) => modern(a) - modern(b))[0]
    if (pick) out.set(work, pick)
  }
  return out
}

// --- audio ---------------------------------------------------------------------

/** iTunes previews: the one audio host /audio fetches without being handed the file first. */
const PREVIEW_HOST = /^audio-ssl\.itunes\.apple\.com$/

export function previewPlayer(raw: unknown): Player | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && PREVIEW_HOST.test(url.hostname) && !url.port ? { kind: 'audio', src: url.href, host: 'apple.com' } : undefined
  } catch {
    return undefined
  }
}

/** Audio files pit.world handed out (episodes from a playlist it read), by URL, for a while. In RAM only. */
export class AudioRegistry {
  private known = new Map<string, number>()
  constructor(private readonly ttlMs = 12 * 3600_000) {}
  add(url: string): void {
    this.known.delete(url)
    this.known.set(url, Date.now())
    while (this.known.size > 50_000) this.known.delete(this.known.keys().next().value!)
  }
  allowed(raw: string): boolean {
    try {
      const url = new URL(raw)
      if (url.protocol === 'https:' && PREVIEW_HOST.test(url.hostname) && !url.port) return true
    } catch {
      return false
    }
    const at = this.known.get(raw)
    return at !== undefined && Date.now() - at < this.ttlMs
  }
}

export type Episode = { title: string; seconds?: number; url: string }

/** An extended M3U playlist (p0dcasters' /playlist.m3u): `#EXTINF:<seconds>,<title>` then the file. */
export function parseM3u(text: string, max = 12): Episode[] {
  const out: Episode[] = []
  let pending: { title: string; seconds?: number } | null = null
  for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
    if (!line) continue
    const inf = /^#EXTINF:(-?\d+(?:\.\d+)?)\s*(?:[^,]*)?,(.*)$/.exec(line)
    if (inf) {
      const s = Number(inf[1])
      pending = { title: inf[2]!.trim(), ...(s > 0 ? { seconds: Math.round(s) } : {}) }
      continue
    }
    if (line.startsWith('#')) continue
    if (/^https?:\/\//i.test(line)) {
      out.push({ title: pending?.title || 'Episode', ...(pending?.seconds ? { seconds: pending.seconds } : {}), url: line })
      if (out.length >= max) break
    }
    pending = null
  }
  return out
}

/** A p0dcasters show page, exactly: https://p0dcasters.com/podcast/<slug>. */
export function showPage(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.hostname !== 'p0dcasters.com' || url.port || url.search || url.hash) return null
    return /^\/podcast\/[a-z0-9-]{1,200}\/?$/.test(url.pathname) ? `https://p0dcasters.com${url.pathname.replace(/\/$/, '')}` : null
  } catch {
    return null
  }
}

/** The newest episodes of a p0dcasters show, each registered so /audio will stream it. */
export async function showEpisodes(show: string, registry: AudioRegistry, fetchImpl: Fetch = fetch): Promise<Episode[]> {
  const page = showPage(show)
  if (!page) throw new Error('not a p0dcasters show')
  const response = await fetchImpl(`${page}/playlist.m3u`, { headers: { 'user-agent': 'pit.world search (https://pit.world/privacy)' }, signal: AbortSignal.timeout(8_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const episodes = parseM3u(await response.text())
  for (const e of episodes) registry.add(e.url)
  return episodes
}

const AUDIO_TYPES = /^(audio\/[a-z0-9.+-]+|video\/mp4|application\/octet-stream)/i

/**
 * Streams an audio file to the visitor, Range and all, so seeking works. Redirects are followed by hand and
 * every hop must resolve to public addresses only; the publisher sees pit.world, never the visitor.
 */
export async function proxyAudio(raw: string, range: string | null, options: { fetch?: Fetch; resolve?: Resolve } = {}): Promise<Response> {
  let url = new URL(raw)
  const fetchImpl = options.fetch ?? fetch
  for (let hop = 0; hop < 6; hop++) {
    if (!(await isPublicPageUrl(url, options.resolve))) return new Response(null, { status: 502 })
    // threatcrush-disable-next-line js-ssrf-outbound-request  only a file pit.world handed out (AudioRegistry) or an iTunes preview; every hop resolved and checked public
    const upstream = await fetchImpl(url.href, {
      redirect: 'manual',
      headers: { 'user-agent': 'pit.world audio (https://pit.world/privacy)', ...(range && /^bytes=\d*-\d*$/.test(range) ? { range } : {}) },
      signal: AbortSignal.timeout(20_000),
    })
    const location = upstream.status >= 300 && upstream.status < 400 ? upstream.headers.get('location') : null
    if (location) {
      upstream.body?.cancel().catch(() => {})
      url = new URL(location, url)
      continue
    }
    const type = upstream.headers.get('content-type') ?? ''
    if (!(upstream.status === 200 || upstream.status === 206) || !AUDIO_TYPES.test(type)) {
      upstream.body?.cancel().catch(() => {})
      return new Response(null, { status: 502 })
    }
    const headers = new Headers({
      // iTunes previews say audio/x-m4p (an old iTunes Store name) for plain AAC in MP4, which some browsers refuse.
      'content-type': /^application\/octet-stream/i.test(type) ? 'audio/mpeg' : /^audio\/x-m4[ap]/i.test(type) ? 'audio/mp4' : type,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=3600',
    })
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  }
  return new Response(null, { status: 502 })
}
