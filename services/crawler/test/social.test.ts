import { describe, expect, test } from 'bun:test'
import { configFromEnv } from '../src/config.ts'
import { createCrawler } from '../src/crawler.ts'
import { MemoryFrontier } from '../src/frontier.ts'
import { interleave, parseBluesky, parseHackerNews, parseLemmy, parseMastodon, parseTsbb, plainText, recognise, sampleInstances, searchInstance, searchPds, type SocialSite } from '../src/social.ts'

const BSKY = { posts: [{ uri: 'at://did:plc:x/app.bsky.feed.post/3abc', author: { handle: 'ann.bsky.social' }, record: { text: 'Rust is <b>nice</b>' }, likeCount: 2, replyCount: 1, indexedAt: '2026-11-06T10:00:00Z', labels: [] }] }
const HN = { hits: [{ objectID: '42', title: 'Show HN: Rust', author: 'bob', points: 10, num_comments: 3, created_at: '2026-10-01T00:00:00Z' }] }
const LEMMY = { posts: [{ post: { name: 'Rust thread', ap_id: 'https://lemmy.world/post/9', published: '2026-09-01T00:00:00Z' }, community: { name: 'rust' }, counts: { score: 5, comments: 1 } }] }
const MASTODON = [{ url: 'https://mastodon.social/@cy/1', content: '<p>Hello &amp; welcome <a href="https://x.example">#rust</a></p>', account: { acct: 'cy' }, created_at: '2026-11-01T00:00:00Z', favourites_count: 1, replies_count: 0 }]
const site = (s: string, adapter: SocialSite['adapter'], extra: Partial<SocialSite> = {}): SocialSite => ({ site: s, software: adapter, adapter, seenAt: '2026-11-07T00:00:00.000Z', ...extra })

describe('reading each kind of network', () => {
  test('builds the address a person can open and reply at', () => {
    expect(parseBluesky(BSKY)[0]).toMatchObject({ url: 'https://bsky.app/profile/ann.bsky.social/post/3abc', host: 'Bluesky', author: '@ann.bsky.social', extra: '2 likes, 1 reply' })
    expect(parseHackerNews(HN)[0]).toMatchObject({ url: 'https://news.ycombinator.com/item?id=42', extra: '10 points, 3 comments' })
    expect(parseLemmy(LEMMY, 'lemmy.world')[0]).toMatchObject({ url: 'https://lemmy.world/post/9', host: 'lemmy.world', author: 'c/rust' })
    expect(parseMastodon(MASTODON, 'mastodon.social')[0]).toMatchObject({ url: 'https://mastodon.social/@cy/1', title: 'Hello & welcome #rust' })
    expect(parseTsbb({ hits: [{ postId: 54, topicId: 53, title: 'The line, before the game!', author: 'anthony', createdAt: 1788753609436, snippet: 'tipoffwatch now' }] }, 'bbs.hqtui.com')[0]).toMatchObject({ url: 'https://bbs.hqtui.com/t/the-line-before-the-game-53/p/54', host: 'bbs.hqtui.com', author: 'anthony', date: '2026-09-07' })
  })
  test('leaves out what its author or network marked sensitive', () => {
    expect(parseBluesky({ posts: [{ ...BSKY.posts[0], labels: [{ val: 'porn' }] }] })).toEqual([])
    expect(parseLemmy({ posts: [{ ...LEMMY.posts[0], post: { ...LEMMY.posts[0]!.post, nsfw: true } }] })).toEqual([])
    expect(parseLemmy({ posts: [{ ...LEMMY.posts[0], community: { name: 'x', nsfw: true } }] })).toEqual([])
    expect(parseMastodon([{ ...MASTODON[0], sensitive: true }])).toEqual([])
    expect(parseMastodon([{ ...MASTODON[0], spoiler_text: 'cw' }])).toEqual([])
  })
  test('refuses an address that is not https, and survives junk', () => {
    expect(parseLemmy({ posts: [{ ...LEMMY.posts[0], post: { name: 'x', ap_id: 'javascript:alert(1)' } }] })).toEqual([])
    expect(parseMastodon([{ ...MASTODON[0], url: 'http://plain.example/1' }])).toEqual([])
    for (const parse of [parseBluesky, parseHackerNews, parseLemmy, parseMastodon]) expect(parse({ nonsense: true })).toEqual([])
    expect(parseTsbb({ hits: [{ title: 'no ids' }] }, 'x.example')).toEqual([])
  })
  test('HTML becomes plain words, and a long post a title and text', () => {
    expect(plainText('<p>a<br>b</p> &lt;c&gt;')).toBe('a b <c>')
    const [long] = parseMastodon([{ ...MASTODON[0], content: `<p>${'word '.repeat(100)}</p>` }])
    expect(long!.title.length).toBeLessThanOrEqual(121)
    expect(long!.description!.length).toBeLessThanOrEqual(300)
  })
})

