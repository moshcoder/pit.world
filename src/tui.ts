/**
 * `pit` with no arguments: search from the terminal.
 *
 * Type, Enter searches, ↑/↓ pick a result, Enter opens it in the browser,
 * Esc goes back to typing, Ctrl+C quits. A Moshpit name gets its own line on top.
 */
import { spawn } from 'node:child_process'
import { createApp } from '@profullstack/hqtui'
import { PitClient, type ApiSearch } from './client.js'

export type TuiState = {
  query: string
  typing: boolean
  busy: boolean
  result: ApiSearch | null
  error: string | null
  selected: number
}

export const initialState = (): TuiState => ({ query: '', typing: true, busy: false, result: null, error: null, selected: 0 })

/** Pure key handling, so it can be tested without a terminal. Returns what to do next. */
export function onKey(state: TuiState, key: { name: string; key: string; char?: string }): 'search' | 'open' | 'quit' | null {
  if (key.key === 'ctrl+c') return 'quit'
  if (state.typing) {
    if (key.name === 'enter') return state.query.trim() ? 'search' : null
    if (key.name === 'backspace') state.query = state.query.slice(0, -1)
    else if (key.name === 'escape') {
      if (state.result?.results.length) state.typing = false
      else return 'quit'
    } else if (key.name === 'down' && state.result?.results.length) state.typing = false
    else if (key.char && key.char.length === 1 && !key.key.startsWith('ctrl+')) state.query += key.char
    return null
  }
  const count = state.result?.results.length ?? 0
  if (key.name === 'down' || key.name === 'j') state.selected = Math.min(count - 1, state.selected + 1)
  else if (key.name === 'up' || key.name === 'k') {
    if (state.selected === 0) state.typing = true
    else state.selected -= 1
  } else if (key.name === 'enter') return count ? 'open' : null
  else if (key.name === 'escape' || key.name === '/' || key.char === '/') state.typing = true
  else if (key.name === 'q') return 'quit'
  return null
}

function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  const argv = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url] : ['xdg-open', url]
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

export async function runTui(client = new PitClient()): Promise<void> {
  const state = initialState()
  const app = await createApp({ title: 'pit.world', quitKeys: [] })

  const doSearch = async () => {
    state.busy = true
    state.error = null
    app.invalidate()
    try {
      state.result = await client.search(state.query.trim(), 15)
      state.selected = 0
      state.typing = !state.result.results.length
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    } finally {
      state.busy = false
      app.invalidate()
    }
  }

  app.on('key', (event: any) => {
    const action = onKey(state, event)
    if (action === 'quit') app.quit()
    else if (action === 'search') void doSearch()
    else if (action === 'open') openUrl(state.result!.results[state.selected]!.url)
    app.invalidate()
  })

  app.render(({ ui, theme }: any) => {
    ui.row({ size: 1 }, (header: any) => {
      header.text(' pit.world', { fg: theme.accent, bold: true, size: 11 })
      header.text('private search · the Moshpit network', { fg: theme.muted })
      header.text(`${client.base.replace(/^https?:\/\//, '')} `, { fg: theme.muted, align: 'right' })
    })
    ui.panel({ title: state.typing ? 'Search (typing)' : 'Search', size: 3 }, (p: any) => {
      p.text(`${state.query}${state.typing ? '▏' : ''}`, { fg: theme.text })
    })
    const mosh = state.result?.moshpit
    if (mosh?.nameRegistered) {
      ui.panel({ title: 'Moshpit name', size: 3 }, (p: any) => p.text(`${mosh.name}${mosh.target ? ` → ${mosh.target}` : ''}   ${mosh.page}`, { fg: theme.accent }))
    }
    ui.panel({ title: state.busy ? 'Searching…' : state.result ? `Results via ${state.result.provider ?? '?'}${state.result.cached ? ' (cached)' : ''}` : 'Results' }, (p: any) => {
      if (state.error) p.text(state.error, { fg: theme.danger ?? theme.accent })
      else if (!state.result) p.text('Type a search and press Enter. Moshpit names like chovy.hacker work too.', { fg: theme.muted })
      else
        p.list({
          items: state.result.results.map((hit) => ({ label: `${hit.title}  ${hit.host}` })),
          selected: state.typing ? -1 : state.selected,
          followSelection: true,
          scrollbar: true,
        })
    })
    const hit = !state.typing ? state.result?.results[state.selected] : undefined
    if (hit) ui.panel({ title: hit.host, size: 4 }, (p: any) => p.text(`${hit.url}\n${hit.description}`, { fg: theme.muted }))
    ui.statusBar({
      items: state.typing
        ? [{ key: 'Enter', label: 'search' }, { key: '↓', label: 'results' }, { key: 'Esc', label: 'quit' }]
        : [{ key: 'Enter', label: 'open' }, { key: '↑↓', label: 'move' }, { key: '/', label: 'type' }, { key: 'q', label: 'quit' }],
      right: [{ label: 'no logs · no cookies' }],
    })
  })

  await app.start()
}
