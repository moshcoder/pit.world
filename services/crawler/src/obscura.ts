/**
 * Rendering through Obscura (github.com/h4ckf0r0day/obscura), a headless
 * browser served as an MCP server (`obscura mcp --http`, bearer token from
 * OBSCURA_MCP_TOKEN). One server holds one page, so a client renders one
 * address at a time; more rendering means more Obscura servers.
 *
 * What comes back is a small JSON object, not the page's whole outerHTML:
 * a big evaluate result breaks the MCP reply, so the head (where the tags
 * live, capped), the visible text and the links are asked for separately
 * and put back together as a document the extractor reads like any other.
 */

import { CRAWL_RENDER_SETTLE_MS, CRAWL_RENDER_TIMEOUT_MS } from './config.ts'

export type Rendered = { url: string; html: string }

/**
 * Trouble on our side of the render (Obscura unreachable, a dropped session, a JSON-RPC
 * error): never the target's fault, so never a reason to park it. `ours` tells failureKind.
 */
export class ObscuraError extends Error {
  override name = 'ObscuraError'
  readonly ours = true
}

/** A render that ran out of CRAWL_RENDER_TIMEOUT_MS: a failure to record, never a page. */
export class RenderTimeout extends Error {
  override name = 'TimeoutError'
  constructor(url: string, ms: number) {
    super(`render timed out after ${Math.round(ms / 1000)} s: ${url}`)
  }
}

type Fetch = typeof fetch

const EXPRESSION = `(() => {
  const d = document;
  const links = Array.from(d.querySelectorAll('a[href]')).slice(0, 1500).map((a) => [a.href, a.rel || '']);
  return JSON.stringify({
    url: location.href,
    lang: d.documentElement.lang || '',
    head: d.head ? d.head.outerHTML.slice(0, 120000) : '',
    text: d.body ? (d.body.innerText || '').slice(0, 80000) : '',
    main: (() => { const m = d.querySelector('main, article, [role="main"]'); return m ? (m.innerText || '').slice(0, 80000) : ''; })(),
    links,
  });
})()`

/** The read back, after a bounded settle: `load` has fired, a late script gets this long, then we read. */
export const SETTLED_EXPRESSION = (settleMs: number) =>
  `new Promise((resolve) => setTimeout(resolve, ${Math.max(0, Math.min(2_000, Math.floor(settleMs)))})).then(() => ${EXPRESSION})`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The evaluate result as HTML: head verbatim, text as paragraphs, links as anchors. */
export function documentFrom(parts: { lang?: string; head?: string; text?: string; main?: string; links?: Array<[string, string]> }): string {
  const paragraphs = (text: string) =>
    text
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${esc(p)}</p>`)
      .join('')
  const main = parts.main ? `<main>${paragraphs(parts.main)}</main>` : ''
  const rest = parts.main ? '' : `<div>${paragraphs(parts.text ?? '')}</div>`
  const anchors = (parts.links ?? []).map(([href, rel]) => `<a href="${esc(href)}"${rel ? ` rel="${esc(rel)}"` : ''}></a>`).join('')
  // Head tags only: a stray <script> in a head is inert here, the extractor never runs it.
  const head = (parts.head ?? '').replace(/^<head[^>]*>|<\/head>$/gi, '')
  return `<!doctype html><html lang="${esc(parts.lang ?? '')}"><head>${head}</head><body>${main}${rest}<nav>${anchors}</nav></body></html>`
}

export class ObscuraClient {
  private session = ''
  private id = 0
  private busy: Promise<unknown> = Promise.resolve()

  constructor(
    readonly endpoint: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
    /** The whole render: navigation, settle and read back (CRAWL_RENDER_TIMEOUT_MS). */
    private readonly budgetMs = CRAWL_RENDER_TIMEOUT_MS,
    private readonly settleMs = CRAWL_RENDER_SETTLE_MS,
  ) {}

  /** When the render in progress must be done by; every call inside it gets only what is left. */
  private deadline = 0

  private left(): number {
    return this.deadline ? this.deadline - Date.now() : this.budgetMs
  }

  private async rpc(method: string, params: unknown, notify = false): Promise<any> {
    const left = this.left()
    if (left <= 0) throw new Error('render budget spent')
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
      },
      body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(left),
      })
    } catch (error) {
      const name = (error as Error)?.name
      if (name === 'TimeoutError' || name === 'AbortError') throw error
      throw new ObscuraError(`obscura unreachable: ${(error as Error)?.message ?? error}`)
    }
    this.session = response.headers.get('mcp-session-id') ?? this.session
    const text = await response.text()
    if (response.status === 404 || response.status === 400) {
      // A restarted server forgot the session.
      this.session = ''
      throw new ObscuraError(`obscura HTTP ${response.status}`)
    }
    if (!response.ok) throw new ObscuraError(`obscura HTTP ${response.status}`)
    if (notify) return null
    const line = text.includes('data:')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .pop()!
          .slice(5)
      : text
    let json: any
    try {
      json = JSON.parse(line)
    } catch {
      throw new ObscuraError('obscura sent a reply that is not JSON')
    }
    if (json.error) throw new ObscuraError(`obscura ${json.error.message ?? 'error'}`)
    return json.result
  }

  private async ensureSession(): Promise<void> {
    if (this.session) return
    await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pitbot', version: '0.1.0' } })
    await this.rpc('notifications/initialized', {}, true)
  }

  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureSession()
    let result: any
    try {
      result = await this.rpc('tools/call', { name, arguments: args })
    } catch (error) {
      if (this.session) throw error
      // The session was dropped: one fresh start, then give up.
      await this.ensureSession()
      result = await this.rpc('tools/call', { name, arguments: args })
    }
    const text = (result?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('')
    if (result?.isError) throw new Error(`obscura ${name}: ${text.slice(0, 200)}`)
    return text
  }

  /**
   * Navigate to `load` (never networkidle: a page that keeps a socket open never goes idle),
   * settle briefly, read it back, all inside one budget. Out of budget it rejects with
   * RenderTimeout, which the crawler records as a slow target. Serialised: one page per
   * server, and the budget starts when this page's turn does, not while it queues.
   */
  render(url: string): Promise<Rendered> {
    const run = this.busy.then(async () => {
      this.deadline = Date.now() + this.budgetMs
      try {
        await this.call('browser_navigate', { url, waitUntil: 'load' })
        const timeoutMs = Math.max(1, this.left() - 500)
        const raw = await this.call('browser_evaluate', { expression: SETTLED_EXPRESSION(Math.min(this.settleMs, timeoutMs / 2)), timeoutMs })
        const parts = JSON.parse(raw)
        return { url: String(parts.url || url), html: documentFrom(parts) }
      } catch (error) {
        if (this.left() <= 0 || (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') throw new RenderTimeout(url, this.budgetMs)
        throw error
      } finally {
        this.deadline = 0
      }
    })
    this.busy = run.catch(() => undefined)
    return run
  }
}

/** Round-robin over several Obscura servers. */
export class ObscuraPool {
  private next = 0
  readonly clients: ObscuraClient[]
  constructor(endpoints: string[], token: string, fetchImpl: Fetch = fetch) {
    this.clients = endpoints.map((e) => new ObscuraClient(e, token, fetchImpl))
  }
  get size(): number {
    return this.clients.length
  }
  render(url: string): Promise<Rendered> {
    const client = this.clients[this.next++ % this.clients.length]
    if (!client) return Promise.reject(new Error('no Obscura server configured'))
    return client.render(url)
  }
}
