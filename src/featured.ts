/**
 * Our own network first: when a web search matches a pit.world ring site, a promo box for it sits above
 * the outside results (Anthony 2026-10-27: "we always push our net first via promo boxes").
 *
 * Only the core ring (our own sites), never claimed business listings: those get their own card.
 * Matching is local and free: the query is held against each site's name, keywords and about line.
 */
import { RING, type RingSite } from './ring.js'

const STOP = new Set(
  'a an and are as at be best by can do for free from get how i in is it me my of on online or the to top what where who why with you your app apps site website'.split(' '),
)
const NAME_NOISE = new Set(['pit', 'world'])

const words = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean)
const flat = (text: string) => words(text).join(' ')

/** How strongly a query points at a site; 0 when it does not. */
export function score(query: string, site: RingSite): number {
  const terms = words(query).filter((w) => !STOP.has(w))
  if (!terms.length) return 0
  const phrase = ` ${flat(query)} `
  const compact = terms.join('')
  const labels = site.name.toLowerCase().split('.').filter((l) => l && !NAME_NOISE.has(l))
  let points = 0
  // The name typed whole, with or without its dots or spaces ("off the record podcast", "group.call").
  const name = labels.join('')
  if (name.length >= 6 && compact.includes(name)) points += 10
  for (const label of labels) {
    if (label.length < 3) continue
    if (terms.includes(label)) points += 4
    else if (label.length >= 6 && compact.includes(label)) points += 4
  }
  for (const k of site.keywords ?? []) if (phrase.includes(` ${flat(k)} `)) points += 6
  const about = new Set(words(site.about).filter((w) => w.length >= 4 && !STOP.has(w)))
  for (const t of terms) if (t.length >= 4 && about.has(t)) points += 2
  return points
}

/** The ring sites a query is about, best first; at most `max`. */
export function featuredFor(query: string, max = 2, sites: RingSite[] = RING): RingSite[] {
  return sites
    .map((site) => ({ site, points: score(query, site) }))
    .filter((s) => s.points >= 4)
    .sort((a, b) => b.points - a.points)
    .slice(0, max)
    .map((s) => s.site)
}
