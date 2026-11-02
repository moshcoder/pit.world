/**
 * robots.txt, the Google reading: the group naming our token, else `*`;
 * the longest matching rule wins; Allow beats Disallow on a tie; `*` and `$`
 * in patterns; no rule is permission. Crawl-delay is honoured up to a cap.
 */
import { BOT } from './config.ts'

export type Rule = { allow: boolean; pattern: string }
/**
 * `ai`: for each AI-training crawler below, the rules that apply to it (its own group, else `*`),
 * deduplicated; [] when none has any. `tdm`: the site's /.well-known/tdmrep.json rules.
 * Both absent on a robots.txt cached by an older crawler: the caller reads it again.
 */
export type Robots = { rules: Rule[]; crawlDelayMs: number | null; sitemaps: string[]; ai?: Rule[][]; tdm?: TdmRule[]; /** 'error': robots.txt could not be fetched (a 4xx is an answer: no rules). */ read?: 'ok' | 'error' }

export const EMPTY: Robots = { rules: [], crawlDelayMs: null, sitemaps: [], ai: [], tdm: [] }

/**
 * Crawlers that collect text for AI training. A publisher who disallows any of them for a path has
 * said no to training on it, so /api/corpus leaves the page out (pitbot may still read it for search).
 */
export const AI_TRAINING_AGENTS = [
  'gptbot',
  'google-extended',
  'ccbot',
  'claudebot',
  'anthropic-ai',
  'claude-web',
  'cohere-ai',
  'cohere-training-data-crawler',
  'bytespider',
  'perplexitybot',
  'applebot-extended',
  'meta-externalagent',
  'amazonbot',
  'omgilibot',
  'diffbot',
  'imagesiftbot',
  'timpibot',
  'ai2bot',
  'youbot',
]

/** One /.well-known/tdmrep.json entry (W3C TDMRep): a path pattern and whether TDM rights are reserved. */
export type TdmRule = { location: string; reserved: boolean }

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
  const groupsFor = (agent: string) => {
    const me = agent.toLowerCase()
    const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && me.startsWith(a)))
    return mine.length ? mine : groups.filter((g) => g.agents.includes('*'))
  }
  const chosen = groupsFor(token)
  const ai = new Map<string, Rule[]>()
  for (const agent of AI_TRAINING_AGENTS) {
    const rules = groupsFor(agent).flatMap((g) => g.rules)
    if (rules.length) ai.set(JSON.stringify(rules), rules)
  }
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelayMs: chosen.map((g) => g.delay).find((d) => d !== null) ?? null,
    sitemaps,
    ai: [...ai.values()],
    tdm: [],
  }
}

/**
 * Whether robots.txt keeps an AI-training crawler off this path. Rules from an older cache
 * (no `ai`) count as unknown: null.
 */
export function aiDisallowed(robots: Robots, pathAndQuery: string): boolean | null {
  if (!robots.ai || robots.read === 'error') return null
  return robots.ai.some((rules) => !allows({ rules, crawlDelayMs: null, sitemaps: [] }, pathAndQuery))
}

/** /.well-known/tdmrep.json, read leniently: an array of { location, "tdm-reservation" }. */
export function parseTdmrep(text: string): TdmRule[] {
  let data: unknown
  try {
    data = JSON.parse(String(text ?? ''))
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: TdmRule[] = []
  for (const entry of data.slice(0, 200)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const location = typeof e.location === 'string' ? e.location.trim() : ''
    if (!location) continue
    out.push({ location: location.startsWith('/') ? location : `/${location}`, reserved: Number(e['tdm-reservation']) === 1 })
  }
  return out
}

/** TDMRep: the first rule whose location matches the path decides. */
export function tdmReserved(rules: TdmRule[] | undefined, pathAndQuery: string): boolean {
  for (const rule of rules ?? []) if (matches(rule.location, pathAndQuery)) return rule.reserved
  return false
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
