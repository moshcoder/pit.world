/**
 * Known-bad hosts, from ThreatCrush.
 *
 * threatcrushd runs on every crawl box and keeps the abuse.ch indicators it alerts on
 * (ThreatFox C2 and payload hosts, URLhaus, Feodo) in its state dir, already stripped of
 * shared infrastructure (CDN ranges, public resolvers, PaaS edges, shared suffixes). A
 * crawler that opens a connection to one of them looks, to the box's own ThreatCrush and to
 * the hosting provider's flow analysis, exactly like an infected server: on 2026-11-27 netcup
 * opened an abuse case against the vienna crawl box for a mining-pool host found in a link.
 * Such hosts hold nothing worth indexing, so a name or an address on that list is never
 * fetched.
 *
 * The file is re-read when it changes (checked at most once a minute). No file (a box
 * without threatcrushd, a test) means nothing is listed: the gate is never a reason to stop
 * crawling.
 */
import { readFileSync, statSync } from 'node:fs'

/** threatcrushd's feed cache. In the dev2 container, /var/lib/threatcrush is mounted read-only. */
export const DEFAULT_FEEDS_PATH = '/var/lib/threatcrush/threat-feeds.json'

export interface ThreatFeeds {
  ips: Set<string>
  domains: Set<string>
}

/** A ThreatCrush FeedSet (`threat-feeds.json`) as the two sets the crawler asks. Null when it is not one. */
export function parseFeeds(text: string): ThreatFeeds | null {
  try {
    const set = JSON.parse(text) as { ips?: unknown; domains?: unknown }
    if (!set || typeof set.ips !== 'object' || typeof set.domains !== 'object' || !set.ips || !set.domains) return null
    return {
      ips: new Set(Object.keys(set.ips).map((ip) => ip.toLowerCase())),
      domains: new Set(Object.keys(set.domains).map((d) => d.toLowerCase().replace(/\.$/, ''))),
    }
  } catch {
    return null
  }
}

/** The listed name a host falls under: itself or any parent (the same rule as threatcrushd's matchDomain). */
export function listedDomain(host: string, feeds: ThreatFeeds | null): string | null {
  if (!feeds || !feeds.domains.size) return null
  const labels = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '').split('.')
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.')
    if (feeds.domains.has(candidate)) return candidate
  }
  return null
}

/** Whether an address is listed, `::ffff:a.b.c.d` read as the IPv4 address it is. */
export function listedAddress(ip: string, feeds: ThreatFeeds | null): boolean {
  if (!feeds || !feeds.ips.size) return false
  return feeds.ips.has(ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, ''))
}

/**
 * The feeds at `path`, re-read when the file's mtime moves (looked at once per `checkMs`).
 * A file that disappears or stops parsing keeps the last good copy.
 */
export function feedsLoader(
  path = process.env.CRAWL_THREAT_FEEDS ?? DEFAULT_FEEDS_PATH,
  options: { checkMs?: number; log?: (line: string) => void; now?: () => number } = {},
): () => ThreatFeeds | null {
  const { checkMs = 60_000, log = () => {}, now = Date.now } = options
  let feeds: ThreatFeeds | null = null
  let mtime = 0
  let checked = -Infinity
  let missingNoted = false
  return () => {
    if (now() - checked < checkMs) return feeds
    checked = now()
    if (!path) return feeds
    try {
      const m = statSync(path).mtimeMs
      if (m === mtime) return feeds
      const next = parseFeeds(readFileSync(path, 'utf8'))
      if (next) {
        feeds = next
        mtime = m
        log(`threat feeds: ${next.domains.size} domains, ${next.ips.size} addresses from ${path}`)
      }
    } catch {
      if (!missingNoted) log(`threat feeds: ${path} not readable; no host is refused for reputation`)
      missingNoted = true
    }
    return feeds
  }
}

let shared: (() => ThreatFeeds | null) | null = null

/** The process-wide feeds, loaded on first use. */
export function threatFeeds(): ThreatFeeds | null {
  shared ??= feedsLoader(undefined, { log: (line) => console.log(line) })
  return shared()
}
