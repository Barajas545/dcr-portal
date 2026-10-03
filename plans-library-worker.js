/* DCR portal — Plans Library download worker.

   Writes one .takeoff plan file into this device's private file storage (the
   Origin Private File System) WHILE it downloads, one byte range at a time.
   Nothing is held in memory but the piece in flight, so a 2.3 GB plan set
   downloads on a phone as well as on a desktop, and a dropped connection
   picks up at the last byte written instead of starting over.

   Why a worker: the synchronous access handle is the one OPFS writer every
   current browser has, Safari included, and it exists only in workers.

   The page owns the session. When SharePoint's pre-authed link expires
   (about an hour), this asks the page for a fresh one ("need-url") and waits;
   it never sees the portal token. One download per worker.

   page -> worker  {op:"probe"}                 can this browser write here at all?
                   {op:"start", id, file, url, size, from}
                   {op:"url", url}             a fresh link, or "" when there is none
                   {op:"cancel", id}           pause: stop, keep what is written
   worker -> page  {type:"probe", ok}
                   {type:"progress", id, done}
                   {type:"need-url", id}
                   {type:"done", id, size, magic}
                   {type:"cancelled", id, done}
                   {type:"error", id, message, status, done}

   status 507 on an error means the device ran out of room (final, not a
   connection to retry); status 0 or 5xx means the connection (a pause). */
"use strict";

var DIR = "plans-library";
var CHUNK = 8 * 1024 * 1024;              // one Range request
var WAITS = [2000, 8000, 30000];          // after a dropped connection
var RENEW_MAX = 3;                        // fresh links in a row before giving up
var STALL_MS = 60000;                     // no bytes for this long: the connection is dead
var NAME_RE = /^[A-Za-z0-9_-]+\.takeoff$/;

var job = null;

