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
        let res = await fetch('/api/summarize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
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
        if (res.status === 429 && body.signIn) {
          show(box, `${body.error} `, 'err')
          const a = document.createElement('a')
          a.href = body.signIn
          a.textContent = 'Sign in'
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
  // Installable app + offline page. The worker caches the static shell only, never a search.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
})()
