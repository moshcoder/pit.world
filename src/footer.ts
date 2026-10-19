/**
 * The pit.world global footer: one quiet line every fleet site ends with.
 *
 * pit.world is the source of truth. A site fetches /snippets/footer.html?site=<its host> server-side
 * (cache it an hour, drop it on any error) and prints the fragment as the last thing in <body>. The
 * fragment carries its own <style> and no script, so it needs no CSP exception beyond inline styles;
 * the "How do I use this?" modal is a native popover.
 *
 * The *.pit.world proxy (proxy.ts) adds the same markup to every proxied page that does not already
 * carry it (data-pit-footer), linking the same rules from /.pit/proxy.css instead.
 */
import { findSite, hostOf, RING_HOME } from './ring.js'

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)

const PUBLISH = 'https://pit.moshcode.sh'

/** Which site a ?site= value names, and whether it is a Moshpit name (family.ancestry, or family.ancestry.pit.world). */
export function footerSite(value: string | null | undefined): { name: string; moshpit: boolean } | null {
  const host = hostOf(value)
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return null
  const known = findSite(host)
  if (known) return { name: known.name, moshpit: known.moshpit }
  if (host.endsWith('.pit.world')) {
    const name = host.slice(0, -'.pit.world'.length)
    const ring = findSite(name)
    if (name.includes('.')) return { name, moshpit: ring ? ring.moshpit : true }
  }
  return { name: host, moshpit: false }
}

/** The steps for opening a Moshpit name directly, behind the "How do I use this?" button. */
function howTo(name: string): string {
  const n = esc(name)
  return `<button type="button" popovertarget="pit-foot-howto">How do I use this?</button>
<div id="pit-foot-howto" class="pit-foot-modal" popover role="dialog" aria-label="How to use ${n}">
<button type="button" class="pit-foot-x" popovertarget="pit-foot-howto" popovertargetaction="hide" aria-label="Close">&times;</button>
<h2>How do I use this?</h2>
<p>${n} lives on Moshpit, a namespace beside the old one where anyone can own an ending like <code>.${esc(name.split('.').pop())}</code>. The pit.world copy, <a href="https://${n}.pit.world/">${n}.pit.world</a>, works in any browser with nothing to install. To open <code>https://${n}</code> directly, about two minutes:</p>
<ol>
<li>Turn on secure DNS in your browser (Chrome, Edge, Brave: Settings, Privacy and security, Use secure DNS, Custom. Firefox: Settings, Privacy &amp; Security, DNS over HTTPS) and enter <code>https://dns.moshcode.sh/dns-query</code>.</li>
<li>Install the Moshpit certificate so the padlock shows: <a href="https://pit.world/moshpit-root-ca.crt">moshpit-root-ca.crt</a>.</li>
<li>Open <code>https://${n}</code>.</li>
</ol>
<p>Every device, and how to undo it: <a href="https://pit.world/connect">pit.world/connect</a>. Or install moshcode: <code>curl -fsSL https://moshcode.sh/install.sh | sh</code></p>
<p>${n} also has a <a href="https://bbs.${n}.pit.world/">board</a> and an AT Protocol <a href="https://social.${n}.pit.world/">social feed</a>. One <a href="https://pit.world/account">pit.world account</a> signs you in on both, and on every other name's.</p>
<p><b>Publish here:</b> <a href="${PUBLISH}">claim your own name</a> and it opens at <code>yourname.ending.pit.world</code> too, or <a href="https://pit.world/build">have us build the app</a>.</p>
</div>`
}

/** The footer markup, without its styles. */
export function footerMarkup(site: { name: string; moshpit: boolean }): string {
  const n = esc(site.name)
  const about = site.moshpit ? `<b>${n}</b> is a Moshpit name on pit.world` : `<b>${n}</b> is part of the pit.world network`
  return `<nav class="pit-foot" aria-label="The pit.world network" data-pit-footer>
<span>${about}</span>
<span class="pit-foot-links"><a href="https://pit.world/">Search</a><a href="${RING_HOME}">Ring</a><a href="${PUBLISH}">Publish here</a>${site.moshpit ? howTo(site.name) : ''}</span>
</nav>`
}

/** The /snippets/footer.html body: styles and markup in one fragment. */
export function footerSnippet(site: { name: string; moshpit: boolean }): string {
  return `<style>${FOOTER_CSS}</style>\n${footerMarkup(site)}\n`
}

// all:initial keeps the host page's CSS out; it also drops the UA popover rules, hence height:fit-content
// and the :not(:popover-open) line.
export const FOOTER_CSS = `.pit-foot,.pit-foot-modal{all:initial;box-sizing:border-box;font:13px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#5b6555}
.pit-foot *{box-sizing:border-box;font:inherit;color:inherit}
.pit-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:4px 16px;margin:0 auto;padding:12px 16px;max-width:960px;text-align:center}
.pit-foot b{font-weight:600;color:#2a3324}
.pit-foot-links{display:flex;flex-wrap:wrap;justify-content:center;gap:4px 14px}
.pit-foot-links>a,.pit-foot-links>button{all:unset;cursor:pointer;color:#2f6b00}
.pit-foot-links>a:hover,.pit-foot-links>button:hover{text-decoration:underline}
.pit-foot a:focus-visible,.pit-foot button:focus-visible{outline:2px solid #4d8a00;outline-offset:2px;border-radius:2px}
.pit-foot-modal{position:fixed;inset:0;margin:auto;width:min(560px,calc(100vw - 32px));height:fit-content;max-height:calc(100vh - 32px);overflow:auto;padding:22px 24px 18px;border:0;border-radius:12px;background:#fff;color:#2a3324;font-size:14px;line-height:1.55;text-align:left;box-shadow:0 20px 60px rgba(0,0,0,.25)}
.pit-foot-modal:not(:popover-open){display:none}
.pit-foot-modal::backdrop{background:rgba(10,14,8,.45)}
.pit-foot-modal h2{display:block;margin:0 0 10px;font-size:18px;font-weight:700}
.pit-foot-modal p,.pit-foot-modal ol{display:block;margin:0 0 10px}.pit-foot-modal ol{padding-left:22px}.pit-foot-modal li{display:list-item;margin:4px 0}
.pit-foot-modal b{font-weight:700}.pit-foot-modal a{color:#2f6b00;text-decoration:underline;cursor:pointer}
.pit-foot-modal code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:#eef3e7;padding:.05em .3em;border-radius:4px;overflow-wrap:anywhere}
.pit-foot-x{all:unset;position:absolute;top:8px;right:12px;font-size:22px;line-height:1;padding:4px 6px;cursor:pointer;color:#6b7563}
@media (prefers-color-scheme:dark){.pit-foot{color:#a9b5a0}.pit-foot b{color:#dfe8d8}.pit-foot-links>a,.pit-foot-links>button{color:#c4ff6b}.pit-foot-modal{background:#151a11;color:#dfe8d8}.pit-foot-modal a{color:#c4ff6b}.pit-foot-modal code{background:#222a1c}.pit-foot-x{color:#a9b5a0}}
`
