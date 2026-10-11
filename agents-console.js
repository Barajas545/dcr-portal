/* DCR Agents — the web console's shell (agents-console.html).

   Every admin manages the DCR Agents running on the DCR server computer from
   here, with their own portal account. The page cannot reach that computer:
   it posts a request to the portal (?action=console), the server picks it up
   on its next poll, runs it with the same Python the desktop uses, and posts
   the answer, which this page reads back. So every call is "Working…" for a
   few seconds, and the server can be offline, in Standby, or busy — the shell
   keeps all of that in one place so the modules only ask for data.

   What the shell does:
   - Admin only: anybody else sees "Only an Admin can manage the DCR Agents."
     and nothing is loaded. The portal checks again on every request, and the
     DCR server checks every method and every argument on its own; nothing
     here is a guard, only manners.
   - The status bar and the banners, from GET ?action=console&server=1 every
     30 seconds (and right after a call fails): online, paused, offline,
     Standby, not set up, another computer also running the DCR Agents.
   - The tabs: each console-*.js file calls DCRConsole.register({id, title,
     order, render(el, ctx), leave?, autoRefresh?}) and the router (#/<tab>/
     <parts…>?<query>) gives render a fresh, empty element every time.
   - ctx.rpc(method, args, opts): POST → poll the id every second for 10 s,
     then every 2 s; a request nobody picked up in 60 s is cancelled ("the DCR
     server is busy"); past its timeout it is answered "timeout" and still
     followed in the background (up to twice the timeout) with a toast for the
     outcome. At most 4 requests in flight; the ids are kept in this tab's
     sessionStorage so a reload picks them up again.
   - ctx.act(method, args): the confirm flow for the methods that ask first.
     The DCR server writes the question (the desktop's own words); this page
     only shows it, then calls again with confirmed:true.
   - Shared drawing helpers (ctx.ui), toasts, a working line, the print host.

   Everything a server sends is drawn through DCR.esc; controls that write
   carry data-act and are greyed while nothing can be changed. Links are only
   https: or relative. No inline handlers anywhere. */
