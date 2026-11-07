/**
 * The crawler's local search mirror: every record it publishes, in SQLite FTS5.
 *
 * nichedb.dev/c/sites is where the index is published and kept, open to anyone.
 * But a full-text match there runs against the GIN index of nichedb's whole
 * items table (millions of rows across every collection), about a second for
 * a common word and several for three words, and pit.world gives a slow engine
 * 2.5 s. So the crawler also keeps what it publishes here and answers the same
 * `/api/v1/search` shape on loopback in milliseconds; pit.world reads this.
 *
 * Written by the publish role (one writer), read by the health server. A
 * record is keyed by canonical address, so a re-crawl replaces it.
 *
 * It is a cache, not the archive: nichedb keeps every record for good, this
 * file only has to answer fast. So it lives inside a byte budget
 * (CRAWL_INDEX_MAX_BYTES) and drops its oldest pages to stay there. Without
 * that it grew to 207 GB in 2.7 days and filled dev2's root filesystem, which
 * truncated the append-only file of every other Redis on the box (2026-11-04).
 * Two things make the budget keepable: `auto_vacuum = INCREMENTAL`, so freed
 * pages go back to the filesystem rather than to a freelist this disk cannot
 * afford, and not keeping media here at all -- images and videos are published
 * on the nichedb record, and nothing ever read them back from this file.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type IndexedRecord = {
  record: { url: string; canonical: string; title: string; description: string | null; kind: string; language: string | null; fetched_at: string; site?: { name?: string } }
  enrichment: {
    keywords?: string[]
    excerpt?: string
    text?: string
    language?: string | null
    /** Set by the crawler from the publisher's opt-outs (crawler.ts trainingFor). */
    training?: { allowed: boolean; reason: string }
    images?: Array<{ url: string; alt?: string; width?: number | null; height?: number | null }>
    videos?: Array<{ url: string; title?: string; thumbnail?: string | null; provider?: string | null }>
  }
}

/** How many of a word's newest matches a search for one kind of page looks through. */
const KIND_SCAN = 8_000

export type IndexHit = { url: string; title: string; summary: string; site: string; kind: string; fetched_at: string; score: number }

/**
 * User words as an FTS5 query that cannot fail: each token quoted as a literal.
 * Raw input is a query language (a hyphen is a column filter, a dot a syntax
 * error), and a search box must never 500 on what someone typed.
 */
