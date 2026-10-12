/* DCR Agents web console — the Activity, Replies and People tabs
   (console-spec §6.1.6, §6.1.7, §6.1.8 and §6.4).

   Views over the DCR server computer's ledger, through ctx.rpc; the words
   and the rules are the desktop tabs' own, on the PC (manual.py,
   roster.py, console/audit.py):

   Activity — what the agents sent (filter, paging, a message's words on a
   tap, "Export CSV" built here in the browser from the same pages), the
   events log, the agent runs, and the remote actions: what the admins did
   from this console, never the words they typed.

   Replies — what came back and what happened with it; Poll now; a reply
   by hand (always to the reply's own address, on the channel the PC picks,
   after the PC's own question); "Teach the agents what this meant…", a
   reply-reading example kept on Training; "This is…" for a WhatsApp
   message from a name nobody is known by (the contact name saved on the
   company phone): the PC keeps it as the person's WhatsApp name and
   handles the last day's messages from it, after its own question.

   People — the roster with phones, emails and flags (taught on Training);
   a person's overrides, WhatsApp name, channel preference, mute and
   always-nudge; Refresh
   from portal; a test text to the number on file (after the PC's
   question). Opt-outs are shown, never cleared — the desktop does not
   allow it either.

   The shell's vocabulary (agents-console.css, ctx.ui.table / pager / chip)
   with a few classes of its own. Everything from the server goes through
   ctx.esc; write buttons carry data-act (greyed while the DCR server is
   offline or in Standby) and data-method (greyed when the server's build
   does not know the method). */
