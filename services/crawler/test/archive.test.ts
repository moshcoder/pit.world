import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { hourName, PageArchive, processTag } from '../src/archive.ts'
import { configFromEnv } from '../src/config.ts'
import { createCrawler } from '../src/crawler.ts'
import { MemoryFrontier } from '../src/frontier.ts'

describe('the page archive', () => {
  test('one gzip file per UTC hour and process, batches appended as members, earlier hours sealed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pitarchive-'))
    try {
      let now = new Date('2026-11-08T15:59:58Z')
      const archive = new PageArchive(dir, () => now, 'hostA-11')
      archive.write(['{"a":1}', '{"a":2}'])
      archive.write(['{"a":3}'])
      expect(readdirSync(dir)).toEqual(['pages-20261108T15-hostA-11.jsonl.gz.partial'])
      now = new Date('2026-11-08T16:00:01Z')
      archive.write(['{"b":1}'])
      expect(readdirSync(dir).sort()).toEqual(['pages-20261108T15-hostA-11.jsonl.gz', 'pages-20261108T16-hostA-11.jsonl.gz.partial'])
      // Concatenated gzip members read back as one stream, in order.
      expect(gunzipSync(readFileSync(join(dir, 'pages-20261108T15-hostA-11.jsonl.gz'))).toString()).toBe('{"a":1}\n{"a":2}\n{"a":3}\n')
      expect(hourName(new Date('2026-01-02T03:04:05Z'))).toBe('pages-20260102T03.jsonl.gz')
      expect(hourName(new Date('2026-01-02T03:04:05Z'), 'h-1')).toBe('pages-20260102T03-h-1.jsonl.gz')
      // Whatever the tag, the shipper's glob (deploy/crawler-remote/ship-archive.sh) matches a sealed hour, never an open one.
      expect(new Bun.Glob('pages-*.jsonl.gz').match('pages-20261108T15-hostA-11.jsonl.gz')).toBe(true)
      expect(new Bun.Glob('pages-*.jsonl.gz').match('pages-20261108T16-hostA-11.jsonl.gz.partial')).toBe(false)
      expect(processTag('my host/x', 42)).toBe('my_host_x-42')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("several publishing processes write their own files and never seal one another's current hour", () => {
    const dir = mkdtempSync(join(tmpdir(), 'pitarchive-'))
    try {
      let now = new Date('2026-11-08T15:30:00Z')
      const a = new PageArchive(dir, () => now, 'box-1')
      const b = new PageArchive(dir, () => now, 'box-2')
      a.write(['{"a":1}'])
      b.write(['{"b":1}'])
      a.write(['{"a":2}'])
      expect(readdirSync(dir).sort()).toEqual(['pages-20261108T15-box-1.jsonl.gz.partial', 'pages-20261108T15-box-2.jsonl.gz.partial'])
      expect(gunzipSync(readFileSync(join(dir, 'pages-20261108T15-box-1.jsonl.gz.partial'))).toString()).toBe('{"a":1}\n{"a":2}\n')
      // The hour turns: a seals its own hour 15 at once, but not b's, which may still be finishing a batch there.
      now = new Date('2026-11-08T16:00:01Z')
      a.write(['{"a":3}'])
      expect(readdirSync(dir).sort()).toEqual(['pages-20261108T15-box-1.jsonl.gz', 'pages-20261108T15-box-2.jsonl.gz.partial', 'pages-20261108T16-box-1.jsonl.gz.partial'])
      // b writes again and seals its own.
      b.write(['{"b":2}'])
      expect(
        readdirSync(dir)
          .filter((f) => f.endsWith('.partial'))
          .sort(),
      ).toEqual(['pages-20261108T16-box-1.jsonl.gz.partial', 'pages-20261108T16-box-2.jsonl.gz.partial'])
      // A process that died (b) leaves a partial; another seals it once that hour is two behind.
      now = new Date('2026-11-08T17:10:00Z')
      a.write([])
      expect(readdirSync(dir)).toContain('pages-20261108T16-box-2.jsonl.gz.partial')
      now = new Date('2026-11-08T18:00:00Z')
      a.write([])
      expect(readdirSync(dir).filter((f) => f.endsWith('.partial'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a leftover partial from before per-process names is still sealed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pitarchive-'))
    try {
      writeFileSync(join(dir, 'pages-20261108T15.jsonl.gz.partial'), '')
      const archive = new PageArchive(dir, () => new Date('2026-11-08T18:00:00Z'), 'box-1')
      expect(archive.seal()).toEqual(['pages-20261108T15.jsonl.gz'])
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
