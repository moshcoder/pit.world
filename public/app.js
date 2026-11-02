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
        if (res.status === 429 && (body.signIn || body.pass)) {
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
