import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decorate, joinFooter, namesFromSitemap, proxiedName, proxyRequest, rewriteCookie, rewriteUrls, sweepCerts, Targets, unrewriteUrl, type Certs } from '../src/proxy.ts'

describe('certificate sweep', () => {
  const sitemap = `<?xml version="1.0"?><urlset>
  <url><loc>https://pit.moshcode.sh/pit</loc></url>
  <url><loc>https://pit.moshcode.sh/n/streaming</loc></url>
  <url><loc>https://pit.moshcode.sh/n/live.streaming</loc></url>
  <url><loc>https://pit.moshcode.sh/n/family.ancestry</loc></url>
  <url><loc>https://pit.moshcode.sh/n/kathleen.ettinger</loc></url>
  <url><loc>https://pit.moshcode.sh/n/www.x</loc></url>
  <url><loc>https://pit.moshcode.sh/n/live.streaming</loc></url>
</urlset>`

  it('reads label.ending names from the registry sitemap, not bare endings or junk', () => {
    expect(namesFromSitemap(sitemap).sort()).toEqual(['family.ancestry', 'kathleen.ettinger', 'live.streaming'])
  })

  function fakeCerts(have: string[], refuse: string[] = []) {
    const issued: string[] = []
    const certs: Certs = {
      has: (h) => have.includes(h),
      issue: (h) => {
        if (refuse.includes(h)) return false
        issued.push(h)
        return true
      },
    }
    return { certs, issued }
  }

  it('asks for a certificate for every reachable name that has none, before any visit', async () => {
    const { certs, issued } = fakeCerts(['family.ancestry.pit.world'])
    const r = await sweepCerts({
      certs,
      sitemap: async () => sitemap,
      // kathleen.ettinger points at another Moshpit name, which the relay cannot reach.
      reachable: async (n) => n !== 'kathleen.ettinger',
    })
    expect(issued).toEqual(['live.streaming.pit.world'])
    expect(r).toEqual({ names: 3, missing: ['live.streaming.pit.world'], asked: ['live.streaming.pit.world'] })
  })

  it('reports a name it could not ask for (cap or recently asked) as missing', async () => {
    const { certs } = fakeCerts([], ['live.streaming.pit.world'])
    const r = await sweepCerts({ certs, sitemap: async () => sitemap, reachable: async () => true })
    expect(r.missing).toContain('live.streaming.pit.world')
    expect(r.asked).not.toContain('live.streaming.pit.world')
  })

  it('skips a name whose reachability check throws', async () => {
    const { certs, issued } = fakeCerts([])
    await sweepCerts({ certs, sitemap: async () => sitemap, reachable: async () => { throw new Error('dns') } })
    expect(issued).toEqual([])
  })
})

describe('<name>.pit.world', () => {
  it('maps hosts to Moshpit names, and leaves pit.world itself alone', () => {
    expect(proxiedName('family.ancestry.pit.world')).toBe('family.ancestry')
    expect(proxiedName('Seo.Rank.pit.world:443')).toBe('seo.rank')
    expect(proxiedName('a.b.c.pit.world')).toBe('a.b.c')
    expect(proxiedName('alt.2600.pit.world')).toBe('alt.2600')
    for (const host of ['pit.world', 'www.pit.world', 'hacker.pit.world', 'www.x.y.pit.world', 'evil.com', 'x.y.pit.world.evil.com', '-bad.x.pit.world', '', null]) expect(proxiedName(host)).toBeNull()
  })

  it('rewrites links to the name, and only to the name', () => {
    const p = 'family.ancestry.pit.world'
    expect(rewriteUrls('<a href="https://family.ancestry/t/1">', 'family.ancestry', p)).toBe(`<a href="https://${p}/t/1">`)
    expect(rewriteUrls('http://family.ancestry:443/x //family.ancestry', 'family.ancestry', p)).toBe(`https://${p}/x //${p}`)
    for (const keep of ['https://family.ancestry.pit.world/', 'https://pit.moshcode.sh/n/family.ancestry', 'https://family.ancestryx/', 'https://my.family.ancestry/'])
      expect(rewriteUrls(keep, 'family.ancestry', p)).toBe(keep.replace('https://family.ancestry.pit.world/', `https://${p}/`))
    expect(unrewriteUrl(`https://${p}/signin`, 'family.ancestry', p)).toBe('https://family.ancestry/signin')
    expect(unrewriteUrl('https://evil.example/', 'family.ancestry', p)).toBe('https://evil.example/')
  })

  it('pins cookies to the proxied host', () => {
    expect(rewriteCookie('fa_session=abc; Path=/; Domain=family.ancestry; HttpOnly; Secure')).toBe('fa_session=abc; Path=/; HttpOnly; Secure')
    expect(rewriteCookie('a=1; domain=.pit.world')).toBe('a=1')
  })

  it('adds the stylesheet and the join-Moshpit footer to every page, escaped', () => {
    const html = decorate('<html><head><title>x</title></head><body><p>hi</p></body></html>', 'family.ancestry', 'family.ancestry.pit.world')
    expect(html).toContain('<link rel="stylesheet" href="/.pit/proxy.css">\n</head>')
    expect(html.indexOf('class="pit-foot"')).toBeLessThan(html.indexOf('</body>'))
    expect(html).toContain('https://dns.moshcode.sh/dns-query')
    expect(html).toContain('https://pit.world/connect')
    // The steps sit in a popover behind one button, not in the page.
    expect(html).toContain('popovertarget="pit-foot-howto">How do I use this?</button>')
    expect(html).toContain('id="pit-foot-howto" class="pit-foot-modal" popover')
    expect(html).toContain('>Publish here</a>')
    expect(html).not.toContain('<script')
    expect(decorate('bare', 'a.b', 'a.b.pit.world')).toContain('class="pit-foot"')
    expect(joinFooter('x<y.z')).not.toContain('x<y')
    // A site that prints the global footer itself is left alone.
    const own = '<html><body><nav class="pit-foot" data-pit-footer></nav></body></html>'
    expect(decorate(own, 'a.b', 'a.b.pit.world').match(/data-pit-footer/g)?.length).toBe(1)
  })
})

