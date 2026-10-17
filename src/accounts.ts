/**
 * pit.world accounts: one sign-in for every *.pit.world site.
 *
 * People sign in here once, with CoinPay (OAuth 2.1, code + PKCE), and every
 * site under pit.world that needs an account (social.<name>.pit.world,
 * bbs.<name>.pit.world, and the apps we list in PIT_BRIDGE_CLIENTS) signs them
 * in through us with @profullstack/bridges: no second account, no second
 * password, and a site never learns more than the claims we hand it.
 *
 * Who you are is your CoinPay `sub` (your CoinPay DID when you have one). Email
 * is a hint and never links accounts: CoinPay reports every email unverified.
 *
 * Sites are not registered one by one. A site's client id is its host, and its
 * secret is HMAC-SHA256(PIT_BRIDGE_KEY, host), so the social service and every
 * board can work out their own secret, and a new name works the moment it exists.
 * Nothing outside our own services ever holds PIT_BRIDGE_KEY.
 *
 * The rest of pit.world sets no cookie. The session cookie exists only after you
 * press "Sign in", and search never reads it.
 */
import { Database } from 'bun:sqlite'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Account = { id: string; sub: string; name: string | null; email: string | null; created_at: number; last_seen_at: number }
export type Grant = { client_id: string; first_at: number; last_at: number; count: number }
export type ApiToken = { id: string; label: string; created_at: number; last_used_at: number | null }

export const SESSION_COOKIE = 'pw_session'
const SESSION_DAYS = 60

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const b64url = (b: Buffer) => b.toString('base64url')
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes))

