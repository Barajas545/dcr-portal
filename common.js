// Shared helpers for all portal pages. No secrets here — auth is a signed token
// issued by the backend and stored only in this browser.
(function () {
  const cfg = window.DCR_CONFIG || {};
  const API_BASE = (cfg.API_BASE || "").replace(/\/$/, "");
  const TOKEN_KEY = "dcr_portal_token";

  const DCR = {
    API_BASE,
    company: (cfg.COMPANY && cfg.COMPANY.name) || cfg.COMPANY_NAME || "DCR",
    // Full company block for letterheads etc. — missing fields come back "".
    companyInfo: Object.assign(
      { name: "DCR", legalName: "", logo: "logo.png", address: "", phone: "",
        fax: "", email: "", website: "", license: "" },
      cfg.COMPANY || {}
    ),

    getToken() {
      return localStorage.getItem(TOKEN_KEY) || "";
    },
    setToken(t) {
      localStorage.setItem(TOKEN_KEY, t);
    },
    clearToken() {
      localStorage.removeItem(TOKEN_KEY);
    },

    // Fetch wrapper. Adds the Bearer token, parses JSON, throws on non-2xx.
    async api(path, { method = "GET", body, auth = true } = {}) {
      const headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (auth) {
        const token = DCR.getToken();
        if (token) headers.Authorization = "Bearer " + token;
      }
      const res = await fetch(API_BASE + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        /* no body */
      }

      if (res.status === 401 && auth) {
        // Session gone — bounce to login (unless we're already there).
        DCR.clearToken();
        if (!/index\.html$|\/$/.test(location.pathname)) {
          location.href = "index.html";
        }
      }
      if (!res.ok) {
        const err = new Error((data && data.error) || `Request failed (${res.status})`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    },

    // Load the current user or redirect to login. Returns the profile object.
    async requireAuth() {
      if (!DCR.getToken()) {
        location.href = "index.html";
        throw new Error("not signed in");
      }
      try {
        return await DCR.api("/api/portal?action=me");
      } catch (e) {
        location.href = "index.html";
        throw e;
      }
    },

    logout() {
      DCR.clearToken();
      location.href = "index.html";
    },

    // Fetch an authenticated portal endpoint as a blob object-URL (for <img>
    // tags that can't send Authorization headers). Cached per path.
    _blobCache: {},
    async blobUrl(path) {
      if (DCR._blobCache[path]) return DCR._blobCache[path];
      const res = await fetch(API_BASE + path, {
        headers: { Authorization: "Bearer " + DCR.getToken() },
      });
      if (!res.ok) throw new Error("Image load failed (" + res.status + ")");
      const url = URL.createObjectURL(await res.blob());
      DCR._blobCache[path] = url;
      return url;
    },

    // Escape untrusted strings before inserting into HTML.
    esc(v) {
      return String(v ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
      );
    },

    // ── company week + geo (shared by the capture screen and project files) ──

    // The company week runs Saturday→Friday, same as timesheet.js:39,
    // timesheet-manager.js:20, timesheet-pdf.js:45 and report-timecard.js:29.
    saturdayOf(date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      const day = d.getDay();                       // 0=Sun … 6=Sat
      d.setDate(d.getDate() - (day === 6 ? 0 : day + 1));
      return d;
    },

    // Folder name for a capture date, e.g. "2026-Week #02".
    // Week #01 is the Saturday–Friday week containing January 1, so the week
    // straddling New Year belongs to the year that January 1 falls in.
    weekFolder(date) {
      const sat = DCR.saturdayOf(date || new Date());
      // Try the following year first: a late-December week can contain Jan 1.
      let y = sat.getFullYear() + 1;
      let anchor = DCR.saturdayOf(new Date(y, 0, 1));
      if (sat < anchor) {
        y -= 1;
        anchor = DCR.saturdayOf(new Date(y, 0, 1));
      }
      // 604800000 = 7 days in ms; rounding absorbs any DST shift in between.
      const n = Math.round((sat - anchor) / 604800000) + 1;
      return y + "-Week #" + (n < 10 ? "0" + n : String(n));
    },

    // "lat,lng" or "lat,lng|src" → {lat, lng, src} | null
    parseCoords(s) {
      if (!s) return null;
      const parts = String(s).split("|");
      const n = parts[0].split(/[,;\s]+/).map(parseFloat).filter((v) => !isNaN(v));
      if (n.length < 2 || Math.abs(n[0]) > 90 || Math.abs(n[1]) > 180) return null;
      return { lat: n[0], lng: n[1], src: (parts[1] || "").trim() || "gps" };
    },

    // Great-circle distance in miles.
    distanceMi(a, b) {
      const R = 3958.8, rad = Math.PI / 180;
      const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
      const s = Math.sin(dLat / 2) ** 2 +
        Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
    },
  };

  /* ── DCR.modal — the app's own dialogs ──────────────────────────────────
     Replaces window.prompt/confirm/alert, which render as "barajas545.github.io
     says…" with the browser's own chrome — wrong name, wrong look, and stuck
     to the top of the screen. This one is centred in the app, carries the
     company mark, themes with the rest of the portal, and returns a Promise.

       await DCR.confirm("Delete this row?", { danger: true })   -> true/false
       await DCR.ask("What needs to happen?")                    -> string|null
       await DCR.alert("Saved.")
       await DCR.modal({ title, message, fields:[…], okText })   -> {name:value}|null

     Several fields in one dialog is the point: asking for a note and then a
     date in two stacked prompts is how the old flow felt clumsy. */
  var modalStack = [];

  function modalEl() {
    var host = document.getElementById("dcrModalHost");
    if (host) return host;
    host = document.createElement("div");
    host.id = "dcrModalHost";
    host.className = "dcr-mo";
    host.innerHTML = '<div class="dcr-mo-card" role="dialog" aria-modal="true"></div>';
    document.body.appendChild(host);
    return host;
  }

  DCR.modal = function (opts) {
    opts = opts || {};
    var fields = opts.fields || [];
    return new Promise(function (resolve) {
      var host = modalEl();
      var card = host.querySelector(".dcr-mo-card");
      var lastFocus = document.activeElement;
      var co = DCR.companyInfo || {};

      card.innerHTML =
        '<div class="dcr-mo-hd">' +
          (co.logo ? '<img src="' + DCR.esc(co.logo) + '" alt="">' : "") +
          "<span>" + DCR.esc(co.name || DCR.company || "DCR") + "</span></div>" +
        (opts.title ? '<div class="dcr-mo-t">' + DCR.esc(opts.title) + "</div>" : "") +
        (opts.message ? '<div class="dcr-mo-m">' + DCR.esc(opts.message) + "</div>" : "") +
        fields.map(function (f, i) {
          var id = "dcrMoF" + i;
          var lab = f.label ? '<label for="' + id + '">' + DCR.esc(f.label) + "</label>" : "";
          if (f.type === "textarea") {
            return '<div class="dcr-mo-f">' + lab + '<textarea id="' + id + '" rows="' + (f.rows || 3) +
              '" placeholder="' + DCR.esc(f.placeholder || "") + '">' + DCR.esc(f.value || "") + "</textarea></div>";
          }
          if (f.type === "select") {
            return '<div class="dcr-mo-f">' + lab + '<select id="' + id + '">' +
              (f.options || []).map(function (o) {
                var v = o.value !== undefined ? o.value : o;
                var t = o.label !== undefined ? o.label : o;
                return '<option value="' + DCR.esc(v) + '"' + (String(v) === String(f.value) ? " selected" : "") + ">" + DCR.esc(t) + "</option>";
              }).join("") + "</select></div>";
          }
          return '<div class="dcr-mo-f">' + lab + '<input id="' + id + '" type="' + (f.type || "text") +
            '" placeholder="' + DCR.esc(f.placeholder || "") + '" value="' + DCR.esc(f.value || "") + '"' +
            (f.step ? ' step="' + DCR.esc(f.step) + '"' : "") + "></div>";
        }).join("") +
        '<div class="dcr-mo-err" id="dcrMoErr"></div>' +
        '<div class="dcr-mo-ft">' +
          (opts.cancel === false ? "" : '<button type="button" class="btn btn-ghost btn-sm" id="dcrMoNo">' +
            DCR.esc(opts.cancelText || "Cancel") + "</button>") +
          '<button type="button" class="btn btn-sm' + (opts.danger ? " dcr-mo-danger" : "") + '" id="dcrMoYes">' +
            DCR.esc(opts.okText || "OK") + "</button>" +
        "</div>";

      host.classList.add("open");
      var entry = { host: host, resolve: resolve, done: false };
      modalStack.push(entry);

      function close(value) {
        if (entry.done) return;
        entry.done = true;
        modalStack.pop();
        host.classList.remove("open");
        document.removeEventListener("keydown", onKey, true);
        try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
        resolve(value);
      }
      function values() {
        var out = {};
        fields.forEach(function (f, i) {
          var n = document.getElementById("dcrMoF" + i);
          out[f.name || String(i)] = n ? n.value : "";
        });
        return out;
      }
      function submit() {
        var v = values();
        if (opts.validate) {
          var problem = opts.validate(v);
          if (problem) { document.getElementById("dcrMoErr").textContent = problem; return; }
        }
        close(fields.length ? v : true);
      }
      function onKey(e) {
        if (modalStack[modalStack.length - 1] !== entry) return;
        if (e.key === "Escape") { e.preventDefault(); close(null); }
        else if (e.key === "Enter" && !e.shiftKey) {
          var t = e.target;
          if (t && t.tagName === "TEXTAREA") return;   // Enter is a newline there
          e.preventDefault(); submit();
        }
      }
      document.addEventListener("keydown", onKey, true);
      card.querySelector("#dcrMoYes").onclick = submit;
      var no = card.querySelector("#dcrMoNo");
      if (no) no.onclick = function () { close(null); };
      host.onclick = function (e) { if (e.target === host) close(null); };

      var first = card.querySelector("input, textarea, select");
      setTimeout(function () {
        if (first) { first.focus(); if (first.select) first.select(); }
        else card.querySelector("#dcrMoYes").focus();
      }, 20);
    });
  };

  // prompt() → string or null
  DCR.ask = function (message, opts) {
    opts = opts || {};
    return DCR.modal({
      title: opts.title || "", message: message,
      okText: opts.okText || "OK", danger: opts.danger,
      fields: [{ name: "v", type: opts.type || "text", value: opts.value || "",
        placeholder: opts.placeholder || "", label: opts.label || "" }],
      validate: opts.validate,
    }).then(function (r) { return r ? r.v : null; });
  };
  // confirm() → true/false
  DCR.confirm = function (message, opts) {
    opts = opts || {};
    return DCR.modal({
      title: opts.title || "", message: message,
      okText: opts.okText || "Yes", cancelText: opts.cancelText || "Cancel",
      danger: opts.danger, fields: [],
    }).then(function (r) { return r === true; });
  };
  // alert() → resolves when dismissed
  DCR.alert = function (message, opts) {
    opts = opts || {};
    return DCR.modal({ title: opts.title || "", message: message,
      okText: opts.okText || "OK", cancel: false, fields: [] }).then(function () {});
  };

  /* ── DCR.live — the auto-save engine ────────────────────────────────────
     Edits persist by themselves; nobody hunts for a Save button. One saver per
     RECORD (not per field), so every dirty field of a record coalesces into a
     single write and a record never has two writes in flight.

       var saver = DCR.live.record({
         key: "project:" + PID,          // same key === same saver
         status: "pjMsg",                // where the badge paints
         write: function (fields) { return DCR.api(…, {body:{fields:fields}}); },
         onSaved: function (fields) { … patch local state IN PLACE … }
       });
       saver.baseline(record);           // what the server already has
       saver.bind(paneEl);               // wire every [data-key] input
       saver.set("projectNotes", txt);   // or drive it by hand

     Deliberately NOT auto-saved anywhere: creating, deleting, uploading,
     emailing, and workflow stage changes. Those stay one deliberate click. */
  var LIVE_DELAY = 800;        // idle after the last keystroke
  var LIVE_NOW = 120;          // discrete controls: instant to a human, but long
                               // enough that a burst of clicks is one write
  var LIVE_CEILING = 4000;     // …but never wait longer than this while typing
  var LIVE_BACKOFF = [2000, 6000, 15000];
  var liveRecords = {};
  var livePageNodes = [];

  function liveNorm(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return v ? "1" : "";
    if (typeof v === "number") return isFinite(v) ? String(v) : "";
    return String(v);
  }
  function liveCount(o) { return Object.keys(o).length; }
  // Worth trying again? Network, throttling and server faults are; 400/403 are not.
  function liveRetryable(e) {
    if (!navigator.onLine) return true;
    if (!e || !e.status) return true;                 // fetch failed outright
    return e.status >= 500 || e.status === 429 || e.status === 408;
  }
  function liveRetryAfter(e) {
    var s = e && e.data && Number(e.data.retryAfter);
    return isFinite(s) && s > 0 ? Math.min(s, 60) * 1000 : 0;
  }
  function liveClock(d) {
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? "pm" : "am";
    h = h % 12; if (!h) h = 12;
    return h + ":" + (m < 10 ? "0" + m : m) + ap;
  }

  function LiveRecord(opts) {
    this.opts = opts;
    this.base = {};       // last values known to be on the server
    this.pend = {};       // dirty, not yet sent
    this.bad = {};        // held back by validate()
    this.timer = null;
    this.retryTimer = null;
    this.firstDirtyAt = 0;
    this.inflight = null;
    this.tries = 0;
    this.state = "idle";  // idle | dirty | saving | saved | error | invalid
    this.savedAt = null;
    this.err = null;
    this.nodes = [];
  }

  LiveRecord.prototype.baseline = function (obj) {
    if (!obj) return this;
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) this.base[k] = obj[k];
    // anything that now matches the server is no longer dirty
    for (var p in this.pend) {
      if (liveNorm(this.pend[p]) === liveNorm(this.base[p])) delete this.pend[p];
    }
    return this;
  };

  LiveRecord.prototype.set = function (field, value, o) {
    o = o || {};
    if (this.opts.validate && !this.opts.validate(field, value)) {
      this.bad[field] = true;
      delete this.pend[field];
      this.state = "invalid";
      this.paint();
      return this;
    }
    delete this.bad[field];
    if (liveNorm(value) === liveNorm(this.base[field])) delete this.pend[field];
    else this.pend[field] = value;

    if (!liveCount(this.pend)) {
      if (this.state === "dirty" || this.state === "invalid") {
        this.state = this.savedAt ? "saved" : "idle";
      }
      clearTimeout(this.timer); this.timer = null; this.firstDirtyAt = 0;
      this.paint();
      return this;
    }
    if (this.state !== "saving") this.state = "dirty";
    this.paint();
    this.arm(o.now ? LIVE_NOW : 0);
    return this;
  };

  LiveRecord.prototype.arm = function (fixed) {
    var self = this;
    if (!this.firstDirtyAt) this.firstDirtyAt = Date.now();
    clearTimeout(this.timer);
    var wait;
    if (fixed) {
      wait = fixed;
    } else {
      var elapsed = Date.now() - this.firstDirtyAt;
      wait = Math.max(0, Math.min(this.opts.delay || LIVE_DELAY, LIVE_CEILING - elapsed));
    }
    this.timer = setTimeout(function () { self.flush(); }, wait);
  };

  LiveRecord.prototype.flush = function () {
    var self = this;
    clearTimeout(this.timer); this.timer = null;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    if (this.inflight) return this.inflight;          // one write at a time, in order
    if (!liveCount(this.pend)) return Promise.resolve();

    var fields = this.pend;
    this.pend = {};
    this.firstDirtyAt = 0;
    this.state = "saving";
    this.paint();

    this.inflight = Promise.resolve()
      .then(function () { return self.opts.write(fields); })
      .then(function (res) {
        self.inflight = null; self.tries = 0; self.err = null;
        for (var k in fields) self.base[k] = fields[k];
        self.state = "saved"; self.savedAt = new Date();
        try { if (self.opts.onSaved) self.opts.onSaved(fields, res); } catch (e) { /* never break the page */ }
        self.paint();
        if (liveCount(self.pend)) return self.flush();   // typed while saving
      })
      .catch(function (e) {
        self.inflight = null;
        // put the failed values back UNDER anything newer the user typed
        var merged = {}, k;
        for (k in fields) merged[k] = fields[k];
        for (k in self.pend) merged[k] = self.pend[k];
        self.pend = merged;
        self.err = e; self.state = "error";
        self.paint();
        if (liveRetryable(e) && self.tries < LIVE_BACKOFF.length) {
          var wait = liveRetryAfter(e) || LIVE_BACKOFF[self.tries];
          self.tries++;
          self.retryTimer = setTimeout(function () { self.flush(); }, wait);
        }
      });
    return this.inflight;
  };

  LiveRecord.prototype.retry = function () { this.tries = 0; return this.flush(); };
  LiveRecord.prototype.busy = function () { return !!(this.inflight || liveCount(this.pend)); };
  LiveRecord.prototype.dispose = function () {
    var self = this;
    var p = this.flush();
    delete liveRecords[this.opts.key];
    return p.then(function () { self.nodes = []; });
  };

  // Wire every [data-key] control under root. Discrete controls (checkbox,
  // select, date) save on change; typed fields debounce and flush on blur.
  LiveRecord.prototype.bind = function (root, o) {
    var self = this;
    o = o || {};
    if (!root) return this;
    Array.prototype.forEach.call(root.querySelectorAll("[data-key]"), function (inp) {
      if (inp._dcrLive) return;
      inp._dcrLive = true;
      var discrete = inp.type === "checkbox" || inp.type === "radio" ||
        inp.tagName === "SELECT" || inp.type === "date";
      inp.addEventListener(discrete ? "change" : "input", function () {
        self.set(inp.getAttribute("data-key"), DCR.live.inputValue(inp), { now: discrete });
      });
      if (!discrete) {
        inp.addEventListener("blur", function () {
          self.set(inp.getAttribute("data-key"), DCR.live.inputValue(inp));
          self.flush();
        });
      }
    });
    if (o.baseline !== false) this.paint();
    return this;
  };

  LiveRecord.prototype.summary = function () {
    var bad = Object.keys(this.bad);
    if (this.state === "error") {
      var offline = !navigator.onLine;
      return { state: "error", retry: !offline,
        text: offline ? "Offline — saves when you reconnect"
          : "⚠ " + ((this.err && this.err.message) || "Couldn't save") };
    }
    if (bad.length) return { state: "invalid", text: "Can't save " + bad[0] + " — check the value" };
    if (this.state === "saving") {
      return { state: "saving", text: this.tries ? "Saving… (retry " + this.tries + ")" : "Saving…" };
    }
    if (this.state === "dirty") return { state: "dirty", text: "• Unsaved" };
    if (this.state === "saved") return { state: "saved", text: "✓ Saved " + liveClock(this.savedAt) };
    return { state: "idle", text: "" };
  };

  LiveRecord.prototype.paint = function () {
    var s = this.summary(), self = this;
    this.nodes.forEach(function (n) { livePaint(n, s, self); });
    livePaintPage();
  };

  var LIVE_STATES = /\b(dcr-live|idle|dirty|saving|saved|error|invalid)\b/g;
  function livePaint(node, s, rec) {
    if (!node) return;
    // Keep whatever classes the page put on this node — pages hook their own
    // (".qtLive" and friends) and blindly overwriting className loses them.
    if (node._dcrBase === undefined) node._dcrBase = node.className.replace(LIVE_STATES, "").trim();
    node.className = ("dcr-live " + node._dcrBase + " " + s.state).replace(/\s+/g, " ").trim();
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    node.textContent = s.text;
    if (s.retry && rec) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "dcr-live-retry";
      b.textContent = "Retry";
      b.onclick = function () { rec.retry(); };
      node.appendChild(document.createTextNode(" "));
      node.appendChild(b);
    }
  }

  var LIVE_RANK = { error: 5, invalid: 4, saving: 3, dirty: 2, saved: 1, idle: 0 };
  function livePaintPage() {
    if (!livePageNodes.length) return;
    var worst = null, rec = null;
    for (var k in liveRecords) {
      var s = liveRecords[k].summary();
      if (!worst || LIVE_RANK[s.state] > LIVE_RANK[worst.state]) { worst = s; rec = liveRecords[k]; }
    }
    livePageNodes.forEach(function (n) { livePaint(n, worst || { state: "idle", text: "" }, rec); });
  }

  function liveNode(x) { return typeof x === "string" ? document.getElementById(x) : x; }

  DCR.live = {
    // Same key returns the same saver — that IS the coalescing guarantee.
    // Re-calling refreshes the callbacks, which a re-render will have replaced.
    record: function (opts) {
      var rec = liveRecords[opts.key];
      if (rec) {
        for (var k in opts) if (k !== "key") rec.opts[k] = opts[k];
      } else {
        rec = liveRecords[opts.key] = new LiveRecord(opts);
      }
      var n = liveNode(opts.status);
      if (n && rec.nodes.indexOf(n) === -1) rec.nodes.push(n);
      rec.paint();
      return rec;
    },
    get: function (key) { return liveRecords[key] || null; },
    inputValue: function (inp) {
      var type = inp.getAttribute && inp.getAttribute("data-type");
      if (type === "bool" || inp.type === "checkbox") return inp.checked;
      if (type === "num") return inp.value === "" ? null : Number(inp.value);
      if (type === "date") return inp.value ? inp.value + "T12:00:00Z" : null;
      return inp.value;
    },
    busy: function () {
      for (var k in liveRecords) if (liveRecords[k].busy()) return true;
      return false;
    },
    flushAll: function () {
      var all = [];
      for (var k in liveRecords) all.push(liveRecords[k].flush());
      return Promise.all(all);
    },
    // A page-wide badge: shows the worst state of every record on the page, so
    // the header always answers "is my work safe?" even from another tab.
    mountBadge: function (x) {
      var n = liveNode(x);
      if (n && livePageNodes.indexOf(n) === -1) livePageNodes.push(n);
      livePaintPage();
      return n;
    },
  };

  // One guard for the whole app: warn only while something is genuinely
  // unsaved, and take every chance to get it written.
  window.addEventListener("beforeunload", function (e) {
    if (!DCR.live.busy()) return;
    DCR.live.flushAll();
    e.preventDefault();
    e.returnValue = "";
  });
  window.addEventListener("pagehide", function () { DCR.live.flushAll(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") DCR.live.flushAll();
  });
  window.addEventListener("online", function () { DCR.live.flushAll(); });

  window.DCR = DCR;

  /* Register the service worker so the portal is installable and opens
     offline.

     The path is worked out from where THIS file was loaded, not from the page.
     A relative "sw.js" resolves against the page's own directory, so a page in
     a subfolder (cme.html's module tree, say) asked for /dcr-portal/cme/sw.js,
     got a 404, and the .catch swallowed it — a cold install entered through
     that page silently never registered a worker at all. common.js always sits
     in the portal root, so its own URL is the reliable anchor, and unlike a
     hardcoded "/dcr-portal/" it still works on localhost and on any other host. */
  if ("serviceWorker" in navigator) {
    var portalRoot = (function () {
      try {
        var self = document.currentScript && document.currentScript.src;
        if (!self) {
          var tags = document.getElementsByTagName("script");
          for (var i = 0; i < tags.length; i++) {
            if (/(^|\/)common\.js(\?|$)/.test(tags[i].src || "")) { self = tags[i].src; break; }
          }
        }
        return self ? new URL(".", self).href : null;
      } catch (e) { return null; }
    })();
    window.addEventListener("load", function () {
      if (!portalRoot) return;                       // nothing safe to register against
      navigator.serviceWorker
        .register(portalRoot + "sw.js", { scope: portalRoot })
        .catch(function () { /* non-fatal */ });
    });
  }

  // ── Single-instance guard (installed app only) ───────────────────────────
  // Windows opens a brand-new window every time you launch an installed PWA.
  // The manifest's launch_handler:"focus-existing" tells the browser to reuse
  // the existing window; this is the belt-and-suspenders fallback: if a second
  // app window ever appears, it shows a notice and hands control back to the one
  // window that holds an exclusive Web Lock — auto-activating when the other
  // closes. Scoped to display-mode:standalone so it never restricts browser tabs.
  (function () {
    /* Frames are not windows.

       An iframe inherits its parent's display-mode, and any portal page loaded
       into one - the drawing tool, for instance - also loads this file. It then
       asked for the very lock its own parent was holding, decided it was a
       second copy of the app, and covered itself with "DCR Portal is already
       open". The guard exists to stop a second APP WINDOW, so a frame inside
       the window that already holds the lock is explicitly not its business. */
    var inFrame = false;
    try { inFrame = window.top !== window.self; } catch (e) { inFrame = true; }  // cross-origin parent
    if (inFrame) return;

    var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true;
    if (!standalone || !navigator.locks || !navigator.locks.request) return;

    var LOCK = "dcr-portal-single-instance";
    var overlay = null;

    function showOverlay() {
      if (overlay) { overlay.style.display = "flex"; return; }
      overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;" +
        "align-items:center;justify-content:center;gap:14px;text-align:center;padding:28px;background:#0f141a;" +
        "color:#e6ebf1;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;";
      overlay.innerHTML =
        '<div style="font-size:40px">📲</div>' +
        '<div style="font-size:18px;font-weight:700">DCR Portal is already open</div>' +
        '<div style="font-size:14px;opacity:.75;max-width:340px;line-height:1.5">It’s running in another window. ' +
        'Switch to that window — this one activates automatically when you close the other.</div>' +
        '<button id="dcrSiReload" style="margin-top:6px;padding:9px 16px;border-radius:8px;border:1px solid #2a333d;' +
        'background:#171d25;color:#e6ebf1;font-weight:600;cursor:pointer">Reload this window</button>';
      (document.body || document.documentElement).appendChild(overlay);
      overlay.querySelector("#dcrSiReload").onclick = function () { location.reload(); };
    }

    function becomePrimary() {
      if (overlay) overlay.style.display = "none";
      return new Promise(function () {}); // hold the lock for this window's lifetime
    }

    navigator.locks.request(LOCK, { ifAvailable: true }, function (lock) {
      if (lock) return becomePrimary(); // we are the only instance
      // Another window holds the lock. Wait a moment (to ignore the brief overlap
      // during in-app page navigation), then show the notice if still blocked.
      var t = setTimeout(function () {
        if (document.body) showOverlay();
        else document.addEventListener("DOMContentLoaded", showOverlay);
      }, 400);
      return navigator.locks.request(LOCK, { mode: "exclusive" }, function () {
        clearTimeout(t);
        return becomePrimary(); // the other window closed — take over
      });
    });
  })();

  /* ── Back / Forward ───────────────────────────────────────────────────────
     The portal opens in a desktop shell with no browser chrome, so no page has
     a back control of its own: every screen is a full navigation, and the only
     ways back were the brand link or retyping a URL.

     The buttons drive real history - history.back() and history.forward() -
     rather than a stack of our own, so they stay in step with anything else
     that moves through history: a keyboard shortcut, the shell's own gesture,
     a redirect. What our bookkeeping adds is only knowing WHERE in that
     history we are, which the platform will not tell you; there is no API for
     "is there an entry ahead of this one". So each entry is stamped with an
     index, and the highest index reached this session says whether a forward
     entry exists. Reading the stamp back off history.state means arriving by
     any route - click, Back, Forward, reload - lands on the right answer. */
  (function () {
    var LAST  = "dcr_nav_last";  // index of the entry we were last on
    var MAX   = "dcr_nav_max";   // highest index reached; anything beyond is gone

    /* The sign-in page, which is deliberately NOT stamped below.

       It replaces itself with the dashboard the moment a token is in hand, so
       its entry never survives - counting it would push every later index one
       past the real history depth, and Back would offer to go somewhere that
       does not exist. Identified by URL, not by "has no topbar": eleven pages
       have no topbar. */
    function isSignIn() {
      var p = String(location.pathname || "");
      // A directory URL is the sign-in page too: the site is served at
      // /dcr-portal/, which hands back index.html without naming it.
      if (/\/$/.test(p) || p === "") return true;
      var leaf = p.slice(p.lastIndexOf("/") + 1);
      return /^index\.html$/i.test(leaf) || leaf.indexOf(".") === -1;
    }

    function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
    function get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
    function set(k, v) { try { sessionStorage.setItem(k, String(v)); } catch (e) {} }
    function stamped(st) { return st && typeof st.dcrNav === "number" ? st.dcrNav : null; }

    /* Pages set their own history state - project.js and pm.js write the open
       tab or item into the URL, all of them passing null as the state - which
       would wipe the stamp off the current entry and lose our place. Rather
       than ask six call sites to remember us, keep the stamp through any
       replaceState, and give a pushState the next index as a new entry. */
    ["pushState", "replaceState"].forEach(function (name) {
      var orig = history[name];
      if (typeof orig !== "function") return;
      history[name] = function (st, title, url) {
        var idx = name === "replaceState"
          ? stamped(history.state)
          : num(get(LAST)) + 1;
        if (idx !== null) {
          try { st = Object.assign({}, st || {}, { dcrNav: idx }); } catch (e) {}
          if (name === "pushState") { set(LAST, idx); set(MAX, idx); }
        }
        return orig.call(history, st, title, url);
      };
    });

    // Where this entry sits. An unstamped entry is a fresh navigation: it lands
    // one past wherever we were, and anything that was ahead is now unreachable.
    function position() {
      var idx = stamped(history.state);
      if (idx === null) {
        idx = num(get(LAST)) + 1;
        try { history.replaceState(Object.assign({}, history.state || {}, { dcrNav: idx }), ""); } catch (e) {}
        set(MAX, idx);
      }
      set(LAST, idx);
      return idx;
    }

    /* Stamp this entry NOW, before anything else runs and whether or not this
       page shows the buttons.

       It used to happen inside build(), which returns early when there is no
       top bar - and eleven pages have none, among them the plan viewer, the
       map and every printable report. Those entries were never stamped and
       never advanced the counters, so they were holes: come back from one and
       Forward was greyed out with the page still sitting one step ahead in
       real history. Where the buttons are DRAWN is a question about this page;
       where we are in history is not. */
    if (!isSignIn()) position();

    function build() {
      var bar = document.querySelector(".topbar");
      // Eleven pages have no bar - the sign-in page, the phone view, the plan
      // viewer, the map, the printable reports. Their history position is
      // already recorded above; they simply do not draw the buttons.
      if (!bar || bar.querySelector(".dcr-nav")) return;

      var CHEV = function (d) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="' + d + '"/></svg>';
      };
      var nav = document.createElement("div");
      nav.className = "dcr-nav";
      nav.innerHTML =
        '<button type="button" class="dcr-navbtn" data-nav="back" title="Back" aria-label="Go back">' + CHEV("15 18 9 12 15 6") + '</button>' +
        '<button type="button" class="dcr-navbtn" data-nav="fwd" title="Forward" aria-label="Go forward">' + CHEV("9 18 15 12 9 6") + '</button>';

      /* querySelector finds a .brand at any depth, but insertBefore demands a
         direct child - and capture.html wraps its bar contents in .topbar-in,
         so passing that grandchild threw NotFoundError and Site Photos got no
         buttons at all. Staying a direct child also keeps the CSS matching,
         since those rules use the child combinator. */
      var brand = bar.querySelector(".brand");
      bar.insertBefore(nav, brand && brand.parentNode === bar ? brand : bar.firstChild);

      var back = nav.querySelector('[data-nav="back"]');
      var fwd = nav.querySelector('[data-nav="fwd"]');
      back.onclick = function () { if (!back.disabled) history.back(); };
      fwd.onclick = function () { if (!fwd.disabled) history.forward(); };

      function paint() {
        var idx = position();
        var max = Math.max(num(get(MAX)), idx);
        /* Index 1 is the first portal page of this session. The sign-in page
           is never counted and never lingers - it replaces itself - so nothing
           behind index 1 is anywhere Back should go. */
        back.disabled = idx <= 1;
        fwd.disabled = idx >= max;
      }
      paint();

      // Restored from the back/forward cache the script does not re-run, so the
      // buttons would still describe the page you left.
      window.addEventListener("pageshow", paint);
      window.addEventListener("popstate", paint);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
    else build();
  })();

  /* ── guided assist ────────────────────────────────────────────────────────
     Being shown how to use the portal, on whatever device you are holding.

     The desktop remote-control tool cannot reach a phone - its screen capture
     and input injection are win32 calls - and on iPhone and iPad nobody can
     drive the screen, because Apple does not expose that to third parties at
     all. So this drives the PAGE instead of the machine: the helper points at
     something or sends you somewhere, and the page you are already looking at
     carries it out. Same code on a phone, a tablet and a desktop.

     There is no realtime channel and cannot cheaply be one - the API is
     serverless, and SharePoint is the only store - so the page asks, rather
     than being told. Rarely when nothing is happening; briskly once a session
     is live. Only while the tab is visible: a portal left open in a background
     tab all day should cost nothing. */
  (function () {
    var IDLE_MS = 10000;    // "is anyone helping me?"
    var LIVE_MS = 1500;     // "what next?"
    var timer = null, session = null, lastSeq = 0, banner = null, pointer = null, stopped = false;

    function isSignInPage() {
      var p = String(location.pathname || "");
      if (/\/$/.test(p) || p === "") return true;
      var leaf = p.slice(p.lastIndexOf("/") + 1);
      return /^index\.html$/i.test(leaf) || leaf.indexOf(".") === -1;
    }
    function pageName() {
      var leaf = String(location.pathname || "").split("/").pop();
      return leaf || "dashboard.html";
    }

    function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

    function showBanner(operator) {
      if (banner) return;
      banner = el("div", "dcr-assist");
      var pip = el("span", "pip");
      var who = el("span", "who");
      who.textContent = (operator || "Someone") + " is helping you";
      var msg = el("span", "msg");
      var end = document.createElement("button");
      end.type = "button";
      end.textContent = "End";
      end.title = "Stop being helped";
      end.onclick = endSession;
      banner.appendChild(pip); banner.appendChild(who); banner.appendChild(msg); banner.appendChild(end);
      document.body.appendChild(banner);
      banner._msg = msg;
    }
    function hideBanner() {
      if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
      banner = null;
      clearPointer();
    }
    function clearPointer() {
      if (pointer && pointer.parentNode) pointer.parentNode.removeChild(pointer);
      pointer = null;
    }

    function runCommand(cmd) {
      if (!cmd || typeof cmd !== "object") return;
      if (Number(cmd.seq) <= lastSeq) return;     // already done this one
      lastSeq = Number(cmd.seq) || 0;

      if (cmd.kind === "point") {
        clearPointer();
        pointer = el("div", "dcr-assist-point");
        // Percentages of the viewport, because the helper may be on a large
        // monitor and this may be a phone.
        pointer.style.left = Math.max(0, Math.min(100, Number(cmd.x) || 0)) + "vw";
        pointer.style.top = Math.max(0, Math.min(100, Number(cmd.y) || 0)) + "vh";
        pointer.setAttribute("data-label", String(cmd.label || ""));
        document.body.appendChild(pointer);
      } else if (cmd.kind === "say") {
        if (banner) banner._msg.textContent = String(cmd.text || "");
      } else if (cmd.kind === "clear") {
        clearPointer();
        if (banner) banner._msg.textContent = "";
      } else if (cmd.kind === "goto") {
        /* Re-checked here as well as on the server. A page name, never a URL:
           one member of staff able to send another's browser anywhere is an
           open redirect with a person operating it. */
        var page = String(cmd.page || "");
        if (!/^[a-z0-9-]{1,40}\.html$/i.test(page)) return;
        if (page === pageName() && !cmd.query) return;
        location.href = page + (cmd.query ? "?" + cmd.query : "");
      }
    }

    async function endSession() {
      var id = session && session.id;
      hideBanner();
      session = null;
      if (!id) return;
      try {
        await DCR.api("/api/portal?action=assist", { method: "POST", body: { op: "end", sessionId: id } });
      } catch (e) { /* it is ended locally either way */ }
      schedule();
    }

    async function tick() {
      if (stopped || !DCR.getToken() || document.visibilityState !== "visible") return schedule();
      try {
        var d = await DCR.api("/api/portal?action=assist&op=poll&where=" +
                              encodeURIComponent(pageName()));
        if (d && d.session) {
          if (!session) { session = d.session; lastSeq = 0; showBanner(d.session.operator); }
          else { session = d.session; }
          runCommand(d.command);
        } else if (session) {
          session = null;
          hideBanner();
        }
      } catch (e) {
        /* Signed out, offline, or the endpoint is unavailable. Fall back to the
           slow cadence rather than hammering it, and never surface an error:
           nobody looking at a timesheet needs to hear that a support channel
           they are not using is unreachable. */
        if (e && /signed in/i.test(e.message || "")) stopped = true;
      }
      schedule();
    }

    function schedule() {
      clearTimeout(timer);
      if (stopped) return;
      timer = setTimeout(tick, session ? LIVE_MS : IDLE_MS);
    }

    function start() {
      if (isSignInPage()) return;
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") { clearTimeout(timer); timer = setTimeout(tick, 250); }
      });
      timer = setTimeout(tick, 1500);   // let the page finish loading first
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  })();
})();
