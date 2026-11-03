import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { RateLimiter } from './ratelimit.js'

export const AUCTION_HOST = 'auctions.pit.world'
export const AUCTION_ALIAS = 'art.auctions.pit.world'
export const AUCTION_HOSTS = [AUCTION_HOST, AUCTION_ALIAS] as const

export function isAuctionHost(value: string | null | undefined): boolean {
  const host = String(value ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  return (AUCTION_HOSTS as readonly string[]).includes(host)
}

type Artwork = {
  id: string
  title: string
  artist: string
  medium: string
  description: string
  image_type: string
  created_at: number
}

export const AUCTION_THEMES = ['warm', 'blue'] as const
export type AuctionTheme = (typeof AUCTION_THEMES)[number]
export const DEFAULT_AUCTION_THEME: AuctionTheme = 'warm'
const THEME_COOKIE = 'aa_theme'
const THEME_COLOR: Record<AuctionTheme, string> = { blue: '#eef3fa', warm: '#f3eee5' }
const THEME_LABEL: Record<AuctionTheme, string> = { blue: 'Blue', warm: 'Warm' }

export function themeFromCookie(header: string | null | undefined): AuctionTheme {
  const match = /(?:^|;\s*)aa_theme=([a-z]+)/.exec(String(header ?? ''))
  const value = match?.[1] as AuctionTheme | undefined
  return value && (AUCTION_THEMES as readonly string[]).includes(value) ? value : DEFAULT_AUCTION_THEME
}

function themePicker(theme: AuctionTheme, path: string) {
  const back = encodeURIComponent(path)
  return `<nav class="theme-pick" aria-label="Color theme">THEME ${AUCTION_THEMES.map((t) => `<a href="/theme/${t}?back=${back}" rel="nofollow" aria-current="${t === theme}"><i class="swatch-${t}" aria-hidden="true"></i>${THEME_LABEL[t]}</a>`).join('')}</nav>`
}

type ArtworkImage = { image_type: string; image: Uint8Array }

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif'])
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const clean = (value: unknown, length: number) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length)

function validImage(type: string, bytes: Uint8Array): boolean {
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (type === 'image/png') return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
  if (type === 'image/webp') return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  if (type === 'image/avif') return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 12)).startsWith('ftypavif')
  if (type === 'image/heic' || type === 'image/heif') {
    if (bytes.length < 12) return false
    const brand = String.fromCharCode(...bytes.slice(4, 12))
    return brand.startsWith('ftypheic') || brand.startsWith('ftypheix') || brand.startsWith('ftyphevc') || brand.startsWith('ftypmif1') || brand.startsWith('ftypmsf1')
  }
  return false
}

// The stylesheet URL carries a hash of its contents, so a browser never keeps an old copy
// after a deploy (a cached pre-theme stylesheet left the Blue switch doing nothing).
let cssVersion: string | undefined
const cssHref = () => `/style.css?v=${(cssVersion ??= createHash('sha256').update(AUCTIONS_CSS).digest('hex').slice(0, 12))}`

function page(theme: AuctionTheme, title: string, body: string, description = 'A home for art, artists and the stories behind every piece.', canonicalPath = '/') {
  return `<!doctype html>
<html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="${THEME_COLOR[theme]}"><meta name="description" content="${esc(description)}"><link rel="stylesheet" href="${cssHref()}"><link rel="canonical" href="https://${AUCTION_HOST}${esc(canonicalPath)}"><title>${esc(title)} · Art Auctions</title></head>
<body><header class="top"><a class="brand" href="/" aria-label="Art Auctions home"><span class="brand-mark">A</span><span>Art Auctions<small>THE HOUSE FOR ORIGINAL WORK</small></span></a><nav><a href="/#gallery">Browse art</a><a class="nav-cta" href="/new">Submit a piece <span aria-hidden="true">↗</span></a></nav></header>${body}<footer><a class="brand footer-brand" href="/"><span class="brand-mark">A</span><span>Art Auctions<small>ART, WITH A STORY.</small></span></a><p>A place for original work and the people who make it.</p>${themePicker(theme, canonicalPath)}</footer></body></html>`
}

