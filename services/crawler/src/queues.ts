/**
 * The crawl on BullMQ. Four queues on pit.world's own Redis (never a shared one):
 *
 *   pit-crawl-site     one job per site per cycle: robots.txt, sitemaps, home page
 *   pit-crawl-page     one job per page; shallow pages first (priority = depth)
 *   pit-crawl-render   pages that came back as an empty JavaScript shell, read again in Obscura
 *   pit-crawl-publish  two schedulers: flush the outbox to nichedb every 5 s, start due recrawls hourly
 *
 * Politeness: a page job whose site is inside its request gap is moved back
 * to delayed for the rest of the gap (DelayedError, no attempt used), so one
 * slow site never holds a worker and a thousand sites interleave.
 *
 * Scale: every process runs the roles CRAWL_ROLES names against the same
 * Redis. Add page workers anywhere; add render workers next to Obscura.
 * Job ids never contain a colon (BullMQ rejects them), processors return
 * nothing (a return value is stored in Redis per job), finished jobs are
 * trimmed, and event streams are capped.
 */
import { DelayedError, type Job, Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import type { Config, Role } from './config.ts'
import { createCrawler, type Crawler, type PageJob, type SiteJob } from './crawler.ts'
import { RedisFrontier } from './frontier.ts'
import { MemorySiteStore, PgSiteStore, type SiteStore } from './site-store.ts'
import { submitFeed } from '@profullstack/submit-feed/core'
import { IndexStore } from './index-store.ts'
import type { McpJob } from './mcp.ts'
import { ObscuraPool } from './obscura.ts'
import { urlId } from './url.ts'

export const QUEUES = {
  site: 'pit-crawl-site',
  page: 'pit-crawl-page',
  render: 'pit-crawl-render',
  publish: 'pit-crawl-publish',
  submit: 'pit-crawl-submit',
  mcp: 'pit-crawl-mcp',
} as const

/** addBulk in chunks: one call with half a million jobs is one enormous Redis script run. */
async function addInChunks<T>(items: T[], add: (chunk: T[]) => Promise<unknown>, size = 1_000): Promise<void> {
  for (let i = 0; i < items.length; i += size) await add(items.slice(i, i + size))
}

const JOB_DEFAULTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { age: 7 * 86_400, count: 20_000 },
}

/** Submitted addresses into the submit queue; a resubmission while one is waiting is the same job. */
export async function enqueueSubmissions(runtime: Runtime, urls: string[]): Promise<number> {
  const unique = [...new Set(urls)].slice(0, 1_000)
  await addInChunks(unique, (chunk) => runtime.queues.submit.addBulk(chunk.map((url) => ({ name: 'submit', data: { url }, opts: { jobId: `u-${urlId(url)}`, attempts: 2 } }))))
  return unique.length
}

export function connect(url: string): Redis {
  // BullMQ needs maxRetriesPerRequest null for its blocking calls.
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, connectionName: 'pit-crawler' })
}

export type Runtime = {
  crawler: Crawler
  queues: Record<keyof typeof QUEUES, Queue>
  frontier: RedisFrontier
  sites: SiteStore
  redis: Redis
  index: IndexStore
  close(): Promise<void>
}

/** Top the site queue up from the parked sites once it is under half its cap. */
export async function feedParked(runtime: Pick<Runtime, 'queues' | 'sites'>, config: Config): Promise<number> {
  const waiting = await runtime.queues.site.getWaitingCount()
  const room = config.siteQueueHigh - waiting
  if (room < config.siteQueueHigh / 2) return 0
  const jobs: SiteJob[] = await runtime.sites.takeParked(Math.min(room, 10_000))
  await addInChunks(jobs, (chunk) => runtime.queues.site.addBulk(chunk.map((data) => ({ name: 'site', data }))))
  return jobs.length
}

/** Copy the frontier's size into the Redis stats, which is all /stats and health read. */
export async function publishSiteCounts(runtime: Pick<Runtime, 'sites' | 'frontier'>): Promise<void> {
  const c = await runtime.sites.counts()
  await runtime.frontier.setGauges({ sites: c.known, sites_parked: c.parked })
}

/**
 * One-off move of the site frontier from Redis (pitcrawl:pending, then pitcrawl:sites)
 * into Postgres. Parked sites go first, in order, so the later known-site pass keeps them
 * parked (ON CONFLICT DO NOTHING); the rest arrive scheduled at their old score.
 * `drop` unlinks the Redis keys afterwards.
 */