// Every number posted is a real number: a Promise in a message cannot be
// cloned, and a failed post would leave the page waiting forever.
function post(m) {
  if ("done" in m) m.done = Number(m.done) || 0;
  try { self.postMessage(m); } catch (e) { /* nothing more can be said */ }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function failure(message, status) { var e = new Error(message); e.status = status || 0; return e; }
function cancelled() { var e = new Error("cancelled"); e.cancelled = true; return e; }
function noRoom() {
  var e = failure("This device ran out of room for this plan. Remove a saved plan or free up space, then try again.", 507);
  e.final = true;
  return e;
}

self.onmessage = function (ev) {
  var m = ev.data || {};
  if (m.op === "start") {
    start(m).catch(function (e) {
      post({ type: "error", id: m.id, message: (e && e.message) || "The download failed.", status: 0, done: 0 });
    });
    return;
  }
  if (m.op === "probe") { probe(); return; }
  if (!job) return;
  if (m.op === "url" && job.urlWaiter) {
    var w = job.urlWaiter; job.urlWaiter = null; w(String(m.url || ""));
    return;
  }
  if (m.op === "cancel" && m.id === job.id) {
    job.cancelled = true;
    if (job.abort) { try { job.abort.abort(); } catch (e) { /* already done */ } }
    if (job.urlWaiter) { var w2 = job.urlWaiter; job.urlWaiter = null; w2(""); }
  }
};

/* Can this browser write here, for real? The handle existing is not enough:
   before Safari 16.4 its methods returned Promises, and a resume written for
   the synchronous ones would cut the partial file to nothing. So a scratch
   file is opened and getSize() must answer with a number. */
async function probe() {
  var ok = false, ah = null, dir = null, name = "probe-" + Date.now().toString(36) + ".tmp";
  try {
    if (typeof FileSystemFileHandle !== "undefined" && "createSyncAccessHandle" in FileSystemFileHandle.prototype) {
      var root = await navigator.storage.getDirectory();
      dir = await root.getDirectoryHandle(DIR, { create: true });
      var fh = await dir.getFileHandle(name, { create: true });
      ah = await fh.createSyncAccessHandle();
      ok = typeof ah.getSize() === "number";
    }
  } catch (e) { ok = false; }
  try { if (ah) ah.close(); } catch (e) { /* fine */ }
  try { if (dir) await dir.removeEntry(name); } catch (e) { /* fine */ }
  post({ type: "probe", ok: ok });
}

function askForUrl() {
  return new Promise(function (resolve) {
    job.urlWaiter = resolve;
    post({ type: "need-url", id: job.id });
  });
}

function retryAfterMs(res) {
  var v = res && res.headers && res.headers.get("Retry-After");
  var n = Number(v);
  if (isFinite(n) && n > 0) return Math.min(60000, n * 1000);
  var t = Date.parse(v || "");
  return isFinite(t) ? Math.min(60000, Math.max(1000, t - Date.now())) : 0;
}

/* One Range request, answered 206 (the piece) or 200 (a server that ignored
   the range and sent the whole file). An expired link is renewed and asked
   again; a network failure or SharePoint throttling waits and asks again; a
   missing file is final. */
async function fetchRange(start, end) {
  var fails = 0, renewals = 0;
  for (;;) {
    if (job.cancelled) throw cancelled();
    job.abort = new AbortController();
    var res = null, err = null;
    var waiting = setTimeout(function () { try { job.abort.abort(); } catch (e) { /* done */ } }, STALL_MS);
    try {
      res = await fetch(job.url, {
        headers: { Range: "bytes=" + start + "-" + end },
        signal: job.abort.signal,
        cache: "no-store",
      });
    } catch (e) { err = e; }
    clearTimeout(waiting);
    if (job.cancelled) throw cancelled();
    if (res && (res.status === 206 || res.status === 200)) return res;
    if (res && (res.status === 401 || res.status === 403 || res.status === 410)) {
      if (++renewals > RENEW_MAX) throw failure("SharePoint kept refusing the download link.", res.status);
      var url = await askForUrl();
      if (job.cancelled) throw cancelled();
      if (!url) throw failure("The download link expired and no new one could be had.", res.status);
      job.url = url;
      continue;
    }
    if (res && res.status === 404) throw failure("The file is no longer in SharePoint.", 404);
    if (res && res.status === 416) throw failure("The file in SharePoint is not the size it was when this download started.", 416);
    if (++fails > WAITS.length) {
      throw failure(res ? "SharePoint answered " + res.status + "." : "The connection dropped and did not come back.",
        res ? (res.status === 429 ? 503 : res.status) : 0);
    }
    // SharePoint asks to slow down with 429 and says for how long.
    await sleep(res && res.status === 429 ? (retryAfterMs(res) || WAITS[fails - 1]) : WAITS[fails - 1]);
  }
}

async function start(m) {
  if (job) { post({ type: "error", id: m.id, message: "This worker is already downloading.", status: 0, done: 0 }); return; }
  job = { id: m.id, url: String(m.url || ""), size: Math.max(0, Number(m.size) || 0), cancelled: false, pos: 0 };
  var ah = null, pos = 0;
  // A word every few seconds even while waiting on SharePoint, so the page
  // can tell a slow download from a worker that has died.
  var beat = setInterval(function () { if (job) post({ type: "progress", id: job.id, done: job.pos }); }, 10000);
  try {
    if (!NAME_RE.test(String(m.file || ""))) throw failure("That is not a library file name.");
    if (!job.url) throw failure("No download link.");
    var root = await navigator.storage.getDirectory();
    var dir = await root.getDirectoryHandle(DIR, { create: true });
    var fh = await dir.getFileHandle(m.file, { create: true });
    ah = await fh.createSyncAccessHandle();

    /* Resume from the file's own length, not from the last number the page
       saved: writes go strictly in order, so every byte below the length is
       the right byte, and the page only records progress now and then. A
       partial file longer than the whole download is somebody else's bytes. */
    var have = ah.getSize();
    if (typeof have !== "number") throw failure("This browser cannot resume a download here.");
    pos = Number(m.from) > 0 ? have : 0;
    if (pos > job.size) pos = 0;
    ah.truncate(pos);
    job.pos = pos;
    post({ type: "progress", id: job.id, done: pos });

    var fails = 0, lastPost = 0;
    while (pos < job.size) {
      if (job.cancelled) throw cancelled();
      var end = Math.min(pos + CHUNK, job.size) - 1;
      var res = await fetchRange(pos, end);
      var whole = res.status === 200;
      if (whole && pos !== 0) { ah.truncate(0); pos = 0; job.pos = 0; }   // the whole file came back: take it from the top
      var reader = null;
      try {
        reader = res.body.getReader();
        for (;;) {
          // A body that stops sending without closing is a dead connection.
          var stall = null;
          var r = await Promise.race([
            reader.read(),
            new Promise(function (_, rej) { stall = setTimeout(function () { rej(failure("The connection stalled.")); }, STALL_MS); }),
          ]);
          clearTimeout(stall);
          if (r.done) break;
          if (job.cancelled) throw cancelled();
          try {
            ah.write(r.value, { at: pos });
          } catch (we) {
            throw noRoom();                       // the device, not the connection: never retried
          }
          pos += r.value.byteLength;
          job.pos = pos;
          var now = Date.now();
          if (now - lastPost > 250) { lastPost = now; post({ type: "progress", id: job.id, done: pos }); }
        }
        fails = 0;
      } catch (e) {
        if (reader) { try { reader.cancel(); } catch (e2) { /* gone */ } }
        if (e && (e.cancelled || e.final)) throw e;
        if (job.cancelled) throw cancelled();
        // The body broke off. What arrived is written; ask again from there.
        try { ah.flush(); } catch (e3) { throw noRoom(); }
        post({ type: "progress", id: job.id, done: pos });
        if (++fails > WAITS.length) throw failure("The connection dropped and did not come back.");
        await sleep(WAITS[fails - 1]);
        continue;
      }
      try { ah.flush(); } catch (e4) { throw noRoom(); }
      post({ type: "progress", id: job.id, done: pos });
      if (whole) break;
    }
    if (pos !== job.size) {
      throw failure("The download ended at " + pos + " of " + job.size + " bytes.");
    }
    // The first bytes say whether this is a takeoff project at all.
    var head = new Uint8Array(Math.min(9, pos));
    if (head.length) ah.read(head, { at: 0 });
    var magic = String.fromCharCode.apply(null, Array.prototype.slice.call(head));
    ah.flush();
    ah.close(); ah = null;
    post({ type: "done", id: job.id, size: pos, magic: magic });
  } catch (e) {
    try { if (ah) { ah.flush(); ah.close(); } } catch (e2) { /* nothing more to save */ }
    if (e && e.cancelled) post({ type: "cancelled", id: job.id, done: pos });
    else post({ type: "error", id: job.id, message: (e && e.message) || "The download failed.", status: (e && e.status) || 0, done: pos });
  } finally {
    clearInterval(beat);
    job = null;
  }
}
