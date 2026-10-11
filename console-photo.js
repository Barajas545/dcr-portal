/* DCR Agents web console — the Photo & Video tab (console-spec §6.1.9 and
   §6.4; tab "photo", order 50).

   Everything the desktop's Photo & Video tab does, from a phone or another
   computer: the plans, Upcoming, the Calendar, Suggestions, one plan (the
   game plan, the four milestone dates — "N shoots will move" before
   anything is saved —, every shoot, a shoot's brief to edit, Revise with
   AI, Make it again, Approve & start, who gets copies), one shoot's actions
   (send a reminder now, mark done, skip, move, bring back, post kit,
   debrief), the setup wizard with Claude's questions, the Playbook and the
   Coach, the photo settings, and the printouts as a print-friendly page
   that the browser prints or saves as a PDF.

   This file decides nothing about the plans. Every word that is not a
   label comes from the DCR server computer — console/handlers_photo.py over
   photo/views.py and photo/printmodel.py, the helpers the desktop draws
   from — and every change is a request the PC checks again. A change the
   desktop asks about goes through ctx.act: the PC writes the question, this
   page only shows it. Every server string goes through esc(); links are
   "#/photo/…" or https:; write buttons carry data-act (greyed by the shell
   while the server cannot act) and data-method (greyed when this server's
   build does not know the method).

   A request travels through the portal to the PC and back, so it takes a
   few seconds. What was read is kept for 30 seconds — going from a plan to
   one of its shoots and back is instant — and forgotten after any change.
   Unsaved edits (a shoot's brief, the milestone dates, the settings) are
   kept while the admin looks elsewhere in the console. */
