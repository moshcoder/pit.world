import { describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { importFromNichedb, recordOf } from '../src/import-nichedb.ts'
import { IndexStore } from '../src/index-store.ts'

/** An item shaped the way nichedb's /api/v1/items hands one over. */
const item = (id: number, over: { url?: string; fetched?: string; excerpt?: string; title?: string } = {}) => ({
  id,
  url: over.url ?? `https://s${id}.example/a`,
  title: over.title ?? `Page ${id}`,
  summary: 'A short summary.',
  data: {
    record: {
      url: over.url ?? `https://s${id}.example/a`,
      canonical: over.url ?? `https://s${id}.example/a`,
      kind: 'article',
      title: over.title ?? `Page ${id}`,
      description: 'A short summary.',
      language: 'en',
      site: { name: `s${id}.example`, web: `https://s${id}.example` },
      fetched_at: over.fetched ?? '2026-11-03T00:00:00.000Z',
    },
    enrichment: {
      words: 210,
      images: [{ url: 'https://s.example/i.jpg', alt: 'a picture' }],
      excerpt: over.excerpt ?? `the body of ${id}`,
      keywords: ['alpha', 'beta'],
      language: 'en',
    },
  },
})

const serve = (pages: Array<ReturnType<typeof item>[]>, seen: Array<{ url: string; auth: string | null }> = []) => {
  let call = 0
  const fake = (async (input: string | URL, init?: RequestInit) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') })
    return Response.json({ items: pages[call++] ?? [] })
  }) as typeof fetch
  return { fake, seen }
}

const temp = (label: string) => `${tmpdir()}/pit-import-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`
const clean = (path: string) => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
}

describe('a record as nichedb kept it, back in the mirror', () => {
  test('maps what a published record carries', () => {
    const r = recordOf(item(7))!
    expect(r.record).toMatchObject({
      canonical: 'https://s7.example/a',
      title: 'Page 7',
      description: 'A short summary.',
      kind: 'article',
      language: 'en',
      fetched_at: '2026-11-03T00:00:00.000Z',
      site: { name: 's7.example' },
    })
    expect(r.enrichment.keywords).toEqual(['alpha', 'beta'])
    // No full text on a published record: the excerpt is the body there is.
    expect(r.enrichment.excerpt).toBe('the body of 7')
    expect(r.enrichment.text).toBeUndefined()
    // And no training verdict, so the page counts as unknown and stays out of the corpus.
    expect(r.enrichment.training).toBeUndefined()
  })

  test('falls back to the item when the record is thin, and refuses one it cannot key', () => {
    const thin = { id: 9, url: 'https://t.example/x', title: 'T', summary: 'S' }
    expect(recordOf(thin)!.record).toMatchObject({ canonical: 'https://t.example/x', title: 'T', description: 'S', kind: 'page' })
    expect(recordOf({ id: 10 })).toBeNull()
  })
})

describe('the backfill', () => {
  test('pages through the collection, writes every page, and ends with no cursor', async () => {
    const path = temp('walk')
    const store = new IndexStore(path, 1024 ** 3)
    const { fake, seen } = serve([[item(30), item(29)], [item(28)]])
    const result = await importFromNichedb(store, { nichedbUrl: 'https://nichedb.test', key: 'k1', fetch: fake, pageSize: 2, pauseMs: 0 })
    expect(result).toMatchObject({ read: 3, kept: 3, skipped: 0, locked: 0, cursor: null })
    expect(store.count()).toBe(3)
    // Searchable on what the record carried.
    expect(store.search('alpha')).toHaveLength(3)
    expect(store.search('body of 28')).toHaveLength(1)
    // Newest first, and the key goes on every request.
    expect(seen[0]!.url).toBe('https://nichedb.test/api/v1/items?collection=sites&limit=2')
    expect(seen[1]!.url).toBe('https://nichedb.test/api/v1/items?collection=sites&limit=2&before=29')
    expect(seen.every((s) => s.auth === 'Bearer k1')).toBe(true)
    expect(store.importCursor()).toBeNull()
    store.close()
    clean(path)
  })

  test('stops at the byte ceiling and keeps a cursor to carry on from', async () => {
    const path = temp('ceiling')
    const store = new IndexStore(path, 1024 ** 3)
    const { fake } = serve([[item(50), item(49)], [item(48), item(47)]])
    // A ceiling of one byte: the first page of results already passes it.
    const result = await importFromNichedb(store, { nichedbUrl: 'https://nichedb.test', fetch: fake, pageSize: 2, maxBytes: 1, pauseMs: 0 })
    expect(result.read).toBe(2)
    expect(result.cursor).toBe(49)
    expect(store.importCursor()).toBe(49)

    // A second run carries on from the kept cursor rather than starting over.
    const seen: Array<{ url: string; auth: string | null }> = []
    const again = serve([[item(48)]], seen)
    await importFromNichedb(store, { nichedbUrl: 'https://nichedb.test', fetch: again.fake, pageSize: 2, pauseMs: 0 })
    expect(seen[0]!.url).toContain('before=49')
    expect(store.count()).toBe(3)
    store.close()
    clean(path)
  })

  test('a metered collection with no key says so, and the cursor survives the failure', async () => {
    const path = temp('402')
    const store = new IndexStore(path, 1024 ** 3)
    let call = 0
    const fake = (async () => (call++ === 0 ? Response.json({ items: [item(60), item(59)] }) : new Response('payment required', { status: 402 }))) as unknown as typeof fetch
    await expect(importFromNichedb(store, { nichedbUrl: 'https://nichedb.test', fetch: fake, pageSize: 2, pauseMs: 0 })).rejects.toThrow('NICHEDB_API_KEY is not set')
    expect(store.count()).toBe(2)
    expect(store.importCursor()).toBe(59)
    store.close()
    clean(path)
  })

  test('a page already in the index is replaced, not duplicated', async () => {
    const path = temp('upsert')
    const store = new IndexStore(path, 1024 ** 3)
    const first = serve([[item(70, { excerpt: 'old words' })]])
    await importFromNichedb(store, { nichedbUrl: 'https://nichedb.test', fetch: first.fake, pageSize: 2, pauseMs: 0 })
    const second = serve([[item(70, { excerpt: 'fresh words' })]])
    await importFromNichedb(store, { nichedbUrl: 'https://nichedb.test', fetch: second.fake, pageSize: 2, pauseMs: 0, cursor: 0 })
    expect(store.count()).toBe(1)
    expect(store.search('old')).toHaveLength(0)
    expect(store.search('fresh')).toHaveLength(1)
    store.close()
    clean(path)
  })
})

