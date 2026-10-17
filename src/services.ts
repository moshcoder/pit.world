/**
 * social.<name>.pit.world and bbs.<name>.pit.world: every Moshpit name gets a
 * social feed and a bulletin board, with nothing to set up.
 *
 *   social.<name>.pit.world  one shared service (moshcoder/pit-social) for every
 *                            name: the AT Protocol posts tagged with the name's
 *                            niche, from every relay we can reach, plus members.
 *   bbs.<name>.pit.world     a tsbb board per name, made on its first visit by
 *                            /usr/local/bin/pit-bbs-provision (deploy/).
 *
 * Both sign people in with their pit.world account (src/accounts.ts), so nobody
 * makes an account per site. The name must exist in the Moshpit registry; it need
 * not point anywhere.
 *
 * Certificates: one per name covers <name>.pit.world, social.<name>.pit.world and
 * bbs.<name>.pit.world (deploy/pit-proxy-cert), so the three cost one of
 * Let's Encrypt's 50 a week.
 */
import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MoshpitAccess } from './listings.js'
import { PROXY_SUFFIX, type Certs } from './proxy.js'

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length'])

export type Board = { name: string; port: number; created_at: number }

/** Which name has a board, on which loopback port. The provisioner does the rest. */
export class Boards {
  readonly db: Database
  constructor(
    path: string,
    private options: { command?: string; max?: number; firstPort?: number; now?: () => number } = {},
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec('CREATE TABLE IF NOT EXISTS boards (name TEXT PRIMARY KEY, port INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL)')
  }

  board(name: string): Board | null {
    return this.db.query<Board, [string]>('SELECT * FROM boards WHERE name = ?').get(name)
  }

  list(): Board[] {
    return this.db.query<Board, []>('SELECT * FROM boards ORDER BY created_at').all()
  }

  /** Make a board for this name: a port, a row, and the provisioner in the background. Null when the cap is reached. */
  provision(name: string): Board | null {
    const existing = this.board(name)
    if (existing) return existing
    const max = this.options.max ?? 100
    const count = this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM boards').get()?.n ?? 0
    if (count >= max) return null
    const top = this.db.query<{ p: number | null }, []>('SELECT MAX(port) AS p FROM boards').get()?.p
    const port = Math.max(top ?? 0, (this.options.firstPort ?? 9100) - 1) + 1
    this.db.query('INSERT INTO boards (name, port, created_at) VALUES (?, ?, ?)').run(name, port, (this.options.now ?? Date.now)())
    const command = this.options.command ?? '/usr/local/bin/pit-bbs-provision'
    // The name was validated as DNS labels; spawn passes each argument as one, never through a shell.
    if (existsSync(command)) spawn(command, [name, String(port)], { stdio: 'ignore', detached: true }).unref()
    return this.board(name)
  }
}

export type ServiceDeps = {
  access: MoshpitAccess
  certs: Certs
  /** Where pit-social listens, e.g. http://127.0.0.1:8794; null switches social.* off. */
  socialUrl: string | null
  boards: Boards | null
  fetch?: typeof fetch
}

const names = new Map<string, { at: number; ok: boolean }>()

/** The name is registered on Moshpit (cached a minute). */
async function exists(name: string, access: MoshpitAccess): Promise<boolean> {
  const hit = names.get(name)
  if (hit && Date.now() - hit.at < 60_000) return hit.ok
  const r = await access.resolve(name).catch(() => null)
  const ok = Boolean(r?.nameRegistered)
  if (r) names.set(name, { at: Date.now(), ok })
  return ok
}

const page = (status: number, title: string, body: string, extra: Record<string, string> = {}) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="stylesheet" href="/.pit/proxy.css"></head><body><main class="pit-proxy"><h1>${esc(title)}</h1>${body}</main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...extra } },
  )

/** Pass the request to a loopback service, keeping Host so it knows which name it serves. */
async function forward(request: Request, upstream: string, host: string, name: string, ip: string, f: typeof fetch): Promise<Response | null> {
  const url = new URL(request.url)
  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (!HOP.has(key) && !key.startsWith('x-forwarded-') && key !== 'x-real-ip' && key !== 'x-pit-name') headers.set(key, value)
  })
  headers.set('host', host)
  headers.set('x-forwarded-host', host)
  headers.set('x-forwarded-proto', 'https')
  headers.set('x-forwarded-for', ip)
  headers.set('x-real-ip', ip)
  headers.set('x-pit-name', name)
  try {
    // threatcrush-disable-next-line js-ssrf-outbound-request  loopback only: our own services, address from config, never from the request
    const res = await f(`${upstream}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      redirect: 'manual',
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body, duplex: 'half' }),
      signal: AbortSignal.timeout(60_000),
    } as RequestInit)
    const out = new Headers(res.headers)
    out.delete('content-encoding')
    out.delete('content-length')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
  } catch {
    return null
  }
}

/** Answer a request for social.<name>.pit.world or bbs.<name>.pit.world. */
export async function serviceRequest(request: Request, svc: { service: 'social' | 'bbs'; name: string; host: string }, ip: string, proto: string, deps: ServiceDeps): Promise<Response> {
  const url = new URL(request.url)
  const { service, name, host } = svc
  const f = deps.fetch ?? fetch
  if (url.pathname === '/.pit/proxy.css') {
    const { PROXY_CSS } = await import('./proxy.js')
    return new Response(PROXY_CSS, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' } })
  }
  if (!(await exists(name, deps.access)))
    return page(404, `${name} is not on Moshpit`, `<p>There is no Moshpit name <code>${esc(name)}</code>, so there is no ${service === 'bbs' ? 'board' : 'social feed'} for it either. Claim it, or look around: <a href="https://pit.world/">pit.world</a>.</p>`)

  if (proto !== 'https') {
    if (deps.certs.has(host)) return Response.redirect(`https://${host}${url.pathname}${url.search}`, 301)
    // One certificate covers the name and both of its services.
    deps.certs.issue(`${name}${PROXY_SUFFIX}`)
    return page(503, `Setting up ${host}`, `<p>This is the first visit to <code>${esc(host)}</code>, so its secure address is being made. It takes about a minute; this page checks again on its own.</p>`, { refresh: '30', 'retry-after': '30' })
  }

  if (service === 'social') {
    if (!deps.socialUrl) return page(404, 'Not here yet', '<p>Social feeds are switched off on this instance.</p>')
    const res = await forward(request, deps.socialUrl, host, name, ip, f)
    return res ?? page(503, `social.${name} is restarting`, '<p>Back in a few seconds; this page checks again on its own.</p>', { refresh: '10', 'retry-after': '10' })
  }

  if (!deps.boards) return page(404, 'Not here yet', '<p>Boards are switched off on this instance.</p>')
  const board = deps.boards.board(name) ?? deps.boards.provision(name)
  if (!board) return page(503, 'No more boards for now', `<p>pit.world has made as many boards as it can for the moment. Try again in a day or two.</p>`, { 'retry-after': '86400' })
  const res = await forward(request, `http://127.0.0.1:${board.port}`, host, name, ip, f)
  return (
    res ??
    page(503, `Setting up the board for ${name}`, `<p>The <b>${esc(name)}</b> board is starting (the first time takes about a minute). This page checks again on its own. Everyone signs in with their <a href="https://pit.world/account">pit.world account</a>.</p>`, { refresh: '15', 'retry-after': '15' })
  )
}
