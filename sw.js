/* DCR Portal service worker.
   Network-FIRST: when online, every request goes to the network so the app is
   always up to date (no stale-cache surprises). Responses are cached only as an
   offline fallback. Cross-origin requests (the Vercel API) and non-GET requests
   (logins, saves) are never intercepted — they always hit the network directly. */
const CACHE = "dcr-portal-v3";

self.addEventListener("install", function () {
  self.skipWaiting(); // activate the new worker immediately
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", function (event) {
  const req = event.request;
  if (req.method !== "GET") return;                       // don't touch API writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // don't touch the Vercel API (cross-origin)

  event.respondWith((async function () {
    try {
      const fresh = await fetch(req);                     // network first — always current when online
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);             // offline → last-seen copy of the app shell
      if (cached) return cached;
      throw err;
    }
  })());
});
