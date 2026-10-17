/**
 * The Moshpit network, read from its registry (pit.moshcode.sh today).
 *
 * Moshpit is a namespace outside ICANN's: endings like `.hacker`, `.eggs` or
 * `.pit` are claimed in an open, append-only registry, and a name such as
 * `chovy.hacker` points wherever its owner says. Machines reach it through the
 * moshcode DNS bridge or the public DoH resolver, and the registry signs
 * certificates for it, so the names are real HTTPS sites to anyone on the network.
 */

export const DEFAULT_REGISTRY = 'https://pit.moshcode.sh'

export const LINKS = {
  registry: 'https://pit.moshcode.sh',
  claim: 'https://pit.moshcode.sh',
  moshcode: 'https://moshcode.sh',
  moshcoding: 'https://moshcoding.com',
  doh: 'https://dns.moshcode.sh/dns-query',
  install: 'curl -fsSL https://moshcoding.com/install.sh | sh',
  enable: 'moshcode dns enable',
  source: 'https://github.com/moshcoder',
  tron: 'https://tronbrowser.dev',
  tronInstall: 'curl -fsSL https://tronbrowser.dev/install.sh | sh',
  /** The registry's root, as it publishes it; pit.world serves the same file at /moshpit-root-ca.crt. */
  ca: 'https://pit.moshcode.sh/api/moshpit/ca.crt',
}

/** CN=Moshpit Root CA, O=Moshpit, valid to 2046-09-11. Anyone installing it should check this first. */
export const MOSHPIT_ROOT_SHA256 = '4A:57:66:EC:8C:1F:10:F8:75:C9:89:65:FB:E8:DC:36:1A:32:C7:2B:C3:95:95:16:EA:7B:81:61:00:1E:15:57'

export type Resolution = {
  name: string
  registered: boolean
  nameRegistered: boolean
  target: string | null
  mode: string | null
  page: string
}

export type NetworkStats = {
  endings: number
  events: number
  recent: Array<{ tld: string; action: string; at: number }>
  forSale: Array<{ tld: string; price: number }>
}

type Fetch = typeof fetch

/** A single dotted token: `chovy.hacker`, `seo.rank`, `example.com`. */
export function looksLikeName(query: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\.?$/i.test(query.trim())
}

async function getJson(fetchImpl: Fetch, url: string, timeoutMs: number): Promise<any> {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`registry HTTP ${response.status}`)
  return response.json()
}

export class Registry {
  private statsCache: { at: number; value: NetworkStats } | null = null

  constructor(
    readonly base = DEFAULT_REGISTRY,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  /** Null when the registry does not answer in time: a search never waits on it for long. */
  async resolve(name: string, timeoutMs = 2_500): Promise<Resolution | null> {
    const clean = name.trim().replace(/\.$/, '').toLowerCase()
    try {
      const body = await getJson(this.fetchImpl, `${this.base}/api/moshpit/resolve?name=${encodeURIComponent(clean)}`, timeoutMs)
      return {
        name: typeof body?.name === 'string' ? body.name : clean,
        registered: body?.registered === true,
        nameRegistered: body?.name_registered === true,
        target: typeof body?.target === 'string' ? body.target : null,
        mode: typeof body?.mode === 'string' ? body.mode : null,
        page: `${this.base}/n/${encodeURIComponent(clean).replace(/%2E/gi, '.')}`,
      }
    } catch {
      return null
    }
  }

  /** Live numbers for the front page, cached for a minute. */
  async stats(): Promise<NetworkStats | null> {
    if (this.statsCache && Date.now() - this.statsCache.at < 60_000) return this.statsCache.value
    try {
      const [tlds, logHead, market] = await Promise.all([
        getJson(this.fetchImpl, `${this.base}/api/moshpit/tlds?limit=1`, 4_000),
        getJson(this.fetchImpl, `${this.base}/api/moshpit/log?limit=1`, 4_000),
        getJson(this.fetchImpl, `${this.base}/api/moshpit/market`, 4_000).catch(() => ({ tlds: [] })),
      ])
      const events = Number(logHead?.total ?? 0)
      const tail = await getJson(this.fetchImpl, `${this.base}/api/moshpit/log?since=${Math.max(0, events - 24)}&limit=24`, 4_000).catch(() => ({ entries: [] }))
      const value: NetworkStats = {
        endings: Number(tlds?.total ?? 0),
        events,
        // Newest first, one chip per ending: a claim and its follow-up edits are one event to a reader.
        recent: (Array.isArray(tail?.entries) ? tail.entries : [])
          .filter((e: any) => typeof e?.tld === 'string')
          .map((e: any) => ({ tld: e.tld, action: String(e.action ?? ''), at: Number(e.at ?? 0) }))
          .reverse()
          .filter((e: { tld: string }, i: number, all: Array<{ tld: string }>) => all.findIndex((x) => x.tld === e.tld) === i)
          .slice(0, 8),
        forSale: (Array.isArray(market?.tlds) ? market.tlds : [])
          .filter((t: any) => t?.for_sale && typeof t.tld === 'string')
          .slice(0, 12)
          .map((t: any) => ({ tld: t.tld, price: Number(t.price_usd ?? 0) })),
      }
      this.statsCache = { at: Date.now(), value }
      return value
    } catch {
      return this.statsCache?.value ?? null
    }
  }
}
