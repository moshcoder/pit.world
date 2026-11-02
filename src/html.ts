/**
 * Server-rendered pages. Every page works with JavaScript off (Tor Browser on
 * "Safest" included); /app.js only adds keyboard shortcuts.
 */
import type { Listing } from './listings.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { BANGS } from './bangs.js'
import type { CrawlStatus } from './crawl-status.js'
import { KIND_LABELS, type SubmitKind, SUBMIT_MAX } from './submit-kinds.js'
import { LINKS, MOSHPIT_ROOT_SHA256, type NetworkStats, type Resolution } from './moshpit.js'
import type { Promo } from './promoted.js'
import { ringFooter, ringFooterCssUrl, ringFooterOptions, setRingFooterOptions } from './ring-footer.js'
import { proxyUrl, ringBar, ringSites, RSS_RING, siteHref, type RingSite } from './ring.js'
import { LABELS, type Provider, type SearchResult } from './search.js'
import { MEDIA_SOURCES, thumbSrc, VERTICALS, type Media, type MediaResult, type Vertical } from './verticals.js'
import { voteBox, type VoteView } from './vote-html.js'

export const SITE = 'https://pit.world'

const listFormat = new Intl.ListFormat('en', { type: 'conjunction' })

// Each asset URL carries a hash of its content, so a deploy that changes the CSS or
// JS reaches returning visitors on their next page load instead of an hour later
// (browser cache) or never (the service worker keeps whatever it stored first).
const asset = (name: string) => {
  const body = readFileSync(new URL(`../public/${name}`, import.meta.url))
  return `/${name}?v=${createHash('sha256').update(body).digest('hex').slice(0, 10)}`
}
// The footer's own links; the ring nav and copyright come from @profullstack/footer.
// Its house links already carry "Find a pro" (pit.world/pro) and Profullstack's
// "Privacy", so ours must not repeat those labels.
setRingFooterOptions(
  ringFooterOptions([
    { label: 'Account', href: '/account' },
    { label: 'Search privacy', href: '/privacy' },
    { label: 'Connect to Moshpit', href: '/connect' },
    { label: 'Start building', href: '/start' },
    { label: 'Build an app', href: '/build' },
    { label: 'Promoter program', href: '/promote' },
    { label: 'Claim your listing', href: '/b' },
    { label: 'How it works', href: '/about' },
    { label: 'API · CLI · MCP', href: '/about#api' },
    { label: 'Web ring', href: '/ring' },
    { label: 'Submit your site', href: '/submit' },
    { label: 'Crawler status', href: '/status' },
    { label: 'pitbot crawler', href: '/bot' },
    { label: 'Moshpit registry', href: LINKS.registry },
  ]),
)

const STYLE_URL = asset('style.css')
const APP_URL = asset('app.js')

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)

const fmt = (n: number) => n.toLocaleString('en-US')

/**
 * crawlproof analytics and ads, on pit.world's own pages only: the *.pit.world relay
 * (proxy.ts) serves other people's sites and never gets either. Analytics never runs on
 * search results, whose URL is the query. The ad does (one line after the third result,
 * Anthony 2026-10-29), because it is a cross-origin sandboxed iframe sent with an
 * origin-only referrer: the ad sees pit.world's origin and nothing else, never the query.
 * CRAWLPROOF_AD_SLOT=off turns ads off.
 */
const TRACKER_SITE = '81a8a3cd-8d5b-4c5f-bb29-c21a1bbb6a05'
export const AD_SLOT = process.env.CRAWLPROOF_AD_SLOT ?? '782907b4-bf27-44bf-b202-df196c4b207e'
/**
 * Sponsored listings at the top of results (Anthony 2026-11-02: "we need more sponsored
 * listings (ie: our ads network) at top of page"): CRAWLPROOF_TOP_ADS text_link units,
 * default 3, 0 for none. Each is its own sandboxed frame, so each is its own auction (on
 * 2026-11-02 thirty fills of this slot came from 29 campaigns, so three rarely repeat),
 * and like the line below, none of them is told the query. Never on the home page.
 */
export const TOP_ADS = Math.max(0, Math.min(6, Number(process.env.CRAWLPROOF_TOP_ADS ?? 3) || 0))
const adFrame = (pos: number) =>
  `<iframe src="https://crawlproof.com/api/ads/frame?slot=${encodeURIComponent(AD_SLOT)}&amp;format=text_link&amp;pos=${pos}" title="Sponsored listing ${pos}" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" scrolling="no"></iframe>`
// Votes on a sponsored slot are cast from pit.world's side of the frame (the ad itself is
// cross-origin and sandboxed): they record how useful that slot's ads are on that page type,
// a quality signal kept for later. Paid slots are never reordered by votes.
const slotVote = (page: string | undefined, slot: string, view: VoteView | undefined) =>
  page ? voteBox('ad', `${page}:${slot}`, view, 'this sponsored listing') : ''
export const sponsoredTop = (page?: string, view?: VoteView) =>
  AD_SLOT === 'off' || TOP_ADS === 0
    ? ''
    : `<section class="sponsored-top" aria-label="Sponsored"><p class="sponsored-label">Sponsored</p>${Array.from({ length: TOP_ADS }, (_, i) => (page ? `<div class="ad-slot">${adFrame(i + 1)}${slotVote(page, `top-${i + 1}`, view)}</div>` : adFrame(i + 1))).join('')}</section>`
/** One low-profile text_link line; never on the home page, never against the footer. */
export const adUnit = (page?: string, view?: VoteView) =>
  AD_SLOT === 'off' ? '' : `<div class="ad-unit${page ? ' ad-slot' : ''}"><iframe src="https://crawlproof.com/api/ads/frame?slot=${encodeURIComponent(AD_SLOT)}&amp;format=text_link" title="Advertisement" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" scrolling="no"></iframe>${slotVote(page, 'inline', view)}</div>`

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

// A wink: nobody's watching, and we're in on it.
const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 18.5c2.5 5.5 11.5 5.5 14 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M9 12.6h5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="20.5" cy="12.5" r="2.2" fill="currentColor"/></svg>`

function layout(options: { title: string; description: string; path: string; body: string; bodyClass?: string; noindex?: boolean; track?: boolean; head?: string }): string {
  const url = `${SITE}${options.path}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(options.title)}</title>
<meta name="description" content="${esc(options.description)}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#050505">
${options.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(url)}">`}
<meta property="og:type" content="website">
<meta property="og:site_name" content="pit.world">
<meta property="og:title" content="${esc(options.title)}">
<meta property="og:description" content="${esc(options.description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="pit.world">
<meta name="pwamart-verification" content="19278327af99806655813c4a">
<link rel="search" type="application/opensearchdescription+xml" title="pit.world" href="/opensearch.xml">
<link rel="alternate" type="application/atom+xml" title="New on pit.world" href="/b/feed.xml">
${options.head ?? ''}<link rel="stylesheet" href="${ringFooterCssUrl()}">
<link rel="stylesheet" href="${STYLE_URL}">
<script src="${APP_URL}" defer></script>
${options.track === false ? '' : `<script data-site="${TRACKER_SITE}" src="https://crawlproof.com/stats.js" async></script>`}
</head>
<body class="${options.bodyClass ?? ''}">
${ringBar('pit.world', false)}
${options.body}
${ringFooter()}
</body>
</html>`
}

function searchForm(query = '', autofocus = false, vertical: Vertical = 'web'): string {
  return `<form class="search" action="/search" method="get" role="search">
  <input name="q" type="search" value="${esc(query)}" placeholder="Search privately, or try chovy.hacker" aria-label="Search" autocomplete="off" spellcheck="false"${autofocus ? ' autofocus' : ''} maxlength="512" required>${vertical === 'web' ? '' : `\n  <input type="hidden" name="t" value="${vertical}">`}
  <button type="submit" aria-label="Search">Search</button>
</form>`
}

function networkPanel(stats: NetworkStats | null): string {
  const numbers = stats
    ? `<div class="stats">
    <div><b>${fmt(stats.endings)}</b><span>endings claimed</span></div>
    <div><b>${fmt(stats.events)}</b><span>registry events, all public</span></div>
    <div><b>$0</b><span>to search, forever</span></div>
  </div>`
    : ''
  const recent = stats?.recent.length
    ? `<h3>Just claimed</h3><ul class="chips">${stats.recent
        .map((e) => `<li><a href="${LINKS.registry}/n/${esc(e.tld)}">.${esc(e.tld)}</a><small>${esc(ago(e.at))}</small></li>`)
        .join('')}</ul>`
    : ''
  const sale = stats?.forSale.length
    ? `<h3>Endings for sale right now</h3><ul class="chips">${stats.forSale
        .map((t) => `<li><a href="${LINKS.claim}">.${esc(t.tld)}</a><small>$${esc(t.price)}</small></li>`)
        .join('')}</ul>`
    : ''
  return `<section id="moshpit" class="network">
  <p class="kicker">The Moshpit network</p>
  <h2>The internet ICANN didn't sell you.</h2>
  <p class="lede">Moshpit is a namespace that lives beside the old one. Anyone can claim an ending like <code>.hacker</code>, <code>.eggs</code> or <code>.pit</code>, put names under it, and point them anywhere. The registry is open and append-only, its log is public, and it signs real certificates, so <code>https://chovy.hacker</code> is a working site for everyone on the network. pit.world searches both worlds.</p>
  ${numbers}
  <div class="steps">
    <div><span>1</span><h4>Get on the network</h4><pre><code>${esc(LINKS.install)}
${esc(LINKS.enable)}</code></pre><p>Or point your browser's secure DNS at <code>${esc(LINKS.doh)}</code>, no install at all.</p><p><a class="btn" href="/connect">Step by step, for every device →</a></p></div>
    <div><span>2</span><h4>Claim an ending</h4><p>Pick one nobody has, and it is yours: every name under it, forever, in a log anyone can audit.</p><p><a class="btn" href="${LINKS.claim}">Claim an ending →</a></p></div>
    <div><span>3</span><h4>Search it here</h4><p>Type a Moshpit name into pit.world and it resolves through the registry, next to your web results.</p></div>
  </div>
  ${recent}
  ${sale}
  <p class="links"><a href="${LINKS.registry}">Registry</a> · <a href="${LINKS.moshcode}">moshcode</a> · <a href="${LINKS.moshcoding}">moshcoding.com</a> · <a href="${LINKS.source}">Source</a></p>
</section>`
}

/** Where a signup came from, and where to send the reader back to. Both built from a normalized hostname. */
export type NewsletterOrigin = { source?: string | null; pit?: boolean }

export function newsletterForm(origin: NewsletterOrigin = {}): string {
  const pit = origin.pit ?? true
  const site = origin.source && origin.source !== 'pit.world' ? `\n    <input type="hidden" name="site" value="${esc(origin.source)}">` : ''
  const intro = pit
    ? `<p class="kicker">The pit.world newsletter</p>
  <h2>What's new on pit.world and the Moshpit network.</h2>
  <p class="lede">About once a month. You confirm by email before anything is sent, and every issue has a one-click unsubscribe. Your address is the only thing pit.world will ever keep, and only if you click the link.</p>`
    : `<p class="kicker">The Profullstack newsletter</p>
  <h2>What's new across the Profullstack sites.</h2>
  <p class="lede">About once a month. You confirm by email before anything is sent, and every issue has a one-click unsubscribe. We keep your address and the site you signed up on, nothing else.</p>`
  return `<section id="newsletter" class="newsletter">
  ${intro}
  <form class="subscribe" action="/subscribe" method="post">
    <input name="email" type="email" placeholder="you@example.com" aria-label="Email address" autocomplete="email" maxlength="254" required>${site}
    <input class="hp" name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">
    <button type="submit">Subscribe</button>
  </form>
