import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readableText, Speech, SpeechClient, speechKey, type Segment } from '../src/speech.ts'
import { createApp } from '../src/server.ts'
import { Registry } from '../src/moshpit.ts'
import { W3bsNetwork } from '../src/w3bs-network.ts'
import { Summarizer } from '../src/summarize.ts'
import { AudioRegistry } from '../src/players.ts'

const hasFfmpeg = Bun.which('ffmpeg') !== null && Bun.which('ffprobe') !== null

/** `seconds` of silence in a format, made by ffmpeg itself. */
async function tone(seconds: number, format: 'wav' | 'mp3'): Promise<Uint8Array> {
  const proc = Bun.spawn(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', `anullsrc=r=16000:cl=mono`, '-t', String(seconds), ...(format === 'mp3' ? ['-b:a', '32k'] : []), '-f', format, 'pipe:1'], { stdout: 'pipe' })
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
  await proc.exited
  return out
}

/** A stand-in c0mpute speech gateway: TTS returns a WAV, STT returns one segment per piece it is sent. */
function gateway(log: string[], wav: Uint8Array) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    log.push(`${url} ${new Headers(init?.headers).get('authorization')}`)
    if (url.endsWith('/v1/tts')) {
      const body = JSON.parse(String(init?.body))
      log.push(`tts:${body.engine}:${body.voice}:${body.text.length}`)
      return new Response(wav as unknown as BodyInit, { headers: { 'content-type': 'audio/wav' } })
    }
    if (url.includes('/v1/stt')) {
      const n = log.filter((l) => l === 'stt').length
      log.push('stt')
      return Response.json({ text: `piece ${n}`, segments: [{ start: 1, end: 4, text: `piece ${n}` }] })
    }
    return new Response('no', { status: 404 })
  }) as typeof fetch
}