describe('an AT Protocol server', () => {
  const pds = async (url: string) => {
    if (url.includes('listRepos')) return { repos: [{ did: 'did:plc:a', active: true }, { did: 'did:plc:gone', active: false }] }
    if (url.includes('describeRepo')) return { handle: 'riotcoder.social.w3bs.org' }
    return { records: [{ uri: 'at://did:plc:a/app.bsky.feed.post/1', value: { text: 'A node on c0mpute', createdAt: '2026-11-01T00:00:00Z' } }, { uri: 'at://did:plc:a/app.bsky.feed.post/2', value: { text: 'Something else' } }, { uri: 'at://did:plc:a/app.bsky.feed.post/3', value: { text: 'A node, labelled', labels: { values: [{ val: 'porn' }] } } }] }
  }
  test('has no search, so its posts are read and matched on every word', async () => {
    const hits = await searchPds(pds, site('social.w3bs.org', 'atproto', { web: true }), 'node c0mpute')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ url: 'https://social.w3bs.org/profile/riotcoder.social.w3bs.org/post/1', host: 'social.w3bs.org' })
  })
  test('with no client of its own, a post opens on bsky.app', async () => {
    const hits = await searchPds(pds, site('pds.example', 'atproto'), 'node')
    expect(hits[0]!.url).toStartWith('https://bsky.app/profile/')
  })
})

describe('recognising a site, with no list of networks', () => {
  const web = (pages: Record<string, { body?: unknown; type?: string; status?: number }>) => async (path: string) => {
    const p = pages[path]
    return p ? { status: p.status ?? 200, contentType: p.type ?? 'application/json', body: typeof p.body === 'string' ? p.body : JSON.stringify(p.body) } : { status: 404, contentType: 'text/html', body: '' }
  }
  const pointer = (domain: string) => ({ links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: `https://${domain}/nodeinfo/2.0` }] })

  test('any fediverse software on any domain', async () => {
    const mastodon = await recognise('toot.example', web({ '/.well-known/nodeinfo': { body: pointer('toot.example') }, '/nodeinfo/2.0': { body: { software: { name: 'Mastodon' } } } }))
    expect(mastodon).toMatchObject({ site: 'toot.example', software: 'mastodon', adapter: 'mastodon' })
    const lemmy = await recognise('talk.example', web({ '/.well-known/nodeinfo': { body: pointer('talk.example') }, '/nodeinfo/2.0': { body: { software: { name: 'lemmy' } } } }))
    expect(lemmy?.adapter).toBe('lemmy')
  })
  test('software we cannot search is still recognised, and read through the index', async () => {
    const misskey = await recognise('misskey.example', web({ '/.well-known/nodeinfo': { body: pointer('misskey.example') }, '/nodeinfo/2.0': { body: { software: { name: 'misskey' } } } }))
    expect(misskey).toMatchObject({ software: 'misskey', adapter: 'none' })
  })
  test('an AT Protocol server, and whether it has a client of its own', async () => {
    const withClient = await recognise('social.w3bs.org', web({ '/xrpc/_health': { body: { version: '0.4.5037' } }, '/': { body: '<html>', type: 'text/html' } }))
    expect(withClient).toMatchObject({ adapter: 'atproto', web: true })
    const bare = await recognise('pds.example', web({ '/xrpc/_health': { body: { version: '0.4' } }, '/': { body: 'hello', type: 'text/plain' } }))
    expect(bare?.web).toBe(false)
  })
  test('an ordinary site is nothing, and a NodeInfo pointing elsewhere is not followed', async () => {
    expect(await recognise('shop.example', web({}))).toBeNull()
    expect(await recognise('evil.example', web({ '/.well-known/nodeinfo': { body: pointer('internal.example') } }))).toBeNull()
  })
})

