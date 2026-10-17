/**
 * pit: pit.world from the terminal.
 *
 *   pit                         the TUI
 *   pit search WORDS [--json] [-n N]
 *   pit resolve NAME [--json]   a Moshpit name
 *   pit network [--json]        live Moshpit numbers
 *   pit subscribe EMAIL         newsletter signup (confirm by email)
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
        if (result.moshpit?.registered) out.log(`◉ Moshpit: ${result.moshpit.name}${result.moshpit.target ? ` → ${result.moshpit.target}` : ''}  ${result.moshpit.page}\n`)
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
        else out.log(r.registered ? `${r.name} is on the Moshpit network${r.target ? `, pointing at ${r.target}` : ''}.\n${r.page}` : `${r.name} is not registered. Claim it: ${r.page}`)
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
        return main(['search', ...rest, ...(json ? ['--json'] : [])], out, client)
    }
  } catch (error) {
    out.error(`pit: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function usage(out: Out, text: string): number {
  out.error(`usage: ${text}`)
  return 64
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
