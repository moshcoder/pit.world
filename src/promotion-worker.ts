/**
 * The publishing worker: hands a campaign's due posts to myna and proves they are live.
 *
 *   pit promo worker <campaign> [--once]
 *
 * It runs where myna is logged in (the operator's account), not inside pit.world, and talks to pit.world
 * only through the promotion API. Each pass leases a few placements and, for each one:
 *
 *  1. Reconciles first. Every campaign link carries its placement id (?via=plc_...), so myna's history
 *     and queue say whether this post already went out or is waiting. A worker that died mid-post, or
 *     an uncertain answer, therefore never leads to a second post.
 *  2. Posts only what is in neither: `myna post <account> --front`, text on stdin. Automated promotion
 *     is paced by myna (never --now); --front keeps it on the campaign's calendar behind myna's gap.
 *  3. Verifies what myna says went out against the network's public API (Bluesky getPostThread,
 *     Mastodon statuses, or the page itself for pit.world). A provider record alone is not proof.
 *     LinkedIn has no public read: its posts stay "published", never "verified", and never count.
 *
 * Organic only: accounts on networks where myna's CrawlProof plugin buys an ad are refused.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { PitClient } from './client.js'
import { AD_NETWORKS } from './promotion.js'

export type Placement = {
  id: string
  kind: string
  channel: string
  account: string
  state: string
  body: string
  link: string
  publicUrl: string
  providerId: string
  queueId: string
  attempts: number
  businesses: string[]
}

export type MynaEntry = { at: string; accountId: string; text: string; ok: boolean; postId?: string; url?: string; error?: string }
export type MynaQueued = { id: string; targets: string[]; text: string; status: string; scheduledFor: string }

export type Myna = {
  history(): MynaEntry[]
  queue(): MynaQueued[]
  post(account: string, text: string): Promise<{ code: number; output: string }>
}

/** myna on this machine: its own files for reading, its CLI for posting. */
export function localMyna(dir = process.env.MYNA_CONFIG_DIR ?? `${homedir()}/.config/myna`, bin = process.env.MYNA_BIN ?? 'myna'): Myna {
  const read = <T>(file: string, key: string): T[] => {
    try {
      const data = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'))
      return (Array.isArray(data) ? data : (data[key] ?? [])) as T[]
    } catch {
      return []
    }
  }
  return {
    history: () => read<MynaEntry>('history.json', 'entries'),
    queue: () => read<MynaQueued>('queue.json', 'posts'),
    post: (account, text) =>
      new Promise((resolve) => {
        const child = spawn(bin, ['post', account, '--front'], { stdio: ['pipe', 'pipe', 'pipe'] })
        let output = ''
        child.stdout.on('data', (d) => (output += d))
        child.stderr.on('data', (d) => (output += d))
        const timer = setTimeout(() => child.kill('SIGTERM'), 120_000)
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ code: code ?? 1, output: output.slice(-2000) })
        })
        child.on('error', (e) => resolve({ code: 127, output: String(e) }))
        child.stdin.end(text)
      }),
  }
}

/** Where this post stands in myna, found by its tracking id. */
export function findInMyna(myna: Myna, p: Placement): { history?: MynaEntry; queued?: MynaQueued } {
  const marker = `via=${p.id}`
  const history = myna
    .history()
    .filter((e) => e.accountId === p.account && e.text?.includes(marker))
    .sort((a, b) => (a.ok === b.ok ? 0 : a.ok ? -1 : 1))[0]
  const queued = myna.queue().find((q) => q.status === 'pending' && q.targets?.includes(p.account) && q.text?.includes(marker))
  return { ...(history ? { history } : {}), ...(queued ? { queued } : {}) }
}

