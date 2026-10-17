/**
 * Keep the pit.world ring mirrored on rssamplifier.com as an OpenWebring ring of feeds.
 *
 * rssamplifier's rings hold feeds that are in its directory, so a member is mirrored only when its
 * homepage advertises a feed (discovered on claim and daily, see Listings.checkSite) and its name has an
 * ICANN address (rssamplifier cannot reach Moshpit-only names). The sync is a diff, so it is safe to run
 * any number of times: submit the feeds rssamplifier does not know yet, add the members the ring lacks,
 * take out the ones that left (opted out, or lost their feed). New feeds take a crawl to land in the
 * directory; until then they come back as "missing" and the next run adds them.
 *
 * Auth is an rssamplifier API key (rsa_...) of the account that owns the ring, from the vault
 * (RSSAMPLIFIER_API_KEY). Without one the sync is off.
 */
import type { RingSite } from './ring.js'

export type RingSyncOptions = {
  apiKey: string
  base?: string
  slug?: string
  title?: string
  description?: string
  fetch?: typeof fetch
}

export type RingSyncReport = { ok: boolean; created: boolean; submitted: number; added: number; removed: number; missing: string[]; error?: string }

type RemoteMember = { url: string; slug: string; feed: string | null }

const sameUrl = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b) && a!.replace(/\/+$/, '').toLowerCase() === b!.replace(/\/+$/, '').toLowerCase()

export class RingSync {
  readonly base: string
  readonly slug: string
  private fetchImpl: typeof fetch
  private running: Promise<RingSyncReport> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  last: (RingSyncReport & { at: number }) | null = null

  constructor(private options: RingSyncOptions) {
    this.base = (options.base ?? 'https://rssamplifier.com').replace(/\/+$/, '')
    this.slug = options.slug ?? 'pit-world'
    this.fetchImpl = options.fetch ?? fetch
  }

  private async call(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<{ status: number; body: any }> {
    // threatcrush-disable-next-line js-ssrf-outbound-request  fixed host from configuration (rssamplifier.com), never from a request
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'pit.world ring sync (+https://pit.world/ring)',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.auth ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(60_000),
    })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }

  /** The members that belong on rssamplifier: ICANN names with a feed. */
  static wanted(sites: RingSite[]): Array<{ site: string; feed: string }> {
    return sites.filter((s) => s.feed && !s.moshpit).map((s) => ({ site: `https://${s.name}/`, feed: s.feed! }))
  }

  async sync(sites: RingSite[]): Promise<RingSyncReport> {
    const want = RingSync.wanted(sites)
    const report: RingSyncReport = { ok: false, created: false, submitted: 0, added: 0, removed: 0, missing: [] }
    const ring = await this.call(`/api/rings/${this.slug}`)
    if (ring.status !== 200 && ring.status !== 404) return { ...report, error: `ring lookup answered ${ring.status}` }
    const members: RemoteMember[] = ring.status === 200 && Array.isArray(ring.body?.members) ? ring.body.members : []
    const has = (w: { site: string; feed: string }) => members.some((m) => sameUrl(m.feed, w.feed) || sameUrl(m.url, w.site))
    const absent = want.filter((w) => !has(w))

    // Feeds the directory may not have yet. Submitting a known feed is harmless (it is matched, not duplicated).
    if (absent.length) {
      const submit = await this.call('/api/submit', { method: 'POST', body: { urls: absent.map((w) => w.feed) } })
      if (submit.status < 300) report.submitted = absent.length
    }

    if (ring.status === 404) {
      if (!want.length) return { ...report, ok: true }
      const made = await this.call('/api/rings', {
        method: 'POST',
        auth: true,
        body: { title: this.options.title ?? 'pit.world', description: this.options.description ?? 'Every business and site claimed on pit.world, plus the Moshpit sites it started with. Mirrored from https://pit.world/ring.', members: want.map((w) => w.feed) },
      })
      if (made.status === 201) return { ...report, ok: true, created: true, added: Number(made.body?.added ?? 0), missing: made.body?.missing ?? [] }
      // Nothing crawled yet: the next run tries again.
      if (made.status === 400 && made.body?.error === 'members-required') return { ...report, ok: true, missing: made.body?.missing ?? [] }
      return { ...report, error: `creating the ring answered ${made.status} ${made.body?.error ?? ''}`.trim() }
    }

    if (absent.length) {
      const add = await this.call(`/api/rings/${this.slug}/members`, { method: 'POST', auth: true, body: { action: 'add', members: absent.map((w) => w.feed) } })
      if (add.status !== 200) return { ...report, error: `adding members answered ${add.status} ${add.body?.error ?? ''}`.trim() }
      report.added = Number(add.body?.added ?? 0)
      report.missing = add.body?.missing ?? []
    }

    for (const m of members) {
      if (want.some((w) => sameUrl(m.feed, w.feed) || sameUrl(m.url, w.site))) continue
      const gone = await this.call(`/api/rings/${this.slug}/members`, { method: 'POST', auth: true, body: { action: 'remove', member: m.slug } })
      if (gone.status === 200 && gone.body?.ok) report.removed += 1
    }
    return { ...report, ok: true }
  }

  /** Run one sync at a time; a call while one is running shares its result. */
  run(sites: () => RingSite[]): Promise<RingSyncReport> {
    if (!this.running) {
      this.running = this.sync(sites())
        .catch((error): RingSyncReport => ({ ok: false, created: false, submitted: 0, added: 0, removed: 0, missing: [], error: error instanceof Error ? error.message : String(error) }))
        .then((report) => {
          this.last = { ...report, at: Date.now() }
          return report
        })
        .finally(() => {
          this.running = null
        })
    }
    return this.running
  }

  /** A sync a few seconds from now, so a claim and the edit that follows it cost one run. */
  soon(sites: () => RingSite[], delayMs = 5_000): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run(sites)
    }, delayMs)
    this.timer.unref?.()
  }
}
