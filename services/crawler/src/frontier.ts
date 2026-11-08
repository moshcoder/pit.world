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
import type { McpServer } from './mcp.ts'
import type { SocialSite } from './social.ts'
import type { Redis } from 'ioredis'
import { EMPTY, type Robots } from './robots.ts'
import { urlId } from './url.ts'

/** One line of the crawl log, newest first on /status. */
export type CrawlEvent = {
  at: string
  kind: 'site' | 'page' | 'render' | 'skip' | 'mcp' | 'social' | 'fail' | 'publish'
  site?: string
  url?: string
  title?: string
  note?: string
}

/** Counters over time: the last hour, the last day, and the day hour by hour (oldest first). */
export type Activity = {
  lastHour: Record<string, number>
  lastDay: Record<string, number>
  hours: Array<{ at: string; counts: Record<string, number> }>
}

const LOG_MAX = 200
const minuteOf = (t: number) => Math.floor(t / 60_000)
const hourOf = (t: number) => Math.floor(t / 3_600_000)
const add = (into: Record<string, number>, from: Record<string, string | number>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + Number(v)
  return into
}

export interface Frontier {
  /** Admit a page to this cycle: 'new', 'seen', or 'full' (the site has had its maxPages). */
  admit(site: string, url: string): Promise<'new' | 'seen' | 'full'>
  /** admit() over a list in one call; stops after the first 'full' (shorter result). */
  admitMany(site: string, urls: string[]): Promise<('new' | 'seen' | 'full')[]>
  /**
   * Take the site's request slot for gapMs. Taken: { waitMs: 0 } and the fetch is
   * counted. Busy: how long until it frees, and how many of the site's admitted pages
   * are not fetched yet, so the caller can spread its retry over the site's backlog.
   */
  lease(site: string, gapMs: number): Promise<{ waitMs: number; pending: number }>
  getRobots(site: string): Promise<Robots | null>
  setRobots(site: string, robots: Robots): Promise<void>
  /** The first start of a site in a cycle claims it; every later one is told no. */
  claimStart(site: string, cycleMs: number): Promise<boolean>
  /** The first sighting of an MCP address in a cycle claims its probe; every later one is told no. */
  claimMcp(endpoint: string, cycleMs: number): Promise<boolean>
  /** A site pitbot recognised as social, kept by host. */
  saveSocial(site: SocialSite): Promise<void>
  listSocial(): Promise<SocialSite[]>
  /** A proved server, kept by address. A later proof replaces it. */
  saveMcp(server: McpServer): Promise<void>
  listMcp(): Promise<McpServer[]>
  mcpCount(): Promise<number>
  push(entries: unknown[], max: number): Promise<void>
  /** Records waiting to be published. */
  outboxLength(): Promise<number>
  take(count: number): Promise<string[]>
  giveBack(raw: string[]): Promise<void>
  /** A counter, kept as a total and in minute and hour buckets for rates. */
  bump(field: string, by?: number): Promise<void>
  stats(): Promise<Record<string, number>>
  /** Gauges: figures set from elsewhere (the site frontier in Postgres), read back by stats(). */
  setGauges(values: Record<string, number>): Promise<void>
  log(event: Omit<CrawlEvent, 'at'>): Promise<void>
  recent(count: number): Promise<CrawlEvent[]>
  activity(): Promise<Activity>
}

// Take the slot (and count the fetch), or say how long until it frees and how much of the
// site is still waiting. One call instead of SET + PTTL + two GETs.
const LEASE = `
if redis.call('SET', KEYS[1], '1', 'PX', ARGV[1], 'NX') then
  redis.call('INCR', KEYS[3])
  redis.call('PEXPIRE', KEYS[3], ARGV[2])
  return {0, 0}
end
local left = redis.call('PTTL', KEYS[1])
local count = math.min(tonumber(redis.call('GET', KEYS[2]) or '0'), tonumber(ARGV[3]))
local done = tonumber(redis.call('GET', KEYS[3]) or '0')
return {left, math.max(0, count - done)}
`

