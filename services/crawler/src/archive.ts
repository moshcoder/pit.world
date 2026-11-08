/**
 * The page archive: every record the publish role takes from the outbox, full text and
 * all, appended to one gzip file per UTC hour (`pages-20261108T15.jsonl.gz`). An index is
 * a cache that forgets its oldest pages; the archive is what a bigger index or another
 * search engine is rebuilt from. Since 2026-11-08 nothing else keeps pages (they stopped
 * going to nichedb), so pitbot's publish host writes here and a cron ships finished hours
 * to seed1 (2.8 TB at ~2.4 KB a page gzipped: ~1.2B pages).
 *
 * Each write is one complete gzip member (concatenated members are one valid gzip
 * stream), so a crash loses at most the batch being written. The current hour is
 * `<name>.partial`; it is renamed to `<name>` once the hour has passed, and only
 * renamed files are shipped.
 */
import { appendFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

export const hourName = (at: Date) => `pages-${at.toISOString().slice(0, 13).replace(/[-:]/g, '')}.jsonl.gz`

export class PageArchive {
  constructor(
    readonly dir: string,
    private now: () => Date = () => new Date(),
  ) {
    mkdirSync(dir, { recursive: true })
  }

  /** Append records (one JSON per line); seals any earlier hour first. */
  write(lines: string[]): void {
    const name = hourName(this.now())
    this.seal(name)
    if (!lines.length) return
    appendFileSync(join(this.dir, `${name}.partial`), gzipSync(`${lines.join('\n')}\n`, { level: 6 }))
  }

  /** Rename every .partial that is not the current hour's: its hour is over. */
  seal(current = hourName(this.now())): string[] {
    const sealed: string[] = []
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.partial') || f === `${current}.partial`) continue
      const done = f.slice(0, -'.partial'.length)
      renameSync(join(this.dir, f), join(this.dir, done))
      sealed.push(done)
    }
    return sealed
  }
}
