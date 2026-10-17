/**
 * Bangs: `!gh hqtui` goes straight to GitHub's search. The redirect is a 302
 * from pit.world with `Referrer-Policy: no-referrer`, so the destination sees
 * the words you sent it and nothing about where you came from.
 */

export type Bang = { name: string; url: string; aliases?: string[] }

const q = '{q}'

export const BANGS: Bang[] = [
  { name: 'Google', url: `https://www.google.com/search?q=${q}`, aliases: ['g'] },
  { name: 'DuckDuckGo', url: `https://duckduckgo.com/?q=${q}`, aliases: ['ddg', 'd'] },
  { name: 'Brave Search', url: `https://search.brave.com/search?q=${q}`, aliases: ['brave', 'b'] },
  { name: 'Wikipedia', url: `https://en.wikipedia.org/w/index.php?search=${q}`, aliases: ['w', 'wiki'] },
  { name: 'GitHub', url: `https://github.com/search?q=${q}`, aliases: ['gh'] },
  { name: 'npm', url: `https://www.npmjs.com/search?q=${q}`, aliases: ['npm'] },
  { name: 'MDN', url: `https://developer.mozilla.org/en-US/search?q=${q}`, aliases: ['mdn'] },
  { name: 'Stack Overflow', url: `https://stackoverflow.com/search?q=${q}`, aliases: ['so'] },
  { name: 'Hacker News', url: `https://hn.algolia.com/?q=${q}`, aliases: ['hn'] },
  { name: 'YouTube', url: `https://www.youtube.com/results?search_query=${q}`, aliases: ['yt'] },
  { name: 'Reddit', url: `https://www.reddit.com/search/?q=${q}`, aliases: ['r', 'reddit'] },
  { name: 'X', url: `https://x.com/search?q=${q}`, aliases: ['x', 'tw'] },
  { name: 'OpenStreetMap', url: `https://www.openstreetmap.org/search?query=${q}`, aliases: ['maps', 'osm', 'm'] },
  { name: 'Wayback Machine', url: `https://web.archive.org/web/*/${q}`, aliases: ['wb', 'archive'] },
  { name: 'Moshpit name', url: `https://pit.moshcode.sh/n/${q}`, aliases: ['pit', 'mosh'] },
  { name: 'moshcode', url: `https://github.com/moshcoder/moshcode/search?q=${q}`, aliases: ['mc'] },
]

const byAlias = new Map<string, Bang>()
for (const bang of BANGS) for (const alias of bang.aliases ?? []) byAlias.set(alias, bang)

/**
 * `!gh foo`, `foo !gh` or a bare `!gh` (which opens the site's search with no
 * words). Returns null when there is no known bang, so `!important` stays a search.
 */
export function parseBang(query: string): { bang: Bang; terms: string; url: string } | null {
  const tokens = query.trim().split(/\s+/)
  const index = tokens.findIndex((token) => /^![a-z0-9]+$/i.test(token) && byAlias.has(token.slice(1).toLowerCase()))
  if (index === -1) return null
  const bang = byAlias.get(tokens[index]!.slice(1).toLowerCase())!
  const terms = tokens.filter((_, i) => i !== index).join(' ')
  // The Moshpit name page takes a name in the path, not a query string.
  const encoded = bang.aliases?.includes('pit') ? encodeURIComponent(terms).replace(/%2E/gi, '.') : encodeURIComponent(terms)
  return { bang, terms, url: bang.url.replace(q, encoded) }
}
