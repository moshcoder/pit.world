import { afterAll, describe, expect, it } from 'bun:test'
import { PitClient } from '../src/client.ts'
import { Listings, type Verifier } from '../src/listings.ts'
import { draftText, holdOf, leadDomain, localHour, Promotion, spotlightText, type Snapshot } from '../src/promotion.ts'
import { findInMyna, workOnce, type Myna, type MynaEntry, type MynaQueued } from '../src/promotion-worker.ts'
import { createApp } from '../src/server.ts'

const DAY = 24 * 3600 * 1000
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15'
const verifier: Verifier = { txt: async () => [], homepage: async () => null }

function setup(start = Date.parse('2026-10-20T17:00:00Z')) {
  const clock = { t: start }
  const listings = new Listings(':memory:', verifier, () => clock.t)
  const seed = (domain: string, name: string, extra: Record<string, unknown> = {}) =>
    listings.seed({ domain, name, description: `${name} builds custom homes and remodels. Second sentence.`, phone: '(408) 555-0100', category: 'construction', area: 'Los Gatos, CA and the South Bay', city: 'Los Gatos', region: 'CA', country: 'USA', services: ['Remodels'], license: 'CSLB #100 (B - General Building)', licenseCheckedAt: start - DAY, ...extra })
  seed('alpha-build.com', 'Alpha Build')
  seed('bravo-homes.com', 'Bravo Homes')
  seed('zulu-remodel.com', 'Zulu Remodel', { featured: 0 })
  seed('charlie-co.com', 'Charlie Co', { license: '' })
  seed('outsider.com', 'Aardvark Outsider')
  const deliveries: Array<{ to: string }> = []
  const upstream = { suppressed: false as boolean | null }
  const promo = new Promotion(listings, 'https://pit.world', () => clock.t, {
    suppressed: async () => upstream.suppressed,
    send: async (m) => {
      deliveries.push({ to: m.to })
      return { id: `msg_${deliveries.length}` }
    },
  })
  const campaign = promo.createCampaign({
    name: 'Building contractors in Los Gatos, CA',
    source: 'outreachgraph',
    sourceRef: 'cmp_test',
    config: { slug: 'los-gatos-builders', title: 'Los Gatos builders', intro: 'Contractors with permits in town.', spotlightAccounts: ['bluesky:a.bsky.social', 'mastodon:b@defcon.social'], announceAccounts: ['bluesky:a.bsky.social'], sender: { name: 'Anthony Ettinger', company: 'Profullstack, Inc.', email: 'anthony@profullstack.com', footer: 'Profullstack, Inc., 16375 Bonnie Lane, Los Gatos, CA 95032' } },
  })
  const app = createApp({ keys: {}, listings, promotion: promo, adminToken: 'admintoken', internalIps: ['198.51.100.7'] })
  const request = (path: string, init: RequestInit = {}, ip = '203.0.113.9') => app.request(path, init, { ip })
  const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    request(`/api/v1/promotion${path}`, { method, headers: { authorization: 'Bearer admintoken', 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { clock, listings, promo, campaign, app, request, api, deliveries, upstream }
}

const held = [{ id: 'cmp_test', approvalMode: 'draft_and_approve', status: 'active' }]
function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    source: 'outreachgraph',
    campaignId: 'cmp_test',
    snapshotAt: '2026-10-20T16:00:00.000Z',
    complete: true,
    total: 7,
    rows: [
      { leadId: 'per_1', order: 1, name: 'Ann Alpha', kind: 'person', company: 'Alpha Build', domain: 'alpha-build.com', emails: ['ann@alpha-build.com'], socials: [{ network: 'bluesky', url: 'https://bsky.app/x' }], suppressed: true, campaigns: held, contacts: { outbound: 0, inbound: 0, lastAt: null } },
      { leadId: 'per_2', order: 2, name: 'Alpha office', kind: 'person', company: 'Alpha Build', domain: 'www.alpha-build.com', emails: ['info@alpha-build.com'], suppressed: true, campaigns: held },
      { leadId: 'per_3', order: 3, name: 'Bo Bravo', kind: 'person', company: null, domain: null, emails: ['bo@bravo-homes.com'], socials: [], suppressed: true, campaigns: held },
      { leadId: 'per_4', order: 4, name: 'Harm Gmail', kind: 'person', domain: null, emails: ['harm@gmail.com'], suppressed: true, campaigns: held },
      { leadId: 'per_5', order: 5, name: 'Charlie', kind: 'person', domain: 'charlie-co.com', emails: [], suppressed: true, campaigns: held },
      { leadId: 'per_6', order: 6, name: 'Zed', kind: 'person', domain: 'zulu-remodel.com', emails: ['zed@zulu-remodel.com'], suppressed: false, campaigns: [...held, { id: 'cmp_other', approvalMode: 'trusted_automation', status: 'active' }] },
      { leadId: 'per_7', order: 7, name: 'Gone', kind: 'person', domain: 'dead-site.com', emails: ['x@dead-site.com'], suppressed: true, campaigns: held },
    ],
    ...overrides,
  }
}

/** Import, exclude the dead site, launch, pass the tracking test and verify the roundup: windows start. */
async function launched(h: ReturnType<typeof setup>) {
  h.promo.exclude(h.campaign, 'dead-site.com', 'website does not respond')
  h.promo.import(h.campaign, snapshot())
  const preview = h.promo.preview(h.campaign)
  h.promo.launch(h.campaign, preview.version)
  for (const d of ['alpha-build.com', 'bravo-homes.com']) {
    await h.request(`/b/${d}?pt=test`, { headers: { 'user-agent': BROWSER } })
    await h.request(`/b/${d}/go?pt=test`, { headers: { 'user-agent': BROWSER } })
  }
  h.promo.checkTracking(h.campaign)
  const roundup = h.promo.placements(h.campaign, { state: 'published' }).placements.find((p) => p.kind === 'roundup')!
  h.promo.report(roundup.id, { state: 'verified', evidence: { status: 200 } })
  h.promo.tick()
  return { preview, roundup }
}

describe('promotion: import and reconciliation', () => {
  it('gives every source row exactly one disposition, and the totals add up (AC-01, AC-04, AC-05)', () => {
    const h = setup()
    h.promo.exclude(h.campaign, 'dead-site.com', 'website does not respond')
    const r = h.promo.import(h.campaign, snapshot()) as any
    expect(r.sourceRows).toBe(7)
    expect(r.matched + r.merged + r.unresolved + r.excluded).toBe(7)
    expect([r.matched, r.merged, r.unresolved, r.excluded]).toEqual([4, 1, 1, 1])
    expect(r.businesses).toBe(4)
    const rows = h.promo.importRows(r.importId) as any[]
    expect(rows.find((x) => x.lead_id === 'per_2').disposition).toBe('merged')
    expect(rows.find((x) => x.lead_id === 'per_4').reason).toContain('no business website')
    // Bravo has no social profile and no company domain: kept, matched by its address's domain.
    expect(rows.find((x) => x.lead_id === 'per_3')).toMatchObject({ disposition: 'matched', domain: 'bravo-homes.com' })
    const alpha = h.promo.member(h.campaign, 'alpha-build.com')
    expect(alpha.leads.map((l) => l.leadId)).toEqual(['per_1', 'per_2'])
  })

  it('re-importing the same snapshot changes nothing (AC-03)', () => {
    const h = setup()
    const first = h.promo.import(h.campaign, snapshot()) as any
    const again = h.promo.import(h.campaign, snapshot()) as any
    expect(again.repeated).toBe(true)
    expect(again.importId).toBe(first.importId)
    expect(h.promo.roster(h.campaign).total).toBe(first.businesses)
  })

  it('refuses a snapshot whose row count does not match, or for another campaign', () => {
    const h = setup()
    expect(() => h.promo.import(h.campaign, snapshot({ total: 99 }))).toThrow('99 rows')
    expect(() => h.promo.import(h.campaign, snapshot({ campaignId: 'cmp_else' }))).toThrow('not outreachgraph cmp_test')
  })

  it('a partial snapshot never removes members; a complete one marks the missing ones as left, keeping the listing', () => {
    const h = setup()
    h.promo.import(h.campaign, snapshot())
    const partial = snapshot({ complete: false, total: undefined, snapshotAt: 'x', rows: snapshot().rows.slice(0, 1) })
    h.promo.import(h.campaign, partial)
    expect(h.promo.member(h.campaign, 'bravo-homes.com').state).toBe('verified')
    const complete = snapshot({ total: 6, rows: snapshot().rows.filter((r) => r.leadId !== 'per_3') })
    h.promo.import(h.campaign, complete)
    expect(h.promo.member(h.campaign, 'bravo-homes.com').state).toBe('left')
    expect(h.listings.toPublic('bravo-homes.com')).not.toBeNull()
  })

  it('reads a business domain from the company, or from a non-freemail address', () => {
    expect(leadDomain({ leadId: 'a', domain: 'https://www.Acme.com/x' })).toBe('acme.com')
    expect(leadDomain({ leadId: 'a', domain: null, emails: ['me@gmail.com', 'me@acme.com'] })).toBe('acme.com')
    expect(leadDomain({ leadId: 'a', domain: 'gmail.com', emails: ['me@gmail.com'] })).toBeNull()
  })

  it('holds only when every upstream path is suppressed or waits for approval', () => {
    expect(holdOf([{ leadId: 'a', suppressed: true, campaigns: [] }]).hold).toBe('held')
    expect(holdOf([{ leadId: 'a', suppressed: false, campaigns: [{ id: 'c', approvalMode: 'trusted_automation', status: 'active' }] }]).hold).toBe('conflict')
    expect(holdOf([{ leadId: 'a', suppressed: false }]).hold).toBe('unknown')
  })
})

describe('promotion: launch, priority and the roundup', () => {
  it('blocks conflicts and unverified listings, launches the rest (AC-06)', () => {
    const h = setup()
    h.promo.import(h.campaign, snapshot())
    const p = h.promo.preview(h.campaign)
    expect(p.launchable).toEqual(['alpha-build.com', 'bravo-homes.com'])
    expect(p.blocked).toEqual([{ domain: 'zulu-remodel.com', reason: expect.stringContaining('conflict') }])
    expect(h.promo.member(h.campaign, 'charlie-co.com')).toMatchObject({ state: 'unverified', reason: expect.stringContaining('checked source') })
    expect(() => h.promo.launch(h.campaign, 'stale')).toThrow('preview again')
    const r = h.promo.launch(h.campaign, p.version)
    // roundup + one announcement + two spotlights
    expect(r.placementsCreated).toBe(4)
    expect(h.promo.launch(h.campaign, h.promo.preview(h.campaign).version).placementsCreated).toBe(0)
  })

  it('puts eligible campaign businesses first across filters, pages and the API (AC-07)', async () => {
    const h = setup()
    h.promo.import(h.campaign, snapshot())
    h.promo.launch(h.campaign, h.promo.preview(h.campaign).version)
    const all = h.listings.directory({ limit: 100 }).listings.map((l) => l.domain)
    expect(all.slice(0, 3)).toEqual(['alpha-build.com', 'bravo-homes.com', 'zulu-remodel.com'])
    // Page 2 of 1 continues the same order.
    expect(h.listings.directory({ limit: 1, offset: 1 }).listings[0]!.domain).toBe('bravo-homes.com')
    // A filter is applied first: priority cannot bring in a business that does not match.
    expect(h.listings.directory({ q: 'aardvark' }).listings.map((l) => l.domain)).toEqual(['outsider.com'])
    const api = (await (await h.request('/api/pros?n=2&page=1')).json()) as any
    expect(api.results.map((l: any) => l.domain)).toEqual(['alpha-build.com', 'bravo-homes.com'])
    expect(JSON.stringify(api)).not.toContain('promo')
    // Taking priority away leaves the listing in place.
    h.promo.updateMember(h.campaign, 'alpha-build.com', { priority: false })
    expect(h.listings.directory({ limit: 100 }).listings[0]!.domain).toBe('bravo-homes.com')
    expect(h.listings.directory({ limit: 100 }).listings.map((l) => l.domain)).toContain('alpha-build.com')
    // Stopping the campaign removes priority for all.
    h.promo.setState(h.campaign, 'stopped')
    const after = h.listings.directory({ limit: 100 }).listings.map((l) => l.domain)
    expect(after.indexOf('zulu-remodel.com')).toBeGreaterThan(after.indexOf('outsider.com'))
  })

  it('serves the roundup with tracked links, and its views stay campaign-level (AC-12)', async () => {
    const h = setup()
    const { roundup } = await launched(h)
    const page = await (await h.request('/roundup/los-gatos-builders', { headers: { 'user-agent': BROWSER } })).text()
    expect(page).toContain(`/b/alpha-build.com?via=${roundup.id}`)
    expect(page).not.toContain('zulu-remodel.com')
    expect(page).not.toContain('ann@alpha-build.com')
    const m = h.promo.metrics(h.campaign, 'alpha-build.com', 0, h.clock.t + DAY)
    expect(m.views).toBe(0)
    const campaignViews = h.promo.db.query("SELECT COUNT(*) AS n FROM promo_events WHERE type = 'roundup_view' AND domain IS NULL").get() as { n: number }
    expect(campaignViews.n).toBe(1)
  })

  it('writes spotlight text from the listing, with the tracking link last and within 300 characters', () => {
    const h = setup()
    const text = spotlightText(h.listings.toPublic('alpha-build.com')!, 'https://pit.world/b/alpha-build.com?via=plc_abcdefgh')
    expect(text.length).toBeLessThanOrEqual(300)
    expect(text.endsWith('https://pit.world/b/alpha-build.com?via=plc_abcdefgh')).toBe(true)
    expect(text).toContain('CSLB license 100')
    expect(text).not.toMatch(/[—–“”]/)
  })

  it('refuses spotlight accounts on networks that buy an ad per post (AC-20)', () => {
    const h = setup()
    expect(() => h.promo.configure(h.campaign, { spotlightAccounts: ['htmlblog:dev.profullstack.com/~anthony/blog'] })).toThrow('CrawlProof ad')
  })
})

describe('promotion: measurement', () => {
  it('starts a window only when the listing is live, tracking passed a marked test and a placement was verified (AC-08)', async () => {
    const h = setup()
    h.promo.import(h.campaign, snapshot())
    h.promo.launch(h.campaign, h.promo.preview(h.campaign).version)
    expect(h.promo.tick().started).toBe(0)
    await h.request('/b/alpha-build.com?pt=test', { headers: { 'user-agent': BROWSER } })
    await h.request('/b/alpha-build.com/go?pt=test', { headers: { 'user-agent': BROWSER } })
    expect(h.promo.checkTracking(h.campaign).passed).toEqual(['alpha-build.com'])
    expect(h.promo.tick().started).toBe(0)
    const roundup = h.promo.placements(h.campaign).placements.find((p) => p.kind === 'roundup')!
    h.clock.t += 3600 * 1000
    h.promo.report(roundup.id, { state: 'verified', evidence: { status: 200 } })
    expect(h.promo.tick().started).toBe(1)
    const [period] = h.promo.periods(h.campaign)
    expect(period.started_at).toBe(h.clock.t)
    expect(period.ends_at - period.started_at).toBe(30 * DAY)
  })

  it('counts views and clicks, deduplicates beacons and excludes tests, bots, previews and internal traffic (AC-11)', async () => {
    const h = setup()
    const { roundup } = await launched(h)
    const announce = h.promo.placements(h.campaign).placements.find((p) => p.kind === 'announcement')!
    await h.request(`/b/alpha-build.com?via=${roundup.id}`, { headers: { 'user-agent': BROWSER } })
    await h.request(`/b/alpha-build.com/go?via=${roundup.id}`, { headers: { 'user-agent': BROWSER } })
    await h.request('/b/alpha-build.com', { headers: { 'user-agent': BROWSER, referer: 'https://www.google.com/search?q=x' } })
    await h.request('/b/alpha-build.com', { headers: { 'user-agent': 'Googlebot/2.1' } })
    await h.request('/b/alpha-build.com', { headers: { 'user-agent': 'facebookexternalhit/1.1' } })
    await h.request('/b/alpha-build.com', { headers: { 'user-agent': BROWSER, 'sec-purpose': 'prefetch' } })
    await h.request('/b/alpha-build.com', { headers: { 'user-agent': BROWSER } }, '198.51.100.7')
    await h.request('/b/alpha-build.com?pt=test', { headers: { 'user-agent': BROWSER } })
    const beacon = { method: 'POST', headers: { 'user-agent': BROWSER, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'phone_click', id: 'abcdef123456', via: announce.id }) }
    await h.request('/b/alpha-build.com/e', beacon)
    await h.request('/b/alpha-build.com/e', beacon)
    // Only phone taps come from a beacon.
    await h.request('/b/alpha-build.com/e', { ...beacon, body: JSON.stringify({ type: 'website_click', id: 'zzzzzz123456' }) })
    const m = h.promo.metrics(h.campaign, 'alpha-build.com', 0, h.clock.t + DAY)
    expect(m).toMatchObject({ views: 2, clicks: 1, phone: 1, promoViews: 1, promoClicks: 1, unattributedViews: 1 })
    expect(m.exclusions).toMatchObject({ bot: 2, prefetch: 1, internal: 1 })
    expect(m.exclusions.test).toBeGreaterThanOrEqual(3)
    const stored = JSON.stringify(h.promo.db.query('SELECT * FROM promo_events').all())
    expect(stored).not.toContain('203.0.113.9')
    expect(stored).not.toContain('Macintosh')
    expect(stored).toContain('www.google.com')
    expect(stored).not.toContain('search?q')
  })

  it('does not track businesses outside a campaign', async () => {
    const h = setup()
    await launched(h)
    await h.request('/b/outsider.com', { headers: { 'user-agent': BROWSER } })
    expect((h.promo.db.query("SELECT COUNT(*) AS n FROM promo_events WHERE domain = 'outsider.com'").get() as { n: number }).n).toBe(0)
  })

  it('runs a whole window on simulated time across the DST change, with one review per window (AC-14, AC-15, AC-17)', async () => {
    const h = setup()
    await launched(h)
    const periods = h.promo.periods(h.campaign)
    expect(periods).toHaveLength(2)
    const ends = periods[0].ends_at
    // 2026-11-01 is the end of daylight time in Los Angeles: the window is still 30 x 24 hours.
    expect(ends - periods[0].started_at).toBe(30 * DAY)
    h.clock.t = ends - 1000
    expect(h.promo.tick().due).toBe(0)
    h.clock.t = ends + 1000
    const first = h.promo.tick()
    expect(first).toMatchObject({ due: 2, reviewed: 2 })
    // A restarted process runs the pass again: no second review task, no second report.
    expect(h.promo.tick()).toMatchObject({ due: 0, reviewed: 0 })
    expect(h.promo.reports(h.campaign)).toHaveLength(2)
    expect((h.promo.db.query("SELECT COUNT(*) AS n FROM promo_jobs WHERE kind = 'review'").get() as { n: number }).n).toBe(2)
    const report = h.promo.reports(h.campaign).find((r) => r.domain === 'bravo-homes.com')!
    expect(report.data.metrics.listingViews!.value).toBe(0)
    expect(report.data.metrics.platformImpressions!.value).toBeNull()
    expect(report.data.metrics.verifiedInquiries!.value).toBeNull()
    expect(report.data.period.timezone).toBe('America/Los_Angeles')
  })

  it('gives a late addition its own full window', async () => {
    const h = setup()
    await launched(h)
    h.clock.t += 5 * DAY
    h.listings.seed({ domain: 'zulu-remodel.com', name: 'Zulu Remodel', description: 'Remodels.', category: 'construction', city: 'Los Gatos', license: 'CSLB #3', licenseCheckedAt: h.clock.t })
    h.promo.updateMember(h.campaign, 'zulu-remodel.com', { holdAttestation: 'cmp_other paused by hand 2026-10-25' })
    h.promo.launch(h.campaign, h.promo.preview(h.campaign).version)
    const spot = h.promo.placements(h.campaign, { domain: 'zulu-remodel.com' }).placements.find((p) => p.kind === 'spotlight')!
    expect(spot.plannedAt).toBeGreaterThanOrEqual(h.clock.t)
    await h.request('/b/zulu-remodel.com?pt=test', { headers: { 'user-agent': BROWSER } })
    await h.request('/b/zulu-remodel.com/go?pt=test', { headers: { 'user-agent': BROWSER } })
    h.promo.checkTracking(h.campaign, ['zulu-remodel.com'])
    h.promo.report(spot.id, { state: 'publishing' } as any)
    h.promo.report(spot.id, { state: 'published', providerId: 'x', publicUrl: 'https://mastodon.example/@b/1' })
    h.promo.report(spot.id, { state: 'verified', evidence: { status: 200 } })
    h.promo.tick()
    const z = h.promo.periods(h.campaign).find((p: any) => p.domain === 'zulu-remodel.com')
    expect(z.started_at).toBe(h.clock.t)
    expect(z.ends_at).toBe(h.clock.t + 30 * DAY)
  })

  it('keeps scheduled, failed and uncertain posts out of the verified count (AC-10)', async () => {
    const h = setup()
    await launched(h)
    const [spot] = h.promo.placements(h.campaign).placements.filter((p) => p.kind === 'spotlight')
    h.clock.t = spot!.plannedAt + 1
    h.promo.lease(h.campaign, 'w')
    h.promo.report(spot!.id, { state: 'scheduled', queueId: 'q1' })
    expect(() => h.promo.report(spot!.id, { state: 'verified' })).toThrow()
    h.promo.report(spot!.id, { state: 'uncertain', error: 'timeout' })
    expect(h.promo.placements(h.campaign, { state: 'verified' }).placements.map((p) => p.kind)).toEqual(['roundup'])
  })

  it('records gaps and reports them', async () => {
    const h = setup()
    await launched(h)
    h.promo.recordGap(h.campaign, { kind: 'downtime', from: h.clock.t + DAY, to: h.clock.t + DAY + 3600 * 1000, note: 'deploy' })
    h.clock.t += 31 * DAY
    h.promo.tick()
    expect(h.promo.reports(h.campaign)[0]!.data.gaps).toEqual([expect.objectContaining({ kind: 'downtime', note: 'deploy' })])
  })
})

