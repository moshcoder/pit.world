// Optional niceties. pit.world works without this file.
// "/" focuses the search box; j/k move between results; Enter opens one.
(() => {
  const input = document.querySelector('.search input')
  const links = () => [...document.querySelectorAll('.hits .title')]
  let index = -1
  const focus = (i) => {
    const all = links()
    if (!all.length) return
    index = Math.max(0, Math.min(all.length - 1, i))
    all[index].focus()
  }
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // Any field counts, not just search: j/k and "/" were eaten in the footer's newsletter email box,
    // so "anthony@profullstack.com" went out as "...profullstac.com" and bounced as undeliverable.
    const el = document.activeElement
    const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
    if (event.key === '/' && !typing) {
      event.preventDefault()
      input?.focus()
      input?.select()
    } else if (event.key === 'Escape' && typing) {
      el.blur()
    } else if (!typing && (event.key === 'j' || event.key === 'ArrowDown')) {
      event.preventDefault()
      focus(index + 1)
    } else if (!typing && (event.key === 'k' || event.key === 'ArrowUp')) {
      event.preventDefault()
      focus(index - 1)
    }
  })
  // On a phone the tab row scrolls sideways: start it with the current tab in view, not off the edge.
  const tabs = document.querySelector('.tabs')
  const current = tabs?.querySelector('[aria-current="page"]')
  if (tabs && current && tabs.scrollWidth > tabs.clientWidth) {
    tabs.scrollLeft = Math.max(0, current.offsetLeft - tabs.offsetLeft - (tabs.clientWidth - current.offsetWidth) / 2)
  }
  // Play / Listen / Read here (src/players.ts): nothing loads until the button is pressed, then the player
  // opens under the result. Pressing again closes it, and opening one closes any other.
  const closePlayers = (except) => {
    for (const box of document.querySelectorAll('.player')) {
      if (box === except) continue
      const b = box.previousElementSibling?.querySelector?.('.play')
      if (b) {
        b.setAttribute('aria-expanded', 'false')
        b.textContent = b.dataset.label
      }
      box.remove()
    }
  }
  const audioEl = (src) => {
    const a = document.createElement('audio')
    a.controls = true
    a.autoplay = true
    a.preload = 'none'
    a.src = src
    return a
  }
  const clock = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : `${Math.floor(s / 60)}`) + `:${String(s % 60).padStart(2, '0')}`
  for (const row of document.querySelectorAll('.play-row')) {
    row.hidden = false
    const button = row.querySelector('.play')
    const label = button.textContent
    button.dataset.label = label
    button.setAttribute('aria-expanded', 'false')
    button.addEventListener('click', async () => {
      const open = row.nextElementSibling?.classList.contains('player') ? row.nextElementSibling : null
      if (open) {
        open.remove()
        button.setAttribute('aria-expanded', 'false')
        button.textContent = label
        return
      }
      const box = document.createElement('div')
      box.className = `player ${button.dataset.kind === 'embed' ? `shape-${button.dataset.shape}` : 'shape-audio-file'}`
      closePlayers(box)
      row.after(box)
      button.setAttribute('aria-expanded', 'true')
      button.textContent = 'Close'
      const kind = button.dataset.kind
      if (kind === 'embed') {
        const frame = document.createElement('iframe')
        frame.src = button.dataset.src
        frame.title = `Player: ${row.closest('li')?.querySelector('.title')?.textContent ?? 'media'}`
        // The site's own player needs to know the page it is on (YouTube refuses without), never the search.
        frame.referrerPolicy = 'strict-origin'
        frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture'
        frame.allowFullscreen = true
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox')
        box.append(frame)
      } else if (kind === 'audio') {
        box.append(audioEl(button.dataset.src))
      } else if (kind === 'episodes') {
        box.textContent = 'Loading episodes…'
        try {
          const res = await fetch(`/api/episodes?show=${encodeURIComponent(button.dataset.show)}`)
          const body = await res.json()
          if (!res.ok || !body.episodes?.length) throw new Error(body.error || 'No episodes found.')
          box.textContent = ''
          const now = document.createElement('p')
          now.className = 'now-playing'
          const player = audioEl(body.episodes[0].src)
          const list = document.createElement('ol')
          list.className = 'episodes'
          const pick = (i) => {
            now.textContent = body.episodes[i].title
            for (const [j, li] of [...list.children].entries()) li.firstChild.setAttribute('aria-current', String(i === j))
          }
          body.episodes.forEach((e, i) => {
            const li = document.createElement('li')
            const b = document.createElement('button')
            b.type = 'button'
            b.textContent = e.seconds ? `${e.title} (${clock(e.seconds)})` : e.title
            b.addEventListener('click', () => {
              player.src = e.src
              player.play().catch(() => {})
              pick(i)
            })
            li.append(b)
            list.append(li)
          })
          box.append(now, player, list)
          pick(0)
        } catch (error) {
          box.textContent = error.message || 'Episodes unavailable. Try again.'
          box.classList.add('err')
        }
      }
    })
  }
  // Summarize: ask pit.world for a c0mpute summary of one result, then poll until a node has written it.
  const show = (box, text, kind) => {
    box.hidden = false
    box.className = `summary${kind ? ` ${kind}` : ''}`
    box.textContent = text
  }
  for (const button of document.querySelectorAll('.hits .summarize')) {
    button.hidden = false
    button.addEventListener('click', async () => {
      const url = button.dataset.url
      const box = button.parentElement.querySelector('.summary')
      button.disabled = true
      show(box, 'Summarizing on c0mpute… this can take a minute.', 'wait')
      const started = Date.now()
      try {
        // The device fingerprint, so the free allowance is per device rather than per address (privacy#votes).
        const headers = { 'content-type': 'application/json' }
        try {
          const m = await fp()
          headers['x-fingerprint'] = m.encodePayload(await m.getFingerprint())
        } catch {}
        let res = await fetch('/api/summarize', { method: 'POST', headers, body: JSON.stringify({ url }) })
        let body = await res.json().catch(() => ({}))
        while (res.ok && body.status === 'pending' && Date.now() - started < 150_000) {
          await new Promise((r) => setTimeout(r, 3000))
          res = await fetch(`/api/summarize?url=${encodeURIComponent(url)}`)
          body = await res.json().catch(() => ({}))
        }
        if (body.status === 'done') {
          show(box, body.summary, '')
          button.hidden = true
          return
        }
        // 402 is the same limit with an x402 offer attached for agents; people get the same links.
        if ((res.status === 429 || res.status === 402) && (body.signIn || body.pass)) {
          show(box, `${body.error} `, 'err')
          const a = document.createElement('a')
          a.href = body.signIn || body.pass
          a.textContent = body.signIn ? 'Sign in' : body.pass === '/pass' ? 'Get the $1 weekly pass' : 'Your pass'
          box.append(a)
        } else {
          show(box, body.error || 'Summary unavailable. Try again.', 'err')
        }
      } catch {
        show(box, 'Summary unavailable. Try again.', 'err')
      }
      button.disabled = false
      button.textContent = 'Try again'
    })
  }
  // ▲ ▼ votes. The device fingerprint (/fp.js, @profullstack/browser-fingerprint, served by pit.world) is read
  // only when you press one, and only a salted hash of it is kept (pit.world/privacy#votes). Your own votes are
  // remembered on this device only, to show which arrow you pressed.
  let fpModule = null
  const fp = () => (fpModule ??= import('/fp.js'))
  const MINE = 'pit-votes'
  const mine = () => {
    try {
      return JSON.parse(localStorage.getItem(MINE) || '{}')
    } catch {
      return {}
    }
  }
  const remember = (key, value) => {
    try {
      const all = mine()
      if (value) all[key] = value
      else delete all[key]
      const keys = Object.keys(all)
      for (const k of keys.slice(0, Math.max(0, keys.length - 2000))) delete all[k]
      localStorage.setItem(MINE, JSON.stringify(all))
    } catch {}
  }
  const query = () => document.querySelector('main[data-q]')?.getAttribute('data-q') || ''
  const keyOf = (form) => `${form.dataset.item}|${form.dataset.item.startsWith('result:') ? query() : ''}`
  const paint = (form, value, tally) => {
    form.querySelector('.up')?.setAttribute('aria-pressed', String(value === 1))
    form.querySelector('.down')?.setAttribute('aria-pressed', String(value === -1))
    const out = form.querySelector('.n')
    if (out && tally) {
      out.textContent = tally.up || tally.down ? String(tally.up - tally.down) : ''
      out.title = `${tally.up} up, ${tally.down} down`
    }
  }
  const stored = mine()
  for (const form of document.querySelectorAll('form.vote')) if (stored[keyOf(form)]) paint(form, stored[keyOf(form)])
  const say = (form, text) => {
    let note = form.querySelector('.vote-note')
    if (!note) {
      note = document.createElement('span')
      note.className = 'vote-note'
      note.setAttribute('role', 'status')
      form.appendChild(note)
    }
    note.textContent = text
    setTimeout(() => note.remove(), 4000)
  }
  document.addEventListener('submit', async (event) => {
    const form = event.target
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('vote')) return
    event.preventDefault()
    if (form.dataset.busy) return
    const value = Number(event.submitter?.value || 0)
    form.dataset.busy = '1'
    try {
      const { getFingerprint } = await fp()
      const send = async (fresh) =>
        fetch('/api/vote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: form.elements.kind.value, target: form.elements.target.value, value, toggle: true, q: query(), fp: await getFingerprint({ fresh }) }),
        })
      let res = await send(false)
      let body = await res.json().catch(() => ({}))
      if (res.status === 400 && body.error === 'stale') {
        res = await send(true)
        body = await res.json().catch(() => ({}))
      }
      if (res.ok && body.ok) {
        paint(form, body.value, body)
        remember(keyOf(form), body.value)
      } else
        say(form, body.error === 'limited' ? 'Too many votes; wait a bit.' : body.error === 'bot' ? 'Not counted: looked automated.' : 'Not counted; reload and try again.')
    } catch {
      say(form, 'Vote failed; try again.')
    } finally {
      delete form.dataset.busy
    }
  })
  // Anonymous forms (newsletter, claims, quote requests, submissions, build orders) carry the same fingerprint, so
  // they are limited per device instead of per address. Without JavaScript they still work, limited by address.
  const ANON = 'form[action="/subscribe"], form[action$="//pit.world/subscribe"], form[action="/build/invoice"], form[action$="/claim"], form[action$="/quote"], form[action="/submit"]'
  if (document.querySelector(ANON)) fp().then((m) => m.attachToForms({ selector: ANON })).catch(() => {})

  // Installable app + offline page. The worker caches the static shell only, never a search.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
})()
