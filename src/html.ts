/**
 * Server-rendered pages. Every page works with JavaScript off (Tor Browser on
 * "Safest" included); /app.js only adds keyboard shortcuts.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { BANGS } from './bangs.js'
import { LINKS, MOSHPIT_ROOT_SHA256, type NetworkStats, type Resolution } from './moshpit.js'
import type { Promo } from './promoted.js'
import { ringFooter, ringFooterOptions, setRingFooterOptions } from './ring-footer.js'
import { proxyUrl, ringBar, ringSites, RSS_RING, siteHref, type RingSite } from './ring.js'
import { LABELS, type Provider, type SearchResult } from './search.js'
import { thumbSrc, VERTICALS, type Media, type MediaResult, type Vertical } from './verticals.js'

export const SITE = 'https://pit.world'

// Each asset URL carries a hash of its content, so a deploy that changes the CSS or
// JS reaches returning visitors on their next page load instead of an hour later
// (browser cache) or never (the service worker keeps whatever it stored first).
const asset = (name: string) => {
  const body = readFileSync(new URL(`../public/${name}`, import.meta.url))
  return `/${name}?v=${createHash('sha256').update(body).digest('hex').slice(0, 10)}`
}
// The footer's own links; the ring nav and copyright come from @profullstack/footer.
setRingFooterOptions(
  ringFooterOptions([
    { label: 'Account', href: '/account' },
    { label: 'Privacy', href: '/privacy' },
    { label: 'Connect to Moshpit', href: '/connect' },
    { label: 'Start building', href: '/start' },
    { label: 'Build an app', href: '/build' },
    { label: 'Promoter program', href: '/promote' },
    { label: 'Find a pro', href: '/pros' },
    { label: 'Claim your listing', href: '/b' },
    { label: 'How it works', href: '/about' },
    { label: 'API · CLI · MCP', href: '/about#api' },
    { label: 'Web ring', href: '/ring' },
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
 * (proxy.ts) serves other people's sites and never gets either. Neither runs on search
 * results, whose URL is the query. Ads are a cross-origin sandboxed iframe, so
 * the ad sees pit.world's origin and nothing else. CRAWLPROOF_AD_SLOT=off turns ads off.
 */
const TRACKER_SITE = '81a8a3cd-8d5b-4c5f-bb29-c21a1bbb6a05'
export const AD_SLOT = process.env.CRAWLPROOF_AD_SLOT ?? '782907b4-bf27-44bf-b202-df196c4b207e'
export const adUnit = (format: 'banner_300x250' | 'text_link' = 'banner_300x250') =>
  AD_SLOT === 'off' ? '' : `<div class="ad-unit ad-${format}"><iframe src="https://crawlproof.com/api/ads/frame?slot=${encodeURIComponent(AD_SLOT)}&amp;format=${format}" title="Advertisement" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" scrolling="no"></iframe></div>`

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
<link rel="search" type="application/opensearchdescription+xml" title="pit.world" href="/opensearch.xml">
<link rel="alternate" type="application/atom+xml" title="New on pit.world" href="/b/feed.xml">
${options.head ?? ''}<link rel="stylesheet" href="${STYLE_URL}">
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

export function newsletterForm(): string {
  return `<section id="newsletter" class="newsletter">
  <p class="kicker">The pit.world newsletter</p>
  <h2>What's new on pit.world and the Moshpit network.</h2>
  <p class="lede">About once a month. You confirm by email before anything is sent, and every issue has a one-click unsubscribe. Your address is the only thing pit.world will ever keep, and only if you click the link.</p>
  <form class="subscribe" action="/subscribe" method="post">
    <input name="email" type="email" placeholder="you@example.com" aria-label="Email address" autocomplete="email" maxlength="254" required>
    <input class="hp" name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">
    <button type="submit">Subscribe</button>
  </form>
</section>`
}