describe('promotion: reports and outreach', () => {
  async function ended(h: ReturnType<typeof setup>) {
    await launched(h)
    await h.request('/b/alpha-build.com', { headers: { 'user-agent': BROWSER } })
    await h.request('/b/alpha-build.com/go', { headers: { 'user-agent': BROWSER } })
    h.clock.t += 31 * DAY
    h.promo.tick()
  }

  it('quotes the report version in the draft, says zero as zero and supersedes on late data (AC-13, AC-18)', async () => {
    const h = setup()
    await ended(h)
    const drafts = h.promo.drafts(h.campaign)
    const alpha = drafts.find((d) => d.domain === 'alpha-build.com')!
    expect(alpha.kind).toBe('introduction')
    expect(alpha.recipientEmail).toBe('ann@alpha-build.com')
    expect(alpha.body).toContain('Hi Ann,')
    expect(alpha.body).toContain('1 view and 1 click')
    expect(alpha.body).toContain('https://pit.world/r/')
    expect(alpha.body).not.toContain('{{')
    expect(alpha.body).not.toMatch(/[—–]/)
    expect(alpha.body).not.toMatch(/following up|earlier note/i)
    const bravo = drafts.find((d) => d.domain === 'bravo-homes.com')!
    expect(bravo.body).toContain('no measurable visits or clicks')
    // Late data: a corrected event lands inside the window, and the report gets a new version.
    const period = h.promo.periods(h.campaign).find((p: any) => p.domain === 'alpha-build.com')
    h.promo.record({ type: 'listing_view', domain: 'alpha-build.com', ip: '192.0.2.1', userAgent: BROWSER, at: period.started_at + DAY })
    const v2 = h.promo.generateReport(period.id)
    expect(v2.version).toBe(2)
    expect(h.promo.draft(alpha.id).state).toBe('invalidated')
    expect(h.promo.createDraft(v2.id).body).toContain('2 views')
  })

  it('writes a follow-up only when contact is on record', () => {
    const d = { business: { name: 'X', listingUrl: 'u' }, period: { startLocal: 'a', endLocal: 'b' }, placements: [], metrics: { listingViews: { value: 3 }, websiteClicks: { value: 1 }, phoneClicks: { value: 0 } }, referrals: { promotionViews: 0 } } as any
    expect(draftText(d, { sender: null } as any, '', false, 'r').body).not.toContain('Following up')
    expect(draftText(d, { sender: null } as any, '', true, 'r').body).toContain('Following up on my earlier note')
  })

  it('blocks a draft without an address, and never sends before the window ends or without authorization (AC-16, AC-19)', async () => {
    const h = setup()
    await launched(h)
    // Mid-window: a report can be made by hand, but delivery refuses.
    const period = h.promo.periods(h.campaign).find((p: any) => p.domain === 'alpha-build.com')
    const early = h.promo.generateReport(period.id)
    const draft = h.promo.createDraft(early.id)
    await expect(h.promo.deliver(draft.id)).rejects.toThrow('not authorized')
    h.promo.configure(h.campaign, { sendAuthorized: true })
    await expect(h.promo.deliver(draft.id)).rejects.toThrow('has not ended')
    h.clock.t += 31 * DAY
    h.promo.tick()
    const final = h.promo.drafts(h.campaign).find((d) => d.domain === 'alpha-build.com' && d.state === 'draft')!
    h.upstream.suppressed = null
    await expect(h.promo.deliver(final.id)).rejects.toThrow('unknown')
    h.upstream.suppressed = true
    await expect(h.promo.deliver(final.id)).rejects.toThrow('suppressed')
    h.upstream.suppressed = false
    expect(await h.promo.deliver(final.id)).toMatchObject({ state: 'sent' })
    await expect(h.promo.deliver(final.id)).rejects.toThrow()
    expect(h.deliveries).toHaveLength(1)
  })

  it('serves a shared report without the operator economics, as HTML, Markdown and JSON', async () => {
    const h = setup()
    await ended(h)
    const r = h.promo.reports(h.campaign)[0]!
    const token = r.shareUrl.split('/r/')[1]
    const html = await (await h.request(`/r/${token}`)).text()
    expect(html).toContain('Listing views')
    expect(html).not.toContain('operator only')
    expect(await (await h.request(`/r/${token}.md`)).text()).toContain('| Listing views |')
    const json = (await (await h.request(`/r/${token}.json`)).json()) as any
    expect(json.economics).toBeUndefined()
    expect((await h.request('/r/not-a-real-token-at-all-xx')).status).toBe(404)
    const csv = await (await h.api('GET', `/campaigns/${h.campaign}/reports.csv`)).text()
    expect(csv.split('\n')[0]).toContain('listing_views')
    expect(csv).toContain('alpha-build.com')
  })
})

