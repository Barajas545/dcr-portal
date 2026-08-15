/* DCR portal — the upload queue that does not lose pictures.

   A photo taken on a job site is often the only record that something was
   done a certain way, and the phone taking it is frequently somewhere with no
   bars. So the bytes go into IndexedDB the moment they are picked — before any
   network is attempted — and the queue drains whenever there is a connection.
   Close the tab, lose signal, drive out of range, reboot the phone: the file is
   still there and still goes up.

   IndexedDB rather than localStorage because localStorage holds strings; a
   40 MB video base64'd into it would blow the quota and the main thread with
   it. IndexedDB stores the Blob itself.

   Used by BOTH the project Journal and the Site Photos screen — one queue, so
   a phone with pending work uploads it whichever screen the user happens to
   open next. */
(function () {
  var DCR = (window.DCR = window.DCR || {});

  var DB_NAME = "dcrUploads";
  var STORE = "q";
  var CHUNK = 320 * 1024 * 24;      // 7.5 MiB, 320KiB-aligned (Graph requires it)
  var MAX_TRIES = 8;

  var _db = null;
  var _mem = null;                  // set when IndexedDB cannot be used at all
  var _listeners = [];
  var _draining = false;
  var _live = {};                   // id -> bytes sent so far, for the progress bar

  function openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, 1); }
      catch (e) { return reject(e); }          // private mode can throw outright
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { reject(req.error || new Error("Could not open the upload store")); };
      req.onblocked = function () { reject(new Error("The upload store is busy")); };
    });
  }

  /* Storage, one small interface over two backings. IndexedDB is the real one;
     if the browser refuses it (private browsing, no quota, an older phone) the
     queue keeps the files in memory instead. That loses durability across a
     closed tab — and only that. Refusing the photo outright would be far worse
     than holding it the way the app used to. */
  function idbOps(db) {
    function run(mode, fn) {
      return new Promise(function (res, rej) {
        var t = db.transaction(STORE, mode), s = t.objectStore(STORE), out;
        var r = fn(s);
        if (r) { r.onsuccess = function () { out = r.result; }; }
        t.oncomplete = function () { res(out); };
        t.onerror = t.onabort = function () { rej(t.error || new Error("Upload store write failed")); };
      });
    }
    return {
      put: function (v) { return run("readwrite", function (s) { return s.put(v); }).then(function () { return v; }); },
      del: function (id) { return run("readwrite", function (s) { return s.delete(id); }); },
      all: function () { return run("readonly", function (s) { return s.getAll(); }).then(function (r) { return r || []; }); },
    };
  }
  var memOps = {
    put: function (v) { _mem[v.id] = v; return Promise.resolve(v); },
    del: function (id) { delete _mem[id]; return Promise.resolve(); },
    all: function () {
      return Promise.resolve(Object.keys(_mem).map(function (k) { return _mem[k]; }));
    },
  };
  function ops() {
    if (_mem) return Promise.resolve(memOps);
    return openDb().then(idbOps, function () { _mem = _mem || {}; return memOps; });
  }
  function sPut(v) { return ops().then(function (o) { return o.put(v); }); }
  function sDel(id) { return ops().then(function (o) { return o.del(id); }); }
  function sAll() { return ops().then(function (o) { return o.all(); }); }

  function emit() {
    var snap = null;
    _listeners.forEach(function (fn) {
      try { fn(); } catch (e) { /* a listener must never stall the queue */ }
    });
    return snap;
  }

  /* A public view of one queued file. The Blob is deliberately not handed out —
     callers want to know what is happening, not to hold a second reference to
     40 MB of video. */
  function pub(rec) {
    var sent = _live[rec.id] != null ? _live[rec.id] : rec.sent || 0;
    return {
      id: rec.id, pid: rec.pid, name: rec.name, tag: rec.tag || "",
      size: rec.size || 0, sent: sent,
      pct: rec.size ? Math.min(100, Math.round((sent / rec.size) * 100)) : 0,
      state: rec.state || "waiting", error: rec.error || "",
      tries: rec.tries || 0, added: rec.added,
    };
  }

  var api = {
    /* Take custody of a file. Resolves once the bytes are safely on disk —
       NOT once they are uploaded. That distinction is the whole point: the
       caller can carry on, and the file is already safe. */
    add: function (opts) {
      var rec = {
        id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
        pid: String(opts.pid || ""),
        target: String(opts.target || "pictures"),
        weekFolder: opts.weekFolder || "",
        name: String(opts.name || "file"),
        mime: String(opts.mime || ""),
        blob: opts.blob,
        size: (opts.blob && opts.blob.size) || 0,
        tag: opts.tag || "",
        added: Date.now(),
        tries: 0, sent: 0, state: "waiting", error: "",
      };
      return sPut(rec).then(function () { emit(); api.start(); return rec.id; });
    },

    list: function () {
      return sAll().then(function (all) {
        return all.sort(function (a, b) { return a.added - b.added; }).map(pub);
      });
    },
    /* Everything still queued for one project — what the Journal and Site
       Photos screens draw their progress bars from. */
    listFor: function (pid) {
      return api.list().then(function (all) {
        return all.filter(function (r) { return String(r.pid) === String(pid); });
      });
    },
    count: function () { return api.list().then(function (a) { return a.length; }); },

    remove: function (id) {
      return sDel(id).then(function () { delete _live[id]; emit(); });
    },
    /* Put failed items back in line — used by the "retry" affordance and
       automatically when the connection comes back. */
    retryAll: function () {
      return sAll().then(function (all) {
        return Promise.all(all.filter(function (r) { return r.state === "failed"; })
          .map(function (r) {
            r.state = "waiting"; r.tries = 0; r.error = "";
            return sPut(r);
          }));
      }).then(function () { emit(); api.start(); });
    },

    /* False once the browser has refused IndexedDB: files are being held in
       memory only, so closing the tab really would lose them. Screens can warn
       on this; nothing else changes. */
    durable: function () { return !_mem; },

    on: function (fn) {
      _listeners.push(fn);
      return function () { _listeners = _listeners.filter(function (f) { return f !== fn; }); };
    },

    online: function () { return navigator.onLine !== false; },

    /* Drain. Safe to call at any time and from anywhere — it no-ops if it is
       already running. */
    start: function () {
      if (_draining) return;
      _draining = true;
      drain().catch(function () {}).then(function () { _draining = false; });
    },
  };

  async function drain() {
    for (;;) {
      if (!api.online()) return;               // the 'online' event restarts us
      var all = await sAll();
      var next = all.filter(function (r) { return r.state !== "failed"; })
        .sort(function (a, b) { return a.added - b.added; })[0];
      if (!next) return;

      next.state = "uploading";
      await sPut(next);
      emit();

      try {
        await sendOne(next);
        await api.remove(next.id);
      } catch (err) {
        delete _live[next.id];
        var fatal = !!(err && err.fatal);
        next.tries = (next.tries || 0) + 1;
        next.error = (err && err.message) || "Upload failed";
        // A refusal from the API is permanent — retrying it forever would
        // hammer the server and never succeed. Anything network-shaped keeps
        // its place in the queue.
        next.state = (fatal || next.tries >= MAX_TRIES) ? "failed" : "waiting";
        next.sent = 0;
        next.session = null;
        await sPut(next);
        emit();
        if (next.state === "waiting") {
          // back off, then let the next tick pick it up
          await new Promise(function (r) { setTimeout(r, Math.min(30000, 2000 * next.tries)); });
        }
      }
      emit();
    }
  }

  async function sendOne(rec) {
    if (!rec.blob || !rec.blob.size) {
      var e0 = new Error("The file was empty"); e0.fatal = true; throw e0;
    }
    var session = rec.session;
    if (!session) {
      try {
        var s = await DCR.api("/api/portal?action=drive", {
          method: "POST",
          body: {
            op: "uploadSession", projectId: rec.pid, target: rec.target,
            name: rec.name, mimeType: rec.mime, weekFolder: rec.weekFolder || "",
          },
        });
        session = s.uploadUrl;
      } catch (e) {
        // 4xx here is a real refusal (no access, bad name); retrying will not
        // fix it. Everything else is worth another go.
        var err = new Error(e.message || "Could not start the upload");
        err.fatal = /\b(400|401|403|404|409)\b/.test(String(e.message || ""));
        throw err;
      }
      rec.session = session;
      rec.sent = 0;
      await sPut(rec);
    }
    var total = rec.blob.size;
    var pos = rec.sent || 0;
    while (pos < total) {
      var end = Math.min(pos + CHUNK, total);
      await putChunk(rec, session, pos, end, total);
      pos = end;
      rec.sent = pos;
      _live[rec.id] = pos;
      await sPut(rec);
      emit();
    }
    delete _live[rec.id];
  }

  function putChunk(rec, session, start, end, total) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open("PUT", session);
      x.setRequestHeader("Content-Range", "bytes " + start + "-" + (end - 1) + "/" + total);
      x.timeout = 180000;
      var lastPct = -1;
      x.upload.onprogress = function (ev) {
        if (!ev.lengthComputable) return;
        _live[rec.id] = start + ev.loaded;
        var pct = total ? Math.round((_live[rec.id] / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; emit(); }
      };
      x.onload = function () {
        if (x.status === 200 || x.status === 201 || x.status === 202) return resolve();
        if (x.status === 404 || x.status === 410) {
          // the session expired — start it over on the next attempt
          rec.session = null; rec.sent = 0;
          return reject(new Error("Upload session expired"));
        }
        if (x.status >= 400 && x.status < 500 && x.status !== 408 && x.status !== 429) {
          var f = new Error("Upload rejected (" + x.status + ")"); f.fatal = true;
          return reject(f);
        }
        reject(new Error("Upload failed (" + x.status + ")"));
      };
      x.onerror = function () { reject(new Error("No connection")); };
      x.ontimeout = function () { reject(new Error("Timed out")); };
      x.send(rec.blob.slice(start, end));
    });
  }

  // Signal came back — go. Also try on load, so a phone that was closed with
  // work pending picks it up as soon as any portal page is opened.
  window.addEventListener("online", function () { api.retryAll(); });
  window.addEventListener("load", function () { setTimeout(api.start, 800); });
  // Mid-transfer, or holding files the browser wouldn't let us write to disk —
  // the second case is the one where leaving actually loses something.
  window.addEventListener("beforeunload", function (e) {
    var risky = _draining || (_mem && Object.keys(_mem).length > 0);
    if (!risky) return;
    e.preventDefault(); e.returnValue = "";
  });

  DCR.uploadQueue = api;
})();
