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
import { ObscuraPool } from './obscura.ts'
import { urlId } from './url.ts'

export const QUEUES = {
  site: 'pit-crawl-site',
  page: 'pit-crawl-page',
  render: 'pit-crawl-render',
  publish: 'pit-crawl-publish',
} as const

const JOB_DEFAULTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { age: 7 * 86_400, count: 20_000 },
}

export function connect(url: string): Redis {
  // BullMQ needs maxRetriesPerRequest null for its blocking calls.
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, connectionName: 'pit-crawler' })
}

export type Runtime = {
  crawler: Crawler
  queues: Record<keyof typeof QUEUES, Queue>
  frontier: RedisFrontier
  redis: Redis
  close(): Promise<void>
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
  }
  const frontier = new RedisFrontier(redis, config.maxPages, config.recrawlDays * 86_400_000)
  const pool = config.obscuraUrls.length ? new ObscuraPool(config.obscuraUrls, config.obscuraToken) : null
  const crawler = createCrawler({
    config,
    frontier,
    renderer: pool,
    log,
    enqueue: {
      async sites(jobs: SiteJob[]) {
        await queues.site.addBulk(jobs.map((data) => ({ name: 'site', data })))
      },
      async pages(jobs: PageJob[]) {
        await queues.page.addBulk(
          jobs.map((data) => ({ name: 'page', data, opts: { jobId: `p-${urlId(data.url)}`, priority: Math.min(data.depth + 1, 100) } })),
        )
      },
      async render(job: PageJob) {
        await queues.render.add('render', job, { jobId: `r-${urlId(job.url)}`, attempts: 2 })
      },
    },
  })
  return {
    crawler,
    queues,
    frontier,
    redis,
    async close() {
      await Promise.all(Object.values(queues).map((q) => q.close()))
      redis.disconnect()
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
      new Worker<SiteJob>(
        QUEUES.site,
        async (job) => {
          const out = await crawler.crawlSite(job.data)
          log(`site ${job.data.site}: ${out.outcome}, ${out.admitted} pages queued`)
        },
        { ...common, connection: workerConnection(), concurrency: Math.max(2, Math.ceil(config.concurrency / 4)) },
      ),
    )
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
  if (role('publish')) {
    await runtime.queues.publish.upsertJobScheduler('flush', { every: 5_000 }, { name: 'flush', opts: { removeOnComplete: true, removeOnFail: 100 } })
    await runtime.queues.publish.upsertJobScheduler('recrawl', { every: 3_600_000 }, { name: 'recrawl', opts: { removeOnComplete: true, removeOnFail: 100 } })
    workers.push(
      new Worker(
        QUEUES.publish,
        async (job) => {
          if (job.name === 'recrawl') {
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
      const field = w.name === QUEUES.render ? 'renders_errored' : w.name === QUEUES.publish ? 'publish_errored' : 'pages_errored'
      void runtime.frontier.bump(field).catch(() => {})
      void runtime.frontier
        .log({ kind: 'fail', ...(data.site ? { site: data.site } : {}), ...(data.url ? { url: data.url } : {}), note: `${w.name.replace('pit-crawl-', '')}: ${error.message.slice(0, 160)}` })
        .catch(() => {})
    })
    w.on('error', (error) => log(`${w.name} error: ${error.message}`))
  }
  log(`pit-crawler up: roles ${config.roles.join(',')}, ${config.concurrency} pages at once, ${config.obscuraUrls.length} Obscura, max ${config.maxPages} pages/site, nichedb ${config.nichedbKey ? config.nichedbUrl : 'off (outbox only)'}`)

  return {
    runtime,
    workers,
    async close() {
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
  return { stats, queues }
}

/** Everything /status shows: the snapshot, rates over the hour and the day, the log tail. */
export async function report(runtime: Runtime, config: Config) {
  const [snap, activity, log] = await Promise.all([snapshot(runtime), runtime.frontier.activity(), runtime.frontier.recent(60)])
  return {
    ...snap,
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
      publishing: Boolean(config.nichedbKey),
    },
    generatedAt: new Date().toISOString(),
  }
}