/** Does the public post exist? Evidence for "verified", or null when the network cannot be read without a login. */
export async function verifyPublic(p: Placement, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; evidence: Record<string, unknown> } | null> {
  const network = p.channel === 'pit.world' ? 'pit.world' : p.account.split(':')[0]
  const at = new Date().toISOString()
  const get = async (url: string) => {
    const r = await fetchImpl(url, { headers: { accept: 'application/json, text/html', 'user-agent': 'pit.world-verifier-bot (+https://pit.world/privacy#listings)' }, signal: AbortSignal.timeout(15_000) })
    return { status: r.status, text: await r.text().catch(() => '') }
  }
  if (network === 'pit.world') {
    const r = await get(p.publicUrl)
    return { ok: r.status === 200 && r.text.includes('<h1>'), evidence: { method: 'GET public page', url: p.publicUrl, status: r.status, checkedAt: at } }
  }
  if (network === 'bluesky') {
    const uri = p.providerId.split('|')[0]
    if (!uri?.startsWith('at://')) return { ok: false, evidence: { error: 'no at:// uri', checkedAt: at } }
    const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0`
    const r = await get(url)
    return { ok: r.status === 200 && r.text.includes(p.id), evidence: { method: 'bluesky getPostThread', url, status: r.status, containsLink: r.text.includes(p.id), publicUrl: p.publicUrl, checkedAt: at } }
  }
  if (network === 'mastodon') {
    const u = new URL(p.publicUrl)
    const id = u.pathname.split('/').pop()
    const url = `${u.origin}/api/v1/statuses/${id}`
    const r = await get(url)
    return { ok: r.status === 200 && r.text.includes(p.id), evidence: { method: 'mastodon statuses', url, status: r.status, containsLink: r.text.includes(p.id), publicUrl: p.publicUrl, checkedAt: at } }
  }
  return null
}

export type WorkerResult = { placement: string; action: string; state?: string; detail?: string }

/** One pass over what the lease hands out. Returns what it did, per placement. */
export async function workOnce(client: PitClient, campaignId: string, myna: Myna, options: { owner?: string; max?: number; fetch?: typeof fetch } = {}): Promise<WorkerResult[]> {
  const { placements, reason } = await client.promo<{ placements: Placement[]; reason?: string }>('POST', `/campaigns/${encodeURIComponent(campaignId)}/lease`, { owner: options.owner ?? 'myna-worker', max: options.max ?? 20 })
  if (reason) return [{ placement: '-', action: 'idle', detail: reason }]
  const out: WorkerResult[] = []
  const report = async (p: Placement, body: Record<string, unknown>, action: string) => {
    const r = await client.promo<Placement>('POST', `/placements/${encodeURIComponent(p.id)}/report`, body)
    out.push({ placement: p.id, action, state: r.state, ...(body.error ? { detail: String(body.error) } : {}) })
  }
  for (const p of placements) {
    try {
      if (p.state === 'published') {
        const v = await verifyPublic(p, options.fetch)
        if (!v) out.push({ placement: p.id, action: 'unverifiable', state: p.state, detail: `${p.account.split(':')[0]} has no public read` })
        else if (v.ok) await report(p, { state: 'verified', evidence: v.evidence }, 'verified')
        else await report(p, { state: 'published', error: `not visible yet: ${JSON.stringify(v.evidence)}` }, 'not-yet-visible')
        continue
      }
      if (p.channel !== 'myna') continue
      if (AD_NETWORKS.has(p.account.split(':')[0]!)) {
        await report(p, { state: 'failed', error: `refused: ${p.account} would buy a CrawlProof ad and this is organic promotion` }, 'refused')
        continue
      }
      const found = findInMyna(myna, p)
      if (found.history?.ok) {
        await report(p, { state: 'published', providerId: found.history.postId ?? '', publicUrl: found.history.url ?? '', at: Date.parse(found.history.at) }, 'reconciled-published')
        continue
      }
      if (found.queued) {
        if (p.state !== 'scheduled' || p.queueId !== found.queued.id) await report(p, { state: 'scheduled', queueId: found.queued.id }, 'reconciled-scheduled')
        else out.push({ placement: p.id, action: 'waiting', state: 'scheduled', detail: `myna ${found.queued.id} at ${found.queued.scheduledFor}` })
        continue
      }
      if (found.history && !found.history.ok) {
        await report(p, { state: 'failed', error: `myna: ${found.history.error ?? 'post failed'}` }, 'reconciled-failed')
        continue
      }
      if (p.state === 'scheduled') {
        await report(p, { state: 'failed', error: 'no longer in myna queue or history (cancelled?)' }, 'lost')
        continue
      }
      if (p.state === 'uncertain') {
        // Reconciled: it is in neither place, so it never went. Back in line for a normal post.
        await report(p, { state: 'ready', error: '' }, 'reconciled-not-sent')
        continue
      }
      if (!p.body.includes(`via=${p.id}`)) {
        await report(p, { state: 'failed', error: 'post text lost its tracking link; not posting it' }, 'refused')
        continue
      }
      const r = await myna.post(p.account, p.body)
      const after = findInMyna(myna, p)
      if (after.history?.ok) await report(p, { state: 'published', providerId: after.history.postId ?? '', publicUrl: after.history.url ?? '', at: Date.parse(after.history.at) }, 'posted')
      else if (after.queued) await report(p, { state: 'scheduled', queueId: after.queued.id }, 'queued')
      else if (after.history && !after.history.ok) await report(p, { state: 'failed', error: `myna: ${after.history.error ?? r.output.slice(-300)}` }, 'post-failed')
      else await report(p, { state: 'uncertain', error: `myna exited ${r.code} and left no record: ${r.output.slice(-300)}` }, 'uncertain')
    } catch (error) {
      out.push({ placement: p.id, action: 'error', detail: error instanceof Error ? error.message : String(error) })
    }
  }
  return out
}
