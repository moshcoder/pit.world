#!/usr/bin/env bun
import { savedToken } from './login.js'

const BASE = (process.env.STITCHER_URL ?? 'https://daily.stitcher.pit.world').replace(/\/+$/, '')
const HELP = `Daily Stitcher publishing queue

Sign in with CoinPay OAuth 2.1 + PKCE first:
  pit login

Commands:
  bun bin/stitcher status
  bun bin/stitcher propose --title "Story title" --body "Draft text"
  bun bin/stitcher proposals
  bun bin/stitcher approve <story-id>
  bun bin/stitcher reject <story-id>

Only the configured owner CoinPay DID can approve or reject. Approval publishes a
journal note. This CLI cannot create products, set prices, accept orders, or charge money.`

function allowedBase(value: string) {
  const url = new URL(value)
  return url.protocol === 'https:' && url.hostname === 'daily.stitcher.pit.world' && !url.username && !url.password
    || ['localhost', '127.0.0.1'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)
}

async function main(args: string[]) {
  const [command, ...rest] = args
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP)
    return
  }
  if (!allowedBase(BASE)) throw new Error('STITCHER_URL must be https://daily.stitcher.pit.world (localhost is allowed for development)')
  const saved = savedToken()
  if (!saved?.token) throw new Error('Not signed in. Run `pit login` first; this uses CoinPay OAuth 2.1 with PKCE.')

  let path: string
  let method = 'GET'
  let body: Record<string, string> | undefined
  if (command === 'status') path = '/api/owner/status'
  else if (command === 'proposals') path = '/api/owner/proposals'
  else if (command === 'propose') {
    const values: Record<string, string> = {}
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i]
      if (flag !== '--title' && flag !== '--body') throw new Error(`Unknown option: ${flag}`)
      const value = rest[++i]
      if (!value) throw new Error(`Missing value for ${flag}`)
      values[flag.slice(2)] = value
    }
    if (!values.title || !values.body) throw new Error('propose requires --title and --body')
    path = '/api/owner/proposals'
    method = 'POST'
    body = values
  } else if (command === 'approve' || command === 'reject') {
    const id = rest[0]
    if (!id || rest.length !== 1 || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`${command} needs a story UUID`)
    path = `/api/owner/proposals/${encodeURIComponent(id)}/${command}`
    method = 'POST'
  } else {
    throw new Error(`Unknown command: ${command}\n\n${HELP}`)
  }

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${saved.token}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  })
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const error = typeof result.error === 'string' ? result.error : `HTTP ${response.status}`
    if (response.status === 401) throw new Error(`${error}. Run pit login to authenticate with CoinPay OAuth 2.1.`)
    if (response.status === 409 && error === 'owner_identity_not_configured') throw new Error('The owner CoinPay DID is not configured. Stories remain private until the owner is set.')
    if (response.status === 403 && error === 'owner_only') throw new Error('This CoinPay DID is not authorized to publish Daily Stitcher stories.')
    throw new Error(error)
  }
  console.log(JSON.stringify(result, null, 2))
}

main(Bun.argv.slice(2)).catch((error) => {
  console.error(`stitcher: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
