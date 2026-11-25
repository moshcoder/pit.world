/**
 * New listings from the three sister directories, read into pit.world twice over: each listing's
 * own website is handed to the crawler through the same door as pit.world/submit (so it is read
 * into the index), and the site is filed in /directory under the closest existing category,
 * marked with the directory it came from.
 *
 * Shaped like the NicheDB import (src/nichedb-import.ts): a small run on a timer, a cursor kept in
 * listings.db, one source at a time. Each feed is asked newest first, a page of 100 at a time:
 *
 *   SaaSRow      GET /api/v1/products?sort=recent&limit=100&offset=N
 *   pwamart      GET /api/v1/apps?sort=new&limit=100&offset=N
 *   built.indie  GET /api/v1/products?window=new&limit=100&offset=N
 *
 * A run takes at most `cap` listings it has not seen from each source (50 by default), so the first
 * pass over a few thousand listings trickles in over days instead of landing on the crawler at once.
 * The head of the feed is always read first, so today's launches never wait behind the backlog; what
 * is left of the cap walks the older pages from a saved offset until the feed ends.
 *
 * The sister directories keep their Adult (18+) listings out of these public feeds. Should one ever
 * arrive carrying the category `adult`, it is filed under Adult (members only) and is NOT handed to
 * the crawler: a crawled page is published to NicheDB and the corpus, which adult entries never are.
 */
import type { Listings } from './listings.js'
import { ADULT, siteHost, siteUrl, type DirectorySites } from './directory-sites.js'

export type FeedItem = { id: string; name: string; url: string; description: string; category: string; tags: string[]; page: string }

export type SisterSource = {
  key: string
  label: string
  /** The newest-first feed, a page at `offset`. */
  feed: (offset: number, limit: number) => string
  parse: (body: any) => FeedItem[]
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const list = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [])

export const SISTER_SOURCES: SisterSource[] = [
  {
    key: 'saasrow',
    label: 'SaaSRow',
    feed: (offset, limit) => `https://saasrow.pwa.pit.world/api/v1/products?sort=recent&limit=${limit}&offset=${offset}`,
    parse: (body) =>
      (Array.isArray(body?.data) ? body.data : []).map((p: any) => ({
        id: str(p?.id), name: str(p?.name), url: str(p?.website), description: str(p?.description), category: str(p?.category), tags: list(p?.tags), page: str(p?.saasrow_url),
      })),
  },
  {
    key: 'pwamart',
    label: 'pwamart',
    feed: (offset, limit) => `https://pwamart.com/api/v1/apps?sort=new&limit=${limit}&offset=${offset}`,
    parse: (body) =>
      (Array.isArray(body?.apps) ? body.apps : []).map((a: any) => ({
        id: str(a?.slug), name: str(a?.name), url: str(a?.url) || str(a?.origin), description: str(a?.summary) || str(a?.description), category: str(a?.category), tags: list(a?.tags),
        page: str(a?.slug) ? `https://pwamart.com/apps/${encodeURIComponent(str(a.slug))}` : '',
      })),
  },
  {
    key: 'built.indie',
    label: 'built.indie',
    feed: (offset, limit) => `https://built.indie.pit.world/api/v1/products?window=new&limit=${limit}&offset=${offset}`,
    parse: (body) =>
      (Array.isArray(body?.products) ? body.products : []).map((p: any) => ({
        id: str(p?.slug), name: str(p?.name), url: str(p?.url), description: str(p?.tagline) || str(p?.description), category: str(p?.category), tags: list(p?.tags), page: str(p?.page),
      })),
  },
]

/** Where everything from a software directory goes when nothing more exact is certain. */
export const GENERAL = 'computers/software'

const key = (v: string) => v.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Sister-directory categories that name one of ours outright. Everything else is filed under GENERAL. */
const BY_CATEGORY: Record<string, string> = {
  ai: 'computers/ai',
  'ai-tools': 'computers/ai',
  'ai-and-agents': 'computers/ai',
  'artificial-intelligence': 'computers/ai',
  security: 'computers/security',
  'security-and-privacy': 'computers/security',
  communication: 'computers/communication',
  social: 'computers/communication',
  marketing: 'business/advertising',
  advertising: 'business/advertising',
  'affiliate-marketing': 'business/advertising',
  shopping: 'business/shopping',
  'e-commerce': 'business/shopping',
  games: 'entertainment/games',
  music: 'entertainment/music',
  news: 'news/news',
  'news-and-media': 'news/news',
  'news-and-reading': 'news/news',
  legal: 'reference/legal',
  'legal-software': 'reference/legal',
  hosting: 'computers/hosting',
}

