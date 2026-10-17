// Counts taps on a listing's phone link (for promotion campaigns): one beacon per tap, with an id so a
// retried beacon is counted once. Sends the listing's domain and the campaign link it came from, nothing else.
document.addEventListener('click', (event) => {
  const a = event.target instanceof Element ? event.target.closest('a[data-ev="phone"]') : null
  if (!a || !navigator.sendBeacon) return
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, '')
  const body = JSON.stringify({ type: 'phone_click', id, via: a.dataset.via || null })
  navigator.sendBeacon(`/b/${encodeURIComponent(a.dataset.domain)}/e`, new Blob([body], { type: 'application/json' }))
})