export function homePage(stats: NetworkStats | null, options: { newsletter?: boolean } = {}): string {
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
  ${adUnit()}
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

/** All · Images · Videos · Music · Live, each the same query in another index. */
function tabs(query: string, active: Vertical): string {
  return `<nav class="tabs" aria-label="Search type">${VERTICALS.map((v) => {
    const href = `/search?q=${encodeURIComponent(query)}${v.id === 'web' ? '' : `&t=${v.id}`}`
    return v.id === active ? `<a href="${href}" aria-current="page">${v.label}</a>` : `<a href="${href}">${v.label}</a>`
  }).join('')}</nav>`
}

/** PairUX channels and nixamp streams, ours, ahead of everything else. */
function promoStrip(promos: Promo[], vertical: Vertical): string {
  if (!promos.length) return ''
  const label = vertical === 'live' ? 'Live on PairUX and nixamp' : vertical === 'music' ? 'Listen on nixamp' : 'Watch on PairUX and nixamp'
  return `<section class="promo" aria-label="${label}">
  <p class="kicker">${label}</p>
  <ul>${promos
    .map(
      (p) => `<li${p.live ? ' class="live"' : ''}>
    <a href="${esc(p.url)}" rel="noreferrer noopener"><span class="from">${p.source === 'pairux' ? 'PairUX' : 'nixamp'}</span>${p.live ? '<span class="dot">LIVE</span>' : ''}<b>${esc(p.title)}</b>${p.line ? `<small>${esc(p.line)}</small>` : ''}</a>
  </li>`,
    )
    .join('')}</ul>
</section>`
}

function thumb(m: Media, cls = 'thumb'): string {
  const src = thumbSrc(m.thumbnail)
  return src ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : `<span class="${cls} none" aria-hidden="true"></span>`
}

function mediaList(vertical: Exclude<Vertical, 'web'>, hits: Media[]): string {
  if (vertical === 'images') {
    return `<ul class="images">${hits
      .map((m) => `<li><a href="${esc(m.url)}" rel="noreferrer noopener" title="${esc(m.title)}">${thumb(m)}<span>${esc(m.host)}</span></a></li>`)
      .join('')}</ul>`
  }
  if (vertical === 'music') {
    return `<ol class="hits">${hits
      .map(
        (m) => `<li>
      <a class="title" href="${esc(m.url)}" rel="noreferrer noopener">${esc(m.title)}</a>
      <div class="url">${esc(m.host)}</div>
      ${m.description ? `<p>${esc(m.description)}</p>` : ''}
    </li>`,
      )
      .join('')}</ol>`
  }
  return `<ol class="videos">${hits
    .map(
      (m) => `<li><a href="${esc(m.url)}" rel="noreferrer noopener">${thumb(m)}${m.duration ? `<span class="dur">${esc(m.duration)}</span>` : ''}</a>
    <div><a class="title" href="${esc(m.url)}" rel="noreferrer noopener">${esc(m.title)}</a>
    <div class="url">${esc([m.host, m.channel, m.date].filter(Boolean).join(' · '))}</div>
    ${m.description ? `<p>${esc(m.description)}</p>` : ''}</div></li>`,
    )
    .join('')}</ol>`
}

export function mediaPage(options: { query: string; vertical: Exclude<Vertical, 'web'>; result: MediaResult | null; promos: Promo[]; error: string | null }): string {
  const { query, vertical, result, promos, error } = options
  const hits = result?.hits ?? []
  const label = VERTICALS.find((v) => v.id === vertical)!.label
  const body = `<header class="bar">
  <a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>
  ${searchForm(query, false, vertical)}
</header>
${tabs(query, vertical)}
<main class="results ${vertical}">
  ${promoStrip(promos, vertical)}
  ${error ? `<p class="notice">${esc(error)}</p>` : ''}
  ${hits.length ? mediaList(vertical, hits) : ''}
  ${!error && hits.length === 0 ? `<p class="notice">No ${label.toLowerCase()} found. Try other words.</p>` : ''}
  ${result ? `<p class="via">${label} from the Google index, fetched by pit.world. Thumbnails are loaded through pit.world too, so Google and YouTube never see your IP address, browser or cookies.</p>` : ''}
</main>`
  return layout({ title: `${query} · ${label} · pit.world`, description: `Private ${label.toLowerCase()} results for ${query}`, path: '/search', body, bodyClass: 'serp', noindex: true, track: false })
}

export function resultsPage(options: { query: string; result: SearchResult | null; resolution: Resolution | null; error: string | null; card?: string }): string {
  const { query, result, resolution, error } = options
  const hits = result?.hits ?? []
  const domain = !resolution?.registered && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(query) ? query.toLowerCase() : null
  const body = `<header class="bar">
  <a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>
  ${searchForm(query)}
</header>
${tabs(query, 'web')}
<main class="results">
  ${resolution?.registered ? moshpitCard(resolution) : ''}
  ${options.card ?? ''}
  ${domain ? `<p class="go">Go straight to <a href="https://${esc(domain)}/" rel="noreferrer noopener">${esc(domain)}</a>${options.card ? '' : ` · <a href="/b/${encodeURIComponent(domain)}">business listing</a>`}</p>` : ''}
  ${error ? `<p class="notice">${esc(error)}</p>` : ''}
  <ol class="hits">
    ${hits
      .map(
        (h) => `<li>
      <a class="title" href="${esc(h.url)}" rel="noreferrer noopener">${esc(h.title)}</a>
      <div class="url">${esc(h.host)}${(h.sources ?? []).map((src) => `<span class="src">${esc(LABELS[src] ?? src)}</span>`).join('')}</div>
      ${h.description ? `<p>${esc(h.description)}</p>` : ''}
    </li>`,
      )
      .join('')}
  </ol>
  ${!error && hits.length === 0 ? '<p class="notice">Nothing found. Try other words, or a bang like <code>!ddg</code>.</p>' : ''}
  <p class="elsewhere">Try this search on <a href="/search?q=${encodeURIComponent(`${query} !ddg`)}">DuckDuckGo</a>, <a href="/search?q=${encodeURIComponent(`${query} !b`)}">Brave</a> or <a href="/search?q=${encodeURIComponent(`${query} !g`)}">Google</a>, without a referrer.</p>
  ${result?.provider ? `<p class="via">Results from the ${result.provider.split('+').map((p) => LABELS[p as Provider] ?? p).join(' and ')} ${result.provider.includes('+') ? 'indexes' : 'index'}, fetched by pit.world and merged. Your IP address, browser and cookies were not sent.</p>` : ''}
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
<li><b>Cookies, to search.</b> Searching sets none and reads none. The only cookie pit.world ever sets is the sign-in one, and only after you press Sign in (below).</li>
<li><b>Your searches, to anyone else.</b> Search results pages load nothing from a third party.</li>
</ul>
<h2 id="analytics">Analytics and ads, outside search</h2>
<p>pit.world's other pages (this one, the home page, the docs) load <a href="https://crawlproof.com">crawlproof</a>'s page-view counter and show a crawlproof ad in a sandboxed frame. The counter reports the page address and keeps a random visitor id in your browser's local storage (not a cookie); neither one runs on search results, so neither ever sees a query. The ad frame is told only that it is on pit.world. Fonts and every other script still come from pit.world.</p>
<h2>What happens to a search</h2>
<ol>
<li>Your browser sends the words to pit.world over HTTPS.</li>
<li>pit.world asks the Google index (through Serper) and the Bing index (through DataForSEO) for results and merges them. The providers receive the words from our server: not your IP, browser, cookies or referrer.</li>
<li>To avoid paying twice for a popular search, identical searches are answered from memory for up to ten minutes. That cache holds the words and the results, nothing about who asked, never touches disk, and empties on restart.</li>
<li>Result links go straight to the site, with no redirect through us and <code>no-referrer</code>, so the site does not learn what you searched for.</li>
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
<p>One pit.world account signs you in on every <code>social.&lt;name&gt;.pit.world</code> feed and <code>bbs.&lt;name&gt;.pit.world</code> board, so you never make an account per site. You sign in with CoinPay (OAuth 2.1). We keep your CoinPay id, the name and email CoinPay gives us, a session cookie for <code>pit.world</code> only, and the list of pit.world sites you signed in to, which you can see and clear on <a href="/account">your account page</a>. A site gets your CoinPay id and name, nothing else. Search never reads the cookie. Delete the account from the same page and it is gone; what you posted on a board or feed stays there until you delete it on that site.</p>
<h2>Source</h2>
<p>The code that does all of this is public: <a href="https://github.com/moshcoder/pit.world">github.com/moshcoder/pit.world</a>.</p>
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
${adUnit()}
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

/** The page after a signup or a confirmation click. One page per outcome, never one that says who is on the list. */
export function newsletterPage(kind: 'check' | 'invalid' | 'undeliverable' | 'failed' | 'limited' | 'confirmed' | 'expired'): string {
  const copy = {
    check: ['Check your inbox', 'If that address can get the newsletter, a confirmation link is on its way. Click it within 48 hours to join; otherwise the address is forgotten.'],
    invalid: ["That doesn't look like an email address", 'Check it and try again.'],
    undeliverable: ["That domain can't receive email", 'There is no mail server for it. Check the spelling after the @.'],
    failed: ["We couldn't send the confirmation", 'Our email provider did not take the message. Please try again in a few minutes.'],
    limited: ['Slow down a little', 'Too many requests from your connection. Try again in a minute.'],
    confirmed: ["You're on the list", 'Thanks. The next issue comes to your inbox, and each one has a one-click unsubscribe.'],
    expired: ['That link has expired', 'Confirmation links work once, for 48 hours. Sign up again and use the new link.'],
  }[kind]
  const retry = kind === 'invalid' || kind === 'undeliverable' || kind === 'failed' || kind === 'expired'
  return layout({
    title: `${copy[0]} · pit.world`,
    description: 'The pit.world newsletter.',
    path: '/subscribe',
    bodyClass: 'doc',
    noindex: true,
    body: `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm()}</header>
<main class="prose">
<h1>${esc(copy[0])}</h1>
<p>${esc(copy[1])}</p>
${retry ? newsletterForm() : '<p><a class="btn" href="/">Back to search</a></p>'}
</main>`,
  })
}

export function buildPage(): string {
  return layout({
    title: 'Build an app: $49, then $2 a month to keep it online · pit.world',
    description: 'Describe an app in plain words. AI agents build it on the open source Profullstack stack, you approve it, and it stays online for $2 a month. Paid in crypto through CoinPay.',
    path: '/build',
    bodyClass: 'doc',
    body: `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm()}</header>
