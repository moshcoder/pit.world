/**
 * Listen and Transcript, written by c0mpute's speech workers (the peer network's TTS and STT roles),
 * never by a paid provider.
 *
 * Listen reads a result aloud: its c0mpute summary when there is one, otherwise the start of the page
 * itself (read the same way summaries are, src/summarize.ts). Transcript turns a podcast episode pit.world
 * handed out (src/players.ts AudioRegistry) into timed text, ten minutes at a time, so the first lines
 * arrive while the rest is still being written.
 *
 * Both are kept on disk by page or by audio address, so the second request for either is instant and
 * costs nobody anything. Privacy: c0mpute is sent the text to read or the audio to transcribe, nothing
 * else: not the search, not who asked.
 */
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proxyAudio } from './players.js'

type Fetch = typeof fetch

export const TTS_ENGINE = 'piper'
export const TTS_VOICE = 'en_US-joe-medium'
/** About 80 seconds of speech: long enough to hear what a page is, short enough to be written in seconds. */
export const LISTEN_CHARS = 1_500
/** Transcripts are written in pieces this long, so text appears while the rest is still being written. */
export const CHUNK_SECONDS = 600
/** Without a pass a transcript is a preview: the first five minutes. */
export const PREVIEW_SECONDS = 300
/** The longest stretch of an episode a pass transcribes. */
export const MAX_SECONDS = 7_200

export class SpeechError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type Segment = { start: number; end: number; text: string }

