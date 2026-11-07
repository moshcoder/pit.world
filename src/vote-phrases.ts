/**
 * The searches people voted on, counted per day.
 *
 * A vote is a person saying a search mattered enough to rate its results, which
 * is the best signal of interest this site has, and the one place pit.world
 * keeps the words of a search. Everything else stays as /privacy describes it:
 * a search with no vote leaves nothing behind.
 *
 * Deliberately not a column on `votes`. This table is a count of words and a day
 * and nothing else, so a phrase cannot be walked back to a device or an account.
 * The public list only shows a phrase once three separate votes have landed on
 * it, so one person's search is never published.
 */
import type { Database } from 'bun:sqlite'

/** Votes a phrase needs before anyone else can see it. */
export const MIN_PUBLIC_VOTES = 3
const KEEP_DAYS = 90
const DAY_MS = 86_400_000

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * The phrase worth counting, or null. Leaves out what is likelier to be about a
 * person than a subject (addresses, links, long numbers) and the isbn: and vin:
 * lookups.
 */
export function votablePhrase(query: string | null | undefined): string | null {
  const text = String(query ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (text.length < 2 || text.length > 80 || text.split(' ').length > 8) return null
  if (/[@:/\\]|\.[a-z]{2,}\b|\d{5,}/.test(text)) return null
  return text
}

export class VotePhrases {
  constructor(
    readonly db: Database,
    private readonly now = () => Date.now(),
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS vote_phrases (
      day TEXT NOT NULL, phrase TEXT NOT NULL, votes INTEGER NOT NULL,
      PRIMARY KEY (day, phrase))`)
  }

  record(query: string | null | undefined): void {
    const phrase = votablePhrase(query)
    if (!phrase) return
    const today = this.now()
    this.db
      .query('INSERT INTO vote_phrases (day, phrase, votes) VALUES (?, ?, 1) ON CONFLICT (day, phrase) DO UPDATE SET votes = votes + 1')
      .run(day(today), phrase)
    this.db.query('DELETE FROM vote_phrases WHERE day < ?').run(day(today - KEEP_DAYS * DAY_MS))
  }

  /** The most voted-on searches over `days`, with this period set against the one before it. */
  top(options: { days?: number; limit?: number } = {}): Array<{ phrase: string; votes: number; prior_votes: number }> {
    const days = Math.min(30, Math.max(1, Math.trunc(options.days ?? 7)))
    const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)))
    const since = day(this.now() - days * DAY_MS)
    const before = day(this.now() - 2 * days * DAY_MS)
    return this.db
      .query(
        `SELECT phrase,
                SUM(CASE WHEN day >= ?1 THEN votes ELSE 0 END) AS votes,
                SUM(CASE WHEN day < ?1 THEN votes ELSE 0 END) AS prior_votes
           FROM vote_phrases WHERE day >= ?2
          GROUP BY phrase HAVING SUM(CASE WHEN day >= ?1 THEN votes ELSE 0 END) >= ?3
          ORDER BY votes DESC, phrase LIMIT ?4`,
      )
      .all(since, before, MIN_PUBLIC_VOTES, limit) as Array<{ phrase: string; votes: number; prior_votes: number }>
  }
}
