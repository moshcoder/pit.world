/**
 * The search mirror on a real Postgres. Runs when CRAWL_TEST_PG is set, e.g. against
 * `docker run -d --rm --name pgidx-test -e POSTGRES_PASSWORD=test -p 127.0.0.1:6493:5432 postgres:17-alpine`.
 *
 * Each test gets its own login role with a schema of the same name, so the store finds its
 * tables through the role's default search_path ("$user") and never touches public.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { IndexStore } from '../src/index-store.ts'
import { migrateIndexFromSqlite } from '../src/migrate-index.ts'
import { corpusWebsearch, PgIndexStore } from '../src/pg-index-store.ts'

const PG = process.env.CRAWL_TEST_PG
const OPEN = { allowed: true, reason: 'no reservation' }

const entry = (
  url: string,
  title: string,
  body: string,
  extra: { keywords?: string[]; kind?: string; language?: string; fetched_at?: string; training?: { allowed: boolean; reason: string } | null; description?: string | null } = {},
) => ({
  record: {
    url,
    canonical: url,
    title,
    description: extra.description ?? null,
    kind: extra.kind ?? 'page',
    language: extra.language ?? 'en',
    fetched_at: extra.fetched_at ?? '2026-11-02T00:00:00.000Z',
  },
  enrichment: { keywords: extra.keywords ?? [], excerpt: body, text: body, ...(extra.training === null ? {} : { training: extra.training ?? OPEN }) },
})

describe.skipIf(!PG)('the search mirror on a real Postgres', () => {
  const admin = PG ? new SQL({ url: PG, max: 2 }) : null
  const made: string[] = []
  const stores: PgIndexStore[] = []

  /** A fresh role + schema; returns its connection string. */
  const fresh = async () => {
    const name = `pgidx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    await admin!.unsafe(`create role ${name} login password '${name}'`)
    await admin!.unsafe(`create schema ${name} authorization ${name}`)
    made.push(name)
    const url = new URL(PG!)
    url.username = name
    url.password = name
    return url.toString()
  }
  const open = async (maxBytes = 0, options: { corpusLagMs?: number } = {}, url?: string) => {
    const store = new PgIndexStore(url ?? (await fresh()), maxBytes, { corpusLagMs: 0, max: 3, ...options })
    stores.push(store)
    return store
  }

  afterEach(async () => {
    for (const s of stores.splice(0)) await s.close().catch(() => {})
  })

  afterAll(async () => {
    for (const name of made) {
      await admin!.unsafe(`drop schema if exists ${name} cascade`)
      await admin!.unsafe(`drop role if exists ${name}`)
    }
    await admin?.close()
  })

  test("tables live in the role's own schema; whatever someone types is a valid query", async () => {
    const store = await open()
    await store.add([entry('https://a.example/', 'Node.js catch-all errors', 'TypeError: x is not a function in C# and node.js 1.3.14')])
    expect(await store.tables()).toEqual(['index_meta', 'page_cards', 'page_policy', 'pages', 'policy_site_checks'])
    const inPublic = (await admin!`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'pages'`) as { n: number }[]
    expect(inPublic[0]!.n).toBe(0)
    for (const q of ['catch-all', 'TypeError: x', 'foo(bar', 'node.js', '1.3.14', 'C#', 'why "this fails', '***', '-', 'or', 'a OR b', '!x', "it's", '\\', '_'])
      expect(Array.isArray(await store.search(q))).toBe(true)
    expect(await store.search('node.js')).toHaveLength(1)
    expect(await store.search('1.3.14')).toHaveLength(1)
    expect(await store.search('node.js', 10, 'no-such-kind')).toHaveLength(0)
    // `or` is a word here, not an operator: nothing has "catch" AND "or".
    expect(await store.search('typeerror or')).toHaveLength(1) // the OR fallback finds typeerror
  })

  test('all words first, any word when nothing has them all; title outranks body; a re-crawl replaces', async () => {
    const store = await open()
    await store.add([
      entry('https://ovens.example/pizza', 'Wood-fired pizza ovens', 'how to build a brick oven', { keywords: ['pizza', 'oven'] }),
      entry('https://blog.example/x', 'A post about bread', 'we once ate pizza near an oven'),
      entry('https://other.example/', 'Gardening', 'tomatoes'),
    ])
    expect((await store.search('pizza oven')).map((h) => h.url)).toEqual(['https://ovens.example/pizza', 'https://blog.example/x'])
    expect((await store.search('pizza tomatoes')).map((h) => h.url).sort()).toEqual(['https://blog.example/x', 'https://other.example/', 'https://ovens.example/pizza'])
    const [top] = await store.search('pizza')
    expect(top!.summary).toBe('how to build a brick oven')
    expect(top!.score).toBeLessThan(0)
    // The site's own name parts are searchable, as they were in FTS5.
    expect((await store.search('ovens example')).map((h) => h.url)).toContain('https://ovens.example/pizza')
    await store.add([JSON.stringify(entry('https://other.example/', 'Gardening again', 'cucumbers', { description: 'All about cucumbers.' }))])
    expect(await store.count()).toBe(3)
    expect(await store.search('tomatoes')).toEqual([])
    const [cuke] = await store.search('cucumbers')
    expect(cuke).toMatchObject({ title: 'Gardening again', summary: 'All about cucumbers.', site: 'other.example', kind: 'page', fetched_at: '2026-11-02T00:00:00.000Z' })
  })

  test('a search for one kind keeps that kind, most words in the title first; cards come with products', async () => {
    const store = await open()
    const product = (url: string, title: string, body: string) => {
      const e = entry(url, title, body, { kind: 'product' })
      return { ...e, record: { ...e.record, image: { url: `${url}.jpg` } }, enrichment: { ...e.enrichment, price: '$5' } }
    }
    await store.add(
      [
        product('https://a.example/1', 'Trail running shoes', 'light and quick'),
        product('https://b.example/2', 'Socks', 'for running in shoes'),
        entry('https://c.example/3', 'Why running shoes wear out', 'an essay'),
      ].map((e) => JSON.stringify(e)),
    )
    expect((await store.search('running shoes', 10, 'product')).map((h) => h.url)).toEqual(['https://a.example/1', 'https://b.example/2'])
    expect((await store.search('running shoes', 1, 'product')).map((h) => h.url)).toEqual(['https://a.example/1'])
    expect((await store.search('running shoes')).map((h) => h.url)).toContain('https://c.example/3')
    expect((await store.cards(['https://a.example/1'])).get('https://a.example/1')).toEqual({ image: 'https://a.example/1.jpg', price: '$5' })
    expect((await store.cards(['https://never.example/'])).size).toBe(0)
    await store.setCard('https://bare.example/', null, null)
    expect((await store.cards(['https://bare.example/', 'https://a.example/1'])).get('https://bare.example/')).toEqual({ image: null, price: null })
  })

  test('text Postgres cannot hold, and addresses it cannot key, never fail a batch', async () => {
    const store = await open()
    const kept = await store.add([
      entry('https://nul.example/', 'Has a \u0000 NUL', 'body with \u0000 in it, and "quotes" and \\backslashes\\ and {braces,} and NULL'),
      entry(`https://long.example/${'x'.repeat(3_000)}`, 'Too long to key', 'words'),
      entry('https://ok.example/', 'Fine', 'words'),
      'not json',
      JSON.stringify({ record: { canonical: 'not a url' } }),
    ])
    expect(kept).toBe(2)
    expect(await store.count()).toBe(2)
    expect((await store.search('braces'))[0]!.url).toBe('https://nul.example/')
    expect((await store.search('null'))[0]!.url).toBe('https://nul.example/')
  })

  test('the training corpus: comma lists, filters, opt-outs, the backfill and its stats', async () => {
    const store = await open()
    expect(corpusWebsearch('open source, self-hosted')).toBe('"open" "source" or "self" "hosted"')
    expect(corpusWebsearch(' , ,')).toBeNull()
    await store.add([
      entry('https://a.example/1', 'one', 'saas pricing', { language: 'en-us' }),
      entry('https://a.example/2', 'two', 'crypto wallets', { language: 'de', kind: 'article' }),
      entry('https://b.example/3', 'three', 'gardening', { fetched_at: '2026-10-01T00:00:00.000Z' }),
      entry('https://a.example/noai', 'four', 'saas reserved', { training: { allowed: false, reason: 'meta robots: noai' } }),
      entry('https://old.example/x', 'five', 'saas legacy', { training: null }),
    ])
    for (const q of ['catch-all', 'TypeError: x', 'foo(bar', 'NEAR(a b)', '"', '***', '-x', 'a OR', 'title:x', '^x', ',,,']) expect((await store.corpus({ q })).items).toBeDefined()
    expect((await store.corpus({ q: 'saas,crypto' })).items.map((i) => i.url)).toEqual(['https://a.example/1', 'https://a.example/2'])
    expect((await store.corpus({ q: 'saas pricing,nothing here' })).items.map((i) => i.url)).toEqual(['https://a.example/1'])
    expect((await store.corpus({ q: 'saas' })).total_matches).toBe(3)
    expect((await store.corpus({})).items).toHaveLength(3)
    expect((await store.corpus({ site: 'www.a.example' })).items.map((i) => i.url)).toEqual(['https://a.example/1', 'https://a.example/2'])
    expect((await store.corpus({ lang: 'en' })).items.map((i) => i.url)).toEqual(['https://a.example/1', 'https://b.example/3'])
    expect((await store.corpus({ kind: 'article' })).items.map((i) => i.url)).toEqual(['https://a.example/2'])
    expect((await store.corpus({ since: '2026-11-01T00:00:00.000Z' })).items).toHaveLength(2)
    const first = await store.corpus({ limit: 2 })
    expect(first.items).toHaveLength(2)
    expect((await store.corpus({ limit: 2, cursor: Number(first.next_cursor) })).items.map((i) => i.url)).toEqual(['https://b.example/3'])
    expect((await store.corpus({ textMax: 2 })).items[0]!.text).toBe('sa')
    expect(typeof (await store.corpus({})).items[0]!.id).toBe('number')

    expect(await store.corpusStats(0)).toMatchObject({ pages_indexed: 5, pages: 3, excluded: 1, unknown: 1, sites: 2, excluded_by: [{ reason: 'meta robots: noai', pages: 1 }] })
    expect(await store.unknownSites()).toEqual(['old.example'])
    const [legacy] = await store.unknownPagesOf('old.example')
    await store.setPolicies('old.example', [{ id: legacy!.id, allowed: true, reason: 'site allows (backfill)' }])
    expect(await store.unknownSites()).toEqual([])
    expect((await store.corpus({ q: 'saas' })).items).toHaveLength(2)
    // A record without a verdict (an old outbox line) keeps the one already made.
    await store.add([entry('https://a.example/noai', 'four', 'saas reserved', { training: null })])
    expect((await store.corpus({ q: 'saas' })).items).toHaveLength(2)
    // Pages without a policy row get one, once.
    await (store as unknown as { sql: SQL }).sql.unsafe('delete from page_policy')
    expect(await store.mapLegacy(2)).toBe(2)
    expect(await store.mapLegacy(10)).toBe(3)
    expect(await store.mapLegacy(10)).toBe(0)
    expect(await store.corpusStats(Date.now() + 10 * 60_000)).toBeDefined()
  })

  test('cursor paging is stable and complete while pages are added, and never runs past a page still being written', async () => {
    const store = await open()
    await store.add(Array.from({ length: 25 }, (_, i) => entry(`https://s${i % 3}.example/${i}`, `p${i}`, `widget number ${i}`)))
    const seen: string[] = []
    let cursor: string | null = '0'
    let pages = 0
    while (cursor !== null) {
      const page = await store.corpus({ q: 'widget', limit: 10, cursor: Number(cursor) })
      seen.push(...page.items.map((i) => i.url))
      cursor = page.next_cursor
      if (pages++ === 0) await store.add([entry('https://late.example/x', 'late', 'widget late')])
    }
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(26)
    expect(seen.at(-1)).toBe('https://late.example/x')
    await store.add([entry('https://s0.example/0', 'p0', 'widget again')])
    const after = await store.corpus({ q: 'widget', cursor: Number((await store.corpus({ q: 'widget', limit: 100 })).resume_cursor) })
    expect(after.items).toEqual([])
    expect(after.next_cursor).toBeNull()

    // With the production lag, a page written a moment ago is not handed out yet: the cursor stops below it.
    const lagged = await open(0, { corpusLagMs: 60_000 })
    await lagged.add([entry('https://new.example/', 'new', 'widget brand new')])
    const page = await lagged.corpus({ q: 'widget' })
    expect(page.items).toEqual([])
    expect(page.resume_cursor).toBe('0')
  })

  test('many writers at once: every page counted once, the counter equals count(*)', async () => {
    const url = await fresh()
    const writers = await Promise.all(Array.from({ length: 4 }, () => open(0, {}, url)))
    // Overlapping batches from four stores (four pools), several rounds each, in parallel.
    const urls = Array.from({ length: 300 }, (_, i) => `https://w${i % 37}.example/${i}`)
    await Promise.all(
      writers.flatMap((w, n) =>
        Array.from({ length: 5 }, (_, round) => {
          const slice = urls.filter((_, i) => (i + n + round) % 3 !== 0)
          return w.add(slice.map((u) => entry(u, `title ${u}`, `round ${round} writer ${n}`)))
        }),
      ),
    )
    expect(await writers[0]!.count(0)).toBe(300)
    expect(await writers[1]!.resync()).toBe(300)
    const policy = (await (writers[0] as unknown as { sql: SQL }).sql`select count(*)::int as n from page_policy`) as { n: number }[]
    expect(policy[0]!.n).toBe(300)
    expect(await writers[2]!.highWaterMark()).toBeGreaterThanOrEqual(300)
  }, 60_000)

  test('the byte budget: oldest pages go first, in batches, never below keepMin, the counter follows', async () => {
    const url = await fresh()
    const fill = await open(0, {}, url)
    const fat = 'lorem ipsum dolor sit amet '.repeat(200)
    for (let batch = 0; batch < 5; batch++)
      await fill.add(
        Array.from({ length: 200 }, (_, i) => {
          const n = batch * 200 + i
          // Read times run backwards from the ids, as a newest-first import would make them.
          const fetched = new Date(Date.UTC(2026, 10, 5) - n * 60_000).toISOString()
          return entry(`https://a.example/${n}`, `Page ${n}`, `${fat}${n === 0 ? ' zebraomega' : ''}${n === 999 ? ' aardvarkzero' : ''}`, { fetched_at: fetched })
        }),
      )
    expect(await fill.count()).toBe(1_000)
    const grown = await fill.sizeBytes(0)
    expect(grown).toBeGreaterThan(0)
    // Inside the budget: nothing goes.
    expect(await (await open(grown * 2, {}, url)).trim()).toMatchObject({ deleted: 0, done: true })
    expect(await (await open(0, {}, url)).trim()).toMatchObject({ deleted: 0, done: true })

    const store = await open(Math.floor(grown / 2), {}, url)
    const result = await store.trim({ batch: 100, keepMin: 100 })
    expect(result.deleted).toBeGreaterThanOrEqual(490)
    expect(result.deleted).toBeLessThanOrEqual(510)
    expect(result.done).toBe(true)
    expect(result.liveBytes!).toBeLessThanOrEqual(store.maxBytes)
    expect(await store.count(0)).toBe(1_000 - result.deleted)
    expect(await store.resync()).toBe(1_000 - result.deleted)
    // The page read longest ago (the highest id here) went; the newest stayed.
    expect(await store.search('zebraomega')).toHaveLength(1)
    expect(await store.search('aardvarkzero')).toHaveLength(0)
    // A second sweep with nothing new does not keep deleting: the files did not shrink, but the live pages fit.
    expect((await store.trim({ batch: 100, keepMin: 100 })).deleted).toBe(0)

    // A budget too small to meet leaves a working index rather than an empty one.
    const tiny = await open(4096, {}, url)
    const floor = await tiny.trim({ batch: 50, keepMin: 100 })
    expect(floor.done).toBe(false)
    expect(await tiny.count(0)).toBe(100)
    expect(await tiny.search('zebraomega')).toHaveLength(1)
  }, 60_000)

  test('/stats figures are cached and refreshed behind the cache', async () => {
    const store = await open(1024 ** 3)
    await store.add([entry('https://a.example/', 'First', 'words')])
    const size = await store.sizeBytes()
    expect(await store.count()).toBe(1)
    await store.add(Array.from({ length: 50 }, (_, i) => entry(`https://b.example/${i}`, `Page ${i}`, 'lorem ipsum '.repeat(300))))
    // The cached size answers at once; a fresh read sees the growth.
    expect(await store.sizeBytes()).toBe(size)
    expect(await store.sizeBytes(0)).toBeGreaterThanOrEqual(size)
    expect(await store.count()).toBe(51)
  })

  test('migrate-index: a SQLite index streams in with ids, read times, verdicts and cards, resumably', async () => {
    const path = `${tmpdir()}/pit-migrate-${Date.now()}.db`
    const sqlite = new IndexStore(path)
    sqlite.add(
      Array.from({ length: 30 }, (_, i) =>
        entry(`https://m${i % 4}.example/${i}`, `Migrated ${i}`, `moved words ${i}`, {
          fetched_at: new Date(Date.UTC(2026, 9, 1) + i * 3_600_000).toISOString(),
          training: i % 5 === 0 ? { allowed: false, reason: 'robots' } : i % 7 === 0 ? null : OPEN,
        }),
      ),
    )
    sqlite.add([{ ...entry('https://shop.example/p', 'A product', 'buy it', { kind: 'product' }), enrichment: { excerpt: 'buy it', price: '$9', training: OPEN } }])
    sqlite.setPolicies('m0.example', [])
    // Gaps in the ids, as trim leaves them.
    ;(sqlite as unknown as { db: { run(q: string): void } }).db.run('DELETE FROM pages WHERE id IN (3, 4, 10)')
    const ids = (sqlite as unknown as { db: { query(q: string): { all(): Array<{ id: number; url: string; fetched_at: string }> } } }).db
      .query('SELECT id, url, fetched_at FROM pages ORDER BY id')
      .all()
    sqlite.close()

    const url = await fresh()
    const pg = await open(0, {}, url)
    // The crawl already wrote one of these pages to Postgres, more freshly: it wins.
    await pg.add([entry('https://m1.example/1', 'Fresh from the crawl', 'newer words')])
    const result = await migrateIndexFromSqlite(path, pg, { batch: 7 })
    expect(result.read).toBe(ids.length)
    expect(result.inserted).toBe(ids.length - 1)
    expect(result.pages).toBe(ids.length)
    expect(await pg.count(0)).toBe(ids.length)
    const rows = (await (pg as unknown as { sql: SQL }).sql`select id::int as id, url, fetched_at from pages order by id`) as Array<{ id: number; url: string; fetched_at: string }>
    const byUrl = new Map(rows.map((r) => [r.url, r]))
    // Ids and read times kept, except where the crawl's earlier page had taken the id (id 1):
    // that page still comes over, under a fresh id above the migrated range.
    const maxMigrated = Math.max(...ids.map((r) => r.id))
    for (const r of ids) {
      if (r.url === 'https://m1.example/1') continue
      if (r.id === 1) expect(byUrl.get(r.url)!.fetched_at).toBe(r.fetched_at)
      else expect(byUrl.get(r.url)).toEqual(r)
    }
    expect(byUrl.get(ids.find((r) => r.id === 1)!.url)!.id).toBeGreaterThan(maxMigrated)
    expect((await pg.search('newer'))[0]!.url).toBe('https://m1.example/1')
    expect(await pg.search('moved words 29')).not.toHaveLength(0)
    // Verdicts came over: reserved pages stay out of the corpus, unknown ones too.
    const open1 = (await pg.corpus({ q: 'moved', limit: 100 })).items.map((i) => i.url)
    expect(open1).not.toContain('https://m0.example/0')
    expect(open1).not.toContain('https://m3.example/7')
    expect(open1).toContain('https://m2.example/6')
    expect((await pg.cards(['https://shop.example/p'])).get('https://shop.example/p')).toEqual({ image: null, price: '$9' })
    // Run again: the cursor says it is done, nothing is read twice.
    const again = await migrateIndexFromSqlite(path, pg, { batch: 7 })
    expect(again.read).toBe(0)
    expect(await pg.count(0)).toBe(ids.length)
    // A page written after the move takes an id above every migrated one.
    await pg.add([entry('https://after.example/', 'After', 'later')])
    const top = (await (pg as unknown as { sql: SQL }).sql`select id::int as id from pages where url = 'https://after.example/'`) as { id: number }[]
    expect(top[0]!.id).toBeGreaterThan(Math.max(...ids.map((r) => r.id)))
    // --restart reads it all again; pages already there stay as they are.
    const restarted = await migrateIndexFromSqlite(path, pg, { batch: 50, restart: true })
    expect(restarted).toMatchObject({ read: ids.length, inserted: 0 })
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
  }, 60_000)
})
