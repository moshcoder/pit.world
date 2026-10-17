/**
 * Server-rendered pages. Every page works with JavaScript off (Tor Browser on
 * "Safest" included); /app.js only adds keyboard shortcuts.
 */
import { BANGS } from './bangs.js'
import { LINKS, type NetworkStats, type Resolution } from './moshpit.js'
import type { SearchResult } from './search.js'

export const SITE = 'https://pit.world'

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)

const fmt = (n: number) => n.toLocaleString('en-US')

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

// A wink: nobody's watching, and we're in on it.
const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 18.5c2.5 5.5 11.5 5.5 14 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M9 12.6h5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="20.5" cy="12.5" r="2.2" fill="currentColor"/></svg>`

function layout(options: { title: string; description: string; path: string; body: string; bodyClass?: string; noindex?: boolean }): string {
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
<link rel="search" type="application/opensearchdescription+xml" title="pit.world" href="/opensearch.xml">
<link rel="stylesheet" href="/style.css">
<script src="/app.js" defer></script>
</head>
<body class="${options.bodyClass ?? ''}">
${options.body}
<footer class="foot">
  <nav>
    <a href="/privacy">Privacy</a>
    <a href="/about">How it works</a>
    <a href="/about#default">Make it your default</a>
    <a href="/about#bangs">Bangs</a>
    <a href="/about#api">API · CLI · MCP</a>
    <a href="${LINKS.registry}">Moshpit registry</a>
    <a href="${LINKS.moshcode}">moshcode</a>
  </nav>
  <p>No logs. No cookies. No profile. Part of the <a href="/#moshpit">Moshpit network</a>.</p>
</footer>
</body>
</html>`
}

function searchForm(query = '', autofocus = false): string {
  return `<form class="search" action="/search" method="get" role="search">
  <input name="q" type="search" value="${esc(query)}" placeholder="Search privately, or try chovy.hacker" aria-label="Search" autocomplete="off" spellcheck="false"${autofocus ? ' autofocus' : ''} maxlength="512" required>
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
${esc(LINKS.enable)}</code></pre><p>Or point your browser's secure DNS at <code>${esc(LINKS.doh)}</code>, no install at all.</p></div>
    <div><span>2</span><h4>Claim an ending</h4><p>Pick one nobody has, and it is yours: every name under it, forever, in a log anyone can audit.</p><p><a class="btn" href="${LINKS.claim}">Claim an ending →</a></p></div>
    <div><span>3</span><h4>Search it here</h4><p>Type a Moshpit name into pit.world and it resolves through the registry, next to your web results.</p></div>
  </div>
  ${recent}
  ${sale}
  <p class="links"><a href="${LINKS.registry}">Registry</a> · <a href="${LINKS.moshcode}">moshcode</a> · <a href="${LINKS.moshcoding}">moshcoding.com</a> · <a href="${LINKS.source}">Source</a></p>
</section>`
}

export function homePage(stats: NetworkStats | null): string {
  return layout({
    title: 'pit.world: private search, and the doorway to the Moshpit network',
    description: 'Search the web without being the product. No logs, no cookies, no profile, no JavaScript required. And search the Moshpit network, the namespace ICANN didn\'t sell you.',
    path: '/',
    bodyClass: 'home',
    body: `<main>
  <header class="hero">
    <a class="brand big" href="/">${LOGO}<span>pit<i>.</i>world</span></a>
    <p class="tag">Search like nobody's watching. Because nobody is.</p>
    ${searchForm('', true)}
    <ul class="promises">
      <li><b>No logs</b> of what you search</li>
      <li><b>No cookies</b>, none, ever</li>
      <li><b>No profile</b> to sell</li>
      <li><b>No JavaScript</b> required</li>
    </ul>
    <p class="default"><a href="/about#default">Make pit.world your default search →</a></p>
  </header>
  ${networkPanel(stats)}
</main>`,
  })
}

