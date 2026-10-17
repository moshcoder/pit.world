# pit.world

**Private search, and the front door to the Moshpit network.**

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

## What it does

- **Web search, privately.** Your browser talks only to pit.world. pit.world asks one search provider (the Google index through Serper, with Linkup, Exa and Perplexity as fallbacks) and sends it the words, never your IP, browser, cookies or referrer.
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
| Web + API | `bun src/server.ts` (`PORT`, `HOST`; provider keys `SERPER_API_KEY`, `LINKUP_API_KEY`, `EXA_API_KEY`, `PERPLEXITY_API_KEY`) |
| CLI | `pit search`, `pit resolve`, `pit network`, `pit open` |
| TUI | `pit` |
| MCP | `pit mcp`: tools `search`, `moshpit_resolve`, `moshpit_network` |

The CLI, TUI and MCP talk to `https://pit.world` (or `PIT_URL`), so they need no keys.

## Run your own

```bash
git clone https://github.com/moshcoder/pit.world && cd pit.world
bun install
SERPER_API_KEY=… bun src/server.ts        # http://127.0.0.1:8787
```

Production runs on bare metal with `bin/install.sh` ([OpenInstall](https://logicsrc.com/openinstall)): nginx + Let's Encrypt + a systemd unit running bun.

## The Moshpit network

Moshpit is a namespace beside ICANN's. Anyone can claim an ending (`.hacker`, `.eggs`, `.pit`), put names under it and point them anywhere; the registry is open and append-only, and it signs certificates, so the names are real HTTPS sites to anyone on the network. Get on it with [moshcode](https://moshcode.sh) (`curl -fsSL https://moshcoding.com/install.sh | sh`, then `moshcode dns enable`) or by setting your browser's secure DNS to `https://dns.moshcode.sh/dns-query`. Claim an ending at [pit.moshcode.sh](https://pit.moshcode.sh).

## License

MIT
