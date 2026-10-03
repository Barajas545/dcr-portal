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

/* Only this app's own old caches. The takeoff tool is served from the same
   origin and keeps its offline copy in Cache Storage too ("ptt-web-*"):
   deleting every name but ours wiped it on each portal update, and the saved
   plans in the Plans Library are useless offline without the tool to open
   them. (The name above stays v6 on purpose: a changed worker installs by
   itself, and a new name would throw away every page already kept offline.) */
self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.indexOf("dcr-portal-") === 0 && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* The Plans Library asks for the pages it needs offline to be kept now,
   rather than whenever they happen to be visited: the library page, its
   scripts, the shared helpers and styles. Only this app's own files, inside
   this worker's scope, are ever fetched. */
self.addEventListener("message", function (event) {
  const m = event.data || {};
  if (m.type !== "dcr-precache" || !Array.isArray(m.urls)) return;
  const scope = self.registration.scope;
  // Normalised first: "…/dcr-portal/../takeoff-web/x" is not inside the scope.
  const urls = m.urls.map(function (u) {
    try { return new URL(String(u), scope).href; } catch (e) { return ""; }
  }).filter((u) => u && u.indexOf(scope) === 0).slice(0, 40);
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    await Promise.all(urls.map(async (u) => {
      try {
        const res = await fetch(u, { cache: "no-cache" });
        if (res && res.ok && res.type === "basic") await cache.put(u, res);
      } catch (e) { /* offline or missing: keep whatever copy is there */ }
    }));
  })());
});

self.addEventListener("fetch", function (event) {
  const req = event.request;
  if (req.method !== "GET") return;                       // don't touch API writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // don't touch the Vercel API (cross-origin)

  event.respondWith((async function () {
    // "Network first" only means something if the request actually reaches
    // the network. A plain fetch(req) still consults the browser's own HTTP
    // cache, so GitHub Pages' max-age let a page load new HTML against a JS
    // file the browser was still holding — a shipped fix looking unshipped.
    // no-cache revalidates every time (a 304 costs nothing when unchanged).
    const network = fetch(req, { cache: "no-cache" }).then(function (fresh) {
      if (fresh && fresh.ok) {
        const copy = fresh.clone();
        caches.open(CACHE).then(function (cache) { return cache.put(req, copy); }).catch(function () {});
      }
      return fresh;
    });

    /* The Plans Library exists for a weak or absent signal. With a signal
       that is there but barely, a network-first fetch can hang for most of a
       minute before failing, and the saved plans would sit out of reach the
       whole time. So the library page, and what it loads, wait at most three
       seconds before the copy kept on this device is used (the network
       answer still refreshes that copy for next time). Every other page stays
       strictly network-first, as above. */
    let quick = false;
    try {
      if (url.pathname.indexOf("/api/") !== 0) {
        if (/\/plans-library\.html$/.test(url.pathname)) quick = true;
        else if (event.clientId) {
          const client = await self.clients.get(event.clientId);
          quick = !!(client && /\/plans-library\.html$/.test(new URL(client.url).pathname));
        }
      }
    } catch (e) { quick = false; }
    if (quick) {
      const kept = await caches.match(req);
      if (kept) {
        const first = await Promise.race([
          network.catch(function () { return null; }),
          new Promise(function (r) { setTimeout(function () { r(null); }, 3000); }),
        ]);
        if (first) return first;
        event.waitUntil(network.catch(function () {}));
        return kept;
      }
    }

    try {
      return await network;
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
