import { describe, expect, it } from 'bun:test'
import { directoryKeys, enrichNicheDb } from '../src/nichedb.ts'

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

  it('looks a Moshpit-only name up by its relay host and a subdomain by its company domain', async () => {
    expect(directoryKeys('acme.com')).toEqual(['acme.com'])
    expect(directoryKeys('family.ancestry', true)).toEqual(['family.ancestry', 'family.ancestry.pit.world'])
    expect(directoryKeys('trialstack.davidts.ai')).toEqual(['trialstack.davidts.ai', 'davidts.ai'])
    expect(directoryKeys('shop.acme.co.uk')).toEqual(['shop.acme.co.uk', 'acme.co.uk'])
    expect(directoryKeys('acme.co.uk')).toEqual(['acme.co.uk'])
    expect(directoryKeys('seo.rank.pit.world', true)).toEqual(['seo.rank.pit.world'])

    const attached = new Map<string, unknown>()
    const queries: string[] = []
    const records: Record<string, string> = {
      'family.ancestry.pit.world': 'https://nichedb.dev/i/10',
      'davidts.ai': 'https://nichedb.dev/i/11',
    }
    const listings = {
      directoryDomains: () => ['family.ancestry', 'trialstack.davidts.ai'],
      needsWebResearchRefresh: () => true,
      toPublic: (domain: string) => ({ moshpitOnly: domain === 'family.ancestry' }) as never,
      enrichWebResearch: (domain: string, data: unknown) => {
        attached.set(domain, data)
        return true
      },
    }
    const fetchImpl = async (input: URL) => {
      const q = new URL(String(input)).searchParams.get('q') ?? ''
      queries.push(q)
      const page = records[q]
      const items = page ? [{ kind: 'company', url: `https://${q}`, page, data: { row: { kind: 'company', topics: ['software'] } } }] : []
      return new Response(JSON.stringify({ items }), { status: 200 })
    }
    expect(await enrichNicheDb(listings, fetchImpl, 1)).toEqual({ checked: 2, matched: 2, unmatched: 0, failed: 0 })
    expect(queries).toEqual(['family.ancestry', 'family.ancestry.pit.world', 'trialstack.davidts.ai', 'davidts.ai'])
    expect(attached.get('family.ancestry')).toEqual({ topics: ['software'], sourceUrl: 'https://nichedb.dev/i/10' })
    expect(attached.get('trialstack.davidts.ai')).toEqual({ topics: ['software'], sourceUrl: 'https://nichedb.dev/i/11' })
  })
})
