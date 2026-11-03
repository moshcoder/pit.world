import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { RateLimiter } from './ratelimit.js'
import { AuctionLedger, BidError, BRIDGE_COOKIE, SESSION_COOKIE, SESSION_TTL, parseCookies, readSession, safeReturn, sessionValue, type Identity } from './auction-accounts.js'
import type { BridgeClient } from '@profullstack/bridges'
import { AuctionShop, OrderError, SHOP_STATES, adminOk, type ShopItem, type ShopOrder } from './auction-shop.js'

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
  topic: string
  created_at: number
  owner_sub: string
  starting_bid: number | null
  ends_at: number | null
  closed_at: number | null
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

export const AUCTION_TOPICS = {
  dahlias: { name: 'Dahlias', blurb: 'Dinner plates, pompons and cactus blooms in every medium.' },
  mums: { name: 'Mums', blurb: 'Chrysanthemums: spiders, spoons and autumn color.' },
  roses: { name: 'Roses', blurb: 'Garden roses, climbers and the classic bloom.' },
  seacliffs: { name: 'Sea cliffs', blurb: 'Coastal bluffs, surf and the edge of the land.' },
} as const
export type AuctionTopic = keyof typeof AUCTION_TOPICS
export const isTopic = (value: unknown): value is AuctionTopic => typeof value === 'string' && Object.hasOwn(AUCTION_TOPICS, value)
const TOPIC_SLUGS = Object.keys(AUCTION_TOPICS) as AuctionTopic[]

function mediaTag(item: Artwork, lazy = true) {
  const src = `/image/${encodeURIComponent(item.id)}`
  const label = `${esc(item.title)} by ${esc(item.artist)}`
  return isVideo(item.image_type)
    ? `<video src="${src}" muted loop autoplay playsinline preload="metadata" aria-label="${label}"></video>`
    : `<img src="${src}" alt="${label}"${lazy ? ' loading="lazy"' : ''}>`
}

/** Drawn stand-in art for a topic with nothing on its walls yet. */
const flower = (slug: AuctionTopic) => slug === 'seacliffs'
  ? `<span class="flower-ph ph-seacliffs" aria-hidden="true"><span class="sky-sun"></span><span class="cliff"></span><span class="sea"></span></span>`
  : `<span class="flower-ph ph-${slug}" aria-hidden="true"><span class="flower"></span><span class="stem"></span></span>`

function topicDirectory(house: AuctionHouse) {
  const cards = TOPIC_SLUGS.map((slug) => {
    const t = AUCTION_TOPICS[slug]
    const count = house.countTopic(slug)
    const cover = house.list(1, slug)[0]
    return `<a class="topic-card" href="/topics/${slug}"><span class="topic-cover">${cover ? mediaTag(cover) : flower(slug)}</span><span class="topic-body"><span class="eyebrow">${count ? `${count} ${count === 1 ? 'PIECE' : 'PIECES'}` : 'OPEN CALL'}</span><h3>${t.name}</h3><p>${t.blurb}</p></span></a>`
  }).join('')
  return `<section id="topics" class="topics-section"><div class="section-head"><div><p class="eyebrow">THE DIRECTORY</p><h2>Browse by topic</h2></div><a class="text-link" href="/topics">All topics <span aria-hidden="true">↗</span></a></div><div class="topic-grid">${cards}</div></section>`
}

function placeholderTiles(slug: AuctionTopic) {
  const name = AUCTION_TOPICS[slug].name.replace(/s$/, '').toLowerCase()
  return `<div class="gallery">${[1, 2, 3].map((n) => `<a class="art-card placeholder-card" href="/new?topic=${slug}"><span class="art-image placeholder-tile">${flower(slug)}<span class="placeholder-label">Your ${esc(name)} here</span></span><div class="art-info"><span class="eyebrow">OPEN SPOT ${String(n).padStart(2, '0')}</span><h3>Add a piece</h3><p>Photo or short video</p></div></a>`).join('')}</div>`
}

function topicPage(house: AuctionHouse, slug: AuctionTopic, theme: AuctionTheme, shopCount = 0) {
  const t = AUCTION_TOPICS[slug]
  const works = house.list(48, slug)
  const others = TOPIC_SLUGS.filter((s) => s !== slug).map((s) => `<a href="/topics/${s}">${AUCTION_TOPICS[s].name}</a>`).join('')
  return page(theme, t.name, `<main><section class="gallery-section topic-page"><a class="back-link" href="/#topics">← All topics</a><div class="section-head"><div><p class="eyebrow">TOPIC</p><h2>${t.name} <span class="count">${works.length.toString().padStart(2, '0')}</span></h2><p class="topic-lede">${t.blurb}</p>${shopCount ? `<p class="topic-shop"><a class="text-link" href="/shop#${slug}">Shop ${t.name.toLowerCase()}: ${shopCount} ${shopCount === 1 ? 'item' : 'items'} shipped from US growers <span aria-hidden="true">↗</span></a></p>` : ''}</div><a class="text-link" href="/new?topic=${slug}">Submit a piece <span aria-hidden="true">↗</span></a></div>${works.length ? `<div class="gallery">${works.map(artworkCard).join('')}</div>` : placeholderTiles(slug)}<nav class="topic-chips" aria-label="Other topics">${others}</nav></section></main>`, `${t.name} in the Art Auctions House: ${t.blurb}`, `/topics/${slug}`)
}

function topicsIndex(house: AuctionHouse, theme: AuctionTheme) {
  return page(theme, 'Topics', `<main class="topics-main">${topicDirectory(house).replace('<a class="text-link" href="/topics">All topics <span aria-hidden="true">↗</span></a>', '<a class="text-link" href="/new">Submit a piece <span aria-hidden="true">↗</span></a>')}</main>`, 'Browse the Art Auctions House by topic.', '/topics')
}

type ArtworkImage = { image_type: string; image: Uint8Array }

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
// Caddy and the relay both cap a request body at 30 MiB, so a video stays under that with room for the form.
const MAX_VIDEO_BYTES = 25 * 1024 * 1024
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime'])
const isVideo = (type: string) => type.startsWith('video/')

