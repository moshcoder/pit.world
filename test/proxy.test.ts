import { describe, expect, it } from 'bun:test'
import { decorate, joinFooter, proxiedName, rewriteCookie, rewriteUrls, unrewriteUrl } from '../src/proxy.ts'

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
    expect(html.indexOf('class="pit-proxy"')).toBeLessThan(html.indexOf('</body>'))
    expect(html).toContain('https://dns.moshcode.sh/dns-query')
    expect(html).toContain('https://pit.world/connect')
    expect(decorate('bare', 'a.b', 'a.b.pit.world')).toContain('class="pit-proxy"')
    expect(joinFooter('x<y.z')).not.toContain('x<y')
  })
})
