const CACHE_NAME = 'gaia-healers-20260721g';
const APP_SHELL = [
  '/',
  '/home.html',
  '/manifest.webmanifest',
  '/gaia-shared.css',
  '/gaia-ui-v2.css',
  '/gaia-system.css',
  '/gaia-reshape.css',
  '/gaia-utilities.css',
  '/gaia-app-urls.js',
  '/gaia-ecosystem.js',
  '/gaia-live-sync.js',
  '/gaia-chakra-data.js',
  '/shared-nav.js',
  '/gaia-realtime-voice.js',
  '/gaia-member.js',
  '/gaia-wellness.js',
  '/gaia-quiz.js',
  '/gaia-store.js',
  '/gaia-ui.js',
  '/assets/gaia-mark.svg',
  '/assets/gaia-event-hero.webp',
  '/assets/gaia-chakra-meditation.webp',
  '/assets/icon-192.png',
  '/assets/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/home.html', copy));
          return response;
        })
        .catch(() => caches.match('/home.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }))
  );
});
