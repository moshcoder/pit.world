#!/usr/bin/env bun
/**
 * pit-crawler: pit.world's spider.
 *
 *   pit-crawler worker                       run the roles in CRAWL_ROLES (default all) until stopped
 *   pit-crawler seed <site...>               crawl these sites
 *   pit-crawler seed --from nichedb|ring     backfill: every site nichedb keeps, or the ring
 *   pit-crawler seed --from rssamplifier|p0dcasters   every site behind every feed in that directory's OPML
 *   pit-crawler seed --opml <url|path>       any OPML file
 *   add --first to any seed to put those sites ahead of everything already waiting
 *   pit-crawler seed --file <path>           one site per line
 *   pit-crawler stats                        queue depths and counters, as JSON
 *   pit-crawler read <url> [--render]        read one page now and print its record (no Redis)
 */
import { readFileSync } from 'node:fs'
import { type Config, configFromEnv, VERSION } from './config.ts'
import { extract, needsRender } from './extract.ts'
import { politeGet } from './fetcher.ts'
import { ObscuraClient } from './obscura.ts'
import { createRuntime, enqueueSubmissions, report, snapshot, startWorkers, type Runtime } from './queues.ts'
import { OPML_SOURCES, opmlText, sitesFromNichedb, sitesFromOpml, sitesFromRing, sitesFromText } from './seed.ts'
import { importFromNichedb } from './import-nichedb.ts'
import { IndexStore } from './index-store.ts'
import { normalizeUrl, resolvesPublic, siteOf } from './url.ts'
import { trainingFor } from './crawler.ts'
import { pathOf } from './robots.ts'

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? '') : null
}

