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
    images?: Array<{ url: string; alt?: string; width?: number | null; height?: number | null }>
    videos?: Array<{ url: string; title?: string; thumbnail?: string | null; provider?: string | null }>
  }
}

export type MediaHit = { kind: 'image' | 'video'; url: string; text: string; thumbnail: string | null; width: number | null; height: number | null; provider: string | null; page: string; page_title: string; site: string; score: number }

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

export class IndexStore {
  private db: Database

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
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
      -- Images and videos a page shows: references only, never the files.
      CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY,
        page_url TEXT NOT NULL,
        kind TEXT NOT NULL,
        url TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        thumbnail TEXT,
        width INTEGER,
        height INTEGER,
        provider TEXT,
        UNIQUE (page_url, url)
      );
      CREATE INDEX IF NOT EXISTS media_page ON media (page_url);
      CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(text, page_title, tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
        INSERT INTO pages_fts(pages_fts, rowid, title, description, keywords, body, site) VALUES ('delete', old.id, old.title, old.description, old.keywords, old.body, old.site);
        INSERT INTO pages_fts(rowid, title, description, keywords, body, site) VALUES (new.id, new.title, new.description, new.keywords, new.body, new.site);
      END;
    `)
  }

  /** Keep a batch (one transaction). Entries are the outbox's JSON lines or objects. */
  add(entries: Array<IndexedRecord | string>): number {
    const upsert = this.db.prepare(`
      INSERT INTO pages (url, site, kind, title, description, keywords, body, language, fetched_at)
      VALUES ($url, $site, $kind, $title, $description, $keywords, $body, $language, $fetched)
      ON CONFLICT(url) DO UPDATE SET site = excluded.site, kind = excluded.kind, title = excluded.title,
        description = excluded.description, keywords = excluded.keywords, body = excluded.body,
        language = excluded.language, fetched_at = excluded.fetched_at
    `)
    const addMedia = this.db.prepare(
      'INSERT OR IGNORE INTO media (page_url, kind, url, text, thumbnail, width, height, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    )
    const addFts = this.db.prepare('INSERT INTO media_fts (rowid, text, page_title) VALUES (?, ?, ?)')
    const dropFts = this.db.prepare('DELETE FROM media_fts WHERE rowid IN (SELECT id FROM media WHERE page_url = ?)')
    const clearMedia = this.db.prepare('DELETE FROM media WHERE page_url = ?')
    let kept = 0
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
        upsert.run({
          $url: r.canonical,
          $site: site,
          $kind: r.kind ?? 'page',
          $title: r.title ?? site,
          $description: r.description ?? '',
          $keywords: (entry.enrichment?.keywords ?? []).join(' '),
          $body: entry.enrichment?.text || entry.enrichment?.excerpt || '',
          $language: entry.enrichment?.language ?? r.language ?? null,
          $fetched: r.fetched_at ?? new Date().toISOString(),
        })
        // A re-crawl replaces the page's media wholesale.
        dropFts.run(r.canonical)
        clearMedia.run(r.canonical)
        const pageTitle = r.title ?? site
        const add = (kind: 'image' | 'video', url: string, text: string, thumbnail: string | null, width: number | null, height: number | null, provider: string | null) => {
          const row = addMedia.get(r.canonical, kind, url, text, thumbnail, width, height, provider) as { id: number } | null
          if (row) addFts.run(row.id, text, pageTitle)
        }
        for (const img of entry.enrichment?.images ?? []) if (img?.url) add('image', img.url, img.alt ?? '', null, img.width ?? null, img.height ?? null, null)
        for (const vid of entry.enrichment?.videos ?? []) if (vid?.url) add('video', vid.url, vid.title ?? '', vid.thumbnail ?? null, null, null, vid.provider ?? null)
        kept++
      }
    })()
    return kept
  }

  /** Images or videos whose own words (alt text, title) or page title match. */
  searchMedia(query: string, kind: 'image' | 'video', limit = 20): MediaHit[] {
    const terms = toFtsTerms(query)
    if (!terms.length) return []
    const run = (match: string) =>
      this.db
        .query(
          `SELECT m.kind, m.url, m.text, m.thumbnail, m.width, m.height, m.provider, m.page_url AS page,
                  p.title AS page_title, p.site, bm25(media_fts, 5.0, 1.0) AS score
           FROM media_fts JOIN media m ON m.id = media_fts.rowid JOIN pages p ON p.url = m.page_url
           WHERE media_fts MATCH ? AND m.kind = ?
           ORDER BY score LIMIT ?`,
        )
        .all(match, kind, Math.min(Math.max(1, limit), 50)) as MediaHit[]
    const all = run(terms.join(' AND '))
    return all.length || terms.length === 1 ? all : run(terms.join(' OR '))
  }

  /** Full scan: tests and one-off checks only, never a request path. */
  mediaCount(): { images: number; videos: number } {
    const rows = this.db.query('SELECT kind, count(*) AS n FROM media GROUP BY kind').all() as Array<{ kind: string; n: number }>
    return { images: rows.find((r) => r.kind === 'image')?.n ?? 0, videos: rows.find((r) => r.kind === 'video')?.n ?? 0 }
  }

  /** Best matches: every word if any page has them all, else any word. Title weighs most. */
  search(query: string, limit = 10): IndexHit[] {
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
    const all = run(terms.join(' AND '))
    return all.length || terms.length === 1 ? all : run(terms.join(' OR '))
  }

  /**
   * Pages kept, instantly: the highest id. Rows are upserted, never deleted, so it is the
   * count. A count(*) here took 14 s at 812k pages and blocked the event loop until the
   * health check failed (2026-11-02).
   */
  count(): number {
    return (this.db.query('SELECT coalesce(max(id), 0) AS n FROM pages').get() as { n: number }).n
  }

  close(): void {
    this.db.close()
  }
}
