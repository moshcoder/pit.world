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

No key is needed. `PIT_URL` points it at another pit.world instance (default `https://pit.world`).

## What it does

- **Web search, privately.** Your browser talks only to pit.world. pit.world asks the Google index (through Serper) and the Bing index (through DataForSEO) at the same time, merges the two lists, and tags each result with the engine that found it. The providers get the words, never your IP, browser, cookies or referrer. Linkup, Exa and Perplexity are fallbacks if both fail.
- **Moshpit names.** A query that looks like `label.ending` is checked against the Moshpit registry, and a registered name gets a card with where it points.
- **Bangs.** `!gh hqtui`, `rust lifetimes !so`, `!pit chovy.hacker`: straight to that site's search, without a referrer. The full list is at [pit.world/about#bangs](https://pit.world/about#bangs).
- **Default search engine.** OpenSearch description at `/opensearch.xml`, suggestions at `/suggest`, and `https://pit.world/search?q=%s` for any browser.

## Privacy, by construction

- nginx writes **no access log** for the site (`ACCESS_LOG=off` in `bin/install.conf`), and the app logs nothing per request.
- **No cookies.** The server strips `Set-Cookie` from every response.
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

No key. Rate limited per visitor (`429` with `Retry-After`).

## Surfaces

The house rule: everything ships a TUI, a CLI, an MCP and an API.

| | |
| --- | --- |
| Web + API | `bun src/server.ts` (`PORT`, `HOST`; provider keys `SERPER_API_KEY`, `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` (Bing), `LINKUP_API_KEY`, `EXA_API_KEY`, `PERPLEXITY_API_KEY`) |
| CLI | `pit search`, `pit resolve`, `pit network`, `pit open` |
| TUI | `pit` |
| MCP | `pit mcp`: tools `search`, `moshpit_resolve`, `moshpit_network`. In the official MCP Registry as `world.pit/pit` (`server.json`) |
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