async function worker() {
  const config = configFromEnv()
  const running = await startWorkers(config, log)
  const { runtime } = running

  // Restart instead of hanging: a Redis that stops answering for a minute ends the process, systemd starts it again.
  let misses = 0
  const watchdog = setInterval(async () => {
    try {
      await Promise.race([runtime.redis.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))])
      misses = 0
    } catch {
      if (++misses >= 4) {
        log('watchdog: Redis has not answered for a minute, exiting')
        process.exit(1)
      }
    }
  }, 15_000)

  const server = config.healthPort
    ? Bun.serve({
        hostname: config.healthHost,
        port: config.healthPort,
        async fetch(request) {
          const url = new URL(request.url)
          const path = url.pathname
          if (path === '/api/v1/search') {
            // The same shape as nichedb's search, so pit.world reads either.
            const q = (url.searchParams.get('q') ?? '').slice(0, 512)
            const limit = Number(url.searchParams.get('limit')) || 10
            const items = q ? runtime.index.search(q, limit) : []
            return Response.json({ q, count: items.length, items })
          }
          if (path === '/api/v1/submit' && request.method === 'POST') {
            // Loopback only (the port is published on 127.0.0.1): pit.world's /submit posts here.
            const body = (await request.json().catch(() => null)) as { urls?: unknown } | null
            const urls = Array.isArray(body?.urls) ? body.urls.filter((u): u is string => typeof u === 'string') : []
            if (!urls.length) return Response.json({ error: 'send { "urls": [ ... ] }' }, { status: 400 })
            return Response.json({ queued: await enqueueSubmissions(runtime, urls) }, { status: 202 })
          }
          if (path === '/api/v1/corpus') {
            // Loopback only: pit.world's /api/corpus meters and sells this. Pages whose publishers reserved AI training are never in it.
            const p = url.searchParams
            const cursor = Number(p.get('cursor') ?? 0)
            if (!Number.isFinite(cursor) || cursor < 0) return Response.json({ error: 'cursor must be a cursor this API returned' }, { status: 400 })
            const since = p.get('since') ?? ''
            if (since && Number.isNaN(Date.parse(since))) return Response.json({ error: 'since must be an ISO date, e.g. 2026-11-01' }, { status: 400 })
            const page = runtime.index.corpus({
              q: (p.get('q') ?? '').slice(0, 512),
              site: (p.get('site') ?? '').slice(0, 253),
              kind: (p.get('kind') ?? '').slice(0, 40),
              lang: (p.get('lang') ?? '').slice(0, 20),
              ...(since ? { since: new Date(since).toISOString() } : {}),
              limit: Number(p.get('limit')) || 20,
              cursor,
              textMax: Number(p.get('text_max')) || 24_000,
            })
            return Response.json(page)
          }
          if (path === '/api/v1/corpus/stats') {
            return Response.json(runtime.index.corpusStats())
          }
          if (path !== '/healthz' && path !== '/stats') return new Response('not found', { status: 404 })
          try {
            // /healthz is the cheap one (Docker asks every 30 s); /stats is what pit.world/status reads.
            const body = path === '/stats' ? await report(runtime, config) : await snapshot(runtime)
            return Response.json({ ok: true, version: VERSION, roles: config.roles, ...body })
          } catch (error) {
            return Response.json({ ok: false, error: (error as Error).message }, { status: 503 })
          }
        },
      })
    : null

  // Pages indexed before training verdicts were recorded: give each a row, then judge each site's
  // pages on its robots.txt and tdmrep.json (re-crawls add the page's own headers and meta).
  const backfill = config.roles.includes('publish') ? startPolicyBackfill(runtime, log, config.indexPath) : null

  // The mirror inside its byte budget. The publish role is the only writer, so it is the
  // only one that may delete; a page dropped here is still on nichedb, and comes back on
  // its next recrawl.
  const trimmer = config.roles.includes('publish') && config.indexMaxBytes ? startIndexTrim(runtime, log, config) : null

  const stop = async () => {
    log('stopping')
    clearInterval(watchdog)
    backfill?.stop()
    trimmer?.stop()
    server?.stop()
    await Promise.race([running.close(), new Promise((resolve) => setTimeout(resolve, 20_000))])
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

function startIndexTrim(runtime: Runtime, log: (line: string) => void, config: Config) {
  let stopped = false
  let running = false
  let warned = false
  const sweep = async () => {
    if (stopped || running) return
    running = true
    try {
      const result = await runtime.index.trim()
      if (!result.reclaims && result.bytesBefore > config.indexMaxBytes && !warned) {
        warned = true
        log(
          `index trim: ${gb(result.bytesBefore)} is over the ${gb(config.indexMaxBytes)} budget, but this index was made with auto_vacuum = NONE, ` +
            'so deleting rows cannot give the space back. Rebuild it (the records are on nichedb) or give it its own disk.',
        )
      }
      if (result.deleted) log(`index trim: dropped ${result.deleted} pages, ${gb(result.bytesBefore)} -> ${gb(result.bytesAfter)} (budget ${gb(config.indexMaxBytes)})${result.done ? '' : ', more next sweep'}`)
    } catch (error) {
      log(`index trim: ${(error as Error).message}`)
    } finally {
      running = false
    }
  }
  void sweep()
  const timer = setInterval(sweep, config.indexTrimMs)
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

function startPolicyBackfill(runtime: Runtime, log: (line: string) => void, indexPath: string) {
  let stopped = false
  let mapping = true
  const mapper = new Worker(new URL('./policy-map-worker.ts', import.meta.url).href, { env: { ...process.env, CRAWL_INDEX_PATH: indexPath } } as WorkerOptions)
  mapper.onmessage = (event: MessageEvent) => {
    const data = event.data as { done?: number; error?: string }
    if (data.error) log(`policy map: ${data.error}`)
    if (data.done !== undefined) {
      mapping = false
      log(`policy map: ${data.done} legacy pages given a row`)
    }
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const next = (ms: number) => {
    if (!stopped) timer = setTimeout(run, ms)
  }
  const run = async () => {
    try {
      // Sites are judged as their pages are mapped; the mapper runs on its own thread.
      const sites = runtime.index.unknownSites(8)
      if (!sites.length) return next(mapping ? 30_000 : 10 * 60_000)
      await Promise.all(
        sites.map(async (site) => {
          const robots = await runtime.crawler.robotsFor(site).catch(() => 'unavailable' as const)
          const pages = runtime.index.unknownPagesOf(site)
          if (robots === 'unavailable' || robots.read === 'error') return runtime.index.setPolicies(site, [])
          runtime.index.setPolicies(
            site,
            pages.map((p) => {
              const verdict = trainingFor({ robots, path: pathOf(p.url), noai: false, tdmMeta: false })
              return { id: p.id, allowed: verdict.allowed, reason: verdict.allowed ? 'site allows (backfill)' : `${verdict.reason} (backfill)` }
            }),
          )
        }),
      )
      next(500)
    } catch (error) {
      log(`policy backfill: ${(error as Error).message}`)
      next(60_000)
    }
  }
  next(30_000)
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      mapper.terminate()
    },
  }
}

async function seed(args: string[]) {
  const config = configFromEnv()
  const from = flag(args, '--from')
  const file = flag(args, '--file')
  const limit = Number(flag(args, '--limit')) || undefined
  let sites: string[] = []
  if (from === 'nichedb') sites = await sitesFromNichedb(config.nichedbUrl, { ...(limit ? { limit } : {}), ...(config.nichedbKey ? { key: config.nichedbKey } : {}) })
  else if (from === 'ring') sites = sitesFromRing()
  else if (from && OPML_SOURCES[from]) sites = sitesFromOpml(await opmlText(from))
  else if (from) throw new Error(`unknown --from ${from} (nichedb, ring, ${Object.keys(OPML_SOURCES).join(', ')})`)
  const opml = flag(args, '--opml')
  if (opml) sites.push(...sitesFromOpml(await opmlText(opml)))
  if (file) sites.push(...sitesFromText(readFileSync(file, 'utf8')))
  const valued = new Set(['--from', '--file', '--limit', '--opml'])
  sites.push(...sitesFromText(args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? '')).join(' ')))
  if (limit) sites = sites.slice(0, limit)
  const runtime = createRuntime(config, log)
  try {
    const out = await runtime.crawler.scheduleSites([...new Set(sites)], from ?? (file ? 'file' : 'cli'), { first: args.includes('--first') })
    console.log(JSON.stringify({ found: sites.length, ...out }))
  } finally {
    await runtime.close()
  }
}

