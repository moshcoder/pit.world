/** Pages for business listings (/b) and the pro directory (/pros). Every value is escaped; links carry no referrer. */
import { docPage, esc } from './html.js'
import type { ClaimStart, ContactStatus, Listing } from './listings.js'
import { CATEGORIES, PRICES, categoryOf, operatorHref, priceLabel, ringEligible } from './pros.js'
import { proxyUrl, ringSnippet, RSS_RING } from './ring.js'
import { openProfilePath } from './listing-openprofile.js'

const p = (s: string) => encodeURIComponent(s)
const ext = (href: string, text: string) => `<a href="${esc(href)}" rel="noreferrer noopener">${esc(text)}</a>`
const bare = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '')

/** CSLB's license lookup. Its detail pages need a session cookie, so link the search form. */
const CSLB_CHECK = 'https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx'
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function licenseRow(l: Listing): string {
  if (!l.license) return ''
  const checked = l.licenseCheckedAt ? ` · active when pit.world checked on ${day(l.licenseCheckedAt)}` : ''
  const verify = /^CSLB\b/.test(l.license) ? ` · ${ext(CSLB_CHECK, 'check it at CSLB')}` : ''
  return `<li><b>License</b> ${esc(l.license)}${esc(checked)}${verify}</li>`
}

/**
 * The listing's website: a link on its own domain (some sites only answer on www or http), else https://<domain>/.
 * A site that lives only on Moshpit opens through our relay, so the link works in any browser.
 */
export function siteUrl(l: Listing): string {
  if (l.moshpitOnly) return proxyUrl(l.domain)
  const own = l.links.find((u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '') === l.domain
    } catch {
      return false
    }
  })
  return own ?? `https://${l.domain}/`
}

export function place(l: Listing): string {
  return [l.city, l.region, l.country].filter(Boolean).join(', ')
}

function details(l: Listing, track?: { domain: string; via: string }): string {
  const beacon = track ? ` data-ev="phone" data-domain="${esc(track.domain)}"${track.via ? ` data-via="${esc(track.via)}"` : ''}` : ''
  const where = place(l)
  const operator = l.operator ? (operatorHref(l.operator) ? ext(l.operator, bare(l.operator)) : `<span class="handle">${esc(l.operator)}</span>`) : ''
  const rows = [
    l.category && `<li><b>Category</b> <a href="/pros/${p(l.category)}">${esc(categoryOf(l.category)?.label ?? l.category)}</a></li>`,
    l.operator && `<li><b>Operated by</b> ${operator}</li>`,
    l.company && `<li><b>Company</b> ${l.companyUrl ? ext(l.companyUrl, l.company) : esc(l.company)}</li>`,
    !l.company && l.companyUrl && `<li><b>Company</b> ${ext(l.companyUrl, bare(l.companyUrl))}</li>`,
    (where || l.area) && `<li><b>Serves</b> ${esc([l.area, where].filter(Boolean).join(' · '))}</li>`,
    l.price && `<li><b>Price</b> ${esc(priceLabel(l.price))}</li>`,
    l.hours && `<li><b>Hours</b> ${esc(l.hours)}</li>`,
    l.address && `<li><b>Address</b> ${esc(l.address)}</li>`,
    licenseRow(l),
    l.phone && `<li><b>Phone</b> <a href="tel:${esc(l.phone.replace(/[^\d+]/g, ''))}"${beacon}>${esc(l.phone)}</a></li>`,
    l.moshpit && `<li><b>On Moshpit</b> ${ext(`https://${l.moshpit}/`, l.moshpit)} · ${ext(proxyUrl(l.moshpit), `${l.moshpit}.pit.world`)} <span class="muted">(any browser)</span></li>`,
    l.feed && `<li><b>Feed</b> ${ext(l.feed, bare(l.feed))}</li>`,
    ...l.links.filter((u) => u !== siteUrl(l)).map((u) => `<li>${ext(u, bare(u))}</li>`),
  ].filter(Boolean)
  return rows.length ? `<ul class="facts">${rows.join('')}</ul>` : ''
}

