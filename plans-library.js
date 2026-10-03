/* DCR portal — Plans Library: .takeoff plan files kept on THIS device.

   The owner saves chosen plan files so they open in Professional Takeoff
   Tools with no internet — a site trailer, a house with no roof yet. The
   library is a MIRROR of SharePoint: each saved copy is exactly one version of
   one SharePoint file, the portal says when SharePoint holds a newer one, and
   the owner decides whether to download it. The takeoff tool never writes into
   a saved copy; its Save goes to Save As or a download, as for any file it
   opens from the portal.

   Where things live (per browser profile; the same origin as the takeoff
   tool, which is what lets it open these files with no portal round trip):
     · the files — the Origin Private File System, directory "plans-library",
       one file per saved version: p<owner>-<item id>-<version>.takeoff
     · what is known about them — IndexedDB "dcr-plans-library"
         plans     one record per person per saved file (key "<owner>|<id>")
         projects  code, name, address, thumbnail picture, newer-file hints
         meta      when updates were last checked
     · a small read-only index for the takeoff tool's start screen —
         localStorage "dcr.plansLibrary.v1"

   Records belong to the person who saved them (the token's subject). A shared
   tablet shows each person only their own plans, and a person whose role may
   not open archive plans cannot open somebody else's copy through this page. */
