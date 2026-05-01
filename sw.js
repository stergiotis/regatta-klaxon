// Service worker — cache-first app shell for offline use.
// __BUILD_ID__ is replaced with the short git SHA at deploy time so each push invalidates the cache.
const CACHE = 'klaxon-__BUILD_ID__';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './audio/minute_6.mp3',
  './audio/minute_5.mp3',
  './audio/minute_4.mp3',
  './audio/minute_3.mp3',
  './audio/minute_2.mp3',
  './audio/minute_1.mp3',
  './audio/sec_10.mp3',
  './audio/sec_9.mp3',
  './audio/sec_8.mp3',
  './audio/sec_7.mp3',
  './audio/sec_6.mp3',
  './audio/sec_5.mp3',
  './audio/sec_4.mp3',
  './audio/sec_3.mp3',
  './audio/sec_2.mp3',
  './audio/sec_1.mp3',
  './audio/go.mp3',
  './audio/sync.mp3',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Network-first for HTML so updates ship; cache-first for everything else.
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) {
    e.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return resp;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