describe('the other writer', () => {
  test('a locked batch is waited out and read again, not thrown away', async () => {
    const path = temp('locked')
    const store = new IndexStore(path, 1024 ** 3)
    // The publish role holds the write lock: the first add() fails, the retry lands.
    let attempts = 0
    const realAdd = store.add.bind(store)
    store.add = ((batch: Parameters<typeof realAdd>[0]) => {
      if (++attempts === 1) throw new Error('database is locked')
      return realAdd(batch)
    }) as typeof store.add
    const { fake } = serve([[item(80), item(79)], [item(80), item(79)], [item(78)]])
    const result = await importFromNichedb(store, { nichedbUrl: 'https://nichedb.test', fetch: fake, pageSize: 2, pauseMs: 0 })
    expect(result.locked).toBe(1)
    // Both records of the locked page are in, and counted once.
    expect(store.count()).toBe(3)
    expect(result.read).toBe(3)
    expect(store.search('body of 80')).toHaveLength(1)
    store.close()
    clean(path)
  }, 20_000)

  test('a failure that is not a lock still stops the run', async () => {
    const path = temp('throw')
    const store = new IndexStore(path, 1024 ** 3)
    store.add = (() => {
      throw new Error('disk I/O error')
    }) as typeof store.add
    const { fake } = serve([[item(90)]])
    await expect(importFromNichedb(store, { nichedbUrl: 'https://nichedb.test', fetch: fake, pageSize: 2, pauseMs: 0 })).rejects.toThrow('disk I/O error')
    store.close()
    clean(path)
  })
})

describe('eviction after a bulk import', () => {
  test('drops the page read longest ago, not the one that happens to hold the lowest id', async () => {
    const path = temp('age')
    const store = new IndexStore(path)
    // The import arrives newest first, so id order is the reverse of crawl order: the
    // page with id 1 is the NEWEST. Evicting by id would throw away exactly the wrong end.
    const fat = 'lorem ipsum dolor sit amet '.repeat(200)
    store.add([
      { record: { url: 'https://new.example/', canonical: 'https://new.example/', title: 'newest', description: null, kind: 'page', language: 'en', fetched_at: '2026-11-05T00:00:00.000Z' }, enrichment: { excerpt: `${fat} zebraomega` } },
      { record: { url: 'https://old.example/', canonical: 'https://old.example/', title: 'oldest', description: null, kind: 'page', language: 'en', fetched_at: '2026-10-01T00:00:00.000Z' }, enrichment: { excerpt: `${fat} aardvarkzero` } },
    ])
    expect(store.count()).toBe(2)
    store.close()

    const bounded = new IndexStore(path, 4096)
    const result = await bounded.trim({ batch: 1, keepMin: 1 })
    expect(result.deleted).toBe(1)
    expect(bounded.search('zebraomega')).toHaveLength(1)
    expect(bounded.search('aardvarkzero')).toHaveLength(0)
    bounded.close()
    clean(path)
  })
})
