/**
 * pit.world's own footer: its links, the << Profullstack >> webring nav and the
 * copyright line, from @profullstack/footer. It is rendered into the HTML on the
 * server because rssamplifier's ring verifier reads the page and never runs script.
 *
 * Pages render synchronously, so the footer is kept as a string: the bundled
 * template at boot, then the @latest template from the CDN, refreshed every 15
 * minutes (a footer release reaches us with no redeploy). A failed refresh keeps
 * the last good copy.
 *
 * Our CSP allows no inline <style>, so the template CSS is off (css: false) and the
 * .pfs-footer rules live in public/style.css.
 *
 * This is NOT the pit.world global footer (footer.ts, /snippets/footer.html): that
 * fragment goes on every fleet site and never carries the Profullstack ring.
 */
import { createHash } from 'node:crypto'
import { footerHtml, footerHtmlSync, subscribeForm } from '@profullstack/footer'

type FooterOptions = Parameters<typeof footerHtmlSync>[0]

/**
 * The CSP source for the footer's inline newsletter script (wireSubscribe, since 0.4.0), as
 * 'sha256-...'. Our CSP has no 'unsafe-inline' and the footer is a cached string, so a per-request
 * nonce cannot reach it; the script is the same bytes on every render (the renderer, not the CDN
 * template, emits it), so its hash allows exactly it.
 */
export const FOOTER_SCRIPT_SRC: string = (() => {
  const m = subscribeForm('https://pit.world/').match(/<script[^>]*>([\s\S]*?)<\/script>/)
  return m?.[1] ? `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'` : ''
})()

export function ringFooterOptions(links: { label: string; href: string }[]): FooterOptions {
  return {
    site: 'https://pit.world/',
    links,
    since: 2026,
    tagline: 'No logs. No profile. No cookies unless you sign in.',
    css: false,
    badges: [
      {
        href: 'https://built.indie.pit.world/',
        src: 'https://built.indie.pit.world/for.svg',
        alt: 'Built Indie',
        width: 32,
        height: 32,
      },
    ],
  }
}

let options: FooterOptions | null = null
let html = ''

export function setRingFooterOptions(next: FooterOptions): void {
  options = next
  html = footerHtmlSync(next)
}

/** The footer markup, never empty once options are set. */
export function ringFooter(): string {
  return html
}

/** Accept a rendered footer only when it still links the ring. */
export function setRingFooter(next: unknown): boolean {
  if (typeof next !== 'string' || !next.includes('/ring/profullstack') || next.length > 64_000) return false
  html = next
  return true
}

export function startRingFooterRefresh(everyMs = 15 * 60_000): () => void {
  const run = () => {
    if (!options) return
    footerHtml(options).then(setRingFooter, () => {})
  }
  run()
  const timer = setInterval(run, everyMs)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
