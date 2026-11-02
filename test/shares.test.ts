import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Listings } from '../src/listings.ts'
import { Registry } from '../src/moshpit.ts'
import { createApp } from '../src/server.ts'
import { nichedbRecord, Shares } from '../src/shares.ts'
import { SHARED_WEIGHT, Votes } from '../src/votes.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const HITS = Array.from({ length: 6 }, (_, i) => ({ title: `Result ${i}`, link: `https://site${i}.example/page`, snippet: `About ${i}` }))
const fake = (async (input: any) => {
  if (String(input).startsWith('https://google.serper.dev')) return new Response(JSON.stringify({ organic: HITS }), { headers: { 'content-type': 'application/json' } })
  return new Response('{}', { status: 404 })
}) as typeof fetch

function setup() {
  const listings = new Listings(':memory:', { verify: async () => ({ ok: false }) } as any)
  const app = createApp({ keys: { serper: 'K' }, registry: new Registry('https://registry.test', fake), fetch: fake, listings, fingerprintSecret: 'test-fingerprint-secret-0123456789', network: { has: () => false } })
  const req = (path: string) => app.request(path, { headers: { 'user-agent': UA } }, { ip: '203.0.113.7' })
  return { req, listings }
}

const unescape = (s: string) => s.replaceAll('&amp;', '&')

describe('shares: the signed link', () => {
  const hit = { url: 'https://site1.example/page', title: 'Result 1', description: 'About 1', host: 'site1.example' }

  it('keeps a result only from a link pit.world signed, and refuses a changed one', () => {
    const shares = new Shares(new Database(':memory:'), 'secret-secret-secret')
    const href = shares.href(hit)
    expect(href.startsWith('/share?')).toBe(true)
    const p = new URLSearchParams(href.slice('/share?'.length))
    const params = { u: p.get('u'), t: p.get('t'), d: p.get('d'), s: p.get('s') }
    expect(shares.get('site1.example/page')).toBeNull()
    expect(shares.save({ ...params, t: 'A title nobody gave' })).toBeNull()
    expect(shares.save({ ...params, i: '1' })).toBeNull()
    expect(shares.save({ ...params, s: 'x'.repeat(22) })).toBeNull()
    expect(shares.save(params)).toBe('site1.example/page')
    expect(shares.get('site1.example/page')).toEqual({ slug: 'site1.example/page', url: hit.url, title: 'Result 1', description: 'About 1', host: 'site1.example', indexed: false })
  })

  it('marks a result from our own index, so its page links the nichedb.dev record', () => {
    const shares = new Shares(new Database(':memory:'), 'secret-secret-secret')
    const p = new URLSearchParams(shares.href({ ...hit, sources: ['serper', 'pit'] }).split('?')[1])
    expect(p.get('i')).toBe('1')
    expect(shares.save({ u: p.get('u'), t: p.get('t'), d: p.get('d'), i: p.get('i'), s: p.get('s') })).toBe('site1.example/page')
    expect(shares.get('site1.example/page')?.indexed).toBe(true)
    expect(nichedbRecord(hit.url)).toBe('https://nichedb.dev/c/sites/site1.example/page')
  })
})

describe('shares: the pages', () => {
  it('puts Share under every result, and the link lands on a page with its vote box', async () => {
    const { req } = setup()
    const serp = await (await req('/search?q=things')).text()
    const links = [...serp.matchAll(/<a class="share" href="([^"]+)"/g)].map((m) => unescape(m[1]!))
    expect(links).toHaveLength(HITS.length)
    expect(await (await req('/result/site2.example/page')).status).toBe(404)
    const hop = await req(links[2]!)
    expect(hop.status).toBe(303)
    expect(hop.headers.get('location')).toBe('/result/site2.example/page')
    const res = await req('/result/site2.example/page')
    expect(res.status).toBe(200)
    const page = await res.text()
    expect(page).toContain('href="https://site2.example/page"')
    expect(page).toContain('About 2')
    expect(page).toContain('<form class="vote" method="post" action="/vote" data-item="result:site2.example/page">')
    expect(page).toContain('name="back" value="/result/site2.example/page"')
    expect(page).toContain('value="https://pit.world/result/site2.example/page"')
    expect(page).toContain('<meta name="robots" content="noindex">')
    expect(page).not.toContain('nichedb.dev/c/sites')
    // A tampered link is refused, and keeps nothing.
    expect((await req(links[3]!.replace('t=Result+3', 't=Fake'))).status).toBe(400)
    expect((await req('/result/site3.example/page')).status).toBe(404)
  })
})

describe('shares: votes on a shared page move the result on every search', () => {
  it('counts shared-page votes (no search) with SHARED_WEIGHT', () => {
    const v = new Votes(new Database(':memory:'), 'secret-secret-secret')
    for (let i = 0; i < 200; i++) v.cast({ visitor: `v${i}`, kind: 'result', item: 'result:s5.example', domain: 's5.example', value: 1 })
    const shared = v.sharedTallies(['result:s5.example']).get('result:s5.example')!
    expect(shared.up).toBe(200)
    // Any search: the shared score plus the domain score, nothing from a search's own votes.
    const move = v.nudges(['https://s5.example/'], 'some search').get('https://s5.example/')!
    expect(move).toBeGreaterThanOrEqual(Math.floor(SHARED_WEIGHT * shared.score))
    const hits = Array.from({ length: 8 }, (_, i) => ({ url: `https://s${i}.example/` }))
    expect(v.rerank(hits, 'another search').findIndex((h) => h.url === 'https://s5.example/')).toBeLessThan(5)
  })
})
