/**
 * The training corpus: cursor paging over the local index, safe queries, comma lists,
 * and the publisher opt-outs that keep a page out of it.
 */
import { describe, expect, test } from 'bun:test'
import { headerOptOut, trainingFor } from '../src/crawler.ts'
import { extract } from '../src/extract.ts'
import { corpusMatch, IndexStore } from '../src/index-store.ts'
import { aiDisallowed, parseRobots, parseTdmrep, tdmReserved } from '../src/robots.ts'

const OPEN = { allowed: true, reason: 'no reservation' }
const entry = (url: string, body: string, training: { allowed: boolean; reason: string } | null = OPEN, extra: { language?: string; kind?: string; fetched_at?: string } = {}) => ({
  record: { url, canonical: url, title: `T ${url}`, description: null, kind: extra.kind ?? 'page', language: extra.language ?? 'en', fetched_at: extra.fetched_at ?? '2026-11-02T00:00:00.000Z' },
  enrichment: { keywords: [], excerpt: body, text: body, ...(training ? { training } : {}) },
})

describe('corpus queries', () => {
  test('raw input never reaches MATCH as syntax; commas are alternatives', () => {
    expect(corpusMatch('saas')).toBe('"saas"')
    expect(corpusMatch('saas,business,crypto')).toBe('"saas" OR "business" OR "crypto"')
    expect(corpusMatch('open source, self-hosted')).toBe('("open" AND "source") OR ("self" AND "hosted")')
    expect(corpusMatch(' , ,')).toBeNull()
    const store = new IndexStore(':memory:')
    store.add([entry('https://a.example/', 'TypeError: x is not a function')])
    for (const q of ['catch-all', 'TypeError: x', 'foo(bar', 'NEAR(a b)', '"', '***', '-x', 'a OR', 'title:x', '^x', ',,,'])
      expect(() => store.corpus({ q })).not.toThrow()
    expect(store.corpus({ q: 'typeerror: x' }).items).toHaveLength(1)
  })

  test('comma lists return pages matching any term', () => {
    const store = new IndexStore(':memory:')
    store.add([entry('https://a.example/1', 'saas pricing'), entry('https://b.example/2', 'crypto wallets'), entry('https://c.example/3', 'gardening')])
    expect(store.corpus({ q: 'saas,crypto' }).items.map((i) => i.url)).toEqual(['https://a.example/1', 'https://b.example/2'])
    expect(store.corpus({ q: 'saas pricing,nothing here' }).items.map((i) => i.url)).toEqual(['https://a.example/1'])
  })

  test('cursor paging is stable, complete and has no duplicates, also while pages are added', () => {
    const store = new IndexStore(':memory:')
    store.add(Array.from({ length: 25 }, (_, i) => entry(`https://s${i % 3}.example/${i}`, `widget number ${i}`)))
    const seen: string[] = []
    let cursor: string | null = '0'
    let pages = 0
    while (cursor !== null) {
      const page = store.corpus({ q: 'widget', limit: 10, cursor: Number(cursor) })
      seen.push(...page.items.map((i) => i.url))
      cursor = page.next_cursor
      // A page added mid-harvest lands after the cursor: it is read, never shifts what was read.
      if (pages++ === 0) store.add([entry('https://late.example/x', 'widget late')])
    }
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(26)
    expect(seen.at(-1)).toBe('https://late.example/x')
    // A re-crawl keeps the id: it does not come round again.
    store.add([entry('https://s0.example/0', 'widget again')])
    const after = store.corpus({ q: 'widget', cursor: Number(store.corpus({ q: 'widget', limit: 100 }).resume_cursor) })
    expect(after.items).toEqual([])
    expect(after.next_cursor).toBeNull()
  })

  test('empty q pages the whole open corpus; filters by site, kind, language and date', () => {
    const store = new IndexStore(':memory:')
    store.add([
      entry('https://a.example/1', 'one', OPEN, { language: 'en-us' }),
      entry('https://a.example/2', 'two', OPEN, { language: 'de', kind: 'article' }),
      entry('https://b.example/3', 'three', OPEN, { fetched_at: '2026-10-01T00:00:00.000Z' }),
    ])
    expect(store.corpus({}).items).toHaveLength(3)
    expect(store.corpus({ site: 'www.a.example' }).items.map((i) => i.url)).toEqual(['https://a.example/1', 'https://a.example/2'])
    expect(store.corpus({ lang: 'en' }).items.map((i) => i.url)).toEqual(['https://a.example/1', 'https://b.example/3'])
    expect(store.corpus({ kind: 'article' }).items.map((i) => i.url)).toEqual(['https://a.example/2'])
    expect(store.corpus({ since: '2026-11-01T00:00:00.000Z' }).items).toHaveLength(2)
    const first = store.corpus({ limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(store.corpus({ limit: 2, cursor: Number(first.next_cursor) }).items.map((i) => i.url)).toEqual(['https://b.example/3'])
    expect(store.corpus({ textMax: 2 }).items[0]!.text).toBe('on')
  })

  test('reserved and unknown pages are never in it; the backfill decides unknown ones', () => {
    const store = new IndexStore(':memory:')
    store.add([
      entry('https://a.example/open', 'alpha open'),
      entry('https://a.example/noai', 'alpha reserved', { allowed: false, reason: 'meta robots: noai' }),
      entry('https://old.example/x', 'alpha legacy', null),
    ])
    expect(store.corpus({ q: 'alpha' }).items.map((i) => i.url)).toEqual(['https://a.example/open'])
    const stats = store.corpusStats()
    expect(stats).toMatchObject({ pages: 1, excluded: 1, unknown: 1 })
    expect(store.unknownSites()).toEqual(['old.example'])
    const [legacy] = store.unknownPagesOf('old.example')
    store.setPolicies('old.example', [{ id: legacy!.id, allowed: true, reason: 'site allows (backfill)' }])
    expect(store.unknownSites()).toEqual([])
    expect(store.corpus({ q: 'alpha' }).items).toHaveLength(2)
    // A record without a verdict (an old outbox line) keeps the one already made.
    store.add([entry('https://a.example/noai', 'alpha reserved', null)])
    expect(store.corpus({ q: 'alpha' }).items).toHaveLength(2)
  })

  test('mapLegacy gives pages from before the policy table a row, once', () => {
    const store = new IndexStore(':memory:')
    store.add([entry('https://a.example/1', 'x', null), entry('https://a.example/2', 'y', null)])
    ;(store as any).db.run('DELETE FROM page_policy')
    expect(store.mapLegacy(1)).toBe(1)
    expect(store.mapLegacy(10)).toBe(1)
    expect(store.mapLegacy(10)).toBe(0)
    expect(store.corpusStats(0)).toMatchObject({ unknown: 2, pages: 0 })
  })
})

describe('training opt-outs', () => {
  const robots = parseRobots(`
User-agent: *
Disallow: /private

User-agent: GPTBot
Disallow: /blog/

User-agent: CCBot
Disallow: /
Allow: /public/
`)
  test('robots.txt groups for AI-training crawlers, path by path', () => {
    expect(aiDisallowed(robots, '/blog/post')).toBe(true)
    // CCBot may read /public/, GPTBot only stays out of /blog/, the rest fall back to *.
    expect(aiDisallowed(robots, '/public/page')).toBe(false)
    expect(aiDisallowed(robots, '/about')).toBe(true) // CCBot: Disallow /
    expect(aiDisallowed(robots, '/private/x')).toBe(true) // * applies to the unnamed AI crawlers
    expect(aiDisallowed(parseRobots('User-agent: *\nDisallow: /x\n'), '/y')).toBe(false)
    expect(aiDisallowed(parseRobots('User-agent: *\nDisallow: /x\n'), '/x/1')).toBe(true)
    expect(aiDisallowed(parseRobots('User-agent: Google-Extended\nDisallow: /\n'), '/')).toBe(true)
    expect(aiDisallowed(parseRobots(''), '/anything')).toBe(false)
    // Cached by an older crawler (no `ai`), or unreadable: unknown.
    expect(aiDisallowed({ rules: [], crawlDelayMs: null, sitemaps: [] }, '/')).toBeNull()
    expect(aiDisallowed({ ...parseRobots(''), read: 'error' }, '/')).toBeNull()
  })

  test('TDMRep file: first matching location decides', () => {
    const rules = parseTdmrep('[{"location":"/news/*","tdm-reservation":1},{"location":"/*","tdm-reservation":0}]')
    expect(tdmReserved(rules, '/news/a')).toBe(true)
    expect(tdmReserved(rules, '/about')).toBe(false)
    expect(parseTdmrep('not json')).toEqual([])
  })

  test('headers and meta: noai and tdm-reservation reserve; noimageai alone does not reserve text', () => {
    expect(headerOptOut({ robotsTag: 'noai, noimageai', tdmReservation: '' })).toBe('x-robots-tag: noai')
    expect(headerOptOut({ robotsTag: 'gptbot: noai', tdmReservation: '' })).toBe('x-robots-tag: noai')
    expect(headerOptOut({ robotsTag: 'noimageai', tdmReservation: '' })).toBe('')
    expect(headerOptOut({ robotsTag: '', tdmReservation: '1' })).toBe('tdm-reservation header')
    const noai = extract('<html><head><meta name="robots" content="index, noai"></head><body>x</body></html>', 'https://e.com/')
    expect(noai.noai).toBe(true)
    const tdm = extract('<html><head><meta name="tdm-reservation" content="1"></head><body>x</body></html>', 'https://e.com/')
    expect(tdm.tdmReserved).toBe(true)
    const open = parseRobots('')
    expect(trainingFor({ robots: open, path: '/', noai: true, tdmMeta: false })).toEqual({ allowed: false, reason: 'meta robots: noai' })
    expect(trainingFor({ robots: open, path: '/', noai: false, tdmMeta: true }).allowed).toBe(false)
    expect(trainingFor({ robots: open, path: '/', noai: false, tdmMeta: false, optOut: 'x-robots-tag: noai' }).allowed).toBe(false)
    expect(trainingFor({ robots: { ...open, tdm: [{ location: '/', reserved: true }] }, path: '/a', noai: false, tdmMeta: false }).reason).toBe('tdmrep.json')
    expect(trainingFor({ robots, path: '/blog/x', noai: false, tdmMeta: false }).reason).toBe('robots.txt disallows AI crawlers')
    expect(trainingFor({ robots: open, path: '/', noai: false, tdmMeta: false })).toEqual({ allowed: true, reason: 'no reservation' })
  })
})
