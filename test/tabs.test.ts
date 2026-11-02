import { describe, expect, it } from 'bun:test'
import { parseArchiveMovies, parseCommonsImages, parseOpenAlex, parseOpenLibrary, parseSepia, searchMedia, thumbAllowed } from '../src/verticals.ts'
import { Cache } from '../src/search.ts'

// Shapes as the live APIs answered on 2026-11-02.
const COMMONS = {
  query: {
    pages: {
      '2': { title: 'File:Second shot.png', index: 2, imageinfo: [{ thumburl: 'https://upload.wikimedia.org/b/second.png/330px.png', url: 'https://upload.wikimedia.org/b/second.png', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Second_shot.png', width: 639, height: 909, mime: 'image/png' }] },
      '1': { title: 'File:Taylor_Swift_2019.jpg', index: 1, imageinfo: [{ thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/65/T.jpg/330px-T.jpg', url: 'https://upload.wikimedia.org/6/65/T.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Taylor_Swift_2019.jpg', width: 1200, height: 800, mime: 'image/jpeg' }] },
      '3': { title: 'File:Clip.webm', index: 3, imageinfo: [{ descriptionurl: 'https://commons.wikimedia.org/wiki/File:Clip.webm', mime: 'video/webm' }] },
    },
  },
}
const SEPIA = {
  total: 2,
  data: [
    { name: 'Taylor Swift - Delicate', url: 'https://tube.example/w/abc', description: 'Music video.\n\nMore   text', duration: 245, publishedAt: '2026-04-09T00:33:15.037Z', channel: { displayName: 'Music', host: 'tube.example' }, nsfw: false },
    { name: 'Not for work', url: 'https://tube.example/w/x', nsfw: true },
    { name: 'Live now', url: 'https://live.example/w/l', isLive: true, duration: 0, channel: { displayName: 'Stream', host: 'live.example' } },
  ],
}
const ARCHIVE = { response: { numFound: 1, docs: [{ identifier: 'climate_film_1975', title: 'Climate and Man', description: '<p>A 1975 <b>educational</b> film.</p>', year: 1975, creator: ['NASA'] }, { identifier: 'bad id/../x', title: 'x' }] } }

describe('Images without Google: Wikimedia Commons', () => {
  it('reads files in search order, images only, linked to their Commons page', () => {
    const hits = parseCommonsImages(COMMONS)
    expect(hits.map((h) => h.title)).toEqual(['Taylor Swift 2019', 'Second shot'])
    expect(hits[0]).toMatchObject({ url: 'https://commons.wikimedia.org/wiki/File:Taylor_Swift_2019.jpg', host: 'commons.wikimedia.org', width: 1200, height: 800 })
    expect(thumbAllowed(hits[0]!.thumbnail!)).not.toBeNull()
    expect(thumbAllowed(hits[1]!.thumbnail!)).not.toBeNull()
  })
})

describe('Videos and Live without Google: PeerTube and the Internet Archive', () => {
  it('reads Sepia Search, drops NSFW, formats duration and marks live', () => {
    const hits = parseSepia(SEPIA)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ title: 'Taylor Swift - Delicate', duration: '4:05', date: '2026-04-09', channel: 'Music', host: 'tube.example', description: 'Music video. More text' })
    expect(hits[1]!.duration).toBe('LIVE')
  })

  it('reads Internet Archive films with an /img-able thumbnail and no markup', () => {
    const hits = parseArchiveMovies(ARCHIVE)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ url: 'https://archive.org/details/climate_film_1975', thumbnail: 'https://archive.org/services/img/climate_film_1975', description: 'A 1975 educational film.', date: '1975', channel: 'NASA' })
    expect(thumbAllowed(hits[0]!.thumbnail!)).not.toBeNull()
  })
})

describe('Books and Scholar parsing', () => {
  it('Open Library: first sentence as the description when there is one', () => {
    const [book] = parseOpenLibrary({ docs: [{ key: '/works/OL1W', title: 'Rust in Action', author_name: ['Tim McNamara'], first_publish_year: 2021, cover_i: 10, edition_count: 2, first_sentence: ['Rust is a language.'] }] })
    expect(book).toMatchObject({ url: 'https://openlibrary.org/works/OL1W', description: 'Rust is a language.', author: 'Tim McNamara', date: '2021', extra: '2 editions' })
  })

  it('OpenAlex: abstract, authors, venue, citations', () => {
    const [paper] = parseOpenAlex({ results: [{ id: 'https://openalex.org/W1', display_name: 'Bitcoin', doi: 'https://doi.org/10.1/x', publication_year: 2015, cited_by_count: 328, authorships: [{ author: { display_name: 'Aviv Zohar' } }], primary_location: { source: { display_name: 'CACM' } }, abstract_inverted_index: { The: [0], myths: [1] } }] })
    expect(paper).toMatchObject({ url: 'https://doi.org/10.1/x', title: 'Bitcoin', description: 'The myths', author: 'Aviv Zohar - CACM', extra: 'Cited by 328' })
  })
})

/** A fake network: Serper out of credits (its real answer), the open indexes answering. */
function network(log: string[]) {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    log.push(new URL(url).hostname)
    if (url.startsWith('https://google.serper.dev/')) return Response.json({ message: 'Not enough credits', statusCode: 400 }, { status: 400 })
    if (url.startsWith('https://commons.wikimedia.org/')) return Response.json(COMMONS)
    if (url.startsWith('https://sepiasearch.org/')) return Response.json(SEPIA)
    if (url.startsWith('https://archive.org/advancedsearch.php')) return Response.json(ARCHIVE)
    return new Response('no', { status: 500 })
  }) as typeof fetch
}

