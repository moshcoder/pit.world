import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'node:os'
import { c0mputeChat, forgetStalledModels, pickModel, cleanSummary, fetchPageText, htmlText, readPage, readStream, relayPageText, Summarizer, SummaryStore, summaryKey } from '../src/summarize.ts'
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

describe('c0mpute when nodes are missing or stuck', () => {
  const done = () => sse([['meta', { model: 'qwen3:4b' }], ['done', { text: 'Fine.' }]])

  it('picks the best general model Infernet lists as live, never a fine-tune', () => {
    expect(pickModel(['hf.co/x/saas-agent', 'jaahas/qwen3.5-uncensored:2b', 'gemma3:4b', 'qwen3:4b'], 'qwen2.5:7b')).toBe('qwen3:4b')
    expect(pickModel(['qwen2.5:7b'], 'qwen2.5:7b')).toBeUndefined()
    expect(pickModel(undefined)).toBeUndefined()
  })

  it('on "no live node serves it" asks for a listed model, then any node', async () => {
    const asked: Array<string | undefined> = []
    const f = (async (input: any, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/chat')) {
        const body = JSON.parse(String(init?.body))
        asked.push(body.modelName)
        if (body.modelName) return Response.json({ error: 'No live node serves it', detail: { availableModels: ['gemma3:4b', 'qwen3:4b'] } }, { status: 503 })
        return Response.json({ jobId: 'job-1', source: 'p2p' })
      }
      return done()
    }) as typeof fetch
    const r = await c0mputeChat('s', 'u', { model: 'qwen2.5:7b', fetch: f })
    expect(asked).toEqual(['qwen2.5:7b', 'qwen3:4b', undefined])
    expect(r.text).toBe('Fine.')
  })

  it('a node that takes the job and never answers is retried once on another', async () => {
    let jobs = 0
    const f = (async (input: any, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/chat')) return Response.json({ jobId: `job-${++jobs}`, source: 'p2p' })
      if (url.endsWith('/job-1')) {
        // A stuck node: the stream stays open until the caller gives up.
        return new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener('abort', () => c.error(new Error('aborted'))) } }))
      }
      return done()
    }) as typeof fetch
    const t0 = Date.now()
    const r = await c0mputeChat('s', 'u', { fetch: f, timeoutMs: 12_000, firstTryShare: 0.25 })
    expect(r.text).toBe('Fine.')
    expect(jobs).toBe(2)
    expect(Date.now() - t0).toBeLessThan(6_000)
  })

  it('does not retry a refused key', async () => {
    let calls = 0
    const f = (async () => (calls++, Response.json({ error: 'bad key' }, { status: 401 }))) as unknown as typeof fetch
    await expect(c0mputeChat('s', 'u', { fetch: f })).rejects.toThrow('401')
    expect(calls).toBe(1)
  })

  it('drops summaries written while the page reader mixed up pages, once', () => {
    const path = `${tmpdir()}/pit-crosstalk-${process.pid}-${Date.now()}.db`
    const old = new Database(path)
    old.exec('CREATE TABLE summaries (url TEXT PRIMARY KEY, summary TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL, source TEXT)')
    old.query('INSERT INTO summaries VALUES (?, ?, ?, ?, ?)').run('before.example', 'ok', 'm', Date.UTC(2026, 10, 2, 10), 'page')
    old.query('INSERT INTO summaries VALUES (?, ?, ?, ?, ?)').run('during.example', 'wrong page', 'm', Date.UTC(2026, 10, 2, 12), 'page')
    old.close()
    const store = new SummaryStore(path)
    expect(store.get('before.example')?.summary).toBe('ok')
    expect(store.get('during.example')).toBeNull()
    // Later summaries survive a restart.
    store.set('later.example', 'right page', 'm')
    expect(new SummaryStore(path).get('later.example')?.summary).toBe('right page')
  })
})

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

