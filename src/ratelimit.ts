/**
 * Per-visitor rate limiting that remembers nobody.
 *
 * Each search costs real money at the provider, so one client must not be able
 * to spend the month in an afternoon. The limiter keys on an HMAC of the IP
 * with a random secret that is regenerated every hour and never stored: the
 * buckets cannot be turned back into addresses, and an hour later they cannot
 * even be linked to the previous hour's. Nothing here touches the disk.
 */
import { createHmac, randomBytes } from 'node:crypto'

export class RateLimiter {
  private salt = randomBytes(32)
  private saltAt = Date.now()
  private buckets = new Map<string, { tokens: number; at: number }>()

  constructor(
    /** Searches allowed in a burst. */
    private readonly burst = 30,
    /** Searches regained per minute. */
    private readonly perMinute = 20,
  ) {}

  private key(ip: string): string {
    if (Date.now() - this.saltAt > 3_600_000) {
      this.salt = randomBytes(32)
      this.saltAt = Date.now()
      this.buckets.clear()
    }
    return createHmac('sha256', this.salt).update(ip).digest('base64url').slice(0, 22)
  }

  /** True when this request may go ahead, and spends one token if so. */
  take(ip: string): boolean {
    const key = this.key(ip)
    const now = Date.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: now }
    bucket.tokens = Math.min(this.burst, bucket.tokens + ((now - bucket.at) / 60_000) * this.perMinute)
    bucket.at = now
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket)
      return false
    }
    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    if (this.buckets.size > 100_000) this.buckets.delete(this.buckets.keys().next().value!)
    return true
  }
}