/** The real video type from the file's first bytes, whatever the browser declared (phones often send none). */
export function sniffVideo(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm'
  if (bytes.length < 12 || String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') return null
  const brand = String.fromCharCode(...bytes.slice(8, 12))
  if (brand === 'qt  ') return 'video/quicktime'
  if (/^(isom|iso[2-9]|mp41|mp42|avc1|M4V |M4VP|dash|3gp[4-6]|3g2a|MSNV|f4v |mmp4)$/.test(brand)) return 'video/mp4'
  return null
}
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
<body><header class="top"><a class="brand" href="/" aria-label="Art Auctions home"><span class="brand-mark">A</span><span>Art Auctions<small>THE HOUSE FOR ORIGINAL WORK</small></span></a><nav><a href="/#gallery">Browse art</a><a href="/topics">Topics</a><a href="/shop">Shop</a><a href="/account">Account</a><a class="nav-cta" href="/new">Submit a piece <span aria-hidden="true">↗</span></a></nav></header>${body}<footer><a class="brand footer-brand" href="/"><span class="brand-mark">A</span><span>Art Auctions<small>ART, WITH A STORY.</small></span></a><p>A place for original work and the people who make it.</p>${themePicker(theme, canonicalPath)}</footer></body></html>`
}

function artworkCard(item: Artwork) {
  return `<article class="art-card"><a class="art-image" href="/art/${encodeURIComponent(item.id)}">${mediaTag(item)}</a><div class="art-info"><span class="eyebrow">${esc(item.medium || 'ORIGINAL WORK')}</span><h3><a href="/art/${encodeURIComponent(item.id)}">${esc(item.title)}</a></h3><p>by ${esc(item.artist)}</p></div></article>`
}

function home(house: AuctionHouse, theme: AuctionTheme) {
  const works = house.list()
  const gallery = works.length
    ? `<div class="gallery">${works.map(artworkCard).join('')}</div>`
    : `<div class="empty"><span class="empty-stamp" aria-hidden="true">✳</span><h3>The walls are waiting.</h3><p>Bring the first piece. Share the work you want the world to see.</p><a class="button button-dark" href="/new">Submit your artwork <span aria-hidden="true">↗</span></a></div>`
  return page(theme, 'Art Auctions House', `<main>
    <section class="hero"><div class="hero-copy"><p class="eyebrow">ART · PEOPLE · STORIES</p><h1>Good art deserves<br><em>a good home.</em></h1><p class="lede">A new house for original art, made by people with something to say.</p><a class="button button-dark" href="/new">Bring us a piece <span aria-hidden="true">↗</span></a><p class="hero-note">Made for artists. Ready for your camera roll.</p></div><div class="hero-art" role="img" aria-label="Abstract art in a warm gallery"><div class="sun"></div><div class="shape shape-one"></div><div class="shape shape-two"></div><div class="shape shape-three"></div><div class="shape shape-four"></div><span class="art-caption">A house for art<br><b>Vol. 01 · Open call</b></span></div><span class="hero-index">01 / 01</span></section>
    <section id="gallery" class="gallery-section"><div class="section-head"><div><p class="eyebrow">FROM THE WALLS</p><h2>Works in the house <span class="count">${works.length.toString().padStart(2, '0')}</span></h2></div><a class="text-link" href="/new">Submit your work <span aria-hidden="true">↗</span></a></div>${gallery}</section>
    ${topicDirectory(house)}
    <section class="invite"><div><p class="eyebrow">AN OPEN DOOR</p><h2>Make room<br><em>for your work.</em></h2></div><div class="invite-copy"><p>Send a photo and a few words about the piece. It will appear in the gallery with your name.</p><a class="button button-light" href="/new">Add your artwork <span aria-hidden="true">↗</span></a><small>Only share work you own or have permission to display. The gallery is public.</small></div></section>
  </main>`)
}

function formPage(theme: AuctionTheme, error = '', topic = '', signedIn = false) {
  return page(theme, 'Submit artwork', `<main><section class="form-wrap"><a class="back-link" href="/">← Back to the house</a><p class="eyebrow">ADD A PIECE TO THE WALLS</p><h1>Show us<br><em>what you made.</em></h1><p class="form-intro">Share a clear photo or a short video and a little about the work. Your submission will appear in the public gallery.</p>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}<form class="art-form" method="post" action="/new" enctype="multipart/form-data"><div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div><label class="field"><span>Title <b>*</b></span><input name="title" maxlength="120" autocomplete="off" required placeholder="What is this piece called?"></label><label class="field"><span>Artist name <b>*</b></span><input name="artist" maxlength="80" autocomplete="name" required placeholder="The name you want shown"></label><label class="field"><span>Medium <small>optional</small></span><input name="medium" maxlength="80" autocomplete="off" placeholder="Oil on canvas, ceramic, collage…"></label><label class="field"><span>Topic <small>optional</small></span><select name="topic"><option value="">No topic</option>${TOPIC_SLUGS.map((slug) => `<option value="${slug}"${slug === topic ? ' selected' : ''}>${AUCTION_TOPICS[slug].name}</option>`).join('')}</select></label><label class="field"><span>About the piece <small>optional</small></span><textarea name="description" rows="4" maxlength="1600" placeholder="A few words about the work"></textarea></label>${signedIn ? `<fieldset class="auction-fields"><legend>Auction it <small>optional</small></legend><div class="field-row two"><label class="field"><span>Starting bid (USD)</span><input name="starting_bid" type="number" min="1" step="1" inputmode="numeric" placeholder="20"></label><label class="field"><span>Runs for</span><select name="days"><option value="3">3 days</option><option value="7" selected>7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label></div><small>Buyers pay you directly at the CoinPay link in your <a href="/account">account</a>.</small></fieldset>` : `<p class="notice"><a href="/signin?return=%2Fnew">Sign in with CoinPay</a> to auction your piece and see your bids.</p>`}<label class="field upload-field"><span>Photo or video of your work <b>*</b></span><input name="image" type="file" accept="image/*,video/mp4,video/webm,video/quicktime,.mp4,.mov,.webm" required><small>Photos: JPEG, PNG, WebP, AVIF or HEIC up to 8 MB. Videos: MP4, MOV or WebM up to 25 MB.</small></label><label class="permission"><input type="checkbox" name="permission" value="yes" required><span>I own this work or have permission to share it, and I agree to display the photo and details publicly.</span></label><button class="button button-dark submit-button" type="submit">Add to the gallery <span aria-hidden="true">↗</span></button><p class="form-foot">Submissions are public as soon as they are added. Sign in with CoinPay to run an auction; winning bidders pay you directly.</p></form></section></main>`, undefined, '/new')
}

function detail(item: Artwork, theme: AuctionTheme, auctionHtml = '') {
  return page(theme, item.title, `<main><section class="detail-wrap"><a class="back-link" href="/#gallery">← Back to the gallery</a><div class="detail-grid">${isVideo(item.image_type) ? `<video class="detail-image" src="/image/${encodeURIComponent(item.id)}" controls playsinline preload="metadata" aria-label="${esc(item.title)} by ${esc(item.artist)}"></video>` : `<img class="detail-image" src="/image/${encodeURIComponent(item.id)}" alt="${esc(item.title)} by ${esc(item.artist)}">`}<div class="detail-copy"><p class="eyebrow">${esc(item.medium || 'ORIGINAL WORK')}</p><h1>${esc(item.title)}</h1><p class="artist">by ${esc(item.artist)}</p>${auctionHtml}${isTopic(item.topic) ? `<p class="topic-chips detail-topic"><a href="/topics/${item.topic}">${AUCTION_TOPICS[item.topic].name}</a></p>` : ''}${item.description ? `<p class="detail-description">${esc(item.description).replace(/\n/g, '<br>')}</p>` : ''}<a class="text-link" href="/new">Add your work <span aria-hidden="true">↗</span></a></div></div></section></main>`, 'A piece in the Art Auctions House gallery.', `/art/${encodeURIComponent(item.id)}`)
}

export class AuctionHouse {
  ledger!: AuctionLedger
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
    const columns = this.db.query<{ name: string }, []>('PRAGMA table_info(auction_artworks)').all().map((c) => c.name)
    if (!columns.includes('topic')) this.db.exec("ALTER TABLE auction_artworks ADD COLUMN topic TEXT NOT NULL DEFAULT ''")
    this.db.exec('CREATE INDEX IF NOT EXISTS auction_artworks_topic ON auction_artworks(topic, created_at DESC)')
    const have = this.db.query<{ name: string }, []>('PRAGMA table_info(auction_artworks)').all().map((c) => c.name)
    if (!have.includes('owner_sub')) this.db.exec("ALTER TABLE auction_artworks ADD COLUMN owner_sub TEXT NOT NULL DEFAULT ''")
    if (!have.includes('starting_bid')) this.db.exec('ALTER TABLE auction_artworks ADD COLUMN starting_bid INTEGER')
    if (!have.includes('ends_at')) this.db.exec('ALTER TABLE auction_artworks ADD COLUMN ends_at INTEGER')
    if (!have.includes('closed_at')) this.db.exec('ALTER TABLE auction_artworks ADD COLUMN closed_at INTEGER')
    this.ledger = new AuctionLedger(this.db)

    // Archive Anthony's test post privately, then remove it from every public artwork route.
    const cleanupId = '0RZW_lLDiS_z_1lM'
    const migrationName = 'remove-test-artwork-' + cleanupId
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS auction_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL); ' +
      "CREATE TABLE IF NOT EXISTS auction_artwork_archive (" +
      "id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, medium TEXT NOT NULL DEFAULT '', " +
      "description TEXT NOT NULL DEFAULT '', image_type TEXT NOT NULL, image BLOB NOT NULL, topic TEXT NOT NULL DEFAULT '', " +
      'created_at INTEGER NOT NULL, removed_at INTEGER NOT NULL, reason TEXT NOT NULL)',
    )
    if (!this.db.query<{ name: string }, [string]>('SELECT name FROM auction_migrations WHERE name = ?').get(migrationName)) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const removedAt = Date.now()
        this.db.query(
          'INSERT OR IGNORE INTO auction_artwork_archive ' +
          '(id, title, artist, medium, description, image_type, image, topic, created_at, removed_at, reason) ' +
          'SELECT id, title, artist, medium, description, image_type, image, topic, created_at, ?, ? ' +
          'FROM auction_artworks WHERE id = ?',
        ).run(removedAt, 'Anthony requested removal of this test post', cleanupId)
        this.db.query('DELETE FROM auction_artworks WHERE id = ?').run(cleanupId)
        this.db.query('INSERT INTO auction_migrations (name, applied_at) VALUES (?, ?)').run(migrationName, removedAt)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  list(limit = 48, topic?: AuctionTopic): Artwork[] {
    const n = Math.max(1, Math.min(100, limit))
    if (topic) return this.db.query<Artwork, [string, number]>('SELECT id, title, artist, medium, description, image_type, topic, created_at, owner_sub, starting_bid, ends_at, closed_at FROM auction_artworks WHERE topic = ? ORDER BY created_at DESC LIMIT ?').all(topic, n)
    return this.db.query<Artwork, [number]>('SELECT id, title, artist, medium, description, image_type, topic, created_at, owner_sub, starting_bid, ends_at, closed_at FROM auction_artworks ORDER BY created_at DESC LIMIT ?').all(n)
  }

  countTopic(topic: AuctionTopic): number {
    return this.db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM auction_artworks WHERE topic = ?').get(topic)?.n ?? 0
  }

  get(id: string): Artwork | null {
    return this.db.query<Artwork, [string]>('SELECT id, title, artist, medium, description, image_type, topic, created_at, owner_sub, starting_bid, ends_at, closed_at FROM auction_artworks WHERE id = ?').get(id) ?? null
  }

  image(id: string): ArtworkImage | null {
    return this.db.query<ArtworkImage, [string]>('SELECT image_type, image FROM auction_artworks WHERE id = ?').get(id) ?? null
  }

  add(input: { title: string; artist: string; medium: string; description: string; imageType: string; image: Uint8Array; topic?: AuctionTopic | ''; ownerSub?: string }, now = Date.now()): string {
    const id = randomBytes(12).toString('base64url')
    this.db.query('INSERT INTO auction_artworks (id, title, artist, medium, description, image_type, image, topic, owner_sub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.title, input.artist, input.medium, input.description, input.imageType, input.image, input.topic ?? '', input.ownerSub ?? '', now)
    return id
  }

  /** Put a piece up for auction (or change it while nobody has bid). */
  setAuction(id: string, startingBid: number, days: number, now = Date.now()) {
    if (!Number.isInteger(startingBid) || startingBid < 1 || startingBid > 1_000_000) throw new BidError('The starting bid must be a whole number of dollars.')
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new BidError('An auction runs 1 to 30 days.')
    const item = this.get(id)
    if (!item) throw new BidError('That piece is not in the house.')
    if (this.ledger.high(id)) throw new BidError('This auction already has bids, so its terms are fixed.')
    this.db.query('UPDATE auction_artworks SET starting_bid = ?, ends_at = ?, closed_at = NULL WHERE id = ?').run(startingBid, now + days * 86_400_000, id)
  }

  /** Close every auction whose time is up; returns what closed so the caller can send the notices. */
  closeDue(now = Date.now()): Artwork[] {
    const due = this.db.query<Artwork, [number]>(`SELECT id, title, artist, medium, description, image_type, topic, created_at, owner_sub, starting_bid, ends_at, closed_at FROM auction_artworks WHERE ends_at IS NOT NULL AND ends_at <= ? AND closed_at IS NULL`).all(now)
    for (const a of due) this.db.query('UPDATE auction_artworks SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(now, a.id)
    return due
  }

  ownedBy(sub: string): Artwork[] {
    return this.db.query<Artwork, [string]>(`SELECT id, title, artist, medium, description, image_type, topic, created_at, owner_sub, starting_bid, ends_at, closed_at FROM auction_artworks WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 100`).all(sub)
  }

  /** Archive, then remove. */
  remove(id: string, reason: string, now = Date.now()) {
    this.db.transaction(() => {
      this.db.query(`INSERT OR REPLACE INTO auction_artwork_archive (id, title, artist, medium, description, image_type, image, topic, created_at, removed_at, reason)
        SELECT id, title, artist, medium, description, image_type, image, topic, created_at, ?, ? FROM auction_artworks WHERE id = ?`).run(now, reason, id)
      this.db.query('DELETE FROM auction_artworks WHERE id = ?').run(id)
    })()
  }

  allowSubmission(ip: string): boolean {
    return this.submissions.take(ip)
  }
}

const SHOP_GROUPS: { topic: ShopItem['topic']; title: string; art: AuctionTopic }[] = [
  { topic: 'dahlias', title: 'Dahlias', art: 'dahlias' },
  { topic: 'mums', title: 'Mums', art: 'mums' },
  { topic: 'roses', title: 'Roses', art: 'roses' },
  { topic: 'other', title: 'Bouquets and more', art: 'roses' },
]
const shopArt = (item: ShopItem, lazy = true) => item.photo
  ? `<img class="shop-photo" src="/shop/photo/${encodeURIComponent(item.slug)}.jpg" alt="${esc(item.photo.caption || item.name)}"${lazy ? ' loading="lazy"' : ''}>`
  : flower((SHOP_GROUPS.find((g) => g.topic === item.topic) ?? SHOP_GROUPS[0]!).art)
const photoCredit = (item: ShopItem) => item.photo
  ? `<p class="photo-credit">${item.photo.caption ? `${esc(item.photo.caption)}. ` : ''}Photo: <a href="${esc(item.photo.source)}" rel="noreferrer">${esc(item.photo.author)}</a>${item.photo.license ? `, ${item.photo.licenseUrl ? `<a href="${esc(item.photo.licenseUrl)}" rel="license noreferrer">${esc(item.photo.license)}</a>` : esc(item.photo.license)}` : ''}, via Wikimedia Commons</p>`
  : ''
const shipsFromState = (item: ShopItem) => item.supplier.shipsFrom.split(',').pop()?.trim() ?? ''

function shopCard(item: ShopItem) {
  return `<a class="art-card shop-card" href="/shop/${encodeURIComponent(item.slug)}"><span class="art-image shop-art">${shopArt(item)}</span><div class="art-info"><span class="eyebrow">${item.season ? esc(item.season.toUpperCase()) : 'SHIPS FROM A US GROWER'}</span><h3>${esc(item.name)}</h3><p><b class="price">$${item.priceUsd}</b> · shipping included</p></div></a>`
}

function shopPage(shop: AuctionShop, theme: AuctionTheme) {
  const groups = SHOP_GROUPS.map((g) => ({ ...g, items: shop.catalog.filter((i) => i.topic === g.topic) })).filter((g) => g.items.length)
  const body = groups.length
    ? groups.map((g) => `<section id="${g.topic}" class="shop-group"><div class="section-head"><div><p class="eyebrow">THE SHOP</p><h2>${g.title} <span class="count">${String(g.items.length).padStart(2, '0')}</span></h2></div>${g.topic !== 'other' ? `<a class="text-link" href="/topics/${g.topic}">See the art <span aria-hidden="true">↗</span></a>` : ''}</div><div class="gallery">${g.items.map(shopCard).join('')}</div></section>`).join('')
    : `<div class="empty"><span class="empty-stamp" aria-hidden="true">✳</span><h3>The shelves are being stocked.</h3><p>Dahlias, mums and roses from US growers, coming soon.</p></div>`
  return page(theme, 'Flower shop', `<main><section class="gallery-section shop-page"><p class="eyebrow">THE FLOWER SHOP</p><h1 class="shop-title">Grow the <em>subject.</em></h1><p class="topic-lede">Tubers, plants and bushes from US growers, shipped straight to your door. Pay with crypto through CoinPay.</p>${!shop.open ? '<p class="notice">Checkout opens soon. You can browse in the meantime.</p>' : ''}${body}${shop.catalog.some((i) => i.photo) ? `<details class="credits"><summary>Photo credits</summary><ul>${shop.catalog.filter((i) => i.photo).map((i) => `<li>${esc(i.name)}: ${photoCredit(i).replace(/^<p class="photo-credit">|<\/p>$/g, '')}</li>`).join('')}</ul></details>` : ''}<p class="form-foot shop-terms">Every item ships directly from the grower to a US address. Live plants ship when the season allows; we email your tracking number when it ships. Questions: hello@pit.world.</p></section></main>`, 'Dahlias, mums and roses from US growers, shipped to your door. Pay with CoinPay.', '/shop')
}

function itemPage(shop: AuctionShop, item: ShopItem, theme: AuctionTheme, error = '', values: Record<string, string> = {}) {
  const v = (k: string) => esc(values[k] ?? '')
  const states = SHOP_STATES.map((s) => `<option${values.state === s ? ' selected' : ''}>${s}</option>`).join('')
  const form = shop.open
    ? `<form class="art-form shop-form" method="post" action="/shop/${encodeURIComponent(item.slug)}"><div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div><p class="eyebrow">SHIP TO</p><label class="field"><span>Full name <b>*</b></span><input name="name" maxlength="100" autocomplete="name" required value="${v('name')}" placeholder="Who it is for"></label><label class="field"><span>Email <b>*</b></span><input name="email" type="email" maxlength="254" autocomplete="email" required value="${v('email')}" placeholder="For your receipt and tracking"></label><label class="field"><span>Street address <b>*</b></span><input name="address1" maxlength="120" autocomplete="address-line1" required value="${v('address1')}"></label><label class="field"><span>Apt, suite <small>optional</small></span><input name="address2" maxlength="120" autocomplete="address-line2" value="${v('address2')}"></label><div class="field-row"><label class="field"><span>City <b>*</b></span><input name="city" maxlength="80" autocomplete="address-level2" required value="${v('city')}"></label><label class="field"><span>State <b>*</b></span><select name="state" autocomplete="address-level1" required><option value="">--</option>${states}</select></label><label class="field"><span>ZIP <b>*</b></span><input name="zip" maxlength="10" inputmode="numeric" autocomplete="postal-code" required value="${v('zip')}" placeholder="95010"></label></div><label class="field"><span>Gift note <small>optional</small></span><input name="note" maxlength="300" value="${v('note')}" placeholder="We pass it to the grower when they allow one"></label><label class="permission"><input type="checkbox" name="agree" value="yes" required><span>This is a US address. I understand it ships directly from the grower${item.season ? ` (${esc(item.season.toLowerCase())})` : ''}${item.restrictions ? `, and ${esc(item.restrictions)}` : ''}.</span></label><button class="button button-dark submit-button" type="submit">Pay $${item.priceUsd} with crypto <span aria-hidden="true">↗</span></button><p class="form-foot">Checkout is on CoinPay: pay with USDC, BTC, ETH, SOL and more. Your order is placed with the grower once the payment confirms.</p></form>`
    : '<p class="notice">Checkout opens soon.</p>'
  return page(theme, item.name, `<main><section class="detail-wrap"><a class="back-link" href="/shop#${item.topic}">← Back to the shop</a><div class="detail-grid"><div><div class="shop-hero">${shopArt(item, false)}</div>${photoCredit(item)}</div><div class="detail-copy"><p class="eyebrow">${item.season ? esc(item.season.toUpperCase()) : 'FROM A US GROWER'}</p><h1>${esc(item.name)}</h1><p class="artist"><b class="price">$${item.priceUsd}</b> · shipping included</p><p class="detail-description">${esc(item.blurb)}</p><ul class="shop-facts"><li>Ships from a grower in ${esc(shipsFromState(item))}</li>${item.restrictions ? `<li>${esc(item.restrictions.replace(/^it c/, 'C'))}</li>` : ''}<li>Paid in crypto through CoinPay</li></ul>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}${form}</div></div></section></main>`, `${item.name}: $${item.priceUsd}, shipped from a US grower.`, `/shop/${encodeURIComponent(item.slug)}`)
}

const STEPS: [ShopOrder['status'][], string][] = [[['open', 'creating', 'unknown'], 'Awaiting payment'], [['paid'], 'Paid, ordering from the grower'], [['placed'], 'Ordered from the grower'], [['shipped'], 'Shipped']]
function orderPage(order: ShopOrder, item: ShopItem | undefined, theme: AuctionTheme, key: string) {
  const at = STEPS.findIndex(([s]) => s.includes(order.status))
  const steps = order.status === 'cancelled' ? '<li class="done">Cancelled</li>' : STEPS.map(([, label], i) => `<li class="${i <= at ? 'done' : ''}">${label}</li>`).join('')
  return page(theme, 'Your order', `<main><section class="form-wrap"><a class="back-link" href="/shop">← Back to the shop</a><p class="eyebrow">ORDER ${esc(order.id.slice(0, 8).toUpperCase())}</p><h1>${esc(item?.name ?? 'Your order')}</h1><p class="form-intro">$${order.amount_usd} · shipping to ${esc(order.city)}, ${esc(order.state)}</p><ol class="order-steps">${steps}</ol>${order.tracking ? `<p class="detail-description">Tracking: <b>${esc(order.tracking)}</b></p>` : ''}${order.status === 'open' && order.url ? `<a class="button button-dark" href="${esc(order.url)}">Pay now <span aria-hidden="true">↗</span></a>` : ''}<p class="form-foot">Questions: hello@pit.world, with order ${esc(order.id.slice(0, 8).toUpperCase())}.</p></section></main>`, 'Order status.', `/shop/order/${order.id}?k=${key}`)
}

function adminPage(shop: AuctionShop, theme: AuctionTheme, token = '', message = '') {
  if (!token) return page(theme, 'Shop admin', `<main><section class="form-wrap"><p class="eyebrow">SHOP ADMIN</p><h1>Orders</h1>${message ? `<p class="error" role="alert">${esc(message)}</p>` : ''}<form class="art-form" method="post" action="/shop/admin"><label class="field"><span>Admin token</span><input name="token" type="password" autocomplete="current-password" required></label><button class="button button-dark submit-button" type="submit">Show orders</button></form></section></main>`, 'Shop admin.', '/shop/admin')
  const hidden = `<input type="hidden" name="token" value="${esc(token)}">`
  const rows = shop.list().map((o) => {
    const item = shop.item(o.item_slug)
    const actions = o.status === 'paid'
      ? `<form method="post" action="/shop/admin">${hidden}<input type="hidden" name="id" value="${esc(o.id)}"><input type="hidden" name="action" value="placed"><input name="ref" placeholder="Supplier order #"><button>Mark placed</button></form>`
      : ''
    const ship = o.status === 'paid' || o.status === 'placed'
      ? `<form method="post" action="/shop/admin">${hidden}<input type="hidden" name="id" value="${esc(o.id)}"><input type="hidden" name="action" value="shipped"><input name="tracking" placeholder="Tracking number" required><button>Mark shipped</button></form>`
      : ''
    return `<tr><td><b>${esc(o.status)}</b><br><small>${new Date(o.created_at).toISOString().slice(0, 16).replace('T', ' ')}</small></td><td>${esc(item?.name ?? o.item_slug)}<br><small>$${o.amount_usd}${item ? ` · <a href="${esc(item.supplier.url)}" rel="noreferrer">supplier</a>` : ''}</small></td><td>${esc(o.name)}<br><small>${esc(o.address1)}${o.address2 ? `, ${esc(o.address2)}` : ''}, ${esc(o.city)}, ${esc(o.state)} ${esc(o.zip)}<br>${esc(o.email)}</small>${o.note ? `<br><small>Note: ${esc(o.note)}</small>` : ''}</td><td><small>${esc(o.supplier_ref)} ${esc(o.tracking)}</small>${actions}${ship}</td></tr>`
  }).join('')
  return page(theme, 'Shop admin', `<main><section class="gallery-section"><p class="eyebrow">SHOP ADMIN</p><h2>Orders</h2>${message ? `<p class="notice">${esc(message)}</p>` : ''}<div class="admin-table"><table><thead><tr><th>Status</th><th>Item</th><th>Ship to</th><th>Fulfilment</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No orders yet.</td></tr>'}</tbody></table></div></section></main>`, 'Shop admin.', '/shop/admin')
}

