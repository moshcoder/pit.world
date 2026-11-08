/**
 * The page archive: every record the publish role takes from the outbox, full text and
 * all, appended to one gzip file per UTC hour and process (`pages-20261108T15-<host>-<pid>.jsonl.gz`). An index is
 * a cache that forgets its oldest pages; the archive is what a bigger index or another
 * search engine is rebuilt from. Since 2026-11-08 nothing else keeps pages (they stopped
 * going to nichedb), so pitbot's publish host writes here and a cron ships finished hours
 * to seed1 (2.8 TB at ~2.4 KB a page gzipped: ~1.2B pages).
 *
 * Each write is one complete gzip member (concatenated members are one valid gzip
 * stream), so a crash loses at most the batch being written. The current hour is
 * `<name>.partial`; it is renamed to `<name>` once the hour has passed, and only
 * renamed files are shipped.
 *
 * Several publishing processes may share the directory (the index takes many writers since
 * it moved to Postgres), so each process writes its own file: the name carries the host and
 * pid (`pages-20261108T15-<host>-<pid>.jsonl.gz`). A process seals its own earlier hours at
 * once; another's only once that hour is two behind, by when its writer has long moved on (or
 * died, which is how a restart's leftover gets sealed). The `pages-` prefix and `.jsonl.gz`
 * suffix stay, so deploy/crawler-remote/ship-archive.sh still matches `pages-*.jsonl.gz`.
 */
import { appendFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const hourKey = (at: Date) => at.toISOString().slice(0, 13).replace(/[-:]/g, '')

/** `pages-<hour>[-<tag>].jsonl.gz`; the tag tells one writing process from another. */
export const hourName = (at: Date, tag = '') => `pages-${hourKey(at)}${tag ? `-${tag}` : ''}.jsonl.gz`

/** This process, as a file-name-safe tag: host and pid. */
export const processTag = (host = hostname(), pid = process.pid) => `${host.replace(/[^A-Za-z0-9.]+/g, '_').slice(0, 64)}-${pid}`

export class PageArchive {
  constructor(
    readonly dir: string,
    private now: () => Date = () => new Date(),
    readonly tag: string = processTag(),
  ) {
    mkdirSync(dir, { recursive: true })
  }

  /** Append records (one JSON per line); seals any earlier hour first. */
  write(lines: string[]): void {
    const name = hourName(this.now(), this.tag)
    this.seal(name)
    if (!lines.length) return
    appendFileSync(join(this.dir, `${name}.partial`), gzipSync(`${lines.join('\n')}\n`, { level: 6 }))
  }

  /**
   * Rename every .partial whose hour is over: this process's own as soon as the hour turns,
   * any other process's once it is two hours old (it may still be finishing its last batch).
   */
  seal(current = hourName(this.now(), this.tag)): string[] {
    const sealed: string[] = []
    const now = this.now()
    const previous = hourKey(new Date(now.getTime() - 3_600_000))
    const suffix = this.tag ? `-${this.tag}.jsonl.gz.partial` : '.jsonl.gz.partial'
    for (const f of readdirSync(this.dir)) {
      if (!f.startsWith('pages-') || !f.endsWith('.partial') || f === `${current}.partial`) continue
      const hour = f.slice('pages-'.length, 'pages-'.length + 11)
      const ours = f === `pages-${hour}${suffix}`
      if (!ours && hour >= previous) continue
      const done = f.slice(0, -'.partial'.length)
      renameSync(join(this.dir, f), join(this.dir, done))
      sealed.push(done)
    }
    return sealed
  }
}