export async function migrateSitesFromRedis(runtime: Runtime, options: { drop?: boolean } = {}, log: (line: string) => void = console.log) {
  const { redis, sites } = runtime
  let parked = 0
  for (let at = 0; ; at += 10_000) {
    const raw = await redis.lrange('pitcrawl:pending', at, at + 9_999)
    if (!raw.length) break
    const rows = raw.flatMap((entry) => {
      const cut = entry.indexOf(' ')
      return cut > 0 ? [{ source: entry.slice(0, cut), site: entry.slice(cut + 1), scheduledAt: null }] : []
    })
    parked += await sites.load(rows)
  }
  log(`migrate: ${parked} parked sites loaded`)
  let known = 0
  for (let at = 0; ; at += 10_000) {
    const flat = await redis.zrange('pitcrawl:sites', at, at + 9_999, 'WITHSCORES')
    if (!flat.length) break
    const rows: { site: string; source: string; scheduledAt: number }[] = []
    for (let i = 0; i < flat.length; i += 2) rows.push({ site: flat[i]!, source: 'redis', scheduledAt: Number(flat[i + 1]) })
    known += await sites.load(rows)
    if (at % 200_000 === 0) log(`migrate: ${at + rows.length} known sites read`)
  }
  const counts = await sites.resync()
  log(`migrate: ${known} scheduled sites loaded; frontier now ${counts.known} known, ${counts.parked} parked`)
  if (options.drop) {
    await redis.unlink('pitcrawl:pending', 'pitcrawl:sites')
    log('migrate: Redis pitcrawl:pending and pitcrawl:sites unlinked')
  }
  return counts
}

/** Queues, frontier and crawler, without workers: what `seed` and `stats` need. */
export function createRuntime(config: Config, log: (line: string) => void = console.log): Runtime {
  const redis = connect(config.redisUrl)
  const opts = { connection: redis, defaultJobOptions: JOB_DEFAULTS, streams: { events: { maxLen: 1_000 } } }
  const queues = {
    site: new Queue(QUEUES.site, opts),
    page: new Queue(QUEUES.page, opts),
    render: new Queue(QUEUES.render, opts),
    publish: new Queue(QUEUES.publish, opts),
    submit: new Queue(QUEUES.submit, opts),
    mcp: new Queue(QUEUES.mcp, opts),
  }
  const frontier = new RedisFrontier(redis, config.maxPages, Math.min(config.seenTtlMs, config.recrawlDays * 86_400_000))
  const pool = config.obscuraUrls.length ? new ObscuraPool(config.obscuraUrls, config.obscuraToken) : null
  const index = new IndexStore(config.indexPath, config.indexMaxBytes)
  if (!config.databaseUrl) log('CRAWL_DATABASE_URL unset: the site frontier is in memory and forgets every site on restart')
  const sites: SiteStore = config.databaseUrl ? new PgSiteStore(config.databaseUrl) : new MemorySiteStore()
  const crawler = createCrawler({
    config,
    frontier,
    sites,
    renderer: pool,
    index,
    // A feed submitted at pit.world/submit is offered to the RSS directory as well.
    async forwardFeed(feedUrl: string) {
      await submitFeed('https://rssamplifier.com', { url: feedUrl })
    },
    async pageBacklog() {
      const c = await queues.page.getJobCounts('waiting', 'prioritized', 'delayed')
      return (c.waiting ?? 0) + (c.prioritized ?? 0) + (c.delayed ?? 0)
    },
    log,
    enqueue: {
      async sites(jobs: SiteJob[]) {
        // LIFO puts a `first` site at the head of the waiting list, ahead of a big seed.
        await addInChunks(jobs, (chunk) => queues.site.addBulk(chunk.map((data) => ({ name: 'site', data, ...(data.first ? { opts: { lifo: true } } : {}) }))))
      },
      // Discovery finds sites far faster than they are read; past this many waiting jobs
      // new ones stay parked in Postgres and the site gate feeds them in.
      async sitesDeep() {
        return (await queues.site.getWaitingCount()) >= config.siteQueueHigh
      },
      async pages(jobs: PageJob[]) {
        await addInChunks(jobs, (chunk) =>
          queues.page.addBulk(chunk.map((data) => ({ name: 'page', data, opts: { jobId: `p-${urlId(data.url)}`, priority: Math.min(data.depth + 1, 100) } }))),
        )
      },
      async render(job: PageJob) {
        await queues.render.add('render', job, { jobId: `r-${urlId(job.url)}`, attempts: 2 })
      },
      async mcp(jobs: McpJob[]) {
        await addInChunks(jobs, (chunk) => queues.mcp.addBulk(chunk.map((data) => ({ name: 'mcp', data, opts: { jobId: `m-${urlId(data.endpoint)}`, attempts: 2 } }))))
      },
    },
  })
  return {
    crawler,
    queues,
    frontier,
    sites,
    redis,
    index,
    async close() {
      await Promise.all(Object.values(queues).map((q) => q.close()))
      redis.disconnect()
      index.close()
      await sites.close()
    },
  }
}

