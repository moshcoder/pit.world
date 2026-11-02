/**
 * The ▲ ▼ on every listing. A plain form, so it is a real control without
 * JavaScript; app.js sends it with the browser fingerprint instead (a vote
 * without one is refused politely, see /vote).
 */
import { itemFor, type Tally, type VoteKind } from './votes.js'

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)

/** What a page knows about votes: tallies for the items on it, and where the no-JS answer links back to. */
export type VoteView = { counts?: Map<string, Tally>; back?: string }

export function voteBox(kind: VoteKind, target: string, view: VoteView | undefined, what = ''): string {
  const it = itemFor(kind, target)
  if (!it) return ''
  const t = view?.counts?.get(it.item)
  const shown = t && (t.up || t.down) ? String(t.up - t.down) : ''
  const label = what ? ` ${what}` : ''
  return `<form class="vote" method="post" action="/vote" data-item="${esc(it.item)}"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="target" value="${esc(target)}">${view?.back ? `<input type="hidden" name="back" value="${esc(view.back)}">` : ''}<button type="submit" name="v" value="1" class="up" aria-pressed="false" aria-label="Vote up${esc(label)}" title="Useful: vote up">▲</button><output class="n" title="${t ? `${t.up} up, ${t.down} down` : 'No votes yet'}">${shown}</output><button type="submit" name="v" value="-1" class="down" aria-pressed="false" aria-label="Vote down${esc(label)}" title="Not useful: vote down">▼</button></form>`
}

/** Every item key a list of (kind, target) pairs renders, for fetching tallies in one query. */
export function itemsOf(pairs: Array<[VoteKind, string | undefined | null]>): string[] {
  const out: string[] = []
  for (const [kind, target] of pairs) {
    const it = target ? itemFor(kind, target) : null
    if (it) out.push(it.item)
  }
  return out
}
