import { describe, expect, it } from 'bun:test'
import { parseGdelt, parseItunes, parseNominatim, searchMedia, Spacer, thumbAllowed } from '../src/verticals.ts'

// Shapes as the live APIs answered on 2026-11-02.
const GDELT = { articles: [{ url: 'https://news.example/swift', title: 'Taylor Swift inducted into Hall of Fame', seendate: '20261027T051500Z', domain: 'news.example', socialimage: 'https://img.example/x.jpg' }, { url: 'javascript:x', title: 'bad' }] }
const ITUNES = {
  resultCount: 2,
  results: [
    { wrapperType: 'track', kind: 'song', trackName: 'Patient Zero', artistName: 'Taylor Swift', collectionName: 'The Life of a Showgirl', trackViewUrl: 'https://music.apple.com/us/album/patient-zero/1?i=2', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg', releaseDate: '2026-09-24T07:00:00Z', trackTimeMillis: 225868, primaryGenreName: 'Pop' },
    { wrapperType: 'track', trackName: 'Patient Zero', artistName: 'Taylor Swift', trackViewUrl: 'https://music.apple.com/us/album/patient-zero/1?i=2' },
  ],
}
const NOMINATIM = [
  { osm_type: 'node', osm_id: 2637755154, lat: '37.22', lon: '-121.98', type: 'fast_food', name: 'Pizza My Heart', display_name: 'Pizza My Heart, 9, North Santa Cruz Avenue, Los Gatos, California, 95030, United States', extratags: { cuisine: 'pizza', phone: '+1 408 555 0100' } },
  { osm_type: 'way', osm_id: 5, lat: '1', lon: '2', type: 'restaurant', name: 'Site Pizza', display_name: 'Site Pizza, Somewhere', extratags: { website: 'https://sitepizza.example/' } },
]

describe('more open fallbacks: parsing', () => {
  it('GDELT: articles with day and domain, no non-web links', () => {
    expect(parseGdelt(GDELT)).toEqual([{ url: 'https://news.example/swift', title: 'Taylor Swift inducted into Hall of Fame', host: 'news.example', thumbnail: 'https://img.example/x.jpg', date: '2026-10-27', channel: 'news.example' }])
  })
  it('iTunes: song · artist, album and genre, duration, artwork /img may fetch, no repeats', () => {
    const hits = parseItunes(ITUNES)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ title: 'Patient Zero · Taylor Swift', host: 'music.apple.com', description: 'The Life of a Showgirl · Pop', duration: '3:45', date: '2026-09-24', channel: 'Taylor Swift' })
    expect(thumbAllowed(hits[0]!.thumbnail!)).not.toBeNull()
  })
  it('Nominatim: own site when tagged, else the OSM object; address, type, phone', () => {
    const [a, b] = parseNominatim(NOMINATIM)
    expect(a).toMatchObject({ url: 'https://www.openstreetmap.org/node/2637755154', title: 'Pizza My Heart', host: 'openstreetmap.org', channel: 'fast food', extra: '+1 408 555 0100' })
    expect(a!.address).toContain('Los Gatos')
    expect(b).toMatchObject({ url: 'https://sitepizza.example/', host: 'sitepizza.example' })
  })
})

describe('Spacer', () => {
  it('lets one call through per gap and refuses callers that would wait too long', async () => {
    const s = new Spacer(5_000, 0)
    expect(await s.take()).toBe(true)
    expect(await s.take()).toBe(false)
    const t = new Spacer(30, 100)
    const start = Date.now()
    expect(await t.take()).toBe(true)
    expect(await t.take()).toBe(true)
    expect(Date.now() - start).toBeGreaterThanOrEqual(25)
  })
})

function network(log: string[], answers: Record<string, unknown>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    log.push(`${new URL(url).hostname} ${new Headers(init?.headers).get('user-agent') ?? ''}`)
    if (url.startsWith('https://google.serper.dev/')) return Response.json({ message: 'Not enough credits', statusCode: 400 }, { status: 400 })
    for (const [prefix, body] of Object.entries(answers)) if (url.startsWith(prefix)) return body === 'down' ? new Response('x', { status: 503 }) : Response.json(body)
    return new Response('no', { status: 500 })
  }) as typeof fetch
}
const free = () => ({ gdelt: new Spacer(0, 0), nominatim: new Spacer(0, 0) })