function services(l: Listing): string {
  return l.services.length ? `<h2>Services</h2><ul class="services">${l.services.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''
}

/** The card beside search results, for claimed listings only. */
export function listingCard(l: Listing): string {
  return `<aside class="card listing">
  <p class="kicker">Business listing · <span class="verified">✓ verified owner</span></p>
  <h2><a href="/b/${p(l.domain)}">${esc(l.name || l.domain)}</a></h2>
  ${l.description ? `<p>${esc(l.description)}</p>` : ''}
  ${details(l)}
  <p class="row"><a class="btn" href="${esc(siteUrl(l))}" rel="noreferrer noopener">Visit ${esc(l.domain)}</a> <a href="/b/${p(l.domain)}">Full listing →</a>${l.quotes ? ` <a href="/b/${p(l.domain)}#quote">Get in touch</a>` : ''}</p>
</aside>`
}

export type QuoteState = 'sent' | 'invalid' | 'undeliverable' | 'limited' | 'failed' | 'unavailable'

const QUOTE_NOTES: Record<QuoteState, string> = {
  sent: 'Sent. The owner gets your message by email and replies to you directly.',
  invalid: 'Add your name, a real email address and a message of at least a few words (and no more than three links).',
  undeliverable: "That email address's domain can't receive mail, so the owner could not reply to you.",
  limited: 'This listing has had a lot of messages recently. Try again in an hour or two.',
  failed: "pit.world couldn't send that just now. Try again in a few minutes.",
  unavailable: 'This listing is not taking messages through pit.world.',
}

function quoteForm(l: Listing, state?: QuoteState): string {
  if (!l.quotes) return ''
  return `<section class="quote" id="quote">
<h2>Request a quote · get in touch</h2>
${state ? `<p class="notice">${esc(QUOTE_NOTES[state])}</p>` : ''}
<form class="listing-form" action="/b/${p(l.domain)}/quote" method="post">
  <label for="q-name">Your name</label><input id="q-name" name="name" maxlength="80" required autocomplete="name">
  <label for="q-email">Your email</label><input id="q-email" name="email" type="email" maxlength="254" required autocomplete="email">
  <label for="q-phone">Phone (optional)</label><input id="q-phone" name="phone" maxlength="40" autocomplete="tel">
  <label for="q-message">What do you need?</label><textarea id="q-message" name="message" maxlength="3000" rows="6" required minlength="10"></textarea>
  <div class="hp" aria-hidden="true"><label for="q-website">Leave this empty</label><input id="q-website" name="website" tabindex="-1" autocomplete="off"></div>
  <button class="btn" type="submit">Send to ${esc(l.name || l.domain)}</button>
</form>
<p class="small">Goes to the owner by email, with your address to reply to. pit.world never shows their address, and keeps no copy of your message. One listing per message; no bulk sends.</p>
</section>`
}

/**
 * A directory listing's website link goes through /b/<domain>/go, which counts the click (for promotion
 * campaigns only; see src/promotion-routes.ts) and redirects to the site. A bare unclaimed page links direct.
 */
function websiteHref(l: Listing, via: string): string {
  if (!(l.claimed || l.seeded) || !l.listed) return siteUrl(l)
  return `/b/${p(l.domain)}/go${via ? `?via=${p(via)}` : ''}`
}

/** Directory listings (claimed or listed by pit.world, and not taken out) publish an OpenProfile. */
export const hasOpenProfile = (l: Listing) => l.listed

export function listingPage(l: Listing, options: { quote?: QuoteState; via?: string } = {}): string {
  const title = l.name || l.domain
  const via = options.via ?? ''
  const claim = l.claimed
    ? `<p class="small">Claimed by the owner of ${esc(l.domain)}.${l.ring ? ` In the <a href="/ring">pit.world ring</a>.` : ''} <a href="/b/${p(l.domain)}/edit">Owner? Edit this listing</a></p>`
    : l.seeded
      ? `<section class="claim" id="claim">
  <h2>Is this your business? Claim it</h2>
  <p>pit.world listed ${esc(title)} in the <a href="/pros">pro directory</a> from public records: its own website and its state license. Nobody at ${esc(l.domain)} wrote or paid for this page. Claim it to take it over: rewrite it, add your services, hours and links, turn on quote requests, or take it out of the directory. You prove you run ${esc(l.domain)} with a DNS record or a tag on your homepage. No account, no fee.</p>
  <form action="/b/${p(l.domain)}/claim" method="post"><button class="btn" type="submit">Claim this listing</button></form>
</section>`
      : `<section class="claim" id="claim">
  <h2>Is this your business?</h2>
  <p>Claim the listing to write it yourself: what you do, who runs it, where you work, services, hours, phone, links and your Moshpit name. You prove you run ${esc(l.domain)} with a DNS record or a tag on your homepage. No account, no fee.</p>
  <form action="/b/${p(l.domain)}/claim" method="post"><button class="btn" type="submit">Claim this listing</button></form>
</section>`
  return docPage({
    title: `${title} · pit.world`,
    description: l.description || `${l.domain} on pit.world`,
    path: `/b/${p(l.domain)}`,
    noindex: !l.claimed && !l.seeded,
    ...(hasOpenProfile(l) ? { head: `<link rel="openprofile" type="text/markdown" href="${esc(openProfilePath(l.domain))}">\n` } : {}),
    body: `<p class="kicker">Business listing${l.claimed ? ' · <span class="verified">✓ verified owner</span>' : l.seeded ? ' · listed by pit.world · unclaimed' : ' · unclaimed'}</p>
<h1>${esc(title)}</h1>
<p><a href="${esc(websiteHref(l, via))}" rel="noreferrer noopener nofollow">${esc(l.domain)}</a></p>
${l.description ? `<p class="lede">${esc(l.description)}</p>` : l.claimed ? '' : '<p class="small">Nothing here yet beyond the name.</p>'}
${details(l, { domain: l.domain, via })}
${services(l)}
${l.claimed ? quoteForm(l, options.quote) : ''}
${l.claimed ? '' : l.seeded ? `<p class="small">Written by pit.world from public information, not by the business. Details can go out of date: check with ${esc(l.domain)} before you hire. Something wrong? The owner can claim this page to correct it, or take it down.</p>` : `<p class="small">Until it is claimed, this listing shows what ${esc(l.domain)}'s own homepage says about itself.</p>`}
${claim}
${l.listed && l.phone ? '<script src="/listing.js" defer></script>' : ''}`,
  })
}

export function claimPage(domain: string, c: ClaimStart): string {
  return docPage({
    title: `Claim ${domain} · pit.world`,
    description: `Prove you run ${domain}.`,
    path: `/b/${p(domain)}/claim`,
    noindex: true,
    body: `<p class="kicker">Claim a listing</p>
<h1>Prove you run ${esc(domain)}</h1>
<p>Do <b>one</b> of these, then press Verify. Bookmark this page: the link below works for 7 days.</p>
<h2>Option 1: a DNS record</h2>
<p>At your DNS provider, add a <b>TXT</b> record:</p>
<pre><code>Name:  _pit-verify.${esc(domain)}
Value: ${esc(c.token)}</code></pre>
<p class="small">Some providers want only <code>_pit-verify</code> as the name. New records can take a few minutes to appear.</p>
<h2>Option 2: a tag on your homepage</h2>
<p>Put this inside the <code>&lt;head&gt;</code> of <code>https://${esc(domain)}/</code>:</p>
<pre><code>${esc(c.meta)}</code></pre>
<form action="/b/${p(domain)}/verify" method="post">
  <input type="hidden" name="claim" value="${esc(c.claimId)}">
  <button class="btn" type="submit">Verify</button>
</form>
<p class="small">Come back later: <a href="/b/${p(domain)}/claim/${esc(c.claimId)}">pit.world/b/${esc(domain)}/claim/${esc(c.claimId)}</a></p>`,
  })
}

export function verifyFailedPage(domain: string, c: ClaimStart | null): string {
  return docPage({
    title: `Not verified yet · pit.world`,
    description: `Claim ${domain}.`,
    path: `/b/${p(domain)}/verify`,
    noindex: true,
    body: c
      ? `<h1>Not found yet</h1>
<p>pit.world could not find <code>${esc(c.token)}</code> in a TXT record at <code>_pit-verify.${esc(domain)}</code>, or the meta tag on <code>https://${esc(domain)}/</code>. DNS changes can take a few minutes; try again shortly.</p>
<form action="/b/${p(domain)}/verify" method="post"><input type="hidden" name="claim" value="${esc(c.claimId)}"><button class="btn" type="submit">Verify again</button></form>
<p class="small"><a href="/b/${p(domain)}/claim/${esc(c.claimId)}">Back to the instructions</a></p>`
      : `<h1>That claim has expired</h1><p>Claims last 7 days. <a href="/b/${p(domain)}">Start a new one</a>.</p>`,
  })
}

function ringBlock(domain: string): string {
  return `<h2>You're in the pit.world ring</h2>
<p>Every claimed *.pit.world site and Moshpit name joins the <a href="/ring">pit.world web ring</a>: visitors walk from one member's site to the next. Paste these links anywhere on your site (a footer is good) so people can walk on from yours. If your homepage has an RSS or Atom feed, the ring also carries it on <a href="${RSS_RING}" rel="noreferrer noopener">rssamplifier.com</a>. Rather not? Choose "Leave the ring" on the edit page.</p>
<pre><code>${esc(ringSnippet(domain))}</code></pre>`
}

export function verifiedPage(domain: string, editKey: string, method: 'dns' | 'meta', inRing = false): string {
  return docPage({
    title: `${domain} is yours · pit.world`,
    description: `Listing claimed.`,
    path: `/b/${p(domain)}/verify`,
    noindex: true,
    body: `<p class="kicker">Claimed ✓</p>
<h1>${esc(domain)} is yours</h1>
<p>Verified by ${method === 'dns' ? 'DNS record' : 'homepage tag'}. This is your <b>edit key</b>. It is shown <b>once</b>: pit.world keeps only a fingerprint of it, so it cannot show it again. Save it in your password manager.</p>
<pre><code class="fp">${esc(editKey)}</code></pre>
<p>Lost it? Claim the listing again; the new key replaces the old one. You can remove the DNS record or tag now.</p>
<p><a class="btn" href="/b/${p(domain)}/edit">Write your listing →</a></p>
${inRing ? ringBlock(domain) : ''}`,
  })
}

const CONTACT_NOTES: Record<ContactStatus, string> = {
  none: 'No address set: the listing shows no quote form.',
  pending: 'Waiting for the confirmation link to be clicked.',
  confirmed: 'Confirmed: quote requests are on.',
}

export function editPage(l: Listing, message = '', contact: ContactStatus | null = null): string {
  const field = (name: string, label: string, value: string, max: number, long = false, hint = '') =>
    `<label for="${name}">${label}</label>${long ? `<textarea id="${name}" name="${name}" maxlength="${max}" rows="4">${esc(value)}</textarea>` : `<input id="${name}" name="${name}" value="${esc(value)}" maxlength="${max}">`}${hint ? `<p class="small">${hint}</p>` : ''}`
  const select = (name: string, label: string, value: string, options: Array<{ slug: string; label: string }>, blank: string) =>
    `<label for="${name}">${label}</label><select id="${name}" name="${name}"><option value="">${esc(blank)}</option>${options.map((o) => `<option value="${esc(o.slug)}"${o.slug === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
  return docPage({
    title: `Edit ${l.domain} · pit.world`,
    description: `Edit the ${l.domain} listing.`,
    path: `/b/${p(l.domain)}/edit`,
    noindex: true,
    body: `<p class="kicker">Edit listing</p>
<h1>${esc(l.name || l.domain)}</h1>
${message ? `<p class="notice">${esc(message)}</p>` : ''}
${l.claimed ? '' : `<p class="notice">This listing is not claimed yet. <a href="/b/${p(l.domain)}">Claim it first</a>.</p>`}
<form class="listing-form" action="/b/${p(l.domain)}/edit" method="post">
  <label for="key">Edit key</label><input id="key" name="key" type="password" autocomplete="current-password" required placeholder="pitk_…">
  ${field('name', 'Name', l.name, 80)}
  ${field('description', 'What you do', l.description, 600, true)}
  <h2>Who runs it</h2>
  ${field('operator', 'Operated by', l.operator, 300, false, 'An agent or person handle like <code>riotcoder@profullstack.com</code>, or an https link to a profile or OpenAgent record.')}
  ${field('company', 'Company', l.company, 100)}
  ${field('companyUrl', 'Company website', l.companyUrl, 300)}
  <h2>Pro directory</h2>
  ${select('category', 'Category', l.category, CATEGORIES, 'Not in the directory by category')}
  ${field('services', 'Services offered (one per line, up to 12)', l.services.join('\n'), 1200, true)}
  ${field('area', 'Service area', l.area, 160, false, 'In your words: "Bay Area and remote", "within 30 miles of Austin".')}
  ${field('city', 'City', l.city, 80)}
  ${field('region', 'State or region', l.region, 80)}
  ${field('country', 'Country', l.country, 80)}
  ${select('price', 'Price range', l.price, [...PRICES], 'Not shown')}
  ${field('hours', 'Hours', l.hours, 200)}
  ${field('address', 'Address', l.address, 200)}
  ${field('phone', 'Phone', l.phone, 40)}
  <h2>Quote requests</h2>
  <label for="contact">Email for quote requests (private)</label><input id="contact" name="contact" type="email" maxlength="254" placeholder="${l.quotes ? 'set: leave blank to keep it' : 'you@yourbusiness.com'}">
  <p class="small">Never shown on the listing. Visitors write through a form; pit.world mails you their message with their address to reply to. A new address only starts working once you click the link pit.world mails to it.${contact ? ` <b>${esc(CONTACT_NOTES[contact])}</b>` : ''}</p>
  <label class="check"><input type="checkbox" name="contactRemove" value="1"> Stop quote requests (forget the address)</label>
  <h2>Links</h2>
  ${field('links', 'Links (one per line, up to 5)', l.links.join('\n'), 1600, true)}
  ${field('moshpit', 'Moshpit name (e.g. acme.bakery)', l.moshpit, 253)}
  <h2>Pro directory listing</h2>
  <label for="listed">In the <a href="/pros">pro directory</a></label><select id="listed" name="listed"><option value="in"${l.listed || !l.claimed ? ' selected' : ''}>Listed</option><option value="out"${l.claimed && !l.listed ? ' selected' : ''}>Take it out of the directory</option></select>
  <p class="small">Out of the directory, this page still answers at pit.world/b/${esc(l.domain)}.</p>
${ringEligible(l.domain, l.moshpitOnly) ? `  <h2>Web ring</h2>
  <label for="ring">The pit.world ring</label><select id="ring" name="ring"><option value="in"${l.ring || !l.claimed ? ' selected' : ''}>In the ring</option><option value="out"${l.claimed && !l.ring ? ' selected' : ''}>Leave the ring</option></select>` : ''}
  <button class="btn" type="submit">Save</button>
</form>
${l.claimed && l.ring ? ringBlock(l.domain) : ''}`,
  })
}

export function contactConfirmedPage(domain: string, ok: boolean): string {
  return docPage({
    title: ok ? 'Address confirmed · pit.world' : 'Link expired · pit.world',
    description: 'Quote requests for a pit.world listing.',
    path: `/b/${p(domain)}/contact`,
    noindex: true,
    body: ok
      ? `<h1>Quote requests are on</h1><p>Messages from the form on <a href="/b/${p(domain)}">pit.world/b/${esc(domain)}</a> now come to this address. It is never shown on the listing.</p>`
      : `<h1>That link has expired</h1><p>Confirmation links last 48 hours and work once. Set the address again from the <a href="/b/${p(domain)}/edit">edit page</a>.</p>`,
  })
}

export function listingsIndexPage(): string {
  return docPage({
    title: 'Business listings anyone can claim · pit.world',
    description: 'A business listing like Google’s, without the tracking. Claim yours with a DNS record or a homepage tag: no account, no fee.',
    path: '/b',
    body: `<p class="kicker">Business listings</p>
<h1>Claim your business on pit.world</h1>
<p class="lede">Every website gets a listing on pit.world. Claim yours to write it yourself: what you do, who runs it, where you work, services, hours, phone, links, and your Moshpit name. When someone searches your domain, your listing shows beside the results, and claimed listings are in the <a href="/pros">pro directory</a> and the <a href="/ring">pit.world ring</a>.</p>
<form class="listing-lookup" action="/b" method="get">
  <input name="domain" placeholder="yourbusiness.com" aria-label="Your domain" required maxlength="253">
  <button class="btn" type="submit">Find my listing</button>
</form>
<h2>How claiming works</h2>
<ol>
<li>Find your listing by domain and press <b>Claim this listing</b>.</li>
<li>Add a DNS TXT record, or a meta tag on your homepage, with the code pit.world gives you.</li>
<li>Press <b>Verify</b>. You get an edit key, shown once. No account, no password reset, no email.</li>
</ol>
<p>Like everything on pit.world: no cookies, no tracking. From the terminal: <code>pit claim yourbusiness.com</code>. New claims as a feed: <a href="/b/feed.xml">/b/feed.xml</a>.</p>`,
  })
}

export function prosPage(options: { listings: Listing[]; total: number; category: string; near: string; q: string; page: number; perPage: number; counts: Record<string, number> }): string {
  const cat = categoryOf(options.category)
  const heading = cat ? cat.label : 'Find a pro'
  const qs = (page: number) => {
    const params = new URLSearchParams()
    if (options.q) params.set('q', options.q)
    if (options.near) params.set('near', options.near)
    if (page > 1) params.set('page', String(page))
    const s = params.toString()
    return `${cat ? `/pros/${p(cat.slug)}` : '/pros'}${s ? `?${s}` : ''}`
  }
  const cards = options.listings
    .map((l) => {
      const where = [l.area, place(l)].filter(Boolean).join(' · ')
      return `<li class="pro">
  <h3><a href="/b/${p(l.domain)}">${esc(l.name || l.domain)}</a> ${l.claimed ? '<span class="verified" title="Verified owner">✓</span>' : '<span class="small">unclaimed</span>'}</h3>
  <p class="small">${[l.category ? esc(categoryOf(l.category)?.label ?? '') : '', where ? esc(where) : '', l.price ? esc(priceLabel(l.price)) : ''].filter(Boolean).join(' · ') || esc(l.domain)}</p>
  ${l.description ? `<p>${esc(l.description.length > 220 ? `${l.description.slice(0, 217)}…` : l.description)}</p>` : ''}
  ${l.services.length ? `<p class="small">${esc(l.services.slice(0, 5).join(' · '))}</p>` : ''}
  ${l.license ? `<p class="small">${esc(l.license)}</p>` : ''}
  <p class="row"><a href="/b/${p(l.domain)}">Listing →</a>${l.quotes ? ` <a href="/b/${p(l.domain)}#quote">Request a quote</a>` : ''}${l.seeded ? ` <a href="/b/${p(l.domain)}#claim">Yours? Claim it</a>` : ''}</p>
</li>`
    })
    .join('')
  const pages = Math.ceil(options.total / options.perPage)
  const nav = pages > 1 ? `<p class="row">${options.page > 1 ? `<a href="${esc(qs(options.page - 1))}">← Newer</a>` : ''} <span class="small">Page ${options.page} of ${pages}</span> ${options.page < pages ? `<a href="${esc(qs(options.page + 1))}">More →</a>` : ''}</p>` : ''
  const chips = CATEGORIES.map((c) => `<a class="chip${cat?.slug === c.slug ? ' on' : ''}" href="/pros/${p(c.slug)}" title="${esc(c.examples)}">${esc(c.label)}${options.counts[c.slug] ? ` <span>${options.counts[c.slug]}</span>` : ''}</a>`).join('')
  return docPage({
    title: `${heading}${options.near ? ` near ${options.near}` : ''} · pit.world pros`,
    description: cat ? `${cat.label} (${cat.examples}) on pit.world. No paid placement, no fake reviews.` : 'A directory of businesses and pros: verified owners and licensed businesses waiting to claim. No paid placement, no fake reviews, no tracking.',
    path: cat ? `/pros/${p(cat.slug)}` : '/pros',
    noindex: Boolean(options.q || options.near || options.page > 1),
    body: `<p class="kicker">Pro directory</p>
<h1>${esc(heading)}</h1>
<p class="lede">Businesses and independent pros. A <span class="verified">✓</span> means the owner proved they run the site and wrote the listing; <i>unclaimed</i> ones were listed by pit.world from public records (a state license, the business's own website) and are waiting for their owner. Nobody pays to be placed higher and there are no star ratings to buy: a few listings pit.world features come first, then verified owners by latest edit. Get in touch with a person, not a lead broker.</p>
<form class="listing-lookup" action="${cat ? `/pros/${p(cat.slug)}` : '/pros'}" method="get">
  <input name="q" value="${esc(options.q)}" placeholder="What do you need? (plumber, tax prep, web app)" aria-label="What you need" maxlength="120">
  <input name="near" value="${esc(options.near)}" placeholder="Where? (city, region or country)" aria-label="Where" maxlength="120">
  <button class="btn" type="submit">Search</button>
</form>
<nav class="chips" aria-label="Categories"><a class="chip${cat ? '' : ' on'}" href="/pros">All</a>${chips}</nav>
<p class="small">${options.total} listing${options.total === 1 ? '' : 's'}${cat ? ` in ${esc(cat.label)}` : ''}${options.near ? ` near ${esc(options.near)}` : ''}${options.q ? ` for “${esc(options.q)}”` : ''}.</p>
${cards ? `<ul class="pros">${cards}</ul>` : `<p>Nobody here yet. Run a business${cat ? ` in ${esc(cat.label.toLowerCase())}` : ''}? <a href="/b">Claim your listing</a>: it is free, and it puts you here.</p>`}
${nav}
<p class="small">Are you a pro? <a href="/b">Claim your listing</a> with a DNS record or a homepage tag. API: <code>GET https://pit.world/api/pros?c=legal&amp;near=oakland</code> · CLI: <code>pit pros --category legal --near oakland</code>.</p>`,
  })
}

/** An Atom feed of claimed listings, newest claim or edit first: new on pit.world. */
export function listingsFeed(listings: Listing[]): string {
  const x = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const updated = new Date(Math.max(0, ...listings.map((l) => l.updatedAt ?? 0)) || Date.now()).toISOString()
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>pit.world listings</title>
<subtitle>Businesses and sites claimed on pit.world by their owners.</subtitle>
<link href="https://pit.world/b/feed.xml" rel="self"/>
<link href="https://pit.world/ring" rel="alternate"/>
<id>https://pit.world/b/feed.xml</id>
<updated>${updated}</updated>
${listings
  .map(
    (l) => `<entry>
<title>${x(l.name || l.domain)}</title>
<link href="https://pit.world/b/${p(l.domain)}"/>
<id>https://pit.world/b/${p(l.domain)}</id>
<updated>${new Date(l.updatedAt ?? 0).toISOString()}</updated>
<summary>${x([l.description, l.category ? categoryOf(l.category)?.label : '', place(l)].filter(Boolean).join(' · '))}</summary>
</entry>`,
  )
  .join('\n')}
</feed>
`
}