describe('asking the instances', () => {
  test('mastodon by hashtag, and a query with no word asks nothing', async () => {
    const asked: string[] = []
    const get = async (url: string) => {
      asked.push(url)
      return []
    }
    await searchInstance(get, site('toot.example', 'mastodon'), 'rust lang', 5)
    await searchInstance(get, site('toot.example', 'mastodon'), '!!!', 5)
    expect(asked).toEqual(['https://toot.example/api/v1/timelines/tag/rustlang?limit=5'])
  })
  test('a sample is capped, skips what has no search, and is different each time', () => {
    const all = Array.from({ length: 50 }, (_, i) => site(`s${i}.example`, 'tsbb'))
    expect(sampleInstances([...all, site('misskey.example', 'none')], 12).some((s) => s.adapter === 'none')).toBe(false)
    expect(sampleInstances(all, 12)).toHaveLength(12)
    expect(sampleInstances(all, 12).map((s) => s.site)).not.toEqual(sampleInstances(all, 12).map((s) => s.site))
  })
  test('takes one from each list in turn, no repeats', () => {
    const m = (url: string) => ({ url, title: url, host: 'x' })
    expect(interleave([[m('a1'), m('a2'), m('a3')], [m('b1')], [m('a1'), m('c2')]], 5).map((h) => h.url)).toEqual(['a1', 'b1', 'a2', 'c2', 'a3'])
  })
})

describe('the search', () => {
  const crawlerOver = (handler: (url: string) => Response) => {
    const frontier = new MemoryFrontier(1000)
    const noop = async () => {}
    const fake = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/robots.txt') || u.includes('tdmrep')) return new Response('', { status: 404 })
      return handler(u)
    }) as typeof fetch
    return { frontier, crawler: createCrawler({ config: configFromEnv({}), frontier, fetch: fake, resolver: async () => true, enqueue: { sites: noop, pages: noop, render: noop } }) }
  }
  const answers = (u: string) => (u.includes('bsky') ? Response.json(BSKY) : u.includes('algolia') ? Response.json(HN) : Response.json({ query: 'q', hits: [{ postId: 1, topicId: 2, title: 'On a board', createdAt: 1788753609436 }] }))

  test('the big indexes, every recognised site, and our own pages, one network down costing only itself', async () => {
    const { crawler, frontier } = crawlerOver((u) => (u.includes('dead.example') ? new Response('', { status: 500 }) : answers(u)))
    await frontier.saveSocial(site('bbs.example', 'tsbb'))
    await frontier.saveSocial(site('dead.example', 'tsbb'))
    const r = await crawler.searchSocial('rust', 20, [{ url: 'https://forum.example/t/1', title: 'A forum thread', site: 'forum.example', summary: 'words' }])
    expect(r.items.map((i) => i.host).sort()).toEqual(['Bluesky', 'Hacker News', 'bbs.example', 'forum.example'])
    expect(r.unavailable).toBe(false)
  })

  test('says so when nothing answered, rather than that nobody said anything', async () => {
    const { crawler } = crawlerOver(() => new Response('', { status: 503 }))
    expect((await crawler.searchSocial('rust', 20)).unavailable).toBe(true)
  })

  test('the crawl recognises a site at its start and a tsbb board by its descriptor', async () => {
    const { crawler, frontier } = crawlerOver((u) => {
      if (u.endsWith('/.well-known/openmcp.json')) return Response.json({ name: 'tsbb', mcp: 'https://bbs.example/api/mcp' })
      return new Response('', { status: 404 })
    })
    await crawler.crawlSite({ site: 'bbs.example', source: 'test' })
    expect(await frontier.listSocial()).toMatchObject([{ site: 'bbs.example', adapter: 'tsbb' }])
  })
})
