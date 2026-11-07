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
  // The language setting (/settings, src/language.ts) lives here in the browser and rides on each search as ?lang=.
  const LANG = 'pit-language'
  const saveLanguage = (key, value) => {
    try {
      value === undefined ? localStorage.removeItem(key) : localStorage.setItem(key, value)
    } catch {}
  }
  let language = null
  try {
    language = localStorage.getItem(LANG)
  } catch {}
  const picker = document.getElementById('language')
  if (picker) {
    if (language && [...picker.options].some((o) => o.value === language)) picker.value = language
    picker.addEventListener('change', () => {
      language = picker.value === 'browser' ? null : picker.value
      saveLanguage(LANG, language ?? undefined)
      addLanguage()
      const saved = document.querySelector('.settings .saved')
      if (saved) saved.hidden = false
    })
  }
  function addLanguage() {
    for (const form of document.querySelectorAll('form.search')) {
      form.querySelector('input[name=lang]')?.remove()
      if (!language) continue
      const field = document.createElement('input')
      field.type = 'hidden'
      field.name = 'lang'
      field.value = language
      form.append(field)
    }
  }
  if (language) {
    // A search from the address bar or a bookmark arrives without it.
    const here = new URL(location.href)
    if (here.pathname === '/search' && here.searchParams.has('q') && !here.searchParams.has('lang')) {
      here.searchParams.set('lang', language)
      location.replace(here)
      return
    }
    // A page that carries its own lang= (Show all languages) keeps it.
    if (!document.querySelector('form.search input[name=lang]')) addLanguage()
  }
  // On a phone the tab row scrolls sideways: start it with the current tab in view, not off the edge.
  const tabs = document.querySelector('.tabs')
  const current = tabs?.querySelector('[aria-current="page"]')
  if (tabs && current && tabs.scrollWidth > tabs.clientWidth) {
    tabs.scrollLeft = Math.max(0, current.offsetLeft - tabs.offsetLeft - (tabs.clientWidth - current.offsetWidth) / 2)
  }
  // The mini player: one slim bar at the bottom for everything that is only sound (song previews, podcast
  // episodes, read-alouds), so it keeps playing while you scroll. Built on first use; nothing loads before.
  const speechOn = document.querySelector('main[data-speech]') !== null
  // A picture read from the result's own page (src/page-image.ts) can fail: the row closes up rather than show a hole.
  const noPicture = (img) => img.closest('li')?.classList.add('no-image')
  document.addEventListener('error', (e) => e.target.matches?.('img.page-image') && noPicture(e.target), true)
  for (const img of document.querySelectorAll('img.page-image')) if (img.complete && !img.naturalWidth) noPicture(img)
  const clock = (s) => {
    s = Math.max(0, Math.floor(s || 0))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const r = String(s % 60).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
  }
  // The mini player is @profullstack/player (src/player-bundle.ts), loaded the first time something plays.
  // Its bar shows the right button for what is happening (never a pause button over a stopped track),
  // hides itself while playing, and is the same player every Profullstack site uses.
  let playerModule = null
  const loadPlayer = () => {
    if (!playerModule) {
      if (!document.querySelector('link[data-pf-player]')) {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = '/pf-player.css'
        link.dataset.pfPlayer = ''
        document.head.append(link)
      }
      playerModule = import('/pf-player.js').catch((error) => {
        playerModule = null
        throw error
      })
    }
    return playerModule
  }
  let bar = null
  const stopBar = () => {
    if (!bar) return
    try {
      bar.player?.destroy()
    } catch {}
    bar.player = null
    if (bar.audio) {
      bar.audio.pause()
      bar.audio.removeAttribute('src')
      bar.audio.load()
    }
    bar.audio = null
  }
  const mini = () => {
    if (bar) return bar
    const el = document.createElement('section')
    el.className = 'mini-player'
    el.setAttribute('aria-label', 'Player')
    // threatcrush-disable-next-line js-unescaped-html-sink  a fixed literal with no interpolation; titles and transcript text are set with textContent
    el.innerHTML = `<div class="mp-panel" hidden><div class="mp-panel-head"><b>Transcript</b><span class="mp-panel-note"></span></div><ol class="mp-lines"></ol></div>
<div class="mp-row"><div class="mp-meta"><span class="mp-title"></span><span class="mp-sub"></span></div>
<div class="mp-stage"></div>
<button type="button" class="mp-tx" hidden aria-expanded="false">Transcript</button>
<button type="button" class="mp-close" aria-label="Close player">✕</button></div>`
    document.body.append(el)
    document.body.classList.add('has-mini-player')
    const $ = (sel) => el.querySelector(sel)
    $('.mp-close').addEventListener('click', () => {
      stopBar()
      el.remove()
      document.body.classList.remove('has-mini-player')
      bar = null
    })
    $('.mp-tx').addEventListener('click', () => transcript(bar))
    bar = { el, audio: null, player: null, $, track: null, polling: null }
    return bar
  }
  // Follow along in the transcript while it plays.
  const follow = (b, audio) =>
    audio.addEventListener('timeupdate', () => {
      if (b.$('.mp-panel').hidden) return
      let current = null
      for (const li of b.$('.mp-lines').children) if (Number(li.dataset.start) <= audio.currentTime) current = li
      for (const li of b.$('.mp-lines').querySelectorAll('[aria-current]')) if (li !== current) li.removeAttribute('aria-current')
      if (current && !current.hasAttribute('aria-current')) {
        current.setAttribute('aria-current', 'true')
        current.scrollIntoView({ block: 'nearest' })
      }
    })
  const playInBar = async (track) => {
    const b = mini()
    clearTimeout(b.polling)
    b.track = track
    b.$('.mp-title').textContent = track.title
    b.$('.mp-sub').textContent = track.sub || ''
    b.$('.mp-panel').hidden = true
    b.$('.mp-lines').textContent = ''
    const tx = b.$('.mp-tx')
    tx.hidden = !(speechOn && track.transcript)
    tx.setAttribute('aria-expanded', 'false')
    // One thing plays at a time: an open video under a result closes when sound starts here.
    closePlayers(null, 'video')
    stopBar()
    const stage = b.$('.mp-stage')
    stage.textContent = ''
    try {
      const { createPlayer } = await loadPlayer()
      if (b.track !== track || bar !== b) return
      const root = document.createElement('div')
      stage.append(root)
      b.player = createPlayer(root, { src: track.src, kind: 'audio', audio: true, autoplay: true, unplayableSubject: 'this track' })
      b.audio = b.player.media
    } catch {
      // The player bundle did not load: the browser's own controls still play it.
      if (b.track !== track || bar !== b) return
      const audio = document.createElement('audio')
      audio.controls = true
      audio.src = track.src
      stage.append(audio)
      b.audio = audio
      audio.play().catch(() => {})
    }
    follow(b, b.audio)
  }
  const deviceHeaders = async () => {
    const headers = { 'content-type': 'application/json' }
    try {
      const m = await fp()
      headers['x-fingerprint'] = m.encodePayload(await m.getFingerprint())
    } catch {}
    return headers
  }
  // Transcript (src/speech.ts): written by c0mpute ten minutes at a time; lines appear as they are written.
  const transcript = async (b) => {
    const panel = b.$('.mp-panel')
    const tx = b.$('.mp-tx')
    if (!panel.hidden) {
      panel.hidden = true
      tx.setAttribute('aria-expanded', 'false')
      return
    }
    panel.hidden = false
    tx.setAttribute('aria-expanded', 'true')
    const track = b.track
    const note = b.$('.mp-panel-note')
    const lines = b.$('.mp-lines')
    const render = (body) => {
      if (b.track !== track) return
      lines.textContent = ''
      for (const seg of body.segments || []) {
        const li = document.createElement('li')
        li.dataset.start = String(seg.start)
        const t = document.createElement('button')
        t.type = 'button'
        t.className = 'mp-at'
        t.textContent = clock(seg.start)
        t.addEventListener('click', () => {
          if (!b.audio) return
          b.audio.currentTime = seg.start
          b.audio.play().catch(() => {})
        })
        li.append(t, document.createTextNode(` ${seg.text}`))
        lines.append(li)
      }
      if (body.status === 'pending') note.textContent = body.segments?.length ? `Writing… ${clock(body.seconds)} so far` : 'Transcribing on c0mpute… the first lines take about a minute.'
      else if (body.status === 'failed') note.textContent = body.error || 'Transcript unavailable. Try again.'
      else if (body.preview && !body.complete) {
        note.textContent = 'Preview: the first five minutes. '
        const a = document.createElement('a')
        a.href = '/pass'
        a.textContent = 'The pass transcribes whole episodes'
        note.append(a)
      } else note.textContent = body.complete ? '' : `Up to ${clock(body.seconds)}`
    }
    note.textContent = 'Asking c0mpute…'
    try {
      let res = await fetch('/api/transcript', { method: 'POST', headers: await deviceHeaders(), body: JSON.stringify({ audio: track.transcript }) })
      let body = await res.json().catch(() => ({}))
      if (!res.ok && res.status !== 202) {
        note.textContent = `${body.error || 'Transcript unavailable.'} `
        if (body.pass) {
          const a = document.createElement('a')
          a.href = body.pass
          a.textContent = 'Get the pass'
          note.append(a)
        }
        return
      }
      render(body)
      const poll = async () => {
        if (b.track !== track || body.status !== 'pending') return
        res = await fetch(`/api/transcript?audio=${encodeURIComponent(track.transcript)}`)
        body = await res.json().catch(() => ({ status: 'failed' }))
        render(body)
        if (body.status === 'pending') b.polling = setTimeout(poll, 4000)
      }
      if (body.status === 'pending') b.polling = setTimeout(poll, 4000)
    } catch {
      note.textContent = 'Transcript unavailable. Try again.'
    }
  }

  // Play / Listen / Read here (src/players.ts): nothing loads until the button is pressed. Videos and books open
  // under the result; sound goes to the mini player. Pressing an open one again closes it.
  const closePlayers = (except, shape) => {
    for (const box of document.querySelectorAll(shape ? `.player.shape-${shape}` : '.player')) {
      if (box === except) continue
      const b = box.previousElementSibling?.querySelector?.('.play')
      if (b) {
        b.setAttribute('aria-expanded', 'false')
        b.textContent = b.dataset.label
      }
      box.remove()
    }
  }
  const resultTitle = (el) => el.closest('li')?.querySelector('.title')?.textContent?.trim() || 'Untitled'
  const upstreamOf = (src) => {
    try {
      return new URL(src, location.href).searchParams.get('u')
    } catch {
      return null
    }
  }
  for (const row of document.querySelectorAll('.play-row')) {
    row.hidden = false
    const button = row.querySelector('.play')
    const label = button.textContent
    button.dataset.label = label
    const kind = button.dataset.kind
    if (kind === 'audio') {
      // A song preview: straight to the mini player.
      button.addEventListener('click', () => playInBar({ src: button.dataset.src, title: resultTitle(button), sub: '30-second preview' }))
      continue
    }
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
      box.className = `player ${kind === 'embed' ? `shape-${button.dataset.shape}` : 'shape-episodes'}`
      closePlayers(box)
      row.after(box)
      button.setAttribute('aria-expanded', 'true')
      button.textContent = 'Close'
      if (kind === 'embed') {
        const frame = document.createElement('iframe')
        frame.src = button.dataset.src
        frame.title = `Player: ${resultTitle(row)}`
        // The site's own player needs to know the page it is on (YouTube refuses without), never the search.
        frame.referrerPolicy = 'strict-origin'
        frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture'
        frame.allowFullscreen = true
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox')
        box.append(frame)
        if (button.dataset.shape === 'video') {
          // Sound in the mini player stops when a video starts: two things playing at once is nobody's intent.
          stopBar()
          // Our own Full screen, on pit.world's side of the frame: it works whatever the embedded
          // player allows, and double-clicking the frame edge or pressing f does the same.
          const tools = document.createElement('div')
          tools.className = 'player-tools'
          const full = document.createElement('button')
          full.type = 'button'
          full.className = 'player-full'
          full.textContent = 'Full screen'
          const goFull = async () => {
            try {
              if (document.fullscreenElement) return await document.exitFullscreen()
              if (box.requestFullscreen) return await box.requestFullscreen({ navigationUI: 'hide' })
              if (box.webkitRequestFullscreen) return box.webkitRequestFullscreen()
            } catch {}
            full.textContent = 'Use the player’s own full screen button'
          }
          full.addEventListener('click', goFull)
          box.addEventListener('dblclick', (event) => {
            if (event.target === box) goFull()
          })
          box.tabIndex = -1
          box.addEventListener('keydown', (event) => {
            if (event.key === 'f' && event.target === box) goFull()
          })
          document.addEventListener('fullscreenchange', () => {
            full.textContent = document.fullscreenElement === box ? 'Exit full screen' : 'Full screen'
          })
          tools.append(full)
          box.append(tools)
        }
        return
      }
      // A podcast: its newest episodes as a short list; the one you pick plays in the mini player.
      const showName = resultTitle(row)
      box.textContent = 'Loading episodes…'
      try {
        const res = await fetch(`/api/episodes?show=${encodeURIComponent(button.dataset.show)}`)
        const body = await res.json()
        if (!res.ok || !body.episodes?.length) throw new Error(body.error || 'No episodes found.')
        box.textContent = ''
        const list = document.createElement('ol')
        list.className = 'episodes'
        const pick = (i) => {
          const e = body.episodes[i]
          playInBar({ src: e.src, title: e.title, sub: showName, transcript: upstreamOf(e.src) })
          for (const [j, li] of [...list.children].entries()) li.firstChild.setAttribute('aria-current', String(i === j))
        }
        body.episodes.forEach((e, i) => {
          const li = document.createElement('li')
          const b = document.createElement('button')
          b.type = 'button'
          b.textContent = e.seconds ? `${e.title} (${clock(e.seconds)})` : e.title
          b.addEventListener('click', () => pick(i))
          li.append(b)
          list.append(li)
        })
        box.append(list)
        pick(0)
      } catch (error) {
        box.textContent = error.message || 'Episodes unavailable. Try again.'
        box.classList.add('err')
      }
    })
  }

  // Listen (src/speech.ts): c0mpute reads the result aloud (its summary, or the start of the page) into the mini player.
  for (const button of document.querySelectorAll('.summary-row .listen')) {
    button.hidden = false
    button.addEventListener('click', async () => {
      const url = button.dataset.url
      const box = button.parentElement.querySelector('.summary')
      const track = (src) => ({ src, title: button.dataset.title || url, sub: `Read aloud by c0mpute · ${button.dataset.host || ''}` })
      button.disabled = true
      show(box, 'Reading it aloud on c0mpute… about half a minute.', 'wait')
      const started = Date.now()
      try {
        let res = await fetch('/api/listen', { method: 'POST', headers: await deviceHeaders(), body: JSON.stringify({ url }) })
        let body = await res.json().catch(() => ({}))
        while ((res.ok || res.status === 202) && body.status === 'pending' && Date.now() - started < 180_000) {
          await new Promise((r) => setTimeout(r, 3000))
          res = await fetch(`/api/listen?url=${encodeURIComponent(url)}`)
          body = await res.json().catch(() => ({}))
        }
        if (body.status === 'done') {
          box.hidden = true
          button.disabled = false
          button.textContent = 'Listen again'
          playInBar(track(body.src))
          return
        }
        show(box, `${body.error || 'Listen unavailable. Try again.'} `, 'err')
        if (body.pass || body.signIn) {
          const a = document.createElement('a')
          a.href = body.signIn && !body.pass ? body.signIn : body.pass
          a.textContent = body.pass ? 'Get the pass' : 'Sign in'
          box.append(a)
        }
      } catch {
        show(box, 'Listen unavailable. Try again.', 'err')
      }
      button.disabled = false
      button.textContent = 'Try again'
    })
  }
  // Summarize: ask pit.world for a c0mpute summary of one result, then poll until a node has written it.
  const show = (box, text, kind) => {
    box.hidden = false
    box.className = `summary${kind ? ` ${kind}` : ''}`
    box.textContent = text
  }
  for (const button of document.querySelectorAll('.summary-row .summarize')) {
    button.hidden = false
    button.addEventListener('click', async () => {
      const url = button.dataset.url
      const box = button.parentElement.querySelector('.summary')
      button.disabled = true
      show(box, 'Summarizing…', 'wait')
      const started = Date.now()
      let drafted = false
      try {
        // The device fingerprint, so the free allowance is per device rather than per address (privacy#votes).
        const headers = { 'content-type': 'application/json' }
        try {
          const m = await fp()
          headers['x-fingerprint'] = m.encodePayload(await m.getFingerprint())
        } catch {}
        let res = await fetch('/api/summarize', { method: 'POST', headers, body: JSON.stringify({ url }) })
        let body = await res.json().catch(() => ({}))
        // An instant summary from the page itself. The model's replaces it if it arrives; if not, this one stands.
        if (body.draft) {
          drafted = true
          show(box, body.draft, '')
          button.hidden = true
        }
        while ((res.ok || res.status === 202) && body.status === 'pending' && Date.now() - started < 120_000) {
          await new Promise((r) => setTimeout(r, 3000))
          res = await fetch(`/api/summarize?url=${encodeURIComponent(url)}`)
          body = await res.json().catch(() => ({}))
          if (!drafted && body.draft) {
            drafted = true
            show(box, body.draft, '')
            button.hidden = true
          }
        }
        if (body.status === 'done') {
          show(box, body.summary, '')
          button.hidden = true
          return
        }
        if (drafted) return
        // 402 is the same limit with an x402 offer attached for agents; people get the same links.
        if ((res.status === 429 || res.status === 402) && (body.signIn || body.pass)) {
          show(box, `${body.error} `, 'err')
          const a = document.createElement('a')
          a.href = body.signIn || body.pass
          a.textContent = body.signIn ? 'Sign in' : body.pass === '/pass' ? 'Get the $1 weekly pass' : 'Your pass'
          box.append(a)
        } else {
          show(box, body.error || 'That took too long. Try again.', 'err')
        }
      } catch {
        if (drafted) return
        show(box, 'Could not reach pit.world. Try again.', 'err')
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

  // Shared result page: Copy link (shown only with script and a clipboard), and select-all on focus.
  for (const button of document.querySelectorAll('.share-copy .copy')) {
    if (!navigator.clipboard) continue
    button.hidden = false
    button.addEventListener('click', () => {
      navigator.clipboard.writeText(button.dataset.copy || '').then(
        () => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy link' }, 2000) },
        () => { button.textContent = 'Select and copy' },
      )
    })
  }
  for (const input of document.querySelectorAll('.share-copy input')) input.addEventListener('focus', () => input.select())

  // Installable app + offline page. The worker caches the static shell only, never a search.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
})()
