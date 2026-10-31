import { describe, expect, test } from 'bun:test'
import { parseCompanyHomepage } from '../src/company-metadata.ts'
import { Listings } from '../src/listings.ts'
import { enrichOfficialCompanySites } from '../src/official-company-sites.ts'

const domain = 'company.example'
const html = `<html><a href="/contact">Contact</a><a href="/team">Leadership</a><a href="mailto:sales@company.example">Sales</a>
<a href="mailto:ceo@company.example">Do not import individual</a>
<a href="https://www.linkedin.com/company/example-company/">LinkedIn</a>
<script type="application/ld+json">{"@type":"Organization","url":"https://company.example","telephone":"+1 (555) 555-1212"}</script></html>`

describe('official company metadata', () => {
  test('extracts same-domain public business contact, team page, corporate social link, with attribution', () => {
    expect(parseCompanyHomepage(html, domain)).toEqual({
      contactUrl: 'https://company.example/contact',
      teamUrl: 'https://company.example/team',
      email: 'sales@company.example',
      phone: '+1 (555) 555-1212',
      socialUrls: ['https://www.linkedin.com/company/example-company/'],
      sourceUrl: 'https://company.example/',
    })
  })

  test('never imports private email, off-domain links or misleading structured data', () => {
    const page = `<a href="mailto:person@company.example">person</a><a href="https://evil.example/contact">contact</a>
<a href="https://linkedin.com/in/person">profile</a>
<script type="application/ld+json">{"@type":"Organization","url":"https://evil.example","telephone":"999 999 9999"}</script>`
    const facts = parseCompanyHomepage(page, domain)
    expect(facts?.email).toBe('')
    expect(facts?.phone).toBe('')
    expect(facts?.contactUrl).toBe('')
    expect(facts?.socialUrls).toEqual([])
  })

  test('enrichment never overwrites owner-controlled fields or claimed listings', async () => {
    const store = new Listings(':memory:', {
      txt: async () => [], homepage: async () => html,
    })
    store.seed({ domain, name: 'Example Company', phone: 'official-seed-number', category: 'industrial' })
    const results = await enrichOfficialCompanySites(store, 1)
    expect(results).toEqual({ checked: 1, enriched: 1, failed: 0 })
    const item = store.toPublic(domain)!
    expect(item.phone).toBe('official-seed-number')
    expect(item.publicMetadata?.email).toBe('sales@company.example')
    expect(item.publicMetadata?.teamUrl).toBe('https://company.example/team')
    expect(await enrichOfficialCompanySites(store, 1)).toEqual({ checked: 0, enriched: 0, failed: 0 })
    const claim = store.startClaim(domain)!
    const verified = new Listings(':memory:', {
      txt: async () => [claim.token], homepage: async () => html,
    })
    // The owner takes over the same listing; enrichment does not publish stale unclaimed facts.
    verified.seed({domain, name: 'Example Company'})
    const initiated = verified.startClaim(domain)!
    // Fake verifier's TXT response is set above; ownership is proven through that challenge.
    expect((await verified.verify(initiated.claimId)).ok).toBe(true)
    expect(verified.toPublic(domain)?.publicMetadata).toBeNull()
  })
})
