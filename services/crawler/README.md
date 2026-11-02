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
bun services/crawler/src/cli.ts stats
bun services/crawler/src/cli.ts read https://example.com/ [--render]
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
| `CRAWL_DISCOVER` | 0 | 1: crawl linked sites too, up to `CRAWL_MAX_SITES` (100,000) |
| `OBSCURA_MCP_URLS` | none | comma-separated `obscura mcp --http` endpoints |
| `OBSCURA_MCP_TOKEN` | none | Obscura's bearer token (32+ bytes) |
| `NICHEDB_URL` / `NICHEDB_API_KEY` | nichedb.dev / none | an admin key; without one records wait in the outbox |
| `CRAWL_HEALTH_PORT` | 8797 | `/healthz` with queue depths and counters |

## Deploy (dev2)

`deploy/crawler/docker-compose.yml`: the crawler, its Redis, two Obscura servers, all on
loopback (`/healthz` at 127.0.0.1:8807). `~/www/pit-crawler/{app,crawler.env}`;
`deploy/crawler/poll.sh` from cron rebuilds on every new commit to main.

## Tests

`bun test` runs everything with fakes. `CRAWL_TEST_REDIS=redis://127.0.0.1:6399/15` adds the
real-Redis frontier and queue tests (CI runs them), `OBSCURA_TEST_URL` + `OBSCURA_TEST_TOKEN` a
real render.
