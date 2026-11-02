import { describe, expect, it } from 'bun:test'
import { callProvider, LABELS, parsePitIndex, PRIMARY } from '../src/search.ts'
import { createApp, keysFromEnv } from '../src/server.ts'

describe('our own index as one of the engines', () => {
  it('reads nichedb search items: url, title, summary; never a non-web link', () => {
    expect(
      parsePitIndex({
        items: [
          { url: 'javascript:alert(1)', title: 'bad' },
          { url: 'https://ovens.example/pizza', title: 'Wood-fired pizza', summary: 'How to build one.' },
        ],
      }),
    ).toEqual([{ url: 'https://ovens.example/pizza', title: 'Wood-fired pizza', description: 'How to build one.', host: 'ovens.example' }])
  })

  it('asks the sites collection, with a bearer only when one is configured', async () => {
    const asked: Array<{ url: string; auth: string | null }> = []
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') })
      return Response.json({ items: [{ url: 'https://a.example/', title: 'A', summary: '' }] })
    }) as typeof fetch
    expect(await callProvider('pit', 'https://nichedb.test/', 'pizza ovens', 10, fake)).toHaveLength(1)
    await callProvider('pit', 'https://nichedb.test k1', 'x', 5, fake)
    expect(asked[0]).toEqual({ url: 'https://nichedb.test/api/v1/search?q=pizza+ovens&collection=sites&limit=10', auth: null })
    expect(asked[1]!.auth).toBe('Bearer k1')
  })

  it('is on by default, last among the primaries, and can be turned off', () => {
    expect(PRIMARY.at(-1)).toBe('pit')
    expect(LABELS.pit).toBe('pit.world index')
    expect(keysFromEnv({}).pit).toBe('https://nichedb.dev')
    expect(keysFromEnv({ PIT_INDEX_URL: 'http://127.0.0.1:3010', PIT_INDEX_KEY: 'k' }).pit).toBe('http://127.0.0.1:3010 k')
    expect(keysFromEnv({ PIT_INDEX_URL: 'off' }).pit).toBeUndefined()
  })

  it('/bot says who pitbot is and how to keep it out', async () => {
    const app = createApp({ keys: {} })
    const page = await (await app.request('/bot')).text()
    expect(page).toContain('User-agent: pitbot')
    expect(page).toContain('nichedb.dev/c/sites')
    expect(await (await app.request('/privacy')).text()).toContain('href="/bot"')
  })
})
