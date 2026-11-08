/**
 * pit.world/directory: every *.pit.world site, filed by subject, the way Yahoo! and DMOZ
 * filed the web in the nineties. Top categories, subcategories, cross-listings, a "What's New"
 * page and a NEW! badge.
 *
 * Nobody maintains the list by hand. It is read from what the server already serves:
 *
 *  - /etc/nginx/pit-proxy-certs: a certificate per relayed Moshpit name and per owned multi-label
 *    host. The registry sweep (proxy.ts) issues one for every new Moshpit name within 15 minutes,
 *    so a name registered today is in the directory by the next refresh.
 *  - /etc/caddy/Caddyfile: the dev2 edge, which serves <app>.pwa.pit.world and owned hosts.
 *
 * Each site's own <title> and description are read every few hours. A site that does not answer
 * is left out until it does. Known sites are filed by hand below (FILED); anything new is filed by
 * keywords in its name, title and description (RULES), or under New Arrivals when nothing fits,
 * so adding a domain never needs a code change; filing it better is a one-line PR to FILED.
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { docPage, esc } from './html.js'
import { RING } from './ring.js'

export type Subcategory = { slug: string; name: string }
export type Category = { slug: string; name: string; subs: Subcategory[] }

const cat = (slug: string, name: string, subs: Record<string, string>): Category => ({
  slug,
  name,
  subs: Object.entries(subs).map(([s, n]) => ({ slug: s, name: n })),
})

/** The top of the tree, in Yahoo's order. Empty categories and subcategories are never shown. */
export const CATEGORIES: Category[] = [
  cat('arts', 'Arts & Humanities', { 'fine-art': 'Fine Art', photography: 'Photography', crafts: 'Crafts', collectibles: 'Collectibles', 'body-art': 'Body Art' }),
  cat('business', 'Business & Economy', { payments: 'Crypto & Payments', shopping: 'Shopping & Auctions', advertising: 'Advertising', investing: 'Investing', jobs: 'Jobs', travel: 'Business Travel' }),
  cat('computers', 'Computers & Internet', {
    ai: 'Artificial Intelligence',
    security: 'Security',
    'web-dev': 'Web Development & SEO',
    software: 'Software',
    hosting: 'Hosting & Storage',
    communication: 'Communication',
    bbs: 'BBSes & Forums',
    networking: 'Networking Tools',
    hardware: 'Hardware',
  }),
  cat('entertainment', 'Entertainment', { radio: 'Radio & TV', music: 'Music & Concerts', games: 'Games' }),
  cat('health', 'Health', { medicine: 'Medicine & Telehealth', peptides: 'Peptides', cannabis: 'Cannabis' }),
  cat('news', 'News & Media', { podcasts: 'Podcasts', news: 'News', alerts: 'Alerts & Incidents', transcription: 'Transcription' }),
  cat('recreation', 'Recreation & Sports', { food: 'Food & Drink', tobacco: 'Tobacco & Cigars', autos: 'Automotive' }),
  cat('reference', 'Reference', { legal: 'Legal', public: 'Public Services' }),
  cat('society', 'Society & Culture', { genealogy: 'Genealogy', family: 'Family', community: 'Community', people: 'Personal Home Pages' }),
  cat('new', 'New Arrivals', { unfiled: 'Not Yet Filed' }),
]