/** A page outcome that says "not yet" becomes a delay, not a failure. */
async function politely(job: Job, token: string | undefined, run: () => Promise<{ delayMs?: number }>): Promise<void> {
  const out = await run()
  if (out.delayMs && token) {
    // Jitter, so the jobs waiting on one site do not all wake in the same millisecond.
    await job.moveToDelayed(Date.now() + out.delayMs + Math.floor(Math.random() * 500), token)
    throw new DelayedError()
  }
}

export async function startWorkers(config: Config, log: (line: string) => void = console.log) {
  const runtime = createRuntime(config, log)
  const { crawler, redis } = runtime
  // A Worker on a Redis that never answers leaks timers; ask first.
  await redis.ping()
  const workerConnection = () => connect(config.redisUrl)
  const workers: Worker[] = []
  const role = (r: Role) => config.roles.includes(r)
  const common = { stalledInterval: 60_000, maxStalledCount: 2 }

  if (role('site'))
    workers.push(
      new Worker<{ url: string }>(
        QUEUES.submit,
        async (job) => {
          const out = await crawler.submit(job.data.url)
          log(`submit ${job.data.url}: ${out.kind}, ${out.sites} sites, ${out.pages} pages`)
        },
        { ...common, connection: workerConnection(), concurrency: 4 },
      ),
    )
  let gate: ReturnType<typeof setInterval> | null = null
  if (role('site')) {
    const siteWorker = new Worker<SiteJob>(
      QUEUES.site,
      (job, token) =>
        politely(job, token, async () => {
          const out = await crawler.crawlSite(job.data)
          if (!out.delayMs) log(`site ${job.data.site}: ${out.outcome}, ${out.admitted} pages queued`)
          return out
        }),
      { ...common, connection: workerConnection(), concurrency: Math.max(2, Math.ceil(config.concurrency / 4)) },
    )
    workers.push(siteWorker)
    // Backpressure without losing places: a site job delayed for the page backlog came
    // back at the END of the waiting list (BullMQ returns delayed jobs behind everything),
    // so seed --first sites fell behind a 358k-site seed. Instead the site worker stops
    // taking jobs while the backlog is over the cap and resumes under 90% of it.
    const pageBacklog = async () => {
      const c = await runtime.queues.page.getJobCounts('waiting', 'prioritized', 'delayed')
      return (c.waiting ?? 0) + (c.prioritized ?? 0) + (c.delayed ?? 0)
    }
    let paused = false
    let ticks = 0
    gate = setInterval(async () => {
      try {
        await feedParked(runtime, config)
        if (++ticks % 6 === 1) await publishSiteCounts(runtime)
        const backlog = await pageBacklog()
        if (!paused && backlog > config.maxPageBacklog) {
          paused = true
          await siteWorker.pause(true)
        } else if (paused && backlog < config.maxPageBacklog * 0.9) {
          paused = false
          siteWorker.resume()
        }
      } catch {
        // Redis trouble is the watchdog's to handle.
      }
    }, 5_000)
  }
  if (role('page'))
    workers.push(
      new Worker<PageJob>(QUEUES.page, (job, token) => politely(job, token, () => crawler.crawlPage(job.data)), {
        ...common,
        connection: workerConnection(),
        concurrency: config.concurrency,
        lockDuration: 60_000,
      }),
    )
  if (role('render') && config.obscuraUrls.length)
    workers.push(
      new Worker<PageJob>(QUEUES.render, (job, token) => politely(job, token, () => crawler.renderPage(job.data)), {
        ...common,
        connection: workerConnection(),
        // One page per Obscura server; the pool serialises per server.
        concurrency: config.obscuraUrls.length,
        lockDuration: 120_000,
      }),
    )
  if (role('publish'))
    workers.push(
      new Worker<McpJob>(
        QUEUES.mcp,
        async (job) => {
          const out = await crawler.probeMcp(job.data)
          if (out.outcome === 'proved') log(`mcp ${job.data.endpoint}: proved`)
        },
        { ...common, connection: workerConnection(), concurrency: 8, lockDuration: 60_000 },
      ),
    )
  if (role('publish')) {
    await runtime.queues.publish.upsertJobScheduler('flush', { every: 5_000 }, { name: 'flush', opts: { removeOnComplete: true, removeOnFail: 100 } })
    await runtime.queues.publish.upsertJobScheduler('recrawl', { every: 3_600_000 }, { name: 'recrawl', opts: { removeOnComplete: true, removeOnFail: 100 } })
    workers.push(
      new Worker(
        QUEUES.publish,
        async (job) => {
          if (job.name === 'recrawl') {
            // Hourly, the counters are made exact again (count(*) is seconds at 100M rows).
            await runtime.sites.resync().catch((error) => log(`sites resync: ${error instanceof Error ? error.message : error}`))
            const n = await crawler.recrawl()
            if (n) log(`recrawl: ${n} sites due again`)
            return
          }
          const out = await crawler.publish()
          if (out.sent) log(`publish: ${out.sent} records to nichedb (${out.added} new, ${out.rejected} refused)`)
        },
        { ...common, connection: workerConnection(), concurrency: 1 },
      ),
    )
  }
  for (const w of workers) {
    w.on('failed', (job, error) => {
      if (error instanceof DelayedError) return
      log(`${w.name} ${job?.id ?? '?'} failed: ${error.message}`)
      const data = (job?.data ?? {}) as Partial<PageJob>
      const field = w.name === QUEUES.render ? 'renders_errored' : w.name === QUEUES.publish ? 'publish_errored' : w.name === QUEUES.mcp ? 'mcp_errored' : 'pages_errored'
      void runtime.frontier.bump(field).catch(() => {})
      void runtime.frontier
        .log({ kind: 'fail', ...(data.site ? { site: data.site } : {}), ...(data.url ? { url: data.url } : {}), note: `${w.name.replace('pit-crawl-', '')}: ${error.message.slice(0, 160)}` })
        .catch(() => {})
    })
    w.on('error', (error) => log(`${w.name} error: ${error.message}`))
  }
  log(`pit-crawler up: roles ${config.roles.join(',')}, ${config.concurrency} pages at once, ${config.obscuraUrls.length} Obscura, max ${config.maxPages} pages/site, nichedb ${config.nichedbKey && config.publishPages ? config.nichedbUrl : 'off (local index only)'}`)

  return {
    runtime,
    workers,
    async close() {
      if (gate) clearInterval(gate)
      await Promise.all(workers.map((w) => w.close()))
      await runtime.close()
    },
  }
}