/** Same-site form posts only. Chrome sends Origin: null under our no-referrer policy. */
function crossSite(c: { req: { header(name: string): string | undefined; url: string } }): boolean {
  const host = String(c.req.header('host') ?? new URL(c.req.url).host).trim().toLowerCase().replace(/:\d+$/, '')
  const origin = c.req.header('origin')
  const fetchSite = c.req.header('sec-fetch-site')
  if (origin === 'null') {
    if (fetchSite !== 'same-origin') return true
  } else if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== host) return true
    } catch {
      return true
    }
  }
  return Boolean(fetchSite && fetchSite !== 'same-origin')
}

const money = (n: number) => `$${n.toLocaleString('en-US')}`
function timeLeft(ms: number) {
  if (ms <= 0) return 'ended'
  const h = Math.floor(ms / 3_600_000), d = Math.floor(h / 24)
  return d >= 1 ? `${d} day${d === 1 ? '' : 's'} left` : h >= 1 ? `${h} hour${h === 1 ? '' : 's'} left` : `${Math.max(1, Math.floor(ms / 60_000))} min left`
}

/** The auction box on a piece's page. */
function auctionBlock(house: AuctionHouse, item: Artwork, viewer: Identity | null, isAdmin: boolean, now: number, message = '') {
  const canManage = Boolean(viewer && (isAdmin || (item.owner_sub && item.owner_sub === viewer.sub)))
  const notice = message ? `<p class="notice" role="status">${esc(message)}</p>` : ''
  const manage = canManage
    ? `<details class="manage"><summary>Manage this piece</summary>${!house.ledger.high(item.id) ? `<form method="post" action="/art/${encodeURIComponent(item.id)}/auction" class="inline-form"><label>Starting bid $<input name="starting_bid" type="number" min="1" step="1" required value="${item.starting_bid ?? ''}"></label><label>Runs <select name="days"><option value="3">3 days</option><option value="7" selected>7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label><button class="quiet-button">${item.starting_bid ? 'Update auction' : 'Start auction'}</button></form>` : '<p>Bids are in, so the auction terms are fixed.</p>'}<form method="post" action="/art/${encodeURIComponent(item.id)}/delete" onsubmit="return confirm('Delete this piece?')"><button class="quiet-button danger">Delete piece</button></form></details>`
    : ''
  if (!item.starting_bid || !item.ends_at) return notice + manage
  const high = house.ledger.high(item.id)
  const count = house.ledger.bids(item.id).length
  const ended = Boolean(item.closed_at) || item.ends_at <= now
  if (ended) {
    const won = high && viewer && high.bidder_sub === viewer.sub
    const payLink = item.owner_sub ? house.ledger.account(item.owner_sub)?.pay_link : ''
    return `${notice}<div class="auction-box ended"><p class="eyebrow">AUCTION ENDED</p>${high ? `<p class="bid-now">Sold for <b>${money(high.amount_usd)}</b> to ${esc(high.bidder_name)}</p>` : '<p class="bid-now">Ended with no bids.</p>'}${won ? `<p class="won">You won this piece.${payLink ? ` <a class="button button-dark" href="${esc(payLink)}" rel="noreferrer">Pay the artist on CoinPay <span aria-hidden="true">↗</span></a>` : ' The house will be in touch about payment and delivery.'}</p>` : ''}</div>${manage}`
  }
  const min = house.ledger.minimumNext(item.starting_bid, item.id)
  const own = viewer && item.owner_sub === viewer.sub
  const form = !viewer
    ? `<a class="button button-dark" href="/signin?return=${encodeURIComponent(`/art/${item.id}`)}">Sign in with CoinPay to bid <span aria-hidden="true">↗</span></a>`
    : own ? '<p class="form-foot">This is your piece.</p>'
    : `<form class="bid-form" method="post" action="/art/${encodeURIComponent(item.id)}/bid"><label><span>Your bid (USD)</span><input name="amount" type="number" min="${min}" step="1" required value="${min}" inputmode="numeric"></label><button class="button button-dark" type="submit">Place bid <span aria-hidden="true">↗</span></button></form><p class="form-foot">Bidding is free. If you win, you pay the artist directly${item.owner_sub ? ' at their CoinPay link' : ''}.</p>`
  return `${notice}<div class="auction-box"><p class="eyebrow">LIVE AUCTION · ${esc(timeLeft(item.ends_at - now).toUpperCase())}</p><p class="bid-now">${high ? `Current bid <b>${money(high.amount_usd)}</b> by ${esc(high.bidder_name)}` : `Starting bid <b>${money(item.starting_bid)}</b>`}</p><p class="form-foot">${count} ${count === 1 ? 'bid' : 'bids'} · next bid at least ${money(min)} · ends ${new Date(item.ends_at).toUTCString().replace(/:\d\d GMT$/, ' UTC')}</p>${form}</div>${manage}`
}

