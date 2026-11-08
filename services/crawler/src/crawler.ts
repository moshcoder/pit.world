/**
 * What the crawler does, with no queue in it: schedule a site, start a site
 * (robots.txt, sitemaps, home page), read a page, render a page, publish.
 * The BullMQ wiring (queues.ts) calls these; the tests call them directly
 * with an in-memory frontier and a fake web.
 */
import type { Config } from './config.ts'
import { extract, needsRender, type Extracted } from './extract.ts'
import { politeGet, readSitemapXml } from './fetcher.ts'
import { endpointsIn, handshake, mcpRecord, type McpJob, WELL_KNOWN } from './mcp.ts'
import { globalSources, interleave, isTsbbDescriptor, recognise, sampleInstances, searchInstance, type SocialPost, type SocialSite } from './social.ts'
import type { Frontier } from './frontier.ts'
import { MemorySiteStore, type SiteStore } from './site-store.ts'
import type { Rendered } from './obscura.ts'
import { aiDisallowed, allows, EMPTY, parseRobots, parseTdmrep, pathOf, tdmReserved, type Robots } from './robots.ts'
import { sitesFromOpml } from './seed.ts'
import { feedLinks, guessKind, sniff, type SubmitKind } from './submit.ts'
import { crawlable, normalizeUrl, resolvesPublic, sameSite, siteFromInput, siteOf, type Resolver } from './url.ts'

/** `first`: ahead of everything already waiting (seed --first). */
export type SiteJob = { site: string; source: string; first?: boolean }
/** `optOut`: a training reservation the page's headers made when it was first fetched (a render has no headers). */
export type PageJob = { url: string; site: string; depth: number; rendered?: boolean; optOut?: string }

export type Training = { allowed: boolean; reason: string }

/** A header reservation: X-Robots-Tag `noai`, or TDMRep's `tdm-reservation: 1`. '' when none. */
export function headerOptOut(headers: { robotsTag: string; tdmReservation: string } | null | undefined): string {
  if (!headers) return ''
  if (/(^|[\s,;:])noai\b/.test(headers.robotsTag)) return 'x-robots-tag: noai'
  if (headers.tdmReservation === '1') return 'tdm-reservation header'
  return ''
}

/**
 * Whether a page may go into the training corpus (/api/corpus). Search is a different use:
 * a page is indexed either way. Any reservation the publisher made wins: X-Robots-Tag or
 * meta robots `noai`, TDMRep (header, meta, /.well-known/tdmrep.json), or a robots.txt
 * group that keeps an AI-training crawler (AI_TRAINING_AGENTS) off the path.
 */
export function trainingFor(input: { robots: Robots; path: string; optOut?: string; noai: boolean; tdmMeta: boolean }): Training {
  if (input.optOut) return { allowed: false, reason: input.optOut }
  if (input.noai) return { allowed: false, reason: 'meta robots: noai' }
  if (input.tdmMeta) return { allowed: false, reason: 'tdm-reservation meta' }
  if (tdmReserved(input.robots.tdm, input.path)) return { allowed: false, reason: 'tdmrep.json' }
  const ai = aiDisallowed(input.robots, input.path)
  if (ai === null) return { allowed: false, reason: 'unknown: robots.txt not read for AI crawlers' }
  if (ai) return { allowed: false, reason: 'robots.txt disallows AI crawlers' }
  return { allowed: true, reason: 'no reservation' }
}

export type Enqueue = {
  sites(jobs: SiteJob[]): Promise<void>
  pages(jobs: PageJob[]): Promise<void>
  render(job: PageJob): Promise<void>
  /** MCP addresses to prove (src/mcp.ts). Unset, the crawl does not look for them. */
  mcp?(jobs: McpJob[]): Promise<void>
  /** True while the site queue holds enough: new sites then park in the site store instead. */
  sitesDeep?(): Promise<boolean>
}

