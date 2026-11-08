/**
 * What pitbot (services/crawler) is doing, for /status and /api/status.
 *
 * The crawler is its own service; it answers /stats on loopback with its queue
 * depths, counters, hour and day rates and a log tail. This reads that and
 * turns it into the questions a visitor actually has: is it running, how much
 * is waiting, how fast is it going, when does the backlog clear. The web
 * server can be healthy while the crawler has been wedged for hours, and that
 * failure is invisible from outside, so it gets a page (rssamplifier's
 * /crawlstats, same idea).
 */

export type CrawlEvent = { at: string; kind: string; site?: string; url?: string; title?: string; note?: string }

export type CrawlerReport = {
  ok: boolean
  version: string
  stats: Record<string, number>
  queues: Record<string, Record<string, number>>
  activity: { lastHour: Record<string, number>; lastDay: Record<string, number>; hours: Array<{ at: string; counts: Record<string, number> }> }
  log: CrawlEvent[]
  settings: { maxPages: number; maxDepth: number; concurrency: number; hostDelayMs: number; recrawlDays: number; renderers: number; discover: boolean; publishing: boolean; maxSites?: number }
  generatedAt: string
}

export type Health = 'healthy' | 'idle' | 'degraded' | 'stalled' | 'offline'

export type Job = {
  key: string
  label: string
  what: string
  state: 'working' | 'idle' | 'stalled' | 'off'
  backlog: number
  ratePerHour: number
  errorsLastHour: number
  clearsInHours: number | null
}

export type CrawlStatus = {
  health: Health
  summary: string
  reachable: boolean
  totals: { sites: number; sitesParked: number; pagesIndexed: number; pagesRendered: number; published: number; outbox: number; failed: number; searchable: number; images: number; videos: number; mcps: number }
  /** The local mirror against its byte budget. The index filling the disk is what took the box down on 2026-11-04, so it is on the page. */
  index: { bytes: number; maxBytes: number } | null
  lastHour: { pages: number; rendered: number; failed: number; published: number; sitesStarted: number }
  lastDay: { pages: number; rendered: number; failed: number; published: number; sitesStarted: number }
  jobs: Job[]
  /** Pages read per hour, oldest first, for the chart. */
  hourly: Array<{ at: string; pages: number; failed: number }>
  log: CrawlEvent[]
  settings: CrawlerReport['settings'] | null
  generatedAt: string
}

const n = (o: Record<string, number> | undefined, ...keys: string[]) => keys.reduce((sum, k) => sum + (Number(o?.[k]) || 0), 0)
const depth = (q: Record<string, number> | undefined) => n(q, 'waiting', 'prioritized', 'delayed', 'active')

function job(key: string, label: string, what: string, backlog: number, ratePerHour: number, errorsLastHour: number, enabled = true): Job {
  const state: Job['state'] = !enabled ? 'off' : ratePerHour > 0 ? 'working' : backlog > 0 ? 'stalled' : 'idle'
  return {
    key,
    label,
    what,
    state,
    backlog,
    ratePerHour,
    errorsLastHour,
    clearsInHours: backlog > 0 && ratePerHour > 0 ? Math.round((backlog / ratePerHour) * 10) / 10 : null,
  }
}