/**
 * Refill the mirror from nichedb instead of crawling it all again. Safe to stop and
 * re-run: it keeps a cursor, and a page already there is replaced, not duplicated.
 */
async function importCmd(args: string[]) {
  const config = configFromEnv()
  const from = flag(args, '--from') ?? 'nichedb'
  if (from !== 'nichedb') throw new Error(`unknown --from ${from} (nichedb)`)
  const limit = Number(flag(args, '--limit')) || undefined
  const maxGb = Number(flag(args, '--max-gb')) || undefined
  const restart = args.includes('--restart')
  const index = new IndexStore(config.indexPath, config.indexMaxBytes)
  if (restart) index.setImportCursor(null)
  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`
  let lastSaid = 0
  try {
    const result = await importFromNichedb(index, {
      nichedbUrl: config.nichedbUrl,
      ...(config.nichedbKey ? { key: config.nichedbKey } : {}),
      ...(limit ? { limit } : {}),
      ...(maxGb ? { maxBytes: Math.round(maxGb * 1024 ** 3) } : {}),
      onProgress(p) {
        // One line per 20,000 records: enough to watch, not enough to fill a log.
        if (p.read - lastSaid < 20_000) return
        lastSaid = p.read
        log(`import: ${p.read} read, ${p.kept} kept, ${gb(p.bytes)} of ${gb(index.maxBytes)}, cursor ${p.cursor}${p.locked ? `, ${p.locked} waited on the lock` : ''}`)
      },
      onLocked(cursor, message) {
        log(`import: the index is busy at cursor ${cursor} (${message}); waiting 5 s and reading that page again`)
      },
    })
    console.log(JSON.stringify({ ...result, bytes: undefined, size: gb(result.bytes), pages: index.count() }))
  } finally {
    index.close()
  }
}

async function stats() {
  const runtime = createRuntime(configFromEnv(), log)
  try {
    console.log(JSON.stringify(await snapshot(runtime), null, 2))
  } finally {
    await runtime.close()
  }
}

async function read(args: string[]) {
  const config = configFromEnv()
  const url = normalizeUrl(args.find((a) => !a.startsWith('--')) ?? '')
  if (!url) throw new Error('read <url>')
  const r = await politeGet(url, { userAgent: config.userAgent, resolver: resolvesPublic })
  let doc = extract(r.body, normalizeUrl(r.finalUrl) ?? url, { crawler: config.userAgent })
  const shell = needsRender(r.body, doc.textLength)
  if ((args.includes('--render') || shell) && config.obscuraUrls[0]) {
    const rendered = await new ObscuraClient(config.obscuraUrls[0], config.obscuraToken).render(url)
    doc = extract(rendered.html, normalizeUrl(rendered.url) ?? url, { rendered: true, crawler: config.userAgent })
  }
  console.log(
    JSON.stringify(
      { status: r.status, shell, record: { ...doc.record, cards: undefined, jsonld: doc.record.jsonld.length }, enrichment: doc.enrichment, internal: doc.internal.length, external: doc.external.slice(0, 10), site: siteOf(url) },
      null,
      2,
    ),
  )
}

const [command, ...rest] = process.argv.slice(2)
const commands: Record<string, (args: string[]) => Promise<void>> = { worker, seed, import: importCmd, stats: () => stats(), read }
const run = command ? commands[command] : undefined
if (!run) {
  console.log(
    'usage: pit-crawler worker | seed <site...> [--from nichedb|ring] [--file path] [--limit n] | import [--from nichedb] [--limit n] [--max-gb n] [--restart] | stats | read <url> [--render]',
  )
  process.exit(command ? 1 : 0)
}
run(rest).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
