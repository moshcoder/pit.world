/**
 * The pit.world web ring: sites that carry the same thin bar (or three links), so a visitor can walk
 * from one to the next.
 *
 * Two kinds of member. The core sites below, pit.world and the Moshpit sites it was started with; and
 * every business listing claimed on pit.world, which joins the ring the moment it is claimed (its owner
 * can opt out from the edit page). Ring order is core first, then listings in the order they joined.
 *
 * pit.world is the source of truth. Member sites read /api/ring and draw the bar themselves
 * (server-side, so it works with JavaScript off and needs no CSP exception); /ring/next, /ring/prev and
 * /ring/random are plain redirects for a site that would rather paste three static links.
 *
 * A Moshpit name only opens for a visitor on Moshpit DNS. Everyone else gets the whole site through
 * pit.world's proxy, https://<name>.pit.world/ (src/proxy.ts).
 *
 * The same ring is mirrored to rssamplifier.com as an OpenWebring ring of feeds (ring-sync.ts).
 */
// Its own escaper, so html.ts can import this module without a cycle.
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)

export const proxyUrl = (name: string) => `https://${name}.pit.world/`
export const RING_HOME = 'https://pit.world/ring'
/** The mirror of this ring on rssamplifier.com, where members' feeds are read. */
export const RSS_RING = 'https://rssamplifier.com/ring/pit-world'

export type RingSite = {
  /** The hostname, which is also the site's id in the ring. */
  name: string
  /** One line on what it is. */
  about: string
  /** True for a Moshpit name, which needs Moshpit DNS (or the pit.world proxy) to open. */
  moshpit: boolean
  /** True when the site is in the ring because its listing was claimed on pit.world. */
  listing?: boolean
  /** Its RSS/Atom feed, when it has one. */
  feed?: string
}

/** A claimed listing, as the ring sees it (Listings.ringMembers()). */
export type ListingMember = { domain: string; name: string; description: string; moshpitOnly: boolean; feed: string }

/** The core of the ring, always first, in this order. */
export const RING: RingSite[] = [
  { name: 'pit.world', about: 'Private search, and the front door of the Moshpit network.', moshpit: false, feed: 'https://pit.world/b/feed.xml' },
  { name: 'seo.rank', about: 'Free, open-source on-page SEO audit. API, CLI and MCP.', moshpit: true },
  { name: 'family.ancestry', about: 'Your family tree, on your own name. Import GEDCOM, share by link.', moshpit: true },
  { name: 'pay.agent', about: 'Get paid in crypto with one link. Sign in with CoinPay; people and agents pay you by name.', moshpit: true },
  { name: 'built.indie', about: 'Launch your indie product with one URL. We fetch the rest; people upvote; you get a badge.', moshpit: true, feed: 'https://built.indie.pit.world/feed.xml' },
  { name: 'ad.network.pit.world', about: 'Run ads, or earn from your site, in crypto. Paste a link and a budget, or one tag and a wallet.', moshpit: false },
]

let source: (() => ListingMember[]) | null = null

/** Where the claimed listings come from; createApp sets it when listings are on. */
export function useListings(members: (() => ListingMember[]) | null): void {
  source = members
}

/** Every member, in ring order: the core, then claimed listings. A claimed core site keeps its core place. */
export function ringSites(): RingSite[] {
  const listed = source?.() ?? []
  const byName = new Map(listed.map((m) => [m.domain, m]))
  const core = RING.map((s) => {
    const m = byName.get(s.name)
    return m ? { ...s, listing: true, ...(m.feed ? { feed: m.feed } : {}) } : s
  })
  const extra = listed
    .filter((m) => !RING.some((s) => s.name === m.domain))
    .map((m): RingSite => ({ name: m.domain, about: m.description || `${m.name} on pit.world`, moshpit: m.moshpitOnly, listing: true, ...(m.feed ? { feed: m.feed } : {}) }))
  return [...core, ...extra]
}

