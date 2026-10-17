/** Pages for promotion campaigns: the public roundup, a business's shareable report, and the operator's dashboard. */
import { docPage, esc } from './html.js'
import type { Listing } from './listings.js'
import { place } from './listings-html.js'
import type { Metric, Promotion, ReportData } from './promotion.js'

const p = (s: string) => encodeURIComponent(s)
const when = (ms: number | null | undefined, tz = 'America/Los_Angeles') =>
  ms ? new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms)) : '-'

/** The roundup: one section per business, each linking to its listing with the roundup's tracking id. */
export function roundupPage(options: { title: string; intro: string; slug: string; placementId: string; listings: Listing[]; updatedAt: number | null }): string {
  const sections = options.listings
    .map((l) => {
      const where = [l.area, place(l)].filter(Boolean).join(' · ')
      return `<section class="pro" id="${esc(l.domain)}">
  <h2><a href="/b/${p(l.domain)}?via=${esc(options.placementId)}">${esc(l.name || l.domain)}</a></h2>
  ${where ? `<p class="small">${esc(where)}</p>` : ''}
  ${l.description ? `<p>${esc(l.description)}</p>` : ''}
  ${l.services.length ? `<p class="small">${esc(l.services.slice(0, 6).join(' · '))}</p>` : ''}
  ${l.license ? `<p class="small">${esc(l.license)}${l.licenseCheckedAt ? `, active when pit.world checked on ${esc(new Date(l.licenseCheckedAt).toISOString().slice(0, 10))}` : ''}</p>` : ''}
  <p class="row"><a href="/b/${p(l.domain)}?via=${esc(options.placementId)}">Listing and contact →</a></p>
</section>`
    })
    .join('\n')
  return docPage({
    title: `${options.title} · pit.world`,
    description: `${options.listings.length} local contractors, each with a license pit.world checked. No paid placement.`,
    path: `/roundup/${p(options.slug)}`,
    body: `<p class="kicker">Roundup · pro directory</p>
<h1>${esc(options.title)}</h1>
<p class="lede">${esc(options.intro)}</p>
<p class="small">${options.listings.length} businesses. Nobody paid to be here and none of them asked: pit.world wrote these from each business's own website and its state license record. Order is pit.world's, not a ranking. Something wrong about yours? Use "Claim this listing" on its page to correct it, or to take it down.</p>
${sections}
<p class="small">More pros: <a href="/pros/construction">pit.world/pros/construction</a>.</p>`,
  })
}

const metricRow = (label: string, m: Metric | undefined) =>
  m ? `<tr><th>${esc(label)}</th><td>${m.value === null ? '<i>unavailable</i>' : esc(String(m.value))}</td><td class="small">${esc(m.definition)}${m.note ? `. ${esc(m.note)}` : ''} <span class="muted">(${esc(m.source)})</span></td></tr>` : ''

const METRIC_LABELS: Array<[string, string]> = [
  ['listingViews', 'Listing views'],
  ['visitorDays', 'Visitor-days'],
  ['uniqueVisitors', 'Unique visitors'],
  ['websiteClicks', 'Website clicks'],
  ['phoneClicks', 'Phone taps'],
  ['emailClicks', 'Email taps'],
  ['verifiedInquiries', 'Verified inquiries'],
  ['verifiedPlacements', 'Verified placements'],
  ['platformImpressions', 'Platform impressions'],
]

