/**
 * Service worker: makes Essay Reader fully offline after the first visit.
 *
 * Strategy
 *   - App shell (HTML/CSS/JS/manifest/icons): cache-first, refreshed in the
 *     background, so launching is instant and works with no signal.
 *   - Dictionary data (core chunks + letter shards): cache-first and long-lived;
 *     it rarely changes and is the bulk of the download.
 *   - Dictionary API requests: never cached here (the app carries its own data;
 *     the API is only optional enrichment on the desktop build).
 *
 * Bump CACHE_VERSION whenever the shell files change so old caches retire.
 */

const CACHE_VERSION = 'essay-reader-v22';

/**
 * Only the files needed to boot the app are precached. The dictionary is NOT
 * part of this list on purpose: precaching it during install would make the
 * worker's own install step compete with the words the reader is already trying
 * to look up, which is exactly the slowdown this avoids. Dictionary files are
 * cached on first fetch instead.
 */
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/state.js',
  './js/tokenize.js',
  './js/pin.js',
  './js/dict.js',
  './js/dict-offline.js',
  './js/glossary.js',
  './js/i18n.js',
  // Account sync. None of these is needed to read an essay, but precaching them
  // keeps a signed-in reader working offline and stops a first-ever sync from
  // failing on a flaky connection.
  './js/merge.js',
  './js/auth.js',
  './js/sync.js',
  './js/account.js',
  './js/supabase-config.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL).catch(() => null))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Data files worth keeping for a long time. */
const isData = (pathname) => /\/data\/(instant|core-\d+|shards\/[a-z_])\.json$/.test(pathname);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The optional desktop proxy must never be served from cache.
  if (url.pathname.includes('/api/')) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) {
        // Refresh the shell in the background so the next launch is current.
        // Dictionary data is stable enough not to revalidate.
        if (!isData(url.pathname)) {
          event.waitUntil(
            fetch(request)
              .then((res) => {
                if (res.ok) return caches.open(CACHE_VERSION).then((c) => c.put(request, res.clone()));
                return null;
              })
              .catch(() => null),
          );
        }
        return cached;
      }

      return fetch(request)
        .then((res) => {
          if (res.ok && (request.mode === 'navigate' || isData(url.pathname) || /\.(js|css|json|png|svg)$/.test(url.pathname))) {
            const copy = res.clone();
            event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.put(request, copy)));
          }
          return res;
        })
        .catch(() => {
          // Offline and uncached: fall back to the app shell for navigation.
          if (request.mode === 'navigate') return caches.match('./index.html');
          return new Response('', { status: 504, statusText: 'offline' });
        });
    }),
  );
});
