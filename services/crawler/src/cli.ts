#!/usr/bin/env bun
/**
 * pit-crawler: pit.world's spider.
 *
 *   pit-crawler worker                       run the roles in CRAWL_ROLES (default all) until stopped
 *   pit-crawler seed <site...>               crawl these sites
 *   pit-crawler seed --from nichedb|ring     backfill: every site nichedb keeps, or the ring
 *   pit-crawler seed --file <path>           one site per line
 *   pit-crawler stats                        queue depths and counters, as JSON
 *   pit-crawler read <url> [--render]        read one page now and print its record (no Redis)
 */
import { readFileSync } from 'node:fs'
import { configFromEnv, VERSION } from './config.ts'
import { extract, needsRender } from './extract.ts'
import { politeGet } from './fetcher.ts'
import { ObscuraClient } from './obscura.ts'
import { createRuntime, report, snapshot, startWorkers } from './queues.ts'
import { sitesFromNichedb, sitesFromRing, sitesFromText } from './seed.ts'
import { normalizeUrl, resolvesPublic, siteOf } from './url.ts'

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

  const stop = async () => {
    log('stopping')
    clearInterval(watchdog)
    server?.stop()
    await Promise.race([running.close(), new Promise((resolve) => setTimeout(resolve, 20_000))])
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

async function seed(args: string[]) {
  const config = configFromEnv()
  const from = flag(args, '--from')
  const file = flag(args, '--file')
  const limit = Number(flag(args, '--limit')) || undefined
  let sites: string[] = []
  if (from === 'nichedb') sites = await sitesFromNichedb(config.nichedbUrl, { ...(limit ? { limit } : {}) })
  else if (from === 'ring') sites = sitesFromRing()
  else if (from) throw new Error(`unknown --from ${from} (nichedb or ring)`)
  if (file) sites.push(...sitesFromText(readFileSync(file, 'utf8')))
  sites.push(...sitesFromText(args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')).join(' ')))
  if (limit) sites = sites.slice(0, limit)
  const runtime = createRuntime(config, log)
  try {
    const out = await runtime.crawler.scheduleSites([...new Set(sites)], from ?? (file ? 'file' : 'cli'))
    console.log(JSON.stringify({ found: sites.length, ...out }))
  } finally {
    await runtime.close()
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
const commands: Record<string, (args: string[]) => Promise<void>> = { worker, seed, stats: () => stats(), read }
const run = command ? commands[command] : undefined
if (!run) {
  console.log('usage: pit-crawler worker | seed <site...> [--from nichedb|ring] [--file path] [--limit n] | stats | read <url> [--render]')
  process.exit(command ? 1 : 0)
}
run(rest).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
