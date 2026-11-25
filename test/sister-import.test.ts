/** The sister-directory importer: newest first, capped per run, seen once, crawled and filed. */
import { describe, expect, it } from 'bun:test'
import { DirectorySites } from '../src/directory-sites.ts'
import { Listings } from '../src/listings.ts'
import { GENERAL, importSister, importSisters, pathFor, SISTER_SOURCES, type SisterDeps, type SisterSource } from '../src/sister-import.ts'

type Product = { id: string; name: string; website: string; description?: string; category?: string; tags?: string[]; saasrow_url?: string }

const saasrow = SISTER_SOURCES.find((s) => s.key === 'saasrow')!

function harness(products: Product[], options: { cap?: number; pageSize?: number; maxPages?: number; known?: (host: string) => boolean; crawlerDown?: () => boolean } = {}) {
  const listings = new Listings(':memory:')
  const sites = new DirectorySites(listings.db, Date.now, 0)
  const asked: string[] = []
  const queued: string[][] = []
  const fetchImpl = (async (input: any) => {
    const url = new URL(String(input))
    asked.push(`${url.pathname}${url.search}`)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const limit = Number(url.searchParams.get('limit') ?? 25)
    return Response.json({ data: products.slice(offset, offset + limit), pagination: { total: products.length, limit, offset } })
  }) as unknown as typeof fetch
  const deps: SisterDeps = {
    sites,
    cursors: listings,
    known: options.known ?? ((host) => sites.has(host)),
    submit: async (urls) => {
      if (options.crawlerDown?.()) throw new Error('the crawler is not taking submissions')
      queued.push(urls)
      return urls.length
    },
    fetchImpl,
    pauseMs: 0,
    ...(options.cap ? { cap: options.cap } : {}),
    ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    ...(options.maxPages ? { maxPages: options.maxPages } : {}),
  }
  return { listings, sites, asked, queued, deps, run: () => importSister(saasrow, deps) }
}

const make = (n: number, from = 0): Product[] =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${from + i}`, name: `Product ${from + i}`, website: `https://product-${from + i}.test/?utm_source=saasrow`, category: 'Software', tags: [], saasrow_url: `https://saasrow.pwa.pit.world/software/id-${from + i}` }))

describe('sister feeds', () => {
  it('asks each directory newest first, a page at a time', () => {
    expect(SISTER_SOURCES.map((s) => s.feed(100, 100))).toEqual([
      'https://saasrow.pwa.pit.world/api/v1/products?sort=recent&limit=100&offset=100',
      'https://pwamart.com/api/v1/apps?sort=new&limit=100&offset=100',
      'https://built.indie.pit.world/api/v1/products?window=new&limit=100&offset=100',
    ])
  })

  it('reads each directory own record shape', () => {
    const [s, p, b] = SISTER_SOURCES as [SisterSource, SisterSource, SisterSource]
    expect(s.parse({ data: [{ id: 'u1', name: 'A', website: 'https://a.test', description: 'd', category: 'AI Tools', tags: ['x'], saasrow_url: 'https://saasrow.pwa.pit.world/software/u1' }] })[0]).toEqual({
      id: 'u1', name: 'A', url: 'https://a.test', description: 'd', category: 'AI Tools', tags: ['x'], page: 'https://saasrow.pwa.pit.world/software/u1',
    })
    expect(p.parse({ apps: [{ slug: 'b-app', name: 'B', url: 'https://b.test/', summary: 's', category: 'games', tags: [] }] })[0]).toMatchObject({ id: 'b-app', url: 'https://b.test/', description: 's', category: 'games', page: 'https://pwamart.com/apps/b-app' })
    expect(b.parse({ products: [{ slug: 'c', name: 'C', url: 'https://c.test/', tagline: 't', tags: ['seo'], page: 'https://built.indie.pit.world/p/c' }] })[0]).toMatchObject({ id: 'c', description: 't', category: '', tags: ['seo'] })
    expect(s.parse(null)).toEqual([])
    expect(p.parse({ apps: 'nope' })).toEqual([])
  })
})

describe('sister categories', () => {
  it('maps only what names one of ours, and files the rest under the general category', () => {
    expect(pathFor('AI Tools')).toBe('computers/ai')
    expect(pathFor('ai')).toBe('computers/ai')
    expect(pathFor('Security')).toBe('computers/security')
    expect(pathFor('News & Media')).toBe('news/news')
    expect(pathFor('games')).toBe('entertainment/games')
    expect(pathFor('Marketing')).toBe('business/advertising')
    for (const vague of ['Software', 'Productivity', 'Design', 'Analytics', 'Finance', 'Health', 'travel', 'utilities', '', 'something new']) expect(pathFor(vague)).toBe(GENERAL)
    expect(pathFor('', ['multimedia', 'SEO'])).toBe('computers/web-dev')
    expect(pathFor('Productivity', ['ai'])).toBe('computers/ai')
    expect(pathFor('Security', ['games'])).toBe('computers/security')
  })

  it('files the category adult under Adult, whatever the tags say, and nothing else there', () => {
    expect(pathFor('adult')).toBe('adult')
    expect(pathFor('Adult (18+)', ['ai'])).toBe('adult')
    expect(pathFor('Software', ['adult'])).toBe(GENERAL)
    expect(pathFor('Adult education')).toBe(GENERAL)
  })
})