/** A report as HTML. `shared` leaves out what is for the operator only (spend, effort). */
export function reportPage(d: ReportData, version: number, shared: boolean): string {
  return docPage({
    title: `${d.business.name}: results ${d.period.startLocal} to ${d.period.endLocal} · pit.world`,
    description: `Listing results for ${d.business.name}.`,
    path: '/r',
    noindex: true,
    body: `<p class="kicker">Results · report v${version}</p>
<h1>${esc(d.business.name)}</h1>
<p><a href="${esc(d.business.listingUrl)}">${esc(d.business.listingUrl)}</a></p>
<p>${esc(d.period.startLocal)} to ${esc(d.period.endLocal)} (${esc(d.period.timezone)}): ${esc(d.period.startedAt)} to ${esc(d.period.endsAt)} UTC.</p>
<h2>Where it was promoted</h2>
${d.placements.length ? `<ul>${d.placements.map((x) => `<li>${esc(x.kind)} on ${esc(x.channel === 'pit.world' ? 'pit.world' : x.account)}: <a href="${esc(x.url)}" rel="noreferrer noopener">${esc(x.url)}</a>${x.sharedWith > 1 ? ` <span class="small">(shared with ${x.sharedWith - 1} other businesses; its audience is not counted as yours)</span>` : ''}</li>`).join('')}</ul>` : '<p>No verified placement.</p>'}
<h2>What was measured</h2>
<table class="facts">${METRIC_LABELS.map(([k, label]) => metricRow(label, d.metrics[k])).join('')}</table>
<h2>Promotion versus everything else</h2>
<p>Views that came from one of the campaign's own links: <b>${d.referrals.promotionViews}</b>. Clicks to your website from those visits: <b>${d.referrals.promotionClicks}</b>. Views and clicks we cannot attribute (search, direct, other sites): <b>${d.referrals.unattributedViews}</b> and <b>${d.referrals.unattributedClicks}</b>. We do not claim the promotion caused the rest.</p>
<h2>Left out, and gaps</h2>
<p class="small">${Object.entries(d.exclusions).length ? Object.entries(d.exclusions).map(([k, n]) => `${esc(k)}: ${n}`).join(' · ') : 'Nothing was excluded.'} Crawlers, link previews, prefetches, our own traffic and marked tests are not counted; this filter is imperfect and what remains is not proven to be people.</p>
${d.gaps.length ? `<ul>${d.gaps.map((g) => `<li>${esc(g.kind)} from ${esc(g.from)} to ${esc(g.to ?? 'ongoing')}: ${esc(g.note)}</li>`).join('')}</ul>` : '<p class="small">No recorded downtime or tracking gaps.</p>'}
${shared ? '' : `<h2>Costs (operator only)</h2><p>Paid media: $${(d.economics.paidCents / 100).toFixed(2)} · AI: $${(d.economics.aiCents / 100).toFixed(2)} · operator time: ${d.economics.operatorMinutes ?? 'not recorded'}</p>`}
<h2>Next step</h2>
<p>${esc(d.nextStep)}</p>
<p class="small">Generated ${esc(d.cutoff)} under rules ${esc(d.rulesVersion)}. Numbers come from pit.world's own records: no cookies, no IP addresses kept.</p>`,
  })
}

export function reportMarkdown(d: ReportData, version: number, shared: boolean): string {
  const rows = METRIC_LABELS.filter(([k]) => d.metrics[k]).map(([k, label]) => {
    const m = d.metrics[k]!
    return `| ${label} | ${m.value === null ? 'unavailable' : m.value} | ${m.definition}${m.note ? `. ${m.note}` : ''} (${m.source}) |`
  })
  return [
    `# ${d.business.name}: results, report v${version}`,
    '',
    `Listing: ${d.business.listingUrl}`,
    `Window: ${d.period.startLocal} to ${d.period.endLocal} (${d.period.timezone}); ${d.period.startedAt} to ${d.period.endsAt} UTC`,
    '',
    '## Placements',
    ...(d.placements.length ? d.placements.map((x) => `- ${x.kind} on ${x.channel === 'pit.world' ? 'pit.world' : x.account}: ${x.url}${x.sharedWith > 1 ? ` (shared with ${x.sharedWith - 1} others)` : ''}`) : ['- none verified']),
    '',
    '## Metrics',
    '| Metric | Value | Definition |',
    '| --- | --- | --- |',
    ...rows,
    '',
    `Promotion-referred views ${d.referrals.promotionViews}, clicks ${d.referrals.promotionClicks}; unattributed views ${d.referrals.unattributedViews}, clicks ${d.referrals.unattributedClicks}.`,
    `Excluded: ${Object.entries(d.exclusions).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}. Gaps: ${d.gaps.map((g) => `${g.kind} ${g.from} to ${g.to ?? 'ongoing'} (${g.note})`).join('; ') || 'none recorded'}.`,
    ...(shared ? [] : ['', `Costs (operator only): paid $${(d.economics.paidCents / 100).toFixed(2)}, AI $${(d.economics.aiCents / 100).toFixed(2)}, operator time ${d.economics.operatorMinutes ?? 'not recorded'}.`]),
    '',
    `Next step: ${d.nextStep}`,
    '',
    `Generated ${d.cutoff}, rules ${d.rulesVersion}.`,
    '',
  ].join('\n')
}

