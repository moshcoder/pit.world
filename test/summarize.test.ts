import { describe, expect, it } from 'bun:test'
import { c0mputeChat, cleanSummary, fetchPageText, htmlText, readStream, Summarizer, summaryKey } from '../src/summarize.ts'
import { createApp } from '../src/server.ts'
import { Cache } from '../src/search.ts'

function sse(events: Array<[string, unknown]>): Response {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}

/** A fake Infernet: records what it was sent, answers from a peer node. */
function infernet(sent: any[], options: { source?: string; noModel?: boolean; summary?: string } = {}) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/chat')) {
      const body = JSON.parse(String(init?.body))
      sent.push({ body, auth: new Headers(init?.headers).get('authorization') })
      if (options.noModel && body.modelName) return Response.json({ error: 'No live node serves it' }, { status: 503 })
      return Response.json({ jobId: 'job-1', source: options.source ?? 'p2p', model: null })
    }
    if (url.includes('/api/chat/stream/job-1')) {
      return sse([
        ['meta', { model: 'qwen2.5:7b' }],
        ['token', { text: 'ignored' }],
        ['done', { text: options.summary ?? 'Summary: Acme sells a **project tool** for small teams. Plans start at $9 a user.' }],
      ])
    }
    return new Response('nope', { status: 404 })
  }) as typeof fetch
}

describe('c0mpute client', () => {
  it('sends p2p_only, the trusted key and the model, and reads the stream', async () => {
    const sent: any[] = []
    const r = await c0mputeChat('sys', 'user', { apiKey: 'ifc_x', model: 'qwen2.5:7b', fetch: infernet(sent) })
    expect(sent[0].body).toMatchObject({ p2p_only: true, modelName: 'qwen2.5:7b' })
    expect(sent[0].auth).toBe('Bearer ifc_x')
    expect(r.model).toBe('qwen2.5:7b')
  })

  it('takes any node when none serves the preferred model', async () => {
    const sent: any[] = []
    await c0mputeChat('s', 'u', { model: 'qwen2.5:7b', fetch: infernet(sent, { noModel: true }) })
    expect(sent.map((s) => s.body.modelName)).toEqual(['qwen2.5:7b', undefined])
  })

  it('refuses an answer from the billed hosted fallback', async () => {
    await expect(c0mputeChat('s', 'u', { fetch: infernet([], { source: 'nim' }) })).rejects.toThrow('no c0mpute node')
  })

  it('reads tokens when done carries no text, and fails on error events', async () => {
    expect((await readStream(sse([['token', { text: 'a' }], ['token', { text: 'b' }], ['done', {}]]).body!)).text).toBe('ab')
    await expect(readStream(sse([['error', { message: 'node died' }]]).body!)).rejects.toThrow('node died')
    await expect(readStream(sse([['token', { text: 'a' }]]).body!)).rejects.toThrow('before the answer finished')
  })
})

describe('summaries', () => {
  it('tidies a model answer', () => {
    expect(cleanSummary('Summary: **Acme** sells   tools.')).toBe('Acme sells tools.')
    expect(cleanSummary('<think>hmm</think>Here is a summary: It works.')).toBe('It works.')
    expect(cleanSummary('NO SUMMARY')).toBe('')
  })

  it('reads the visible text of a page', () => {
    expect(htmlText('<title>T</title><nav>menu</nav><script>x()</script><p>Body &amp; soul</p><footer>f</footer>')).toBe('T Body & soul')
  })

  it('normalizes the cache key', () => {
    expect(summaryKey('https://www.Acme.example/pricing/#top')).toBe(summaryKey('http://acme.example/pricing'))
  })

  it('summarizes only known results, sends page text but never the query, and caches', async () => {
    const sent: any[] = []
    const s = new Summarizer({ apiKey: 'ifc_x', fetch: infernet(sent), pageText: async () => '' })
    const url = 'https://acme.example/pricing'
    expect(s.known(url)).toBe(false)
    s.remember([{ url, title: 'Pricing | Acme', description: 'Acme is a project tool for small teams. '.repeat(30), host: 'acme.example' }])
    expect(s.known(url)).toBe(true)
    const done = await s.wait(url)
    expect(done).toMatchObject({ status: 'done', summary: 'Acme sells a project tool for small teams. Plans start at $9 a user.', model: 'qwen2.5:7b' })
    expect(JSON.stringify(sent[0].body)).toContain('project tool')
    expect(JSON.stringify(sent[0].body)).not.toContain('saas pricing')
    // Second time: from the store, no new job.
    expect(s.start(url).status).toBe('done')
    expect(sent).toHaveLength(1)
  })

  it('reads the page itself when the engines gave too little text', async () => {
    let fetched = ''
    const s = new Summarizer({ apiKey: 'k', fetch: infernet([]), pageText: async (u) => ((fetched = u), 'A long page about pricing plans and features. '.repeat(10)) })
    s.remember([{ url: 'https://thin.example/', title: 'Thin', description: '', host: 'thin.example' }])
    expect((await s.wait('https://thin.example/')).status).toBe('done')
    expect(fetched).toBe('https://thin.example/')
  })

  it('reports a failure (not a hang) when c0mpute is down', async () => {
    const down = (async () => new Response('x', { status: 502 })) as unknown as typeof fetch
    const s = new Summarizer({ apiKey: 'k', fetch: down, pageText: async () => '' })
    s.remember([{ url: 'https://a.example/', title: 'A', description: 'Plenty of text about the page here. '.repeat(20), host: 'a.example' }])
    const r = await s.wait('https://a.example/')
    expect(r.status).toBe('failed')
  })

  it('never fetches a private address', async () => {
    let asked = false
    const f = (async () => ((asked = true), new Response('x'))) as unknown as typeof fetch
    expect(await fetchPageText('http://internal.example/', f, async () => ['10.0.0.5'])).toBe('')
    expect(await fetchPageText('http://127.0.0.1:8787/', f, async () => ['127.0.0.1'])).toBe('')
    expect(asked).toBe(false)
  })
})