function moshpitCard(resolution: Resolution): string {
  const live = resolution.nameRegistered || resolution.registered
  return `<aside class="card mosh">
  <p class="kicker">Moshpit name</p>
  <h2><a href="https://${esc(resolution.name)}/" rel="noreferrer noopener">${esc(resolution.name)}</a></h2>
  <p>${live ? `Registered on the Moshpit network${resolution.target ? `, pointing at <code>${esc(resolution.target)}</code>` : ''}.` : 'Not registered yet: it could be yours.'}</p>
  <p class="row"><a class="btn" href="${esc(resolution.page)}">${live ? 'Registry page' : 'Claim it'}</a>
  <a href="/#moshpit">How to open Moshpit names →</a></p>
</aside>`
}

export function resultsPage(options: { query: string; result: SearchResult | null; resolution: Resolution | null; error: string | null }): string {
  const { query, result, resolution, error } = options
  const hits = result?.hits ?? []
  const domain = !resolution?.registered && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(query) ? query.toLowerCase() : null
  const body = `<header class="bar">
  <a class="brand" href="/">${LOGO}<span>pit<i>.</i>world</span></a>
  ${searchForm(query)}
</header>
<main class="results">
  ${resolution && (resolution.registered || resolution.nameRegistered) ? moshpitCard(resolution) : ''}
  ${domain ? `<p class="go">Go straight to <a href="https://${esc(domain)}/" rel="noreferrer noopener">${esc(domain)}</a></p>` : ''}
  ${error ? `<p class="notice">${esc(error)}</p>` : ''}
  <ol class="hits">
    ${hits
      .map(
        (h) => `<li>
      <a class="title" href="${esc(h.url)}" rel="noreferrer noopener">${esc(h.title)}</a>
      <div class="url">${esc(h.host)}</div>
      ${h.description ? `<p>${esc(h.description)}</p>` : ''}
    </li>`,
      )
      .join('')}
  </ol>
  ${!error && hits.length === 0 ? '<p class="notice">Nothing found. Try other words, or a bang like <code>!ddg</code>.</p>' : ''}
  <p class="elsewhere">Try this search on <a href="/search?q=${encodeURIComponent(`${query} !ddg`)}">DuckDuckGo</a>, <a href="/search?q=${encodeURIComponent(`${query} !b`)}">Brave</a> or <a href="/search?q=${encodeURIComponent(`${query} !g`)}">Google</a>, without a referrer.</p>
  ${result?.provider ? `<p class="via">Results from the ${result.provider === 'serper' ? 'Google index' : result.provider} index, fetched by pit.world. Your IP address, browser and cookies were not sent.</p>` : ''}
</main>`
  return layout({ title: `${query} · pit.world`, description: `Private search results for ${query}`, path: '/search', body, bodyClass: 'serp', noindex: true })
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
<li><b>Cookies.</b> pit.world sets none. Your settings, when there are any, stay in your browser.</li>
<li><b>Trackers, analytics, ads, third-party scripts or fonts.</b> None. Every byte comes from pit.world.</li>
</ul>
<h2>What happens to a search</h2>
<ol>
<li>Your browser sends the words to pit.world over HTTPS.</li>
<li>pit.world asks one search provider for results (normally the Google index, through Serper). The provider receives the words from our server: not your IP, browser, cookies or referrer.</li>
<li>To avoid paying twice for a popular search, identical searches are answered from memory for up to ten minutes. That cache holds the words and the results, nothing about who asked, never touches disk, and empties on restart.</li>
<li>Result links go straight to the site, with no redirect through us and <code>no-referrer</code>, so the site does not learn what you searched for.</li>
</ol>
<h2>Moshpit names</h2>
<p>When a search looks like a name (<code>chovy.hacker</code>), pit.world also asks the public Moshpit registry whether it exists. That lookup is the name only, from our server.</p>
<h2>Bangs</h2>
<p><code>!gh hqtui</code> sends you to GitHub's own search. From that moment you are on their site, under their privacy policy; pit.world only redirects you there without a referrer.</p>
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
<p>A private front end to the web's search indexes, and a search engine for the Moshpit network. One search box, no account, no tracking.</p>

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
<p>Search a name like <code>chovy.hacker</code> and pit.world asks the Moshpit registry about it. To open Moshpit names in your browser, get on the network: <code>${esc(LINKS.install)}</code> then <code>${esc(LINKS.enable)}</code>, or set your browser's secure DNS to <code>${esc(LINKS.doh)}</code>.</p>

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
