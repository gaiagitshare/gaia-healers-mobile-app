const CACHE_NAME = 'gaia-healers-20260912j-stall-fix';
/**
 * Precache ONLY what the page requests by exactly this URL.
 *
 * home.html asks for its scripts and stylesheets with a ?v= cache-buster --
 * 47 of 53 same-origin requests carry one. caches.match() compares the full
 * URL including the query, so precaching the bare paths cached 63 files that
 * could never be served: the shell was downloaded twice on every first visit,
 * about 3.2MB of it, and then answered from the network anyway.
 *
 * The versioned assets are not listed here on purpose. The fetch handler below
 * is cache-first and stores whatever it fetches, so they are cached the moment
 * the page loads them -- and because a deploy changes the ?v=, a new version is
 * a new cache key that cannot be answered with the old file. Matching with
 * ignoreSearch would have broken exactly that.
 *
 * Only the modern image formats are precached. The PNG fallbacks are for the
 * browsers that cannot read WebP; those browsers pick them up at runtime rather
 * than every visitor paying 787KB for a file most of them will never request.
 */
const APP_SHELL = [
  '/',
  '/home.html',
  '/manifest.webmanifest',
  '/assets/gaia-mark.svg',
  '/assets/gaia-hero-moon-wide.webp',
  '/assets/gaia-hero-moon.webp',
  '/assets/gaia-elevate-hero.webp',
  '/assets/gaia-hero-moon.jpg',
  '/assets/gaia-elevate-poster.jpg',
  '/vendor/phosphor/Phosphor.woff2'
];

self.addEventListener('install', (event) => {
  // addAll() is atomic: one 404 and the whole install fails, so the update
  // never lands and users stay on the old worker indefinitely. Added one at a
  // time instead -- a missing asset costs that asset, not the release.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
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
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // The clone has to be taken BEFORE the response is handed back. Doing it
        // inside the caches.open() callback runs a microtask later, by which
        // point the page is already reading the body and clone() throws --
        // inside a floating promise, so it failed silently and the runtime
        // cache never filled. The navigate branch above always did this right.
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      });
    })
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