describe('/api/summarize', () => {
  const url = 'https://acme.example/pricing'
  const app = (limits = { anon: 2, signedIn: 5, anonTotal: 100 }) => {
    const summarizer = new Summarizer({ apiKey: 'ifc_x', fetch: infernet([]), pageText: async () => '' })
    summarizer.remember([{ url, title: 'Acme', description: 'Acme is a project tool for small teams. '.repeat(30), host: 'acme.example' }])
    for (let i = 0; i < 5; i++) summarizer.remember([{ url: `https://acme.example/p${i}`, title: 'Acme', description: 'Acme is a project tool for small teams. '.repeat(30), host: 'acme.example' }])
    return { summarizer, app: createApp({ keys: {}, cache: new Cache(), summarizer, summaryLimits: limits }) }
  }
  const post = (a: ReturnType<typeof createApp>, u: string, ip = '1.2.3.4') =>
    a.request('/api/summarize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: u }) }, { ip })

  it('starts a job (202), then GET returns the summary', async () => {
    const { app: a, summarizer } = app()
    const r = await post(a, url)
    expect(r.status).toBe(202)
    expect((await r.json()).status).toBe('pending')
    await summarizer.wait(url)
    const g = await a.request(`/api/summarize?url=${encodeURIComponent(url)}`, {}, { ip: '1.2.3.4' })
    expect(await g.json()).toMatchObject({ status: 'done', cached: true })
  })

  it('refuses a URL pit.world did not return', async () => {
    const { app: a } = app()
    const r = await post(a, 'http://169.254.169.254/latest/meta-data')
    expect(r.status).toBe(404)
  })

  it('throttles anonymous visitors per address, says to sign in, and cached summaries cost nothing', async () => {
    const { app: a, summarizer } = app()
    expect((await post(a, `https://acme.example/p0`)).status).toBe(202)
    expect((await post(a, `https://acme.example/p1`)).status).toBe(202)
    const limited = await post(a, `https://acme.example/p2`)
    expect(limited.status).toBe(429)
    const body = await limited.json()
    expect(body.signIn).toBe('/signin')
    expect(body.error).toMatch(/Sign in/)
    // Another address has its own allowance.
    expect((await post(a, `https://acme.example/p2`, '5.6.7.8')).status).toBe(202)
    // A finished summary is free even when over the limit.
    await summarizer.wait('https://acme.example/p0')
    expect((await post(a, `https://acme.example/p0`)).status).toBe(200)
  })

  it('is off without a c0mpute key', async () => {
    const a = createApp({ keys: {}, summarizer: new Summarizer({}) })
    expect((await post(a, url)).status).toBe(503)
  })

  it('the results page shows the Summarize button only when summaries are on', async () => {
    const fake = (async () => Response.json({ results: [{ url, title: 'Acme', text: 'Acme is a project tool.' }] })) as unknown as typeof fetch
    const { summarizer } = app()
    const on = createApp({ keys: { exa: 'k' }, fetch: fake, summarizer, network: { has: () => false } as any, promoted: { for: async () => [] } as any })
    expect(await (await on.request('/search?q=acme', {}, { ip: '9.9.9.9' })).text()).toContain('class="summarize"')
    const off = createApp({ keys: { exa: 'k' }, fetch: fake, network: { has: () => false } as any, promoted: { for: async () => [] } as any })
    expect(await (await off.request('/search?q=acme', {}, { ip: '9.9.9.9' })).text()).not.toContain('class="summarize"')
  })
})
