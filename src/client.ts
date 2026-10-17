/**
 * The pit.world API, as a client. The CLI, the TUI and the MCP server all use
 * this, so none of them need provider keys: they ask pit.world, privately,
 * like the page does. PIT_URL points them at another instance.
 */
import type { Hit } from './search.js'
import type { NetworkStats, Resolution } from './moshpit.js'

export type ApiSearch = {
  query: string
  provider: string | null
  cached: boolean
  results: Hit[]
  moshpit: Resolution | null
}

export class PitClient {
  constructor(
    readonly base = (process.env.PIT_URL ?? 'https://pit.world').replace(/\/+$/, ''),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.base}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    const body = (await response.json().catch(() => ({}))) as any
    if (!response.ok) {
      const retry = response.headers.get('retry-after')
      throw new Error(`${body?.error ?? `HTTP ${response.status}`}${retry ? ` (retry in ${retry}s)` : ''}`)
    }
    return body as T
  }

  search(query: string, n = 10): Promise<ApiSearch> {
    return this.get(`/api/search?q=${encodeURIComponent(query)}&n=${n}`)
  }

  resolve(name: string): Promise<Resolution> {
    return this.get(`/api/resolve?name=${encodeURIComponent(name)}`)
  }

  network(): Promise<NetworkStats> {
    return this.get('/api/network')
  }
}
