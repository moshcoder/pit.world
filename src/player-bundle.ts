/**
 * @profullstack/player for the browser, served from pit.world's own origin (script-src 'self').
 *
 * pit.world has no client build step: public/app.js is plain JS. So the player is bundled here, once,
 * the first time it is asked for, into one ES module (/pf-player.js) plus its stylesheet
 * (/pf-player.css). app.js imports it only when something is about to play, so search pages that
 * never play anything never load it.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

let js: Promise<string> | null = null
let css: string | null = null

export function playerJs(): Promise<string> {
  js ??= (async () => {
    const out = await Bun.build({
      entrypoints: [new URL('./client/player-entry.ts', import.meta.url).pathname],
      target: 'browser',
      format: 'esm',
      splitting: false,
      minify: true,
    })
    if (!out.success) throw new Error(`player bundle failed: ${out.logs.map((l) => l.message).join('; ')}`)
    return await out.outputs[0]!.text()
  })().catch((error) => {
    js = null
    throw error
  })
  return js
}

export function playerCss(): string {
  css ??= readFileSync(createRequire(import.meta.url).resolve('@profullstack/player/player.css'), 'utf8')
  return css
}