/** Where a link to `site` should point, given whether the visitor can resolve Moshpit names. */
export function siteHref(site: RingSite, direct: boolean): string {
  return site.moshpit && !direct ? proxyUrl(site.name) : `https://${site.name}/`
}

/** `https://www.Seo.Rank/page?x` -> `seo.rank`. */
export function hostOf(value: string | undefined | null): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]!
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '')
}

export function findSite(name: string | undefined, sites: RingSite[] = ringSites()): RingSite | undefined {
  const host = hostOf(name)
  return sites.find((s) => s.name === host)
}

/** The sites either side of `from`, wrapping round. An unknown `from` starts at the top of the ring. */
export function neighbors(from: string | undefined, sites: RingSite[] = ringSites()): { prev: RingSite; next: RingSite } {
  const current = findSite(from, sites)
  const i = current ? sites.indexOf(current) : -1
  const at = i < 0 ? 0 : i
  const step = i < 0 ? 0 : 1
  return { prev: sites[(at - step + sites.length) % sites.length]!, next: sites[(at + step) % sites.length]! }
}

/** Any member but `from` (when there is a choice). */
export function randomSite(from: string | undefined, rand = Math.random, sites: RingSite[] = ringSites()): RingSite {
  const current = findSite(from, sites)
  const others = sites.filter((s) => s !== current)
  const pool = others.length ? others : sites
  return pool[Math.floor(rand() * pool.length)]!
}

/** The /api/ring document. Members render their bar from this. */
export function ringJson() {
  const sites = ringSites()
  return {
    name: 'The pit.world ring',
    home: RING_HOME,
    proxy: 'https://<name>.pit.world/',
    mirror: RSS_RING,
    count: sites.length,
    sites: sites.map((s) => ({ ...s, listing: Boolean(s.listing), url: `https://${s.name}/`, proxyUrl: s.moshpit ? proxyUrl(s.name) : `https://${s.name}/` })),
  }
}

/** How many sites the bar names between its arrows; the rest are one click away on /ring. */
const BAR_SITES = 5

/**
 * The bar itself. `from` marks the current site; `direct` says whether this
 * visitor reached Moshpit names on their own (see siteHref).
 */
export function ringBar(from: string, direct: boolean): string {
  const sites = ringSites()
  const { prev, next } = neighbors(from, sites)
  const current = findSite(from, sites)
  const link = (s: RingSite, text = s.name) =>
    `<a href="${esc(siteHref(s, direct))}"${s === current ? ' aria-current="page"' : ''} title="${esc(s.about)}">${esc(text)}</a>`
  const random = `${RING_HOME}/random?from=${encodeURIComponent(current?.name ?? '')}${direct ? '&direct=1' : ''}`
  const shown = sites.slice(0, BAR_SITES).map((s) => link(s))
  if (sites.length > BAR_SITES) shown.push(`<a href="${RING_HOME}">+${sites.length - BAR_SITES} more</a>`)
  return `<nav class="ring-bar" aria-label="pit.world ring">
  <a class="ring-home" href="${RING_HOME}">◉ <span>pit.world </span>ring</a>
  ${link(prev, `‹ ${prev.name}`)}
  <span class="ring-sites">${shown.join('')}</span>
  ${link(next, `${next.name} ›`)}
  <a href="${esc(random)}">random</a>
</nav>`
}

/**
 * The copy-paste links a member puts on its own pages: previous, the ring, random, next, and the
 * rssamplifier mirror (which is how rssamplifier sees that the site links back, and marks it active).
 */
export function ringSnippet(domain: string): string {
  const from = encodeURIComponent(`https://${domain}/`)
  return `<nav class="pit-ring" aria-label="pit.world ring">
  <a href="${RING_HOME}/prev?from=${from}">&larr; prev</a>
  <a href="${RING_HOME}">pit.world ring</a>
  <a href="${RING_HOME}/random?from=${from}">random</a>
  <a href="${RING_HOME}/next?from=${from}">next &rarr;</a>
  <a href="${RSS_RING}">feeds</a>
</nav>`
}
