/**
 * The W3BS network's sites, as pit.world's featured set (Anthony 2026-11-02:
 * "mark these as featured sites", about the sites on w3bs.org/net).
 *
 * The list is w3bs.org's own: its registry (/api/net/v1/registry `names`) and
 * the links on /net, refreshed every hour. A W3BS name is reached on the open
 * web through its pit.world relay (<name>.pit.world; <name>.w3bs.org does not
 * resolve outside W3BS), so both spellings count. Until the first refresh
 * answers, and whenever it fails, the ring's own sites stand in.
 *
 * Featured is ours and unpaid, never an ad: a search result from one of these
 * sites carries a Featured badge, and up to FEATURED_TOP of them lead the page.
 */
import { RING } from './ring.ts'
import { callProvider, type Hit, type SearchResult, urlKey } from './search.ts'

export const FEATURED_TOP = 1
const REFRESH_MS = 60 * 60_000
const REGISTRY = 'https://w3bs.org/api/net/v1/registry'
const PAGE = 'https://w3bs.org/net'

type Fetch = typeof fetch

const clean = (host: string) => host.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '')

/** The hosts a W3BS name answers on: its pit.world relay and its w3bs.org spelling. */
function hostsFor(name: string): string[] {
  const n = clean(name).replace(/\.(pit\.world|w3bs\.org)$/, '')
  return [`${n}.pit.world`, `${n}.w3bs.org`]
}

export function fallbackHosts(): Set<string> {
  const out = new Set<string>(['w3bs.org', 'pit.world'])
  for (const s of RING) for (const h of s.moshpit ? hostsFor(s.name) : [clean(s.name)]) out.add(h)
  return out
}

/** Hosts named by the registry JSON and the /net page HTML. */
export function hostsFrom(registry: unknown, html: string): Set<string> {
  const out = new Set<string>(['w3bs.org'])
  const names = (registry as { names?: Array<{ name?: unknown; status?: unknown }> } | null)?.names ?? []
  for (const n of names) if (typeof n?.name === 'string' && n.status !== 'released') for (const h of hostsFor(n.name)) out.add(h)
  for (const m of html.matchAll(/href="https:\/\/([a-z0-9.-]+\.(?:pit\.world|w3bs\.org))\/?[^"]*"/gi)) for (const h of hostsFor(m[1]!)) out.add(h)
  return out
}

export class W3bsNetwork {
  private hosts: Set<string>
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly fetchImpl: Fetch = fetch,
    initial?: Iterable<string>,
  ) {
    this.hosts = initial ? new Set([...initial].map(clean)) : fallbackHosts()
  }

  /** Keep the list current: now, then hourly. Unref'd, so it never holds the process open. */
  start(): this {
    // Tests stay offline: the ring's sites stand in.
    if (process.env.NODE_ENV === 'test') return this
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
    return this
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async refresh(): Promise<number> {
    try {
      const [registry, html] = await Promise.all([
        // threatcrush-disable-next-line js-ssrf-outbound-request  fixed w3bs.org URLs from this module, never from a request
        this.fetchImpl(REGISTRY, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : null)),
        // threatcrush-disable-next-line js-ssrf-outbound-request  fixed w3bs.org URLs from this module, never from a request
        this.fetchImpl(PAGE, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.text() : '')),
      ])
      const found = hostsFrom(registry, html)
      // A broken answer must not empty the set: keep the last good one.
      if (found.size > 10) this.hosts = new Set([...found, ...fallbackHosts()])
    } catch {
      // Keep what we had.
    }
    return this.hosts.size
  }

  has(host: string): boolean {
    return this.hosts.has(clean(host))
  }

  get size(): number {
    return this.hosts.size
  }
}

/**
 * Network pages our own index has for a query (services/crawler's local mirror, the
 * same base the 'pit' engine reads), so a featured slot can be filled even when no
 * engine returned a network site. Loopback and short: a slow index only means no extra.
 */
export async function networkPagesFromIndex(query: string, indexKey: string | undefined, network: Pick<W3bsNetwork, 'has'>, fetchImpl?: typeof fetch): Promise<Hit[]> {
  if (!indexKey) return []
  try {
    const hits = await Promise.race([
      callProvider('pit', indexKey, query, 50, fetchImpl),
      new Promise<Hit[]>((resolve) => setTimeout(() => resolve([]), 1_500)),
    ])
    return hits.filter((h) => network.has(h.host))
  } catch {
    return []
  }
}

/**
 * The same result with network hits badged and up to FEATURED_TOP of them first,
 * in their own order; everything else keeps its order. When the engines brought
 * fewer than FEATURED_TOP network sites, the free slots go to network pages from
 * our own index (`fromIndex`, best first), one per site, never one already on the
 * page. Returns a new object, so a cached result is never changed.
 */
export function featureNetwork(result: SearchResult, network: Pick<W3bsNetwork, 'has'>, fromIndex: Hit[] = []): SearchResult {
  const top: Hit[] = []
  const rest: Hit[] = []
  for (const hit of result.hits) {
    if (network.has(hit.host)) {
      const badged = { ...hit, featured: true }
      if (top.length < FEATURED_TOP) top.push(badged)
      else rest.push(badged)
    } else rest.push(hit)
  }
  const onPage = new Set(result.hits.map((h) => urlKey(h.url)))
  const sites = new Set(top.map((h) => h.host))
  for (const hit of fromIndex) {
    if (top.length >= FEATURED_TOP) break
    if (onPage.has(urlKey(hit.url)) || sites.has(hit.host) || !network.has(hit.host)) continue
    top.push({ ...hit, featured: true, sources: ['pit'] })
    sites.add(hit.host)
  }
  return top.length || rest.some((h) => h.featured) ? { ...result, hits: [...top, ...rest] } : result
}
