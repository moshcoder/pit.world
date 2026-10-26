/**
 * pit login: your pit.world account in the terminal, OAuth 2.1 the way RFC 8252
 * says a CLI should do it. A listener on 127.0.0.1, PKCE S256, the browser to
 * pit.world/oauth/authorize (which signs you in with CoinPay if you aren't yet),
 * and a token saved to ~/.config/pit/token.json (0600). Nothing to paste.
 */
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CLI_CLIENT = 'pit-cli'

export const tokenFile = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'pit', 'token.json')

export function savedToken(): { base: string; token: string } | null {
  const file = tokenFile()
  if (!existsSync(file)) return null
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    return typeof saved?.token === 'string' ? saved : null
  } catch {
    return null
  }
}

function openBrowser(url: string, log: (t: string) => void) {
  const argv = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url] : ['xdg-open', url]
  spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
  log(`If no browser opened, visit:\n  ${url}`)
}

export async function login(base: string, log: (t: string) => void, options: { open?: boolean; timeoutMs?: number } = {}): Promise<{ name: string | null; sub: string }> {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('base64url')
  let done!: (v: { code: string } | { error: string }) => void
  const result = new Promise<{ code: string } | { error: string }>((resolve) => (done = resolve))
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/callback') return new Response('not found', { status: 404 })
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code')
      done(ok ? { code: url.searchParams.get('code')! } : { error: url.searchParams.get('error') ?? 'state mismatch' })
      return new Response(ok ? 'Signed in. You can close this tab and go back to the terminal.' : 'Sign-in failed; see the terminal.', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    },
  })
  const redirectUri = `http://127.0.0.1:${server.port}/callback`
  const authorize = `${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CLI_CLIENT, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state })}`
  if (options.open !== false) openBrowser(authorize, log)
  else log(`Open this to sign in:\n  ${authorize}`)
  const timer = setTimeout(() => done({ error: 'timed out waiting for the browser' }), options.timeoutMs ?? 5 * 60_000)
  const got = await result
  clearTimeout(timer)
  server.stop(true)
  if ('error' in got) throw new Error(`sign-in failed: ${got.error}`)
  const res = await fetch(`${base}/api/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', client_id: CLI_CLIENT, code: got.code, redirect_uri: redirectUri, code_verifier: verifier, label: `pit CLI on ${process.env.HOSTNAME ?? 'this computer'}` }),
  })
  const body = (await res.json().catch(() => ({}))) as any
  if (!res.ok || !body.access_token) throw new Error(`sign-in failed: ${body.error ?? `HTTP ${res.status}`}`)
  const file = tokenFile()
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify({ base, token: body.access_token }), { mode: 0o600 })
  chmodSync(file, 0o600)
  return { name: body.account?.name ?? null, sub: body.account?.sub }
}

export async function whoami(base: string): Promise<any> {
  const saved = savedToken()
  if (!saved) throw new Error('not signed in: pit login')
  const res = await fetch(`${saved.base || base}/api/v1/me`, { headers: { authorization: `Bearer ${saved.token}` }, signal: AbortSignal.timeout(15_000) })
  const body = (await res.json().catch(() => ({}))) as any
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

/** A call to the pit.world API as the signed-in account (pit login). */
export async function authed(base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  const saved = savedToken()
  if (!saved) throw new Error('not signed in: pit login')
  const res = await fetch(`${saved.base || base}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${saved.token}`, accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await res.json().catch(() => ({}))) as any
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

export async function logout(base: string): Promise<boolean> {
  const saved = savedToken()
  if (!saved) return false
  await fetch(`${saved.base || base}/api/v1/oauth/revoke`, { method: 'POST', headers: { authorization: `Bearer ${saved.token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null)
  rmSync(tokenFile(), { force: true })
  return true
}