function artworkCard(item: Artwork) {
  return `<article class="art-card"><a class="art-image" href="/art/${encodeURIComponent(item.id)}"><img src="/image/${encodeURIComponent(item.id)}" alt="${esc(item.title)} by ${esc(item.artist)}" loading="lazy"></a><div class="art-info"><span class="eyebrow">${esc(item.medium || 'ORIGINAL WORK')}</span><h3><a href="/art/${encodeURIComponent(item.id)}">${esc(item.title)}</a></h3><p>by ${esc(item.artist)}</p></div></article>`
}

function home(house: AuctionHouse, theme: AuctionTheme) {
  const works = house.list()
  const gallery = works.length
    ? `<div class="gallery">${works.map(artworkCard).join('')}</div>`
    : `<div class="empty"><span class="empty-stamp" aria-hidden="true">✳</span><h3>The walls are waiting.</h3><p>Bring the first piece. Share the work you want the world to see.</p><a class="button button-dark" href="/new">Submit your artwork <span aria-hidden="true">↗</span></a></div>`
  return page(theme, 'Art Auctions House', `<main>
    <section class="hero"><div class="hero-copy"><p class="eyebrow">ART · PEOPLE · STORIES</p><h1>Good art deserves<br><em>a good home.</em></h1><p class="lede">A new house for original art, made by people with something to say.</p><a class="button button-dark" href="/new">Bring us a piece <span aria-hidden="true">↗</span></a><p class="hero-note">Made for artists. Ready for your camera roll.</p></div><div class="hero-art" role="img" aria-label="Abstract art in a warm gallery"><div class="sun"></div><div class="shape shape-one"></div><div class="shape shape-two"></div><div class="shape shape-three"></div><div class="shape shape-four"></div><span class="art-caption">A house for art<br><b>Vol. 01 · Open call</b></span></div><span class="hero-index">01 / 01</span></section>
    <section id="gallery" class="gallery-section"><div class="section-head"><div><p class="eyebrow">FROM THE WALLS</p><h2>Works in the house <span class="count">${works.length.toString().padStart(2, '0')}</span></h2></div><a class="text-link" href="/new">Submit your work <span aria-hidden="true">↗</span></a></div>${gallery}</section>
    <section class="invite"><div><p class="eyebrow">AN OPEN DOOR</p><h2>Make room<br><em>for your work.</em></h2></div><div class="invite-copy"><p>Send a photo and a few words about the piece. It will appear in the gallery with your name.</p><a class="button button-light" href="/new">Add your artwork <span aria-hidden="true">↗</span></a><small>Only share work you own or have permission to display. The gallery is public.</small></div></section>
  </main>`)
}

function formPage(theme: AuctionTheme, error = '') {
  return page(theme, 'Submit artwork', `<main><section class="form-wrap"><a class="back-link" href="/">← Back to the house</a><p class="eyebrow">ADD A PIECE TO THE WALLS</p><h1>Show us<br><em>what you made.</em></h1><p class="form-intro">Share a clear photo and a little about the work. Your submission will appear in the public gallery.</p>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}<form class="art-form" method="post" action="/new" enctype="multipart/form-data"><div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div><label class="field"><span>Title <b>*</b></span><input name="title" maxlength="120" autocomplete="off" required placeholder="What is this piece called?"></label><label class="field"><span>Artist name <b>*</b></span><input name="artist" maxlength="80" autocomplete="name" required placeholder="The name you want shown"></label><label class="field"><span>Medium <small>optional</small></span><input name="medium" maxlength="80" autocomplete="off" placeholder="Oil on canvas, ceramic, collage…"></label><label class="field"><span>About the piece <small>optional</small></span><textarea name="description" rows="4" maxlength="1600" placeholder="A few words about the work"></textarea></label><label class="field upload-field"><span>Photo of your work <b>*</b></span><input name="image" type="file" accept="image/*" required><small>JPEG, PNG, WebP, AVIF or HEIC. Up to 8 MB.</small></label><label class="permission"><input type="checkbox" name="permission" value="yes" required><span>I own this work or have permission to share it, and I agree to display the photo and details publicly.</span></label><button class="button button-dark submit-button" type="submit">Add to the gallery <span aria-hidden="true">↗</span></button><p class="form-foot">Submissions are public as soon as they are added. Bidding and payment features are not active yet.</p></form></section></main>`, undefined, '/new')
}