</section>`
}

function businessDirectoryHome(businesses: Listing[], view?: VoteView): string {
  const cards = businesses.map(l => `<article class="business-preview${l.sponsoredUntil ? ' sponsored' : ''}">
    <p class="small">${l.sponsoredUntil ? 'Featured · Paid placement' : l.claimed ? 'Verified owner' : 'Listed by pit.world · Unclaimed'}</p>
    <h3><a href="/b/${encodeURIComponent(l.domain)}">${esc(l.name || l.domain)}</a></h3>
    <p class="small">${esc([l.category.replaceAll('-',' '),l.city,l.region].filter(Boolean).join(' · '))}</p>
    <p>${esc(l.description.slice(0,160))}${l.description.length > 160 ? '…' : ''}</p>
    <a href="/b/${encodeURIComponent(l.domain)}">View business →</a>${voteBox('listing', l.domain, view, l.name || l.domain)}</article>`).join('')
  return `<section class="home-businesses" aria-labelledby="businesses-title"><p class="kicker">The local business directory</p><div class="business-heading"><div><h2 id="businesses-title">Good businesses. Easy to find.</h2><p>Find builders, shops and independent pros by service and location.</p></div><a href="/pros">Browse all businesses →</a></div>
  <form class="business-search" action="/pros" method="get"><label>What do you need?<input name="q" maxlength="120" placeholder="Contractor, coffee, accountant…"></label><label>Where?<input name="near" maxlength="120" placeholder="City or region"></label><button class="btn">Find businesses</button></form>
  <div class="business-previews">${cards || '<p>Own a business? <a href="/b">Claim your free listing</a> and help people find you.</p>'}</div>
  <p class="business-offer"><span>Your searchable listing is free.</span> <a href="/featured">Get featured · $19/month through CoinPay →</a></p></section>`
}

export function homePage(stats: NetworkStats | null, options: { newsletter?: boolean; businesses?: Listing[]; votes?: VoteView } = {}): string {
  return layout({
    title: 'pit.world: private search, and the doorway to the Moshpit network',
    description: 'ICANN doesn\'t scale for the agentic web. Meet pit.world: search the web without being the product. No logs, no cookies, no profile, no JavaScript required. And search the Moshpit network, the namespace ICANN didn\'t sell you.',
    path: '/',
    bodyClass: 'home',
    body: `<main>
  <header class="hero">
    <a class="brand big" href="/">${LOGO}<span>pit<i>.</i>world</span></a>
    <p class="pitch">ICANN doesn't scale for the agentic web. <a href="#moshpit">Meet pit.world.</a></p>
    <p class="tag">Search like nobody's watching. Because nobody is.</p>
    ${searchForm('', true)}
    <ul class="promises">
      <li><b>No logs</b> of what you search</li>
      <li><b>No cookies</b> to search, ever</li>
      <li><b>No profile</b> to sell</li>
      <li><b>No JavaScript</b> required</li>
    </ul>
    <p class="default"><a href="/about#default">Make pit.world your default search →</a></p>
    <p class="default"><a href="/connect">Connect to the Moshpit network →</a></p>
    <p class="default"><a href="/build">Build an app: $49, then $2 a month →</a></p>
  </header>
  ${businessDirectoryHome(options.businesses ?? [], options.votes)}
  ${networkPanel(stats)}
  ${options.newsletter ? newsletterForm() : ''}
</main>`,
  })
}

function moshpitCard(resolution: Resolution): string {
  const live = resolution.nameRegistered
  // A name with a server opens for everyone through our relay (<name>.pit.world): that is the link we lead with,
  // because most people searching have no Moshpit DNS. The bare name is for those who do.
  const served = live && Boolean(resolution.target)
  const web = proxyUrl(resolution.name)
  return `<aside class="card mosh">
  <p class="kicker">Moshpit name</p>
  <h2><a href="${esc(served ? web : `https://${resolution.name}/`)}" rel="noreferrer noopener">${esc(resolution.name)}</a></h2>
  ${served ? `<p class="url"><a href="${esc(web)}" rel="noreferrer noopener">${esc(web.replace(/\/$/, ''))}</a></p>` : ''}
  <p>${live ? `Registered on the Moshpit network${resolution.target ? `, pointing at <code>${esc(resolution.target)}</code>` : ''}.${served ? ' Opens in any browser through pit.world, no setup needed.' : ''}` : 'Not registered yet: it could be yours.'}</p>
  <p class="row">${served ? `<a class="btn" href="${esc(web)}" rel="noreferrer noopener">Open ${esc(resolution.name)}</a> <a href="https://${esc(resolution.name)}/" rel="noreferrer noopener">On Moshpit DNS</a> · ` : ''}<a${served ? '' : ' class="btn"'} href="${esc(resolution.page)}">${live ? 'Registry page' : 'Claim it'}</a>
  <a href="/connect">How to open Moshpit names →</a></p>
</aside>`
}

/** All · Images · Videos · Music · Live · Shopping · News · Books · Podcasts · Blogs · Places · Scholar: the same query in another index. */
function tabs(query: string, active: Vertical): string {
  return `<nav class="tabs" aria-label="Search type">${VERTICALS.map((v) => {
    const href = `/search?q=${encodeURIComponent(query)}${v.id === 'web' ? '' : `&t=${v.id}`}`
    return v.id === active ? `<a href="${href}" aria-current="page">${v.label}</a>` : `<a href="${href}">${v.label}</a>`
  }).join('')}</nav>`
}

/** Our own ring sites a search is about, above every outside result (featured.ts). */
function featuredBox(sites: RingSite[] | undefined, view?: VoteView): string {
  if (!sites?.length) return ''
  return `<section class="promo featured" aria-label="Featured on pit.world">
  <p class="kicker">Featured on pit.world</p>
  <ul>${sites
    .map(
      (s) => `<li>
    <a href="${esc(siteHref(s, false))}"><span class="from">${esc(s.name.replace(/\.pit\.world$/, ''))}</span><b>${esc(s.about.split(/(?<=[.:!?])\s/)[0]!.replace(/[.:]$/, ''))}</b><small>${esc(s.about)}</small></a>
    ${voteBox('featured', featuredTarget(s), view, s.name)}
  </li>`,
    )
    .join('')}</ul>
</section>`
}

/** The host a featured ring site is voted under. */
export const featuredTarget = (s: RingSite) => new URL(siteHref(s, false)).hostname

/** PairUX channels and nixamp streams, ours, ahead of everything else. */
function promoStrip(promos: Promo[], vertical: Vertical, view?: VoteView): string {
  if (!promos.length) return ''
  const label = vertical === 'live' ? 'Live on PairUX and nixamp' : vertical === 'music' ? 'Listen on nixamp' : 'Watch on PairUX and nixamp'
  return `<section class="promo" aria-label="${label}">
  <p class="kicker">${label}</p>
  <ul>${promos
    .map(
      (p) => `<li${p.live ? ' class="live"' : ''}>
    <a href="${esc(p.url)}" rel="noreferrer noopener"><span class="from">${p.source === 'pairux' ? 'PairUX' : 'nixamp'}</span>${p.live ? '<span class="dot">LIVE</span>' : ''}<b>${esc(p.title)}</b>${p.line ? `<small>${esc(p.line)}</small>` : ''}</a>
    ${voteBox('promo', p.url, view, p.title)}
  </li>`,
    )
    .join('')}</ul>
</section>`
}

function thumb(m: Media, cls = 'thumb'): string {
  const src = thumbSrc(m.thumbnail)
  return src ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : `<span class="${cls} none" aria-hidden="true"></span>`
}

/** "★ 4.6 (1,234)", or nothing. */
function stars(m: Media): string {
  if (m.rating === undefined) return ''
  return `★ ${m.rating.toFixed(1)}${m.reviews ? ` (${m.reviews.toLocaleString('en-US')})` : ''}`
}

/** The small line under a title: where it is from and the facts that tell results apart. */
function metaLine(m: Media): string {
  return esc([m.host, m.channel, m.author, m.address, m.date, m.extra, stars(m)].filter(Boolean).join(' · '))
}

function mediaList(vertical: Exclude<Vertical, 'web'>, hits: Media[], view?: VoteView): string {
  const vote = (m: Media) => voteBox('result', m.url, view, m.title)
  if (vertical === 'images') {
    return `<ul class="images">${hits
      .map((m) => `<li><a href="${esc(m.url)}" rel="noreferrer noopener" title="${esc(m.title)}">${thumb(m)}<span>${esc(m.host)}</span></a>${vote(m)}</li>`)
      .join('')}</ul>`
  }
  if (vertical === 'shopping') {
    return `<ul class="shop">${hits
      .map(
        (m) => `<li><a href="${esc(m.url)}" rel="noreferrer noopener">${thumb(m)}<b>${esc(m.title)}</b>${m.price ? `<span class="price">${esc(m.price)}</span>` : ''}<small>${esc([m.host, stars(m)].filter(Boolean).join(' · '))}</small></a>${vote(m)}</li>`,
      )
      .join('')}</ul>`
  }
  if (vertical === 'books') {
    return `<ol class="books">${hits
      .map(
        (m) => `<li><a href="${esc(m.url)}" rel="noreferrer noopener">${thumb(m)}</a>
    <div><a class="title" href="${esc(m.url)}" rel="noreferrer noopener">${esc(m.title)}</a>
    <div class="url">${esc([m.author, m.date, m.extra].filter(Boolean).join(' · '))}</div>${vote(m)}</div></li>`,
      )
      .join('')}</ol>`
  }
  if (vertical !== 'videos' && vertical !== 'live' && vertical !== 'news') {
    // Music, podcasts, blogs, places, scholar: words, no pictures.
    return `<ol class="hits">${hits
      .map(
        (m) => `<li>
      <a class="title" href="${esc(m.url)}" rel="noreferrer noopener">${esc(m.title)}</a>
      <div class="url">${metaLine(m)}</div>
      ${m.description ? `<p>${esc(m.description)}</p>` : ''}
      ${vote(m)}
    </li>`,
      )
      .join('')}</ol>`
  }
  return `<ol class="videos">${hits
    .map(
      (m) => `<li><a href="${esc(m.url)}" rel="noreferrer noopener">${thumb(m)}${m.duration ? `<span class="dur">${esc(m.duration)}</span>` : ''}</a>
    <div><a class="title" href="${esc(m.url)}" rel="noreferrer noopener">${esc(m.title)}</a>
    <div class="url">${esc([m.host, m.channel, m.date].filter(Boolean).join(' · '))}</div>
    ${m.description ? `<p>${esc(m.description)}</p>` : ''}${vote(m)}</div></li>`,
    )
    .join('')}</ol>`
}

/** Blogs: the blogs that write about the search, on rssamplifier.com, above their posts. */
function blogSites(sites: Media[] | undefined, view?: VoteView): string {
  if (!sites?.length) return ''
  return `<section class="promo" aria-label="Blogs on RSS Amplifier">
  <p class="kicker">Blogs on RSS Amplifier</p>
  <ul>${sites
    .map(
      (s) => `<li>
    <a href="${esc(s.url)}" rel="noreferrer noopener"><span class="from">rssamplifier</span><b>${esc(s.title)}</b>${s.description ? `<small class="clamp">${esc(s.description)}</small>` : ''}</a>
    ${voteBox('blog', s.url, view, s.title)}
  </li>`,
    )
    .join('')}</ul>
