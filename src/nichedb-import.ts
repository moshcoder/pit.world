/**
 * Business listings from NicheDB's directory collection, which mirrors OutreachGraph's public
 * directory (companies by domain, their industry and stack; never an email, phone or person).
 *
 * Read incrementally like NicheDB's own sync: in id order after a saved id (a keyset, so rows that
 * share a timestamp are never skipped), a few pages a run, so the first pass over ~220k companies takes hours of small batches instead of
 * one big job at boot. Only companies whose domain resolves to a public address are listed.
 */
import { Resolver } from 'node:dns/promises'
import type { ImportInput, Listings } from './listings.js'
import { isPublicAddress, normalizeDomain } from './listings.js'

export const NICHEDB_ITEMS = 'https://nichedb.dev/api/v1/items'
export const IMPORT_SOURCE = 'nichedb-directory'
const PAGE = 200

type Item = {
  id?: unknown
  kind?: unknown
  url?: unknown
  title?: unknown
  page?: unknown
  data?: { row?: { kind?: unknown; name?: unknown; topics?: unknown; country?: unknown } } | null
}

/** Industries (OutreachGraph's first topic) to the /pros categories. First match wins; no match is no category. */
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/construction|remodel|roofing|contractor/, 'construction'],
  [/real estate|property/, 'real-estate'],
  [/news|media|podcast|publishing|journalism|film|music|phonograph|broadcast|anime|video game|entertainment/, 'media'],
  [/retail|e-?commerce|deals|coupon|clothing|fashion|wholesale|shop|store|consumer goods/, 'retail'],
  [/software|ai tooling|productivity|saas|developer tools|information technology|internet service|web development/, 'software'],
  [/telecom|hosting|cloud|cyber|network|computer/, 'it'],
  [/bank|financ|insurance|invest|fintech|crypto|payment/, 'finance'],
  [/account|tax|bookkeep/, 'accounting'],
  [/law|legal/, 'legal'],
  [/pharma|biotech|health|medical|hospital|clinic|dental/, 'health'],
  [/fitness|wellness|sport/, 'wellness'],
  [/cosmetic|beauty/, 'beauty'],
  [/education|school|universit|tutor|learning/, 'education'],
  [/food|restaurant|brew|beverage|catering|hospitality|wine|coffee|bakery/, 'food'],
  [/design|architect|creative|advertising|branding|photograph/, 'design'],
  [/marketing|consult|staffing|recruit|human resources/, 'consulting'],
  [/automotive|car |vehicle|tire/, 'auto'],
  [/industr|manufactur|energy|petroleum|oil|chemical|mechanical|electronic|battery|shipbuild|mining|steel|utility|power/, 'industrial'],
  [/logistic|moving|storage|freight/, 'moving'],
  [/nonprofit|charity|church|religio|community/, 'community'],
  [/pet|veterinar/, 'pets'],
]

/** Never listed: adult and gambling businesses, by industry or by the words in the domain. */
const DENY = /porn|adult|escort|gambl|casino|betting|\bsex|xxx|hentai|camgirl|onlyfans/

/**
 * A company with no industry leads its topics with the tech its site runs on ("google analytics",
 * "wordpress"), which says nothing about the business. A store platform is the one useful hint.
 */
const TECH = /google|tag manager|wordpress|squarespace|wix|webflow|cloudflare|netlify|vercel|next\.js|nuxt|react|vue|angular|svelte|gatsby|hugo|jekyll|ghost|framer|hubspot|amplitude|calendly|stripe|jquery|bootstrap|nginx|apache|php|typescript|javascript|mailchimp|intercom|segment|hotjar|facebook|plausible|matomo|mixpanel|sentry|recaptcha|font|cdn|aws|heroku|github|gitlab|docusaurus|astro|tailwind|elementor|yoast|drupal|joomla|typekit|zendesk|klaviyo|tiktok|linkedin|twitter|youtube|vimeo|unpkg|jsdelivr/
const STORE_TECH = /shopify|woocommerce|bigcommerce|magento|prestashop|squarespace commerce|ecwid/

/** Bump when the rules change: imported listings are re-categorised once (Listings.recategorizeImported). */
export const CATEGORY_RULES_VERSION = '2'

