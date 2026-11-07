import { describe, expect, it } from 'bun:test'
import { bookCard, parseLookup, runLookup, vinCard } from '../src/lookups.ts'
import { createApp } from '../src/server.ts'

const BOOK = { isbn: { isbn10: '0140328726', isbn13: '9780140328721' }, title: 'Fantastic Mr. Fox', edition: { title: 'Fantastic Mr. Fox', authors: ['Roald Dahl'], publishers: ['Puffin'], publishDate: 'October 1, 1988', pages: 96, cover: 'https://covers.openlibrary.org/b/id/1-M.jpg' }, online: [{ vendor: 'Amazon', url: 'https://www.amazon.com/dp/x?tag=parklookup-20' }] }
const VIN = { vin: '1HGCM82633A004352', valid: true, modelYear: 2003, make: 'HONDA', model: 'Accord', bodyClass: 'Coupe', decoded: { Trim: 'EX-V6', Doors: '2', EngineHP: '240', DisplacementL: '2.998832712', EngineCylinders: '6', FuelTypePrimary: 'Gasoline', PlantCountry: 'UNITED STATES (USA)' } }

describe('reading a lookup out of the search box', () => {
  it('takes either kind, however it was typed', () => {
    expect(parseLookup('isbn:9798162954880')).toEqual({ kind: 'isbn', value: '9798162954880' })
    expect(parseLookup('ISBN: 979-8-16-295488-0')).toEqual({ kind: 'isbn', value: '9798162954880' })
    expect(parseLookup('isbn:080442957x')).toEqual({ kind: 'isbn', value: '080442957X' })
    expect(parseLookup('vin:1hgcm82633a004352')).toEqual({ kind: 'vin', value: '1HGCM82633A004352' })
  })
  it('leaves everything else alone', () => {
    for (const q of ['isbn', 'vin', 'what is a vin', 'isbn:', 'isbn: hello', 'isbn lookup 978', 'vin: diesel engine']) expect(parseLookup(q)).toBeNull()
  })
})

describe('the cards', () => {
  it('a book says what it is', () => {
    const c = bookCard('9780140328721', BOOK)
    expect(c.title).toBe('Fantastic Mr. Fox')
    expect(c.lines).toContain('Roald Dahl')
    expect(c.lines).toContain('Puffin · October 1, 1988 · 96 pages')
    expect(c.url).toBe('https://nichedb.dev/isbn/9780140328721')
  })
  it('a book no catalogue has says that, with what the number tells us', () => {
    const c = bookCard('9798162954880', { isbn: { isbn13: '9798162954880', isbn10: null }, edition: null, facts: { registeredIn: 'United States', selfPublishingLikely: true } })
    expect(c.title).toBe('ISBN 9798162954880')
    expect(c.lines.join(' ')).toContain('No catalogue')
    expect(c.lines.join(' ')).toContain('Registered in United States')
  })
  it('a car reads like a car', () => {
    const c = vinCard(VIN.vin, VIN)
    expect(c.title).toBe('2003 Honda Accord EX-V6')
    expect(c.lines).toContain('3.0 L · 6 cylinders · 240 hp · Gasoline')
    expect(c.lines).toContain('Built in United States')
    expect(c.url).toBe('https://nichedb.dev/vin?vin=1HGCM82633A004352')
  })
  it('a bad VIN says why', () => {
    expect(vinCard('BAD', { vin: 'BAD', valid: false, error: 'A VIN is 17 characters' }).invalid).toBe('A VIN is 17 characters')
  })
})

describe('asking nichedb', () => {
  it('sends the key when there is one', async () => {
    const auth: Array<string | null> = []
    await runLookup({ kind: 'vin', value: VIN.vin }, { key: 'k', fetch: (async (_u: unknown, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get('authorization'))
      return Response.json(VIN)
    }) as unknown as typeof fetch })
    expect(auth).toEqual(['Bearer k'])
  })
  it('a failure is a card with a link, never an exception', async () => {
    const quota = await runLookup({ kind: 'vin', value: VIN.vin }, { fetch: (async () => Response.json({ error: 'allowance' }, { status: 402 })) as unknown as typeof fetch })
    expect(quota.unavailable).toBe(true)
    expect(quota.url).toContain('nichedb.dev/vin')
    const down = await runLookup({ kind: 'isbn', value: '9780140328721' }, { fetch: (async () => { throw new Error('down') }) as unknown as typeof fetch })
    expect(down.unavailable).toBe(true)
  })
  it('a 400 means the number is wrong', async () => {
    const c = await runLookup({ kind: 'isbn', value: '9780000000000' }, { fetch: (async () => Response.json({ error: 'Check digit' }, { status: 400 })) as unknown as typeof fetch })
    expect(c.invalid).toBe('Check digit')
  })
})

describe('in the search page', () => {
  function site(body: unknown) {
    const asked: string[] = []
    const app = createApp({
      keys: { pit: 'http://index.test' },
      fingerprintSecret: 'a-test-secret-long-enough',
      fetch: (async (url: string | URL | Request) => {
        asked.push(String(url))
        return String(url).includes('nichedb.dev') ? Response.json(body) : Response.json({ items: [{ url: 'https://a.example/', title: 'A web result', site: 'a.example', summary: 'x' }] })
      }) as typeof fetch,
    } as never)
    return { asked, request: (path: string) => app.request(path, {}, { ip: '203.0.113.7' }) }
  }

  it('shows the card above the results, and searches the web for the bare number', async () => {
    const { request, asked } = site(BOOK)
    const html = await (await request('/search?q=isbn%3A9780140328721')).text()
    expect(html).toContain('Fantastic Mr. Fox')
    expect(html).toContain('Roald Dahl')
    expect(html.indexOf('Fantastic Mr. Fox')).toBeLessThan(html.indexOf('A web result'))
    expect(asked.some((u) => u.includes('/api/v1/search') && u.includes('q=9780140328721'))).toBe(true)
    expect(asked.every((u) => !u.includes('/api/v1/search') || !u.includes('isbn'))).toBe(true)
    // Sellers stay on nichedb, with its affiliate tags.
    expect(html).not.toContain('parklookup-20')
  })
  it('a car too, with a stranger’s text escaped', async () => {
    const { request } = site({ ...VIN, model: '<b>Accord</b>' })
    const html = await (await request('/search?q=vin%3A1HGCM82633A004352')).text()
    expect(html).toContain('2003 Honda &lt;b&gt;Accord&lt;/b&gt;')
    expect(html).not.toContain('<b>Accord</b>')
  })
  it('the JSON search carries it as well', async () => {
    const { request } = site(VIN)
    const body = (await (await request('/api/search?q=vin%3A1HGCM82633A004352')).json()) as { lookup: { title: string } }
    expect(body.lookup.title).toBe('2003 Honda Accord EX-V6')
  })
})
