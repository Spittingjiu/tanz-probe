// Tanz Probe Service Worker (PWA Cache & Offline Support)
const CACHE_NAME = 'tanz-probe-v49.0';
const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Strictly bypass all cross-origin requests (CDNs like tailwindcss, jsdelivr, google fonts)
  // Let the browser network handle them directly so they are NEVER blocked by Service Worker!
  if (url.origin !== self.location.origin) {
    return;
  }

  // 2. Network-only for real-time WebSocket, dynamic APIs and report posts
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    return;
  }

  // 3. Network-first for HTML pages and app scripts (.js, .html)
  if (event.request.mode === 'navigate' || url.pathname.endsWith('.js') || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseToCache));
        }
        return networkResponse;
      }).catch(() => caches.match(event.request) || caches.match('/'))
    );
    return;
  }

  // 4. Stale-while-revalidate for local same-origin static assets (images, icons, etc.)
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      const fetchPromise = fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseToCache));
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
