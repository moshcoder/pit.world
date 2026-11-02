import { describe, expect, it } from 'bun:test'
import { makeSnippet, queryTerms, SNIPPET_MAX } from '../src/snippet.ts'
import { mergeResults, search } from '../src/search.ts'

const DUMP =
  'Pricing Plans | Acme SaaS Skip to content Search for: Home Features Pricing Blog Login Sign up ' +
  'Acme is a project tool for small teams. We use cookies to improve your experience. Accept all cookies ' +
  'Our pricing is simple. SaaS pricing starts at $9 per user per month, with a free tier for up to three users. ' +
  'Annual billing saves 20 percent on every plan. Enterprise customers get SSO, audit logs and a dedicated manager. ' +
  'Read more about our story and the team behind the product, our investors, our offices in four countries, ' +
  'our careers page with open roles in engineering, design, sales and support, and our press kit. '.repeat(6)

describe('makeSnippet', () => {
  it('turns a page dump into a short, query-biased snippet', () => {
    const s = makeSnippet(DUMP, { title: 'Pricing Plans | Acme SaaS', query: 'saas pricing' })
    expect(s.length).toBeLessThanOrEqual(SNIPPET_MAX + 1)
    expect(s.length).toBeGreaterThan(80)
    expect(s).toContain('SaaS pricing starts at $9')
    expect(s).not.toMatch(/skip to content|search for|cookies/i)
    expect(s.startsWith('Pricing Plans')).toBe(false)
  })

  it('ends on a word boundary with an ellipsis when it cuts', () => {
    const long = 'word '.repeat(200).trim()
    const s = makeSnippet(long, { query: 'nothing' })
    expect(s.endsWith('…')).toBe(true)
    expect(s.slice(0, -1).endsWith('word')).toBe(true)
  })

  it('leaves a short snippet alone apart from whitespace and markup', () => {
    expect(makeSnippet('  Rust is a   <b>fast</b> language.  ', { title: 'Rust', query: 'rust' })).toBe('Rust is a fast language.')
  })

  it('strips a leading repeat of the title', () => {
    expect(makeSnippet('Rust Programming Language Rust Programming Language A language empowering everyone to build reliable software.', { title: 'Rust Programming Language' })).toBe(
      'A language empowering everyone to build reliable software.',
    )
  })

  it('never invents text: empty in, empty out', () => {
    expect(makeSnippet('', { title: 'x', query: 'y' })).toBe('')
    expect(makeSnippet('Skip to content', { title: 'x' })).toBe('')
  })

  it('drops markdown syntax from engines that answer in markdown', () => {
    const s = makeSnippet('# Climate change\n\n![chart](https://x/y.png) **Climate change** is the long-term shift in [temperatures](https://x/t) and weather patterns.', { query: 'climate change' })
    expect(s).toBe('Climate change is the long-term shift in temperatures and weather patterns.')
  })

  it('query terms skip stop words and repeats', () => {
    expect(queryTerms('What is the Rust rust programming language?')).toEqual(['rust', 'programming', 'language'])
  })
})

describe('search results carry snippets, not dumps', () => {
  it('cuts the merged (longest) description to a snippet and hands the full text to onText first', async () => {
    const fake = (async () => Response.json({ results: [{ url: 'https://acme.example/pricing', title: 'Pricing Plans | Acme SaaS', text: DUMP }] })) as unknown as typeof fetch
    let seen = 0
    const result = await search('saas pricing', { exa: 'k' }, { fetch: fake, onText: (hits) => (seen = hits[0]!.description.length) })
    expect(seen).toBe(DUMP.trim().length)
    expect(result.hits[0]!.description.length).toBeLessThanOrEqual(SNIPPET_MAX + 1)
    expect(result.hits[0]!.description).toContain('SaaS pricing')
  })

  it('merge still keeps the longest text, so the snippet has the most to choose from', () => {
    const hits = mergeResults(
      [
        { provider: 'serper', hits: [{ url: 'https://a.example/', title: 'A', description: 'short', host: 'a.example' }] },
        { provider: 'exa', hits: [{ url: 'https://a.example/', title: 'A', description: 'a much longer text', host: 'a.example' }] },
      ],
      10,
    )
    expect(hits[0]!.description).toBe('a much longer text')
  })
})

describe('makeSnippet page chrome', () => {
  it('drops a long title repeated after a breadcrumb, with or without its site suffix', () => {
    const s = makeSnippet('Pricing & Positioning [Report] 2023 State of SaaS Pricing: How Leaders Win If you cast your mind back a decade, most SaaS companies treated pricing as an afterthought.', {
      title: '[Report] 2023 State of SaaS Pricing: How Leaders Win - OpenView',
      query: 'saas pricing',
    })
    expect(s).not.toContain('[Report]')
    expect(s).toContain('If you cast your mind back')
  })
})
