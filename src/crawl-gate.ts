/**
 * The crawl door on pit.world itself (never on the relayed <name>.pit.world
 * sites, which are other people's): AI training crawlers, headless browsers and
 * SEO scrapers buy a day pass ($1 a day over x402, or any coin / PayPal through
 * CoinPay's hosted checkout) on /crawl, and get a 402 everywhere else. People,
 * verified search crawlers, AI chat/search fetchers and signed-in users are
 * never charged; the API, MCP, footer snippets and health check are never
 * metered. Built only with a scoped key and a payee, so a local server never sells.
 */
import { createGateway } from '@profullstack/x402-gateway'
import { SESSION_COOKIE } from './accounts.js'

export type CrawlGate = { handle: (request: Request) => Promise<Response | null> }

export function createCrawlGate(env: Record<string, string | undefined> = process.env): CrawlGate | null {
  const apiKey = env.COINPAY_X402_KEY ?? ''
  const payTo = env.CRAWL_PAY_TO ?? ''
  if (!apiKey || !payTo) return null
  const session = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=`)
  return createGateway({
    siteUrl: (env.PIT_SITE || 'https://pit.world').replace(/\/+$/, ''),
    siteName: 'pit.world',
    coinpay: { apiKey },
    payTo,
    contact: 'mailto:anthony@profullstack.com',
    openPaths: ['/health', '/api/', '/mcp', '/snippets/', '/llms.txt', '/moshpit-root-ca.crt', '/moshpit.mobileconfig', '/opensearch.xml'],
    exempt: (request: Request) => session.test(request.headers.get('cookie') ?? ''),
  })
}