(function () {
  "use strict";

  var EP = "/api/portal?action=console";
  var TEST = !!window.__DCR_CONSOLE_TEST__;
  var FAST_MS = 1000, SLOW_MS = 2000, FAST_FOR_MS = 10000;   // poll an id every second for 10 s, then every 2 s
  var PICKUP_CANCEL_MS = 60000;      // still waiting for the server after this: cancel it
  var PICKUP_SLACK_S = 30;           // added to a method's own timeout for the pick-up
  var DEFAULT_TIMEOUT_S = 60;        // a method this page has no timeout for
  var NET_GIVEUP_MS = 60000;         // the connection gone this long while following a request
  var MAX_INFLIGHT = 4;
  var STATUS_EVERY_MS = 30000;
  var PAUSE_NOTE_MS = 180000;        // a pause or resume from here is believed this long, until the heartbeat says so
  var WAIT_WORDS_MS = 10000;         // still not picked up after this: the working line says the server is busy
  var IDLE_MS = 10 * 60000;          // nobody has touched the page this long: auto refreshes stop until someone does
  var RATE_RETRY_MAX_S = 30;         // a read refused for the rate is tried once more after at most this wait
  var STARTING_MS = 3 * 60000;       // a record this fresh that still says Standby / not running is a start
  var PENDING_KEY = "dcr.agentsConsole.pending.v1";
  var METHODS_KEY = "dcr.agentsConsole.methods.v1";
  var NAME_RE = /^[A-Za-z0-9_]{1,40}$/;

  var ADMIN_ONLY = "Only an Admin can manage the DCR Agents.";
  var UPDATE_WORDS = "Update DCR Agents on the server computer to use this";
  var BUSY_WORDS = "The DCR server is busy — try again in a minute.";
  var NETWORK_WORDS = "Can't reach the portal — check the connection and try again.";
  var AI_WORDS = "Claude is working… this can take a minute";
  var WORKING = "Working…";
  /* What the web says for a code when the server's own message is missing
     (console-spec §6.1.0). */
  var CODE_WORDS = {
    unknown_method: "The DCR server's DCR Agents does not know that yet — update it on the server computer.",
    unconfirmed: "Not done — it needs a confirmation.",
    changed: "Someone changed this since you opened it — reload and try again.",
    standby: "The DCR server computer is in Standby.",
    timeout: "This is taking too long on the DCR server; it may still finish — check before trying again.",
    busy: BUSY_WORDS,
    network: NETWORK_WORDS,
    offline: "The DCR server is offline — nothing can be changed until it is back.",
    not_set_up: "The DCR server has not set up remote management yet.",
    forbidden: ADMIN_ONLY,
    expired: "The DCR server did not pick this up — it may be off or in Standby.",
    lost: "The DCR server stopped while working on this — check before trying again.",
    cancelled: "That was cancelled before the DCR server started it.",
    rate: "Too many requests in a short time — wait a moment and try again.",
    too_big: "That is too much to send to the DCR server at once.",
    failed: "Something went wrong on the DCR server.",
  };
  var TONES = { good: 1, warn: 1, bad: 1, dim: 1, info: 1 };
  var DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  /* Time, behind one object so the page tests can drive it. */
  var clock = {
    now: function () { return Date.now(); },
    setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
    clearTimeout: function (id) { clearTimeout(id); },
  };

  var defs = {};
  var booted = false;
  var profile = null;
  var server = null;            // the last ?action=console&server=1 answer
  var serverErr = null;         // why it could not be read, when it could not
  var statusTimer = null, statusInflight = null, refreshTimer = null;
  var readyResolve, statusReady = new Promise(function (r) { readyResolve = r; });
  var methods = null;           // name → {kind, confirm, lane, timeout, ai, exclusive, area} once console.methods answered
  var info = null;              // the console.methods answer itself (version, host, ai)
  var methodsLoading = false;
  var pausedNote = null;        // {paused, at}
  var lastCan = false;
  var gated = false;            // shown the Admin-only refusal: nothing more is asked
  var current = null;           // {def, el, route, gen}
  var gen = 0;
  var autoTimer = null;
  var subs = [];                // onServer subscriptions
  var handlers = {};            // table rows and pagers drawn by ctx.ui, by id
  var seq = 0;
  var inflight = 0, queue = [];
  var active = [];              // calls being worked on, for the status bar's working line
  var transport = relayRpc;     // the page tests swap it (DCRConsole._test.setRpc)

  function $(id) { return document.getElementById(id); }
  function esc(v) { return DCR.esc(v); }
  function text(v) { return v === null || v === undefined ? "" : String(v); }

  function err(code, message, extra) {
    var e = new Error(text(message) || CODE_WORDS[code] || CODE_WORDS.failed);
    e.code = code;
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    return e;
  }
  /* Anything thrown, as an Error with a code. */
  function asErr(e) {
    if (e && e.code && e.message) return e;
    if (e && e.code) return err(e.code, e.message);
    return err("failed", (e && e.message) || "");
  }
  /* A portal refusal (DCR.api throws with .status and .data) in the codes the
     modules know. */
  function fromHttp(e) {
    if (!e || !e.status) return err("network", NETWORK_WORDS);
    var d = e.data || {};
    var map = { forbidden: "forbidden", bad_request: "bad_args", too_big: "too_big", rate: "rate", too_many: "rate",
      not_set_up: "not_set_up", not_found: "not_found" };
    var code = map[text(d.code)] ||
      (e.status === 401 || e.status === 403 ? "forbidden" : e.status === 429 ? "rate" : e.status === 503 ? "not_set_up"
        : e.status === 413 ? "too_big" : "failed");
    var x = err(code, d.error || e.message, { status: e.status });
    if (d.retryAfter) x.retryAfter = Number(d.retryAfter) || 0;
    return x;
  }

  /* ── the server's state ─────────────────────────────────────────────── */

  function agoWords(mins) {
    if (mins === null || mins === undefined || !isFinite(Number(mins))) return "never";
    mins = Number(mins);
    if (mins < 1) return "just now";
    if (mins < 60) return Math.round(mins) + " min ago";
    if (mins < 1440) return Math.round(mins / 60) + " h ago";
    var d = Math.round(mins / 1440);
    return d + (d === 1 ? " day ago" : " days ago");
  }

  function isPaused(s) {
    var srv = s && s.server;
    if (pausedNote && clock.now() - pausedNote.at < PAUSE_NOTE_MS) return pausedNote.paused;
    return !!(srv && srv.paused);
  }

  /* What the last status means: {code, tone, text, canAct}. code is "online"
     or "paused" when the console can be used, else the reason it cannot
     (offline, standby, not_set_up, network, forbidden, unknown). */
  function serverState(s, e) {
    if (e) {
      return e.code === "forbidden" ? { code: "forbidden", tone: "bad", text: ADMIN_ONLY, canAct: false }
        : { code: "network", tone: "bad", text: "Can't reach the portal right now — this page keeps trying.", canAct: false };
    }
    if (!s) return { code: "unknown", tone: "dim", text: "Checking the DCR server…", canAct: false };
    var srv = s.server;
    if (!srv) {
      return { code: "offline", tone: "bad", canAct: false,
        text: "No DCR server has reported yet — start DCR Agents on the DCR server computer." };
    }
    var host = text(srv.host) || "The DCR server";
    var STARTING = { code: "starting", tone: "warn", canAct: false, text: "The DCR server is starting — try again in a minute." };
    if (srv.standby) {
      /* the lease is its own: the first beat after a start said Standby
         before the portal answered — a start, not a stop */
      if (srv.online && s.lease && s.lease.host === srv.host) return STARTING;
      return { code: "standby", tone: "bad", canAct: false,
        text: host + " is waiting in Standby. To make it the server, press \u201cMake this computer the DCR server\u201d on its Dashboard." };
    }
    if (!srv.online) {
      var mins = srv.minutesAgo;
      return { code: "offline", tone: "bad", canAct: false,
        text: mins === null || mins === undefined || !isFinite(Number(mins))
          ? "The DCR server has not reported yet. Nothing can be changed until it does."
          : "The DCR server has not reported for " + agoWords(mins).replace(/ ago$/, "") + ". Nothing can be changed until it is back." };
    }
    if (!s.ready) return { code: "not_set_up", tone: "warn", text: "The DCR server has not set up remote management yet.", canAct: false };
    if (!srv.consoleOn) {
      /* never polled yet, or polled moments ago: it is starting */
      var polled = srv.consoleAt ? Date.parse(srv.consoleAt) : NaN;
      if (srv.proto && (!isFinite(polled) || clock.now() - polled < STARTING_MS)) return STARTING;
      return { code: "offline", tone: "warn", canAct: false,
        text: srv.proto ? "The DCR server's remote management is not running right now — it starts again by itself."
          : "The DCR server runs an older DCR Agents" + (srv.version ? " (" + text(srv.version) + ")" : "") +
            " that cannot be managed from here — update it on the server computer." };
    }
    if (isPaused(s)) return { code: "paused", tone: "warn", text: "Everything is paused on the DCR server.", canAct: true };
    return { code: "online", tone: "good", text: "", canAct: true };
  }

  function canAct() { return serverState(server, serverErr).canAct; }
  function gateError() {
    var st = serverState(server, serverErr);
    if (st.canAct) return null;
    var code = st.code === "unknown" ? "offline" : st.code;
    return err(code, st.text);
  }

  /* Others still sending beside the server: a fresh, not-Standby record that
     is neither the server nor the lease holder. */
  function alsoRunning(s) {
    if (!s || !s.server) return [];
    var lease = s.lease && s.lease.host;
    return (s.others || []).filter(function (o) {
      return o && o.host && o.host !== s.server.host && o.host !== lease && !o.standby &&
        Number(o.minutesAgo) <= 10;
    }).map(function (o) { return text(o.host); });
  }

  function paintStatus() {
    var st = serverState(server, serverErr);
    var dot = $("cDot"), line = $("cStatusText");
    if (dot) dot.className = "c-dot " + (st.code === "online" ? "good" : st.code === "paused" || st.code === "not_set_up" || st.code === "starting" ? "warn"
      : st.code === "unknown" ? "" : "bad");
    if (!line) return;
    var srv = server && server.server;
    if (serverErr) {
      line.innerHTML = esc(st.text);
    } else if (!server) {
      line.innerHTML = esc(st.text);
    } else if (!srv) {
      line.innerHTML = "No DCR server has reported yet";
    } else {
      line.innerHTML = "DCR server <span class=\"c-st-host\">" + esc(srv.host) + "</span>" +
        (srv.version ? " · v" + esc(srv.version) : "") + " · last seen " + esc(agoWords(srv.minutesAgo)) +
        (st.code === "starting" ? " " + chip("Starting", "warn") : srv.standby ? " " + chip("Standby", "bad") : st.code === "paused" ? " " + chip("Paused", "warn")
          : !srv.online ? " " + chip("Offline", "bad") : "");
    }
  }

  function paintBanners() {
    var host = $("cBanners");
    if (!host) return;
    var out = [];
    var st = serverState(server, serverErr);
    var srv = server && server.server;
    if (serverErr || (server && !st.canAct)) out.push({ tone: st.tone === "warn" ? "warn" : "bad", text: st.text });
    if (server && srv && st.code === "paused") {
      out.push({ tone: "warn", text: "Everything is paused on the DCR server — no agent sends and no assistant answers until someone resumes.",
        button: '<button type="button" class="c-btn sm" id="cResume" data-act data-method="dashboard.pause">Resume</button>' });
    }
    alsoRunning(server).forEach(function (h) {
      out.push({ tone: "warn", text: h + " is also running the DCR Agents — stop it there." });
    });
    host.innerHTML = out.map(function (b) {
      return '<div class="c-banner ' + b.tone + '" role="alert"><span>' + esc(b.text) + "</span>" + (b.button || "") + "</div>";
    }).join("");
  }

  function paintWorking() {
    var w = $("cWorking");
    if (!w) return;
    if (!active.length) { w.textContent = ""; return; }
    var ai = active.some(function (a) { return a.ai; });
    var last = active[active.length - 1];
    w.textContent = ai ? AI_WORDS : (last.text || WORKING) + (active.length > 1 ? " (" + active.length + ")" : "");
  }

  function afterServer() {
    paintStatus();
    paintBanners();
    applyGates();
    var can = canAct();
    if (can && methods === null && !methodsLoading) loadMethods();
    subs.slice().forEach(function (s) { try { s.fn(server); } catch (e) { /* a module's own problem */ } });
    if (can && !lastCan && current && current.el && current.el.querySelector && current.el.querySelector("[data-c-retry]")) {
      rerender();                      // a tab that could not load while the server was away tries again
    }
    lastCan = can;
  }

  function refreshServer() {
    if (gated) return Promise.resolve();
    if (statusInflight) return statusInflight;
    clock.clearTimeout(statusTimer);
    statusInflight = DCR.api(EP + "&server=1").then(function (s) {
      server = s || null;
      serverErr = null;
    }, function (e) {
      var x = fromHttp(e);
      serverErr = x;
      if (x.code === "forbidden") showGate();
    }).then(function () {
      statusInflight = null;
      readyResolve();
      afterServer();
      if (!(serverErr && serverErr.code === "forbidden")) {
        statusTimer = clock.setTimeout(refreshServer, STATUS_EVERY_MS);
      }
    });
    return statusInflight;
  }
  function refreshSoon() {
    clock.clearTimeout(refreshTimer);
    refreshTimer = clock.setTimeout(refreshServer, 1500);
  }

  /* The server's method list, asked once per server build: it is kept in
     this tab for the same host and version, so moving between pages does
     not spend one of the admin's requests a minute on it every time. */
  function useMethods(d) {
    info = d || null;
    var map = {};
    ((d && d.methods) || []).forEach(function (m) { if (m && m.name) map[m.name] = m; });
    methods = map;
    applyGates();
  }
  function loadMethods() {
    var srv = (server && server.server) || {};
    try {
      var kept = JSON.parse(sessionStorage.getItem(METHODS_KEY) || "null");
      if (kept && kept.host === srv.host && kept.version === srv.version && kept.data && Array.isArray(kept.data.methods)) {
        useMethods(kept.data);
        return Promise.resolve();
      }
    } catch (e) { /* asked again below */ }
    methodsLoading = true;
    return rpc("console.methods", {}, { quiet: true }).then(function (d) {
      useMethods(d);
      try { sessionStorage.setItem(METHODS_KEY, JSON.stringify({ host: srv.host, version: srv.version, data: d })); } catch (e) { /* not kept */ }
    }, function () { /* asked again when the server is next seen online */ }).then(function () { methodsLoading = false; });
  }

  function has(name) { return methods === null ? true : Object.prototype.hasOwnProperty.call(methods, name); }
  function methodOf(name) { return methods && methods[name] ? methods[name] : null; }

  function notePaused(v) {
    pausedNote = { paused: !!v, at: clock.now() };
    afterServer();
  }

  /* ── calls to the DCR server ────────────────────────────────────────── */

  function sleep(ms) { return new Promise(function (r) { clock.setTimeout(r, ms); }); }

  function pendingAll() {
    try { var v = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "[]"); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function pendingSave(list) {
    try {
      if (list.length) sessionStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-20)));
      else sessionStorage.removeItem(PENDING_KEY);
    } catch (e) { /* a private window: a reload just forgets them */ }
  }
  function remember(id, method, at, limit) {
    var list = pendingAll().filter(function (p) { return p.id !== id; });
    var m = methodOf(method);
    list.push({ id: id, method: method, at: at, limit: limit, kind: m && m.kind === "R" ? "R" : "W" });
    pendingSave(list);
  }
  function forget(id) { pendingSave(pendingAll().filter(function (p) { return p.id !== id; })); }

  function relayRpc(method, args, opts) {
    return new Promise(function (resolve, reject) {
      queue.push({ method: method, args: args, opts: opts, resolve: resolve, reject: reject });
      pump();
    });
  }
  function pump() {
    while (inflight < MAX_INFLIGHT && queue.length) {
      var job = queue.shift();
      inflight++;
      runJob(job).then(job.resolve, job.reject).then(function () { inflight--; pump(); });
    }
  }

  async function runJob(job) {
    var m = methodOf(job.method);
    var limitS = Number(job.opts.timeout) || ((m ? Number(m.timeout) || DEFAULT_TIMEOUT_S : DEFAULT_TIMEOUT_S) + PICKUP_SLACK_S);
    var limit = limitS * 1000;
    var t0 = clock.now();
    var posted;
    for (var attempt = 1; ; attempt++) {
      try {
        posted = await DCR.api(EP, { method: "POST", body: { method: job.method, args: job.args } });
        break;
      } catch (e) {
        var x = fromHttp(e);
        /* A read the page asked for by itself (or a list the admin is
           looking at) waits out the portal's retryAfter and is tried once
           more; a change is never sent twice without the admin. */
        if (x.code === "rate" && attempt === 1 && readOnly(job.method) && x.retryAfter > 0 && x.retryAfter <= RATE_RETRY_MAX_S) {
          if (job.opts && typeof job.opts.onWait === "function") job.opts.onWait("Waiting a moment — many requests just now…");
          await sleep(x.retryAfter * 1000);
          continue;
        }
        if (x.code === "rate" && x.retryAfter > 0) x.message = "Too many requests in a short time — try again in " + plural(Math.ceil(x.retryAfter), "second") + ".";
        throw x;
      }
    }
    var id = text(posted && posted.id);
    if (!id) throw err("failed", "The portal did not take that request.");
    remember(id, job.method, t0, limit);
    return follow(id, job.method, t0, limit, false, readOnly(job.method), job.opts && job.opts.onWait);
  }

  /* Read one request until it is answered. In the background (after a
     timeout, or after a reload) it goes on up to twice the timeout. */
  function readOnly(method) { var m = methodOf(method); return !!(m && m.kind === "R"); }
  var FINISHED_EARLIER = { finishedEarlier: true };
  async function follow(id, method, t0, limit, background, quietRead, onWait) {
    var cancelTried = false, netSince = 0, saidWait = false;
    for (;;) {
      await sleep(clock.now() - t0 < FAST_FOR_MS ? FAST_MS : SLOW_MS);
      var elapsed = clock.now() - t0;
      var r;
      try {
        r = await DCR.api(EP + "&id=" + encodeURIComponent(id));
        netSince = 0;
      } catch (e) {
        if (!e || !e.status) {                        // the connection: keep asking for a while
          if (!netSince) netSince = clock.now();
          if (clock.now() - netSince >= NET_GIVEUP_MS) { forget(id); throw err("network", NETWORK_WORDS); }
          continue;
        }
        forget(id);
        /* followed again after a reload: the portal forgets a request ten
           minutes after it finished — it finished, it did not fail */
        if (background && e.status === 404) return FINISHED_EARLIER;
        throw fromHttp(e);
      }
      var st = text(r && r.status);
      if (st === "done") { forget(id); return r.result === undefined ? null : r.result; }
      if (st === "error" || st === "expired" || st === "cancelled") {
        forget(id);
        var er = (r && r.error) || {};
        throw err(text(er.code) || (st === "error" ? "failed" : st), er.message);
      }
      if (st === "new") {
        if (!saidWait && elapsed >= WAIT_WORDS_MS && typeof onWait === "function") {
          saidWait = true;
          onWait("Waiting for the DCR server — it is busy with other actions…");
        }
        if (!cancelTried && elapsed >= PICKUP_CANCEL_MS) {
          cancelTried = true;
          var c = null;
          try { c = await DCR.api(EP, { method: "POST", body: { cancel: id } }); } catch (e) { c = null; }
          if (c && c.ok) { forget(id); throw err("busy", BUSY_WORDS); }
          /* the server took it a moment ago (or it already finished): keep reading it */
        }
        continue;
      }
      if (st === "taken") {
        if (!background && elapsed > limit) {
          followLater(id, method, t0, limit, quietRead);
          throw err("timeout", CODE_WORDS.timeout);
        }
        if (background && elapsed > 2 * limit) { forget(id); throw err("timeout", CODE_WORDS.timeout); }
      }
    }
  }

  function outcomeWords(data) {
    if (data && typeof data === "object") {
      if (typeof data.words === "string" && data.words) return data.words;
      if (typeof data.summary === "string" && data.summary) return data.summary;
    }
    return "";
  }
  /* A request nobody is waiting on any more (past its timeout, or from
     before a reload), followed to the end. What a change did is said in a
     toast; a read that arrives late is simply dropped — the tab can be
     reloaded. */
  function followLater(id, method, t0, limit, quietRead) {
    follow(id, method, t0, limit, true, quietRead).then(function (data) {
      if (quietRead) return;
      if (data === FINISHED_EARLIER) { toast("That finished on the DCR server a while ago — see Activity → Remote actions."); return; }
      var w = outcomeWords(data);
      toast(w ? "Finished on the DCR server: " + w : "Finished on the DCR server.");
    }, function (e) {
      if (quietRead) return;
      toast("Not done on the DCR server: " + asErr(e).message, { bad: true });
    });
  }
  /* After a reload: the requests this tab was waiting on, followed again. */
  function resumePending() {
    var now = clock.now();
    pendingAll().forEach(function (p) {
      if (!p || !p.id || !(now - Number(p.at) < 2 * Number(p.limit) + 60000)) { if (p && p.id) forget(p.id); return; }
      followLater(String(p.id), String(p.method || ""), Number(p.at), Number(p.limit), p.kind === "R");
    });
  }

  /* ctx.rpc: the data of a method, or a rejection with {code, message}. */
  function rpc(method, args, opts) {
    opts = opts || {};
    args = args || {};
    var m = methodOf(method);
    var rec = { method: method, ai: !!(m && m.ai), text: opts.text || "" };
    var callOpts = {};
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) callOpts[k] = opts[k];
    callOpts.onWait = function (words) { rec.text = words; rec.ai = false; paintWorking(); };
    return statusReady.then(function () {
      if (!opts.force) {
        var g = gateError();
        if (g) throw g;
      }
      active.push(rec);
      paintWorking();
      return Promise.resolve().then(function () { return transport(method, args, callOpts); });
    }).then(function (data) {
      done();
      return data;
    }, function (e) {
      done();
      var x = asErr(e);
      if (!opts.quiet) toast(x.message, { bad: true });
      refreshSoon();                       // after any failure, ask how the server is doing
      throw x;
    });
    function done() {
      var i = active.indexOf(rec);
      if (i >= 0) { active.splice(i, 1); paintWorking(); }
    }
  }

  /* ctx.act: a method that may ask first. The server answers {confirm:{…}}
     without confirmed:true; the question is shown, and only a yes calls it
     again — with confirmed:true and any ticked extra boxes. null = declined. */
  function act(method, args, opts) {
    args = args || {};
    return rpc(method, args, opts).then(function (data) {
      if (!data || typeof data !== "object" || !data.confirm || typeof data.confirm !== "object") return data;
      var c = data.confirm;
      return askConfirm(c).then(function (extra) {
        if (!extra) return null;
        var next = {};
        for (var k in args) if (Object.prototype.hasOwnProperty.call(args, k)) next[k] = args[k];
        for (var x in extra) if (Object.prototype.hasOwnProperty.call(extra, x)) next[x] = extra[x];
        next.confirmed = true;
        return rpc(method, next, opts);
      });
    });
  }
  function askConfirm(c) {
    var fields = (Array.isArray(c.extra) ? c.extra : []).filter(function (x) {
      return x && x.type === "checkbox" && NAME_RE.test(text(x.name));
    }).map(function (x) { return { name: text(x.name), label: text(x.label), type: "checkbox", value: !!x.value }; });
    return Promise.resolve(DCR.modal({
      title: text(c.title), message: text(c.question), okText: text(c.ok_text) || "OK", danger: !!c.danger, fields: fields,
    })).then(function (res) {
      if (!res) return null;
      var extra = {};
      fields.forEach(function (f) { extra[f.name] = !!(res && typeof res === "object" && res[f.name] === true); });
      if (!c.twice) return extra;
      return Promise.resolve(DCR.confirm(text(c.twice), { title: text(c.title), okText: text(c.ok_text) || "Yes", danger: !!c.danger }))
        .then(function (ok) { return ok ? extra : null; });
    });
  }

  /* ── toasts, working lines, buttons ─────────────────────────────────── */

  function toast(words, o) {
    var host = $("cToasts");
    if (!host || !document.createElement) return;
    var t = document.createElement("div");
    t.className = "c-toast" + (o && o.bad ? " bad" : "");
    t.textContent = text(words);
    host.appendChild(t);
    clock.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, o && o.bad ? 9000 : 5000);
  }

  /* A working line with the seconds counting, appended to el; done() takes
     it away. */
  function busy(el, words) {
    if (!el || !document.createElement) return function () {};
    var line = document.createElement("div");
    line.className = "c-busy";
    line.setAttribute("role", "status");
    var t0 = clock.now(), timer = null, label = text(words) || WORKING;
    function paint() {
      var s = Math.floor((clock.now() - t0) / 1000);
      line.textContent = label + (s >= 2 ? " " + s + " s" : "");
      timer = clock.setTimeout(paint, 1000);
    }
    paint();
    el.appendChild(line);
    return function () {
      clock.clearTimeout(timer);
      if (line.parentNode) line.parentNode.removeChild(line);
    };
  }

  /* A button that is working: greyed, "Working…" (or Claude's line for a
     method that may call Claude), back to itself when fn's promise settles. */
  function press(btn, fn, words) {
    if (btn && btn.disabled) return Promise.resolve(null);
    var saved = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.textContent = text(words) || WORKING;
    }
    function back() {
      if (!btn) return;
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.innerHTML = saved;
      applyGates();
    }
    return Promise.resolve().then(fn).then(function (v) { back(); return v; }, function (e) { back(); throw e; });
  }

  /* ── greying what cannot be used ────────────────────────────────────── */

  function each(root, sel, fn) {
    if (!root || !root.querySelectorAll) return;
    var list = root.querySelectorAll(sel);
    for (var i = 0; i < list.length; i++) fn(list[i]);
  }
  function applyGates() {
    var can = canAct();
    if (document.body && document.body.classList) document.body.classList.toggle("c-offline", !can);
    var root = $("cApp") || document;
    each(root, "[data-act]", function (el) {
      if (!can) {
        if (!el.disabled && !el.getAttribute("data-c-off")) { el.disabled = true; el.setAttribute("data-c-off", "1"); }
      } else if (el.getAttribute("data-c-off")) {
        el.removeAttribute("data-c-off");
        if (!el.getAttribute("data-c-nom")) el.disabled = false;
      }
    });
    each(root, "[data-method]", function (el) {
      var name = el.getAttribute("data-method");
      if (!has(name)) {
        if (!el.getAttribute("data-c-nom")) {
          el.setAttribute("data-c-nom", "1");
          el.setAttribute("data-c-title", el.getAttribute("title") || "");
          el.disabled = true;
          el.setAttribute("title", UPDATE_WORDS);
        }
      } else if (el.getAttribute("data-c-nom")) {
        el.removeAttribute("data-c-nom");
        el.setAttribute("title", el.getAttribute("data-c-title") || "");
        el.removeAttribute("data-c-title");
        if (!el.getAttribute("data-c-off")) el.disabled = false;
      }
    });
  }
  var gateQueued = false;
  function gateSoon() {
    if (gateQueued) return;
    gateQueued = true;
    Promise.resolve().then(function () { gateQueued = false; applyGates(); });
  }

  /* ── drawing helpers (ctx.ui) — every value escaped ─────────────────── */

  function chip(words, tone) {
    return '<span class="c-chip' + (TONES[tone] ? " " + tone : "") + '">' + esc(words) + "</span>";
  }
  function empty(words) { return '<div class="c-empty">' + esc(words || "Nothing here.") + "</div>"; }
  function plural(n, word, many) {
    n = Number(n) || 0;
    return n + " " + (n === 1 ? word : many || word + "s");
  }
  function parseWhen(iso) {
    if (!iso) return null;
    var d = new Date(String(iso));
    return isNaN(d.getTime()) ? null : d;
  }
  function when(iso) {
    var d = parseWhen(iso);
    if (!d) return "";
    return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function day(iso) {
    var s = text(iso);
    var d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T12:00:00") : parseWhen(s);
    if (!d || isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  function ago(iso) {
    var d = parseWhen(iso);
    if (!d) return "";
    return agoWords((clock.now() - d.getTime()) / 60000);
  }
  /* A link target that is safe to draw: https:, or a page of this portal. */
  function href(u) {
    var s = text(u).trim();
    if (/^https:\/\//i.test(s)) return s;
    if (/^[a-z0-9-]{1,60}\.html([?#][^\s"'<>]*)?$/i.test(s)) return s;
    if (/^#\/[^\s"'<>]*$/.test(s)) return s;
    return "";
  }
  function kv(pairs) {
    return '<dl class="c-kv">' + (pairs || []).filter(Boolean).map(function (p) {
      var v = p[1];
      var body = v && typeof v === "object" && typeof v.html === "string" ? v.html : esc(v);
      return "<dt>" + esc(p[0]) + "</dt><dd>" + body + "</dd>";
    }).join("") + "</dl>";
  }
  function section(title, html, o) {
    o = o || {};
    return '<details class="c-sec"' + (o.id ? ' id="' + esc(o.id) + '"' : "") + (o.open ? " open" : "") +
      "><summary>" + esc(title) + '</summary><div class="c-sec-body">' + (html || "") + "</div></details>";
  }
  function table(o) {
    o = o || {};
    var cols = o.cols || [], rows = o.rows || [];
    if (!rows.length) return empty(o.empty || "Nothing here.");
    var tid = "cT" + (++seq);
    if (typeof o.onRow === "function") handlers[tid] = { kind: "row", fn: o.onRow, rows: rows, gen: gen };
    var cls = function (c) { return c.cls ? ' class="' + esc(c.cls) + '"' : ""; };
    return '<div class="c-tablewrap"><table class="c-table' + (o.onRow ? " c-click" : "") + '" id="' + tid + '" data-c-table="' + tid + '">' +
      "<thead><tr>" + cols.map(function (c) { return "<th" + cls(c) + ' scope="col">' + esc(c.label) + "</th>"; }).join("") + "</tr></thead><tbody>" +
      rows.map(function (r, i) {
        return '<tr data-row="' + i + '"' + (o.onRow ? ' tabindex="0"' : "") + ">" + cols.map(function (c) {
          var cell = typeof c.render === "function" ? c.render(r, i) : esc(r ? r[c.key] : "");
          return '<td data-label="' + esc(c.label) + '"' + cls(c) + ">" + (cell === undefined || cell === null ? "" : cell) + "</td>";
        }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>";
  }
  function pager(page, onPage) {
    page = page || {};
    var offset = Number(page.offset) || 0, limit = Number(page.limit) || 50, total = Number(page.total) || 0;
    var next = page.next === null || page.next === undefined ? null : Number(page.next);
    if (!total && !offset && next === null) return "";
    var pid = "cP" + (++seq);
    if (typeof onPage === "function") handlers[pid] = { kind: "page", fn: onPage, gen: gen };
    var prev = offset > 0 ? Math.max(0, offset - limit) : null;
    var last = Math.min(total || offset + limit, offset + limit);
    return '<div class="c-pager" data-c-pager="' + pid + '">' +
      '<button type="button" class="c-btn ghost sm" data-c-page="' + (prev === null ? "" : prev) + '"' + (prev === null ? " disabled" : "") + ">‹ Previous</button>" +
      "<span>" + esc((total ? (offset + 1) + "–" + last + " of " + total : "")) + "</span>" +
      '<button type="button" class="c-btn ghost sm" data-c-page="' + (next === null ? "" : next) + '"' + (next === null ? " disabled" : "") + ">Next ›</button></div>";
  }
  function failed(e, o) {
    var x = asErr(e);
    var title = (o && o.title) || (x.code === "offline" || x.code === "standby" || x.code === "not_set_up" || x.code === "network"
      ? "The DCR server is not available right now." : x.code === "not_found" ? "Not found."
        : x.code === "rate" ? "Too many requests just now." : "That did not work.");
    return '<div class="c-error" role="alert"><b>' + esc(title) + "</b><span>" + esc(x.message) + "</span>" +
      (o && o.retry === false ? "" : '<div class="c-actions"><button type="button" class="c-btn ghost sm" data-c-retry>Try again</button></div>') +
      "</div>";
  }

  /* ctx.ui.form: {html, read(root) → values, id(name) → the element's id}.
     Field types: text textarea number select checkbox time date days list. */
  function form(spec) {
    var n = ++seq;
    var fields = (spec && spec.fields) || [];
    var idOf = function (name) { return "cf" + n + "-" + String(name).replace(/[^A-Za-z0-9_-]/g, "_"); };
    return {
      html: '<div class="c-form">' + fields.map(function (f) { return fieldHtml(f, idOf(f.name)); }).join("") + "</div>",
      id: idOf,
      read: function (root) {
        var out = {};
        fields.forEach(function (f) { out[f.name] = readField(f, idOf(f.name), root); });
        return out;
      },
    };
  }
  function find(root, id) {
    var el = null;
    if (root && root.querySelector) { try { el = root.querySelector("#" + id); } catch (e) { el = null; } }
    return el || $(id);
  }
  function attrs(f) {
    var a = "";
    if (f.maxLength) a += ' maxlength="' + esc(f.maxLength) + '"';
    if (f.placeholder) a += ' placeholder="' + esc(f.placeholder) + '"';
    if (f.min !== undefined && f.min !== null) a += ' min="' + esc(f.min) + '"';
    if (f.max !== undefined && f.max !== null) a += ' max="' + esc(f.max) + '"';
    if (f.step) a += ' step="' + esc(f.step) + '"';
    if (f.disabled) a += " disabled";
    return a;
  }
  function fieldHtml(f, id) {
    var v = f.value;
    var help = f.help ? '<div class="c-help" id="' + id + '-help">' + esc(f.help) + "</div>" : "";
    var common = ' id="' + id + '" name="' + esc(f.name) + '"' + (f.help ? ' aria-describedby="' + id + '-help"' : "") + attrs(f);
    var lab = f.label ? '<label class="c-label" for="' + id + '">' + esc(f.label) + "</label>" : "";
    var control;
    switch (f.type) {
      case "textarea":
        control = "<textarea" + common + ' rows="' + (Number(f.rows) || 4) + '">' + esc(v) + "</textarea>";
        break;
      case "number":
        control = '<input type="number" inputmode="decimal"' + common + ' value="' + esc(v === null || v === undefined ? "" : v) + '">';
        break;
      case "select":
        control = "<select" + common + ">" + (f.options || []).map(function (o) {
          var ov = o && typeof o === "object" ? o.value : o, ol = o && typeof o === "object" ? (o.label === undefined ? o.value : o.label) : o;
          return '<option value="' + esc(ov) + '"' + (String(ov) === String(v) ? " selected" : "") + ">" + esc(ol) + "</option>";
        }).join("") + "</select>";
        break;
      case "checkbox":
        return '<div class="c-field" id="' + id + '-row"><label class="c-check"><input type="checkbox"' + common + (v ? " checked" : "") +
          "> " + esc(f.label) + "</label>" + help + "</div>";
      case "time":
      case "date":
        control = '<input type="' + f.type + '"' + common + ' value="' + esc(v || "") + '">';
        break;
      case "days":
        var on = daysOf(v);
        control = '<div class="c-days" role="group" aria-label="' + esc(f.label || "Days") + '">' + DAYS.map(function (d, i) {
          return '<label><input type="checkbox" id="' + id + "-" + i + '"' + (on.indexOf(i) >= 0 ? " checked" : "") +
            (f.disabled ? " disabled" : "") + "> " + d + "</label>";
        }).join("") + "</div>";
        lab = f.label ? '<span class="c-label">' + esc(f.label) + "</span>" : "";
        break;
      case "list":
        control = '<input type="text"' + common + ' value="' + esc(Array.isArray(v) ? v.join(", ") : text(v)) + '">';
        break;
      default:
        control = '<input type="text"' + common + ' value="' + esc(v) + '">';
    }
    if (f.suffix) control = '<div class="c-inline">' + control + "<span>" + esc(f.suffix) + "</span></div>";
    return '<div class="c-field" id="' + id + '-row">' + lab + control + help + "</div>";
  }
  function daysOf(v) {
    if (v === "weekdays") return [0, 1, 2, 3, 4];
    if (v === "everyday") return [0, 1, 2, 3, 4, 5, 6];
    return Array.isArray(v) ? v.map(Number) : [];
  }
  function readField(f, id, root) {
    if (f.type === "days") {
      var out = [];
      for (var i = 0; i < 7; i++) { var b = find(root, id + "-" + i); if (b && b.checked) out.push(i); }
      return out;
    }
    var el = find(root, id);
    if (!el) return f.type === "checkbox" ? false : f.type === "list" ? [] : null;
    if (f.type === "checkbox") return !!el.checked;
    if (f.type === "number") {
      var s = text(el.value).trim();
      return s === "" ? null : Number(s);
    }
    if (f.type === "list") {
      return text(el.value).split(/[,\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
    }
    if (f.type === "text") return text(el.value).trim();
    return text(el.value);
  }

  /* ── printing ───────────────────────────────────────────────────────── */

  function print(html, o) {
    o = o || {};
    var host = $("cPrint");
    if (!host) return;
    host.innerHTML = html || "";
    var paper = o.paper === "a4" ? "A4" : "letter";
    var style = $("cPrintPage");
    if (!style && document.createElement) {
      style = document.createElement("style");
      style.id = "cPrintPage";
      (document.head || document.body).appendChild(style);
    }
    if (style) style.textContent = "@page { size: " + paper + "; margin: 12mm; }";
    var oldTitle = document.title;
    if (o.title) document.title = text(o.title);
    document.body.classList.add("c-printing");
    document.body.setAttribute("data-paper", paper.toLowerCase());
    var undone = false;
    function after() {
      if (undone) return;
      undone = true;
      document.body.classList.remove("c-printing");
      document.title = oldTitle;
      window.removeEventListener("afterprint", after);
    }
    window.addEventListener("afterprint", after);
    try { window.print(); } finally { clock.setTimeout(after, 1500); }
  }

  /* ── the router ─────────────────────────────────────────────────────── */

  function decode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function parseHash(h) {
    var s = text(h).replace(/^#\/?/, "");
    var q = "", i = s.indexOf("?");
    if (i >= 0) { q = s.slice(i + 1); s = s.slice(0, i); }
    var parts = s.split("/").filter(Boolean).map(decode);
    var tab = (parts.shift() || "").toLowerCase();
    var query = {};
    q.split("&").forEach(function (kvs) {
      if (!kvs) return;
      var j = kvs.indexOf("=");
      var k = decode((j >= 0 ? kvs.slice(0, j) : kvs).replace(/\+/g, " "));
      if (k) query[k] = decode((j >= 0 ? kvs.slice(j + 1) : "").replace(/\+/g, " "));
    });
    return { tab: tab, parts: parts, query: query };
  }
  function sorted() {
    return Object.keys(defs).map(function (k) { return defs[k]; })
      .sort(function (a, b) { return a.order - b.order || (a.id < b.id ? -1 : 1); });
  }
  /* ctx.go: to another route. A tab with unsaved changes (ctx.guard) is
     asked about first, whichever way the page is left: go(), a tab, Back. */
  function go(path) {
    var p = text(path).replace(/^#?\/?/, "");
    var want = "#/" + p;
    if (location.hash === want) {
      leaving().then(function (ok) { if (ok) route(); });
    } else {
      location.hash = want;
    }
  }
  var guardFn = null, lastHash = "", skipHash = null;
  function unsaved() {
    try { return guardFn ? text(guardFn()) : ""; } catch (e) { return ""; }
  }
  function leaving() {
    var msg = unsaved();
    if (!msg) return Promise.resolve(true);
    return Promise.resolve(DCR.confirm(msg, { title: "Unsaved changes", okText: "Leave without saving", danger: true }))
      .then(function (ok) { if (ok) guardFn = null; return !!ok; });
  }
  function onHash() {
    if (skipHash !== null && location.hash === skipHash) { skipHash = null; return; }
    skipHash = null;
    var target = location.hash;
    if (unsaved() && current) {
      skipHash = lastHash;
      location.hash = lastHash;                   // stay put while asking
      leaving().then(function (ok) { if (ok) location.hash = target; });
      return;
    }
    lastHash = target;
    route();
  }
  function paintTabs() {
    var nav = $("cTabs");
    if (!nav) return;
    nav.innerHTML = sorted().map(function (d) {
      var on = !!(current && current.def === d);
      return '<a class="c-tab" role="tab" id="cTab-' + esc(d.id) + '" href="#/' + encodeURIComponent(d.id) + '" aria-selected="' + on + '">' +
        esc(d.title) + "</a>";
    }).join("");
    var sel = current && $("cTab-" + current.def.id);
    if (sel && sel.scrollIntoView) { try { sel.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) { /* old browsers */ } }
  }
  function leaveCurrent() {
    clock.clearTimeout(autoTimer);
    guardFn = null;
    if (current && current.def.leave) { try { current.def.leave(); } catch (e) { /* never stop the router */ } }
    for (var k in handlers) if (handlers[k].gen !== 0) delete handlers[k];
    subs = subs.filter(function (s) { return s.gen === 0; });
  }
  function route() {
    if (!booted) return;
    var r = parseHash(location.hash);
    var def = defs[r.tab] || defs.dashboard || sorted()[0];
    var view = $("cView");
    if (!view) return;
    leaveCurrent();
    if (!def) { view.innerHTML = empty("Nothing to show yet."); return; }
    if (def.id !== r.tab) r = { tab: def.id, parts: [], query: {} };
    if (typeof window.scrollTo === "function") { try { window.scrollTo(0, 0); } catch (e) { /* a new view starts at the top */ } }
    show(def, r, view, null);
    paintTabs();
  }
  function rerender() {
    if (!current) return;
    var view = $("cView");
    var old = current.el;
    leaveCurrent();
    show(current.def, current.route, view, old);
  }
  function show(def, r, view, old) {
    var el = document.createElement("div");
    el.className = "c-view";
    if (old && old.offsetHeight) el.style.minHeight = old.offsetHeight + "px";   // no jump while it redraws
    view.innerHTML = "";
    view.appendChild(el);
    current = { def: def, el: el, route: r, gen: ++gen };
    var mine = current.gen;
    var settle = function () {
      if (current && current.gen === mine) { el.style.minHeight = ""; applyGates(); }
    };
    try {
      var p = def.render(el, ctx);
      if (p && typeof p.then === "function") {
        p.then(settle, function (e) {
          if (current && current.gen === mine) el.innerHTML = failed(e);
          settle();
        });
      } else settle();
    } catch (e) {
      el.innerHTML = failed(e);
      settle();
    }
    armAuto();
  }
  function modalOpen() {
    try { return !!document.querySelector(".dcr-mo.open"); } catch (e) { return false; }
  }
  /* The last time someone touched the page: an auto refresh is a request
     on the admin's allowance, and a tab left open all day must not spend
     it. The next touch brings the refreshes back. */
  var lastTouch = clock.now();
  function touched() { lastTouch = clock.now(); }
  function armAuto() {
    clock.clearTimeout(autoTimer);
    if (!current || !current.def.autoRefresh) return;
    var mine = current.gen;
    autoTimer = clock.setTimeout(function () {
      if (!current || current.gen !== mine) return;
      if (document.visibilityState === "hidden" || modalOpen() || clock.now() - lastTouch > IDLE_MS) { armAuto(); return; }
      if (current.def.refresh) {
        /* the tab redraws in place, only what changed (no skeletons) */
        var p = null;
        try { p = current.def.refresh(current.el, ctx); } catch (e) { p = null; }
        Promise.resolve(p).then(function () { if (current && current.gen === mine) { applyGates(); armAuto(); } },
          function () { if (current && current.gen === mine) armAuto(); });
        return;
      }
      rerender();
    }, current.def.autoRefresh * 1000);
  }

  function onServer(fn) {
    var s = { fn: fn, gen: current ? current.gen : 0 };
    subs.push(s);
    return function () { subs = subs.filter(function (x) { return x !== s; }); };
  }

  /* Clicks the shell owns: Try again, table rows, pager buttons, Resume. */
  function onViewClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var retry = t.closest("[data-c-retry]");
    if (retry) { e.preventDefault(); rerender(); return; }
    var pg = t.closest("[data-c-page]");
    if (pg) {
      var box = pg.closest("[data-c-pager]");
      var h = box && handlers[box.getAttribute("data-c-pager")];
      var off = pg.getAttribute("data-c-page");
      if (h && off !== "" && off !== null && !pg.disabled) h.fn(Number(off));
      return;
    }
    var row = t.closest("[data-row]");
    if (row && !t.closest("a, button, input, select, textarea, label")) {
      var tb = row.closest("[data-c-table]");
      var hr = tb && handlers[tb.getAttribute("data-c-table")];
      if (hr && hr.kind === "row") hr.fn(hr.rows[Number(row.getAttribute("data-row"))], e);
    }
  }
  function onViewKey(e) {
    if (e.key !== "Enter") return;
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute("data-row") !== null && t.closest && t.closest("[data-c-table]")) onViewClick(e);
  }
  function onBannerClick(e) {
    var b = e.target && e.target.closest && e.target.closest("#cResume");
    if (!b) return;
    press(b, function () {
      return act("dashboard.pause", { paused: false }).then(function (d) {
        if (!d) return;
        notePaused(false);
        toast("Resumed — the agents and the assistants run again.");
        if (current && current.def.id === "dashboard") rerender();
      }, function () { /* the toast said why */ });
    });
  }

  function showGate() {
    clock.clearTimeout(statusTimer);
    leaveCurrent();
    current = null;
    booted = false;
    gated = true;
    var nav = $("cTabs"), st = $("cStatus"), bn = $("cBanners"), view = $("cView");
    if (nav) { nav.innerHTML = ""; nav.hidden = true; }
    if (st) st.hidden = true;
    if (bn) bn.innerHTML = "";
    if (view) {
      view.innerHTML = '<div class="c-card c-gate"><h2>' + esc(ADMIN_ONLY) + '</h2><p class="c-muted">Ask an admin if you need ' +
        'something changed on the DCR Agents.</p><p><a class="c-btn ghost" href="dashboard.html">Back to the dashboard</a></p></div>';
    }
  }

  /* ── ctx and boot ───────────────────────────────────────────────────── */

  var ui = { table: table, chip: chip, kv: kv, section: section, pager: pager, form: form, when: when, day: day, ago: ago,
    plural: plural, empty: empty, failed: failed, href: href, esc: esc };
  var ctx = {
    rpc: rpc, act: act, has: has, go: go, onServer: onServer, canAct: canAct, toast: toast, busy: busy, press: press,
    print: print, ui: ui, esc: esc, notePaused: notePaused,
    refresh: function () { rerender(); },
    /* guard(fn): while this tab is open, fn() answers a sentence when there
       are unsaved changes ("" when there are none); leaving asks first. */
    guard: function (fn) { guardFn = typeof fn === "function" ? fn : null; },
    info: function () { return info; },
    method: function (name) { return methodOf(name); },
    confirm: function (m, o) { return DCR.confirm(m, o); },
    modal: function (o) { return DCR.modal(o); },
    admin: { name: "", email: "" },
  };
  Object.defineProperty(ctx, "route", { enumerable: true, get: function () { return current ? current.route : parseHash(location.hash); } });
  Object.defineProperty(ctx, "server", { enumerable: true, get: function () { return server; } });

  function register(def) {
    if (!def || typeof def !== "object") throw new Error("DCRConsole.register needs a tab definition.");
    var id = text(def.id);
    if (!/^[a-z][a-z0-9_-]{0,30}$/.test(id)) throw new Error('A console tab needs an id like "agents".');
    if (typeof def.render !== "function") throw new Error('The console tab "' + id + '" needs render(el, ctx).');
    if (Object.prototype.hasOwnProperty.call(defs, id)) throw new Error('The console tab "' + id + '" is registered twice.');
    var auto = Number(def.autoRefresh) || 0;
    defs[id] = { id: id, title: text(def.title) || id, order: Number(def.order) || 999, render: def.render,
      leave: typeof def.leave === "function" ? def.leave : null, autoRefresh: auto > 0 ? Math.max(30, auto) : 0,
      refresh: typeof def.refresh === "function" ? def.refresh : null };
    if (booted) paintTabs();
    return defs[id];
  }

  /* Inside another site's frame the console does not start at all: a page
     drawn over it could lead an admin through a confirm. A link opens it in
     its own window. (The portal is on GitHub Pages, which cannot send
     X-Frame-Options; agents-console.html hides everything before the first
     paint, this is the shell's own check.) */
  function framed() {
    try { return !!window.top && window.top !== window.self; } catch (e) { return true; }
  }
  function showFramed() {
    var box = $("cFramed");
    if (!box) return;
    box.hidden = false;
    box.innerHTML = "<b>The DCR Agents console does not open inside another page.</b><p>" +
      '<a class="btn" href="agents-console.html" target="_blank" rel="noopener">Open it in its own window</a></p>';
  }

  /* The status bar sticks under the portal's own sticky top bar, whose
     height changes with the window (its buttons wrap on a phone). */
  function measureTop() {
    var bar = document.querySelector ? document.querySelector(".topbar") : null;
    var root = document.documentElement;
    if (!bar || !root || !root.style || typeof root.style.setProperty !== "function") return;
    root.style.setProperty("--c-top", (Number(bar.offsetHeight) || 0) + "px");
  }

  async function boot() {
    if (framed()) { showFramed(); return; }
    measureTop();
    window.addEventListener("resize", measureTop);
    if (typeof ResizeObserver === "function") {
      try { new ResizeObserver(measureTop).observe(document.querySelector(".topbar")); } catch (e) { /* resize still measures */ }
    }
    profile = await DCR.requireAuth();
    var pill = $("userPill");
    if (pill) pill.textContent = text(profile.displayName || profile.email) + " · " + text(profile.role);
    if (!profile || profile.role !== "Admin") { showGate(); return; }
    ctx.admin = { name: text(profile.displayName || profile.email), email: text(profile.email) };
    booted = true;
    var view = $("cView");
    if (view) {
      view.addEventListener("click", onViewClick);
      view.addEventListener("keydown", onViewKey);
    }
    var bn = $("cBanners");
    if (bn) bn.addEventListener("click", onBannerClick);
    lastHash = location.hash;
    window.addEventListener("hashchange", onHash);
    window.addEventListener("beforeunload", function (e) {
      if (!unsaved()) return;
      e.preventDefault();
      e.returnValue = "";
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && booted) refreshServer();
    });
    ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (ev) {
      document.addEventListener(ev, touched, { passive: true, capture: true });
    });
    if (typeof MutationObserver === "function") {
      try { new MutationObserver(gateSoon).observe($("cApp") || document.body, { childList: true, subtree: true }); }
      catch (e) { /* the gates still run after every render */ }
    }
    paintStatus();
    refreshServer().then(resumePending);
    route();
  }

  var api = { register: register, version: 1 };
  if (TEST) {
    api._test = {
      clock: clock,
      setRpc: function (fn) { transport = typeof fn === "function" ? fn : relayRpc; },
      setServer: function (s) { server = s || null; serverErr = null; readyResolve(); afterServer(); },
      setMethods: function (list) {
        if (list === null) { methods = null; info = null; }
        else { methods = {}; (list || []).forEach(function (m) { methods[typeof m === "string" ? m : m.name] = typeof m === "string" ? { name: m } : m; }); }
        applyGates();
      },
      parseHash: parseHash, serverState: serverState, agoWords: agoWords, fromHttp: fromHttp,
      state: function () {
        return { server: server, serverErr: serverErr, methods: methods, inflight: inflight, queued: queue.length,
          current: current ? { tab: current.def.id, route: current.route, gen: current.gen } : null, pending: pendingAll(),
          active: active.length };
      },
      ctx: ctx, refreshServer: refreshServer, route: route,
    };
  }
  window.DCRConsole = api;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else Promise.resolve().then(boot);
})();