</section>`
}

/** Says who answered, and that they never saw the visitor. */
function viaLine(label: string, result: MediaResult): string {
  const from = `${label} from ${MEDIA_SOURCES[result.provider]}, fetched by pit.world`
  switch (result.provider) {
    case 'serper':
      return `${from}. Thumbnails are loaded through pit.world too, so Google and YouTube never see your IP address, browser or cookies.`
    case 'openlibrary':
      return `${from}. Covers are loaded through pit.world too, so Open Library never sees your IP address, browser or cookies.`
    default:
      return `${from}, so the directory sees our server and the words, never your IP address, browser or cookies.`
  }
}

export function mediaPage(options: { query: string; vertical: Exclude<Vertical, 'web'>; result: MediaResult | null; promos: Promo[]; error: string | null; featured?: RingSite[]; backfill?: RingSite; votes?: VoteView }): string {
  const { query, vertical, result, promos, error, votes: view } = options
  const hits = result?.hits ?? []
  const label = VERTICALS.find((v) => v.id === vertical)!.label
  const body = `<header class="bar">
  <a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>
  ${searchForm(query, false, vertical)}
</header>
${tabs(query, vertical)}
<main class="results ${vertical}" data-q="${esc(query)}">
  ${featuredBox(options.featured, view)}
  ${promoStrip(promos, vertical, view)}
  ${error ? `<p class="notice">${esc(error)}</p>` : ''}
  ${blogSites(result?.sites, view)}
  ${hits.length ? sponsoredTop(vertical, view) : ''}
  ${hits.length ? mediaList(vertical, hits, view) : ''}
  ${hits.length ? adUnit(vertical, view) : ''}
  ${featuredBox(options.backfill ? [options.backfill] : undefined, view)}
  ${!error && hits.length === 0 ? `<p class="notice">No ${label.toLowerCase()} found. Try other words.</p>` : ''}
  ${result ? `<p class="via">${viaLine(label, result)}</p>` : ''}
</main>`
  return layout({ title: `${query} · ${label} · pit.world`, description: `Private ${label.toLowerCase()} results for ${query}`, path: '/search', body, bodyClass: 'serp', noindex: true, track: false })
}

/** Web results before the one ad line: in the content, never at the top, never by the footer. */
const AD_AFTER = 3

function hitItem(h: SearchResult['hits'][number], summaries = false, view?: VoteView): string {
  // Summarize: hidden until app.js shows it (it needs script), and only when the server has c0mpute.
  const summarize = summaries
    ? `<div class="summary-row"><button type="button" class="summarize" data-url="${esc(h.url)}" hidden>Summarize</button><p class="summary" hidden aria-live="polite"></p></div>`
    : ''
  return `<li${h.featured ? ' class="featured-hit"' : ''}>
      <a class="title" href="${esc(h.url)}" rel="noreferrer noopener">${esc(h.title)}</a>
      <div class="url">${esc(h.host)}${h.featured ? '<span class="src featured" title="A W3BS network site, featured on pit.world. Not an ad.">Featured</span>' : ''}${(h.sources ?? []).map((src) => `<span class="src">${esc(LABELS[src] ?? src)}</span>`).join('')}</div>
      ${h.description ? `<p>${esc(h.description)}</p>` : ''}
      ${summarize}
      ${voteBox('result', h.url, view, h.title)}
    </li>`
}

export function resultsPage(options: { query: string; result: SearchResult | null; resolution: Resolution | null; error: string | null; card?: string; featured?: RingSite[]; backfill?: RingSite; summaries?: boolean; votes?: VoteView }): string {
  const { query, result, resolution, error, votes: view } = options
  const item = (h: SearchResult['hits'][number]) => hitItem(h, options.summaries, view)
  const hits = result?.hits ?? []
  const domain = !resolution?.registered && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(query) ? query.toLowerCase() : null
  const body = `<header class="bar">
  <a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>
  ${searchForm(query)}
</header>
${tabs(query, 'web')}
<main class="results" data-q="${esc(query)}">
  ${resolution?.registered ? moshpitCard(resolution) : ''}
  ${featuredBox(options.featured, view)}
  ${options.card ?? ''}
  ${domain ? `<p class="go">Go straight to <a href="https://${esc(domain)}/" rel="noreferrer noopener">${esc(domain)}</a>${options.card ? '' : ` · <a href="/b/${encodeURIComponent(domain)}">business listing</a>`}</p>` : ''}
  ${error ? `<p class="notice">${esc(error)}</p>` : ''}
  ${hits.length ? sponsoredTop('web', view) : ''}
  <ol class="hits">
    ${hits.slice(0, AD_AFTER).map(item).join('')}
  </ol>
  ${hits.length ? adUnit('web', view) : ''}
  ${hits.length > AD_AFTER ? `<ol class="hits" start="${AD_AFTER + 1}">${hits.slice(AD_AFTER).map(item).join('')}</ol>` : ''}
  ${featuredBox(options.backfill ? [options.backfill] : undefined, view)}
  ${!error && hits.length === 0 ? '<p class="notice">Nothing found. Try other words, or a bang like <code>!ddg</code>.</p>' : ''}
  <p class="elsewhere">Try this search on <a href="/search?q=${encodeURIComponent(`${query} !ddg`)}">DuckDuckGo</a>, <a href="/search?q=${encodeURIComponent(`${query} !b`)}">Brave</a> or <a href="/search?q=${encodeURIComponent(`${query} !g`)}">Google</a>, without a referrer.</p>
  ${result?.provider ? `<p class="via">Results from the ${listFormat.format(result.provider.split('+').map((p) => LABELS[p as Provider] ?? p))} ${result.provider.includes('+') ? 'indexes' : 'index'}, fetched by pit.world and merged. Your IP address, browser and cookies were not sent.</p>` : ''}
</main>`
  return layout({ title: `${query} · pit.world`, description: `Private search results for ${query}`, path: '/search', body, bodyClass: 'serp', noindex: true, track: false })
}

export function privacyPage(): string {
  return layout({
    title: 'Privacy · pit.world',
    description: 'What pit.world keeps about you: nothing that is yours.',
    path: '/privacy',
    bodyClass: 'doc',
    body: `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm()}</header>
