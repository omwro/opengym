/* openGym service worker — runtime caching (works with Vite's hashed asset names).
   Media (img/gif) cache-first; everything else network-first with offline fallback. */
const CACHE = 'opengym-rt-v2'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()))
})
// Every push must end in a visible notification. iOS revokes push for a web app whose push
// handler shows nothing, and Chrome shows a generic "site updated in the background" instead —
// so a payload that fails to parse still produces a notification rather than throwing.
self.addEventListener('push', e => {
  let data = {}
  try { data = e.data ? e.data.json() : {} } catch { data = { body: e.data ? e.data.text() : '' } }
  e.waitUntil(self.registration.showNotification(data.title || 'openGym', {
    body: data.body || '',
    icon: new URL('icon-512.png', self.registration.scope).href,
    badge: new URL('icon-180.png', self.registration.scope).href,
    tag: data.tag || 'opengym',
    renotify: true,
    data: { url: data.url || './' }
  }))
})
self.addEventListener('notificationclick', e => {
  e.notification.close()
  const target = new URL(e.notification.data?.url || './', self.registration.scope).href
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const c = clients.find(c => 'focus' in c)
    if (c) return c.focus().then(w => (w && 'navigate' in w && target.includes('#') ? w.navigate(target) : w))
    return self.clients.openWindow(target)
  }))
})

// The browser can replace a subscription on its own (expiry, key rotation). When it does, the
// old endpoint stops working and the server would keep pushing into nothing — so register the
// new one straight away. The session cookie rides along on this same-origin request.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const { key } = await fetch('api/push/public-key', { credentials: 'same-origin' }).then(r => r.json())
    const pad = '='.repeat((4 - key.length % 4) % 4)
    const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/'))
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
    })
    await fetch('api/push/subscribe', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() })
    })
  })().catch(() => {}))
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/')) return    // never cache auth/data

  const isMedia = url.pathname.includes('/img/') || url.pathname.includes('/gif/')
  if (isMedia) {
    e.respondWith(caches.open(CACHE).then(c => c.match(e.request).then(hit =>
      hit || fetch(e.request).then(res => { if (res.ok) c.put(e.request, res.clone()); return res })
    )))
  } else {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()))
      return res
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('index.html'))))
  }
})