export type Deps = {
  config: Config
  frontier: Frontier
  enqueue: Enqueue
  /** Every known site, parked or scheduled (Postgres in production). */
  sites?: SiteStore
  fetch?: typeof fetch
  resolver?: Resolver
  renderer?: { size: number; render(url: string): Promise<Rendered> } | null
  log?: (line: string) => void
  /** Page jobs queued now; a site start waits while it is over config.maxPageBacklog. */
  pageBacklog?: () => Promise<number>
  /** Offer a submitted feed to rssamplifier.com too (best effort). */
  forwardFeed?: (feedUrl: string) => Promise<void>
  /** The local search mirror; every published batch lands here first. */
  index?: { add(entries: string[]): number; setCard?(url: string, image: string | null, price: string | null): void } | null
}

export type PageOutcome = { delayMs?: number; outcome: string }

/** Links followed from one page; the rest of a link farm waits for another page to mention them. */
const LINKS_PER_PAGE = 300
const SITES_PER_PAGE = 25
const SITEMAP_DOCS = 6
const BATCH = 200
/** The longest a page waits for its turn at a busy site before asking again. */
const MAX_SPREAD_MS = 30 * 60_000

/**
 * When a site's slot is busy, wait for it to free plus a random share of the
 * site's backlog. Every page of a site waking each time the slot frees cost the
 * queue a move per page per gap (measured 2026-11-02: ~30,000 Redis ops per page
 * fetched, Redis pinned at one core); spread over the backlog, about one wakes per gap.
 */
export function spreadDelay(waitMs: number, pending: number, gapMs: number, random = Math.random): number {
  const turns = Math.max(0, pending - 1)
  return Math.min(MAX_SPREAD_MS, waitMs + Math.floor(random() * turns) * Math.max(gapMs, 1))
}

