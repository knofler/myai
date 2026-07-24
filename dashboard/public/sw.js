// myAI dashboard service worker — app-shell + offline fallback.
// Bump CACHE on any change to the shell assets to force re-cache.
const CACHE = 'myai-shell-v4'; // v4: web push handlers (REALTIME_NOTIFICATIONS Phase 6)
const SHELL = [
  '/',
  '/work',
  '/apps',
  '/system',
  '/registry',
  '/memory',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => undefined))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Web push (REALTIME_NOTIFICATIONS Phase 6) ──────────────────────────────
// The gateway pushes a JSON payload {title, body, level, type, url} when the
// user has no dashboard tab open. Clicking the notification focuses (or opens)
// the app at the payload's url — /notifications by default.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'myAI';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.type || 'myai-notification',
      data: { url: data.url || '/notifications' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/notifications';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const win of wins) {
        if ('focus' in win) {
          win.navigate(url).catch(() => undefined);
          return win.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// Network-first for navigations + data (keeps the dashboard live), falling
// back to the cached app-shell when offline. Cache-first for static assets.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isAsset = /\.(?:png|svg|ico|css|js|woff2?)$/.test(url.pathname);

  if (isAsset) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached ||
        fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // navigations / API: network-first, cache fallback
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (request.mode === 'navigate') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached || caches.match('/'))
      )
  );
});
