/**
 * MCP servers the crawl runs into.
 *
 * Finding: only what a site says about itself. A descriptor it publishes
 * (/.well-known/openmcp.json, an MCP server card), or an address on one of its
 * pages that looks like an endpoint: a link, a config block, a `claude mcp add`
 * line. We never guess by POSTing to /mcp on every site.
 *
 * Proving: a page mentioning an address proves nothing, so nothing is kept until
 * the address answers MCP's own handshake: `initialize`, then `tools/list`. Those
 * two read-only calls are all pitbot ever sends. It never calls a tool.
 *
 * What comes back was written by whoever runs the server. It is stored and served
 * as data, clipped, and never treated as instructions.
 */
import { createHash } from 'node:crypto'
import { readCapped } from './fetcher.ts'
import { normalizeUrl, type Resolver } from './url.ts'

export type McpJob = { endpoint: string; foundOn: string; descriptor?: boolean }

export type McpTool = { name: string; description: string | null }

export type McpServer = {
  mcp: string
  name: string
  description: string
  serverName: string
  version: string
  protocolVersion: string
  tools: McpTool[]
  /** 'required': it answered 401 with MCP's own auth challenge, so its tools are not ours to see. */
  auth: 'none' | 'required'
  /** True when the server's own site published a descriptor naming this address. */
  descriptor: boolean
  foundOn: string
  hash: string
  seenAt: string
}

const PROTOCOL = '2025-06-18'
const MAX_REPLY = 512 * 1024
const MAX_TOOLS = 200
const PER_PAGE = 10

/** Where a site can say it has a server, read once at the start of each crawl cycle. */
export const WELL_KNOWN = ['/.well-known/openmcp.json', '/.well-known/mcp/server-card.json']

/** Hosts that write about MCP servers, or list them, without being one. */
const NOT_SERVERS = /(^|\.)(github\.com|githubusercontent\.com|gitlab\.com|npmjs\.com|pypi\.org|modelcontextprotocol\.io|smithery\.ai|glama\.ai|mcp\.so|pulsemcp\.com|youtube\.com|reddit\.com|medium\.com|wikipedia\.org)$/
const FILE = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|json|ya?ml|md|txt|pdf|zip|gz|html?)$/i

function looksLikeEndpoint(url: URL): boolean {
  if (url.protocol !== 'https:' || NOT_SERVERS.test(url.hostname) || FILE.test(url.pathname)) return false
  const segments = url.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase())
  const last = segments[segments.length - 1] ?? ''
  // https://example.com/mcp, /api/mcp, /v1/mcp, and the older /mcp/sse.
  if (last === 'mcp' || (last === 'sse' && segments.includes('mcp'))) return true
  // https://mcp.example.com/ and https://mcp.example.com/sse, not a whole docs tree under that host.
  return /^mcp\./.test(url.hostname) && (segments.length === 0 || last === 'sse')
}