/** Hand-filed sites: host -> "category/subcategory" paths, the first is where it mainly lives. */
export const FILED: Record<string, string[]> = {
  'ad.network.pit.world': ['business/advertising'],
  'agent.bbs.pit.world': ['computers/bbs', 'computers/ai'],
  'agent.database.pit.world': ['computers/ai', 'computers/software'],
  'alt.2600.pit.world': ['computers/bbs', 'computers/security'],
  'alt.cyberpunk.pit.world': ['computers/bbs', 'society/community'],
  'art.auctions.pit.world': ['arts/fine-art', 'business/shopping'],
  'auctions.pit.world': ['business/shopping', 'arts/fine-art'],
  'auto.hacker.pit.world': ['computers/security'],
  'built.indie.pit.world': ['computers/software', 'computers/web-dev'],
  'chovy.hacker.pit.world': ['society/people', 'computers/security'],
  'chuck.duh.pit.world': ['society/people'],
  'daily.stitcher.pit.world': ['arts/crafts'],
  'deadman.switch.pit.world': ['business/payments', 'computers/security'],
  'demo.indie.pit.world': ['computers/hosting'],
  'family.ancestry.pit.world': ['society/genealogy', 'society/family'],
  'family.tree.pit.world': ['society/genealogy', 'society/family'],
  'fineprint.agent.pit.world': ['reference/legal', 'computers/ai'],
  'group.call.pit.world': ['computers/communication', 'computers/ai'],
  'hawaiian.chicken.pit.world': ['recreation/food'],
  'live.streaming.pit.world': ['entertainment/radio', 'entertainment/music'],
  'mums.flower.pit.world': ['society/family', 'business/shopping'],
  'number.station.pit.world': ['entertainment/radio'],
  'offtherecord.podcast.pit.world': ['news/podcasts'],
  'otr.podcast.pit.world': ['news/podcasts'],
  'pay.agent.pit.world': ['business/payments'],
  'pay.crypto.pit.world': ['business/payments'],
  'pics.collage.pit.world': ['arts/photography'],
  'profullstack.agent.pit.world': ['computers/ai'],
  'resident.alerts.pit.world': ['news/alerts', 'reference/public'],
  'search.peptides.pit.world': ['health/peptides', 'business/shopping'],
  'seo.rank.pit.world': ['computers/web-dev'],
  'server.abhishek.pit.world': ['society/people', 'computers/hosting'],
  'watch.wallet.pit.world': ['business/payments', 'news/alerts'],
  'my.ip.pit.world': ['computers/networking'],
  'webmail.pit.world': ['computers/communication'],
  'advis0r.pwa.pit.world': ['business/investing'],
  'agenticjobs.pwa.pit.world': ['business/jobs'],
  'aiornot.pwa.pit.world': ['computers/ai', 'entertainment/games'],
  'avenasea.pwa.pit.world': ['business/travel'],
  'bg0ne.pwa.pit.world': ['arts/photography', 'computers/ai'],
  'brisk.pwa.pit.world': ['news/news'],
  'c0ncerts.pwa.pit.world': ['entertainment/music'],
  'c0upons.pwa.pit.world': ['business/shopping'],
  'cigarunderground.pwa.pit.world': ['recreation/tobacco'],
  'd1sks.pwa.pit.world': ['computers/hosting'],
  'd3vices.pwa.pit.world': ['computers/hardware'],
  'datamart.pwa.pit.world': ['reference/public'],
  'getprivacycode.pwa.pit.world': ['computers/ai', 'computers/security'],
  'goingbroke.pwa.pit.world': ['business/payments'],
  'icemap.pwa.pit.world': ['news/alerts'],
  'media2markdown.pwa.pit.world': ['computers/software', 'news/transcription'],
  'naallo.pwa.pit.world': ['arts/body-art', 'recreation/autos'],
  'opensocial.pwa.pit.world': ['computers/communication'],
  'opensourcelegends.pwa.pit.world': ['arts/collectibles', 'computers/software'],
  'recipepdfs.pwa.pit.world': ['recreation/food'],
  'ringhuman.pwa.pit.world': ['computers/communication', 'computers/ai'],
  'saasrow.pwa.pit.world': ['computers/software'],
  'submitfleet.pwa.pit.world': ['computers/web-dev'],
  'sysops.pwa.pit.world': ['society/people'],
  'tleehealth.pwa.pit.world': ['health/medicine'],
  'tsbb.pwa.pit.world': ['computers/bbs', 'computers/software'],
  'typeheard.pwa.pit.world': ['news/transcription'],
  'weedforcrypto.pwa.pit.world': ['health/cannabis', 'business/payments'],
}

