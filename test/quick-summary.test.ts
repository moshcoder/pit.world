import { describe, expect, it } from 'bun:test'
import { quickSummary } from '../src/quick-summary.ts'
import { articleText, Summarizer, SummaryStore } from '../src/summarize.ts'

const ARTICLE = 'Our Daily News Sign up for our newsletter to get the latest headlines every morning in your inbox. The central bank raised interest rates by a quarter point on Tuesday, citing stubborn inflation. Economists had widely expected the central bank to raise rates after inflation stayed above target. Mortgage rates are likely to climb further as the central bank keeps rates high. Short line. We use cookies to improve your experience on this website and to show you ads.'

describe('quickSummary', () => {
  it('picks sentences about the page, in order, and no furniture', () => {
    const out = quickSummary(ARTICLE, 'Our Daily News')
    expect(out).toContain('raised interest rates')
    expect(out).not.toMatch(/newsletter|cookies/)
    expect(out.indexOf('raised')).toBeLessThan(out.indexOf('Mortgage'))
    expect(out.length).toBeLessThanOrEqual(480)
  })
  it('decodes entities, keeps U.S. whole, and does not repeat itself', () => {
    const out = quickSummary("BlackRock&#039;s fund lost money again in the U.S. market on Tuesday this week.\nBlackRock&#x27;s fund lost money again in the U.S. market on Tuesday.\nAnalysts said the outflows were the longest streak of the whole year so far.")
    expect(out).toContain("BlackRock's fund lost money again in the U.S. market")
    expect(out).not.toContain('&#')
    expect(out.match(/BlackRock/g)).toHaveLength(1)
    expect(out).toContain('Analysts said')
  })
  it('articleText takes prose, not menus', () => {
    const out = articleText('<html><head><meta content="A page about rates." property="og:description"></head><body><nav><p>Home Menu</p></nav><p>The <a href="/x">bank</a> raised rates.<sup>[1]</sup></p><footer><p>Copyright</p></footer></body></html>')
    expect(out).toBe('A page about rates.\nThe bank raised rates.')
  })
  it('gives nothing rather than nonsense', () => {
    expect(quickSummary('Copy and paste this code into your Wikipedia page right now please.')).toBe('')
    expect(quickSummary('Home About Contact')).toBe('')
    expect(quickSummary('')).toBe('')
  })
})

describe('a click', () => {
  const never = (async () => new Promise(() => {})) as never
  it('answers from the page at once, before any model has', async () => {
    const s = new Summarizer({ apiKey: 'k', store: new SummaryStore(':memory:'), fetch: never, pageText: async () => ARTICLE })
    s.remember([{ url: 'https://a.example/x', title: 'X', host: 'a.example', description: 'd' }])
    const started = Date.now()
    const state = await s.begin('https://a.example/x')
    expect(Date.now() - started).toBeLessThan(500)
    expect(state.status).toBe('pending')
    expect((state as { draft?: string }).draft).toContain('raised interest rates')
    expect((s.status('https://a.example/x') as { draft?: string }).draft).toContain('raised interest rates')
  })
  it('falls back to the search snippet when the page will not read', async () => {
    const s = new Summarizer({ apiKey: 'k', store: new SummaryStore(':memory:'), fetch: never, pageText: async () => '' })
    s.remember([{ url: 'https://b.example/x', title: 'X', host: 'b.example', description: 'The central bank raised interest rates by a quarter point on Tuesday, citing stubborn inflation.' }])
    expect(((await s.begin('https://b.example/x')) as { draft?: string }).draft).toContain('quarter point')
  })
  it('prefers the snippet to one thin line of page', async () => {
    const s = new Summarizer({ apiKey: 'k', store: new SummaryStore(':memory:'), fetch: never, pageText: async () => 'A very short line that is barely a real sentence.' })
    s.remember([{ url: 'https://d.example/x', title: 'X', host: 'd.example', description: 'The central bank raised interest rates by a quarter point on Tuesday, citing stubborn inflation that has lasted all year.' }])
    expect(((await s.begin('https://d.example/x')) as { draft?: string }).draft).toContain('quarter point')
  })
  it('does not wait on a page that hangs', async () => {
    const s = new Summarizer({ apiKey: 'k', store: new SummaryStore(':memory:'), fetch: never, pageText: () => new Promise(() => {}) })
    s.remember([{ url: 'https://c.example/x', title: 'X', host: 'c.example', description: 'd' }])
    const started = Date.now()
    await s.begin('https://c.example/x')
    expect(Date.now() - started).toBeLessThan(3_500)
  })
})
