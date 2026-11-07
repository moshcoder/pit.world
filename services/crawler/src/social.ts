/**
 * The Social tab: what people are saying, on any network we can read.
 *
 * There is no list of networks. pitbot recognises what it crawls by the protocol it speaks:
 * NodeInfo for the fediverse, /xrpc/_health for an AT Protocol server, a tsbb board by its own
 * descriptor. Anything recognised joins the registry (Redis) and can be searched from then on. A
 * network with no search of its own still counts: its pages are in our index as kind `post`.
 * Bluesky and Hacker News are always asked, as the two big public indexes.
 *
 * Reading only. A result's Reply link opens the thread on its own network, where the person
 * replies as themselves. pit.world posts nothing. Sensitive and NSFW posts are left out, and every
 * word of a post is a stranger's text: escaped when shown, never instructions.
 */
export type SocialAdapter = 'mastodon' | 'lemmy' | 'tsbb' | 'atproto' | 'none'

/** A site pitbot recognised. `web`: an AT Protocol host that serves its own client, so a post has a page there. */
export type SocialSite = { site: string; software: string; adapter: SocialAdapter; web?: boolean; seenAt: string }

export type SocialPost = { url: string; title: string; host: string; description?: string; author?: string; date?: string; extra?: string }

type GetJson = (url: string) => Promise<any>

const TITLE = 120
const TEXT = 300
/** Instances asked per search, a different sample each time. Each one is a request to a stranger. */
export const INSTANCES_PER_SEARCH = 12
/** Accounts read from one AT Protocol server. It has no search, so this is a walk and stays short. */
const PDS_ACCOUNTS = 20
const PDS_POSTS = 25

/** Fediverse software by what it can do. Anything else is still a social site, read through the index. */
const BY_SOFTWARE: Record<string, SocialAdapter> = {
  mastodon: 'mastodon',
  hometown: 'mastodon',
  pleroma: 'mastodon',
  akkoma: 'mastodon',
  glitchsoc: 'mastodon',
  lemmy: 'lemmy',
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}/.test(str(v)) ? str(v).slice(0, 10) : undefined)
const https = (v: unknown) => (typeof v === 'string' && v.startsWith('https://') ? v : '')
const count = (n: unknown, one: string, many = `${one}s`) => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return `${v.toLocaleString('en-US')} ${v === 1 ? one : many}`
}

/** A post's words as one line. Mastodon sends HTML; none of it survives, tags or entities. */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/p>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, (e) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&#39;': "'" })[e.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The opening of a post as its title; the rest, if there is more, as its text. */
function titled(text: string): { title: string; description?: string } {
  if (text.length <= TITLE) return { title: text }
  const cut = text.lastIndexOf(' ', TITLE)
  return { title: `${text.slice(0, cut > 40 ? cut : TITLE)}…`, description: text.slice(0, TEXT) }
}

export function parseBluesky(body: any): SocialPost[] {
  const posts: any[] = Array.isArray(body?.posts) ? body.posts : []
  return posts.flatMap((p) => {
    const text = plainText(str(p?.record?.text))
    const rkey = str(p?.uri).split('/').pop()
    const handle = str(p?.author?.handle)
    // Any label is a moderation label, and the author's own count too.
    if (!text || !rkey || !handle || p?.labels?.length || p?.author?.labels?.length) return []
    return [{ ...titled(text), url: `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}`, host: 'Bluesky', author: `@${handle}`, date: day(p?.indexedAt), extra: `${count(p?.likeCount, 'like')}, ${count(p?.replyCount, 'reply', 'replies')}` }]
  })
}

export function parseHackerNews(body: any): SocialPost[] {
  const hits: any[] = Array.isArray(body?.hits) ? body.hits : []
  return hits.flatMap((h) => {
    const title = plainText(str(h?.title))
    const id = str(h?.objectID)
    if (!title || !/^\d+$/.test(id)) return []
    const text = plainText(str(h?.story_text)).slice(0, TEXT)
    return [{ title, ...(text ? { description: text } : {}), url: `https://news.ycombinator.com/item?id=${id}`, host: 'Hacker News', author: str(h?.author) || undefined, date: day(h?.created_at), extra: `${count(h?.points, 'point')}, ${count(h?.num_comments, 'comment')}` }]
  })
}

