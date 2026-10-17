/**
 * `pit promo tui ID`: a campaign in the terminal. Tab switches between businesses and posts, ↑/↓ move,
 * Enter opens the detail (a business's leads, hold and windows; a post's state, error and evidence),
 * p pauses or resumes, r retries a failed post, t runs the hourly pass, g refreshes, q quits.
 */
import { createApp } from '@profullstack/hqtui'
import type { PitClient } from './client.js'

export type PromoTuiState = {
  tab: 'businesses' | 'posts'
  selected: number
  detail: unknown | null
  overview: any | null
  businesses: any[]
  posts: any[]
  message: string
  busy: boolean
}

export const initialPromoState = (): PromoTuiState => ({ tab: 'businesses', selected: 0, detail: null, overview: null, businesses: [], posts: [], message: '', busy: false })

/** Pure key handling, testable without a terminal. */
export function onPromoKey(s: PromoTuiState, key: { name: string; key: string; char?: string }): 'quit' | 'open' | 'pause' | 'retry' | 'tick' | 'refresh' | null {
  if (key.key === 'ctrl+c' || key.char === 'q') return 'quit'
  if (s.detail) {
    if (key.name === 'escape' || key.name === 'backspace' || key.name === 'enter') s.detail = null
    return null
  }
  const count = s.tab === 'businesses' ? s.businesses.length : s.posts.length
  if (key.name === 'tab') {
    s.tab = s.tab === 'businesses' ? 'posts' : 'businesses'
    s.selected = 0
  } else if (key.name === 'down' || key.char === 'j') s.selected = Math.min(Math.max(0, count - 1), s.selected + 1)
  else if (key.name === 'up' || key.char === 'k') s.selected = Math.max(0, s.selected - 1)
  else if (key.name === 'enter') return count ? 'open' : null
  else if (key.char === 'p') return 'pause'
  else if (key.char === 'r') return s.tab === 'posts' ? 'retry' : null
  else if (key.char === 't') return 'tick'
  else if (key.char === 'g') return 'refresh'
  return null
}

export async function runPromoTui(client: PitClient, campaignId: string): Promise<void> {
  const s = initialPromoState()
  const app = await createApp({ title: 'pit promo', quitKeys: [] })
  const id = encodeURIComponent(campaignId)
  const run = async (work: () => Promise<string | void>) => {
    s.busy = true
    app.invalidate()
    try {
      s.message = (await work()) || ''
    } catch (error) {
      s.message = error instanceof Error ? error.message : String(error)
    } finally {
      s.busy = false
      app.invalidate()
    }
  }
  const refresh = () =>
    run(async () => {
      s.overview = await client.promo('GET', `/campaigns/${id}`)
      s.businesses = (await client.promo('GET', `/campaigns/${id}/businesses?limit=500`)).businesses
      s.posts = (await client.promo('GET', `/campaigns/${id}/placements?limit=500`)).placements
    })

  app.on('key', (event: any) => {
    const action = onPromoKey(s, event)
    if (action === 'quit') app.quit()
    else if (action === 'refresh') void refresh()
    else if (action === 'open')
      void run(async () => {
        if (s.tab === 'businesses') {
          const b = s.businesses[s.selected]
          s.detail = await client.promo('GET', `/campaign-businesses/${encodeURIComponent(`${s.overview.campaign.id}:${new URL(b.website).hostname}`)}/results`)
        } else s.detail = s.posts[s.selected]
      })
    else if (action === 'pause')
      void run(async () => {
        const state = s.overview?.campaign.state === 'active' ? 'paused' : 'active'
        await client.promo('POST', `/campaigns/${id}/pause`, { state })
        await refresh()
        return `campaign ${state}`
      })
    else if (action === 'retry')
      void run(async () => {
        const p = s.posts[s.selected]
        await client.promo('POST', `/placements/${encodeURIComponent(p.id)}/retry`, {})
        await refresh()
        return `retrying ${p.id}`
      })
    else if (action === 'tick')
      void run(async () => {
        const t = await client.promo('POST', '/tick', {})
        await refresh()
        return `hourly pass: ${t.started} started, ${t.due} due, ${t.reviewed} reviewed`
      })
    app.invalidate()
  })

  app.render(({ ui, theme }: any) => {
    const o = s.overview
    ui.row({ size: 1 }, (h: any) => {
      h.text(' pit promo', { fg: theme.accent, bold: true, size: 11 })
      h.text(o ? `${o.campaign.name} · ${o.campaign.state}` : 'loading…', { fg: theme.muted })
      h.text(s.busy ? 'working… ' : `${s.message} `, { fg: theme.muted, align: 'right' })
    })
    if (o) {
      const line = (k: string) => `${k}: ${Object.entries(o[k]).map(([a, n]) => `${a} ${n}`).join(' · ') || 'none'}`
      ui.panel({ title: 'Campaign', size: 4 }, (p: any) => p.text(`${line('members')}   ${line('holds')}\n${line('placements')}   ${line('periods')}   reports ${o.reports}`, { fg: theme.text }))
    }
    if (s.detail) {
      ui.panel({ title: 'Detail (Esc to go back)' }, (p: any) => p.text(JSON.stringify(s.detail, null, 2), { fg: theme.text }))
    } else if (s.tab === 'businesses') {
      ui.panel({ title: `Businesses (${s.businesses.length})  · Tab: posts` }, (p: any) =>
        p.list({ items: s.businesses.map((b) => ({ label: `${b.verification.padEnd(10)} ${b.hold.padEnd(8)} ${b.business}  ${b.plannedAction}` })), selected: s.selected, followSelection: true, scrollbar: true }),
      )
    } else {
      ui.panel({ title: `Posts (${s.posts.length})  · Tab: businesses` }, (p: any) =>
        p.list({ items: s.posts.map((x) => ({ label: `${x.state.padEnd(10)} ${new Date(x.plannedAt).toISOString().slice(0, 16)} ${x.kind.padEnd(12)} ${x.account}${x.error ? `  ! ${x.error}` : ''}` })), selected: s.selected, followSelection: true, scrollbar: true }),
      )
    }
    ui.statusBar({
      items: [{ key: 'Tab', label: 'switch' }, { key: 'Enter', label: 'detail' }, { key: 'p', label: 'pause/resume' }, { key: 'r', label: 'retry post' }, { key: 't', label: 'hourly pass' }, { key: 'g', label: 'refresh' }, { key: 'q', label: 'quit' }],
      right: [{ label: 'operators only' }],
    })
  })

  void refresh()
  await app.start()
}
