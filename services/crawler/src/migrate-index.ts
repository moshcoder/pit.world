/**
 * The SQLite search mirror into Postgres, once (`pit-crawler migrate-index --from-sqlite <path>`).
 *
 * The file on dev2 holds ~10M pages in 64 GB, so this streams: keyset pages of `batch` rows by
 * id, each written in one statement that also moves the cursor kept in Postgres, so a stopped
 * run carries on from the last batch that landed. Ids and read times travel with the pages, so
 * trim() still drops the oldest first and corpus cursors keep their meaning; the id sequence is
 * moved past the highest id brought over, so pages the crawl writes meanwhile never collide.
 * A page the crawl has already written to Postgres wins over its older SQLite copy.
 */
import { Database } from 'bun:sqlite'
import type { MigratedPage, PgIndexStore } from './pg-index-store.ts'

export type MigrateIndexResult = { read: number; inserted: number; cards: number; siteChecks: number; cursor: number; pages: number }

const PAGES_CURSOR = 'migrate_cursor'
const CARDS_CURSOR = 'migrate_cards_cursor'

export async function migrateIndexFromSqlite(path: string, index: PgIndexStore, options: { batch?: number; restart?: boolean; log?: (line: string) => void } = {}): Promise<MigrateIndexResult> {
  const batch = Math.min(Math.max(1, Math.trunc(options.batch ?? 500)), 5_000)
  const log = options.log ?? (() => {})
  // Read-only: the crawler may still be writing this file, and nothing here should change it.
  const db = new Database(path, { readonly: true })
  db.exec('PRAGMA busy_timeout = 30000;')
  try {
    if (options.restart) {
      await index.setCursor(PAGES_CURSOR, null)
      await index.setCursor(CARDS_CURSOR, null)
    }
    const hasPolicy = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'page_policy'").get())
    const pick = db.query(
      hasPolicy
        ? `SELECT p.id, p.url, p.site, p.kind, p.title, p.description, p.keywords, p.body, p.language, p.fetched_at, pp.train, pp.reason, pp.source
           FROM pages p LEFT JOIN page_policy pp ON pp.id = p.id WHERE p.id > ? ORDER BY p.id LIMIT ?`
        : `SELECT id, url, site, kind, title, description, keywords, body, language, fetched_at, NULL AS train, NULL AS reason, NULL AS source
           FROM pages WHERE id > ? ORDER BY id LIMIT ?`,
    )
    // Before the first batch: the crawl may be writing Postgres already, and its new pages
    // must take ids above every id coming over.
    const top = (db.query('SELECT coalesce(max(id), 0) AS n FROM pages').get() as { n: number }).n
    await index.reserveIds(top)
    let cursor = (await index.cursor(PAGES_CURSOR)) ?? 0
    const result: MigrateIndexResult = { read: 0, inserted: 0, cards: 0, siteChecks: 0, cursor, pages: 0 }
    if (cursor) log(`migrate-index: carrying on after id ${cursor}`)
    let lastSaid = 0
    while (true) {
      const rows = pick.all(cursor, batch) as MigratedPage[]
      if (!rows.length) break
      const last = rows[rows.length - 1]!.id
      result.inserted += await index.load(rows, { key: PAGES_CURSOR, value: last })
      result.read += rows.length
      cursor = last
      result.cursor = cursor
      if (result.read - lastSaid >= 50_000) {
        lastSaid = result.read
        log(`migrate-index: ${result.read} read, ${result.inserted} new, at id ${cursor}`)
      }
    }

    const hasCards = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'page_cards'").get())
    if (hasCards) {
      let rowid = (await index.cursor(CARDS_CURSOR)) ?? 0
      const cards = db.query('SELECT rowid AS rowid, url, image, price FROM page_cards WHERE rowid > ? ORDER BY rowid LIMIT ?')
      while (true) {
        const rows = cards.all(rowid, 2_000) as Array<{ rowid: number; url: string; image: string | null; price: string | null }>
        if (!rows.length) break
        await index.loadCards(rows)
        rowid = rows[rows.length - 1]!.rowid
        await index.setCursor(CARDS_CURSOR, rowid)
        result.cards += rows.length
      }
    }

    const hasChecks = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'policy_site_checks'").get())
    if (hasChecks) {
      const checks = db.query('SELECT site, checked_at FROM policy_site_checks WHERE site > ? ORDER BY site LIMIT 5000')
      let after = ''
      while (true) {
        const rows = checks.all(after) as Array<{ site: string; checked_at: number }>
        if (!rows.length) break
        await index.loadSiteChecks(rows)
        after = rows[rows.length - 1]!.site
        result.siteChecks += rows.length
      }
    }

    // Once, at the end: the counter made exact (a count(*), fine for a one-off).
    result.pages = await index.resync()
    log(`migrate-index: done, ${result.read} read, ${result.inserted} new, ${result.cards} cards, ${result.pages} pages in Postgres`)
    return result
  } finally {
    db.close()
  }
}
