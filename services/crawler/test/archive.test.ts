import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { hourName, PageArchive } from '../src/archive.ts'
import { configFromEnv } from '../src/config.ts'
import { createCrawler } from '../src/crawler.ts'
import { MemoryFrontier } from '../src/frontier.ts'

describe('the page archive', () => {
  test('one gzip file per UTC hour, batches appended as members, earlier hours sealed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pitarchive-'))
    try {
      let now = new Date('2026-11-08T15:59:58Z')
      const archive = new PageArchive(dir, () => now)
      archive.write(['{"a":1}', '{"a":2}'])
      archive.write(['{"a":3}'])
      expect(readdirSync(dir)).toEqual(['pages-20261108T15.jsonl.gz.partial'])
      now = new Date('2026-11-08T16:00:01Z')
      archive.write(['{"b":1}'])
      expect(readdirSync(dir).sort()).toEqual(['pages-20261108T15.jsonl.gz', 'pages-20261108T16.jsonl.gz.partial'])
      // Concatenated gzip members read back as one stream, in order.
      expect(gunzipSync(readFileSync(join(dir, 'pages-20261108T15.jsonl.gz'))).toString()).toBe('{"a":1}\n{"a":2}\n{"a":3}\n')
      expect(hourName(new Date('2026-01-02T03:04:05Z'))).toBe('pages-20260102T03.jsonl.gz')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('publish archives every record, and a failed archive write returns the batch to the outbox', async () => {
    const frontier = new MemoryFrontier(1000)
    await frontier.push([{ record: { title: 'x' } }, { record: { title: 'y' } }], 100)
    const written: string[] = []
    let fail = true
    const archive = {
      write(lines: string[]) {
        if (fail) throw new Error('disk full')
        written.push(...lines)
      },
    }
    const noop = async () => {}
    const crawler = createCrawler({ config: configFromEnv({ CRAWL_PUBLISH_PAGES: '0' }), frontier, archive, enqueue: { sites: noop, pages: noop, render: noop } })
    await expect(crawler.publish()).rejects.toThrow('disk full')
    expect(frontier.outbox.length).toBe(2)
    fail = false
    await crawler.publish()
    expect(written.map((l) => JSON.parse(l).record.title)).toEqual(['x', 'y'])
    expect(frontier.outbox).toEqual([])
    expect(frontier.counters.archived).toBe(2)
  })
})