/** What a shared report may carry: everything but the operator's economics. */
export function sharedReport(d: ReportData): Omit<ReportData, 'economics'> {
  const { economics: _economics, ...rest } = d
  return rest
}

/** The operator dashboard: the actual businesses first, then the calendar, windows, reports and drafts. */
export function adminPage(promo: Promotion, campaignId: string, message = ''): string {
  const o = promo.overview(campaignId)
  const c = promo.campaign(campaignId)
  const tz = c.config.timezone
  const roster = promo.roster(campaignId).businesses
  const placements = promo.placements(campaignId, { limit: 500 }).placements
  const periods = promo.periods(campaignId)
  const drafts = promo.drafts(campaignId)
  const counts = (obj: Record<string, number>) => Object.entries(obj).map(([k, n]) => `${esc(k)} ${n}`).join(' · ') || 'none'
  const action = (name: string, label: string, extra = '') => `<form method="post" action="/admin/promo/${p(c.id)}/${name}" class="inline">${extra}<button class="btn" type="submit">${esc(label)}</button></form>`
  return docPage({
    title: `${c.name} · promotion · pit.world`,
    description: 'Promotion campaign dashboard.',
    path: `/admin/promo/${p(c.id)}`,
    noindex: true,
    body: `<p class="kicker">Promotion campaign · ${esc(o.campaign.state)}</p>
<h1>${esc(c.name)}</h1>
${message ? `<p class="notice">${esc(message)}</p>` : ''}
<p class="small">Source ${esc(o.campaign.source)} · launched ${esc(when(c.launchedAt, tz))} · roundup <a href="/roundup/${p(c.config.slug)}">/roundup/${esc(c.config.slug)}</a></p>
<p class="row">${c.state === 'active' ? action('pause', 'Pause campaign') : c.state === 'paused' ? action('resume', 'Resume') : ''} ${action('tick', 'Run the hourly pass now')} ${action('reports', 'Generate due reports')}</p>
<h2>Businesses (${roster.length})</h2>
<p class="small">Members: ${counts(o.members)} · outreach holds: ${counts(o.holds)} · tracking tested ${o.trackingTested}</p>
<div class="scroll"><table class="facts"><tr><th>Business</th><th>Status</th><th>Hold</th><th>Action</th></tr>
${roster.map((b) => `<tr><td>${b.listingUrl ? `<a href="${esc(b.listingUrl)}">${esc(b.business)}</a>` : esc(b.business)}<br><span class="small">${esc(b.website)} · ${b.leadIds.length} lead${b.leadIds.length === 1 ? '' : 's'}</span></td><td>${esc(b.verification)}<br><span class="small">${esc(b.reason)}</span></td><td>${esc(b.hold)}</td><td class="small">${esc(b.plannedAction)}</td></tr>`).join('')}
</table></div>
<h2>Promotion calendar (${placements.length})</h2>
<p class="small">${counts(o.placements)}. Scheduled, failed and uncertain posts are not counted as published; only verified ones start a window.</p>
<div class="scroll"><table class="facts"><tr><th>When</th><th>What</th><th>State</th><th>Link</th></tr>
${placements.map((x) => `<tr><td class="small">${esc(when(x.plannedAt, tz))}</td><td>${esc(x.kind)} · ${esc(x.account)}<br><span class="small">${esc(x.businesses.length > 3 ? `${x.businesses.length} businesses` : x.businesses.join(', '))}</span></td><td>${esc(x.state)}${x.error ? `<br><span class="small">${esc(x.error)}</span>` : ''}${x.state === 'failed' ? action(`placements/${p(x.id)}/retry`, 'Retry') : ''}</td><td class="small">${x.publicUrl ? `<a href="${esc(x.publicUrl)}" rel="noreferrer noopener">${esc(x.publicUrl.replace(/^https?:\/\//, '').slice(0, 60))}</a>` : '-'}</td></tr>`).join('')}
</table></div>
<h2>Measurement windows (${periods.length})</h2>
<p class="small">${counts(o.periods)}. ${c.config.periodDays} days each, from the moment the listing was live, tracking had passed a test, and a placement naming the business was verified.</p>
<div class="scroll"><table class="facts"><tr><th>Business</th><th>From</th><th>To</th><th>State</th></tr>
${periods.map((x: any) => `<tr><td><a href="/admin/promo/${p(c.id)}/b/${p(x.domain)}">${esc(x.domain)}</a></td><td class="small">${esc(when(x.started_at, tz))}</td><td class="small">${esc(when(x.ends_at, tz))}</td><td>${esc(x.state)}</td></tr>`).join('')}
</table></div>
<h2>Reports and drafts</h2>
<p class="small">${o.reports} current reports · drafts: ${counts(o.drafts)} · sending ${c.config.sendAuthorized ? 'authorized' : 'off (drafts only)'} · spend: paid $${(o.spend.paidCents / 100).toFixed(2)}, AI $${(o.spend.aiCents / 100).toFixed(2)} · <a href="/api/v1/promotion/campaigns/${p(c.id)}/reports.csv">comparison CSV</a></p>
${drafts.length ? `<ul>${drafts.map((d) => `<li><b>${esc(d.domain)}</b> · ${esc(d.kind)} · ${esc(d.state)}${d.reason ? ` (${esc(d.reason)})` : ''} · to ${esc(d.recipientName || '-')}</li>`).join('')}</ul>` : '<p class="small">No drafts yet: they are written when a window ends.</p>'}`,
  })
}