<main class="prose">
<h1>Privacy, plainly</h1>
<p>pit.world is built so that there is nothing to hand over. Not a policy promise: the system has nowhere to put it.</p>
<h2>What we never keep</h2>
<ul>
<li><b>Your searches.</b> The web server does not write access logs for pit.world, and the application logs no queries.</li>
<li><b>Your IP address.</b> It is not stored anywhere. Rate limiting uses a keyed hash of it, held in memory, under a random key that is thrown away every hour, so the counters cannot be turned back into addresses or linked across hours.</li>
<li id="votes"><b>Votes, and forms you send.</b> Anonymous ▲ ▼ votes are tied to a salted, hashed fingerprint of your device (things like your screen size, graphics card, installed fonts, timezone and languages, hashed together with a secret key), used only to stop one device voting many times or flooding our forms. We never store the fingerprint itself, only that hash, and it is not linked to anything you search. A vote on a result also keeps a keyed hash of the search it was cast on, so the vote can nudge that search's order; the words themselves are not stored. Sign-ups, listing claims, quote requests, submissions and free result summaries sent with JavaScript on are limited by the same hash, held in memory and gone on restart; without JavaScript they are limited by address as above.</li>
<li><b>Cookies, to search.</b> Searching sets none and reads none. The only cookie pit.world ever sets is the sign-in one, and only after you press Sign in (below).</li>
<li><b>Your searches, to anyone else.</b> Search results pages load nothing from a third party.</li>
</ul>
<h2 id="analytics">Analytics and ads, outside search</h2>
<p>pit.world's other pages (this one, the home page, the docs) load <a href="https://crawlproof.com">crawlproof</a>'s page-view counter and show a crawlproof ad in a sandboxed frame. The counter reports the page address and keeps a random visitor id in your browser's local storage (not a cookie); it never runs on search results, so it never sees a query. Search results show crawlproof ads from our own ad network: a few sponsored listings at the top, marked Sponsored, and one line after the third result. Each is its own sandboxed frame and is told only that it is on pit.world, never what you searched for. Boxes marked "Featured on pit.world", and results with a Featured badge (sites on the W3BS network, listed at w3bs.org/net), are our own network, not ads, and nobody pays for them. Fonts and every other script still come from pit.world.</p>
<h2>What happens to a search</h2>
<ol>
<li>Your browser sends the words to pit.world over HTTPS.</li>
<li>pit.world asks several indexes at once (Google through Serper, Bing through DataForSEO, Brave, Tavily, Ceramic, Exa, Linkup, our own SearXNG, which asks Bing, Brave, Mojeek, Startpage and Yahoo, and <a href="/bot">our own index</a>, kept at nichedb.dev), takes the top results from each and merges them. Perplexity is asked only when all of those fail. The providers receive the words from our server: not your IP, browser, cookies or referrer.</li>
<li>The tabs above the results work the same way. Images, Videos, Live, Music, Shopping, News, Places and Scholar ask Google through Serper. When Google does not answer, Music asks the <a href="https://performance-partners.apple.com/search-api">iTunes Search API</a>, Places asks <a href="https://nominatim.openstreetmap.org/">OpenStreetMap's Nominatim</a> (© OpenStreetMap contributors), News asks our own <a href="https://rssamplifier.com/">rssamplifier.com</a> and the <a href="https://www.gdeltproject.org/">GDELT Project</a>, Images asks <a href="https://commons.wikimedia.org/">Wikimedia Commons</a>, Videos and Live ask PeerTube's <a href="https://sepiasearch.org/">Sepia Search</a> (Videos also the <a href="https://archive.org/">Internet Archive</a>), and Scholar asks <a href="https://openalex.org/">OpenAlex</a>; Books asks <a href="https://openlibrary.org/">Open Library</a>; Podcasts asks our own <a href="https://p0dcasters.com/">p0dcasters.com</a>; Blogs asks our own <a href="https://rssamplifier.com/">rssamplifier.com</a>. Pictures and book covers are fetched by pit.world and handed to you, so none of them sees your IP address either.</li>
<li>To avoid paying twice for a popular search, identical searches are answered from memory for up to ten minutes. That cache holds the words and the results, nothing about who asked, never touches disk, and empties on restart.</li>
<li>Result links go straight to the site, with no redirect through us and <code>no-referrer</code>, so the site does not learn what you searched for.</li>
<li><b>Summarize</b> under a result asks <a href="https://c0mpute.com/">c0mpute</a>, a peer network of inference nodes, for two or three sentences about that page. pit.world reads the page itself first, through <a href="https://tronbrowser.dev/">TronBrowser</a>'s page reader (the same one c0mpute's chat uses for web search), which is sent the page address only. The node is then sent the page's text and address only: never your search words, your IP address or your account. Summaries are kept by page address so the next person gets the same one instantly. Without an account you get a few an hour; signed in, more; with the <a href="/pass">$1 weekly pass</a>, up to 1,000 a week. The pass keeps only a count of summaries per account and time, never which pages.</li>
</ol>
<h2>Moshpit names</h2>
<p>When a search looks like a name (<code>chovy.hacker</code>), pit.world also asks the public Moshpit registry whether it exists. That lookup is the name only, from our server.</p>
<h2>Bangs</h2>
<p><code>!gh hqtui</code> sends you to GitHub's own search. From that moment you are on their site, under their privacy policy; pit.world only redirects you there without a referrer.</p>
<h2 id="newsletter">The newsletter, only if you ask</h2>
<p>The newsletter is the one thing pit.world keeps, and only after you ask twice. When you sign up, pit.world stores your address beside a fingerprint of a one-time link and emails you that link. Nothing else about you: no IP address, no browser, no referrer. Click it and your address joins the list; don't, and both are deleted within 48 hours. Issues are sent by our newsletter tool through our email provider, and every one has a one-click unsubscribe that takes you off for good.</p>
<h2 id="listings">Business listings: what we count</h2>
<p>For businesses pit.world is featuring in a promotion (like a local roundup), pit.world counts visits to their listing page, clicks on the link to their website, taps on their phone number and quote requests, so it can tell each business honestly what the listing did for them. Search is never counted. A visit is stored as a type, a time, the listing, which of our posts linked you there (if one did) and the site you came from (its name only, never the full address). To count distinct visitors in a day, pit.world keeps a hash of your IP address and browser under a random key that is deleted when that day ends: nothing that can be turned back into an address, and nothing that links two days. No cookie is set, and nothing from a third party is loaded. The phone-tap count comes from a few lines of pit.world's own script on the listing page.</p>
<h2 id="accounts">Your account, only if you sign in</h2>
<p>Business owners may buy featured placement for $19 per month. We keep the invoice email, listing domain, renewal preference, provider invoice identifiers and paid-through date for billing. CoinPay processes the payments through pay.agent. Paid listings are labeled; these billing records are not used to track searches.</p>
<p>One pit.world account signs you in on every <code>social.&lt;name&gt;.pit.world</code> feed and <code>bbs.&lt;name&gt;.pit.world</code> board, so you never make an account per site. You sign in with CoinPay (OAuth 2.1). We keep your CoinPay id, the name and email CoinPay gives us, a session cookie for <code>pit.world</code> only, and the list of pit.world sites you signed in to, which you can see and clear on <a href="/account">your account page</a>. A site gets your CoinPay id and name, nothing else. Search never reads the cookie. Delete the account from the same page and it is gone; what you posted on a board or feed stays there until you delete it on that site.</p>
<h2>Source</h2>
<p>The code that does all of this is public: <a href="https://github.com/moshcoder/pit.world">github.com/moshcoder/pit.world</a>.</p>
</main>`,
  })
}

/** pitbot's live status: is the crawler running, what is waiting, how fast it goes, what it just read. */
export function statusPage(st: CrawlStatus): string {
  const label: Record<string, string> = { healthy: 'Healthy', idle: 'Idle', degraded: 'Degraded', stalled: 'Stalled', offline: 'Offline' }
  const stat = (name: string, value: string, note: string) => `<div class="stat"><span class="stat-label">${esc(name)}</span><b>${esc(value)}</b><small>${esc(note)}</small></div>`
  const ago = (iso: string) => {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
  }
  const eta = (hours: number | null) => (hours === null ? '' : hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`)
  const max = Math.max(1, ...st.hourly.map((x) => x.pages + x.failed))
  const bars = st.hourly
    .map((x, i) => {
      const ok = Math.round((x.pages / max) * 60)
      const bad = Math.round((x.failed / max) * 60)
      return `<g><title>${esc(new Date(x.at).toISOString().slice(11, 16))} UTC: ${fmt(x.pages)} read, ${fmt(x.failed)} failed</title><rect class="bar-ok" x="${i * 10}" y="${64 - ok}" width="8" height="${ok}"/><rect class="bar-bad" x="${i * 10}" y="${64 - ok - bad}" width="8" height="${bad}"/></g>`
    })
    .join('')
  const chart = st.hourly.length
    ? `<figure class="crawl-chart"><svg viewBox="0 0 ${st.hourly.length * 10} 66" preserveAspectRatio="none" role="img" aria-label="Pages read per hour, last 24 hours">${bars}</svg><figcaption>Pages read per hour, last 24 hours (UTC). Failures stacked on top.</figcaption></figure>`
    : ''
  const jobs = st.jobs.length
    ? `<table class="crawl-jobs"><thead><tr><th>Job</th><th>State</th><th>Waiting</th><th>Last hour</th><th>Errors (1h)</th><th>Clears in</th></tr></thead><tbody>${st.jobs
        .map(
          (j) =>
            `<tr><td><b>${esc(j.label)}</b><br><small>${esc(j.what)}</small></td><td><span class="state state-${j.state}">${esc(j.state)}</span></td><td>${fmt(j.backlog)}</td><td>${fmt(j.ratePerHour)}</td><td>${fmt(j.errorsLastHour)}</td><td>${esc(eta(j.clearsInHours))}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : ''
  const log = st.log.length
    ? `<ol class="crawl-log">${st.log
        .map((e) => {
          const what = e.url
            ? `<a href="${esc(e.url)}" rel="noopener noreferrer nofollow">${esc(e.title || e.url)}</a>`
            : esc(e.site ?? '')
          const record = e.url && (e.kind === 'page' || e.kind === 'render') ? ` <a class="rec" href="https://nichedb.dev/c/sites/${esc(e.url.replace(/^https?:\/\//, ''))}" rel="noopener">record</a>` : ''
          return `<li class="ev-${esc(e.kind)}"><time datetime="${esc(e.at)}">${esc(e.at.slice(11, 19))}</time> <span class="kind">${esc(e.kind)}</span> ${e.url && e.site ? `<span class="site">${esc(e.site)}</span> ` : ''}${what}${record}${e.note ? ` <small>${esc(e.note)}</small>` : ''}</li>`
        })
        .join('')}</ol>`
    : '<p class="meta">Nothing logged yet.</p>'
  const set = st.settings
  return layout({
    title: 'Crawler status: pitbot',
    description: "Live status of pitbot, the crawler behind pit.world's own index: pages read in the last hour and day, what is waiting, and what it just read.",
    path: '/status',
    bodyClass: 'doc',
    head: '<meta http-equiv="refresh" content="15">',
    body: `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm()}</header>
<main class="prose crawl-status">
<h1>Crawler status</h1>
<p>Live view of <a href="/bot">pitbot</a>, the crawler that builds pit.world's own index: up to ${fmt(set?.maxPages ?? 1000)} pages per site, published as open records to <a href="https://nichedb.dev/c/sites">nichedb.dev/c/sites</a> and searched next to the other engines. This page refreshes every 15 seconds; the same numbers are at <a href="/api/status">/api/status</a>.</p>
<p class="crawl-health crawl-health-${st.health}"><strong>${label[st.health]}</strong> ${esc(st.summary)}</p>
${
  st.reachable
    ? `<div class="stat-grid">
${stat('Sites', fmt(st.totals.sites), 'known to the crawler')}
${stat('Pages read', fmt(st.totals.pagesIndexed), `${fmt(st.totals.pagesRendered)} through a browser`)}
${stat('Read (1h)', fmt(st.lastHour.pages), `${fmt(st.lastHour.rendered)} rendered`)}
${stat('Read (24h)', fmt(st.lastDay.pages), `${fmt(st.lastDay.sitesStarted)} sites started`)}
${stat('Searchable', fmt(st.totals.searchable), 'pages in the index pit.world searches')}
${stat('Images', fmt(st.totals.images), 'found on those pages, by reference')}
${stat('Videos', fmt(st.totals.videos), 'embedded or linked, by reference')}
${stat('Published', fmt(st.totals.published), `${fmt(st.lastHour.published)} in the last hour`)}
${stat('Waiting to publish', fmt(st.totals.outbox), set?.publishing ? 'records for nichedb' : 'publishing is off')}
${stat('Failed (24h)', fmt(st.lastDay.failed), `${fmt(st.totals.failed)} all time`)}
</div>
${chart}
<h2>Jobs</h2>
${jobs}
<h2>Live log</h2>
${log}
<p class="meta">${set ? `${fmt(set.concurrency)} pages at once per worker, ${fmt(set.hostDelayMs / 1000)} s between requests to one site, ${fmt(set.renderers)} browsers, ${fmt(set.maxDepth)} link hops, every site re-read each ${fmt(set.recrawlDays)} days${set.discover ? ', following links to new sites' : ''}. ` : ''}Generated ${esc(ago(st.generatedAt))}.</p>`
    : ''
}
</main>`,
  })
}

export type SubmitOutcome = {
  accepted: Array<{ url: string; kind: SubmitKind }>
  rejected: Array<{ url: string; error: string }>
  queued: number
  truncated: boolean
  error: string | null
}

const submitHeader = () => `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm()}</header>`

/** pit.world/submit: sites, pages, feeds, sitemaps and OPML into our own index, up to a thousand at once. */
export function submitPage(options: { error?: string } = {}): string {
  return layout({
    title: 'Submit your site to pit.world',
    description: "Add sites, pages, RSS feeds, sitemaps or an OPML file to pit.world's own search index: up to a thousand at once, free.",
    path: '/submit',
    bodyClass: 'doc',
    body: `${submitHeader()}
<main class="prose submit">
<h1>Submit your site</h1>
<p>Put your site in pit.world's own index, the one <a href="/bot">pitbot</a> builds and pit.world searches next to the other engines. Free, no account. Paste one address or up to ${fmt(SUBMIT_MAX)}, one per line, of any kind:</p>
<ul class="kinds">
<li><b>Site</b> <code>example.com</code>: its home page, robots.txt and sitemaps, then up to a thousand pages.</li>
<li><b>Page</b> <code>example.com/post/42</code>: read right away.</li>
<li><b>Feed</b> RSS, Atom or JSON Feed: every item is read, and the feed is listed on <a href="https://rssamplifier.com">RSS Amplifier</a> too.</li>
<li><b>Sitemap</b> <code>example.com/sitemap.xml</code>, or a sitemap index: every page it lists.</li>
<li><b>OPML</b>: every site behind every feed in it.</li>
</ul>
${options.error ? `<p class="notice">${esc(options.error)}</p>` : ''}
<form class="submit-form" method="post" action="/submit" enctype="multipart/form-data">
<label for="submit-input">Addresses, one per line</label>
<textarea id="submit-input" name="input" rows="12" spellcheck="false" autocomplete="off" placeholder="example.com
https://example.com/feed.xml
https://example.com/sitemap.xml
https://example.com/a-page"></textarea>
<label for="submit-file">Or a file: a list (.txt, .csv), an OPML file, or a sitemap you saved</label>
<input id="submit-file" name="file" type="file" accept=".txt,.csv,.opml,.xml,text/plain,text/x-opml,application/xml">
<button type="submit">Submit to the index</button>
</form>
<p class="meta">Everything is read in the crawler's queue: the list is answered at once, the reading takes minutes to hours, and <a href="/status">the crawler's status page</a> shows it working. pitbot obeys robots.txt; to keep a site out, see <a href="/bot">pitbot</a>. Submitting does not buy a ranking. To be on top, sponsored listings are sold through <a href="https://ad.network.pit.world">ad.network</a> and marked Sponsored.</p>
<h2 id="api">From a script or an agent</h2>
<pre><code>curl -X POST https://pit.world/api/submit -H 'content-type: application/json' \
  -d '{"urls": ["example.com", "https://example.com/feed.xml"]}'
pit submit example.com https://example.com/sitemap.xml</code></pre>
<p>The MCP server (<code>pit mcp</code>) has a <code>submit_urls</code> tool. The reply follows the shared submit contract: <code>accepted</code>, <code>rejected</code> with a reason each, <code>queued</code>.</p>
</main>`,
  })
}