/** How a site nobody has filed yet gets filed: first two rules that match its name, title and description. */
const RULES: Array<[RegExp, string]> = [
  [/podcast/, 'news/podcasts'],
  [/peptide/, 'health/peptides'],
  [/cannabis|\bweed\b|dispensar/, 'health/cannabis'],
  [/genealog|ancestr|family tree/, 'society/genealogy'],
  [/pentest|vulnerab|\bhack|security/, 'computers/security'],
  [/\bseo\b|backlink/, 'computers/web-dev'],
  [/\bbbs\b|forum|bulletin board|^alt\./, 'computers/bbs'],
  [/\bradio\b|\bstation|\btv\b|live ?stream/, 'entertainment/radio'],
  [/concert|music|\bband\b/, 'entertainment/music'],
  [/wallet|crypto|bitcoin|usdc|\bpay\b|payment/, 'business/payments'],
  [/auction|coupon|\bshop\b|\bstore\b/, 'business/shopping'],
  [/advertis|\bads\b/, 'business/advertising'],
  [/\bjobs?\b|hiring|career/, 'business/jobs'],
  [/stock|invest/, 'business/investing'],
  [/\bagents?\b|\bai\b|\bllm/, 'computers/ai'],
  [/hosting|\bserver\b|storage|\bdisk|deploy/, 'computers/hosting'],
  [/\bcall\b|\bchat\b|webmail|messag/, 'computers/communication'],
  [/telehealth|clinic|patient|doctor|medic/, 'health/medicine'],
  [/\bnews\b|headline/, 'news/news'],
  [/alert|incident|\b911\b|emergenc/, 'news/alerts'],
  [/transcri/, 'news/transcription'],
  [/recipe|\bfood\b|chicken|cook|restaurant/, 'recreation/food'],
  [/cigar|tobacco/, 'recreation/tobacco'],
  [/lawyer|\blegal\b|terms of service/, 'reference/legal'],
  [/photo|collage|picture/, 'arts/photography'],
  [/quilt|craft|stitch|knit/, 'arts/crafts'],
  [/\bart\b|artist|gallery/, 'arts/fine-art'],
  [/\bgame|\bplay\b/, 'entertainment/games'],
  [/open.source|software|\bapp\b/, 'computers/software'],
]

export function fileSite(host: string, text: string): string[] {
  const hand = FILED[host]
  if (hand) return hand
  const hay = `${host.replace(/\.pit\.world$/, '').replace(/\.pwa$/, '')} ${text}`.toLowerCase()
  const found: string[] = []
  for (const [re, path] of RULES) if (re.test(hay) && !found.includes(path) && found.push(path) >= 2) break
  return found.length ? found : ['new/unfiled']
}

/** Hosts that are plumbing, not sites: wildcards, the apex, per-name boards and feeds, app backends. */
export function listable(host: string): boolean {
  if (!host.endsWith('.pit.world') || host.includes('*')) return false
  if (host === 'www.pit.world' || /^(bbs|social|rsend|wildcard|www)\./.test(host)) return false
  if (/-(supabase|bbs)\.pwa\.pit\.world$/.test(host)) return false
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.pit\.world$/.test(host)
}

