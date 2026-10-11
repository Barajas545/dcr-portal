/* DCR Agents console — the Agents tab (agents.*, and the first-run review
   through dashboard.first_run / dashboard.approve).

   The desktop Agents tab from the web:
   - #/agents                 the agents grouped like the desktop tree: what
                              they watch, then whom they are for, then the
                              agents in day order; on/off per agent and per
                              group, New / Duplicate / Delete / Run now.
   - #/agents/edit/<id>       the full editor (the desktop's four tabs: What
   - #/agents/new/<feed>      and when, Who and how, The message, Rules), with
                              the server's problems shown as you type (agents.
                              check, debounced) and Preview — who would get
                              this now, with the words. Nothing is sent by a
                              Preview.
   - #/agents/review/<id>     a first run waiting for review: who would get
                              what, then Mark these as already handled / Send
                              them.
   The DCR server checks every field again (agent_form.normalize_agent and
   agent_problems — the desktop editor's own code) and says what is wrong in
   its words; a save carries the `rev` it was opened at, so two admins never
   overwrite each other silently. Every question (delete, run now, turn a
   group on or off, start a first run) is the server's, through ctx.act. */
(function () {
  "use strict";
  var C = window.DCRConsole;
  if (!C) return;

  var COLLAPSE_KEY = "dcr.agentsConsole.collapsed.v1";
  /* The check runs once the form has been still for two seconds, and at
     most every five: each one is a request on the admin's allowance. */
  var CHECK_DEBOUNCE_MS = 2000, CHECK_GAP_MS = 5000;
  var HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  var KIND_WORDS = [["daily", "Once a day, at a time (runs late if the PC was asleep, up to the window end)"],
    ["interval", "Every N minutes, between two times"]];
  var FALLBACK_CHANNELS = [{ kind: "app", label: "DCR app on the phone" }, { kind: "sms", label: "Text message (SMS)" },
    { kind: "whatsapp", label: "WhatsApp" }, { kind: "email", label: "Email" }];
  var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  /* The schema the DCR server holds the agent to (console-spec §6.1.3);
     checked here first only so a typo gets a plain sentence, not bad_args. */
  var LIMITS = { name: 80, subject: 200, body: 4000, sms: 1600, sid: 40, varLen: 40, vars: 10, person: 80, people: 50, escalate: 120 };

  var feedChoices = null;     // [{feed, label}] from agents.list
  var S = null;               // the open editor

  C.register({ id: "agents", title: "Agents", order: 20, render: render, leave: leave });

  function $(id) { return document.getElementById(id); }
  function esc(v) { return DCR.esc(v); }
  function text(v) { return v === null || v === undefined ? "" : String(v); }

  function render(el, ctx) {
    var r = ctx.route, p = r.parts || [];
    if (p[0] === "edit" && p[1]) return editor(el, ctx, { agent_id: p[1] });
    if (p[0] === "new" && p[1]) {
      var inc = text(r.query && r.query.include).split("|").map(function (s) { return s.trim(); }).filter(Boolean);
      return editor(el, ctx, { feed: p[1], include: inc });
    }
    if (p[0] === "review" && p[1]) return review(el, ctx, p[1]);
    return list(el, ctx);
  }

  function leave() {
    if (S && S.timer) clearTimeout(S.timer);
    S = null;
  }

  function plural(n, w) { n = Number(n) || 0; return n + " " + (n === 1 ? w : w + "s"); }
  function suffix(n, on) { return " — " + plural(n, "agent") + ", " + (Number(on) || 0) + " on"; }

  /* ── the list ───────────────────────────────────────────────────────── */

  function collapsed() {
    try { var v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]"); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function setCollapsed(key, shut) {
    try {
      var v = collapsed().filter(function (k) { return k !== key; });
      if (shut) v.push(key);
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(v.slice(-200)));
    } catch (e) { /* a private window: every group opens again next time */ }
  }

  function list(el, ctx) {
    el.innerHTML = '<div class="c-head"><h2>Agents</h2></div><div class="c-skel"></div><div class="c-skel"></div>';
    return ctx.rpc("agents.list", {}, { quiet: true }).then(function (d) {
      if (d && Array.isArray(d.feed_choices)) feedChoices = d.feed_choices;
      drawList(el, ctx, d || {});
    }, function (e) {
      el.innerHTML = '<div class="c-head"><h2>Agents</h2></div>' + ctx.ui.failed(e);
    });
  }

  function agentRow(ctx, a) {
    var ui = ctx.ui;
    var notes = (a.notes || []).map(function (n) {
      var tone = n === "review waiting on the Dashboard" ? "bad" : n === "first run pending review" ? "warn" : "dim";
      return ui.chip(n, tone);
    }).join(" ");
    var chans = (a.channels || []).map(function (c) { return ui.chip(c, "info"); }).join(" ");
    var id = esc(a.id);
    return '<div class="ca-agent' + (a.on ? " on" : "") + '" id="ca-a-' + id + '">' +
      '<div class="ca-a1">' +
        '<label class="ca-switch" title="' + (a.on ? "On — click to turn it off" : "Off — click to turn it on") + '">' +
          '<input type="checkbox" data-do="toggle" data-id="' + id + '"' + (a.on ? " checked" : "") +
          ' data-act data-method="agents.toggle" aria-label="' + esc((a.on ? "Turn off " : "Turn on ") + text(a.name)) + '">' +
          '<span class="ca-sw-word">' + (a.on ? "on" : "off") + "</span></label>" +
        '<a class="ca-aname" href="#/agents/edit/' + encodeURIComponent(a.id) + '">' + esc(a.name || "(no name)") + "</a>" +
        (notes ? '<span class="ca-notes">' + notes + "</span>" : "") +
      "</div>" +
      '<div class="ca-meta">' + esc(a.when) + (chans ? " · " + chans : "") + "</div>" +
      '<div class="ca-meta">' +
        "Last run: " + esc(a.last ? ui.when(a.last) : "never") + " · Next run: " +
        '<span class="' + (a.next_today ? "ca-today" : "") + '">' + esc(a.next ? ui.when(a.next) : a.on ? "none in the next 8 days" : "off") + "</span>" +
      "</div>" +
      '<div class="c-actions ca-tools">' +
        '<a class="c-btn ghost sm" href="#/agents/edit/' + encodeURIComponent(a.id) + '">Edit</a>' +
        (a.waiting ? '<a class="c-btn sm" href="#/agents/review/' + encodeURIComponent(a.id) + '" data-act data-method="dashboard.first_run">Review the first run</a>' : "") +
        '<button type="button" class="c-btn ghost sm" data-do="run" data-id="' + id + '" data-act data-method="agents.run_now">Run now</button>' +
        '<button type="button" class="c-btn ghost sm" data-do="dup" data-id="' + id + '" data-act data-method="agents.duplicate">Duplicate</button>' +
        '<button type="button" class="c-btn ghost danger sm" data-do="del" data-id="' + id + '" data-act data-method="agents.delete">Delete</button>' +
      "</div></div>";
  }

  function drawList(el, ctx, d) {
    var feeds = d.feeds || [];
    var shut = collapsed();
    var groups = [];          // the rows a group button acts on
    var total = 0, on = 0;
    feeds.forEach(function (f) { total += Number(f.n) || 0; on += Number(f.on) || 0; });
    function group(label, agents, feed, include) {
      var ids = agents.map(function (a) { return a.id; });
      groups.push({ label: label, ids: ids, turnOn: agents.some(function (a) { return !a.on; }), feed: feed, include: include || [] });
      return groups.length - 1;
    }
    var html = '<div class="c-head"><div><h2>Agents</h2><p class="c-sub">' +
        esc(plural(total, "agent") + ", " + on + " on — grouped by what they watch, then whom they are for.") + "</p></div>" +
        '<div class="c-actions"><button type="button" class="c-btn sm" id="caNew" data-act data-method="agents.new">New agent</button>' +
        '<button type="button" class="c-btn ghost sm" id="caRefresh">Refresh</button></div></div>' +
      '<div id="caMsg" class="ca-msg" role="status" aria-live="polite"></div>';
    if (!feeds.length) html += ctx.ui.empty("No agents yet — New agent makes the first one.");
    html += feeds.map(function (f) {
      var all = [];
      (f.people || []).forEach(function (p) { all = all.concat(p.agents || []); });
      var gi = group(f.label, all, f.feed, []);
      var key = "feed:" + f.feed;
      return '<details class="ca-feed" data-key="' + esc(key) + '"' + (shut.indexOf(key) >= 0 ? "" : " open") + ">" +
        '<summary class="ca-gh"><span class="ca-feedname">' + esc(f.label) + '</span><span class="ca-suffix">' + esc(suffix(f.n, f.on)) + "</span></summary>" +
        '<div class="ca-gbody"><div class="c-actions ca-gtools">' + groupButtons(gi, groups[gi], "New agent here") + "</div>" +
        (f.people || []).map(function (p) {
          var pi = group(p.label, p.agents || [], f.feed, p.include || []);
          var pkey = "person:" + f.feed + ":" + text(p.key);
          /* Under a feed with one group only, the feed's own buttons already
             act on the same agents. */
          var tools = (f.people || []).length > 1
            ? '<div class="c-actions ca-gtools">' + groupButtons(pi, groups[pi], p.key ? "New for " + text(p.label) : "New agent for everyone") + "</div>" : "";
          return '<details class="ca-person" data-key="' + esc(pkey) + '"' + (shut.indexOf(pkey) >= 0 ? "" : " open") + ">" +
            '<summary class="ca-ph"><span class="ca-personname">' + esc(p.label) + '</span><span class="ca-suffix">' + esc(suffix(p.n, p.on)) + "</span></summary>" +
            '<div class="ca-pbody">' + tools +
            (p.agents || []).map(function (a) { return agentRow(ctx, a); }).join("") + "</div></details>";
        }).join("") + "</div></details>";
    }).join("");
    el.innerHTML = html;
    wireList(el, ctx, groups, d);
  }

  function groupButtons(i, g, newWords) {
    return '<button type="button" class="c-btn ghost sm" data-do="gtoggle" data-g="' + i + '" data-act data-method="agents.toggle">' +
      (g.turnOn ? "Turn all on" : "Turn all off") + "</button>" +
      '<button type="button" class="c-btn ghost sm" data-do="gnew" data-g="' + i + '" data-act data-method="agents.new">' + esc(newWords) + "</button>";
  }

  function say(words, bad) {
    var m = $("caMsg");
    if (!m) return;
    m.className = "ca-msg" + (words ? (bad ? " bad" : " good") : "");
    m.textContent = text(words);
  }

  function wireList(el, ctx, groups, d) {
    var boxes = el.querySelectorAll ? el.querySelectorAll("details[data-key]") : [];
    for (var i = 0; i < boxes.length; i++) {
      (function (box) {
        box.addEventListener("toggle", function () { setCollapsed(box.getAttribute("data-key"), !box.open); });
      })(boxes[i]);
    }
    el.addEventListener("change", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || t.getAttribute("data-do") !== "toggle") return;
      var want = !!t.checked;
      t.disabled = true;
      ctx.act("agents.toggle", { ids: [t.getAttribute("data-id")], on: want }).then(function (r) {
        if (!r) { t.checked = !want; t.disabled = false; return; }
        ctx.toast(r.words || "Done.");
        ctx.refresh();
      }, function () { t.checked = !want; t.disabled = false; });
    });
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!t || t.disabled) return;
      if (t.id === "caRefresh") { ctx.refresh(); return; }
      if (t.id === "caNew") { pickFeed(ctx, d.feed_choices || feedChoices || []); return; }
      var what = t.getAttribute("data-do"), id = t.getAttribute("data-id");
      if (what === "gtoggle") {
        var g = groups[Number(t.getAttribute("data-g"))];
        if (!g || !g.ids.length) return;
        ctx.press(t, function () {
          return ctx.act("agents.toggle", { ids: g.ids.slice(0, 100), on: g.turnOn, label: text(g.label).slice(0, 120) }).then(function (r) {
            if (!r) return;
            ctx.toast(r.words || "Done.");
            ctx.refresh();
          }, function () {});
        });
      } else if (what === "gnew") {
        var ng = groups[Number(t.getAttribute("data-g"))];
        if (ng) ctx.go("agents/new/" + encodeURIComponent(ng.feed) + (ng.include.length ? "?include=" + encodeURIComponent(ng.include.join("|")) : ""));
      } else if (what === "run" && id) {
        runNow(ctx, t, id);
      } else if (what === "dup" && id) {
        ctx.press(t, function () {
          return ctx.rpc("agents.duplicate", { agent_id: id }).then(function (r) {
            ctx.toast((r && r.words) || "Duplicated.");
            ctx.refresh();
          }, function () {});
        });
      } else if (what === "del" && id) {
        ctx.press(t, function () {
          return ctx.act("agents.delete", { agent_id: id }).then(function (r) {
            if (!r) return;
            ctx.toast(r.words || "Deleted.");
            ctx.refresh();
          }, function () {});
        });
      }
    });
  }

  function runNow(ctx, btn, id, after) {
    return ctx.press(btn, function () {
      return ctx.act("agents.run_now", { agent_id: id }, { text: "Running the agent…" }).then(function (r) {
        if (!r) return;
        say(r.summary || "Done.");
        ctx.toast(r.summary || "Done.");
        if (after) after(r);
      }, function (e) { say(e.message, true); });
    }, "Running…");
  }

  function pickFeed(ctx, choices) {
    if (!choices.length) { ctx.toast("Reload the list first.", { bad: true }); return; }
    return ctx.modal({
      title: "New agent", message: "What should it watch?", okText: "Next",
      fields: [{ name: "feed", type: "select", value: choices[0].feed,
        options: choices.map(function (c) { return { value: c.feed, label: c.label }; }) }],
    }).then(function (v) {
      if (v && v.feed) ctx.go("agents/new/" + encodeURIComponent(v.feed));
    });
  }

  /* ── the first-run review ───────────────────────────────────────────── */

  function review(el, ctx, aid) {
    el.innerHTML = '<div class="c-head"><h2>First run</h2></div><div class="c-skel"></div>';
    return ctx.rpc("dashboard.first_run", { agent_id: aid }, { quiet: true }).then(function (d) {
      drawReview(el, ctx, d || {}, aid);
    }, function (e) {
      el.innerHTML = '<p><a href="#/agents">‹ All agents</a></p><div class="c-head"><h2>First run</h2></div>' + ctx.ui.failed(e, { retry: e.code !== "not_found" });
    });
  }

  function rowsTable(ctx, headers, rows, empty) {
    var cols = (headers || []).map(function (h, i) {
      return { key: String(i), label: h, render: function (r) { return esc(r[i]); } };
    });
    return ctx.ui.table({ cols: cols, rows: rows || [], empty: empty });
  }

  function drawReview(el, ctx, d, aid) {
    var a = d.agent || { id: aid, name: aid };
    el.innerHTML = '<p class="ca-back"><a href="#/agents">‹ All agents</a></p>' +
      '<div class="c-head"><div><h2>' + esc("First run of '" + text(a.name) + "'") + '</h2><p class="c-sub">' +
        esc(plural(d.found, "item") + " found, " + (Number(d.would_send) || 0) + " would be sent. Nothing has gone yet — " +
          "review the list, then start the agent.") + "</p></div></div>" +
      '<div class="c-card">' + rowsTable(ctx, d.headers, d.rows, "Nobody would get anything.") + "</div>" +
      '<div class="c-actions">' +
        '<button type="button" class="c-btn ghost" id="caMark" data-act data-method="dashboard.approve">Mark these as already handled, then start</button>' +
        '<button type="button" class="c-btn" id="caSend" data-act data-method="dashboard.approve">Send them, and start</button>' +
        '<a class="c-btn ghost" href="#/agents/edit/' + encodeURIComponent(a.id) + '">Edit the agent</a>' +
      "</div>";
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!t || t.disabled || (t.id !== "caMark" && t.id !== "caSend")) return;
      ctx.press(t, function () {
        return ctx.act("dashboard.approve", { agent_id: a.id, mark_handled: t.id === "caMark" }).then(function (r) {
          if (!r) return;
          ctx.toast(r.words || "Started.");
          ctx.go("agents");
        }, function () {});
      });
    });
  }

  /* ── the editor ─────────────────────────────────────────────────────── */

  function editor(el, ctx, want) {
    el.innerHTML = '<p class="ca-back"><a href="#/agents">‹ All agents</a></p><div class="c-head"><h2>' +
      (want.agent_id ? "Edit agent" : "New agent") + '</h2></div><div class="c-skel"></div><div class="c-skel"></div>';
    var load = want.agent_id ? ctx.rpc("agents.get", { agent_id: want.agent_id }, { quiet: true })
      : ctx.rpc("agents.new", { feed: want.feed, include: want.include || [] }, { quiet: true });
    var choices = feedChoices ? Promise.resolve(feedChoices)
      : ctx.rpc("agents.list", {}, { quiet: true }).then(function (d) {
        if (d && Array.isArray(d.feed_choices)) feedChoices = d.feed_choices;
        return feedChoices;
      }, function () { return null; });
    return Promise.all([load, choices]).then(function (res) {
      drawEditor(el, ctx, res[0] || {}, !want.agent_id);
    }, function (e) {
      el.innerHTML = '<p class="ca-back"><a href="#/agents">‹ All agents</a></p><div class="c-head"><h2>' +
        (want.agent_id ? "Edit agent" : "New agent") + "</h2></div>" + ctx.ui.failed(e, { retry: e.code !== "not_found" });
    });
  }

  function timeInput(id, v, label) {
    return '<input type="time" id="' + id + '" value="' + esc(HHMM.test(text(v)) ? v : "") + '" aria-label="' + esc(label) + '">';
  }
  function numInput(id, v, lo, hi, step, label) {
    return '<input type="number" inputmode="decimal" id="' + id + '" value="' + esc(v === null || v === undefined ? "" : v) + '"' +
      (lo !== null && lo !== undefined ? ' min="' + esc(lo) + '"' : "") + (hi !== null && hi !== undefined ? ' max="' + esc(hi) + '"' : "") +
      (step ? ' step="' + esc(step) + '"' : "") + (label ? ' aria-label="' + esc(label) + '"' : "") + ">";
  }
  function field(label, control, help, forId) {
    return '<div class="c-field">' + (label ? '<label class="c-label"' + (forId ? ' for="' + forId + '"' : "") + ">" + esc(label) + "</label>" : "") +
      control + (help ? '<div class="c-help">' + help + "</div>" : "") + "</div>";
  }
  function check(id, on, words, disabled) {
    return '<div class="c-field"><label class="c-check"><input type="checkbox" id="' + id + '"' + (on ? " checked" : "") + (disabled ? " disabled" : "") +
      "> " + esc(words) + "</label></div>";
  }
  function daysOf(v) {
    if (v === "weekdays" || v === undefined || v === null) return [0, 1, 2, 3, 4];
    if (v === "everyday") return [0, 1, 2, 3, 4, 5, 6];
    return Array.isArray(v) ? v.map(Number) : [];
  }

  function paramsHtml(form, values) {
    var specs = form.params || [];
    if (!specs.length) return "";
    return '<fieldset class="ca-fs"><legend>Feed settings</legend>' + specs.map(function (s) {
      var v = values && Object.prototype.hasOwnProperty.call(values, s.name) ? values[s.name] : s.default;
      var id = "ae-p-" + s.name;
      if (s.kind === "int") {
        return field(s.label, '<div class="c-inline">' + numInput(id, v, s.lo, s.hi, 1, s.label) +
          (s.suffix ? "<span>" + esc(text(s.suffix).trim()) + "</span>" : "") + "</div>", "", id);
      }
      return field(s.label, '<input type="text" id="' + id + '" maxlength="80" value="' + esc(v) + '"' +
        (s.placeholder ? ' placeholder="' + esc(s.placeholder) + '"' : "") + ">", "", id);
    }).join("") + "</fieldset>";
  }

  function varsHtml(form) {
    var vars = (form.vars || []).concat(form.global_vars || []);
    return '<div class="ca-vars" role="group" aria-label="Insert a placeholder"><span class="c-muted c-small">Insert:</span> ' +
      vars.map(function (v) {
        return '<button type="button" class="ca-var" data-do="insert" data-var="' + esc(v) + '">' + esc(v) + "</button>";
      }).join("") + "</div>";
  }

  function smartNote(form) { return text(form.smart && form.smart.note); }

  function channelRows(S) {
    return S.channels.map(function (c, i) {
      return '<li class="ca-ch">' +
        '<label class="c-check"><input type="checkbox" id="ae-ch-' + esc(c.kind) + '"' + (c.on ? " checked" : "") + "> " + esc(c.label) + "</label>" +
        '<span class="ca-ch-move">' +
          '<button type="button" class="c-btn ghost sm" data-do="chup" data-i="' + i + '"' + (i === 0 ? " disabled" : "") +
            ' aria-label="' + esc("Try " + c.label + " earlier") + '">↑</button>' +
          '<button type="button" class="c-btn ghost sm" data-do="chdown" data-i="' + i + '"' + (i === S.channels.length - 1 ? " disabled" : "") +
            ' aria-label="' + esc("Try " + c.label + " later") + '">↓</button>' +
        "</span></li>";
    }).join("");
  }

  function drawEditor(el, ctx, d, isNew) {
    var a = d.agent || {};
    var form = d.form || {};
    var s = a.schedule || {};
    var aud = a.audience || {};
    var t = a.template || {};
    var r = a.rules || {};
    var kinds = form.channel_kinds && form.channel_kinds.length ? form.channel_kinds : FALLBACK_CHANNELS;
    var picked = (a.channels || []).filter(function (k) { return kinds.some(function (c) { return c.kind === k; }); });
    S = {
      agent: a, rev: text(d.rev), form: form, isNew: isNew, pane: "what", dirty: false, timer: null,
      lastChecked: "", checking: false, lastCheckAt: 0, focus: "ae-body",
      channels: picked.map(function (k) { return { kind: k, label: kinds.filter(function (c) { return c.kind === k; })[0].label, on: true }; })
        .concat(kinds.filter(function (c) { return picked.indexOf(c.kind) < 0; }).map(function (c) { return { kind: c.kind, label: c.label, on: false }; })),
    };
    var feeds = feedChoices && feedChoices.length ? feedChoices : [{ feed: a.feed, label: a.feed }];
    var days = daysOf(s.days);
    var roles = form.roles || [];
    var between = Array.isArray(s.between) && s.between.length === 2 ? s.between : ["08:00", "18:00"];
    var interval = s.kind === "interval";
    var offered = !!(form.smart && form.smart.offered);
    var mc = form.min_confidence || [];

    var html =
      '<p class="ca-back"><a href="#/agents" id="ae-back">‹ All agents</a></p>' +
      '<div class="c-head"><div><h2 id="ae-title">' + esc(isNew ? "New agent" : text(a.name) || "Edit agent") + "</h2>" +
        '<p class="c-sub">' + esc(isNew ? "Not saved yet — it starts off, with a first-run review." : "Agent " + text(a.id)) + "</p></div>" +
        (isNew ? "" : '<div class="c-actions">' +
          /* the desktop's "Train this agent…": the Training tab on this agent's rules */
          '<a class="c-btn ghost sm" id="ae-train" href="#/training/' + encodeURIComponent("agent:" + text(a.id)) + '" data-method="training.scope">Train this agent…</a>' +
          '<button type="button" class="c-btn ghost sm" id="ae-run" data-act data-method="agents.run_now">Run now</button>' +
          '<button type="button" class="c-btn ghost sm" id="ae-dup" data-act data-method="agents.duplicate">Duplicate</button>' +
          '<button type="button" class="c-btn ghost danger sm" id="ae-del" data-act data-method="agents.delete">Delete</button></div>') +
      "</div>" +
      '<div class="ca-panes" role="tablist" aria-label="Agent editor">' +
        [["what", "What and when"], ["who", "Who and how"], ["words", "The message"], ["rules", "Rules"]].map(function (p) {
          return '<button type="button" role="tab" id="ae-tab-' + p[0] + '" data-pane="' + p[0] + '" aria-selected="' + (p[0] === "what") + '">' + p[1] + "</button>";
        }).join("") +
      "</div>" +
      '<form class="c-card ca-form" id="ae-form" novalidate>' +
      /* What and when */
      '<section id="ae-pane-what" role="tabpanel" aria-labelledby="ae-tab-what">' +
        field("Name", '<input type="text" id="ae-name" maxlength="' + LIMITS.name + '" value="' + esc(a.name) + '">', "", "ae-name") +
        field("Watches", '<select id="ae-feed">' + feeds.map(function (f) {
          return '<option value="' + esc(f.feed) + '"' + (f.feed === a.feed ? " selected" : "") + ">" + esc(f.label) + "</option>";
        }).join("") + "</select>", '<span id="ae-feednote">' + esc(form.who) + "</span>", "ae-feed") +
        check("ae-enabled", !!a.enabled, "Enabled — runs on its schedule") +
        '<fieldset class="ca-fs"><legend>Schedule</legend>' +
          field("Kind", '<select id="ae-kind">' + KIND_WORDS.map(function (k) {
            return '<option value="' + k[0] + '"' + ((interval ? "interval" : "daily") === k[0] ? " selected" : "") + ">" + esc(k[1]) + "</option>";
          }).join("") + "</select>", "", "ae-kind") +
          '<div id="ae-daily"' + (interval ? " hidden" : "") + ">" + field("Daily at", '<div class="c-inline">' + timeInput("ae-at", s.at || "09:00", "Daily at") +
            "<span>no later than</span>" + timeInput("ae-until", s.until || "23:59", "No later than") + "</div>") + "</div>" +
          '<div id="ae-interval"' + (interval ? "" : " hidden") + ">" + field("Interval", '<div class="c-inline">' +
            numInput("ae-every", s.every_minutes || 30, 5, 720, 1, "Every (minutes)") + "<span>min between</span>" +
            timeInput("ae-b0", between[0], "Between") + "<span>and</span>" + timeInput("ae-b1", between[1], "And") + "</div>") + "</div>" +
          '<div class="c-field"><span class="c-label">Days</span><div class="c-days" role="group" aria-label="Days">' +
            DAY_NAMES.map(function (n, i) {
              return '<label><input type="checkbox" id="ae-d' + i + '"' + (days.indexOf(i) >= 0 ? " checked" : "") + "> " + n + "</label>";
            }).join("") + "</div></div>" +
        "</fieldset>" +
        '<div id="ae-params">' + paramsHtml(form, a.feed_params || {}) + "</div>" +
      "</section>" +
      /* Who and how */
      '<section id="ae-pane-who" role="tabpanel" aria-labelledby="ae-tab-who" hidden>' +
        '<div class="c-field"><span class="c-label">Roles (none = everyone the feed returns)</span><div class="c-days" role="group" aria-label="Roles">' +
          roles.map(function (role, i) {
            return '<label><input type="checkbox" id="ae-r-' + i + '"' + ((aud.roles || []).indexOf(role) >= 0 ? " checked" : "") + "> " + esc(role) + "</label>";
          }).join("") + "</div></div>" +
        field("Only these people", '<input type="text" id="ae-include" value="' + esc((aud.include || []).join(", ")) +
          '" placeholder="names, comma separated — only these">', "", "ae-include") +
        field("Never these people", '<input type="text" id="ae-exclude" value="' + esc((aud.exclude || []).join(", ")) +
          '" placeholder="names, comma separated — never these">', "", "ae-exclude") +
        '<fieldset class="ca-fs"><legend>Channels, in the order to try them</legend><ol class="ca-chs" id="ae-channels">' + channelRows(S) + "</ol>" +
          '<p class="c-help">' + esc(form.note_channels || "Tick the channels to use; the first one with an address on file is tried first.") +
          " On this screen, ↑ and ↓ change the order.</p></fieldset>" +
      "</section>" +
      /* The message */
      '<section id="ae-pane-words" role="tabpanel" aria-labelledby="ae-tab-words" hidden>' +
        '<div id="ae-vars">' + varsHtml(form) + "</div>" +
        field("Email subject", '<input type="text" id="ae-subject" maxlength="' + LIMITS.subject + '" value="' + esc(t.subject) + '">', "", "ae-subject") +
        field("Message (email, and texts when the text version below is empty)", '<textarea id="ae-body" rows="8" maxlength="' + LIMITS.body + '">' +
          esc(t.body) + "</textarea>", "", "ae-body") +
        field("Text version (SMS / WhatsApp) — short, plain characters; leave empty to use the message above",
          '<textarea id="ae-sms" rows="3" maxlength="' + LIMITS.sms + '">' + esc(t.sms) + "</textarea>",
          '<span id="ae-seg"></span>', "ae-sms") +
        '<fieldset class="ca-fs"><legend>WhatsApp template (for messages we start)</legend>' +
          field("Content SID", '<input type="text" id="ae-wasid" maxlength="' + LIMITS.sid + '" value="' + esc(t.whatsapp_content_sid) +
            '" placeholder="HX… — the approved Content Template SID from Twilio">', "", "ae-wasid") +
          field("Variables {{1}}, {{2}}…", '<input type="text" id="ae-wavars" value="' + esc((t.whatsapp_vars || []).join(", ")) +
            '" placeholder="variables in template order, comma separated, e.g. firstName, company">', "", "ae-wavars") +
        "</fieldset>" +
      "</section>" +
      /* Rules */
      '<section id="ae-pane-rules" role="tabpanel" aria-labelledby="ae-tab-rules" hidden>' +
        field("Repeat the same reminder after", '<div class="c-inline">' + numInput("ae-repeat", r.repeat_after_hours, 0, 1440, "0.5", "Repeat after (hours)") +
          "<span>h</span></div>", "0 = never repeat the same reminder") +
        field("At most, per fact", numInput("ae-maxrem", r.max_reminders, 1, 99, 1), "", "ae-maxrem") +
        field("Money: contact must be at least", '<select id="ae-minconf">' + mc.map(function (m) {
          return '<option value="' + esc(m.key) + '"' + (m.key === r.min_confidence ? " selected" : "") + ">" + esc(m.label) + "</option>";
        }).join("") + "</select>", "", "ae-minconf") +
        field("Escalate to", '<input type="text" id="ae-escto" maxlength="' + LIMITS.escalate + '" value="' + esc(r.escalate_to) +
          '" placeholder="email — told once when a person hits the maximum with no change">', "", "ae-escto") +
        field("…after this many reminders (0 = never)", numInput("ae-escafter", r.escalate_after, 0, 99, 1), "", "ae-escafter") +
        field("At most per run", numInput("ae-cap", r.max_per_run, 0, 1000, 1), "0 = no cap", "ae-cap") +
        check("ae-dry", !!r.dry_run, "Dry run — decide and record, send nothing") +
        check("ae-reviewed", !!r.first_run_reviewed, "First run reviewed (untick to make the next run a review again)") +
        '<div class="c-field"><span class="c-label">Smart wording</span>' +
          '<label class="c-check"><input type="checkbox" id="ae-smart"' + (offered && r.smart_wording ? " checked" : "") + (offered ? "" : " disabled") +
          "> Let Claude write each message using the training</label>" +
          '<div class="c-help" id="ae-smartnote">' + esc(smartNote(form)) + "</div></div>" +
      "</section>" +
      "</form>" +
      '<div id="ae-problems" class="ca-problems" role="alert" aria-live="polite"></div>' +
      '<div id="ae-preview"></div>' +
      '<div class="ca-bar">' +
        '<button type="button" class="c-btn ghost" id="ae-previewbtn" data-act data-method="agents.preview">Preview<span class="ca-long"> — who would get this now</span></button>' +
        '<span class="ca-bar-gap"></span>' +
        '<a class="c-btn ghost" href="#/agents" id="ae-cancel">Cancel</a>' +
        '<button type="button" class="c-btn" id="ae-save" data-act data-method="agents.save">Save</button>' +
      "</div>";
    el.innerHTML = html;
    var mine = S;
    ctx.guard(function () { return mine.dirty ? "Leave without saving your changes to this agent?" : ""; });
    wireEditor(el, ctx, mine);
    scheduleCheck(ctx, mine, true);
  }

  function showPane(S, name) {
    S.pane = name;
    ["what", "who", "words", "rules"].forEach(function (p) {
      var pane = $("ae-pane-" + p), tab = $("ae-tab-" + p);
      if (pane) pane.hidden = p !== name;
      if (tab) tab.setAttribute("aria-selected", String(p === name));
    });
  }

  /* The agent as the form holds it — the closed shape the DCR server takes
     (console-spec §6.1.3); unknown keys of the stored agent stay on the
     server (normalize_agent carries them over). */
  function collect(S) {
    var val = function (id) { var n = $(id); return n ? text(n.value) : ""; };
    var on = function (id) { var n = $(id); return !!(n && n.checked); };
    var num = function (id) { var v = val(id).trim(); return v === "" ? null : Number(v); };
    var names = function (id) { return val(id).split(",").map(function (x) { return x.trim(); }).filter(Boolean); };
    var form = S.form || {};
    var params = {};
    (form.params || []).forEach(function (p) {
      params[p.name] = p.kind === "int" ? num("ae-p-" + p.name) : val("ae-p-" + p.name).trim();
    });
    var days = [];
    for (var i = 0; i < 7; i++) if (on("ae-d" + i)) days.push(i);
    var offered = !!(form.smart && form.smart.offered);
    return {
      id: text(S.agent.id), name: val("ae-name").trim(), feed: val("ae-feed") || text(S.agent.feed), enabled: on("ae-enabled"),
      schedule: { kind: val("ae-kind") === "interval" ? "interval" : "daily", at: val("ae-at"), until: val("ae-until") || null,
        every_minutes: num("ae-every"), between: [val("ae-b0"), val("ae-b1")], days: days },
      audience: { roles: (form.roles || []).filter(function (r, j) { return on("ae-r-" + j); }), include: names("ae-include"), exclude: names("ae-exclude") },
      channels: S.channels.filter(function (c) { return on("ae-ch-" + c.kind); }).map(function (c) { return c.kind; }),
      template: { subject: val("ae-subject").trim(), body: val("ae-body"), sms: val("ae-sms"), whatsapp_content_sid: val("ae-wasid").trim(),
        whatsapp_vars: names("ae-wavars") },
      rules: { repeat_after_hours: num("ae-repeat"), max_reminders: num("ae-maxrem"), min_confidence: val("ae-minconf") || "likely",
        escalate_to: val("ae-escto").trim(), escalate_after: num("ae-escafter"), max_per_run: num("ae-cap"), dry_run: on("ae-dry"),
        first_run_reviewed: on("ae-reviewed"), smart_wording: offered && on("ae-smart") },
      feed_params: params,
    };
  }

  /* What the server's schema would refuse, said plainly and found here, so
     a slip never costs a round trip (the server checks it all again). */
  function localProblems(a, form) {
    var out = [];
    var whole = function (v, lo, hi) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v && v >= lo && v <= hi; };
    if (!a.name) out.push("Give the agent a name.");
    if (a.name.length > LIMITS.name) out.push("Keep the name under " + LIMITS.name + " characters.");
    if (a.schedule.kind === "daily") {
      if (!HHMM.test(a.schedule.at)) out.push("Pick the time it runs (Daily at).");
      if (!HHMM.test(text(a.schedule.until))) out.push("Pick the “no later than” time.");
    } else {
      if (!whole(a.schedule.every_minutes, 5, 720)) out.push("Every … minutes must be a whole number from 5 to 720.");
      if (!HHMM.test(a.schedule.between[0]) || !HHMM.test(a.schedule.between[1])) out.push("Pick both times of the interval.");
    }
    if (a.audience.include.length > LIMITS.people || a.audience.exclude.length > LIMITS.people) out.push("At most " + LIMITS.people + " names in each list.");
    if (a.audience.include.concat(a.audience.exclude).some(function (n) { return n.length > LIMITS.person; })) out.push("A name is longer than " + LIMITS.person + " characters.");
    if (a.template.whatsapp_vars.length > LIMITS.vars) out.push("At most " + LIMITS.vars + " WhatsApp variables.");
    if (a.template.whatsapp_vars.some(function (n) { return n.length > LIMITS.varLen; })) out.push("A WhatsApp variable is longer than " + LIMITS.varLen + " characters.");
    var rr = a.rules;
    if (!(typeof rr.repeat_after_hours === "number" && isFinite(rr.repeat_after_hours) && rr.repeat_after_hours >= 0 && rr.repeat_after_hours <= 1440)) {
      out.push("Repeat after must be 0 to 1440 hours.");
    }
    if (!whole(rr.max_reminders, 1, 99)) out.push("At most, per fact must be a whole number from 1 to 99.");
    if (!whole(rr.escalate_after, 0, 99)) out.push("Escalate after must be a whole number from 0 to 99.");
    if (!whole(rr.max_per_run, 0, 1000)) out.push("At most per run must be a whole number from 0 to 1000.");
    (form.params || []).forEach(function (p) {
      var v = a.feed_params[p.name];
      if (p.kind === "int" && !whole(v, Number(p.lo), Number(p.hi))) out.push(text(p.label) + " must be a whole number from " + p.lo + " to " + p.hi + ".");
    });
    return out;
  }

  /* The agent ready to send: the form's values, and the half of the schedule
     the chosen kind does not use kept valid (the server's closed schema
     takes every field; the desktop's widgets always hold a time). */
  function build(S) {
    var a = collect(S);
    var problems = localProblems(a, S.form);
    var sc = a.schedule, old = (S.agent && S.agent.schedule) || {};
    if (sc.kind === "interval") {
      if (!HHMM.test(sc.at)) sc.at = HHMM.test(text(old.at)) ? old.at : "09:00";
      if (sc.until !== null && !HHMM.test(sc.until)) sc.until = null;
    } else {
      if (!HHMM.test(sc.between[0]) || !HHMM.test(sc.between[1])) {
        sc.between = Array.isArray(old.between) && HHMM.test(text(old.between[0])) && HHMM.test(text(old.between[1])) ? old.between.slice(0, 2) : ["08:00", "18:00"];
      }
      if (!(typeof sc.every_minutes === "number" && sc.every_minutes >= 5 && sc.every_minutes <= 720 && Math.floor(sc.every_minutes) === sc.every_minutes)) {
        sc.every_minutes = Number(old.every_minutes) >= 5 ? Number(old.every_minutes) : 30;
      }
    }
    return { agent: a, problems: problems, key: JSON.stringify(a) };
  }

  function showProblems(list, tone) {
    var box = $("ae-problems");
    if (!box) return;
    if (!list || !list.length) { box.className = "ca-problems"; box.innerHTML = ""; return; }
    box.className = "ca-problems " + (tone || "warn");
    box.innerHTML = (list.length === 1 ? "<span>" + esc(list[0]) + "</span>"
      : "<ul>" + list.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul>");
  }
  function splitProblems(message) {
    var m = text(message).replace(/^(Not saved|Fix first):\s*/, "");
    return m.split(/;\s+/).filter(Boolean);
  }

  function scheduleCheck(ctx, S, now) {
    if (S.timer) clearTimeout(S.timer);
    S.timer = setTimeout(function () { runCheck(ctx, S); }, now ? 50 : CHECK_DEBOUNCE_MS);
  }
  function runCheck(ctx, S) {
    if (S !== currentS() || S.checking) return;
    var b = build(S), a = b.agent, key = b.key;
    if (b.problems.length) { showProblems(b.problems); S.lastChecked = ""; return; }
    if (key === S.lastChecked || !ctx.canAct() || !ctx.has("agents.check")) return;
    var wait = S.lastCheckAt + CHECK_GAP_MS - Date.now();
    if (wait > 0) { S.timer = setTimeout(function () { runCheck(ctx, S); }, wait); return; }
    S.checking = true;
    S.lastCheckAt = Date.now();
    ctx.rpc("agents.check", { agent: a }, { quiet: true }).then(function (r) {
      S.checking = false;
      if (S !== currentS()) return;
      S.lastChecked = key;
      /* a refusal from Save or Preview stays until the next edit */
      if (!S.sticky) showProblems((r && r.problems) || []);
      var seg = $("ae-seg");
      if (seg) {
        seg.className = r && r.segments && r.segments.warn ? "ca-seg warn" : "ca-seg";
        seg.textContent = text(r && r.segments && r.segments.text);
      }
      if (build(S).key !== key) scheduleCheck(ctx, S);   // typed while it was asking
    }, function () { S.checking = false; });
  }
  function currentS() { return S; }

  function changeFeed(ctx, S, feed) {
    return ctx.rpc("agents.form", { feed: feed }, { quiet: true }).then(function (form) {
      if (S !== currentS() || !form) return;
      S.form = form;
      var p = $("ae-params"), v = $("ae-vars"), n = $("ae-feednote"), sm = $("ae-smart"), sn = $("ae-smartnote");
      if (p) p.innerHTML = paramsHtml(form, {});
      if (v) v.innerHTML = varsHtml(form);
      if (n) n.textContent = text(form.who);
      if (sm) {
        var offered = !!(form.smart && form.smart.offered);
        sm.disabled = !offered;
        if (!offered) sm.checked = false;
      }
      if (sn) sn.textContent = smartNote(form);
      S.dirty = true;
      scheduleCheck(ctx, S);
    }, function (e) {
      ctx.toast(e.message, { bad: true });
      var sel = $("ae-feed");
      if (sel) sel.value = text(S.form.feed || S.agent.feed);
    });
  }

  function insertVar(S, name) {
    var box = $(S.focus) || $("ae-body");
    if (!box) return;
    var ins = "{{" + name + "}}";
    var v = text(box.value);
    var a = typeof box.selectionStart === "number" ? box.selectionStart : v.length;
    var b = typeof box.selectionEnd === "number" ? box.selectionEnd : v.length;
    box.value = v.slice(0, a) + ins + v.slice(b);
    try { box.focus(); box.setSelectionRange(a + ins.length, a + ins.length); } catch (e) { /* not every field can */ }
  }

  function wireEditor(el, ctx, S) {
    var form = $("ae-form");
    var edited = function (e) {
      var t = e && e.target;
      if (t && t.id === "ae-kind") {
        var iv = t.value === "interval";
        var dly = $("ae-daily"), itv = $("ae-interval");
        if (dly) dly.hidden = iv;
        if (itv) itv.hidden = !iv;
      }
      if (t && t.id === "ae-feed") {
        /* a select fires input and change for one pick: ask the server once */
        if (e.type === "change" && t.value !== text(S.form.feed || S.agent.feed)) changeFeed(ctx, S, t.value);
        return;
      }
      if (t && t.id === "ae-name") {
        var h = $("ae-title");
        if (h && !S.isNew) h.textContent = t.value || "Edit agent";
      }
      S.dirty = true;
      S.sticky = false;
      scheduleCheck(ctx, S);
    };
    if (form) {
      form.addEventListener("input", edited);
      form.addEventListener("change", edited);
      form.addEventListener("submit", function (e) { e.preventDefault(); });
      form.addEventListener("focusin", function (e) {
        var id = e.target && e.target.id;
        if (id === "ae-subject" || id === "ae-body" || id === "ae-sms") S.focus = id;
      });
    }
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!t || t.disabled) return;
      var pane = t.getAttribute("data-pane");
      if (pane) { showPane(S, pane); return; }
      var what = t.getAttribute("data-do");
      if (what === "insert") { insertVar(S, t.getAttribute("data-var")); S.dirty = true; scheduleCheck(ctx, S); return; }
      if (what === "chup" || what === "chdown") {
        var i = Number(t.getAttribute("data-i")), j = what === "chup" ? i - 1 : i + 1;
        if (j < 0 || j >= S.channels.length) return;
        S.channels.forEach(function (c) { var b = $("ae-ch-" + c.kind); if (b) c.on = !!b.checked; });
        var tmp = S.channels[i]; S.channels[i] = S.channels[j]; S.channels[j] = tmp;
        var ol = $("ae-channels");
        if (ol) ol.innerHTML = channelRows(S);
        S.dirty = true;
        scheduleCheck(ctx, S);
        return;
      }
      if (t.id === "ae-save") { save(ctx, S, t); return; }
      if (t.id === "ae-previewbtn") { preview(ctx, S, t); return; }
      if (t.id === "ae-run") {
        if (S.dirty) { ctx.toast("Save your changes first — Run now runs the saved agent.", { bad: true }); return; }
        runNow(ctx, t, S.agent.id);
        return;
      }
      if (t.id === "ae-dup") {
        ctx.press(t, function () {
          return ctx.rpc("agents.duplicate", { agent_id: S.agent.id }).then(function (r) {
            ctx.toast((r && r.words) || "Duplicated.");
            if (r && r.agent_id) ctx.go("agents/edit/" + encodeURIComponent(r.agent_id));
          }, function () {});
        });
        return;
      }
      if (t.id === "ae-del") {
        ctx.press(t, function () {
          return ctx.act("agents.delete", { agent_id: S.agent.id }).then(function (r) {
            if (!r) return;
            S.dirty = false;
            ctx.toast(r.words || "Deleted.");
            ctx.go("agents");
          }, function () {});
        });
      }
    });
  }

  function save(ctx, S, btn) {
    var b = build(S), a = b.agent;
    if (b.problems.length) { showProblems(b.problems, "bad"); return Promise.resolve(null); }
    return ctx.press(btn, function () {
      return ctx.rpc("agents.save", { agent: a, rev: S.rev }, { quiet: true }).then(function (r) {
        S.rev = text(r && r.rev);
        S.agent = (r && r.agent) || S.agent;
        S.dirty = false;
        ctx.toast((r && r.words) || "Saved.");
        ctx.go("agents");
      }, function (e) {
        S.sticky = true;
        if (e.code === "refused") showProblems(splitProblems(e.message), "bad");
        else if (e.code === "changed") showProblems([e.message + " (Your changes are still on this screen.)"], "bad");
        else showProblems([e.message], "bad");
      });
    }, "Saving…");
  }

  function preview(ctx, S, btn) {
    var b = build(S), a = b.agent;
    var box = $("ae-preview");
    if (b.problems.length) { showProblems(b.problems, "bad"); return Promise.resolve(null); }
    if (box) box.innerHTML = "";
    var done = ctx.busy(box, ctx.method("agents.preview") && ctx.method("agents.preview").ai === false
      ? "Asking the portal…" : "Asking the portal — Claude may write the words; this can take a minute…");
    return ctx.press(btn, function () {
      return ctx.rpc("agents.preview", { agent: a }, { quiet: true }).then(function (p) {
        done();
        p = p || {};
        if (!box) return;
        box.innerHTML = '<div class="c-card"><h3>Preview — who would get this now</h3>' +
          (p.error ? '<p class="ca-problems bad">' + esc("Preview failed: " + p.error) + "</p>"
            : '<p class="c-sub">' + esc(p.words || (plural(p.found, "item") + " found; " + (Number(p.would_send) || 0) + " would be sent, " +
              (Number(p.held) || 0) + " held for you, " + (Number(p.skipped) || 0) + " skipped. Nothing was sent.")) + "</p>") +
          rowsTable(ctx, p.headers, p.rows, "Nobody would get anything right now.") + "</div>";
        if (box.scrollIntoView) { try { box.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) { /* old browsers */ } }
      }, function (e) {
        done();
        if (e.code === "refused") { S.sticky = true; showProblems(splitProblems(e.message), "bad"); }
        else if (box) box.innerHTML = ctx.ui.failed(e, { retry: false, title: "Preview failed." });
      });
    }, "Previewing…");
  }

  if (window.__DCR_CONSOLE_TEST__) {
    C._agents = { collect: function () { return S ? build(S).agent : null; }, localProblems: localProblems, state: function () { return S; },
      splitProblems: splitProblems };
  }
})();
