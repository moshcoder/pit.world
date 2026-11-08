import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Directory, directoryHome, fileSite, listable, liveHosts, parseMeta, view } from '../src/directory.ts'
import { createApp } from '../src/server.ts'

const page = (title: string, description = '') => `<html><head><title>${title}</title><meta name="description" content="${description}"></head></html>`

function fakeFetch(pages: Record<string, string | number>) {
  const asked: string[] = []
  const f = (async (url: string | URL) => {
    const host = new URL(String(url)).hostname
    asked.push(host)
    const p = pages[host]
    if (p === undefined || typeof p === 'number') return new Response('down', { status: typeof p === 'number' ? p : 502 })
    return new Response(p, { headers: { 'content-type': 'text/html' } })
  }) as unknown as typeof fetch
  return { f, asked }
}

describe('directory hosts', () => {
  it('reads relay certs and the edge config, and drops plumbing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pitdir-'))
    const certs = join(dir, 'certs')
    mkdirSync(certs)
    for (const f of ['seo.rank.pit.world.crt', 'seo.rank.pit.world.key', 'bbs.seo.rank.pit.world.crt', 'social.seo.rank.pit.world.crt']) writeFileSync(join(certs, f), '')
    const caddy = join(dir, 'Caddyfile')
    writeFileSync(caddy, 'brisk.pwa.pit.world, brisk-supabase.pwa.pit.world {\n}\n*.pwa.pit.world wildcard.pwa.pit.world www.pit.world pit.world\n')
    expect(liveHosts({ certDir: certs, configs: [caddy], extra: [] })).toEqual(['brisk.pwa.pit.world', 'seo.rank.pit.world'])
  })

  it('knows a site from its plumbing', () => {
    expect(listable('seo.rank.pit.world')).toBe(true)
    expect(listable('pit.world')).toBe(false)
    expect(listable('*.pit.world')).toBe(false)
    expect(listable('social.seo.rank.pit.world')).toBe(false)
    expect(listable('icemap-supabase.pwa.pit.world')).toBe(false)
    expect(listable('example.com')).toBe(false)
  })
})

describe('filing', () => {
  it('uses the hand-filed category first', () => {
    expect(fileSite('seo.rank.pit.world', '')).toEqual(['computers/web-dev'])
  })

  it('files a brand-new name by what its homepage says', () => {
    expect(fileSite('true.crime.pit.world', 'True crime podcast, weekly episodes')).toEqual(['news/podcasts'])
    expect(fileSite('tacos.pit.world', 'Find the best restaurant tacos')[0]).toBe('recreation/food')
  })

  it('puts what it cannot file under New Arrivals', () => {
    expect(fileSite('zzz.qqq.pit.world', 'hello')).toEqual(['new/unfiled'])
  })

  it('parses a title and description', () => {
    expect(parseMeta(page('A &amp; B', 'It&#39;s good'))).toEqual({ title: 'A & B', description: "It's good" })
  })
})

describe('Directory', () => {
  it('lists a new domain automatically on the next refresh, marked NEW', async () => {
    let hosts = ['seo.rank.pit.world']
    let now = 1_000_000
    const { f } = fakeFetch({ 'seo.rank.pit.world': page('seo.rank'), 'true.crime.pit.world': page('True Crime', 'A true crime podcast') })
    const d = new Directory({ hosts: () => hosts, fetch: f, now: () => now })
    await d.refresh()
    expect(d.entries().map((e) => e.host)).toEqual(['seo.rank.pit.world'])
    expect(d.entries()[0]!.added).toBe(0)

    hosts = ['seo.rank.pit.world', 'true.crime.pit.world']
    now += 60_000
    await d.refresh()
    const fresh = d.entries().find((e) => e.host === 'true.crime.pit.world')!
    expect(fresh.added).toBe(now)
    expect(fresh.paths).toEqual(['news/podcasts'])
    expect(directoryHome(view(d, now))).toContain('NEW!')
  })

  it('hides a site that does not answer, and lists it again once it does', async () => {
    const pages: Record<string, string | number> = { 'a.b.pit.world': 502 }
    const { f } = fakeFetch(pages)
    let now = 0
    const d = new Directory({ hosts: () => ['a.b.pit.world'], fetch: f, now: () => now, metaTtl: 1000 })
    await d.refresh()
    expect(d.entries()).toEqual([])
    expect(d.down()).toEqual(['a.b.pit.world'])
    pages['a.b.pit.world'] = page('a.b', 'Back')
    now += 5000
    await d.refresh()
    expect(d.entries().map((e) => e.about)).toEqual(['Back'])
  })

  it('remembers first-seen dates across restarts', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pitdir-')), 'directory.json')
    const { f } = fakeFetch({ 'x.y.pit.world': page('x'), 'n.m.pit.world': page('n') })
    const one = new Directory({ hosts: () => ['x.y.pit.world'], fetch: f, file, now: () => 5 })
    await one.refresh()
    const two = new Directory({ hosts: () => ['x.y.pit.world', 'n.m.pit.world'], fetch: f, file, now: () => 9 })
    await two.refresh()
    expect(Object.fromEntries(two.entries().map((e) => [e.host, e.added]))).toEqual({ 'x.y.pit.world': 0, 'n.m.pit.world': 9 })
  })
})

describe('routes', () => {
  const d = new Directory({
    hosts: () => ['seo.rank.pit.world', 'brisk.pwa.pit.world'],
    fetch: fakeFetch({ 'seo.rank.pit.world': page('seo.rank'), 'brisk.pwa.pit.world': page('brisk.news — AI News Summaries', 'Audio news briefings') }).f,
  })
  const app = createApp({ directory: d } as never)

  it('serves the top page, a category, a subcategory, search and JSON', async () => {
    await d.refresh()
    const top = await (await app.request('/directory')).text()
    expect(top).toContain('Computers &amp; Internet')
    expect(top).toContain('News &amp; Media')
    const sub = await (await app.request('/directory/computers/web-dev')).text()
    expect(sub).toContain('seo.rank.pit.world')
    expect(sub).toContain('Top</a> &gt;')
    const cat = await (await app.request('/directory/news')).text()
    expect(cat).toContain('brisk.news')
    const found = await (await app.request('/directory?q=brisk')).text()
    expect(found).toContain('Site Matches (1)')
    const json = (await (await app.request('/api/directory')).json()) as { count: number; sites: { host: string }[] }
    expect(json.count).toBe(2)
    expect((await app.request('/directory/nope')).status).toBe(404)
    expect((await app.request('/directory/computers/nope')).status).toBe(404)
    expect(await (await app.request('/sitemap.xml')).text()).toContain('/directory/computers/web-dev')
  })
})
