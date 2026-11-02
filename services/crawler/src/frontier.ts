/**
 * The crawl's shared state, in Redis so any number of workers on any number
 * of boxes agree on it:
 *
 *   pitcrawl:seen:<site>    set of url ids admitted this cycle (expires with the cycle)
 *   pitcrawl:count:<site>   pages admitted this cycle; admission stops at maxPages
 *   pitcrawl:robots:<site>  the parsed robots.txt, for a day
 *   pitcrawl:lease:<site>   held for the gap between two requests to one site
 *   pitcrawl:sites          sorted set: site -> when it was last scheduled
 *   pitcrawl:outbox         records waiting for nichedb, oldest first
 *   pitcrawl:stats          counters
 *
 * Admission is one Lua call, so two workers finding the same link at once
 * still admit it once, and the thousand-page cap is exact.
 */
import type { Redis } from 'ioredis'
import { EMPTY, type Robots } from './robots.ts'
import { urlId } from './url.ts'

export interface Frontier {
  /** Admit a page to this cycle: 'new', 'seen', or 'full' (the site has had its maxPages). */
  admit(site: string, url: string): Promise<'new' | 'seen' | 'full'>
  /** Take the site's request slot for gapMs; 0 when taken, else how long until it frees. */
  lease(site: string, gapMs: number): Promise<number>
  getRobots(site: string): Promise<Robots | null>
  setRobots(site: string, robots: Robots): Promise<void>
  /**
   * Remember a site was scheduled now. False (and nothing changes) when it was
   * already scheduled within cycleMs, or when the index holds maxSites others.
   */
  noteSite(site: string, maxSites: number, cycleMs: number): Promise<boolean>
  sitesDue(olderThanMs: number, limit: number): Promise<string[]>
  push(entries: unknown[], max: number): Promise<void>
  take(count: number): Promise<string[]>
  giveBack(raw: string[]): Promise<void>
  bump(field: string, by?: number): Promise<void>
  stats(): Promise<Record<string, number>>
}

const K = {
  seen: (s: string) => `pitcrawl:seen:${s}`,
  count: (s: string) => `pitcrawl:count:${s}`,
  robots: (s: string) => `pitcrawl:robots:${s}`,
  lease: (s: string) => `pitcrawl:lease:${s}`,
  sites: 'pitcrawl:sites',
  outbox: 'pitcrawl:outbox',
  stats: 'pitcrawl:stats',
}

const ADMIT = `
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then return 0 end
local n = redis.call('INCR', KEYS[2])
if n == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
end
if n > tonumber(ARGV[2]) then return -1 end
return n
`

type WithAdmit = Redis & { pitcrawlAdmit(seen: string, count: string, id: string, max: number, cycleMs: number): Promise<number> }

export class RedisFrontier implements Frontier {
  private readonly redis: WithAdmit
  constructor(
    redis: Redis,
    private readonly maxPages: number,
    private readonly cycleMs: number,
  ) {
    // A fixed script registered once (EVALSHA after the first call), never built from input.
    if (!('pitcrawlAdmit' in redis)) redis.defineCommand('pitcrawlAdmit', { numberOfKeys: 2, lua: ADMIT })
    this.redis = redis as WithAdmit
  }

  async admit(site: string, url: string) {
    const n = Number(await this.redis.pitcrawlAdmit(K.seen(site), K.count(site), urlId(url), this.maxPages, this.cycleMs))
    return n === 0 ? 'seen' : n < 0 ? 'full' : 'new'
  }

  async lease(site: string, gapMs: number) {
    if (gapMs <= 0) return 0
    const ok = await this.redis.set(K.lease(site), '1', 'PX', gapMs, 'NX')
    if (ok) return 0
    const left = await this.redis.pttl(K.lease(site))
    return Math.max(50, left)
  }

  async getRobots(site: string) {
    const raw = await this.redis.get(K.robots(site))
    if (!raw) return null
    try {
      return JSON.parse(raw) as Robots
    } catch {
      return EMPTY
    }
  }