/** The report as the page shows it. A null report means the crawler did not answer. */
export function describe(report: CrawlerReport | null, now = new Date()): CrawlStatus {
  if (!report) {
    return {
      health: 'offline',
      summary: 'The crawler did not answer. Searches still work; the index just is not growing right now.',
      reachable: false,
      totals: { sites: 0, sitesParked: 0, pagesIndexed: 0, pagesRendered: 0, published: 0, outbox: 0, failed: 0, searchable: 0, images: 0, videos: 0, mcps: 0 },
      index: null,
      lastHour: { pages: 0, rendered: 0, failed: 0, published: 0, sitesStarted: 0 },
      lastDay: { pages: 0, rendered: 0, failed: 0, published: 0, sitesStarted: 0 },
      jobs: [],
      hourly: [],
      log: [],
      settings: null,
      generatedAt: now.toISOString(),
    }
  }
  const { stats, queues, activity } = report
  const window = (o: Record<string, number>) => ({
    pages: n(o, 'pages_indexed', 'pages_rendered'),
    rendered: n(o, 'pages_rendered'),
    failed: n(o, 'pages_failed', 'pages_errored', 'renders_errored'),
    published: n(o, 'published'),
    sitesStarted: n(o, 'sites_started'),
  })
  const lastHour = window(activity.lastHour)
  const lastDay = window(activity.lastDay)
  const h = activity.lastHour
  const fetchedLastHour = n(h, 'pages_indexed', 'pages_failed', 'pages_noindex', 'pages_disallowed', 'render_queued', 'pages_errored')

  const jobs: Job[] = [
    job('sites', 'Site starts', 'robots.txt, sitemaps and the home page of each site', depth(queues.site) + n(stats, 'sites_parked'), n(h, 'sites_started', 'sites_refused', 'sites_disallowed', 'sites_unavailable'), 0),
    job('pages', 'Page reads', 'fetch, read and follow same-site links, one request per site at a time', depth(queues.page), fetchedLastHour, n(h, 'pages_failed', 'pages_errored')),
    job('render', 'Browser renders', 'pages that are an empty shell until JavaScript runs, read again in Obscura', depth(queues.render), n(h, 'pages_rendered'), n(h, 'renders_errored'), report.settings.renderers > 0),
    job('submit', 'Submissions', 'addresses sent to pit.world/submit: read, sorted (site, page, feed, sitemap, OPML) and queued', depth(queues.submit), n(h, 'submitted_site', 'submitted_page', 'submitted_feed', 'submitted_sitemap', 'submitted_opml'), n(h, 'submitted_refused', 'submitted_unreadable')),
    job('publish', 'Publishing', 'records sent to nichedb.dev/c/sites, two hundred a call', n(stats, 'outbox'), n(h, 'published'), n(h, 'publish_errored'), report.settings.publishing),
  ]

  const waiting = jobs.reduce((sum, j) => sum + (j.state === 'off' ? 0 : j.backlog), 0)
  const stalled = jobs.filter((j) => j.state === 'stalled' && j.key !== 'publish')
  let health: Health
  let summary: string
  if (stalled.length && fetchedLastHour === 0) {
    health = 'stalled'
    summary = `${fmt(waiting)} jobs are waiting and nothing has been read in the last hour.`
  } else if (report.settings.publishing && jobs.find((j) => j.key === 'publish')?.state === 'stalled') {
    health = 'degraded'
    summary = `${fmt(n(stats, 'outbox'))} records are waiting for nichedb and none were accepted in the last hour.`
  } else if (lastHour.failed > Math.max(20, lastHour.pages)) {
    health = 'degraded'
    summary = `More pages failed (${fmt(lastHour.failed)}) than were read (${fmt(lastHour.pages)}) in the last hour.`
  } else if (waiting === 0 && fetchedLastHour === 0) {
    health = 'idle'
    summary = 'Nothing is waiting: every site is read for this cycle. New sites and the monthly re-read wake it up.'
  } else {
    health = 'healthy'
    summary = `${fmt(lastHour.pages)} pages read in the last hour, ${fmt(waiting)} jobs waiting.`
  }
  // The index at its budget is normal (it drops its oldest pages and carries on), but say so:
  // the one time it had no budget it filled the box's disk.
  const maxBytes = n(stats, 'index_max_bytes')
  // The frontier at its cap stops discovery outright, which reads as the crawler "finding
  // nothing new" (1,000,000 on 2026-11-08). Say it, since the page cannot show a refusal.
  const maxSites = report.settings.maxSites ?? 0
  if (maxSites && n(stats, 'sites') >= maxSites) summary += ` The crawler knows its limit of ${fmt(maxSites)} sites, so links to new sites are not being followed.`
  if (maxBytes && n(stats, 'index_bytes') >= maxBytes * 0.95) summary += ' The index is at its size budget, so its oldest pages are making room for new ones.'

  return {
    health,
    summary,
    reachable: true,
    totals: {
      sites: n(stats, 'sites'),
      sitesParked: n(stats, 'sites_parked'),
      pagesIndexed: n(stats, 'pages_indexed', 'pages_rendered'),
      pagesRendered: n(stats, 'pages_rendered'),
      published: n(stats, 'published'),
      outbox: n(stats, 'outbox'),
      failed: n(stats, 'pages_failed', 'pages_errored', 'renders_errored'),
      searchable: n(stats, 'index_pages'),
      images: n(stats, 'index_images'),
      videos: n(stats, 'index_videos'),
      mcps: n(stats, 'index_mcps'),
    },
    index: stats.index_bytes ? { bytes: n(stats, 'index_bytes'), maxBytes: n(stats, 'index_max_bytes') } : null,
    lastHour,
    lastDay,
    jobs,
    hourly: activity.hours.map((x) => ({ at: x.at, pages: n(x.counts, 'pages_indexed', 'pages_rendered'), failed: n(x.counts, 'pages_failed', 'pages_errored', 'renders_errored') })),
    log: report.log.slice(0, 60),
    settings: report.settings,
    generatedAt: report.generatedAt,
  }
}

export function fmt(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/**
 * Ask the crawler. Loopback, a short leash, and a few seconds of memory so a busy page
 * does not hammer it.
 *
 * One missed answer is not an outage. The crawler shares a box with everything else and
 * answers /stats off the same event loop that renews its job locks, so a single call can
 * run past the leash while the crawler is perfectly healthy -- and "Offline" is the one
 * thing this page should not say wrongly, having said it for fourteen hours when it was
 * true. So a failure inside `graceMs` of a good answer reports that answer, with the
 * timestamp it was taken; only a crawler that has been quiet for longer reads as offline.
 */
export function createCrawlStatus(url: string, fetchImpl: typeof fetch = fetch, ttlMs = 5_000, graceMs = 60_000) {
  let cached: { at: number; value: CrawlStatus } | null = null
  let lastGood: { at: number; value: CrawlStatus } | null = null
  return async function status(): Promise<CrawlStatus> {
    if (cached && Date.now() - cached.at < ttlMs) return cached.value
    let report: CrawlerReport | null = null
    try {
      // threatcrush-disable-next-line js-ssrf-outbound-request  fixed loopback address from configuration (CRAWLER_STATUS_URL), never from a request
      const response = await fetchImpl(`${url.replace(/\/+$/, '')}/stats`, { signal: AbortSignal.timeout(3_000) })
      if (response.ok) report = (await response.json()) as CrawlerReport
    } catch {
      report = null
    }
    const now = Date.now()
    let value = describe(report)
    if (report) lastGood = { at: now, value }
    else if (lastGood && now - lastGood.at < graceMs) value = lastGood.value
    cached = { at: now, value }
    return value
  }
}