const K = {
  seen: (s: string) => `pitcrawl:seen:${s}`,
  count: (s: string) => `pitcrawl:count:${s}`,
  done: (s: string) => `pitcrawl:done:${s}`,
  robots: (s: string) => `pitcrawl:robots:${s}`,
  lease: (s: string) => `pitcrawl:lease:${s}`,
  started: (s: string) => `pitcrawl:started:${s}`,
  outbox: 'pitcrawl:outbox',
  stats: 'pitcrawl:stats',
  mcp: 'pitcrawl:mcp',
  social: 'pitcrawl:social',
  mcpSeen: (id: string) => `pitcrawl:mcpseen:${id}`,
  minute: (m: number) => `pitcrawl:m:${m}`,
  hour: (h: number) => `pitcrawl:h:${h}`,
  log: 'pitcrawl:log',
}

// The seen-set and count live ARGV[3] ms past the site's last new page (a sliding
// window): a site being crawled keeps them, a finished one lets them go. At hundreds of
// thousands of sites, sets held for the whole 30-day cycle would be gigabytes of Redis;
// the site's own schedule (pitcrawl:sites) is what stops it starting again early.
const ADMIT = `
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then return 0 end
local n = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
if n > tonumber(ARGV[2]) then return -1 end
return n
`

// ADMIT over a page's whole link list in one call, stopping at the cap exactly as the
// one-at-a-time loop did. One round trip instead of up to 300: from a worker 112 ms from
// Redis (vienna, 2026-11-08) the loop alone cost ~30 s a page.
const ADMIT_MANY = `
local max = tonumber(ARGV[1])
local out = {}
for i = 3, #ARGV do
  if redis.call('SADD', KEYS[1], ARGV[i]) == 0 then
    out[#out + 1] = 0
  else
    local n = redis.call('INCR', KEYS[2])
    if n > max then
      out[#out + 1] = -1
      break
    end
    out[#out + 1] = n
  end
end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
return out
`

type WithAdmit = Redis & {
  pitcrawlAdmit(seen: string, count: string, id: string, max: number, cycleMs: number): Promise<number>
  pitcrawlAdmitMany(seen: string, count: string, max: number, cycleMs: number, ...ids: string[]): Promise<number[]>
  pitcrawlLease(lease: string, count: string, done: string, gapMs: number, ttlMs: number, max: number): Promise<[number, number]>
}

export class RedisFrontier implements Frontier {
  private readonly redis: WithAdmit
  constructor(
    redis: Redis,
    private readonly maxPages: number,
    private readonly seenTtlMs: number,
  ) {
    // A fixed script registered once (EVALSHA after the first call), never built from input.
    if (!('pitcrawlAdmit' in redis)) redis.defineCommand('pitcrawlAdmit', { numberOfKeys: 2, lua: ADMIT })
    if (!('pitcrawlAdmitMany' in redis)) redis.defineCommand('pitcrawlAdmitMany', { numberOfKeys: 2, lua: ADMIT_MANY })
    if (!('pitcrawlLease' in redis)) redis.defineCommand('pitcrawlLease', { numberOfKeys: 3, lua: LEASE })
    this.redis = redis as WithAdmit
  }

  async admit(site: string, url: string) {
    const n = Number(await this.redis.pitcrawlAdmit(K.seen(site), K.count(site), urlId(url), this.maxPages, this.seenTtlMs))
    return n === 0 ? 'seen' : n < 0 ? 'full' : 'new'
  }
  async admitMany(site: string, urls: string[]) {
    if (!urls.length) return []
    const out = await this.redis.pitcrawlAdmitMany(K.seen(site), K.count(site), this.maxPages, this.seenTtlMs, ...urls.map(urlId))
    return out.map((n) => (Number(n) === 0 ? 'seen' : Number(n) < 0 ? 'full' : 'new') as 'new' | 'seen' | 'full')
  }