/** Tags that name one of ours outright; read only when the category said nothing exact. */
const BY_TAG: Record<string, string> = {
  ai: 'computers/ai',
  llm: 'computers/ai',
  'ai-agent': 'computers/ai',
  'ai-agents': 'computers/ai',
  security: 'computers/security',
  cybersecurity: 'computers/security',
  seo: 'computers/web-dev',
  hosting: 'computers/hosting',
  podcast: 'news/podcasts',
  podcasts: 'news/podcasts',
  game: 'entertainment/games',
  games: 'entertainment/games',
}

export const isAdultCategory = (category: string) => /^adult(-18)?$/.test(key(category))

/** The directory path for a sister listing. `adult` only for the category adult; never a guess beyond the tables above. */
export function pathFor(category: string, tags: string[] = []): string {
  if (isAdultCategory(category)) return ADULT.slug
  const exact = BY_CATEGORY[key(category)]
  if (exact) return exact
  for (const t of tags) {
    const byTag = BY_TAG[key(t)]
    if (byTag) return byTag
  }
  return GENERAL
}

export type SisterResult = {
  source: string
  /** Feed records read this run. */
  read: number
  /** Records not seen before (at most the cap). */
  fresh: number
  /** Addresses the crawler took. */
  queued: number
  /** Sites newly filed in the directory (public categories). */
  added: number
  /** Filed under Adult instead (never crawled). */
  adult: number
  /** Already in the directory under that host. */
  duplicates: number
  /** No usable public address. */
  skipped: number
  /** Where the walk over older pages stands: an offset, or 'done'. */
  backfill: number | 'done'
}

export type SisterDeps = {
  sites: DirectorySites
  cursors: Pick<Listings, 'importCursor' | 'setImportCursor'>
  /** Is this host already in the directory (a *.pit.world site, or filed)? */
  known: (host: string) => boolean
  /** Hand addresses to the crawl queue (pit.world/submit's path). Throws when the crawler is not taking them. */
  submit: (urls: string[]) => Promise<number>
  fetchImpl?: typeof fetch
  /** New listings taken per source per run. */
  cap?: number
  pageSize?: number
  /** Feed pages read per source per run. */
  maxPages?: number
  /** Gap between feed requests. */
  pauseMs?: number
}

const USER_AGENT = 'pit.world directory import (+https://pit.world/directory)'

type State = { offset: number; done: boolean }

