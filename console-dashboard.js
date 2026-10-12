/* DCR Agents console — the Dashboard tab (dashboard.status, dashboard.health,
   dashboard.approve, dashboard.pause).

   The desktop Dashboard, read from the DCR server: Needs you (with the
   first-run reviews' Show me / Mark these as already handled / Send them),
   today's numbers, the health rows, Coming up and Recent runs, and Pause /
   Resume everything. Every line is the server's own (dashboard.py), so the
   two screens say the same thing; the questions before an approve or a
   pause come from the server too (ctx.act). WhatsApp on the DCR server
   computer's outbox is shown read-only (dashboard.status → wadesktop): what
   waits for someone at the server to press Send in WhatsApp, numbers masked
   — it is sent from there, never from here. */
(function () {
  "use strict";
  var C = window.DCRConsole;
  if (!C) return;

  var LEVEL_TONE = { good: "good", warn: "warn", bad: "bad" };
  var HEALTH_STALE_MS = 10 * 60000;   // the desktop Dashboard checks the channels every 10 minutes
  var autoCheckedAt = 0;              // when this page last asked for a check by itself

  /* refresh: the minute's auto refresh keeps what is on the screen and
     swaps it only when the server's answer changed — no blank flash, and a
     "Check now" in progress is left alone. */
  C.register({ id: "dashboard", title: "Dashboard", order: 10, autoRefresh: 60, render: render, refresh: quietRefresh });

  function render(el, ctx) {
    el.innerHTML = '<div class="c-skel"></div><div class="c-skel"></div><div class="c-skel"></div>';
    return ctx.rpc("dashboard.status", {}, { quiet: true }).then(function (d) {
      draw(el, ctx, d || {});
    }, function (e) {
      el.innerHTML = '<div class="c-head"><h2>Dashboard</h2></div>' + ctx.ui.failed(e);
    });
  }

  function quietRefresh(el, ctx) {
    if (!el.__cdData || el.querySelector('[aria-busy="true"], .c-busy')) return null;   // a press in flight, or never drawn
    return ctx.rpc("dashboard.status", {}, { quiet: true }).then(function (d) {
      if (JSON.stringify(d || {}) !== el.__cdJson) draw(el, ctx, d || {});
    }, function () { /* the status bar says why; what is on the screen stays */ });
  }

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function needsHtml(ctx, needs) {
    var esc = ctx.esc;
    if (!needs.length) return ctx.ui.empty("Nothing. The robot is running and nobody is waiting on you.");
    return '<ul class="cd-needs">' + needs.map(function (n, i) {
      var tone = LEVEL_TONE[n && n.level] || "dim";
      var fr = n && n.firstrun;
      var buttons = "";
      if (fr && fr.agent_id) {
        buttons = '<div class="c-actions cd-fr">' +
          '<a class="c-btn ghost sm" href="#/agents/review/' + encodeURIComponent(fr.agent_id) + '" data-act data-method="dashboard.first_run">Show me</a>' +
          '<button type="button" class="c-btn ghost sm" data-do="approve" data-i="' + i + '" data-mark="1" data-act data-method="dashboard.approve">' +
          "Mark these as already handled, then start</button>" +
          '<button type="button" class="c-btn sm" data-do="approve" data-i="' + i + '" data-mark="0" data-act data-method="dashboard.approve">' +
          "Send them, and start</button></div>";
      }
      if (!buttons && n && Number(n.outbox) > 0) {
        buttons = '<div class="c-actions cd-fr"><button type="button" class="c-btn ghost sm" data-do="wa">Show the messages</button></div>';
      }
      return '<li class="cd-need ' + tone + '"><span class="cd-need-t">' + esc(n && n.text) + "</span>" + buttons + "</li>";
    }).join("") + "</ul>";
  }

  /* WhatsApp on the DCR server computer: the outbox, read-only. The server
     sends the oldest few (each cut short) with the numbers masked; Open in
     WhatsApp, Sent and Skip are at the server's keyboard only. */
  function waHtml(ctx, w) {
    if (!w) return "";
    var esc = ctx.esc, ui = ctx.ui;
    var n = num(w.waiting);
    var auto = w.mode === "automatic";
    var chips = (w.enabled ? ui.chip(w.mode_words || (auto ? "sent automatically" : "waits for someone to press Send"), auto ? "warn" : "good")
      : ui.chip("off", "dim")) + (w.read_ok === false || w.read_error ? " " + ui.chip("replies not read", "bad") : "");
    var lines = [];
    if (auto && n && w.state_words) lines.push(String(w.state_words));
    if (w.read_error) lines.push("Reading replies: " + w.read_error);
    else if (w.read_ok === false && w.read_words) lines.push("Reading replies: " + w.read_words);
    var list = n ? ui.table({
      cols: [
        { key: "created_at", label: "Waiting since", cls: "c-nowrap", render: function (r) { return esc(ui.when(r.created_at)); } },
        { key: "person", label: "Person", render: function (r) { return esc(r.person || "(not on the roster)"); } },
        { key: "phone_masked", label: "Number", cls: "c-nowrap" },
        { key: "agent", label: "Agent" },
        { key: "text", label: "Message", render: function (r) { return '<span class="cd-wa-text">' + esc(r.text) + "</span>"; } },
        { key: "status", label: "", render: function (r) { return r.opened ? ui.chip("opened in WhatsApp", "info") : ""; } },
      ],
      rows: w.items || [], empty: "",
    }) : ui.empty("Nothing is waiting in the WhatsApp outbox.");
    return '<div class="c-card" id="cdWa"><div class="c-head"><h3>WhatsApp outbox</h3><div class="cd-wa-chips">' + chips + "</div></div>" +
      '<p class="c-sub c-small">' + esc(n ? plural(n, "message") + " waiting" + (w.expire_hours ? " · dropped after " + num(w.expire_hours) + " h if nobody sends them" : "")
        : "WhatsApp on the DCR server computer") + "</p>" +
      lines.map(function (t) { return '<p class="cd-wa-line">' + esc(t) + "</p>"; }).join("") +
      list + (num(w.more) ? '<p class="c-muted c-small">… and ' + esc(plural(num(w.more), "more message")) + ".</p>" : "") +
      '<p class="c-muted c-small">' + esc(w.where || "") + "</p></div>";
  }

  function stat(label, value, bad) {
    return '<div class="c-stat' + (bad ? " bad" : "") + '"><div class="c-stat-l">' + DCR.esc(label) + '</div><div class="c-stat-n">' +
      DCR.esc(value) + "</div></div>";
  }

  /* A detail the server already starts with its own verdict ("PROBLEM — …")
     loses it beside the chip that says the same. */
  function bare(s) { return String(s === null || s === undefined ? "" : s).replace(/^(PROBLEM|OK)\s+—\s+/, ""); }

  function healthHtml(ctx, d) {
    var esc = ctx.esc, ui = ctx.ui;
    var h = d.health || {};
    var rows = (h.rows || []).map(function (r) {
      return [r.key, { html: ui.chip(r.ok ? "OK" : "PROBLEM", r.ok ? "good" : "bad") + " " + esc(bare(r.detail)) }];
    });
    var extras = (d.extras || []).map(function (r) {
      var chipped = r.key === "scheduled task" || !r.ok;
      return [r.key, { html: (chipped ? ui.chip(r.ok ? "OK" : "PROBLEM", r.ok ? "good" : "bad") + " " : "") +
        esc(chipped ? bare(r.detail) : r.detail) }];
    });
    var checked = h.checked_at ? "Channels checked " + ui.ago(h.checked_at) + "." : "The channels have not been checked since the DCR server started.";
    return '<div class="c-card" id="cdHealth"><div class="c-head"><h3>Health</h3>' +
      '<button type="button" class="c-btn ghost sm" id="cdCheck" data-act data-method="dashboard.health">Check now</button></div>' +
      '<p class="c-sub c-small" id="cdChecked">' + esc(checked) + "</p>" +
      (rows.length || extras.length ? ui.kv(rows.concat(extras)) : "") +
      '<div id="cdHealthBusy"></div></div>';
  }

  function draw(el, ctx, d) {
    var esc = ctx.esc, ui = ctx.ui;
    var cards = d.cards || {};
    var paused = !!d.paused;
    var lease = d.lease || {};
    var cons = d.console || {};
    var up = d.coming_up || [];
    var runs = d.recent_runs || [];
    var html =
      '<div class="c-head"><div><h2>Dashboard</h2><p class="c-sub">' +
        esc((d.host ? "DCR server " + d.host : "The DCR server") + (d.version ? " · DCR Agents " + d.version : "")) + "</p></div>" +
        '<div class="c-actions">' +
          '<button type="button" class="c-btn ' + (paused ? "" : "ghost ") + 'sm" id="cdPause" data-act data-method="dashboard.pause">' +
            (paused ? "Resume everything" : "Pause everything") + "</button>" +
          '<button type="button" class="c-btn ghost sm" id="cdRefresh">Refresh</button>' +
        "</div></div>" +
      (d.dry_run_all ? '<div class="c-banner info"><span>Dry run: the DCR server decides and records, and sends nothing.</span></div>' : "") +
      '<div class="c-card"><h3>Needs you</h3>' + needsHtml(ctx, d.needs || []) + "</div>" +
      waHtml(ctx, d.wadesktop) +
      '<div class="c-stats">' +
        stat("Sent today", num(cards.sent)) + stat("Failed today", num(cards.failed), num(cards.failed) > 0) +
        stat("Replies today", num(cards.replies)) + stat("Agents on", num(cards.agents_on) + " / " + num(cards.agents_total)) +
      "</div>" +
      healthHtml(ctx, d) +
      '<div class="c-card"><h3>Coming up</h3>' + ui.table({
        cols: [
          { key: "group", label: "Group" },
          { key: "name", label: "Agent", render: function (r) {
            return '<a href="#/agents/edit/' + encodeURIComponent(r.agent_id || "") + '">' + esc(r.name) + "</a>"; } },
          { key: "watches", label: "Watches" },
          { key: "on", label: "On", render: function (r) { return ui.chip(r.on ? "on" : "off", r.on ? "good" : "dim"); } },
          { key: "next", label: "Next run", cls: "c-nowrap", render: function (r) { return esc(ui.when(r.next)); } },
          { key: "last", label: "Last run", cls: "c-nowrap", render: function (r) { return esc(ui.when(r.last)); } },
        ],
        rows: up, empty: "No agents yet.",
      }) + "</div>" +
      '<div class="c-card"><h3>Recent runs</h3>' + ui.table({
        cols: [
          { key: "at", label: "When", cls: "c-nowrap", render: function (r) { return esc(ui.when(r.at)); } },
          { key: "agent", label: "Agent" },
          { key: "found", label: "Found", cls: "c-num" },
          { key: "sent", label: "Sent", cls: "c-num" },
          { key: "skipped", label: "Skipped", cls: "c-num" },
          { key: "failed", label: "Failed", cls: "c-num" },
          { key: "note", label: "Note" },
        ],
        rows: runs, empty: "No runs yet.",
      }) + "</div>" +
      '<p class="c-muted c-small">' + esc(
        (lease.host ? "The DCR server is " + lease.host + (lease.since ? " since " + ui.when(lease.since) : "") + (lease.by ? " (" + lease.by + ")" : "") + ". " : "") +
        (d.last_tick ? "Last tick " + ui.when(d.last_tick) + ". " : "") +
        /* workers_busy counts this very request too */
        (num(cons.workers_busy) > 1 ? plural(num(cons.workers_busy) - 1, "other remote action") + " running now." : "")) + "</p>";
    el.innerHTML = html;
    el.__cdData = d;
    el.__cdJson = JSON.stringify(d);
    wire(el, ctx);
    autoCheck(el, ctx, d);
  }

  /* On an unattended server nobody presses Check now: when the last check
     is older than ten minutes (or there is none), ask once in the
     background, quietly, and redraw when it answers. */
  function autoCheck(el, ctx, d) {
    var h = d.health || {};
    var at = h.checked_at ? Date.parse(h.checked_at) : NaN;
    var stale = !isFinite(at) || Date.now() - at > HEALTH_STALE_MS;
    if (!stale || Date.now() - autoCheckedAt < HEALTH_STALE_MS || !ctx.canAct() || !ctx.has("dashboard.health")) return;
    autoCheckedAt = Date.now();
    var line = el.querySelector ? el.querySelector("#cdChecked") : null;
    if (line) line.textContent = "Checking the channels…";
    ctx.rpc("dashboard.health", {}, { quiet: true }).then(function () {
      return quietRefresh(el, ctx);
    }, function () {
      if (line && line.parentNode) line.textContent = "The channels could not be checked just now — press Check now to try again.";
    });
  }

  function plural(n, w) { n = num(n); return n + " " + (n === 1 ? w : w + "s"); }

  /* Once per element: a quiet redraw keeps the same element, and the
     handler reads the answer drawn last. */
  function wire(el, ctx) {
    if (el.__cdWired) return;
    el.__cdWired = true;
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("button") : null;
      var d = el.__cdData || {};
      if (!t || t.disabled) return;
      if (t.id === "cdRefresh") { ctx.refresh(); return; }
      if (t.id === "cdPause") { pause(ctx, t, !d.paused); return; }
      if (t.id === "cdCheck") { checkHealth(el, ctx, t); return; }
      if (t.getAttribute("data-do") === "wa") {
        var card = el.querySelector ? el.querySelector("#cdWa") : null;
        if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (t.getAttribute("data-do") === "approve") {
        var n = (d.needs || [])[Number(t.getAttribute("data-i"))];
        if (n && n.firstrun) approve(ctx, t, n.firstrun.agent_id, t.getAttribute("data-mark") === "1");
      }
    });
  }

  function pause(ctx, btn, paused) {
    return ctx.press(btn, function () {
      return ctx.act("dashboard.pause", { paused: paused }).then(function (r) {
        if (!r) return;
        ctx.notePaused(!!r.paused);
        ctx.toast(r.paused ? "Everything is paused on the DCR server." : "Resumed — the agents and the assistants run again.");
        ctx.refresh();
      }, function () { /* the toast said why */ });
    });
  }

  function approve(ctx, btn, agentId, mark) {
    return ctx.press(btn, function () {
      return ctx.act("dashboard.approve", { agent_id: agentId, mark_handled: mark }).then(function (r) {
        if (!r) return;
        ctx.toast(r.words || "Started.");
        ctx.refresh();
      }, function () { /* the toast said why */ });
    });
  }

  function checkHealth(el, ctx, btn) {
    var slot = document.getElementById("cdHealthBusy");
    var done = ctx.busy(slot, "Asking the portal and every channel…");
    return ctx.press(btn, function () {
      return ctx.rpc("dashboard.health", {}).then(function (h) {
        done();
        ctx.refresh();
        return h;
      }, function () { done(); });
    });
  }

  if (window.__DCR_CONSOLE_TEST__) C._dashboard = { needsHtml: needsHtml, healthHtml: healthHtml, waHtml: waHtml };
})();