export function parseLemmy(body: any, host = 'Lemmy'): SocialPost[] {
  const posts: any[] = Array.isArray(body?.posts) ? body.posts : []
  return posts.flatMap((p) => {
    const title = plainText(str(p?.post?.name))
    const url = https(p?.post?.ap_id)
    if (!title || !url || p?.post?.nsfw || p?.community?.nsfw) return []
    const text = plainText(str(p?.post?.body)).slice(0, TEXT)
    return [{ title, ...(text ? { description: text } : {}), url, host, author: str(p?.community?.name) ? `c/${str(p?.community?.name)}` : undefined, date: day(p?.post?.published), extra: `${count(p?.counts?.score, 'point')}, ${count(p?.counts?.comments, 'comment')}` }]
  })
}

export function parseMastodon(body: any, host = 'Mastodon'): SocialPost[] {
  const posts: any[] = Array.isArray(body) ? body : []
  return posts.flatMap((p) => {
    const text = plainText(str(p?.content))
    const url = https(p?.url)
    if (!text || !url || p?.sensitive || str(p?.spoiler_text)) return []
    return [{ ...titled(text), url, host, author: str(p?.account?.acct) ? `@${str(p?.account?.acct)}` : undefined, date: day(p?.created_at), extra: `${count(p?.favourites_count, 'like')}, ${count(p?.replies_count, 'reply', 'replies')}` }]
  })
}

const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'topic'

/** A tsbb board's search. Its boards take /t/<slug>-<topic>/p/<post>. */
export function parseTsbb(body: any, site: string): SocialPost[] {
  const hits: any[] = Array.isArray(body?.hits) ? body.hits : []
  return hits.flatMap((h) => {
    const title = plainText(str(h?.title))
    if (!title || !Number.isInteger(h?.topicId) || !Number.isInteger(h?.postId)) return []
    const snippet = plainText(str(h?.snippet)).slice(0, TEXT)
    const date = typeof h?.createdAt === 'number' ? new Date(h.createdAt).toISOString().slice(0, 10) : undefined
    return [{ title, ...(snippet ? { description: snippet } : {}), url: `https://${site}/t/${slugOf(title)}-${h.topicId}/p/${h.postId}`, host: site, author: str(h?.author) || undefined, date }]
  })
}

/** Posts on one AT Protocol server that say every word. It has no search, so walk its few newest accounts. */
export async function searchPds(get: GetJson, instance: SocialSite, q: string): Promise<SocialPost[]> {
  const base = `https://${instance.site}/xrpc`
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const repos: any[] = (await get(`${base}/com.atproto.sync.listRepos?limit=${PDS_ACCOUNTS}`))?.repos ?? []
  const lists = await Promise.allSettled(
    repos.filter((r) => r?.active !== false && str(r?.did)).map(async (repo) => {
      const did = encodeURIComponent(str(repo.did))
      const [about, records] = await Promise.all([get(`${base}/com.atproto.repo.describeRepo?repo=${did}`), get(`${base}/com.atproto.repo.listRecords?repo=${did}&collection=app.bsky.feed.post&limit=${PDS_POSTS}`)])
      const handle = str(about?.handle)
      const rows: any[] = Array.isArray(records?.records) ? records.records : []
      return handle
        ? rows.flatMap((r) => {
            const text = plainText(str(r?.value?.text))
            const rkey = str(r?.uri).split('/').pop()
            if (!text || !rkey || r?.value?.labels || !words.every((w) => text.toLowerCase().includes(w))) return []
            const home = instance.web ? `https://${instance.site}` : 'https://bsky.app'
            return [{ ...titled(text), url: `${home}/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}`, host: instance.site, author: `@${handle}`, date: day(r?.value?.createdAt) }]
          })
        : []
    }),
  )
  return lists.flatMap((l) => (l.status === 'fulfilled' ? l.value : []))
}