(function () {
  "use strict";

  var DB_NAME = "dcr-plans-library", DB_VER = 1, DIR = "plans-library";
  var INDEX_KEY = "dcr.plansLibrary.v1";
  var WARM_KEY = "dcr.plansLibrary.toolWarmAt";
  var LOCK = "dcr-plans-dl:";
  // The takeoff tool holds this (shared) while it has a saved copy open; such a
  // file is never deleted until it lets go, whatever the library decides.
  var OPEN_LOCK = "dcr-plans-open:";
  var CHECK_EVERY = 6 * 3600 * 1000;           // background update checks
  var THUMB_EVERY = 7 * 24 * 3600 * 1000;      // re-fetch a project picture weekly
  var SPACE_MARGIN = 64 * 1024 * 1024;         // never fill the last bit of the quota
  var MAGIC = "PDFCACHE1";                     // every .takeoff starts with these bytes
  var OFFLINE_ASSETS = ["plans-library.html", "plans-library-page.js", "plans-library.js", "plans-library-worker.js",
    "takeoff-open.js", "common.js", "config.js", "styles.css", "manifest.json", "logo.png", "icon-192.png", "icon-180.png"];

  var channel = null;
  try { channel = new BroadcastChannel("dcr-plans-library"); } catch (e) { channel = null; }
  var listeners = [];
  var jobs = {};          // key -> {worker, done, size, rate, startedAt, startDone}
  var remote = {};        // key -> {done, size, rate, at} progress of a download running in another window

  /* ── small helpers ─────────────────────────────────────────────────────── */
  function err(code, message, extra) {
    var e = new Error(message); e.code = code;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }
  function nowIso() { return new Date().toISOString(); }
  function ms(iso) { var t = Date.parse(iso || ""); return isFinite(t) ? t : 0; }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }
  function fmtWhen(iso) {
    var t = ms(iso); if (!t) return "";
    return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function fmtDay(iso) {
    var t = ms(iso); if (!t) return "";
    return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  function fmtAgo(iso) {
    var t = ms(iso); if (!t) return "";
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    var d = Math.round(s / 86400);
    return d + " day" + (d === 1 ? "" : "s") + " ago";
  }
  function safe(v, max) { return String(v == null ? "" : v).replace(/[^A-Za-z0-9]/g, "_").slice(0, max || 60) || "x"; }
  function timeout(p, ms_) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(err("timeout", "The portal took too long to answer.")); }, ms_);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  /* Who is signed in on this device, read from the session token itself.
     Not a verification — the server does that on every request — but it is
     what lets the library work offline, where nothing can be asked. */
  function claims() {
    var t = "";
    try { t = (window.DCR && DCR.getToken()) || localStorage.getItem("dcr_portal_token") || ""; } catch (e) { return null; }
    var parts = t.split(".");
    if (parts.length < 2) return null;
    try {
      var b = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b.length % 4) b += "=";
      var bin = atob(b), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) { return null; }
  }
  function owner() {
    var c = claims();
    return c ? String(c.sub || c.email || "") : "";
  }
  function keyOf(id, who) { return (who == null ? owner() : who) + "|" + id; }

  /* Two checks. supported() is what the page itself can see: private file
     storage, a database, workers. canWrite() asks the download worker whether
     it has the synchronous file handle the downloads are written with — that
     handle exists only inside workers, so the page cannot see it on its own
     window. The answer is kept for the rest of the visit. */
  function supported() {
    try {
      return !!(window.isSecureContext && navigator.storage && navigator.storage.getDirectory &&
        window.indexedDB && window.Worker && window.FileSystemFileHandle);
    } catch (e) { return false; }
  }
  var writeProbe = null;
  function canWrite() {
    if (!supported()) return Promise.resolve(false);
    if (writeProbe) return writeProbe;
    var definite = false;
    var probe = writeProbe = new Promise(function (resolve) {
      var w, done = false;
      function finish(ok, sure) {
        if (done) return;
        done = true; definite = !!sure;
        try { w && w.terminate(); } catch (e) { /* gone */ }
        resolve(!!ok);
      }
      try {
        w = new Worker(new URL("plans-library-worker.js", scriptBase).href);
        w.onmessage = function (ev) { finish(ev.data && ev.data.type === "probe" && ev.data.ok, true); };
        w.onerror = function () { finish(false, true); };
        w.postMessage({ op: "probe" });
        // A slow connection fetching the worker is not a "no": forget that
        // answer so the next save asks again.
        setTimeout(function () { finish(false, false); }, 8000);
      } catch (e) { finish(false, true); }
    });
    probe.then(function () { if (!definite && writeProbe === probe) writeProbe = null; });
    return probe;
  }

  /* ── IndexedDB ─────────────────────────────────────────────────────────── */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains("plans")) d.createObjectStore("plans", { keyPath: "key" });
        if (!d.objectStoreNames.contains("projects")) d.createObjectStore("projects", { keyPath: "key" });
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "k" });
      };
      r.onsuccess = function () {
        var d = r.result;
        d.onversionchange = function () { try { d.close(); } catch (e) { /* closed */ } dbp = null; };
        resolve(d);
      };
      r.onerror = function () { dbp = null; reject(r.error || err("db", "This browser would not open its storage.")); };
      r.onblocked = function () { /* another tab is upgrading; it will finish */ };
    });
    return dbp;
  }
  function req(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(store, mode), out;
        var r = fn(tx.objectStore(store));
        if (r) r.onsuccess = function () { out = r.result; };
        tx.oncomplete = function () { resolve(out); };
        tx.onerror = tx.onabort = function () { reject(tx.error || err("db", "Saving to this device's storage failed.")); };
      });
    });
  }
  function getAll(store) { return req(store, "readonly", function (s) { return s.getAll(); }).then(function (v) { return v || []; }); }
  function get(store, key) { return req(store, "readonly", function (s) { return s.get(key); }); }
  function put(store, value) { return req(store, "readwrite", function (s) { return s.put(value); }); }
  function del(store, key) { return req(store, "readwrite", function (s) { return s.delete(key); }); }

  /* ── the files ─────────────────────────────────────────────────────────── */
  function dir() {
    return navigator.storage.getDirectory().then(function (root) { return root.getDirectoryHandle(DIR, { create: true }); });
  }
  function removeFile(name) {
    if (!name) return Promise.resolve();
    return dir().then(function (d) { return d.removeEntry(name); }).catch(function () { /* already gone */ });
  }
  /* Is a saved copy really on the device, whole? A browser that was not told
     to keep the files (persist) may clear them when space runs low, and the
     records would then promise copies that are not there. */
  async function fileOk(name, size) {
    if (!name) return false;
    try {
      var f = await (await dir()).getFileHandle(name).then(function (h) { return h.getFile(); });
      return !size || f.size === Number(size);
    } catch (e) { return false; }
  }
  var MISSING = "This saved copy is no longer on this device (the browser cleared it). Press Try again to download it again.";
  /* Every saved copy checked against the device. One that is gone becomes a
     stopped download with the reason, so the row offers Try again and the
     takeoff tool stops listing it, instead of a "ready" copy that will not open. */
  async function verifyFiles() {
    var who = owner(), lost = 0;
    if (!who) return 0;
    var mine = (await getAll("plans")).filter(function (e) { return e.owner === who && e.file; });
    for (var i = 0; i < mine.length; i++) {
      if (await fileOk(mine[i].file, mine[i].size)) continue;
      var cur = await get("plans", mine[i].key);
      if (!cur || !cur.file || cur.file !== mine[i].file) continue;
      cur.file = "";
      if (!cur.dl) cur.dl = { file: "", done: 0, size: 0, state: "error", userPaused: false, error: MISSING };
      await put("plans", cur);
      lost++;
    }
    if (lost) changed("*");
    return lost;
  }

  function fileName(e, ver) {
    var tag = (ms(ver.modifiedTime) || Date.now()).toString(36);
    return "p" + safe(e.owner, 24) + "-" + safe(e.id, 80) + "-" + tag + ".takeoff";
  }
  function sameVersion(a, b) {
    if (!a || !b) return false;
    if (a.cTag && b.cTag) return a.cTag === b.cTag;
    return Number(a.size) === Number(b.size) && ms(a.modifiedTime) === ms(b.modifiedTime);
  }
  function outdated(e) {
    return !!(e && e.file && e.latest && e.latest.status === "ok" && !sameVersion(e, e.latest));
  }

  /* ── change notices ────────────────────────────────────────────────────── */
  function emit(msg) {
    listeners.slice().forEach(function (fn) { try { fn(msg); } catch (e) { /* a listener's own problem */ } });
  }
  // Listeners hear about a change only once the index says it too, so a badge
  // drawn from the index on that notice is never one step behind.
  function changed(key) {
    return writeIndex().then(function () {
      emit({ t: "changed", key: key || "*" });
      if (channel) try { channel.postMessage({ t: "changed", key: key || "*" }); } catch (e) { /* closed */ }
    });
  }
  var lastBroadcast = {};
  function progress(key) {
    var j = jobs[key]; if (!j) return;
    emit({ t: "progress", key: key, done: j.done, size: j.size, rate: j.rate });
    var now = Date.now();
    if (channel && now - (lastBroadcast[key] || 0) > 500) {
      lastBroadcast[key] = now;
      try { channel.postMessage({ t: "progress", key: key, done: j.done, size: j.size, rate: j.rate }); } catch (e) { /* closed */ }
    }
  }
  if (channel) {
    channel.onmessage = function (ev) {
      var m = ev.data || {};
      if (m.t === "progress") { remote[m.key] = { done: m.done, size: m.size, rate: m.rate, at: Date.now() }; emit(m); }
      else if (m.t === "changed") { if (m.key && m.key !== "*") delete remote[m.key]; emit(m); }
      else if (m.t === "pause" && jobs[m.key]) pause(m.key, true);
    };
  }

  /* The takeoff tool's start screen lists saved plans from this, so it must
     never be wrong for long: rewritten after every change. Every person's
     entries are here; the tool shows only the signed-in person's. */
  function writeIndex() {
    return getAll("plans").then(function (all) {
      var entries = all.map(function (e) {
        return {
          id: e.id, owner: e.owner, file: e.file || "", name: e.name, size: e.size || 0,
          lastModified: ms(e.modifiedTime), savedAt: e.savedAt || "", projectCode: e.projectCode || "",
          projectTitle: e.projectTitle || "", folder: e.folder || "",
          // "denied": the account may no longer open it; the tool lists only "ready".
          status: !e.file ? "downloading" : (e.latest && e.latest.status === "denied" ? "denied" : "ready"),
          updateAvailable: outdated(e),
        };
      });
      try { localStorage.setItem(INDEX_KEY, JSON.stringify({ v: 1, entries: entries })); } catch (e) { /* full or blocked */ }
    }).catch(function () { /* storage blocked: nothing to index */ });
  }

  /* ── reading the library ───────────────────────────────────────────────── */
  function filesInUse() {
    if (!navigator.locks || !navigator.locks.query) return Promise.resolve({});
    return navigator.locks.query().then(function (s) {
      var out = {};
      (s.held || []).concat(s.pending || []).forEach(function (l) {
        if (l.name && l.name.indexOf(OPEN_LOCK) === 0) out[l.name.slice(OPEN_LOCK.length)] = true;
      });
      return out;
    }).catch(function () { return {}; });
  }
  async function openInTool(id) {
    var e = await get("plans", keyOf(id));
    return !!(e && e.file && (await filesInUse())[e.file]);
  }

  function heldLocks() {
    if (!navigator.locks || !navigator.locks.query) return Promise.resolve(null);
    return navigator.locks.query().then(function (s) {
      var held = {};
      (s.held || []).forEach(function (l) { if (l.name && l.name.indexOf(LOCK) === 0) held[l.name.slice(LOCK.length)] = true; });
      return held;
    }).catch(function () { return null; });
  }

  /* Each record with what it amounts to now:
       status  "downloading" | "paused" | "failed" | "ready" | "outdated" | "gone" | "denied"
       live    {done, size, rate} while a download runs here or in another window */
  function describe(e, held) {
    var live = jobs[e.key] ? { done: jobs[e.key].done, size: jobs[e.key].size, rate: jobs[e.key].rate } : null;
    if (!live && remote[e.key] && Date.now() - remote[e.key].at < 5000) live = remote[e.key];
    if (!live && held && held[e.key] && e.dl) live = { done: e.dl.done || 0, size: e.dl.size || 0, rate: 0 };
    var status;
    if (live) status = "downloading";
    else if (e.dl && e.dl.state === "error") status = "failed";
    else if (e.dl) status = "paused";
    else if (!e.file) status = "failed";            // nothing on this device: a save that never got going
    else if (e.latest && e.latest.status === "denied") status = "denied";
    else if (e.latest && e.latest.status === "gone") status = "gone";
    else if (outdated(e)) status = "outdated";
    else status = "ready";
    var out = Object.assign({}, e, { status: status, live: live, hasFile: !!e.file, outdated: outdated(e) });
    return out;
  }

  async function list() {
    var who = owner();
    if (!who) return [];
    var all = (await getAll("plans")).filter(function (e) { return e.owner === who; });
    var held = await heldLocks();
    return all.map(function (e) { return describe(e, held); }).sort(function (a, b) {
      return String(a.projectCode || "").localeCompare(String(b.projectCode || ""), undefined, { numeric: true }) ||
        String(a.folder || "").localeCompare(String(b.folder || "")) ||
        ms(b.modifiedTime) - ms(a.modifiedTime) || String(a.name).localeCompare(String(b.name));
    });
  }
  async function entry(id) {
    var e = await get("plans", keyOf(id));
    if (!e) return null;
    return describe(e, await heldLocks());
  }
  async function projects() {
    var who = owner(), out = {};
    (await getAll("projects")).forEach(function (p) { if (p.owner === who) out[p.projectId] = p; });
    return out;
  }

  /* ── room on the device ────────────────────────────────────────────────── */
  async function estimate() {
    try { return navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) { return null; }
  }
  var persistAsked = false;
  async function askPersist() {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    try { if (!(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (e) { /* best effort */ }
  }
  // Asked by a button on the library page: a press is the moment some browsers want.
  async function protect() {
    try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; }
    catch (e) { return false; }
  }
  async function usage() {
    var est = await estimate();
    var persisted = false;
    try { persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) { /* unknown */ }
    var mine = 0, n = 0;
    (await list()).forEach(function (e) {
      if (e.file) { mine += Number(e.size) || 0; n++; }
      if (e.dl) mine += Number(e.dl.done) || 0;
    });
    return {
      libraryBytes: mine, plans: n, persisted: persisted,
      quota: est && est.quota || 0, used: est && est.usage || 0,
      free: est && est.quota ? Math.max(0, est.quota - est.usage) : 0,
    };
  }

  /* ── project details and the thumbnail picture ─────────────────────────── */
  async function noteProject(info) {
    var who = owner();
    if (!who || !info.projectId) return;
    var key = who + "|" + info.projectId;
    var p = (await get("projects", key)) || { key: key, owner: who, projectId: String(info.projectId), thumb: null, thumbAt: "" };
    p.code = info.projectCode || p.code || "";
    p.title = info.projectTitle || p.title || "";
    p.sub = info.projectSub || p.sub || "";
    await put("projects", p);
  }
  async function refreshThumb(projectId, force) {
    var who = owner();
    if (!who || !projectId || !navigator.onLine) return;
    var key = who + "|" + projectId;
    var p = await get("projects", key);
    if (!p) return;
    if (!force && p.thumbAt && Date.now() - ms(p.thumbAt) < THUMB_EVERY) return;
    try {
      var res = await fetch(DCR.API_BASE + "/api/portal?action=thumb&projectId=" + encodeURIComponent(projectId), {
        headers: { Authorization: "Bearer " + DCR.getToken() },
      });
      var pic;
      if (res.ok) {
        var blob = await res.blob();
        // Only a real picture counts; anything else is tried again next time.
        if (!(/^image\//.test(blob.type) && blob.size > 0 && blob.size < 12 * 1024 * 1024)) return;
        pic = await shrink(blob);
      } else if (res.status === 404) {
        pic = null;                              // that project has no picture
      } else {
        return;                                  // try again another time
      }
      // The picture onto the project record as it is now (its last plan may
      // have been removed while the picture was on its way).
      var cur = await get("projects", key);
      if (!cur) return;
      cur.thumb = pic;
      cur.thumbAt = nowIso();
      await put("projects", cur);
      changed("project:" + projectId);
    } catch (e) { /* offline or blocked: keep the picture already saved */ }
  }

  /* Project pictures are often full photos (4–5 MB). The library shows them
     at 84 px, so a copy about 480 px wide is kept instead — tens of KB, not
     megabytes, on a device that may be short of room. The original is kept
     only when the browser cannot make the smaller one. */
  async function shrink(blob) {
    if (blob.size < 200 * 1024 || !window.createImageBitmap) return blob;
    try {
      var bmp = await createImageBitmap(blob);
      var scale = Math.min(1, 480 / Math.max(1, bmp.width));
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      var small = await new Promise(function (r) { c.toBlob(r, "image/jpeg", 0.82); });
      return small && small.size && small.size < blob.size ? small : blob;
    } catch (e) { return blob; }
  }

  /* ── saving, updating, resuming ────────────────────────────────────────── */
  /* info: {id, name, size, modifiedTime, source ("archive"|"project"),
            projectId, projectCode, projectTitle, projectSub, folder} */
  async function save(info) {
    if (!(await canWrite())) throw err("unsupported", UNSUPPORTED);
    var who = owner();
    if (!who) throw err("signin", "Sign in first.");
    if (!info || !info.id) throw err("bad", "No file to save.");
    var key = keyOf(info.id, who);
    var e = await get("plans", key);
    if (!e) {
      e = {
        key: key, id: String(info.id), owner: who, name: info.name || "plan.takeoff",
        source: info.source === "project" ? "project" : "archive",
        projectId: info.projectId ? String(info.projectId) : "", projectCode: info.projectCode || "",
        projectTitle: info.projectTitle || "", projectSub: info.projectSub || "", folder: info.folder || "",
        file: "", size: 0, modifiedTime: null, cTag: null, eTag: null,
        savedAt: "", openedAt: "", dl: null, latest: null,
      };
      await put("plans", e);
    } else {
      // Newer details from wherever it was saved again; the version is the download's to set.
      ["projectCode", "projectTitle", "projectSub", "folder"].forEach(function (k) { if (info[k]) e[k] = info[k]; });
      await put("plans", e);
    }
    await noteProject(info);
    changed(key);
    return download(key);
  }
  function update(id) { return download(keyOf(id)); }
  function resume(id) { return download(keyOf(id)); }

  var UNSUPPORTED = "This browser cannot keep plan files on the device. Use Chrome or Edge on a computer or Android phone, or Safari 16.4 or newer on an iPhone or iPad.";

  function download(key) {
    if (jobs[key] && jobs[key].promise) return jobs[key].promise;
    var job = jobs[key] = jobs[key] || { done: 0, size: 0, rate: 0 };
    job.cancelRequested = false;
    var p = (async function () {
      try {
        if (!navigator.onLine) throw err("offline", "You're offline. Downloads need the internet; your saved copies still open.");
        if (!(await canWrite())) throw err("unsupported", UNSUPPORTED);
        if (navigator.locks && navigator.locks.request) {
          return await navigator.locks.request(LOCK + key, { ifAvailable: true }, function (lock) {
            if (!lock) throw err("busy", "This plan is already downloading in another portal window.");
            return run(key);
          });
        }
        return await run(key);
      } catch (x) {
        await noteFailure(key, x);
        throw x;
      }
    })();
    job.promise = p;
    p.then(cleanup, cleanup);
    function cleanup() { if (jobs[key] && jobs[key].promise === p) delete jobs[key]; changed(key); }
    return p;
  }

  /* A save that fails before a single byte arrives (offline, no room, no
     access, no link) must not leave a record that reads as saved: it is
     marked as stopped, with the reason, so the row offers Try again. A copy
     already on the device keeps opening; only its update failed. */
  async function noteFailure(key, x) {
    var code = x && x.code;
    if (code === "busy" || code === "paused" || code === "removed") return;
    try {
      var e = await get("plans", key);
      if (!e) return;
      if (code === "denied") e.latest = { status: "denied", checkedAt: nowIso() };
      if (!e.file && !e.dl) {
        e.dl = { file: "", done: 0, size: 0, state: "error", userPaused: false,
          error: (x && x.message) || "The download did not start." };
      }
      await put("plans", e);
    } catch (e2) { /* the message has already reached the person */ }
  }

  async function fileInfo(id) {
    var info = await DCR.api("/api/portal?action=drive&fileInfo=" + encodeURIComponent(id));
    if (!info || !info.downloadUrl) throw err("nolink", "SharePoint gave no download link for this file.");
    if (!/\.takeoff$/i.test(info.name || "")) throw err("bad", "That file is not a .takeoff plan file.");
    return info;
  }
  function versionOf(info) {
    return { name: info.name, size: Number(info.size) || 0, modifiedTime: info.modifiedTime || null,
      cTag: info.cTag || null, eTag: info.eTag || null };
  }
  /* The version SharePoint holds now, from the version check — or, when that
     cannot be had, from the file's own info. null only when neither answers. */
  async function versionNow(id) {
    try {
      var d = await DCR.api("/api/portal?action=drive&takeoffVersions=" + encodeURIComponent(id));
      var a = d && d.items && d.items[0];
      if (a && a.status !== "error") return a;
    } catch (e) { /* fall through to the file's own info */ }
    try {
      return Object.assign({ status: "ok" }, versionOf(await fileInfo(id)));
    } catch (e) {
      return e && e.status === 404 ? { status: "gone" } : e && e.status === 403 ? { status: "denied" } : null;
    }
  }

  async function run(key) {
    for (var attempt = 0; attempt < 2; attempt++) {
      var job = jobs[key] || {};
      var e = await get("plans", key);
      if (!e) throw err("removed", "That saved plan was removed.");
      var info;
      try {
        info = await fileInfo(e.id);
      } catch (x) {
        if (x && x.status === 404) {
          var g = await get("plans", key);
          if (!g) throw err("removed", "That saved plan was removed.");
          g.latest = { status: "gone", checkedAt: nowIso() };
          if (g.dl && g.dl.file) await removeFile(g.dl.file);
          g.dl = g.file ? null : { file: "", done: 0, size: 0, state: "error", error: "This file is no longer in SharePoint." };
          await put("plans", g);
          throw err("gone", "This file is no longer in SharePoint.");
        }
        if (x && x.status === 403) throw err("denied", x.message || "Your account cannot open this plan file.");
        throw x;
      }
      // Asking for the link took a moment; work on the record as it is now (a
      // check may have written to it, another window may have removed it).
      e = await get("plans", key);
      if (!e) throw err("removed", "That saved plan was removed.");
      var ver = versionOf(info);
      if (e.file && sameVersion(e, ver) && (await fileOk(e.file, e.size))) {
        // Already the version SharePoint holds, and really on the device: nothing to fetch.
        e.latest = Object.assign({ status: "ok", checkedAt: nowIso() }, ver);
        if (e.dl && e.dl.file) await removeFile(e.dl.file);
        e.dl = null;
        await put("plans", e);
        return { already: true };
      }
      var dl = e.dl && e.dl.file && sameVersion(e.dl, ver) && e.dl.file !== e.file ? e.dl : null;
      if (!dl) {
        if (e.dl && e.dl.file && e.dl.file !== e.file) await removeFile(e.dl.file);   // part of an older version
        // Never the saved copy's own file: it keeps opening until the new one is whole.
        var fname = fileName(e, ver);
        if (fname === e.file) fname = fname.replace(/\.takeoff$/, "-" + Date.now().toString(36) + ".takeoff");
        dl = Object.assign({ file: fname, done: 0, startedAt: nowIso() }, ver);
      }
      var est = await estimate();
      var need = ver.size - (Number(dl.done) || 0);
      if (est && est.quota && need > est.quota - est.usage - SPACE_MARGIN) {
        throw err("space", "Not enough room on this device: this file needs " + fmtSize(need) + " and about " +
          fmtSize(Math.max(0, est.quota - est.usage - SPACE_MARGIN)) + " is free for the portal. Remove a saved plan or free up space, then try again.");
      }
      await askPersist();
      // A permission prompt can sit there for a while: the record as it is now.
      var fresh = await get("plans", key);
      if (!fresh) throw err("removed", "That saved plan was removed.");
      e = fresh;
      if (job.cancelRequested) {
        // Pause pressed before the download really started: nothing is fetched.
        dl.state = "paused"; dl.error = ""; dl.userPaused = true;
        e.dl = dl;
        await put("plans", e);
        return { paused: true };
      }
      dl.state = "running"; dl.error = ""; dl.userPaused = false;
      e.dl = dl;
      await put("plans", e);
      changed(key);

      var r;
      try {
        r = await runWorker(e, dl, info.downloadUrl);
      } catch (x) {
        var cur = await get("plans", key);
        if (!cur) { await removeFile(dl.file); throw err("removed", "That saved plan was removed."); }
        e = cur;
        if (!e.dl) e.dl = dl;
        e.dl.done = x.done != null ? x.done : e.dl.done;
        if (x.status === 404) {
          await removeFile(e.dl.file);
          e.latest = { status: "gone", checkedAt: nowIso() };
          e.dl = e.file ? null : { file: "", done: 0, size: 0, state: "error", error: "This file is no longer in SharePoint." };
          await put("plans", e);
          throw err("gone", "This file is no longer in SharePoint.");
        }
        if ((x.status === 416 || x.changed) && attempt === 0) {
          // The file changed in SharePoint mid-download: start again, once.
          await removeFile(e.dl.file); e.dl = null;
          await put("plans", e);
          continue;
        }
        // A dropped connection or a SharePoint hiccup is a pause that resumes
        // on its own; running out of room, or anything else, is a stop with its
        // reason. Either way Resume asks for a fresh link.
        var retryable = x.status !== 507 && (!navigator.onLine || !x.status || x.status >= 500 ||
          /connection|stalled|stopped responding/i.test(x.message || ""));
        e.dl.state = retryable ? "paused" : "error";
        e.dl.error = x.message || "The download stopped.";
        await put("plans", e);
        throw err(retryable ? "paused" : "failed", e.dl.error);
      }
      // Removed from another window while this one was downloading: what was
      // written here goes too, and the record is not brought back.
      var now1 = await get("plans", key);
      if (!now1) { await removeFile(dl.file); return { removed: true }; }
      e = now1;
      if (r.paused) {
        // Paused by the owner: it stays paused until they press Resume (the
        // library resumes on its own only what a closed window or a dropped
        // connection interrupted).
        if (e.dl) {
          e.dl.state = "paused"; e.dl.done = r.done; e.dl.error = "";
          e.dl.userPaused = true;
          await put("plans", e);
        }
        return { paused: true };
      }
      if (r.magic !== MAGIC) {
        await removeFile(dl.file);
        e.dl = Object.assign({}, dl, { state: "error", done: 0, error: "What downloaded is not a takeoff project file." });
        await put("plans", e);
        throw err("failed", e.dl.error);
      }
      var after = await versionNow(e.id);
      var now2 = await get("plans", key);
      if (!now2) { await removeFile(dl.file); return { removed: true }; }
      e = now2;
      if (after && after.status === "ok" && !sameVersion(after, ver)) {
        await removeFile(dl.file); e.dl = null;
        await put("plans", e);
        if (attempt === 0) continue;
        throw err("changed", "The file changed in SharePoint while it was downloading. Try again in a minute.");
      }
      var old = e.file;
      e.file = dl.file;
      e.name = ver.name || e.name;
      e.size = ver.size; e.modifiedTime = ver.modifiedTime; e.cTag = ver.cTag; e.eTag = ver.eTag;
      e.savedAt = nowIso();
      e.dl = null;
      // What SharePoint said just now: normally the version just saved; a file
      // deleted or closed to this account meanwhile is recorded as such.
      e.latest = after && (after.status === "gone" || after.status === "denied")
        ? { status: after.status, checkedAt: nowIso() }
        : Object.assign({ status: "ok", checkedAt: nowIso() }, ver);
      await put("plans", e);
      // The old version goes now, unless the takeoff tool has it open; then
      // it goes on the first library visit after the tool lets go of it.
      if (old && old !== e.file) {
        if ((await filesInUse())[old]) trash.push(old); else await removeFile(old);
      }
      changed(key);
      refreshThumb(e.projectId, false);
      warmOffline();
      return { saved: true };
    }
    throw err("changed", "The file kept changing in SharePoint while it was downloading. Try again in a minute.");
  }
  var trash = [];

  function runWorker(e, dl, url) {
    return new Promise(function (resolve, reject) {
      var key = e.key;
      var w = new Worker(new URL("plans-library-worker.js", scriptBase).href);
      var j = jobs[key] = Object.assign(jobs[key] || {}, { worker: w, done: dl.done || 0, size: dl.size, rate: 0,
        startedAt: Date.now(), startDone: dl.done || 0, changed: false, finished: false });
      var lastSave = 0, lastT = Date.now(), lastD = j.done, lastMsg = Date.now();
      /* A worker that goes silent (it posts at least every few seconds, even
         while it waits on SharePoint) is ended and the download treated as a
         pause: the bytes written stay, and Resume carries on from there. */
      var dog = setInterval(function () {
        if (j.finished || Date.now() - lastMsg < 90000) return;
        end();
        var x = new Error("The download stopped responding."); x.status = 0; x.done = j.done;
        reject(x);
      }, 10000);
      function end() { j.finished = true; clearInterval(dog); try { w.terminate(); } catch (x) { /* gone */ } }
      w.onmessage = async function (ev) {
        var m = ev.data || {};
        lastMsg = Date.now();
        if (j.finished) return;
        if (m.type === "progress") {
          var now = Date.now();
          if (now - lastT >= 1000) { j.rate = Math.max(0, (m.done - lastD) / ((now - lastT) / 1000)); lastT = now; lastD = m.done; }
          j.done = m.done;
          if (now - lastSave > 2000) {
            lastSave = now;
            get("plans", key).then(function (cur) {
              // Not once the download has ended: run() writes the final record
              // then, and this older snapshot must never land on top of it.
              if (j.finished) return;
              if (cur && cur.dl && cur.dl.file === dl.file) { cur.dl.done = m.done; return put("plans", cur); }
            }).catch(function () {});
          }
          progress(key);
        } else if (m.type === "need-url") {
          try {
            var i2 = await fileInfo(e.id);
            if (!sameVersion(versionOf(i2), dl)) { j.changed = true; w.postMessage({ op: "url", url: "" }); }
            else w.postMessage({ op: "url", url: i2.downloadUrl });
          } catch (x) { w.postMessage({ op: "url", url: "" }); }
        } else if (m.type === "done") {
          end(); j.done = m.size; resolve({ done: true, size: m.size, magic: m.magic });
        } else if (m.type === "cancelled") {
          end(); j.done = m.done; resolve({ paused: true, done: m.done });
        } else if (m.type === "error") {
          end();
          var x = new Error(m.message); x.status = m.status; x.done = m.done; x.changed = j.changed;
          reject(x);
        }
      };
      w.onerror = function (ev) {
        if (j.finished) return;
        end();
        var x = new Error("The download stopped (" + ((ev && ev.message) || "the worker failed") + ")."); x.done = j.done;
        reject(x);
      };
      w.postMessage({ op: "start", id: key, file: dl.file, url: url, size: dl.size, from: dl.done || 0 });
    });
  }

  /* Pause: the bytes written so far stay, and Resume carries on from there.
     Pressed before the download really starts, it is remembered and nothing
     is fetched. A download running in another window is asked to pause. */
  function pause(id, isKey) {
    var key = isKey ? id : keyOf(id);
    var j = jobs[key];
    if (j) {
      j.cancelRequested = true;
      if (j.worker && !j.finished) j.worker.postMessage({ op: "cancel", id: key });
      return true;
    }
    if (channel) try { channel.postMessage({ t: "pause", key: key }); } catch (e) { /* closed */ }
    return false;
  }

  // Until the window downloading this plan has let go of it (or a while has passed).
  function downloadReleased(key, ms) {
    if (!navigator.locks || !navigator.locks.request) return Promise.resolve();
    return new Promise(function (resolve) {
      var t = setTimeout(resolve, ms);
      navigator.locks.request(LOCK + key, function () { clearTimeout(t); resolve(); })
        .catch(function () { clearTimeout(t); resolve(); });
    });
  }

  async function remove(id) {
    var key = keyOf(id);
    pause(key, true);                              // here, or the window that is downloading it
    if (jobs[key] && jobs[key].promise) {
      try { await jobs[key].promise; } catch (e) { /* it stopped; that is all we wanted */ }
    }
    await downloadReleased(key, 15000);
    var e = await get("plans", key);
    if (!e) return;
    // Open in the takeoff tool right now: the record goes, the file stays until
    // the tool closes it (the next sweep takes it then), so unread sheets and
    // a Save in progress there do not fail underneath the estimator.
    if (e.file && !(await filesInUse())[e.file]) await removeFile(e.file);
    if (e.dl && e.dl.file) await removeFile(e.dl.file);
    await del("plans", key);
    var still = (await getAll("plans")).some(function (x) { return x.owner === e.owner && x.projectId === e.projectId; });
    if (!still && e.projectId) await del("projects", e.owner + "|" + e.projectId);
    changed(key);
  }

  /* Files nobody points at any more: an old version after an update, a part
     left by a closed window, a copy whose record was removed elsewhere. Swept
     when the library page opens, a moment when the takeoff tool is unlikely
     to be reading one of them. */
  async function sweep() {
    var keep = {};
    (await getAll("plans")).forEach(function (e) { if (e.file) keep[e.file] = true; if (e.dl && e.dl.file) keep[e.dl.file] = true; });
    var held = await heldLocks();
    if (held && Object.keys(held).length) return;   // a download elsewhere may be creating its file right now
    var names = [];
    try {
      var d = await dir();
      for await (var name of d.keys()) names.push(name);
    } catch (e) {
      names = trash.slice();                       // no directory listing here: at least the known leftovers
    }
    var inUse = await filesInUse();                // open in the takeoff tool: not now
    await Promise.all(names.filter(function (n) { return !keep[n] && !inUse[n]; }).map(removeFile));
    trash = trash.filter(function (n) { return inUse[n]; });
  }

  /* ── keeping the library current ───────────────────────────────────────── */
  /* Asks SharePoint for the current version of every saved file in one go.
     With hints, also looks in each archive project's folder for a NEWER plan
     file saved under a different name (outside Backups, which holds the older
     copies), so a new plan set does not go unnoticed. The owner decides. */
  async function checkUpdates(opts) {
    opts = opts || {};
    var who = owner();
    if (!who) return { checked: 0 };
    if (!navigator.onLine) throw err("offline", "You're offline — updates are checked when you're back online.");
    var mine = (await getAll("plans")).filter(function (e) { return e.owner === who; });
    var ids = mine.map(function (e) { return e.id; });
    var answers = {}, unsupported = false;
    for (var i = 0; i < ids.length; i += 60) {
      try {
        var d = await DCR.api("/api/portal?action=drive&takeoffVersions=" + encodeURIComponent(ids.slice(i, i + 60).join(",")));
        ((d && d.items) || []).forEach(function (a) { answers[a.id] = a; });
      } catch (x) {
        if (x && (x.status === 400 || x.status === 404)) { unsupported = true; break; }
        throw x;
      }
    }
    var at = nowIso(), sum = { checked: 0, updates: 0, gone: 0, denied: 0, errors: 0, unsupported: unsupported };
    for (var k = 0; k < mine.length; k++) {
      var e = mine[k], a = answers[e.id];
      if (!a) continue;
      if (a.status === "error") { sum.errors++; continue; }   // keep what we knew
      // Only the answer is written, onto the record as it is now: a download
      // that finished while SharePoint was being asked must not be undone by
      // the snapshot read before the question.
      var cur = await get("plans", e.key);
      if (!cur) continue;
      cur.latest = { status: a.status, name: a.name || "", size: Number(a.size) || 0, modifiedTime: a.modifiedTime || null,
        cTag: a.cTag || null, eTag: a.eTag || null, checkedAt: at };
      await put("plans", cur);
      e = cur;
      sum.checked++;
      if (a.status === "gone") sum.gone++;
      else if (a.status === "denied") sum.denied++;
      else if (outdated(e)) sum.updates++;
    }
    if (!unsupported) await put("meta", { k: "lastCheck|" + who, at: at });
    if (opts.hints) await newerHints(mine);
    if (opts.thumbs !== false) {
      var pids = {};
      mine.forEach(function (e) { if (e.projectId) pids[e.projectId] = true; });
      Object.keys(pids).forEach(function (pid) { refreshThumb(pid, false); });
    }
    changed("*");
    return sum;
  }

  async function newerHints(mine) {
    var who = owner(), byProject = {};
    mine.forEach(function (e) {
      if (e.source !== "archive" || !e.projectId) return;
      (byProject[e.projectId] = byProject[e.projectId] || []).push(e);
    });
    var savedIds = {};
    mine.forEach(function (e) { savedIds[e.id] = true; });
    for (var pid in byProject) {
      try {
        var d = await DCR.api("/api/portal?action=drive&takeoffsFor=" + encodeURIComponent(pid));
        var newest = Math.max.apply(null, byProject[pid].map(function (e) { return ms(e.modifiedTime); }).concat([0]));
        var found = [];
        (function walk(node, path) {
          (node.files || []).forEach(function (f) {
            if (!savedIds[f.id] && ms(f.modifiedTime) > newest) found.push({ id: f.id, name: f.name, size: f.size, modifiedTime: f.modifiedTime, folder: path });
          });
          (node.folders || []).forEach(function (sub) {
            // Backups and archived plans are older copies by what they are called, whatever their dates say.
            if (/^(backups?|archived?|archives|old|superseded)$/i.test(String(sub.name || "").trim())) return;
            walk(sub, path ? path + " / " + sub.name : sub.name);
          });
        })((d && d.tree) || {}, "");
        found.sort(function (a, b) { return ms(b.modifiedTime) - ms(a.modifiedTime); });
        var p = await get("projects", who + "|" + pid);
        if (p) { p.newer = found.slice(0, 3); p.newerAt = nowIso(); await put("projects", p); }
      } catch (x) { /* hints are a nicety; a refusal or a hiccup leaves them as they were */ }
    }
  }

  /* The background check the dashboard and search pages run: at most every
     few hours, silently, only when there is something saved to check. */
  async function maybeCheck() {
    try {
      if (!supported() || !navigator.onLine) return null;
      var who = owner();
      if (!who) return null;
      var mine = (await getAll("plans")).filter(function (e) { return e.owner === who; });
      if (!mine.length) return null;
      var last = await get("meta", "lastCheck|" + who);
      if (last && Date.now() - ms(last.at) < CHECK_EVERY) return null;
      return await checkUpdates({ hints: false, thumbs: false });
    } catch (e) { return null; }
  }
  async function lastChecked() {
    var who = owner();
    var m = who ? await get("meta", "lastCheck|" + who) : null;
    return m ? m.at : "";
  }

  /* Counts for a badge, straight from the index (no database open needed). */
  function counts() {
    var who = owner(), out = { saved: 0, updates: 0 };
    try {
      var idx = JSON.parse(localStorage.getItem(INDEX_KEY) || "null");
      ((idx && idx.entries) || []).forEach(function (x) {
        if (x.owner !== who) return;
        if (x.status === "ready") out.saved++;
        if (x.updateAvailable) out.updates++;
      });
    } catch (e) { /* no index yet */ }
    return out;
  }

  /* ── opening ───────────────────────────────────────────────────────────── */
  async function open(id) {
    var e = await entry(id);
    if (!e || !e.file) throw err("missing", "That plan has not finished downloading to this device.");
    if (e.latest && e.latest.status === "denied") throw err("denied", "Your account can no longer open this plan file.");
    if (!(await fileOk(e.file, e.size))) { await verifyFiles(); throw err("missing", MISSING); }
    var cur = await get("plans", e.key);
    if (cur) { cur.openedAt = nowIso(); await put("plans", cur); }
    window.DCRTakeoff.openSaved({
      id: e.id, owner: e.owner, file: e.file, name: e.name, size: e.size,
      lastModified: ms(e.modifiedTime), updateAvailable: e.outdated,
    });
  }

  /* ── working offline ───────────────────────────────────────────────────── */
  /* Two things must already be on the device before the internet goes away:
     this page with the scripts it runs, and the takeoff tool itself. The
     portal's worker is asked to keep the first; the second is loaded once,
     out of sight, so the tool's own worker installs and keeps it. Its first
     visit is not under its worker yet, so it is loaded twice — the second
     time every piece it fetches goes through the worker and is kept. */
  var scriptBase = (function () {
    try {
      var s = document.currentScript && document.currentScript.src;
      return s ? new URL(".", s).href : location.href;
    } catch (e) { return location.href; }
  })();
  function toolBase() { return new URL(window.DCRTakeoff.APP, location.href).href; }
  // A deep module of the tool, not just its front page: only when that is in
  // Cache Storage can the tool start with no internet.
  // Only the tool's caches from v9 on count: those are filled in one go at
  // install, so one deep module there means the whole program is. Older ones
  // were filled piece by piece as pages happened to be fetched.
  async function toolCached() {
    try {
      var url = new URL("js/core/takeoff-file.js", toolBase()).href;
      var names = await caches.keys();
      for (var i = 0; i < names.length; i++) {
        var m = /^ptt-web-v(\d+)$/.exec(names[i]);
        if (!m || Number(m[1]) < 9) continue;
        if (await (await caches.open(names[i])).match(url)) return true;
      }
    } catch (e) { /* no cache access: not ready */ }
    return false;
  }
  function warmOffline(force) {
    if (!navigator.onLine || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      var w = reg && (reg.active || navigator.serviceWorker.controller);
      if (w) w.postMessage({ type: "dcr-precache", urls: OFFLINE_ASSETS.map(function (u) { return new URL(u, scriptBase).href; }) });
    }).catch(function () {});
    var last = 0;
    try { last = Number(localStorage.getItem(WARM_KEY) || 0); } catch (e) { /* none */ }
    if (!force && Date.now() - last < 20 * 3600 * 1000) return;
    if (document.getElementById("dcrToolWarm") || !window.DCRTakeoff) return;
    var f = document.createElement("iframe");
    f.id = "dcrToolWarm"; f.hidden = true; f.tabIndex = -1;
    f.setAttribute("aria-hidden", "true"); f.setAttribute("title", "");
    f.style.cssText = "position:absolute;width:1px;height:1px;border:0;left:-9999px;top:0";
    f.src = new URL("index.html?warm=1", toolBase()).href;
    var reloaded = false, finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      toolCached().then(function (ok) {
        // Stamped only when the tool can really start offline, so a warm-up
        // that did not take is tried again on the next visit, not tomorrow.
        if (ok) { try { localStorage.setItem(WARM_KEY, String(Date.now())); } catch (e) { /* fine */ } }
        f.remove();
        changed("warm");
      });
    }
    function controlled() {
      try { return !!f.contentWindow.navigator.serviceWorker.controller; } catch (e) { return false; }
    }
    f.onload = function () {
      /* Did THIS load go through the tool's worker? A worker that claims the
         frame a moment after it loaded still never saw the modules that load
         fetched. If not, wait for the worker to take the frame and load it
         once more, so every piece the tool needs is fetched through it. */
      var viaWorker = false;
      try {
        var nav = f.contentWindow.performance.getEntriesByType("navigation")[0];
        viaWorker = !!(nav && nav.workerStart > 0);
      } catch (e) { viaWorker = false; }
      if (!viaWorker && !reloaded) {
        var waited = 0;
        var t = setInterval(function () {
          waited += 250;
          if (controlled() || waited >= 10000) {
            clearInterval(t);
            if (!controlled()) { finish(); return; }
            reloaded = true;
            try { f.contentWindow.location.reload(); } catch (e) { finish(); }
          }
        }, 250);
        return;
      }
      setTimeout(finish, 4000);                  // its first screen fetches a few more pieces
    };
    setTimeout(finish, 45000);                    // never leave the frame behind
    document.body.appendChild(f);
  }
  async function offlineReady() {
    var out = { page: false, tool: false };
    if (!("serviceWorker" in navigator)) return out;
    try {
      out.page = !!navigator.serviceWorker.controller;
      var reg = await navigator.serviceWorker.getRegistration(toolBase());
      out.tool = !!(reg && reg.active && reg.scope && reg.scope.indexOf("takeoff-web") !== -1) && (await toolCached());
    } catch (e) { /* unknown */ }
    return out;
  }

  /* ── the session, for the library page (which must also work offline) ──── */
  async function session() {
    var c = claims();
    if (!c) return { signedIn: false };
    var base = { signedIn: true, owner: String(c.sub || c.email || ""), name: c.name || c.email || "", role: c.role || "" };
    if (navigator.onLine) {
      try {
        var me = await timeout(DCR.api("/api/portal?action=me"), 8000);
        if (me && me.token) DCR.setToken(me.token);
        return Object.assign(base, { online: true, me: me });
      } catch (e) {
        if (e && e.status === 401) return { signedIn: false, expired: true };   // api() is already on its way to the sign-in page
      }
    }
    return Object.assign(base, { online: false });
  }

  function onChange(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
  }

  window.DCRPlansLibrary = {
    supported: supported, canWrite: canWrite, owner: owner, session: session,
    list: list, entry: entry, projects: projects, usage: usage, counts: counts, lastChecked: lastChecked,
    save: save, update: update, resume: resume, pause: pause, remove: remove, open: open,
    checkUpdates: checkUpdates, maybeCheck: maybeCheck, sweep: sweep, verifyFiles: verifyFiles, protect: protect,
    warmOffline: warmOffline, offlineReady: offlineReady, openInTool: openInTool, onChange: onChange,
    isRunning: function (id) { return !!jobs[keyOf(id)]; },
    fmtSize: fmtSize, fmtWhen: fmtWhen, fmtDay: fmtDay, fmtAgo: fmtAgo,
  };
})();
