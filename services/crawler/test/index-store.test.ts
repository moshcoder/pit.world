import { describe, expect, test } from 'bun:test'
import { configFromEnv } from '../src/config.ts'
import { createCrawler } from '../src/crawler.ts'
import { MemoryFrontier } from '../src/frontier.ts'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { IndexStore, toFtsTerms } from '../src/index-store.ts'

const entry = (url: string, title: string, body: string, keywords: string[] = []) => ({
  record: { url, canonical: url, title, description: null, kind: 'page', language: 'en', fetched_at: '2026-11-02T00:00:00.000Z' },
  enrichment: { keywords, excerpt: body },
})

describe('the local search mirror', () => {
  test('whatever someone types is a valid query', () => {
    const store = new IndexStore(':memory:')
    store.add([entry('https://a.example/', 'Node.js catch-all errors', 'TypeError: x is not a function in C# and node.js 1.3.14')])
    for (const q of ['catch-all', 'TypeError: x', 'foo(bar', 'node.js', '1.3.14', 'C#', 'why "this fails', '***', '-'])
      expect(() => store.search(q)).not.toThrow()
    expect(store.search('node.js')).toHaveLength(1)
    expect(toFtsTerms('a "b" c-d')).toEqual(['"a"', '"b"', '"c"', '"d"'])
  })

  test('all words first, any word when nothing has them all; title outranks body', () => {
    const store = new IndexStore(':memory:')
    store.add([
      entry('https://ovens.example/pizza', 'Wood-fired pizza ovens', 'how to build a brick oven', ['pizza', 'oven']),
      entry('https://blog.example/x', 'A post about bread', 'we once ate pizza near an oven'),
      entry('https://other.example/', 'Gardening', 'tomatoes'),
    ])
    expect(store.search('pizza oven').map((h) => h.url)).toEqual(['https://ovens.example/pizza', 'https://blog.example/x'])
    expect(store.search('pizza tomatoes').map((h) => h.url).sort()).toEqual(['https://blog.example/x', 'https://other.example/', 'https://ovens.example/pizza'])
    expect(store.search('pizza')[0]!.summary).toBe('how to build a brick oven')
  })

  test('a re-crawl replaces the page, it does not add a second one', () => {
    const store = new IndexStore(':memory:')
    store.add([JSON.stringify(entry('https://a.example/', 'Old title', 'old words'))])
    store.add([JSON.stringify(entry('https://a.example/', 'New title', 'fresh words'))])
    expect(store.count()).toBe(1)
    expect(store.search('old')).toEqual([])
    expect(store.search('fresh')[0]!.title).toBe('New title')
  })

  test('publishing fills the mirror, even with nichedb off', async () => {
    const store = new IndexStore(':memory:')
    const frontier = new MemoryFrontier(10)
    const noop = async () => {}
    const crawler = createCrawler({ config: configFromEnv({}), frontier, index: store, resolver: async () => true, enqueue: { sites: noop, pages: noop, render: noop } })
    await frontier.push([entry('https://a.example/', 'Hello mirror', 'words')], 100)
    expect(await crawler.publish()).toEqual({ sent: 0, added: 0, rejected: 0, waiting: false })
    expect(store.search('mirror')).toHaveLength(1)
    expect(frontier.counters.indexed_local).toBe(1)
  })
})