function accountPage(house: AuctionHouse, viewer: Identity | null, theme: AuctionTheme, signinReady: boolean, message = '', error = '') {
  if (!viewer) return page(theme, 'Account', `<main><section class="form-wrap"><p class="eyebrow">YOUR ACCOUNT</p><h1>Sign in with<br><em>CoinPay.</em></h1><p class="form-intro">One pit.world account, backed by CoinPay. Sign in to bid, to auction your work and to get paid directly by buyers.</p>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}${signinReady ? '<a class="button button-dark" href="/signin?return=%2Faccount">Continue with CoinPay <span aria-hidden="true">↗</span></a>' : '<p class="notice">Sign-in is being configured.</p>'}</section></main>`, 'Sign in to the Art Auctions House.', '/account')
  const acct = house.ledger.account(viewer.sub)
  const pieces = house.ownedBy(viewer.sub)
  const bids = house.ledger.myBids(viewer.sub)
  const now = Date.now()
  const pieceRows = pieces.map((a) => `<li><a href="/art/${encodeURIComponent(a.id)}">${esc(a.title)}</a>${a.starting_bid ? ` · ${(a.closed_at || (a.ends_at ?? 0) <= now) ? 'auction ended' : `auction live, ${house.ledger.high(a.id) ? `high bid ${money(house.ledger.high(a.id)!.amount_usd)}` : `starts at ${money(a.starting_bid)}`}`}` : ''}</li>`).join('')
  const seen = new Set<string>()
  const bidRows = bids.filter((b) => !seen.has(b.artwork_id) && seen.add(b.artwork_id)).map((b) => {
    const high = house.ledger.high(b.artwork_id)
    const ended = Boolean(b.closed_at) || (b.ends_at ?? 0) <= now
    const leading = high?.bidder_sub === viewer.sub
    return `<li><a href="/art/${encodeURIComponent(b.artwork_id)}">${esc(b.title)}</a> · your bid ${money(b.amount_usd)} · ${ended ? (leading ? '<b>you won</b>' : 'ended') : leading ? 'you are the high bidder' : `outbid at ${money(high?.amount_usd ?? 0)}`}</li>`
  }).join('')
  return page(theme, 'Account', `<main><section class="form-wrap account"><p class="eyebrow">YOUR ACCOUNT</p><h1>${esc(acct?.name || viewer.name || 'Welcome')}</h1><p class="form-intro">Signed in with CoinPay.</p>${message ? `<p class="notice" role="status">${esc(message)}</p>` : ''}${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
    <h2>Get paid</h2><form class="art-form" method="post" action="/account"><label class="field"><span>Your CoinPay pay link <small>optional</small></span><input name="pay_link" type="url" value="${esc(acct?.pay_link ?? '')}" placeholder="https://coinpayportal.com/… or https://pay.agent.pit.world/…"></label><p class="form-foot">Winning bidders on your pieces pay you here, straight to your CoinPay wallet. The house never holds the money.</p><label class="field"><span>Email for auction notices <small>optional, private</small></span><input name="email" type="email" value="${esc(acct?.email ?? '')}" placeholder="Only used to tell you when an auction ends"></label><button class="button button-dark submit-button" type="submit">Save</button></form>
    <h2>Your pieces</h2>${pieceRows ? `<ul class="account-list">${pieceRows}</ul>` : '<p class="form-foot">Nothing yet. <a href="/new">Submit a piece</a>.</p>'}
    <h2>Your bids</h2>${bidRows ? `<ul class="account-list">${bidRows}</ul>` : '<p class="form-foot">No bids yet.</p>'}
    <form method="post" action="/signout"><button class="quiet-button">Sign out</button></form></section></main>`, 'Your Art Auctions account.', '/account')
}

