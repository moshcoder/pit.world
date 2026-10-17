/**
 * Promotion campaigns: list and promote the businesses an outreach campaign targets, measure what that
 * did for each one over its own window, and only then write to them, with the numbers.
 *
 * The source of a campaign is a complete snapshot of an OutreachGraph campaign (see
 * scripts/outreachgraph-campaign-export.sh). Every source row ends in exactly one disposition; leads
 * that are the same business (same domain) become one member with all their lead ids. Members are
 * pit.world listings: a member never gets a second page, and leaving the campaign only takes away its
 * place at the top of the directory.
 *
 * Everything here is deterministic: when a window starts and ends, what a metric counts, whether a
 * budget allows a job. Copy is written from the listing's own facts by templates, not by a model.
 *
 * Privacy: lead names and addresses live in promo_leads and are never in a public page, an event or a
 * URL. Events carry no IP and no cookie; a visitor is a hash of (address, browser, a salt that is
 * thrown away when its UTC day ends), so pit.world can count distinct visitors in a day and never
 * across days.
 */
import type { Database } from 'bun:sqlite'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { normalizeDomain, type Listing, type Listings } from './listings.js'
import { ensurePromotionSchema } from './promotion-schema.js'

export { ensurePromotionSchema } from './promotion-schema.js'

export const RULES_VERSION = 'promo-metrics/1'
const DAY = 24 * 3600 * 1000
const FREEMAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'comcast.net', 'sbcglobal.net', 'att.net', 'msn.com', 'live.com', 'me.com', 'ymail.com', 'pacbell.net', 'earthlink.net', 'mac.com', 'protonmail.com', 'verizon.net'])
/** Networks where myna's CrawlProof plugin buys an ad after each post: organic jobs never go there. */
export const AD_NETWORKS = new Set(['gitblog', 'htmlblog', 'bl0ggers', 'autoblog', 'devto'])

export const EVENT_TYPES = ['listing_view', 'website_click', 'phone_click', 'inquiry_sent', 'roundup_view'] as const
export type EventType = (typeof EVENT_TYPES)[number]
export const PLACEMENT_STATES = ['draft', 'ready', 'scheduled', 'publishing', 'published', 'verified', 'failed', 'uncertain', 'removed'] as const
export type PlacementState = (typeof PLACEMENT_STATES)[number]

/** One row of an OutreachGraph campaign snapshot, as the exporter writes it. */
export type SnapshotRow = {
  leadId: string
  order?: number
  name?: string | null
  kind?: string | null
  title?: string | null
  company?: string | null
  domain?: string | null
  location?: string | null
  emails?: string[]
  socials?: Array<{ network: string; url: string | null }>
  suppressed?: boolean
  suppressLists?: string[] | null
  campaigns?: Array<{ id: string; name?: string; approvalMode: string; status: string; memberStatus?: string }>
  contacts?: { outbound: number; inbound: number; lastAt: string | null }
}
export type Snapshot = { source: string; campaignId: string; campaignName?: string; snapshotAt: string; complete: boolean; total?: number; rows: SnapshotRow[] }

export type CampaignConfig = {
  /** Where the roundup lives: /roundup/<slug>. */
  slug: string
  title: string
  /** Shown above the roundup: how these businesses were chosen. */
  intro: string
  timezone: string
  periodDays: number
  /** Spotlight accounts (myna account ids), taking turns; each posts at most perAccountPerDay. */
  spotlightAccounts: string[]
  perAccountPerDay: number
  /** Accounts that announce the roundup itself. */
  announceAccounts: string[]
  /** Local hour (campaign timezone) the first post of a day is handed to myna. */
  postHour: number
  budget: { paidCents: number; aiCents: number }
  sender: { name: string; company: string; email: string; footer: string } | null
  /** Sending stays off until an operator turns it on. Drafts are always made. */
  sendAuthorized: boolean
}

export const DEFAULT_CONFIG: CampaignConfig = {
  slug: '',
  title: '',
  intro: '',
  timezone: 'America/Los_Angeles',
  periodDays: 30,
  spotlightAccounts: [],
  perAccountPerDay: 1,
  announceAccounts: [],
  postHour: 10,
  budget: { paidCents: 0, aiCents: 0 },
  sender: null,
  sendAuthorized: false,
}

export type Disposition = 'matched' | 'merged' | 'unresolved' | 'excluded'
export type MemberState = 'verified' | 'unverified' | 'unresolved' | 'excluded' | 'left'
export type HoldState = 'held' | 'conflict' | 'unknown'

