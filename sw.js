const CACHE_NAME = 'videoshelf-pwa-v3';
const OFFLINE_URL = './index.html';
const ASSETS = [
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return caches.match(OFFLINE_URL);
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return caches.match(request) || caches.match(OFFLINE_URL);
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Navigation: network first, then cached app shell when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Local application assets: cache first for fast/offline startup.
  event.respondWith(cacheFirst(event.request));
});

/* ---------- Background Sync ----------
   VideoShelf is local-first, so there is no server mutation to retry yet.
   This handler is intentionally safe and can be used by future network
   features without breaking browsers that do not implement Background Sync.
*/
self.addEventListener('sync', (event) => {
  if (event.tag !== 'videoshelf-background-sync') return;
  event.waitUntil(Promise.resolve());
});

/* ---------- Periodic Background Sync ----------
   Keep the app shell warm when supported. This does not invent a network
   backend; it simply refreshes same-origin cached assets opportunistically.
*/
self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'videoshelf-periodic-sync') return;
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(ASSETS.map(async asset => {
        try {
          const response = await fetch(asset, { cache: 'no-cache' });
          if (response.ok) await cache.put(asset, response);
        } catch (_) {}
      }))
    )
  );
});

/* ---------- Push Notifications ----------
   The service worker is ready to display notifications when a push service
   is connected. A real push subscription still requires an application
   server/VAPID setup, so no fake subscription is created here.
*/
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}

  const title = data.title || 'VideoShelf';
  const options = {
    body: data.body || 'You have a new VideoShelf notification.',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: data.url || './' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(client => 'focus' in client);
      if (existing) {
        return existing.navigate(target).then(client => client.focus());
      }
      return clients.openWindow(target);
    })
  );
});
