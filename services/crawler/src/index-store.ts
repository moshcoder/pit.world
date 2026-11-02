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
  enrichment: { keywords?: string[]; excerpt?: string; language?: string | null }
}

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
          $body: entry.enrichment?.excerpt ?? '',
          $language: entry.enrichment?.language ?? r.language ?? null,
          $fetched: r.fetched_at ?? new Date().toISOString(),
        })
        kept++
      }
    })()
    return kept
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

  count(): number {
    return (this.db.query('SELECT count(*) AS n FROM pages').get() as { n: number }).n
  }

  close(): void {
    this.db.close()
  }
}
