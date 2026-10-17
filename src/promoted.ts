/**
 * Our own live and on-demand video, shown above the web results in the Videos,
 * Music and Live tabs: PairUX channels first, then nixamp streams.
 *
 * Both are public directories read from our server, so a visitor's browser
 * never talks to either until they click. Fetched at most once a minute and
 * kept in RAM, like the search cache.
 */
import type { Vertical } from './verticals.js'

type Fetch = typeof fetch

export type Promo = {
  source: 'pairux' | 'nixamp'
  title: string
  url: string
  /** One short line: who, what's on, how many watching. */
  line: string
  live: boolean
}

export const PAIRUX = 'https://pairux.com'
export const NIXAMP = 'https://nixamp.com'
const TTL_MS = 60_000
const TIMEOUT_MS = 4_000

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const https = (v: unknown) => (/^https:\/\/[^\s"'<>]+$/.test(str(v)) ? str(v) : '')
const handleOk = (v: unknown) => (/^[A-Za-z0-9_.-]{1,64}$/.test(str(v)) ? str(v) : '')

export function parsePairuxRooms(body: any): Promo[] {
  const rows: any[] = Array.isArray(body?.data) ? body.data : []
  return rows.flatMap((r) => {
    const code = handleOk(r?.join_code)
    if (!code) return []
    const who = str(r?.channel_name) || str(r?.host_display_name) || str(r?.host_username)
    const viewers = num(r?.viewer_count)
    return [
      {
        source: 'pairux' as const,
        title: str(r?.subject) || `${who || 'A'} live room`,
        url: `${PAIRUX}/l/${encodeURIComponent(code)}`,
        line: [who, r?.is_live ? 'live now' : '', viewers ? `${viewers} watching` : ''].filter(Boolean).join(' · '),
        live: r?.is_live === true,
      },
    ]
  })
}

export function parsePairuxChannels(body: any): Promo[] {
  const rows: any[] = Array.isArray(body?.data) ? body.data : []
  return rows.flatMap((c) => {
    const handle = handleOk(c?.handle)
    if (!handle) return []
    const subs = num(c?.subscriber_count)
    return [
      {
        source: 'pairux' as const,
        title: str(c?.name) || `@${handle}`,
        url: `${PAIRUX}/@${encodeURIComponent(handle)}`,
        line: [`@${handle}`, c?.is_live ? 'live now' : '', subs ? `${subs} subscribers` : '', str(c?.description).slice(0, 120)].filter(Boolean).join(' · '),
        live: c?.is_live === true,
      },
    ]
  })
}

export function parseNixamp(body: any): Promo[] {
  const streams: any[] = Array.isArray(body?.streams) ? body.streams : []
  return streams.flatMap((s) => {
    const url = https(s?.url)
    if (!url) return []
    const channels: string[] = Array.isArray(s?.channels) ? s.channels.map(str).filter(Boolean) : []
    const playing = s?.playing === true
    const now = str(s?.nowPlaying)
    const tracks = num(s?.tracks)
    return [
      {
        source: 'nixamp' as const,
        title: str(s?.name) || 'nixamp stream',
        url,
        line: [
          playing && now ? `now playing ${now}` : '',
          channels.length ? `live: ${channels.slice(0, 3).join(', ')}` : '',
          tracks ? `${tracks.toLocaleString('en-US')} on demand` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        live: playing || channels.length > 0,
      },
    ]
  })
}

/** Lowercase words of 2+ letters, for a forgiving "does this listing mention the search" check. */
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []

export function matches(promo: Promo, query: string): boolean {
  const want = words(query)
  if (!want.length) return false
  const have = new Set(words(`${promo.title} ${promo.line}`))
  return want.some((w) => have.has(w))
}

/**
 * What to show for a search in a tab. Live shows everything live (matches first);
 * Videos and Music show listings that mention the search, then anything live.
 * PairUX always leads.
 */
export function pick(all: Promo[], query: string, vertical: Vertical): Promo[] {
  if (vertical === 'web' || vertical === 'images') return []
  const pool = vertical === 'music' ? all.filter((p) => p.source === 'nixamp') : all
  const score = (p: Promo) => (matches(p, query) ? 4 : 0) + (p.live ? 2 : 0) + (p.source === 'pairux' ? 1 : 0)
  const shown = pool.filter((p) => matches(p, query) || p.live || vertical === 'live')
  const seen = new Set<string>()
  return shown
    .sort((a, b) => score(b) - score(a))
    .filter((p) => (seen.has(p.url) ? false : (seen.add(p.url), true)))
    .slice(0, vertical === 'live' ? 12 : 6)
}

export class Promoted {
  private items: Promo[] = []
  private at = 0
  private pending: Promise<Promo[]> | null = null

  constructor(
    private fetchImpl: Fetch = fetch,
    private ttlMs = TTL_MS,
  ) {}

  private async get(url: string): Promise<any> {
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
      return response.ok ? await response.json() : null
    } catch {
      return null
    }
  }

  /** Every listing, PairUX first. A directory that is down just contributes nothing. */
  async all(): Promise<Promo[]> {
    if (Date.now() - this.at < this.ttlMs) return this.items
    this.pending ??= (async () => {
      const [rooms, channels, nixamp] = await Promise.all([
        this.get(`${PAIRUX}/api/live?limit=20`),
        this.get(`${PAIRUX}/api/channels/directory?limit=60`),
        this.get(`${NIXAMP}/api/directory`),
      ])
      this.items = [...parsePairuxRooms(rooms), ...parsePairuxChannels(channels), ...parseNixamp(nixamp)]
      this.at = Date.now()
      this.pending = null
      return this.items
    })()
    return this.pending
  }

  async for(query: string, vertical: Vertical): Promise<Promo[]> {
    if (vertical === 'web' || vertical === 'images') return []
    return pick(await this.all(), query, vertical)
  }
}