/** The c0mpute speech gateway (c0mpute `speech serve`): POST /v1/tts and /v1/stt with a bearer token. */
export class SpeechClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async tts(text: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/v1/tts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text, engine: TTS_ENGINE, voice: TTS_VOICE }),
      signal: AbortSignal.timeout(180_000),
    })
    if (!res.ok) throw new SpeechError(res.status, `tts ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async stt(audio: Uint8Array, type = 'audio/mpeg'): Promise<{ text: string; segments: Segment[] }> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/v1/stt?model=base`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': type },
      body: audio as unknown as BodyInit,
      signal: AbortSignal.timeout(600_000),
    })
    if (!res.ok) throw new SpeechError(res.status, `stt ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const body = (await res.json()) as { text?: unknown; segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }> }
    const segments = (Array.isArray(body.segments) ? body.segments : []).flatMap((s) =>
      typeof s.start === 'number' && typeof s.end === 'number' && typeof s.text === 'string' && s.text.trim() ? [{ start: s.start, end: s.end, text: s.text.trim() }] : [],
    )
    return { text: typeof body.text === 'string' ? body.text : segments.map((s) => s.text).join(' '), segments }
  }
}

/** Runs ffmpeg with `input` on stdin; resolves when it exits 0. */
async function ffmpeg(args: string[], input: ReadableStream<Uint8Array> | Uint8Array | null, bin = 'ffmpeg'): Promise<Uint8Array> {
  const proc = Bun.spawn([bin, '-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { stdin: input ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const feeding = (async () => {
    if (!input || !proc.stdin) return
    try {
      if (input instanceof Uint8Array) proc.stdin.write(input)
      else for await (const chunk of input as any) proc.stdin.write(chunk)
    } catch {
      // ffmpeg closed its input early (a -t limit): fine.
    }
    try {
      await proc.stdin.end()
    } catch {}
  })()
  const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited])
  await feeding
  if (code !== 0) throw new SpeechError(500, `ffmpeg ${code}: ${err.slice(0, 200)}`)
  return new Uint8Array(out)
}

/** WAV from the TTS worker -> a small mono MP3 for the browser. */

/** A simple counter: at most `n` jobs of a kind talk to the workers at once, the rest wait their turn. */
export class Gate {
  private active = 0
  private waiting: Array<() => void> = []
  constructor(private readonly n: number) {}
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((r) => this.waiting.push(r))
    this.active++
    try {
      return await job()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

/** What to read aloud: whole sentences, at most `max` characters, no URLs or leftover markup. */
export function readableText(title: string, body: string, max = LISTEN_CHARS): string {
  const clean = (s: string) =>
    s
      .replace(/https?:\/\/\S+?(?=[.,;:!?)]*(?:\s|$))/g, ' ')
      .replace(/[#*_`>|[\]{}<]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/ ([.,;:!?])/g, '$1')
      .trim()
  const t = clean(title)
  let text = clean(body)
  if (t && !text.toLowerCase().startsWith(t.toLowerCase().slice(0, 40))) text = `${t}. ${text}`
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return end > max / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}.`
}

export const speechKey = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32)

export type ListenState =
  | { status: 'done'; url: string; src: string; source: 'summary' | 'page'; cached: boolean }
  | { status: 'pending'; url: string }
  | { status: 'failed'; url: string; error: string }
  | { status: 'unknown'; url: string }

export type TranscriptState = {
  status: 'done' | 'pending' | 'failed' | 'unknown'
  audio: string
  segments: Segment[]
  /** How far into the episode the transcript reaches, in seconds. */
  seconds: number
  /** Whether it reaches the end of the episode (or the most a transcript covers). */
  complete: boolean
  /** Written as a free preview (the first five minutes) rather than the whole episode. */
  preview: boolean
  error?: string
}

/** Listen and Transcript: jobs, the on-disk store, and the files Listen serves. */
export class Speech {
  readonly db: Database
  private readonly dir: string
  private listens = new Map<string, Promise<void>>()
  private listenFailures = new Map<string, { error: string; at: number }>()
  private transcripts = new Map<string, { promise: Promise<void>; full: boolean }>()
  private transcriptFailures = new Map<string, { error: string; at: number }>()
  private readonly ttsGate: Gate
  private readonly sttGate: Gate

  constructor(
    private readonly client: SpeechClient | null,
    options: { dbPath?: string; dir?: string; ffmpeg?: string; fetch?: Fetch; resolve?: (h: string) => Promise<string[]>; ttsConcurrency?: number; sttConcurrency?: number; maxFiles?: number } = {},
  ) {
    this.options = options
    this.db = new Database(options.dbPath ?? ':memory:', { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('CREATE TABLE IF NOT EXISTS listens (key TEXT PRIMARY KEY, file TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL)')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS transcripts (key TEXT PRIMARY KEY, segments TEXT NOT NULL, seconds REAL NOT NULL, complete INTEGER NOT NULL, preview INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    )
    this.dir = options.dir ?? mkdtempSync(join(tmpdir(), 'pit-speech-'))
    mkdirSync(this.dir, { recursive: true })
    this.ttsGate = new Gate(options.ttsConcurrency ?? 2)
    this.sttGate = new Gate(options.sttConcurrency ?? 1)
  }
  private options: { ffmpeg?: string; fetch?: Fetch; resolve?: (h: string) => Promise<string[]>; maxFiles?: number }

  get enabled(): boolean {
    return !!this.client
  }

  // ---- Listen -----------------------------------------------------------------

  listenStatus(url: string, pageKey: string): ListenState {
    const row = this.db.query<{ file: string; source: string }, [string]>('SELECT file, source FROM listens WHERE key = ?').get(pageKey)
    if (row) return { status: 'done', url, src: `/api/listen/audio/${row.file}`, source: row.source as 'summary' | 'page', cached: true }
    if (this.listens.has(pageKey)) return { status: 'pending', url }
    const failed = this.listenFailures.get(pageKey)
    if (failed && Date.now() - failed.at < 10 * 60_000) return { status: 'failed', url, error: failed.error }
    return { status: 'unknown', url }
  }

  /**
   * Starts reading a page aloud unless it is read or being read. `text` gives what to read once the job
   * runs: the summary when there is one, else the page; it may throw "could not read the page".
   */
  startListen(url: string, pageKey: string, text: () => Promise<{ text: string; source: 'summary' | 'page' }>): ListenState {
    const now = this.listenStatus(url, pageKey)
    if (now.status === 'done' || now.status === 'pending') return now
    if (!this.client) return { status: 'failed', url, error: 'Listen is off on this server.' }
    this.listenFailures.delete(pageKey)
    const job = this.ttsGate
      .run(async () => {
        const { text: words, source } = await text()
        if (words.length < 40) throw new SpeechError(422, 'nothing to read')
        const mp3 = await toMp3Via(this.options.ffmpeg, await this.client!.tts(words))
        const file = `${speechKey(`${pageKey}:${TTS_VOICE}`)}.mp3`
        await Bun.write(join(this.dir, file), mp3)
        this.db.query('INSERT OR REPLACE INTO listens (key, file, source, created_at) VALUES (?, ?, ?, ?)').run(pageKey, file, source, Date.now())
        this.prune()
      })
      .catch((error) => {
        const message =
          error instanceof SpeechError && error.message === 'nothing to read'
            ? 'There is not enough text on that page to read aloud.'
            : error instanceof Error && error.message === 'could not read the page'
              ? 'Could not read that page aloud.'
              : 'The reader did not answer. Try again in a minute.'
        this.listenFailures.set(pageKey, { error: message, at: Date.now() })
        console.warn(`listen: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => this.listens.delete(pageKey))
    this.listens.set(pageKey, job)
    return { status: 'pending', url }
  }

  /** For tests: wait for a Listen job. */
  async waitListen(pageKey: string): Promise<void> {
    await this.listens.get(pageKey)
  }

  /** A Listen file by name, or null. Names are our own hex, nothing a visitor can steer elsewhere. */
  listenFile(name: string): ReturnType<typeof Bun.file> | null {
    return /^[0-9a-f]{32}\.mp3$/.test(name) ? Bun.file(join(this.dir, name)) : null
  }

  /** Keeps the newest files only (default 4,000, about 2 GB): an evicted page is simply read again. */
  private prune(): void {
    const max = this.options.maxFiles ?? 4_000
    const old = this.db.query<{ key: string; file: string }, [number]>('SELECT key, file FROM listens ORDER BY created_at DESC LIMIT -1 OFFSET ?').all(max)
    for (const row of old) {
      try {
        unlinkSync(join(this.dir, row.file))
      } catch {}
      this.db.query('DELETE FROM listens WHERE key = ?').run(row.key)
    }
  }

  // ---- Transcript ------------------------------------------------------------------

  private stored(audio: string): { segments: Segment[]; seconds: number; complete: boolean; preview: boolean } | null {
    const row = this.db
      .query<{ segments: string; seconds: number; complete: number; preview: number }, [string]>('SELECT segments, seconds, complete, preview FROM transcripts WHERE key = ?')
      .get(speechKey(audio))
    return row ? { segments: JSON.parse(row.segments) as Segment[], seconds: row.seconds, complete: !!row.complete, preview: !!row.preview } : null
  }

  transcriptStatus(audio: string): TranscriptState {
    const done = this.stored(audio)
    const job = this.transcripts.get(speechKey(audio))
    const failed = this.transcriptFailures.get(speechKey(audio))
    const base = { audio, segments: done?.segments ?? [], seconds: done?.seconds ?? 0, complete: done?.complete ?? false, preview: done?.preview ?? false }
    if (job) return { ...base, status: 'pending' }
    if (done && (done.complete || done.preview)) return { ...base, status: 'done' }
    if (failed && Date.now() - failed.at < 10 * 60_000) return { ...base, status: 'failed', error: failed.error }
    return { ...base, status: done ? 'done' : 'unknown' }
  }

  /** Whether a request for this transcript is already answered (or being answered) without new work. */
  transcriptCovered(audio: string, full: boolean): boolean {
    const done = this.stored(audio)
    const job = this.transcripts.get(speechKey(audio))
    if (done?.complete || (!full && done)) return true
    return !!job && (job.full || !full)
  }

  /**
   * Transcribes an episode: the first five minutes for a preview, up to two hours for a pass holder.
   * Each ten-minute piece is saved as soon as it is written. A whole transcript, once written, is shared
   * with everyone who asks for it.
   */
  startTranscript(audio: string, full: boolean): TranscriptState {
    const key = speechKey(audio)
    if (!this.client) return { ...this.transcriptStatus(audio), status: 'failed', error: 'Transcripts are off on this server.' }
    if (this.transcriptCovered(audio, full)) return this.transcriptStatus(audio)
    this.transcriptFailures.delete(key)
    const job = this.transcribe(audio, full)
      .catch((error) => {
        this.transcriptFailures.set(key, { error: 'The transcript stopped partway. Try again in a minute.', at: Date.now() })
        console.warn(`transcript: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => this.transcripts.delete(key))
    this.transcripts.set(key, { promise: job, full })
    return this.transcriptStatus(audio)
  }

  async waitTranscript(audio: string): Promise<void> {
    await this.transcripts.get(speechKey(audio))?.promise
  }

  private save(audio: string, segments: Segment[], seconds: number, complete: boolean, preview: boolean): void {
    this.db
      .query('INSERT OR REPLACE INTO transcripts (key, segments, seconds, complete, preview, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(speechKey(audio), JSON.stringify(segments), seconds, complete ? 1 : 0, preview ? 1 : 0, Date.now())
  }

  private async transcribe(audio: string, full: boolean): Promise<void> {
    const limit = full ? MAX_SECONDS : PREVIEW_SECONDS
    const work = mkdtempSync(join(tmpdir(), 'pit-stt-'))
    try {
      // The episode, through the same public-only reader /audio uses, cut by ffmpeg into ten-minute pieces of
      // 16 kHz mono MP3 (about 2.4 MB each, well inside what a worker accepts).
      const upstream = await proxyAudio(audio, null, { ...(this.options.fetch ? { fetch: this.options.fetch } : {}), ...(this.options.resolve ? { resolve: this.options.resolve } : {}) })
      if (!upstream.ok || !upstream.body) throw new SpeechError(502, `audio ${upstream.status}`)
      await ffmpeg(
        ['-i', 'pipe:0', '-t', String(limit), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-reset_timestamps', '1', join(work, 'part%03d.mp3')],
        upstream.body,
        this.options.ffmpeg,
      )
      const parts = readdirSync(work)
        .filter((f) => /^part\d{3}\.mp3$/.test(f))
        .sort()
      if (!parts.length) throw new SpeechError(422, 'no audio in that file')
      // How much audio there was, to tell "the episode ended" from "we stopped at the limit".
      let total = 0
      for (const part of parts) total += await duration(join(work, part), this.options.ffmpeg)
      const ended = total < limit - 2
      const segments: Segment[] = []
      for (const [i, part] of parts.entries()) {
        const offset = i * CHUNK_SECONDS
        const bytes = new Uint8Array(await Bun.file(join(work, part)).arrayBuffer())
        const piece = (await this.sttGate.run(() => this.client!.stt(bytes))).segments
        for (const s of piece) segments.push({ start: round(s.start + offset), end: round(s.end + offset), text: s.text })
        const last = i === parts.length - 1
        const seconds = last ? round(total) : offset + CHUNK_SECONDS
        // A pass transcript is complete at its end (the whole episode, or the first two hours); a preview
        // only when the episode itself was shorter than five minutes.
        this.save(audio, segments, seconds, last && (full || ended), !full && !ended)
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
}

const round = (n: number) => Math.round(n * 100) / 100

/** A file's length in seconds (ffprobe beside ffmpeg). */
async function duration(file: string, ffmpegBin = 'ffmpeg'): Promise<number> {
  const probe = ffmpegBin.replace(/ffmpeg$/, 'ffprobe')
  const proc = Bun.spawn([probe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const n = Number(out.trim())
  return Number.isFinite(n) ? n : 0
}

async function toMp3Via(bin: string | undefined, wav: Uint8Array): Promise<Uint8Array> {
  return ffmpeg(['-i', 'pipe:0', '-ac', '1', '-b:a', '48k', '-f', 'mp3', 'pipe:1'], wav, bin)
}