  async lease(site: string, gapMs: number) {
    const [left, pending] = await this.redis.pitcrawlLease(K.lease(site), K.count(site), K.done(site), Math.max(1, gapMs), this.seenTtlMs, this.maxPages)
    return left === 0 ? { waitMs: 0, pending: 0 } : { waitMs: Math.max(50, Number(left)), pending: Number(pending) }
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

  async claimMcp(endpoint: string, cycleMs: number) {
    return (await this.redis.set(K.mcpSeen(urlId(endpoint)), '1', 'PX', cycleMs, 'NX')) === 'OK'
  }
  async saveSocial(site: SocialSite) {
    await this.redis.hset(K.social, site.site, JSON.stringify(site))
  }
  async listSocial() {
    return Object.values(await this.redis.hgetall(K.social)).flatMap((raw) => {
      try {
        return [JSON.parse(raw) as SocialSite]
      } catch {
        return []
      }
    })
  }
  async saveMcp(server: McpServer) {
    await this.redis.hset(K.mcp, server.mcp, JSON.stringify(server))
  }
  async listMcp() {
    return Object.values(await this.redis.hgetall(K.mcp)).flatMap((raw) => {
      try {
        return [JSON.parse(raw) as McpServer]
      } catch {
        return []
      }
    })
  }
  async mcpCount() {
    return this.redis.hlen(K.mcp)
  }

  async claimStart(site: string, cycleMs: number) {
    // A little under the cycle, so the recrawl that comes due at the cycle's end can claim it.
    const ttl = Math.max(60_000, cycleMs - 3_600_000)
    return (await this.redis.set(K.started(site), String(Date.now()), 'PX', ttl, 'NX')) === 'OK'
  }

  async push(entries: unknown[], max: number) {
    if (!entries.length) return
    await this.redis
      .multi()
      .rpush(K.outbox, ...entries.map((e) => JSON.stringify(e)))
      .ltrim(K.outbox, -max, -1)
      .exec()
  }

  async outboxLength() {
    return this.redis.llen(K.outbox)
  }

  async take(count: number) {
    return (await this.redis.lpop(K.outbox, count)) ?? []
  }

  async giveBack(raw: string[]) {
    if (raw.length) await this.redis.lpush(K.outbox, ...[...raw].reverse())
  }

  async bump(field: string, by = 1) {
    const now = Date.now()
    await this.redis
      .multi()
      .hincrby(K.stats, field, by)
      .hincrby(K.minute(minuteOf(now)), field, by)
      .expire(K.minute(minuteOf(now)), 7_200)
      .hincrby(K.hour(hourOf(now)), field, by)
      .expire(K.hour(hourOf(now)), 49 * 3_600)
      .exec()
  }

  async stats() {
    // `sites` and `sites_parked` are in the hash: the site gate copies them from Postgres.
    const [hash, outbox] = await Promise.all([this.redis.hgetall(K.stats), this.redis.llen(K.outbox)])
    const out: Record<string, number> = { outbox }
    for (const [k, v] of Object.entries(hash)) out[k] = Number(v)
    return out
  }
  /** Gauges (set, not counted): the site frontier's size, copied from Postgres. */
  async setGauges(values: Record<string, number>) {
    await this.redis.hset(K.stats, values)
  }

  async log(event: Omit<CrawlEvent, 'at'>) {
    await this.redis
      .multi()
      .lpush(K.log, JSON.stringify({ at: new Date().toISOString(), ...event }))
      .ltrim(K.log, 0, LOG_MAX - 1)
      .exec()
  }

  async recent(count: number) {
    const raw = await this.redis.lrange(K.log, 0, Math.min(count, LOG_MAX) - 1)
    return raw.flatMap((line) => {
      try {
        return [JSON.parse(line) as CrawlEvent]
      } catch {
        return []
      }
    })
  }

  async activity() {
    const now = Date.now()
    const m = minuteOf(now)
    const h = hourOf(now)
    const pipe = this.redis.pipeline()
    for (let i = 0; i < 60; i++) pipe.hgetall(K.minute(m - i))
    for (let i = 23; i >= 0; i--) pipe.hgetall(K.hour(h - i))
    const results = ((await pipe.exec()) ?? []).map(([, v]) => (v ?? {}) as Record<string, string>)
    const lastHour: Record<string, number> = {}
    for (const r of results.slice(0, 60)) add(lastHour, r)
    const hourly = results.slice(60)
    const lastDay: Record<string, number> = {}
    for (const r of hourly) add(lastDay, r)
    return {
      lastHour,
      lastDay,
      hours: hourly.map((r, i) => ({ at: new Date((h - 23 + i) * 3_600_000).toISOString(), counts: add({}, r) })),
    }
  }
}

/** The same contract in memory, for tests and a one-process dry run. */
export class MemoryFrontier implements Frontier {
  seen = new Map<string, Set<string>>()
  leases = new Map<string, number>()
  robots = new Map<string, Robots>()
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
  async admitMany(site: string, urls: string[]) {
    const out: ('new' | 'seen' | 'full')[] = []
    for (const url of urls) {
      const v = await this.admit(site, url)
      out.push(v)
      if (v === 'full') break
    }
    return out
  }
  fetched = new Map<string, number>()
  async lease(site: string, gapMs: number) {
    const until = this.leases.get(site) ?? 0
    if (Date.now() < until) {
      const admitted = Math.min(this.seen.get(site)?.size ?? 0, this.maxPages)
      return { waitMs: until - Date.now(), pending: Math.max(0, admitted - (this.fetched.get(site) ?? 0)) }
    }
    this.leases.set(site, Date.now() + gapMs)
    this.fetched.set(site, (this.fetched.get(site) ?? 0) + 1)
    return { waitMs: 0, pending: 0 }
  }