describe('a node that takes the job and goes silent', () => {
  /** Infernet as it stood on 2026-11-07: one model with no node, one wedged, one working, and a list naming them all. */
  function wedged() {
    const asked: string[] = []
    const dead = new Set(['qwen2.5:7b', 'gemma3:4b', 'qwen2.5:3b'])
    const fake = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('/stream/')) {
        if (String(url).endsWith('/qwen3')) return await new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError'))))
        return new Response('event: token\ndata: {"text":"ok"}\n\nevent: done\ndata: {"text":"ok"}\n\n')
      }
      const name = JSON.parse(String(init!.body)).modelName as string
      asked.push(name)
      if (dead.has(name)) return Response.json({ detail: { availableModels: ['qwen3:4b', 'gemma3:4b', 'qwen2.5:3b', 'qwen2.5:1.5b'] } }, { status: 503 })
      return Response.json({ jobId: name.startsWith('qwen3') ? 'qwen3' : 'small', source: 'p2p', model: name })
    }) as never
    return { asked, fake }
  }

  it('moves on to a model that answers, and goes straight there next time', async () => {
    forgetStalledModels()
    const { asked, fake } = wedged()
    const first = await c0mputeChat('s', 'u', { model: 'qwen2.5:7b', fetch: fake, timeoutMs: 6_000, firstTryShare: 0.1 })
    expect(first.text).toBe('ok')
    expect(asked).toEqual(['qwen2.5:7b', 'qwen3:4b', 'qwen2.5:7b', 'gemma3:4b', 'qwen2.5:3b', 'qwen2.5:1.5b'])
    asked.length = 0
    await c0mputeChat('s', 'u', { model: 'qwen2.5:7b', fetch: fake, timeoutMs: 6_000, firstTryShare: 0.1 })
    expect(asked).not.toContain('qwen3:4b')
    forgetStalledModels()
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

  it('always summarizes the page itself, even when the snippet is long', async () => {
    const sent: any[] = []
    let fetched = ''
    const s = new Summarizer({ apiKey: 'k', fetch: infernet(sent), pageText: async (u) => ((fetched = u), 'The real page body talks about invoicing for plumbers. '.repeat(10)) })
    s.remember([{ url: 'https://long.example/', title: 'Long', description: 'An engine snippet that says something else. '.repeat(30), host: 'long.example' }])
    expect(await s.wait('https://long.example/')).toMatchObject({ status: 'done', source: 'page' })
    expect(fetched).toBe('https://long.example/')
    const user = sent[0].body.messages[1].content as string
    expect(user).toContain('invoicing for plumbers')
    expect(user).not.toContain('says something else')
  })

  it('falls back to a long snippet only when the page cannot be read, and fails on a short one', async () => {
    const s = new Summarizer({ apiKey: 'k', fetch: infernet([]), pageText: async () => '' })
    s.remember([{ url: 'https://walled.example/', title: 'Walled', description: 'Plenty of engine text about the page here. '.repeat(20), host: 'walled.example' }])
    expect(await s.wait('https://walled.example/')).toMatchObject({ status: 'done', source: 'snippet' })
    s.remember([{ url: 'https://thin.example/', title: 'Thin', description: 'Short.', host: 'thin.example' }])
    expect(await s.wait('https://thin.example/')).toMatchObject({ status: 'failed', error: 'Could not read that page to summarize it.' })
  })

  it('rewrites summaries cached before pages were always read', async () => {
    const sent: any[] = []
    const store = new SummaryStore()
    store.set('old.example', 'from the snippet', 'qwen2.5:7b')
    ;(store as any).db.exec('UPDATE summaries SET source = NULL')
    const s = new Summarizer({ apiKey: 'k', store, fetch: infernet(sent), pageText: async () => 'The page body, read for real this time around. '.repeat(5) })
    s.remember([{ url: 'https://old.example/', title: 'Old', description: '', host: 'old.example' }])
    expect(s.status('https://old.example/').status).toBe('unknown')
    expect(await s.wait('https://old.example/')).toMatchObject({ status: 'done', source: 'page' })
    expect(sent).toHaveLength(1)
  })

  it('adds the source column to a summaries database from before it', () => {
    const path = `${tmpdir()}/pit-summaries-${process.pid}-${Date.now()}.db`
    const old = new Database(path)
    old.exec('CREATE TABLE summaries (url TEXT PRIMARY KEY, summary TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL)')
    old.query('INSERT INTO summaries VALUES (?, ?, ?, ?)').run('a.example', 'old', 'm', 1)
    old.close()
    const store = new SummaryStore(path)
    expect(store.get('a.example')).toMatchObject({ summary: 'old', source: null })
    store.set('b.example', 'new', 'm')
    expect(store.get('b.example')?.source).toBe('page')
  })

  it('reads pages through the fetch_page relay, and fetches directly when the relay fails', async () => {
    const calls: string[] = []
    const relay = (ok: boolean) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        calls.push(url)
        if (url === 'https://relay.example/mcp') {
          if (!ok) return new Response('down', { status: 502 })
          const body = JSON.parse(String(init?.body))
          expect(body.params).toMatchObject({ name: 'fetch_page', arguments: { url: 'https://acme.example/', format: 'markdown' } })
          const markdown = '[Home](/) [Docs](/docs)\n# Acme invoices for plumbers\n![logo](x.png)\n## Acme sends invoices and chases late payments for small plumbing firms.\nIt costs nine dollars a month, needs no setup at all, and works from [your phone](/app) on site.\nTeams of up to forty plumbers use it to get paid in days rather than in months.\n{"engine":"obscura","url":"https://acme.example/"}'
          return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: markdown }] } })
        }
        return new Response(`<title>Acme</title><p>${'Direct page text about invoices for plumbers. '.repeat(10)}</p>`, { headers: { 'content-type': 'text/html' } })
      }) as unknown as typeof fetch
    const resolve = async () => ['93.184.216.34']
    const viaRelay = await readPage('https://acme.example/', { relayUrl: 'https://relay.example/mcp', fetch: relay(true), resolve })
    // Menus, images, short headings, link targets and the relay's status line are gone.
    expect(viaRelay).toBe(
      'Acme sends invoices and chases late payments for small plumbing firms.\nIt costs nine dollars a month, needs no setup at all, and works from your phone on site.\nTeams of up to forty plumbers use it to get paid in days rather than in months.',
    )
    expect(calls).toEqual(['https://relay.example/mcp'])
    calls.length = 0
    const direct = await readPage('https://acme.example/', { relayUrl: 'https://relay.example/mcp', fetch: relay(false), resolve })
    expect(direct).toContain('Direct page text about invoices')
    expect(calls).toEqual(['https://relay.example/mcp', 'https://acme.example/'])
  })

  it('drops a bot check, and never sends a private address to the relay', async () => {
    let asked = false
    const wall = (async () => ((asked = true), Response.json({ result: { content: [{ type: 'text', text: 'Just a moment... checking that your browser is a real one, please wait.' }] } }))) as unknown as typeof fetch
    expect(await relayPageText('https://walled.example/', { relayUrl: 'https://relay.example/mcp', fetch: wall, resolve: async () => ['93.184.216.34'] })).toBe('')
    asked = false
    expect(await relayPageText('http://internal.example/', { relayUrl: 'https://relay.example/mcp', fetch: wall, resolve: async () => ['10.0.0.5'] })).toBe('')
    expect(asked).toBe(false)
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
