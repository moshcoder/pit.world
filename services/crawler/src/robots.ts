/**
 * robots.txt, the Google reading: the group naming our token, else `*`;
 * the longest matching rule wins; Allow beats Disallow on a tie; `*` and `$`
 * in patterns; no rule is permission. Crawl-delay is honoured up to a cap.
 */
import { BOT } from './config.ts'

export type Rule = { allow: boolean; pattern: string }
export type Robots = { rules: Rule[]; crawlDelayMs: number | null; sitemaps: string[] }

export const EMPTY: Robots = { rules: [], crawlDelayMs: null, sitemaps: [] }

export function parseRobots(text: string, token = BOT): Robots {
  type Group = { agents: string[]; rules: Rule[]; delay: number | null }
  const groups: Group[] = []
  const sitemaps: string[] = []
  let current: Group | null = null
  let lastWasAgent = false
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === 'sitemap') {
      if (/^https?:\/\//i.test(value)) sitemaps.push(value)
      continue
    }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!current) continue
    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow allows everything: it is no rule at all.
      if (value) current.rules.push({ allow: key === 'allow', pattern: value })
    } else if (key === 'crawl-delay') {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds >= 0) current.delay = seconds * 1000
    }
  }
  const me = token.toLowerCase()
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && me.startsWith(a)))
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'))
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelayMs: chosen.map((g) => g.delay).find((d) => d !== null) ?? null,
    sitemaps,
  }
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const re = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${re}${anchored ? '$' : ''}`).test(path)
}

/** Whether the path (with its query) may be read. */
export function allows(robots: Robots, pathAndQuery: string): boolean {
  let best: Rule | null = null
  for (const rule of robots.rules) {
    if (!matches(rule.pattern, pathAndQuery)) continue
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule
  }
  return best ? best.allow : true
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`
  } catch {
    return '/'
  }
}
