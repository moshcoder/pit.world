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
 * Every proxied page ends with the pit.world global footer (footer.ts) unless the site
 * already prints it or the Profullstack footer; "How do I use this?" opens the steps
 * for opening the name directly.
 *
 * Certificates: a TLS wildcard covers one label, and these hosts have at least two
 * (family.ancestry.pit.world), so each name gets its own Let's Encrypt certificate.
 * nginx picks it by SNI. A name without one is issued on its first plain-http visit,
 * capped well under Let's Encrypt's 50 a week for pit.world.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { isPublicAddress, normalizeDomain, type MoshpitAccess } from './listings.js'
import { FOOTER_CSS, footerMarkup } from './footer.js'

export const PROXY_SUFFIX = '.pit.world'
const ASSET_PATH = '/.pit/proxy.css'
const ASSET = `${ASSET_PATH}?v=contrast-1`
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

/** The footer every proxied page ends with: the pit.world global footer (footer.ts). */
export function joinFooter(name: string): string {
  return footerMarkup({ name, moshpit: true })
}

/** Link our stylesheet and add the footer; both survive pages with no </head> or </body>. */
export function decorate(html: string, name: string, proxyHost: string): string {
  let out = rewriteUrls(html, name, proxyHost)
  const link = `<link rel="stylesheet" href="${ASSET}">`
  out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${link}\n</head>`) : `${link}\n${out}`
  // A site that already prints either shared footer keeps just its own copy.
  if (/\bdata-pit-footer\b/.test(out)) return out
  if (/\bdata-pfs-footer\b/.test(out)) return out
  const footer = joinFooter(name)
  const at = out.search(/<\/body>(?![\s\S]*<\/body>)/i)
  return at >= 0 ? `${out.slice(0, at)}${footer}\n${out.slice(at)}` : `${out}\n${footer}`
}

/** The info pages services.ts serves (a .pit-proxy panel), then the global footer. */
export const PROXY_CSS = `.pit-proxy{all:initial;display:block;box-sizing:border-box;margin:32px auto 0;padding:18px 20px 20px;max-width:760px;border-top:2px solid #4d8a00;font:14px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#2a3324;background:#f4f8ee}
.pit-proxy *{box-sizing:border-box;font:inherit;color:inherit}
.pit-proxy p,.pit-proxy ol{margin:0 0 8px;display:block}.pit-proxy ol{padding-left:22px}.pit-proxy li{display:list-item;margin:2px 0}
.pit-proxy strong{font-weight:700}.pit-proxy a{color:#2f6b00;text-decoration:underline}
.pit-proxy code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;background:#e4eed8;padding:.05em .3em;border-radius:4px;overflow-wrap:anywhere}
@media (prefers-color-scheme:dark){.pit-proxy{color:#dfe8d8;background:#10140d;border-top-color:#a6ff1a}.pit-proxy a{color:#c4ff6b}.pit-proxy code{background:#1d2419}}
${FOOTER_CSS}`

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

/** What the relay knows about a name: where it lives, that it does not exist, or that nobody could say just now. */
export type Lookup = { state: 'live'; target: Target; stale?: boolean } | { state: 'missing' } | { state: 'unreachable' }

/**
 * Where names live: the registry's target, every address public, cached a minute.
 *
 * The registry going down (its database restarting, a deploy) is not the names going
 * away. Every name ever resolved keeps its last good address, on disk when `file` is
 * given so a relay restarted mid-outage still has it, and is served from there while
 * the registry does not answer. Only the registry saying "not registered" is a 404.
 */
export class Targets {
  private fresh = new Map<string, { at: number; value: Target | null }>()
  private known: Record<string, { address: string; at: number }> = {}

  constructor(
    private readonly file?: string,
    private readonly resolveHost: (host: string) => Promise<{ address: string }[]> = (host) => lookup(host, { all: true }),
    private readonly now = () => Date.now(),
  ) {
    try {
      if (file && existsSync(file)) this.known = JSON.parse(readFileSync(file, 'utf8')) ?? {}
    } catch (e) {
      console.error(`relay targets: could not read ${file}: ${(e as Error).message}`)
    }
  }

  async get(name: string, access: MoshpitAccess): Promise<Lookup> {
    const hit = this.fresh.get(name)
    if (hit && this.now() - hit.at < 60_000) return hit.value ? { state: 'live', target: hit.value } : { state: 'missing' }
    const r = await access.resolve(name).catch(() => null)
    // No answer is not "no such name": serve what we last knew, and ask again next time.
    if (!r) return this.lastKnown(name)
    const raw = r.nameRegistered ? String(r.target ?? '').trim().toLowerCase() : ''
    let value: Target | null = null
    if (raw && isIP(raw)) value = isPublicAddress(raw) ? { address: raw } : null
    else if (raw) {
      const host = normalizeDomain(raw)
      const addresses = host ? await this.resolveHost(host).catch(() => null) : []
      // The target's own DNS failing is an outage too, not a verdict on the name.
      if (addresses === null) return this.lastKnown(name)
      if (addresses.length && addresses.every((a) => isPublicAddress(a.address))) value = { address: addresses[0]!.address }
    }
    this.fresh.set(name, { at: this.now(), value })
    this.remember(name, value)
    return value ? { state: 'live', target: value } : { state: 'missing' }
  }

  private lastKnown(name: string): Lookup {
    const k = this.known[name]
    return k ? { state: 'live', target: { address: k.address }, stale: true } : { state: 'unreachable' }
  }

  private remember(name: string, value: Target | null): void {
    const before = this.known[name]?.address ?? null
    if (value) this.known[name] = { address: value.address, at: this.now() }
    else delete this.known[name]
    if (!this.file || (value?.address ?? null) === before) return
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.known))
      renameSync(`${this.file}.tmp`, this.file)
    } catch (e) {
      console.error(`relay targets: could not write ${this.file}: ${(e as Error).message}`)
    }
  }
}

const defaultTargets = new Targets()

/** `label.ending` names in the registry's sitemap (`/n/<name>` URLs); bare endings are skipped. */
export function namesFromSitemap(xml: string): string[] {
  const names = new Set<string>()
  // One flat class (no nested quantifiers, so no backtracking); proxiedName() decides what is a label.ending name.
  for (const m of xml.matchAll(/\/n\/([a-z0-9.-]{1,253})<\/loc>/gi)) {
    const name = m[1]!.toLowerCase()
    if (proxiedName(`${name}${PROXY_SUFFIX}`) === name) names.add(name)
  }
  return [...names]
}

export type SweepDeps = {
  certs: Certs
  /** The registry's sitemap XML. */
  sitemap: () => Promise<string>
  /** Whether the relay can reach the name (the same check a visit makes). */
  reachable: (name: string) => Promise<boolean>
}

/**
 * Make certificates before anyone visits. pit.world sends HSTS with
 * includeSubDomains, so a browser that has seen pit.world goes straight to
 * https://<name>.pit.world and never makes the plain-http visit that used to
 * trigger issuance: a name with no certificate failed its TLS handshake for
 * every such visitor (live.streaming, 2026-10-18). This walks every name the
 * registry lists and asks for the ones the relay can serve; certs.issue keeps
 * the weekly cap and the once-an-hour-per-host guard.
 */
export async function sweepCerts(deps: SweepDeps): Promise<{ names: number; missing: string[]; asked: string[] }> {
  const names = namesFromSitemap(await deps.sitemap())
  const missing: string[] = []
  const asked: string[] = []
  for (const name of names) {
    const host = `${name}${PROXY_SUFFIX}`
    if (deps.certs.has(host)) continue
    if (!(await deps.reachable(name).catch(() => false))) continue
    missing.push(host)
    if (deps.certs.issue(host)) asked.push(host)
  }
  return { names: names.length, missing, asked }
}

/** The sweep against the live registry, as serve() runs it. */
export function registrySweep(
  access: MoshpitAccess,
  certs: Certs,
  registry = 'https://pit.moshcode.sh',
  targets: Targets = defaultTargets,
): () => Promise<{ names: number; missing: string[]; asked: string[] }> {
  return () =>
    sweepCerts({
      certs,
      sitemap: async () => {
        const res = await fetch(`${registry}/sitemap.xml`, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) throw new Error(`registry sitemap ${res.status}`)
        return res.text()
      },
      reachable: async (name) => (await targets.get(name, access)).state === 'live',
    })
}

const page = (status: number, title: string, body: string, extra: Record<string, string> = {}) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="stylesheet" href="${ASSET}"></head><body><main class="pit-proxy"><h1>${esc(title)}</h1>${body}</main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...extra } },
  )

export type ProxyDeps = { access: MoshpitAccess; certs: Certs; targets?: Targets }

/** Answer a request for <name>.pit.world. `proto` is the scheme the visitor used, as nginx reports it. */
export async function proxyRequest(request: Request, name: string, ip: string, proto: string, deps: ProxyDeps): Promise<Response> {
  const url = new URL(request.url)
  const proxyHost = `${name}${PROXY_SUFFIX}`
  if (url.pathname === ASSET_PATH) return new Response(PROXY_CSS, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' } })

  const found = await (deps.targets ?? defaultTargets).get(name, deps.access)
  if (found.state === 'unreachable')
    return page(503, 'Moshpit is catching its breath', `<p>The Moshpit registry is not answering right now, so pit.world cannot look up <code>${esc(name)}</code>. This page tries again on its own.</p>`, { refresh: '30', 'retry-after': '30' })
  if (found.state === 'missing')
    return page(404, `${name} is not on Moshpit`, `<p>No Moshpit name <code>${esc(name)}</code> points anywhere yet. Claim it, or look around: <a href="https://pit.world/">pit.world</a>.</p>`)
  const target = found.target

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
    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
      // pipe() does not forward errors: a visitor who disconnects mid-upload makes the body stream emit
      // AbortError ("The connection was closed"), and with no listener that kills the whole process.
      const body = Readable.fromWeb(request.body as any)
      body.on('error', (e) => req.destroy(e))
      body.pipe(req)
    } else req.end()
  })
  // An upstream that drops mid-response emits 'error' on the response stream; never let that be unhandled.
  if (!(upstream instanceof Error)) upstream.on('error', () => {})
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