(function () {
  "use strict";

  var UPDATE = "Update DCR Agents on the server computer to use this";
  var LIMIT = 50;
  var EXPORT_PAGE = 200;
  var EXPORT_MAX_PAGES = 10;          // the PC reads the newest 1000 messages
  var FILTER_WAIT_MS = 500;
  var REPLY_MAX = 1600, SAID_MAX = 1000, MEANT_MAX = 500, PHONE_MAX = 30, EMAIL_MAX = 120, WA_NAME_MAX = 80;
  /* the two WhatsApps told apart in a reply's line */
  var CHANNEL_WORDS = { whatsapp: "WhatsApp (Twilio)", wadesktop: "WhatsApp on the DCR server" };

  /* ── small helpers ───────────────────────────────────────────────────── */

  function errWords(e) { return (e && e.message) || "Something went wrong."; }
  function m(method) { return ' data-method="' + method + '"'; }
  function canAct(ctx) { return !ctx.canAct || ctx.canAct(); }
  function find(root, id) { return root && root.querySelector ? root.querySelector("#" + id) : null; }
  function setHtml(root, id, html) { var n = find(root, id); if (n) n.innerHTML = html; return n; }
  function say(root, id, text, tone) {
    var n = find(root, id);
    if (!n) return;
    n.className = "cp-msg" + (tone ? " " + tone : "");
    n.textContent = text || "";
  }
  function working(ctx, node, text) {
    if (!node) return function () {};
    if (ctx.busy) {
      try { return ctx.busy(node, text) || function () {}; } catch (e) { /* fall through */ }
    }
    node.innerHTML = '<div class="c-busy">' + ctx.esc(text) + "</div>";
    return function () {};
  }
  function emptyHtml(ctx, words) {
    return ctx.ui && ctx.ui.empty ? ctx.ui.empty(words) : '<div class="c-empty">' + ctx.esc(words) + "</div>";
  }
  function failedHtml(ctx, e) {
    return ctx.ui && ctx.ui.failed ? ctx.ui.failed(e) : '<div class="c-error"><span>' + ctx.esc(errWords(e)) + "</span></div>";
  }
  function chip(ctx, text, tone) {
    return ctx.ui && ctx.ui.chip ? ctx.ui.chip(text, tone) : '<span class="c-chip' + (tone ? " " + tone : "") + '">' + ctx.esc(text) + "</span>";
  }
  function press(ctx, btn, fn, words) { return ctx.press && btn ? ctx.press(btn, fn, words) : fn(); }

  /* When something happened, in this browser's own time: "Oct 9, 11:42 AM". */
  function when(iso) {
    var t = Date.parse(String(iso || ""));
    if (!isFinite(t)) return String(iso || "");
    try {
      return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) { return new Date(t).toISOString().slice(0, 16).replace("T", " "); }
  }
  /* The same, for a spreadsheet: "2026-10-09 11:42". */
  function stamp(iso) {
    var t = Date.parse(String(iso || ""));
    if (!isFinite(t)) return String(iso || "");
    var d = new Date(t);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* The shell's table (a card per row under 640 px) and pager. */
  function table(ctx, o) {
    if (ctx.ui && ctx.ui.table) return ctx.ui.table(o);
    if (!o.rows.length) return emptyHtml(ctx, o.empty);
    return '<table class="c-table"><tbody>' + o.rows.map(function (r, i) {
      return '<tr data-row="' + i + '">' + o.cols.map(function (c) {
        return '<td data-label="' + ctx.esc(c.label) + '">' + (c.render ? c.render(r, i) : ctx.esc(r[c.key])) + "</td>";
      }).join("") + "</tr>";
    }).join("") + "</tbody></table>";
  }
  /* the shell's pager, only when there is more than one page */
  function pager(ctx, page, onPage) {
    if (!page || (!(Number(page.offset) > 0) && (page.next === null || page.next === undefined))) return "";
    return ctx.ui && ctx.ui.pager ? ctx.ui.pager(page, onPage) : "";
  }

  /* ── this module's own look, over the shell's tokens (.c-app) ────────── */

  var CSS = [
    ".cp-seg{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px;padding:3px;margin:0 0 12px;max-width:640px;",
    "background:var(--surface-2);border:1px solid var(--border);border-radius:12px}",
    ".cp-seg button{min-height:44px;padding:6px;border:0;border-radius:9px;background:transparent;color:var(--text-muted);font-weight:700;",
    "font-size:14px;line-height:1.15}",
    ".cp-seg button[aria-selected=\"true\"]{background:var(--surface);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.14)}",
    ".cp-seg button:focus-visible{outline:2px solid var(--acc);outline-offset:1px}",
    ".cp-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 10px}",
    ".cp-tools input[type=search]{flex:1 1 240px;width:auto;min-height:44px;font-size:16px}",
    ".cp-tools select{width:auto;min-height:44px;font-size:15px}",
    ".cp-msg{min-height:20px;margin:0 0 10px;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text-muted)}",
    ".cp-msg.ok{color:var(--text)}.cp-msg.bad{color:var(--bad);font-weight:600}",
    ".cp-msg:empty{margin:0;min-height:0}",
    /* two lines at most (a block, not -webkit-box: that one keeps a long
       unbroken JSON summary from wrapping and widens the whole table) */
    ".cp-clip{display:block;max-height:2.9em;line-height:1.45;overflow:hidden;overflow-wrap:anywhere;word-break:break-word}",
    ".cp-bad{color:var(--bad);font-weight:800}",
    ".cp .c-table td.cp-words{overflow-wrap:normal;word-break:normal;min-width:9em}",
    ".cp input,.cp select{font-family:inherit}",
    ":root[data-theme=\"dark\"] .cp input{color-scheme:dark}",
    "@media (prefers-color-scheme: dark){:root:not([data-theme=\"light\"]) .cp input{color-scheme:dark}}",
    /* a card under 640px leaves out the lines with nothing in them */
    "@media (max-width:640px){.cp .c-table td:empty{display:none}}",
    ".cp-count{margin:6px 2px 0;font-size:13px;color:var(--text-muted)}",
    /* replies */
    ".cp-replies{list-style:none;margin:0;padding:0}",
    ".cp-reply{margin:0 0 10px;padding:12px 14px 6px}",
    ".cp-rhead{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px}",
    ".cp-rwho{font-weight:800;font-size:15.5px;overflow-wrap:anywhere}",
    ".cp-rbody{margin:6px 0 6px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.45}",
    ".cp-rline{font-size:13.5px;color:var(--text-muted);overflow-wrap:anywhere;white-space:pre-wrap;margin:1px 0}",
    ".cp-rline b{font-weight:700}",
    ".cp-ract{display:flex;flex-wrap:wrap;gap:0 16px;margin-top:2px}",
    /* a person */
    ".cp-page{max-width:640px}",
    ".cp-back{margin:-4px 0 6px}",
    ".cp-flags{margin:6px 0 0}",
    ".cp-flags .c-chip{margin:0 4px 4px 0}",
    ".cp-form .c-field input,.cp-form .c-field select{font-size:16px;min-height:44px}",
    "@media (max-width:640px){.cp-seg button{font-size:13px}}",
  ].join("\n");

  function style() {
    try {
      if (typeof document === "undefined" || !document.head || document.getElementById("cpStyle")) return;
      var s = document.createElement("style");
      s.id = "cpStyle";
      s.textContent = CSS;
      document.head.appendChild(s);
    } catch (e) { /* the page still works unstyled */ }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Activity
     ════════════════════════════════════════════════════════════════════════ */

  var VIEWS = [
    { id: "sends", label: "Messages", method: "activity.sends", empty: "No messages yet." },
    { id: "events", label: "Events", method: "activity.events", empty: "No events." },
    { id: "runs", label: "Runs", method: "activity.runs", empty: "No agent runs yet." },
    { id: "remote", label: "Remote actions", method: "activity.remote", empty: "Nobody has done anything from the web yet." },
  ];
  /* qs: each view's own filter (the desktop filters Messages and Remote
     actions; Runs too, here). */
  var AC = { view: "sends", qs: { sends: "", runs: "", remote: "" }, level: "", offset: { sends: 0, events: 0, runs: 0, remote: 0 }, data: null,
    gen: 0, timer: null };
  var FILTER_WORDS = { sends: ["filter by person, agent, channel or status", "Filter the messages"],
    runs: ["filter by agent or note", "Filter the runs"], remote: ["filter by admin, action or how it went", "Filter the remote actions"] };

  function viewOf(id) { return VIEWS.filter(function (v) { return v.id === id; })[0] || VIEWS[0]; }

  function howItWent(r) { return (r.ok ? "OK" : "problem — " + (r.code || "failed")) + (r.late ? " (late)" : ""); }

  function columns(ctx, view) {
    var esc = ctx.esc;
    var at = { key: "at", label: "When", cls: "c-nowrap", render: function (r) { return esc(when(r.at)); } };
    var clip = function (k) { return function (r) { return r[k] ? '<span class="cp-clip">' + esc(r[k]) + "</span>" : ""; }; };
    if (view === "sends") {
      return [at, { key: "agent", label: "Agent" }, { key: "channel", label: "Channel" }, { key: "person", label: "Person" },
        { key: "to", label: "To" },
        { key: "status", label: "Status", cls: "c-nowrap", render: function (r) {
          if (r.dry || r.status === "dry-run") return chip(ctx, "dry run", "warn");      // the ledger's "dry-run" row
          var tone = r.status === "sent" || r.status === "delivered" ? "good" : (r.status === "failed" ? "bad" : "dim");
          return chip(ctx, r.status || "?", tone);
        } },
        { key: "delivery", label: "Delivery" }, { key: "note", label: "Note", render: clip("note") }];
    }
    if (view === "events") {
      return [at,
        { key: "level", label: "Level", cls: "c-nowrap", render: function (r) { return chip(ctx, r.level || "info", r.level === "error" ? "bad" : (r.level === "warn" ? "warn" : "dim")); } },
        { key: "area", label: "Area", cls: "c-nowrap" }, { key: "message", label: "Message", render: clip("message") },
        { key: "detail", label: "Detail", render: clip("detail") }];
    }
    if (view === "runs") {
      return [at,
        { key: "agent", label: "Agent", render: function (r) { return esc(r.agent) + (r.dry ? " " + chip(ctx, "dry run", "warn") : ""); } },
        { key: "found", label: "Found", cls: "c-num" }, { key: "sent", label: "Sent", cls: "c-num" },
        { key: "skipped", label: "Skipped", cls: "c-num" },
        { key: "failed", label: "Failed", cls: "c-num", render: function (r) { return Number(r.failed) ? '<span class="cp-bad">' + esc(r.failed) + "</span>" : esc(r.failed); } },
        { key: "note", label: "Note", render: clip("note") }];
    }
    return [at, { key: "admin", label: "Admin", cls: "cp-words" }, { key: "method", label: "Did", cls: "c-nowrap" },
      { key: "summary", label: "Details", render: clip("summary") },
      { key: "kind", label: "Kind", cls: "c-nowrap", render: function (r) { return esc(r.kind === "W" ? "change" : "look"); } },
      { key: "ok", label: "How it went", cls: "c-nowrap", render: function (r) { return chip(ctx, howItWent(r), r.ok ? (r.late ? "warn" : "good") : "bad"); } },
      { key: "ms", label: "Took", cls: "c-num", render: function (r) { return esc(((Number(r.ms) || 0) / 1000).toFixed(1) + " s"); } }];
  }

  /* A tapped row in full: a message's words are asked of the PC; the other
     views show the row's own long fields. */
  function acOpen(root, ctx, r) {
    if (!r || !ctx.modal) return Promise.resolve();
    var gen = AC.gen;
    if (AC.view === "sends") {
      return ctx.rpc("activity.send", { id: r.id }, { text: "Loading the message…" }).then(function (msg) {
        if (gen !== AC.gen) return;
        var head = [when(r.at), r.agent, r.channel + " to " + (r.person || r.to), r.status + (r.dry ? " (dry run)" : "")].filter(Boolean).join(" · ");
        ctx.modal({
          title: msg && msg.subject ? msg.subject : "The message", okText: "Close", cancel: false, fields: [],
          message: head + "\n\n" + ((msg && msg.body) || "(no words kept)") + (r.note ? "\n\n" + r.note : "") + (r.key ? "\n\n" + r.key : ""),
        });
      }, function () { /* the shell's toast said why */ });
    }
    var text = AC.view === "events" ? [r.area, r.message, r.detail].filter(Boolean).join("\n\n")
      : AC.view === "runs" ? [r.agent, "Found " + r.found + " · sent " + r.sent + " · skipped " + r.skipped + " · failed " + r.failed, r.note].filter(Boolean).join("\n\n")
        : [r.admin, r.method + (r.summary ? " " + r.summary : ""), howItWent(r)].filter(Boolean).join("\n\n");
    return Promise.resolve(ctx.modal({ title: when(r.at), message: text, okText: "Close", cancel: false, fields: [] }));
  }

  function acArgs() {
    var a = { offset: AC.offset[AC.view] || 0, limit: LIMIT };
    if (AC.view === "sends") a.q = AC.qs.sends;
    else if (AC.view in AC.qs && AC.qs[AC.view]) a.q = AC.qs[AC.view];    // sent only when filtering: an older server lacks it
    if (AC.view === "events") a.level = AC.level;
    return a;
  }

  function acDraw(root, ctx) {
    var v = viewOf(AC.view);
    var rows = (AC.data && AC.data.rows) || [];
    setHtml(root, "cpAcList", table(ctx, {
      cols: columns(ctx, AC.view), rows: rows,
      empty: AC.view === "sends" && AC.qs.sends ? "No message matches the filter." : AC.qs[AC.view] ? "Nothing matches the filter." : v.empty,
      onRow: function (r) { acOpen(root, ctx, r); },
    }));
    setHtml(root, "cpAcPager", pager(ctx, AC.data && AC.data.page, function (offset) {
      AC.offset[AC.view] = Math.max(0, Number(offset) || 0);
      acLoad(root, ctx);
    }));
  }

  function acLoad(root, ctx) {
    var gen = ++AC.gen;
    var v = viewOf(AC.view);
    if (ctx.has && !ctx.has(v.method)) {
      AC.data = null;
      setHtml(root, "cpAcList", emptyHtml(ctx, UPDATE + "."));
      setHtml(root, "cpAcPager", "");
      return Promise.resolve();
    }
    var done = working(ctx, find(root, "cpAcBusy"), "Loading…");
    return ctx.rpc(v.method, acArgs(), { quiet: true }).then(function (d) {
      done();                            // its own working line, even when a newer load took over
      if (gen !== AC.gen) return;
      AC.data = d || { rows: [] };
      acDraw(root, ctx);
    }, function (e) {
      done();                            // its own working line, even when a newer load took over
      if (gen !== AC.gen) return;
      AC.data = null;
      setHtml(root, "cpAcList", failedHtml(ctx, e));
      setHtml(root, "cpAcPager", "");
    });
  }

  function acSegHtml(ctx) {
    return VIEWS.map(function (v) {
      return '<button type="button" role="tab" data-cp="ac-view" data-v="' + v.id + '" aria-selected="' + (v.id === AC.view ? "true" : "false") + '">' +
        ctx.esc(v.label) + "</button>";
    }).join("");
  }

  function acToolsHtml(ctx) {
    var esc = ctx.esc;
    if (AC.view in AC.qs) {
      var fw = FILTER_WORDS[AC.view];
      return '<input type="search" id="cpAcQ" data-cp="ac-q" maxlength="80" placeholder="' + esc(fw[0]) + '" ' +
        'aria-label="' + esc(fw[1]) + '" value="' + esc(AC.qs[AC.view]) + '">' +
        (AC.view === "sends" ? '<button type="button" class="c-btn ghost sm" data-cp="ac-csv"' + m("activity.sends") + ">Export CSV</button>" : "");
    }
    if (AC.view === "events") {
      return '<select id="cpAcLevel" data-cp="ac-level" aria-label="Which events">' +
        [["", "Every event"], ["info", "Info"], ["warn", "Warnings"], ["error", "Errors"]].map(function (o) {
          return '<option value="' + o[0] + '"' + (AC.level === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
        }).join("") + "</select>";
    }
    return "";
  }

  function csvField(v) {
    var s = String(v == null ? "" : v);
    /* a cell a spreadsheet would run as a formula is kept as text */
    if (/^[=@\t\r]/.test(s) || /^[+-][^0-9]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* The desktop's export columns, in its order. */
  function csvText(rows) {
    var lines = [["when", "agent", "channel", "person", "to", "status", "delivery", "note", "key"].join(",")];
    rows.forEach(function (r) {
      lines.push([stamp(r.at), r.agent, r.channel, r.person, r.to, (r.status || "") + (r.dry ? " (dry)" : ""), r.delivery, r.note, r.key]
        .map(csvField).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  function download(name, text) {
    var blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 2000);
  }

  /* Export CSV: the messages under the filter, read page by page from the
     PC and written here — the PC never writes a file (§6.1.6). */
  function acExport(root, ctx, btn) {
    var gen = AC.gen;
    var all = [];
    var q = AC.qs.sends;
    function step(offset, n) {
      return ctx.rpc("activity.sends", { q: q, offset: offset, limit: EXPORT_PAGE }, { text: "Reading the messages…", quiet: true }).then(function (d) {
        all = all.concat((d && d.rows) || []);
        var next = d && d.page ? d.page.next : null;
        if (next != null && n + 1 < EXPORT_MAX_PAGES) return step(next, n + 1);
      });
    }
    return press(ctx, btn, function () {
      return step(0, 0).then(function () {
        if (gen !== AC.gen) return;
        download("dcr-agents-activity.csv", csvText(all));
        say(root, "cpAcMsg", "Exported " + all.length + " message" + (all.length === 1 ? "" : "s") + " to dcr-agents-activity.csv.", "ok");
      }, function (e) {
        if (gen !== AC.gen) return;
        say(root, "cpAcMsg", "Could not export: " + errWords(e), "bad");
      });
    }, "Exporting…");
  }

  function renderActivity(el, ctx) {
    style();
    AC.gen++;
    el.innerHTML =
      '<div class="cp">' +
        '<div class="c-head"><div><h2>Activity</h2><p class="c-sub">What the agents sent, what happened on the DCR server, and what the admins did from the web.</p></div>' +
          '<div class="c-actions"><button type="button" class="c-btn ghost sm" data-cp="ac-refresh">Refresh</button></div></div>' +
        '<div class="cp-seg" id="cpAcSeg" role="tablist" aria-label="What to show">' + acSegHtml(ctx) + "</div>" +
        '<div class="cp-tools" id="cpAcTools">' + acToolsHtml(ctx) + "</div>" +
        '<div class="cp-msg" id="cpAcMsg" role="status"></div><div id="cpAcBusy"></div>' +
        '<div id="cpAcList"></div><div id="cpAcPager"></div>' +
      "</div>";
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-cp]") : null;
      if (!t || t.disabled) return;
      var act = t.getAttribute("data-cp");
      if (act === "ac-view") {
        var v = viewOf(t.getAttribute("data-v")).id;
        if (v === AC.view) return;
        AC.view = v;
        AC.data = null;
        if (AC.timer) { clearTimeout(AC.timer); AC.timer = null; }
        setHtml(el, "cpAcSeg", acSegHtml(ctx));
        setHtml(el, "cpAcTools", acToolsHtml(ctx));
        setHtml(el, "cpAcList", "");
        setHtml(el, "cpAcPager", "");
        say(el, "cpAcMsg", "");
        acLoad(el, ctx);
      } else if (act === "ac-refresh") acLoad(el, ctx);
      else if (act === "ac-csv") acExport(el, ctx, t);
    });
    el.addEventListener("input", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || t.getAttribute("data-cp") !== "ac-q") return;
      var view = AC.view;
      if (!(view in AC.qs)) return;
      AC.qs[view] = String(t.value || "").slice(0, 80);
      if (AC.timer) clearTimeout(AC.timer);
      AC.timer = setTimeout(function () { AC.timer = null; AC.offset[view] = 0; if (AC.view === view) acLoad(el, ctx); }, FILTER_WAIT_MS);
    });
    el.addEventListener("change", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || t.getAttribute("data-cp") !== "ac-level") return;
      AC.level = String(t.value || "");
      AC.offset.events = 0;
      acLoad(el, ctx);
    });
    return acLoad(el, ctx);
  }

  /* ════════════════════════════════════════════════════════════════════════
     Replies
     ════════════════════════════════════════════════════════════════════════ */

  /* drafts: what was typed for a reply that did not go (declined, or
     refused) — the next "Send a text…" starts from it. */
  var RP = { offset: 0, data: null, gen: 0, drafts: {} };

  function rpRow(i) { return RP.data && RP.data.rows ? RP.data.rows[i] : null; }

  function rpListHtml(ctx) {
    var esc = ctx.esc;
    var rows = (RP.data && RP.data.rows) || [];
    if (!rows.length) return emptyHtml(ctx, "No replies yet.");
    return '<ul class="cp-replies">' + rows.map(function (r, i) {
      var email = r.channel === "email";
      var wa = r.channel === "wadesktop";
      return '<li class="c-card flat cp-reply">' +
        '<div class="cp-rhead"><span class="cp-rwho">' + esc(r.person || "(unknown)") + "</span>" +
          '<span class="c-muted c-small">' + esc([r.from, CHANNEL_WORDS[r.channel] || r.channel, when(r.at)].filter(Boolean).join(" · ")) + "</span></div>" +
        (r.subject ? '<div class="cp-rline"><b>Subject:</b> ' + esc(r.subject) + "</div>" : "") +
        '<div class="cp-rbody">' + esc(r.body || "(no words)") + "</div>" +
        (r.result ? '<div class="cp-rline"><b>What happened:</b> ' + esc(r.result) + "</div>" : "") +
        (r.reply ? '<div class="cp-rline"><b>We replied:</b> ' + esc(r.reply) + "</div>" : "") +
        '<div class="cp-ract">' +
          (r.learn ? '<button type="button" class="c-btn link" data-cp="rp-thisis" data-i="' + i + '" data-act' + m("replies.this_is") +
            ' title="Say who this WhatsApp name is: it is kept as their WhatsApp name and the last day\'s messages from it are handled.">This is…</button>' :
          '<button type="button" class="c-btn link" data-cp="rp-reply" data-i="' + i + '" data-act' + m("replies.reply") + ">" +
            (email ? "Send an email…" : wa ? "Send a WhatsApp message…" : "Send a text…") + "</button>") +
          '<button type="button" class="c-btn link" data-cp="rp-teach" data-i="' + i + '" data-act' + m("replies.teach") +
            ' title="Save this reply as an example for reading replies (Training → Reading replies). Claude reads the crew\'s replies with the newest examples in mind.">' +
            "Teach the agents what this meant…</button>" +
        "</div></li>";
    }).join("") + "</ul>";
  }

  function rpDraw(root, ctx) {
    setHtml(root, "cpRpList", rpListHtml(ctx));
    setHtml(root, "cpRpPager", pager(ctx, RP.data && RP.data.page, function (offset) {
      RP.offset = Math.max(0, Number(offset) || 0);
      rpLoad(root, ctx);
    }));
  }

  function rpLoad(root, ctx) {
    var gen = ++RP.gen;
    var done = working(ctx, find(root, "cpRpBusy"), "Loading the replies…");
    return ctx.rpc("replies.list", { offset: RP.offset, limit: LIMIT }, { quiet: true }).then(function (d) {
      done();
      if (gen !== RP.gen) return;
      RP.data = d || { rows: [] };
      rpDraw(root, ctx);
    }, function (e) {
      done();
      if (gen !== RP.gen) return;
      setHtml(root, "cpRpList", failedHtml(ctx, e));
      setHtml(root, "cpRpPager", "");
    });
  }

  /* A hand reply. The DCR server is asked first whether it can go at all
     (no channel for it, or a text in quiet hours — the desktop checks
     before it opens its box), so nothing typed is thrown away; a reply
     refused after the words were typed opens again with them, and the
     reason. */
  function rpReply(root, ctx, r, btn) {
    if (!r || !canAct(ctx)) return Promise.resolve();
    var gen = RP.gen;
    var first = ctx.has && ctx.has("replies.check")
      ? press(ctx, btn, function () { return ctx.rpc("replies.check", { sid: r.sid }, { text: "Checking…", quiet: true }); }, "Checking…")
      : Promise.resolve(null);
    return first.then(function (chk) {
      if (gen !== RP.gen) return;
      var kind = chk && chk.kind ? String(chk.kind) : r.channel;
      var head = chk && chk.words ? String(chk.words) : "To " + (r.person || r.from) + ":";
      return ask(kind, head, RP.drafts[r.sid] || "", "");
    }, function (e) {
      if (gen !== RP.gen) return;
      say(root, "cpRpMsg", errWords(e), "bad");
    });

    function ask(kind, head, typed, why) {
      return Promise.resolve(ctx.modal({
        title: kind === "email" ? "Send an email" : kind === "wadesktop" ? "Send a WhatsApp message" : "Send a text",
        message: head + (why ? "\n\nNot sent: " + why : ""),
        fields: [{ name: "text", type: "textarea", rows: 5, placeholder: "Type the message", value: typed }],
        okText: "Next",
        validate: function (v) {
          var s = String(v.text || "").trim();
          if (!s) return "There is nothing to send.";
          if (s.length > REPLY_MAX) return "At most " + REPLY_MAX + " characters — this is " + s.length + ".";
          return "";
        },
      })).then(function (v) {
        if (!v || gen !== RP.gen) return;
        var words = String(v.text || "").trim();
        RP.drafts[r.sid] = words;
        return press(ctx, btn, function () {
          return ctx.act("replies.reply", { sid: r.sid, text: words }, { text: "Sending…", quiet: true }).then(function (d) {
            if (gen !== RP.gen || !d) return;
            delete RP.drafts[r.sid];
            say(root, "cpRpMsg", d.words || "Sent.", "ok");
            return rpLoad(root, ctx);
          }, function (e) {
            if (gen !== RP.gen) return;
            say(root, "cpRpMsg", errWords(e), "bad");
            if (e && (e.code === "refused" || e.code === "bad_args")) return { again: errWords(e) };
          });
        }, "Sending…").then(function (res) {
          if (res && res.again && gen === RP.gen) return ask(kind, head, words, res.again);
        });
      });
    }
  }

  /* "This is…": pick the person a WhatsApp name belongs to (people with a
     phone only — the answer goes back to it on WhatsApp), the server's
     likely one first. The DCR server asks its own question before anything
     is saved, then keeps the name and handles the last day's messages. */
  function rpThisIs(root, ctx, r, btn) {
    if (!r || !canAct(ctx)) return Promise.resolve();
    var gen = RP.gen;
    var people = PP.data && PP.data.rows ? Promise.resolve(PP.data) :
      press(ctx, btn, function () { return ctx.rpc("people.list", {}, { text: "Loading the people…", quiet: true }); }, "Loading…");
    return people.then(function (d) {
      if (gen !== RP.gen) return;
      if (d && d.rows && !PP.data) PP.data = d;
      var options = [{ value: "", label: "— pick a person —" }].concat(((d && d.rows) || []).filter(function (p) {
        return p && (p.phone_override || p.phone);
      }).map(function (p) { return { value: p.name, label: p.name + " — " + (p.phone_override || p.phone) }; }));
      return Promise.resolve(ctx.modal({
        title: "This is…",
        message: "A WhatsApp message came from “" + r.from + "”, a name nobody on the People list is known by — it is how the person " +
          "is saved in the company phone's contacts.\n\nThey wrote: " + String(r.body || "(no words)").slice(0, 200) + "\n\nWho is it?",
        fields: [{ name: "name", type: "select", label: "This is", options: options, value: r.suggest || "" }],
        okText: "Next",
        validate: function (v) { return String(v.name || "") ? "" : "Pick the person first."; },
      })).then(function (v) {
        if (!v || gen !== RP.gen || !v.name) return;
        return press(ctx, btn, function () {
          return ctx.act("replies.this_is", { sid: r.sid, name: String(v.name) }, { text: "Saving and handling…", quiet: true }).then(function (res) {
            if (gen !== RP.gen || !res) return;
            say(root, "cpRpMsg", res.words || "Saved.", "ok");
            PP.data = null;                    // the WhatsApp name changed
            return rpLoad(root, ctx);
          }, function (e) {
            if (gen !== RP.gen) return;
            say(root, "cpRpMsg", errWords(e), "bad");
          });
        }, "Saving…");
      });
    }, function (e) {
      if (gen !== RP.gen) return;
      say(root, "cpRpMsg", errWords(e), "bad");
    });
  }

  function rpTeach(root, ctx, r, btn) {
    if (!r || !canAct(ctx)) return Promise.resolve();
    var gen = RP.gen;
    return Promise.resolve(ctx.modal({
      title: "Teach the agents what this meant",
      message: "Claude reads the crew's replies with these examples in mind (Settings → Claude AI). Trim the words to the part that matters.",
      fields: [
        { name: "said", type: "textarea", rows: 3, label: "Someone wrote", value: String(r.body || "") },
        { name: "meant", type: "text", label: "It means", placeholder: "e.g. 8 hours on job A081 today, framing" },
      ],
      okText: "Teach",
      validate: function (v) {
        var said = String(v.said || "").trim();
        var meant = String(v.meant || "").trim();
        if (!said) return "Write what they wrote — trimmed to the part that matters.";
        if (said.length > SAID_MAX) return "The example's words can be at most " + SAID_MAX + " characters.";
        if (!meant) return "Write what it means.";
        if (meant.length > MEANT_MAX) return "What it meant can be at most " + MEANT_MAX + " characters.";
        return "";
      },
    })).then(function (v) {
      if (!v || gen !== RP.gen) return;
      return press(ctx, btn, function () {
        return ctx.rpc("replies.teach", { sid: r.sid, said: String(v.said || "").trim(), meant: String(v.meant || "").trim() },
          { text: "Teaching…", quiet: true }).then(function (d) {
          if (gen !== RP.gen) return;
          say(root, "cpRpMsg", (d && d.words) || "Taught.", "ok");
        }, function (e) {
          if (gen !== RP.gen) return;
          say(root, "cpRpMsg", "Not saved: " + errWords(e), "bad");
        });
      }, "Teaching…");
    });
  }

  function rpPoll(root, ctx, btn) {
    if (!canAct(ctx)) return Promise.resolve();
    var gen = RP.gen;
    return press(ctx, btn, function () {
      return ctx.rpc("replies.poll", {}, { text: "Checking every way a reply can arrive…", quiet: true }).then(function (d) {
        if (gen !== RP.gen) return;
        say(root, "cpRpMsg", (d && d.words) || "Done.", "ok");
        RP.offset = 0;
        return rpLoad(root, ctx);
      }, function (e) {
        if (gen !== RP.gen) return;
        say(root, "cpRpMsg", errWords(e), "bad");
      });
    }, "Checking…");
  }

  function renderReplies(el, ctx) {
    style();
    RP.gen++;
    el.innerHTML =
      '<div class="cp">' +
        '<div class="c-head"><div><h2>Replies</h2><p class="c-sub">What came back from the crew, and what happened with it.</p></div>' +
          '<div class="c-actions">' +
            '<button type="button" class="c-btn sm" data-cp="rp-poll" data-act' + m("replies.poll") + ">Poll now</button>" +
            '<button type="button" class="c-btn ghost sm" data-cp="rp-refresh">Refresh</button>' +
          "</div></div>" +
        '<div class="cp-msg" id="cpRpMsg" role="status"></div><div id="cpRpBusy"></div>' +
        '<div id="cpRpList"></div><div id="cpRpPager"></div>' +
      "</div>";
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-cp]") : null;
      if (!t || t.disabled) return;
      var act = t.getAttribute("data-cp");
      if (act === "rp-poll") rpPoll(el, ctx, t);
      else if (act === "rp-refresh") rpLoad(el, ctx);
      else if (act === "rp-reply") rpReply(el, ctx, rpRow(Number(t.getAttribute("data-i"))), t);
      else if (act === "rp-teach") rpTeach(el, ctx, rpRow(Number(t.getAttribute("data-i"))), t);
      else if (act === "rp-thisis") rpThisIs(el, ctx, rpRow(Number(t.getAttribute("data-i"))), t);
    });
    if (ctx.has && !ctx.has("replies.list")) {
      setHtml(el, "cpRpList", emptyHtml(ctx, UPDATE + "."));
      return Promise.resolve();
    }
    if (RP.data) rpDraw(el, ctx);
    return rpLoad(el, ctx);
  }

  /* ════════════════════════════════════════════════════════════════════════
     People
     ════════════════════════════════════════════════════════════════════════ */

  var PP = { data: null, q: "", gen: 0 };

  function fold(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }
  function ppFind(name) {
    var k = fold(name);
    return ((PP.data && PP.data.rows) || []).filter(function (r) { return fold(r.name) === k; })[0] || null;
  }

  /* The rows the find box lets through, in the PC's order. */
  function ppShown() {
    var rows = (PP.data && PP.data.rows) || [];
    var q = fold(PP.q);
    if (!q) return rows;
    return rows.filter(function (r) {
      return fold([r.name, r.role, r.phone, r.phone_override, r.email, r.email_override, r.wa_name].concat(r.flags || []).join(" ")).indexOf(q) >= 0;
    });
  }

  function ppFlags(ctx, r) {
    return (r.flags || []).map(function (f) {
      var tone = /opted out|muted|no phone|shared number/.test(f) ? "warn" : (/^away|^no contact/.test(f) ? "info" : "dim");
      return chip(ctx, f, tone);
    }).join(" ");
  }

  function ppListHtml(ctx, onRow) {
    var esc = ctx.esc;
    var rows = ppShown();
    var cols = [
      { key: "name", label: "Name", render: function (r) { return "<b>" + esc(r.name) + "</b>"; } },
      { key: "role", label: "Role" },
      { key: "phone", label: "Phone", render: function (r) {
        return esc(r.phone_override || r.phone) + (r.phone_override ? ' <span class="c-muted c-small">(override)</span>' : ""); } },
      { key: "email", label: "Email", render: function (r) {
        return esc(r.email_override || r.email) + (r.email_override ? ' <span class="c-muted c-small">(override)</span>' : ""); } },
      { key: "app", label: "App", render: function (r) { return r.app ? "yes" : ""; } },
      { key: "active", label: "Active", render: function (r) { return r.active ? "yes" : "no"; } },
      { key: "flags", label: "Flags", render: function (r) { return ppFlags(ctx, r); } },
    ];
    return table(ctx, { cols: cols, rows: rows, empty: PP.q.trim() ? "Nobody matches." : "Nobody on the list yet — Refresh from portal.", onRow: onRow }) +
      '<p class="cp-count">' + esc(rows.length + " of " + ((PP.data && PP.data.rows) || []).length + " people") + "</p>";
  }

  function ppLoad(root, ctx, then, busyId) {
    var gen = ++PP.gen;
    var done = working(ctx, find(root, busyId || "cpPpBusy"), "Loading the people…");
    return ctx.rpc("people.list", {}, { quiet: true }).then(function (d) {
      done();
      if (gen !== PP.gen) return;
      PP.data = d || { rows: [] };
      if (then) then();
    }, function (e) {
      done();
      if (gen !== PP.gen) return;
      setHtml(root, busyId === "cpPeBusy" ? "cpPeBody" : "cpPpList", failedHtml(ctx, e));
    });
  }

  function renderPeopleList(el, ctx) {
    var esc = ctx.esc;
    el.innerHTML =
      '<div class="cp">' +
        '<div class="c-head"><div><h2>People</h2><p class="c-sub" id="cpPpNote">Names, roles, phones and emails come from the portal.</p></div>' +
          '<div class="c-actions"><button type="button" class="c-btn sm" data-cp="pp-refresh" data-act' + m("people.refresh") +
            ">Refresh from portal</button></div></div>" +
        '<div class="cp-tools"><input type="search" id="cpPpQ" data-cp="pp-q" maxlength="80" placeholder="Find a person" aria-label="Find a person" value="' +
          esc(PP.q) + '"></div>' +
        '<div class="cp-msg" id="cpPpMsg" role="status"></div><div id="cpPpBusy"></div>' +
        '<div id="cpPpList"></div>' +
      "</div>";
    var openRow = function (r) { if (r) ctx.go("people/" + encodeURIComponent(r.name)); };
    function draw() {
      var note = find(el, "cpPpNote");
      if (note && PP.data && PP.data.note) note.textContent = PP.data.note;
      setHtml(el, "cpPpList", ppListHtml(ctx, openRow));
    }
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-cp]") : null;
      if (!t || t.disabled || t.getAttribute("data-cp") !== "pp-refresh" || !canAct(ctx)) return;
      var gen = PP.gen;
      press(ctx, t, function () {
        return ctx.rpc("people.refresh", {}, { text: "Refreshing from the portal…", quiet: true }).then(function (d) {
          if (gen !== PP.gen) return;
          say(el, "cpPpMsg", (d && d.words) || "Refreshed.", "ok");
          return ppLoad(el, ctx, draw);
        }, function (err) {
          if (gen !== PP.gen) return;
          say(el, "cpPpMsg", errWords(err), "bad");
        });
      }, "Refreshing…");
    });
    el.addEventListener("input", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || t.getAttribute("data-cp") !== "pp-q") return;
      PP.q = String(t.value || "");
      setHtml(el, "cpPpList", ppListHtml(ctx, openRow));
    });
    if (ctx.has && !ctx.has("people.list")) {
      setHtml(el, "cpPpList", emptyHtml(ctx, UPDATE + "."));
      return Promise.resolve();
    }
    if (PP.data) draw();
    return ppLoad(el, ctx, draw);
  }

  function renderPerson(el, ctx, name) {
    var esc = ctx.esc;
    el.innerHTML = '<div class="cp cp-page"><button type="button" class="c-btn link cp-back" data-cp="pp-back">← All people</button>' +
      '<div id="cpPeBusy"></div><div id="cpPeBody"></div><p class="cp-msg" id="cpPeMsg" role="status"></p></div>';

    function draw() {
      var r = ppFind(name);
      if (!r) {
        setHtml(el, "cpPeBody", '<div class="c-head"><div><h2>' + esc(name) + "</h2></div></div>" +
          emptyHtml(ctx, "That person is not on the list — Refresh from portal, or pick someone else."));
        return;
      }
      var prefs = (PP.data && PP.data.prefs) || [];
      var portal = [r.role, r.phone ? "phone " + r.phone : "no phone on the portal", r.email, r.active ? "" : "not active"].filter(Boolean).join(" · ");
      var training = "#/training/" + encodeURIComponent("employee:" + r.name);
      setHtml(el, "cpPeBody",
        '<div class="c-head"><div><h2>' + esc(r.name) + '</h2><p class="c-sub">' + esc(portal) + "</p>" +
          ((r.flags || []).length ? '<div class="cp-flags">' + ppFlags(ctx, r) + "</div>" : "") + "</div></div>" +
        '<div class="c-card cp-form">' +
          '<div class="c-field"><label for="cpPeP">Phone override</label>' +
            '<input type="tel" id="cpPeP" maxlength="' + PHONE_MAX + '" autocomplete="off" placeholder="+1805…" aria-describedby="cpPePHelp" value="' +
            esc(r.phone_override) + '"><p class="c-help" id="cpPePHelp">Used instead of the portal\'s number.</p></div>' +
          '<div class="c-field"><label for="cpPeE">Email override</label>' +
            '<input type="email" id="cpPeE" maxlength="' + EMAIL_MAX + '" autocomplete="off" aria-describedby="cpPeEHelp" value="' + esc(r.email_override) +
            '"><p class="c-help" id="cpPeEHelp">Used instead of the portal\'s email.</p></div>' +
          ("wa_name" in r ? '<div class="c-field"><label for="cpPeW">WhatsApp name</label>' +
            '<input type="text" id="cpPeW" maxlength="' + WA_NAME_MAX + '" autocomplete="off" aria-describedby="cpPeWHelp" value="' + esc(r.wa_name) +
            '"><p class="c-help" id="cpPeWHelp">How WhatsApp on the DCR server computer shows them — their contact name on the company phone. ' +
            "Messages under this name are theirs. Empty clears it.</p></div>" : "") +
          '<div class="c-field"><label for="cpPePref">Prefers</label><select id="cpPePref">' + prefs.map(function (p) {
            return '<option value="' + esc(p.key) + '"' + (String(p.key) === String(r.channel_pref || "") ? " selected" : "") + ">" + esc(p.label) + "</option>";
          }).join("") + "</select></div>" +
          '<label class="c-check"><input type="checkbox" id="cpPeMute"' + (r.muted ? " checked" : "") + "> Muted — no agent messages this person</label><br>" +
          '<label class="c-check"><input type="checkbox" id="cpPeAlways"' + (r.always_nudge ? " checked" : "") +
            "> Always nudge about timesheets, even after a break</label>" +
        "</div>" +
        '<div class="c-actions">' +
          '<button type="button" class="c-btn" id="cpPeSave" data-cp="pe-save" data-act' + m("people.save") + ">Save person</button>" +
          '<button type="button" class="c-btn ghost" data-cp="pe-test" data-act' + m("people.test_text") + ">Send a test text</button>" +
          '<a class="c-btn ghost" href="' + esc(training) + '"' + m("training.scope") +
            ' title="Time away, no-contact days, language and notes — on the Training tab">Teach the agents about this person…</a>' +
        "</div>");
    }

    function val(id, fallback) { var n = find(el, id); return n ? String(n.value == null ? "" : n.value) : fallback; }
    function ticked(id, fallback) { var n = find(el, id); return n ? !!n.checked : fallback; }

    /* Unsaved edits ask before the page is left, like the Agents, Settings
       and Training forms. */
    function dirty() {
      var r = ppFind(name);
      if (!r || !find(el, "cpPeP")) return false;
      return val("cpPeP", "").trim() !== String(r.phone_override || "") || val("cpPeE", "").trim() !== String(r.email_override || "") ||
        val("cpPePref", "") !== String(r.channel_pref || "") || ticked("cpPeMute", false) !== !!r.muted ||
        ticked("cpPeAlways", false) !== !!r.always_nudge || ("wa_name" in r && val("cpPeW", "").trim() !== String(r.wa_name || ""));
    }
    if (ctx.guard) ctx.guard(function () { return dirty() ? "Leave without saving your changes to this person?" : ""; });

    function save(btn) {
      var r = ppFind(name);
      if (!r || !canAct(ctx)) return Promise.resolve();
      var values = {
        name: r.name,
        phone_override: val("cpPeP", r.phone_override || "").trim(),
        email_override: val("cpPeE", r.email_override || "").trim(),
        channel_pref: val("cpPePref", r.channel_pref || ""),
        muted: ticked("cpPeMute", !!r.muted),
        always_nudge: ticked("cpPeAlways", !!r.always_nudge),
      };
      /* only to a server that knows it (its rows carry wa_name): an older one
         would refuse the key */
      if ("wa_name" in r) values.wa_name = val("cpPeW", r.wa_name || "").trim();
      /* what was on the screen when it opened: another admin's save in
         between answers "changed" instead of being overwritten */
      if (r.rev) values.rev = String(r.rev);
      if (values.phone_override.length > PHONE_MAX) { say(el, "cpPeMsg", "The phone override can be at most " + PHONE_MAX + " characters.", "bad"); return Promise.resolve(); }
      if (values.email_override.length > EMAIL_MAX) { say(el, "cpPeMsg", "The email override can be at most " + EMAIL_MAX + " characters.", "bad"); return Promise.resolve(); }
      if ((values.wa_name || "").length > WA_NAME_MAX) { say(el, "cpPeMsg", "A WhatsApp name can be at most " + WA_NAME_MAX + " characters.", "bad"); return Promise.resolve(); }
      var gen = PP.gen;
      return press(ctx, btn, function () {
        return ctx.rpc("people.save", values, { text: "Saving…", quiet: true }).then(function (d) {
          if (gen !== PP.gen) return;
          var words = (d && d.words) || "Saved.";
          return ppLoad(el, ctx, function () { draw(); say(el, "cpPeMsg", words, "ok"); }, "cpPeBusy");
        }, function (e) {
          if (gen !== PP.gen) return;
          say(el, "cpPeMsg", errWords(e) + (e && e.code === "changed" ? " (Your changes are still on this screen.)" : ""), "bad");
        });
      }, "Saving…");
    }

    function test(btn) {
      var r = ppFind(name);
      if (!r || !canAct(ctx)) return Promise.resolve();
      var gen = PP.gen;
      return press(ctx, btn, function () {
        return ctx.act("people.test_text", { name: r.name }, { text: "Sending the test…", quiet: true }).then(function (d) {
          if (gen !== PP.gen || !d) return;
          say(el, "cpPeMsg", d.words || "Sent.", "ok");
        }, function (e) {
          if (gen !== PP.gen) return;
          say(el, "cpPeMsg", errWords(e), "bad");
        });
      }, "Sending…");
    }

    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-cp]") : null;
      if (!t || t.disabled) return;
      var act = t.getAttribute("data-cp");
      if (act === "pp-back") ctx.go("people");
      else if (act === "pe-save") save(t);
      else if (act === "pe-test") test(t);
    });
    if (PP.data && ppFind(name)) { draw(); return Promise.resolve(); }
    return ppLoad(el, ctx, draw, "cpPeBusy");
  }

  function renderPeople(el, ctx) {
    style();
    PP.gen++;
    var parts = (ctx.route && ctx.route.parts) || [];
    if (parts[0]) return renderPerson(el, ctx, String(parts[0]));
    return renderPeopleList(el, ctx);
  }

  /* ── registration ────────────────────────────────────────────────────── */

  window.DCRConsolePeople = { when: when, stamp: stamp, csvText: csvText, csvField: csvField, _ac: AC, _rp: RP, _pp: PP };
  if (window.DCRConsole && typeof window.DCRConsole.register === "function") {
    window.DCRConsole.register({ id: "activity", title: "Activity", order: 80, render: renderActivity,
      leave: function () { AC.gen++; if (AC.timer) { clearTimeout(AC.timer); AC.timer = null; } } });
    window.DCRConsole.register({ id: "replies", title: "Replies", order: 90, render: renderReplies, leave: function () { RP.gen++; } });
    window.DCRConsole.register({ id: "people", title: "People", order: 100, render: renderPeople, leave: function () { PP.gen++; } });
  }
})();