(function () {
  "use strict";

  /* ── what this page knows by heart ──────────────────────────────────── */

  var TTL = 30 * 1000;                 // a read is drawn again from memory this long
  var WAIT_MS = 600;                   // a preview is asked again this long after the last change
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
    "November", "December"];
  var MON_FIRST = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  /* The PC's tones (photo/views.py) → the shell's chip classes. */
  var TONE = { blue: "info", green: "good", amber: "warn", red: "bad", grey: "", purple: "cph-purple" };
  var UPDATE_WORDS = "Update DCR Agents on the server computer to use this";
  var ARGS_MAX = 20000;                // what one request may carry (§6.2.5)
  /* The printouts' fixed numbers (photo/printmodel.py, ui/photo_print.py). */
  var KIND_WORDS = { photo: "Photo", video: "Video", drone: "Drone", timelapse: "Time-lapse" };
  var SURE_WORDS = { firm: "Firm", estimate: "Estimate", unsure: "Not sure" };
  var NOTES_LINES = { none: 0, few: 6, half: 16 };
  var NOTES_CHOICES = [["none", "None"], ["few", "A few lines"], ["half", "Half a page"]];
  var PAPER_CHOICES = [["letter", "Letter (8.5 × 11 in)"], ["a4", "A4 (210 × 297 mm)"]];
  var PRINT_DEFAULTS = { include_done: false, notes: "few", one_per_page: false, paper: "letter" };
  var GENERAL_NOTE_LINES = 5;
  var CLOSED = { done: 1, skipped: 1, missed: 1 };
  var PRINT_KEY = "dcr.console.photoPrint.v1";
  /* The shoot editor's limits (console/handlers_photo.py — the store's own). */
  var MAX_SHOTS = 15;
  var LIST_LIMITS = { tips: [10, 200], equipment: [12, 80], safety: [10, 200], caption_ideas: [6, 200] };
  var LIST_FIELDS = [["tips", "Tips"], ["equipment", "Bring"], ["safety", "Safety"], ["caption_ideas", "Caption ideas"]];
  var SHOT_KINDS = [["photo", "Photo"], ["video", "Video"], ["drone", "Drone"], ["timelapse", "Time-lapse"]];
  var RATINGS = [[1, "It didn't work out"], [2, "Not great"], [3, "OK"], [4, "Good"], [5, "Excellent"]];
  var DATE_QUESTIONS = { framing_start: 1, delivery: 1 };        // photo/views.DATE_QUESTIONS
  var ANSWER_KEY = /^[A-Za-z0-9_-]{1,40}$/;
  /* Who gets copies, by group (photo/copies.KIND_GROUPS). */
  var COPY_GROUPS = [["heads_up", "Heads-up and date changes"], ["followups", "Follow-ups and the escalation"],
    ["day_before", "The evening-before reminder"], ["agenda", "The Monday list"]];
  var COPIES_MAX = { cc: 25, pc: 20 };
  var POST_KIT = [["instagram", "Instagram"], ["facebook", "Facebook"], ["linkedin", "LinkedIn"], ["tiktok", "TikTok"],
    ["hashtags", "Hashtags"], ["best_time", "Best time to post"], ["alt_text", "Alt text (for the photo)"]];
  /* Photo & Video → Settings, laid out as the desktop page is. */
  var SET_GROUPS = [
    ["Who", ["photo.photographer", "photo.admin_name"], "Both must be names on the portal's roster (the People tab) — " +
      "the reminders go to their app, text or email the way People says."],
    ["Also send copies to", ["photo.cc", "photo.cc_kinds"], "Project managers, admins — anyone with an email. On every " +
      "plan, each gets an email of their own with a copy of a reminder once it has really gone to the photographer. A " +
      "plan can add its own people: “Copies” at the top of the plan. The Monday list covers every plan, so only this " +
      "list can be copied on it."],
    ["Reminders", ["photo.lead_days", "photo.day_before", "photo.followup_every_days", "photo.max_followups",
      "photo.weekly_agenda", "photo.shoot_days"], "A planned date that lands on another day moves to the next shoot " +
      "day. A date you pick yourself stays where you put it."],
    ["When the agent may act alone", ["photo.auto_apply", "photo.weather", "photo.poll_minutes"], ""],
    ["Claude", ["photo.ai", "photo.model"], ""],
  ];
  var AUTO_WHY = {
    safe: "Marks a shoot done when its task is closed on My Tasks, and takes the delivery date from the project log and " +
      "the framing start from the timesheets. Everything else waits in Suggestions.",
    all: "As above, plus suggestions the agent is sure of. A shoot is never marked done from photo counts.",
    none: "Every change waits in Suggestions.",
  };
  var BRIEF_EXAMPLE = "For example: “Two-story ADU behind the main house, with a vaulted great room. The trusses come " +
    "by crane — the client loves drone shots. Steep driveway: park on the street. We want a reel of the whole frame " +
    "going up for Instagram.”";
  var NO_PLANS = "No active plans yet. Press “+ New project plan” to set one up: the agent asks a few questions, writes " +
    "a plan with a date and a shot list for every shoot, and reminds the photographer before each one.";
  var SUB = [["plans", "Plans"], ["upcoming", "Upcoming"], ["calendar", "Calendar"], ["suggestions", "Suggestions"],
    ["playbook", "Playbook & Coach"], ["settings", "Settings"]];
  var ORDER = { active: 0, review: 1, interview: 2, draft: 2, paused: 3, done: 4, archived: 5 };
  var CURRENT = { draft: 1, interview: 1, review: 1, active: 1, paused: 1 };
  var FILTERS = [["current", "Active plans"], ["all", "Every plan"], ["archived", "Archived"]];
  var STEPS = ["Pick the project", "Tell me about it", "Questions", "Review the plan"];
  var EMAIL_RX = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

  /* ── the page's own memory ──────────────────────────────────────────── */

  var S = {
    ctx: null, el: null, r: null, token: 0,
    cache: {},            // "method {args}" → {data, at}
    o: null,              // the last photo.overview
    v: {},                // this drawing: its forms and what it is showing
    shoot: {},            // sid → {form, base, rev}: a shoot's edits, kept until saved or undone
    ms: {},               // pid → {form, base}: milestone dates changed and not saved
    wiz: {},              // pid → {round, useAi, view, answers}
    calDay: null,         // the day picked on the Calendar
    settings: null,       // {form, base, rev} unsaved Photo & Video settings
    timers: [],
  };

  /* ── small helpers ──────────────────────────────────────────────────── */

  function noop() {}
  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function int(v, d) { var n = parseInt(v, 10); return isFinite(n) ? n : (d || 0); }
  function esc(v) {
    if (S.ctx && typeof S.ctx.esc === "function") return S.ctx.esc(v);
    return str(v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function plural(n, word, many) { n = Number(n) || 0; return n + " " + (n === 1 ? word : many || word + "s"); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function own(o, k) { return o && Object.prototype.hasOwnProperty.call(o, k); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function lines(v) { return (Array.isArray(v) ? v : []).map(str).join("\n"); }
  function splitLines(s) { return str(s).split("\n").map(function (x) { return x.trim(); }).filter(Boolean); }

  /* "2026-10-15" (or a longer ISO stamp) → a local date at noon, or null. */
  function asDay(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v));
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], 12);
    return d.getMonth() === +m[2] - 1 ? d : null;
  }
  /* "Thu Oct 15" and "Thu Oct 15, 2026" — the PC's day_text and long_day_text. */
  function dayText(v) { var d = asDay(v); return d ? WEEKDAYS[d.getDay()] + " " + MONTHS[d.getMonth()] + " " + d.getDate() : ""; }
  function longDayText(v) { var d = asDay(v); return d ? dayText(v) + ", " + d.getFullYear() : ""; }
  function isoOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function todayIso() { return isoOf(new Date()); }
  function monthOk(m) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(str(m)); }
  function shiftMonth(m, by) {
    var y = int(m.slice(0, 4)), mo = int(m.slice(5, 7)) - 1 + by;
    var d = new Date(y, mo, 1, 12);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1);
  }
  /* '6:01-6:38 pm' as print writes it: '6:01–6:38 pm' (ui/photo_print.dash). */
  function dash(span) { return str(span).replace(/([\dm])-(?=\d)/g, "$1–"); }
  /* A link from the server: https: only (the shoot's task on My Tasks). */
  function httpsOnly(u) { u = str(u).trim(); return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : ""; }

  function $(id) {
    var n = null;
    if (S.el && S.el.querySelector) { try { n = S.el.querySelector("#" + id); } catch (e) { n = null; } }
    return n || (typeof document !== "undefined" && document.getElementById ? document.getElementById(id) : null);
  }
  function setHtml(id, html) { var n = $(id); if (n) n.innerHTML = html; return n; }
  function has(m) { return !S.ctx || typeof S.ctx.has !== "function" || !!S.ctx.has(m); }
  function aiMethod(m) { var d = S.ctx && S.ctx.method ? S.ctx.method(m) : null; return !!(d && d.ai); }

  function chip(words, tone, title) {
    if (!str(words)) return "";
    var cls = own(TONE, tone) ? TONE[tone] : "";
    return '<span class="c-chip' + (cls ? " " + cls : "") + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" +
      esc(words) + "</span>";
  }
  function chipOf(pair, title) { pair = Array.isArray(pair) ? pair : []; return chip(pair[0], pair[1], title); }
  function busyHtml(words) { return '<div class="c-busy" role="status">' + esc(words || "Working…") + "</div>"; }
  function emptyHtml(words) { return '<div class="c-empty">' + esc(words) + "</div>"; }

  /* A button. o.method: the console method it calls (greyed with a note when
     this server's build does not have it); o.write: a change (data-act, so
     the shell greys it while the server cannot act). */
  function btn(label, ph, o) {
    o = o || {};
    var cls = "c-btn" + (o.primary ? "" : " ghost") + (o.danger ? " danger" : "") + (o.big ? "" : " sm") +
      (o.cls ? " " + o.cls : "");
    var a = ' type="button" class="' + cls + '" data-ph="' + esc(ph) + '"';
    if (o.data) Object.keys(o.data).forEach(function (k) { a += " data-" + k + '="' + esc(o.data[k]) + '"'; });
    if (o.id) a += ' id="' + esc(o.id) + '"';
    if (o.method) {
      a += ' data-method="' + esc(o.method) + '"';
      if (!has(o.method)) return "<button" + a + ' disabled title="' + esc(UPDATE_WORDS) + '">' + esc(label) + "</button>";
    }
    if (o.write) a += ' data-act="' + esc(o.method || ph) + '"';
    if (o.title) a += ' title="' + esc(o.title) + '"';
    if (o.disabled) a += " disabled";
    if (o.pressed !== undefined) a += ' aria-pressed="' + (o.pressed ? "true" : "false") + '"';
    return "<button" + a + ">" + esc(label) + "</button>";
  }
  function link(label, path, cls) {
    return '<a class="' + (cls || "c-btn ghost sm") + '" href="#/photo/' + esc(path) + '">' + esc(label) + "</a>";
  }
  function back(label, path) { return '<a class="cph-back" href="#/photo/' + esc(path) + '">‹ ' + esc(label) + "</a>"; }
  function field(label, control, help, id) {
    return '<div class="c-field"' + (id ? ' id="' + id + '"' : "") + ">" + (label ? '<label class="c-label">' + esc(label) +
      "</label>" : "") + control + (help ? '<div class="c-help">' + esc(help) + "</div>" : "") + "</div>";
  }
  function check(label, f, on, extra) {
    return '<label class="c-check"><input type="checkbox" data-f="' + esc(f) + '"' + (on ? " checked" : "") +
      (extra || "") + "> " + esc(label) + "</label>";
  }
  function options(list, cur) {
    return list.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (str(o[0]) === str(cur) ? " selected" : "") + ">" + esc(o[1]) + "</option>";
    }).join("");
  }

  /* ── feedback ───────────────────────────────────────────────────────── */

  function errWords(e) {
    return (e && e.message) || "Something went wrong — try again.";
  }
  function toast(words, bad) { if (S.ctx && S.ctx.toast) S.ctx.toast(str(words), { bad: !!bad }); }
  function failHtml(e, title) {
    var code = e && e.code;
    var head = title || (code === "offline" || code === "standby" || code === "not_set_up" || code === "network" ?
      "The DCR server is not available right now." : code === "not_found" ? "Not found." : "That did not work.");
    return '<div class="c-error" role="alert"><b>' + esc(head) + "</b><span>" + esc(errWords(e)) + "</span>" +
      '<div class="c-actions">' + btn("Try again", "reload") + "</div></div>";
  }
  /* A working line with the seconds counting (the shell's), under a button. */
  function working(id, words) {
    var n = $(id);
    if (!n) return noop;
    if (S.ctx && typeof S.ctx.busy === "function") {
      try { return S.ctx.busy(n, words) || noop; } catch (e) { /* plain words below */ }
    }
    n.innerHTML = busyHtml(words);
    return function () { n.innerHTML = ""; };
  }
  /* The button greyed and saying it is working while fn's promise runs. */
  function press(button, fn, words) {
    if (S.ctx && typeof S.ctx.press === "function" && button && button.nodeType) return S.ctx.press(button, fn, words);
    if (button && button.disabled) return Promise.resolve(null);
    if (button) button.disabled = true;
    return Promise.resolve().then(fn).then(function (v) { if (button) button.disabled = false; return v; },
      function (e) { if (button) button.disabled = false; throw e; });
  }
  function aiWords(method, plain) { return aiMethod(method) ? "Claude is working… this can take a minute" : plain; }

  /* ── reading and writing ────────────────────────────────────────────── */

  function keyOf(method, args) { return method + " " + JSON.stringify(args || {}); }
  /* A read, from memory while it is fresh (opts.fresh skips that). */
  function read(method, args, opts) {
    opts = opts || {};
    var k = keyOf(method, args);
    var c = S.cache[k];
    if (!opts.fresh && c && Date.now() - c.at < (opts.ttl || TTL)) return Promise.resolve(c.data);
    return S.ctx.rpc(method, args || {}, { quiet: true, text: opts.text }).then(function (d) {
      S.cache[k] = { data: d, at: Date.now() };
      return d;
    });
  }
  function forget(prefix) {
    Object.keys(S.cache).forEach(function (k) { if (!prefix || k.indexOf(prefix) === 0) delete S.cache[k]; });
  }
  /* A change: afterwards everything the Photo & Video tab read is stale. */
  function write(method, args, opts) {
    return S.ctx.rpc(method, args || {}, { quiet: true, text: opts && opts.text }).then(function (d) {
      forget("photo.");
      return d;
    });
  }
  /* A change the PC may ask about first (C / C?): the shell shows its question. */
  function act(method, args, opts) {
    return S.ctx.act(method, args || {}, { quiet: true, text: opts && opts.text }).then(function (d) {
      if (d) forget("photo.");
      return d;
    });
  }

  /* ── the router ─────────────────────────────────────────────────────── */

  function num(v) { var s = str(v); return /^[1-9]\d{0,9}$/.test(s) && +s < 2e9 ? +s : null; }
  function where(route) {
    var p = (route && route.parts) || [], q = (route && route.query) || {};
    var page = str(p[0]) || "plans";
    if (page === "plan") {
      var pid = num(p[1]);
      return pid ? { page: "plan", pid: pid, sid: p[2] === "shoot" ? num(p[3]) : null, q: q } : { page: "plans", q: q };
    }
    if (page === "print") {
      if (p[1] === "agenda") return { page: "agenda", pid: num(q.pid), q: q };
      var ppid = num(p[1]);
      return ppid ? { page: "print", pid: ppid, sid: num(q.shoot), q: q } : { page: "plans", q: q };
    }
    if (page === "new") return { page: "new", q: q };
    if (!SUB.some(function (s) { return s[0] === page; })) page = "plans";
    return { page: page, q: q };
  }
  /* Go somewhere in this tab (the shell draws it again). */
  function goto(path) {
    var want = "#/photo/" + path;
    if (S.ctx && typeof S.ctx.go === "function") { S.ctx.go(want); return; }
    if (location.hash === want) paint(); else location.hash = want;
  }
  function paint() {
    if (S.ctx && typeof S.ctx.refresh === "function") S.ctx.refresh();
    else if (S.el && S.ctx) render(S.el, S.ctx);
  }
  function reload() { forget(); paint(); }
  function later(fn, ms) {
    var id = setTimeout(function () { S.timers = S.timers.filter(function (x) { return x !== id; }); fn(); }, ms);
    S.timers.push(id);
    return id;
  }
  function stopTimers() { S.timers.forEach(function (id) { clearTimeout(id); }); S.timers = []; }

  function render(el, ctx) {
    S.ctx = ctx;
    S.el = el;
    var t = ++S.token;
    stopTimers();
    if (!el.__cph) {
      el.__cph = true;
      el.addEventListener("click", onClick);
      el.addEventListener("input", onInput);
      el.addEventListener("change", onChange);
      el.addEventListener("keydown", onKey);
    }
    if (el.classList) el.classList.add("cph");
    var r = S.r = where(ctx.route);
    S.v = { forms: {}, page: r.page };
    var pages = { plan: planPage, new: pickPage, print: printPage, agenda: agendaPage };
    return (pages[r.page] || overviewPage)(r, t);
  }
  function leave() { stopTimers(); S.token++; }

  /* ── events: every control names what it does in data-ph ────────────── */

  function onClick(e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-ph]") : null;
    if (!t) return;
    if (t.disabled) return;
    var fn = CLICK[t.getAttribute("data-ph")];
    if (!fn) return;
    if (e.preventDefault) e.preventDefault();
    fn(t, e);
  }
  /* A form field: data-f="<form>:<path>" keeps the page's copy of it. */
  function onInput(e) { var n = e.target; if (n && n.getAttribute) fieldChanged(n); }
  function onChange(e) {
    var n = e.target;
    if (!n || !n.getAttribute) return;
    fieldChanged(n);
    var ch = n.getAttribute("data-ch");
    if (ch && CHANGE[ch]) CHANGE[ch](n, e);
  }
  function onKey(e) {
    var n = e.target;
    if (e.key !== "Enter" || !n || !n.getAttribute) return;
    var k = n.getAttribute("data-enter");
    if (k && CLICK[k] && n.tagName !== "TEXTAREA") {
      if (e.preventDefault) e.preventDefault();
      CLICK[k]($(n.getAttribute("data-enter-btn")) || n, e);
    }
  }
  function valueOf(n) {
    var type = str(n.type).toLowerCase();
    if (type === "checkbox") return !!n.checked;
    if (type === "number") { var s = str(n.value).trim(); return s === "" ? null : Number(s); }
    return str(n.value);
  }
  function fieldChanged(n) {
    var f = n.getAttribute("data-f");
    if (!f) return;
    var i = f.indexOf(":");
    var formName = i > 0 ? f.slice(0, i) : "main", path = i > 0 ? f.slice(i + 1) : f;
    var form = S.v.forms[formName];
    if (!form) return;
    var v = valueOf(n);
    var hook = S.v.edited && S.v.edited[formName];
    /* A form keyed by dotted setting names ("photo.lead_days"): the key is
       the whole path; "key|part" is a tick inside a list, kept by the hook. */
    if (FLAT[formName]) {
      if (path.indexOf("|") < 0) form[path] = v;
      if (hook) hook(path, v, n);
      return;
    }
    var keys = path.split(".");
    var o = form;
    for (var j = 0; j < keys.length - 1; j++) {
      if (o[keys[j]] === undefined || o[keys[j]] === null) o[keys[j]] = {};
      o = o[keys[j]];
    }
    o[keys[keys.length - 1]] = v;
    if (hook) hook(path, v, n);
  }

  var FLAT = { set: 1, pc: 1 };
  var CLICK = {}, CHANGE = {};

  CLICK.reload = function () { reload(); };

  /* ══ the overview pages ═════════════════════════════════════════════ */

  function overviewPage(r, t) {
    var page = r.page;
    S.el.innerHTML = '<div id="cphTop" class="cph-top">' + (S.o ? topHtml(S.o) : busyHtml("Reading the Photo & Video plans…")) +
      "</div>" + '<div id="cphSub">' + subnavHtml(page, S.o) + "</div>" + '<div id="cphBody" class="cph-body"></div>';
    var top = read("photo.overview").then(function (o) {
      if (t === S.token) {
        S.o = o;
        setHtml("cphTop", topHtml(o));
        setHtml("cphSub", subnavHtml(page, o));
      }
      return o;
    }, function (e) {
      if (t === S.token) setHtml("cphTop", page === "plans" ? "" : failHtml(e));
      throw e;
    });
    var body = OVERVIEW[page](r, t, top);
    return Promise.all([top.then(noop, noop), Promise.resolve(body).then(noop, noop)]).then(noop);
  }

  function topHtml(o) {
    var h = o.header || {}, late = int(h.overdue), sug = int(o.suggestions_open);
    var ai = o.ai || {};
    var who = str(o.photographer);
    var whoWords = "Photographer: " + (who || "not picked yet") + (who && o.photographer_auto ? " (automatic)" : "");
    var out = '<div class="cph-chips">' +
      '<a class="c-chip good cph-big" href="#/photo/plans">' + esc(plural(h.active, "active plan")) + "</a>" +
      '<a class="c-chip info cph-big" href="#/photo/upcoming">' + esc(plural(h.week, "shoot") + " this week") + "</a>" +
      '<a class="c-chip cph-big' + (late ? " bad b" : "") + '" href="#/photo/upcoming">' + esc(late + " overdue") + "</a>" +
      '<a class="c-chip cph-big' + (sug ? " warn b" : "") + '" href="#/photo/suggestions">' + esc(plural(sug, "suggestion")) +
      "</a>" + '<a class="cph-ai ' + (ai.ok ? "ok" : "warn") + '" href="#/settings" title="Settings → Claude">' +
      (ai.ok ? "● " : "") + esc(ai.words) + "</a></div>" +
      '<div class="cph-toprow">' + btn(whoWords + " ▾", "who-default", { method: "settings.save", write: true,
        cls: "cph-who" + (who ? "" : " warn"), title: "The photographer every plan uses unless it names its own" }) +
      btn("+ New project plan", "new-plan", { primary: true, method: "photo.wizard.create", write: true }) +
      btn("↻", "reload", { title: "Read everything again from the DCR server", cls: "cph-icon" }) + "</div>";
    var notes = [];
    if (o.dry_run) notes.push('<span class="c-chip warn">Dry run — reminders are recorded, not sent</span>');
    if (o.agent && o.agent.exists && !o.agent.enabled) {
      notes.push('<span class="cph-note warn">The “Photo &amp; Video — shoot reminders” agent is off, so no reminder goes. ' +
        '<a href="#/agents">Turn it on in the Agents tab</a>.</span>');
    }
    if (notes.length) out += '<div class="cph-notes">' + notes.join("") + "</div>";
    return out;
  }

  function subnavHtml(page, o) {
    return '<nav class="cph-sub" aria-label="Photo &amp; Video">' + SUB.map(function (s) {
      var n = s[0] === "suggestions" && o && int(o.suggestions_open) ? ' <span class="cph-badge">' + esc(o.suggestions_open) +
        "</span>" : "";
      var on = s[0] === page;
      return '<a class="cph-subitem' + (on ? " on" : "") + '" href="#/photo/' + s[0] + '"' + (on ? ' aria-current="page"' : "") +
        ">" + esc(s[1]) + n + "</a>";
    }).join("") + "</nav>";
  }

  CLICK["new-plan"] = function () { goto("new"); };

  /* The photographer every plan uses (photo.photographer, a setting). */
  CLICK["who-default"] = function (b) {
    press(b, function () {
      return Promise.all([read("settings.get"), peopleNames(), read("photo.overview")]).then(function (res) {
        var st = res[0], names = res[1], o = res[2] || {};
        var sec = (st.sections || {}).photo || {};
        var cur = str((sec.values || {})["photo.photographer"]);
        var hint = o.hint || {};
        var auto = hint.name ? "Automatic — the portal's best guess (" + hint.name + ", " + int(hint.count) + " photo tasks)" :
          "Automatic — the person with the most photo tasks";
        var opts = [{ value: "", label: auto }].concat(names.map(function (n) { return { value: n, label: n }; }));
        if (cur && names.indexOf(cur) < 0) opts.push({ value: cur, label: cur + " (not on the roster)" });
        return S.ctx.modal({ title: "Photographer", message: "Who takes the photos and videos? Every plan uses this person " +
          "unless it names its own.", okText: "Save", fields: [{ name: "who", type: "select", options: opts, value: cur }] })
          .then(function (ans) {
            if (!ans) return null;
            return S.ctx.rpc("settings.save", { section: "photo", values: { "photo.photographer": str(ans.who) }, rev: sec.rev },
              { quiet: true }).then(function () {
              forget("photo.");
              forget("settings.get");
              toast("Photographer: " + (ans.who || "automatic") + ".");
              paint();
            });
          });
      });
    }).then(noop, function (e) { toast(errWords(e), true); });
  };

  /* Every roster name (People), for the person pickers. */
  function peopleRows() {
    if (!has("people.list")) return Promise.resolve([]);
    return read("people.list", {}, { ttl: 5 * 60 * 1000 }).then(function (d) { return (d && d.rows) || []; },
      function () { return []; });
  }
  function peopleNames() {
    return peopleRows().then(function (rows) { return rows.map(function (r) { return str(r.name); }).filter(Boolean); });
  }

  var OVERVIEW = {};

  /* ── Plans ──────────────────────────────────────────────────────────── */

  OVERVIEW.plans = function (r, t, top) {
    var body = $("cphBody");
    if (!S.o && body) body.innerHTML = '<div class="c-skel"></div><div class="c-skel"></div>';
    else if (S.o) setHtml("cphBody", plansHtml(S.o, r));
    return top.then(function (o) { if (t === S.token) setHtml("cphBody", plansHtml(o, r)); },
      function (e) { if (t === S.token) setHtml("cphBody", failHtml(e)); });
  };

  function plansHtml(o, r) {
    var show = r.q.show === "all" || r.q.show === "archived" ? r.q.show : "current";
    var all = o.projects || [];
    var rows = all.filter(function (p) {
      return show === "all" ? true : show === "archived" ? p.status === "archived" : own(CURRENT, p.status);
    });
    rows.sort(function (a, b) {
      var oa = own(ORDER, a.status) ? ORDER[a.status] : 9, ob = own(ORDER, b.status) ? ORDER[b.status] : 9;
      if (oa !== ob) return oa - ob;
      var da = str((a.next_shoot || {}).date) || "9999", db = str((b.next_shoot || {}).date) || "9999";
      if (da !== db) return da < db ? -1 : 1;
      return str(a.label) < str(b.label) ? -1 : str(a.label) > str(b.label) ? 1 : 0;
    });
    var head = '<div class="c-head"><div class="cph-filter"><label class="c-label" for="cphShow">Show</label>' +
      '<select id="cphShow" data-ch="plans-show">' + options(FILTERS, show) + "</select></div></div>";
    if (!rows.length) {
      var words = show === "archived" ? "Archived plans show up here." :
        !all.some(function (p) { return p.status === "active"; }) && show === "current" ? NO_PLANS :
          "No plans here — “+ New project plan” starts one.";
      return head + emptyHtml(words);
    }
    return head + '<div class="cph-plans">' + rows.map(function (p) {
      var printable = p.status !== "draft" && p.status !== "interview" && int((p.counts || {}).total) > 0;
      return '<div class="c-card cph-plan">' +
        '<a class="cph-plan-main" href="#/photo/plan/' + int(p.id) + '"><span class="cph-plan-name">' + esc(p.label || "Plan " + p.id) +
        "</span> " + chipOf(p.chip) + '<span class="cph-plan-sub">' + esc(p.subtitle) + "</span></a>" +
        (printable ? '<a class="c-btn link cph-plan-print" href="#/photo/print/' + int(p.id) + '">Print schedule</a>' : "") +
        "</div>";
    }).join("") + "</div>";
  }
  CHANGE["plans-show"] = function (n) { goto("plans" + (n.value && n.value !== "current" ? "?show=" + encodeURIComponent(n.value) : "")); };

  /* ── Upcoming ───────────────────────────────────────────────────────── */

  OVERVIEW.upcoming = function (r, t) {
    var pid = num(r.q.pid);
    setHtml("cphBody", busyHtml("Reading the shoots…"));
    return read("photo.upcoming", { pid: pid }).then(function (d) {
      if (t === S.token) setHtml("cphBody", upcomingHtml(d, pid));
    }, function (e) { if (t === S.token) setHtml("cphBody", failHtml(e)); });
  };

  function upcomingHtml(d, pid) {
    var plans = (d.plans || []).map(function (p) { return [str(p.id), str(p.label)]; });
    var head = '<div class="c-head"><div class="cph-filter"><label class="c-label" for="cphUpPlan">Show</label>' +
      '<select id="cphUpPlan" data-ch="up-plan">' + options([["", "Every active plan"]].concat(plans), pid ? String(pid) : "") +
      "</select></div>" + '<a class="c-btn ghost sm" href="#/photo/print/agenda' + (pid ? "?pid=" + pid : "") +
      '" title="These shoots on paper, by week, with a column to write in — or saved as a PDF">Print this list</a></div>';
    if (d.empty) return head + emptyHtml(NO_PLANS);
    var order = Array.isArray(d.order) && d.order.length ? d.order : ["overdue", "week", "next", "later", "undated", "done"];
    var words = d.group_words || {};
    var groups = d.groups || {};
    var copied = d.copied || {};
    var out = order.map(function (g) {
      var rows = groups[g] || [];
      if (!rows.length) return "";
      return '<section class="cph-group' + (g === "overdue" ? " late" : "") + '"><h3 class="cph-gh">' + esc(words[g] || g) +
        ' <span class="c-muted">— ' + esc(plural(rows.length, "shoot")) + "</span></h3>" +
        rows.map(function (s) { return shootRowHtml(s, copied); }).join("") + "</section>";
    }).join("");
    if (!out) out = emptyHtml("No shoots in the active plans yet.");
    var note = d.trimmed ? '<p class="c-help">Some shoots are left out here — too many to send at once' +
      (d.done_trimmed ? " (the done ones first)" : "") + ". Pick one plan under Show to see them all.</p>" : "";
    return head + note + out;
  }
  /* One shoot in a list across plans: a link to it in its plan. */
  function shootRowHtml(s, copied) {
    var cc = (copied || {})[String(s.project_id)] || [];
    var who = str(s.photographer), n = int(cc[0]);
    var whoWords = who ? who + (n ? " +" + n + " cc" : "") : "";
    var sub = [str(s.project_label), str(s.time_of_day)].filter(Boolean).join(" · ");
    var wx = [str(s.weather), str(s.golden) ? "golden hour " + dash(s.golden) : ""].filter(Boolean).join(" · ");
    return '<a class="cph-srow" href="#/photo/plan/' + int(s.project_id) + "/shoot/" + int(s.id) + '">' +
      '<span class="cph-srow-when"><b>' + esc(dayText(s.planned_date) || "No date") + "</b>" +
      (s.when_text ? '<span class="c-muted">' + esc(s.when_text) + "</span>" : "") + "</span>" +
      '<span class="cph-srow-what"><b>' + esc(s.name) + "</b>" + (sub ? '<span class="c-muted">' + esc(sub) + "</span>" : "") +
      (whoWords ? '<span class="c-muted"' + (n ? ' title="' + esc("Reminders go to " + (who || "the photographer") + "; copies to " +
        str(cc[1]) + ".") + '"' : "") + ">" + esc(whoWords) + "</span>" : "") +
      (wx ? '<span class="c-muted c-small">' + esc(wx) + "</span>" : "") + "</span>" +
      '<span class="cph-srow-chip">' + chipOf(s.chip) + "</span></a>";
  }
  CHANGE["up-plan"] = function (n) { goto("upcoming" + (num(n.value) ? "?pid=" + num(n.value) : "")); };

  /* ── Calendar ───────────────────────────────────────────────────────── */

  OVERVIEW.calendar = function (r, t) {
    var month = monthOk(r.q.month) ? r.q.month : todayIso().slice(0, 7);
    setHtml("cphBody", busyHtml("Reading the month…"));
    return read("photo.calendar", { month: month }).then(function (d) {
      if (t !== S.token) return;
      S.v.cal = d;
      var first = str(d.first), last = str(d.last);
      var day = S.calDay && S.calDay >= first && S.calDay <= last ? S.calDay :
        str(d.today) >= first && str(d.today) <= last && str(d.today).slice(0, 7) === month ? str(d.today) : month + "-01";
      S.calDay = day;
      setHtml("cphBody", calendarHtml(d, month));
    }, function (e) { if (t === S.token) setHtml("cphBody", failHtml(e)); });
  };

  function calendarHtml(d, month) {
    var legend = [["Planned", "blue"], ["Heads-up sent", "purple"], ["Done", "green"], ["Late", "red"], ["Skipped", "grey"]]
      .map(function (x) { return chip(x[0], x[1]); }).join(" ");
    var title = str(d.title) || MONTHS_LONG[int(month.slice(5, 7)) - 1] + " " + month.slice(0, 4);
    var bar = '<div class="cph-calbar"><a class="c-btn ghost sm" href="#/photo/calendar?month=' + esc(shiftMonth(month, -1)) +
      '" aria-label="Previous month">‹</a><a class="c-btn ghost sm" href="#/photo/calendar" data-ph="cal-today">Today</a>' +
      '<a class="c-btn ghost sm" href="#/photo/calendar?month=' + esc(shiftMonth(month, 1)) + '" aria-label="Next month">›</a>' +
      '<h3 class="cph-caltitle">' + esc(title) + '</h3><span class="cph-legend">' + legend + "</span></div>";
    return bar + '<div class="cph-cal"><div class="cph-grid" id="cphGrid">' + gridHtml(d, month) + "</div>" +
      '<div class="cph-day c-card flat" id="cphDay">' + dayPanelHtml(d) + "</div></div>";
  }
  function gridHtml(d, month) {
    var first = asDay(d.first) || asDay(month + "-01");
    var shootDays = {};
    (d.shoot_days || []).forEach(function (x) { shootDays[int(x)] = 1; });
    var out = MON_FIRST.map(function (w) { return '<div class="cph-wd">' + w + "</div>"; }).join("");
    for (var k = 0; k < 42; k++) {
      var day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + k, 12);
      var iso = isoOf(day);
      var rows = (d.days || {})[iso] || [];
      var cls = "cph-cell" + (iso.slice(0, 7) === month ? "" : " out") + (shootDays[(day.getDay() + 6) % 7] ? "" : " off") +
        (iso === str(d.today) ? " today" : "") + (iso === S.calDay ? " sel" : "");
      var fit = rows.length > 3 ? 2 : rows.length;
      out += '<button type="button" class="' + cls + '" data-ph="cal-day" data-day="' + iso + '" aria-label="' +
        esc(longDayText(iso) + (rows.length ? ", " + plural(rows.length, "shoot") : "")) + '"' +
        (iso === S.calDay ? ' aria-pressed="true"' : "") + '><span class="cph-dn">' + day.getDate() + "</span>" +
        rows.slice(0, fit).map(function (s) {
          var tone = (s.chip || [])[1];
          return '<span class="cph-pill t-' + esc(own(TONE, tone) ? tone : "grey") + '">' + esc(s.name) + "</span>";
        }).join("") + (rows.length > fit ? '<span class="cph-more">+' + (rows.length - fit) + " more</span>" : "") + "</button>";
    }
    return out;
  }
  function dayPanelHtml(d) {
    var day = S.calDay;
    var rows = ((d && d.days) || {})[day] || [];
    return '<h3 class="cph-gh">' + esc(longDayText(day)) + "</h3>" + (rows.length ? rows.map(function (s) {
      return shootRowHtml(s, null);
    }).join("") : '<p class="c-muted">No shoots this day.</p>');
  }
  CLICK["cal-day"] = function (b) {
    var day = str(b.getAttribute("data-day"));
    if (!asDay(day) || !S.v.cal) return;
    var month = str(S.v.cal.month) || day.slice(0, 7);
    S.calDay = day;
    if (day.slice(0, 7) !== month) { goto("calendar?month=" + day.slice(0, 7)); return; }
    setHtml("cphGrid", gridHtml(S.v.cal, month));
    setHtml("cphDay", dayPanelHtml(S.v.cal));
  };
  CLICK["cal-today"] = function () { S.calDay = todayIso(); goto("calendar"); };

  /* ── Suggestions ────────────────────────────────────────────────────── */

  var SUG_STATUS = [["open", "Waiting for you"], ["applied", "Applied"], ["dismissed", "Dismissed"], ["expired", "Expired"]];

  OVERVIEW.suggestions = function (r, t) {
    var status = SUG_STATUS.some(function (s) { return s[0] === r.q.status; }) ? r.q.status : "open";
    var pid = num(r.q.pid);
    setHtml("cphBody", busyHtml("Reading the suggestions…"));
    return read("photo.suggestions", { status: status, pid: pid }).then(function (d) {
      if (t === S.token) setHtml("cphBody", suggestionsHtml(d, status, pid));
    }, function (e) { if (t === S.token) setHtml("cphBody", failHtml(e)); });
  };

  function suggestionsHtml(d, status, pid) {
    var rows = d.rows || [];
    var open = status === "open";
    var n = int(d.total) || rows.length;
    var head = '<div class="c-head"><div><h3 class="cph-h3">' + esc(open ? (n ? plural(n, "suggestion") + " waiting" : "Nothing waiting") :
      plural(n, "suggestion")) + "</h3></div><div class=\"c-actions\">" +
      '<select aria-label="Which suggestions" data-ch="sug-status">' + options(SUG_STATUS, status) + "</select>" +
      (open ? btn("Apply all safe", "sug-safe", { method: "photo.suggestions.apply_safe", write: true, disabled: !n,
        title: "Applies the suggestions the agent is sure of, and dates read from the project log or the timesheets. A " +
          "shoot is never marked done this way." }) : "") + "</div></div>" +
      (pid ? '<p class="c-help">One plan only. <a href="#/photo/suggestions' + (open ? "" : "?status=" + esc(status)) +
        '">Show every plan</a>.</p>' : "") +
      (open ? '<p class="c-help">The agent reads the project log, the timesheets, My Tasks, the uploaded photos and the ' +
        "forecast. What it can do safely by itself it does (Settings → When the agent may act alone); the rest waits here " +
        "for you.</p>" : "");
    if (!rows.length) {
      return head + emptyHtml(open ? "No suggestions right now. When the project log shows a delivery, the crew starts " +
        "framing, the photographer writes a note, or rain is coming on a shoot day, it shows up here." : "None.");
    }
    return head + rows.map(function (g) { return suggestionCard(g, open); }).join("");
  }
  function suggestionCard(g, open) {
    var conf = str(g.confidence_words);
    return '<div class="c-card cph-sug"><div class="cph-sug-head">' + chip(g.kind_words || g.kind, g.tone) +
      '<b class="cph-sug-where">' + esc(g.where) + "</b>" +
      (conf ? chip(conf, g.confidence === "high" ? "green" : "grey", "How sure the agent is") : "") + "</div>" +
      '<p class="cph-sug-reason">' + esc(g.reason) + "</p>" +
      '<div class="cph-sug-foot"><span class="c-muted c-small">' + esc(g.source_words) + "</span>" +
      (open ? '<span class="c-actions">' + btn("Apply", "sug-apply", { primary: true, method: "photo.suggestion.apply", write: true,
        data: { id: int(g.id) } }) + btn("Dismiss", "sug-dismiss", { method: "photo.suggestion.dismiss", write: true,
        data: { id: int(g.id) } }) + "</span>" : "") + "</div></div>";
  }
  CHANGE["sug-status"] = function (n) {
    var q = [];
    if (n.value && n.value !== "open") q.push("status=" + encodeURIComponent(n.value));
    if (num((S.r && S.r.q || {}).pid)) q.push("pid=" + num(S.r.q.pid));
    goto("suggestions" + (q.length ? "?" + q.join("&") : ""));
  };
  CLICK["sug-apply"] = function (b) {
    press(b, function () {
      return write("photo.suggestion.apply", { id: int(b.getAttribute("data-id")) }, { text: "Applying it…" });
    }).then(function (d) { if (d) { toast(d.words || "Applied."); paint(); } }, function (e) { toast(errWords(e), true); });
  };
  CLICK["sug-dismiss"] = function (b) {
    press(b, function () { return write("photo.suggestion.dismiss", { id: int(b.getAttribute("data-id")) }); })
      .then(function (d) { if (d) paint(); }, function (e) { toast(errWords(e), true); });
  };
  CLICK["sug-safe"] = function (b) {
    press(b, function () { return write("photo.suggestions.apply_safe", {}, { text: "Applying the safe suggestions…" }); })
      .then(function (d) { if (d) { toast(d.words); paint(); } }, function (e) { toast(errWords(e), true); });
  };

  /* ── Playbook & Coach ───────────────────────────────────────────────── */

  OVERVIEW.playbook = function (r, t) {
    setHtml("cphBody", '<div class="cph-pb"><div id="cphRules" class="c-card">' + busyHtml("Reading the Playbook…") + "</div>" +
      '<div id="cphCoach" class="c-card">' + busyHtml("Reading the Coach…") + "</div></div>");
    var a = read("photo.rules").then(function (d) { if (t === S.token) { S.v.rules = d; setHtml("cphRules", rulesHtml(d)); } },
      function (e) { if (t === S.token) setHtml("cphRules", failHtml(e)); });
    var b = read("photo.coach").then(function (d) { if (t === S.token) { S.v.coach = d; setHtml("cphCoach", coachHtml(d)); } },
      function (e) { if (t === S.token) setHtml("cphCoach", failHtml(e)); });
    return Promise.all([a, b]);
  };

  function rulesHtml(d) {
    var rules = d.rules || [];
    return '<div class="c-head"><h3 class="cph-h3">Playbook — every plan follows these</h3></div>' +
      (rules.length ? '<ul class="cph-rules">' + rules.map(function (r) {
        return '<li class="cph-rule' + (r.active ? "" : " off") + '"><label class="cph-on" title="Untick to keep the rule but stop ' +
          'plans from following it"><input type="checkbox" data-ch="rule-on" data-id="' + int(r.id) + '"' +
          (r.active ? " checked" : "") + (has("photo.rule.update") ? ' data-act="photo.rule.update"' : " disabled") +
          ' aria-label="Plans follow this rule"></label><div class="cph-rule-main"><div class="cph-rule-text">' + esc(r.text) +
          '</div><div class="c-muted c-small">' + esc([str(r.category_words), r.source_words ? "from " + r.source_words : ""]
            .filter(Boolean).join(" · ")) + "</div></div>" + '<div class="cph-rule-btns">' +
          btn("Edit", "rule-edit", { method: "photo.rule.update", write: true, data: { id: int(r.id) } }) +
          btn("Delete", "rule-del", { method: "photo.rule.delete", write: true, data: { id: int(r.id) } }) + "</div></li>";
      }).join("") + "</ul>" : emptyHtml("No rules yet. Add your own, or let the Coach suggest some.")) +
      '<div class="c-actions cph-rule-bar">' + btn("+ Add a rule", "rule-add", { method: "photo.rule.add", write: true }) +
      btn("Export", "pb-export", { method: "photo.playbook.export",
        title: "Save the Playbook as a file — to keep a copy or move it to another computer" }) +
      btn("Import…", "pb-import", { method: "photo.playbook.import", write: true,
        title: "Add the rules from an exported Playbook (ones already here are not added twice)" }) +
      '<input type="file" id="cphPbFile" accept=".json,application/json" hidden data-ch="pb-file"></div>';
  }
  function coachHtml(d) {
    var hist = d.history || [];
    var ai = d.ai || {};
    S.v.forms.coach = S.v.forms.coach || { words: "" };
    var chat = hist.length ? hist.map(function (c) {
      var mine = c.role !== "assistant";
      return '<div class="cph-msg ' + (mine ? "me" : "coach") + '"><b>' + (mine ? "You" : "Coach") + "</b>" +
        '<div class="c-pre">' + esc(c.content) + "</div></div>";
    }).join("") : '<p class="c-muted">' + esc(d.empty) + "</p>";
    var props = (d.proposals || []).map(function (p) {
      var why = [str(p.category) ? str(p.category).charAt(0).toUpperCase() + str(p.category).slice(1) : "", str(p.why)]
        .filter(Boolean).join(" · ");
      return '<div class="cph-prop"><div><div>' + esc(p.text) + "</div>" + (why ? '<div class="c-muted c-small">' + esc(why) +
        "</div>" : "") + "</div>" + (p.in_playbook ? '<button type="button" class="c-btn ghost sm" disabled>In the Playbook ✓</button>' :
        btn("Add to the Playbook", "coach-accept", { method: "photo.coach.accept", write: true,
          data: { chat: int(d.chat_id), n: int(p.n) } })) + "</div>";
    }).join("");
    return '<div class="c-head"><h3 class="cph-h3">Coach — teach the agent your style</h3></div>' +
      (d.history_trimmed ? '<p class="c-help">The latest messages only.</p>' : "") +
      '<div class="cph-chat">' + chat + "</div>" + (props ? '<div class="cph-props">' + props + "</div>" : "") +
      (d.note ? '<p class="cph-note warn">' + esc(d.note) + "</p>" : "") +
      '<textarea id="cphCoachText" rows="3" maxlength="2000" data-f="coach:words" placeholder="' +
      esc("e.g. “Our best clips are the crane lifts — always plan for the truss delivery” or “The drone never flies on Mondays”") +
      '"' + (ai.ok ? "" : " disabled") + "></textarea>" + '<div class="c-actions cph-end"><span id="cphCoachBusy"></span>' +
      btn("Send to the coach", "coach-send", { primary: true, method: "photo.coach.ask", write: true, disabled: !ai.ok }) + "</div>";
  }
  function editRule(rule) {
    var cats = (S.v.rules && S.v.rules.categories) || ["style"];
    return S.ctx.modal({
      title: rule ? "Playbook rule" : "Add a Playbook rule",
      message: "A rule is something every plan should follow, in your own words — “Always get one vertical clip for Reels” " +
        "or “No shoots on Sundays”.",
      okText: "Save",
      fields: [{ name: "text", type: "textarea", value: rule ? str(rule.text) : "", rows: 3 },
        { name: "category", label: "Kind", type: "select", value: rule ? str(rule.category || "style") : "style",
          options: cats.map(function (c) { return { value: c, label: str(c).charAt(0).toUpperCase() + str(c).slice(1) }; }) }],
      validate: function (v) {
        var s = str(v.text).trim();
        if (!s) return "Write the rule first.";
        if (/\n/.test(s)) return "One line, please.";
        if (s.length > 300) return "At most 300 characters.";
        return "";
      },
    });
  }
  function ruleById(id) { return ((S.v.rules && S.v.rules.rules) || []).filter(function (r) { return int(r.id) === id; })[0]; }
  CLICK["rule-add"] = function (b) {
    editRule(null).then(function (ans) {
      if (!ans) return;
      return press(b, function () { return write("photo.rule.add", { text: str(ans.text).trim(), category: ans.category }); })
        .then(function () { toast("Added to the Playbook."); paint(); });
    }).then(noop, function (e) { toast(errWords(e), true); });
  };
  CLICK["rule-edit"] = function (b) {
    var rule = ruleById(int(b.getAttribute("data-id")));
    if (!rule) return;
    editRule(rule).then(function (ans) {
      if (!ans) return;
      return press(b, function () {
        return write("photo.rule.update", { id: int(rule.id), text: str(ans.text).trim(), category: ans.category });
      }).then(function (d) { toast((d && d.words) || "Saved."); paint(); });
    }).then(noop, function (e) { toast(errWords(e), true); });
  };
  CLICK["rule-del"] = function (b) {
    press(b, function () { return act("photo.rule.delete", { id: int(b.getAttribute("data-id")) }); })
      .then(function (d) { if (d) { toast(d.words || "Deleted."); paint(); } }, function (e) { toast(errWords(e), true); });
  };
  CHANGE["rule-on"] = function (n) {
    var id = int(n.getAttribute("data-id")), on = !!n.checked;
    write("photo.rule.update", { id: id, active: on }).then(function () {
      toast(on ? "Plans follow this rule again." : "Kept, but plans no longer follow it.");
      paint();
    }, function (e) { n.checked = !on; toast(errWords(e), true); });
  };
  CLICK["pb-export"] = function (b) {
    press(b, function () { return read("photo.playbook.export", {}, { fresh: true }); }).then(function (d) {
      if (!d) return;
      download(str(d.file_name) || "photo-playbook.json", JSON.stringify(d.data, null, 2));
      var n = ((d.data || {}).rules || []).length;
      toast("Saved " + plural(n, "rule") + " to " + (str(d.file_name) || "photo-playbook.json") + " (your Downloads).");
    }, function (e) { toast(errWords(e), true); });
  };
  CLICK["pb-import"] = function () { var f = $("cphPbFile"); if (f && f.click) f.click(); };
  CHANGE["pb-file"] = function (n) {
    var file = n.files && n.files[0];
    if (!file) return;
    readFile(file).then(function (text) {
      n.value = "";
      var data;
      try { data = JSON.parse(text); } catch (e) { throw { message: "That file is not a Playbook export (it is not JSON)." }; }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw { message: "That file is not a Playbook export." };
      if (JSON.stringify({ data: data }).length > ARGS_MAX) {
        throw { message: "That Playbook is too large for the web — import it on the DCR server computer." };
      }
      return act("photo.playbook.import", { data: data }).then(function (d) { if (d) { toast(d.words); paint(); } });
    }).then(noop, function (e) { toast(errWords(e), true); });
  };
  CLICK["coach-send"] = function (b) {
    var words = str((S.v.forms.coach || {}).words).trim();
    if (!words) { toast("Write something to the coach first.", true); return; }
    var stop = working("cphCoachBusy", "The coach is thinking… this can take a minute");
    press(b, function () { return write("photo.coach.ask", { words: words }, { text: "The coach is thinking…" }); }, "Thinking…")
      .then(function (d) {
        stop();
        if (!d) return;
        S.v.forms.coach = { words: "" };
        S.cache[keyOf("photo.coach", {})] = { data: d, at: Date.now() };
        S.v.coach = d;
        setHtml("cphCoach", coachHtml(d));
      }, function (e) { stop(); toast(errWords(e), true); });
  };
  CLICK["coach-accept"] = function (b) {
    var chat = int(b.getAttribute("data-chat")), n = int(b.getAttribute("data-n"));
    press(b, function () { return write("photo.coach.accept", { chat_id: chat, n: n }); }).then(function (d) {
      if (!d) return;
      toast(d.words || "Added to the Playbook.");
      b.textContent = "Added ✓";
      b.disabled = true;
      b.removeAttribute("data-act");
      read("photo.rules", {}, { fresh: true }).then(function (r) { S.v.rules = r; setHtml("cphRules", rulesHtml(r)); }, noop);
    }, function (e) { toast(errWords(e), true); });
  };

  function download(name, text) {
    try {
      var blob = new Blob([text], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.rel = "noopener";
      (document.body || S.el).appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1000);
    } catch (e) { toast("This browser could not save the file.", true); }
  }
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      if (file.size > 2 * ARGS_MAX) { reject({ message: "That file is too large for the web — import it on the DCR server computer." }); return; }
      var fr = new FileReader();
      fr.onload = function () { resolve(str(fr.result)); };
      fr.onerror = function () { reject({ message: "Could not read that file." }); };
      fr.readAsText(file);
    });
  }

  /* ── Photo & Video settings (settings.get / settings.save, section photo) ─ */

  OVERVIEW.settings = function (r, t, top) {
    setHtml("cphBody", busyHtml("Reading the settings…"));
    return Promise.all([read("settings.get"), peopleRows(), top.then(null, function () { return S.o || {}; })]).then(function (res) {
      if (t !== S.token) return;
      var st = res[0] || {}, sec = (st.sections || {}).photo;
      if (!sec) { setHtml("cphBody", emptyHtml("This DCR server does not offer the Photo & Video settings yet.")); return; }
      var base = clone(sec.values || {});
      var kept = S.settings && S.settings.rev === sec.rev && !same(S.settings.form, S.settings.base) ? S.settings : null;
      S.settings = kept || { form: clone(base), base: base, rev: sec.rev, typed: "", pick: "" };
      S.v.set = { st: st, sec: sec, people: res[1] || [], o: res[2] || S.o || {}, kept: !!kept };
      S.v.forms.set = S.settings.form;
      S.v.forms.cc = S.settings;
      S.v.edited = { set: settingsEdited, cc: function () { ccProblem(""); } };
      setHtml("cphBody", settingsHtml());
    }, function (e) { if (t === S.token) setHtml("cphBody", failHtml(e)); });
  };

  function settingsHtml() {
    var x = S.v.set, sec = x.sec, f = S.settings.form;
    var fields = {};
    (sec.fields || []).forEach(function (fd) { fields[fd.key] = fd; });
    var used = {};
    var groups = SET_GROUPS.map(function (g) {
      var inner = g[1].filter(function (k) { return own(fields, k); }).map(function (k) { used[k] = 1; return setControl(fields[k], f); })
        .join("");
      if (!inner) return "";
      return '<section class="c-card cph-setgroup"><h3 class="cph-h3">' + esc(g[0]) + "</h3>" + inner +
        (g[2] ? '<p class="c-help">' + esc(g[2]) + "</p>" : "") + "</section>";
    }).join("");
    var rest = (sec.fields || []).filter(function (fd) { return !used[fd.key]; });
    if (rest.length) {
      groups += '<section class="c-card cph-setgroup"><h3 class="cph-h3">More</h3>' +
        rest.map(function (fd) { return setControl(fd, f); }).join("") + "</section>";
    }
    var claude = x.st.claude_words || [];
    return (x.kept ? '<div class="c-banner warn"><span>Your unsaved changes from before are kept — save them or ' +
      "reload.</span></div>" : "") + '<div class="cph-settings">' + groups + "</div>" +
      (claude[0] ? '<p class="c-help">The Claude key: ' + esc(claude[0]) + " " + esc(x.st.server_note || "") + "</p>" : "") +
      '<div class="c-actions cph-savebar"><span id="cphSetMsg" class="cph-msg-line" role="status"></span>' +
      btn("Save the Photo & Video settings", "set-save", { primary: true, method: "settings.save", write: true }) + "</div>";
  }
  function setControl(fd, f) {
    var k = fd.key, v = f[k], label = str(fd.label), help = str(fd.help);
    var fa = "set:" + k;
    switch (fd.type) {
      case "bool": return '<div class="c-field">' + check(label, fa, !!v) + "</div>";
      case "int":
        return field(label, '<input type="number" inputmode="numeric" data-f="' + esc(fa) + '" min="' + esc(fd.lo) + '" max="' +
          esc(fd.hi) + '" step="1" value="' + esc(v === null || v === undefined ? "" : v) + '">', help ||
          (fd.lo !== undefined ? fd.lo + " to " + fd.hi : ""));
      case "enum":
        return field(label, '<select data-f="' + esc(fa) + '">' + options((fd.choices || []).map(function (c) {
          return [c.key, c.label];
        }), v) + "</select>", k === "photo.auto_apply" ? AUTO_WHY[str(v)] || help : help,
        k === "photo.auto_apply" ? "cphAutoRow" : "");
      case "person": return field(label, personSelect(fa, k, v), help);
      case "days":
        var on = Array.isArray(v) ? v.map(Number) : [];
        return '<div class="c-field"><span class="c-label">' + esc(label) + '</span><div class="c-days" role="group" aria-label="' +
          esc(label) + '">' + MON_FIRST.map(function (d, i) {
            return '<label><input type="checkbox" data-f="set:' + esc(k) + "|" + i + '"' + (on.indexOf(i) >= 0 ? " checked" : "") +
              "> " + d + "</label>";
          }).join("") + "</div></div>";
      case "cc": return '<div class="c-field"><div id="cphCc" aria-label="' + esc(label) + '">' + ccEditorHtml("cc") + "</div></div>";
      case "cc_kinds":
        var kinds = Array.isArray(v) ? v : [];
        return '<div class="c-field"><span class="c-label">Copy them on</span>' + COPY_GROUPS.map(function (g) {
          return check(g[1], "set:" + k + "|" + g[0], kinds.indexOf(g[0]) >= 0);
        }).join("") + "</div>";
      default:
        return field(label, '<input type="text" data-f="' + esc(fa) + '" maxlength="' + esc(fd.max || 200) + '" value="' + esc(v) + '">',
          help);
    }
  }
  function personSelect(fa, key, cur) {
    var x = S.v.set, names = x.people.map(function (p) { return str(p.name); }).filter(Boolean);
    var first;
    if (key === "photo.admin_name") {
      var email = str(((x.st.sections || {}).general || {}).values && x.st.sections.general.values["general.admin_email"]);
      first = email ? "The admin email (" + email + ")" : "The admin email (not set yet)";
    } else {
      var hint = (x.o || {}).hint || {};
      first = hint.name ? "Automatic — the portal's best guess (" + hint.name + ")" :
        "Automatic — the person with the most photo tasks (not known yet)";
    }
    var opts = [["", first]].concat(names.map(function (n) { return [n, n]; }));
    if (cur && names.indexOf(str(cur)) < 0) opts.push([str(cur), str(cur) + " (not on the roster)"]);
    return '<select data-f="' + esc(fa) + '">' + options(opts, str(cur)) + "</select>";
  }
  /* A days or groups tick is kept as a list the PC understands. */
  function settingsEdited(path, v) {
    var f = S.settings.form;
    var m = /^(photo\.shoot_days)\|(\d)$/.exec(path);
    if (m) {
      var days = (Array.isArray(f[m[1]]) ? f[m[1]] : []).filter(function (d) { return int(d) !== int(m[2]); });
      if (v) days.push(int(m[2]));
      f[m[1]] = days.sort(function (a, b) { return a - b; });
      return;
    }
    var k = /^(photo\.cc_kinds)\|([a-z_]+)$/.exec(path);
    if (k) {
      var kinds = (Array.isArray(f[k[1]]) ? f[k[1]] : []).filter(function (x) { return x !== k[2]; });
      if (v) kinds.push(k[2]);
      f[k[1]] = COPY_GROUPS.map(function (g) { return g[0]; }).filter(function (g) { return kinds.indexOf(g) >= 0; });
      return;
    }
    if (path === "photo.auto_apply") setHtml("cphAutoRow", '<label class="c-label">' + esc(fieldLabel("photo.auto_apply")) +
      "</label>" + '<select data-f="set:photo.auto_apply">' + options(((fieldOf("photo.auto_apply") || {}).choices || [])
      .map(function (c) { return [c.key, c.label]; }), v) + '</select><div class="c-help">' + esc(AUTO_WHY[str(v)] || "") + "</div>");
    if (path === "photo.photographer") setHtml("cphCc", ccEditorHtml("cc"));
  }
  function fieldOf(key) { return ((S.v.set && S.v.set.sec.fields) || []).filter(function (f) { return f.key === key; })[0]; }
  function fieldLabel(key) { return str((fieldOf(key) || {}).label); }

  CLICK["set-save"] = function (b) {
    var s = S.settings, f = s.form, msg = $("cphSetMsg");
    var say = function (t, bad) { if (msg) { msg.textContent = t; msg.className = "cph-msg-line" + (bad ? " bad" : ""); } };
    if (own(f, "photo.shoot_days") && !(Array.isArray(f["photo.shoot_days"]) && f["photo.shoot_days"].length)) {
      say("Pick at least one shoot day. Nothing was saved.", true);
      return;
    }
    if (str(s.typed).trim()) {
      var problem = ccTakeTyped("cc");
      if (problem) { say("Also send copies to: " + problem + " Nothing was saved.", true); return; }
    }
    var values = {};
    Object.keys(f).forEach(function (k) {
      if (own(s.base, k) && !same(f[k], s.base[k])) {
        values[k] = f[k];
      }
    });
    if (!Object.keys(values).length) { say("Nothing changed."); return; }
    var daysChanged = own(values, "photo.shoot_days");
    press(b, function () {
      return S.ctx.rpc("settings.save", { section: "photo", values: values, rev: s.rev }, { quiet: true });
    }).then(function (d) {
      if (!d) return;
      forget("settings.get");
      forget("photo.");
      S.settings = null;
      toast((d.words || "Saved.") + (daysChanged ? " New dates follow the new shoot days the next time a plan is laid out." : ""));
      paint();
    }, function (e) { say(errWords(e), true); });
  };

  /* ── who gets copies: one editor for the every-plan list ("cc", in the
     settings) and a plan's own list ("pc", at the top of the plan) ──── */

  function copiesState(scope) { return scope === "cc" ? S.settings : S.v.copies; }
  function copiesPeople(scope) {
    var st = copiesState(scope);
    if (scope === "cc") return Array.isArray(st.form["photo.cc"]) ? st.form["photo.cc"] : (st.form["photo.cc"] = []);
    return st.people;
  }
  function copiesContext(scope) {
    if (scope === "pc") {
      var c = S.v.copies;
      return { roster: c.roster || [], photographer: str(c.photographer), groups: c.groups, max: int(c.max_people) || COPIES_MAX.pc,
        his: [] };
    }
    var x = S.v.set, who = str(S.settings.form["photo.photographer"]) || str((x.o || {}).photographer);
    var roster = [], his = [];
    (x.people || []).forEach(function (p) {
      var email = cleanEmail(p.email_override || p.email);
      if (who && str(p.name).toLowerCase() === who.toLowerCase()) {
        [p.email, p.email_override].forEach(function (e) { if (cleanEmail(e)) his.push(cleanEmail(e)); });
      }
      if (!email || emailProblem(email) || p.active === false) return;
      roster.push({ name: str(p.name), email: email });
    });
    return { roster: roster, photographer: who, his: his, max: COPIES_MAX.cc,
      groups: COPY_GROUPS.map(function (g) { return { key: g[0], words: g[1] }; }) };
  }
  function ccEditorHtml(scope) {
    var st = copiesState(scope), people = copiesPeople(scope), cx = copiesContext(scope);
    var onList = {};
    people.forEach(function (p) { onList[cleanEmail(p.email)] = 1; });
    var his = {};
    cx.his.forEach(function (e) { his[e] = 1; });
    var left = cx.roster.filter(function (p) { return !onList[cleanEmail(p.email)] && !his[cleanEmail(p.email)]; });
    var chips = people.length ? '<div class="cph-ccchips">' + people.map(function (p) {
      var who = str(p.name) ? p.name + "  ·  " + p.email : str(p.email);
      var held = str(p.hold);
      return '<span class="cph-ccchip' + (held ? " held" : "") + '" title="' + esc(held ? "No copy goes to " + p.email + ": " + held +
        ". " + str((S.v.copies || {}).undo_words) : p.email) + '">' + esc(held ? who + "  —  no copies: " + held : who) +
        '<button type="button" data-ph="cc-del" data-scope="' + scope + '" data-email="' + esc(cleanEmail(p.email)) +
        '" aria-label="' + esc("Remove " + (str(p.name) || p.email)) + '">✕</button></span>';
    }).join("") + "</div>" : '<p class="c-muted c-small">Nobody yet — only the photographer gets the reminders.</p>';
    var rosterSel = '<select data-f="' + scope + ':pick" aria-label="From the roster">' + options([["", left.length ? "Pick someone…" :
      cx.roster.length ? "Everyone on the roster with an email is added" : "Nobody on the roster has an email yet"]]
      .concat(left.map(function (p) { return [p.email, p.name + "  —  " + p.email]; })), str(st.pick)) + "</select>";
    return chips + '<div class="cph-ccadd"><label class="c-label">From the roster</label><div class="c-inline">' + rosterSel +
      btn("Add", "cc-add-roster", { data: { scope: scope }, disabled: !left.length }) + "</div>" +
      '<label class="c-label">Or type an address</label><div class="c-inline"><input type="text" data-f="' + scope +
      ':typed" maxlength="200" value="' + esc(st.typed) + '" placeholder="name@example.com  or  Maria Lopez &lt;maria@example.com&gt;"' +
      ' data-enter="cc-add-typed" data-enter-btn="cphCcAdd-' + scope + '">' +
      btn("Add", "cc-add-typed", { data: { scope: scope }, id: "cphCcAdd-" + scope }) + "</div>" +
      '<div class="cph-problem" id="cphCcProblem-' + scope + '" role="alert">' + esc(st.problem || "") + "</div></div>";
  }
  function ccRedraw(scope) { setHtml(scope === "cc" ? "cphCc" : "cphPcEditor", ccEditorHtml(scope)); }
  function ccProblem(text, scope) {
    scope = scope || "cc";
    var st = copiesState(scope);
    if (st) st.problem = text;
    setHtml("cphCcProblem-" + scope, esc(text));
    return text;
  }
  function ccAdd(scope, name, email) {
    var people = copiesPeople(scope), cx = copiesContext(scope);
    var problem = addProblem(people, name, email, cx.photographer, cx.his, cx.max);
    if (problem) return ccProblem(problem, scope);
    if (!name) name = (cx.roster.filter(function (p) { return cleanEmail(p.email) === cleanEmail(email); })[0] || {}).name || "";
    people.push({ name: str(name).split(/\s+/).join(" ").trim().slice(0, 80), email: cleanEmail(email) });
    copiesState(scope).problem = "";
    return "";
  }
  /* What is still in the address box is added as if Add had been pressed
     (typing an address and pressing Save means "copy them"). */
  function ccTakeTyped(scope) {
    var st = copiesState(scope);
    var p = parseTyped(st.typed);
    if (p.problem) { ccRedraw(scope); return ccProblem(p.problem, scope); }
    if (copiesPeople(scope).some(function (x) { return cleanEmail(x.email) === p.email; })) { st.typed = ""; return ""; }
    var problem = ccAdd(scope, p.name, p.email);
    if (!problem) st.typed = "";
    ccRedraw(scope);
    return problem;
  }
  CLICK["cc-del"] = function (b) {
    var scope = b.getAttribute("data-scope") === "pc" ? "pc" : "cc";
    var email = cleanEmail(b.getAttribute("data-email"));
    var people = copiesPeople(scope);
    for (var i = people.length - 1; i >= 0; i--) if (cleanEmail(people[i].email) === email) people.splice(i, 1);
    ccRedraw(scope);
  };
  CLICK["cc-add-roster"] = function (b) {
    var scope = b.getAttribute("data-scope") === "pc" ? "pc" : "cc";
    var st = copiesState(scope);
    if (!str(st.pick)) { ccProblem("Pick someone in the list first.", scope); return; }
    if (!ccAdd(scope, "", st.pick)) st.pick = "";
    ccRedraw(scope);
  };
  CLICK["cc-add-typed"] = function (b) {
    var scope = b.getAttribute("data-scope") === "pc" ? "pc" : "cc";
    if (!str(copiesState(scope).typed).trim()) { ccProblem("Type an email address.", scope); return; }
    ccTakeTyped(scope);
  };

  /* The copy lists' checks, in the editors' words (photo/copies.py); the PC
     checks again on save. */
  function cleanEmail(t) { return str(t).trim().replace(/^<|>$/g, "").trim().toLowerCase(); }
  function emailProblem(t) {
    var s = str(t).trim();
    if (!s) return "Type an email address.";
    var parts = s.split(/[\s,;]+/).filter(Boolean);
    if (parts.filter(function (p) { return p.indexOf("@") >= 0; }).length > 1) return "One address at a time.";
    if (s.indexOf("@") < 0) return "That is not an email address — it has no @.";
    if (parts.length > 1) return "An email address has no spaces or commas in it.";
    if (!EMAIL_RX.test(s) || s.indexOf("..") >= 0 || s.charAt(0) === "." || /\.$/.test(s.split("@")[0])) {
      return "That doesn't look like an email address.";
    }
    return "";
  }
  function parseTyped(text) {
    var s = str(text).trim(), name = "";
    var m = /^\s*"?([^"<>]*?)"?\s*<\s*([^<>\s]+)\s*>\s*$/.exec(s);
    if (m) { name = m[1].trim(); s = m[2].trim(); }
    var problem = emailProblem(s);
    return { name: name.split(/\s+/).join(" ").slice(0, 80), email: problem ? "" : cleanEmail(s), problem: problem };
  }
  function addProblem(people, name, email, photographer, his, max) {
    email = cleanEmail(email);
    var problem = emailProblem(email);
    if (problem) return problem;
    if (people.some(function (p) { return cleanEmail(p.email) === email; })) return email + " is on the list already.";
    var who = str(name).trim();
    if ((his || []).indexOf(email) >= 0 || (photographer && who && who.toLowerCase() === photographer.toLowerCase())) {
      return (photographer || "That person") + " is the photographer and already gets the reminders — never a copy.";
    }
    if (people.length >= max) return "At most " + max + " people.";
    return "";
  }

  /* ══ one plan ═══════════════════════════════════════════════════════ */

  function planPage(r, t) {
    var pid = r.pid;
    S.el.innerHTML = '<div class="cph-crumbs">' + back("All plans", "plans") + "</div>" +
      '<div id="cphPlan">' + busyHtml("Reading the plan…") + "</div>";
    return read("photo.project", { pid: pid }).then(function (p) {
      if (t !== S.token) return;
      S.v.p = p;
      if (p.status === "draft" || p.status === "interview") return wizardPage(p, r, t);
      planView(p, r, t);
    }, function (e) { if (t === S.token) setHtml("cphPlan", failHtml(e)); });
  }

  function planView(p, r, t) {
    var sid = r.sid;
    var shoots = p.shoots || [];
    if (sid && !shoots.some(function (s) { return int(s.id) === sid; })) sid = null;
    S.v.sid = sid;
    var root = $("cphPlan");
    if (!root) return;
    if (root.classList) root.classList.toggle("has-shoot", !!sid);
    root.innerHTML = (p.status === "review" ? stepBarHtml(3) : "") + planHeadHtml(p) +
      '<div id="cphCopies"></div>' +
      '<div class="cph-planonly"><div id="cphGame" class="cph-game">' + gamePlanHtml(p) + '</div><div id="cphMs">' +
      milestonesHtml(p) + "</div></div>" +
      '<div class="cph-planbody' + (sid ? " has-shoot" : "") + '">' +
      '<div class="cph-shoots" id="cphShoots">' + shootListHtml(p, sid) + "</div>" +
      '<div class="cph-detail" id="cphDetail">' + (sid ? "" : '<p class="c-muted cph-pick">Pick a shoot to see and edit its brief.</p>') +
      "</div></div>" + '<div class="cph-planonly">' + reviseHtml(p) + "</div>";
    msInit(p);
    if (sid) shootPane(p, sid, t);
  }

  function planHeadHtml(p) {
    var b = p.buttons || {};
    var c = p.copies || {};
    var pid = int(p.id);
    var acts = [
      btn(str(p.who_words) + " ▾", "plan-who", { method: "photo.plan.photographer", write: true, title: "Change the photographer for this plan" }),
      btn("Copies: " + (str(c.count_words) || "nobody") + " ▾", "plan-copies", { method: "photo.plan.copies", title: str(c.words) }),
      b.print ? '<a class="c-btn ghost sm" href="#/photo/print/' + pid + '" title="Every shoot of this plan on paper for the ' +
        'photographer — shot lists to tick, room for notes — or saved as a PDF">Print schedule</a>' : "",
      b.sync ? btn("Sync now", "plan-sync", { method: "photo.plan.sync", write: true,
        title: "Read the project log, timesheets, My Tasks and photos for this plan now" }) : "",
      b.pause ? btn(str(b.pause_text) || "Pause", "plan-status", { method: "photo.plan.status", write: true,
        data: { action: str(b.pause_text) === "Resume" ? "resume" : "pause" } }) : "",
      btn(str(b.archive_text) || "Archive", "plan-status", { method: "photo.plan.status", write: true,
        data: { action: str(b.archive_text) === "Bring back" ? "unarchive" : "archive" } }),
    ].filter(Boolean).join("");
    return '<div class="cph-planhead"><div class="cph-planhead-top"><h2 class="c-title">' + esc(p.label) + "</h2> " +
      chipOf(p.chip) + "</div>" + (p.header_words ? '<p class="c-sub">' + esc(p.header_words) + "</p>" : "") +
      '<div class="c-actions cph-planacts">' + acts + "</div>" + '<div id="cphPlanBusy"></div></div>';
  }

  function gamePlanHtml(p) {
    var plan = p.plan || {};
    var made = str(p.made_by_words);
    var summary = str(plan.summary);
    var long = summary.length > 150;
    var open = !!S.v.openPlan;
    var shown = long && !open ? summary.slice(0, 150).replace(/\s+\S*$/, "") + "…" : summary;
    return '<div class="cph-game-head"><h3 class="cph-h3">' + esc(plan.title || p.label) + "</h3>" +
      chip(made, made.indexOf("Made by") === 0 ? "purple" : "grey") +
      (long || plan.story ? btn(open ? "Hide the game plan" : "Show the whole game plan", "plan-text", { cls: "link" }) : "") +
      "</div>" + (shown ? '<p class="cph-game-text">' + esc(shown) + "</p>" : "") +
      (open && plan.story ? '<p class="c-muted">' + esc("The story: " + plan.story) + "</p>" : "") +
      (p.briefs_trimmed || (p.trimmed || []).length ? '<p class="c-help">This plan is large, so each shoot\'s brief is read ' +
        "when you open the shoot.</p>" : "");
  }
  CLICK["plan-text"] = function () {
    S.v.openPlan = !S.v.openPlan;
    if (S.v.p) setHtml("cphGame", gamePlanHtml(S.v.p));
  };

  /* ── the milestones: what a change moves, before anything is saved ── */

  function milestoneRows(p) {
    return (p.milestone_rows || []).filter(function (m) { return own({ framing_start: 1, delivery: 1, framing_complete: 1,
      house_complete: 1 }, m.key); });
  }
  function msBase(p) {
    var out = {};
    milestoneRows(p).forEach(function (m) {
      out[m.key] = { day: str(m.date), unsure: !m.date, firm: !!(m.date && m.confirmed) };
    });
    return out;
  }
  function msInit(p) {
    var pid = int(p.id), base = msBase(p);
    var kept = S.ms[pid];
    if (!kept || !same(kept.base, base)) kept = S.ms[pid] = { form: clone(base), base: base };
    S.v.forms.ms = kept.form;
    S.v.edited = S.v.edited || {};
    S.v.edited.ms = function (path) { msEdited(pid, path); };
    if (msPending(pid).length) { setHtml("cphMs", milestonesHtml(p)); msPreviewSoon(pid); }
  }
  function msPending(pid) {
    var st = S.ms[pid];
    if (!st) return [];
    return Object.keys(st.form).filter(function (k) {
      var f = st.form[k], b = st.base[k] || {};
      var now = f.unsure || !f.day ? [null, false] : [f.day, !!f.firm];
      var was = b.unsure ? [null, false] : [b.day, !!b.firm];
      return !same(now, was);
    }).map(function (k) {
      var f = st.form[k];
      return { key: k, day: f.unsure || !f.day ? null : f.day, confirmed: !(f.unsure || !f.day) && !!f.firm };
    });
  }
  function milestonesHtml(p) {
    var pid = int(p.id), st = S.ms[pid], form = st ? st.form : msBase(p);
    var pending = msPending(pid).length;
    return '<div class="cph-ms">' + milestoneRows(p).map(function (m) {
      var f = form[m.key] || {};
      var off = f.unsure;
      return '<div class="cph-mscol"><div class="cph-msname"><b>' + esc(m.name) + "</b>" +
        (m.source_words ? ' <span class="c-muted c-small" title="' + esc(m.tip) + '">· ' + esc(m.source_words) + "</span>" : "") +
        '</div><input type="date" id="cphMsD-' + m.key + '" data-f="ms:' + m.key + '.day" value="' + esc(f.day || "") + '"' +
        (off ? " disabled" : "") + ' aria-label="' + esc(m.name) + '" title="' + esc(m.tip) + '">' +
        '<div class="cph-msopts">' + check("Not sure", "ms:" + m.key + ".unsure", !!f.unsure) +
        check("Firm", "ms:" + m.key + ".firm", !!f.firm, ' id="cphMsF-' + m.key + '" title="A firm date is never moved by the ' +
          'agent by itself; it only suggests a change."' + (off ? " disabled" : "")) + "</div></div>";
    }).join("") + '<div class="cph-msbar" id="cphMsBar"' + (pending ? "" : " hidden") + '><span class="cph-warnline" id="cphMsPreview">' +
      (pending ? "Working out what moves…" : "") + "</span>" + btn("Undo", "ms-undo") +
      btn("Save the dates", "ms-save", { primary: true, method: "photo.milestones.save", write: true }) + "</div></div>";
  }
  function msEdited(pid, path) {
    var st = S.ms[pid];
    var m = /^([a-z_]+)\.(day|unsure|firm)$/.exec(path);
    if (!st || !m) return;
    var f = st.form[m[1]];
    if (m[2] === "unsure") {
      if (!f.unsure && !f.day) {
        f.day = todayIso();
        var d = $("cphMsD-" + m[1]);
        if (d) d.value = f.day;
      }
      var di = $("cphMsD-" + m[1]), fi = $("cphMsF-" + m[1]);
      if (di) di.disabled = !!f.unsure;
      if (fi) fi.disabled = !!f.unsure;
    }
    var bar = $("cphMsBar");
    var pending = msPending(pid);
    if (bar) bar.hidden = !pending.length;
    if (pending.length) { setHtml("cphMsPreview", "Working out what moves…"); msPreviewSoon(pid); }
  }
  function msPreviewSoon(pid) {
    clearTimeout(S.v.msTimer);
    S.v.msTimer = later(function () {
      var changes = msPending(pid);
      if (!changes.length) return;
      var asked = JSON.stringify(changes), t = S.token;
      read("photo.milestones.preview", { pid: pid, changes: changes }).then(function (d) {
        if (t === S.token && JSON.stringify(msPending(pid)) === asked) setHtml("cphMsPreview", esc(d.text));
      }, function (e) { if (t === S.token) setHtml("cphMsPreview", esc(errWords(e))); });
    }, WAIT_MS);
  }
  CLICK["ms-undo"] = function () {
    var p = S.v.p;
    if (!p) return;
    delete S.ms[int(p.id)];
    msInit(p);
    setHtml("cphMs", milestonesHtml(p));
  };
  CLICK["ms-save"] = function (b) {
    var p = S.v.p;
    if (!p) return;
    var pid = int(p.id), changes = msPending(pid);
    if (!changes.length) return;
    press(b, function () {
      return write("photo.milestones.save", { pid: pid, changes: changes }, { text: "Saving the dates and moving the shoots…" });
    }).then(function (d) {
      if (!d) return;
      delete S.ms[pid];
      toast(d.words);
      paint();
    }, function (e) { toast(errWords(e), true); });
  };

  /* ── the shoots ─────────────────────────────────────────────────────── */

  function shootListHtml(p, sid) {
    var rows = (p.shoots || []).slice();
    var open = rows.filter(function (s) { return s.status === "planned" || s.status === "announced"; }).length;
    var pid = int(p.id);
    return '<h3 class="cph-h3">' + esc(plural(rows.length, "shoot") + " — " + open + " still to do") + "</h3>" +
      (rows.length ? '<div class="cph-slist">' + rows.map(function (s) {
        var dim = s.status === "skipped" || s.status === "missed";
        var on = int(s.id) === sid;
        return '<a class="cph-sitem' + (dim ? " dim" : "") + (on ? " on" : "") + '" href="#/photo/plan/' + pid + "/shoot/" + int(s.id) +
          '"' + (on ? ' aria-current="true"' : "") + ' title="' + esc(str(s.name) + (s.phase_words ? " — " + s.phase_words : "")) +
          '"><span class="cph-sitem-day">' + esc(dayText(s.planned_date) || "—") + '</span><span class="cph-sitem-name">' +
          esc(s.name) + "</span>" + chipOf(s.chip) + "</a>";
      }).join("") + "</div>" : emptyHtml("No shoots yet."));
  }

  function shootPane(p, sid, t) {
    var row = (p.shoots || []).filter(function (s) { return int(s.id) === sid; })[0];
    var pid = int(p.id);
    setHtml("cphDetail", '<div class="cph-crumbs cph-backplan">' + back("Back to the plan", "plan/" + pid) + "</div>" +
      shootHeadHtml(row, null) + busyHtml("Reading the shoot…"));
    return read("photo.shoot", { sid: sid }).then(function (s) {
      if (t !== S.token) return;
      S.v.s = s;
      var base = formFrom(s);
      var kept = S.shoot[sid];
      var note = "";
      if (kept && !same(kept.form, kept.base)) {
        if (kept.rev === s.rev) note = "kept";
        else { note = "stale"; kept = null; }
      } else kept = null;
      if (!kept) kept = S.shoot[sid] = { form: base, base: clone(base), rev: s.rev };
      S.v.forms.shoot = kept.form;
      S.v.edited = S.v.edited || {};
      S.v.edited.shoot = function () { shootDirty(sid); };
      S.v.forms.act = { note: "", reason: "", status: "skipped", day: "", notify: true, rating: int((s.feedback || {}).rating) || 4,
        used: {}, dnote: "" };
      S.v.edited.act = actEdited;
      setHtml("cphDetail", shootHtml(p, s, note));
      shootDirty(sid);
    }, function (e) { if (t === S.token) setHtml("cphDetail", failHtml(e)); });
  }

  function shootHeadHtml(s, full) {
    if (!s) return "";
    var date = longDayText(s.planned_date) || "No date yet — its milestone is not known";
    return '<div class="cph-shead"><div class="c-muted c-small">' + esc([str(s.phase_words), str(s.project_label)].filter(Boolean)
      .join(" · ")) + "</div>" + '<h3 class="cph-h3 cph-sh3">' + esc(s.name) + "</h3>" +
      '<div class="cph-swhen">' + esc(date + (s.when_text ? "  (" + s.when_text + ")" : "")) + " " + chipOf(s.chip) + "</div></div>";
  }

  function formFrom(s) {
    var b = s.brief || {}, drone = b.drone || {};
    var f = { name: str(s.name), window_days: int(s.window_days), time_of_day: str(b.time_of_day), purpose: str(b.purpose),
      shots: (Array.isArray(b.shots) ? b.shots : []).map(function (x) {
        return { must: x.priority === "must", shot: str(x.title), frame: str(x.description), kind: str(x.kind) || "photo" };
      }), sample_shot: str(b.sample_shot), drone: { needed: !!drone.needed, notes: str(drone.notes) }, lists: {} };
    LIST_FIELDS.forEach(function (lf) { f.lists[lf[0]] = lines(b[lf[0]]); });
    return f;
  }

  function shootHtml(p, s, note) {
    var sid = int(s.id);
    var f = S.shoot[sid].form;
    var listFields = (s.list_fields || []).length ? s.list_fields.map(function (x) { return [str(x.key), str(x.words)]; }) : LIST_FIELDS;
    var notes = (s.notes || []).map(function (n) {
      return esc(str(n.day) + "  " + str(n.text) + (n.who === "office" ? "  (the office)" : ""));
    });
    var moves = (s.history || []).map(function (h) {
      return esc((dayText(h.from) || "no date") + " → " + (dayText(h.to) || "no date") + " (" + str(h.reason) + ")");
    });
    var fb = s.feedback || null;
    var light = '<div class="cph-light"><span id="cphLight" class="c-muted">' + esc(s.light) + "</span>" +
      (s.planned_date ? btn("Check the forecast", "shoot-wx", { method: "photo.shoot.conditions",
        title: "Asks Open-Meteo (free, no key) for the next days at the site" }) : "") + "</div>";
    return '<div class="cph-crumbs cph-backplan">' + back("Back to the plan", "plan/" + int(p.id)) + "</div>" +
      (note === "kept" ? '<div class="c-banner warn"><span>Your unsaved changes from before are kept — Save or Undo.</span></div>' :
        note === "stale" ? '<div class="c-banner warn"><span>This shoot changed on the DCR server while you were editing it, so ' +
          "your unsaved changes were set aside.</span></div>" : "") +
      shootHeadHtml(s, true) + light +
      '<div class="cph-acts" id="cphActs">' + actionsHtml(s) + '</div><div id="cphPanel" class="cph-panel"></div>' +
      '<div class="cph-form">' +
      field("Shoot", '<input type="text" class="cph-sname" data-f="shoot:name" maxlength="80" value="' + esc(f.name) + '">') +
      '<div class="cph-two">' + field("Time of day", '<input type="text" data-f="shoot:time_of_day" maxlength="80" value="' +
        esc(f.time_of_day) + '" placeholder="golden hour, about an hour before sunset">') +
      field("Can still be done up to", '<div class="c-inline"><input type="number" data-f="shoot:window_days" min="0" max="14" ' +
        'step="1" value="' + esc(f.window_days) + '"><span>days after the date</span></div>', "How long after the planned day the " +
        "shoot still counts as on time; after that, follow-ups start.") + "</div>" +
      field("Purpose", '<textarea rows="' + rowsFor(f.purpose, 2) + '" data-f="shoot:purpose" maxlength="400">' + esc(f.purpose) + "</textarea>") +
      '<div class="c-field"><div class="cph-shotshead"><span class="c-label">Shot list</span>' +
      btn("+ Shot", "shot-add", { id: "cphShotAdd" }) + '</div><div id="cphShots">' + shotsHtml(f) + "</div></div>" +
      field("Sample shot", '<textarea rows="' + rowsFor(f.sample_shot, 2) + '" data-f="shoot:sample_shot" maxlength="700">' + esc(f.sample_shot) + "</textarea>") +
      listFields.map(function (lf) {
        var lim = LIST_LIMITS[lf[0]];
        return field(lf[1] + " (one per line)", '<textarea rows="' + rowsFor(f.lists[lf[0]], 3) + '" data-f="shoot:lists.' + esc(lf[0]) + '">' +
          esc(f.lists[lf[0]] || "") + "</textarea>", lim ? "At most " + lim[0] + " lines of " + lim[1] + " characters." : "");
      }).join("") +
      '<div class="c-field cph-drone">' + check("A drone is needed", "shoot:drone.needed", !!f.drone.needed) +
      '<input type="text" data-f="shoot:drone.notes" maxlength="300" value="' + esc(f.drone.notes) +
      '" placeholder="Drone notes — airspace, launch spot, wind" aria-label="Drone notes"></div>' +
      (notes.length ? '<div class="c-field"><span class="c-label">Notes from My Tasks</span><div class="c-pre c-muted c-small">' +
        notes.join("\n") + "</div></div>" : "") +
      (moves.length ? '<p class="c-muted c-small">Moves: ' + moves.join("; ") + "</p>" : "") +
      (fb ? '<p class="c-muted c-small">Debrief: ' + esc("★★★★★".slice(0, int(fb.rating)) + " " + ratingWords(fb.rating) +
        (fb.note ? " — " + fb.note : "")) + "</p>" : "") +
      "</div>" + '<div class="cph-savebar c-actions" id="cphSaveBar"><span class="cph-warnline" id="cphDirty"></span>' +
      btn("Undo changes", "shoot-undo", { id: "cphUndo" }) +
      btn("Save the shoot", "shoot-save", { primary: true, method: "photo.shoot.save", write: true, id: "cphSave" }) + "</div>";
  }
  /* Room for what a box already holds: its lines, long lines wrapped at about 60 characters. */
  function rowsFor(text, least) {
    var n = str(text).split(/\n/).reduce(function (a, l) { return a + Math.max(1, Math.ceil(l.length / 60)); }, 0);
    return Math.max(least || 2, Math.min(12, n + 1));
  }
  function ratingWords(n) { var r = RATINGS.filter(function (x) { return x[0] === int(n); })[0]; return r ? r[1] : ""; }

  function shotsHtml(f) {
    var kinds = (S.v.s && S.v.s.shot_kinds && S.v.s.shot_kinds.length) ?
      S.v.s.shot_kinds.map(function (k) { return [str(k.kind), str(k.words)]; }) : SHOT_KINDS;
    if (!f.shots.length) return '<p class="c-muted c-small">No shots yet — “+ Shot” adds one.</p>';
    return f.shots.map(function (x, i) {
      return '<div class="cph-shot"><span class="cph-shot-must">' + check("Must", "shoot:shots." + i + ".must", !!x.must) + "</span>" +
        '<input type="text" class="cph-shot-shot" data-f="shoot:shots.' + i + '.shot" maxlength="100" value="' + esc(x.shot) +
        '" placeholder="Shot" aria-label="Shot">' + '<textarea class="cph-shot-frame" rows="' + Math.min(4, rowsFor(x.frame, 2)) + '" data-f="shoot:shots.' + i +
        '.frame" maxlength="300" placeholder="What to frame" aria-label="What to frame">' + esc(x.frame) + "</textarea>" +
        '<select class="cph-shot-kind" data-f="shoot:shots.' + i + '.kind" aria-label="Kind">' + options(kinds, x.kind) + "</select>" +
        '<button type="button" class="c-btn ghost sm cph-x" data-ph="shot-del" data-i="' + i + '" aria-label="Remove this shot">✕</button></div>';
    }).join("");
  }
  function shootDirty(sid) {
    var st = S.shoot[sid];
    var dirty = !!st && !same(st.form, st.base);
    setHtml("cphDirty", dirty ? "Unsaved changes" : "");
    var u = $("cphUndo"), sv = $("cphSave");
    if (u) u.disabled = !dirty;
    if (sv && !sv.getAttribute("data-c-nom") && !sv.getAttribute("data-c-off")) sv.disabled = !dirty;
    var add = $("cphShotAdd");
    if (add && st) add.disabled = st.form.shots.length >= MAX_SHOTS;
    return dirty;
  }
  CLICK["shot-add"] = function () {
    var sid = S.v.sid, st = S.shoot[sid];
    if (!st || st.form.shots.length >= MAX_SHOTS) return;
    st.form.shots.push({ must: true, shot: "", frame: "", kind: "photo" });
    setHtml("cphShots", shotsHtml(st.form));
    shootDirty(sid);
  };
  CLICK["shot-del"] = function (b) {
    var sid = S.v.sid, st = S.shoot[sid], i = int(b.getAttribute("data-i"), -1);
    if (!st || i < 0 || i >= st.form.shots.length) return;
    st.form.shots.splice(i, 1);
    setHtml("cphShots", shotsHtml(st.form));
    shootDirty(sid);
  };
  CLICK["shoot-undo"] = function () {
    var sid = S.v.sid, st = S.shoot[sid];
    if (!st || !S.v.s) return;
    st.form = clone(st.base);
    S.v.forms.shoot = st.form;
    setHtml("cphDetail", shootHtml(S.v.p, S.v.s, ""));
    shootDirty(sid);
  };
  /* What the save sends; a problem in the editor's own words stops it here. */
  function shootArgs(sid) {
    var st = S.shoot[sid], f = st.form;
    var name = str(f.name).trim();
    if (!name) return { problem: "Give the shoot a name." };
    var wd = f.window_days === null || f.window_days === "" ? 0 : Number(f.window_days);
    if (!(wd >= 0 && wd <= 14 && Math.floor(wd) === wd)) return { problem: "“Can still be done up to” is 0 to 14 days." };
    var shots = f.shots.filter(function (x) { return str(x.shot).trim() || str(x.frame).trim(); }).map(function (x) {
      return { must: !!x.must, shot: str(x.shot).trim(), frame: str(x.frame).trim(), kind: str(x.kind) || "photo" };
    });
    if (shots.length > MAX_SHOTS) return { problem: "At most " + MAX_SHOTS + " shots." };
    var brief = { time_of_day: str(f.time_of_day).trim(), purpose: str(f.purpose).trim(), shots: shots,
      sample_shot: str(f.sample_shot).trim(), drone: { needed: !!f.drone.needed, notes: str(f.drone.notes).trim() } };
    for (var i = 0; i < LIST_FIELDS.length; i++) {
      var k = LIST_FIELDS[i][0], lim = LIST_LIMITS[k], items = splitLines(f.lists[k]);
      if (items.length > lim[0]) return { problem: LIST_FIELDS[i][1] + ": at most " + lim[0] + " lines." };
      if (items.some(function (x) { return x.length > lim[1]; })) {
        return { problem: LIST_FIELDS[i][1] + ": a line is longer than " + lim[1] + " characters." };
      }
      brief[k] = items;
    }
    return { args: { sid: sid, rev: st.rev, name: name, window_days: wd, brief: brief } };
  }
  CLICK["shoot-save"] = function (b) {
    var sid = S.v.sid;
    if (!S.shoot[sid]) return;
    var a = shootArgs(sid);
    if (a.problem) { setHtml("cphDirty", esc(a.problem)); toast(a.problem, true); return; }
    saveShoot(b, sid, a.args).then(noop, noop);
  };
  function saveShoot(b, sid, args) {
    return press(b, function () { return write("photo.shoot.save", args); }).then(function (d) {
      if (!d) return d;
      var st = S.shoot[sid];
      st.rev = d.rev;
      st.base = clone(st.form);
      toast(d.words || "Saved.");
      shootDirty(sid);
      refreshList(sid);
      return d;
    }, function (e) { toast(errWords(e), true); throw e; });
  }
  /* The list beside the shoot, read again (a name may have changed). */
  function refreshList(sid) {
    var p = S.v.p, t = S.token;
    if (!p) return;
    read("photo.project", { pid: int(p.id) }).then(function (np) {
      if (t !== S.token) return;
      S.v.p = np;
      setHtml("cphShoots", shootListHtml(np, sid));
    }, noop);
  }
  CLICK["shoot-wx"] = function (b) {
    var sid = S.v.sid;
    press(b, function () { return read("photo.shoot.conditions", { sid: sid }, { fresh: true }); }, "Asking…").then(function (d) {
      if (d) setHtml("cphLight", esc(d.words));
    }, function (e) { toast(errWords(e), true); });
  };

  /* ── a shoot's actions (ShootActions.menu): each opens a small panel ── */

  var ACTION_WORDS = { send: "Send reminder now", done: "Mark done", skip: "Skip", move: "Move", bring_back: "Bring it back",
    task: "Open its task", print: "Print this shoot", post_kit: "Post kit", debrief: "Debrief" };
  var ACTION_METHOD = { send: "photo.shoot.send", done: "photo.shoot.done", skip: "photo.shoot.skip", move: "photo.shoot.move",
    bring_back: "photo.shoot.bring_back", post_kit: "photo.shoot.post_kit", debrief: "photo.shoot.debrief", print: "photo.print" };
  var ACTION_WRITES = { send: 1, done: 1, skip: 1, move: 1, bring_back: 1, debrief: 1 };

  function actionsHtml(s) {
    var link = httpsOnly(s.link);
    return (s.actions || []).map(function (a) {
      var name = str(a.action);
      if (!own(ACTION_WORDS, name)) return "";
      var label = ACTION_WORDS[name] + (name === "bring_back" && a.needs_day ? "…" : "");
      if (name === "task") {
        return a.enabled && link ? '<a class="c-btn ghost sm" href="' + esc(link) + '" target="_blank" rel="noopener">Open its task ↗</a>' :
          '<button type="button" class="c-btn ghost sm" aria-disabled="true" data-ph="why" data-why="' + esc(a.why) + '">' +
          esc(label) + "</button>";
      }
      if (!a.enabled) {
        return '<button type="button" class="c-btn ghost sm" aria-disabled="true" data-ph="why" data-why="' + esc(a.why) +
          '" title="' + esc(a.why) + '">' + esc(label) + "</button>";
      }
      return btn(label, "act-open", { method: ACTION_METHOD[name], write: !!ACTION_WRITES[name], data: { a: name },
        pressed: S.v.panel === name });
    }).join("");
  }
  CLICK.why = function (b) {
    var why = str(b.getAttribute("data-why"));
    setHtml("cphPanel", '<p class="cph-note">' + esc(why ? "Not now — " + why + "." : "Not available for this shoot.") + "</p>");
  };
  CLICK["act-open"] = function (b) {
    var name = str(b.getAttribute("data-a"));
    var s = S.v.s;
    if (!s) return;
    if (name === "print") { goto("print/" + int(s.project_id) + "?shoot=" + int(s.id)); return; }
    S.v.panel = S.v.panel === name ? "" : name;
    setHtml("cphActs", actionsHtml(s));
    setHtml("cphPanel", S.v.panel ? panelHtml(S.v.panel, s) : "");
    if (S.v.panel === "post_kit") postKit(s);
    if ((S.v.panel === "move" || S.v.panel === "bring_back") && S.v.forms.act.day) moveCheckSoon();
  };
  function actionOf(s, name) { return (s.actions || []).filter(function (a) { return a.action === name; })[0] || {}; }

  function panelHtml(name, s) {
    var f = S.v.forms.act;
    var today = todayIso();
    var title = '<div class="cph-panelhead"><b>' + esc(ACTION_WORDS[name]) + "</b>" + btn("Close", "act-close", { cls: "link" }) + "</div>";
    if (name === "send") {
      return title + (s.dry_run ? '<p class="c-help">Dry run — nothing is really sent; the reminder is recorded.</p>' : "") +
        '<div class="cph-kinds">' + (s.send_kinds || []).map(function (k) {
          return btn(k.words, "send", { method: "photo.shoot.send", write: true, data: { kind: k.kind } });
        }).join("") + "</div>";
    }
    if (name === "done") {
      return title + field("What came back (optional)", '<textarea rows="2" maxlength="500" data-f="act:note" placeholder="' +
        esc("120 photos, a drone orbit…") + '">' + esc(f.note) + "</textarea>") + '<div class="c-actions">' +
        btn("Mark done", "done", { primary: true, method: "photo.shoot.done", write: true }) + "</div>";
    }
    if (name === "skip") {
      return title + '<div class="c-field cph-radios"><label class="c-check"><input type="radio" name="cphSkip" data-f="act:skip_s" ' +
        'value="skipped"' + (f.status !== "missed" ? " checked" : "") + "> Skip it — this shoot is not needed</label>" +
        '<label class="c-check"><input type="radio" name="cphSkip" data-f="act:skip_m" value="missed"' +
        (f.status === "missed" ? " checked" : "") + "> Missed — it should have happened and did not</label></div>" +
        field("Why", '<input type="text" maxlength="200" data-f="act:reason" value="' + esc(f.reason) + '" placeholder="' +
          esc("Why (goes on the task in My Tasks when it is closed)") + '">', "A skipped shoot can be brought back later.") +
        '<div class="c-actions">' + btn("Skip", "skip", { primary: true, method: "photo.shoot.skip", write: true }) + "</div>";
    }
    if (name === "move" || name === "bring_back") {
      var a = actionOf(s, "bring_back");
      var needDay = name === "move" || !!a.needs_day;
      var now = (str(s.date_text) || "no date yet") + (s.when_text ? " (" + s.when_text + ")" : "");
      return title + '<p class="c-muted c-small">' + esc(name === "move" ? "Now planned for " + now + "." :
        needDay ? "It was planned for " + now + "; pick the day it can happen now." : "") + "</p>" +
        (needDay ? field("New date", '<input type="date" min="' + today + '" data-f="act:day" value="' + esc(f.day) + '">') +
          '<p class="c-muted c-small" id="cphMoveCheck"></p>' : "") +
        (name === "move" ? field("Why", '<input type="text" maxlength="200" data-f="act:reason" value="' + esc(f.reason) +
          '" placeholder="rain, a crew delay, the client asked…">') + (s.status === "announced" ? '<div class="c-field">' +
          check("Tell the photographer (a “moved” message on the agent's next run, and a note on the task in My Tasks)",
            "act:notify", f.notify !== false) + "</div>" : "") : '<p class="c-help">It comes back as planned: the photographer ' +
          "gets the heads-up before that day, with a fresh task on My Tasks.</p>") +
        '<div class="c-actions">' + btn(name === "move" ? "Move" : "Bring it back", name, { primary: true,
          method: ACTION_METHOD[name], write: true }) + "</div>";
    }
    if (name === "post_kit") return title + '<div id="cphKit">' + busyHtml(aiWords("photo.shoot.post_kit", "Writing the captions…")) +
      "</div>";
    if (name === "debrief") {
      var shots = ((s.brief || {}).shots || []).map(function (x) { return str(x.title); }).filter(Boolean);
      var ratings = (s.ratings || []).length ? s.ratings.map(function (x) { return [int(x.n), str(x.words)]; }) : RATINGS;
      return title + '<div class="cph-stars" role="group" aria-label="How did it go?">' + ratings.map(function (r) {
        return '<button type="button" class="cph-star' + (r[0] <= f.rating ? " on" : "") + '" data-ph="star" data-n="' + r[0] +
          '" aria-label="' + esc(r[0] + " — " + r[1]) + '" aria-pressed="' + (r[0] === f.rating) + '">★</button>';
      }).join("") + '<span id="cphRating" class="c-muted">' + esc(ratingWords(f.rating)) + "</span></div>" +
        (shots.length ? '<div class="c-field"><span class="c-label">What did you get?</span>' + shots.slice(0, 30).map(function (t, i) {
          return check(t, "act:used." + i, !!f.used[i]);
        }).join("") + "</div>" : "") +
        field("Anything to remember next time?", '<textarea rows="3" maxlength="2000" data-f="act:dnote" placeholder="' +
          esc("The light was gone by 6:15 — go earlier. The crane shot was the best one.") + '">' + esc(f.dnote) + "</textarea>") +
        '<div class="c-actions"><span id="cphDebriefBusy"></span>' + btn("Save the debrief", "debrief", { primary: true,
          method: "photo.shoot.debrief", write: true }) + '</div><div id="cphLessons"></div>';
    }
    return "";
  }
  function actEdited(path, v) {
    var f = S.v.forms.act;
    if (path === "skip_s" && v) f.status = "skipped";
    if (path === "skip_m" && v) f.status = "missed";
    if (path === "day") moveCheckSoon();
  }
  CLICK["act-close"] = function () { S.v.panel = ""; setHtml("cphPanel", ""); if (S.v.s) setHtml("cphActs", actionsHtml(S.v.s)); };
  function moveCheckSoon() {
    clearTimeout(S.v.mcTimer);
    S.v.mcTimer = later(function () {
      var s = S.v.s, day = str(S.v.forms.act.day), t = S.token;
      if (!s || !asDay(day) || !has("photo.shoot.move_check")) { setHtml("cphMoveCheck", ""); return; }
      read("photo.shoot.move_check", { sid: int(s.id), day: day }).then(function (d) {
        if (t === S.token && str(S.v.forms.act.day) === day) setHtml("cphMoveCheck", esc(d.words));
      }, function (e) { if (t === S.token) setHtml("cphMoveCheck", esc(errWords(e))); });
    }, WAIT_MS);
  }
  /* After a shoot's action: the plan and the shoot are read again. */
  function acted(d) {
    if (!d) return;
    toast(d.words || "Done.");
    S.v.panel = "";
    paint();
  }
  CLICK.send = function (b) {
    var s = S.v.s;
    press(b, function () {
      return act("photo.shoot.send", { sid: int(s.id), kind: str(b.getAttribute("data-kind")) }, { text: "Sending it…" });
    }, "Sending…").then(acted, function (e) { toast(errWords(e), true); });
  };
  CLICK.done = function (b) {
    var s = S.v.s;
    press(b, function () { return act("photo.shoot.done", { sid: int(s.id), note: str(S.v.forms.act.note).trim() }); })
      .then(acted, function (e) { toast(errWords(e), true); });
  };
  CLICK.skip = function (b) {
    var s = S.v.s, f = S.v.forms.act, reason = str(f.reason).trim();
    if (!reason) { toast("Say why first — it goes on the task in My Tasks.", true); return; }
    press(b, function () {
      return act("photo.shoot.skip", { sid: int(s.id), reason: reason, status: f.status === "missed" ? "missed" : "skipped" });
    }).then(acted, function (e) { toast(errWords(e), true); });
  };
  CLICK.move = function (b) {
    var s = S.v.s, f = S.v.forms.act, day = str(f.day);
    if (!asDay(day)) { toast("Pick the new date first.", true); return; }
    var args = { sid: int(s.id), day: day, reason: str(f.reason).trim() };
    if (s.status === "announced") args.notify = f.notify !== false;
    press(b, function () { return act("photo.shoot.move", args); }).then(acted, function (e) { toast(errWords(e), true); });
  };
  CLICK.bring_back = function (b) {
    var s = S.v.s, f = S.v.forms.act;
    var needDay = !!actionOf(s, "bring_back").needs_day;
    if (needDay && !asDay(f.day)) { toast("Pick the day it can happen now.", true); return; }
    press(b, function () { return act("photo.shoot.bring_back", { sid: int(s.id), day: needDay ? str(f.day) : null }); })
      .then(acted, function (e) { toast(errWords(e), true); });
  };
  function postKit(s) {
    var t = S.token;
    read("photo.shoot.post_kit", { sid: int(s.id) }, { text: "Writing the captions…" }).then(function (kit) {
      if (t !== S.token || S.v.panel !== "post_kit") return;
      S.v.kit = kit;
      setHtml("cphKit", kitHtml(kit));
    }, function (e) { if (t === S.token) setHtml("cphKit", failHtml(e)); });
  }
  function kitHtml(kit) {
    var made = str(kit.made_by);
    var out = '<div class="cph-kithead">' + chip(made, made.indexOf("Claude") >= 0 ? "purple" : "grey") + "</div>" +
      (kit.error ? '<p class="c-help">' + esc("Claude could not write this one (" + kit.error + "), so these are the standard words.") +
        "</p>" : "");
    POST_KIT.forEach(function (k) {
      var v = kit[k[0]];
      var text = Array.isArray(v) ? v.map(str).join(" ") : str(v);
      if (!text) return;
      out += '<div class="cph-kit"><div class="cph-kitrow"><span class="c-label">' + esc(k[1]) + "</span>" +
        btn("Copy", "kit-copy", { data: { k: k[0] } }) + '</div><div class="c-pre cph-kittext">' + esc(text) + "</div></div>";
    });
    return out;
  }
  CLICK["kit-copy"] = function (b) {
    var k = str(b.getAttribute("data-k")), v = (S.v.kit || {})[k];
    var text = Array.isArray(v) ? v.map(str).join(" ") : str(v);
    var done = function () { toast("Copied."); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {
        toast("This browser would not copy — select the words and copy them.", true);
      });
      else toast("This browser would not copy — select the words and copy them.", true);
    } catch (e) { toast("This browser would not copy — select the words and copy them.", true); }
  };
  CLICK.star = function (b) {
    var f = S.v.forms.act;
    f.rating = Math.max(1, Math.min(5, int(b.getAttribute("data-n"), 4)));
    setHtml("cphPanel", panelHtml("debrief", S.v.s));
  };
  CLICK.debrief = function (b) {
    var s = S.v.s, f = S.v.forms.act;
    var shots = ((s.brief || {}).shots || []).map(function (x) { return str(x.title); }).filter(Boolean);
    var used = shots.slice(0, 30).filter(function (t, i) { return !!f.used[i]; });
    var stop = working("cphDebriefBusy", aiWords("photo.shoot.debrief", "Saving the debrief…"));
    press(b, function () {
      return write("photo.shoot.debrief", { sid: int(s.id), rating: f.rating, note: str(f.dnote).trim(), used: used },
        { text: "Saving the debrief…" });
    }).then(function (d) {
      stop();
      if (!d) return;
      S.v.lessons = d;
      setHtml("cphLessons", lessonsHtml(d));
      toast(d.words || "Debrief saved.");
    }, function (e) { stop(); toast(errWords(e), true); });
  };
  function lessonsHtml(d) {
    var lessons = d.lessons || [], props = d.proposed_rules || [];
    if (!lessons.length && !props.length) {
      return '<p class="cph-note">' + esc(d.note || "Saved. Nothing new to learn from this one.") + "</p>";
    }
    return (d.note ? '<p class="c-help">' + esc(d.note) + "</p>" : "") +
      (lessons.length ? '<span class="c-label">Lessons</span><ul class="cph-lessons">' + lessons.map(function (l) {
        return "<li>" + esc(l) + "</li>";
      }).join("") + "</ul>" : "") +
      (props.length ? '<span class="c-label">Rules it suggests for the Playbook</span>' + props.map(function (p, i) {
        var why = [str(p.category) ? str(p.category).charAt(0).toUpperCase() + str(p.category).slice(1) : "", str(p.why)]
          .filter(Boolean).join(" · ");
        return '<div class="cph-prop"><div><div>' + esc(p.text) + "</div>" + (why ? '<div class="c-muted c-small">' + esc(why) +
          "</div>" : "") + "</div>" + btn("Add to the Playbook", "lesson-add", {
          method: has("photo.debrief.accept") ? "photo.debrief.accept" : "photo.rule.add", write: true, data: { i: i } }) + "</div>";
      }).join("") : "");
  }
  /* A debrief's proposed rule into the Playbook. The DCR server looks the
     proposal up on the shoot and keeps it as a debrief rule
     (photo.debrief.accept, like the Coach's); an older server takes the
     words as an admin's rule. */
  CLICK["lesson-add"] = function (b) {
    var n = int(b.getAttribute("data-i"), -1);
    var p = ((S.v.lessons || {}).proposed_rules || [])[n];
    var s = S.v.s;
    if (!p) return;
    var args = { text: str(p.text).trim() };
    if (str(p.category)) args.category = str(p.category);
    press(b, function () {
      if (has("photo.debrief.accept") && s && s.id) return write("photo.debrief.accept", { sid: int(s.id), n: n });
      return write("photo.rule.add", args).then(null, function (e) {
        if (e && e.code === "bad_args" && args.category) return write("photo.rule.add", { text: args.text });
        throw e;
      });
    }).then(function () {
      b.textContent = "Added ✓";
      b.disabled = true;
      b.removeAttribute("data-act");
      toast("Added to the Playbook.");
    }, function (e) { toast(errWords(e), true); });
  };

  /* ── the plan's header buttons ──────────────────────────────────────── */

  CLICK["plan-who"] = function (b) {
    var p = S.v.p;
    if (!p) return;
    press(b, function () {
      return Promise.all([peopleNames(), read("photo.overview").then(null, function () { return S.o || {}; })]).then(function (res) {
        var names = res[0], usual = str((res[1] || {}).photographer);
        var cur = p.photographer_own ? str(p.photographer) : "";
        var opts = [{ value: "", label: "The usual photographer (" + (usual || "not set") + ")" }]
          .concat(names.map(function (n) { return { value: n, label: n }; }));
        if (cur && names.indexOf(cur) < 0) opts.push({ value: cur, label: cur + " (not on the roster)" });
        return S.ctx.modal({ title: "Photographer for this plan", message: "Who shoots this project?", okText: "Save",
          fields: [{ name: "who", type: "select", options: opts, value: cur }] }).then(function (ans) {
          if (!ans) return null;
          return write("photo.plan.photographer", { pid: int(p.id), name: str(ans.who) });
        });
      });
    }).then(function (d) { if (d) { toast(d.words); paint(); } }, function (e) { toast(errWords(e), true); });
  };
  CLICK["plan-sync"] = function (b) {
    var p = S.v.p;
    var stop = working("cphPlanBusy", "Reading the project log, timesheets, My Tasks and photos…");
    press(b, function () { return write("photo.plan.sync", { pid: int(p.id) }, { text: "Reading the project…" }); })
      .then(function (d) { stop(); if (d) { toast(d.words, !!d.error); paint(); } }, function (e) { stop(); toast(errWords(e), true); });
  };
  CLICK["plan-status"] = function (b) {
    var p = S.v.p;
    var action = str(b.getAttribute("data-action"));
    press(b, function () { return act("photo.plan.status", { pid: int(p.id), action: action }); }).then(function (d) {
      if (!d) return;
      toast(d.words);
      forget("photo.");
      paint();
    }, function (e) { toast(errWords(e), true); });
  };

  /* A plan's own copy list, in a panel under the header. */
  CLICK["plan-copies"] = function (b) {
    var p = S.v.p;
    if (!p) return;
    if (S.v.copies && S.v.copiesOpen) { S.v.copiesOpen = false; setHtml("cphCopies", ""); return; }
    press(b, function () { return read("photo.plan.copies", { pid: int(p.id) }); }).then(function (d) {
      if (!d) return;
      S.v.copies = { people: clone(d.people || []), kinds: clone(d.kinds || []), roster: d.roster || [],
        photographer: str(d.photographer), groups: d.groups || [], max_people: int(d.max_people) || COPIES_MAX.pc,
        undo_words: str(d.undo_words), typed: "", pick: "", problem: "", intro: str(d.intro), every: d.every || {} };
      S.v.copiesOpen = true;
      S.v.forms.pc = S.v.copies;
      S.v.edited = S.v.edited || {};
      S.v.edited.pc = function (path, v) {
        var m = /^kind\|([a-z_]+)$/.exec(path);
        if (m) {
          var kinds = S.v.copies.kinds.filter(function (k) { return k !== m[1]; });
          if (v) kinds.push(m[1]);
          S.v.copies.kinds = (S.v.copies.groups || []).map(function (g) { return str(g.key); })
            .filter(function (k) { return kinds.indexOf(k) >= 0; });
        } else ccProblem("", "pc");
      };
      setHtml("cphCopies", copiesPanelHtml());
    }, function (e) { toast(errWords(e), true); });
  };
  function copiesPanelHtml() {
    var c = S.v.copies;
    return '<div class="c-card cph-copies"><div class="cph-panelhead"><b>Who else gets this plan\'s reminders</b>' +
      btn("Close", "pc-close", { cls: "link" }) + "</div><p>" + esc(c.intro) + "</p>" +
      '<div id="cphPcEditor">' + ccEditorHtml("pc") + "</div>" +
      '<div class="c-field"><span class="c-label">Copy them on</span>' + (c.groups || []).map(function (g) {
        return '<label class="c-check"><input type="checkbox" data-f="pc:kind|' + esc(g.key) + '"' +
          (c.kinds.indexOf(str(g.key)) >= 0 ? " checked" : "") + "> " + esc(g.words) + "</label>";
      }).join("") + "</div>" + '<p class="c-help">' + esc((c.every || {}).words) + "</p>" +
      '<div class="c-actions">' + btn("Save", "pc-save", { primary: true, method: "photo.plan.copies.save", write: true }) +
      btn("Cancel", "pc-close") + "</div></div>";
  }
  CLICK["pc-close"] = function () { S.v.copiesOpen = false; setHtml("cphCopies", ""); };
  CLICK["pc-save"] = function (b) {
    var p = S.v.p, c = S.v.copies;
    if (str(c.typed).trim() && ccTakeTyped("pc")) return;
    press(b, function () {
      return write("photo.plan.copies.save", { pid: int(p.id), people: c.people.map(function (q) {
        return { name: str(q.name), email: cleanEmail(q.email) };
      }), kinds: c.kinds.slice() });
    }).then(function (d) { if (d) { toast(d.words); S.v.copiesOpen = false; paint(); } }, function (e) {
      ccProblem(errWords(e), "pc");
      toast(errWords(e), true);
    });
  };

  /* ── Revise with AI, Make it again, Approve & start ─────────────────── */

  function reviseHtml(p) {
    var b = p.buttons || {};
    var ai = p.ai || {};
    S.v.forms.rev = S.v.forms.rev || { words: "" };
    return '<div class="cph-revise"><div class="cph-reviserow"><input type="text" maxlength="2000" data-f="rev:words" ' +
      'id="cphReviseText" data-enter="plan-revise" data-enter-btn="cphRevise" placeholder="' +
      esc(b.revise ? "Revise with AI — e.g. “move the drone shoot after the roof is on”" :
        "Revising in your own words needs Claude — edit the shoots instead") + '"' + (b.revise ? "" : " disabled") +
      ' aria-label="Revise with AI">' + btn("Revise with AI", "plan-revise", { method: "photo.plan.revise", write: true,
        disabled: !b.revise, id: "cphRevise" }) + "</div>" +
      '<div class="c-actions cph-review">' +
      (b.remake ? btn("Make it again", "plan-remake", { method: "photo.plan.remake", write: true,
        title: "A fresh plan from the same answers" }) : "") +
      (b.approve ? btn("Approve & start", "plan-approve", { primary: true, method: "photo.plan.approve", write: true,
        title: "Turns the plan on: shoots get their dates, and the photographer gets a heads-up before each one (once the " +
          "Photo & Video agent is on in the Agents tab)" }) : "") + "</div>" +
      '<div id="cphReviseBusy"></div><div id="cphEscape"></div>' +
      (p.state_note ? '<p class="c-muted c-small">' + esc(p.state_note) + "</p>" : "") +
      (!ai.ok && ai.words && b.revise === false ? "" : "") + "</div>";
  }
  CLICK["plan-revise"] = function (b) {
    var p = S.v.p, words = str((S.v.forms.rev || {}).words).trim();
    if (!words) { toast("Say what to change first.", true); return; }
    var stop = working("cphReviseBusy", "Claude is revising the plan… this can take a minute");
    press(b, function () { return write("photo.plan.revise", { pid: int(p.id), words: words }, { text: "Claude is revising the plan…" }); },
      "Revising…").then(function (d) {
      stop();
      if (!d) return;
      S.v.forms.rev = { words: "" };
      toast(d.words);
      paint();
    }, function (e) { stop(); toast(errWords(e), true); });
  };
  CLICK["plan-remake"] = function (b) {
    var p = S.v.p, ai = !!(p.ai || {}).ok;
    remake(b, p, ai);
  };
  function remake(b, p, useAi) {
    setHtml("cphEscape", "");
    var stop = working("cphReviseBusy", useAi ? "Claude is writing a fresh plan… this can take a minute" : "Writing the standard plan…");
    press(b, function () { return act("photo.plan.remake", { pid: int(p.id), use_ai: useAi }, { text: "Writing the plan…" }); })
      .then(function (d) {
        stop();
        if (!d) return;
        toast(d.words);
        paint();
      }, function (e) {
        stop();
        if (useAi && e && e.code === "refused") {
          setHtml("cphEscape", escapeBox(e, "plan-remake-std"));
          return;
        }
        toast(errWords(e), true);
      });
  }
  CLICK["plan-remake-std"] = function (b) { remake(b, S.v.p, false); };
  CLICK["plan-approve"] = function (b) {
    var p = S.v.p, sid = S.v.sid;
    var st = sid ? S.shoot[sid] : null;
    var first = Promise.resolve(true);
    if (st && !same(st.form, st.base)) {
      first = S.ctx.confirm("Save your changes to “" + (str(st.form.name) || "this shoot") + "” first?", { title: "Unsaved changes",
        okText: "Save them" }).then(function (yes) {
        if (!yes) { st.form = clone(st.base); return true; }
        var a = shootArgs(sid);
        if (a.problem) { toast(a.problem, true); return false; }
        return saveShoot($("cphSave"), sid, a.args).then(function () { return true; }, function () { return false; });
      });
    }
    first.then(function (go) {
      if (!go) return;
      return press(b, function () { return act("photo.plan.approve", { pid: int(p.id) }, { text: "Starting the plan…" }); })
        .then(function (d) { if (d) { toast(d.words); paint(); } });
    }).then(noop, function (e) { toast(errWords(e), true); });
  };
  function escapeBox(e, ph, data) {
    return '<div class="c-error" role="alert"><b>Claude could not do it.</b><span>' + esc(errWords(e)) + "</span>" +
      '<div class="c-actions">' + btn("Use the standard plan instead", ph, { primary: true, write: true, data: data }) + "</div></div>";
  }

  /* ══ the setup wizard ══════════════════════════════════════════════ */

  function stepBarHtml(n) {
    return '<ol class="cph-steps">' + STEPS.map(function (w, i) {
      var tone = i < n ? "green" : i === n ? "blue" : "grey";
      return '<li class="c-chip ' + (TONE[tone] || "") + (i === n ? " b" : "") + '"' + (i === n ? ' aria-current="step"' : "") + ">" +
        esc((i < n ? "✓ " : (i + 1) + "  ") + w) + "</li>";
    }).join("") + "</ol>";
  }

  /* Step 1: the project (#/photo/new). The draft is made when it is picked. */
  function pickPage(r, t) {
    S.v.wiz = S.v.wiz || { q: "", pick: null };
    S.el.innerHTML = '<div class="cph-crumbs">' + back("All plans", "plans") + "</div>" +
      '<div class="c-card cph-wizard"><h2 class="c-title">New project plan</h2><p class="c-sub">Four short steps: pick the ' +
      "project, describe it, answer a few questions, review the plan.</p>" + stepBarHtml(0) +
      '<div class="c-head"><h3 class="cph-h3">Which project is this plan for?</h3>' +
      btn("Reload the list", "wiz-reload", { method: "photo.wizard.projects" }) + "</div>" +
      '<input type="search" class="cph-search" data-f="wiz:q" placeholder="Search by code, name or city…" aria-label="Search the projects">' +
      '<div id="cphWizList" class="cph-wizlist">' + busyHtml("Loading the project list from the portal…") + "</div>" +
      '<p class="c-muted c-small" id="cphWizNote"></p><h3 class="cph-h3">What the portal knows about it</h3>' +
      '<div id="cphFacts"><p class="c-muted">Pick a project to see its facts.</p></div>' +
      '<div class="c-actions cph-wizbar">' + link("Cancel", "plans") + '<span class="cph-grow"></span>' +
      btn("Next — tell me about it", "wiz-create", { primary: true, method: "photo.wizard.create", write: true, id: "cphWizNext",
        disabled: true }) + "</div></div>";
    S.v.forms.wiz = S.v.wiz;
    S.v.edited = { wiz: function () { setHtml("cphWizList", wizListHtml()); } };
    return loadProjects(t, false);
  }
  function loadProjects(t, fresh) {
    return read("photo.wizard.projects", {}, { fresh: fresh, ttl: 5 * 60 * 1000 }).then(function (d) {
      if (t !== S.token) return;
      S.v.projects = d.projects || [];
      setHtml("cphWizList", wizListHtml());
    }, function (e) { if (t === S.token) setHtml("cphWizList", failHtml(e)); });
  }
  function wizListHtml() {
    var q = str(S.v.wiz.q).trim().toLowerCase();
    var all = S.v.projects || [];
    var shown = all.filter(function (p) {
      return !q || (str(p.label) + " " + str(p.code) + " " + str(p.city)).toLowerCase().indexOf(q) >= 0;
    });
    setHtml("cphWizNote", all.length ? esc(shown.length + " of " + all.length + " projects — active jobs first") :
      "No projects came back from the portal.");
    if (!shown.length) return '<p class="c-muted">' + (all.length ? "No project matches." : "") + "</p>";
    var pick = S.v.wiz.pick;
    return shown.slice(0, 200).map(function (p) {
      var on = pick && pick.id === str(p.id);
      var bits = [str(p.status), p.has_plan ? "has a photo plan" : ""].filter(Boolean).join(" · ");
      return '<button type="button" class="cph-proj' + (on ? " on" : "") + (p.active ? "" : " dim") + '" data-ph="wiz-pick" data-id="' +
        esc(p.id) + '" aria-pressed="' + (on ? "true" : "false") + '"' + (p.has_plan ? " disabled" : "") + "><b>" + esc(p.label) +
        "</b>" + (bits ? '<span class="c-muted c-small">' + esc(bits) + "</span>" : "") + "</button>";
    }).join("");
  }
  CLICK["wiz-reload"] = function () { setHtml("cphWizList", busyHtml("Loading the project list from the portal…")); loadProjects(S.token, true); };
  CLICK["wiz-pick"] = function (b) {
    var id = str(b.getAttribute("data-id"));
    var p = (S.v.projects || []).filter(function (x) { return str(x.id) === id; })[0];
    if (!p || p.has_plan) return;
    S.v.wiz.pick = { id: id, label: str(p.label) };
    setHtml("cphWizList", wizListHtml());
    var next = $("cphWizNext");
    if (next) next.disabled = false;
    if (!/^\d{1,10}$/.test(id)) { setHtml("cphFacts", '<p class="c-muted">This project has no facts to read.</p>'); return; }
    setHtml("cphFacts", busyHtml("Reading the project's facts…"));
    var t = S.token;
    read("photo.wizard.facts", { spid: id }).then(function (d) {
      if (t !== S.token || !S.v.wiz.pick || S.v.wiz.pick.id !== id) return;
      setHtml("cphFacts", '<div class="cph-factchips">' + (d.chips || []).map(function (c) { return chipOf(c); }).join(" ") + "</div>" +
        (d.note ? '<p class="c-muted c-small">' + esc(d.note) + "</p>" : ""));
    }, function (e) { if (t === S.token) setHtml("cphFacts", '<p class="c-muted">' + esc(errWords(e)) + "</p>"); });
  };
  CLICK["wiz-create"] = function (b) {
    var pick = S.v.wiz.pick;
    if (!pick || !/^\d{1,10}$/.test(pick.id)) return;
    press(b, function () {
      return write("photo.wizard.create", { spid: pick.id, label: pick.label.slice(0, 120) }, { text: "Starting a plan for " + pick.label + "…" });
    }).then(function (d) {
      if (!d || !num(d.pid)) return;
      S.v.wiz = null;
      goto("plan/" + num(d.pid));
    }, function (e) { toast(errWords(e), true); });
  };

  /* Steps 2 and 3, for a plan still being set up. */
  function wizardPage(p, r, t) {
    var pid = int(p.id);
    var root = $("cphPlan");
    if (root) root.innerHTML = '<div class="c-card cph-wizard"><div class="cph-planhead-top"><h2 class="c-title">' + esc(p.label) +
      "</h2> " + chipOf(p.chip) + '</div><div id="cphWiz">' + busyHtml("Reading where the setup stopped…") + "</div>" +
      '<div class="c-actions cph-wizfoot">' + btn(str((p.buttons || {}).archive_text) || "Archive", "plan-status", {
        method: "photo.plan.status", write: true, data: { action: "archive" },
        title: "Not wanted? Archive this draft." }) + "</div></div>";
    return read("photo.wizard.state", { pid: pid }).then(function (st) {
      if (t !== S.token) return;
      S.v.wst = st;
      var w = S.wiz[pid] = S.wiz[pid] || { useAi: null, view: "", round: null, answers: {} };
      var view = w.view || (st.step === "round" ? "round" : "brief");
      if (view === "round" && !w.round && st.step === "round") {
        w.round = { round: st.round, questions: st.questions, understanding: st.understanding, facts_needed: st.facts_needed,
          ready: st.ready, made_by: st.made_by };
      }
      if (view === "round" && w.round) roundView(pid); else briefView(pid);
    }, function (e) { if (t === S.token) setHtml("cphWiz", failHtml(e)); });
  }

  function briefView(pid) {
    var st = S.v.wst, w = S.wiz[pid];
    w.view = "brief";
    if (!w.brief) {
      w.brief = { text: str(st.brief), photographer: str(st.photographer), ms: {} };
      (st.milestones || []).forEach(function (m) { w.brief.ms[m.key] = { day: str(m.date), unsure: !m.date, firm: !!(m.date && m.confirmed) }; });
    }
    S.v.forms.brief = w.brief;
    S.v.edited = S.v.edited || {};
    S.v.edited.brief = function (path) {
      var m = /^ms\.([a-z_]+)\.unsure$/.exec(path);
      if (!m) return;
      var f = w.brief.ms[m[1]];
      if (!f.unsure && !f.day) { f.day = todayIso(); var d = $("cphWD-" + m[1]); if (d) d.value = f.day; }
      var di = $("cphWD-" + m[1]), fi = $("cphWF-" + m[1]);
      if (di) di.disabled = !!f.unsure;
      if (fi) fi.disabled = !!f.unsure;
    };
    var aiOn = !!(st.ai || {}).ok && w.useAi !== false;
    setHtml("cphWiz", stepBarHtml(1) + '<h3 class="cph-h3">Tell me about this project</h3>' +
      '<div class="cph-factchips">' + (st.facts || []).map(function (c) { return chipOf(c); }).join(" ") + "</div>" +
      field("", '<textarea rows="5" maxlength="4000" data-f="brief:text" placeholder="' + esc(BRIEF_EXAMPLE) + '" aria-label="About ' +
        'this project">' + esc(w.brief.text) + "</textarea>", "What's special about it, what the client or the team wants to " +
        "show, anything the photographer should know. A few sentences are plenty.") +
      field("Photographer for this plan", '<select data-f="brief:photographer" id="cphWizWho">' + options([["", st.photographer_usual ?
        "The usual photographer (" + st.photographer_usual + ")" : "The usual photographer (pick one in Settings)"]]
        .concat(w.brief.photographer ? [[w.brief.photographer, w.brief.photographer]] : []), w.brief.photographer) + "</select>") +
      '<h3 class="cph-h3">Dates you already know</h3><p class="c-help">Leave a date as “not sure yet” — the agent watches the ' +
      "project log and the timesheets and fills it in, and every shoot moves with it.</p>" +
      '<div class="cph-wizms">' + (st.milestones || []).map(function (m) {
        var f = w.brief.ms[m.key] || { unsure: true };
        return '<div class="cph-wizmsrow"><span class="cph-wizmsname">' + esc(m.name) + '</span><input type="date" id="cphWD-' + esc(m.key) +
          '" data-f="brief:ms.' + esc(m.key) + '.day" value="' + esc(f.day || "") + '"' + (f.unsure ? " disabled" : "") + ' aria-label="' +
          esc(m.name) + '">' + check("Not sure yet", "brief:ms." + m.key + ".unsure", !!f.unsure) +
          check("Firm date", "brief:ms." + m.key + ".firm", !!f.firm, ' id="cphWF-' + esc(m.key) + '"' + (f.unsure ? " disabled" : "") +
            ' title="A firm date is never moved by the agent; it only suggests a change."') + "</div>";
      }).join("") + "</div>" + '<div id="cphWizBusy"></div><div id="cphEscape"></div>' +
      '<div class="c-actions cph-wizbar">' + btn("Back", "wiz-back") + '<span class="cph-grow"></span>' +
      btn(aiOn ? "Next — Claude asks a few questions" : "Next — a short checklist", "wiz-start", { primary: true,
        method: "photo.wizard.start", write: true }) + "</div>");
    peopleNames().then(function (names) {
      var sel = $("cphWizWho");
      if (!sel || S.v.forms.brief !== w.brief) return;
      var cur = w.brief.photographer;
      var opts = [["", st.photographer_usual ? "The usual photographer (" + st.photographer_usual + ")" :
        "The usual photographer (pick one in Settings)"]].concat(names.map(function (n) { return [n, n]; }));
      if (cur && names.indexOf(cur) < 0) opts.push([cur, cur + " (not on the roster)"]);
      sel.innerHTML = options(opts, cur);
    });
  }
  CLICK["wiz-back"] = function () {
    toast("This plan's project is chosen. To plan another project, use “+ New project plan”; archive this draft if it is not wanted.");
  };
  function wizAi(pid) { var st = S.v.wst || {}; return !!(st.ai || {}).ok && S.wiz[pid].useAi !== false; }
  function askingWords(pid) {
    return wizAi(pid) ? "Claude is reading the project and thinking of questions… this can take a minute" : "Making the checklist…";
  }
  CLICK["wiz-start"] = function (b) {
    var pid = int(S.v.wst.pid) || int(S.v.p.id), w = S.wiz[pid];
    var ms = Object.keys(w.brief.ms).map(function (k) {
      var f = w.brief.ms[k];
      var day = f.unsure || !asDay(f.day) ? null : f.day;
      return { key: k, day: day, confirmed: !!(day && f.firm) };
    });
    var args = { pid: pid, brief: str(w.brief.text).trim(), photographer: str(w.brief.photographer), milestones: ms };
    if (w.useAi === false) args.use_ai = false;
    wizCall(b, "photo.wizard.start", args, pid, "start");
  };
  /* One wizard call that comes back with a round of questions (or the plan). */
  function wizCall(b, method, args, pid, step) {
    setHtml("cphEscape", "");
    var stop = working("cphWizBusy", step === "finish" ? (wizAi(pid) ? "Claude is writing the plan — shoots, shot lists, " +
      "tips… this can take a minute or two" : "Writing the standard plan…") : askingWords(pid));
    var t = S.token;
    return press(b, function () { return write(method, args, { text: step === "finish" ? "Writing the plan…" : "Asking…" }); })
      .then(function (d) {
        stop();
        if (!d || t !== S.token) return;
        var w = S.wiz[pid];
        if (step === "finish") {
          delete S.wiz[pid];
          toast(d.words || "Here is the plan. Change any date or shot list, then press “Approve & start”.");
          paint();
          return;
        }
        w.round = d;
        w.answers = {};
        w.view = "round";
        roundView(pid);
      }, function (e) {
        stop();
        if (t !== S.token) return;
        if (e && e.code === "refused" && S.wiz[pid].useAi !== false && wizAi(pid)) {
          setHtml("cphEscape", escapeBox(e, "wiz-escape", { step: step === "finish" ? "finish" : "next" }));
          return;
        }
        toast(errWords(e), true);
      });
  }
  /* After Claude failed: the rest of this setup uses the checklist and the
     standard plan. The answers already given are kept on the PC, so the
     round is asked again without them. */
  CLICK["wiz-escape"] = function (b) {
    var pid = int(S.v.wst.pid), w = S.wiz[pid];
    w.useAi = false;
    var finish = b.getAttribute("data-step") === "finish";
    wizCall(b, finish ? "photo.wizard.finish" : "photo.wizard.next", { pid: pid, answers: {}, use_ai: false }, pid,
      finish ? "finish" : "next");
  };

  function roundView(pid) {
    var w = S.wiz[pid], res = w.round || {};
    var qs = Array.isArray(res.questions) ? res.questions : [];
    var n = int(res.round) || 1;
    var byAi = res.made_by === "ai";
    var made = str(res.made_by_words) || (byAi ? "Asked by Claude" : w.useAi === false ? "Standard checklist" :
      "Standard checklist — AI is off");
    w.answers = w.answers || {};
    S.v.forms.ans = w.answers;
    S.v.edited = S.v.edited || {};
    S.v.edited.ans = function (path) {
      var m = /^([A-Za-z0-9_-]+)\.(own|date)$/.exec(path);
      if (!m) return;
      var a = w.answers[m[1]];
      if (m[2] === "date") { a.own = str(a.date); a.pick = null; var o = $("cphOwn-" + m[1]); if (o) o.value = a.own; }
      else if (str(a.own).trim()) a.pick = null;
      setHtml("cphChoices-" + m[1], choicesHtml(qs, m[1]));
    };
    var still = (res.facts_needed || []).map(str).filter(function (x) { return x.trim(); });
    var ready = !!res.ready;
    setHtml("cphWiz", stepBarHtml(2) + '<div class="cph-roundhead"><h3 class="cph-h3">' + esc(str(res.title) || "A few questions — round " +
      n + " of 3") + "</h3>" + chip(made, byAi ? "purple" : "grey") + "</div>" +
      (str(res.understanding).trim() ? '<p class="cph-understand">' + esc("What I understand so far: " + res.understanding) + "</p>" : "") +
      (qs.length ? qs.map(function (q, i) { return questionHtml(q, i, w); }).join("") :
        '<p class="cph-done">I have what I need. Make the plan, then look it over before it starts.</p>') +
      (still.length ? '<p class="c-muted c-small">' + esc("Still unknown (the plan can start without them): " + still.join("; ")) + "</p>" : "") +
      '<div id="cphWizBusy"></div><div id="cphEscape"></div>' +
      '<div class="c-actions cph-wizbar">' + btn("Back to the description", "wiz-tobrief") + '<span class="cph-grow"></span>' +
      (qs.length && !ready && n < 3 ? btn("Next questions", "wiz-next", { method: "photo.wizard.next", write: true }) : "") +
      btn(ready || !qs.length ? "Make the plan" : "Make the plan now", "wiz-finish", { primary: true, method: "photo.wizard.finish",
        write: true }) + "</div>");
  }
  function qid(q, i) { var id = str(q && q.id); return ANSWER_KEY.test(id) ? id : "q" + i; }
  function questionHtml(q, i, w) {
    var id = qid(q, i);
    var a = w.answers[id] = w.answers[id] || { pick: null, own: "", date: "" };
    var choices = (q.choices || []).map(str).filter(function (c) { return c.trim(); });
    var isDate = own(DATE_QUESTIONS, str(q.id));
    return '<div class="c-card flat cph-q"><div class="cph-qtext">' + esc(q.question) + "</div>" +
      (q.why ? '<div class="c-muted c-small">' + esc(q.why) + "</div>" : "") +
      (choices.length ? '<div class="cph-choices" id="cphChoices-' + id + '">' + choicesHtml([q], id, i) + "</div>" : "") +
      '<div class="c-inline cph-own"><input type="text" id="cphOwn-' + id + '" maxlength="500" data-f="ans:' + id + '.own" value="' +
      esc(a.own) + '" placeholder="' + esc(isDate ? "Or a date, like 2026-10-19…" : choices.length ? "Or in your own words…" :
        "Your answer…") + '" aria-label="' + esc(q.question) + '">' + (isDate ? '<input type="date" data-f="ans:' + id + '.date" ' +
        'aria-label="Pick a date">' : "") + "</div></div>";
  }
  function choicesHtml(qs, id, idx) {
    var q = qs.length === 1 ? qs[0] : qs.filter(function (x, i) { return qid(x, i) === id; })[0];
    if (!q) return "";
    var w = S.wiz[int(S.v.wst.pid)];
    var a = (w.answers || {})[id] || {};
    return (q.choices || []).map(str).filter(function (c) { return c.trim(); }).map(function (c, j) {
      var on = a.pick === c && !str(a.own).trim();
      return '<button type="button" class="cph-choice' + (on ? " on" : "") + '" data-ph="wiz-choice" data-q="' + esc(id) + '" data-i="' +
        j + '" aria-pressed="' + (on ? "true" : "false") + '">' + esc(c) + "</button>";
    }).join("");
  }
  CLICK["wiz-choice"] = function (b) {
    var pid = int(S.v.wst.pid), w = S.wiz[pid], id = str(b.getAttribute("data-q")), j = int(b.getAttribute("data-i"), -1);
    var qs = (w.round || {}).questions || [];
    var q = qs.filter(function (x, i) { return qid(x, i) === id; })[0];
    if (!q) return;
    var c = (q.choices || []).map(str).filter(function (x) { return x.trim(); })[j];
    var a = w.answers[id] = w.answers[id] || { pick: null, own: "", date: "" };
    a.pick = a.pick === c && !str(a.own).trim() ? null : c;
    if (a.pick) { a.own = ""; var o = $("cphOwn-" + id); if (o) o.value = ""; }
    setHtml("cphChoices-" + id, choicesHtml(qs, id));
  };
  /* {question id: answer} — the admin's own words win over a picked choice. */
  function answers(pid) {
    var w = S.wiz[pid], out = {};
    ((w.round || {}).questions || []).forEach(function (q, i) {
      var id = qid(q, i), a = w.answers[id] || {};
      out[id] = (str(a.own).trim() || str(a.pick)).slice(0, 500);
    });
    return out;
  }
  CLICK["wiz-tobrief"] = function () { var pid = int(S.v.wst.pid); S.wiz[pid].view = "brief"; briefView(pid); };
  CLICK["wiz-next"] = function (b) {
    var pid = int(S.v.wst.pid), w = S.wiz[pid];
    var args = { pid: pid, answers: answers(pid) };
    if (w.useAi === false) args.use_ai = false;
    wizCall(b, "photo.wizard.next", args, pid, "next");
  };
  CLICK["wiz-finish"] = function (b) {
    var pid = int(S.v.wst.pid), w = S.wiz[pid];
    var args = { pid: pid, answers: answers(pid) };
    if (w.useAi === false) args.use_ai = false;
    wizCall(b, "photo.wizard.finish", args, pid, "finish");
  };

  /* ══ the printouts ═════════════════════════════════════════════════ */

  function printOptions() {
    var o = clone(PRINT_DEFAULTS);
    try {
      var kept = JSON.parse(localStorage.getItem(PRINT_KEY) || "null");
      if (kept && typeof kept === "object") {
        if (typeof kept.include_done === "boolean") o.include_done = kept.include_done;
        if (own(NOTES_LINES, kept.notes)) o.notes = kept.notes;
        if (typeof kept.one_per_page === "boolean") o.one_per_page = kept.one_per_page;
        if (kept.paper === "a4" || kept.paper === "letter") o.paper = kept.paper;
      }
    } catch (e) { /* a private window: the defaults */ }
    return o;
  }
  function keepOptions(o) { try { localStorage.setItem(PRINT_KEY, JSON.stringify(o)); } catch (e) { /* not kept */ } }

  /* Print schedule (a whole plan) and Print this shoot's page (?shoot=). */
  function printPage(r, t) {
    var o = printOptions();
    var sid = r.sid;
    S.v.print = { kind: sid ? "shoot" : "schedule", pid: r.pid, sid: sid, opts: o, sent: null, d: null };
    S.v.forms.pr = o;
    S.v.edited = { pr: function (path) { printEdited(path, t); } };
    S.el.innerHTML = '<div class="cph-crumbs">' + back(sid ? "Back to the shoot" : "Back to the plan", "plan/" + r.pid +
      (sid ? "/shoot/" + sid : "")) + "</div>" + '<div class="cph-print"><div class="c-card cph-printopts" id="cphPrintOpts">' +
      printOptionsHtml() + '</div><div id="cphPreview">' + busyHtml("Laying out the pages…") + "</div></div>";
    return fetchPrint(t);
  }
  function agendaPage(r, t) {
    var o = printOptions();
    S.v.print = { kind: "agenda", pid: r.pid, opts: o, d: null };
    S.v.forms.pr = o;
    S.v.edited = { pr: function (path) { printEdited(path, t); } };
    S.el.innerHTML = '<div class="cph-crumbs">' + back("Back to Upcoming", "upcoming" + (r.pid ? "?pid=" + r.pid : "")) + "</div>" +
      '<div class="cph-print"><div class="c-card cph-printopts" id="cphPrintOpts">' + printOptionsHtml() + "</div>" +
      '<div id="cphPreview">' + busyHtml("Laying out the pages…") + "</div></div>";
    return fetchPrint(t);
  }
  function printArgs() {
    var pv = S.v.print, o = pv.opts;
    if (pv.kind === "agenda") return ["photo.print_agenda", { pid: pv.pid || null, include_done: !!o.include_done }];
    return ["photo.print", { pid: pv.pid, shoot_id: pv.sid || null, include_done: pv.kind === "shoot" ? false : !!o.include_done,
      notes: o.notes, one_per_page: pv.kind === "shoot" ? false : !!o.one_per_page, paper: o.paper }];
  }
  function fetchPrint(t) {
    var pv = S.v.print, a = printArgs();
    setHtml("cphPreview", busyHtml("Laying out the pages…"));
    return read(a[0], a[1]).then(function (d) {
      if (t !== S.token) return;
      pv.d = d;
      pv.sent = JSON.stringify(a[1]);
      setHtml("cphPrintOpts", printOptionsHtml());
      showPreview();
    }, function (e) { if (t === S.token) setHtml("cphPreview", failHtml(e)); });
  }
  function printEdited(path, t) {
    var pv = S.v.print;
    keepOptions(pv.opts);
    if (path === "include_done") { fetchPrint(t); return; }
    if (pv.d) showPreview();
  }
  function printOptionsHtml() {
    var pv = S.v.print, o = pv.opts, d = pv.d || {};
    var intro = { schedule: "Every shoot of this plan on paper, with its shot list to tick and room for notes.",
      shoot: "This shoot on its own page, with its shot list to tick and room for notes.",
      agenda: "The shoots this list shows, by week, with a column to write in." }[pv.kind];
    var title = str(d.title) || (pv.kind === "agenda" ? "Print this list" : pv.kind === "shoot" ? "Print this shoot's page" : "Print schedule");
    return '<h2 class="c-title">' + esc(title) + '</h2><p class="c-sub">' + esc(intro) + "</p>" +
      '<div class="cph-printform">' +
      (pv.kind !== "shoot" ? '<div class="c-field">' + check("Include shoots already done or skipped", "pr:include_done", !!o.include_done) +
        "</div>" : "") +
      (pv.kind !== "agenda" ? field(pv.kind === "schedule" ? "Room for notes under each shoot" : "Room for notes",
        '<select data-f="pr:notes">' + options(NOTES_CHOICES, o.notes) + "</select>") : "") +
      (pv.kind === "schedule" ? '<div class="c-field">' + check("Start each shoot on a new page", "pr:one_per_page", !!o.one_per_page) +
        "</div>" : "") +
      field("Paper", '<select data-f="pr:paper">' + options(PAPER_CHOICES, o.paper) + "</select>") + "</div>" +
      '<div class="c-actions">' + btn("Print / Save as PDF", "print-now", { primary: true, big: true, disabled: !pv.d }) + "</div>" +
      '<p class="c-help">Your browser\'s print window prints it, or saves it as a PDF' +
      (d.file_name ? " (" + esc(d.file_name) + ")" : "") + ". Turn off the browser's own headers and footers there for the " +
      "cleanest pages.</p>";
  }
  /* The model as the PC sent it, with this page's layout choices. */
  function docFor() {
    var pv = S.v.print, d = pv.d || {}, o = pv.opts;
    var notes = pv.kind === "agenda" ? 0 : d.options && d.options.notes === o.notes && typeof d.notes_lines === "number" ?
      d.notes_lines : NOTES_LINES[o.notes];
    var opts = { notes_lines: notes, one_per_page: pv.kind === "schedule" && !!o.one_per_page, paper: o.paper };
    var body = pv.kind === "agenda" ? agendaDoc(d) : pv.kind === "shoot" ? shootDoc(d, opts) : scheduleDoc(d, opts);
    return { body: body, opts: opts, d: d };
  }
  function previewHtml() {
    var x = docFor(), foot = x.d.footer || {};
    return '<div class="cph-paper cph-paper-' + (x.opts.paper === "a4" ? "a4" : "letter") + '" id="cphPaper"><div class="cpr">' + x.body +
      "</div>" + '<div class="cph-paperfoot"><span>' + esc(str(foot.left) + " · page numbers when printed") + "</span><span>" +
      esc(foot.right) + "</span></div></div>";
  }
  function showPreview() {
    setHtml("cphPreview", previewHtml());
    fitPaper();
  }
  /* The preview is laid out on the paper's own width and shrunk to fit the
     screen — a small copy of the page, not the page reflowed for a phone. */
  function fitPaper() {
    var box = $("cphPreview"), paper = $("cphPaper");
    if (!box || !paper || !paper.style || !box.clientWidth) return;
    var full = (S.v.print && S.v.print.opts.paper === "a4") ? 794 : 816;
    var z = Math.min(1, box.clientWidth / full);
    paper.style.zoom = z < 1 ? String(Math.floor(z * 1000) / 1000) : "";
  }
  CLICK["print-now"] = function () {
    var pv = S.v.print;
    if (!pv || !pv.d) return;
    var x = docFor(), foot = x.d.footer || {};
    var html = pageStyle(x.opts.paper, foot.left, foot.right) + '<div class="cpr cpr-print">' + x.body + "</div>";
    var title = str(x.d.file_name).replace(/\.pdf$/i, "") || "Photo & Video schedule";
    var a = printArgs();
    if (pv.kind !== "agenda" && pv.sent !== JSON.stringify(a[1])) {
      /* the PC remembers the choices for the next printout, as the desktop does */
      S.ctx.rpc(a[0], a[1], { quiet: true }).then(function (d) { S.cache[keyOf(a[0], a[1])] = { data: d, at: Date.now() }; pv.sent = JSON.stringify(a[1]); },
        noop);
    }
    if (S.ctx && typeof S.ctx.print === "function") S.ctx.print(html, { title: title, paper: x.opts.paper });
  };

  /* @page for the paper and the footer on every page — "A068 · Photo &
     Video schedule · page 2 of 7" left, "Printed Tue Oct 6, 2026" right —
     as the desktop paints it (browsers with page margin boxes). */
  function cssString(s) {
    return '"' + str(s).replace(/[\\"]/g, "\\$&").replace(/[\r\n]+/g, " ").replace(/</g, "\\3C ") + '"';
  }
  function pageStyle(paper, left, right) {
    var box = "font-family:'Segoe UI',Arial,sans-serif;font-size:8.5pt;color:#3d3d3d;border-top:0.75pt solid #8c8c8c;" +
      "vertical-align:top;padding-top:4pt;";
    return "<style>@page{size:" + (paper === "a4" ? "A4" : "letter") + " portrait;margin:0.6in 0.65in 0.62in 0.65in;" +
      "@bottom-left{content:" + cssString((left ? left + " · " : "") + "page ") + ' counter(page) " of " counter(pages);' + box +
      "}@bottom-right{content:" + cssString(right) + ";text-align:right;" + box + "}}</style>";
  }

  /* ── the paper itself: ui/photo_print.py's schedule_html, shoot_html and
     agenda_html, as HTML for the browser (console-print.css lays it out) ── */

  var BOX = '<svg class="cpr-box" viewBox="0 0 15 15" aria-hidden="true"><rect x="0.6" y="0.6" width="13.8" height="13.8" ' +
    'fill="none" stroke="#000" stroke-width="1.25"/></svg>';
  var TICK = '<svg class="cpr-box" viewBox="0 0 15 15" aria-label="done"><rect x="0.6" y="0.6" width="13.8" height="13.8" ' +
    'fill="none" stroke="#000" stroke-width="1.25"/><polyline points="3.3,7.8 6.4,11.1 12,3.9" fill="none" stroke="#000" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function boxFor(status) { return status === "done" ? TICK : own(CLOSED, status) ? '<span class="cpr-dash">–</span>' : BOX; }
  function upper(s) { return str(s).toUpperCase(); }
  function ruled(n) { var out = ""; for (var i = 0; i < n; i++) out += '<div class="cpr-line"></div>'; return out; }
  /* A notes block on one page with its label: never bare lines at the top
     of the next page (the desktop trims a block that runs over; a browser
     cannot, so the whole block moves instead). */
  function notesBlock(label, n) {
    if (!n) return "";
    return '<div class="cpr-keep cpr-notes"><p class="cpr-label">' + esc(upper(label)) + "</p>" + ruled(n) + "</div>";
  }
  function bullets(items) {
    items = (Array.isArray(items) ? items : []).map(function (x) { return str(x).trim(); }).filter(Boolean);
    return items.length ? '<ul class="cpr-ul">' + items.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" : "";
  }
  function checks(items) {
    return (Array.isArray(items) ? items : []).map(function (x) { return str(x).trim(); }).filter(Boolean).map(function (x) {
      return '<div class="cpr-check">' + BOX + "<span>" + esc(x) + "</span></div>";
    }).join("");
  }
  function plainLine(v, cap) {
    var s = str(v).replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
    return s.length <= cap ? s : s.slice(0, cap).replace(/[ ,;:-]+$/, "");
  }

  function headerDoc(m, kicker, title, cells) {
    var firm = [str(m.company), m.office_phone ? "Office " + m.office_phone : ""].filter(Boolean).join(" · ");
    cells = cells.filter(function (c) { return str(c[1]); });
    var grid = "";
    for (var i = 0; i < cells.length; i += 2) {
      var pair = cells.slice(i, i + 2);
      grid += '<div class="cpr-factrow">' + pair.map(function (c) {
        return '<span class="cpr-k">' + esc(c[0]) + '</span><span class="cpr-v">' + esc(c[1]) + "</span>";
      }).join("") + (pair.length < 2 ? '<span class="cpr-k"></span><span class="cpr-v"></span>' : "") + "</div>";
    }
    return '<header class="cpr-head"><div class="cpr-top"><span class="cpr-kicker">' + esc(upper(kicker)) + '</span>' +
      '<span class="cpr-kicker">' + esc(upper(firm)) + '</span></div><h1 class="cpr-title">' + esc(title) + "</h1>" +
      (grid ? '<div class="cpr-facts">' + grid + "</div>" : "") + "</header>";
  }
  function projectHeader(m) {
    var site = [str(m.address), str(m.city)].filter(Boolean).join(", ");
    return headerDoc(m, "Photo & Video schedule", str(m.label) || str(m.code) || "Project",
      [["Site", site], ["Photographer", str(m.photographer) || "not picked yet"], ["Printed", longDayText(m.printed)],
        ["Plan", str(m.made_by)], ["Copies to", str(m.copies)]]);
  }
  function milestonesDoc(m) {
    var rows = m.milestones || [];
    if (!rows.length) return "";
    var head = '<div class="cpr-tr cpr-th cpr-ms"><span>Milestone</span><span>Date</span><span>How sure</span>' +
      "<span>Where the date comes from</span></div>";
    var trs = rows.map(function (r) {
      return '<div class="cpr-tr cpr-ms"><span><b>' + esc(r.name) + "</b></span><span>" + esc(longDayText(r.date) || "Not known yet") +
        "</span><span>" + esc(own(SURE_WORDS, r.sure) ? SURE_WORDS[r.sure] : r.sure) + "</span><span>" + esc(r.source) + "</span></div>";
    });
    return '<div class="cpr-keep"><h2 class="cpr-h2">Milestones</h2>' + head + trs.join("") + "</div>";
  }
  function glanceDoc(d) {
    var m = d.model || {}, rows = m.shoots || [];
    var head = '<h2 class="cpr-h2">The schedule at a glance</h2><div class="cpr-tr cpr-th cpr-gl"><span>Done</span><span>Date</span>' +
      "<span>Shoot and time of day</span><span>Golden hour</span><span>Status</span></div>";
    var trs = rows.map(function (r) {
      var tod = str((r.brief || {}).time_of_day);
      return '<div class="cpr-tr cpr-gl"><span class="cpr-boxcell">' + boxFor(r.status) + "</span><span>" +
        (r.date ? "<b>" + esc(dayText(r.date)) + "</b>" : "<i>Date to be set</i>") + "</span><span><b>" + esc(r.name) + "</b>" +
        (tod ? '<br><span class="cpr-soft">' + esc(tod) + "</span>" : "") + "</span><span>" + (esc(dash(r.golden)) || "—") +
        "</span><span>" + esc(r.status_words) + "</span></div>";
    });
    var notes = [rows.length ? str(d.light_note) : "", str(d.hidden_note)].filter(Boolean);
    return '<div class="cpr-keep">' + head + trs.slice(0, 3).join("") + "</div>" + trs.slice(3).join("") +
      (rows.length ? "" : '<p class="cpr-para">No shoots to print.</p>') +
      notes.map(function (n) { return '<p class="cpr-note">' + esc(n) + "</p>"; }).join("");
  }
  function shootDoc1(d, r, opts, first) {
    var m = d.model || {}, b = r.brief || {};
    var brk = opts.one_per_page && !first ? " cpr-newpage" : "";
    var kicker = "SHOOT " + int(r.n) + " OF " + int(r.of) + (r.phase ? " · " + upper(r.phase) : "");
    var band = '<div class="cpr-band"><div><p class="cpr-kicker">' + esc(kicker) + '</p><p class="cpr-shoot">' + esc(r.name) + "</p></div>" +
      '<div class="cpr-bandright"><p class="cpr-when">' + (r.date ? esc(dayText(r.date)) : "Date to be set") + '</p><p class="cpr-small">' +
      esc(r.status_words) + "</p></div></div>";
    var when = [r.date ? longDayText(r.date) : "Date to be set — the office will tell you the day"];
    if (b.time_of_day) when.push(str(b.time_of_day));
    if (int(r.window_days)) when.push("can slip up to " + plural(int(r.window_days), "day"));
    var metas = ['<p class="cpr-meta"><b>When:</b> ' + esc(when.join(" · ")) + "</p>"];
    if (r.golden) {
      var where = str(m.light_where);
      metas.push('<p class="cpr-meta"><b>Light:</b> ' + esc((where ? "golden hour for " + where + " " : "golden hour ") + dash(r.golden) +
        (r.sunset ? " · sunset " + r.sunset : "")) + "</p>");
    }
    if (r.weather) metas.push('<p class="cpr-meta"><b>Forecast:</b> ' + esc(r.weather) + "</p>");
    if (own(CLOSED, r.status)) metas.push('<p class="cpr-meta"><b>' + esc(r.status_words) + "</b>" + (r.done_note ? " " + esc("— " + r.done_note) : "") + "</p>");
    var shots = (Array.isArray(b.shots) ? b.shots : []).filter(function (s) { return s && (s.title || s.description); });
    var purpose = b.purpose ? '<p class="cpr-label">PURPOSE</p><p class="cpr-para">' + esc(b.purpose) + "</p>" : "";
    var shotRows = shots.map(function (s) {
      var title = esc(plainLine(s.title, 200)), desc = esc(plainLine(s.description, 600));
      var text = (title ? "<b>" + title + "</b>" : "") + (desc && title ? " — " + desc : desc);
      return '<div class="cpr-tr cpr-shots"><span class="cpr-boxcell">' + BOX + "</span><span>" +
        (s.priority === "must" ? "<b>Must</b>" : "Nice") + "</span><span>" + text + "</span><span>" +
        esc(own(KIND_WORDS, s.kind) ? KIND_WORDS[s.kind] : str(s.kind || "photo").charAt(0).toUpperCase() + str(s.kind || "photo").slice(1)) +
        "</span></div>";
    });
    var shotHead = shots.length ? '<p class="cpr-label">SHOT LIST</p><div class="cpr-tr cpr-th cpr-shots"><span></span><span>Need</span>' +
      "<span>Shot — what to frame</span><span>Kind</span></div>" : "";
    var out = '<section class="cpr-sec' + brk + '"><div class="cpr-keep">' + band + metas.join("") + purpose + shotHead +
      shotRows.slice(0, 3).join("") + "</div>" + shotRows.slice(3).join("");
    if (b.sample_shot) out += '<div class="cpr-sample cpr-keep"><p class="cpr-kicker">SAMPLE SHOT</p><p class="cpr-para">' +
      esc(b.sample_shot) + "</p></div>";
    if ((b.tips || []).length) out += '<div class="cpr-keep"><p class="cpr-label">TIPS</p>' + bullets(b.tips) + "</div>";
    var bring = Array.isArray(b.equipment) ? b.equipment : [], safety = Array.isArray(b.safety) ? b.safety : [];
    if (bring.length && safety.length) {
      out += '<div class="cpr-sides cpr-keep"><div><p class="cpr-label">BRING</p>' + bullets(bring) + '</div><div><p class="cpr-label">' +
        "SAFETY</p>" + bullets(safety) + "</div></div>";
    } else if (bring.length || safety.length) {
      out += '<div class="cpr-keep"><p class="cpr-label">' + (bring.length ? "BRING" : "SAFETY") + "</p>" + bullets(bring.length ? bring : safety) +
        "</div>";
    }
    var drone = b.drone || {};
    if (drone.needed || drone.notes) {
      out += '<div class="cpr-keep"><p class="cpr-label">' + (drone.needed ? "DRONE" : "DRONE — NOT NEEDED") + "</p>" +
        (drone.notes ? '<p class="cpr-para">' + esc(drone.notes) + "</p>" : "") + (drone.needed ? checks(d.drone_check) : "") + "</div>";
    }
    if ((b.caption_ideas || []).length) out += '<div class="cpr-keep"><p class="cpr-label">CAPTION IDEAS</p>' + bullets(b.caption_ideas) +
      "</div>";
    out += notesBlock("Notes · shoot " + int(r.n) + " of " + int(r.of), int(opts.notes_lines));
    return out + "</section>";
  }
  function scheduleDoc(d, opts) {
    var m = d.model || {};
    var out = projectHeader(m);
    if (m.summary) out += '<div class="cpr-keep"><h2 class="cpr-h2">The game plan</h2><p class="cpr-para">' + esc(m.summary) + "</p></div>";
    if (m.story) out += '<p class="cpr-para cpr-story"><b>The story:</b> ' + esc(m.story) + "</p>";
    out += milestonesDoc(m) + glanceDoc(d);
    /* "Start each shoot on a new page" starts the first one on its own page
       too, after the schedule at a glance — as the desktop's printout does */
    (m.shoots || []).forEach(function (r) { out += shootDoc1(d, r, opts, false); });
    var groups = Array.isArray(m.visit_groups) && m.visit_groups.length ? m.visit_groups : [["", m.visit || d.visit_basics || []]];
    out += '<section class="cpr-closing cpr-keep"><h2 class="cpr-h2">Before every visit</h2>' + groups.map(function (g) {
      var title = Array.isArray(g) ? str(g[0]) : str(g && g.title), items = Array.isArray(g) ? g[1] : g && g.items;
      return (title ? '<p class="cpr-label">' + esc(upper(title)) + "</p>" : "") + checks(items);
    }).join("") + '<h2 class="cpr-h2">General notes</h2>' + ruled(GENERAL_NOTE_LINES) + "</section>";
    return out;
  }
  function shootDoc(d, opts) {
    var m = d.model || {};
    return projectHeader(m) + (m.shoots || []).map(function (r) { return shootDoc1(d, r, { notes_lines: opts.notes_lines }, true); }).join("");
  }
  function agendaDoc(d) {
    var m = d.model || {};
    var people = Array.isArray(m.photographers) ? m.photographers.map(str).filter(Boolean) : [];
    var out = headerDoc(m, "Photo & Video shoots", str(m.title) || "Every active plan",
      [["Photographer", people.join(", ") || "not picked yet"], ["Printed", longDayText(m.printed)], ["Shoots", String(int(m.count))]]);
    var head = '<div class="cpr-tr cpr-th cpr-ag"><span>Done</span><span>Date</span><span>Project</span><span>Shoot and time of day</span>' +
      "<span>Notes</span></div>";
    (m.groups || []).forEach(function (g) {
      var rows = (g.rows || []).map(function (r) {
        return '<div class="cpr-tr cpr-ag"><span class="cpr-boxcell">' + BOX + "</span><span>" + (r.date ? "<b>" + esc(dayText(r.date)) +
          "</b>" : "<i>To be set</i>") + '<br><span class="cpr-soft">' + esc(r.status_words) + "</span></span><span>" +
          esc(r.label || r.code) + (r.city ? '<br><span class="cpr-soft">' + esc(r.city) + "</span>" : "") + "</span><span><b>" +
          esc(r.name) + "</b>" + (r.time_of_day ? '<br><span class="cpr-soft">' + esc(r.time_of_day) + "</span>" : "") +
          '</span><span class="cpr-write"></span></div>';
      });
      out += '<div class="cpr-keep"><h2 class="cpr-h2">' + esc(g.title) + "</h2>" + head + rows.slice(0, 1).join("") + "</div>" +
        rows.slice(1).join("");
    });
    if (!(m.groups || []).length) out += '<p class="cpr-para">No shoots to print.</p>';
    if (int(m.hidden_done)) out += '<p class="cpr-note">' + esc("Not listed: " + plural(int(m.hidden_done), "shoot") + " done recently.") + "</p>";
    if (m.cut_note) out += '<p class="cpr-note">' + esc(m.cut_note) + "</p>";
    return out + '<section class="cpr-keep"><h2 class="cpr-h2">Notes</h2>' + ruled(GENERAL_NOTE_LINES) + "</section>";
  }

  /* Unsaved edits: the browser asks before the page is closed or reloaded. */
  function anyDirty() {
    var k;
    for (k in S.shoot) if (own(S.shoot, k) && !same(S.shoot[k].form, S.shoot[k].base)) return true;
    for (k in S.ms) if (own(S.ms, k) && !same(S.ms[k].form, S.ms[k].base)) return true;
    return !!(S.settings && !same(S.settings.form, S.settings.base));
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("beforeunload", function (e) {
      if (!anyDirty()) return;
      e.preventDefault();
      e.returnValue = "";
    });
    window.addEventListener("resize", function () { if (S.v && S.v.print) fitPaper(); });
  }

  var DEF = { id: "photo", title: "Photo & Video", order: 50, render: render, leave: leave };
  /* The pure pieces, for the page tests and the print check. */
  window.DCRConsolePhoto = {
    def: DEF, dayText: dayText, longDayText: longDayText, dash: dash, scheduleDoc: scheduleDoc, shootDoc: shootDoc,
    agendaDoc: agendaDoc, pageStyle: pageStyle, emailProblem: emailProblem, parseTyped: parseTyped, where: where,
    state: function () { return S; },
  };
  if (window.DCRConsole && typeof window.DCRConsole.register === "function") window.DCRConsole.register(DEF);
})();