export function categoryFor(topic: string): string {
  const t = topic.toLowerCase()
  if (STORE_TECH.test(t)) return 'retail'
  if (TECH.test(t)) return ''
  for (const [rule, slug] of CATEGORY_RULES) if (rule.test(t)) return slug
  return ''
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** One NicheDB directory item as a listing, or null: not a company, no usable domain, or denied. */
export function importCandidate(item: Item): ImportInput | null {
  const row = item.data?.row
  if (item.kind !== 'company' || row?.kind !== 'company') return null
  const domain = normalizeDomain(str(item.url))
  if (!domain || domain === 'pit.world' || domain.endsWith('.pit.world')) return null
  const topics = Array.isArray(row.topics) ? row.topics.filter((t): t is string => typeof t === 'string') : []
  const industry = topics[0] ?? ''
  if (DENY.test(`${industry} ${domain}`.toLowerCase())) return null
  let sourceUrl = ''
  try {
    const url = new URL(str(item.page))
    if (url.protocol === 'https:' && url.hostname === 'nichedb.dev' && /^\/i\/\d+$/.test(url.pathname)) sourceUrl = url.href
  } catch {}
  if (!sourceUrl) return null
  return { domain, name: str(row.name) || str(item.title) || domain, category: categoryFor(industry), country: str(row.country), topics, sourceUrl }
}

/** Does the domain resolve to a public address? c-ares with a short timeout, so a slow zone cannot stall the batch. */
export function dnsCheck(timeoutMs = 2500): (domain: string) => Promise<boolean> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 })
  return async (domain) => {
    for (const ask of [() => resolver.resolve4(domain), () => resolver.resolve6(domain)]) {
      const addresses = await ask().catch(() => [] as string[])
      if (addresses.length) return addresses.every(isPublicAddress)
    }
    return false
  }
}

export type ImportResult = { read: number; candidates: number; resolved: number; imported: number; caughtUp: boolean; cursor: string | null }

/**
 * One run: up to `pages` pages from the saved cursor. Each page is checked and written before the next
 * is read, so memory stays at one page and a crash loses at most that page (the cursor is saved per page).
 */
export async function importNicheDb(
  listings: Pick<Listings, 'importListings' | 'importCursor' | 'setImportCursor'>,
  options: { fetchImpl?: typeof fetch; resolves?: (domain: string) => Promise<boolean>; pages?: number; concurrency?: number; base?: string } = {},
): Promise<ImportResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const resolves = options.resolves ?? dnsCheck()
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 8))
  let after = Number(listings.importCursor(IMPORT_SOURCE) ?? 0) || 0
  const result: ImportResult = { read: 0, candidates: 0, resolved: 0, imported: 0, caughtUp: false, cursor: after ? String(after) : null }
  for (let page = 0; page < (options.pages ?? 10); page++) {
    const url = new URL(options.base ?? NICHEDB_ITEMS)
    url.searchParams.set('collection', 'directory')
    url.searchParams.set('sort', 'id')
    url.searchParams.set('order', 'asc')
    url.searchParams.set('limit', String(PAGE))
    if (after) url.searchParams.set('after', String(after))
    // threatcrush-disable-next-line js-ssrf-outbound-request  fixed NicheDB host
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json', 'user-agent': 'pit.world directory import (+https://pit.world/pros)' } })
    if (!response.ok) throw new Error(`NicheDB answered ${response.status}`)
    const body = (await response.json()) as { items?: Item[] } | null
    const items = Array.isArray(body?.items) ? body.items : []
    result.read += items.length
    const candidates = items.map(importCandidate).filter((c): c is ImportInput => c !== null)
    result.candidates += candidates.length
    const live: ImportInput[] = []
    let next = 0
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < candidates.length) {
          const c = candidates[next++]!
          if (await resolves(c.domain).catch(() => false)) live.push(c)
        }
      }),
    )
    result.resolved += live.length
    result.imported += listings.importListings(live)
    const last = Math.max(after, ...items.map((i) => Number(i.id)).filter(Number.isFinite))
    if (last > after) {
      after = last
      listings.setImportCursor(IMPORT_SOURCE, String(after))
    }
    result.cursor = after ? String(after) : null
    if (items.length < PAGE) {
      result.caughtUp = true
      break
    }
  }
  return result
}
