/* DCR Portal service worker.
   Network-FIRST: when online, every request goes to the network so the app is
   always up to date (no stale-cache surprises). Responses are cached only as an
   offline fallback. Cross-origin requests (the Vercel API) and non-GET requests
   (logins, saves) are never intercepted — they always hit the network directly. */
/* Bumped for the CME drawing tool: ~30 separate ES module files with no
   content hashing, so a partially-filled old cache could serve a mixed-version
   module graph offline. Network-first covers the online case; a new cache name
   covers the offline one. v6: phone reminders (push + notificationclick below),
   so every installed copy picks up the new worker. */
const CACHE = "dcr-portal-v6";

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
      // "Network first" only means something if the request actually reaches
      // the network. A plain fetch(req) still consults the browser's own HTTP
      // cache, so GitHub Pages' max-age let a page load new HTML against a JS
      // file the browser was still holding — a shipped fix looking unshipped.
      // no-cache revalidates every time (a 304 costs nothing when unchanged).
      const fresh = await fetch(req, { cache: "no-cache" });
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

/* ── phone reminders ──────────────────────────────────────────────────────
   The DCR Agents PC asks the portal to push {title, body, url, tag} to a
   phone that turned reminders on (push.js). The tag makes a second reminder
   for the same thing replace the first instead of stacking; the url is the
   timesheet page for the day being asked about. A push with no readable
   payload still shows something, because a silent push is not allowed to be
   silent on iOS and would cost the subscription. */
self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    try { data = { body: event.data.text() }; } catch (e2) { data = {}; }
  }
  var title = data.title || "DCR Framing";
  var url = data.url || new URL("dashboard.html", self.registration.scope).href;
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: new URL("icon-192.png", self.registration.scope).href,
    badge: new URL("icon-192.png", self.registration.scope).href,
    tag: data.tag || "dcr-portal",
    renotify: true,
    data: { url: url },
  }));
});

/* Tapping the reminder opens the page it points at: in a portal window that
   is already open when there is one (the installed app), else a new one. */
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) ||
    new URL("dashboard.html", self.registration.scope).href;
  event.waitUntil((async function () {
    var all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      if (c.url && c.url.indexOf(self.registration.scope) === 0 && "focus" in c) {
        try {
          if ("navigate" in c) await c.navigate(url);
        } catch (e) { /* a window we may not steer: focusing it is still better than nothing */ }
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
