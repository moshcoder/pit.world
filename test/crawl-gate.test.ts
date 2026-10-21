import { describe, expect, test } from 'bun:test'
import { createCrawlGate } from '../src/crawl-gate.js'
import { createApp } from '../src/server.js'

const GPT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)'
const CHROME = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-dest': 'document',
}
const crawlGate = createCrawlGate({ COINPAY_X402_KEY: 'cp_live_test', CRAWL_PAY_TO: '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5' })
const app = createApp({ keys: {}, crawlGate })
const get = (path: string, headers: Record<string, string>) => app.request(path, { headers }, { ip: '203.0.113.9' })

describe('crawl gateway', () => {
  test('is off without a key', () => {
    expect(createCrawlGate({})).toBeNull()
  })
  test('charges GPTBot with a PAYMENT-REQUIRED offer', async () => {
    const res = await get('/', { 'user-agent': GPT })
    expect(res.status).toBe(402)
    expect(res.headers.get('payment-required')).toBeTruthy()
  })
  test('sells a $1 day pass on /crawl', async () => {
    const res = await get('/crawl', { accept: 'application/json' })
    expect(res.status).toBe(402)
    expect(String(((await res.json()) as { accepts: Array<{ amount: string }> }).accepts[0]!.amount)).toBe('1000000')
  })
  test('lets a browser, a member and the health check through', async () => {
    expect((await get('/', CHROME)).status).toBe(200)
    expect((await get('/', { 'user-agent': GPT, cookie: 'pw_session=x' })).status).not.toBe(402)
    expect((await get('/health', { 'user-agent': GPT })).status).toBe(200)
  })
})