export function toFtsTerms(input: string): string[] {
  return String(input)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.+#]+/u)
    .map((t) => t.replace(/^[.+#]+|[.]+$/g, ''))
    .filter(Boolean)
    .slice(0, 32)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
}

/**
 * `q` for /api/corpus as an FTS5 query that cannot fail. Commas separate alternatives:
 * `saas,business,crypto` is any of the three; the words inside one part must all appear
 * (`open source,self hosted` = (open AND source) OR (self AND hosted)). Null when nothing is left.
 */
export function corpusMatch(input: string): string | null {
  const parts = String(input ?? '')
    .split(',')
    .map((part) => toFtsTerms(part))
    .filter((terms) => terms.length)
    .slice(0, 16)
  if (!parts.length) return null
  return parts.map((terms) => (terms.length === 1 ? terms[0] : `(${terms.join(' AND ')})`)).join(' OR ')
}

export type CorpusQuery = {
  q?: string
  site?: string
  kind?: string
  lang?: string
  /** ISO date or time: pages fetched at or after it. */
  since?: string
  limit?: number
  /** The last id a previous page returned (or scanned past): pages after it. */
  cursor?: number
  /** Characters of text per item. */
  textMax?: number
  /** Stop scanning after this long and hand back a cursor (a rare match must not block the process). */
  budgetMs?: number
}

export type CorpusItem = { id: number; url: string; title: string; site: string; kind: string; language: string | null; fetched_at: string; text: string }

export type CorpusPage = {
  items: CorpusItem[]
  /** Pass back as `cursor` for the next page; null once the end of the index is reached. */
  next_cursor: string | null
  /** Where to resume later for pages added since (the end of what was scanned). */
  resume_cursor: string
  /** Matching pages in the whole index, before opt-outs and filters (capped at total_cap), or null when not counted. */
  total_matches: number | null
  total_capped: boolean
}

export type PolicyRow = { id: number; url: string }

const TOTAL_CAP = 10_000

export class IndexStore {
  private db: Database
  private statsCache: { at: number; value: Record<string, unknown> } | null = null
  /** Bytes the file may use before trim() drops its oldest pages. 0: no budget. */
  readonly maxBytes: number
  /** Whether freed pages can go back to the filesystem (auto_vacuum = INCREMENTAL). */
  readonly reclaims: boolean
  private sizeCache: { at: number; value: number } | null = null
  /** When the publisher last added a batch (this process). */
  lastAddAt: string | null = null

  constructor(path: string, maxBytes = 0) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.maxBytes = maxBytes > 0 ? maxBytes : 0
    this.db = new Database(path, { create: true })
    // auto_vacuum only takes on an empty database, so an index made before the byte
    // budget existed keeps auto_vacuum = NONE: deletes still bound the rows, but the
    // file keeps its high-water mark, and trim() says so once rather than every sweep.
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL;')
    // 30 s, not 5. WAL lets readers run while one writer works, but writers serialise, and
    // this file has had two of them since the nichedb backfill existed: a publish batch or a
    // trim sweep can hold the write lock longer than five seconds, and the backfill died of
    // exactly that ("database is locked", 1.8M pages in, 2026-11-05).
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 30000;')
    this.reclaims = (this.db.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number } | null)?.auto_vacuum === 2
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        site TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        keywords TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        language TEXT,
        fetched_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
        title, description, keywords, body, site,
        content='pages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
        INSERT INTO pages_fts(rowid, title, description, keywords, body, site) VALUES (new.id, new.title, new.description, new.keywords, new.body, new.site);
      END;
      CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
        INSERT INTO pages_fts(pages_fts, rowid, title, description, keywords, body, site) VALUES ('delete', old.id, old.title, old.description, old.keywords, old.body, old.site);
      END;
      -- The training corpus's view of each page: whether its publisher left AI training open
      -- (train 1), reserved it (0) or it is not known yet (NULL, pages indexed before this was
      -- recorded, until the backfill or a re-crawl decides). Its own small table: an UPDATE
      -- on pages re-indexes the page's full text through pages_au.
      CREATE TABLE IF NOT EXISTS page_policy (
        id INTEGER PRIMARY KEY,
        site TEXT NOT NULL,
        kind TEXT NOT NULL,
        language TEXT,
        fetched_at TEXT NOT NULL,
        train INTEGER,
        reason TEXT,
        source TEXT NOT NULL DEFAULT 'crawl'
      );
      CREATE INDEX IF NOT EXISTS page_policy_train ON page_policy (train, id);
      CREATE INDEX IF NOT EXISTS page_policy_site ON page_policy (site, id);
      CREATE INDEX IF NOT EXISTS page_policy_train_site ON page_policy (train, site);
      -- trim() takes the oldest pages first, and "oldest" is when the page was read,
      -- not what id it happens to hold: a bulk import from nichedb arrives newest-first,
      -- so id order and crawl order are not the same thing.
      CREATE INDEX IF NOT EXISTS pages_fetched_at ON pages (fetched_at);
      CREATE TABLE IF NOT EXISTS policy_site_checks (site TEXT PRIMARY KEY, checked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS corpus_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
        INSERT INTO pages_fts(pages_fts, rowid, title, description, keywords, body, site) VALUES ('delete', old.id, old.title, old.description, old.keywords, old.body, old.site);
        INSERT INTO pages_fts(rowid, title, description, keywords, body, site) VALUES (new.id, new.title, new.description, new.keywords, new.body, new.site);
      END;
    `)
    // Media used to be kept here too: 135M rows, a UNIQUE index over (page_url, url) and an
    // FTS5 table that stored a second copy of every alt text, about 75 GB of the 207 GB, and
    // no reader -- pit.world's Images and Videos tabs come from the media search providers,
    // never from this file. The references still travel on the nichedb record.
    this.db.exec('DROP TABLE IF EXISTS media_fts; DROP TABLE IF EXISTS media;')
    // How many pages are actually here. max(id) stopped being that answer when trim()
    // began deleting from the low end, and count(*) over millions of rows blocks the
    // event loop for seconds (2026-11-02), so it is kept as it changes.
    if (!this.meta('pages_live')) {
      const hwm = this.maxId()
      this.setMeta('pages_live', String(hwm))
      this.setMeta('pages_hwm', String(hwm))
    }
  }

  /**
   * Runs a write, waiting out the other writer if it has to.
   *
   * `busy_timeout` covers a lock held when the statement starts; it does not cover
   * SQLITE_BUSY raised mid-transaction, which is what a second writer actually sees.
   * The index-store header says one writer for a reason -- the publish role -- and the
   * nichedb backfill made that two. Rather than pretend otherwise, a busy write waits
   * and tries again, because losing the batch means losing the work that produced it.
   */
  private write<T>(run: () => T, attempts = 6): T {
    let waitMs = 250
    for (let attempt = 1; ; attempt++) {
      try {
        return run()
      } catch (error) {
        const message = String((error as Error)?.message ?? error)
        if (attempt >= attempts || !/database is locked|SQLITE_BUSY|database table is locked/i.test(message)) throw error
        // Synchronous on purpose: this is bun:sqlite, and the caller is inside a batch it
        // has to finish. Backs off 0.25s, 0.5s, 1s, 2s, 4s -- about eight seconds in all.
        Bun.sleepSync(waitMs)
        waitMs *= 2
      }
    }
  }

  private meta(key: string): string | null {
    return (this.db.query('SELECT value FROM corpus_meta WHERE key = ?').get(key) as { value: string } | null)?.value ?? null
  }

  private setMeta(key: string, value: string): void {
    this.db.run('INSERT INTO corpus_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
  }

  private maxId(): number {
    return (this.db.query('SELECT coalesce(max(id), 0) AS n FROM pages').get() as { n: number }).n
  }

  /** Keep a batch (one transaction). Entries are the outbox's JSON lines or objects. */
  add(entries: Array<IndexedRecord | string>): number {
    const upsert = this.db.prepare(`
      INSERT INTO pages (url, site, kind, title, description, keywords, body, language, fetched_at)
      VALUES ($url, $site, $kind, $title, $description, $keywords, $body, $language, $fetched)
      ON CONFLICT(url) DO UPDATE SET site = excluded.site, kind = excluded.kind, title = excluded.title,
        description = excluded.description, keywords = excluded.keywords, body = excluded.body,
        language = excluded.language, fetched_at = excluded.fetched_at
      RETURNING id
    `)
    // A record without a verdict (queued by an older crawler) keeps whatever was decided before.
    const policy = this.db.prepare(`
      INSERT INTO page_policy (id, site, kind, language, fetched_at, train, reason, source)
      VALUES ($id, $site, $kind, $language, $fetched, $train, $reason, $source)
      ON CONFLICT(id) DO UPDATE SET site = excluded.site, kind = excluded.kind, language = excluded.language,
        fetched_at = excluded.fetched_at,
        train = CASE WHEN excluded.source = 'crawl' THEN excluded.train ELSE page_policy.train END,
        reason = CASE WHEN excluded.source = 'crawl' THEN excluded.reason ELSE page_policy.reason END,
        source = CASE WHEN excluded.source = 'crawl' THEN 'crawl' ELSE page_policy.source END
    `)
    let kept = 0
    let hwm = Number(this.meta('pages_hwm') ?? 0)
    let live = Number(this.meta('pages_live') ?? 0)
    this.write(() =>
      this.db.transaction(() => {
      for (const raw of entries) {
        let entry: IndexedRecord
        try {
          entry = typeof raw === 'string' ? (JSON.parse(raw) as IndexedRecord) : raw
        } catch {
          continue
        }
        const r = entry?.record
        if (!r?.canonical) continue
        let site = ''
        try {
          site = new URL(r.canonical).hostname.replace(/^www\./, '')
        } catch {
          continue
        }
        const language = entry.enrichment?.language ?? r.language ?? null
        const fetched = r.fetched_at ?? new Date().toISOString()
        const row = upsert.get({
          $url: r.canonical,
          $site: site,
          $kind: r.kind ?? 'page',
          $title: r.title ?? site,
          $description: r.description ?? '',
          $keywords: (entry.enrichment?.keywords ?? []).join(' '),
          $body: entry.enrichment?.text || entry.enrichment?.excerpt || '',
          $language: language,
          $fetched: fetched,
        }) as { id: number } | null
        const training = entry.enrichment?.training
        if (row)
          policy.run({
            $id: row.id,
            $site: site,
            $kind: r.kind ?? 'page',
            $language: language,
            $fetched: fetched,
            $train: training ? (training.allowed ? 1 : 0) : null,
            $reason: training ? String(training.reason ?? '').slice(0, 120) : null,
            $source: training ? 'crawl' : 'legacy',
          })
        // A new row always takes an id above every id ever used, so this tells an
        // insert from an upsert without asking the database to count anything.
        if (row && row.id > hwm) {
          hwm = row.id
          live++
        }
        kept++
      }
      if (kept) {
        this.setMeta('pages_hwm', String(hwm))
        this.setMeta('pages_live', String(live))
      }
      })(),
    )
    if (kept) this.lastAddAt = new Date().toISOString()
    return kept
  }

  // ---- the byte budget ---------------------------------------------------------------

  /**
   * What the file takes on disk, from two pragmas and no scan -- but cached for a few
   * seconds, because /stats asks on every request and /status gives the crawler a 3 s
   * leash. Two processes write this file (the publish role, and a nichedb backfill), and
   * a read waiting on `busy_timeout` behind one of them was enough to make /status
   * flash "Offline" on a crawler that was perfectly healthy (2026-11-05).
   */
  sizeBytes(maxAgeMs = 5_000): number {
    const now = Date.now()
    if (this.sizeCache && now - this.sizeCache.at < maxAgeMs) return this.sizeCache.value
    const pages = (this.db.query('PRAGMA page_count').get() as { page_count: number }).page_count
    const size = (this.db.query('PRAGMA page_size').get() as { page_size: number }).page_size
    const value = pages * size
    this.sizeCache = { at: now, value }
    return value
  }

  /**
   * Brings the file back inside its budget by dropping its oldest pages, in small
   * batches so one sweep never holds the event loop (BullMQ renews its locks on the
   * same loop, and a stalled renewal is what read as "Offline" before).
   *
   * Oldest first by `fetched_at`, which is when the page was actually read. It used
   * to go by id, on the assumption that ids ascend with crawl time -- true for a
   * crawl, false the moment a bulk import from nichedb inserts newest-first, which
   * would have made the newest records the first to be evicted.
   */
  async trim(options: { batch?: number; maxBatches?: number; keepMin?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ deleted: number; bytesBefore: number; bytesAfter: number; done: boolean; reclaims: boolean }> {
    const batch = Math.max(1, Math.trunc(options.batch ?? 2_000))
    const maxBatches = Math.max(1, Math.trunc(options.maxBatches ?? 50))
    // A budget too small for the index's own overhead must leave a working mirror
    // rather than empty it: a wrong number in the environment is not a reason to
    // throw away the index.
    const keepMin = Math.max(0, Math.trunc(options.keepMin ?? 1_000))
    const idle = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    // Fresh figures here: a sweep that trusted a cached size would loop against a number
    // its own deletes had already changed.
    const bytesBefore = this.sizeBytes(0)
    if (!this.maxBytes || bytesBefore <= this.maxBytes) return { deleted: 0, bytesBefore, bytesAfter: bytesBefore, done: true, reclaims: this.reclaims }
    const pick = this.db.prepare('SELECT id FROM pages ORDER BY fetched_at, id LIMIT ?')
    let deleted = 0
    let rounds = 0
    while (rounds++ < maxBatches && this.sizeBytes(0) > this.maxBytes) {
      const room = this.count() - keepMin
      if (room < 1) break
      const rows = pick.all(Math.min(batch, room)) as Array<{ id: number }>
      if (rows.length < 1) break
      // The ids are scattered now that they are picked by date, so they go as a list.
      const ids = rows.map((r) => r.id).join(',')
      this.write(() =>
        this.db.transaction(() => {
        // threatcrush-disable-next-line sql-template-interpolation  ids come from this table's own INTEGER PRIMARY KEY, never from a request
        this.db.run(`DELETE FROM page_policy WHERE id IN (${ids})`)
        // threatcrush-disable-next-line sql-template-interpolation  same ids, read out of the index a line above
        this.db.run(`DELETE FROM pages WHERE id IN (${ids})`)
        this.setMeta('pages_live', String(Math.max(0, Number(this.meta('pages_live') ?? 0) - rows.length)))
        })(),
      )
      deleted += rows.length
      // Hand the freed pages back to the filesystem. Without INCREMENTAL they only
      // reach the freelist, so the file never shrinks and the loop would not end:
      // the row deletes still bound the index, so stop and let the log say why.
      if (this.reclaims) this.db.exec('PRAGMA incremental_vacuum(4000);')
      else break
      if (rows.length < Math.min(batch, room)) break
      await idle(0)
    }
    this.statsCache = null
    const bytesAfter = this.sizeBytes(0)
    return { deleted, bytesBefore, bytesAfter, done: bytesAfter <= this.maxBytes, reclaims: this.reclaims }
  }

  // ---- the training corpus (/api/corpus) ---------------------------------------------------

  /**
   * One page of the corpus, in id order (stable: a page keeps its id when re-crawled, new pages
   * get higher ones), only pages whose publisher left AI training open. Scans the id space in
   * windows until `limit` items are found, the index ends, or the time budget is spent; then
   * the cursor says where to carry on, so a rare match never holds the process.
   */
  corpus(query: CorpusQuery): CorpusPage {
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 20)), 100)
    const textMax = Math.min(Math.max(0, Math.trunc(query.textMax ?? 24_000)), 100_000)
    const budget = query.budgetMs ?? 800
    const start = Math.max(0, Math.trunc(query.cursor ?? 0))
    const match = query.q ? corpusMatch(query.q) : null
    const maxId = this.highWaterMark()
    const filters: string[] = []
    const params: Array<string | number> = []
    if (query.site) {
      filters.push('pp.site = ?')
      params.push(query.site.toLowerCase().replace(/^www\./, ''))
    }
    if (query.kind) {
      filters.push('pp.kind = ?')
      params.push(query.kind)
    }
    if (query.lang) {
      // "en" matches en, en-us, en-gb.
      filters.push('(pp.language = ? OR pp.language LIKE ?)')
      params.push(query.lang.toLowerCase(), `${query.lang.toLowerCase()}-%`)
    }
    if (query.since) {
      filters.push('pp.fetched_at >= ?')
      params.push(query.since)
    }
    const where = filters.length ? ` AND ${filters.join(' AND ')}` : ''
    const ids: number[] = []
    let scannedTo = start
    const began = performance.now()
    if (query.q && !match) return { items: [], next_cursor: null, resume_cursor: String(start), total_matches: 0, total_capped: false }
    if (!match && query.site) {
      // One site: its own index, no windows needed.
      const rows = this.db
        // threatcrush-disable-next-line sql-template-interpolation  only fixed column filters and "?" placeholders are interpolated; every value is bound
        .query(`SELECT pp.id FROM page_policy pp WHERE pp.train = 1 AND pp.id > ?${where} ORDER BY pp.site, pp.id LIMIT ?`)
        .all(start, ...params, limit) as Array<{ id: number }>
      for (const r of rows) ids.push(r.id)
      scannedTo = rows.length === limit ? rows[rows.length - 1]!.id : maxId
    } else {
      const ftsSql =
        // threatcrush-disable-next-line sql-template-interpolation  only fixed column filters and "?" placeholders are interpolated; every value is bound
        `SELECT f.rowid AS id FROM pages_fts f CROSS JOIN page_policy pp ON pp.id = f.rowid WHERE pages_fts MATCH ? AND f.rowid > ? AND f.rowid <= ? AND pp.train = 1${where} ORDER BY f.rowid LIMIT ?`
      const allSql =
        // threatcrush-disable-next-line sql-template-interpolation  only fixed column filters and "?" placeholders are interpolated; every value is bound
        `SELECT pp.id FROM page_policy pp WHERE pp.train = 1 AND pp.id > ? AND pp.id <= ?${where} ORDER BY pp.id LIMIT ?`
      const sql = match ? ftsSql : allSql
      const stmt = this.db.query(sql)
      let window = 50_000
      let lo = start
      while (lo < maxId && ids.length < limit) {
        const hi = Math.min(maxId, lo + window)
        const need = limit - ids.length
        const rows = (match ? stmt.all(match, lo, hi, ...params, need) : stmt.all(lo, hi, ...params, need)) as Array<{ id: number }>
        for (const r of rows) ids.push(r.id)
        scannedTo = rows.length === need ? rows[rows.length - 1]!.id : hi
        lo = scannedTo
        if (performance.now() - began > budget) break
        // Few hits so far: look further at once.
        if (rows.length < need) window = Math.min(window * 4, 2_000_000)
      }
    }
    const items: CorpusItem[] = []
    if (ids.length) {
      const rows = this.db
        // threatcrush-disable-next-line sql-template-interpolation  only "?" placeholders are interpolated; every id is bound
        .query(`SELECT id, url, title, site, kind, language, fetched_at, substr(body, 1, ?) AS text FROM pages WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
        .all(textMax, ...ids) as CorpusItem[]
      items.push(...rows)
    }
    let total: number | null = null
    let capped = false
    if (match && start === 0) {
      total = (this.db.query('SELECT count(*) AS n FROM (SELECT rowid FROM pages_fts WHERE pages_fts MATCH ? LIMIT ?)').get(match, TOTAL_CAP) as { n: number }).n
      capped = total >= TOTAL_CAP
    }
    const done = scannedTo >= maxId && ids.length < limit
    return { items, next_cursor: done ? null : String(scannedTo), resume_cursor: String(scannedTo), total_matches: total, total_capped: capped }
  }

  /** Corpus counts for harvesters: cached for five minutes (each is an index scan). */
  corpusStats(now = Date.now()): Record<string, unknown> {
    if (this.statsCache && now - this.statsCache.at < 300_000) return this.statsCache.value
    const byTrain = this.db.query('SELECT train, count(*) AS n FROM page_policy GROUP BY train').all() as Array<{ train: number | null; n: number }>
    const n = (t: number | null) => byTrain.find((r) => r.train === t)?.n ?? 0
    const sites = (this.db.query('SELECT count(DISTINCT site) AS n FROM page_policy WHERE train = 1').get() as { n: number }).n
    const languages = this.db
      .query('SELECT coalesce(language, \'unknown\') AS language, count(*) AS pages FROM page_policy WHERE train = 1 GROUP BY 1 ORDER BY 2 DESC LIMIT 25')
      .all() as Array<{ language: string; pages: number }>
    const kinds = this.db.query('SELECT kind, count(*) AS pages FROM page_policy WHERE train = 1 GROUP BY 1 ORDER BY 2 DESC LIMIT 25').all() as Array<{ kind: string; pages: number }>
    const reasons = this.db.query('SELECT reason, count(*) AS pages FROM page_policy WHERE train = 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 25').all() as Array<{ reason: string; pages: number }>
    const last = this.db.query('SELECT max(fetched_at) AS t FROM (SELECT fetched_at FROM page_policy ORDER BY id DESC LIMIT 1000)').get() as { t: string | null }
    const value = {
      pages_indexed: this.count(),
      pages: n(1),
      excluded: n(0),
      unknown: n(null),
      not_yet_mapped: Math.max(0, this.count() - n(1) - n(0) - n(null)),
      sites,
      languages,
      kinds,
      excluded_by: reasons,
      last_crawl: this.lastAddAt ?? last.t ?? null,
      computed_at: new Date(now).toISOString(),
    }
    this.statsCache = { at: now, value }
    return value
  }

  // ---- backfill: pages indexed before verdicts were recorded ---------------------------

  /** Gives `n` more legacy pages a page_policy row (train unknown). 0 once every page has one. */
  mapLegacy(n = 2000): number {
    const meta = this.db.query("SELECT value FROM corpus_meta WHERE key = 'map_cursor'").get() as { value: string } | null
    const after = Number(meta?.value ?? 0)
    const rows = this.db.query('SELECT id, site, kind, language, fetched_at FROM pages WHERE id > ? ORDER BY id LIMIT ?').all(after, n) as Array<{
      id: number
      site: string
      kind: string
      language: string | null
      fetched_at: string
    }>
    if (!rows.length) return 0
    const insert = this.db.prepare("INSERT OR IGNORE INTO page_policy (id, site, kind, language, fetched_at, train, reason, source) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'legacy')")
    this.db.transaction(() => {
      for (const r of rows) insert.run(r.id, r.site, r.kind, r.language, r.fetched_at)
      this.db.run("INSERT INTO corpus_meta (key, value) VALUES ('map_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(rows[rows.length - 1]!.id)])
    })()
    return rows.length
  }

  /** Sites with pages whose verdict is unknown, not tried in the last day. */
  unknownSites(n = 16, now = Date.now()): string[] {
    return (
      this.db
        .query(
          `SELECT DISTINCT pp.site FROM page_policy pp WHERE pp.train IS NULL
           AND NOT EXISTS (SELECT 1 FROM policy_site_checks c WHERE c.site = pp.site AND c.checked_at > ?) LIMIT ?`,
        )
        .all(now - 86_400_000, n) as Array<{ site: string }>
    ).map((r) => r.site)
  }

  unknownPagesOf(site: string): PolicyRow[] {
    return this.db.query('SELECT pp.id, p.url FROM page_policy pp JOIN pages p ON p.id = pp.id WHERE pp.site = ? AND pp.train IS NULL').all(site) as PolicyRow[]
  }

  /** Records verdicts for unknown pages (never overrides one made at crawl time) and that the site was tried. */
  setPolicies(site: string, verdicts: Array<{ id: number; allowed: boolean; reason: string }>, now = Date.now()): void {
    const set = this.db.prepare("UPDATE page_policy SET train = ?, reason = ?, source = 'backfill' WHERE id = ? AND train IS NULL")
    this.db.transaction(() => {
      for (const v of verdicts) set.run(v.allowed ? 1 : 0, v.reason.slice(0, 120), v.id)
      this.db.run('INSERT INTO policy_site_checks (site, checked_at) VALUES (?, ?) ON CONFLICT(site) DO UPDATE SET checked_at = excluded.checked_at', [site, now])
    })()
  }

  /** Best matches: every word if any page has them all, else any word. Title weighs most. `kind` keeps one kind of page. */
  search(query: string, limit = 10, kind?: string): IndexHit[] {
    const terms = toFtsTerms(query)
    if (!terms.length) return []
    const run = (match: string) =>
      this.db
        .query(
          `SELECT p.url, p.title, p.site, p.kind, p.fetched_at,
                  CASE WHEN p.description != '' THEN p.description ELSE substr(p.body, 1, 300) END AS summary,
                  bm25(pages_fts, 10.0, 4.0, 6.0, 1.0, 3.0) AS score
           FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
           WHERE pages_fts MATCH ?
           ORDER BY score LIMIT ?`,
        )
        .all(match, Math.min(Math.max(1, limit), 50)) as IndexHit[]
    if (kind) return this.searchKind(terms, kind, limit)
    const all = run(terms.join(' AND '))
    return all.length || terms.length === 1 ? all : run(terms.join(' OR '))
  }

  /**
   * Best matches of one kind, quickly. bm25 has to score every match before LIMIT applies, which
   * took 6 s for "shoes" on 6M pages (2026-11-07), and SQLite here blocks the event loop the health
   * check runs on. So: the newest KIND_SCAN matches, that kind only, most words in the title first.
   */
  private searchKind(terms: string[], kind: string, limit: number): IndexHit[] {
    const run = (match: string) =>
      this.db
        .query(
          `SELECT p.url, p.title, p.site, p.kind, p.fetched_at,
                  CASE WHEN p.description != '' THEN p.description ELSE substr(p.body, 1, 300) END AS summary, 0 AS score
           FROM pages p
           WHERE p.id IN (SELECT rowid FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rowid DESC LIMIT ${KIND_SCAN})
             AND p.kind = ?
           ORDER BY p.id DESC LIMIT 200`,
        )
        .all(match, kind) as IndexHit[]
    let hits = run(terms.join(' AND '))
    if (!hits.length && terms.length > 1) hits = run(terms.join(' OR '))
    const words = terms.map((t) => t.replace(/"/g, '').toLowerCase())
    const inTitle = (hit: IndexHit) => {
      const title = hit.title.toLowerCase()
      return words.filter((w) => title.includes(w)).length
    }
    return hits
      .map((hit) => ({ hit, n: inTitle(hit) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, Math.min(Math.max(1, limit), 50))
      .map(({ hit }) => hit)
  }

  /**
   * Pages kept, instantly: a counter add() and trim() keep up to date. A count(*) here
   * took 14 s at 812k pages and blocked the event loop until the health check failed
   * (2026-11-02), and max(id) stopped being the answer once trim() deletes from the
   * low end.
   */
  count(): number {
    return Number(this.meta('pages_live') ?? 0)
  }

  /** Where a nichedb backfill left off, so a later run carries on. Null when it finished. */
  importCursor(): number | null {
    const value = this.meta('import_cursor')
    return value ? Number(value) : null
  }

  setImportCursor(cursor: number | null): void {
    if (cursor === null) this.db.run("DELETE FROM corpus_meta WHERE key = 'import_cursor'")
    else this.setMeta('import_cursor', String(cursor))
  }

  /** Which tables the file actually has, for tests and one-off checks. */
  tables(): string[] {
    return (this.db.query("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)
  }

  /** The highest id ever used: the top of the id space a corpus scan has to cover. */
  highWaterMark(): number {
    return Math.max(Number(this.meta('pages_hwm') ?? 0), this.maxId())
  }

  close(): void {
    this.db.close()
  }
}