export function submitResultPage(o: SubmitOutcome): string {
  const counts = new Map<SubmitKind, number>()
  for (const a of o.accepted) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1)
  const summary = [...counts.entries()].map(([k, n]) => `${fmt(n)} ${KIND_LABELS[k].toLowerCase()}${n === 1 ? '' : 's'}`).join(', ')
  const rows = o.accepted
    .slice(0, 200)
    .map((a) => `<tr><td><span class="kind kind-${a.kind}">${KIND_LABELS[a.kind]}</span></td><td>${esc(a.url)}</td></tr>`)
    .join('')
  const rejected = o.rejected
    .slice(0, 200)
    .map((r) => `<li><code>${esc(r.url)}</code> <small>${esc(explainSubmitError(r.error))}</small></li>`)
    .join('')
  return layout({
    title: 'Submitted · pit.world',
    description: 'Your addresses are in the crawl queue.',
    path: '/submit',
    bodyClass: 'doc',
    noindex: true,
    body: `${submitHeader()}
<main class="prose submit">
<h1>${o.error ? 'Not submitted' : 'Submitted'}</h1>
${
  o.error
    ? `<p class="notice">${esc(o.error)}</p>`
    : `<p class="crawl-health crawl-health-healthy"><strong>${fmt(o.queued)} queued.</strong> ${esc(summary)}${o.truncated ? `. Only the first ${fmt(SUBMIT_MAX)} were taken; send the rest as another list` : ''}.</p>
<p>The crawler reads each one, works out for certain what it is (a link that turns out to be a feed is treated as a feed), and queues its pages ahead of the backlog. Watch it on <a href="/status">the status page</a>; pages become searchable as they are read.</p>`
}
${rows ? `<table class="crawl-jobs submit-list"><thead><tr><th>Looks like</th><th>Address</th></tr></thead><tbody>${rows}</tbody></table>${o.accepted.length > 200 ? `<p class="meta">and ${fmt(o.accepted.length - 200)} more.</p>` : ''}` : ''}
${rejected ? `<h2>Not taken</h2><ul class="rejected">${rejected}</ul>` : ''}
<p><a href="/submit">Submit more</a></p>
</main>`,
  })
}

const SUBMIT_ERRORS: Record<string, string> = {
  'invalid-url': 'not a web address',
  'blocked-host': 'a private or internal address, which pitbot never reads',
}
const explainSubmitError = (code: string) => SUBMIT_ERRORS[code] ?? code

/** pitbot: who reads your site for pit.world's own index, and how to say no. */
export function botPage(): string {
  return layout({
    title: 'pitbot: the pit.world crawler',
    description: 'pitbot reads up to a thousand pages per site for pit.world\'s own search index. It obeys robots.txt, noindex and nofollow, and waits between requests.',
    path: '/bot',
    bodyClass: 'doc',
    body: `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm()}</header>
<main class="prose">
<h1>pitbot, the pit.world crawler</h1>
<p>pitbot reads pages for pit.world's own search index. What it reads is published as open <a href="https://logicsrc.com/opensite">OpenSite</a> records at <a href="https://nichedb.dev/c/sites">nichedb.dev/c/sites</a>, one per page, and pit.world searches them alongside the other indexes it asks.</p>
<h2>How it behaves</h2>
<ul>
<li>It identifies itself: <code>Mozilla/5.0 (compatible; pitbot/0.1; +https://pit.world/bot)</code>.</li>
<li>It obeys <code>robots.txt</code>: a group for <code>pitbot</code> if you write one, else <code>*</code>, and <code>Crawl-delay</code> up to 30 seconds.</li>
<li>It obeys <code>&lt;meta name="robots" content="noindex"&gt;</code> and <code>nofollow</code>, and does not follow <code>rel="nofollow"</code>, <code>sponsored</code> or <code>ugc</code> links.</li>
<li>It sends one request at a time to a site, with a pause between them, and reads at most a thousand pages per site per month.</li>
<li>Pages that are an empty shell until JavaScript runs are read once more in a headless browser, so the index sees what a visitor sees.</li>
<li>It reads only public pages: no forms, no logins, no carts.</li>
</ul>
<h2>Keep it out</h2>
<pre><code>User-agent: pitbot
Disallow: /</code></pre>
<p>A page already in the index is dropped on its next read. To ask for anything else, write to <a href="mailto:riotcoder@profullstack.com">riotcoder@profullstack.com</a>.</p>
</main>`,
  })
}

export function aboutPage(): string {
  const bangRows = BANGS.map((b) => `<tr><td><code>!${esc(b.aliases?.[0])}</code>${(b.aliases ?? []).slice(1).map((a) => ` <code>!${esc(a)}</code>`).join('')}</td><td>${esc(b.name)}</td></tr>`).join('')
  return layout({
    title: 'How pit.world works: default search, bangs, API, CLI, MCP',
    description: 'Make pit.world your default search engine, use bangs, and search from your terminal, your scripts or your AI agent.',
    path: '/about',
    bodyClass: 'doc',
    body: `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm()}</header>
<main class="prose">
<h1>How pit.world works</h1>
<p>A private front end to the web's search indexes, and a search engine for the Moshpit network. One search box, no account, and nothing that tracks what you search.</p>
${adUnit()}

<h2 id="default">Make it your default</h2>
<ul>
<li><b>Firefox:</b> right-click the address bar on this page and choose <i>Add "pit.world"</i>, then pick it in Settings → Search.</li>
<li><b>Chrome, Brave, Edge, Vivaldi:</b> Settings → Search engine → Manage → Add, with the URL <code>https://pit.world/search?q=%s</code>.</li>
<li><b>Safari:</b> use an extension that sets a custom engine, with the same URL.</li>
<li><b>Anything else:</b> pit.world publishes an <a href="/opensearch.xml">OpenSearch description</a>, and suggestions at <code>/suggest?q=</code>.</li>
</ul>

<h2 id="bangs">Bangs</h2>
<p>Put a bang anywhere in a search to go straight to another site's search, without a referrer: <code>!gh hqtui</code>, <code>rust lifetimes !so</code>.</p>
<table class="bangs">${bangRows}</table>

<h2 id="moshpit">Moshpit names</h2>
<p>Search a name like <code>chovy.hacker</code> and pit.world asks the Moshpit registry about it. To open Moshpit names in your browser, get on the network: <code>${esc(LINKS.install)}</code> then <code>${esc(LINKS.enable)}</code>, or set your browser's secure DNS to <code>${esc(LINKS.doh)}</code>. Every method, step by step: <a href="/connect">Connect to Moshpit</a>.</p>

<h2 id="votes">Votes: ▲ ▼ on every listing</h2>
<p>Every result, on every tab, has a ▲ and a ▼, and so do the featured box, the sponsored slots, PairUX and nixamp picks, blogs and business listings. No account: one vote per device and listing (per search, for results). Voting again the other way changes it; pressing the same arrow again takes it back.</p>
<p><b>How a vote moves a result.</b> Each result gets a score from its votes on <i>that search</i>, and another from votes on its site across all searches (counting each device once per site). A score is a Bayesian average that starts every item at five up and five down, so a handful of votes barely moves it:</p>
<pre><code>score  = (up + 5) / (up + down + 10) − 0.5          between −0.5 and +0.5
places = 6 × score(on this search) + 2 × score(its site)
moved  = places, capped at 3 either way</code></pre>
<p>Results are then re-ordered by <i>(position − places moved)</i>, ties kept in the engines' order. Ten up-votes and nothing else move a result about one and a half places; no amount of votes moves it more than three, so votes can neither bury a good page nor float a bad one to the top. The featured network site that leads some searches keeps its place. Business listings on <a href="/pros">/pros</a> move by the same rule, but only among unpaid listings: paid placements and campaign picks keep their slots.</p>
<p><b>Sponsored and featured slots are never re-ordered by votes.</b> Their votes are recorded as a quality signal (how useful a slot's ads are on each page type), for deciding what to show later.</p>
<p><b>One device, one vote.</b> Voting needs JavaScript: the page reads a fingerprint of your device (graphics card, screen, fonts, timezone, languages and similar) with <a href="https://github.com/profullstack/browser-fingerprint">@profullstack/browser-fingerprint</a>, from pit.world's own server. pit.world keeps only a salted hash of it and uses that only to stop one device voting many times; see <a href="/privacy#votes">privacy</a>. Votes are throttled hard (a dozen a minute per device, fewer per hour and day, and a ceiling per network), and browsers that look automated are refused.</p>
<pre><code>curl 'https://pit.world/api/votes?kind=result&amp;target=https://developer.mozilla.org/en-US/docs/Web/JavaScript&amp;q=learn+javascript'
curl 'https://pit.world/api/votes/top?kind=listing'
pit votes result https://developer.mozilla.org/en-US/docs/Web/JavaScript --q "learn javascript"
pit votes top listing</code></pre>
<p>Reading tallies needs nothing. Casting a vote needs the browser's fingerprint token, so the API, CLI and MCP server read votes but do not cast them.</p>

<h2 id="api">API, CLI, TUI and MCP</h2>
<p>Everything the page does is an API, and the same API is a command, a terminal app and an MCP server for your agents.</p>
<pre><code># API (JSON, no key)
curl 'https://pit.world/api/search?q=moshpit+network'
curl 'https://pit.world/api/resolve?name=chovy.hacker'
curl 'https://pit.world/api/network'

# CLI and TUI
bun add -g pitworld          # or: npm i -g pitworld (needs bun on PATH)
pit search "private search engines"
pit resolve chovy.hacker
pit                          # the TUI

# MCP, for Claude Code and other agents
claude mcp add pit -- pit mcp</code></pre>
<p>The API is rate limited per visitor, like the page. It answers <code>429</code> with <code>Retry-After</code> when you go over.</p>
</main>`,
  })
}

