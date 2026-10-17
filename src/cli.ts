/**
 * pit: pit.world from the terminal.
 *
 *   pit                         the TUI
 *   pit search WORDS [--json] [-n N]
 *   pit resolve NAME [--json]   a Moshpit name
 *   pit network [--json]        live Moshpit numbers
 *   pit subscribe EMAIL         newsletter signup (confirm by email)
 *   pit pros [WORDS] [--category C] [--near PLACE]   the pro directory
 *   pit edit DOMAIN --key K --field VALUE ...        edit your listing
 *   pit quote DOMAIN --name N --email E --message M  ask a listed pro for a quote
 *   pit login | whoami | logout your pit.world account (OAuth 2.1, PKCE, loopback)
 *   pit ring                    the pit.world web ring
 *   pit open WORDS              the results page in your browser
 *   pit mcp                     MCP server on stdio
 *   pit serve [--port N]        run your own pit.world (needs provider keys)
 */
import { spawn } from 'node:child_process'
import { PitClient } from './client.js'

const HELP = `pit: private search, and the Moshpit network (https://pit.world)

  pit                          interactive search (TUI)
  pit search WORDS [-n N]      search the web privately
  pit resolve NAME             look up a Moshpit name (chovy.hacker)
  pit network                  live numbers for the Moshpit network
  pit listing DOMAIN           a business listing (pit.world/b)
  pit claim DOMAIN             claim your business listing
  pit verify CLAIM_ID          finish a claim; prints your edit key once
  pit edit DOMAIN --key KEY [--operator riotcoder@profullstack.com] [--company "Acme, Inc."]
       [--company-url URL] [--category SLUG] [--services "a; b"] [--area TEXT] [--city C]
       [--region R] [--country C] [--price free|$|$$|$$$|$$$$|quote] [--hours H] [--phone P]
       [--contact EMAIL|""] [--ring in|out] [--name N] [--description D]
                               edit your listing (or PIT_EDIT_KEY=... instead of --key)
  pit pros [WORDS] [--category SLUG] [--near PLACE]
                               the pro directory: verified businesses, no paid placement
  pit categories               the directory's categories
  pit quote DOMAIN --name N --email E --message M [--phone P]
                               ask one listed pro for a quote; they reply to your email
  pit ring                     the pit.world web ring
  pit login [--no-browser]     sign in to your pit.world account (CoinPay, OAuth 2.1):
                               one account for every social.<name> and bbs.<name>.pit.world
  pit whoami                   your account and the pit.world sites you use
  pit logout                   revoke this computer's token
  pit social NAME | pit bbs NAME   the social feed or board of a Moshpit name
  pit subscribe EMAIL          get the pit.world newsletter (double opt-in)
  pit open WORDS               open the results page in your browser
  pit mcp                      MCP server on stdio: claude mcp add pit -- pit mcp
  pit serve [--port N]         run your own instance (SERPER_API_KEY etc.)

  --json                       machine-readable output
  PIT_URL=https://…            use another pit.world instance
`

type Out = { log(text: string): void; error(text: string): void }

