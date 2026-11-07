import { describe, expect, it } from 'bun:test'
import { createApp } from '../src/server.ts'

function site(answer: () => Response) {
  const asked: string[] = []
  const app = createApp({
    keys: { pit: 'http://index.test' },
    fingerprintSecret: 'a-test-secret-long-enough',
    fetch: (async (url: string | URL | Request) => {
      asked.push(String(url))
      return answer()
    }) as typeof fetch,
  } as never)
  return { asked, request: (path: string) => app.request(path, {}, { ip: '203.0.113.7' }) }
}

const POSTS = {
  unavailable: false,
  items: [
    { url: 'https://bsky.app/profile/ann/post/1', title: 'Rust is <b>nice</b>', host: 'Bluesky', author: '@ann', date: '2026-11-06', extra: '2 likes, 1 reply' },
    { url: 'https://bbs.hqtui.com/t/a-1/p/2', title: 'On a board', host: 'bbs.hqtui.com', description: 'words' },
    { url: 'javascript:alert(1)', title: 'A bad link', host: 'evil.example' },
  ],
}

describe('the Social tab', () => {
  it('sits after MCPs and asks the crawler, never a network itself', async () => {
    const { request, asked } = site(() => Response.json(POSTS))
    const html = await (await request('/search?q=rust&t=social')).text()
    const tabs = html.match(/<nav class="tabs"[\s\S]*?<\/nav>/)![0]
    expect(tabs.indexOf('MCPs')).toBeLessThan(tabs.indexOf('Social'))
    expect(html).toContain('aria-current="page">Social</a>')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toStartWith('http://index.test/api/v1/social?q=rust')
  })
  it('each post links to its own network to reply, and a stranger cannot add markup or a bad link', async () => {
    const { request } = site(() => Response.json(POSTS))
    const html = await (await request('/search?q=rust&t=social')).text()
    expect(html).toContain('Reply on Bluesky')
    expect(html).toContain('Reply on bbs.hqtui.com')
    expect(html).toContain('href="https://bbs.hqtui.com/t/a-1/p/2"')
    expect(html).toContain('Rust is &lt;b&gt;nice&lt;/b&gt;')
    expect(html).not.toContain('<b>nice</b>')
    expect(html).not.toContain('javascript:')
  })
  it('says it is unavailable when no network answered', async () => {
    const { request } = site(() => Response.json({ items: [], unavailable: true }))
    expect(await (await request('/search?q=rust&t=social')).text()).toContain('unavailable')
  })
})