export async function importSister(source: SisterSource, deps: SisterDeps): Promise<SisterResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const cap = Math.max(1, Math.min(200, Math.trunc(deps.cap ?? 50)))
  const pageSize = Math.max(1, Math.min(100, Math.trunc(deps.pageSize ?? 100)))
  const maxPages = Math.max(1, Math.min(10, Math.trunc(deps.maxPages ?? 3)))
  const pause = Math.max(0, deps.pauseMs ?? 1_000)
  const cursorKey = `sister:${source.key}`
  let state: State = { offset: 0, done: false }
  try {
    const saved = JSON.parse(deps.cursors.importCursor(cursorKey) ?? 'null') as Partial<State> | null
    if (saved) state = { offset: Math.max(0, Math.trunc(Number(saved.offset)) || 0), done: saved.done === true }
  } catch {}
  const result: SisterResult = { source: source.key, read: 0, fresh: 0, queued: 0, added: 0, adult: 0, duplicates: 0, skipped: 0, backfill: state.done ? 'done' : state.offset }
  let pagesRead = 0

  /** Read one page and take what is new, up to the cap. Says whether the whole page is now behind us. */
  const page = async (offset: number): Promise<{ consumed: boolean; short: boolean; hadSeen: boolean }> => {
    if (pagesRead++ && pause) await new Promise<void>((resolve) => setTimeout(resolve, pause))
    // threatcrush-disable-next-line js-ssrf-outbound-request  fixed sister-directory hosts from SISTER_SOURCES, never from a request
    const response = await fetchImpl(source.feed(offset, pageSize), { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json', 'user-agent': USER_AGENT } })
    if (!response.ok) throw new Error(`${source.label} answered ${response.status}`)
    const items = source.parse(await response.json()).filter((i) => i.id)
    result.read += items.length
    const take: FeedItem[] = []
    let hadSeen = false
    let consumed = true
    for (const item of items) {
      if (deps.sites.seen(source.key, item.id)) {
        hadSeen = true
        continue
      }
      if (result.fresh + take.length >= cap) {
        consumed = false
        break
      }
      take.push(item)
    }
    const crawl: string[] = []
    const file: Array<{ item: FeedItem; url: string; path: string }> = []
    const filing = new Set<string>()
    let duplicates = 0
    let skipped = 0
    for (const item of take) {
      const url = siteUrl(item.url)
      const host = url ? siteHost(url) : null
      if (!url || !host || host === 'pit.world') {
        skipped++
        continue
      }
      const path = pathFor(item.category, item.tags)
      // An adult listing, or a host already filed under Adult, is never handed to the crawler. It is filed
      // at once, so a later record on the same site (a subdomain, a second listing) is held back too.
      if (path === ADULT.slug) {
        const outcome = deps.sites.add({ name: item.name, url, description: item.description, tags: item.tags, path, source: source.key, sourceUrl: item.page })
        if (outcome === 'added' || outcome === 'moved') result.adult++
        else duplicates++
      } else if (deps.sites.isAdult(host)) duplicates++
      else {
        crawl.push(url)
        if (deps.known(host) || filing.has(host)) duplicates++
        else {
          filing.add(host)
          file.push({ item, url, path })
        }
      }
    }
    // The crawler first: if it is not taking submissions nothing is marked seen, and the next run reads this page again.
    if (crawl.length) result.queued += await deps.submit(crawl)
    for (const { item, url, path } of file) {
      const outcome = deps.sites.add({ name: item.name, url, description: item.description, tags: item.tags, path, source: source.key, sourceUrl: item.page })
      if (outcome === 'added') result.added++
      else if (outcome === 'exists') duplicates++
      else skipped++
    }
    deps.sites.markSeen(source.key, take.map((i) => i.id))
    result.fresh += take.length
    result.duplicates += duplicates
    result.skipped += skipped
    return { consumed, short: items.length < pageSize, hadSeen }
  }

  const save = () => {
    deps.cursors.setImportCursor(cursorKey, JSON.stringify(state))
    result.backfill = state.done ? 'done' : state.offset
  }

  // The head: today's launches. Keep going only while every record was new (a burst larger than a page).
  let head = 0
  for (;;) {
    const p = await page(head)
    if (p.consumed) {
      if (state.offset <= head) state.offset = head + pageSize
      if (p.short) state.done = true
      save()
    }
    if (!p.consumed || p.short || p.hadSeen || result.fresh >= cap || pagesRead >= maxPages) break
    head += pageSize
  }
  // The backlog: older pages from the saved offset, with whatever is left of the cap.
  while (!state.done && result.fresh < cap && pagesRead < maxPages) {
    const p = await page(state.offset)
    if (!p.consumed) break
    if (p.short) state.done = true
    else state.offset += pageSize
    save()
  }
  return result
}

/** One run over every sister directory, one after another. A source that fails is reported and does not stop the others. */
export async function importSisters(deps: SisterDeps, sources: SisterSource[] = SISTER_SOURCES): Promise<Array<SisterResult | { source: string; error: string }>> {
  const out: Array<SisterResult | { source: string; error: string }> = []
  for (const source of sources) {
    try {
      out.push(await importSister(source, deps))
    } catch (error) {
      out.push({ source: source.key, error: (error as Error).message })
    }
  }
  return out
}

export const describeRun = (r: SisterResult | { source: string; error: string }): string =>
  'error' in r
    ? `${r.source}: failed (${r.error})`
    : `${r.source}: read ${r.read}, new ${r.fresh}, queued for crawl ${r.queued}, filed ${r.added}, adult ${r.adult}, already listed ${r.duplicates}, skipped ${r.skipped}, backfill ${r.backfill === 'done' ? 'done' : `at offset ${r.backfill}`}`