function detail(item: Artwork, theme: AuctionTheme) {
  return page(theme, item.title, `<main><section class="detail-wrap"><a class="back-link" href="/#gallery">← Back to the gallery</a><div class="detail-grid"><img class="detail-image" src="/image/${encodeURIComponent(item.id)}" alt="${esc(item.title)} by ${esc(item.artist)}"><div class="detail-copy"><p class="eyebrow">${esc(item.medium || 'ORIGINAL WORK')}</p><h1>${esc(item.title)}</h1><p class="artist">by ${esc(item.artist)}</p>${item.description ? `<p class="detail-description">${esc(item.description).replace(/\n/g, '<br>')}</p>` : ''}<a class="text-link" href="/new">Add your work <span aria-hidden="true">↗</span></a><p class="form-foot">Bidding and payment features are not active yet.</p></div></div></section></main>`, 'A piece in the Art Auctions House gallery.', `/art/${encodeURIComponent(item.id)}`)
}

export class AuctionHouse {
  readonly db: Database
  private readonly submissions = new RateLimiter(2, 1 / 15)

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS auction_artworks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      medium TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      image_type TEXT NOT NULL,
      image BLOB NOT NULL,
      created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS auction_artworks_created ON auction_artworks(created_at DESC);`)
  }

  list(limit = 48): Artwork[] {
    return this.db.query<Artwork, [number]>('SELECT id, title, artist, medium, description, image_type, created_at FROM auction_artworks ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(100, limit)))
  }

  get(id: string): Artwork | null {
    return this.db.query<Artwork, [string]>('SELECT id, title, artist, medium, description, image_type, created_at FROM auction_artworks WHERE id = ?').get(id) ?? null
  }

  image(id: string): ArtworkImage | null {
    return this.db.query<ArtworkImage, [string]>('SELECT image_type, image FROM auction_artworks WHERE id = ?').get(id) ?? null
  }

  add(input: { title: string; artist: string; medium: string; description: string; imageType: string; image: Uint8Array }, now = Date.now()): string {
    const id = randomBytes(12).toString('base64url')
    this.db.query('INSERT INTO auction_artworks (id, title, artist, medium, description, image_type, image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.title, input.artist, input.medium, input.description, input.imageType, input.image, now)
    return id
  }

  allowSubmission(ip: string): boolean {
    return this.submissions.take(ip)
  }
}

export function createAuctionApp(house: AuctionHouse) {
  const app = new Hono<{ Bindings: { ip?: string } }>()
  app.use('*', async (c, next) => {
    await next()
    if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store')
    c.header('x-content-type-options', 'nosniff')
    c.header('referrer-policy', 'no-referrer')
  })
  const themeOf = (c: { req: { header(name: string): string | undefined } }) => themeFromCookie(c.req.header('cookie'))
  app.get('/theme/:name', (c) => {
    const name = c.req.param('name') as AuctionTheme
    const back = c.req.query('back') ?? '/'
    const target = back.startsWith('/') && !back.startsWith('//') && !back.includes('\\') ? back : '/'
    if (!(AUCTION_THEMES as readonly string[]).includes(name)) return c.redirect(target, 303)
    c.header('set-cookie', `${THEME_COOKIE}=${name}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`)
    return c.redirect(target, 303)
  })
  app.get('/style.css', (c) => c.body(AUCTIONS_CSS, 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': c.req.query('v') ? 'public, max-age=31536000, immutable' : 'no-cache' }))
  app.get('/image/:id', (c) => {
    const image = house.image(c.req.param('id'))
    if (!image) return c.text('Not found', 404)
    const bytes = image.image.slice().buffer as ArrayBuffer
    return c.body(bytes, 200, { 'content-type': image.image_type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' })
  })
  app.get('/art/:id', (c) => {
    const item = house.get(c.req.param('id'))
    return item ? c.html(detail(item, themeOf(c))) : c.html(page(themeOf(c), 'Not found', '<main><section class="empty"><h1>This piece is not here.</h1><a class="button button-dark" href="/">Back to the house</a></section></main>'), 404)
  })
  app.get('/new', (c) => c.html(formPage(themeOf(c))))
  app.post('/new', async (c) => {
    const host = String(c.req.header('host') ?? new URL(c.req.url).host).trim().toLowerCase().replace(/:\d+$/, '')
    const origin = c.req.header('origin')
    if (origin) {
      try {
        if (new URL(origin).host.toLowerCase() !== host) return c.text('Forbidden', 403)
      } catch {
        return c.text('Forbidden', 403)
      }
    }
    const fetchSite = c.req.header('sec-fetch-site')
    if (fetchSite && fetchSite !== 'same-origin') return c.text('Forbidden', 403)
    const theme = themeOf(c)
    const ip = c.env?.ip ?? c.req.header('x-real-ip') ?? 'unknown'
    if (!house.allowSubmission(String(ip))) return c.html(formPage(theme, 'Too many submissions from this connection. Please try again later.'), 429)
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>) as Record<string, string | File>
    if (clean(body.website, 160)) return c.redirect('/', 303)
    const title = clean(body.title, 120)
    const artist = clean(body.artist, 80)
    const medium = clean(body.medium, 80)
    const description = clean(body.description, 1600)
    if (!title || !artist) return c.html(formPage(theme, 'Add a title and artist name to continue.'), 400)
    if (body.permission !== 'yes') return c.html(formPage(theme, 'Please confirm you have permission to share this work.'), 400)
    const image = body.image
    if (!(image instanceof File) || image.size === 0) return c.html(formPage(theme, 'Choose a photo of your work to continue.'), 400)
    if (image.size > MAX_IMAGE_BYTES) return c.html(formPage(theme, 'That photo is over 8 MB. Choose a smaller image and try again.'), 413)
    const imageType = image.type.toLowerCase()
    if (!IMAGE_TYPES.has(imageType)) return c.html(formPage(theme, 'Choose a JPEG, PNG, WebP, AVIF or HEIC image.'), 415)
    const bytes = new Uint8Array(await image.arrayBuffer())
    if (!validImage(imageType, bytes)) return c.html(formPage(theme, 'That file does not look like a supported image.'), 415)
    const id = house.add({ title, artist, medium, description, imageType, image: bytes })
    return c.redirect(`/art/${encodeURIComponent(id)}`, 303)
  })
  app.get('/', (c) => c.html(home(house, themeOf(c))))
  app.notFound((c) => c.html(page(themeOf(c), 'Not found', '<main><section class="empty"><h1>This page is not in the house.</h1><a class="button button-dark" href="/">Back to the house</a></section></main>'), 404))
  return app
}

const AUCTIONS_CSS = `/* Themes: "warm" (the original cream and green house look) is the default; "blue" is a visitor choice. */
[data-theme=blue]{--ink:#16213a;--muted:#5f6b82;--soft:#46526a;--paper:#eef3fa;--white:#fbfdff;--green:#1f4f8f;--on-green:#f6f9ff;--on-green-accent:#9cc7ff;--line:#d2dcea;--accent:#2f7fe0;--frame:#dbe4f1;--panel:#e2eaf5;--art-1:#c9d8ee;--art-2:#8eaad3;--art-3:#3d6aa8;--art-4:#13294d;--art-shadow:#d6e1f1;--art-frame:#f2f7ff;--art-sun:#f1f5fb;--shape-1:#183865;--shape-2:#4b7fc4;--shape-3:#dbe7f6;--shape-4:#7aa3d9;--invite-eyebrow:#a8c9f2;--invite-em:#c6dcf8;--invite-small:#c5d1e4;--input-line:#c0cbdc;--input-bg:#fff;--upload-line:#98a8c2;--upload-bg:#f4f7fc;--error-bg:#fbe4e4;--error-ink:#8a2b2b;--focus:#3b82f6}
:root,[data-theme=warm]{color-scheme:light;--ink:#24251f;--muted:#74756c;--soft:#595b52;--paper:#f3eee5;--white:#fffdf8;--green:#384b36;--on-green:#fffdf8;--on-green-accent:#f2b393;--line:#d9d3c7;--accent:#d16d48;--frame:#e4ddd1;--panel:#eae3d8;--art-1:#d9c3aa;--art-2:#bd9a7f;--art-3:#75866b;--art-4:#354b3e;--art-shadow:#e5d9c8;--art-frame:#fff8e0;--art-sun:#e6a75f;--shape-1:#38523f;--shape-2:#ad6650;--shape-3:#e8d6ae;--shape-4:#c78d5f;--invite-eyebrow:#d9bd91;--invite-em:#ddc69f;--invite-small:#d5d7cd;--input-line:#c9c4b9;--input-bg:#fff;--upload-line:#a8aa9d;--upload-bg:#f7f4ed;--error-bg:#f7e1d8;--error-ink:#7a3025;--focus:#cf7d5b}
.theme-pick{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:11px;letter-spacing:.08em}.theme-pick a{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--line);border-radius:999px;color:var(--ink)}.theme-pick a[aria-current=true]{border-color:var(--green);font-weight:700}.theme-pick i{display:inline-block;width:10px;height:10px;border-radius:50%}.swatch-blue{background:#1f4f8f}.swatch-warm{background:#384b36}
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-synthesis:none;text-rendering:optimizeLegibility}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink)}a{color:inherit;text-decoration:none}.top{height:82px;padding:0 max(6vw,24px);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:12px;font-family:Georgia,serif;font-size:20px;line-height:1}.brand small{display:block;margin-top:7px;font:9px/1.1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.15em;color:var(--muted)}.brand-mark{display:grid;place-items:center;width:38px;height:38px;border:1px solid var(--green);border-radius:50%;color:var(--green);font:italic 24px Georgia,serif}.top nav{display:flex;align-items:center;gap:32px;font-size:13px}.top nav a:first-child{color:var(--muted)}.nav-cta,.text-link{font-weight:650}.nav-cta span,.text-link span,.button span{margin-left:8px;color:var(--accent)}main{max-width:1440px;margin:0 auto;padding:0 max(6vw,24px)}.hero{position:relative;min-height:540px;padding:76px 0 86px;display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:8%;border-bottom:1px solid var(--line)}.hero-copy{position:relative;z-index:1}.eyebrow{margin:0 0 18px;color:var(--green);font-size:10px;font-weight:750;letter-spacing:.19em}.hero h1,.form-wrap h1{margin:0;font:clamp(52px,6.5vw,88px)/.96 Georgia,"Times New Roman",serif;letter-spacing:-.055em;font-weight:400}.hero h1 em,.form-wrap h1 em,.invite h2 em{color:var(--green);font-weight:400}.lede{max-width:370px;margin:24px 0 28px;color:var(--soft);font:18px/1.55 Georgia,serif}.button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border:0;border-radius:2px;font:650 13px ui-sans-serif,system-ui,sans-serif;cursor:pointer}.button-dark{background:var(--green);color:var(--on-green)}.button-dark span{color:var(--on-green-accent)}.button-light{background:var(--paper);color:var(--ink)}.hero-note{margin:17px 0 0;color:var(--muted);font-size:11px}.hero-art{position:relative;overflow:hidden;width:min(100%,500px);height:380px;justify-self:end;background:linear-gradient(135deg,var(--art-1) 0%,var(--art-2) 47%,var(--art-3) 47%,var(--art-4) 100%);box-shadow:20px 24px 0 var(--art-shadow)}.hero-art:before{content:"";position:absolute;inset:18px;border:1px solid var(--art-frame);opacity:.7}.sun{position:absolute;top:46px;right:78px;width:132px;height:132px;border-radius:50%;background:var(--art-sun)}.shape{position:absolute;bottom:-50px;border-radius:50% 50% 0 0}.shape-one{left:4%;width:65%;height:63%;background:var(--shape-1);transform:rotate(-17deg)}.shape-two{right:-12%;width:62%;height:75%;background:var(--shape-2);transform:rotate(15deg)}.shape-three{left:27%;bottom:-28%;width:48%;height:65%;background:var(--shape-3);transform:rotate(33deg)}.shape-four{left:52%;bottom:-22%;width:30%;height:61%;background:var(--shape-4);transform:rotate(-24deg)}.art-caption{position:absolute;left:34px;bottom:28px;color:white;font:italic 18px/1.45 Georgia,serif}.art-caption b{font:10px ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase}.hero-index{position:absolute;right:0;bottom:22px;color:var(--muted);font-size:10px;letter-spacing:.15em}.gallery-section{padding:74px 0 92px}.section-head{display:flex;align-items:end;justify-content:space-between;margin-bottom:30px}.section-head .eyebrow{margin-bottom:11px}.section-head h2,.invite h2{margin:0;font:clamp(30px,4vw,48px)/1.1 Georgia,serif;font-weight:400;letter-spacing:-.03em}.count{margin-left:7px;vertical-align:top;color:var(--muted);font:11px ui-sans-serif,system-ui,sans-serif;letter-spacing:0}.text-link{font-size:12px}.gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:30px 22px}.art-card{min-width:0}.art-image{display:block;overflow:hidden;aspect-ratio:4/4.7;background:var(--frame)}.art-image img{width:100%;height:100%;display:block;object-fit:cover;transition:transform .35s}.art-card:hover img{transform:scale(1.025)}.art-info{padding:16px 1px}.art-info .eyebrow{font-size:9px;margin:0 0 8px}.art-info h3{margin:0;font:23px/1.2 Georgia,serif;font-weight:400}.art-info p{margin:7px 0 0;color:var(--muted);font:14px Georgia,serif}.empty{padding:72px 24px;text-align:center;background:var(--panel)}.empty-stamp{display:grid;place-items:center;width:55px;height:55px;margin:0 auto 20px;border:1px solid var(--green);border-radius:50%;color:var(--green);font-size:25px}.empty h3{margin:0;font:30px Georgia,serif;font-weight:400}.empty p{max-width:390px;margin:12px auto 22px;color:var(--muted);font:15px/1.6 Georgia,serif}.invite{margin:0 calc(-1 * max(6vw,24px));padding:76px max(6vw,24px);background:var(--green);color:var(--on-green);display:grid;grid-template-columns:1fr 1fr;gap:8%;align-items:center}.invite .eyebrow{color:var(--invite-eyebrow)}.invite h2 em{color:var(--invite-em)}.invite-copy p{max-width:360px;margin:0 0 24px;font:18px/1.55 Georgia,serif}.invite-copy small{display:block;max-width:390px;margin-top:15px;color:var(--invite-small);font-size:11px;line-height:1.5}.form-wrap{max-width:620px;margin:0 auto;padding:64px 0 100px}.back-link{display:inline-block;margin-bottom:52px;color:var(--muted);font-size:12px}.form-wrap .eyebrow{margin-bottom:16px}.form-wrap h1{font-size:clamp(48px,8vw,70px)}.form-intro{max-width:460px;margin:20px 0 30px;color:var(--soft);font:17px/1.6 Georgia,serif}.art-form{padding:30px;background:var(--white);border:1px solid var(--line)}.field{display:block;margin-bottom:21px}.field>span{display:block;margin-bottom:8px;font-size:12px;font-weight:700}.field b{color:var(--accent)}.field small{margin-left:7px;color:var(--muted);font-weight:400}.field input:not([type=file]),.field textarea{display:block;width:100%;min-height:48px;padding:12px 13px;border:1px solid var(--input-line);border-radius:2px;background:var(--input-bg);color:var(--ink);font:15px ui-sans-serif,system-ui,sans-serif}.field textarea{min-height:120px;resize:vertical}.upload-field input[type=file]{display:block;width:100%;min-height:54px;padding:13px;border:1px dashed var(--upload-line);background:var(--upload-bg);color:var(--ink);font-size:13px}.upload-field>small{display:block;margin:8px 0 0;color:var(--muted);font-size:11px}.permission{display:flex;gap:11px;align-items:flex-start;margin:24px 0;color:var(--soft);font-size:12px;line-height:1.55}.permission input{width:18px;height:18px;margin:0;flex:0 0 auto;accent-color:var(--green)}.submit-button{width:100%}.form-foot{margin:16px 0 0;color:var(--muted);font-size:11px;line-height:1.55}.error{padding:12px 14px;background:var(--error-bg);color:var(--error-ink);font-size:13px}.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}.detail-wrap{padding:48px 0 90px}.detail-wrap .back-link{margin-bottom:30px}.detail-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(280px,.75fr);gap:8%;align-items:start}.detail-image{display:block;width:100%;max-height:78vh;object-fit:contain;background:var(--frame)}.detail-copy{padding:10px 0}.detail-copy h1{margin:0;font:clamp(42px,6vw,72px)/1 Georgia,serif;font-weight:400;letter-spacing:-.04em}.detail-copy .artist{margin:13px 0 28px;color:var(--muted);font:18px Georgia,serif}.detail-description{margin:0 0 28px;font:16px/1.7 Georgia,serif}.footer-brand{font-size:17px}.footer-brand .brand-mark{width:33px;height:33px;font-size:21px}footer{display:flex;justify-content:space-between;align-items:center;padding:28px max(6vw,24px);border-top:1px solid var(--line)}footer p{max-width:240px;color:var(--muted);font:13px/1.5 Georgia,serif}input:focus-visible,textarea:focus-visible,a:focus-visible,button:focus-visible{outline:3px solid var(--focus);outline-offset:3px}@media(max-width:760px){.top{height:70px}.top nav{gap:16px;font-size:11px}.brand{font-size:17px}.brand small{font-size:8px}.hero{min-height:auto;padding:55px 0 65px;grid-template-columns:1fr;gap:38px}.hero h1{font-size:clamp(50px,13vw,76px)}.hero-art{width:100%;height:clamp(250px,75vw,380px);justify-self:stretch}.hero-index{bottom:18px}.gallery-section{padding:58px 0 68px}.section-head{align-items:start;gap:12px}.section-head .text-link{padding-top:20px;font-size:11px}.gallery{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 13px}.art-info h3{font-size:18px}.art-info p{font-size:12px}.invite{grid-template-columns:1fr;gap:24px;padding-top:56px;padding-bottom:58px}.form-wrap{padding:42px 0 72px}.back-link{margin-bottom:36px}.art-form{padding:20px}.detail-grid{grid-template-columns:1fr;gap:30px}.detail-image{max-height:65vh}footer{gap:18px;align-items:flex-start;flex-wrap:wrap}.theme-pick{flex-basis:100%}footer p{max-width:150px;font-size:12px}}@media(max-width:380px){.top{padding-inline:16px}.top nav{gap:12px}.top nav a:first-child{display:none}main{padding-inline:16px}.invite{margin-inline:-16px;padding-inline:16px}.hero-art{height:250px}.art-form{padding:16px}footer{padding-inline:16px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*:before,*:after{transition:none!important}}`
