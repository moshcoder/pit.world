import { describe, expect, it } from 'bun:test'
import { type Player, AudioRegistry, embedFor, embedHosts, parseM3u, peertubeEmbed, previewPlayer, proxyAudio, readableScans, showEpisodes, showPage } from '../src/players.ts'
import { createApp } from '../src/server.ts'
import { Registry } from '../src/moshpit.ts'
import { W3bsNetwork } from '../src/w3bs-network.ts'
import { parseItunes, parseP0dcasters, parseSepia, searchMedia } from '../src/verticals.ts'
import { playButton } from '../src/html.ts'

const srcOf = (p: Player | null | undefined) => (p && 'src' in p ? p.src : null)

describe('embedFor: only exact player shapes', () => {
  it('YouTube in every spelling plays from youtube-nocookie', () => {
    for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/live/dQw4w9WgXcQ'])
      expect(embedFor(url)).toEqual({ kind: 'embed', src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0', host: 'youtube-nocookie.com', shape: 'video' })
    expect(embedFor('https://www.youtube.com/watch?v=short')).toBeNull()
    expect(embedFor('https://www.youtube.com/@channel')).toBeNull()
    expect(embedFor('https://evil.example/watch?v=dQw4w9WgXcQ')).toBeNull()
  })
  it('Vimeo, the Internet Archive, Spotify and SoundCloud', () => {
    expect(srcOf(embedFor('https://vimeo.com/76979871'))).toBe('https://player.vimeo.com/video/76979871?dnt=1&autoplay=1')
    expect(embedFor('https://vimeo.com/channels/staffpicks')).toBeNull()
    expect(srcOf(embedFor('https://archive.org/details/night_of_the_living_dead'))).toBe('https://archive.org/embed/night_of_the_living_dead')
    expect(embedFor('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC')).toMatchObject({ src: 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC', shape: 'audio' })
    expect(embedFor('https://open.spotify.com/search/foo')).toBeNull()
    expect(srcOf(embedFor('https://soundcloud.com/artist/song-name'))).toBe('https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Fsong-name&auto_play=true&visual=false')
    expect(embedFor('https://soundcloud.com/discover/sets')).toBeNull()
    expect(embedFor('javascript:alert(1)')).toBeNull()
  })
  it('PeerTube embeds on its own instance, https only', () => {
    expect(srcOf(peertubeEmbed('https://tube.example.org/w/9c9de5e8-0a1e-484a-b099-e80766180a6d'))).toBe('https://tube.example.org/videos/embed/9c9de5e8-0a1e-484a-b099-e80766180a6d?autoplay=1&warningTitle=0')
    expect(peertubeEmbed('https://tube.example.org/videos/watch/abcdEFGH12')?.host).toBe('tube.example.org')
    expect(peertubeEmbed('http://tube.example.org/w/abcdEFGH12')).toBeNull()
    expect(peertubeEmbed('https://tube.example.org:8443/w/abcdEFGH12')).toBeNull()
    expect(embedHosts([peertubeEmbed('https://tube.example.org/w/abcdEFGH12')!, embedFor('https://youtu.be/dQw4w9WgXcQ')!, undefined])).toEqual(['https://tube.example.org'])
  })
})

describe('parsers attach players', () => {
  it('iTunes previews, PeerTube videos, p0dcasters shows', () => {
    const [song] = parseItunes({ results: [{ trackName: 'A', artistName: 'B', trackViewUrl: 'https://music.apple.com/x', previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/p.m4a' }] })
    expect(song!.player).toEqual({ kind: 'audio', src: 'https://audio-ssl.itunes.apple.com/itunes-assets/p.m4a', host: 'apple.com' })
    expect(previewPlayer('https://evil.example/p.m4a')).toBeUndefined()
    const [video] = parseSepia({ data: [{ url: 'https://tube.example.org/w/abcdEFGH12', name: 'V' }] })
    expect(video!.player?.kind).toBe('embed')
    const [show] = parseP0dcasters({ shows: [{ title: 'S', page: 'https://p0dcasters.com/podcast/s-show', host: 'buzzsprout.com', episodes: 3 }] })
    expect(show!.player).toEqual({ kind: 'episodes', show: 'https://p0dcasters.com/podcast/s-show', host: 'buzzsprout.com' })
  })
  it('a button that names who the player comes from, hidden without script', () => {
    const html = playButton(embedFor('https://youtu.be/dQw4w9WgXcQ'))
    expect(html).toContain('<div class="play-row" hidden>')
    expect(html).toContain('data-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&amp;rel=0"')
    expect(html).toContain('from youtube-nocookie.com')
    expect(playButton({ kind: 'audio', src: 'https://audio-ssl.itunes.apple.com/a b.m4a', host: 'apple.com' })).toContain('data-src="/audio?u=https%3A%2F%2Faudio-ssl.itunes.apple.com%2Fa%20b.m4a"')
    expect(playButton(undefined)).toBe('')
  })
})

describe('books: public-domain scans', () => {
  it('picks a readable scan per work, older scans first, and Books gets Read here', async () => {
    const asked: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      asked.push(url)
      if (url.startsWith('https://openlibrary.org/search.json'))
        return Response.json({
          docs: [
            { key: '/works/OL1W', title: 'Moby Dick', ebook_access: 'public', ia: ['bwb_X', 'mobydick00melv_1', 'lent0000'] },
            { key: '/works/OL2W', title: 'New Book', ebook_access: 'borrowable', ia: ['newbook0000'] },
          ],
        })
      if (url.startsWith('https://archive.org/advancedsearch.php')) return Response.json({ response: { docs: [{ identifier: 'bwb_X' }, { identifier: 'mobydick00melv_1' }] } })
      return new Response('no', { status: 500 })
    }) as typeof fetch
    const r = await searchMedia('books', 'moby dick', {}, { fetch: fetchImpl })
    expect(r.hits[0]!.player).toEqual({ kind: 'embed', src: 'https://archive.org/embed/mobydick00melv_1', host: 'archive.org', shape: 'book' })
    expect(r.hits[1]!.player).toBeUndefined()
    const q = new URL(asked.find((u) => u.includes('advancedsearch'))!).searchParams.get('q')!
    expect(q).toContain('NOT collection:(inlibrary OR printdisabled OR lendinglibrary)')
    expect(q).not.toContain('newbook0000')
  })
  it('the archive being down costs the Read button, not the results', async () => {
    const down = (async () => new Response('x', { status: 503 })) as unknown as typeof fetch
    await expect(readableScans(new Map([['w', ['a']]]), down)).rejects.toThrow()
    expect(await readableScans(new Map(), down)).toEqual(new Map())
  })
})

describe('podcast episodes and /audio', () => {
  const M3U = '#EXTM3U\n#PLAYLIST:Show\n#EXTINF:666,What is Public History?\nhttps://cdn.example/ep1.mp3\n#EXTINF:-1,Live\nhttps://cdn.example/ep2.mp3\nnot a url\n'
  it('parses an extended M3U', () => {
    expect(parseM3u(M3U)).toEqual([
      { title: 'What is Public History?', seconds: 666, url: 'https://cdn.example/ep1.mp3' },
      { title: 'Live', url: 'https://cdn.example/ep2.mp3' },
    ])
  })
  it('only exact p0dcasters show pages', () => {
    expect(showPage('https://p0dcasters.com/podcast/the-show/')).toBe('https://p0dcasters.com/podcast/the-show')
    expect(showPage('https://p0dcasters.com/podcast/the-show?x=1')).toBeNull()
    expect(showPage('https://evil.example/podcast/the-show')).toBeNull()
    expect(showPage('https://p0dcasters.com/api/x')).toBeNull()
  })
  it('registers only the episodes it read; /audio streams those with Range and refuses the rest', async () => {
    const reg = new AudioRegistry()
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://p0dcasters.com/podcast/the-show/playlist.m3u') return new Response(M3U)
      if (url === 'https://cdn.example/ep1.mp3') return new Response(null, { status: 302, headers: { location: 'https://media.example/real.mp3' } })
      if (url === 'https://media.example/real.mp3') {
        const range = new Headers(init?.headers).get('range')
        return new Response('abc', { status: range ? 206 : 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '3', ...(range ? { 'content-range': 'bytes 0-2/100' } : {}) } })
      }
      return new Response('no', { status: 500 })
    }) as typeof fetch
    expect(reg.allowed('https://cdn.example/ep1.mp3')).toBe(false)
    await showEpisodes('https://p0dcasters.com/podcast/the-show', reg, fetchImpl)
    expect(reg.allowed('https://cdn.example/ep1.mp3')).toBe(true)
    const pub = async () => ['93.184.216.34']
    const res = await proxyAudio('https://cdn.example/ep1.mp3', 'bytes=0-2', { fetch: fetchImpl, resolve: pub })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-2/100')
    expect(await res.text()).toBe('abc')
    // A redirect into a private network is refused.
    const priv = async (h: string) => (h === 'media.example' ? ['10.0.0.5'] : ['93.184.216.34'])
    expect((await proxyAudio('https://cdn.example/ep1.mp3', null, { fetch: fetchImpl, resolve: priv })).status).toBe(502)
  })
})

describe('the app', () => {
  function make() {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://google.serper.dev/')) return Response.json({ message: 'Not enough credits' }, { status: 400 })
      if (url.startsWith('https://sepiasearch.org/')) return Response.json({ data: [{ url: 'https://tube.example.org/w/abcdEFGH12', name: 'Cats on PeerTube' }] })
      if (url.startsWith('https://archive.org/advancedsearch.php')) return Response.json({ response: { docs: [] } })
      if (url === 'https://p0dcasters.com/podcast/the-show/playlist.m3u') return new Response('#EXTINF:60,One\nhttps://cdn.example/one.mp3\n')
      if (url === 'https://cdn.example/one.mp3') return new Response('mp3', { headers: { 'content-type': 'audio/mpeg' } })
      return new Response('no', { status: 500 })
    }) as typeof fetch
    const app = createApp({
      keys: { serper: 'K' },
      registry: new Registry('https://registry.test', fetchImpl),
      fetch: fetchImpl,
      resolve: async () => ['93.184.216.34'],
      network: new W3bsNetwork(fetchImpl),
    } as Parameters<typeof createApp>[0])
    return (path: string) => app.request(path, {}, { ip: '203.0.113.9' })
  }
  it('Videos: Play here, and frame-src names the PeerTube instance for that page only', async () => {
    const request = make()
    const res = await request('/search?q=cats&t=videos')
    const html = await res.text()
    expect(html).toContain('data-src="https://tube.example.org/videos/embed/abcdEFGH12?autoplay=1&amp;warningTitle=0"')
    expect(res.headers.get('content-security-policy')).toContain('frame-src https://tube.example.org https://crawlproof.com')
    expect(res.headers.get('x-frame-hosts')).toBeNull()
    const other = await request('/search?q=cats&t=books')
    expect(other.headers.get('content-security-policy')).not.toContain('tube.example.org')
  })
  it('/audio refuses files it did not hand out, streams episodes it did', async () => {
    const request = make()
    expect((await request(`/audio?u=${encodeURIComponent('https://cdn.example/one.mp3')}`)).status).toBe(403)
    expect((await request('/api/episodes?show=https%3A%2F%2Fevil.example%2Fpodcast%2Fx')).status).toBe(400)
    const body = (await (await request(`/api/episodes?show=${encodeURIComponent('https://p0dcasters.com/podcast/the-show')}`)).json()) as { episodes: Array<{ src: string; title: string; seconds?: number }> }
    expect(body.episodes).toEqual([{ title: 'One', seconds: 60, src: `/audio?u=${encodeURIComponent('https://cdn.example/one.mp3')}` }])
    const audio = await request(body.episodes[0]!.src)
    expect(audio.status).toBe(200)
    expect(audio.headers.get('content-type')).toBe('audio/mpeg')
    expect(await audio.text()).toBe('mp3')
  })
})