describe('promotion: controls', () => {
  it('pause stops new external actions and keeps everything else (AC-22)', async () => {
    const h = setup()
    await launched(h)
    h.clock.t += 3 * DAY
    h.promo.setState(h.campaign, 'paused')
    expect(h.promo.lease(h.campaign, 'w').placements).toEqual([])
    expect(h.listings.directory({ limit: 1 }).listings[0]!.domain).toBe('alpha-build.com')
    expect(h.promo.overview(h.campaign).periods).toEqual({ active: 2 })
    h.promo.setState(h.campaign, 'active')
    expect(h.promo.lease(h.campaign, 'w').placements.length).toBeGreaterThan(0)
  })

  it('never lets concurrent reservations pass the budget, and a missing budget is zero (AC-21)', async () => {
    const h = setup()
    expect(h.promo.reserve(h.campaign, 'paid', 1, 'a')).toBe(false)
    h.promo.configure(h.campaign, { budget: { paidCents: 1000, aiCents: 0 } })
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => h.promo.reserve(h.campaign, 'paid', 100, `job${i}`))))
    expect(results.filter(Boolean)).toHaveLength(10)
    expect(h.promo.reserve(h.campaign, 'ai', 1, 'x')).toBe(false)
  })

  it('answers the API only with the admin token, and launch needs an idempotency key', async () => {
    const h = setup()
    expect((await h.request(`/api/v1/promotion/campaigns`)).status).toBe(401)
    expect((await h.request(`/api/v1/promotion/campaigns`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await h.api('GET', '/campaigns')).status).toBe(200)
    const imported = (await (await h.api('POST', `/campaigns/${h.campaign}/imports`, { snapshot: snapshot() }, { 'idempotency-key': 'k1' })).json()) as any
    expect(imported.jobId).toMatch(/^job_/)
    const preview = (await (await h.api('POST', `/campaigns/${h.campaign}/preview`, {})).json()) as any
    expect((await h.api('POST', `/campaigns/${h.campaign}/launch`, { version: preview.version })).status).toBe(400)
    const a = (await (await h.api('POST', `/campaigns/${h.campaign}/launch`, { version: preview.version }, { 'idempotency-key': 'L' })).json()) as any
    const b = (await (await h.api('POST', `/campaigns/${h.campaign}/launch`, { version: preview.version }, { 'idempotency-key': 'L' })).json()) as any
    expect(a).toEqual(b)
    const roster = (await (await h.api('GET', `/campaigns/${h.campaign}/businesses?limit=1`)).json()) as any
    expect(roster.businesses).toHaveLength(1)
    // Not excluded here, so the dead site is a member too (without a listing: "seed a verified listing").
    expect(roster.total).toBe(5)
    expect((await h.request('/admin/promo')).status).toBe(401)
  })

  it('computes local posting hours in the campaign timezone', () => {
    // 10:00 in Los Angeles is 17:00 UTC in daylight time and 18:00 UTC after it ends.
    expect(new Date(localHour(Date.parse('2026-10-20T12:00:00Z'), 'America/Los_Angeles', 10)).toISOString()).toBe('2026-10-20T17:00:00.000Z')
    expect(new Date(localHour(Date.parse('2026-11-05T12:00:00Z'), 'America/Los_Angeles', 10)).toISOString()).toBe('2026-11-05T18:00:00.000Z')
  })
})