describe('readableText', () => {
  it('reads the title first, drops links and markup, and stops at a sentence', () => {
    const text = readableText('Moby Dick', `# Chapter 1 Call me **Ishmael**. See https://x.example/a. ${'Some years ago, never mind how long precisely. '.repeat(60)}`, 300)
    expect(text.startsWith('Moby Dick. Chapter 1 Call me Ishmael. See. Some years ago')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(300)
    expect(text.endsWith('.')).toBe(true)
    expect(text).not.toContain('https://')
    expect(readableText('Same title', 'Same title and the rest.')).toBe('Same title and the rest.')
  })
})

describe('SpeechClient', () => {
  it('asks the gateway with its token and the house voice; keeps only real segments', async () => {
    const log: string[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      log.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`)
      if (String(input).includes('/v1/stt')) return Response.json({ text: 'hi', segments: [{ start: 0, end: 1, text: ' hi ' }, { start: 'x', text: 'bad' }, { start: 1, end: 2, text: '  ' }] })
      return new Response(new Uint8Array([1, 2]))
    }) as typeof fetch
    const client = new SpeechClient('http://gw.test/', 'T', fetchImpl)
    expect((await client.tts('hello')).length).toBe(2)
    expect(await client.stt(new Uint8Array([1]))).toEqual({ text: 'hi', segments: [{ start: 0, end: 1, text: 'hi' }] })
    expect(log).toEqual(['http://gw.test/v1/tts Bearer T', 'http://gw.test/v1/stt?model=base Bearer T'])
  })
})

describe.skipIf(!hasFfmpeg)('Speech (real ffmpeg, stand-in gateway)', () => {
  it('Listen: reads once, stores a small MP3, and the second ask is instant', async () => {
    const log: string[] = []
    const speech = new Speech(new SpeechClient('http://gw.test', 'T', gateway(log, await tone(2, 'wav'))), { dir: mkdtempSync(join(tmpdir(), 'speech-test-')) })
    let asked = 0
    const text = async () => {
      asked++
      return { text: 'A page about whales, long enough to be worth reading out loud to someone.', source: 'page' as const }
    }
    expect(speech.startListen('https://a.example/', 'a.example', text).status).toBe('pending')
    expect(speech.startListen('https://a.example/', 'a.example', text).status).toBe('pending')
    await speech.waitListen('a.example')
    const done = speech.listenStatus('https://a.example/', 'a.example')
    expect(done).toMatchObject({ status: 'done', source: 'page', cached: true })
    const name = (done as { src: string }).src.split('/').pop()!
    const file = speech.listenFile(name)!
    expect(await file.exists()).toBe(true)
    expect(new Uint8Array(await file.slice(0, 3).arrayBuffer())[0]).toBeOneOf([0x49, 0xff]) // ID3 or an MP3 frame
    expect(speech.startListen('https://a.example/', 'a.example', text).status).toBe('done')
    expect(asked).toBe(1)
    expect(log.filter((l) => l.startsWith('tts:piper:en_US-joe-medium:'))).toHaveLength(1)
    expect(speech.listenFile('../../etc/passwd')).toBeNull()
  })

  it('Listen: a page with nothing to read fails politely and can be retried', async () => {
    const speech = new Speech(new SpeechClient('http://gw.test', 'T', gateway([], await tone(1, 'wav'))))
    speech.startListen('https://b.example/', 'b', async () => ({ text: 'short', source: 'page' }))
    await speech.waitListen('b')
    expect(speech.listenStatus('https://b.example/', 'b')).toEqual({ status: 'failed', url: 'https://b.example/', error: 'There is not enough text on that page to read aloud.' })
  })

  it('Transcript: a preview is the first five minutes; a pass writes the whole episode in ten-minute pieces with true times', async () => {
    const episode = await tone(700, 'mp3')
    const log: string[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === 'https://cdn.example/ep.mp3') return new Response(episode as unknown as BodyInit, { headers: { 'content-type': 'audio/mpeg' } })
      return gateway(log, new Uint8Array())(input, init)
    }) as typeof fetch
    const speech = new Speech(new SpeechClient('http://gw.test', 'T', fetchImpl), { fetch: fetchImpl, resolve: async () => ['93.184.216.34'] })
    const ep = 'https://cdn.example/ep.mp3'

    expect(speech.startTranscript(ep, false).status).toBe('pending')
    await speech.waitTranscript(ep)
    const preview = speech.transcriptStatus(ep)
    expect(preview).toMatchObject({ status: 'done', preview: true, complete: false })
    expect(preview.segments).toEqual([{ start: 1, end: 4, text: 'piece 0' }])
    expect(speech.transcriptCovered(ep, false)).toBe(true)
    expect(speech.transcriptCovered(ep, true)).toBe(false)

    speech.startTranscript(ep, true)
    await speech.waitTranscript(ep)
    const whole = speech.transcriptStatus(ep)
    expect(whole).toMatchObject({ status: 'done', preview: false, complete: true })
    expect(whole.segments.map((s: Segment) => s.start)).toEqual([1, 601])
    expect(Math.round(whole.seconds)).toBe(700)
    // Once whole, everyone reads it without new work.
    expect(speech.transcriptCovered(ep, false)).toBe(true)
    expect(log.filter((l) => l === 'stt')).toHaveLength(3)
    expect(speechKey(ep)).toHaveLength(32)
  })
})

describe.skipIf(!hasFfmpeg)('the app: /api/listen and /api/transcript', () => {
  async function make() {
    const log: string[] = []
    const wav = await tone(1, 'wav')
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('http://gw.test/')) return gateway(log, wav)(input, init)
      if (url === 'https://cdn.example/one.mp3') return new Response((await tone(20, 'mp3')) as unknown as BodyInit, { headers: { 'content-type': 'audio/mpeg' } })
      if (url === 'https://p0dcasters.com/podcast/the-show/playlist.m3u') return new Response('#EXTINF:20,One\nhttps://cdn.example/one.mp3\n')
      return new Response('no', { status: 500 })
    }) as typeof fetch
    const summarizer = new Summarizer({ pageText: async () => 'Whales are large marine mammals. '.repeat(10) })
    summarizer.remember([{ url: 'https://whales.example/', title: 'All about whales', host: 'whales.example', description: 'x' } as any])
    const speech = new Speech(new SpeechClient('http://gw.test', 'T', fetchImpl), { fetch: fetchImpl, resolve: async () => ['93.184.216.34'] })
    const app = createApp({
      keys: {},
      registry: new Registry('https://registry.test', fetchImpl),
      fetch: fetchImpl,
      resolve: async () => ['93.184.216.34'],
      network: new W3bsNetwork(fetchImpl),
      summarizer,
      speech,
      audio: new AudioRegistry(),
    } as Parameters<typeof createApp>[0])
    const request = (path: string, init: RequestInit = {}, ip = '203.0.113.5') => app.request(path, init, { ip })
    const post = (path: string, body: unknown, ip?: string) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, ip)
    return { request, post, speech, log }
  }

  it('reads a recent result aloud, serves the MP3 with ranges, and holds anonymous visitors to 3 an hour', async () => {
    const { request, post, speech } = await make()
    expect((await post('/api/listen', { url: 'https://unknown.example/' })).status).toBe(404)
    const first = await post('/api/listen', { url: 'https://whales.example/' })
    expect(first.status).toBe(202)
    await speech.waitListen('whales.example')
    const done = (await (await request('/api/listen?url=https%3A%2F%2Fwhales.example%2F')).json()) as { status: string; src: string; source: string }
    expect(done).toMatchObject({ status: 'done', source: 'page' })
    const mp3 = await request(done.src)
    expect(mp3.status).toBe(200)
    expect(mp3.headers.get('content-type')).toBe('audio/mpeg')
    const part = await request(done.src, { headers: { range: 'bytes=0-9' } })
    expect(part.status).toBe(206)
    expect((await part.arrayBuffer()).byteLength).toBe(10)
    // Already written: free, any number of times.
    for (let i = 0; i < 5; i++) expect((await post('/api/listen', { url: 'https://whales.example/' })).status).toBe(200)
  })

  it('transcribes only episodes pit.world handed out; free visitors get the preview', async () => {
    const { request, post, speech } = await make()
    expect((await post('/api/transcript', { audio: 'https://cdn.example/one.mp3' })).status).toBe(404)
    await request(`/api/episodes?show=${encodeURIComponent('https://p0dcasters.com/podcast/the-show')}`)
    const started = await post('/api/transcript', { audio: 'https://cdn.example/one.mp3' })
    expect(started.status).toBe(202)
    expect(((await started.json()) as { pass: boolean }).pass).toBe(false)
    await speech.waitTranscript('https://cdn.example/one.mp3')
    const t = (await (await request('/api/transcript?audio=https%3A%2F%2Fcdn.example%2Fone.mp3')).json()) as { status: string; complete: boolean; segments: unknown[] }
    // A 20-second episode is shorter than the preview, so the preview is the whole thing.
    expect(t).toMatchObject({ status: 'done', complete: true })
    expect(t.segments).toHaveLength(1)
  })
})