export function connectPage(): string {
  const doh = esc(LINKS.doh)
  return layout({
    title: 'Connect to the Moshpit network · pit.world',
    description: 'Open Moshpit names like chovy.hacker on Linux, macOS, Windows, iPhone, iPad and Android: every method, step by step.',
    path: '/connect',
    bodyClass: 'doc',
    body: `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm()}</header>
<main class="prose">
<p class="kicker">The Moshpit network</p>
<h1>Connect to Moshpit</h1>
<p class="lede">Searching Moshpit names works on pit.world with nothing installed. To <i>open</i> them, so that <code>https://chovy.hacker</code> loads like any site, your device needs two things:</p>
<ol>
<li><b>A resolver that knows Moshpit names.</b> Ordinary DNS has never heard of <code>.hacker</code>. Moshpit's resolver at <code>${doh}</code> answers Moshpit names <i>and</i> every normal domain, so it can be your only DNS.</li>
<li><b>Trust in the Moshpit Root CA.</b> The registry signs a real certificate for every name, under its own root. Until your device trusts that root, Moshpit sites open with a certificate warning.</li>
</ol>
<p>Pick the method that fits your device. Each one says which of the two it covers.</p>

<table class="methods">
<tr><th>Method</th><th>For</th><th>Names</th><th>HTTPS</th></tr>
<tr><td><a href="#moshcode">moshcode</a></td><td>Linux, whole machine</td><td>✓</td><td>✓ automatic</td></tr>
<tr><td><a href="#tron">TronBrowser</a></td><td>Linux, one browser</td><td>✓</td><td>✓ automatic</td></tr>
<tr><td><a href="#browser">Browser secure DNS</a></td><td>Chrome, Edge, Brave, Firefox on any OS</td><td>✓</td><td><a href="#ca">install the root</a></td></tr>
<tr><td><a href="#apple">Apple profile</a></td><td>iPhone, iPad, Mac</td><td>✓</td><td>✓ one extra switch</td></tr>
<tr><td><a href="#windows">Windows DNS</a></td><td>Windows 11, whole machine</td><td>✓</td><td><a href="#ca">install the root</a></td></tr>
<tr><td><a href="#android">Android</a></td><td>Android phones and tablets</td><td>✓ in the browser</td><td><a href="#ca">install the root</a></td></tr>
</table>

<h2 id="moshcode">1. moshcode (Linux, the whole machine)</h2>
<p>The most complete setup: every app on the machine resolves Moshpit names, a local proxy handles HTTPS, and the root is trusted for you. Ordinary domains keep resolving the way they did before.</p>
<ol>
<li>Install moshcode:<pre><code>${esc(LINKS.install)}</code></pre></li>
<li>Turn on Moshpit names. It asks for your password once, because it changes system DNS routing and the trust store. Run it as yourself; do not put <code>sudo</code> in front:<pre><code>${esc(LINKS.enable)}</code></pre></li>
<li>Check it:<pre><code>moshcode dns status
curl -I https://chovy.hacker</code></pre></li>
<li>Already installed? Update first, then enable again:<pre><code>moshcode update
${esc(LINKS.enable)}</code></pre></li>
</ol>
<p>Undo everything with <code>moshcode dns disable</code>. To trust the root without changing DNS, use <code>moshcode dns ca</code>.</p>

<h2 id="tron">2. TronBrowser (Linux, one browser)</h2>
<p>A privacy browser that carries the Moshpit root and a one-click switch. Nothing on the rest of the machine changes.</p>
<ol>
<li>Install it:<pre><code>${esc(LINKS.tronInstall)}</code></pre></li>
<li>Start it with <code>tron</code>.</li>
<li>Open the sidebar and click <b>🤘 Pit</b>. Moshpit names now open in TronBrowser, and normal sites still go direct.</li>
<li>Visit <code>https://chovy.hacker</code> to check.</li>
</ol>
<p>The Pit and Tor are exclusive: turning one on turns the other off, so Tor lookups never leak. Already installed? Run <code>tron upgrade</code> first. More at <a href="${esc(LINKS.tron)}">tronbrowser.dev</a>.</p>

<h2 id="browser">3. Browser secure DNS (any OS, nothing to install)</h2>
<p>Point your browser's DNS-over-HTTPS setting at Moshpit. Only that browser changes. Then <a href="#ca">install the root</a> so Moshpit sites open without a warning.</p>
<h3>Chrome, Edge, Brave, Vivaldi, Opera (desktop and Android)</h3>
<ol>
<li>Open <b>Settings → Privacy and security → Security</b>. (Edge: <b>Settings → Privacy, search, and services → Security</b>.)</li>
<li>Turn on <b>Use secure DNS</b>.</li>
<li>Choose <b>With: Custom</b> (or <b>Add custom DNS service provider</b>).</li>
<li>Enter:<pre><code>${doh}</code></pre></li>
</ol>
<h3>Firefox (desktop)</h3>
<ol>
<li>Open <b>Settings → Privacy &amp; Security</b> and scroll to <b>DNS over HTTPS</b>.</li>
<li>Choose <b>Max Protection</b>.</li>
<li>Under <b>Choose provider</b>, pick <b>Custom</b> and enter:<pre><code>${doh}</code></pre></li>
</ol>
<h3>Firefox (Android)</h3>
<ol>
<li>Open <b>Settings → DNS over HTTPS</b>.</li>
<li>Choose <b>Max Protection</b>, then <b>Custom</b>, and enter the same address.</li>
</ol>

<h2 id="apple">4. Apple profile (iPhone, iPad, Mac)</h2>
<p>One download sets the Moshpit resolver for the whole device and carries the root certificate with it.</p>
<h3>iPhone and iPad</h3>
<ol>
<li>Open this page in <b>Safari</b> and tap <a href="/moshpit.mobileconfig">Download the Moshpit profile</a>. Tap <b>Allow</b>.</li>
<li>Open <b>Settings</b>. Tap <b>Profile Downloaded</b> near the top (or <b>General → VPN &amp; Device Management</b>), then <b>Install</b> and enter your passcode. It says "Not Verified" because the profile is not signed; the contents are what this page describes.</li>
<li>Turn on the root: <b>Settings → General → About → Certificate Trust Settings</b>, switch on <b>Moshpit Root CA</b>. iOS asks for this extra step for every root you add yourself.</li>
<li>Check it in <b>Settings → General → VPN &amp; Device Management → DNS</b>: Moshpit should be selected. Then open <code>https://chovy.hacker</code> in Safari.</li>
</ol>
<h3>Mac</h3>
<ol>
<li>Download <a href="/moshpit.mobileconfig">the Moshpit profile</a>.</li>
<li>Open <b>System Settings → General → Device Management</b> (older macOS: <b>Privacy &amp; Security → Profiles</b>), double-click <b>Moshpit network</b> and choose <b>Install</b>.</li>
<li>If Safari or Chrome still warns, open <b>Keychain Access</b>, find <b>Moshpit Root CA</b> under <b>System</b>, open <b>Trust</b> and set <b>When using this certificate</b> to <b>Always Trust</b>.</li>
</ol>
<p>Remove it any time from the same Device Management screen.</p>

<h2 id="windows">5. Windows 11 (the whole machine)</h2>
<ol>
<li>Open <b>Settings → Network &amp; internet</b>, then <b>Wi-Fi</b> or <b>Ethernet</b>, then your connection's <b>Hardware properties</b>.</li>
<li>Next to <b>DNS server assignment</b>, click <b>Edit</b> and choose <b>Manual</b>.</li>
<li>Turn on <b>IPv4</b>. Set <b>Preferred DNS</b> to <code>23.95.228.174</code>.</li>
<li>Set <b>DNS over HTTPS</b> to <b>On (manual template)</b> and enter:<pre><code>${doh}</code></pre></li>
<li>Leave <b>Fallback to plaintext</b> off, and <b>Save</b>.</li>
<li><a href="#ca">Install the root</a>.</li>
</ol>
<p>Undo by setting DNS server assignment back to <b>Automatic (DHCP)</b>.</p>

<h2 id="android">6. Android</h2>
<p>Android's system-wide <b>Private DNS</b> setting speaks DNS-over-TLS, which Moshpit does not offer yet. Use your browser's secure DNS instead, which covers browsing:</p>
<ol>
<li>In Chrome or Firefox, follow the <a href="#browser">browser steps</a> above.</li>
<li>Download <a href="/moshpit-root-ca.crt">the Moshpit root</a>.</li>
<li>Open <b>Settings → Security &amp; privacy → More security settings → Encryption &amp; credentials → Install a certificate → CA certificate</b> (the words differ a little between phone makers; search Settings for "CA certificate"), tap <b>Install anyway</b> and pick the file.</li>
<li>Chrome trusts certificates installed this way. Firefox needs one more switch: <b>Settings → About Firefox</b>, tap the logo five times, then go back to <b>Settings → Secret Settings</b> and turn on <b>Use third party CA certificates</b>.</li>
</ol>

<h2 id="ca">Trust the Moshpit Root CA</h2>
<p>Download it here, <a href="/moshpit-root-ca.crt">moshpit-root-ca.crt</a>, or from the registry at <a href="${esc(LINKS.ca)}">${esc(LINKS.ca)}</a>. Check the fingerprint before you trust it:</p>
<pre><code>openssl x509 -in moshpit-root-ca.crt -noout -subject -fingerprint -sha256</code></pre>
<p>It must say <code>CN = Moshpit Root CA, O = Moshpit</code> and SHA-256 <code class="fp">${MOSHPIT_ROOT_SHA256}</code>.</p>
<p><b>What you are trusting.</b> A root you install can vouch for any name. The registry refuses to sign names under real top-level domains and publishes every certificate it issues, but that is a promise kept by the signer, not something your device can enforce. Install it only on devices where you want Moshpit, and remove it the same way if you change your mind.</p>
<h3>Debian, Ubuntu</h3>
<pre><code>sudo cp moshpit-root-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates</code></pre>
<h3>Fedora, RHEL, Arch</h3>
<pre><code>sudo cp moshpit-root-ca.crt /etc/pki/ca-trust/source/anchors/
sudo update-ca-trust</code></pre>
<p>On Arch the folder is <code>/etc/ca-certificates/trust-source/anchors/</code>; the command is the same.</p>
<h3>Chrome and Chromium on Linux</h3>
<p>They read their own store, not the system one:</p>
<pre><code>certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n "Moshpit Root CA" -i moshpit-root-ca.crt</code></pre>
<h3>macOS</h3>
<pre><code>sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain moshpit-root-ca.crt</code></pre>
<h3>Windows</h3>
<p>In an administrator PowerShell or Command Prompt:</p>
<pre><code>certutil -addstore -f Root moshpit-root-ca.crt</code></pre>
<p>Or double-click the file, choose <b>Install Certificate → Local Machine</b>, then <b>Place all certificates in the following store → Trusted Root Certification Authorities</b>.</p>
<h3>Firefox (any desktop)</h3>
<ol>
<li><b>Settings → Privacy &amp; Security → Certificates → View Certificates → Authorities → Import</b>.</li>
<li>Pick the file and tick <b>Trust this CA to identify websites</b>.</li>
</ol>

<h2 id="check">Check that it works</h2>
<ol>
<li>Search <a href="/search?q=chovy.hacker">chovy.hacker</a> on pit.world: the Moshpit card shows where the name points.</li>
<li>Open <a href="https://chovy.hacker/" rel="noreferrer noopener">https://chovy.hacker</a>. It should load with a padlock and no warning.</li>
<li>Still a warning? The resolver works but the root is not trusted yet: see <a href="#ca">Trust the Moshpit Root CA</a>. "Site can't be reached"? The resolver is not in use: re-check your method's steps, and close and reopen the browser.</li>
</ol>

<h2 id="undo">Undo</h2>
<ul>
<li><b>moshcode:</b> <code>moshcode dns disable</code>.</li>
<li><b>TronBrowser:</b> click <b>🤘 Pit</b> again.</li>
<li><b>Browsers:</b> set secure DNS back to your previous provider or off.</li>
<li><b>Apple:</b> remove the <b>Moshpit network</b> profile in Device Management.</li>
<li><b>Windows:</b> DNS server assignment back to <b>Automatic (DHCP)</b>; remove the root in <code>certmgr.msc</code> → Trusted Root Certification Authorities.</li>
<li><b>Root on Linux:</b> delete the file you copied and run the same update command; for Chrome, <code>certutil -d sql:$HOME/.pki/nssdb -D -n "Moshpit Root CA"</code>.</li>
</ul>

<h2 id="next">Next</h2>
<p>On the network? <a href="${LINKS.claim}">Claim an ending</a> and put your own names on it, or browse what is already there in the <a href="${LINKS.registry}">registry</a>.</p>
</main>`,
  })
}

export type NewsletterKind = 'form' | 'check' | 'invalid' | 'undeliverable' | 'failed' | 'limited' | 'confirmed' | 'expired'

/**
 * The page after a signup or a confirmation click (and GET /subscribe, the form on its own). One page per
 * outcome, never one that says who is on the list. A signup from another Profullstack property gets a plain
 * Profullstack page with a link back to that site, and none of pit.world's own chrome.
 */