  social = new Map<string, SocialSite>()
  async saveSocial(site: SocialSite) {
    this.social.set(site.site, site)
  }
  async listSocial() {
    return [...this.social.values()]
  }
  mcpSeen = new Map<string, number>()
  mcp = new Map<string, McpServer>()
  async claimMcp(endpoint: string, cycleMs: number) {
    if ((this.mcpSeen.get(endpoint) ?? 0) > Date.now()) return false
    this.mcpSeen.set(endpoint, Date.now() + cycleMs)
    return true
  }
  async saveMcp(server: McpServer) {
    this.mcp.set(server.mcp, server)
  }
  async listMcp() {
    return [...this.mcp.values()]
  }
  async mcpCount() {
    return this.mcp.size
  }

  async getRobots(site: string) {
    return this.robots.get(site) ?? null
  }
  async setRobots(site: string, robots: Robots) {
    this.robots.set(site, robots)
  }
  started = new Set<string>()
  async claimStart(site: string) {
    if (this.started.has(site)) return false
    this.started.add(site)
    return true
  }
  async push(entries: unknown[], max: number) {
    this.outbox.push(...entries.map((e) => JSON.stringify(e)))
    if (this.outbox.length > max) this.outbox.splice(0, this.outbox.length - max)
  }
  async outboxLength() {
    return this.outbox.length
  }
  async take(count: number) {
    return this.outbox.splice(0, count)
  }
  async giveBack(raw: string[]) {
    this.outbox.unshift(...raw)
  }
  events: CrawlEvent[] = []
  gauges: Record<string, number> = {}
  async setGauges(values: Record<string, number>) {
    Object.assign(this.gauges, values)
  }
  async bump(field: string, by = 1) {
    this.counters[field] = (this.counters[field] ?? 0) + by
  }
  async stats() {
    return { ...this.counters, ...this.gauges, outbox: this.outbox.length }
  }
  async log(event: Omit<CrawlEvent, 'at'>) {
    this.events.unshift({ at: new Date().toISOString(), ...event })
    this.events.length = Math.min(this.events.length, LOG_MAX)
  }
  async recent(count: number) {
    return this.events.slice(0, count)
  }
  async activity() {
    // In memory everything counted happened "this hour".
    const now = new Date(hourOf(Date.now()) * 3_600_000).toISOString()
    return { lastHour: { ...this.counters }, lastDay: { ...this.counters }, hours: [{ at: now, counts: { ...this.counters } }] }
  }
}
