/**
 * <name>.pit.world: any Moshpit name, on the old internet.
 *
 * family.ancestry opens only for a visitor on Moshpit DNS. family.ancestry.pit.world
 * opens in any browser: nginx sends every *.pit.world host here, we ask the registry
 * where the name lives, connect to that address with the name as SNI and Host, and
 * trust only the Moshpit root, exactly as a visitor on Moshpit would.
 *
 * Unlike the registry gateway (pit.moshcode.sh/n/<name>, the homepage only) this is
 * the whole site: every path and method, request bodies, and cookies, so an app with
 * sign-in works. To make that true we rewrite the few places the name shows through:
 * Location headers, cookie Domain attributes, absolute links in HTML, and the Origin
 * and Referer the browser sends back (so the site's own CSRF checks still pass).
 *
 * Every proxied page ends with a short footer on joining Moshpit, so the visitor
 * learns they can open the name directly.
 *
 * Certificates: a TLS wildcard covers one label, and these hosts have at least two
 * (family.ancestry.pit.world), so each name gets its own Let's Encrypt certificate.
 * nginx picks it by SNI. A name without one is issued on its first plain-http visit,
 * capped well under Let's Encrypt's 50 a week for pit.world.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { isPublicAddress, normalizeDomain, type MoshpitAccess } from './listings.js'

export const PROXY_SUFFIX = '.pit.world'
const ASSET = '/.pit/proxy.css'
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length', 'accept-encoding'])
const MAX_REWRITE = 8 * 1024 * 1024

/** The Moshpit name a *.pit.world host stands for, or null for pit.world itself and anything that is not label.ending. */
export function proxiedName(host: string | null | undefined): string | null {
  const h = String(host ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  if (!h.endsWith(PROXY_SUFFIX)) return null
  const name = h.slice(0, -PROXY_SUFFIX.length)
  if (!name.includes('.') || name.startsWith('www.') || name.length > 240) return null
  // Moshpit endings need not look like ICANN ones (.2600 and .1337 exist), so only the label rules apply.
  return name.split('.').every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) ? name : null
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** https://name/... and http://name/... become https://name.pit.world/...; other hosts are left alone. */
export function rewriteUrls(text: string, name: string, proxyHost: string): string {
  return text.replace(new RegExp(`(https?:)?//${escapeRe(name)}(?![a-z0-9.-])(:\\d+)?`, 'gi'), (_m, scheme) => `${scheme ? 'https:' : ''}//${proxyHost}`)
}

/** The other way, for what the browser sends back (Origin, Referer). */
export function unrewriteUrl(value: string, name: string, proxyHost: string): string {
  return value.replace(new RegExp(`^https?://${escapeRe(proxyHost)}(?![a-z0-9.-])`, 'i'), `https://${name}`)
}

/** Drop Domain= so the cookie belongs to this one proxied host and never to pit.world or a sibling. */
export function rewriteCookie(cookie: string): string {
  return cookie.replace(/;\s*domain=[^;]*/gi, '')
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)

/** The footer every proxied page ends with. */
export function joinFooter(name: string): string {
  return `<aside class="pit-proxy" aria-label="About this address">
<p><strong>You are reading ${esc(name)} through pit.world.</strong> ${esc(name)} is a Moshpit name: an address on a namespace beside the old one, where anyone can own an ending like <code>.${esc(name.split('.').pop())}</code>. This copy works in any browser. On Moshpit you open <code>https://${esc(name)}</code> itself.</p>
<p><strong>Join Moshpit, about two minutes:</strong></p>
<ol>
<li>Turn on secure DNS in your browser (Chrome, Edge, Brave: Settings, Privacy and security, Use secure DNS, Custom; Firefox: Settings, Privacy &amp; Security, DNS over HTTPS) and enter <code>https://dns.moshcode.sh/dns-query</code>.</li>
<li>Install the Moshpit certificate so the padlock shows: <a href="https://pit.world/moshpit-root-ca.crt">pit.world/moshpit-root-ca.crt</a>.</li>
<li>Open <code>https://${esc(name)}</code>.</li>
</ol>
<p>Every device, step by step, and how to undo it: <a href="https://pit.world/connect">pit.world/connect</a>. Or install moshcode: <code>curl -fsSL https://moshcode.sh/install.sh | sh</code>.</p>
</aside>`
}

/** Link our stylesheet and add the footer; both survive pages with no </head> or </body>. */
export function decorate(html: string, name: string, proxyHost: string): string {
  let out = rewriteUrls(html, name, proxyHost)
  const link = `<link rel="stylesheet" href="${ASSET}">`
  out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${link}\n</head>`) : `${link}\n${out}`
  const footer = joinFooter(name)
  const at = out.search(/<\/body>(?![\s\S]*<\/body>)/i)
  return at >= 0 ? `${out.slice(0, at)}${footer}\n${out.slice(at)}` : `${out}\n${footer}`
}

export const PROXY_CSS = `.pit-proxy{all:initial;display:block;box-sizing:border-box;margin:32px auto 0;padding:18px 20px 20px;max-width:760px;border-top:2px solid #4d8a00;font:14px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#2a3324;background:#f4f8ee}
.pit-proxy *{box-sizing:border-box;font:inherit;color:inherit}
.pit-proxy p,.pit-proxy ol{margin:0 0 8px;display:block}.pit-proxy ol{padding-left:22px}.pit-proxy li{display:list-item;margin:2px 0}
.pit-proxy strong{font-weight:700}.pit-proxy a{color:#2f6b00;text-decoration:underline}
.pit-proxy code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;background:#e4eed8;padding:.05em .3em;border-radius:4px;overflow-wrap:anywhere}
@media (prefers-color-scheme:dark){.pit-proxy{color:#dfe8d8;background:#10140d;border-top-color:#a6ff1a}.pit-proxy a{color:#c4ff6b}.pit-proxy code{background:#1d2419}}
`

export type Certs = {
  /** True when nginx has a certificate for this host. */
  has(host: string): boolean
  /** Ask for one in the background; false when refused (cap reached, or asked recently). */
  issue(host: string): boolean
}

/** Certificates under /etc/letsencrypt/live, issued by /usr/local/bin/pit-proxy-cert. */
export function liveCerts(options: { dir?: string; served?: string; command?: string; weeklyCap?: number } = {}): Certs {
  const dir = options.dir ?? '/etc/letsencrypt/live'
  const command = options.command ?? '/usr/local/bin/pit-proxy-cert'
  const cap = options.weeklyCap ?? 30
  const asked = new Map<string, number>()
  const issuedThisWeek = () => {
    try {
      const weekAgo = Date.now() - 7 * 86_400_000
      return readdirSync(dir).filter((d) => d.endsWith(PROXY_SUFFIX) && statSync(`${dir}/${d}`).mtimeMs > weekAgo).length
    } catch {
      return cap
    }
  }
  return {
    // The copy nginx serves from (pit-proxy-cert makes it), not certbot's original.
    has: (host) => existsSync(`${options.served ?? '/etc/nginx/pit-proxy-certs'}/${host}.crt`),
    issue(host) {
      if (Date.now() - (asked.get(host) ?? 0) < 3_600_000 || issuedThisWeek() + asked.size >= cap || !existsSync(command)) return false
      asked.set(host, Date.now())
      // The host was built from a validated Moshpit name, and spawn passes it as one argument, never through a shell.
      spawn(command, [host], { stdio: 'ignore', detached: true }).unref()
      return true
    },
  }
}

type Target = { address: string }
const targets = new Map<string, { at: number; value: Target | null }>()

/** Where a name lives: the registry's target, every address public. Cached a minute. */
async function targetFor(name: string, access: MoshpitAccess): Promise<Target | null> {
  const hit = targets.get(name)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  let value: Target | null = null
  const r = await access.resolve(name).catch(() => null)
  const raw = r?.nameRegistered ? String(r.target ?? '').trim().toLowerCase() : ''
  if (raw && isIP(raw)) value = isPublicAddress(raw) ? { address: raw } : null
  else if (raw) {
    const host = normalizeDomain(raw)
    const addresses = host ? await lookup(host, { all: true }).catch(() => []) : []
    if (addresses.length && addresses.every((a) => isPublicAddress(a.address))) value = { address: addresses[0]!.address }
  }
  targets.set(name, { at: Date.now(), value })
  return value
}

const page = (status: number, title: string, body: string, extra: Record<string, string> = {}) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="stylesheet" href="${ASSET}"></head><body><main class="pit-proxy"><h1>${esc(title)}</h1>${body}</main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...extra } },
  )

export type ProxyDeps = { access: MoshpitAccess; certs: Certs }

/** Answer a request for <name>.pit.world. `proto` is the scheme the visitor used, as nginx reports it. */
export async function proxyRequest(request: Request, name: string, ip: string, proto: string, deps: ProxyDeps): Promise<Response> {
  const url = new URL(request.url)
  const proxyHost = `${name}${PROXY_SUFFIX}`
  if (url.pathname === ASSET) return new Response(PROXY_CSS, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' } })

  const target = await targetFor(name, deps.access)
  if (!target)
    return page(404, `${name} is not on Moshpit`, `<p>No Moshpit name <code>${esc(name)}</code> points anywhere yet. Claim it, or look around: <a href="https://pit.world/">pit.world</a>.</p>`)

  // Plain http: send the visitor to https, making the certificate first if this name has none yet.
  if (proto !== 'https') {
    if (deps.certs.has(proxyHost)) return Response.redirect(`https://${proxyHost}${url.pathname}${url.search}`, 301)
    deps.certs.issue(proxyHost)
    return page(503, `Setting up ${proxyHost}`, `<p>This is the first visit to <code>${esc(name)}</code> through pit.world, so its secure address is being made. It takes about a minute; this page checks again on its own.</p>`, { refresh: '30', 'retry-after': '30' })
  }

  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    if (HOP.has(key) || key.startsWith('x-forwarded-') || key === 'x-real-ip') return
    headers[key] = key === 'origin' || key === 'referer' ? unrewriteUrl(value, name, proxyHost) : value
  })
  Object.assign(headers, {
    host: name,
    // Uncompressed, so HTML can be rewritten; nginx compresses on the way out.
    'accept-encoding': 'identity',
    'x-forwarded-host': proxyHost,
    'x-forwarded-proto': 'https',
    'x-forwarded-for': ip,
    'x-real-ip': ip,
    // Same signal the registry gateway sends: the visitor is not on Moshpit DNS (member sites use it for the ring bar).
    'x-moshpit-name': name,
  })

  const root = deps.access.rootPem
  const upstream = await new Promise<import('node:http').IncomingMessage | Error>((resolve) => {
    // threatcrush-disable-next-line js-ssrf-outbound-request  the address is the registry target's, checked public; TLS must chain to the Moshpit root for this name
    const req = httpsRequest({ host: target.address, port: 443, method: request.method, path: `${url.pathname}${url.search}`, servername: name, ca: root, headers, timeout: 60_000 }, resolve)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', resolve)
    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') Readable.fromWeb(request.body as any).pipe(req)
    else req.end()
  })
  if (upstream instanceof Error)
    return page(502, `${name} did not answer`, `<p>pit.world reached the registry, but <code>${esc(name)}</code> itself did not answer. Try again in a moment.</p>`)

  const out = new Headers()
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (value === undefined || HOP.has(key) || key === 'content-encoding') continue
    if (key === 'set-cookie') for (const c of value as string[]) out.append(key, rewriteCookie(c))
    else if (key === 'location') out.set(key, rewriteUrls(String(value), name, proxyHost))
    else out.set(key, Array.isArray(value) ? value.join(', ') : String(value))
  }
  const status = upstream.statusCode ?? 502
  const isHtml = String(upstream.headers['content-type'] ?? '').includes('text/html')
  const length = Number(upstream.headers['content-length'] ?? 0)
  if (request.method === 'HEAD' || status === 204 || status === 304) {
    upstream.resume()
    return new Response(null, { status, headers: out })
  }
  if (isHtml && length <= MAX_REWRITE) {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of upstream) {
      size += chunk.length
      if (size > MAX_REWRITE) break
      chunks.push(chunk)
    }
    if (size <= MAX_REWRITE) return new Response(decorate(Buffer.concat(chunks).toString('utf8'), name, proxyHost), { status, headers: out })
    upstream.destroy()
    return page(502, `${name} sent too much`, `<p>That page is larger than pit.world will relay.</p>`)
  }
  return new Response(Readable.toWeb(upstream) as unknown as ReadableStream, { status, headers: out })
}