<main class="prose build">
<p class="kicker">Build an app</p>
<h1>Describe it. We build it. $2 a month keeps it online.</h1>
<p class="lede">Tell an AI product team what you want, in your own words. It writes a plan you can argue with, builds the app on the open source <a href="${LINKS.stack}">Profullstack stack</a>, and shows you it working before anything launches. Then it stays online for $2 a month.</p>

<form class="idea" action="${LINKS.chovyStart}" method="get">
  <label for="idea">What should it do?</label>
  <textarea id="idea" name="idea" rows="5" maxlength="2000" required placeholder="A booking page for my barbershop: customers pick a barber and a time, pay a deposit, and get a text reminder the day before."></textarea>
  <input type="hidden" name="plan" value="starter">
  <input type="hidden" name="ref" value="pitworld">
  <button class="btn" type="submit">Start building →</button>
  <p class="small">You continue on chovy.com, where the agents work. Your idea is sent there, not kept here.</p>
</form>

<div class="prices">
  <div><b>$49</b><span>once, to build it</span><p>One small app: pages, a database, sign-in and payments where it needs them, on your own subdomain.</p></div>
  <div><b>$2</b><span>a month, to keep it online</span><p>Hosting for that one app. Stop paying and it is paused, not deleted; pay again and it is back.</p></div>
