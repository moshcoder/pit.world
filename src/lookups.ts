/**
 * `isbn:<number>` and `vin:<vin>` in the search box: a card from nichedb above the ordinary results.
 *
 * The web search below it gets the bare number, since no engine understands the prefix. nichedb is
 * asked by pit.world, so it sees our address and not the visitor's. Seller links stay on nichedb:
 * they carry its affiliate tags, and a private search page does not show those.
 */
export type Lookup = { kind: 'isbn' | 'vin'; value: string }

export type LookupCard = {
  kind: 'isbn' | 'vin'
  value: string
  title: string
  /** Facts, one line each, as nichedb gave them. */
  lines: string[]
  /** A cover, by reference. */
  image?: string
  /** The whole record on nichedb. */
  url: string
  /** Set when the number is fine but nichedb could not answer: the card says so and links there. */
  unavailable?: boolean
  /** Set when the number itself is wrong. */
  invalid?: string
}

type Fetch = typeof fetch

const NICHEDB = 'https://nichedb.dev'
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** A query that is a lookup, or null. Hyphens and spaces in an ISBN are how people type them. */
export function parseLookup(query: string): Lookup | null {
  const isbn = query.trim().match(/^isbn:\s*([\dxX][\dxX -]{8,20})$/i)
  if (isbn) return { kind: 'isbn', value: isbn[1]!.replace(/[\s-]/g, '').toUpperCase() }
  const vin = query.trim().match(/^vin:\s*([a-z0-9]{1,20})$/i)
  if (vin) return { kind: 'vin', value: vin[1]!.toUpperCase() }
  return null
}

/** What goes to the web engines: the number on its own. */
export const lookupSearchTerms = (lookup: Lookup) => lookup.value

const place = (raw: string) => raw.replace(/\s*\(.*\)\s*$/, '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())

export function bookCard(value: string, body: any): LookupCard {
  const isbn13 = str(body?.isbn?.isbn13) || value
  const url = `${NICHEDB}/isbn/${encodeURIComponent(isbn13)}`
  const e = body?.edition
  const facts = body?.facts
  const known = [`ISBN ${isbn13}`, ...(str(body?.isbn?.isbn10) ? [`ISBN-10 ${str(body.isbn.isbn10)}`] : [])].join(' · ')
  if (!e?.title) {
    const said = [facts?.registeredIn ? `Registered in ${str(facts.registeredIn)}.` : '', facts?.selfPublishingLikely ? 'Numbers starting 979-8 are often self-published.' : ''].filter(Boolean).join(' ')
    return { kind: 'isbn', value, title: `ISBN ${isbn13}`, lines: ['No catalogue we can read has this edition yet.', ...(said ? [said] : [])], url }
  }
  const by = (Array.isArray(e.authors) ? e.authors : []).map(str).filter(Boolean).join(', ')
  const made = [Array.isArray(e.publishers) ? str(e.publishers[0]) : '', str(e.publishDate), typeof e.pages === 'number' && e.pages > 0 ? `${e.pages.toLocaleString('en-US')} pages` : ''].filter(Boolean).join(' · ')
  const image = str(e.cover)
  return { kind: 'isbn', value, title: str(e.title), lines: [...(str(e.subtitle) ? [str(e.subtitle)] : []), ...(by ? [by] : []), ...(made ? [made] : []), known], ...(image.startsWith('https://') ? { image } : {}), url }
}

export function vinCard(value: string, body: any): LookupCard {
  const vin = str(body?.vin) || value
  const url = `${NICHEDB}/vin?vin=${encodeURIComponent(vin)}`
  if (body?.valid === false || body?.error) return { kind: 'vin', value, title: `VIN ${vin}`, lines: [], url, invalid: str(body?.error) || 'That is not a valid VIN.' }
  const d = body?.decoded ?? {}
  const title = [body?.modelYear, str(body?.make).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), str(body?.model), str(d.Trim)].filter(Boolean).join(' ') || `VIN ${vin}`
  const litres = Number(d.DisplacementL)
  const engine = [Number.isFinite(litres) && litres > 0 ? `${litres.toFixed(1)} L` : '', str(d.EngineCylinders) ? `${str(d.EngineCylinders)} cylinders` : '', str(d.EngineHP) ? `${str(d.EngineHP)} hp` : '', str(d.FuelTypePrimary)].filter(Boolean).join(' · ')
  const body2 = [str(body?.bodyClass), str(d.Doors) ? `${str(d.Doors)} doors` : '', str(d.DriveType), str(d.TransmissionStyle)].filter(Boolean).join(' · ')
  const built = str(d.PlantCountry) ? `Built in ${place(str(d.PlantCountry))}` : ''
  return { kind: 'vin', value, title, lines: [body2, engine, built, `VIN ${vin}`].filter(Boolean), url }
}

/** Ask nichedb. Never throws: a lookup that fails must not cost anyone their search results. */
export async function runLookup(lookup: Lookup, options: { fetch?: Fetch; key?: string; base?: string } = {}): Promise<LookupCard> {
  const base = options.base ?? NICHEDB
  const { kind, value } = lookup
  const fallback: LookupCard =
    kind === 'isbn'
      ? { kind, value, title: `ISBN ${value}`, lines: ['The lookup is unavailable for a moment.'], url: `${NICHEDB}/isbn/${encodeURIComponent(value)}`, unavailable: true }
      : { kind, value, title: `VIN ${value}`, lines: ['The lookup is unavailable for a moment.'], url: `${NICHEDB}/vin?vin=${encodeURIComponent(value)}`, unavailable: true }
  const path = kind === 'isbn' ? `/api/v1/books/buy?${new URLSearchParams({ isbn: value })}` : `/api/v1/automotive/vin/${encodeURIComponent(value)}?full=false`
  try {
    const response = await (options.fetch ?? fetch)(`${base}${path}`, {
      headers: { accept: 'application/json', 'user-agent': 'pit.world search (https://pit.world/privacy)', ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
      signal: AbortSignal.timeout(6_000),
    })
    const body: any = await response.json().catch(() => null)
    // A 400 is an answer: this number is wrong. Anything else that is not ok is nichedb's trouble.
    if (response.status === 400) return { kind, value, title: `${kind.toUpperCase()} ${value}`, lines: [], url: fallback.url, invalid: str(body?.error) || `That is not a valid ${kind.toUpperCase()}.` }
    if (!response.ok || !body) return fallback
    return kind === 'isbn' ? bookCard(value, body) : vinCard(value, body)
  } catch {
    return fallback
  }
}
