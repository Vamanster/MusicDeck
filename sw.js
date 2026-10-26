// MusicDeck service worker
// Bump CACHE_VERSION whenever you change any file in APP_SHELL.
const CACHE_VERSION = 'v7';
const CACHE_NAME = `musicdeck-shell-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/player.js',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/ui/music.svg',
  './icons/ui/playlist.svg',
  './icons/ui/player-play.svg',
  './icons/ui/player-pause.svg',
  './icons/ui/player-track-next.svg',
  './icons/ui/player-track-prev.svg',
  './icons/ui/repeat.svg',
  './icons/ui/repeat-once.svg',
  './icons/ui/repeat-off.svg',
  './icons/ui/sort-descending.svg',
  './icons/ui/arrows-shuffle.svg',
  './icons/ui/dots-vertical.svg',
  './icons/ui/share.svg',
  './icons/ui/square-plus.svg',
];

// cache: 'reload' skips the browser's HTTP cache, so a new version never gets stored
// alongside a stale copy of a file (which mixes old and new code).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('musicdeck-shell-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// The page asks the waiting worker to take over when the user clicks "Reload".
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// Network-first for app files: online you always get the current files (checked against the
// server, not the HTTP cache), and the cached copy is refreshed. Offline, the cache is used.
// Audio lives in IndexedDB and is played from blob: URLs, so it never hits this handler.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  }
}