export type AuctionAppOptions = {
  shop?: AuctionShop
  adminToken?: string
  /** pit.world bridge (CoinPay sign-in) and the secret that signs our session cookie. */
  bridge?: BridgeClient | null
  sessionSecret?: string
  /** CoinPay subs that can manage every piece. */
  adminSubs?: string[]
  now?: () => number
}

export function createAuctionApp(house: AuctionHouse, options: AuctionAppOptions = {}) {
  const now = options.now ?? Date.now
  const secret = options.sessionSecret ?? ''
  const bridge = options.bridge ?? null
  const admins = new Set(options.adminSubs ?? [])
  const viewerOf = (c: { req: { header(name: string): string | undefined } }): Identity | null => readSession(parseCookies(c.req.header('cookie'))[SESSION_COOKIE], secret, now())
  const shop = options.shop ?? new AuctionShop(house.db, [], null)
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
    const all = image.image
    const headers: Record<string, string> = { 'content-type': image.image_type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes' }
    // Safari will not play a video unless the server answers byte ranges.
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '')
    if (range && (range[1] || range[2])) {
      const size = all.length
      let start = range[1] ? Number(range[1]) : size - Number(range[2])
      let end = range[1] && range[2] ? Number(range[2]) : size - 1
      start = Math.max(0, start)
      end = Math.min(end, size - 1)
      if (start > end || start >= size) return c.body(null, 416, { 'content-range': `bytes */${size}` })
      return c.body(all.slice(start, end + 1).buffer as ArrayBuffer, 206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}` })
    }
    return c.body(all.slice().buffer as ArrayBuffer, 200, headers)
  })
  app.get('/art/:id', (c) => {
    const item = house.get(c.req.param('id'))
    return item ? c.html(detail(item, themeOf(c), auctionBlock(house, item, viewerOf(c), Boolean(viewerOf(c) && admins.has(viewerOf(c)!.sub)), now()))) : c.html(page(themeOf(c), 'Not found', '<main><section class="empty"><h1>This piece is not here.</h1><a class="button button-dark" href="/">Back to the house</a></section></main>'), 404)
  })
  app.get('/new', (c) => { const topic = c.req.query('topic'); return c.html(formPage(themeOf(c), '', isTopic(topic) ? topic : '', Boolean(viewerOf(c)))) })
  app.get('/topics', (c) => c.html(topicsIndex(house, themeOf(c))))
  app.get('/topics/:slug', (c) => {
    const slug = c.req.param('slug').toLowerCase()
    return isTopic(slug) ? c.html(topicPage(house, slug, themeOf(c), shop.catalog.filter((i) => i.topic === slug).length)) : c.html(page(themeOf(c), 'Not found', '<main><section class="empty"><h1>That topic is not in the house yet.</h1><a class="button button-dark" href="/topics">See all topics</a></section></main>'), 404)
  })
  app.post('/new', async (c) => {
    if (crossSite(c)) return c.text('Forbidden', 403)
    const theme = themeOf(c)
    const ip = c.env?.ip ?? c.req.header('x-real-ip') ?? 'unknown'
    if (!house.allowSubmission(String(ip))) return c.html(formPage(theme, 'Too many submissions from this connection. Please try again later.'), 429)
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>) as Record<string, string | File>
    if (clean(body.website, 160)) return c.redirect('/', 303)
    const title = clean(body.title, 120)
    const artist = clean(body.artist, 80)
    const medium = clean(body.medium, 80)
    const topic = isTopic(body.topic) ? body.topic : ''
    const description = clean(body.description, 1600)
    if (!title || !artist) return c.html(formPage(theme, 'Add a title and artist name to continue.'), 400)
    if (body.permission !== 'yes') return c.html(formPage(theme, 'Please confirm you have permission to share this work.'), 400)
    const image = body.image
    if (!(image instanceof File) || image.size === 0) return c.html(formPage(theme, 'Choose a photo or video of your work to continue.'), 400)
    const declared = image.type.toLowerCase()
    const wantsVideo = isVideo(declared) || (!IMAGE_TYPES.has(declared) && /\.(mp4|m4v|mov|webm)$/i.test(image.name))
    if (wantsVideo) {
      if (image.size > MAX_VIDEO_BYTES) return c.html(formPage(theme, 'That video is over 25 MB. Trim it or export a smaller version and try again.'), 413)
    } else {
      if (image.size > MAX_IMAGE_BYTES) return c.html(formPage(theme, 'That photo is over 8 MB. Choose a smaller image and try again.'), 413)
      if (!IMAGE_TYPES.has(declared)) return c.html(formPage(theme, 'Choose a JPEG, PNG, WebP, AVIF or HEIC photo, or an MP4, MOV or WebM video.'), 415)
    }
    const bytes = new Uint8Array(await image.arrayBuffer())
    let imageType = declared
    if (wantsVideo) {
      const sniffed = sniffVideo(bytes)
      if (!sniffed || !VIDEO_TYPES.has(sniffed)) return c.html(formPage(theme, 'That file does not look like an MP4, MOV or WebM video.'), 415)
      imageType = sniffed
    } else if (!validImage(imageType, bytes)) return c.html(formPage(theme, 'That file does not look like a supported image.'), 415)
    const viewer = viewerOf(c)
    const id = house.add({ title, artist, medium, description, imageType, image: bytes, topic, ownerSub: viewer?.sub ?? '' })
    const start = Number(clean(body.starting_bid, 10))
    if (viewer && start > 0) {
      try { house.setAuction(id, Math.round(start), Number(body.days ?? 7), now()) } catch { /* the piece is in; the auction can be set from its page */ }
    }
    return c.redirect(`/art/${encodeURIComponent(id)}`, 303)
  })
  app.get('/', (c) => c.html(home(house, themeOf(c))))
  app.post('/shop/webhooks/coinpay', async (c) => {
    const raw = await c.req.text()
    if (!shop.verifyWebhook(raw, c.req.header('x-coinpay-signature'))) return c.json({ error: 'bad signature' }, 401)
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { return c.json({ error: 'bad json' }, 400) }
    await shop.onWebhook(payload)
    return c.json({ ok: true })
  })
  app.get('/signin', async (c) => {
    if (!bridge || !secret) return c.html(accountPage(house, null, themeOf(c), false), 503)
    const started = await bridge.begin({ returnTo: safeReturn(c.req.query('return') ?? '/account'), prompt: 'login' })
    c.header('set-cookie', `${BRIDGE_COOKIE}=${encodeURIComponent(started.cookie)}; Path=/; Max-Age=${started.maxAge}; HttpOnly; Secure; SameSite=Lax`)
    return c.redirect(started.url, 302)
  })
  app.get('/auth/bridge/callback', async (c) => {
    if (!bridge || !secret) return c.redirect('/account', 302)
    const result = await bridge.complete(c.req.url, parseCookies(c.req.header('cookie'))[BRIDGE_COOKIE])
    c.header('set-cookie', `${BRIDGE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
    if (!result.ok) return c.html(accountPage(house, null, themeOf(c), true, '', `Sign-in did not finish (${result.error}). Please try again.`), 400)
    const identity: Identity = { sub: result.user.sub, name: (result.user.name || result.user.username || '').slice(0, 80) || null }
    house.ledger.touch(identity, now())
    c.header('set-cookie', `${SESSION_COOKIE}=${encodeURIComponent(sessionValue(identity, secret, now()))}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; Secure; SameSite=Lax`, { append: true })
    return c.redirect(safeReturn(result.returnTo), 302)
  })
  app.post('/signout', (c) => {
    if (crossSite(c)) return c.text('Forbidden', 403)
    c.header('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
    return c.redirect('/', 303)
  })
  app.get('/account', (c) => c.html(accountPage(house, viewerOf(c), themeOf(c), Boolean(bridge && secret))))
  app.post('/account', async (c) => {
    if (crossSite(c)) return c.text('Forbidden', 403)
    const viewer = viewerOf(c)
    if (!viewer) return c.redirect('/account', 303)
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, string>
    try {
      house.ledger.saveSettings(viewer.sub, { payLink: body.pay_link, email: body.email }, now())
      return c.html(accountPage(house, viewer, themeOf(c), true, 'Saved.'))
    } catch (error) {
      return c.html(accountPage(house, viewer, themeOf(c), true, '', error instanceof BidError ? error.message : 'That did not save.'), 400)
    }
  })
  const pieceAction = async (c: any, run: (item: Artwork, viewer: Identity, body: Record<string, string>) => string | Response) => {
    if (crossSite(c)) return c.text('Forbidden', 403)
    const item = house.get(c.req.param('id'))
    if (!item) return c.text('Not found', 404)
    const viewer = viewerOf(c)
    if (!viewer) return c.redirect(`/signin?return=${encodeURIComponent(`/art/${item.id}`)}`, 303)
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, string>
    let message = ''
    try {
      const out = run(item, viewer, body)
      if (out instanceof Response) return out
      message = out
    } catch (error) {
      message = error instanceof BidError ? error.message : 'That did not work.'
    }
    const fresh = house.get(item.id)!
    return c.html(detail(fresh, themeOf(c), auctionBlock(house, fresh, viewer, admins.has(viewer.sub), now(), message)))
  }
  const manages = (item: Artwork, viewer: Identity) => admins.has(viewer.sub) || (item.owner_sub !== '' && item.owner_sub === viewer.sub)
  app.post('/art/:id/bid', (c) => pieceAction(c, (item, viewer, body) => {
    if (!item.starting_bid || !item.ends_at || item.closed_at) throw new BidError('This piece is not up for auction.')
    const bid = house.ledger.place({ id: item.id, startingBid: item.starting_bid, endsAt: item.ends_at, ownerSub: item.owner_sub }, viewer, body.amount, now())
    return `Your bid of ${money(bid.amount_usd)} is in. You are the high bidder.`
  }))
  app.post('/art/:id/auction', (c) => pieceAction(c, (item, viewer, body) => {
    if (!manages(item, viewer)) throw new BidError('Only the artist or the house can change this auction.')
    house.setAuction(item.id, Number(body.starting_bid), Number(body.days ?? 7), now())
    return 'The auction is live.'
  }))
  app.post('/art/:id/delete', (c) => pieceAction(c, (item, viewer) => {
    if (!manages(item, viewer)) throw new BidError('Only the artist or the house can delete this piece.')
    if (house.ledger.high(item.id) && !admins.has(viewer.sub)) throw new BidError('This piece has bids. Ask the house to remove it.')
    house.remove(item.id, `deleted by ${admins.has(viewer.sub) ? 'admin' : 'owner'} ${viewer.sub}`, now())
    return new Response(null, { status: 303, headers: { location: '/account' } })
  }))
  app.get('/shop/photo/:file', async (c) => {
    const m = /^([a-z0-9-]+)\.jpg$/.exec(c.req.param('file'))
    const item = m ? shop.item(m[1]!) : undefined
    if (!item?.photo) return c.text('Not found', 404)
    const file = Bun.file(new URL(`../assets/shop/${item.slug}.jpg`, import.meta.url))
    if (!(await file.exists())) return c.text('Not found', 404)
    return c.body(await file.arrayBuffer(), 200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' })
  })
  app.get('/shop', (c) => c.html(shopPage(shop, themeOf(c))))
  app.get('/shop/admin', (c) => c.html(adminPage(shop, themeOf(c))))
  app.post('/shop/admin', async (c) => {
    if (crossSite(c)) return c.text('Forbidden', 403)
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, string>
    const theme = themeOf(c)
    if (!adminOk(options.adminToken, body.token)) return c.html(adminPage(shop, theme, '', options.adminToken ? 'That token is not right.' : 'Set PIT_ADMIN_TOKEN to use the shop admin.'), 403)
    let message = ''
    try {
      if (body.action === 'placed') { await shop.markPlaced(String(body.id), String(body.ref ?? '')); message = 'Marked placed.' }
      else if (body.action === 'shipped') { await shop.markShipped(String(body.id), String(body.tracking ?? '')); message = 'Marked shipped; the buyer was emailed the tracking number.' }
    } catch (error) {
      message = error instanceof OrderError ? error.message : 'That did not work.'
    }
    return c.html(adminPage(shop, theme, String(body.token), message))
  })
  app.get('/shop/order/:id', (c) => {
    const key = c.req.query('k') ?? ''
    const order = shop.view(c.req.param('id'), key)
    if (!order) return c.html(page(themeOf(c), 'Not found', '<main><section class="empty"><h1>We could not find that order.</h1><p>Use the link from your order email.</p><a class="button button-dark" href="/shop">Back to the shop</a></section></main>'), 404)
    return c.html(orderPage(order, shop.item(order.item_slug), themeOf(c), key))
  })
  app.get('/shop/:slug', (c) => {
    const item = shop.item(c.req.param('slug'))
    return item ? c.html(itemPage(shop, item, themeOf(c))) : c.html(page(themeOf(c), 'Not found', '<main><section class="empty"><h1>That item is not in the shop.</h1><a class="button button-dark" href="/shop">Back to the shop</a></section></main>'), 404)
  })
  app.post('/shop/:slug', async (c) => {
    if (crossSite(c)) return c.text('Forbidden', 403)
    const item = shop.item(c.req.param('slug'))
    if (!item) return c.text('Not found', 404)
    const theme = themeOf(c)
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, string>
    if (clean(body.website, 160)) return c.redirect('/shop', 303)
    const ip = String(c.env?.ip ?? c.req.header('x-real-ip') ?? 'unknown')
    if (!shop.allow(ip)) return c.html(itemPage(shop, item, theme, 'Too many orders from this connection. Please try again in a few minutes.', body), 429)
    try {
      const { payUrl } = await shop.start(item.slug, body)
      return c.redirect(payUrl, 303)
    } catch (error) {
      return c.html(itemPage(shop, item, theme, error instanceof OrderError ? error.message : 'Checkout failed. Please try again.', body), 400)
    }
  })
  app.notFound((c) => c.html(page(themeOf(c), 'Not found', '<main><section class="empty"><h1>This page is not in the house.</h1><a class="button button-dark" href="/">Back to the house</a></section></main>'), 404))
  return app
}

const AUCTIONS_CSS = `/* Themes: "warm" (the original cream and green house look) is the default; "blue" is a visitor choice. */
:root,[data-theme=warm]{color-scheme:light;--ink:#24251f;--muted:#74756c;--soft:#595b52;--paper:#f3eee5;--white:#fffdf8;--green:#384b36;--on-green:#fffdf8;--on-green-accent:#f2b393;--line:#d9d3c7;--accent:#d16d48;--frame:#e4ddd1;--panel:#eae3d8;--art-1:#d9c3aa;--art-2:#bd9a7f;--art-3:#75866b;--art-4:#354b3e;--art-shadow:#e5d9c8;--art-frame:#fff8e0;--art-sun:#e6a75f;--shape-1:#38523f;--shape-2:#ad6650;--shape-3:#e8d6ae;--shape-4:#c78d5f;--invite-eyebrow:#d9bd91;--invite-em:#ddc69f;--invite-small:#d5d7cd;--input-line:#c9c4b9;--input-bg:#fff;--upload-line:#a8aa9d;--upload-bg:#f7f4ed;--error-bg:#f7e1d8;--error-ink:#7a3025;--focus:#cf7d5b}
/* Blue must come after the :root default: equal specificity, so source order decides. */
html[data-theme=blue]{--ink:#16213a;--muted:#5f6b82;--soft:#46526a;--paper:#eef3fa;--white:#fbfdff;--green:#1f4f8f;--on-green:#f6f9ff;--on-green-accent:#9cc7ff;--line:#d2dcea;--accent:#2f7fe0;--frame:#dbe4f1;--panel:#e2eaf5;--art-1:#c9d8ee;--art-2:#8eaad3;--art-3:#3d6aa8;--art-4:#13294d;--art-shadow:#d6e1f1;--art-frame:#f2f7ff;--art-sun:#f1f5fb;--shape-1:#183865;--shape-2:#4b7fc4;--shape-3:#dbe7f6;--shape-4:#7aa3d9;--invite-eyebrow:#a8c9f2;--invite-em:#c6dcf8;--invite-small:#c5d1e4;--input-line:#c0cbdc;--input-bg:#fff;--upload-line:#98a8c2;--upload-bg:#f4f7fc;--error-bg:#fbe4e4;--error-ink:#8a2b2b;--focus:#3b82f6}
.theme-pick{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:11px;letter-spacing:.08em}.theme-pick a{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--line);border-radius:999px;color:var(--ink)}.theme-pick a[aria-current=true]{border-color:var(--green);font-weight:700}.theme-pick i{display:inline-block;width:10px;height:10px;border-radius:50%}.swatch-blue{background:#1f4f8f}.swatch-warm{background:#384b36}
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-synthesis:none;text-rendering:optimizeLegibility}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink)}a{color:inherit;text-decoration:none}.top{height:82px;padding:0 max(6vw,24px);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:12px;font-family:Georgia,serif;font-size:20px;line-height:1}.brand small{display:block;margin-top:7px;font:9px/1.1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.15em;color:var(--muted)}.brand-mark{display:grid;place-items:center;width:38px;height:38px;border:1px solid var(--green);border-radius:50%;color:var(--green);font:italic 24px Georgia,serif}.top nav{display:flex;align-items:center;gap:32px;font-size:13px}.top nav a:first-child{color:var(--muted)}.nav-cta,.text-link{font-weight:650}.nav-cta span,.text-link span,.button span{margin-left:8px;color:var(--accent)}main{max-width:1440px;margin:0 auto;padding:0 max(6vw,24px)}.hero{position:relative;min-height:540px;padding:76px 0 86px;display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:8%;border-bottom:1px solid var(--line)}.hero-copy{position:relative;z-index:1}.eyebrow{margin:0 0 18px;color:var(--green);font-size:10px;font-weight:750;letter-spacing:.19em}.hero h1,.form-wrap h1{margin:0;font:clamp(52px,6.5vw,88px)/.96 Georgia,"Times New Roman",serif;letter-spacing:-.055em;font-weight:400}.hero h1 em,.form-wrap h1 em,.invite h2 em{color:var(--green);font-weight:400}.lede{max-width:370px;margin:24px 0 28px;color:var(--soft);font:18px/1.55 Georgia,serif}.button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border:0;border-radius:2px;font:650 13px ui-sans-serif,system-ui,sans-serif;cursor:pointer}.button-dark{background:var(--green);color:var(--on-green)}.button-dark span{color:var(--on-green-accent)}.button-light{background:var(--paper);color:var(--ink)}.hero-note{margin:17px 0 0;color:var(--muted);font-size:11px}.hero-art{position:relative;overflow:hidden;width:min(100%,500px);height:380px;justify-self:end;background:linear-gradient(135deg,var(--art-1) 0%,var(--art-2) 47%,var(--art-3) 47%,var(--art-4) 100%);box-shadow:20px 24px 0 var(--art-shadow)}.hero-art:before{content:"";position:absolute;inset:18px;border:1px solid var(--art-frame);opacity:.7}.sun{position:absolute;top:46px;right:78px;width:132px;height:132px;border-radius:50%;background:var(--art-sun)}.shape{position:absolute;bottom:-50px;border-radius:50% 50% 0 0}.shape-one{left:4%;width:65%;height:63%;background:var(--shape-1);transform:rotate(-17deg)}.shape-two{right:-12%;width:62%;height:75%;background:var(--shape-2);transform:rotate(15deg)}.shape-three{left:27%;bottom:-28%;width:48%;height:65%;background:var(--shape-3);transform:rotate(33deg)}.shape-four{left:52%;bottom:-22%;width:30%;height:61%;background:var(--shape-4);transform:rotate(-24deg)}.art-caption{position:absolute;left:34px;bottom:28px;color:white;font:italic 18px/1.45 Georgia,serif}.art-caption b{font:10px ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase}.hero-index{position:absolute;right:0;bottom:22px;color:var(--muted);font-size:10px;letter-spacing:.15em}.gallery-section{padding:74px 0 92px}.section-head{display:flex;align-items:end;justify-content:space-between;margin-bottom:30px}.section-head .eyebrow{margin-bottom:11px}.section-head h2,.invite h2{margin:0;font:clamp(30px,4vw,48px)/1.1 Georgia,serif;font-weight:400;letter-spacing:-.03em}.count{margin-left:7px;vertical-align:top;color:var(--muted);font:11px ui-sans-serif,system-ui,sans-serif;letter-spacing:0}.text-link{font-size:12px}.gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:30px 22px}.art-card{min-width:0}.art-image{display:block;overflow:hidden;aspect-ratio:4/4.7;background:var(--frame)}.art-image img,.art-image video{width:100%;height:100%;display:block;object-fit:cover;transition:transform .35s}.art-card:hover img,.art-card:hover video{transform:scale(1.025)}.art-info{padding:16px 1px}.art-info .eyebrow{font-size:9px;margin:0 0 8px}.art-info h3{margin:0;font:23px/1.2 Georgia,serif;font-weight:400}.art-info p{margin:7px 0 0;color:var(--muted);font:14px Georgia,serif}.empty{padding:72px 24px;text-align:center;background:var(--panel)}.empty-stamp{display:grid;place-items:center;width:55px;height:55px;margin:0 auto 20px;border:1px solid var(--green);border-radius:50%;color:var(--green);font-size:25px}.empty h3{margin:0;font:30px Georgia,serif;font-weight:400}.empty p{max-width:390px;margin:12px auto 22px;color:var(--muted);font:15px/1.6 Georgia,serif}.invite{margin:0 calc(-1 * max(6vw,24px));padding:76px max(6vw,24px);background:var(--green);color:var(--on-green);display:grid;grid-template-columns:1fr 1fr;gap:8%;align-items:center}.invite .eyebrow{color:var(--invite-eyebrow)}.invite h2 em{color:var(--invite-em)}.invite-copy p{max-width:360px;margin:0 0 24px;font:18px/1.55 Georgia,serif}.invite-copy small{display:block;max-width:390px;margin-top:15px;color:var(--invite-small);font-size:11px;line-height:1.5}.form-wrap{max-width:620px;margin:0 auto;padding:64px 0 100px}.back-link{display:inline-block;margin-bottom:52px;color:var(--muted);font-size:12px}.form-wrap .eyebrow{margin-bottom:16px}.form-wrap h1{font-size:clamp(48px,8vw,70px)}.form-intro{max-width:460px;margin:20px 0 30px;color:var(--soft);font:17px/1.6 Georgia,serif}.art-form{padding:30px;background:var(--white);border:1px solid var(--line)}.field{display:block;margin-bottom:21px}.field>span{display:block;margin-bottom:8px;font-size:12px;font-weight:700}.field b{color:var(--accent)}.field small{margin-left:7px;color:var(--muted);font-weight:400}.field input:not([type=file]),.field textarea{display:block;width:100%;min-height:48px;padding:12px 13px;border:1px solid var(--input-line);border-radius:2px;background:var(--input-bg);color:var(--ink);font:15px ui-sans-serif,system-ui,sans-serif}.field textarea{min-height:120px;resize:vertical}.upload-field input[type=file]{display:block;width:100%;min-height:54px;padding:13px;border:1px dashed var(--upload-line);background:var(--upload-bg);color:var(--ink);font-size:13px}.upload-field>small{display:block;margin:8px 0 0;color:var(--muted);font-size:11px}.permission{display:flex;gap:11px;align-items:flex-start;margin:24px 0;color:var(--soft);font-size:12px;line-height:1.55}.permission input{width:18px;height:18px;margin:0;flex:0 0 auto;accent-color:var(--green)}.submit-button{width:100%}.form-foot{margin:16px 0 0;color:var(--muted);font-size:11px;line-height:1.55}.error{padding:12px 14px;background:var(--error-bg);color:var(--error-ink);font-size:13px}.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}.detail-wrap{padding:48px 0 90px}.detail-wrap .back-link{margin-bottom:30px}.detail-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(280px,.75fr);gap:8%;align-items:start}.detail-image{display:block;width:100%;max-height:78vh;object-fit:contain;background:var(--frame)}.detail-copy{padding:10px 0}.detail-copy h1{margin:0;font:clamp(42px,6vw,72px)/1 Georgia,serif;font-weight:400;letter-spacing:-.04em}.detail-copy .artist{margin:13px 0 28px;color:var(--muted);font:18px Georgia,serif}.detail-description{margin:0 0 28px;font:16px/1.7 Georgia,serif}.footer-brand{font-size:17px}.footer-brand .brand-mark{width:33px;height:33px;font-size:21px}footer{display:flex;justify-content:space-between;align-items:center;padding:28px max(6vw,24px);border-top:1px solid var(--line)}footer p{max-width:240px;color:var(--muted);font:13px/1.5 Georgia,serif}.field select{display:block;width:100%;min-height:48px;padding:12px 13px;border:1px solid var(--input-line);border-radius:2px;background:var(--input-bg);color:var(--ink);font:15px ui-sans-serif,system-ui,sans-serif}.topics-section{padding:0 0 92px}.topic-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:22px}.topic-card{display:flex;flex-direction:column;border:1px solid var(--line);background:var(--white);transition:border-color .2s}.topic-card:hover{border-color:var(--green)}.topic-cover{position:relative;display:block;overflow:hidden;aspect-ratio:4/3;background:var(--panel)}.topic-cover img,.topic-cover video{width:100%;height:100%;display:block;object-fit:cover}.topic-body{display:block;padding:18px 20px 22px}.topic-body .eyebrow{display:block;margin:0 0 8px;font-size:9px}.topic-body h3{margin:0;font:26px/1.15 Georgia,serif;font-weight:400}.topic-body p{margin:8px 0 0;color:var(--muted);font:14px/1.5 Georgia,serif}.topic-lede{max-width:460px;margin:10px 0 0;color:var(--soft);font:16px/1.55 Georgia,serif}.topic-page .back-link{margin-bottom:30px}.topic-chips{display:flex;flex-wrap:wrap;gap:8px;margin:34px 0 0}.topic-chips a{padding:7px 13px;border:1px solid var(--line);border-radius:999px;font-size:12px;font-weight:650}.topic-chips a:hover{border-color:var(--green)}.detail-topic{margin:-14px 0 24px}.flower-ph{position:absolute;inset:0;display:block;background:radial-gradient(circle at 50% 120%,var(--frame),var(--panel) 70%)}.flower{position:absolute;left:50%;top:42%;width:46%;aspect-ratio:1;transform:translate(-50%,-50%);border-radius:50%;z-index:1}.flower:after{content:"";position:absolute;inset:36%;border-radius:50%;background:var(--c3)}.stem{position:absolute;left:calc(50% - 2px);top:64%;width:4px;height:40%;background:#5f7d4f;border-radius:2px}.stem:before{content:"";position:absolute;left:4px;top:30%;width:34px;height:16px;border-radius:0 100% 0 100%;background:#6f8f5c}.ph-dahlias .flower{--c3:#f2c35b;background:repeating-conic-gradient(#c2416b 0 9deg,#e98aa6 9deg 18deg);box-shadow:0 0 0 10px #d65f86 inset}.ph-mums .flower{--c3:#9a6a22;background:repeating-conic-gradient(#d9962b 0 5deg,#f6cf6a 5deg 10deg)}.ph-roses .flower{--c3:transparent;background:radial-gradient(circle,#6e1028 0 10%,#c8455e 11% 22%,#9e1f3a 23% 36%,#c8455e 37% 50%,#9e1f3a 51% 70%)}.ph-seacliffs{background:linear-gradient(#cfe0ec 0 58%,#8fb3cc 58%)}.sky-sun{position:absolute;right:20%;top:16%;width:16%;aspect-ratio:1;border-radius:50%;background:#f6d48a}.cliff{position:absolute;left:0;bottom:22%;width:58%;height:62%;background:#8a6f55;clip-path:polygon(0 18%,30% 6%,58% 14%,82% 30%,100% 100%,0 100%);box-shadow:inset -14px 0 0 #6f5640}.cliff:before{content:"";position:absolute;left:0;top:0;width:100%;height:18%;background:#6f8f5c;clip-path:polygon(0 100%,0 0,30% 0,58% 40%,82% 100%)}.sea{position:absolute;left:0;right:0;bottom:0;height:24%;background:repeating-linear-gradient(170deg,#4f7fa6 0 8px,#5f90b6 8px 16px)}.placeholder-tile{position:relative;border:1px dashed var(--upload-line)}.placeholder-label{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);padding:6px 14px;border-radius:999px;background:var(--white);color:var(--soft);font:italic 14px Georgia,serif;white-space:nowrap;z-index:2}.topics-main .topics-section{padding-top:64px}.placeholder-card .art-info h3{color:var(--muted)}.shop-page .shop-title{margin:0;font:clamp(46px,6vw,78px)/1 Georgia,"Times New Roman",serif;letter-spacing:-.045em;font-weight:400}.shop-page .shop-title em{color:var(--green)}.shop-group{padding-top:58px}.shop-art{position:relative}.shop-photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}.photo-credit{margin:10px 0 0;color:var(--muted);font-size:11px;line-height:1.5}.photo-credit a{text-decoration:underline}.credits{margin-top:46px;color:var(--muted);font-size:12px}.credits summary{cursor:pointer;font-weight:650}.credits ul{padding-left:18px;line-height:1.7}.credits .photo-credit{display:inline}.price{font:600 17px Georgia,serif;color:var(--ink)}.shop-hero{position:relative;aspect-ratio:4/4.4;background:var(--panel);overflow:hidden}.shop-facts{margin:0 0 26px;padding:0 0 0 18px;color:var(--soft);font:15px/1.8 Georgia,serif}.shop-form{margin-top:8px}.field-row{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px}.notice{padding:12px 14px;background:var(--panel);border-left:3px solid var(--green);font-size:13px}.shop-terms{margin-top:46px;max-width:560px}.topic-shop{margin:14px 0 0}.order-steps{margin:8px 0 28px;padding:0;list-style:none;border-left:2px solid var(--line)}.order-steps li{position:relative;padding:8px 0 8px 22px;color:var(--muted);font:16px Georgia,serif}.order-steps li:before{content:"";position:absolute;left:-7px;top:13px;width:12px;height:12px;border-radius:50%;background:var(--paper);border:2px solid var(--line)}.order-steps li.done{color:var(--ink)}.order-steps li.done:before{background:var(--green);border-color:var(--green)}.admin-table{overflow-x:auto}.admin-table table{width:100%;border-collapse:collapse;font-size:13px}.admin-table th,.admin-table td{padding:10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.admin-table form{display:flex;gap:6px;margin-top:6px}.admin-table input{min-width:0;padding:6px;border:1px solid var(--input-line)}.auction-box{margin:0 0 26px;padding:20px 22px;border:1px solid var(--line);background:var(--white)}.auction-box .eyebrow{margin-bottom:10px}.auction-box.ended{background:var(--panel)}.bid-now{margin:0 0 6px;font:20px Georgia,serif}.bid-form{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin-top:14px}.bid-form label{display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:700}.bid-form input{width:140px;min-height:48px;padding:10px;border:1px solid var(--input-line);background:var(--input-bg);color:var(--ink);font:16px ui-sans-serif,system-ui,sans-serif}.won{margin:12px 0 0}.won .button{margin-top:10px}.manage{margin:0 0 26px;font-size:13px}.manage summary{cursor:pointer;font-weight:650}.inline-form{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:12px 0}.inline-form input,.inline-form select{min-height:38px;padding:6px 8px;border:1px solid var(--input-line);background:var(--input-bg);color:var(--ink)}.inline-form input{width:90px}.quiet-button{padding:8px 14px;border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:2px;cursor:pointer;font:600 12px ui-sans-serif,system-ui,sans-serif}.quiet-button.danger{color:#9b2c2c;border-color:#e3b4b4}.auction-fields{margin:0 0 21px;padding:16px;border:1px dashed var(--upload-line)}.auction-fields legend{padding:0 6px;font-size:12px;font-weight:700}.auction-fields>small{display:block;color:var(--muted);font-size:11px}.field-row.two{grid-template-columns:1fr 1fr}.account .art-form .form-foot{margin:-8px 0 20px}.account>form:last-child{margin-top:40px}.account h2{margin:42px 0 14px;font:28px Georgia,serif;font-weight:400}.account-list{margin:0;padding-left:18px;font:15px/1.9 Georgia,serif}.account-list a{text-decoration:underline}input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible,button:focus-visible{outline:3px solid var(--focus);outline-offset:3px}@media(max-width:760px){.top nav a[href="/topics"]{display:none}.field-row{grid-template-columns:1fr 1fr}.field-row .field:first-child{grid-column:1/-1}.top nav a:first-child{display:none}.topics-main .topics-section{padding-top:42px}.topic-grid{grid-template-columns:1fr;gap:16px}.topic-cover{aspect-ratio:16/9}.top{height:70px}.top nav{gap:16px;font-size:11px}.brand{font-size:17px}.brand small{font-size:8px}.hero{min-height:auto;padding:55px 0 65px;grid-template-columns:1fr;gap:38px}.hero h1{font-size:clamp(50px,13vw,76px)}.hero-art{width:100%;height:clamp(250px,75vw,380px);justify-self:stretch}.hero-index{bottom:18px}.gallery-section{padding:58px 0 68px}.section-head{align-items:start;gap:12px}.section-head .text-link{padding-top:20px;font-size:11px}.gallery{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 13px}.art-info h3{font-size:18px}.art-info p{font-size:12px}.invite{grid-template-columns:1fr;gap:24px;padding-top:56px;padding-bottom:58px}.form-wrap{padding:42px 0 72px}.back-link{margin-bottom:36px}.art-form{padding:20px}.detail-grid{grid-template-columns:1fr;gap:30px}.detail-image{max-height:65vh}footer{gap:18px;align-items:flex-start;flex-wrap:wrap}.theme-pick{flex-basis:100%}footer p{max-width:150px;font-size:12px}}@media(max-width:380px){.top{padding-inline:16px}.top nav{gap:12px}.top nav a:first-child{display:none}main{padding-inline:16px}.invite{margin-inline:-16px;padding-inline:16px}.hero-art{height:250px}.art-form{padding:16px}footer{padding-inline:16px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*:before,*:after{transition:none!important}}`