  async setRobots(site: string, robots: Robots) {
    await this.redis.set(K.robots(site), JSON.stringify(robots), 'EX', 86_400)
  }

  async noteSite(site: string, maxSites: number, cycleMs: number) {
    const known = await this.redis.zscore(K.sites, site)
    if (known !== null && Date.now() - Number(known) < cycleMs) return false
    if (known === null && (await this.redis.zcard(K.sites)) >= maxSites) return false
    if (known !== null) {
      // Due again. Two workers both starting it is harmless: page admission still dedupes.
      await this.redis.zadd(K.sites, 'XX', Date.now(), site)
      return true
    }
    // Two workers discovering one new site at once: only the write that lands first schedules it.
    return Number(await this.redis.zadd(K.sites, 'NX', Date.now(), site)) === 1
  }

  async sitesDue(olderThanMs: number, limit: number) {
    return this.redis.zrangebyscore(K.sites, 0, Date.now() - olderThanMs, 'LIMIT', 0, limit)
  }

  async push(entries: unknown[], max: number) {
    if (!entries.length) return
    await this.redis
      .multi()
      .rpush(K.outbox, ...entries.map((e) => JSON.stringify(e)))
      .ltrim(K.outbox, -max, -1)
      .exec()
  }

  async take(count: number) {
    return (await this.redis.lpop(K.outbox, count)) ?? []
  }

  async giveBack(raw: string[]) {
    if (raw.length) await this.redis.lpush(K.outbox, ...[...raw].reverse())
  }

  async bump(field: string, by = 1) {
    await this.redis.hincrby(K.stats, field, by)
  }

  async stats() {
    const [hash, sites, outbox] = await Promise.all([this.redis.hgetall(K.stats), this.redis.zcard(K.sites), this.redis.llen(K.outbox)])
    const out: Record<string, number> = { sites, outbox }
    for (const [k, v] of Object.entries(hash)) out[k] = Number(v)
    return out
  }
}

/** The same contract in memory, for tests and a one-process dry run. */
export class MemoryFrontier implements Frontier {
  seen = new Map<string, Set<string>>()
  leases = new Map<string, number>()
  robots = new Map<string, Robots>()
  sites = new Map<string, number>()
  outbox: string[] = []
  counters: Record<string, number> = {}
  constructor(private readonly maxPages: number) {}
  async admit(site: string, url: string) {
    const set = this.seen.get(site) ?? new Set<string>()
    this.seen.set(site, set)
    const id = urlId(url)
    if (set.has(id)) return 'seen' as const
    set.add(id)
    return set.size > this.maxPages ? ('full' as const) : ('new' as const)
  }
  async lease(site: string, gapMs: number) {
    const until = this.leases.get(site) ?? 0
    if (Date.now() < until) return until - Date.now()
    this.leases.set(site, Date.now() + gapMs)
    return 0
  }
  async getRobots(site: string) {
    return this.robots.get(site) ?? null
  }
  async setRobots(site: string, robots: Robots) {
    this.robots.set(site, robots)
  }
  async noteSite(site: string, maxSites: number, cycleMs: number) {
    const known = this.sites.get(site)
    if (known !== undefined && Date.now() - known < cycleMs) return false
    if (known === undefined && this.sites.size >= maxSites) return false
    this.sites.set(site, Date.now())
    return true
  }
  async sitesDue(olderThanMs: number, limit: number) {
    return [...this.sites.entries()]
      .filter(([, t]) => t <= Date.now() - olderThanMs)
      .slice(0, limit)
      .map(([s]) => s)
  }
  async push(entries: unknown[], max: number) {
    this.outbox.push(...entries.map((e) => JSON.stringify(e)))
    if (this.outbox.length > max) this.outbox.splice(0, this.outbox.length - max)
  }
  async take(count: number) {
    return this.outbox.splice(0, count)
  }
  async giveBack(raw: string[]) {
    this.outbox.unshift(...raw)
  }
  async bump(field: string, by = 1) {
    this.counters[field] = (this.counters[field] ?? 0) + by
  }
  async stats() {
    return { ...this.counters, sites: this.sites.size, outbox: this.outbox.length }
  }
}
