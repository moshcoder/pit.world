import { describe, expect, it } from 'bun:test'
import { enrichNicheDb } from '../src/nichedb.ts'

describe('NicheDB company enrichment', () => {
  it('attaches only an exact-domain company record and its public attribution page', async () => {
    const attached = new Map<string, { topics?: unknown; sourceUrl?: unknown }>()
    const listings = {
      directoryDomains: () => ['acme-builders.com', 'missing.example'],
      needsWebResearchRefresh: () => true,
      enrichWebResearch: (domain: string, data: { topics?: unknown; sourceUrl?: unknown }) => {
        attached.set(domain, data)
        return true
      },
    }
    const fetchImpl = async (input: URL) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://nichedb.dev')
      const domain = url.searchParams.get('q')
      const items = domain === 'acme-builders.com'
        ? [
            { kind: 'company', url: 'https://acme-builders.net', page: 'https://nichedb.dev/i/1', data: { row: { kind: 'company', topics: ['wrong domain'] } } },
            { kind: 'site', url: 'https://acme-builders.com', page: 'https://nichedb.dev/i/2', data: { row: { kind: 'site', topics: ['not a company'] } } },
            { kind: 'company', url: 'https://acme-builders.com', page: 'https://nichedb.dev/i/3', data: { row: { kind: 'company', topics: ['construction & remodeling', 'wordpress'] } } },
          ]
        : []
      return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const result = await enrichNicheDb(listings, fetchImpl, 2)
    expect(result).toEqual({ checked: 2, matched: 1, unmatched: 1, failed: 0 })
    expect(attached.get('acme-builders.com')).toEqual({
      topics: ['construction & remodeling', 'wordpress'],
      sourceUrl: 'https://nichedb.dev/i/3',
    })
    expect(attached.has('missing.example')).toBe(false)
  })

  it('skips fresh records unless forced', async () => {
    const queries: string[] = []
    const listings = {
      directoryDomains: () => ['fresh.example'],
      needsWebResearchRefresh: () => false,
      enrichWebResearch: () => true,
    }
    const fetchImpl = async (input: URL) => {
      queries.push(new URL(String(input)).searchParams.get('q') ?? '')
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    }
    expect(await enrichNicheDb(listings, fetchImpl)).toEqual({ checked: 0, matched: 0, unmatched: 0, failed: 0 })
    expect(await enrichNicheDb(listings, fetchImpl, 2, true)).toEqual({ checked: 1, matched: 0, unmatched: 1, failed: 0 })
    expect(queries).toEqual(['fresh.example'])
  })
})
