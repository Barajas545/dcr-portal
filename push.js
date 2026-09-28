/* Phone reminders through the installed portal ("the DCR app").

   The DCR Agents PC reminds the crew about missing timesheets. Its first
   choice is a phone notification: cheaper than a text and it opens the
   timesheet page in one tap. That only works when THIS phone has said yes —
   so this file draws a small "Phone reminders: on/off" switch into an element
   with id "pushSlot" (the home page and the mobile timesheet have one) and
   exposes the same four verbs as DCR.push for anything else that wants them.

   How it works: the service worker (sw.js) is already registered by
   common.js; here the page asks it for a push subscription with the portal's
   public key (?action=push&op=key), then hands that subscription to the
   portal, which keeps it on the person's own account. The PC never sees it.

   iOS only delivers web push to a site that has been added to the Home
   Screen, so in Safari proper the switch says to install first.           */
(function () {
  var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true;
  var ua = navigator.userAgent || "";
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  function supported() {
    return !!(window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
  }

  /* Which phone this is, for the list on the account: nothing personal, just
     enough for an admin to tell "the old phone" from "the new one". */
  function deviceLabel() {
    var m = /iPhone|iPad|Android|Windows|Macintosh|Linux/.exec(ua);
    return ((m && m[0]) || "phone") + (standalone ? " (app)" : " (browser)");
  }

  /* The VAPID key arrives base64url; PushManager wants raw bytes. */
  function keyBytes(b64) {
    var pad = "=".repeat((4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function registration() {
    /* .ready waits for the worker common.js registers on load; a page that
       has no worker yet (first visit, blocked) never resolves, so cap it. */
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise(function (_, rej) { setTimeout(function () { rej(new Error("The app is still setting up — try again in a moment.")); }, 8000); }),
    ]);
  }

  async function current() {
    if (!supported()) return null;
    var reg = await registration();
    return reg.pushManager.getSubscription();
  }

  async function enabled() {
    try { return !!(await current()); } catch (e) { return false; }
  }

  async function enable() {
    if (!supported()) throw new Error("This browser cannot show phone notifications.");
    if (isIOS && !standalone) throw new Error("Add the portal to your Home Screen first (Install app), then turn reminders on from there.");
    var k = await DCR.api("/api/portal?action=push&op=key", { auth: false });
    if (Notification.permission === "denied") throw new Error("Notifications are blocked for the portal in your phone's settings.");
    var perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notifications were not allowed.");
    var reg = await registration();
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(k.publicKey) });
    }
    try {
      await DCR.api("/api/portal?action=push", { method: "POST", body: { op: "subscribe", subscription: sub.toJSON(), device: deviceLabel() } });
    } catch (e) {
      /* The portal did not keep it, so the phone must not think it is on. */
      try { await sub.unsubscribe(); } catch (_) { /* nothing to undo */ }
      throw e;
    }
    return true;
  }

  async function disable() {
    var sub = null;
    try { sub = await current(); } catch (e) { /* no worker: nothing to turn off */ }
    if (!sub) return false;
    var endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch (e) { /* the portal side still comes off */ }
    try {
      await DCR.api("/api/portal?action=push", { method: "POST", body: { op: "unsubscribe", endpoint: endpoint } });
    } catch (e) { /* a dead entry is pruned the next time the PC pushes to it */ }
    return false;
  }

  window.DCR = window.DCR || {};
  DCR.push = { supported: supported, enabled: enabled, enable: enable, disable: disable };

  /* ── the switch ──────────────────────────────────────────────────────── */
  function mount() {
    var slot = document.getElementById("pushSlot");
    if (!slot || !window.DCR || !DCR.api) return;
    if (!supported() && !(isIOS && !standalone)) return;     // an old browser: say nothing

    slot.innerHTML = '<span class="dcr-push" style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;font-size:13px;color:var(--text-muted)">' +
      '<span id="dcrPushText">Phone reminders: <b id="dcrPushState">…</b></span>' +
      '<button type="button" id="dcrPushBtn" class="btn btn-ghost btn-sm" style="display:none"></button>' +
      '<span id="dcrPushNote" style="flex-basis:100%;font-size:12px"></span></span>';
    var state = document.getElementById("dcrPushState");
    var btn = document.getElementById("dcrPushBtn");
    var note = document.getElementById("dcrPushNote");

    function draw(on) {
      state.textContent = on ? "on" : "off";
      state.style.color = on ? "var(--ok, #2fa679)" : "";
      btn.textContent = on ? "Turn off" : "Turn on";
      btn.style.display = "inline-flex";
      btn.disabled = false;
    }

    if (isIOS && !standalone) {
      state.textContent = "off";
      note.textContent = "Add the portal to your Home Screen first (Install app).";
      return;
    }

    enabled().then(draw);
    btn.addEventListener("click", async function () {
      btn.disabled = true;
      note.textContent = "";
      try {
        var on = await enabled();
        var now = on ? await disable() : await enable();
        draw(now);
        note.textContent = now ? "This phone will get a reminder when a timesheet is missing." : "";
      } catch (e) {
        draw(await enabled());
        note.textContent = (e && e.message) || "Could not change phone reminders.";
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