describe('the registry going down is not the names going away', () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'pit-targets-')), 'relay-targets.json')
  // A registry we can switch off: resolve() answers null when it is down, like Registry.resolve on a 503 or a timeout.
  const registry = (names: Record<string, string>) => {
    const r = { up: true, asked: 0, access: { rootPem: '', resolve: async (name: string) => (r.asked++, r.up ? { nameRegistered: name in names, target: names[name] ?? null } : null) } }
    return r
  }

  it('serves the last good address while the registry does not answer, and says "try again" for a name it never saw', async () => {
    let clock = 0
    const reg = registry({ 'built.indie': '23.95.228.174' })
    const targets = new Targets(undefined, async () => [], () => clock)
    expect(await targets.get('built.indie', reg.access)).toEqual({ state: 'live', target: { address: '23.95.228.174' } })
    reg.up = false
    clock += 61_000
    expect(await targets.get('built.indie', reg.access)).toEqual({ state: 'live', target: { address: '23.95.228.174' }, stale: true })
    expect(await targets.get('never.seen', reg.access)).toEqual({ state: 'unreachable' })
    // Failures are not cached: the registry is asked again on the next request.
    const before = reg.asked
    await targets.get('never.seen', reg.access)
    expect(reg.asked).toBe(before + 1)
  })

  it('only the registry saying "not registered" is a 404, and it forgets the old address', async () => {
    let clock = 0
    const names: Record<string, string> = { 'gone.name': '23.95.228.174' }
    const reg = registry(names)
    const targets = new Targets(undefined, async () => [], () => clock)
    expect((await targets.get('gone.name', reg.access)).state).toBe('live')
    delete names['gone.name']
    clock += 61_000
    expect(await targets.get('gone.name', reg.access)).toEqual({ state: 'missing' })
    reg.up = false
    clock += 61_000
    expect(await targets.get('gone.name', reg.access)).toEqual({ state: 'unreachable' })
  })

  it('keeps the addresses on disk, so a relay restarted mid-outage still serves them', async () => {
    const file = tmp()
    const reg = registry({ 'seo.rank': 'seo.example' })
    await new Targets(file, async () => [{ address: '23.95.228.174' }]).get('seo.rank', reg.access)
    reg.up = false
    expect(await new Targets(file).get('seo.rank', reg.access)).toEqual({ state: 'live', target: { address: '23.95.228.174' }, stale: true })
    // The target host's own DNS failing is an outage too.
    reg.up = true
    expect(await new Targets(file, async () => { throw new Error('SERVFAIL') }).get('seo.rank', reg.access)).toMatchObject({ state: 'live', stale: true })
  })

  it('the relay answers 503 "try again" while the registry is down, not "not on Moshpit"', async () => {
    const reg = registry({})
    reg.up = false
    const certs: Certs = { has: () => true, issue: () => false }
    const res = await proxyRequest(new Request('https://never.seen.pit.world/'), 'never.seen', '1.2.3.4', 'https', { access: reg.access, certs, targets: new Targets() })
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('30')
    expect(await res.text()).not.toContain('is not on Moshpit')
    reg.up = true
    const missing = await proxyRequest(new Request('https://never.seen.pit.world/'), 'never.seen', '1.2.3.4', 'https', { access: reg.access, certs, targets: new Targets() })
    expect(missing.status).toBe(404)
  })
})
