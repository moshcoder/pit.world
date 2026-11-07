import { describe, expect, it } from 'bun:test'
import { createApp } from '../src/server.ts'
import { ALL_LANGUAGES, LANGUAGES, detectLanguage, inLanguage, parseLanguage } from '../src/language.ts'
import { search } from '../src/search.ts'

const EN = { title: 'Trump says the Iran war will be over very soon', summary: 'The president told reporters that the conflict would end after the election.' }
const TR = { title: 'Trump: İran ile savaş yakında bitecek, petrol fiyatları düşecek', summary: 'ABD Başkanı Trump, İran ile savaşın çok yakında biteceğini söyledi ve açıklamalarda bulundu.' }

describe('detectLanguage', () => {
  it('tells real headlines apart', () => {
    expect(detectLanguage(`${EN.title} ${EN.summary}`)).toBe('en')
    expect(detectLanguage(`${TR.title} ${TR.summary}`)).toBe('tr')
  })
  it('has no opinion on short text', () => expect(detectLanguage('Iran')).toBeNull())
  it('offers only languages it can name', () => {
    const samples: Record<string, string> = {
      es: 'El presidente dijo a los periodistas que la guerra terminaría muy pronto después de las elecciones.',
      fr: 'Le président a déclaré aux journalistes que la guerre se terminerait très bientôt après les élections.',
      de: 'Der Präsident sagte den Journalisten, dass der Krieg sehr bald nach den Wahlen zu Ende gehen werde.',
      ru: 'Президент заявил журналистам, что война закончится очень скоро после выборов в этой стране.',
      zh: '总统告诉记者，这场战争将在选举之后很快结束，人们对此感到非常高兴和期待。',
      ja: '大統領は記者団に対し、戦争は選挙の後にすぐ終わるだろうと述べ、多くの人々が期待している。',
      ko: '대통령은 기자들에게 전쟁이 선거 후에 곧 끝날 것이라고 말했으며 많은 사람들이 기대하고 있다.',
      ar: 'قال الرئيس للصحفيين إن الحرب ستنتهي قريبا جدا بعد الانتخابات في هذا البلد الكبير.',
    }
    for (const [code, text] of Object.entries(samples)) expect(detectLanguage(text)).toBe(code)
    expect(LANGUAGES.every((l) => l.code.length === 2)).toBe(true)
  })
})

describe('inLanguage', () => {
  const rows = [EN, TR, { title: 'Iran', summary: '' }]
  const text = (r: typeof EN) => `${r.title} ${r.summary}`
  it('hides only what is confidently another language', () => {
    const out = inLanguage(rows, 'en', text)
    expect(out.rows.map((r) => r.title)).toEqual([EN.title, 'Iran'])
    expect(out.hidden).toBe(1)
  })
  it('never empties a page', () => {
    const out = inLanguage([TR], 'en', text)
    expect(out.rows).toEqual([TR])
    expect(out.fellBack).toBe(true)
  })
  it('any means any', () => expect(inLanguage(rows, ALL_LANGUAGES, text).hidden).toBe(0))
})

it('parseLanguage refuses what we do not offer', () => {
  expect(parseLanguage(undefined)).toBe('en')
  expect(parseLanguage('xx')).toBe('en')
  expect(parseLanguage('tr')).toBe('tr')
  expect(parseLanguage('any')).toBe('any')
  expect(parseLanguage('xx', 'any')).toBe('any')
  expect(parseLanguage('<script>')).toBe('en')
})

function pit(posts = [EN, TR].map((p, i) => ({ ...p, url: `https://n${i}.example/story`, blog: 'A paper' }))) {
  const asked: string[] = []
  const fake = (async (url: string | URL | Request) => {
    const u = String(url)
    asked.push(u)
    if (u.includes('rssamplifier.com/api/search')) return Response.json({ posts })
    return Response.json({})
  }) as typeof fetch
  const app = createApp({ keys: { pit: 'http://index.test' }, fetch: fake, fingerprintSecret: 'a-test-secret-long-enough', resolve: async () => ['93.184.216.34'] } as never)
  return { request: (path: string) => app.request(path, {}, { ip: '203.0.113.7' }), asked }
}

describe('results', () => {
  it('default to English, and say what was hidden', async () => {
    const html = await (await pit().request('/search?q=iran&t=news')).text()
    expect(html).toContain('n0.example/story')
    expect(html).not.toContain('n1.example/story')
    expect(html).toContain('1 in other languages hidden')
    expect(html).toContain('lang=any')
  })
  it('follow the setting, on tabs and the next search too', async () => {
    const html = await (await pit().request('/search?q=iran&t=news&lang=tr')).text()
    expect(html).toContain('n1.example/story')
    expect(html).not.toContain('n0.example/story')
    expect(html).toContain('<input type="hidden" name="lang" value="tr">')
    expect(html).toContain('/search?q=iran&t=blogs&lang=tr')
  })
  it('show everything when asked', async () => {
    const html = await (await pit().request('/search?q=iran&t=news&lang=any')).text()
    expect(html).toContain('n0.example/story')
    expect(html).toContain('n1.example/story')
  })
  it('in a language with nothing, say so rather than go blank', async () => {
    const { request } = pit([{ ...TR, url: 'https://n1.example/story', blog: 'A paper' }])
    const html = await (await request('/search?q=iran&t=news')).text()
    expect(html).toContain('n1.example/story')
    expect(html).toContain('Nothing in English for this search')
  })
  it('the API filters only when asked', async () => {
    const { request } = pit()
    expect((await (await request('/api/search?q=iran&t=news')).json()).results).toHaveLength(2)
    expect((await (await request('/api/search?q=iran&t=news&lang=en')).json()).results).toHaveLength(1)
  })
})

it('tells SearXNG the language, and caches each language apart', async () => {
  const asked: string[] = []
  const fake = (async (u: string) => (asked.push(u), Response.json({ results: [{ url: 'https://a.example/', title: 'A', content: 'B' }] }))) as never
  const { Cache } = await import('../src/search.ts')
  const cache = new Cache()
  await search('iran', { searxng: 'http://127.0.0.1:1' } as never, { fetch: fake, lang: 'en', cache })
  await search('iran', { searxng: 'http://127.0.0.1:1' } as never, { fetch: fake, lang: 'fr', cache })
  expect(asked[0]).toContain('language=en')
  expect(asked[1]).toContain('language=fr')
})

it('/settings offers every language and sets no cookie', async () => {
  const res = await pit().request('/settings')
  const html = await res.text()
  for (const l of LANGUAGES) expect(html).toContain(`value="${l.code}"`)
  expect(html).toContain('All languages')
  expect(res.headers.get('set-cookie')).toBeNull()
})

it('app.js parses: a slip here takes every script on the site with it', async () => {
  const source = await Bun.file('public/app.js').text()
  expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(source)).not.toThrow()
  // Bun's parser and a browser's disagree on some of this, so ask a real engine too.
  expect(() => new Function(source)).not.toThrow()
})
