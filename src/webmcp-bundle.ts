/**
 * @profullstack/webmcp for the browser, served from pit.world's own origin (script-src 'self').
 *
 * Same reasoning as player-bundle.ts: pit.world loads no third-party script, so the embed is
 * bundled here, once, the first time it is asked for, into one ES module (/pf-webmcp.js).
 * It registers site_info, open_page and search_site (/api/search) for the AI agent in the
 * visitor's browser, and does nothing where the browser has no WebMCP.
 */
import { createRequire } from 'node:module'

let js: Promise<string> | null = null

export function webmcpJs(): Promise<string> {
  js ??= (async () => {
    const out = await Bun.build({
      entrypoints: [createRequire(import.meta.url).resolve('@profullstack/webmcp/embed')],
      target: 'browser',
      format: 'esm',
      splitting: false,
      minify: true,
    })
    if (!out.success) throw new Error(`webmcp bundle failed: ${out.logs.map((l) => l.message).join('; ')}`)
    return await out.outputs[0]!.text()
  })().catch((error) => {
    js = null
    throw error
  })
  return js
}