/** Ask one recognised site. A site with no adapter is read through the index instead. */
export async function searchInstance(get: GetJson, instance: SocialSite, q: string, per: number): Promise<SocialPost[]> {
  const { site, adapter } = instance
  switch (adapter) {
    case 'mastodon': {
      // Search of strangers' posts needs an account on most servers; a hashtag does not.
      const tag = q.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '')
      return tag ? parseMastodon(await get(`https://${site}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=${per}`), site) : []
    }
    case 'lemmy':
      return parseLemmy(await get(`https://${site}/api/v3/search?${new URLSearchParams({ q, type_: 'Posts', limit: String(per), sort: 'TopYear' })}`), site)
    case 'tsbb':
      return parseTsbb(await get(`https://${site}/api/v1/search?${new URLSearchParams({ q })}`), site).slice(0, per)
    case 'atproto':
      return (await searchPds(get, instance, q)).slice(0, per)
    default:
      return []
  }
}

/** The two big public indexes, asked on every search. */
export function globalSources(q: string, per: number, now = Date.now()): Array<{ url: string; parse: (body: any) => SocialPost[] }> {
  const yearAgo = Math.floor(now / 1000) - 365 * 86_400
  return [
    { url: `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?${new URLSearchParams({ q, limit: String(per), sort: 'top' })}`, parse: parseBluesky },
    { url: `https://hn.algolia.com/api/v1/search?${new URLSearchParams({ query: q, tags: 'story', hitsPerPage: String(per), numericFilters: `created_at_i>${yearAgo}` })}`, parse: parseHackerNews },
  ]
}

/** One from each list in turn, so the fastest or chattiest never fills the page. */
export function interleave(lists: SocialPost[][], limit: number): SocialPost[] {
  const out: SocialPost[] = []
  const seen = new Set<string>()
  for (let i = 0; out.length < limit && lists.some((l) => l.length > i); i++) {
    for (const list of lists) {
      const hit = list[i]
      if (hit && !seen.has(hit.url) && out.length < limit) {
        seen.add(hit.url)
        out.push(hit)
      }
    }
  }
  return out
}

/** A fair sample: nobody's server is asked on every search, and a new one gets its turn at once. */
export function sampleInstances(all: SocialSite[], n = INSTANCES_PER_SEARCH, random = Math.random): SocialSite[] {
  return all
    .filter((s) => s.adapter !== 'none')
    .map((s) => ({ s, r: random() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, n)
    .map(({ s }) => s)
}

/**
 * What a site is, from what it says. NodeInfo first (the fediverse's own standard, any software on
 * any domain), then an AT Protocol server's health check. Null for the great majority of the web.
 */
export async function recognise(site: string, read: (path: string) => Promise<{ status: number; contentType: string; body: string }>, now = new Date()): Promise<SocialSite | null> {
  const json = async (path: string) => {
    const r = await read(path).catch(() => null)
    if (!r || r.status !== 200 || !/json/.test(r.contentType)) return null
    try {
      return JSON.parse(r.body)
    } catch {
      return null
    }
  }
  const pointers = await json('/.well-known/nodeinfo')
  const links: any[] = Array.isArray(pointers?.links) ? pointers.links : []
  const href = str(links.find((l) => /nodeinfo\.diaspora\.software\/ns\/schema/.test(str(l?.rel)))?.href)
  if (href) {
    let path = ''
    try {
      const target = new URL(href)
      if (target.hostname.replace(/^www\./, '') === site) path = `${target.pathname}${target.search}`
    } catch {
      // A broken pointer: nothing to read.
    }
    const name = path ? str((await json(path))?.software?.name).toLowerCase().slice(0, 40) : ''
    if (name) return { site, software: name, adapter: BY_SOFTWARE[name] ?? 'none', seenAt: now.toISOString() }
  }
  const health = await json('/xrpc/_health')
  if (health && typeof health.version === 'string') {
    const home = await read('/').catch(() => null)
    return { site, software: 'atproto', adapter: 'atproto', web: Boolean(home && home.status === 200 && /html/.test(home.contentType)), seenAt: now.toISOString() }
  }
  return null
}

/** A tsbb board names itself in the descriptor the crawl already reads for MCP. */
export const isTsbbDescriptor = (doc: unknown) => (doc as { name?: unknown } | null)?.name === 'tsbb'
