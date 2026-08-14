const CACHE_NAME = 'videoshelf-pwa-v5';
const OFFLINE_URL = './index.html';
const ASSETS = [
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

async function putInCache(request, response) {
  if (!response || !response.ok || request.method !== 'GET') return response;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return await putInCache(request, response);
  } catch (_) {
    return (await caches.match(request)) || (await caches.match(OFFLINE_URL));
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    return await putInCache(request, response);
  } catch (_) {
    return caches.match(OFFLINE_URL);
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

// Background Sync: VideoShelf is local-first, so there is currently no
// server mutation to retry. The handler is intentionally safe for future use.
self.addEventListener('sync', (event) => {
  if (event.tag !== 'videoshelf-background-sync') return;
  event.waitUntil(Promise.resolve());
});

// Periodic Background Sync: refresh the app shell when the browser grants it.
self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'videoshelf-periodic-sync') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(ASSETS.map(async (asset) => {
      try {
        const response = await fetch(asset, { cache: 'no-cache' });
        if (response.ok) await cache.put(asset, response);
      } catch (_) {}
    }));
  })());
});

// Push Notifications: ready for a real Push API/VAPID subscription.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}

  const title = data.title || 'VideoShelf';
  const options = {
    body: data.body || 'You have a new VideoShelf notification.',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: data.url || './' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || './';
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => 'focus' in client);
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return clients.openWindow(target);
  })());
});

// Allow the app to request an immediate update after a new deployment.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