</div>
<p>Both are paid in crypto through <a href="https://coinpayportal.com">CoinPay</a>. No card, no account with a payment company.</p>

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
    title: 'Start building here: your sites on a Moshpit server, $5 a month · pit.world',
    description: 'Claim a Moshpit name, build your site, and deploy it to a Moshpit server: $5 a month for unlimited sites, paid in crypto through pay.agent or CoinPay.',
    path: '/start',
    bodyClass: 'doc',
    body: `<header class="bar"><a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>${searchForm()}</header>
<main class="prose build">
<p class="kicker">Start building here</p>
<h1>Your name, your sites, one server. $5 a month.</h1>
<p class="lede">A Moshpit server hosts as many sites as you put on it for $5 a month. Every one opens at its own Moshpit name, and at <code>name.pit.world</code> for everyone else, with nothing to install.</p>

<div class="prices">
  <div><b>$5</b><span>a month, per server</span><p>Unlimited sites. Stop paying and the server is paused, not deleted.</p></div>
  <div><b>Crypto</b><span>no card</span><p>Pay through <a href="${LINKS.payAgent}">pay.agent</a> on Moshpit, or <a href="${LINKS.payClearnet}">CoinPay</a> on the clearnet.</p></div>
</div>

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
<li><b>Pay $5 for the month.</b> On Moshpit DNS, use <a href="${pay}">pay.agent/profullstack</a>; on the clearnet, pay through <a href="${LINKS.payClearnet}">coinpayportal.com</a>. In the note, put the names you want served, the username you want, and your SSH public key (<code>cat ~/.ssh/id_ed25519.pub</code>).</li>
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