export class PromoError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 422 | 423, readonly code: string, message: string) {
    super(message)
  }
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const id = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`
const json = <T>(value: string | null | undefined, fallback: T): T => {
  try {
    return value ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}

/** The domain a lead's business lives at: the company's, else a business (not freemail) address's. */
export function leadDomain(row: SnapshotRow): string | null {
  const own = normalizeDomain(row.domain ?? '')
  if (own && !FREEMAIL.has(own)) return own
  for (const email of row.emails ?? []) {
    const d = normalizeDomain(email.split('@')[1] ?? '')
    if (d && !FREEMAIL.has(d)) return d
  }
  return null
}

/** Whether every way the upstream could send to this lead is held: suppressed, or only in campaigns that wait for approval. */
export function holdOf(rows: SnapshotRow[]): { hold: HoldState; detail: string } {
  if (!rows.length) return { hold: 'unknown', detail: 'no source lead' }
  const live: string[] = []
  for (const row of rows) {
    if (row.suppressed) continue
    if (!row.campaigns) return { hold: 'unknown', detail: `lead ${row.leadId}: campaign state not in the snapshot` }
    for (const c of row.campaigns) if (c.status === 'active' && c.approvalMode === 'trusted_automation') live.push(`${row.leadId} in ${c.id} (autopilot)`)
  }
  if (live.length) return { hold: 'conflict', detail: `auto-sending upstream: ${live.join('; ')}` }
  const lists = [...new Set(rows.flatMap((r) => r.suppressLists ?? []))]
  return { hold: 'held', detail: rows.every((r) => r.suppressed) ? `suppressed upstream${lists.length ? ` (${lists.join(', ')})` : ''}` : 'only in campaigns that wait for approval' }
}

/** A short, factual spotlight from the listing's own words. Fits Bluesky's 300 characters with the link. */
export function spotlightText(l: Listing, link: string, max = 300): string {
  const place = l.city ? `${l.city}${l.region ? `, ${l.region}` : ''}` : l.area
  const first = (l.description.match(/^[^.!?]*[.!?]/)?.[0] ?? l.description).trim()
  const license = /^CSLB #\d+/.exec(l.license)?.[0]
  const head = `Local builders, one at a time: ${l.name}${place ? ` (${place})` : ''}.`
  const tail = `${license ? ` ${license.replace('CSLB #', 'CSLB license ')}, active when we checked.` : ''}\n\n${link}`
  const room = max - head.length - tail.length - 1
  const middle = first && room > 40 ? ` ${first.length > room ? `${first.slice(0, room - 1).replace(/\s+\S*$/, '')}…` : first}` : ''
  return `${head}${middle}${tail}`
}

export function roundupAnnouncement(config: CampaignConfig, count: number, link: string, max = 300): string {
  const text = `${config.title}: ${count} contractors who pulled permits in town, each with a license we checked and a page of their own. No paid placement, nobody asked to be on it.\n\n${link}`
  return text.length <= max ? text : `${config.title}: ${count} local contractors, licenses checked, no paid placement.\n\n${link}`
}

const fmtDay = (ms: number, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(ms))
/** Milliseconds since the epoch of `hour`:00 on the local day of `ms` in `tz`. */
export function localHour(ms: number, tz: string, hour: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  const guess = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour)
  // The offset at the target instant (DST changes between now and then are why this is computed twice).
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]))
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - t
  }
  return guess - offsetAt(guess - offsetAt(guess))
}

export type Metric = { value: number | null; definition: string; source: string; note?: string }
export type ReportData = {
  campaign: { id: string; name: string }
  business: { domain: string; name: string; listingUrl: string }
  period: { id: string; seq: number; startedAt: string; endsAt: string; startLocal: string; endLocal: string; timezone: string }
  placements: Array<{ id: string; kind: string; channel: string; account: string; url: string; verifiedAt: string | null; sharedWith: number }>
  metrics: Record<string, Metric>
  referrals: { byPlacement: Array<{ placementId: string; views: number; clicks: number }>; promotionViews: number; promotionClicks: number; unattributedViews: number; unattributedClicks: number }
  exclusions: Record<string, number>
  gaps: Array<{ kind: string; from: string; to: string | null; note: string }>
  economics: { paidCents: number; aiCents: number; operatorMinutes: number | null }
  nextStep: string
  cutoff: string
  rulesVersion: string
}

type Deliverer = {
  /** Upstream suppression, opt-out and bounce state at the moment of sending. null = cannot tell. */
  suppressed(email: string): Promise<boolean | null>
  send(message: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<{ id: string }>
}

export class Promotion {
  readonly db: Database

  constructor(
    readonly listings: Listings,
    readonly site = 'https://pit.world',
    private now = () => Date.now(),
    private deliverer: Deliverer | null = null,
  ) {
    this.db = listings.db
    ensurePromotionSchema(this.db)
  }

  // --- audit, jobs, idempotency ------------------------------------------------------
  audit(actor: string, action: string, campaignId: string | null, subject = '', detail: unknown = {}): void {
    this.db.run('INSERT INTO promo_audit (at, actor, campaign_id, action, subject, detail) VALUES (?, ?, ?, ?, ?, ?)', [this.now(), actor, campaignId, action, subject, JSON.stringify(detail)])
  }

  auditLog(campaignId: string, limit = 100): Array<{ at: number; actor: string; action: string; subject: string; detail: unknown }> {
    return (this.db.query('SELECT * FROM promo_audit WHERE campaign_id = ? ORDER BY at DESC LIMIT ?').all(campaignId, limit) as any[]).map((r) => ({ ...r, detail: json(r.detail, {}) }))
  }

  /** Run once per key: a second call with the same key returns the first answer. */
  idempotent<T>(key: string | undefined, operation: string, run: () => T): T {
    if (!key) return run()
    const k = `${operation}:${key}`.slice(0, 300)
    const hit = this.db.query('SELECT response FROM promo_idempotency WHERE key = ?').get(k) as { response: string } | null
    if (hit) return JSON.parse(hit.response) as T
    const result = run()
    this.db.run('INSERT OR IGNORE INTO promo_idempotency (key, operation, response, at) VALUES (?, ?, ?, ?)', [k, operation, JSON.stringify(result), this.now()])
    return result
  }

  /** A durable job: created once per key (a restarted worker finds it, never makes a second). */
  job(kind: string, key: string, campaignId: string | null): { id: string; created: boolean; state: string } {
    const existing = this.db.query('SELECT id, state FROM promo_jobs WHERE key = ?').get(key) as { id: string; state: string } | null
    if (existing) return { id: existing.id, created: false, state: existing.state }
    const jobId = id('job')
    this.db.run('INSERT OR IGNORE INTO promo_jobs (id, key, kind, campaign_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [jobId, key, kind, campaignId, 'queued', this.now(), this.now()])
    const row = this.db.query('SELECT id, state FROM promo_jobs WHERE key = ?').get(key) as { id: string; state: string }
    return { id: row.id, created: row.id === jobId, state: row.state }
  }

  jobStatus(jobId: string): unknown {
    const row = this.db.query('SELECT * FROM promo_jobs WHERE id = ?').get(jobId) as any
    if (!row) throw new PromoError(404, 'not_found', 'no such job')
    return { ...row, result: json(row.result, row.result) }
  }

  private finishJob(jobId: string, state: 'done' | 'failed', result: unknown, error = ''): void {
    this.db.run('UPDATE promo_jobs SET state = ?, result = ?, error = ?, attempts = attempts + 1, lease_until = NULL, updated_at = ? WHERE id = ?', [state, JSON.stringify(result ?? null), error, this.now(), jobId])
  }

  // --- campaigns -----------------------------------------------------------------------
  createCampaign(input: { name: string; source: string; sourceRef: string; config?: Partial<CampaignConfig> }, actor = 'operator'): string {
    const existing = this.db.query('SELECT id FROM promo_campaigns WHERE source = ? AND source_ref = ?').get(input.source, input.sourceRef) as { id: string } | null
    if (existing) return existing.id
    const config = { ...DEFAULT_CONFIG, ...input.config }
    if (!/^[a-z0-9-]{3,60}$/.test(config.slug)) throw new PromoError(400, 'bad_slug', 'config.slug must be 3-60 lowercase letters, digits or dashes')
    const cid = id('pcm')
    this.db.run('INSERT INTO promo_campaigns (id, name, source, source_ref, state, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [cid, input.name, input.source, input.sourceRef, 'draft', JSON.stringify(config), this.now(), this.now()])
    this.audit(actor, 'campaign.create', cid, input.sourceRef, { config })
    return cid
  }

  campaign(campaignId: string): { id: string; name: string; source: string; sourceRef: string; state: string; config: CampaignConfig; launchedAt: number | null } {
    const row = this.db.query('SELECT * FROM promo_campaigns WHERE id = ? OR source_ref = ?').get(campaignId, campaignId) as any
    if (!row) throw new PromoError(404, 'not_found', 'no such campaign')
    return { id: row.id, name: row.name, source: row.source, sourceRef: row.source_ref, state: row.state, config: { ...DEFAULT_CONFIG, ...json(row.config, {}) }, launchedAt: row.launched_at }
  }

  campaigns(): Array<ReturnType<Promotion['campaign']>> {
    return (this.db.query('SELECT id FROM promo_campaigns ORDER BY created_at').all() as Array<{ id: string }>).map((r) => this.campaign(r.id))
  }

  bySlug(slug: string): ReturnType<Promotion['campaign']> | null {
    for (const c of this.campaigns()) if (c.config.slug === slug && c.state !== 'draft') return c
    return null
  }

  configure(campaignId: string, changes: Partial<CampaignConfig>, actor = 'operator'): CampaignConfig {
    const c = this.campaign(campaignId)
    const next = { ...c.config, ...changes, budget: { ...c.config.budget, ...(changes.budget ?? {}) } }
    for (const account of next.spotlightAccounts) {
      if (AD_NETWORKS.has(account.split(':')[0]!)) throw new PromoError(422, 'ad_network', `${account}: posts there buy a CrawlProof ad; organic spotlights cannot use it`)
    }
    this.db.run('UPDATE promo_campaigns SET config = ?, updated_at = ? WHERE id = ?', [JSON.stringify(next), this.now(), c.id])
    this.audit(actor, 'campaign.configure', c.id, '', { changes })
    return next
  }

  /** Pause stops new posts and sends; reports, priority and every record stay. */
  setState(campaignId: string, state: 'active' | 'paused' | 'stopped', actor = 'operator'): string {
    const c = this.campaign(campaignId)
    if (state === 'active' && !c.launchedAt) throw new PromoError(409, 'not_launched', 'launch the campaign first')
    this.db.run('UPDATE promo_campaigns SET state = ?, updated_at = ? WHERE id = ?', [state, this.now(), c.id])
    if (state !== 'active') this.db.run("UPDATE promo_placements SET lease_owner = NULL, lease_until = NULL, state = 'ready' WHERE campaign_id = ? AND state = 'publishing' AND attempts = 0", [c.id])
    this.audit(actor, `campaign.${state}`, c.id)
    return state
  }

  // --- import ----------------------------------------------------------------------------
  /**
   * Import a snapshot. The same snapshot twice changes nothing (same checksum, same run). A partial
   * snapshot only adds and updates; only a complete one can tell that a lead left the campaign.
   */
  import(campaignId: string, snapshot: Snapshot, options: { dryRun?: boolean; actor?: string } = {}) {
    const c = this.campaign(campaignId)
    if (snapshot.source !== c.source || snapshot.campaignId !== c.sourceRef) throw new PromoError(422, 'wrong_source', `snapshot is for ${snapshot.source} ${snapshot.campaignId}, not ${c.source} ${c.sourceRef}`)
    if (!Array.isArray(snapshot.rows)) throw new PromoError(422, 'bad_snapshot', 'rows missing')
    if (snapshot.complete && typeof snapshot.total === 'number' && snapshot.total !== snapshot.rows.length) throw new PromoError(422, 'incomplete', `snapshot says ${snapshot.total} rows and has ${snapshot.rows.length}`)
    const leadIds = new Set<string>()
    for (const row of snapshot.rows) {
      if (typeof row?.leadId !== 'string' || !row.leadId) throw new PromoError(422, 'bad_row', 'every row needs a leadId')
      if (leadIds.has(row.leadId)) throw new PromoError(422, 'duplicate_lead', `lead ${row.leadId} appears twice`)
      leadIds.add(row.leadId)
    }
    const checksum = sha(JSON.stringify(snapshot.rows))
    const previous = this.db.query('SELECT id, totals FROM promo_imports WHERE campaign_id = ? AND checksum = ?').get(c.id, checksum) as { id: string; totals: string } | null
    if (previous && !options.dryRun) return { importId: previous.id, repeated: true, checksum, ...json<any>(previous.totals, {}) }

    const exclusions = new Map((this.db.query('SELECT subject, reason FROM promo_exclusions WHERE campaign_id = ?').all(c.id) as Array<{ subject: string; reason: string }>).map((r) => [r.subject, r.reason]))
    const groups = new Map<string, SnapshotRow[]>()
    const rows: Array<{ index: number; row: SnapshotRow; domain: string | null; disposition: Disposition; reason: string }> = []
    snapshot.rows.forEach((row, index) => {
      const domain = leadDomain(row)
      const excluded = exclusions.get(row.leadId) ?? (domain ? exclusions.get(domain) : undefined)
      if (excluded) return rows.push({ index, row, domain, disposition: 'excluded', reason: excluded })
      if (!domain) return rows.push({ index, row, domain, disposition: 'unresolved', reason: 'no business website: neither a company domain nor a non-freemail address' })
      const first = !groups.has(domain)
      groups.set(domain, [...(groups.get(domain) ?? []), row])
      rows.push({ index, row, domain, disposition: first ? 'matched' : 'merged', reason: first ? '' : `same business as an earlier lead (${domain})` })
    })
    const members: Array<{ domain: string; state: MemberState; reason: string; hold: ReturnType<typeof holdOf>; verification: unknown }> = []
    for (const [domain, leads] of groups) {
      const listing = this.listingRow(domain)
      const check = this.verifyListing(listing)
      members.push({ domain, state: check.ok ? 'verified' : 'unverified', reason: check.reason, hold: holdOf(leads), verification: check.evidence })
    }
    const totals = {
      sourceRows: snapshot.rows.length,
      businesses: groups.size,
      matched: rows.filter((r) => r.disposition === 'matched').length,
      merged: rows.filter((r) => r.disposition === 'merged').length,
      unresolved: rows.filter((r) => r.disposition === 'unresolved').length,
      excluded: rows.filter((r) => r.disposition === 'excluded').length,
      verified: members.filter((m) => m.state === 'verified').length,
      unverified: members.filter((m) => m.state === 'unverified').length,
      holdConflicts: members.filter((m) => m.hold.hold !== 'held').length,
      complete: snapshot.complete,
    }
    if (totals.matched + totals.merged + totals.unresolved + totals.excluded !== totals.sourceRows) throw new Error('import reconciliation does not add up')
    if (options.dryRun) return { importId: null, repeated: false, checksum, ...totals, rows: rows.map((r) => ({ leadId: r.row.leadId, domain: r.domain, disposition: r.disposition, reason: r.reason })) }

    const importId = id('imp')
    const stamp = this.now()
    const tx = this.db.transaction(() => {
      this.db.run('INSERT INTO promo_imports (id, campaign_id, snapshot_at, complete, checksum, rows_total, totals, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [importId, c.id, snapshot.snapshotAt, snapshot.complete ? 1 : 0, checksum, snapshot.rows.length, JSON.stringify(totals), stamp])
      for (const r of rows) {
        this.db.run('INSERT INTO promo_import_rows (import_id, row_index, lead_id, name, domain, disposition, reason) VALUES (?, ?, ?, ?, ?, ?, ?)', [importId, r.index, r.row.leadId, String(r.row.company || r.row.name || ''), r.domain, r.disposition, r.reason])
        this.db.run(
          `INSERT INTO promo_leads (campaign_id, lead_id, domain, name, title, kind, emails, suppressed, contacts_out, contacts_in, last_contact_at, upstream, source_order, seen_import)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (campaign_id, lead_id) DO UPDATE SET domain = excluded.domain, name = excluded.name, title = excluded.title, kind = excluded.kind, emails = excluded.emails,
             suppressed = excluded.suppressed, contacts_out = excluded.contacts_out, contacts_in = excluded.contacts_in, last_contact_at = excluded.last_contact_at,
             upstream = excluded.upstream, source_order = excluded.source_order, seen_import = excluded.seen_import`,
          [
            c.id, r.row.leadId, r.domain, String(r.row.name ?? ''), String(r.row.title ?? ''), String(r.row.kind ?? ''),
            JSON.stringify((r.row.emails ?? []).map((e) => String(e).toLowerCase())), r.row.suppressed ? 1 : 0, r.row.contacts?.outbound ?? 0, r.row.contacts?.inbound ?? 0,
            r.row.contacts?.lastAt ?? null, JSON.stringify(r.row.campaigns ?? []), r.row.order ?? r.index + 1, importId,
          ],
        )
      }
      for (const m of members) {
        this.db.run(
          `INSERT INTO promo_members (campaign_id, domain, state, reason, hold, hold_detail, verification, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (campaign_id, domain) DO UPDATE SET state = CASE WHEN promo_members.state = 'excluded' THEN 'excluded' ELSE excluded.state END,
             reason = CASE WHEN promo_members.state = 'excluded' THEN promo_members.reason ELSE excluded.reason END,
             hold = excluded.hold, hold_detail = excluded.hold_detail, verification = excluded.verification, left_at = NULL, updated_at = excluded.updated_at`,
          [c.id, m.domain, m.state, m.reason, m.hold.hold, m.hold.detail, JSON.stringify(m.verification), stamp, stamp],
        )
      }
      // Excluded businesses are recorded as members too, so the roster shows every one of them.
      for (const r of rows.filter((x) => x.disposition === 'excluded' && x.domain)) {
        this.db.run(
          `INSERT INTO promo_members (campaign_id, domain, state, reason, joined_at, updated_at) VALUES (?, ?, 'excluded', ?, ?, ?)
           ON CONFLICT (campaign_id, domain) DO UPDATE SET state = 'excluded', reason = excluded.reason, updated_at = excluded.updated_at`,
          [c.id, r.domain, r.reason, stamp, stamp],
        )
      }
      if (snapshot.complete) {
        const present = new Set([...groups.keys(), ...rows.filter((r) => r.domain).map((r) => r.domain!)])
        for (const m of this.db.query("SELECT domain FROM promo_members WHERE campaign_id = ? AND state <> 'left'").all(c.id) as Array<{ domain: string }>) {
          if (!present.has(m.domain)) this.db.run("UPDATE promo_members SET state = 'left', reason = 'no longer in the source campaign', left_at = ?, updated_at = ? WHERE campaign_id = ? AND domain = ?", [stamp, stamp, c.id, m.domain])
        }
      }
    })
    tx()
    this.audit(options.actor ?? 'operator', 'import', c.id, importId, totals)
    return { importId, repeated: false, checksum, ...totals }
  }

  /** A business pit.world can publish: a listing in the directory, with a name, a category, a place, a description and a checked source. */
  verifyListing(row: any): { ok: boolean; reason: string; evidence: Record<string, unknown> } {
    if (!row) return { ok: false, reason: 'no pit.world listing yet: seed one from verified public records', evidence: {} }
    const listed = (row.claimed_at || row.seeded_at) && !row.directory_opt_out
    const missing = [!listed && 'not in the directory', !row.name && 'name', !row.description && 'description', !(row.area || row.city) && 'service area', !row.category && 'category'].filter(Boolean)
    const checked = row.claimed_at ? 'owner-verified (claimed)' : row.license && row.license_checked_at ? `${row.license}, checked ${new Date(row.license_checked_at).toISOString().slice(0, 10)}` : ''
    if (!checked) missing.push('a checked source (license check or owner claim)')
    const evidence = { listing: `${this.site}/b/${row.domain}`, website: `https://${row.domain}/`, license: row.license || null, licenseCheckedAt: row.license_checked_at ? new Date(row.license_checked_at).toISOString() : null, claimed: Boolean(row.claimed_at), checkedAt: new Date(this.now()).toISOString() }
    return missing.length ? { ok: false, reason: `missing: ${missing.join(', ')}`, evidence } : { ok: true, reason: checked, evidence }
  }

  private listingRow(domain: string): any {
    return this.db.query('SELECT * FROM listings WHERE domain = ?').get(domain)
  }

  /** Re-check members against their listings (after an operator seeded or fixed one). */
  reverify(campaignId: string, actor = 'operator'): { verified: number; unverified: number } {
    const c = this.campaign(campaignId)
    let verified = 0
    let unverified = 0
    for (const m of this.db.query("SELECT domain FROM promo_members WHERE campaign_id = ? AND state IN ('verified', 'unverified')").all(c.id) as Array<{ domain: string }>) {
      const check = this.verifyListing(this.listingRow(m.domain))
      this.db.run('UPDATE promo_members SET state = ?, reason = ?, verification = ?, updated_at = ? WHERE campaign_id = ? AND domain = ?', [check.ok ? 'verified' : 'unverified', check.reason, JSON.stringify(check.evidence), this.now(), c.id, m.domain])
      check.ok ? verified++ : unverified++
    }
    this.audit(actor, 'members.reverify', c.id, '', { verified, unverified })
    return { verified, unverified }
  }

  exclude(campaignId: string, subject: string, reason: string, actor = 'operator'): void {
    const c = this.campaign(campaignId)
    if (!reason.trim()) throw new PromoError(400, 'reason_required', 'say why')
    const domain = normalizeDomain(subject) ?? subject
    this.db.run('INSERT INTO promo_exclusions (campaign_id, subject, reason, at) VALUES (?, ?, ?, ?) ON CONFLICT (campaign_id, subject) DO UPDATE SET reason = excluded.reason', [c.id, domain, reason, this.now()])
    this.db.run("UPDATE promo_members SET state = 'excluded', reason = ?, updated_at = ? WHERE campaign_id = ? AND domain = ?", [reason, this.now(), c.id, domain])
    this.audit(actor, 'member.exclude', c.id, domain, { reason })
  }

  /** Resolve a member: its order in the campaign, whether it keeps priority, a recorded prior contact, or an operator's hold attestation. */
  updateMember(campaignId: string, domain: string, changes: { displayOrder?: number | null; priority?: boolean; priorContact?: string; holdAttestation?: string }, actor = 'operator') {
    const c = this.campaign(campaignId)
    const d = normalizeDomain(domain)
    const row = d ? (this.db.query('SELECT * FROM promo_members WHERE campaign_id = ? AND domain = ?').get(c.id, d) as any) : null
    if (!row) throw new PromoError(404, 'not_found', 'not a member of this campaign')
    if (changes.displayOrder !== undefined) this.db.run('UPDATE promo_members SET display_order = ? WHERE campaign_id = ? AND domain = ?', [changes.displayOrder, c.id, d])
    if (changes.priority !== undefined) this.db.run('UPDATE promo_members SET priority = ? WHERE campaign_id = ? AND domain = ?', [changes.priority ? 1 : 0, c.id, d])
    if (changes.priorContact !== undefined) this.db.run('UPDATE promo_members SET prior_contact = ? WHERE campaign_id = ? AND domain = ?', [changes.priorContact, c.id, d])
    if (changes.holdAttestation) this.db.run("UPDATE promo_members SET hold = 'held', hold_detail = ? WHERE campaign_id = ? AND domain = ?", [`operator attestation: ${changes.holdAttestation}`, c.id, d])
    this.db.run('UPDATE promo_members SET updated_at = ? WHERE campaign_id = ? AND domain = ?', [this.now(), c.id, d])
    this.audit(actor, 'member.update', c.id, d!, changes)
    return this.member(c.id, d!)
  }

  member(campaignId: string, domain: string) {
    const r = this.db.query('SELECT * FROM promo_members WHERE campaign_id = ? AND domain = ?').get(campaignId, domain) as any
    if (!r) throw new PromoError(404, 'not_found', 'not a member of this campaign')
    const listing = this.listingRow(domain)
    const leads = this.db.query('SELECT lead_id, name, title, kind, emails, suppressed, contacts_out, contacts_in, source_order FROM promo_leads WHERE campaign_id = ? AND domain = ? ORDER BY source_order').all(campaignId, domain) as any[]
    const periods = this.db.query('SELECT id, seq, started_at, ends_at, state FROM promo_periods WHERE campaign_id = ? AND domain = ? ORDER BY seq').all(campaignId, domain) as any[]
    return {
      domain,
      name: listing?.name ?? '',
      listingUrl: `${this.site}/b/${domain}`,
      state: r.state as MemberState,
      reason: r.reason,
      priority: Boolean(r.priority),
      displayOrder: r.display_order,
      hold: r.hold as HoldState,
      holdDetail: r.hold_detail,
      trackingTestedAt: r.tracking_tested_at,
      priorContact: r.prior_contact,
      verification: json(r.verification, {}),
      leads: leads.map((l) => ({ leadId: l.lead_id, name: l.name, title: l.title, kind: l.kind, emails: json<string[]>(l.emails, []), suppressed: Boolean(l.suppressed), contactsOut: l.contacts_out, contactsIn: l.contacts_in })),
      periods,
      firstVerifiedPlacementAt: this.firstVerifiedPlacement(campaignId, domain),
    }
  }

  /** The roster: every business, in source order, with what will happen to it. Private: lead names and addresses included. */
  roster(campaignId: string, options: { offset?: number; limit?: number } = {}) {
    const c = this.campaign(campaignId)
    const all = this.db
      .query(`SELECT m.domain, MIN(l.source_order) AS first_order FROM promo_members m LEFT JOIN promo_leads l ON l.campaign_id = m.campaign_id AND l.domain = m.domain
              WHERE m.campaign_id = ? GROUP BY m.domain ORDER BY first_order IS NULL, first_order, m.domain`)
      .all(c.id) as Array<{ domain: string }>
    const lastImport = this.db.query('SELECT id FROM promo_imports WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1').get(c.id) as { id: string } | null
    const unresolved = lastImport ? (this.db.query("SELECT lead_id, name, reason FROM promo_import_rows WHERE import_id = ? AND disposition IN ('unresolved') ORDER BY row_index").all(lastImport.id) as any[]) : []
    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.min(500, Math.max(1, options.limit ?? 500))
    const businesses = all.slice(offset, offset + limit).map(({ domain }) => {
      const m = this.member(c.id, domain)
      return {
        leadIds: m.leads.map((l) => l.leadId),
        business: m.name || domain,
        website: `https://${domain}/`,
        listingUrl: this.listingRow(domain) ? m.listingUrl : null,
        verification: m.state,
        reason: m.reason,
        hold: m.hold,
        plannedAction: plannedAction(m.state, m.hold, Boolean(this.listingRow(domain))),
      }
    })
    return { campaignId: c.id, total: all.length, offset, limit, businesses, unresolvedLeads: unresolved.map((u) => ({ leadId: u.lead_id, name: u.name, reason: u.reason })) }
  }

  imports(campaignId: string) {
    return (this.db.query('SELECT * FROM promo_imports WHERE campaign_id = ? ORDER BY created_at DESC').all(this.campaign(campaignId).id) as any[]).map((r) => ({ id: r.id, snapshotAt: r.snapshot_at, complete: Boolean(r.complete), checksum: r.checksum, rows: r.rows_total, totals: json(r.totals, {}), createdAt: r.created_at }))
  }

  importRows(importId: string) {
    return this.db.query('SELECT row_index, lead_id, name, domain, disposition, reason FROM promo_import_rows WHERE import_id = ? ORDER BY row_index').all(importId)
  }

  // --- launch ------------------------------------------------------------------------------
  /** Members that can launch, in campaign order; and why the others cannot. */
  private launchable(campaignId: string) {
    const rows = this.db
      .query(`SELECT m.*, l.name, l.featured FROM promo_members m JOIN listings l ON l.domain = m.domain WHERE m.campaign_id = ? AND m.state = 'verified'
              ORDER BY COALESCE(m.display_order, 1000000), l.featured DESC, lower(l.name), m.domain`)
      .all(campaignId) as any[]
    return { ready: rows.filter((r) => r.hold === 'held'), blocked: rows.filter((r) => r.hold !== 'held').map((r) => ({ domain: r.domain, reason: `outreach hold: ${r.hold} (${r.hold_detail})` })) }
  }

  /** What launch would do, bound to a version: launch refuses a preview whose inputs changed since. */
  preview(campaignId: string) {
    const c = this.campaign(campaignId)
    if (!c.config.slug || !c.config.title) throw new PromoError(422, 'unconfigured', 'set config.slug and config.title')
    const { ready, blocked } = this.launchable(c.id)
    const start = this.now()
    const plan = this.planPlacements(c, ready.map((r) => r.domain), start)
    const version = sha(JSON.stringify({ config: c.config, ready: ready.map((r) => [r.domain, r.updated_at]), plan: plan.map((p) => [p.kind, p.account, p.content_version, p.domains]) }))
    return { campaignId: c.id, version, launchable: ready.map((r) => r.domain), blocked, placements: plan.map((p) => ({ kind: p.kind, channel: p.channel, account: p.account, plannedAt: new Date(p.planned_at).toISOString(), businesses: p.domains, body: p.body })) }
  }

  private planPlacements(c: ReturnType<Promotion['campaign']>, domains: string[], start: number, after = 0) {
    const cfg = c.config
    const out: Array<{ kind: string; channel: string; account: string; body: string; link: string; content_version: string; planned_at: number; domains: string[] }> = []
    // Previewed copy carries a stand-in tracking id; launch writes the real one.
    const add = (p: Omit<(typeof out)[number], 'content_version' | 'body' | 'link'>) => {
      const content = this.content(c, p.kind, p.account, p.domains, 'plc_PREVIEW')
      out.push({ ...p, ...content, content_version: sha(content.body.replace('plc_PREVIEW', '')).slice(0, 16) })
    }
    if (!after) {
      add({ kind: 'roundup', channel: 'pit.world', account: 'pit.world', planned_at: start, domains })
      for (const account of cfg.announceAccounts) add({ kind: 'announcement', channel: 'myna', account, planned_at: start, domains })
    }
    const accounts = cfg.spotlightAccounts
    const perDay = Math.max(1, accounts.length * Math.max(1, cfg.perAccountPerDay))
    const firstDay = localHour(start + DAY, cfg.timezone, cfg.postHour)
    domains.forEach((domain, i) => {
      if (!accounts.length) return
      const slot = after + i
      const dayIndex = Math.floor(slot / perDay)
      const within = slot % perDay
      // Spread a day's posts two hours apart, starting at postHour local time.
      const at = localHour(firstDay + dayIndex * DAY + 12 * 3600 * 1000, cfg.timezone, cfg.postHour) + within * 2 * 3600 * 1000
      add({ kind: 'spotlight', channel: 'myna', account: accounts[slot % accounts.length]!, planned_at: at, domains: [domain] })
    })
    return out
  }

  /** Text and link for a placement, with its tracking id in the link (?via=<placement id>). */
  private content(c: ReturnType<Promotion['campaign']>, kind: string, account: string, domains: string[], placementId: string): { body: string; link: string } {
    const network = account.split(':')[0]
    const max = network === 'mastodon' ? 500 : network === 'linkedin' ? 3000 : 300
    if (kind === 'roundup') return { body: c.config.title, link: `${this.site}/roundup/${c.config.slug}` }
    if (kind === 'announcement') {
      const link = `${this.site}/roundup/${c.config.slug}?via=${placementId}`
      return { body: roundupAnnouncement(c.config, domains.length, link, max), link }
    }
    const listing = this.listings.toPublic(domains[0]!)
    const link = `${this.site}/b/${domains[0]}?via=${placementId}`
    return { body: listing ? spotlightText(listing, link, max) : '', link }
  }

  /**
   * Launch: create the roundup and the calendar of posts. Idempotent per preview version; a member
   * added later gets the next free spotlight slot (launch again with a fresh preview).
   */
  launch(campaignId: string, version: string, actor = 'operator') {
    const c = this.campaign(campaignId)
    const preview = this.preview(c.id)
    if (preview.version !== version) throw new PromoError(409, 'stale_preview', 'the campaign changed since that preview; preview again')
    if (c.state === 'stopped') throw new PromoError(409, 'stopped', 'this campaign is stopped')
    const already = new Set((this.db.query('SELECT pm.domain FROM promo_placement_members pm JOIN promo_placements p ON p.id = pm.placement_id WHERE p.campaign_id = ? AND p.kind = ?').all(c.id, 'spotlight') as Array<{ domain: string }>).map((r) => r.domain))
    const hasRoundup = Boolean(this.db.query("SELECT 1 FROM promo_placements WHERE campaign_id = ? AND kind = 'roundup'").get(c.id))
    const fresh = preview.launchable.filter((d) => !already.has(d))
    const lastSpot = (this.db.query("SELECT COUNT(*) AS n FROM promo_placements WHERE campaign_id = ? AND kind = 'spotlight'").get(c.id) as { n: number }).n
    const start = this.now()
    const plan = hasRoundup ? this.planPlacements(c, fresh, c.launchedAt ?? start, lastSpot) : this.planPlacements(c, fresh, start)
    // A late spotlight never lands in the past: shift its slot to now if the calendar already passed it.
    const tx = this.db.transaction(() => {
      for (const p of plan) {
        const pid = id('plc')
        const planned = Math.max(p.planned_at, start)
        const placement = { ...p, planned_at: planned }
        this.db.run(
          'INSERT INTO promo_placements (id, campaign_id, kind, channel, account, body, link, content_version, planned_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [pid, c.id, placement.kind, placement.channel, placement.account, '', '', placement.content_version, placement.planned_at, 'ready', start, start],
        )
        for (const d of placement.domains) this.db.run('INSERT OR IGNORE INTO promo_placement_members (placement_id, domain) VALUES (?, ?)', [pid, d])
        this.setPlacementContent(pid)
      }
      this.db.run("UPDATE promo_campaigns SET state = CASE WHEN state = 'draft' THEN 'active' ELSE state END, launched_at = COALESCE(launched_at, ?), updated_at = ? WHERE id = ?", [start, start, c.id])
      // The roundup is pit.world's own page: it is live the moment the campaign is.
      this.db.run("UPDATE promo_placements SET state = 'published', public_url = link, published_at = ?, updated_at = ? WHERE campaign_id = ? AND kind = 'roundup' AND state = 'ready'", [start, start, c.id])
    })
    tx()
    this.audit(actor, 'campaign.launch', c.id, version, { placements: plan.length, businesses: fresh.length })
    return { campaignId: c.id, placementsCreated: plan.length, businessesAdded: fresh.length, blocked: preview.blocked }
  }

  private setPlacementContent(placementId: string): void {
    const p = this.db.query('SELECT * FROM promo_placements WHERE id = ?').get(placementId) as any
    const domains = (this.db.query('SELECT domain FROM promo_placement_members WHERE placement_id = ? ORDER BY domain').all(placementId) as Array<{ domain: string }>).map((r) => r.domain)
    const { body, link } = this.content(this.campaign(p.campaign_id), p.kind, p.account, domains, placementId)
    this.db.run('UPDATE promo_placements SET body = ?, link = ?, content_version = ?, updated_at = ? WHERE id = ?', [body, link, sha(body.replace(placementId, '')).slice(0, 16), this.now(), placementId])
  }

  // --- placements ----------------------------------------------------------------------------
  placements(campaignId: string, options: { state?: string; domain?: string; offset?: number; limit?: number } = {}) {
    const c = this.campaign(campaignId)
    // Optional filters as bound parameters: NULL means "any".
    const filters = [c.id, options.state ?? null, options.state ?? null, options.domain ?? null, options.domain ?? null]
    const total = (this.db.query('SELECT COUNT(*) AS n FROM promo_placements p WHERE p.campaign_id = ? AND (? IS NULL OR p.state = ?) AND (? IS NULL OR p.id IN (SELECT placement_id FROM promo_placement_members WHERE domain = ?))').get(...filters) as { n: number }).n
    const rows = this.db
      .query('SELECT p.* FROM promo_placements p WHERE p.campaign_id = ? AND (? IS NULL OR p.state = ?) AND (? IS NULL OR p.id IN (SELECT placement_id FROM promo_placement_members WHERE domain = ?)) ORDER BY p.planned_at, p.id LIMIT ? OFFSET ?')
      .all(...filters, Math.min(500, options.limit ?? 100), options.offset ?? 0) as any[]
    return { total, placements: rows.map((r) => this.placementOut(r)) }
  }

  private placementOut(r: any) {
    const domains = (this.db.query('SELECT domain FROM promo_placement_members WHERE placement_id = ? ORDER BY domain').all(r.id) as Array<{ domain: string }>).map((x) => x.domain)
    return {
      id: r.id, kind: r.kind, channel: r.channel, account: r.account, state: r.state as PlacementState, plannedAt: r.planned_at, body: r.body, link: r.link,
      contentVersion: r.content_version, providerId: r.provider_id, publicUrl: r.public_url, queueId: r.queue_id, publishedAt: r.published_at, verifiedAt: r.verified_at,
      evidence: json(r.evidence, r.evidence), attempts: r.attempts, error: r.error, paid: Boolean(r.paid), businesses: domains,
    }
  }

  placement(placementId: string) {
    const r = this.db.query('SELECT * FROM promo_placements WHERE id = ?').get(placementId) as any
    if (!r) throw new PromoError(404, 'not_found', 'no such placement')
    return this.placementOut(r)
  }

  /**
   * The publishing worker's lease: due placements for myna, plus scheduled/uncertain/unverified ones to
   * reconcile. A lease lasts 15 minutes; a worker that dies leaves the placement to the next one, which
   * reconciles against myna's history before it posts anything.
   */
  lease(campaignId: string, owner: string, max = 5) {
    const c = this.campaign(campaignId)
    if (c.state !== 'active') return { placements: [], reason: `campaign is ${c.state}` }
    const now = this.now()
    const rows = this.db
      .query(`SELECT * FROM promo_placements WHERE campaign_id = ? AND (lease_until IS NULL OR lease_until < ?)
                AND ((channel = 'myna' AND state IN ('ready', 'publishing') AND planned_at <= ?) OR state IN ('scheduled', 'uncertain')
                     OR (state = 'published' AND account NOT LIKE 'linkedin:%'))
              ORDER BY CASE WHEN state IN ('ready', 'publishing') THEN 0 ELSE 1 END, CASE WHEN state IN ('ready', 'publishing') THEN planned_at ELSE updated_at END LIMIT ?`)
      .all(c.id, now, now, max) as any[]
    const leased = []
    for (const r of rows) {
      // Paid distribution needs a budget; with none (the default) a paid placement never leaves.
      if (r.paid && c.config.budget.paidCents <= 0) continue
      const ok = this.db.run('UPDATE promo_placements SET lease_owner = ?, lease_until = ?, state = CASE WHEN state = \'ready\' THEN \'publishing\' ELSE state END, updated_at = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)', [owner, now + 15 * 60 * 1000, now, r.id, now]).changes
      if (ok) leased.push(this.placementOut({ ...r, state: r.state === 'ready' ? 'publishing' : r.state }))
    }
    return { placements: leased }
  }

  /**
   * What the worker found. `published` needs a provider id and a public URL; `verified` needs evidence
   * that the public URL answers (a provider record is not that evidence). Every report is audited.
   */
  report(placementId: string, outcome: { state: PlacementState; providerId?: string; publicUrl?: string; queueId?: string; evidence?: unknown; error?: string; at?: number }, actor = 'worker') {
    const p = this.placement(placementId)
    const allowed: Record<string, PlacementState[]> = {
      ready: ['publishing', 'failed', 'removed'],
      publishing: ['scheduled', 'published', 'failed', 'uncertain', 'ready'],
      scheduled: ['scheduled', 'published', 'failed', 'uncertain', 'removed'],
      uncertain: ['scheduled', 'published', 'failed', 'ready', 'uncertain'],
      published: ['verified', 'published', 'removed', 'uncertain'],
      verified: ['verified', 'removed'],
      failed: ['ready', 'removed'],
      removed: [],
      draft: ['ready'],
    }
    if (!allowed[p.state]?.includes(outcome.state)) throw new PromoError(409, 'bad_transition', `${p.state} -> ${outcome.state}`)
    if (outcome.state === 'published' && !(outcome.publicUrl || p.publicUrl)) throw new PromoError(422, 'no_url', 'published needs the public URL')
    if (outcome.state === 'verified' && !outcome.evidence) throw new PromoError(422, 'no_evidence', 'verified needs evidence that the public URL answers')
    const now = this.now()
    this.db.run(
      `UPDATE promo_placements SET state = ?, provider_id = COALESCE(NULLIF(?, ''), provider_id), public_url = COALESCE(NULLIF(?, ''), public_url), queue_id = COALESCE(NULLIF(?, ''), queue_id),
         published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
         verified_at = CASE WHEN ? = 'verified' THEN COALESCE(verified_at, ?) ELSE verified_at END,
         evidence = CASE WHEN ? <> '' THEN ? ELSE evidence END, error = ?, attempts = attempts + CASE WHEN ? IN ('failed', 'uncertain') THEN 1 ELSE 0 END,
         lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
      [
        outcome.state, outcome.providerId ?? '', outcome.publicUrl ?? '', outcome.queueId ?? '', outcome.state, outcome.at ?? now, outcome.state, now,
        outcome.evidence ? 'x' : '', outcome.evidence ? JSON.stringify(outcome.evidence) : '', outcome.error ?? '', outcome.state, now, placementId,
      ],
    )
    this.audit(actor, `placement.${outcome.state}`, null, placementId, outcome)
    return this.placement(placementId)
  }

  /** Put a failed placement back in line (bounded: three tries). */
  retry(placementId: string, actor = 'operator') {
    const p = this.placement(placementId)
    if (p.state !== 'failed') throw new PromoError(409, 'not_failed', 'only a failed placement is retried')
    if (p.attempts >= 3) throw new PromoError(409, 'exhausted', 'three attempts already; fix the cause and recreate it')
    return this.report(placementId, { state: 'ready' }, actor)
  }

  private firstVerifiedPlacement(campaignId: string, domain: string): number | null {
    const r = this.db
      .query("SELECT MIN(p.verified_at) AS at FROM promo_placements p JOIN promo_placement_members pm ON pm.placement_id = p.id WHERE p.campaign_id = ? AND pm.domain = ? AND p.state = 'verified'")
      .get(campaignId, domain) as { at: number | null }
    return r.at ?? null
  }

  // --- budgets ---------------------------------------------------------------------------------
  /** Reserve spend atomically across concurrent jobs. A budget that was never set is zero. */
  reserve(campaignId: string, kind: 'paid' | 'ai', cents: number, ref: string): boolean {
    const c = this.campaign(campaignId)
    const limit = kind === 'paid' ? c.config.budget.paidCents : c.config.budget.aiCents
    let ok = false
    this.db.transaction(() => {
      const used = (this.db.query("SELECT COALESCE(SUM(cents), 0) AS n FROM promo_spend WHERE campaign_id = ? AND kind = ? AND state IN ('reserved', 'spent')").get(c.id, kind) as { n: number }).n
      if (limit > 0 && used + cents <= limit) {
        this.db.run('INSERT INTO promo_spend (id, campaign_id, kind, cents, state, ref, at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id('spd'), c.id, kind, cents, 'reserved', ref, this.now()])
        ok = true
      }
    }).immediate()
    return ok
  }

  settle(campaignId: string, ref: string, actualCents: number): void {
    this.db.run("UPDATE promo_spend SET state = 'spent', cents = ? WHERE campaign_id = ? AND ref = ? AND state = 'reserved'", [actualCents, campaignId, ref])
  }

  spend(campaignId: string): { paidCents: number; aiCents: number } {
    const sum = (kind: string) => (this.db.query("SELECT COALESCE(SUM(cents), 0) AS n FROM promo_spend WHERE campaign_id = ? AND kind = ? AND state = 'spent'").get(campaignId, kind) as { n: number }).n
    return { paidCents: sum('paid'), aiCents: sum('ai') }
  }

  // --- measurement ------------------------------------------------------------------------------
  private visitorHash(ip: string, ua: string, at: number): string {
    const day = new Date(at).toISOString().slice(0, 10)
    let row = this.db.query('SELECT salt FROM promo_salts WHERE day = ?').get(day) as { salt: string } | null
    if (!row) {
      this.db.run('INSERT OR IGNORE INTO promo_salts (day, salt) VALUES (?, ?)', [day, randomBytes(16).toString('hex')])
      row = this.db.query('SELECT salt FROM promo_salts WHERE day = ?').get(day) as { salt: string }
    }
    return sha(`${row.salt}|${ip}|${ua}`).slice(0, 20)
  }

  /**
   * Record one event. `id` is the deduplication key: a beacon sends its own, a server event gets a
   * random one. Nothing personal is kept: no IP, no user agent, only the day-salted visitor hash and
   * the referring host.
   */
  record(input: { id?: string; type: EventType; domain?: string | null; campaignId?: string; via?: string | null; referer?: string | null; ip?: string; userAgent?: string; test?: boolean; excluded?: string; at?: number }): string | null {
    if (!EVENT_TYPES.includes(input.type)) return null
    const at = input.at ?? this.now()
    const eventId = input.id && /^[A-Za-z0-9_-]{8,64}$/.test(input.id) ? `c_${input.id}` : id('evt')
    const domain = input.domain ? normalizeDomain(input.domain) : null
    const via = input.via && /^plc_[A-Za-z0-9_-]{6,20}$/.test(input.via) ? (this.db.query('SELECT id, campaign_id FROM promo_placements WHERE id = ?').get(input.via) as { id: string; campaign_id: string } | null) : null
    const member = domain ? (this.db.query("SELECT m.campaign_id FROM promo_members m JOIN promo_campaigns c ON c.id = m.campaign_id WHERE m.domain = ? AND c.state <> 'draft' ORDER BY m.joined_at LIMIT 1").get(domain) as { campaign_id: string } | null) : null
    const campaignId = via?.campaign_id ?? member?.campaign_id ?? input.campaignId ?? null
    // Only events that matter to a campaign are kept: pit.world does not track the rest of its traffic.
    if (!campaignId) return null
    let source = ''
    try {
      source = input.referer ? new URL(input.referer).hostname.slice(0, 120) : ''
    } catch {}
    const visitor = input.ip && input.userAgent ? this.visitorHash(input.ip, input.userAgent, at) : ''
    const result = this.db.run('INSERT OR IGNORE INTO promo_events (id, at, type, domain, campaign_id, placement_id, source, test, excluded, visitor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      eventId, at, input.type, domain, campaignId, via?.id ?? null, source, input.test ? 1 : 0, input.excluded ?? '', visitor,
    ])
    return result.changes ? eventId : null
  }

  /** Marked test traffic for a member: a test view and a test click, recorded within the last hour, pass. */
  checkTracking(campaignId: string, domains?: string[], actor = 'operator') {
    const c = this.campaign(campaignId)
    const since = this.now() - 3600 * 1000
    const targets = domains?.length ? domains : (this.db.query("SELECT domain FROM promo_members WHERE campaign_id = ? AND state = 'verified'").all(c.id) as Array<{ domain: string }>).map((r) => r.domain)
    const passed: string[] = []
    const failed: Array<{ domain: string; missing: string[] }> = []
    for (const domain of targets) {
      const has = (type: string) => Boolean(this.db.query('SELECT 1 FROM promo_events WHERE domain = ? AND type = ? AND test = 1 AND at >= ?').get(domain, type, since))
      const missing = ['listing_view', 'website_click'].filter((t) => !has(t))
      if (missing.length) failed.push({ domain, missing })
      else {
        this.db.run('UPDATE promo_members SET tracking_tested_at = COALESCE(tracking_tested_at, ?) WHERE campaign_id = ? AND domain = ?', [this.now(), c.id, domain])
        passed.push(domain)
      }
    }
    this.audit(actor, 'tracking.check', c.id, '', { passed: passed.length, failed: failed.length })
    return { passed, failed }
  }

  recordGap(campaignId: string, gap: { domain?: string; kind: string; from: number; to?: number | null; note?: string }, actor = 'operator'): string {
    const c = this.campaign(campaignId)
    const gid = id('gap')
    this.db.run('INSERT INTO promo_gaps (id, campaign_id, domain, kind, from_at, to_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)', [gid, c.id, gap.domain ?? null, gap.kind, gap.from, gap.to ?? null, gap.note ?? ''])
    this.audit(actor, 'gap.record', c.id, gid, gap)
    return gid
  }

  // --- measurement windows --------------------------------------------------------------------------
  /**
   * The hourly pass. Starts a window for every member whose listing is live, whose tracking passed a
   * marked test and who has a verified placement; marks windows that ended as due and makes one review
   * job per window (never a second, however often this runs or restarts). Sends nothing.
   */
  tick(): { started: number; due: number; reviewed: number } {
    let started = 0
    let due = 0
    let reviewed = 0
    const now = this.now()
    for (const c of this.campaigns().filter((x) => x.launchedAt)) {
      const members = this.db.query("SELECT m.domain, m.tracking_tested_at FROM promo_members m WHERE m.campaign_id = ? AND m.state = 'verified' AND m.hold = 'held' AND m.tracking_tested_at IS NOT NULL").all(c.id) as any[]
      for (const m of members) {
        if (this.db.query('SELECT 1 FROM promo_periods WHERE campaign_id = ? AND domain = ?').get(c.id, m.domain)) continue
        const listing = this.listingRow(m.domain)
        if (!listing || !(listing.claimed_at || listing.seeded_at) || listing.directory_opt_out) continue
        const placed = this.firstVerifiedPlacement(c.id, m.domain)
        if (!placed) continue
        const live = listing.claimed_at ?? listing.seeded_at
        const begin = Math.max(live, m.tracking_tested_at, placed)
        const evidence = { listingLiveAt: new Date(live).toISOString(), trackingTestedAt: new Date(m.tracking_tested_at).toISOString(), firstVerifiedPlacementAt: new Date(placed).toISOString() }
        const r = this.db.run('INSERT OR IGNORE INTO promo_periods (id, campaign_id, domain, seq, started_at, ends_at, state, start_evidence, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)', [
          id('per'), c.id, m.domain, begin, begin + c.config.periodDays * DAY, 'active', JSON.stringify(evidence), now,
        ])
        started += r.changes
      }
      for (const p of this.db.query("SELECT id FROM promo_periods WHERE campaign_id = ? AND state = 'active' AND ends_at <= ?").all(c.id, now) as Array<{ id: string }>) {
        this.db.run("UPDATE promo_periods SET state = 'due' WHERE id = ? AND state = 'active'", [p.id])
        this.job('review', `review:${p.id}`, c.id)
        due++
      }
    }
    // Review jobs: one report and one draft per window. A lease keeps two processes off the same job.
    for (const j of this.db.query("SELECT id, key FROM promo_jobs WHERE kind = 'review' AND state IN ('queued', 'running') AND (lease_until IS NULL OR lease_until < ?)").all(now) as Array<{ id: string; key: string }>) {
      if (!this.db.run("UPDATE promo_jobs SET state = 'running', lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)", [now + 10 * 60 * 1000, j.id, now]).changes) continue
      try {
        const periodId = j.key.slice('review:'.length)
        const report = this.generateReport(periodId)
        const draft = this.createDraft(report.id)
        this.db.run("UPDATE promo_periods SET state = 'reported' WHERE id = ?", [periodId])
        this.finishJob(j.id, 'done', { reportId: report.id, draftId: draft.id, draftState: draft.state })
        reviewed++
      } catch (error) {
        this.finishJob(j.id, 'failed', null, error instanceof Error ? error.message : String(error))
      }
    }
    // Yesterday's salts go: after that, nobody can tie two visits together.
    this.db.run('DELETE FROM promo_salts WHERE day < ?', [new Date(now).toISOString().slice(0, 10)])
    this.db.run("DELETE FROM promo_events WHERE excluded <> '' AND at < ?", [now - 90 * DAY])
    return { started, due, reviewed }
  }

  /** A deliberate restart: a new window after the old one, which is kept as it was. */
  restartPeriod(campaignId: string, domain: string, reason: string, actor = 'operator') {
    const c = this.campaign(campaignId)
    const last = this.db.query('SELECT * FROM promo_periods WHERE campaign_id = ? AND domain = ? ORDER BY seq DESC LIMIT 1').get(c.id, domain) as any
    if (!last) throw new PromoError(404, 'no_period', 'this business has no window to restart')
    const now = this.now()
    if (last.state === 'active') this.db.run("UPDATE promo_periods SET state = 'superseded', ends_at = ? WHERE id = ?", [now, last.id])
    const pid = id('per')
    this.db.run('INSERT INTO promo_periods (id, campaign_id, domain, seq, started_at, ends_at, state, start_evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [pid, c.id, domain, last.seq + 1, now, now + c.config.periodDays * DAY, 'active', JSON.stringify({ restart: reason, previous: last.id }), now])
    this.audit(actor, 'period.restart', c.id, domain, { reason, previous: last.id, period: pid })
    return pid
  }

  periods(campaignId: string) {
    return (this.db.query('SELECT * FROM promo_periods WHERE campaign_id = ? ORDER BY started_at, domain').all(this.campaign(campaignId).id) as any[]).map((p) => ({ ...p, start_evidence: json(p.start_evidence, {}) }))
  }

  // --- reports ----------------------------------------------------------------------------------------
  /** The metrics for one business over [from, to): deterministic, from the event ledger. */
  metrics(campaignId: string, domain: string, from: number, to: number) {
    const rows = this.db.query('SELECT type, placement_id, test, excluded, visitor, at FROM promo_events WHERE domain = ? AND at >= ? AND at < ?').all(domain, from, to) as any[]
    const counted = rows.filter((r) => !r.test && !r.excluded)
    const exclusions: Record<string, number> = {}
    for (const r of rows) {
      const why = r.test ? 'test' : r.excluded
      if (why) exclusions[why] = (exclusions[why] ?? 0) + 1
    }
    const of = (type: string) => counted.filter((r) => r.type === type)
    const days = new Set(of('listing_view').filter((r) => r.visitor).map((r) => `${new Date(r.at).toISOString().slice(0, 10)}|${r.visitor}`))
    const placements = new Map<string, { views: number; clicks: number }>()
    for (const r of counted) {
      if (!r.placement_id || (r.type !== 'listing_view' && r.type !== 'website_click')) continue
      const e = placements.get(r.placement_id) ?? { views: 0, clicks: 0 }
      if (r.type === 'listing_view') e.views++
      else e.clicks++
      placements.set(r.placement_id, e)
    }
    const views = of('listing_view').length
    const clicks = of('website_click').length
    const promoViews = of('listing_view').filter((r) => r.placement_id).length
    const promoClicks = of('website_click').filter((r) => r.placement_id).length
    return { views, clicks, phone: of('phone_click').length, inquiries: of('inquiry_sent').length, visitorDays: days.size, placements, promoViews, promoClicks, exclusions, unattributedViews: views - promoViews, unattributedClicks: clicks - promoClicks }
  }

  /** Generate (or re-generate) the report for a window. Unchanged data keeps the current version. */
  generateReport(periodId: string, cutoff = this.now()) {
    const period = this.db.query('SELECT * FROM promo_periods WHERE id = ?').get(periodId) as any
    if (!period) throw new PromoError(404, 'not_found', 'no such window')
    const c = this.campaign(period.campaign_id)
    const listing = this.listingRow(period.domain)
    const end = Math.min(period.ends_at, cutoff)
    const m = this.metrics(c.id, period.domain, period.started_at, end)
    const tz = c.config.timezone
    const placements = this.db
      .query(`SELECT p.*, (SELECT COUNT(*) FROM promo_placement_members x WHERE x.placement_id = p.id) AS shared FROM promo_placements p JOIN promo_placement_members pm ON pm.placement_id = p.id
              WHERE pm.domain = ? AND p.campaign_id = ? AND p.state = 'verified' AND p.verified_at < ? ORDER BY p.verified_at`)
      .all(period.domain, c.id, period.ends_at) as any[]
    const claimedQuotes = Boolean(listing?.claimed_at && listing?.contact_email)
    const metrics: Record<string, Metric> = {
      listingViews: { value: m.views, definition: 'GET requests for the listing page by a browser, excluding crawlers, link previews, prefetches, internal and marked test traffic', source: 'pit.world event ledger' },
      visitorDays: { value: m.visitorDays, definition: 'distinct visitors per UTC day, added up over the window. A person who came back on three days counts three times. pit.world keeps no identifier past a day, so a count of distinct people over the whole window does not exist', source: 'pit.world event ledger (day-salted hash, no cookies)' },
      uniqueVisitors: { value: null, definition: 'distinct visitors over the whole window', source: 'unavailable', note: 'not measured: pit.world does not keep identifiers across days' },
      websiteClicks: { value: m.clicks, definition: "clicks on the listing's website link (counted by the redirect, once per click), same exclusions as views", source: 'pit.world event ledger' },
      phoneClicks: { value: m.phone, definition: "taps on the phone link, sent by the page's script; browsers without script are not counted. A tap is not a completed call", source: 'pit.world event ledger (beacon)' },
      emailClicks: { value: null, definition: 'taps on an email link', source: 'unavailable', note: 'the listing shows no email address' },
      verifiedInquiries: claimedQuotes
        ? { value: m.inquiries, definition: 'quote requests sent through the listing form', source: 'pit.world event ledger' }
        : { value: null, definition: 'quote requests sent through the listing form', source: 'unavailable', note: 'the form opens only once the owner claims the listing' },
      verifiedPlacements: { value: placements.length, definition: 'campaign posts and pages naming this business whose public URL was checked live', source: 'placement records' },
      platformImpressions: { value: null, definition: 'impressions reported by the social networks', source: 'unavailable', note: 'myna does not read impression counts from these networks' },
    }
    const gaps = this.db.query('SELECT * FROM promo_gaps WHERE campaign_id = ? AND (domain IS NULL OR domain = ?) AND from_at < ? AND (to_at IS NULL OR to_at > ?)').all(c.id, period.domain, period.ends_at, period.started_at) as any[]
    const spend = this.db.query("SELECT kind, COALESCE(SUM(cents), 0) AS n FROM promo_spend WHERE campaign_id = ? AND state = 'spent' GROUP BY kind").all(c.id) as Array<{ kind: string; n: number }>
    const data: ReportData = {
      campaign: { id: c.id, name: c.name },
      business: { domain: period.domain, name: listing?.name ?? period.domain, listingUrl: `${this.site}/b/${period.domain}` },
      period: { id: period.id, seq: period.seq, startedAt: new Date(period.started_at).toISOString(), endsAt: new Date(period.ends_at).toISOString(), startLocal: fmtDay(period.started_at, tz), endLocal: fmtDay(period.ends_at, tz), timezone: tz },
      placements: placements.map((p) => ({ id: p.id, kind: p.kind, channel: p.channel, account: p.account, url: p.public_url, verifiedAt: p.verified_at ? new Date(p.verified_at).toISOString() : null, sharedWith: p.shared })),
      metrics,
      referrals: { byPlacement: [...m.placements].map(([placementId, v]) => ({ placementId, ...v })), promotionViews: m.promoViews, promotionClicks: m.promoClicks, unattributedViews: m.unattributedViews, unattributedClicks: m.unattributedClicks },
      exclusions: m.exclusions,
      gaps: gaps.map((g) => ({ kind: g.kind, from: new Date(g.from_at).toISOString(), to: g.to_at ? new Date(g.to_at).toISOString() : null, note: g.note })),
      economics: { paidCents: spend.find((s) => s.kind === 'paid')?.n ?? 0, aiCents: spend.find((s) => s.kind === 'ai')?.n ?? 0, operatorMinutes: null },
      nextStep: m.views + m.clicks === 0 ? 'Review the listing together and decide whether wider distribution is worth trying.' : 'A short call to go over these results and whether to keep promoting the listing.',
      cutoff: new Date(cutoff).toISOString(),
      rulesVersion: RULES_VERSION,
    }
    const digest = sha(JSON.stringify({ ...data, cutoff: null }))
    const latest = this.db.query('SELECT id, version, digest FROM promo_reports WHERE period_id = ? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1').get(periodId) as { id: string; version: number; digest: string } | null
    if (latest && latest.digest.length === digest.length && timingSafeEqual(Buffer.from(latest.digest), Buffer.from(digest))) return this.reportById(latest.id)
    const rid = id('rpt')
    const now = this.now()
    this.db.transaction(() => {
      if (latest) {
        this.db.run('UPDATE promo_reports SET superseded_at = ? WHERE id = ?', [now, latest.id])
        // Unsent drafts quoting the old numbers are void.
        this.db.run("UPDATE promo_drafts SET state = 'invalidated', reason = 'the report it quotes was superseded', updated_at = ? WHERE report_id = ? AND state IN ('draft', 'blocked')", [now, latest.id])
      }
      this.db.run('INSERT INTO promo_reports (id, period_id, campaign_id, domain, version, generated_at, cutoff, rules_version, data, digest, share_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        rid, periodId, c.id, period.domain, (latest?.version ?? 0) + 1, now, cutoff, RULES_VERSION, JSON.stringify(data), digest, randomBytes(18).toString('base64url'),
      ])
    })()
    this.audit('system', 'report.generate', c.id, rid, { period: periodId, version: (latest?.version ?? 0) + 1 })
    return this.reportById(rid)
  }

  reportById(reportId: string) {
    const r = this.db.query('SELECT * FROM promo_reports WHERE id = ?').get(reportId) as any
    if (!r) throw new PromoError(404, 'not_found', 'no such report')
    return { id: r.id as string, periodId: r.period_id, campaignId: r.campaign_id, domain: r.domain, version: r.version as number, generatedAt: r.generated_at, superseded: Boolean(r.superseded_at), shareUrl: `${this.site}/r/${r.share_token}`, data: JSON.parse(r.data) as ReportData }
  }

  reportByToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return null
    const r = this.db.query('SELECT id FROM promo_reports WHERE share_token = ?').get(token) as { id: string } | null
    return r ? this.reportById(r.id) : null
  }

  reports(campaignId: string) {
    return (this.db.query('SELECT id FROM promo_reports WHERE campaign_id = ? ORDER BY generated_at').all(this.campaign(campaignId).id) as Array<{ id: string }>).map((r) => this.reportById(r.id))
  }

  /** Generate reports for every window that has ended and has none yet. */
  generateDue(campaignId: string) {
    const c = this.campaign(campaignId)
    const out = []
    for (const p of this.db.query("SELECT id FROM promo_periods WHERE campaign_id = ? AND state IN ('due', 'reported', 'superseded')").all(c.id) as Array<{ id: string }>) out.push(this.generateReport(p.id).id)
    return { reports: out }
  }

  /** The comparison across the campaign, for a spreadsheet. */
  comparisonCsv(campaignId: string): string {
    const head = ['domain', 'business', 'period_start', 'period_end', 'report_version', 'listing_views', 'visitor_days', 'website_clicks', 'phone_clicks', 'verified_inquiries', 'verified_placements', 'promotion_views', 'promotion_clicks', 'unattributed_views']
    const cell = (v: unknown) => (v === null || v === undefined ? 'unavailable' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
    const lines = [head.join(',')]
    for (const r of this.reports(campaignId).filter((x) => !x.superseded)) {
      const d = r.data
      lines.push([d.business.domain, d.business.name, d.period.startedAt, d.period.endsAt, r.version, d.metrics.listingViews?.value, d.metrics.visitorDays?.value, d.metrics.websiteClicks?.value, d.metrics.phoneClicks?.value, d.metrics.verifiedInquiries?.value, d.metrics.verifiedPlacements?.value, d.referrals.promotionViews, d.referrals.promotionClicks, d.referrals.unattributedViews].map(cell).join(','))
    }
    return `${lines.join('\n')}\n`
  }

  // --- outreach drafts ------------------------------------------------------------------------------
  /** One draft per report version, from the report's frozen numbers and the member's recorded contact history. */
  createDraft(reportId: string) {
    const existing = this.db.query('SELECT id FROM promo_drafts WHERE report_id = ?').get(reportId) as { id: string } | null
    if (existing) return this.draft(existing.id)
    const report = this.reportById(reportId)
    if (report.superseded) throw new PromoError(409, 'superseded', 'that report has a newer version')
    const c = this.campaign(report.campaignId)
    const member = this.member(c.id, report.domain)
    const leads = member.leads.filter((l) => !l.suppressed || l.emails.length)
    // A named person first, then a role address; never an address we only guessed at is preferred over a published one (the order is the source's).
    const pick = leads.find((l) => l.kind === 'person' && l.emails.length && /\s/.test(l.name) && !/[|,]/.test(l.name)) ?? leads.find((l) => l.emails.length)
    const followUp = member.leads.some((l) => l.contactsOut > 0) || Boolean(member.priorContact)
    const { subject, body } = draftText(report.data, c.config, pick ? firstName(pick.name) : '', followUp, report.shareUrl)
    let state = 'draft'
    let reason = ''
    if (!pick) {
      state = 'blocked'
      reason = 'no verified email address for this business (phone only): call instead'
    } else if (!c.config.sender) {
      state = 'blocked'
      reason = 'campaign sender is not configured'
    }
    const did = id('drf')
    const now = this.now()
    this.db.run('INSERT OR IGNORE INTO promo_drafts (id, report_id, campaign_id, domain, kind, recipient_name, recipient_email, lead_id, subject, body, version, state, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      did, reportId, c.id, report.domain, followUp ? 'follow_up' : 'introduction', pick?.name ?? '', pick?.emails[0] ?? '', pick?.leadId ?? '', subject, body, sha(subject + body).slice(0, 16), state, reason, now, now,
    ])
    this.audit('system', 'draft.create', c.id, did, { report: reportId, state, reason })
    return this.draft((this.db.query('SELECT id FROM promo_drafts WHERE report_id = ?').get(reportId) as { id: string }).id)
  }

  draft(draftId: string) {
    const r = this.db.query('SELECT * FROM promo_drafts WHERE id = ?').get(draftId) as any
    if (!r) throw new PromoError(404, 'not_found', 'no such draft')
    return { id: r.id as string, reportId: r.report_id, domain: r.domain, kind: r.kind, recipientName: r.recipient_name, recipientEmail: r.recipient_email, leadId: r.lead_id, subject: r.subject, body: r.body, version: r.version, state: r.state as string, reason: r.reason }
  }

  drafts(campaignId: string) {
    return (this.db.query('SELECT id FROM promo_drafts WHERE campaign_id = ? ORDER BY created_at').all(this.campaign(campaignId).id) as Array<{ id: string }>).map((r) => this.draft(r.id))
  }

  /**
   * Send one draft through the configured deliverer. Checked here, at the moment of sending: the
   * campaign is running and sending is authorized, the window is over, the report is current, and the
   * upstream says the address is not suppressed (unknown is a no). One delivery per recipient, message
   * version and window, so a retry after a crash never sends twice.
   */
  async deliver(draftId: string, actor = 'operator') {
    const d = this.draft(draftId)
    const report = this.reportById(d.reportId)
    const c = this.campaign(report.campaignId)
    const refuse = (code: string, message: string): never => {
      this.audit(actor, 'delivery.refused', c.id, draftId, { code, message })
      throw new PromoError(423, code, message)
    }
    if (c.state !== 'active') refuse('campaign_not_active', `campaign is ${c.state}`)
    if (!c.config.sendAuthorized || !c.config.sender) refuse('not_authorized', 'sending is not authorized for this campaign')
    if (d.state !== 'draft') refuse('draft_not_sendable', `draft is ${d.state}${d.reason ? `: ${d.reason}` : ''}`)
    if (report.superseded) refuse('report_superseded', 'the report this draft quotes has a newer version')
    const period = this.db.query('SELECT * FROM promo_periods WHERE id = ?').get(report.periodId) as any
    if (!period || period.ends_at > this.now()) refuse('window_open', 'the measurement window has not ended')
    if (!this.deliverer) refuse('no_deliverer', 'no delivery route is configured')
    const suppressed = await this.deliverer!.suppressed(d.recipientEmail)
    if (suppressed !== false) refuse('suppressed', suppressed === null ? 'suppression state unknown: not sending' : 'the recipient is suppressed upstream')
    const deliveryId = id('dlv')
    const inserted = this.db.run('INSERT OR IGNORE INTO promo_deliveries (id, draft_id, recipient, message_version, period_id, state, at) VALUES (?, ?, ?, ?, ?, ?, ?)', [deliveryId, d.id, d.recipientEmail, d.version, report.periodId, 'sending', this.now()]).changes
    if (!inserted) refuse('already_delivered', 'this message already has a delivery record; reconcile it instead of sending again')
    try {
      const sent = await this.deliverer!.send({ to: d.recipientEmail, subject: d.subject, text: d.body, idempotencyKey: deliveryId })
      this.db.run("UPDATE promo_deliveries SET state = 'sent', provider_id = ? WHERE id = ?", [sent.id, deliveryId])
      this.db.run("UPDATE promo_drafts SET state = 'sent', updated_at = ? WHERE id = ?", [this.now(), d.id])
      this.audit(actor, 'delivery.sent', c.id, d.id, { delivery: deliveryId })
      return { deliveryId, state: 'sent' }
    } catch (error) {
      // We do not know whether it went: uncertain until someone checks the provider.
      this.db.run("UPDATE promo_deliveries SET state = 'uncertain', error = ? WHERE id = ?", [error instanceof Error ? error.message : String(error), deliveryId])
      this.audit(actor, 'delivery.uncertain', c.id, d.id, { delivery: deliveryId })
      return { deliveryId, state: 'uncertain' }
    }
  }

  // --- public views -----------------------------------------------------------------------------------
  /** The roundup: members in campaign order, the public facts only. */
  roundup(slug: string) {
    const c = this.bySlug(slug)
    if (!c) return null
    const roundup = this.db.query("SELECT id, state FROM promo_placements WHERE campaign_id = ? AND kind = 'roundup'").get(c.id) as { id: string; state: string } | null
    if (!roundup || roundup.state === 'removed') return null
    const domains = (this.db
      .query(`SELECT m.domain FROM promo_members m JOIN listings l ON l.domain = m.domain WHERE m.campaign_id = ? AND m.state = 'verified' AND m.hold = 'held'
                AND m.domain IN (SELECT domain FROM promo_placement_members WHERE placement_id = ?)
              ORDER BY COALESCE(m.display_order, 1000000), l.featured DESC, lower(l.name), m.domain`)
      .all(c.id, roundup.id) as Array<{ domain: string }>).map((r) => r.domain)
    return { campaign: c, placementId: roundup.id, listings: domains.map((d) => this.listings.toPublic(d)).filter((l): l is Listing => Boolean(l)) }
  }

  /** Overview counts for the dashboard. */
  overview(campaignId: string) {
    const c = this.campaign(campaignId)
    const count = (sql: string, ...args: unknown[]) => (this.db.query(sql).get(...(args as any[])) as { n: number }).n
    const states = Object.fromEntries((this.db.query('SELECT state, COUNT(*) AS n FROM promo_members WHERE campaign_id = ? GROUP BY state').all(c.id) as any[]).map((r) => [r.state, r.n]))
    const placements = Object.fromEntries((this.db.query('SELECT state, COUNT(*) AS n FROM promo_placements WHERE campaign_id = ? GROUP BY state').all(c.id) as any[]).map((r) => [r.state, r.n]))
    return {
      campaign: { id: c.id, name: c.name, state: c.state, source: `${c.source}:${c.sourceRef}`, launchedAt: c.launchedAt, config: c.config },
      members: states,
      holds: Object.fromEntries((this.db.query('SELECT hold, COUNT(*) AS n FROM promo_members WHERE campaign_id = ? GROUP BY hold').all(c.id) as any[]).map((r) => [r.hold, r.n])),
      placements,
      periods: Object.fromEntries((this.db.query('SELECT state, COUNT(*) AS n FROM promo_periods WHERE campaign_id = ? GROUP BY state').all(c.id) as any[]).map((r) => [r.state, r.n])),
      trackingTested: count('SELECT COUNT(*) AS n FROM promo_members WHERE campaign_id = ? AND tracking_tested_at IS NOT NULL', c.id),
      events: count("SELECT COUNT(*) AS n FROM promo_events WHERE campaign_id = ? AND test = 0 AND excluded = ''", c.id),
      reports: count('SELECT COUNT(*) AS n FROM promo_reports WHERE campaign_id = ? AND superseded_at IS NULL', c.id),
      drafts: Object.fromEntries((this.db.query('SELECT state, COUNT(*) AS n FROM promo_drafts WHERE campaign_id = ? GROUP BY state').all(c.id) as any[]).map((r) => [r.state, r.n])),
      spend: this.spend(c.id),
    }
  }

  /** Measured results for one member: its windows and, per window, the latest report or live numbers so far. */
  results(campaignId: string, domain: string) {
    const c = this.campaign(campaignId)
    const member = this.member(c.id, domain)
    return {
      ...member,
      leads: undefined,
      windows: member.periods.map((p: any) => {
        const latest = this.db.query('SELECT id FROM promo_reports WHERE period_id = ? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1').get(p.id) as { id: string } | null
        const live = this.metrics(c.id, domain, p.started_at, Math.min(p.ends_at, this.now()))
        return { ...p, report: latest ? this.reportById(latest.id) : null, soFar: { listingViews: live.views, websiteClicks: live.clicks, phoneClicks: live.phone, promotionViews: live.promoViews } }
      }),
    }
  }
}

function plannedAction(state: MemberState, hold: HoldState, listed: boolean): string {
  if (state === 'excluded') return 'none: excluded'
  if (state === 'left') return 'priority removed: left the campaign (listing kept)'
  if (state === 'unresolved') return 'resolve identity first'
  if (!listed) return 'seed a verified listing, then promote'
  if (state === 'unverified') return 'complete the listing, then promote'
  if (hold !== 'held') return 'blocked until upstream outreach is held'
  return 'priority placement, roundup, spotlight, 30-day measurement'
}

function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? ''
  return /^[A-Z][a-z'-]+$/.test(first) ? first : ''
}

/** The email, from report figures only. Unavailable metrics are left out, zero is said as zero, and nothing implies a conversation that never happened. */
export function draftText(d: ReportData, config: CampaignConfig, first: string, followUp: boolean, reportUrl: string): { subject: string; body: string } {
  const sender = config.sender ?? { name: 'Anthony', company: 'Profullstack, Inc.', email: '', footer: '' }
  const channels = [...new Set(d.placements.map((p) => (p.channel === 'pit.world' ? 'the pit.world roundup' : p.account.split(':')[0] === 'bluesky' ? 'Bluesky' : p.account.split(':')[0] === 'mastodon' ? 'Mastodon' : p.account.split(':')[0] === 'linkedin' ? 'LinkedIn' : p.account)))]
  const views = d.metrics.listingViews?.value
  const clicks = d.metrics.websiteClicks?.value
  const phone = d.metrics.phoneClicks?.value
  const hello = `Hi ${first || 'there'},`
  const opener = followUp
    ? `Following up on my earlier note: since then we featured ${d.business.name} in our Los Gatos builders directory and promoted the listing through ${list(channels)} between ${d.period.startLocal} and ${d.period.endLocal}.`
    : `We featured ${d.business.name} in our Los Gatos builders directory and promoted the listing through ${list(channels)} between ${d.period.startLocal} and ${d.period.endLocal}. Nobody asked us to; we list local builders with an active license.`
  const counted = (views ?? 0) + (clicks ?? 0) + (phone ?? 0)
  const results =
    counted === 0
      ? 'In that time the listing recorded no measurable visits or clicks. That is a real result too: this audience did not find it on its own, and wider distribution is the open question.'
      : `During that period, your listing received ${plural(views ?? 0, 'view')} and ${plural(clicks ?? 0, 'click')} through to your website${phone ? `, and ${plural(phone, 'tap')} on your phone number` : ''}.${d.referrals.promotionViews ? ` ${d.referrals.promotionViews} of those views came straight from our posts.` : ''}`
  const ask = counted === 0 ? 'Would a short look at the listing, and at where else it could run, be useful?' : 'Would you be interested in a brief conversation about the results and continued promotion?'
  const body = [
    hello,
    '',
    opener,
    '',
    results,
    '',
    `Listing: ${d.business.listingUrl}`,
    `Results: ${reportUrl}`,
    '',
    `I'm ${sender.name.split(' ')[0]} with ${sender.company.replace(/, Inc\.$/, '')}. ${ask}`,
    '',
    sender.name,
    sender.company,
    sender.footer,
  ].join('\n')
  return { subject: `Your feature in our Los Gatos builders directory`, body }
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? 'the directory'
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
