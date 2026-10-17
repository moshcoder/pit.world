// The pit.world service worker: makes the site installable and gives it an offline page.
// It stores the static shell and nothing else. Searches, suggestions and the API always
// go to the network and are never written to this device.
// Bumped when the caching rules change. Pages link /style.css?v=<hash>, so new CSS
// is a cache miss by URL and is fetched fresh; v1 cached the bare URL forever.
const CACHE = 'pit-shell-v2'
const SHELL = ['/offline', '/style.css', '/app.js', '/favicon.svg', '/icon-192.png', '/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  // Pages: always the network. Offline, the offline page, never a stored copy of a search.
  if (request.mode === 'navigate') {
    // threatcrush-disable-next-line js-ssrf-outbound-request  runs in the visitor's browser, same-origin only (checked above)
    event.respondWith(fetch(request).catch(() => caches.match('/offline')))
    return
  }

  // The shell: from the cache, refreshed in the background.
  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request)
        // threatcrush-disable-next-line js-ssrf-outbound-request  browser-side, a fixed list of same-origin shell files
        const fresh = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone())
            return response
          })
          .catch(() => cached)
        return cached || fresh
      }),
    )
  }
})