const HOST_RE = /(?<![a-z0-9.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+pit\.world)(?![a-z0-9-])/g

/** Every *.pit.world host this box serves, read from the relay certificates and the edge config. */
export function liveHosts(options: { certDir?: string; configs?: string[]; extra?: string[] } = {}): string[] {
  const found = new Set<string>(options.extra ?? ['my.ip.pit.world'])
  const certDir = options.certDir ?? '/etc/nginx/pit-proxy-certs'
  try {
    for (const f of readdirSync(certDir)) if (f.endsWith('.pit.world.crt')) found.add(f.slice(0, -4))
  } catch {
    // Not on dev2 (tests, a laptop): the edge config may still be there.
  }
  for (const file of options.configs ?? ['/etc/caddy/Caddyfile']) {
    try {
      for (const m of readFileSync(file, 'utf8').toLowerCase().matchAll(HOST_RE)) found.add(m[1]!)
    } catch {
      // Missing config: nothing from it.
    }
  }
  return [...found].filter(listable).sort()
}

export type SiteMeta = { title: string; description: string; ok: boolean; checked: number }

export type Entry = {
  host: string
  url: string
  name: string
  about: string
  /** "category/sub" paths, primary first. */
  paths: string[]
  /** When the directory first saw it, or 0 for the sites it started with. */
  added: number
  /** In the pit.world ring's core: Yahoo's sunglasses. */
  cool: boolean
}

type State = { seen: Record<string, number>; meta: Record<string, SiteMeta> }

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim()

export function parseMeta(html: string): { title: string; description: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''
  const tag =
    html.match(/<meta\s[^>]*name=["']description["'][^>]*>/i)?.[0] ?? html.match(/<meta\s[^>]*property=["']og:description["'][^>]*>/i)?.[0] ?? ''
  const description = tag.match(/content=["']([^"']*)["']/i)?.[1] ?? ''
  return { title: decode(title).slice(0, 200), description: decode(description).slice(0, 300) }
}

const ringAbout = (host: string) => RING.find((r) => r.name === host || `${r.name}.pit.world` === host)

function displayName(host: string, title: string): string {
  if (!host.endsWith('.pwa.pit.world')) return host.replace(/\.pit\.world$/, '')
  const first = title.split(/\s+[—–|·:-]\s+|\s*[|·]\s*/)[0]?.trim()
  return first && first.length <= 40 ? first : host.split('.')[0]!
}

export type DirectoryOptions = {
  hosts?: () => string[]
  file?: string
  fetch?: typeof fetch
  now?: () => number
  /** How long a site's title and status are trusted. */
  metaTtl?: number
}

export class Directory {
  private state: State = { seen: {}, meta: {} }
  private hosts: string[] = []
  private refreshedAt = 0
  private running: Promise<void> | null = null
  private readonly now: () => number

  constructor(private readonly options: DirectoryOptions = {}) {
    this.now = options.now ?? Date.now
    try {
      if (options.file && existsSync(options.file)) {
        const saved = JSON.parse(readFileSync(options.file, 'utf8')) as Partial<State>
        this.state = { seen: saved.seen ?? {}, meta: saved.meta ?? {} }
      }
    } catch (e) {
      console.error(`directory: could not read ${options.file}: ${(e as Error).message}`)
    }
    this.readHosts()
  }

  private readHosts() {
    const first = Object.keys(this.state.seen).length === 0
    this.hosts = (this.options.hosts ?? liveHosts)()
    // The sites the directory starts with are not news; everything after that is.
    for (const h of this.hosts) if (!(h in this.state.seen)) this.state.seen[h] = first ? 0 : this.now()
    this.refreshedAt = this.now()
  }

  /** Re-read the host list and re-check any site whose title is stale. */
  refresh(): Promise<void> {
    if (this.running) return this.running
    this.running = (async () => {
      this.readHosts()
      const ttl = this.options.metaTtl ?? 6 * 3_600_000
      const stale = this.hosts.filter((h) => !this.state.meta[h] || this.now() - this.state.meta[h]!.checked > ttl)
      const queue = [...stale]
      const worker = async () => {
        for (let h = queue.shift(); h; h = queue.shift()) this.state.meta[h] = await this.check(h)
      }
      await Promise.all(Array.from({ length: 4 }, worker))
      this.save()
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** Refresh in the background when the list is older than 15 minutes; pages never wait for it. */
  touch() {
    if (this.now() - this.refreshedAt > 15 * 60_000) void this.refresh().catch((e) => console.error(`directory refresh: ${(e as Error).message}`))
  }

  private async check(host: string): Promise<SiteMeta> {
    const checked = this.now()
    try {
      // Only hosts read from this server's own certificates and edge config are ever fetched.
      const res = await (this.options.fetch ?? fetch)(`https://${host}/`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(8_000),
        headers: { 'user-agent': 'pit.world directory (https://pit.world/directory)', accept: 'text/html' },
      })
      if (!res.ok) return { ...(this.state.meta[host] ?? { title: '', description: '' }), ok: false, checked }
      const html = (await res.text()).slice(0, 200_000)
      return { ...parseMeta(html), ok: true, checked }
    } catch {
      return { ...(this.state.meta[host] ?? { title: '', description: '' }), ok: false, checked }
    }
  }

  private save() {
    if (!this.options.file) return
    try {
      const tmp = `${this.options.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state))
      renameSync(tmp, this.options.file)
    } catch (e) {
      console.error(`directory: could not save ${this.options.file}: ${(e as Error).message}`)
    }
  }

  /** The sites to list: every live host that answered its last check (or has not been checked yet). */
  entries(): Entry[] {
    return this.hosts
      .filter((h) => this.state.meta[h]?.ok !== false)
      .map((host) => {
        const meta = this.state.meta[host]
        const ring = ringAbout(host)
        const name = displayName(host, meta?.title ?? '')
        const raw = ring?.about || meta?.description || meta?.title || ''
        // A site whose only metadata is its own name has nothing to add after the link.
        const about = raw.toLowerCase() === name.toLowerCase() || raw.toLowerCase() === host ? '' : raw
        return {
          host,
          url: `https://${host}/`,
          name,
          about,
          paths: fileSite(host, `${meta?.title ?? ''} ${about}`),
          added: this.state.seen[host] ?? 0,
          cool: !!ring,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Hosts left out because they did not answer. */
  down(): string[] {
    return this.hosts.filter((h) => this.state.meta[h]?.ok === false)
  }
}

// ---------------------------------------------------------------- pages

const NEW_FOR = 14 * 86_400_000

type View = { entries: Entry[]; down: number; now: number }

const inPath = (e: Entry, path: string) => e.paths.some((p) => p === path || p.startsWith(`${path}/`))
const count = (v: View, path: string) => v.entries.filter((e) => inPath(e, path)).length
const href = (path: string) => `/directory/${path}`

function badges(e: Entry, now: number): string {
  return `${e.added && now - e.added < NEW_FOR ? ' <span class="dir-new">NEW!</span>' : ''}${e.cool ? ' <span class="dir-cool" title="In the pit.world ring">&#9733;</span>' : ''}`
}

function crossList(e: Entry, here: string): string {
  const others = e.paths.filter((p) => p !== here)
  if (!others.length) return ''
  return ` <span class="dir-also">Also in: ${others
    .map((p) => {
      const [c, s] = p.split('/')
      const category = CATEGORIES.find((x) => x.slug === c)
      const sub = category?.subs.find((x) => x.slug === s)
      return category && sub ? `<a href="${href(p)}">${esc(category.name)} &gt; ${esc(sub.name)}</a>` : ''
    })
    .filter(Boolean)
    .join(', ')}</span>`
}

function siteList(v: View, list: Entry[], here = ''): string {
  if (!list.length) return '<p class="muted">No sites here yet.</p>'
  return `<ul class="dir-sites">${list
    .map(
      (e) =>
        `<li><a href="${esc(e.url)}">${esc(e.name)}</a>${badges(e, v.now)}${e.about ? ` - ${esc(e.about)}` : ''} <span class="dir-host">${esc(e.host)}</span>${here ? crossList(e, here) : ''}</li>`,
    )
    .join('')}</ul>`
}

const searchBox = (q = '') =>
  `<form class="dir-search" action="/directory" method="get" role="search"><input type="search" name="q" value="${esc(q)}" placeholder="Search the directory" aria-label="Search the directory"><button type="submit">Search</button> <a href="/directory/new">What's New</a> · <a href="/ring/random">Random Link</a></form>`

const legend = (v: View) =>
  `<p class="dir-legend"><span class="dir-new">NEW!</span> added in the last two weeks · <span class="dir-cool">&#9733;</span> in the <a href="/ring">pit.world ring</a>${v.down ? ` · ${v.down} site${v.down === 1 ? '' : 's'} not answering right now, listed again when they are back` : ''}</p>`

const footer = `<h2>Add your site</h2>
<p>Every <code>*.pit.world</code> site is listed on its own: register a Moshpit name and it is relayed at <code>&lt;name&gt;.pit.world</code> and shows up here within the hour, filed by what its homepage says it is. A good <code>&lt;title&gt;</code> and meta description get you filed in the right place. <a href="/connect">Get on Moshpit</a> · <a href="/b">claim your listing</a> · <a href="/api/directory">this directory as JSON</a>.</p>`

export function directoryHome(v: View, q = ''): string {
  if (q.trim()) return directorySearch(v, q.trim())
  const cats = CATEGORIES.filter((c) => count(v, c.slug))
  const fresh = v.entries
    .filter((e) => e.added)
    .sort((a, b) => b.added - a.added)
    .slice(0, 5)
  return docPage({
    title: 'The pit.world Directory: every *.pit.world site by category',
    description: `A Yahoo-style directory of all ${v.entries.length} *.pit.world sites and Moshpit names, filed by subject and updated on its own as new ones go live.`,
    path: '/directory',
    body: `<h1>The pit.world Directory</h1>
<p class="lede">Every site on <code>*.pit.world</code>, filed by subject. ${v.entries.length} sites in ${cats.length} categories, kept up to date by itself: a new Moshpit name or pit.world site shows up here on its own.</p>
${searchBox()}
<div class="dir-cats">${cats
      .map((c) => {
        const subs = c.subs.filter((s) => count(v, `${c.slug}/${s.slug}`))
        return `<section><h2><a href="${href(c.slug)}">${esc(c.name)}</a> <small>(${count(v, c.slug)})</small></h2><p>${subs
          .map((s) => `<a href="${href(`${c.slug}/${s.slug}`)}">${esc(s.name)}</a>`)
          .join(', ')}...</p></section>`
      })
      .join('')}</div>
${fresh.length ? `<h2>What's New</h2>${siteList(v, fresh)}<p><a href="/directory/new">All new sites</a></p>` : ''}
${legend(v)}
${footer}`,
  })
}

export function directoryCategory(v: View, slug: string): string | null {
  const c = CATEGORIES.find((x) => x.slug === slug)
  if (!c) return null
  const subs = c.subs.filter((s) => count(v, `${c.slug}/${s.slug}`))
  return docPage({
    title: `${c.name} · The pit.world Directory`,
    description: `*.pit.world sites in ${c.name}: ${subs.map((s) => s.name).join(', ')}.`,
    path: href(c.slug),
    body: `<p class="dir-crumbs"><a href="/directory">Top</a> &gt; ${esc(c.name)}</p>
<h1>${esc(c.name)}</h1>
${searchBox()}
<ul class="dir-subs">${subs.map((s) => `<li><a href="${href(`${c.slug}/${s.slug}`)}"><b>${esc(s.name)}</b></a> (${count(v, `${c.slug}/${s.slug}`)})</li>`).join('')}</ul>
${subs
  .map((s) => {
    const path = `${c.slug}/${s.slug}`
    return `<h2><a href="${href(path)}">${esc(s.name)}</a></h2>${siteList(v, v.entries.filter((e) => e.paths.includes(path)), path)}`
  })
  .join('')}
${legend(v)}`,
  })
}

export function directorySubcategory(v: View, slug: string, subSlug: string): string | null {
  const c = CATEGORIES.find((x) => x.slug === slug)
  const s = c?.subs.find((x) => x.slug === subSlug)
  if (!c || !s) return null
  const path = `${c.slug}/${s.slug}`
  const list = v.entries.filter((e) => e.paths.includes(path))
  const siblings = c.subs.filter((x) => x.slug !== s.slug && count(v, `${c.slug}/${x.slug}`))
  return docPage({
    title: `${s.name} · ${c.name} · The pit.world Directory`,
    description: `${list.length} *.pit.world site${list.length === 1 ? '' : 's'} in ${c.name} > ${s.name}.`,
    path: href(path),
    body: `<p class="dir-crumbs"><a href="/directory">Top</a> &gt; <a href="${href(c.slug)}">${esc(c.name)}</a> &gt; ${esc(s.name)}</p>
<h1>${esc(s.name)}</h1>
${searchBox()}
<h2>Site Listings</h2>
${siteList(v, list, path)}
${siblings.length ? `<p class="dir-related">More in ${esc(c.name)}: ${siblings.map((x) => `<a href="${href(`${c.slug}/${x.slug}`)}">${esc(x.name)}</a>`).join(' · ')}</p>` : ''}
${legend(v)}`,
  })
}

export function directoryNew(v: View): string {
  const list = v.entries.filter((e) => e.added).sort((a, b) => b.added - a.added)
  const day = (t: number) => new Date(t).toISOString().slice(0, 10)
  const days = [...new Set(list.map((e) => day(e.added)))]
  return docPage({
    title: "What's New · The pit.world Directory",
    description: 'The newest *.pit.world sites and Moshpit names, by the day they went live.',
    path: '/directory/new',
    body: `<p class="dir-crumbs"><a href="/directory">Top</a> &gt; What's New</p>
<h1>What's New</h1>
${searchBox()}
${days.length ? days.map((d) => `<h2>${d}</h2>${siteList(v, list.filter((e) => day(e.added) === d), '')}`).join('') : '<p>Nothing new since the directory opened. New Moshpit names and pit.world sites land here the day they go live.</p>'}
${legend(v)}`,
  })
}

function directorySearch(v: View, q: string): string {
  const needle = q.toLowerCase()
  const sites = v.entries.filter((e) => `${e.host} ${e.name} ${e.about}`.toLowerCase().includes(needle))
  const cats = CATEGORIES.flatMap((c) =>
    c.subs.filter((s) => count(v, `${c.slug}/${s.slug}`) && `${c.name} ${s.name}`.toLowerCase().includes(needle)).map((s) => ({ c, s })),
  )
  return docPage({
    title: `${q} · The pit.world Directory`,
    description: `Directory matches for ${q}.`,
    path: '/directory',
    noindex: true,
    body: `<p class="dir-crumbs"><a href="/directory">Top</a> &gt; Search</p>
<h1>Found: ${esc(q)}</h1>
${searchBox(q)}
<h2>Category Matches (${cats.length})</h2>
${cats.length ? `<ul class="dir-subs">${cats.map(({ c, s }) => `<li><a href="${href(`${c.slug}/${s.slug}`)}">${esc(c.name)} &gt; <b>${esc(s.name)}</b></a></li>`).join('')}</ul>` : '<p class="muted">None.</p>'}
<h2>Site Matches (${sites.length})</h2>
${siteList(v, sites, '')}
<p>Not here? <a href="/search?q=${encodeURIComponent(q)}">Search the whole web for ${esc(q)}</a>.</p>`,
  })
}

export function directoryJson(v: View) {
  return {
    updated: new Date(v.now).toISOString(),
    count: v.entries.length,
    categories: CATEGORIES.filter((c) => count(v, c.slug)).map((c) => ({
      slug: c.slug,
      name: c.name,
      url: `https://pit.world${href(c.slug)}`,
      subcategories: c.subs
        .filter((s) => count(v, `${c.slug}/${s.slug}`))
        .map((s) => ({ slug: s.slug, name: s.name, url: `https://pit.world${href(`${c.slug}/${s.slug}`)}`, count: count(v, `${c.slug}/${s.slug}`) })),
    })),
    sites: v.entries.map((e) => ({
      host: e.host,
      url: e.url,
      name: e.name,
      about: e.about,
      categories: e.paths,
      added: e.added ? new Date(e.added).toISOString() : null,
    })),
  }
}

/** Every category page, for the sitemap. */
export function directoryPaths(v: View): string[] {
  return [
    '/directory',
    '/directory/new',
    ...CATEGORIES.flatMap((c) => (count(v, c.slug) ? [href(c.slug), ...c.subs.filter((s) => count(v, `${c.slug}/${s.slug}`)).map((s) => href(`${c.slug}/${s.slug}`))] : [])),
  ]
}

export function view(d: Directory, now = Date.now()): View {
  return { entries: d.entries(), down: d.down().length, now }
}