describe('sister import', () => {
  it('takes at most the cap per run and trickles a backlog in, each listing once', async () => {
    const h = harness(make(230), { cap: 50 })
    const totals = { fresh: 0, added: 0, queued: 0 }
    const runs = []
    for (let i = 0; i < 6; i++) {
      const r = await h.run()
      runs.push(r)
      expect(r.fresh).toBeLessThanOrEqual(50)
      totals.fresh += r.fresh
      totals.added += r.added
      totals.queued += r.queued
    }
    expect(runs.map((r) => r.fresh)).toEqual([50, 50, 50, 50, 30, 0])
    expect(totals).toEqual({ fresh: 230, added: 230, queued: 230 })
    expect(runs.at(-1)!.backfill).toBe('done')
    expect(h.sites.all()).toHaveLength(230)
    expect(new Set(h.queued.flat()).size).toBe(230)
    // Campaign parameters never reach the crawler or the directory.
    expect(h.queued[0]![0]).toBe('https://product-0.test/')
    expect(h.sites.get('product-7.test')).toMatchObject({ path: GENERAL, source: 'saasrow', sourceUrl: 'https://saasrow.pwa.pit.world/software/id-7' })
    // Every run reads the head first, and never more than three pages.
    expect(h.asked.filter((a) => a.includes('offset=0')).length).toBe(6)
    for (const r of runs) expect(r.read).toBeLessThanOrEqual(300)
  })

  it('picks up a new launch on the next run without re-reading the backlog', async () => {
    const products = make(120)
    const h = harness(products, { cap: 200 })
    expect((await h.run()).fresh).toBe(120)
    products.unshift({ id: 'fresh-1', name: 'Fresh', website: 'https://fresh.test/', category: 'AI Tools', tags: [] })
    h.asked.length = 0
    const r = await h.run()
    expect(r).toMatchObject({ fresh: 1, added: 1, queued: 1, backfill: 'done' })
    expect(h.asked).toEqual(['/api/v1/products?sort=recent&limit=100&offset=0'])
    expect(h.sites.get('fresh.test')!.path).toBe('computers/ai')
  })

  it('does not file a host the directory already has, and still has it crawled', async () => {
    const h = harness([
      { id: 'a', name: 'Dup', website: 'https://www.seo.rank.pit.world/', category: 'Software' },
      { id: 'b', name: 'Twice', website: 'https://twice.test/a', category: 'Software' },
      { id: 'c', name: 'Twice again', website: 'https://twice.test/b', category: 'Software' },
      { id: 'd', name: 'Private', website: 'http://localhost:3000/', category: 'Software' },
      { id: 'e', name: 'Home', website: 'https://pit.world/', category: 'Software' },
    ], { known: (host) => host === 'seo.rank.pit.world' })
    const r = await h.run()
    expect(r).toMatchObject({ fresh: 5, added: 1, duplicates: 2, skipped: 2, queued: 3 })
    expect(h.sites.all().map((s) => s.host)).toEqual(['twice.test'])
    expect(h.queued.flat()).toEqual(['https://www.seo.rank.pit.world/', 'https://twice.test/a', 'https://twice.test/b'])
  })

  it('files a listing that carries the category adult under Adult, never a public one, and never crawls it', async () => {
    const h = harness([
      { id: 'x', name: 'Grown Up', website: 'https://grown-up.test/', category: 'Adult', tags: ['ai'] },
      { id: 'y', name: 'Tame', website: 'https://tame.test/', category: 'AI Tools' },
      { id: 'z', name: 'Grown Up tour', website: 'https://tour.grown-up.test/', category: 'Software' },
    ])
    const r = await h.run()
    expect(r).toMatchObject({ fresh: 3, added: 1, adult: 1, queued: 1 })
    expect(h.sites.all().map((s) => s.host)).toEqual(['tame.test'])
    expect(h.sites.adult().map((s) => s.host)).toEqual(['grown-up.test'])
    expect(h.queued).toEqual([['https://tame.test/']])
  })

  it('marks nothing seen while the crawler is down, and picks the page up again later', async () => {
    let down = true
    const h = harness(make(3), { crawlerDown: () => down })
    await expect(h.run()).rejects.toThrow('crawler')
    expect(h.sites.all()).toEqual([])
    down = false
    expect(await h.run()).toMatchObject({ fresh: 3, added: 3, queued: 3 })
  })

  it('carries on with the other directories when one fails', async () => {
    const h = harness(make(2))
    const broken: SisterSource = { key: 'broken', label: 'Broken', feed: () => 'https://broken.test/feed', parse: () => [] }
    const fetchImpl = (async (input: any) => (String(input).startsWith('https://broken.test') ? new Response('no', { status: 503 }) : h.deps.fetchImpl!(input))) as unknown as typeof fetch
    const out = await importSisters({ ...h.deps, fetchImpl }, [broken, saasrow])
    expect(out[0]).toEqual({ source: 'broken', error: 'Broken answered 503' })
    expect(out[1]).toMatchObject({ source: 'saasrow', added: 2 })
  })
})
