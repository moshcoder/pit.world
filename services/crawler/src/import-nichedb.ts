/**
 * Refilling the local mirror from nichedb, without crawling again.
 *
 * nichedb.dev/c/sites is the archive: the records the crawler published are there,
 * keyed by canonical address. The mirror in front of it is a cache, and on 2026-11-05
 * it had to be rebuilt from empty (207 GB, nothing to shrink it with in place).
 * Re-reading ten million pages at a few tens of thousands an hour would take weeks;
 * reading them back out of nichedb takes hours and asks nothing of the publishers.
 *
 * What comes back is not quite what was there. A published record carries the
 * 1,000-character excerpt, not the full page text -- the crawler strips the text
 * before publishing -- so an imported page is searchable on its title, description,
 * keywords and excerpt, and a recrawl later replaces it with the whole thing. And a
 * record carries no training verdict, so imported pages count as unknown and stay out
 * of /api/corpus until the policy backfill judges their site: an opt-out is respected
 * by staying closed, which is the right way round to be wrong.
 */
import type { IndexedRecord, IndexStore } from './index-store.ts'

type Fetch = typeof fetch

/** One item as nichedb's /api/v1/items hands it over. */
type NichedbItem = {
  id: number
  url?: string
  title?: string
  summary?: string
  data?: { record?: Record<string, unknown>; enrichment?: Record<string, unknown> }
}

export type ImportProgress = {
  /** Records read from nichedb. */
  read: number
  /** Records written to the index (an upsert of a page already there counts here too). */
  kept: number
  /** Records that carried no canonical address to key them by. */
  skipped: number
  /** The id to carry on before, or null once the collection ends. */
  cursor: number | null
  bytes: number
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** A published record as the mirror wants it. Null when it cannot be keyed. */
export function recordOf(item: NichedbItem): IndexedRecord | null {
  const r = (item.data?.record ?? {}) as Record<string, unknown>
  const e = (item.data?.enrichment ?? {}) as Record<string, unknown>
  const canonical = str(r.canonical) ?? str(r.url) ?? str(item.url)
  if (!canonical) return null
  const site = (r.site ?? {}) as Record<string, unknown>
  const keywords = Array.isArray(e.keywords) ? e.keywords.filter((k): k is string => typeof k === 'string') : []
  const name = str(site.name)
  return {
    record: {
      url: str(r.url) ?? canonical,
      canonical,
      title: str(r.title) ?? str(item.title) ?? '',
      description: str(r.description) ?? str(item.summary) ?? null,
      kind: str(r.kind) ?? 'page',
      language: str(r.language) ?? str(e.language) ?? null,
      // Keep the page's own read time: trim() evicts by it, so an imported page has to
      // age as the page it is, not as of the moment it was imported.
      fetched_at: str(r.fetched_at) ?? new Date().toISOString(),
      ...(name ? { site: { name } } : {}),
    },
    enrichment: {
      keywords,
      // There is no full text on a published record, so the excerpt becomes the body.
      ...(str(e.excerpt) ? { excerpt: str(e.excerpt)! } : {}),
      language: str(e.language) ?? str(r.language) ?? null,
    },
  }
}

/**
 * Walks /c/sites newest first and writes each page into the mirror, stopping at
 * `maxBytes`, at `limit` records, or at the end of the collection. The cursor it
 * returns (and keeps in the index) lets a later run carry on rather than restart.
 */
export async function importFromNichedb(
  index: IndexStore,
  options: {
    nichedbUrl: string
    key?: string
    fetch?: Fetch
    /** Records per request; nichedb's own page size caps this at 200. */
    pageSize?: number
    /** Stop once the index reaches this many bytes. Defaults to the index's own budget. */
    maxBytes?: number
    /** Stop after this many records. */
    limit?: number
    /** Start before this id instead of at the newest, or at the kept cursor. */
    cursor?: number
    /** Gap between requests, so a backfill never looks like an attack on our own API. */
    pauseMs?: number
    onProgress?: (progress: ImportProgress) => void
  },
): Promise<ImportProgress> {
  const fetchImpl = options.fetch ?? fetch
  const pageSize = Math.min(Math.max(1, Math.trunc(options.pageSize ?? 200)), 200)
  const limit = options.limit && options.limit > 0 ? Math.trunc(options.limit) : Infinity
  const ceiling = options.maxBytes ?? index.maxBytes ?? 0
  const pause = Math.max(0, Math.trunc(options.pauseMs ?? 50))
  const base = options.nichedbUrl.replace(/\/+$/, '')
  let cursor = options.cursor ?? Number(index.importCursor() ?? 0)
  const progress: ImportProgress = { read: 0, kept: 0, skipped: 0, cursor: cursor || null, bytes: index.sizeBytes() }

  while (progress.read < limit) {
    const url = `${base}/api/v1/items?collection=sites&limit=${pageSize}${cursor ? `&before=${cursor}` : ''}`
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
      signal: AbortSignal.timeout(60_000),
    })
    // Stopping part way through is fine: the cursor is kept, so the next run carries on
    // from here instead of reading the whole collection again.
    if (!response.ok)
      throw new Error(
        `nichedb answered HTTP ${response.status} at cursor ${cursor}${response.status === 402 && !options.key ? ' (metered: NICHEDB_API_KEY is not set)' : ''}`,
      )
    const body = (await response.json()) as { items?: NichedbItem[] }
    const items = body.items ?? []
    if (!items.length) {
      progress.cursor = null
      index.setImportCursor(null)
      break
    }
    const batch: IndexedRecord[] = []
    for (const item of items) {
      progress.read++
      const record = recordOf(item)
      if (record) batch.push(record)
      else progress.skipped++
    }
    if (batch.length) progress.kept += index.add(batch)
    cursor = items[items.length - 1]!.id
    progress.cursor = cursor
    index.setImportCursor(cursor)
    progress.bytes = index.sizeBytes()
    options.onProgress?.({ ...progress })
    if (ceiling && progress.bytes >= ceiling) break
    if (items.length < pageSize) {
      progress.cursor = null
      index.setImportCursor(null)
      break
    }
    if (pause) await new Promise<void>((resolve) => setTimeout(resolve, pause))
  }
  return progress
}