describe('tabs keep answering when Google (Serper) is out of credits', () => {
  it('Images falls back to Commons', async () => {
    const log: string[] = []
    const r = await searchMedia('images', 'taylor swift', { serper: 'k' }, { fetch: network(log), cache: new Cache() })
    expect(r.provider).toBe('commons')
    expect(r.hits.length).toBe(2)
    expect(log).toEqual(['google.serper.dev', 'commons.wikimedia.org'])
  })

  it('Images works with no Serper key at all', async () => {
    const r = await searchMedia('images', 'taylor swift', {}, { fetch: network([]) })
    expect(r.provider).toBe('commons')
  })

  it('Videos interleaves PeerTube and the Internet Archive', async () => {
    const r = await searchMedia('videos', 'climate', { serper: 'k' }, { fetch: network([]) })
    expect(r.provider).toBe('peertube')
    expect(r.hits.map((h) => h.host)).toEqual(['tube.example', 'archive.org', 'live.example'])
  })

  it('Live asks PeerTube for live streams only', async () => {
    const log: string[] = []
    const fake = (async (input: string | URL | Request) => {
      log.push(String(input))
      return Response.json(String(input).includes('sepiasearch') ? SEPIA : { message: 'Not enough credits' }, { status: String(input).includes('sepiasearch') ? 200 : 400 })
    }) as typeof fetch
    const r = await searchMedia('live', 'news', {}, { fetch: fake })
    expect(r.hits.length).toBe(2)
    expect(log.some((u) => u.includes('isLive=true'))).toBe(true)
    expect(log.some((u) => u.includes('archive.org'))).toBe(false)
  })

  it('Live falls back to recorded streams when nothing is live right now', async () => {
    const asked: string[] = []
    const fake = (async (input: string | URL | Request) => {
      const u = String(input)
      asked.push(u)
      if (u.includes('sepiasearch') && u.includes('isLive=true')) return Response.json({ data: [] })
      if (u.includes('sepiasearch')) return Response.json(SEPIA)
      if (u.includes('archive.org')) return Response.json(ARCHIVE)
      return Response.json({}, { status: 400 })
    }) as typeof fetch
    const r = await searchMedia('live', 'news', {}, { fetch: fake })
    expect(r.hits.length).toBeGreaterThan(0)
    expect(asked.some((u) => u.includes('news+live+stream'))).toBe(true)
  })

  it('Videos says unavailable only when every open index failed', async () => {
    const down = (async () => new Response('x', { status: 503 })) as unknown as typeof fetch
    await expect(searchMedia('videos', 'x', {}, { fetch: down })).rejects.toThrow('did not answer')
  })

  it('Books retries a slow or failing Open Library once', async () => {
    let calls = 0
    const flaky = (async () => {
      calls++
      if (calls === 1) return new Response('busy', { status: 503 })
      return Response.json({ docs: [{ key: '/works/OL2W', title: 'Climate Change', author_name: ['A'] }] })
    }) as unknown as typeof fetch
    const r = await searchMedia('books', 'climate change', {}, { fetch: flaky })
    expect(calls).toBe(2)
    expect(r.hits[0]!.title).toBe('Climate Change')
  })

  it('long video descriptions become snippets', async () => {
    const long = { data: [{ name: 'Talk', url: 'https://t.example/w/1', description: 'An introduction to pricing. '.repeat(40) }] }
    const fake = (async () => Response.json(long)) as unknown as typeof fetch
    const r = await searchMedia('live', 'pricing', {}, { fetch: fake })
    expect(r.hits[0]!.description!.length).toBeLessThanOrEqual(241)
  })
})