describe('promotion: the myna worker', () => {
  function fakeMyna() {
    const state = { history: [] as MynaEntry[], queue: [] as MynaQueued[], posts: 0, mode: 'now' as 'now' | 'queue' | 'crash' }
    const myna: Myna = {
      history: () => state.history,
      queue: () => state.queue,
      post: async (account, text) => {
        state.posts++
        if (state.mode === 'queue') state.queue.push({ id: `q${state.posts}`, targets: [account], text, status: 'pending', scheduledFor: 'later' })
        else if (state.mode === 'now') state.history.push({ at: new Date().toISOString(), accountId: account, text, ok: true, postId: `at://did:plc:x/app.bsky.feed.post/${state.posts}`, url: `https://bsky.app/profile/a/post/${state.posts}` })
        return { code: state.mode === 'crash' ? 1 : 0, output: '' }
      },
    }
    return { state, myna }
  }

  function clientFor(h: ReturnType<typeof setup>) {
    process.env.PIT_ADMIN_TOKEN = 'admintoken'
    return new PitClient('https://pit.world', (async (input: any, init: any) => h.app.request(String(input).replace('https://pit.world', ''), init, { ip: '127.0.0.1' })) as any)
  }

  it('posts each due placement once, reconciles instead of re-posting, and verifies through the public API (AC-09, AC-15)', async () => {
    const h = setup()
    await launched(h)
    const { state, myna } = fakeMyna()
    const client = clientFor(h)
    // The network's public API answers with the post, whose text carries the tracking link.
    const verify = (async () => new Response(JSON.stringify({ thread: { post: { record: { text: state.history.map((x) => x.text).join(' ') } } } }), { status: 200 })) as any
    // The announcement is due now; spotlights are on later days.
    await workOnce(client, h.campaign, myna, { fetch: verify })
    expect(state.posts).toBe(1)
    const announce = h.promo.placements(h.campaign).placements.find((p) => p.kind === 'announcement')!
    expect(announce.state).toBe('published')
    expect(announce.publicUrl).toContain('bsky.app')
    // A second pass verifies it and never posts it again.
    await workOnce(client, h.campaign, myna, { fetch: verify })
    expect(state.posts).toBe(1)
    expect(h.promo.placement(announce.id).state).toBe('verified')
    // A crash after myna recorded the post (lease lost, row still "publishing"): reconciled, not re-posted.
    const spot = h.promo.placements(h.campaign).placements.find((p) => p.kind === 'spotlight')!
    h.clock.t = spot.plannedAt + 1
    h.promo.lease(h.campaign, 'dead-worker', 1)
    state.history.push({ at: new Date().toISOString(), accountId: spot.account, text: spot.body, ok: true, postId: '1', url: 'https://defcon.social/@b/1' })
    h.clock.t += 16 * 60 * 1000
    await workOnce(client, h.campaign, myna, { fetch: verify })
    expect(state.posts).toBe(1)
    expect(h.promo.placement(spot.id).state).toMatch(/published|verified/)
  })

  it('keeps a queued post scheduled, and an unexplained exit uncertain until reconciled', async () => {
    const h = setup()
    await launched(h)
    const { state, myna } = fakeMyna()
    const client = clientFor(h)
    state.mode = 'queue'
    await workOnce(client, h.campaign, myna)
    const announce = h.promo.placements(h.campaign).placements.find((p) => p.kind === 'announcement')!
    expect(announce.state).toBe('scheduled')
    expect(findInMyna(myna, announce).queued?.id).toBe('q1')
    await workOnce(client, h.campaign, myna)
    expect(state.posts).toBe(1)
    const spot = h.promo.placements(h.campaign).placements.find((p) => p.kind === 'spotlight')!
    h.clock.t = spot.plannedAt + 1
    state.mode = 'crash'
    await workOnce(client, h.campaign, myna)
    expect(h.promo.placement(spot.id).state).toBe('uncertain')
    // Reconciled against history and queue: it never went, so it goes back in line rather than being re-sent blindly.
    await workOnce(client, h.campaign, myna)
    expect(h.promo.placement(spot.id).state).toBe('ready')
  })
})

describe('promotion: the verifier is not a visitor', () => {
  it('sends a user agent the event filter excludes, so checking a post never counts as a view', async () => {
    const { isPerson } = await import('../src/listings-routes.ts')
    const { verifyPublic } = await import('../src/promotion-worker.ts')
    const seen: string[] = []
    const fetchImpl = (async (_url: string, init: any) => {
      seen.push(init.headers['user-agent'])
      return new Response('<h1>x</h1>', { status: 200 })
    }) as any
    await verifyPublic({ id: 'plc_x', channel: 'pit.world', account: 'pit.world', publicUrl: 'https://pit.world/roundup/x' } as any, fetchImpl)
    expect(seen).toHaveLength(1)
    expect(isPerson(seen[0])).toBe(false)
  })
})

afterAll(() => {
  delete process.env.PIT_ADMIN_TOKEN
})