export function createCrawler(deps: Deps) {
  const { config, frontier, enqueue } = deps
  const siteStore = deps.sites ?? new MemorySiteStore()
  const resolver = deps.resolver ?? resolvesPublic
  const log = deps.log ?? (() => {})
  const get = (url: string, site: string, accept?: string) =>
    politeGet(url, { userAgent: config.userAgent, resolver, site, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(accept ? { accept } : {}) })

  /**
   * Sites pasted, seeded or discovered: known ones skipped, new ones recorded, and queued
   * now or parked while the site queue is deep. `first` (a submission, seed --first)
   * schedules even a known site and jumps the queue; a copy still waiting skips when it
   * comes up (claimStart).
   */
  async function scheduleSites(inputs: string[], source: string, options: { first?: boolean } = {}): Promise<{ queued: number; refused: number }> {
    const sites = [...new Set(inputs.map((input) => siteFromInput(input)).filter((s): s is string => Boolean(s)))]
    const rows = sites.map((site) => ({ site, source }))
    if (options.first) {
      await siteStore.force(rows)
      if (sites.length) await enqueue.sites(sites.map((site) => ({ site, source, first: true })))
      return { queued: sites.length, refused: inputs.length - sites.length }
    }
    try {
      if ((await siteStore.counts()).known >= config.maxSites) return { queued: 0, refused: inputs.length }
      const deep = (await enqueue.sitesDeep?.()) ?? false
      const fresh = await siteStore.add(rows, !deep)
      if (!deep && fresh.length) await enqueue.sites(fresh.map((site) => ({ site, source })))
      return { queued: fresh.length, refused: inputs.length - fresh.length }
    } catch (error) {
      // A frontier outage costs the links found meanwhile, never the page being read.
      log(`sites: ${sites.length} from ${source} not recorded: ${error instanceof Error ? error.message : error}`)
      return { queued: 0, refused: inputs.length }
    }
  }

  async function robotsFor(site: string): Promise<Robots | 'unavailable'> {
    const kept = await frontier.getRobots(site)
    // Cached before AI-crawler rules were kept: read again, so a training opt-out is never missed.
    if (kept && kept.ai) return kept
    let robots: Robots = EMPTY
    try {
      const r = await get(`https://${site}/robots.txt`, site, 'text/plain,*/*;q=0.5')
      // 5xx: the site cannot say, so it is read another day (Google's reading). 4xx: no rules.
      if (r.status >= 500) return 'unavailable'
      if (r.status < 400 && !/html/.test(r.contentType)) robots = parseRobots(r.body)
    } catch {
      robots = { ...EMPTY, read: 'error' }
    }
    // TDMRep's site-wide file: rarely there, read with robots.txt once a day.
    let tdm: Robots['tdm'] = []
    try {
      const t = await get(`https://${site}/.well-known/tdmrep.json`, site, 'application/json,*/*;q=0.1')
      if (t.status < 400 && /json|text\/plain|^$/.test(t.contentType)) tdm = parseTdmrep(t.body)
    } catch {
      tdm = []
    }
    robots = { ...robots, tdm }
    await frontier.setRobots(site, robots)
    return robots
  }

  /** Queue addresses for proving, each once a cycle however many pages mention it. */
  async function noteMcps(endpoints: string[], foundOn: string, descriptor = false): Promise<void> {
    if (!enqueue.mcp || !endpoints.length) return
    const fresh: McpJob[] = []
    for (const endpoint of endpoints) {
      if (await frontier.claimMcp(endpoint, config.recrawlDays * 86_400_000)) fresh.push({ endpoint, foundOn, ...(descriptor ? { descriptor } : {}) })
    }
    if (fresh.length) {
      await frontier.bump('mcp_candidates', fresh.length)
      await enqueue.mcp(fresh)
    }
  }

  async function noteSocial(found: SocialSite): Promise<void> {
    await frontier.saveSocial(found)
    await frontier.bump('social_found')
    await frontier.log({ kind: 'social', site: found.site, note: found.software })
  }

  /** Is this site a social network? Asked once per cycle, by the protocol it speaks. */
  async function recogniseSocial(site: string, robots: Robots): Promise<SocialSite | null> {
    const found = await recognise(site, async (path) => {
      if (!allows(robots, path)) return { status: 403, contentType: '', body: '' }
      return get(`https://${site}${path}`, site, 'application/json,text/html;q=0.5')
    }).catch(() => null)
    if (found) await noteSocial(found)
    return found
  }

  /** Recognise these sites now, without waiting for their next crawl cycle. */
  async function identifySocial(sites: string[]): Promise<Array<SocialSite | { site: string; adapter: null }>> {
    const out: Array<SocialSite | { site: string; adapter: null }> = []
    for (const input of sites) {
      const site = siteFromInput(input)
      if (!site) continue
      const robots = await robotsFor(site)
      let found = robots === 'unavailable' ? null : await recogniseSocial(site, robots)
      if (!found && robots !== 'unavailable') {
        await readMcpDescriptors(site, robots)
        found = (await frontier.listSocial()).find((s) => s.site === site) ?? null
      }
      out.push(found ?? { site, adapter: null })
    }
    return out
  }

  /**
   * One search across social networks: the two big public indexes, a fair sample of the sites
   * pitbot recognised, and pages in our own index that mark themselves as posts or threads. A
   * network that fails or runs long costs only itself. Asked here rather than from the web server:
   * these hostnames came off the open web, and this container cannot reach the host's services.
   */
  async function searchSocial(q: string, limit: number, ownPages: Array<{ url: string; title: string; site: string; summary?: string; fetched_at?: string }> = []): Promise<{ items: SocialPost[]; unavailable: boolean }> {
    const per = Math.min(25, Math.max(5, Math.ceil(limit / 2)))
    const getJson = (site?: string) => async (url: string) => {
      const r = await politeGet(url, { userAgent: config.userAgent, resolver, timeoutMs: 4_000, accept: 'application/json', ...(site ? { site } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) })
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      return JSON.parse(r.body)
    }
    const instances = sampleInstances(await frontier.listSocial())
    const asks: Array<Promise<SocialPost[]>> = [
      ...globalSources(q, per).map(async (s) => s.parse(await getJson()(s.url))),
      ...instances.map(async (instance) => {
        const robots = await robotsFor(instance.site)
        if (robots === 'unavailable') throw new Error('robots.txt unavailable')
        return searchInstance(getJson(instance.site), instance, q, per)
      }),
    ]
    const within = <T>(work: Promise<T>) => Promise.race([work, new Promise<T>((_, no) => setTimeout(() => no(new Error('too slow')), 6_000))])
    const settled = await Promise.allSettled(asks.map(within))
    const lists = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
    const own = ownPages.flatMap((p) => (p.url.startsWith('https://') ? [{ url: p.url, title: p.title, host: p.site, ...(p.summary ? { description: p.summary.slice(0, 300) } : {}), ...(p.fetched_at ? { date: p.fetched_at.slice(0, 10) } : {}) }] : []))
    return { items: interleave([...lists, own], limit), unavailable: !lists.length && !own.length }
  }

  /** What a site says about its own MCP server, read once per cycle at its start. */
  async function readMcpDescriptors(site: string, robots: Robots): Promise<void> {
    for (const path of WELL_KNOWN) {
      if (!allows(robots, path)) continue
      try {
        const r = await get(`https://${site}${path}`, site, 'application/json')
        if (r.status !== 200 || !/json/.test(r.contentType)) continue
        const doc = JSON.parse(r.body)
        if (isTsbbDescriptor(doc)) await noteSocial({ site, software: 'tsbb', adapter: 'tsbb', seenAt: new Date().toISOString() })
        await noteMcps(endpointsIn(doc), `https://${site}${path}`, true)
      } catch {
        // Not there, or not JSON: most sites have neither.
      }
    }
  }

  /** Ask one address MCP's handshake. Only a server that answers it is kept. */
  async function probeMcp(job: McpJob): Promise<{ outcome: string }> {
    const site = siteOf(job.endpoint)
    if (!site) return { outcome: 'not an address' }
    const robots = await robotsFor(site)
    if (robots === 'unavailable') return { outcome: 'robots.txt unavailable' }
    if (!allows(robots, pathOf(job.endpoint))) return { outcome: 'disallowed' }
    await frontier.bump('mcp_probed')
    const proof = await handshake(job.endpoint, { userAgent: config.userAgent, resolver, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).catch(() => null)
    if (!proof) return { outcome: 'not an MCP server' }
    const server = mcpRecord(job, proof)
    await frontier.saveMcp(server)
    await frontier.bump('mcp_found')
    await frontier.log({ kind: 'mcp', site, url: job.endpoint, title: server.name, note: `${server.tools.length} tools${server.auth === 'required' ? ', sign-in required' : ''}` })
    if (config.nichedbKey) {
      const response = await (deps.fetch ?? fetch)(`${config.nichedbUrl}/api/v1/mcp/records`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.nichedbKey}`, 'user-agent': config.userAgent },
        body: JSON.stringify({ records: [server] }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`nichedb answered HTTP ${response.status} for an MCP record`)
    }
    return { outcome: 'proved' }
  }

  /**
   * Product pages indexed before cards existed: read each once and keep its image and price, so
   * the index fills in where people actually look instead of re-crawling all of it. Up to 12 at a
   * time, each politely: robots.txt applies, and a site that says no gets an empty card.
   */
  async function fillCards(urls: string[]): Promise<void> {
    await Promise.all(
      urls.slice(0, 12).map(async (url) => {
        let image: string | null = null
        let price: string | null = null
        try {
          const site = siteOf(url)
          const robots = site ? await robotsFor(site) : 'unavailable'
          if (site && robots !== 'unavailable' && allows(robots, pathOf(url))) {
            const r = await politeGet(url, { userAgent: config.userAgent, resolver, site, timeoutMs: 8_000, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
            if (r.status < 400 && /html/.test(r.contentType)) {
              const doc = extract(r.body, normalizeUrl(r.finalUrl) ?? url, { crawler: config.userAgent })
              image = doc.record.image?.url ?? doc.enrichment.images[0]?.url ?? null
              price = doc.enrichment.price
            }
          }
        } catch (error) {
          log(`card ${url}: ${(error as Error).message}`)
        }
        deps.index?.setCard?.(url, image, price)
      }),
    )
  }

  const gapFor = (robots: Robots) => Math.max(config.hostDelayMs, Math.min(robots.crawlDelayMs ?? 0, config.maxDelayMs))

  async function admitAll(site: string, urls: string[], depth: number, robots: Robots): Promise<PageJob[]> {
    const jobs: PageJob[] = []
    for (const url of urls) {
      if (!crawlable(url) || !allows(robots, pathOf(url))) continue
      const verdict = await frontier.admit(site, url)
      if (verdict === 'full') break
      if (verdict === 'new') jobs.push({ url, site, depth })
    }
    return jobs
  }

  /** A site's start: robots.txt, then the home page and whatever its sitemaps list, up to maxPages. */
  async function crawlSite(job: SiteJob): Promise<{ admitted: number; outcome: string; delayMs?: number }> {
    const { site } = job
    // A seed of half a million sites must not become half a billion page jobs in Redis.
    // The worker gate (queues.ts) pauses site starts at the cap without losing places;
    // this is the hard stop past it (a delayed job comes back at the end of the queue).
    if (deps.pageBacklog && (await deps.pageBacklog()) > config.maxPageBacklog * 1.2) {
      return { admitted: 0, outcome: 'waiting for the page backlog', delayMs: 60_000 }
    }
    // Once per cycle per site, however many jobs for it are queued.
    if (!(await frontier.claimStart(site, config.recrawlDays * 86_400_000))) return { admitted: 0, outcome: 'already started this cycle' }
    if (!(await resolver(site))) {
      await frontier.bump('sites_refused')
      await frontier.log({ kind: 'skip', site, note: 'not on the public internet' })
      return { admitted: 0, outcome: 'not public' }
    }
    const robots = await robotsFor(site)
    if (robots === 'unavailable') {
      await frontier.bump('sites_unavailable')
      await frontier.log({ kind: 'skip', site, note: 'robots.txt answered 5xx; trying another day' })
      return { admitted: 0, outcome: 'robots.txt unavailable' }
    }
    if (!allows(robots, '/')) {
      await frontier.bump('sites_disallowed')
      await frontier.log({ kind: 'skip', site, note: 'robots.txt disallows pitbot' })
      return { admitted: 0, outcome: 'robots.txt disallows /' }
    }
    await readMcpDescriptors(site, robots)
    await recogniseSocial(site, robots)
    const home = `https://${site}/`
    const listed: string[] = []
    const queue = robots.sitemaps.length ? [...robots.sitemaps] : [`https://${site}/sitemap.xml`]
    for (let i = 0; i < queue.length && i < SITEMAP_DOCS && listed.length < config.maxPages; i++) {
      const sitemap = queue[i]!
      if (!sameSite(sitemap, site)) continue
      try {
        const r = await get(sitemap, site, 'application/xml,text/xml;q=0.9,*/*;q=0.1')
        if (r.status >= 400) continue
        const { urls, sitemaps } = readSitemapXml(r.body)
        queue.push(...sitemaps.slice(0, SITEMAP_DOCS))
        for (const u of urls) {
          const url = normalizeUrl(u)
          if (url && sameSite(url, site)) listed.push(url)
        }
      } catch (error) {
        log(`sitemap ${site}: ${(error as Error).message}`)
      }
    }
    const jobs = [...(await admitAll(site, [home], 0, robots)), ...(await admitAll(site, listed.slice(0, config.maxPages), 1, robots))]
    if (jobs.length) await enqueue.pages(jobs)
    await frontier.bump('sites_started')
    await frontier.bump('pages_queued', jobs.length)
    await frontier.log({ kind: 'site', site, note: `started: ${jobs.length} pages queued (${listed.length} in sitemaps)` })
    return { admitted: jobs.length, outcome: 'started' }
  }

  /** What a read page becomes: a record waiting for nichedb, and the next pages. */
  async function accept(doc: Extracted, job: PageJob, robots: Robots): Promise<string> {
    const rendered = doc.enrichment.rendered
    doc.enrichment.training = trainingFor({ robots, path: pathOf(doc.record.url), noai: doc.noai, tdmMeta: doc.tdmReserved, ...(job.optOut ? { optOut: job.optOut } : {}) })
    if (!doc.noindex) {
      await frontier.push([{ record: doc.record, enrichment: doc.enrichment }], config.outboxMax)
      await frontier.bump(rendered ? 'pages_rendered' : 'pages_indexed')
      if (doc.enrichment.images.length) await frontier.bump('images_found', doc.enrichment.images.length)
      if (doc.enrichment.videos.length) await frontier.bump('videos_found', doc.enrichment.videos.length)
    } else await frontier.bump('pages_noindex')
    let followed = 0
    if (job.depth < config.maxDepth && doc.internal.length) {
      const next = await admitAll(job.site, doc.internal.slice(0, LINKS_PER_PAGE), job.depth + 1, robots)
      if (next.length) {
        await enqueue.pages(next)
        await frontier.bump('pages_queued', next.length)
      }
      followed = next.length
    }
    await frontier.log({
      kind: doc.noindex ? 'skip' : rendered ? 'render' : 'page',
      site: job.site,
      url: doc.record.url,
      title: doc.record.title,
      note: doc.noindex ? 'noindex' : `${doc.enrichment.words} words${followed ? `, ${followed} new links` : ''}`,
    })
    if (config.discover && doc.external.length) await scheduleSites(doc.external.slice(0, SITES_PER_PAGE), 'link')
    await noteMcps(doc.mcp, doc.record.url)
    return doc.noindex ? 'noindex' : 'indexed'
  }

  async function crawlPage(job: PageJob): Promise<PageOutcome> {
    // Publishing is the slowest stage: reading faster than nichedb takes records only fills
    // the outbox until it drops them. Wait (a jittered half minute) while it is too full.
    if ((await frontier.outboxLength()) > config.outboxHigh) {
      return { delayMs: 20_000 + Math.floor(Math.random() * 20_000), outcome: 'waiting for publishing to catch up' }
    }
    const robots = await robotsFor(job.site)
    if (robots === 'unavailable') return { outcome: 'robots.txt unavailable' }
    const gap = gapFor(robots)
    const slot = await frontier.lease(job.site, gap)
    if (slot.waitMs > 0) return { delayMs: spreadDelay(slot.waitMs, slot.pending, gap), outcome: 'waiting for the site' }
    if (!allows(robots, pathOf(job.url))) {
      await frontier.bump('pages_disallowed')
      return { outcome: 'disallowed' }
    }
    const r = await get(job.url, job.site)
    if (r.offsite) {
      if (config.discover) await scheduleSites([r.offsite], 'redirect')
      return { outcome: `redirects to ${r.offsite}` }
    }
    if (r.status >= 400) {
      await frontier.bump('pages_failed')
      await frontier.log({ kind: 'fail', site: job.site, url: job.url, note: `HTTP ${r.status}` })
      return { outcome: `HTTP ${r.status}` }
    }
    if (!/html/.test(r.contentType)) return { outcome: `not a page (${r.contentType || 'no type'})` }
    const finalUrl = normalizeUrl(r.finalUrl) ?? job.url
    const doc = extract(r.body, finalUrl, { depth: job.depth, crawler: config.userAgent })
    const optOut = headerOptOut(r.optOut)
    if (!job.rendered && deps.renderer?.size && needsRender(r.body, doc.textLength)) {
      await enqueue.render({ ...job, rendered: true, ...(optOut ? { optOut } : {}) })
      await frontier.bump('render_queued')
      return { outcome: 'needs a browser' }
    }
    return { outcome: await accept(doc, optOut ? { ...job, optOut } : job, robots) }
  }

  async function renderPage(job: PageJob): Promise<PageOutcome> {
    if (!deps.renderer?.size) return { outcome: 'no renderer' }
    const robots = await robotsFor(job.site)
    if (robots === 'unavailable') return { outcome: 'robots.txt unavailable' }
    const gap = gapFor(robots)
    const slot = await frontier.lease(job.site, gap)
    if (slot.waitMs > 0) return { delayMs: spreadDelay(slot.waitMs, slot.pending, gap), outcome: 'waiting for the site' }
    const rendered = await deps.renderer.render(job.url)
    const landed = normalizeUrl(rendered.url) ?? job.url
    if (!sameSite(landed, job.site)) return { outcome: `rendered onto ${siteOf(landed)}` }
    const doc = extract(rendered.html, landed, { depth: job.depth, rendered: true, crawler: config.userAgent })
    return { outcome: await accept(doc, { ...job, rendered: true }, robots) }
  }

  /**
   * Records into the local search mirror, then to nichedb, 200 a call, until the
   * outbox is empty or 20 calls are made. A failed call puts the batch back; the
   * mirror is an upsert, so indexing it again is harmless. Without a nichedb key
   * the records go to the mirror only.
   */
  async function publish(): Promise<{ sent: number; added: number; rejected: number; waiting: boolean }> {
    const toNichedb = Boolean(config.nichedbKey) && config.publishPages
    if (!toNichedb && !deps.index) return { sent: 0, added: 0, rejected: 0, waiting: true }
    const fetchImpl = deps.fetch ?? fetch
    let sent = 0
    let added = 0
    let rejected = 0
    for (let round = 0; round < 20; round++) {
      const raw = await frontier.take(BATCH)
      if (!raw.length) break
      if (deps.index) {
        const kept = deps.index.add(raw)
        if (kept) await frontier.bump('indexed_local', kept)
      }
      if (!toNichedb) continue
      // The full text stays in the local index; nichedb keeps the record, excerpt and media.
      const outgoing = raw.map((line) => {
        try {
          const entry = JSON.parse(line)
          if (entry?.enrichment) {
            delete entry.enrichment.text
            delete entry.enrichment.training
          }
          return JSON.stringify(entry)
        } catch {
          return line
        }
      })
      let response: Response
      try {
        response = await fetchImpl(`${config.nichedbUrl}/api/v1/sites/records`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.nichedbKey}`, 'user-agent': config.userAgent },
          body: `{"records":[${outgoing.join(',')}]}`,
          signal: AbortSignal.timeout(60_000),
        })
      } catch (error) {
        await frontier.giveBack(raw)
        throw error
      }
      if (!response.ok) {
        await frontier.giveBack(raw)
        throw new Error(`nichedb answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
      }
      const body = (await response.json().catch(() => ({}))) as { added?: number; rejected?: unknown[] }
      sent += raw.length
      added += body.added ?? 0
      rejected += body.rejected?.length ?? 0
    }
    if (!toNichedb) return { sent: 0, added: 0, rejected: 0, waiting: false }
    if (sent) {
      await frontier.bump('published', sent)
      await frontier.bump('published_new', added)
      if (rejected) await frontier.bump('published_rejected', rejected)
      await frontier.log({ kind: 'publish', note: `${sent} records to nichedb: ${added} new${rejected ? `, ${rejected} refused` : ''}` })
    }
    return { sent, added, rejected, waiting: false }
  }

  /** Sites whose cycle has run out are started again. */
  async function recrawl(limit = 5_000): Promise<number> {
    const due = await siteStore.takeDue(config.recrawlDays * 86_400_000, limit)
    if (due.length) await enqueue.sites(due.map((site) => ({ site, source: 'recrawl' })))
    return due.length
  }

  /** Pages put straight into the queue (depth 0, shallow-first), their sites scheduled ahead. */
  async function submitPages(urls: string[]): Promise<{ sites: number; pages: number }> {
    const bySite = new Map<string, string[]>()
    for (const url of urls) {
      const site = siteOf(url)
      if (!site || !crawlable(url)) continue
      bySite.set(site, [...(bySite.get(site) ?? []), url])
    }
    const { queued } = await scheduleSites([...bySite.keys()], 'submit', { first: true })
    const jobs: PageJob[] = []
    for (const [site, pages] of bySite) {
      for (const url of pages.slice(0, config.maxPages)) {
        const verdict = await frontier.admit(site, url)
        if (verdict === 'full') break
        if (verdict === 'new') jobs.push({ url, site, depth: 0 })
      }
    }
    if (jobs.length) await enqueue.pages(jobs)
    return { sites: queued, pages: jobs.length }
  }

  /**
   * One submitted address (pit.world/submit): find out what it is by reading it, then
   * queue what it names. A bare origin needs no read: it is a site.
   */
  async function submit(input: string): Promise<{ kind: SubmitKind | 'refused' | 'unreadable'; sites: number; pages: number }> {
    const raw = input.trim()
    const url = normalizeUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    if (!url || !(await resolver(new URL(url).hostname))) {
      await frontier.bump('submitted_refused')
      return { kind: 'refused', sites: 0, pages: 0 }
    }
    let out: { kind: SubmitKind | 'refused' | 'unreadable'; sites: number; pages: number }
    if (guessKind(url) === 'site') {
      out = { kind: 'site', ...(await scheduleSites([url], 'submit', { first: true }).then((r) => ({ sites: r.queued, pages: 0 }))) }
    } else {
      let r
      try {
        r = await politeGet(url, { userAgent: config.userAgent, resolver, ...(deps.fetch ? { fetch: deps.fetch } : {}), accept: 'application/xml,text/xml,application/rss+xml,application/atom+xml,application/feed+json,text/html;q=0.9,*/*;q=0.5' })
      } catch {
        await frontier.bump('submitted_unreadable')
        return { kind: 'unreadable', sites: 0, pages: 0 }
      }
      if (r.status >= 400) {
        await frontier.bump('submitted_unreadable')
        return { kind: 'unreadable', sites: 0, pages: 0 }
      }
      const landed = normalizeUrl(r.finalUrl) ?? url
      const kind = sniff(r.body, r.contentType)
      if (kind === 'sitemap') {
        const pages: string[] = []
        const { urls, sitemaps } = readSitemapXml(r.body)
        pages.push(...urls)
        for (const nested of sitemaps.slice(0, 5)) {
          if (pages.length >= 1_000) break
          try {
            const n = await politeGet(nested, { userAgent: config.userAgent, resolver, ...(deps.fetch ? { fetch: deps.fetch } : {}), accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1' })
            if (n.status < 400) pages.push(...readSitemapXml(n.body).urls)
          } catch {
            // one bad nested sitemap does not sink the rest
          }
        }
        out = { kind: 'sitemap', ...(await submitPages(pages.map((p) => normalizeUrl(p)).filter((p): p is string => Boolean(p)).slice(0, 1_000))) }
      } else if (kind === 'feed') {
        if (deps.forwardFeed) await deps.forwardFeed(landed).catch(() => {})
        out = { kind: 'feed', ...(await submitPages(feedLinks(r.body, landed))) }
      } else if (kind === 'opml') {
        out = { kind: 'opml', ...(await scheduleSites(sitesFromOpml(r.body), 'submit', { first: true }).then((x) => ({ sites: x.queued, pages: 0 }))) }
      } else {
        out = { kind: 'page', ...(await submitPages([landed])) }
      }
    }
    await frontier.bump(`submitted_${out.kind}`)
    await frontier.log({ kind: 'site', url, note: `submitted ${out.kind}: ${out.sites} sites, ${out.pages} pages queued` })
    return out
  }

  return { scheduleSites, crawlSite, crawlPage, renderPage, probeMcp, fillCards, identifySocial, searchSocial, publish, recrawl, submit, robotsFor }
}

export type Crawler = ReturnType<typeof createCrawler>
