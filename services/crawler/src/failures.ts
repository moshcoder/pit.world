/**
 * Slow or broken targets: what counts as one, and how long it is left alone.
 *
 * A timeout, a name that does not resolve, a bad certificate, a refused or reset
 * connection, or a 5xx is not retried within minutes (BullMQ's backoff used to read a
 * dead host's every page three times). The host or page is flagged instead and gets
 * exactly one recheck after CRAWL_RECHECK_MS: success clears the flag, failure sets it
 * another 30 days. A 429 parks the host for its Retry-After, capped at the same 30 days.
 * Every other 4xx keeps its old meaning (the page is dropped, robots.txt reads as no rules).
 */
import { CRAWL_RECHECK_MS } from './config.ts'

export type FailureKind = 'timeout' | 'dns' | 'tls' | 'connection' | 'http5xx' | 'http429'

/** Kinds that are the host's, not one page's: every page of it would fail the same way. */
export const HOST_KINDS: ReadonlySet<FailureKind> = new Set(['dns', 'tls', 'connection', 'http429'])

/** Page timeouts or 5xx from one site inside an hour before the whole site is parked. */
export const HOST_PAGE_FAILURES = 5
export const HOST_PAGE_FAILURE_WINDOW_MS = 3_600_000

/** A 429 without a usable Retry-After waits a day; with one, never less than a minute. */
const RETRY_AFTER_DEFAULT_MS = 86_400_000
const RETRY_AFTER_MIN_MS = 60_000

/** A thrown fetch (or render) error as a failure kind; null when it is not the target's fault. */
export function failureKind(error: unknown): FailureKind | null {
  if (!error || typeof error !== 'object') return null
  const e = error as { name?: unknown; code?: unknown; message?: unknown; ours?: unknown }
  // Our own service failed (src/obscura.ts ObscuraError): not the target's doing.
  if (e.ours === true) return null
  const name = String(e.name ?? '')
  const code = String(e.code ?? '')
  const message = String(e.message ?? '')
  if (name === 'TimeoutError' || name === 'AbortError' || /\btimed? ?out\b|timeout/i.test(message)) return 'timeout'
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_NODATA)$/.test(code) || /getaddrinfo|ENOTFOUND|ERR_NAME_NOT_RESOLVED|not on the public internet/i.test(message)) return 'dns'
  if (/CERT|SSL|TLS/i.test(code) || /certificate|\bssl\b|\btls\b|ERR_CERT_|ERR_SSL_/i.test(message)) return 'tls'
  if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ECONNABORTED|ConnectionClosed|ConnectionRefused)$/.test(code) || /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ERR_CONNECTION_|socket (connection was )?closed|connection (was )?(closed|reset|refused)/i.test(message))
    return 'connection'
  return null
}

/** A status as a failure kind: 5xx and 429 only. */
export function statusKind(status: number): FailureKind | null {
  if (status === 429) return 'http429'
  if (status >= 500 && status <= 599) return 'http5xx'
  return null
}

/** Retry-After (seconds or an HTTP date) in ms from now, clamped to [1 min, 30 days]; a day when absent or unreadable. */
export function retryAfterMs(header: string | null | undefined, now = Date.now(), cap = CRAWL_RECHECK_MS): number {
  const raw = (header ?? '').trim()
  let ms = RETRY_AFTER_DEFAULT_MS
  if (/^\d+$/.test(raw)) ms = Number(raw) * 1000
  else if (raw) {
    const at = Date.parse(raw)
    if (Number.isFinite(at)) ms = at - now
  }
  return Math.min(cap, Math.max(RETRY_AFTER_MIN_MS, ms))
}

/** How long a failure of this kind keeps its target away. */
export function parkFor(kind: FailureKind, retryAfter?: string | null, now = Date.now()): number {
  return kind === 'http429' ? retryAfterMs(retryAfter, now) : CRAWL_RECHECK_MS
}

/** The flag a site row carries while it is parked. */
export type SiteFlag = { status: 'down'; lastError: string; failedAt: number; retryAfter: number }

export function flagFor(error: string, untilMs: number, now = Date.now()): SiteFlag {
  return { status: 'down', lastError: error.slice(0, 300), failedAt: now, retryAfter: untilMs }
}

/** A scheduled site is due again once its cycle has run out AND any flag on it has. */
export function isDue(row: { scheduledAt: number | null; retryAfter?: number | null }, cycleMs: number, now = Date.now()): boolean {
  if (row.scheduledAt === null) return false
  if (row.scheduledAt > now - cycleMs) return false
  return !row.retryAfter || row.retryAfter <= now
}
