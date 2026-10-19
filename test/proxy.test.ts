import { describe, expect, it } from 'bun:test'
import { decorate, joinFooter, namesFromSitemap, proxiedName, rewriteCookie, rewriteUrls, sweepCerts, unrewriteUrl, type Certs } from '../src/proxy.ts'

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
