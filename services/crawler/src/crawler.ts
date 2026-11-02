/**
 * What the crawler does, with no queue in it: schedule a site, start a site
 * (robots.txt, sitemaps, home page), read a page, render a page, publish.
 * The BullMQ wiring (queues.ts) calls these; the tests call them directly
 * with an in-memory frontier and a fake web.
 */
import type { Config } from './config.ts'
import { extract, needsRender, type Extracted } from './extract.ts'
import { politeGet, readSitemapXml } from './fetcher.ts'
import type { Frontier } from './frontier.ts'
import type { Rendered } from './obscura.ts'
import { allows, EMPTY, parseRobots, pathOf, type Robots } from './robots.ts'
import { crawlable, normalizeUrl, resolvesPublic, sameSite, siteFromInput, siteOf, type Resolver } from './url.ts'

export type SiteJob = { site: string; source: string }
export type PageJob = { url: string; site: string; depth: number; rendered?: boolean }

export type Enqueue = {
  sites(jobs: SiteJob[]): Promise<void>
  pages(jobs: PageJob[]): Promise<void>
  render(job: PageJob): Promise<void>
}

export type Deps = {
  config: Config
  frontier: Frontier
  enqueue: Enqueue
  fetch?: typeof fetch
  resolver?: Resolver
  renderer?: { size: number; render(url: string): Promise<Rendered> } | null
  log?: (line: string) => void
  /** Page jobs queued now; a site start waits while it is over config.maxPageBacklog. */
  pageBacklog?: () => Promise<number>
  /** The local search mirror; every published batch lands here first. */
  index?: { add(entries: string[]): number } | null
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
  const resolver = deps.resolver ?? resolvesPublic
  const log = deps.log ?? (() => {})
  const get = (url: string, site: string, accept?: string) =>
    politeGet(url, { userAgent: config.userAgent, resolver, site, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(accept ? { accept } : {}) })

  /** Sites pasted, seeded or discovered: checked, counted, queued once per cycle. */
  async function scheduleSites(inputs: string[], source: string): Promise<{ queued: number; refused: number }> {
    const jobs: SiteJob[] = []
    let refused = 0
    for (const input of inputs) {
      const site = siteFromInput(input)
      if (!site || !(await frontier.noteSite(site, config.maxSites, config.recrawlDays * 86_400_000))) {
        refused++
        continue
      }
      jobs.push({ site, source })
    }
    if (jobs.length) await enqueue.sites(jobs)
    return { queued: jobs.length, refused }
  }

  async function robotsFor(site: string): Promise<Robots | 'unavailable'> {
    const kept = await frontier.getRobots(site)
    if (kept) return kept
    let robots: Robots = EMPTY
    try {
      const r = await get(`https://${site}/robots.txt`, site, 'text/plain,*/*;q=0.5')
      // 5xx: the site cannot say, so it is read another day (Google's reading). 4xx: no rules.
      if (r.status >= 500) return 'unavailable'
      if (r.status < 400 && !/html/.test(r.contentType)) robots = parseRobots(r.body)
    } catch {
      robots = EMPTY
    }
    await frontier.setRobots(site, robots)
    return robots
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
    // A seed of half a million sites must not become half a billion page jobs in Redis:
    // a site starts only while the pages already queued are under the backlog cap.
    if (deps.pageBacklog && (await deps.pageBacklog()) > config.maxPageBacklog) {
      return { admitted: 0, outcome: 'waiting for the page backlog', delayMs: 60_000 }
    }
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
    if (!doc.noindex) {
      await frontier.push([{ record: doc.record, enrichment: doc.enrichment }], config.outboxMax)
      await frontier.bump(rendered ? 'pages_rendered' : 'pages_indexed')
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
    return doc.noindex ? 'noindex' : 'indexed'
  }

  async function crawlPage(job: PageJob): Promise<PageOutcome> {
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
    if (!job.rendered && deps.renderer?.size && needsRender(r.body, doc.textLength)) {
      await enqueue.render({ ...job, rendered: true })
      await frontier.bump('render_queued')
      return { outcome: 'needs a browser' }
    }
    return { outcome: await accept(doc, job, robots) }
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
    if (!config.nichedbKey && !deps.index) return { sent: 0, added: 0, rejected: 0, waiting: true }
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
      if (!config.nichedbKey) continue
      let response: Response
      try {
        response = await fetchImpl(`${config.nichedbUrl}/api/v1/sites/records`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.nichedbKey}`, 'user-agent': config.userAgent },
          body: `{"records":[${raw.join(',')}]}`,
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
    if (!config.nichedbKey) return { sent: 0, added: 0, rejected: 0, waiting: false }
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
    const due = await frontier.sitesDue(config.recrawlDays * 86_400_000, limit)
    if (due.length) await scheduleSites(due, 'recrawl')
    return due.length
  }

  return { scheduleSites, crawlSite, crawlPage, renderPage, publish, recrawl }
}

export type Crawler = ReturnType<typeof createCrawler>