/** A site's bridge secret: base64url(HMAC-SHA256(key, clientId)), no padding. The social service and the boards derive the same. */
export function bridgeSecret(key: string, clientId: string): string {
  return b64url(createHmac('sha256', key).update(clientId).digest())
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** A Moshpit name as it appears inside a pit.world host: two or more DNS labels. */
export function isNameShape(name: string): boolean {
  return name.length <= 200 && name.includes('.') && name.split('.').every((l) => LABEL.test(l))
}

/** social.<name>.pit.world and bbs.<name>.pit.world: which service, and which name. */
export function serviceHost(host: string | null | undefined): { service: 'social' | 'bbs'; name: string; host: string } | null {
  const h = String(host ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  const m = h.match(/^(social|bbs)\.(.+)\.pit\.world$/)
  if (!m || !isNameShape(m[2]!)) return null
  return { service: m[1] as 'social' | 'bbs', name: m[2]!, host: h }
}

/**
 * Who may sign in through us: the social and board hosts of any name, plus the
 * exact hosts in `extra` (our own apps on the relay, e.g. family.ancestry.pit.world).
 * The callback is fixed: https://<host>/auth/bridge/callback, the path tsbb uses.
 */
export function bridgeClient(clientId: string, key: string, extra: string[] = []): { secret: string; redirectUris: string[]; name: string } | null {
  const id = clientId.trim().toLowerCase()
  if (!serviceHost(id) && !extra.includes(id)) return null
  return { secret: bridgeSecret(key, id), redirectUris: [`https://${id}/auth/bridge/callback`], name: id }
}

/** PKCE S256: base64url(sha256(verifier)). */
export const pkceS256 = (verifier: string) => b64url(createHash('sha256').update(verifier).digest())

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export class Accounts {
  readonly db: Database

  constructor(
    path: string,
    private now = () => Date.now(),
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, sub TEXT NOT NULL UNIQUE, name TEXT, email TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, client_id TEXT NOT NULL,
  first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, client_id)
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS replays (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
`)
  }

  // ---- accounts --------------------------------------------------------------

  /** The account for a CoinPay sub, made on first sign-in; name and email refresh each time. */
  signIn(claims: { sub: string; name?: string | null; email?: string | null }): Account {
    const sub = String(claims.sub ?? '').trim()
    if (!sub || sub.length > 300) throw new Error('no subject')
    const name = claims.name ? String(claims.name).slice(0, 120) : null
    const email = claims.email ? String(claims.email).slice(0, 254).toLowerCase() : null
    const existing = this.db.query<Account, [string]>('SELECT * FROM accounts WHERE sub = ?').get(sub)
    if (existing) {
      this.db.query('UPDATE accounts SET name = coalesce(?, name), email = coalesce(?, email), last_seen_at = ? WHERE id = ?').run(name, email, this.now(), existing.id)
      return this.account(existing.id)!
    }
    const id = randomToken(12)
    this.db.query('INSERT INTO accounts (id, sub, name, email, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, sub, name, email, this.now(), this.now())
    return this.account(id)!
  }

  account(id: string): Account | null {
    return this.db.query<Account, [string]>('SELECT * FROM accounts WHERE id = ?').get(id)
  }

  rename(id: string, name: string) {
    this.db.query('UPDATE accounts SET name = ? WHERE id = ?').run(name.trim().slice(0, 120) || null, id)
  }

  /** Everything goes: sessions, tokens, the list of sites. The sites keep their own copy of what you posted there. */
  remove(id: string) {
    this.db.query('DELETE FROM accounts WHERE id = ?').run(id)
  }

  // ---- sessions --------------------------------------------------------------

  createSession(accountId: string): { token: string; maxAge: number } {
    const token = randomToken(32)
    this.db.query('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), accountId, this.now(), this.now() + SESSION_DAYS * 86_400_000)
    return { token, maxAge: SESSION_DAYS * 86_400 }
  }

  sessionAccount(token: string | null | undefined): Account | null {
    if (!token || token.length > 100) return null
    const row = this.db.query<{ account_id: string; expires_at: number }, [string]>('SELECT account_id, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token))
    if (!row || row.expires_at < this.now()) return null
    return this.account(row.account_id)
  }

  endSession(token: string | null | undefined) {
    if (token) this.db.query('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
  }

  // ---- sites you signed in to --------------------------------------------------

  recordGrant(accountId: string, clientId: string) {
    this.db
      .query('INSERT INTO grants (account_id, client_id, first_at, last_at) VALUES (?, ?, ?, ?) ON CONFLICT (account_id, client_id) DO UPDATE SET last_at = excluded.last_at, count = count + 1')
      .run(accountId, clientId, this.now(), this.now())
  }

  grants(accountId: string): Grant[] {
    return this.db.query<Grant, [string]>('SELECT client_id, first_at, last_at, count FROM grants WHERE account_id = ? ORDER BY last_at DESC').all(accountId)
  }

  forgetGrant(accountId: string, clientId: string) {
    this.db.query('DELETE FROM grants WHERE account_id = ? AND client_id = ?').run(accountId, clientId)
  }

  // ---- bridge replay store (codes are single use, across restarts too) ---------

  replayStore() {
    return {
      claim: async (jti: string, expiresAt: number) => {
        this.db.query('DELETE FROM replays WHERE expires_at < ?').run(this.now())
        const r = this.db.query('INSERT OR IGNORE INTO replays (jti, expires_at) VALUES (?, ?)').run(jti, expiresAt)
        return r.changes === 1
      },
    }
  }

  // ---- the pit CLI: OAuth 2.1 code + PKCE to a loopback redirect --------------

  /** A one-time code for the CLI; only loopback http redirects are allowed (RFC 8252). */
  createCode(accountId: string, redirectUri: string, challenge: string): string {
    if (!loopbackRedirect(redirectUri)) throw new Error('redirect_uri must be http://127.0.0.1:<port>/... or http://localhost:<port>/...')
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error('code_challenge must be S256')
    const code = randomToken(24)
    this.db.query('INSERT INTO oauth_codes (code_hash, account_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha256(code), accountId, redirectUri, challenge, this.now() + 5 * 60_000)
    return code
  }

  /** Spend a code (once) for an API token. */
  exchangeCode(code: string, redirectUri: string, verifier: string, label = 'pit CLI'): { token: string; account: Account } | null {
    const hash = sha256(String(code))
    const row = this.db.query<{ account_id: string; redirect_uri: string; challenge: string; expires_at: number }, [string]>('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash)
    this.db.query('DELETE FROM oauth_codes WHERE code_hash = ? OR expires_at < ?').run(hash, this.now())
    if (!row || row.expires_at < this.now() || row.redirect_uri !== redirectUri || !same(pkceS256(String(verifier)), row.challenge)) return null
    const account = this.account(row.account_id)
    if (!account) return null
    return { token: this.createToken(account.id, label), account }
  }

  createToken(accountId: string, label: string): string {
    const token = `pw_${randomToken(30)}`
    this.db.query('INSERT INTO api_tokens (id, token_hash, account_id, label, created_at) VALUES (?, ?, ?, ?, ?)').run(randomToken(9), sha256(token), accountId, label.slice(0, 80), this.now())
    return token
  }

  tokenAccount(token: string | null | undefined): Account | null {
    if (!token?.startsWith('pw_')) return null
    const row = this.db.query<{ id: string; account_id: string }, [string]>('SELECT id, account_id FROM api_tokens WHERE token_hash = ?').get(sha256(token))
    if (!row) return null
    this.db.query('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(this.now(), row.id)
    return this.account(row.account_id)
  }

  tokens(accountId: string): ApiToken[] {
    return this.db.query<ApiToken, [string]>('SELECT id, label, created_at, last_used_at FROM api_tokens WHERE account_id = ? ORDER BY created_at DESC').all(accountId)
  }

  revokeToken(accountId: string, id: string) {
    this.db.query('DELETE FROM api_tokens WHERE account_id = ? AND id = ?').run(accountId, id)
  }

  revokeTokenValue(token: string) {
    this.db.query('DELETE FROM api_tokens WHERE token_hash = ?').run(sha256(token))
  }
}

export function loopbackRedirect(uri: string): boolean {
  try {
    const u = new URL(uri)
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]') && Boolean(u.port) && !u.username && !u.password && !u.hash
  } catch {
    return false
  }
}
