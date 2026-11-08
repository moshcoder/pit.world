# pitbot: pit.world's crawler

pit.world's own index. A BullMQ spider that reads up to 1,000 pages per site, renders
JavaScript-only pages in [Obscura](https://github.com/h4ckf0r0day/obscura), enriches each page
and publishes it as an [OpenSite](https://logicsrc.com/opensite) record to
[nichedb.dev/c/sites](https://nichedb.dev/c/sites). pit.world then searches those records as one
more engine (`pit` in `src/search.ts`), fused with the others.

```
seed (nichedb sites, ring, file, names)
  -> pit-crawl-site    robots.txt, sitemaps, home page          (one job per site per cycle)
  -> pit-crawl-page    fetch, extract, follow same-site links    (shallow first, polite per site)
  -> pit-crawl-render  empty JS shells, read again in Obscura    (one page per Obscura server)
  -> Redis outbox      { record, enrichment }
  -> pit-crawl-publish POST nichedb.dev/api/v1/sites/records     (200 a call, every 5 s)
```

## What it records

- **OpenSite record**: canonical (same-site only), kind, title, description, image, language,
  author, feeds, published/modified dates, og/twitter tags verbatim, JSON-LD.
- **Enrichment**: language, top keywords (become `topic:` tags on nichedb, so they are
  searchable), a 1,000-character excerpt of the main text (the summary when the page has no
  description), word and link counts, whether it was rendered, link depth, and a hash of the
  text: an unchanged page is not written again.

## The local mirror, and why it has a size

Everything published also goes into a SQLite FTS5 file (`/data/index.db`) that answers
`/api/v1/search` in milliseconds, because nichedb's own full-text search takes seconds and
pit.world gives a slow engine 2.5 s. nichedb is the archive; this file is a cache.

Unbounded, that cache reached **207 GB in 2.7 days** and filled dev2's root filesystem, which
truncated the append-only file of every other Redis on the box (2026-11-04). So:

- It keeps **no media**. Images and videos travel on the nichedb record, where they are read
  from; the 135M rows, the UNIQUE index and the second FTS copy they used to cost here
  (~75 GB of that 207 GB) had no reader at all.
- It lives inside **`CRAWL_INDEX_MAX_BYTES`** (60 GB by default). Over it, the publish role
  drops its oldest pages, 2,000 at a time between event-loop turns, and never below 1,000
  pages. A dropped page is still on nichedb and comes back on its next recrawl.
- It is created with `auto_vacuum = INCREMENTAL`, so freed pages go back to the filesystem.
  An index made before this keeps `auto_vacuum = NONE`: deleting rows still bounds it, but
  the file keeps its high-water mark, so rebuild it rather than expecting it to shrink.

`/stats` reports `index_bytes` against `index_max_bytes`, so /status shows the headroom.
Eviction goes by **`fetched_at`**, not by id: a bulk import arrives newest-first, so id order
and crawl order are not the same thing.

### Refilling it without crawling again

```
bun services/crawler/src/cli.ts import --from nichedb [--limit n] [--max-gb n] [--restart]
```

Reads `/c/sites` back out of nichedb newest-first and writes each page into the mirror, stopping
at the byte budget. Safe to stop and re-run: it keeps a cursor in `corpus_meta` and a page already
there is replaced, not duplicated. **It does not restore everything a crawl would**: a published
record carries the 1,000-character excerpt rather than the full page text, and no training verdict,
so imported pages are searchable on title/description/keywords/excerpt and stay out of
`/api/corpus` until the policy backfill judges their site. A recrawl later replaces them whole.

## Training opt-outs

Every page gets a training verdict at crawl time (`trainingFor` in `src/crawler.ts`), kept in the
local index's `page_policy` table: reserved when `X-Robots-Tag` or meta robots says `noai`, when
TDMRep reserves it (`tdm-reservation` header or meta, `/.well-known/tdmrep.json`, read with
robots.txt once a day), or when robots.txt keeps an AI-training crawler (`AI_TRAINING_AGENTS`) off
the path. Search uses every page; `/api/v1/corpus` (pit.world's `/api/corpus`) only open ones.
Pages indexed before verdicts existed are mapped by a worker thread and judged per site by a
background backfill (robots.txt + tdmrep.json); until then they count as unknown and stay out.

## Manners

User agent `Mozilla/5.0 (compatible; pitbot/0.1; +https://pit.world/bot)`. robots.txt (a
`pitbot` group, else `*`; longest match; Crawl-delay up to 30 s), `noindex`/`nofollow`, no
`rel=nofollow|sponsored|ugc` links, one request per site at a time with a gap (1.5 s default),
no forms/carts/logins, media and documents skipped, never a private address (checked by name
and by DNS at every redirect hop).

## Scale

All state is in Redis (`pitcrawl:*` keys), so any number of `pit-crawler worker` processes on
any number of boxes share one crawl. Admission and the 1,000-page cap are one Lua call (exact
under races). A site inside its request gap moves its job back to delayed instead of holding a
worker. `CRAWL_ROLES=page` runs fetch-only workers; `CRAWL_ROLES=render` next to Obscura.

## Commands

```
bun services/crawler/src/cli.ts worker
bun services/crawler/src/cli.ts seed example.com other.example
bun services/crawler/src/cli.ts seed --from nichedb      # backfill: every site nichedb keeps
bun services/crawler/src/cli.ts seed --from ring
bun services/crawler/src/cli.ts seed --from rssamplifier   # every site behind every feed in its OPML
bun services/crawler/src/cli.ts seed --from p0dcasters
bun services/crawler/src/cli.ts seed --opml https://example.com/feeds.opml
bun services/crawler/src/cli.ts stats
bun services/crawler/src/cli.ts read https://example.com/ [--render]
curl '127.0.0.1:8807/api/v1/corpus?q=saas,crypto&limit=20&cursor=0'   # loopback, unmetered
curl 127.0.0.1:8807/api/v1/corpus/stats
```

## Settings

| Env | Default | |
| --- | --- | --- |
| `CRAWL_REDIS_URL` | `redis://127.0.0.1:6396` | pit.world's own Redis, never a shared one |
| `CRAWL_MAX_PAGES` | 1000 | pages per site per cycle |
| `CRAWL_MAX_DEPTH` | 6 | link hops |
| `CRAWL_CONCURRENCY` | 16 | pages at once per process |
| `CRAWL_HOST_DELAY_MS` | 1500 | gap between two requests to one site |
| `CRAWL_RECRAWL_DAYS` | 30 | a site is read again this often |
| `CRAWL_DISCOVER` | 0 | 1: crawl linked sites too, up to `CRAWL_MAX_SITES` (5,000,000; at the limit links to new sites are dropped and /status says so) |
| `CRAWL_SITE_QUEUE_HIGH` | 50000 | past this many waiting site jobs, new sites park in `pitcrawl:pending` (~40 B each, not ~600 B a job) and are fed in as the queue drains; `pit-crawler compact [--keep n]` parks an older, deeper queue |
| `CRAWL_MAX_PAGE_BACKLOG` | 50000 | site starts wait while more page jobs than this are queued |
| `CRAWL_SEEN_TTL_HOURS` | 72 | a site's seen-set lives this long after its last new page |
| `OBSCURA_MCP_URLS` | none | comma-separated `obscura mcp --http` endpoints |
| `OBSCURA_MCP_TOKEN` | none | Obscura's bearer token (32+ bytes) |
| `NICHEDB_URL` / `NICHEDB_API_KEY` | nichedb.dev / none | an admin key; without one records wait in the outbox |
| `CRAWL_HEALTH_PORT` | 8797 | `/healthz` with queue depths and counters |
| `CRAWL_INDEX_MAX_BYTES` | 64424509440 (60 GB) | the mirror's byte budget; over it the oldest pages go. 0 turns it off, which only a box with its own disk for the index should do |
| `CRAWL_INDEX_TRIM_MS` | 300000 | how often the publish role checks the budget |

## Deploy (dev2)

`deploy/crawler/docker-compose.yml`: the crawler, its Redis, two Obscura servers, all on
loopback (`/healthz` at 127.0.0.1:8807). `~/www/pit-crawler/{app,crawler.env}`;
`deploy/crawler/poll.sh` from cron rebuilds on every new commit to main.

## Tests

`bun test` runs everything with fakes. `CRAWL_TEST_REDIS=redis://127.0.0.1:6399/15` adds the
real-Redis frontier and queue tests (CI runs them), `OBSCURA_TEST_URL` + `OBSCURA_TEST_TOKEN` a
real render.
