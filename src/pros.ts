/**
 * The professional services directory (/pros): the fixed category list, price bands, and the field
 * rules for who runs a listing. Kept apart from listings.ts so the CLI, the MCP server and the pages
 * can share it without pulling in SQLite.
 *
 * No reviews, no ranking for money. A listing is what its verified owner says, and the directory
 * shows them most recently updated first.
 */

export type Category = { slug: string; label: string; examples: string }

/** Fixed, so the directory stays browsable. Order is the order they are shown in. */
export const CATEGORIES: Category[] = [
  { slug: 'home-services', label: 'Home services', examples: 'plumbing, electrical, HVAC, cleaning, handyman' },
  { slug: 'construction', label: 'Construction & remodeling', examples: 'contractors, roofing, painting, flooring' },
  { slug: 'outdoor', label: 'Landscaping & outdoor', examples: 'lawn care, tree service, pools, fencing' },
  { slug: 'moving', label: 'Moving & storage', examples: 'movers, junk removal, storage' },
  { slug: 'auto', label: 'Auto services', examples: 'repair, detailing, towing, tires' },
  { slug: 'legal', label: 'Legal', examples: 'attorneys, notaries, immigration, estate planning' },
  { slug: 'accounting', label: 'Accounting & tax', examples: 'bookkeeping, CPAs, payroll, tax prep' },
  { slug: 'finance', label: 'Financial & insurance', examples: 'advisers, insurance agents, mortgage brokers' },
  { slug: 'real-estate', label: 'Real estate', examples: 'agents, property management, appraisal' },
  { slug: 'software', label: 'Software & dev agencies', examples: 'web and app development, open-source tools, AI agents' },
  { slug: 'it', label: 'IT & tech support', examples: 'networking, repair, security, hosting' },
  { slug: 'design', label: 'Design & creative', examples: 'graphic design, branding, illustration, architecture' },
  { slug: 'writing', label: 'Writing & translation', examples: 'copywriting, editing, translation, transcription' },
  { slug: 'photo-video', label: 'Photo, video & events', examples: 'photographers, videographers, DJs, event planning' },
  { slug: 'consulting', label: 'Business consulting', examples: 'strategy, operations, HR, recruiting' },
  { slug: 'health', label: 'Health & medical', examples: 'clinics, dentists, therapists, chiropractors' },
  { slug: 'wellness', label: 'Fitness & wellness', examples: 'personal trainers, yoga, massage, nutrition' },
  { slug: 'beauty', label: 'Beauty & personal care', examples: 'salons, barbers, nails, skincare' },
  { slug: 'education', label: 'Tutoring & lessons', examples: 'tutors, music lessons, test prep, coding classes' },
  { slug: 'childcare', label: 'Childcare & family', examples: 'nannies, daycare, elder care' },
  { slug: 'pets', label: 'Pet services', examples: 'vets, groomers, walkers, sitters' },
  { slug: 'food', label: 'Food & catering', examples: 'caterers, personal chefs, bakeries' },
  { slug: 'community', label: 'Nonprofit & community', examples: 'charities, clubs, co-ops, places of worship' },
  { slug: 'industrial', label: 'Industrial power & equipment', examples: 'switchgear, electrical distribution, industrial controls, data centers' },
  { slug: 'other', label: 'Other services', examples: 'anything that fits nowhere else' },
]

/** Price bands: what a visitor can expect before asking. */
export const PRICES = [
  { slug: 'free', label: 'Free' },
  { slug: '$', label: '$ · budget' },
  { slug: '$$', label: '$$ · moderate' },
  { slug: '$$$', label: '$$$ · premium' },
  { slug: '$$$$', label: '$$$$ · luxury' },
  { slug: 'quote', label: 'Quote on request' },
] as const

export function categoryOf(input: unknown): Category | null {
  if (typeof input !== 'string') return null
  const key = input.trim().toLowerCase()
  return CATEGORIES.find((c) => c.slug === key || c.label.toLowerCase() === key) ?? null
}

export function priceLabel(slug: string): string {
  return PRICES.find((p) => p.slug === slug)?.label ?? ''
}

const strip = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** Services offered: one per line (or an array), up to 12, 80 characters each, no duplicates. */
export function cleanServices(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n|;/) : []
  const out: string[] = []
  for (const raw of list) {
    const item = strip(raw, 80)
    if (item && !out.some((o) => o.toLowerCase() === item.toLowerCase())) out.push(item)
    if (out.length >= 12) break
  }
  return out
}

/** An http(s) URL, normalized, or null. */
export function normalizeWebUrl(value: unknown): string | null {
  const text = strip(value, 300)
  if (!text) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname)) return null
    return url.href
  } catch {
    return null
  }
}

/**
 * Who operates a listing: an agent or person handle, `name@host` (riotcoder@profullstack.com), or an
 * https URL (an OpenAgent record, a profile page). Null for anything else. A handle is not treated as
 * an email address and is never turned into a mailto: link.
 */
export function normalizeOperator(value: unknown): string | null {
  const text = strip(value, 300).replace(/^@(?=[^@]+@)/, '')
  if (!text) return null
  const handle = /^([a-z0-9][a-z0-9._-]{0,63})@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/i.exec(text)
  if (handle) return `${handle[1]}@${handle[2]}`.toLowerCase()
  if (/^https:\/\//i.test(text)) return normalizeWebUrl(text)
  return null
}

/** The page to link an operator to: only a URL operator has one. */
export function operatorHref(operator: string): string | null {
  return /^https?:\/\//.test(operator) ? operator : null
}

/**
 * The pit.world ring is for *.pit.world sites only: a pit.world subdomain, or a Moshpit name, which
 * pit.world relays at <name>.pit.world. A business on its own ICANN domain can claim a listing and be
 * in /pros, but it is not a ring member.
 */
export const ringEligible = (domain: string, moshpitOnly: boolean) => moshpitOnly || domain.endsWith('.pit.world')
