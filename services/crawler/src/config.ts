/**
 * Everything the crawler reads from its environment, in one place.
 *
 * The defaults are sized for one modest box (dev2 shares its RAM with a
 * fleet): scale out by starting more `pit-crawler worker` processes against
 * the same Redis, on this box or any other, not by raising one process's
 * concurrency until it falls over. Render workers scale with Obscura
 * servers, one page at a time each.
 */

export const VERSION = '0.1.0'
export const BOT = 'pitbot'
export const USER_AGENT = `Mozilla/5.0 (compatible; ${BOT}/${VERSION}; +https://pit.world/bot)`

export type Role = 'site' | 'page' | 'render' | 'publish'

export type Config = {
  redisUrl: string
  /** Pages read per site per crawl cycle. */
  maxPages: number
  /** Link hops from the home page or a sitemap entry. */
  maxDepth: number
  /** Pages fetched at once by one process (each from a different site, by the host lease). */
  concurrency: number
  /** Gap between two requests to one site, unless robots.txt asks for more (capped at maxDelayMs). */
  hostDelayMs: number
  maxDelayMs: number
  /** A site is read again this often; its seen-set and page count expire with it. */
  recrawlDays: number
  /** Obscura MCP endpoints, one render at a time each. Empty: no rendering, static HTML only. */
  obscuraUrls: string[]
  obscuraToken: string
  /** Where records go. Without a key they wait in the Redis outbox (bounded). */
  nichedbUrl: string
  nichedbKey: string
  /** How long a site's seen-set outlives its last new page (sliding). */
  seenTtlMs: number
  /** Site starts wait while more page jobs than this are queued: backpressure for big seeds. */
  maxPageBacklog: number
  /** Follow links to other sites and crawl those too, up to maxSites. */
  discover: boolean
  maxSites: number
  /** Records waiting for nichedb beyond this are dropped oldest first. */
  outboxMax: number
  roles: Role[]
  healthPort: number
  healthHost: string
  /** The local search mirror (SQLite FTS5) the publish role writes and /api/v1/search reads. */
  indexPath: string
  userAgent: string
}

const num = (value: string | undefined, fallback: number, min = 0): number => {
  const n = Number(value)
  return Number.isFinite(n) && n >= min ? n : fallback
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): Config {
  const roles = (env.CRAWL_ROLES ?? 'site,page,render,publish')
    .split(',')
    .map((r) => r.trim())
    .filter((r): r is Role => ['site', 'page', 'render', 'publish'].includes(r))
  return {
    redisUrl: env.CRAWL_REDIS_URL ?? env.REDIS_URL ?? 'redis://127.0.0.1:6396',
    maxPages: num(env.CRAWL_MAX_PAGES, 1000, 1),
    maxDepth: num(env.CRAWL_MAX_DEPTH, 6, 0),
    concurrency: num(env.CRAWL_CONCURRENCY, 16, 1),
    hostDelayMs: num(env.CRAWL_HOST_DELAY_MS, 1500, 0),
    maxDelayMs: num(env.CRAWL_MAX_DELAY_MS, 30_000, 0),
    recrawlDays: num(env.CRAWL_RECRAWL_DAYS, 30, 1),
    obscuraUrls: (env.OBSCURA_MCP_URLS ?? env.OBSCURA_MCP_URL ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    obscuraToken: env.OBSCURA_MCP_TOKEN ?? '',
    nichedbUrl: (env.NICHEDB_URL ?? 'https://nichedb.dev').replace(/\/+$/, ''),
    nichedbKey: env.NICHEDB_API_KEY ?? '',
    discover: env.CRAWL_DISCOVER === '1',
    maxSites: num(env.CRAWL_MAX_SITES, 1_000_000, 1),
    seenTtlMs: num(env.CRAWL_SEEN_TTL_HOURS, 72, 1) * 3_600_000,
    maxPageBacklog: num(env.CRAWL_MAX_PAGE_BACKLOG, 50_000, 1),
    outboxMax: num(env.CRAWL_OUTBOX_MAX, 200_000, 1),
    roles: roles.length ? roles : ['site', 'page', 'render', 'publish'],
    healthPort: num(env.CRAWL_HEALTH_PORT, 8797, 0),
    // Loopback on a host; 0.0.0.0 inside a container, whose port is published on the host's loopback.
    healthHost: env.CRAWL_HEALTH_HOST ?? '127.0.0.1',
    indexPath: env.CRAWL_INDEX_PATH ?? './data/index.db',
    userAgent: env.CRAWL_USER_AGENT ?? USER_AGENT,
  }
}