export function adminMemberPage(promo: Promotion, campaignId: string, domain: string): string {
  const c = promo.campaign(campaignId)
  const r = promo.results(campaignId, domain)
  const placements = promo.placements(campaignId, { domain }).placements
  return docPage({
    title: `${r.name || domain} · promotion · pit.world`,
    description: 'Promotion results for one business.',
    path: `/admin/promo/${p(c.id)}/b/${p(domain)}`,
    noindex: true,
    body: `<p class="kicker"><a href="/admin/promo/${p(c.id)}">${esc(c.name)}</a></p>
<h1>${esc(r.name || domain)}</h1>
<p><a href="${esc(r.listingUrl)}">${esc(r.listingUrl)}</a> · ${esc(r.state)} · hold ${esc(r.hold)} (${esc(r.holdDetail)})</p>
<h2>Placements</h2>
<ul>${placements.map((x) => `<li>${esc(x.kind)} · ${esc(x.account)} · ${esc(x.state)} · ${esc(when(x.plannedAt, c.config.timezone))}${x.publicUrl ? ` · <a href="${esc(x.publicUrl)}" rel="noreferrer noopener">post</a>` : ''}${x.error ? ` · ${esc(x.error)}` : ''}</li>`).join('')}</ul>
<h2>Windows</h2>
${r.windows.length ? r.windows.map((w: any) => `<p>${esc(when(w.started_at, c.config.timezone))} to ${esc(when(w.ends_at, c.config.timezone))} · ${esc(w.state)} · so far: ${w.soFar.listingViews} views, ${w.soFar.websiteClicks} website clicks, ${w.soFar.phoneClicks} phone taps, ${w.soFar.promotionViews} views from campaign links${w.report ? ` · <a href="${esc(w.report.shareUrl)}">report v${w.report.version}</a>` : ''}</p>`).join('') : '<p class="small">No window yet.</p>'}`,
  })
}