describe('content and the byte budget', () => {
  const page = (title: string, text: string, images: Array<{ url: string; alt: string }>, videos: Array<{ url: string; title: string }>) => ({
    record: { url: 'https://ovens.example/v', canonical: 'https://ovens.example/v', title, description: 'Short.', kind: 'page', language: 'en', fetched_at: '2026-11-02T00:00:00.000Z' },
    enrichment: { excerpt: text.slice(0, 50), text, images: images.map((i) => ({ ...i, width: null, height: null })), videos: videos.map((v) => ({ ...v, thumbnail: null, provider: null })) },
  })
  test('search reaches the whole text, not just the excerpt', () => {
    const store = new IndexStore(':memory:')
    store.add([page('Ovens', 'intro '.repeat(100) + 'zebracorn', [], [])])
    expect(store.search('zebracorn')).toHaveLength(1)
  })

  test('media on a record is published, never kept here: no table, no rows, no cost', () => {
    const store = new IndexStore(':memory:')
    store.add([page('Wood-fired ovens', 'x', [{ url: 'https://ovens.example/dome.jpg', alt: 'Brick dome at night' }], [{ url: 'https://youtu.be/x', title: 'Firing it up' }])])
    expect(store.count()).toBe(1)
    expect(store.tables()).not.toContain('media')
    expect(store.tables()).not.toContain('media_fts')
  })

  test('an index over its budget drops its oldest pages and gives the space back', async () => {
    const path = `${tmpdir()}/pit-index-trim-${Date.now()}.db`
    const fat = 'lorem ipsum dolor sit amet '.repeat(200)
    const fill = new IndexStore(path)
    // A word only the first page has and one only the last has, so the test can tell
    // which end was dropped without relying on how a title tokenizes.
    for (let batch = 0; batch < 5; batch++)
      fill.add(
        Array.from({ length: 200 }, (_, i) => {
          const first = batch === 0 && i === 0
          const last = batch === 4 && i === 199
          return entry(`https://a.example/${batch}-${i}`, `Page ${batch}-${i}`, `${fat}${first ? ' aardvarkzero' : ''}${last ? ' zebraomega' : ''}`)
        }),
      )
    expect(fill.count()).toBe(1_000)
    const grown = fill.sizeBytes()
    fill.close()

    // Half of what it grew to: it has to let go of roughly half its pages.
    const store = new IndexStore(path, Math.floor(grown / 2))
    expect(store.reclaims).toBe(true)
    const result = await store.trim({ batch: 100, keepMin: 100 })
    expect(result.deleted).toBeGreaterThan(0)
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore)
    expect(store.sizeBytes()).toBeLessThanOrEqual(store.maxBytes)
    expect(store.count()).toBe(1_000 - result.deleted)
    // The newest pages are the ones it kept, and they are still searchable; the
    // oldest is gone from the index as well as from the table.
    expect(store.search('zebraomega')).toHaveLength(1)
    expect(store.search('aardvarkzero')).toHaveLength(0)
    // A page that survived keeps its id, so a corpus cursor still means what it meant.
    expect(store.highWaterMark()).toBe(1_000)
    store.close()
    rmSync(path, { force: true })
    for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
  })

  test('an index inside its budget is left alone, and no budget means no trimming', async () => {
    const store = new IndexStore(':memory:', 1024 ** 3)
    store.add([entry('https://a.example/', 'Small', 'words')])
    expect(await store.trim()).toMatchObject({ deleted: 0, done: true })
    const unbounded = new IndexStore(':memory:')
    unbounded.add([entry('https://a.example/', 'Small', 'words')])
    expect(await unbounded.trim()).toMatchObject({ deleted: 0, done: true })
    expect(unbounded.maxBytes).toBe(0)
  })

  test('a budget too small to meet leaves a working index rather than an empty one', async () => {
    const path = `${tmpdir()}/pit-index-floor-${Date.now()}.db`
    const fill = new IndexStore(path)
    fill.add(Array.from({ length: 300 }, (_, i) => entry(`https://a.example/${i}`, `Page ${i}`, `${'lorem ipsum '.repeat(200)}${i === 299 ? ' newest' : ''}`)))
    fill.close()
    const store = new IndexStore(path, 4096)
    const result = await store.trim({ batch: 50, keepMin: 100 })
    expect(result.done).toBe(false)
    expect(store.count()).toBe(100)
    expect(store.search('newest')).toHaveLength(1)
    store.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
  })
})
