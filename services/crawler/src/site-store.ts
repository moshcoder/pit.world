/**
 * The site frontier: every site pitbot knows, which are parked (found, never started)
 * and when each started one is due again. It lives in Postgres, pit.world's own
 * Supabase (pit-world-supabase, schema pitcrawl), not in Redis: a known site cost
 * ~90 B of Redis RAM and a parked one ~40 B more, so 1M sites was the practical
 * ceiling of a 2 GB Redis (2026-11-08). On disk it is ~100 B a site, so 100M fit.
 *
 * Any number of crawler processes write it at once: inserts are ON CONFLICT DO NOTHING
 * and every claim is FOR UPDATE SKIP LOCKED. Counts are kept in `counts` by the same
 * statements, and recomputed by resync(), since count(*) over 100M rows is seconds.
 */
import { SQL } from 'bun'

export type SiteRow = { site: string; source: string }
export type SiteCounts = { known: number; parked: number }

export interface SiteStore {
  /** Record sites not known yet; returns the ones that were new. `queueNow` marks them started now instead of parked. */
  add(rows: SiteRow[], queueNow: boolean): Promise<string[]>
  /** Record sites as started now whether known or not (a submission, a --first seed). */
  force(rows: SiteRow[]): Promise<void>
  /** The oldest parked sites, now marked started. */
  takeParked(count: number): Promise<SiteRow[]>
  /** Started sites last scheduled more than olderThanMs ago, now rescheduled. */
  takeDue(olderThanMs: number, count: number): Promise<string[]>
  /** From the counters: cheap, slightly behind under concurrent writes until resync(). */
  counts(): Promise<SiteCounts>
  /** Recompute the counters exactly. */
  resync(): Promise<SiteCounts>
  /** Bulk load for the one-off move from Redis: `scheduledAt` ms, or null for parked. */
  load(rows: (SiteRow & { scheduledAt: number | null })[]): Promise<number>
  close(): Promise<void>
}

/**
 * Bun's Postgres client sends a JS array as `a,b`, not an array literal, so arrays are
 * written as literals and cast at the call site (skill bun-sql-array-params).
 */
export function pgArray(values: readonly (string | number | boolean | null)[]): string {
  return `{${values.map((v) => (v === null ? 'NULL' : `"${String(v).replace(/(["\\])/g, '\\$1')}"`)).join(',')}}`
}

const dedupe = (rows: SiteRow[]) => [...new Map(rows.map((r) => [r.site, r])).values()]

const SCHEMA = [
  `create table if not exists sites (
    id bigint generated always as identity,
    site text primary key,
    source text not null,
    found_at timestamptz not null default now(),
    scheduled_at timestamptz
  )`,
  // Parked = never scheduled; taken oldest first.
  `create index if not exists sites_parked on sites (id) where scheduled_at is null`,
  `create index if not exists sites_due on sites (scheduled_at) where scheduled_at is not null`,
  `create table if not exists counts (k text primary key, n bigint not null)`,
  `insert into counts (k, n) values ('known', 0), ('parked', 0) on conflict do nothing`,
]

export class PgSiteStore implements SiteStore {
  private sql: SQL
  private ready: Promise<void> | null = null
  private cached: { at: number; counts: SiteCounts } | null = null

  constructor(url: string, max = 8) {
    this.sql = new SQL({ url, max, idleTimeout: 60 })
  }

  private init() {
    this.ready ??= (async () => {
      for (const statement of SCHEMA) await this.sql.unsafe(statement)
    })().catch((error) => {
      this.ready = null
      throw error
    })
    return this.ready
  }

  async add(rows: SiteRow[], queueNow: boolean) {
    rows = dedupe(rows)
    if (!rows.length) return []
    await this.init()
    const out = await this.sql`
      with ins as (
        insert into sites (site, source, scheduled_at)
        select site, source, case when ${queueNow}::boolean then now() end
        from unnest(${pgArray(rows.map((r) => r.site))}::text[], ${pgArray(rows.map((r) => r.source))}::text[]) as t(site, source)
        on conflict (site) do nothing
        returning site, scheduled_at
      ), k as (
        update counts set n = n + (select count(*) from ins) where k = 'known'
      ), p as (
        update counts set n = n + (select count(*) from ins where scheduled_at is null) where k = 'parked'
      )
      select site from ins`
    return (out as { site: string }[]).map((r) => r.site)
  }

  async force(rows: SiteRow[]) {
    rows = dedupe(rows)
    if (!rows.length) return
    await this.init()
    await this.sql`
      with input as (
        select * from unnest(${pgArray(rows.map((r) => r.site))}::text[], ${pgArray(rows.map((r) => r.source))}::text[]) as t(site, source)
      ), prev as (
        select s.site, s.scheduled_at from sites s join input using (site)
      ), up as (
        insert into sites (site, source, scheduled_at) select site, source, now() from input
        on conflict (site) do update set scheduled_at = now()
        returning site
      ), k as (
        update counts set n = n + (select count(*) from input) - (select count(*) from prev) where k = 'known'
      ), p as (
        update counts set n = n - (select count(*) from prev where scheduled_at is null) where k = 'parked'
      )
      select count(*) from up`
  }