describe('News, Music and Places keep answering when Serper is out of credits', () => {
  it('News: rssamplifier newest first, filled from GDELT', async () => {
    const ra = { posts: [{ url: 'https://a.example/old', title: 'Old', publishedAt: '2026-01-01T00:00:00Z' }, { url: 'https://b.example/new', title: 'New', publishedAt: '2026-10-30T00:00:00Z' }] }
    const r = await searchMedia('news', 'taylor swift', { serper: 'k' }, { fetch: network([], { 'https://rssamplifier.com/': ra, 'https://api.gdeltproject.org/': GDELT }), spacers: free() })
    expect(r.provider).toBe('rssamplifier')
    expect(r.hits.map((h) => h.title)).toEqual(['New', 'Old', 'Taylor Swift inducted into Hall of Fame'])
  })
  it('News: GDELT alone when rssamplifier is down', async () => {
    const r = await searchMedia('news', 'taylor swift', {}, { fetch: network([], { 'https://rssamplifier.com/': 'down', 'https://api.gdeltproject.org/': GDELT }), spacers: free() })
    expect(r.provider).toBe('gdelt')
    expect(r.hits).toHaveLength(1)
  })
  it('News: GDELT is skipped (not queued) inside its 5 s gap', async () => {
    const log: string[] = []
    const busy = { gdelt: new Spacer(60_000, 0), nominatim: new Spacer(0, 0) }
    await busy.gdelt.take()
    await searchMedia('news', 'x', {}, { fetch: network(log, { 'https://rssamplifier.com/': { posts: [{ url: 'https://a.example/', title: 'A' }] } }), spacers: busy })
    expect(log.some((l) => l.startsWith('api.gdeltproject.org'))).toBe(false)
  })
  it('Music: iTunes', async () => {
    const r = await searchMedia('music', 'taylor swift', { serper: 'k' }, { fetch: network([], { 'https://itunes.apple.com/': ITUNES }) })
    expect(r.provider).toBe('itunes')
    expect(r.hits[0]!.title).toBe('Patient Zero · Taylor Swift')
  })
  it('Places: Nominatim with our User-Agent', async () => {
    const log: string[] = []
    const r = await searchMedia('places', 'pizza los gatos', {}, { fetch: network(log, { 'https://nominatim.openstreetmap.org/': NOMINATIM }), spacers: free() })
    expect(r.provider).toBe('osm')
    expect(r.hits).toHaveLength(2)
    expect(log.find((l) => l.startsWith('nominatim'))).toContain('pit.world search')
  })
  it('Shopping needs an index of some kind', async () => {
    await expect(searchMedia('shopping', 'shoes', {}, {})).rejects.toThrow('our own index')
  })
  it('Shopping comes from our own index, products only, with the price a shop wrote', async () => {
    const asked: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      asked.push(String(url))
      return Response.json({ items: [{ url: 'https://shop.example/shoe', title: 'Trail shoe', site: 'shop.example', summary: 'Light. Now $89.50 with free returns.' }] })
    }) as typeof fetch
    const r = await searchMedia('shopping', 'shoes', { pit: 'http://127.0.0.1:8807', serper: 'k' }, { fetch: fetchImpl })
    expect(r.provider).toBe('pit')
    expect(r.hits[0]).toMatchObject({ url: 'https://shop.example/shoe', title: 'Trail shoe', price: '$89.50' })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('kind=product')
  })
  it('Shopping asks Google only when our index has nothing, and survives Google being out of credits', async () => {
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).includes('serper') ? new Response('out of credits', { status: 400 }) : Response.json({ items: [] })) as typeof fetch
    const r = await searchMedia('shopping', 'shoes', { pit: 'http://127.0.0.1:8807', serper: 'k' }, { fetch: fetchImpl })
    expect(r.hits).toEqual([])
  })
})
