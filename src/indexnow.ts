/**
 * IndexNow: tell Bing, Yandex, Seznam, Naver and the other IndexNow engines the moment a listing page
 * changes (claimed, edited, written by pit.world, or newly worth indexing), instead of waiting for
 * them to re-read the sitemap. One POST to api.indexnow.org reaches all of them.
 *
 * The key is ours to choose: PIT_INDEXNOW_KEY, else one made on first start and kept in the data
 * directory. It is served at https://pit.world/<key>.txt, which is how the engines check the POST
 * came from the site. URLs are queued and sent in batches (at most 10,000 a request), so a busy
 * import run costs a handful of requests, not one per listing.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'
const MAX_PER_REQUEST = 10_000

/** PIT_INDEXNOW_KEY when it is a valid key, else the one saved at `path` (made and saved on first use). */
export function indexNowKey(path: string, fromEnv?: string): string {
  if (fromEnv && /^[A-Za-z0-9-]{8,128}$/.test(fromEnv)) return fromEnv
  try {
    const saved = readFileSync(path, 'utf8').trim()
    if (/^[A-Za-z0-9-]{8,128}$/.test(saved)) return saved
  } catch {}
  const key = randomBytes(16).toString('hex')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${key}\n`, { mode: 0o644 })
  return key
}

export type IndexNowResult = { sent: number; statuses: number[] }

export class IndexNow {
  private pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private host: string

  constructor(
    readonly key: string,
    private options: { site?: string; endpoint?: string; fetchImpl?: typeof fetch; delayMs?: number; log?: (line: string) => void } = {},
  ) {
    this.host = new URL(options.site ?? 'https://pit.world').host
  }

  /** Where the key file is served. */
  get keyPath(): string {
    return `/${this.key}.txt`
  }

  get keyLocation(): string {
    return `${this.options.site ?? 'https://pit.world'}${this.keyPath}`
  }

  /** Queue a URL on our own host; sent with the next batch (after `delayMs`, a minute by default). */
  queue(url: string): void {
    try {
      if (new URL(url).host !== this.host) return
    } catch {
      return
    }
    this.pending.add(url)
    if (this.pending.size >= MAX_PER_REQUEST) void this.flush()
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.options.delayMs ?? 60_000)
      ;(this.timer as { unref?: () => void }).unref?.()
    }
  }

  get queued(): number {
    return this.pending.size
  }

  /** Send everything queued now. */
  async flush(): Promise<IndexNowResult> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const urls = [...this.pending]
    this.pending.clear()
    return this.submit(urls)
  }

  /** Submit URLs directly, in batches of up to 10,000. A failed batch is logged, not retried (the sitemap covers it). */
  async submit(urls: string[]): Promise<IndexNowResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const statuses: number[] = []
    let sent = 0
    for (let i = 0; i < urls.length; i += MAX_PER_REQUEST) {
      const urlList = urls.slice(i, i + MAX_PER_REQUEST)
      try {
        // threatcrush-disable-next-line js-ssrf-outbound-request  fixed IndexNow endpoint
        const response = await fetchImpl(this.options.endpoint ?? INDEXNOW_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'pit.world IndexNow (+https://pit.world/bot)' },
          body: JSON.stringify({ host: this.host, key: this.key, keyLocation: this.keyLocation, urlList }),
          signal: AbortSignal.timeout(30_000),
        })
        statuses.push(response.status)
        if (response.ok) sent += urlList.length
        this.options.log?.(`IndexNow: ${urlList.length} URL${urlList.length === 1 ? '' : 's'} -> ${response.status}`)
      } catch (err) {
        statuses.push(0)
        this.options.log?.(`IndexNow: ${urlList.length} URLs failed: ${(err as Error).message}`)
      }
    }
    return { sent, statuses }
  }
}

/** A small JSON state file: which one-off full submissions have been made. */
export function readState(path: string): Record<string, unknown> {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function writeState(path: string, state: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
}