export function newsletterPage(kind: NewsletterKind, origin: NewsletterOrigin = {}): string {
  const pit = origin.pit ?? true
  const name = pit ? 'pit.world' : 'Profullstack'
  const copy = {
    form: [`The ${name} newsletter`, 'About once a month. Confirm by email, unsubscribe in one click.'],
    check: ['Check your inbox', 'A confirmation link is on its way to that address. Click it within 48 hours to join; otherwise the address is forgotten. Nothing there in a few minutes? Look in spam, or try again.'],
    invalid: ["That doesn't look like an email address", 'Check it and try again.'],
    undeliverable: ["That domain can't receive email", 'There is no mail server for it. Check the spelling after the @.'],
    failed: ["We couldn't send the confirmation", 'Our email provider did not take the message. Please try again in a few minutes.'],
    limited: ['Slow down a little', 'Too many requests from your connection. Try again in a minute.'],
    confirmed: ["You're on the list", 'Thanks. The next issue comes to your inbox, and each one has a one-click unsubscribe.'],
    expired: ['That link has expired', 'Confirmation links work once, for 48 hours. Sign up again and use the new link.'],
  }[kind]
  const retry = kind === 'form' || kind === 'invalid' || kind === 'undeliverable' || kind === 'failed' || kind === 'expired'
  const backHref = origin.source && origin.source !== 'pit.world' ? `https://${origin.source}/` : pit ? '/' : 'https://profullstack.com/'
  const backLabel = origin.source && origin.source !== 'pit.world' ? `Back to ${origin.source}` : pit ? 'Back to search' : 'Back to Profullstack'
  const form = retry ? newsletterForm(origin).replace(/<p class="kicker">[\s\S]*?<\/p>\s*<h2>[\s\S]*?<\/h2>\s*<p class="lede">[\s\S]*?<\/p>/, '') : ''
  const status = kind === 'check' || kind === 'confirmed' ? ' role="status"' : ''
  const main = `<main class="prose">
<h1${status}>${esc(copy[0])}</h1>
<p>${esc(copy[1])}</p>
${form}<p><a class="btn" href="${esc(backHref)}">${esc(backLabel)}</a></p>
</main>`
  if (!pit) return plainPage({ title: `${copy[0]} · Profullstack`, body: main })
  return layout({
    title: `${copy[0]} · pit.world`,
    description: 'The pit.world newsletter.',
    path: '/subscribe',
    bodyClass: 'doc',
    noindex: true,
    body: `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm()}</header>
${main}`,
  })
}

/** A bare page for visitors from other Profullstack sites: pit.world's stylesheet, none of its chrome or wording. */
function plainPage(o: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark light">
<link rel="stylesheet" href="${STYLE_URL}">
</head>
<body class="doc">
${o.body}
</body>
</html>`
}

export function buildPage(o: { invoicing?: boolean; error?: string; values?: Record<string, string>; guard?: string } = {}): string {
  const v = o.values ?? {}
  return layout({
    title: 'We build it. We host it. $49, then $2 a month · pit.world',
    description: 'Describe the app in plain words. An AI product team plans it, builds it on the open source Profullstack stack and shows you it working. $49 to build, including the first 30 days, then $2 a month to keep it online. Paid in crypto through CoinPay.',
    path: '/build',
    bodyClass: 'doc',
    body: `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm()}</header>
<main class="prose build">
<p class="kicker">Build an app</p>
<h1>We build it. We host it.</h1>
<p class="lede">Describe the app in plain words. An AI product team writes a plan you can argue with, builds it on the open source <a href="${LINKS.stack}">Profullstack stack</a>, and shows you it working before anything launches. $49 to build, including the first 30 days, then $2 a month to keep it online. Paid in crypto through <a href="https://coinpayportal.com">CoinPay</a>.</p>

<form class="idea" action="${LINKS.chovyStart}" method="get">
  <label for="idea">What should it do?</label>
  <textarea id="idea" name="idea" rows="5" maxlength="2000" required placeholder="A booking page for my barbershop: customers pick a barber and a time, pay a deposit, and get a text reminder the day before."></textarea>
  <input type="hidden" name="plan" value="starter">
  <input type="hidden" name="ref" value="pitworld">
  <button class="btn" type="submit">Start building →</button>
  <p class="small">You continue on chovy.com, where the agents work and you pay at checkout. Your idea is sent there, not kept here.</p>
</form>

<div class="prices">
  <div><b>$49</b><span>to build it, including the first 30 days</span><p>One small app: pages, a database, sign-in and payments where it needs them, on your own subdomain, online for its first month.</p></div>
  <div><b>$2</b><span>a month after that, to keep it online</span><p>Hosting for that one app. Stop paying and it is paused, not deleted; pay again and it is back.</p></div>
</div>
<p>Both are paid in crypto through <a href="https://coinpayportal.com">CoinPay</a>. No card, no account with a payment company.</p>
${o.invoicing ? `
<h2 id="invoice">Rather pay by invoice?</h2>
<p>We send you two invoices through <a href="https://pay.agent.pit.world/">pay.agent</a>: $49 now, and $2 a month from day 31, which CoinPay sends each month by itself. A person on our team starts your build when the first one is paid.</p>
${o.error ? `<p class="note error" role="alert">${esc(o.error)}</p>` : ''}
<form class="idea" action="/build/invoice" method="post">
  <label for="inv-idea">What should it do?</label>
  <textarea id="inv-idea" name="idea" rows="4" maxlength="2000" required>${esc(v.idea ?? '')}</textarea>
  <label for="inv-email">Email for the invoices</label>
  <input id="inv-email" name="email" type="email" required maxlength="254" autocomplete="email" value="${esc(v.email ?? '')}">
  <label for="inv-name">Your name <span class="small">(optional)</span></label>
  <input id="inv-name" name="name" maxlength="80" autocomplete="name" value="${esc(v.name ?? '')}">
  ${o.guard ?? '<input class="hp" name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">'}
  <button class="btn" type="submit">Send me the invoice →</button>
  <p class="small">Your idea and email go to pay.agent (for the invoices) and to the builder. Nothing is kept on pit.world.</p>
</form>` : ''}

<h2>What you get</h2>
<ul>
<li><b>A real app, not a mock-up.</b> It is not called finished until it can be shown working.</li>
<li><b>You approve the launch.</b> Nothing goes live without your yes.</li>
<li><b>You own it.</b> The code and the domain are yours. Take them anywhere.</li>
<li><b>An open stack.</b> MIT-licensed packages pulled out of 170 products that run on them, with a CLI, a terminal app and an MCP server where it makes sense.</li>
</ul>

<h2>Questions</h2>
<h3>Do I need to know how to code?</h3>
<p>No. Describe what you want the way you would to a friend. The agents ask when something is unclear.</p>
<h3>What does "small app" mean?</h3>
<p>One focused product: a booking page, a shop for a few items, a directory, a tool for your team. Bigger builds are possible on chovy.com and priced there.</p>
<h3>What does the $49 cover?</h3>
<p>The build, and the first 30 days online. The $2 a month starts on day 31.</p>
<h3>What happens if I stop paying the $2?</h3>
<p>The app is paused, not deleted. Pay again and it comes back as it was.</p>
<h3>Who builds it?</h3>
<p><a href="https://chovy.com">Chovy</a>, an AI product team by Profullstack, Inc., the people behind pit.world.</p>
</main>`,
  })
}

/** /start, the ring bar's "Start building here…": from nothing to your own sites on a Moshpit server. */
export function startPage(): string {
  const pay = `${LINKS.payAgent}?amount=5&amp;note=${encodeURIComponent('Moshpit server, 1 month')}`
  return layout({
    title: 'Moshpit static site hosting on a shared server, $5 a month · pit.world',
    description: 'Host static sites on a shared Moshpit Linux server for $5 a month. SSH access uses a separate account without root; see current host totals and limits.',
    path: '/start',
    bodyClass: 'doc',
    body: `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm()}</header>
<main class="prose build">
<p class="kicker">Start building here</p>
<h1>Static sites on a shared Moshpit server. $5 a month.</h1>
<p class="lede">This is one hosting account on a shared, managed Linux server, not a dedicated VPS. Each Moshpit name points to your site files and opens at its own name, or at <code>name.pit.world</code> for everyone else.</p>

<div class="prices">
  <div><b>$5</b><span>a month, per hosting account</span><p>Unlimited site names; disk, traffic and machine capacity are shared. Stop paying and the account is paused, not deleted.</p></div>
  <div><b>Crypto</b><span>no card</span><p>Pay through <a href="${LINKS.payAgent}">pay.agent</a> on Moshpit, or <a href="${LINKS.payClearnet}">CoinPay</a> on the clearnet.</p></div>
</div>

<h2>What the $5 plan includes</h2>
<table class="methods"><tbody>
<tr><th scope="row">Access</th><td>A separate Unix account with SSH public-key login. It has no root or sudo access and is not a virtual machine.</td></tr>
<tr><th scope="row">Host totals</th><td>The current shared host has 6 vCPU, 19 GiB of RAM and a 193 GB system disk (checked 2026-11-02). Those are machine totals shared with the operating system and all accounts, not resources reserved for one customer; the host may change.</td></tr>
<tr><th scope="row">Sites and resources</th><td>There is no site-count limit. No per-account CPU, memory, storage or bandwidth allowance is published. “Unlimited” means the number of site names, not unlimited disk or traffic.</td></tr>
<tr><th scope="row">What runs</th><td>HTTPS serves static site files. A <code>deploy.sh</code> can generate those files during a deployment in the shared build queue. An always-on app process, database, mail server or system service is not included.</td></tr>
</tbody></table>
<p>This plan does not include a dedicated server, a VM, root access, guaranteed CPU or memory, or an uptime SLA. A root or dedicated-server plan is not currently offered here.</p>

<h2>Usage and terms</h2>
<p><a href="https://profullstack.com/terms">Profullstack's Terms of Service</a> are the general company terms. They do not yet describe Moshpit-specific prohibited uses, per-account quotas or an abuse-handling process. This page describes the technical service that is currently set up. If you need to run something beyond static sites, contact <a href="mailto:riotcoder@profullstack.com">riotcoder@profullstack.com</a> before ordering.</p>

<h2>Who runs it?</h2>
<p>Moshpit hosting is operated by Profullstack, Inc. See the <a href="https://profullstack.com/teams">named team</a>, <a href="https://profullstack.com/case-studies">case studies</a> and <a href="https://github.com/moshcoder/pit.world">pit.world source code</a>. The $5 price covers hosting; <a href="https://profullstack.com/pricing">engineering services</a> are separate.</p>

<h2>1. Get on Moshpit</h2>
<p>Install moshcode, the command line for the network:</p>
<pre><code>${esc(LINKS.install)}</code></pre>
<p>To open Moshpit names directly in your browser, follow <a href="/connect">Connect to Moshpit</a>. You can skip it: every name also works at <code>name.pit.world</code>.</p>

<h2>2. Claim a name</h2>
<p>Pick a name on <a href="${LINKS.claim}">${esc(LINKS.claim.replace('https://', ''))}</a>, under an ending someone already runs or one of your own (<code>shop.yourname</code>, <code>blog.yourname</code>). One server serves every name you point at it.</p>

<h2>3. Build the site</h2>
<p>A folder of files: hand-written HTML, or what a static site generator or a frontend build puts out. The open source <a href="${LINKS.stack}">Profullstack stack</a> gives you auth, payments and a database ready-made. Rather not build it yourself? <a href="/build">Have AI agents build it</a> for $49.</p>

<h2>4. Deploy it to a Moshpit server</h2>
<ol>
<li><b>Pay $5 for the month.</b> On Moshpit DNS, use <a href="${pay}">pay.agent/profullstack</a>; on the clearnet, pay through <a href="${LINKS.payClearnet}">coinpayportal.com</a>. In the note, put the names you want served, the username you want, and your SSH public key (<code>cat ~/.ssh/id_ed25519.pub</code>). Have a credit code? Redeem it on <a href="/account">your account</a> and use the month there instead: same order, no payment.</li>
<li><b>We set up your account</b> on the Moshpit server and point each name at it, with its certificate. You get a reply when it is ready.</li>
<li><b>Deploy from your machine</b>, from the folder with your site in it:
<pre><code>moshcode deploy shop.yourname --user yourname</code></pre>
It uploads the folder and prints where it is live: <code>https://shop.yourname/</code> on Moshpit DNS and <code>https://shop.yourname.pit.world/</code> everywhere else. Deploy again whenever you change something. Already have moshcode? <code>moshcode upgrade self</code> first.</li>
<li><b>Need a build step?</b> Put your output in <code>public/</code> and a <code>deploy.sh</code> beside it: it runs on the server after each upload, in the queue that keeps builds three at a time.</li>
<li><b>Add more.</b> Claim another name, ask us to add it, deploy. No extra charge. See one live: <a href="https://demo.indie.pit.world/">demo.indie</a>.</li>
</ol>

