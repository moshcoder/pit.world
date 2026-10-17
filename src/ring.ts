/**
 * The Moshpit web ring: a short list of sites that carry the same thin bar
 * across the top of every page, so a visitor can walk from one to the next.
 *
 * pit.world is the source of truth. Member sites read /api/ring and draw the
 * bar themselves (server-side, so it works with JavaScript off and needs no
 * CSP exception); /ring/next, /ring/prev and /ring/random are plain redirects
 * for a site that would rather paste three static links.
 *
 * A Moshpit name only opens for a visitor on Moshpit DNS. Everyone else gets
 * the registry gateway, which fetches the name's homepage through Moshpit DoH
 * and serves it on an ICANN hostname: https://pit.moshcode.sh/n/<name>.
 */
// Its own escaper, so html.ts can import this module without a cycle.
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)

export const GATEWAY = 'https://pit.moshcode.sh/n/'
export const RING_HOME = 'https://pit.world/ring'

export type RingSite = {
  /** The hostname, which is also the site's id in the ring. */
  name: string
  /** One line on what it is. */
  about: string
  /** True for a Moshpit name, which needs Moshpit DNS (or the gateway) to open. */
  moshpit: boolean
}

/** Ring order. Add a site here, and every member's bar picks it up within ten minutes. */
export const RING: RingSite[] = [
  { name: 'pit.world', about: 'Private search, and the front door of the Moshpit network.', moshpit: false },
  { name: 'seo.rank', about: 'Free, open-source on-page SEO audit. API, CLI and MCP.', moshpit: true },
  { name: 'family.ancestry', about: 'Your family tree, on your own name. Import GEDCOM, share by link.', moshpit: true },
]

/** Where a link to `site` should point, given whether the visitor can resolve Moshpit names. */
export function siteHref(site: RingSite, direct: boolean): string {
  return site.moshpit && !direct ? `${GATEWAY}${site.name}` : `https://${site.name}/`
}

export function findSite(name: string | undefined): RingSite | undefined {
  const host = String(name ?? '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  return RING.find((s) => s.name === host)
}

/** The sites either side of `from`, wrapping round. An unknown `from` starts at the top of the ring. */
export function neighbors(from: string | undefined): { prev: RingSite; next: RingSite } {
  const i = RING.findIndex((s) => s === findSite(from))
  const at = i < 0 ? 0 : i
  const step = i < 0 ? 0 : 1
  return { prev: RING[(at - step + RING.length) % RING.length]!, next: RING[(at + step) % RING.length]! }
}

/** Any member but `from` (when there is a choice). */
export function randomSite(from: string | undefined, rand = Math.random): RingSite {
  const others = RING.filter((s) => s !== findSite(from))
  const pool = others.length ? others : RING
  return pool[Math.floor(rand() * pool.length)]!
}

/** The /api/ring document. Members render their bar from this. */
export function ringJson() {
  return {
    name: 'The Moshpit ring',
    home: RING_HOME,
    gateway: GATEWAY,
    sites: RING.map((s) => ({ ...s, url: `https://${s.name}/`, gatewayUrl: s.moshpit ? `${GATEWAY}${s.name}` : `https://${s.name}/` })),
  }
}

/**
 * The bar itself. `from` marks the current site; `direct` says whether this
 * visitor reached Moshpit names on their own (see siteHref).
 */
export function ringBar(from: string, direct: boolean): string {
  const { prev, next } = neighbors(from)
  const current = findSite(from)
  const link = (s: RingSite, text = s.name) =>
    `<a href="${esc(siteHref(s, direct))}"${s === current ? ' aria-current="page"' : ''} title="${esc(s.about)}">${esc(text)}</a>`
  const random = `${RING_HOME}/random?from=${encodeURIComponent(current?.name ?? '')}${direct ? '&direct=1' : ''}`
  return `<nav class="ring-bar" aria-label="Moshpit ring">
  <a class="ring-home" href="${RING_HOME}">◉ <span>Moshpit </span>ring</a>
  ${link(prev, `‹ ${prev.name}`)}
  <span class="ring-sites">${RING.map((s) => link(s)).join('')}</span>
  ${link(next, `${next.name} ›`)}
  <a href="${esc(random)}">random</a>
</nav>`
}
