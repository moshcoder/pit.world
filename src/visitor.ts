/**
 * Who is writing, without knowing who anyone is.
 *
 * Anonymous write actions (votes, newsletter sign-ups, claims, quote requests,
 * submissions, build orders) are limited per browser with
 * @profullstack/browser-fingerprint, not per IP address: an office or a phone
 * carrier shares one address, and a VPN hands out a new one per click. The
 * fingerprint becomes a keyed hash (`visitorKey`) and the raw signals are
 * dropped; the address only feeds a looser per-network ceiling, as a keyed hash
 * of its /24 or /64. Counters live in memory and empty on restart.
 *
 * Votes need the fingerprint. Every other form still works without JavaScript:
 * a request with no fingerprint is limited by address as before, strictly.
 */
import { createFingerprintGuard, type FingerprintGuard, type Rule, type Verdict } from '@profullstack/browser-fingerprint'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Votes: a person reading results votes a few times a minute at most. */
export const VOTE_LIMITS = {
  visitor: [
    { perWindow: 12, windowMs: MIN },
    { perWindow: 60, windowMs: HOUR },
    { perWindow: 200, windowMs: DAY },
  ],
  // A whole office behind one address still gets room; a farm of made-up fingerprints does not.
  ip: [
    { perWindow: 40, windowMs: MIN },
    { perWindow: 300, windowMs: HOUR },
    { perWindow: 1500, windowMs: DAY },
  ],
} satisfies { visitor: Rule[]; ip: Rule[] }

/** Every other anonymous write: per browser, plus a per-network ceiling. */
export const WRITE_LIMITS: Record<WriteAction, { visitor: Rule[]; ip: Rule[] }> = {
  subscribe: { visitor: [{ perWindow: 3, windowMs: 10 * MIN }, { perWindow: 10, windowMs: DAY }], ip: [{ perWindow: 30, windowMs: HOUR }] },
  claim: { visitor: [{ perWindow: 5, windowMs: HOUR }, { perWindow: 20, windowMs: DAY }], ip: [{ perWindow: 60, windowMs: HOUR }] },
  quote: { visitor: [{ perWindow: 3, windowMs: HOUR }, { perWindow: 10, windowMs: DAY }], ip: [{ perWindow: 20, windowMs: HOUR }] },
  submit: { visitor: [{ perWindow: 6, windowMs: 10 * MIN }, { perWindow: 30, windowMs: DAY }], ip: [{ perWindow: 60, windowMs: HOUR }] },
  order: { visitor: [{ perWindow: 3, windowMs: HOUR }, { perWindow: 6, windowMs: DAY }], ip: [{ perWindow: 10, windowMs: HOUR }] },
}
export type WriteAction = 'subscribe' | 'claim' | 'quote' | 'submit' | 'order'

export type VoteGate =
  | { ok: true; visitor: string }
  | { ok: false; reason: 'needs-js' | 'stale' | 'bot' | 'limited'; retryAfterMs: number }

export type WriteGate = { ok: true; visitor: string | null } | { ok: false; reason: 'bot' | 'limited'; retryAfterMs: number }

/** The secret behind every key: PIT_FP_SECRET, else one made once and kept beside the databases. */
export function fingerprintSecret(dataDir: string, env: Record<string, string | undefined> = process.env): string {
  if (env.PIT_FP_SECRET && env.PIT_FP_SECRET.length >= 16) return env.PIT_FP_SECRET
  const path = `${dataDir}/fingerprint.secret`
  if (existsSync(path)) {
    const kept = readFileSync(path, 'utf8').trim()
    if (kept.length >= 16) return kept
  }
  mkdirSync(dirname(path), { recursive: true })
  const made = randomBytes(32).toString('base64url')
  writeFileSync(path, `${made}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return made
}

export class VisitorGate {
  readonly guard: FingerprintGuard

  constructor(
    readonly secret: string,
    /** The address-only limit for a request with no fingerprint (the old behaviour). */
    private readonly byAddress: (ip: string) => boolean,
    guard?: FingerprintGuard,
  ) {
    this.guard = guard ?? createFingerprintGuard({ secret })
  }

  challenge(ip: string): Promise<string> {
    return this.guard.issueChallenge({ ip })
  }

  private async limits(v: Verdict, action: string, rules: { visitor: Rule[]; ip: Rule[] }): Promise<{ ok: boolean; retryAfterMs: number }> {
    if (v.ipKey) {
      const net = await this.guard.limit(v.ipKey, `${action}:ip`, rules.ip)
      if (!net.ok) return net
    }
    return this.guard.limit(v.visitorKey!, action, rules.visitor)
  }

  /** A vote: the fingerprint is required, and both limits apply. */
  async vote(payload: unknown, ip: string, userAgent: string): Promise<VoteGate> {
    if (!payload) return { ok: false, reason: 'needs-js', retryAfterMs: 0 }
    const v = await this.guard.verify({ payload, ip, userAgent })
    if (!v.ok) {
      if (v.reason === 'bot') return { ok: false, reason: 'bot', retryAfterMs: 0 }
      return { ok: false, reason: v.reason === 'payload_invalid' ? 'needs-js' : 'stale', retryAfterMs: 0 }
    }
    const lim = await this.limits(v, 'vote', VOTE_LIMITS)
    return lim.ok ? { ok: true, visitor: v.visitorKey! } : { ok: false, reason: 'limited', retryAfterMs: lim.retryAfterMs }
  }

  /**
   * Any other anonymous write. With a good fingerprint: per-browser limits and
   * the network ceiling. Without one (no JavaScript, or a page left open past
   * its token): the strict address limit, as before. A bot-scored fingerprint
   * is refused.
   */
  async write(action: WriteAction, payload: unknown, ip: string, userAgent: string): Promise<WriteGate> {
    if (payload) {
      const v = await this.guard.verify({ payload, ip, userAgent })
      if (v.reason === 'bot') return { ok: false, reason: 'bot', retryAfterMs: 0 }
      if (v.ok) {
        const lim = await this.limits(v, action, WRITE_LIMITS[action])
        return lim.ok ? { ok: true, visitor: v.visitorKey } : { ok: false, reason: 'limited', retryAfterMs: lim.retryAfterMs }
      }
    }
    return this.byAddress(ip) ? { ok: true, visitor: null } : { ok: false, reason: 'limited', retryAfterMs: 30_000 }
  }
}