/** Queue depths and counters, for /healthz and `pit-crawler stats`. */
export async function snapshot(runtime: Runtime) {
  const [stats, ...counts] = await Promise.all([
    runtime.frontier.stats(),
    ...Object.values(runtime.queues).map((q) => q.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed')),
  ])
  const queues: Record<string, Record<string, number>> = {}
  Object.keys(runtime.queues).forEach((k, i) => (queues[k] = counts[i]!))
  // Redis only: this answers the container health check, which must never wait on SQLite.
  return { stats, queues }
}

/** Everything /status shows: the snapshot, rates over the hour and the day, the log tail. */
export async function report(runtime: Runtime, config: Config) {
  const [snap, activity, log] = await Promise.all([snapshot(runtime), runtime.frontier.activity(), runtime.frontier.recent(60)])
  // Cheap index figures: a counter for pages, two cached pragmas for the size, Redis
  // counters for media (a GROUP BY over millions of media rows is a multi-second scan).
  //
  // And never fatal. /status gives this a 3 s leash and reads a throw as the crawler
  // being down, so a SQLite read waiting behind another writer must cost a number on the
  // page, not the whole page: the one thing /status exists to tell you is whether the
  // crawler is alive, and it was reporting "Offline" on a healthy one (2026-11-05).
  const stats: Record<string, number> = { ...snap.stats, index_images: snap.stats.images_found ?? 0, index_videos: snap.stats.videos_found ?? 0 }
  // Redis, like the media counters: this page must never wait on SQLite for it.
  stats.index_mcps = await runtime.frontier.mcpCount().catch(() => 0)
  try {
    stats.index_pages = runtime.index.count()
    stats.index_bytes = runtime.index.sizeBytes()
    stats.index_max_bytes = runtime.index.maxBytes
  } catch {
    // Leave them out rather than report a wrong zero: /status shows no tile for a figure
    // it did not get, and still says the crawler is up.
  }
  return {
    ...snap,
    stats,
    activity,
    log,
    settings: {
      maxPages: config.maxPages,
      maxDepth: config.maxDepth,
      concurrency: config.concurrency,
      hostDelayMs: config.hostDelayMs,
      recrawlDays: config.recrawlDays,
      renderers: config.obscuraUrls.length,
      discover: config.discover,
      maxSites: config.maxSites,
      publishing: Boolean(config.nichedbKey) && config.publishPages,
    },
    generatedAt: new Date().toISOString(),
  }
}
