const CACHE_NAME = 'gaia-healers-20260830p32';
const APP_SHELL = [
  '/',
  '/home.html',
  '/manifest.webmanifest',
  '/gaia-shared.css',
  '/gaia-ui-v2.css',
  '/gaia-system.css',
  '/gaia-reshape.css',
  '/gaia-superapp.css',
  '/gaia-fit.css',
  '/vendor/phosphor/phosphor.css',
  '/vendor/phosphor/Phosphor.woff2',
  '/gaia-utilities.css',
  '/gaia-app-urls.js',
  '/gaia-ecosystem.js',
  '/gaia-live-sync.js',
  '/gaia-chakra-data.js',
  '/shared-nav.js',
  '/gaia-realtime-voice.js',
  '/gaia-member.js',
  '/gaia-academy-player.js',
  '/gaia-membership-ui.js',
  '/gaia-wellness.js',
  '/gaia-quiz.js',
  '/gaia-store.js',
  '/gaia-ui.js',
  '/gaia-superapp.js',
  '/gaia-directory.js',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/vendor/leaflet/markercluster.js',
  '/vendor/leaflet/MarkerCluster.css',
  '/vendor/leaflet/MarkerCluster.Default.css',
  '/gaia-daily.js',
  '/gaia-onboard.js',
  '/gaia-share.js',
  '/gaia-install.js',
  '/gaia-practice.js',
  '/gaia-sky.js',
  '/gaia-myevents.js',
  '/gaia-myschedule.js',
  '/gaia-people.js',
  '/assets/gaia-mark.svg',
  '/assets/gaia-elevate-hero.png',
  '/assets/gaia-hero-moon.png',
  '/assets/gaia-hero-moon-wide.png',
  '/assets/gaia-event-hero.webp',
  '/assets/gaia-chakra-meditation.webp',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-maskable-512.png',
  '/assets/apple-touch-icon.png'
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

// ---- Web push: show event notifications; focus/open the app on click --------
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { try { data = { body: event.data.text() }; } catch (_) { data = {}; } }
  const title = data.title || "Gaia Healers";
  const options = {
    body: data.body || "",
    icon: "/assets/gaia-logo.png",
    tag: data.tag || ("gaia-event-" + (data.eventId || "")),
    data: { url: data.url || "/home.html?view=events" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/home.html?view=events";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.indexOf(self.location.origin) === 0 && "focus" in client) {
          if ("navigate" in client) { client.navigate(target); }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
