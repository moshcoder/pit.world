/** Pages for business listings (/b). Every value is escaped; links carry no referrer. */
import { docPage, esc } from './html.js'
import type { ClaimStart, Listing } from './listings.js'

const p = (s: string) => encodeURIComponent(s)

function details(l: Listing): string {
  const rows = [
    l.hours && `<li><b>Hours</b> ${esc(l.hours)}</li>`,
    l.address && `<li><b>Address</b> ${esc(l.address)}</li>`,
    l.phone && `<li><b>Phone</b> <a href="tel:${esc(l.phone.replace(/[^\d+]/g, ''))}">${esc(l.phone)}</a></li>`,
    l.moshpit && `<li><b>On Moshpit</b> <a href="https://${esc(l.moshpit)}/" rel="noreferrer noopener">${esc(l.moshpit)}</a></li>`,
    ...l.links.map((u) => `<li><a href="${esc(u)}" rel="noreferrer noopener">${esc(u.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a></li>`),
  ].filter(Boolean)
  return rows.length ? `<ul class="facts">${rows.join('')}</ul>` : ''
}

/** The card beside search results, for claimed listings only. */
export function listingCard(l: Listing): string {
  return `<aside class="card listing">
  <p class="kicker">Business listing · <span class="verified">✓ verified owner</span></p>
  <h2><a href="/b/${p(l.domain)}">${esc(l.name || l.domain)}</a></h2>
  ${l.description ? `<p>${esc(l.description)}</p>` : ''}
  ${details(l)}
  <p class="row"><a class="btn" href="https://${esc(l.domain)}/" rel="noreferrer noopener">Visit ${esc(l.domain)}</a> <a href="/b/${p(l.domain)}">Full listing →</a></p>
</aside>`
}

export function listingPage(l: Listing): string {
  const title = l.name || l.domain
  const claim = l.claimed
    ? `<p class="small">Claimed by the owner of ${esc(l.domain)}. <a href="/b/${p(l.domain)}/edit">Owner? Edit this listing</a></p>`
    : `<section class="claim">
  <h2>Is this your business?</h2>
  <p>Claim the listing to write it yourself: what you do, hours, address, phone, links and your Moshpit name. You prove you run ${esc(l.domain)} with a DNS record or a tag on your homepage. No account, no fee.</p>
  <form action="/b/${p(l.domain)}/claim" method="post"><button class="btn" type="submit">Claim this listing</button></form>
</section>`
  return docPage({
    title: `${title} · pit.world`,
    description: l.description || `${l.domain} on pit.world`,
    path: `/b/${p(l.domain)}`,
    noindex: !l.claimed,
    body: `<p class="kicker">Business listing${l.claimed ? ' · <span class="verified">✓ verified owner</span>' : ' · unclaimed'}</p>
<h1>${esc(title)}</h1>
<p><a href="https://${esc(l.domain)}/" rel="noreferrer noopener">${esc(l.domain)}</a></p>
${l.description ? `<p class="lede">${esc(l.description)}</p>` : l.claimed ? '' : '<p class="small">Nothing here yet beyond the name.</p>'}
${details(l)}
${l.claimed ? '' : `<p class="small">Until it is claimed, this listing shows what ${esc(l.domain)}'s own homepage says about itself.</p>`}
${claim}`,
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

export function verifiedPage(domain: string, editKey: string, method: 'dns' | 'meta'): string {
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
<p><a class="btn" href="/b/${p(domain)}/edit">Write your listing →</a></p>`,
  })
}

export function editPage(l: Listing, message = ''): string {
  const field = (name: string, label: string, value: string, max: number, long = false) =>
    `<label for="${name}">${label}</label>${long ? `<textarea id="${name}" name="${name}" maxlength="${max}" rows="4">${esc(value)}</textarea>` : `<input id="${name}" name="${name}" value="${esc(value)}" maxlength="${max}">`}`
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
  ${field('hours', 'Hours', l.hours, 200)}
  ${field('address', 'Address', l.address, 200)}
  ${field('phone', 'Phone', l.phone, 40)}
  ${field('links', 'Links (one per line, up to 5)', l.links.join('\n'), 1600, true)}
  ${field('moshpit', 'Moshpit name (e.g. acme.bakery)', l.moshpit, 253)}
  <button class="btn" type="submit">Save</button>
</form>`,
  })
}

export function listingsIndexPage(): string {
  return docPage({
    title: 'Business listings anyone can claim · pit.world',
    description: 'A business listing like Google’s, without the tracking. Claim yours with a DNS record or a homepage tag: no account, no fee.',
    path: '/b',
    body: `<p class="kicker">Business listings</p>
<h1>Claim your business on pit.world</h1>
<p class="lede">Every website gets a listing on pit.world. Claim yours to write it yourself: what you do, hours, address, phone, links, and your Moshpit name. When someone searches your domain, your listing shows beside the results.</p>
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
<p>Like everything on pit.world: no cookies, no tracking. From the terminal: <code>pit claim yourbusiness.com</code>.</p>`,
  })
}