  async takeParked(count: number) {
    if (count <= 0) return []
    await this.init()
    const out = await this.sql`
      with picked as (
        select site from sites where scheduled_at is null order by id limit ${count} for update skip locked
      ), upd as (
        update sites s set scheduled_at = now() from picked where s.site = picked.site returning s.id, s.site, s.source
      ), p as (
        update counts set n = n - (select count(*) from upd) where k = 'parked'
      )
      select site, source from upd order by id`
    return out as SiteRow[]
  }

  async takeDue(olderThanMs: number, count: number) {
    await this.init()
    const out = await this.sql`
      with picked as (
        select site from sites
        where scheduled_at is not null and scheduled_at < now() - make_interval(secs => ${olderThanMs / 1000}::float8)
        order by scheduled_at limit ${count} for update skip locked
      )
      update sites s set scheduled_at = now() from picked where s.site = picked.site returning s.site`
    return (out as { site: string }[]).map((r) => r.site)
  }

  async counts() {
    // Every discovered link asks, to honour the site limit: a few seconds stale is fine.
    if (this.cached && Date.now() - this.cached.at < 10_000) return this.cached.counts
    await this.init()
    const out = (await this.sql`select k, n from counts`) as { k: string; n: string | number }[]
    const get = (k: string) => Math.max(0, Number(out.find((r) => r.k === k)?.n ?? 0))
    const counts = { known: get('known'), parked: get('parked') }
    this.cached = { at: Date.now(), counts }
    return counts
  }

  async resync() {
    await this.init()
    await this.sql`update counts set n = (select count(*) from sites) where k = 'known'`
    await this.sql`update counts set n = (select count(*) from sites where scheduled_at is null) where k = 'parked'`
    this.cached = null
    return this.counts()
  }

  async load(rows: (SiteRow & { scheduledAt: number | null })[]) {
    const unique = [...new Map(rows.map((r) => [r.site, r])).values()]
    if (!unique.length) return 0
    await this.init()
    const out = await this.sql`
      insert into sites (site, source, scheduled_at)
      select site, source, case when at is null then null else to_timestamp(at / 1000.0) end
      from unnest(${pgArray(unique.map((r) => r.site))}::text[], ${pgArray(unique.map((r) => r.source))}::text[], ${pgArray(unique.map((r) => r.scheduledAt))}::float8[]) as t(site, source, at)
      on conflict (site) do nothing
      returning 1`
    return (out as unknown[]).length
  }

  async close() {
    await this.sql.close()
  }
}

/** For tests and a laptop without Postgres. Nothing survives a restart. */
export class MemorySiteStore implements SiteStore {
  rows = new Map<string, { source: string; scheduledAt: number | null; id: number }>()
  private next = 1

  async add(rows: SiteRow[], queueNow: boolean) {
    const fresh: string[] = []
    for (const r of dedupe(rows)) {
      if (this.rows.has(r.site)) continue
      this.rows.set(r.site, { source: r.source, scheduledAt: queueNow ? Date.now() : null, id: this.next++ })
      fresh.push(r.site)
    }
    return fresh
  }
  async force(rows: SiteRow[]) {
    for (const r of dedupe(rows)) {
      const row = this.rows.get(r.site)
      if (row) row.scheduledAt = Date.now()
      else this.rows.set(r.site, { source: r.source, scheduledAt: Date.now(), id: this.next++ })
    }
  }
  async takeParked(count: number) {
    const picked = [...this.rows.entries()]
      .filter(([, r]) => r.scheduledAt === null)
      .sort((a, b) => a[1].id - b[1].id)
      .slice(0, Math.max(0, count))
    for (const [, r] of picked) r.scheduledAt = Date.now()
    return picked.map(([site, r]) => ({ site, source: r.source }))
  }
  async takeDue(olderThanMs: number, count: number) {
    const due = [...this.rows.entries()]
      .filter(([, r]) => r.scheduledAt !== null && r.scheduledAt <= Date.now() - olderThanMs)
      .sort((a, b) => a[1].scheduledAt! - b[1].scheduledAt!)
      .slice(0, count)
    for (const [, r] of due) r.scheduledAt = Date.now()
    return due.map(([site]) => site)
  }
  async counts() {
    let parked = 0
    for (const r of this.rows.values()) if (r.scheduledAt === null) parked++
    return { known: this.rows.size, parked }
  }
  async resync() {
    return this.counts()
  }
  async load(rows: (SiteRow & { scheduledAt: number | null })[]) {
    let n = 0
    for (const r of rows) {
      if (this.rows.has(r.site)) continue
      this.rows.set(r.site, { source: r.source, scheduledAt: r.scheduledAt, id: this.next++ })
      n++
    }
    return n
  }
  async close() {}
}