/** Endpoint-shaped addresses in a page's HTML, at most PER_PAGE. Regex over raw HTML: config blocks live in <pre> and inline JSON. */
export function mcpCandidates(html: string): string[] {
  if (!/mcp/i.test(html)) return []
  const text = html.replace(/\\\//g, '/').replace(/&quot;/g, '"').replace(/&#x2F;/gi, '/')
  const out = new Set<string>()
  for (const m of text.matchAll(/https:\/\/[^\s"'`<>\\)\]},|]+/g)) {
    const raw = m[0].replace(/[.;:]+$/, '')
    if (!/mcp/i.test(raw)) continue
    const normal = normalizeUrl(raw)
    if (!normal) continue
    try {
      if (looksLikeEndpoint(new URL(normal))) out.add(normal)
    } catch {
      continue
    }
    if (out.size >= PER_PAGE) break
  }
  return [...out]
}

/** The addresses a descriptor names: OpenMCP's `mcp`, a server card's `url`/`endpoint`, or `remotes[].url`. */
export function endpointsIn(doc: unknown): string[] {
  if (!doc || typeof doc !== 'object') return []
  const d = doc as Record<string, any>
  const found = [d.mcp, d.url, d.endpoint, d.transport?.url, d.transport?.endpoint, ...(Array.isArray(d.remotes) ? d.remotes.map((r: any) => r?.url) : [])]
  return [...new Set(found.filter((u): u is string => typeof u === 'string' && u.startsWith('https://')).map((u) => normalizeUrl(u)).filter((u): u is string => Boolean(u)))].slice(0, PER_PAGE)
}

/** A JSON-RPC reply from a JSON or an event-stream body. */
function rpcReply(body: string): Record<string, any> | null {
  const lines = body.includes('data:') ? body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()) : [body]
  for (const line of lines) {
    try {
      const msg = JSON.parse(line)
      if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return msg
    } catch {
      // Not this line.
    }
  }
  return null
}

const clip = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/**
 * Prove an address is an MCP server, or return null. Redirects are not followed: a server answers
 * at its own address, and following one would let a page aim this POST somewhere else.
 */
export async function handshake(
  endpoint: string,
  options: { userAgent: string; resolver: Resolver; fetch?: typeof fetch; timeoutMs?: number },
): Promise<Pick<McpServer, 'serverName' | 'version' | 'protocolVersion' | 'description' | 'tools' | 'auth'> | null> {
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' || !(await options.resolver(url.hostname))) return null
  const fetchImpl = options.fetch ?? fetch
  const call = async (method: string, params: unknown, id: number | null, session: string | null) => {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'user-agent': options.userAgent,
        ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': PROTOCOL } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    })
    const reply = id ? rpcReply(await readCapped(response, MAX_REPLY)) : (await response.body?.cancel().catch(() => {}), null)
    return { response, reply }
  }
  const init = await call('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'pitbot', version: '1' } }, 1, null)
  if (init.response.status === 401) {
    // MCP's auth spec points a client at its resource metadata. A plain 401 at /mcp proves nothing.
    if (!/resource_metadata=/i.test(init.response.headers.get('www-authenticate') ?? '')) return null
    return { serverName: '', version: '', protocolVersion: '', description: '', tools: [], auth: 'required' }
  }
  const result = init.reply?.result
  if (!init.response.ok || typeof result?.protocolVersion !== 'string' || typeof result?.capabilities !== 'object') return null
  const session = init.response.headers.get('mcp-session-id')
  await call('notifications/initialized', {}, null, session).catch(() => {})
  const list = await call('tools/list', {}, 2, session).catch(() => null)
  const rows: unknown[] = Array.isArray(list?.reply?.result?.tools) ? list!.reply!.result.tools : []
  return {
    serverName: clip(result.serverInfo?.name, 120),
    version: clip(result.serverInfo?.version, 40),
    protocolVersion: clip(result.protocolVersion, 40),
    description: clip(result.instructions, 500),
    tools: rows.slice(0, MAX_TOOLS).flatMap((t: any) => {
      const name = clip(t?.name, 120)
      return name ? [{ name, description: clip(t?.description, 500) || null }] : []
    }),
    auth: 'none',
  }
}

/** The stored record for a proved server. The hash covers what the server said, not when we asked. */
export function mcpRecord(job: McpJob, proof: NonNullable<Awaited<ReturnType<typeof handshake>>>, now = new Date()): McpServer {
  const host = new URL(job.endpoint).hostname
  const hash = createHash('sha1').update(JSON.stringify([proof.serverName, proof.version, proof.description, proof.tools, proof.auth])).digest('hex')
  return { mcp: job.endpoint, name: proof.serverName || host, foundOn: job.foundOn, descriptor: job.descriptor === true, hash, seenAt: now.toISOString(), ...proof }
}

/** Servers matching every word (name, address, description, tool names), most tools first. No words: all of them. */
export function searchMcps(records: McpServer[], query: string, limit = 20): McpServer[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12)
  const matching = records.filter((r) => {
    const text = `${r.name} ${r.mcp} ${r.description} ${r.tools.map((t) => `${t.name} ${t.description ?? ''}`).join(' ')}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
  return matching.sort((a, b) => b.tools.length - a.tools.length || a.name.localeCompare(b.name)).slice(0, Math.min(Math.max(1, limit), 100))
}
