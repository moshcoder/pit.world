# pit.world

**Private search, and the front door to the Moshpit network.**

**An MCP server for private web search.** `pit mcp` is a stdio Model Context Protocol server that gives any agent (Claude, Cursor, any MCP client) web search with no API key and no logging, plus Moshpit name lookups. It is in the official MCP Registry as `world.pit/pit`.

[pit.world](https://pit.world) is a search engine that keeps nothing about you: no query logs, no cookies, no profile, no trackers, no JavaScript required. It is also where the [Moshpit network](https://pit.moshcode.sh) lives in public: type a Moshpit name like `chovy.hacker` and it resolves through the registry, next to your web results.

```bash
# the web
https://pit.world/search?q=anything

# the CLI and TUI
bun add -g pitworld
pit search "private search engines"
pit resolve chovy.hacker
pit                      # interactive

# your agent
claude mcp add pit -- pit mcp
```

## MCP server

```bash
claude mcp add pit -- bunx pitworld mcp
```

```json
{ "mcpServers": { "pit": { "command": "bunx", "args": ["pitworld", "mcp"] } } }
```

Tools:

- `search`: private web search (Google and Bing indexes, merged), returns titles, URLs and snippets.
- `moshpit_resolve`: resolve a Moshpit name such as `chovy.hacker` to where it points.
- `moshpit_network`: live numbers for the Moshpit network.
- `listing`: a business listing by domain (who operates it, category, service area, services, price, hours, feed, ring membership).
- `pros`: search the pro directory by category, place and words.
- `ring`: the pit.world web ring, in order.
- `edit_listing`: edit a listing you own, with its edit key.

No key is needed. `PIT_URL` points it at another pit.world instance (default `https://pit.world`).

## What it does

- **Web search, privately.** Your browser talks only to pit.world. pit.world asks the Google index (through Serper) and the Bing index (through DataForSEO) at the same time, merges the two lists, and tags each result with the engine that found it. The providers get the words, never your IP, browser, cookies or referrer. Linkup, Exa and Perplexity are fallbacks if both fail.
- **Moshpit names.** A query that looks like `label.ending` is checked against the Moshpit registry, and a registered name gets a card with where it points.
- **Bangs.** `!gh hqtui`, `rust lifetimes !so`, `!pit chovy.hacker`: straight to that site's search, without a referrer. The full list is at [pit.world/about#bangs](https://pit.world/about#bangs).
- **Default search engine.** OpenSearch description at `/opensearch.xml`, suggestions at `/suggest`, and `https://pit.world/search?q=%s` for any browser.

## Business listings, the pro directory and the web ring

- **Listings (`/b/<domain>`).** Every site has one. Its owner claims it with a DNS TXT record or a homepage meta tag and gets an edit key (`pitk_…`, shown once, stored as a hash). The owner writes who operates it (an agent or person handle like `riotcoder@profullstack.com`, or an https link to an OpenAgent record or profile), the company and its site, a category, the service area (free text plus city, region, country), services, price range, hours, phone and links.
- **Listed by pit.world (seeded).** pit.world can list a business itself from public records before its owner claims it: the business's own website, a state license checked active at the issuer (e.g. CSLB for California contractors), and the phone the business publishes on its own site. Never an email address, and never quote routing: the page says it is unclaimed and written by pit.world, is indexable, and carries a "Is this your business? Claim it" button. Claiming hands it to the owner (pit.world never writes to it again) and the owner can take it out of the directory from the edit page. Seeding runs on the server against `listings.db`: `bun src/admin.ts seed FILE.json` (an array of `{domain, name, description, phone, category, area, city, region, country, services, links, license, licenseCheckedAt, featured}`), `bun src/admin.ts unseed DOMAIN`, `bun src/admin.ts views`.
- **Views.** `/b/<domain>` counts page views by people (crawlers, link previews and scripts are not counted) for listings in the directory; the count is `views` in `GET /api/listing`.
- **Pro directory (`/pros`, `/pros/<category>`).** Claimed listings and ones pit.world listed, browsable by a fixed list of categories (home services, legal, accounting, software and dev agencies, health, and so on: `GET /api/pros/categories`) and searchable by words and place. A few featured listings first (an editorial pick, never sold), then verified owners by latest edit, then unclaimed ones. No paid placement and **no reviews in v1**: there is no identity to anchor a review to that a business could not fake, so there are none rather than ones that can be bought.
- **Quote requests.** A listing with a confirmed private address shows a "Request a quote" form. pit.world mails the owner from `hello@pit.world` with the sender as Reply-To; the owner's address is never shown, sent, or returned by the API. The address only works after its owner clicks the link mailed to it, so a listing cannot aim pit.world's mail at someone else. One listing per request; three requests an hour per visitor (HMAC'd IP, memory only), five an hour and twenty a day per listing, four hundred a day site-wide; a honeypot field; messages with more than three links are refused. pit.world keeps no copy: only the time, to count.
- **The pit.world ring (`/ring`).** The core sites (pit.world, seo.rank, family.ancestry) and then every claimed listing, in the order they joined: **claiming is joining**, and owners can leave from the edit page. Hops: `/ring/next|prev|random?from=<site>` (also `?host=`, `?url=`, `?via=`, or the Referer), `302` with `no-store`; `/api/ring` for members that draw the bar themselves; `/ring/opml` for every member's feed. The verified and edit pages show the links to paste.
- **Mirrored to rssamplifier.com.** pit.world reads each claimed site's homepage for `<link rel="alternate">` RSS/Atom on claim and daily, and keeps the ring `pit-world` on [rssamplifier.com/ring/pit-world](https://rssamplifier.com/ring/pit-world) in step: submit new feeds, add members, remove ones that left. The sync is a diff (idempotent), runs a few seconds after a claim or edit and once a day, and needs `RSSAMPLIFIER_API_KEY` (an rssamplifier API key of the account that owns the ring; off without it). Moshpit-only names are not mirrored, since rssamplifier cannot reach them. New claims are also a feed: `/b/feed.xml`.

## Promotion campaigns: promote first, then show the results

A promotion campaign lists and promotes the businesses an [OutreachGraph](https://outreachgraph.com) campaign targets, measures what that did for each one over its own 30-day window, and only then writes to them, with the numbers. It is how the Los Gatos builders campaign runs ([pit.world/roundup/los-gatos-builders](https://pit.world/roundup/los-gatos-builders)).

- **Import.** `scripts/outreachgraph-campaign-export.sh cmp_...` writes a complete, read-only snapshot of the OutreachGraph campaign (OutreachGraph has no API that lists every member with its addresses). `pit promo import ID snapshot.json` gives every source row exactly one disposition (matched, merged into the same business, unresolved, excluded) and the totals must add up. Leads at one domain are one business with all their lead ids. Re-importing the same snapshot changes nothing; only a complete snapshot can mark a business as having left (its listing stays, its priority goes). Businesses without social profiles are kept.
- **The roster first.** `pit promo roster ID`: lead ids, business, website, listing, verification, planned action. A member is publishable when its listing is in the directory with a name, category, place, description and a checked source (a license checked at the issuer, or an owner claim).
- **Outreach hold.** A member only launches when every way the upstream could send to it is held: each lead suppressed in OutreachGraph (the `los-gatos-promotion-hold` suppress list) or only in campaigns that wait for approval. Otherwise it is blocked with the reason; an operator can attest a hold (`pit promo set ID DOMAIN --attest TEXT`).
- **Priority.** Verified members of a running campaign come first in `/pros`, in SQL before pagination, after filters, so pages, the API and the mobile view agree. Turning priority off or stopping the campaign leaves the listing alone. Campaign membership is never shown publicly.
- **Roundup and spotlights.** `pit promo preview ID` shows every planned post with its text and time and a version; `pit promo launch ID --version V` publishes `/roundup/<slug>` and creates the calendar: a roundup announcement now, then one spotlight per business across the configured accounts, `perAccountPerDay` each, from `postHour` local time. `pit promo worker ID` (run where myna is logged in) posts due ones with `myna post <account> --front`, reconciles every post against myna's history and queue by its tracking id (`?via=plc_...`) before posting so a crash never posts twice, and verifies each through the network's public API (Bluesky `getPostThread`, Mastodon `statuses`). Scheduled is not published, published is not verified; only verified posts count. LinkedIn has no public read, so its posts never count. Accounts on networks where myna buys a CrawlProof ad per post are refused: promotion is organic, and a paid budget defaults to zero.
- **Measurement.** Listing views, website clicks (`/b/<domain>/go`, a redirect to the listing's own site only), phone taps (a beacon from `/listing.js`, deduplicated by its id), quote requests, and roundup views (campaign-level, never credited to each business). Crawlers, link previews, prefetches, `PIT_INTERNAL_IPS` and marked tests (`?pt=test`) are stored as excluded. No cookie, no IP, no user agent: a visitor is a hash under a salt deleted when its UTC day ends, so "visitor-days" exist and unique visitors over a window do not (reported as unavailable). Only businesses in a campaign are counted.
- **Windows.** Each business's window starts when its listing is live, its tracking passed a marked test (`pit promo test-tracking ID`) and a placement naming it was verified, and lasts `periodDays` (30) elapsed days. The hourly pass marks ended windows due and makes one review job per window (a restart never makes a second), which writes a versioned report and a draft. Late additions get their own window; gaps are recorded (`pit promo gap`), never hidden by moving dates.
- **Reports.** Private and frozen per version (`pit promo report ID --md`); shareable at `/r/<token>` (HTML, `.md`, `.json`) without the operator's costs. Unavailable is not zero. Late data makes a new version and voids unsent drafts that quoted the old one. `pit promo csv ID` compares the campaign.
- **Drafts and sending.** Each report gets one draft from its own numbers: an introduction unless a contact is on record (then a follow-up), an honest note when nothing was measured, blocked when there is no address. Sending is off until `sendAuthorized`; `deliver` re-checks the window, the report version and upstream suppression at send time (unknown means no) and keeps one delivery per recipient, message version and window.
- **Surfaces.** API `/api/v1/promotion/*` (Bearer `PIT_ADMIN_TOKEN`), dashboard `/admin/promo` (a signed-in pit.world admin), `pit promo ...`, `pit promo tui ID`, and `promo_*` MCP tools when `PIT_ADMIN_TOKEN` is set.

## One account for every pit.world site: social.<name> and bbs.<name>

Every Moshpit name gets two more addresses, with nothing to set up:

- **`social.<name>.pit.world`**: the name's social feed. Posts from the AT Protocol network tagged with the name's niche (`family.ancestry` follows #genealogy, #familyhistory, #ancestry, ...), read from every relay we can reach at once (Bluesky's and the independent ones: atproto.africa, relay.fire.hose.cam, relay.upcloud.world, relay.waow.tech), plus posts by members. Each is also an AT Protocol feed generator (`did:web:social.<name>.pit.world`). It is the [pit-social](https://github.com/moshcoder/pit-social) service; pit.world forwards the host to it.
- **`bbs.<name>.pit.world`**: the name's bulletin board, a [tsbb](https://github.com/profullstack/tsbb) board made on its first visit (`deploy/pit-bbs-provision`), its own database, forums seeded, the pit.world admins as its administrators.

Both sign people in with their **pit.world account**: sign in once at [pit.world/signin](https://pit.world/signin) with **CoinPay** (OAuth 2.1, code + PKCE) and every board and feed signs you in through pit.world (`/bridge/authorize`, `/bridge/token`, [@profullstack/bridges](https://github.com/profullstack/bridges)), silently when you are already signed in. Nobody makes an account per site. `/account` shows the sites you use, your CLI tokens, sign out and delete.

- A site's client id is its host; its secret is `base64url(HMAC-SHA256(PIT_BRIDGE_KEY, host))`, so a new name works the moment it exists and no site is registered by hand. `PIT_BRIDGE_CLIENTS` adds exact extra hosts (our own apps on the relay).
- Accounts link by CoinPay `sub` (the person's CoinPay DID) only, never by email (CoinPay reports every email unverified).
- **CLI:** `pit login` (OAuth 2.1, public client, loopback redirect, PKCE S256, RFC 8252), `pit whoami`, `pit logout`, `pit social <name>`, `pit bbs <name>`. API: `GET /api/v1/me` with `Authorization: Bearer pw_…`.
- **Certificates:** one Let's Encrypt certificate per name covers `<name>`, `social.<name>` and `bbs.<name>` (`deploy/pit-proxy-cert`).
- Settings: `PIT_COINPAY_CLIENT_ID`, `PIT_COINPAY_CLIENT_SECRET` (CoinPay client with callback `https://pit.world/api/v1/coinpay/oauth/callback`), `PIT_BRIDGE_KEY`, `PIT_ADMIN_SUBS`, `PIT_SOCIAL_URL` (default `http://127.0.0.1:8794`, `off`), `PIT_BBS` (`off`), `PIT_BBS_MAX` (default 100).

## Privacy, by construction

- nginx writes **no access log** for the site (`ACCESS_LOG=off` in `bin/install.conf`), and the app logs nothing per request.
- **No cookies to search.** The server strips `Set-Cookie` from every response except the sign-in and account routes, which set one only after you press Sign in.
- Rate limiting keys on an **HMAC of the IP under a secret regenerated every hour**, in memory only.
- Identical searches are cached **in memory for ten minutes** to avoid paying twice; the cache holds words and results, nothing about who asked, and never touches disk.
- Strict CSP (`default-src 'none'`, same-origin scripts and styles only), `Referrer-Policy: no-referrer`, results link straight to the site.

The page says the same in plain words: [pit.world/privacy](https://pit.world/privacy).

## API

| | |
| --- | --- |
| `GET /api/search?q=…&n=10` | `{ query, provider, cached, results: [{ url, title, description, host }], moshpit }` |
| `GET /api/resolve?name=chovy.hacker` | the registry's answer for a Moshpit name |
| `GET /api/network` | endings claimed, registry events, recent claims, endings for sale |
| `GET /api/bangs` | every bang |
| `GET /api/listing?domain=…` | a listing (never the owner's contact address) |
| `POST /api/listing/claim` · `POST /api/listing/verify` | claim a listing; the edit key comes back once |
| `POST /api/listing` | edit, with `Authorization: Bearer pitk_…`; `contactEmail` sets the private quote address (`""` clears) |
| `POST /api/listing/quote` | `{ domain, name, email, phone?, message }`: one quote request to one listing |
| `GET /api/pros?c=legal&near=oakland&q=wills&n=20&page=1` | the pro directory |
| `GET /api/pros/categories` | categories (with counts) and price bands |
| `GET /api/ring` | the web ring, in order |

No key. Rate limited per visitor (`429` with `Retry-After`).

## Surfaces

The house rule: everything ships a TUI, a CLI, an MCP and an API.

| | |
| --- | --- |
| Web + API | `bun src/server.ts` (`PORT`, `HOST`; `RESEND_API_KEY` for the newsletter and quote requests; `RSSAMPLIFIER_API_KEY` (+ optional `RSSAMPLIFIER_URL`, `RSSAMPLIFIER_RING`) for the ring mirror; provider keys `SERPER_API_KEY`, `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` (Bing), `LINKUP_API_KEY`, `EXA_API_KEY`, `PERPLEXITY_API_KEY`) |
| CLI | `pit search`, `pit resolve`, `pit network`, `pit open`, `pit listing`, `pit claim`, `pit verify`, `pit edit DOMAIN --key … --operator … --category …`, `pit pros [WORDS] --category … --near …`, `pit categories`, `pit quote DOMAIN --name … --email … --message …`, `pit ring` |
| TUI | `pit` |
| MCP | `pit mcp`: tools `search`, `moshpit_resolve`, `moshpit_network`, `listing`, `pros`, `ring`, `edit_listing`. In the official MCP Registry as `world.pit/pit` (`server.json`) |
| PWA | installable from any browser (`/manifest.webmanifest`, share target into `/search`); the worker in `public/sw.js` caches the static shell and an offline page, never a search |

The CLI, TUI and MCP talk to `https://pit.world` (or `PIT_URL`), so they need no keys.

## Run your own

```bash
git clone https://github.com/moshcoder/pit.world && cd pit.world
bun install
SERPER_API_KEY=… bun src/server.ts        # http://127.0.0.1:8787
```

Production runs on bare metal with `bin/install.sh` ([OpenInstall](https://logicsrc.com/openinstall)): nginx + Let's Encrypt + a systemd unit running bun.

## The Moshpit network

Moshpit is a namespace beside ICANN's. Anyone can claim an ending (`.hacker`, `.eggs`, `.pit`), put names under it and point them anywhere; the registry is open and append-only, and it signs certificates, so the names are real HTTPS sites to anyone on the network. Get on it with [moshcode](https://moshcode.sh) (`curl -fsSL https://moshcoding.com/install.sh | sh`, then `moshcode dns enable`) or by setting your browser's secure DNS to `https://dns.moshcode.sh/dns-query`. Every method (moshcode, TronBrowser, browser DoH, an Apple profile, Windows, Android) and how to trust the Moshpit Root CA is at [pit.world/connect](https://pit.world/connect); pit.world serves the root at `/moshpit-root-ca.crt` and the Apple profile at `/moshpit.mobileconfig`. Claim an ending at [pit.moshcode.sh](https://pit.moshcode.sh).

## License

MIT
