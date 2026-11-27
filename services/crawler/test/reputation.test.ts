import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { feedsLoader, listedAddress, listedDomain, parseFeeds } from '../src/reputation.ts'

const ind = { malware: 'unknown', threat: 'botnet_cc', feed: 'threatfox' }
const SAMPLE = JSON.stringify({
  fetched_at: '2026-11-27T14:34:53.262Z',
  ips: { '162.243.103.246': ind, '2001:db8::bad': ind },
  domains: { 'aafikotorambur.org': ind, 'x.hri88.org': ind },
  sources: [],
  skipped_shared: 0,
})

describe('ThreatCrush reputation gate', () => {
  test('a listed name, any name under it, and nothing else', () => {
    const feeds = parseFeeds(SAMPLE)
    expect(listedDomain('aafikotorambur.org', feeds)).toBe('aafikotorambur.org')
    expect(listedDomain('AraVZZfo.aafikotorambur.org.', feeds)).toBe('aafikotorambur.org')
    expect(listedDomain('x.hri88.org', feeds)).toBe('x.hri88.org')
    expect(listedDomain('deep.x.hri88.org', feeds)).toBe('x.hri88.org')
    // A listed subdomain never takes its parent or its siblings with it.
    expect(listedDomain('hri88.org', feeds)).toBeNull()
    expect(listedDomain('y.hri88.org', feeds)).toBeNull()
    // A bare TLD is never matched, even if a feed listed one.
    expect(listedDomain('example.org', parseFeeds(JSON.stringify({ ips: {}, domains: { org: ind } })))).toBeNull()
    expect(listedDomain('example.com', null)).toBeNull()
  })

  test('a listed address, as IPv4, mapped IPv6 or IPv6', () => {
    const feeds = parseFeeds(SAMPLE)
    expect(listedAddress('162.243.103.246', feeds)).toBe(true)
    expect(listedAddress('::ffff:162.243.103.246', feeds)).toBe(true)
    expect(listedAddress('2001:DB8::BAD', feeds)).toBe(true)
    expect(listedAddress('162.243.103.247', feeds)).toBe(false)
    expect(listedAddress('162.243.103.246', null)).toBe(false)
  })

  test('not a feed set is no feed set', () => {
    expect(parseFeeds('not json')).toBeNull()
    expect(parseFeeds('{"ips":[]}')).toBeNull()
    expect(parseFeeds('null')).toBeNull()
  })

  test('the file is re-read when it changes, and a bad rewrite keeps the last good copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pit-feeds-'))
    try {
      const path = join(dir, 'threat-feeds.json')
      let clock = 0
      const lines: string[] = []
      const load = feedsLoader(path, { checkMs: 1_000, now: () => clock, log: (l) => lines.push(l) })
      // No file yet: nothing listed, said once.
      expect(load()).toBeNull()
      clock += 1_000
      expect(load()).toBeNull()
      expect(lines.length).toBe(1)

      writeFileSync(path, SAMPLE)
      utimesSync(path, 1_000, 1_000)
      clock += 1_000
      expect(listedDomain('aafikotorambur.org', load())).toBe('aafikotorambur.org')

      writeFileSync(path, JSON.stringify({ ips: {}, domains: { 'new.example': ind } }))
      utimesSync(path, 2_000, 2_000)
      // Inside checkMs the old copy is kept without touching the disk.
      expect(listedDomain('aafikotorambur.org', load())).toBe('aafikotorambur.org')
      clock += 1_000
      expect(listedDomain('new.example', load())).toBe('new.example')
      expect(listedDomain('aafikotorambur.org', load())).toBeNull()

      writeFileSync(path, '{ half written')
      utimesSync(path, 3_000, 3_000)
      clock += 1_000
      expect(listedDomain('new.example', load())).toBe('new.example')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an empty path turns the gate off', () => {
    expect(feedsLoader('')()).toBeNull()
  })
})