<h2>5. Join the ring</h2>
<p><a href="/b">Claim your site's listing</a> and it joins the <a href="/ring">pit.world ring</a>, so visitors walk to you from every other member.</p>
</main>`,
  })
}

/** A plain document page (header bar + prose column), for modules that render their own pages. */
const VOTE_NOTES: Record<'needs-js' | 'stale' | 'bot' | 'limited' | 'bad-vote', string> = {
  'needs-js': 'Voting needs JavaScript. pit.world counts one vote per device, and it tells devices apart by a salted, hashed fingerprint that a script reads; without it, a vote could be anyone, as many times as they like. Everything else on pit.world works without JavaScript.',
  stale: 'That page was open a while. Reload it and vote again.',
  bot: 'That vote looked automated, so it was not counted.',
  limited: 'That is a lot of votes in a short time. Give it a few minutes.',
  'bad-vote': 'That vote could not be read.',
}

/** The answer to a ▲ ▼ that could not be counted (the no-JavaScript fallback of every vote form). */
export function votePage(reason: keyof typeof VOTE_NOTES, back: string): string {
  return docPage({
    title: 'Vote not counted · pit.world',
    description: 'Why a vote was not counted.',
    path: '/vote',
    noindex: true,
    body: `<h1>Vote not counted</h1>
<p>${esc(VOTE_NOTES[reason] ?? VOTE_NOTES['bad-vote'])}</p>
<p><a class="btn" href="${esc(back)}">Back</a> <a href="/about#votes">How votes work</a> · <a href="/privacy#votes">What a vote keeps</a></p>`,
  })
}

export function docPage(options: { title: string; description: string; path: string; body: string; noindex?: boolean; query?: string; head?: string }): string {
  return layout({
    title: options.title,
    description: options.description,
    path: options.path,
    bodyClass: 'doc',
    ...(options.noindex ? { noindex: true } : {}),
    ...(options.head ? { head: options.head } : {}),
    body: `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm(options.query ?? '')}</header>
<main class="prose">
${options.body}
</main>`,
  })
}

export function errorPage(): string {
  return layout({
    title: 'Something went wrong · pit.world',
    description: 'pit.world hit an error.',
    path: '/',
    bodyClass: 'doc',
    noindex: true,
    body: `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm()}</header>
<main class="prose">
<h1>Something went wrong</h1>
<p>pit.world hit an error answering that. Nothing about your request was logged. Try again, or try other words.</p>
</main>`,
  })
}

export function offlinePage(): string {
  return layout({
    title: 'Offline · pit.world',
    description: 'pit.world needs the network to search.',
    path: '/offline',
    bodyClass: 'doc',
    noindex: true,
    body: `<main class="prose">
<a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>
<h1>You're offline</h1>
<p>pit.world searches live, so it needs the network. Nothing about your searches is stored on this device, so there is nothing to show until you are back online.</p>
<p><a class="btn" href="/">Try again</a></p>
</main>`,
  })
}

/**
 * An Apple configuration profile: Moshpit's DoH resolver for the whole device, plus the
 * registry's root. Unsigned, so iOS and macOS show it as "Not Verified".
 */
export function mobileConfig(rootPem: string): string {
  const der = rootPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.apple.dnsSettings.managed</string>
      <key>PayloadIdentifier</key><string>world.pit.moshpit.dns</string>
      <key>PayloadUUID</key><string>6B0C2F43-4E0A-4C6B-9A63-2D7A5F1E9C01</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadDisplayName</key><string>Moshpit DNS</string>
      <key>DNSSettings</key>
      <dict>
        <key>DNSProtocol</key><string>HTTPS</string>
        <key>ServerURL</key><string>${esc(LINKS.doh)}</string>
      </dict>
    </dict>
    <dict>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadIdentifier</key><string>world.pit.moshpit.root</string>
      <key>PayloadUUID</key><string>0E4D8B57-1F2C-4A39-8D61-7C3B9E2A5F02</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadDisplayName</key><string>Moshpit Root CA</string>
      <key>PayloadCertificateFileName</key><string>moshpit-root-ca.crt</string>
      <key>PayloadContent</key><data>${der}</data>
    </dict>
  </array>
  <key>PayloadDisplayName</key><string>Moshpit network</string>
  <key>PayloadDescription</key><string>Opens Moshpit names like chovy.hacker on this device: Moshpit's resolver (${esc(LINKS.doh)}) for DNS, and the Moshpit Root CA for HTTPS. See https://pit.world/connect</string>
  <key>PayloadOrganization</key><string>pit.world</string>
  <key>PayloadIdentifier</key><string>world.pit.moshpit</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>A3F1C9D2-5B7E-4E80-B6D4-1C2E3F4A5B03</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadRemovalDisallowed</key><false/>
</dict>
</plist>
`
}

export function openSearchXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/" xmlns:moz="http://www.mozilla.org/2006/browser/search/">
  <ShortName>pit.world</ShortName>
  <Description>Private search, and the Moshpit network</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Image width="16" height="16" type="image/svg+xml">${SITE}/favicon.svg</Image>
  <Url type="text/html" method="get" template="${SITE}/search?q={searchTerms}"/>
  <Url type="application/x-suggestions+json" method="get" template="${SITE}/suggest?q={searchTerms}"/>
  <Url type="application/opensearchdescription+xml" rel="self" template="${SITE}/opensearch.xml"/>
  <moz:SearchForm>${SITE}/</moz:SearchForm>
</OpenSearchDescription>`
}

export function ringPage(options: { mirror?: { ok: boolean; at: number; missing: string[] } | null } = {}): string {
  const sites = ringSites()
  const rows = sites
    .map(
      (s) =>
        `<li><h3><a href="${esc(siteHref(s, false))}">${esc(s.name)}</a></h3><p>${esc(s.about)}</p>${s.listing ? `<p class="muted"><a href="/b/${encodeURIComponent(s.name)}">Listing on pit.world</a>${s.feed ? ` · <a href="${esc(s.feed)}" rel="noreferrer noopener">feed</a>` : ''}</p>` : ''}${s.moshpit ? `<p class="muted">A Moshpit name. On Moshpit DNS: <a href="${esc(siteHref(s, true))}">${esc(siteHref(s, true))}</a>. Everyone else: through pit.world, as linked above.</p>` : ''}</li>`,
    )
    .join('')
  return docPage({
    title: 'The pit.world ring: a web ring of claimed sites and the Moshpit network',
    description: 'A web ring of every business and site claimed on pit.world, plus the Moshpit network sites it started with. Walk from one to the next, Moshpit DNS or not.',
    path: '/ring',
    body: `<h1>The pit.world ring</h1>
<p class="lede">${sites.length} sites, linked the old way: each member carries the same links, to the one before it, the one after it, and a random one. It is for *.pit.world sites only: pit.world's own subdomains and Moshpit names, which pit.world relays at <code>&lt;name&gt;.pit.world</code>. A Moshpit site that claims its listing joins automatically, so this is also the quickest way to look around the sites on pit.world.</p>
<p class="row"><a class="btn" href="/ring/random">Visit a random site</a> <a href="/pros">Browse the pro directory</a> <a href="${RSS_RING}" rel="noreferrer noopener">The ring's feeds on rssamplifier.com</a></p>
<ul class="ring-list">${rows}</ul>
<h2>No Moshpit DNS? Still works.</h2>
<p>A name like <code>seo.rank</code> only opens for a visitor on Moshpit DNS. When a member site cannot tell that you are, the bar links to <code>https://&lt;name&gt;.pit.world/</code> instead: the whole site, relayed by pit.world on an ordinary address that opens in any browser. <a href="/connect">Get on Moshpit DNS</a> and the links go straight to the site.</p>
<h2>Join</h2>
<p>Own a Moshpit name or a *.pit.world site? <a href="/b">Claim its listing</a>: claiming is joining. Businesses on their own .com are welcome in the <a href="/pros">pro directory</a>, not in the ring. The verified page gives you the links to paste; owners can leave the ring from the edit page. Members with an RSS or Atom feed on their homepage (<code>&lt;link rel="alternate"&gt;</code>) are mirrored to <a href="${RSS_RING}" rel="noreferrer noopener">rssamplifier.com/ring/pit-world</a>, which reads their posts${options.mirror ? ` (last synced ${esc(new Date(options.mirror.at).toISOString().slice(0, 16).replace('T', ' '))} UTC)` : ''}.</p>
<ul>
<li><code>GET https://pit.world/api/ring</code>: the members as JSON, with a direct and a pit.world URL for each. Draw the bar from it.</li>
<li>Or paste links, no code at all: <code>https://pit.world/ring/prev?from=&lt;your site&gt;</code>, <code>/ring/next?from=…</code> and <code>/ring/random?from=…</code>. Add <code>&amp;direct=1</code> when your visitors are on Moshpit DNS.</li>
<li>Every member's feed in one file: <a href="/ring/opml">/ring/opml</a>. From the terminal: <code>pit ring</code>.</li>
</ul>`,
  })
}

/** The ring's feeds as OPML, for a feed reader. */
export function ringOpml(sites: RingSite[]): string {
  const x = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return `<?xml version="1.0" encoding="utf-8"?>
<opml version="2.0">
<head><title>The pit.world ring</title><ownerId>https://pit.world/ring</ownerId></head>
<body>
${sites
  .filter((s) => s.feed)
  .map((s) => `<outline type="rss" text="${x(s.name)}" title="${x(s.name)}" xmlUrl="${x(s.feed)}" htmlUrl="${x(`https://${s.name}/`)}"/>`)
  .join('\n')}
</body>
</opml>
`
}

/** /admin/subscribers: newsletter signups per Profullstack property, and the confirmed list (filter with ?site=). */
export function subscribersAdminPage(
  properties: Array<{ source: string; confirmed: number; pending: number }>,
  subscribers: Array<{ email: string; confirmed_at: number; source: string; sources: string[] }>,
  o: { total: number; pending: number; site?: string },
): string {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const rows = properties
    .map((p) => `<tr><td><a href="/admin/subscribers?site=${encodeURIComponent(p.source)}">${esc(p.source)}</a></td><td>${p.confirmed}</td><td>${p.pending}</td></tr>`)
    .join('')
  const list = subscribers.map((s) => `<tr><td>${esc(s.email)}</td><td>${day(s.confirmed_at)}</td><td>${esc(s.sources.join(', '))}</td></tr>`).join('')
  const csv = `/api/admin/subscribers.csv${o.site ? `?site=${encodeURIComponent(o.site)}` : ''}`
  return layout({
    title: 'Newsletter subscribers · pit.world admin',
    description: 'Newsletter signups by property.',
    path: '/admin/subscribers',
    bodyClass: 'doc',
    noindex: true,
    track: false,
    body: `<main class="prose">
<h1>Newsletter subscribers</h1>
<p>${o.total} confirmed, ${o.pending} waiting on their confirmation email (48 h). A signup's property is the site whose footer form (or page) it came from. <a href="${csv}">Download CSV</a>${o.site ? ` · <a href="/admin/subscribers">All properties</a>` : ''}</p>
<h2>By property</h2>
<table class="facts"><tr><th>Property</th><th>Confirmed</th><th>Pending</th></tr>${rows || '<tr><td colspan="3">No signups yet.</td></tr>'}</table>
<h2>${o.site ? `Confirmed from ${esc(o.site)}` : 'Confirmed'} (${subscribers.length})</h2>
<table class="facts"><tr><th>Email</th><th>Confirmed</th><th>Properties</th></tr>${list || '<tr><td colspan="3">None.</td></tr>'}</table>
</main>`,
  })
}