export async function main(argv: string[], out: Out = { log: (t) => console.log(t), error: (t) => console.error(t) }, client = new PitClient()): Promise<number> {
  const json = argv.includes('--json')
  const args = argv.filter((a) => a !== '--json')
  const nAt = args.findIndex((a) => a === '-n' || a === '--limit')
  const n = nAt === -1 ? 10 : Number(args[nAt + 1])
  const rest = nAt === -1 ? args : args.filter((_, i) => i !== nAt && i !== nAt + 1)
  const [command, ...words] = rest

  try {
    switch (command) {
      case undefined: {
        if (!process.stdout.isTTY) {
          out.log(HELP)
          return 0
        }
        await (await import('./tui.js')).runTui(client)
        return 0
      }
      case 'help':
      case '--help':
      case '-h':
        out.log(HELP)
        return 0
      case 'search':
      case 's': {
        const query = words.join(' ').trim()
        if (!query) return usage(out, 'pit search WORDS')
        const result = await client.search(query, Number.isFinite(n) ? n : 10)
        if (json) {
          out.log(JSON.stringify(result, null, 2))
          return 0
        }
        if (result.moshpit?.nameRegistered) out.log(`◉ Moshpit: ${result.moshpit.name}${result.moshpit.target ? ` → ${result.moshpit.target}` : ''}  ${result.moshpit.page}\n`)
        result.results.forEach((hit, i) => {
          out.log(`${String(i + 1).padStart(2)}. ${hit.title}\n    ${hit.url}${hit.description ? `\n    ${hit.description}` : ''}`)
        })
        if (!result.results.length) out.log('No results.')
        return 0
      }
      case 'resolve':
      case 'r': {
        const name = words[0]
        if (!name) return usage(out, 'pit resolve NAME')
        const r = await client.resolve(name)
        if (json) out.log(JSON.stringify(r, null, 2))
        else out.log(r.nameRegistered ? `${r.name} is on the Moshpit network${r.target ? `, pointing at ${r.target}` : ''}.\n${r.page}` : `${r.name} is not registered. Claim it: ${r.page}`)
        return 0
      }
      case 'subscribe': {
        const email = words[0]
        if (!email) return usage(out, 'pit subscribe EMAIL')
        const r = await client.subscribe(email)
        if (json) out.log(JSON.stringify(r, null, 2))
        else
          out.log(
            {
              'check-inbox': 'Check your inbox: click the confirmation link within 48 hours to join the pit.world newsletter.',
              invalid: "That doesn't look like an email address.",
              undeliverable: "That domain can't receive email.",
              failed: "pit.world couldn't send the confirmation right now. Try again in a few minutes.",
            }[r.status] ?? r.status,
          )
        return r.ok ? 0 : 1
      }
      case 'listing': {
        const domain = words[0]
        if (!domain) return usage(out, 'pit listing DOMAIN')
        const l = await client.listing(domain)
        if (json) out.log(JSON.stringify(l, null, 2))
        else {
          out.log(`${l.name || l.domain}  (${l.claimed ? 'claimed by the owner' : 'unclaimed'})  https://pit.world/b/${l.domain}`)
          for (const [k, v] of [['', l.description], ['Hours', l.hours], ['Address', l.address], ['Phone', l.phone], ['Moshpit', l.moshpit]] as const) if (v) out.log(k ? `${k}: ${v}` : v)
          for (const link of l.links) out.log(link)
        }
        return 0
      }
      case 'claim': {
        const domain = words[0]
        if (!domain) return usage(out, 'pit claim DOMAIN')
        const c = await client.claim(domain)
        if (json) out.log(JSON.stringify(c, null, 2))
        else
          out.log(
            `To claim ${c.domain}, do ONE of these, then run: pit verify ${c.claimId}\n\n` +
              `  DNS TXT record   ${c.txtHost}  =  ${c.token}\n` +
              `  homepage <head>  ${c.meta}\n\nOr finish in the browser: ${c.page}`,
          )
        return 0
      }
      case 'verify': {
        const claimId = words[0]
        if (!claimId) return usage(out, 'pit verify CLAIM_ID')
        const r = await client.verify(claimId)
        if (json) out.log(JSON.stringify(r, null, 2))
        else out.log(r.ok ? `Verified by ${r.method}. Your edit key (shown once, save it):\n${r.editKey}` : r.reason === 'unknown-claim' ? 'That claim id is unknown or expired (claims last 7 days).' : 'Not found yet. DNS can take a few minutes; try again.')
        return r.ok ? 0 : 1
      }
      case 'pros': {
        const { flags, rest: terms } = parseFlags(words)
        const r = await client.pros({ q: terms.join(' '), ...(flags.category ? { category: flags.category } : {}), ...(flags.near ? { near: flags.near } : {}), n: Number.isFinite(n) ? n : 10 })
        if (json) out.log(JSON.stringify(r, null, 2))
        else {
          if (!r.results.length) out.log('No listings match. Claim yours: https://pit.world/b')
          for (const l of r.results) {
            const where = [l.area, [l.city, l.region, l.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
            out.log(`${l.name || l.domain}  https://pit.world/b/${l.domain}${l.category ? `\n    ${l.category}` : ''}${where ? `  ${where}` : ''}${l.description ? `\n    ${l.description}` : ''}${l.quotes ? '\n    takes quote requests: pit quote ' + l.domain : ''}`)
          }
          if (r.total > r.results.length) out.log(`… ${r.total - r.results.length} more (use -n or the web: https://pit.world/pros)`)
        }
        return 0
      }
      case 'categories': {
        const r = await client.categories()
        if (json) out.log(JSON.stringify(r, null, 2))
        else for (const c of r.categories) out.log(`${c.slug.padEnd(14)} ${c.label}${c.count ? ` (${c.count})` : ''}  ${c.examples}`)
        return 0
      }
      case 'ring': {
        const r = await client.ring()
        if (json) out.log(JSON.stringify(r, null, 2))
        else {
          out.log(`${r.name}: ${r.count} sites  ${r.home}`)
          for (const site of r.sites) out.log(`  ${site.name.padEnd(24)} ${site.proxyUrl}${site.feed ? `  feed ${site.feed}` : ''}`)
        }
        return 0
      }
      case 'edit': {
        const { flags, rest: positional } = parseFlags(words)
        const domain = positional[0]
        const key = flags.key ?? process.env.PIT_EDIT_KEY
        if (!domain || !key) return usage(out, 'pit edit DOMAIN --key KEY --field VALUE ...  (or PIT_EDIT_KEY)')
        const fields: Record<string, unknown> = {}
        const names: Record<string, string> = { 'company-url': 'companyUrl', contact: 'contactEmail' }
        for (const [flag, value] of Object.entries(flags)) if (flag !== 'key') fields[names[flag] ?? flag] = value
        if (typeof fields.services === 'string') fields.services = fields.services.split(';')
        if (typeof fields.links === 'string') fields.links = fields.links.split(/[\s,]+/).filter(Boolean)
        const l = await client.edit(domain, key, fields)
        if (json) out.log(JSON.stringify(l, null, 2))
        else
          out.log(
            `Saved https://pit.world/b/${l.domain}` +
              (l.contactResult === 'pending' ? '\nCheck that inbox: quote requests start once the confirmation link is clicked.' : '') +
              (l.contactResult && !['pending', 'unchanged', 'cleared'].includes(l.contactResult) ? `\nQuote-request address not changed: ${l.contactResult}` : '') +
              (l.contactStatus ? `\nQuote requests: ${l.contactStatus}` : ''),
          )
        return 0
      }
      case 'quote': {
        const { flags, rest: positional } = parseFlags(words)
        const domain = positional[0]
        if (!domain || !flags.name || !flags.email || !flags.message) return usage(out, 'pit quote DOMAIN --name NAME --email EMAIL --message TEXT [--phone PHONE]')
        const r = await client.quote(domain, { name: flags.name, email: flags.email, message: flags.message, ...(flags.phone ? { phone: flags.phone } : {}) })
        if (json) out.log(JSON.stringify(r, null, 2))
        else
          out.log(
            {
              sent: 'Sent. The owner replies to your email directly.',
              invalid: 'Needs a name, a real email and a message of a few words (at most three links).',
              undeliverable: "Your email's domain can't receive mail, so they couldn't reply.",
              unavailable: 'That listing is not taking messages through pit.world.',
              limited: 'That listing has had a lot of messages recently. Try again later.',
              failed: "pit.world couldn't send it just now. Try again in a few minutes.",
            }[r.status] ?? r.status,
          )
        return r.ok ? 0 : 1
      }
      case 'network': {
        const s = await client.network()
        if (json) out.log(JSON.stringify(s, null, 2))
        else {
          out.log(`Moshpit network: ${s.endings.toLocaleString('en-US')} endings, ${s.events.toLocaleString('en-US')} registry events`)
          if (s.recent.length) out.log(`Just claimed: ${s.recent.map((e) => `.${e.tld}`).join(' ')}`)
        }
        return 0
      }
      case 'open': {
        const query = words.join(' ').trim()
        const url = `${client.base}/search?q=${encodeURIComponent(query)}`
        const argv = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url] : ['xdg-open', url]
        spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' }).on('error', () => out.log(url)).unref()
        return 0
      }
      case 'login': {
        const { login } = await import('./login.js')
        const me = await login(client.base, (t) => out.log(t), { open: !words.includes('--no-browser') })
        out.log(`Signed in as ${me.name ?? me.sub}. Every social.<name>.pit.world and bbs.<name>.pit.world uses this account.`)
        return 0
      }
      case 'whoami': {
        const me = await (await import('./login.js')).whoami(client.base)
        if (json) out.log(JSON.stringify(me, null, 2))
        else {
          out.log(`${me.account.name ?? '(no name)'}  ${me.account.sub}${me.admin ? '  (admin)' : ''}`)
          for (const s of me.sites ?? []) out.log(`  https://${s.client_id}/`)
        }
        return 0
      }
      case 'logout':
        out.log((await (await import('./login.js')).logout(client.base)) ? 'Signed out; the token is revoked.' : 'Not signed in.')
        return 0
      case 'social':
      case 'bbs': {
        const name = (words[0] ?? '').toLowerCase()
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) return usage(out, `pit ${command} NAME   (e.g. pit ${command} family.ancestry)`)
        const url = `https://${command}.${name}.pit.world/`
        out.log(url)
        const argv = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url] : ['xdg-open', url]
        if (!json) spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
        return 0
      }
      case 'mcp':
        await (await import('./mcp.js')).runMcp()
        // Serve until the client hangs up: returning would let bin/pit exit mid-session.
        await new Promise<void>((resolve) => process.stdin.once('close', resolve))
        return 0
      case 'serve': {
        const portAt = words.indexOf('--port')
        const { serve } = await import('./server.js')
        const server = serve(portAt === -1 ? {} : { port: Number(words[portAt + 1]) })
        out.log(`pit.world listening on http://${server.hostname}:${server.port}`)
        await new Promise(() => {})
        return 0
      }
      default:
        // `pit some words` is a search.
        return main(['search', ...rest, ...(nAt === -1 ? [] : ['-n', String(n)]), ...(json ? ['--json'] : [])], out, client)
    }
  } catch (error) {
    out.error(`pit: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/** `--flag value` pairs (and `--flag=value`), and whatever is left. */
export function parseFlags(args: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {}
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(arg)
    if (!m) {
      rest.push(arg)
      continue
    }
    if (m[2] !== undefined) flags[m[1]!] = m[2]
    else {
      flags[m[1]!] = args[i + 1] ?? ''
      i++
    }
  }
  return { flags, rest }
}

function usage(out: Out, text: string): number {
  out.error(`usage: ${text}`)
  return 64
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
