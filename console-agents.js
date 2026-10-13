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
   - #/agents/template/<key>  a new agent from a ready-made one (agents.new
                              {template}), e.g. the Monday report for the
                              marketing team.
   A recurring task (feed "recurring", form.recurring) has its own editor
   panes instead: What, Recurring task (the task, its repeat, the steps, the
   useful information with a Preview, and the history with Run this week's
   now / Mark this one done — recurring.*) and Rules (dry run, first run
   reviewed). Who and The message are not drawn: the steps say whom and how.
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
  var templateChoices = null; // [{template, label, feed}] from agents.list
  var S = null;               // the open editor

  /* A recurring task's choices when the server's form does not list them
     (an older DCR server): the same words as recurring/config.py. */
  var RC_CHANNELS = [{ key: "app", label: "the DCR App" }, { key: "sms", label: "text" }, { key: "whatsapp", label: "WhatsApp (Twilio)" },
    { key: "wadesktop", label: "WhatsApp (this computer)" }, { key: "email", label: "email" }];
  var RC_CH_SHORT = { app: "DCR App", sms: "Text", whatsapp: "WhatsApp (Twilio)", wadesktop: "WhatsApp (this computer)", email: "Email" };
  var RC_NTH = [[1, "first"], [2, "second"], [3, "third"], [4, "fourth"], [-1, "last"]];
  var RC_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  var RC_DESC_VARS = ["dateText", "weekText", "monthText", "companyName"];
  var RC_LIMITS = { title: 120, description: 2000, subject: 200, body: 2000, sms: 600, ask: 500, skip: 30 };
  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var RC_TONES = { on_time: "good", done: "good", late: "warn", open: "info", not_done: "bad", missed: "bad", dry_run: "dim", gone: "dim", waiting: "dim" };

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
    if (p[0] === "template" && p[1]) return editor(el, ctx, { template: p[1] });
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
      if (d && Array.isArray(d.templates)) templateChoices = d.templates;
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
      (a.recurring ? recurringRow(ctx, a.recurring) : "") +
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

  /* Under a recurring task's name: its next step in words and its last
     days (agentgroups.recurring_row). */
  function recurringRow(ctx, rec) {
    var recent = (rec.recent || []).map(function (r) {
      var w = text(r.outcome_words);
      var tone = /^on time|^done/.test(w) ? "good" : /^late/.test(w) ? "warn" : /^open/.test(w) ? "info"
        : /not done|missed/.test(w) ? "bad" : "dim";
      return '<span class="ca-rc-day">' + esc(text(r.date_text)) + " " + ctx.ui.chip(w, tone) + "</span>";
    }).join(" ");
    return '<div class="ca-meta ca-rc-row">' + (rec.next_text ? '<span class="ca-rc-next">' + esc("Next: " + text(rec.next_text)) + "</span>" : "") +
      (recent ? '<span class="ca-rc-recent">' + recent + "</span>" : "") + "</div>";
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
      if (t.id === "caNew") { pickFeed(ctx, d.feed_choices || feedChoices || [], d.templates || templateChoices || []); return; }
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

  /* What it should watch — the feeds, then the ready-made agents (a
     template is a whole agent to start from). */
  function pickFeed(ctx, choices, templates) {
    if (!choices.length) { ctx.toast("Reload the list first.", { bad: true }); return; }
    var options = choices.map(function (c) { return { value: c.feed, label: c.label }; })
      .concat((templates || []).map(function (t) { return { value: "tpl:" + t.template, label: t.label }; }));
    return ctx.modal({
      title: "New agent", message: "What should it watch?", okText: "Next",
      fields: [{ name: "feed", type: "select", value: choices[0].feed, options: options }],
    }).then(function (v) {
      var pick = text(v && v.feed);
      if (/^tpl:/.test(pick)) ctx.go("agents/template/" + encodeURIComponent(pick.slice(4)));
      else if (pick) ctx.go("agents/new/" + encodeURIComponent(pick));
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
      : want.template ? ctx.rpc("agents.new", { template: want.template }, { quiet: true })
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
    var rec = !!(form.recurring && typeof form.recurring === "object");
    S = {
      agent: a, rev: text(d.rev), form: form, isNew: isNew, pane: rec ? "rc" : "what", dirty: false, timer: null,
      lastChecked: "", checking: false, lastCheckAt: 0, focus: "ae-body",
      channels: picked.map(function (k) { return { kind: k, label: kinds.filter(function (c) { return c.kind === k; })[0].label, on: true }; })
        .concat(kinds.filter(function (c) { return picked.indexOf(c.kind) < 0; }).map(function (c) { return { kind: c.kind, label: c.label, on: false }; })),
      rec: rec,
      panes: rec ? [["what", "What"], ["rc", "Recurring task"], ["rules", "Rules"]]
        : [["what", "What and when"], ["who", "Who and how"], ["words", "The message"], ["rules", "Rules"]],
    };
    if (rec) rcInit(S, a, form);
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
      '<div class="ca-panes' + (rec ? " ca-panes3" : "") + '" role="tablist" aria-label="Agent editor">' +
        S.panes.map(function (p) {
          return '<button type="button" role="tab" id="ae-tab-' + p[0] + '" data-pane="' + p[0] + '" aria-selected="' + (p[0] === S.pane) + '">' + p[1] + "</button>";
        }).join("") +
      "</div>" +
      '<form class="c-card ca-form" id="ae-form" novalidate>' +
      /* What and when */
      '<section id="ae-pane-what" role="tabpanel" aria-labelledby="ae-tab-what"' + (S.pane === "what" ? "" : " hidden") + ">" +
        field("Name", '<input type="text" id="ae-name" maxlength="' + LIMITS.name + '" value="' + esc(a.name) + '">', "", "ae-name") +
        field("Watches", '<select id="ae-feed">' + feeds.map(function (f) {
          return '<option value="' + esc(f.feed) + '"' + (f.feed === a.feed ? " selected" : "") + ">" + esc(f.label) + "</option>";
        }).join("") + "</select>", '<span id="ae-feednote">' + esc(form.who) + "</span>", "ae-feed") +
        check("ae-enabled", !!a.enabled, rec ? "Enabled — makes the task and sends the steps on the days it repeats" : "Enabled — runs on its schedule") +
        /* a recurring task's schedule follows from its steps (apply_to_agent) */
        (rec ? "" : '<fieldset class="ca-fs"><legend>Schedule</legend>' +
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
        '<div id="ae-params">' + paramsHtml(form, a.feed_params || {}) + "</div>") +
      "</section>" +
      /* a recurring task: its own pane instead of Who and how and The message */
      (rec ? rcPaneHtml(S, form) :
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
      "</section>") +
      /* Rules */
      '<section id="ae-pane-rules" role="tabpanel" aria-labelledby="ae-tab-rules" hidden>' +
        (rec ? "" : field("Repeat the same reminder after", '<div class="c-inline">' + numInput("ae-repeat", r.repeat_after_hours, 0, 1440, "0.5", "Repeat after (hours)") +
          "<span>h</span></div>", "0 = never repeat the same reminder") +
        field("At most, per fact", numInput("ae-maxrem", r.max_reminders, 1, 99, 1), "", "ae-maxrem") +
        field("Money: contact must be at least", '<select id="ae-minconf">' + mc.map(function (m) {
          return '<option value="' + esc(m.key) + '"' + (m.key === r.min_confidence ? " selected" : "") + ">" + esc(m.label) + "</option>";
        }).join("") + "</select>", "", "ae-minconf") +
        field("Escalate to", '<input type="text" id="ae-escto" maxlength="' + LIMITS.escalate + '" value="' + esc(r.escalate_to) +
          '" placeholder="email — told once when a person hits the maximum with no change">', "", "ae-escto") +
        field("…after this many reminders (0 = never)", numInput("ae-escafter", r.escalate_after, 0, 99, 1), "", "ae-escafter") +
        field("At most per run", numInput("ae-cap", r.max_per_run, 0, 1000, 1), "0 = no cap", "ae-cap")) +
        check("ae-dry", !!r.dry_run, rec ? "Dry run — nothing is made on My Tasks and nothing is sent; the history says what would have gone"
          : "Dry run — decide and record, send nothing") +
        check("ae-reviewed", !!r.first_run_reviewed, "First run reviewed (untick to make the next run a review again)") +
        (rec ? '<p class="c-help">' + esc(smartNote(form)) + "</p>" :
        '<div class="c-field"><span class="c-label">Smart wording</span>' +
          '<label class="c-check"><input type="checkbox" id="ae-smart"' + (offered && r.smart_wording ? " checked" : "") + (offered ? "" : " disabled") +
          "> Let Claude write each message using the training</label>" +
          '<div class="c-help" id="ae-smartnote">' + esc(smartNote(form)) + "</div></div>") +
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
    if (mine.rec) showPane(mine, mine.pane, ctx);
  }

  function showPane(S, name, ctx) {
    S.pane = name;
    S.panes.forEach(function (pp) {
      var p = pp[0];
      var pane = $("ae-pane-" + p), tab = $("ae-tab-" + p);
      if (pane) pane.hidden = p !== name;
      if (tab) tab.setAttribute("aria-selected", String(p === name));
    });
    /* the Recurring task pane fills its project list and history the first
       time it opens */
    if (name === "rc" && ctx && !S.rcOpened) {
      S.rcOpened = true;
      rcProjects(ctx, S);
      rcHistory(ctx, S);
    }
  }

  /* The agent as the form holds it — the closed shape the DCR server takes
     (console-spec §6.1.3); unknown keys of the stored agent stay on the
     server (normalize_agent carries them over). */
  function collect(S) {
    var val = function (id) { var n = $(id); return n ? text(n.value) : ""; };
    var on = function (id) { var n = $(id); return !!(n && n.checked); };
    if (S.rec) {
      /* a recurring task: its settings; the schedule, audience, channels,
         template and the other rules follow from them on the server */
      return { id: text(S.agent.id), name: val("ae-name").trim(), feed: val("ae-feed") || text(S.agent.feed), enabled: on("ae-enabled"),
        rules: { dry_run: on("ae-dry"), first_run_reviewed: on("ae-reviewed") }, recurring: rcCollect(S) };
    }
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
    if (a.recurring) return out.concat(rcLocalProblems(a.recurring));
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
    if (S.rec) return { agent: a, problems: problems, key: JSON.stringify(a) };
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
      if (S.rec) rcWarnings((r && r.warnings) || []);
      var seg = $("ae-seg");
      if (seg) {
        seg.className = r && r.segments && r.segments.warn ? "ca-seg warn" : "ca-seg";
        seg.textContent = text(r && r.segments && r.segments.text);
      }
      if (build(S).key !== key) scheduleCheck(ctx, S);   // typed while it was asking
    }, function () { S.checking = false; });
  }
  function currentS() { return S; }

  function changeFeed(ctx, S, feed, el) {
    return ctx.rpc("agents.form", { feed: feed }, { quiet: true }).then(function (form) {
      if (S !== currentS() || !form) return;
      if (el && !!(form.recurring && typeof form.recurring === "object") !== !!S.rec) {
        /* to or from a recurring task: the panes are not the same, so the
           editor is drawn again with what is on the screen carried over */
        var cur = collect(S);
        var next = JSON.parse(JSON.stringify(S.agent || {}));
        next.name = cur.name;
        next.enabled = cur.enabled;
        next.feed = feed;
        next.rules = Object.assign({}, next.rules || {}, { dry_run: !!(cur.rules && cur.rules.dry_run),
          first_run_reviewed: !!(cur.rules && cur.rules.first_run_reviewed) });
        if (form.recurring && (!next.recurring || typeof next.recurring !== "object")) {
          next.recurring = JSON.parse(JSON.stringify(form.recurring.defaults || {}));
        }
        drawEditor(el, ctx, { agent: next, rev: S.rev, form: form }, S.isNew);
        currentS().dirty = true;
        return;
      }
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
        if (e.type === "change" && t.value !== text(S.form.feed || S.agent.feed)) changeFeed(ctx, S, t.value, el);
        return;
      }
      if (S.rec && t && t.id && t.id.indexOf("ae-rc-") === 0) rcEdited(S, t, e);
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
        if (/^ae-rc-s\d+-(subject|body|sms)$/.test(text(id))) S.rcFocus = id;
      });
    }
    el.addEventListener("click", function (e) {
      /* the editor drawn again (a change to or from a recurring task) wires
         itself anew: this listener belongs to the one before */
      if (S !== currentS()) return;
      var t = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!t || t.disabled) return;
      var pane = t.getAttribute("data-pane");
      if (pane) { showPane(S, pane, ctx); return; }
      var what = t.getAttribute("data-do");
      if (S.rec && ((what && what.indexOf("rc") === 0) || (t.id && t.id.indexOf("ae-rc-") === 0))) { rcClick(ctx, S, t); return; }
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

  /* ── a recurring task (feed "recurring") ─────────────────────────────── */

  /* The settings being edited live in S.rc; the steps' channels keep the
     order they were ticked in (S.rc.steps[i].channels), everything else is
     read from the form when it is collected. */
  function rcInit(S, a, form) {
    var rf = form.recurring || {};
    var cfg = a.recurring && typeof a.recurring === "object" ? a.recurring : (rf.defaults || {});
    cfg = JSON.parse(JSON.stringify(cfg || {}));
    cfg.task = cfg.task && typeof cfg.task === "object" ? cfg.task : {};
    cfg.repeat = cfg.repeat && typeof cfg.repeat === "object" ? cfg.repeat : {};
    cfg.info = cfg.info && typeof cfg.info === "object" ? cfg.info : {};
    cfg.catch_up = cfg.catch_up && typeof cfg.catch_up === "object" ? cfg.catch_up : {};
    cfg.steps = (Array.isArray(cfg.steps) ? cfg.steps : []).filter(function (s) { return s && typeof s === "object"; }).map(function (s) {
      return { n: s.n, at: text(s.at), kind: s.kind === "create" ? "create" : "remind", channels: (Array.isArray(s.channels) ? s.channels : []).map(text),
        condition: s.condition === "if_open" ? "if_open" : "always", subject: text(s.subject), body: text(s.body), sms: text(s.sms) };
    });
    S.rc = cfg;
    S.rcForm = rf;
    S.rcChannels = Array.isArray(rf.channels) && rf.channels.length ? rf.channels : RC_CHANNELS;
    S.rcProjMap = {};
    var p = cfg.task.project || {};
    if (text(p.id)) S.rcProjMap[text(p.id)] = { id: text(p.id), code: text(p.code), label: text(p.label) };
    S.rcProjects = null;
    S.rcProj = "";
    S.rcFocus = "";
    S.rcHist = null;
    /* whom "asked for these times" was ticked for (rcEdited unticks it for another name) */
    S.rcEarlyFor = cfg.task.early_ok ? text(cfg.task.assignee).trim() : "";
  }

  function rcMax(S) { return Number(S.rcForm && S.rcForm.max_steps) || 8; }
  function earlyWords(name) {
    return (text(name).trim() || "The assignee") + " asked for these times — the phone may buzz from 5:00 am";
  }
  function rcTimeWords(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(text(hhmm));
    if (!m) return text(hhmm);
    var h = Number(m[1]);
    return (h % 12 || 12) + ":" + m[2] + (h < 12 ? " am" : " pm");
  }
  function rcAnd(words) {
    return words.length < 2 ? (words[0] || "") : words.slice(0, -1).join(", ") + " and " + words[words.length - 1];
  }
  function rcChannelWord(S, k) {
    var c = (S.rcChannels || RC_CHANNELS).filter(function (x) { return x.key === k; })[0];
    return c ? text(c.label) : k;
  }
  /* recurring.config.step_label: "Create the task" / "Reminder by the DCR
     App, only if not done" */
  function rcStepLabel(S, s) {
    if (s.kind === "create") return "Create the task";
    var kinds = (s.channels || []).map(function (k) { return rcChannelWord(S, k); });
    return "Reminder" + (kinds.length ? " by " + rcAnd(kinds) : "") + (s.condition === "if_open" ? ", only if not done" : "");
  }
  function rcOrderWords(S, kinds) {
    kinds = kinds || [];
    if (kinds.length < 2) return "";
    return "Tried in this order: " + kinds.map(function (k) { return rcChannelWord(S, k); }).join(", then ") +
      " — the first one that can reach them goes.";
  }
  function rcRunWords(S) {
    var n = $("ae-rc-every"), every = n ? text(n.value) : text(S.rc && S.rc.repeat && S.rc.repeat.every);
    return every === "daily" || every === "weekdays" ? "Run today's now"
      : every === "monthly_day" || every === "monthly_weekday" ? "Run this month's now" : "Run this week's now";
  }
  function rcVarsHtml(vars, kind) {
    if (!vars || !vars.length) return "";
    return '<div class="ca-vars" role="group" aria-label="Insert a placeholder"><span class="c-muted c-small">Insert:</span> ' +
      vars.map(function (v) {
        return '<button type="button" class="ca-var" data-do="' + kind + '" data-var="' + esc(v) + '">' + esc(v) + "</button>";
      }).join("") + "</div>";
  }
  function opts(list, value) {
    return list.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(value) ? " selected" : "") + ">" + esc(o[1]) + "</option>";
    }).join("");
  }

  function rcPaneHtml(S, form) {
    var rf = S.rcForm || {}, c = S.rc, t = c.task, r = c.repeat, info = c.info, cu = c.catch_up;
    var every = text(r.every) || "weekly";
    var everyChoices = (Array.isArray(rf.every) && rf.every.length ? rf.every : [{ key: "weekly", label: "Weekly" }, { key: "daily", label: "Every day" },
      { key: "weekdays", label: "Weekdays (Mon-Fri)" }, { key: "monthly_day", label: "Monthly on a day" }, { key: "monthly_weekday", label: "Monthly on a weekday" }])
      .map(function (e) { return [e.key, e.label]; });
    var cats = (Array.isArray(rf.categories) && rf.categories.length ? rf.categories : ["Office Work"]).slice();
    if (text(t.category) && cats.indexOf(t.category) < 0) cats.push(t.category);
    var pris = Array.isArray(rf.priorities) && rf.priorities.length ? rf.priorities : ["Urgent", "Medium", "Low"];
    var wd = Array.isArray(r.weekdays) ? r.weekdays.map(Number) : [];
    var srcs = Array.isArray(rf.info_sources) ? rf.info_sources : [];
    var picked = Array.isArray(info.sources) ? info.sources : [];
    var claude = rf.claude || {};
    var proj = t.project || {};
    return '<section id="ae-pane-rc" role="tabpanel" aria-labelledby="ae-tab-rc"' + (S.pane === "rc" ? "" : " hidden") + ">" +
      /* the task */
      '<fieldset class="ca-fs"><legend>The task</legend>' +
        field("Title", '<input type="text" id="ae-rc-title" maxlength="' + RC_LIMITS.title + '" value="' + esc(t.title) +
          '" placeholder="e.g. Send the project report to the marketing team">', "", "ae-rc-title") +
        field("Description", rcVarsHtml(rf.desc_vars || RC_DESC_VARS, "rcdvar") + '<textarea id="ae-rc-desc" rows="4" maxlength="' + RC_LIMITS.description + '">' +
          esc(t.description) + "</textarea>", esc("What the task says on My Tasks. It can name the day it is for: {{dateText}}, {{weekText}}, {{monthText}}."), "ae-rc-desc") +
        field("For", '<input type="text" id="ae-rc-assignee" list="ae-rc-people" maxlength="80" autocomplete="off" value="' + esc(t.assignee) +
          '" placeholder="a name from the People tab"><datalist id="ae-rc-people">' + (rf.people || []).map(function (n) {
            return '<option value="' + esc(n) + '"></option>';
          }).join("") + "</datalist>", esc("Every step goes to this person, and the task is theirs on My Tasks."), "ae-rc-assignee") +
        field("Project", '<div class="c-inline ca-rc-proj"><select id="ae-rc-project">' + rcProjectOptions(S, text(proj.id)) + "</select>" +
          '<button type="button" class="c-btn ghost sm" id="ae-rc-loadproj" data-act data-method="recurring.projects">Load projects</button></div>',
          '<span id="ae-rc-projnote"></span>', "ae-rc-project") +
        '<div class="ca-rc-3">' +
          field("Category", '<select id="ae-rc-category">' + opts(cats.map(function (x) { return [x, x]; }), t.category) + "</select>", "", "ae-rc-category") +
          field("Priority", '<select id="ae-rc-priority">' + opts(pris.map(function (x) { return [x, x]; }), t.priority) + "</select>", "", "ae-rc-priority") +
          field("Due at", timeInput("ae-rc-due", t.due, "Due at"), "", "ae-rc-due") +
        "</div>" +
        '<div class="c-field"><label class="c-check"><input type="checkbox" id="ae-rc-early"' + (t.early_ok ? " checked" : "") + '> <span id="ae-rc-earlyword">' +
          esc(earlyWords(t.assignee)) + "</span></label>" +
          '<div class="c-help">Phones are quiet until 8:00 am. With this ticked, a step by the DCR App, text or WhatsApp between 5:00 am and noon goes at its time.</div></div>' +
      "</fieldset>" +
      /* repeats */
      '<fieldset class="ca-fs"><legend>Repeats</legend>' +
        field("Repeats", '<select id="ae-rc-every">' + opts(everyChoices, every) + "</select>", "", "ae-rc-every") +
        '<div id="ae-rc-weekly"' + (every === "weekly" ? "" : " hidden") + ">" +
          '<div class="c-field"><span class="c-label">On</span><div class="c-days" role="group" aria-label="Weekdays">' +
            DAY_NAMES.map(function (n, i) {
              return '<label><input type="checkbox" id="ae-rc-wd' + i + '"' + (wd.indexOf(i) >= 0 ? " checked" : "") + "> " + n + "</label>";
            }).join("") + "</div></div>" +
          field("How often", '<div class="c-inline"><span>every</span>' + numInput("ae-rc-interval", r.interval || 1, 1, 8, 1, "Every N weeks") +
            "<span>week(s)</span></div>", "", "ae-rc-interval") +
        "</div>" +
        '<div id="ae-rc-mday"' + (every === "monthly_day" ? "" : " hidden") + ">" +
          field("Day of the month", numInput("ae-rc-monthday", r.month_day || 1, 1, 31, 1, "Day of the month"), esc("Past the end of a shorter month, its last day."), "ae-rc-monthday") +
        "</div>" +
        '<div id="ae-rc-mwd"' + (every === "monthly_weekday" ? "" : " hidden") + ">" +
          field("Which", '<div class="c-inline"><span>the</span><select id="ae-rc-nth" aria-label="Which one">' + opts(RC_NTH, r.nth === undefined ? 1 : r.nth) + "</select>" +
            '<select id="ae-rc-weekday" aria-label="Weekday">' + opts(RC_WEEKDAYS.map(function (d, i) { return [i, d]; }), r.weekday || 0) + "</select><span>of the month</span></div>") +
        "</div>" +
        field("Starts on", '<input type="date" id="ae-rc-start" value="' + esc(DAY_RE.test(text(r.start)) ? r.start : "") + '">',
          esc("Empty: from the first day it matches. Every N weeks counts from this day."), "ae-rc-start") +
        field("Skip these days", '<input type="text" id="ae-rc-skip" value="' + esc((r.skip_dates || []).join(", ")) + '" placeholder="2026-12-25, 2027-01-01">',
          esc("Holidays — dates like 2026-12-25, comma separated (at most " + RC_LIMITS.skip + ")."), "ae-rc-skip") +
      "</fieldset>" +
      /* steps */
      '<fieldset class="ca-fs"><legend>Steps</legend>' +
        '<p class="c-help">Every step goes to the task’s assignee. The first step makes the task on My Tasks and sends its message; the ones marked ' +
          "“only if not done” stop once the task is done.</p>" +
        rcVarsHtml(rf.step_vars || [], "rcvar") +
        '<div id="ae-rc-steps">' + rcStepsHtml(S) + "</div>" +
        '<div class="c-actions"><button type="button" class="c-btn ghost sm" id="ae-rc-add"' + (c.steps.length >= rcMax(S) ? " disabled" : "") + ">Add a step</button></div>" +
        field("If the PC was off at the first step, still make the task until", timeInput("ae-rc-until", cu.create_until || "23:59", "Make it late until"),
          esc("Later than that, the day is recorded as missed."), "ae-rc-until") +
        '<div id="ae-rc-warnings" class="ca-problems" role="status" aria-live="polite"></div>' +
      "</fieldset>" +
      /* useful information */
      '<fieldset class="ca-fs"><legend>Useful information</legend>' +
        '<p class="c-help">Goes in the first step’s email ({{usefulInfo}}) and in any step that uses it. Never money, client phone numbers or emails, or pay.</p>' +
        '<div class="ca-rc-srcs" role="group" aria-label="Sources">' + srcs.map(function (s) {
          return '<label class="c-check"><input type="checkbox" id="ae-rc-src-' + esc(s.key) + '"' + (picked.indexOf(s.key) >= 0 ? " checked" : "") + "> " + esc(s.label) + "</label>";
        }).join("") + "</div>" +
        field("Look back", '<div class="c-inline">' + numInput("ae-rc-days", info.days || 7, 1, 31, 1, "Days to look back") + "<span>days</span></div>", "", "ae-rc-days") +
        '<div class="c-field"><label class="c-check"><input type="checkbox" id="ae-rc-claude"' + (info.claude ? " checked" : "") + "> Let Claude write it</label>" +
          '<div class="c-help" id="ae-rc-claudenote">' + esc(claude.note) + "</div></div>" +
        field("What should it write?", '<textarea id="ae-rc-ask" rows="3" maxlength="' + RC_LIMITS.ask + '" placeholder="' +
          esc(rf.default_ask || "A short, practical summary aimed at this task.") + '">' + esc(info.ask) + "</textarea>", "", "ae-rc-ask") +
        '<div class="c-actions"><button type="button" class="c-btn ghost sm" id="ae-rc-preview" data-act data-method="recurring.preview_info">Preview the useful information</button></div>' +
        '<div id="ae-rc-info"></div>' +
      "</fieldset>" +
      /* history */
      '<fieldset class="ca-fs"><legend>History</legend><div id="ae-rc-history">' +
        (S.isNew ? '<p class="c-help">Save the agent first — its days show here once it runs.</p>' : '<div class="c-skel"></div>') + "</div></fieldset>" +
      "</section>";
  }

  function rcStepsHtml(S) {
    var steps = S.rc.steps;
    return steps.map(function (s, i) { return rcStepHtml(S, s, i); }).join("") ||
      '<p class="c-help">No steps — Add a step makes the first one.</p>';
  }

  function rcStepHtml(S, s, i) {
    var rf = S.rcForm || {};
    var steps = S.rc.steps, n = steps.length;
    var create = s.kind === "create";
    var movable = function (k) { return k >= 0 && k < n && steps[k].kind !== "create"; };
    var conds = (Array.isArray(rf.conditions) && rf.conditions.length ? rf.conditions : [{ key: "always", label: "Always" }, { key: "if_open", label: "Only if not done" }])
      .map(function (c) { return [c.key, c.label]; });
    var id = function (part) { return "ae-rc-s" + i + "-" + part; };
    var label = "Step " + (i + 1);
    return '<div class="ca-step' + (create ? " create" : "") + '" id="ae-rc-step-' + i + '">' +
      '<div class="ca-step-head"><span class="ca-step-n">' + esc(label) + '</span><span class="ca-step-what">' + (create ? "Create the task and send" : "Reminder") + "</span>" +
        (create ? "" : '<span class="ca-step-tools">' +
          '<button type="button" class="c-btn ghost sm" data-do="rcup" data-i="' + i + '"' + (movable(i) && movable(i - 1) ? "" : " disabled") +
            ' aria-label="' + esc("Swap step " + (i + 1) + " with the step before it") + '">↑</button>' +
          '<button type="button" class="c-btn ghost sm" data-do="rcdown" data-i="' + i + '"' + (movable(i) && movable(i + 1) ? "" : " disabled") +
            ' aria-label="' + esc("Swap step " + (i + 1) + " with the step after it") + '">↓</button>' +
          '<button type="button" class="c-btn ghost danger sm" data-do="rcrm" data-i="' + i + '">Remove</button></span>') +
      "</div>" +
      '<div class="ca-step-row">' +
        field("At", timeInput(id("at"), s.at, label + " time"), "", id("at")) +
        field("Goes", '<select id="' + id("cond") + '"' + (create ? " disabled" : "") + ">" + opts(conds, create ? "always" : s.condition) + "</select>", "", id("cond")) +
      "</div>" +
      '<div class="c-field"><span class="c-label">Send by</span><div class="c-days ca-rc-chans" role="group" aria-label="' + esc(label + " channels") + '">' +
        (S.rcChannels || RC_CHANNELS).map(function (c) {
          return '<label><input type="checkbox" id="' + id("ch-" + c.key) + '"' + (s.channels.indexOf(c.key) >= 0 ? " checked" : "") + "> " +
            esc(RC_CH_SHORT[c.key] || c.label) + "</label>";
        }).join("") + '</div><div class="c-help" id="' + id("order") + '">' + esc(rcOrderWords(S, s.channels)) + "</div></div>" +
      field("Email subject", '<input type="text" id="' + id("subject") + '" maxlength="' + RC_LIMITS.subject + '" value="' + esc(s.subject) + '">', "", id("subject")) +
      field("Message", '<textarea id="' + id("body") + '" rows="5" maxlength="' + RC_LIMITS.body + '">' + esc(s.body) + "</textarea>", "", id("body")) +
      field("Short text", '<textarea id="' + id("sms") + '" rows="2" maxlength="' + RC_LIMITS.sms + '">' + esc(s.sms) + "</textarea>",
        esc("The DCR App, texts and WhatsApp use it — short, plain characters. Empty, the DCR App shows the message."), id("sms")) +
      "</div>";
  }

  function rcProjectOptions(S, keepId) {
    var rows = S.rcProjects || [];
    var out = '<option value="">(pick the project the task goes on)</option>';
    var seen = false;
    rows.forEach(function (p) {
      var pid = text(p.id), sel = pid === keepId;
      if (sel) seen = true;
      out += '<option value="' + esc(pid) + '"' + (sel ? " selected" : "") + ">" + esc(text(p.label) || text(p.code) || pid) +
        (p.active ? "" : esc(" (" + (text(p.status) || "not active") + ")")) + "</option>";
    });
    if (keepId && !seen) {
      /* the saved project, before the list arrives (or gone from it) */
      var k = S.rcProjMap[keepId] || {};
      out += '<option value="' + esc(keepId) + '" selected>' + esc(text(k.label) || text(k.code) || "project " + keepId) + "</option>";
    }
    return out;
  }

  /* The steps as the form holds them: their times, conditions and words
     from the boxes, their channels in the order they were ticked. */
  function rcReadSteps(S) {
    S.rc.steps.forEach(function (s, i) {
      var get = function (part) { return $("ae-rc-s" + i + "-" + part); };
      var at = get("at"), cond = get("cond"), subj = get("subject"), body = get("body"), sms = get("sms");
      if (at) s.at = text(at.value);
      if (cond) s.condition = s.kind === "create" ? "always" : (text(cond.value) === "if_open" ? "if_open" : "always");
      if (subj) s.subject = text(subj.value);
      if (body) s.body = text(body.value);
      if (sms) s.sms = text(sms.value);
    });
    return S.rc.steps;
  }

  function rcCollect(S) {
    var val = function (id) { var n = $(id); return n ? text(n.value) : ""; };
    var on = function (id) { var n = $(id); return !!(n && n.checked); };
    var num = function (id, d) { var v = val(id).trim(); return v === "" || !isFinite(Number(v)) ? d : Number(v); };
    var steps = rcReadSteps(S);
    var pid = val("ae-rc-project");
    var proj = pid ? (S.rcProjMap[pid] || { id: pid, code: "", label: "" }) : { id: "", code: "", label: "" };
    var days = [];
    for (var i = 0; i < 7; i++) if (on("ae-rc-wd" + i)) days.push(i);
    var srcs = ((S.rcForm && S.rcForm.info_sources) || []).filter(function (s) { return on("ae-rc-src-" + s.key); }).map(function (s) { return s.key; });
    return {
      version: 1,
      task: { title: val("ae-rc-title").trim(), description: val("ae-rc-desc"), assignee: val("ae-rc-assignee").trim(),
        project: { id: text(proj.id), code: text(proj.code), label: text(proj.label) }, category: val("ae-rc-category"),
        priority: val("ae-rc-priority"), due: val("ae-rc-due"), early_ok: on("ae-rc-early") },
      repeat: { every: val("ae-rc-every") || "weekly", interval: num("ae-rc-interval", 1), weekdays: days, month_day: num("ae-rc-monthday", 1),
        nth: num("ae-rc-nth", 1), weekday: num("ae-rc-weekday", 0), start: val("ae-rc-start"),
        skip_dates: val("ae-rc-skip").split(/[\s,;]+/).map(function (x) { return x.trim(); }).filter(Boolean) },
      steps: steps.map(function (s) {
        return { n: s.n, at: s.at, kind: s.kind, channels: s.channels.slice(), condition: s.condition, subject: s.subject, body: s.body, sms: s.sms };
      }),
      next_n: Number(S.rc.next_n) || 1,
      info: { sources: srcs, days: num("ae-rc-days", 7), claude: on("ae-rc-claude"), ask: val("ae-rc-ask") },
      catch_up: { create_until: val("ae-rc-until") },
    };
  }

  /* Only what would never reach the server whole; the DCR server's
     recurring.config.problems says the rest, in the desktop's words. */
  function rcLocalProblems(rc) {
    var out = [];
    if ((rc.repeat.skip_dates || []).length > RC_LIMITS.skip) out.push("At most " + RC_LIMITS.skip + " days to skip.");
    if ((rc.steps || []).length > 8) out.push("At most 8 steps.");
    return out;
  }

  function rcWarnings(list) {
    var box = $("ae-rc-warnings");
    if (!box) return;
    list = (list || []).filter(Boolean);
    if (!list.length) { box.className = "ca-problems"; box.innerHTML = ""; return; }
    box.className = "ca-problems warn ca-rc-warn";
    box.innerHTML = "<b>Worth knowing</b><ul>" + list.map(function (w) { return "<li>" + esc(w) + "</li>"; }).join("") + "</ul>";
  }

  function rcEdited(S, t, e) {
    var id = t.id;
    if (id === "ae-rc-every") {
      var v = text(t.value);
      [["ae-rc-weekly", "weekly"], ["ae-rc-mday", "monthly_day"], ["ae-rc-mwd", "monthly_weekday"]].forEach(function (p) {
        var box = $(p[0]);
        if (box) box.hidden = v !== p[1];
      });
      var run = $("ae-rc-runnow");
      if (run && !run.getAttribute("aria-busy")) run.textContent = rcRunWords(S);
    } else if (id === "ae-rc-assignee") {
      var w = $("ae-rc-earlyword");
      if (w) w.textContent = earlyWords(t.value);
      /* "<name> asked for these times" is about one person: a name typed
         in full or picked (change, not each keystroke) for someone else
         unticks it; ticked with no name yet, it becomes theirs */
      var early = $("ae-rc-early");
      if (e.type === "change" && early) {
        var who = text(t.value).trim();
        if (early.checked && S.rcEarlyFor && who !== S.rcEarlyFor) early.checked = false;
        if (early.checked) S.rcEarlyFor = who;
      }
    } else if (id === "ae-rc-early" && e.type === "change") {
      var a = $("ae-rc-assignee");
      S.rcEarlyFor = t.checked && a ? text(a.value).trim() : "";
    }
    var m = /^ae-rc-s(\d+)-ch-([a-z]+)$/.exec(id);
    if (m && e.type === "change") {
      var st = S.rc.steps[Number(m[1])];
      if (!st) return;
      /* a channel ticked goes last: they are tried in the order ticked */
      st.channels = st.channels.filter(function (k) { return k !== m[2]; });
      if (t.checked) st.channels.push(m[2]);
      var o = $("ae-rc-s" + m[1] + "-order");
      if (o) o.textContent = rcOrderWords(S, st.channels);
    }
  }

  /* "Add a step": the server's new-step words an hour after the latest
     step (recurring.config.new_step), with a number never given out
     before (at least S.rc.next_n, which only grows): a removed step's
     number would bring that step's sends for the day with it. */
  function rcNewStep(S) {
    var base = (S.rcForm && S.rcForm.new_step) || { kind: "remind", channels: ["email"], condition: "if_open", subject: "Reminder: {{taskName}} - {{dateText}}",
      body: "Hi {{firstName}} - \"{{taskName}}\" is not marked done yet.\n\nOpen it: {{link}}", sms: "" };
    var steps = S.rc.steps;
    var mins = function (hhmm) { var m = /^(\d{2}):(\d{2})$/.exec(text(hhmm)); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    var used = {}, top = null, n = 0;
    steps.forEach(function (s) {
      var v = mins(s.at);
      if (v !== null) { used[v] = true; top = top === null ? v : Math.max(top, v); }
      n = Math.max(n, Number(s.n) || 0);
    });
    var at = Math.min((top === null ? 6 * 60 : top) + 60, 23 * 60 + 59);
    while (used[at] && at > 0) at--;
    var pad = function (x) { return (x < 10 ? "0" : "") + x; };
    var next = Math.max(n + 1, Number(S.rc.next_n) || 1);
    if (next > 99) {
      /* past 99 (a long-edited agent), the lowest number no step has */
      var have = {};
      steps.forEach(function (s) { have[Number(s.n) || 0] = true; });
      next = 1;
      while (have[next] && next < 99) next++;
    }
    S.rc.next_n = Math.min(100, Math.max(Number(S.rc.next_n) || 1, next + 1));
    return { n: next, at: pad(Math.floor(at / 60)) + ":" + pad(at % 60), kind: "remind", channels: (base.channels || ["email"]).slice(),
      condition: base.condition === "always" ? "always" : "if_open", subject: text(base.subject), body: text(base.body), sms: text(base.sms) };
  }

  function rcRedrawSteps(ctx, S) {
    var box = $("ae-rc-steps");
    if (box) box.innerHTML = rcStepsHtml(S);
    var add = $("ae-rc-add");
    if (add) add.disabled = S.rc.steps.length >= rcMax(S);
    S.dirty = true;
    S.sticky = false;
    scheduleCheck(ctx, S);
  }

  function insertInto(box, name) {
    if (!box) return;
    var ins = "{{" + name + "}}";
    var v = text(box.value);
    var a = typeof box.selectionStart === "number" ? box.selectionStart : v.length;
    var b = typeof box.selectionEnd === "number" ? box.selectionEnd : v.length;
    box.value = v.slice(0, a) + ins + v.slice(b);
    try { box.focus(); box.setSelectionRange(a + ins.length, a + ins.length); } catch (e) { /* not every field can */ }
  }

  function rcClick(ctx, S, t) {
    var what = t.getAttribute("data-do") || t.id;
    var i = Number(t.getAttribute("data-i"));
    var steps = S.rc.steps;
    if (what === "rcvar" || what === "rcdvar") {
      var box = what === "rcdvar" ? $("ae-rc-desc") : ($(S.rcFocus) || $("ae-rc-s" + Math.max(0, steps.length - 1) + "-body"));
      insertInto(box, t.getAttribute("data-var"));
      S.dirty = true;
      scheduleCheck(ctx, S);
      return;
    }
    if (what === "ae-rc-add") {
      rcReadSteps(S);
      if (steps.length >= rcMax(S)) return;
      var step = rcNewStep(S);
      steps.push(step);
      steps.sort(function (a, b) { return text(a.at) < text(b.at) ? -1 : text(a.at) > text(b.at) ? 1 : 0; });
      rcRedrawSteps(ctx, S);
      var nb = $("ae-rc-s" + steps.indexOf(step) + "-subject");
      if (nb) { try { nb.focus(); } catch (e) { /* fine */ } }
      return;
    }
    if (what === "rcrm") {
      rcReadSteps(S);
      if (!steps[i] || steps[i].kind === "create") return;
      steps.splice(i, 1);
      rcRedrawSteps(ctx, S);
      return;
    }
    if (what === "rcup" || what === "rcdown") {
      /* two steps swap their words, channels and condition; the times stay
         where they are (and each step keeps its number) */
      rcReadSteps(S);
      var j = what === "rcup" ? i - 1 : i + 1;
      var a = steps[i], b = steps[j];
      if (!a || !b || a.kind === "create" || b.kind === "create") return;
      var aAt = a.at;
      a.at = b.at;
      b.at = aAt;
      steps[i] = b;
      steps[j] = a;
      rcRedrawSteps(ctx, S);
      return;
    }
    if (what === "ae-rc-loadproj") { S.rcProj = ""; rcProjects(ctx, S); return; }
    if (what === "ae-rc-preview") { rcPreview(ctx, S, t); return; }
    if (what === "ae-rc-histrefresh" || what === "rchist") { rcHistory(ctx, S); return; }
    if (what === "ae-rc-runnow") {
      if (S.dirty) { ctx.toast("Save your changes first — this makes the task from the saved agent.", { bad: true }); return; }
      ctx.press(t, function () {
        return ctx.act("recurring.run_now", { agent_id: text(S.agent.id) }, { text: "Making the task on My Tasks…" }).then(function (r) {
          if (!r) return null;
          ctx.toast(r.words || "Done.");
          return rcHistory(ctx, S);
        }, function () { /* the toast said why */ });
      }, "Making it…");
      return;
    }
    if (what === "rcdone") {
      var day = text(t.getAttribute("data-date"));
      ctx.press(t, function () {
        return ctx.act("recurring.mark_done", { agent_id: text(S.agent.id), date: day }).then(function (r) {
          if (!r) return null;
          ctx.toast(r.words || "Marked done.");
          return rcHistory(ctx, S);
        }, function () { /* the toast said why */ });
      }, "Marking…");
    }
  }

  /* The project picker, filled from the portal through the DCR server the
     first time the pane opens; the saved project stays picked, and with
     none saved A074 (DCR Office) is. */
  function rcProjects(ctx, S) {
    var note = $("ae-rc-projnote");
    if (S.rcProj === "busy") return Promise.resolve(null);
    if (!ctx.has("recurring.projects")) {
      if (note) note.textContent = "The DCR server cannot list the projects yet — update DCR Agents there.";
      return Promise.resolve(null);
    }
    S.rcProj = "busy";
    if (note) note.textContent = "Loading the projects from the portal…";
    return ctx.rpc("recurring.projects", {}, { quiet: true }).then(function (d) {
      if (S !== currentS()) return;
      S.rcProj = "done";
      var rows = ((d && d.projects) || []).filter(function (p) { return p && text(p.id); });
      S.rcProjects = rows;
      rows.forEach(function (p) { S.rcProjMap[text(p.id)] = { id: text(p.id), code: text(p.code), label: text(p.label) }; });
      var sel = $("ae-rc-project");
      var keep = sel ? text(sel.value) : "";
      var picked = false;
      if (!keep && d && text(d.default) && S.rcProjMap[text(d.default)]) { keep = text(d.default); picked = true; }
      if (sel) sel.innerHTML = rcProjectOptions(S, keep);
      var n = $("ae-rc-projnote");
      var active = rows.filter(function (p) { return p.active; }).length;
      if (n) n.textContent = plural(rows.length, "project") + " from the portal, " + active + " active." +
        (picked ? " A074 DCR Office is picked — office tasks live there." : "");
      if (picked) { S.dirty = true; scheduleCheck(ctx, S); }
    }, function (e) {
      if (S !== currentS()) return;
      S.rcProj = "";
      var n = $("ae-rc-projnote");
      if (n) n.textContent = "Could not load the projects (" + text(e.message) + ") — Load projects tries again.";
    });
  }

  function rcHistory(ctx, S) {
    var box = $("ae-rc-history");
    if (!box || S.isNew) return Promise.resolve(null);
    if (!ctx.has("recurring.history")) {
      box.innerHTML = '<p class="c-help">The DCR server cannot show this history yet — update DCR Agents there.</p>';
      return Promise.resolve(null);
    }
    return ctx.rpc("recurring.history", { agent_id: text(S.agent.id), limit: 12 }, { quiet: true }).then(function (h) {
      if (S !== currentS()) return;
      S.rcHist = h || {};
      rcDrawHistory(ctx, S);
    }, function (e) {
      if (S !== currentS()) return;
      var b = $("ae-rc-history");
      if (b) {
        b.innerHTML = '<div class="c-error" role="alert"><b>The history could not be read.</b><span>' + esc(e.message) + "</span>" +
          '<div class="c-actions"><button type="button" class="c-btn ghost sm" data-do="rchist">Try again</button></div></div>';
      }
    });
  }

  function rcDrawHistory(ctx, S) {
    var h = S.rcHist || {}, box = $("ae-rc-history");
    if (!box) return;
    var occ = Array.isArray(h.occurrences) ? h.occurrences : [];
    var words = rcRunWords(S);
    box.innerHTML = '<p class="ca-rc-nextline">' + esc(h.next && h.next.text ? "Next: " + h.next.text
        : S.agent.enabled ? "Nothing ahead — the repeat matches no day in the next year." : "Off — turn it on (What) to run.") + "</p>" +
      '<div class="c-actions">' +
        (h.can_run_now ? '<button type="button" class="c-btn sm" id="ae-rc-runnow" data-act data-method="recurring.run_now">' + esc(words) + "</button>"
          : '<button type="button" class="c-btn sm" id="ae-rc-runnow" disabled>' + esc(words) + "</button>") +
        '<button type="button" class="c-btn ghost sm" id="ae-rc-histrefresh">Refresh</button></div>' +
      (!h.can_run_now && h.run_now_words ? '<p class="c-help" id="ae-rc-runwhy">' + esc(h.run_now_words) + "</p>" : "") +
      (occ.length ? occ.map(function (o) { return rcOccHtml(ctx, S, o); }).join("") : ctx.ui.empty("No days yet — the first one shows here once it runs."));
  }

  /* A history stamp on the DCR server's own clock (the company's zone, as
     the ISO string carries it — not this browser's): "6:00 am" on the
     day itself, "Tue, Oct 13, 9:10 am" on another. */
  function rcStamp(ctx, iso, day) {
    var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(text(iso));
    if (!m) return ctx.ui.when(iso);
    return (m[1] === text(day) ? "" : ctx.ui.day(m[1]) + ", ") + rcTimeWords(m[2]);
  }

  function rcOccHtml(ctx, S, o) {
    var bits = [];
    if (o.created_at) bits.push("made " + rcStamp(ctx, o.created_at, o.date) + (o.created_by === "by hand" ? " by hand" : ""));
    if (o.completed_at) {
      bits.push("done " + rcStamp(ctx, o.completed_at, o.date) + (o.completed_by ? " by " + text(o.completed_by) : "") +
        (o.completed_how ? " (" + text(o.completed_how) + ")" : ""));
    }
    if (o.info_source) bits.push(o.info_source === "claude" ? "useful information by Claude" : "useful information: the plain summary");
    var link = ctx.ui.href(o.link);
    var steps = o.steps || [];
    /* a day that was never made: its note says so once, not once per step */
    var quiet = o.outcome === "missed" && steps.every(function (s) { return s.outcome === "not_sent"; });
    return '<div class="ca-occ" data-date="' + esc(o.date) + '">' +
      '<div class="ca-occ-head"><span class="ca-occ-day">' + esc(o.date_text || o.date) + "</span> " + ctx.ui.chip(text(o.outcome_words || o.status), RC_TONES[o.outcome] || "dim") +
        (link ? ' <a class="ca-occ-link" href="' + esc(link) + '" target="_blank" rel="noopener">Open the task</a>' : "") + "</div>" +
      (bits.length ? '<div class="ca-meta"' + (o.info_why ? ' title="' + esc("Claude did not write it: " + o.info_why) + '"' : "") + ">" +
        esc(bits.join(" · ")) + "</div>" : "") +
      (o.note ? '<div class="ca-meta">' + esc(o.note) + "</div>" : "") +
      (quiet ? "" : '<ol class="ca-occ-steps">' + steps.map(function (s) {
        return '<li class="ca-occ-step' + (/^[a-z_]+$/.test(text(s.outcome)) ? " " + s.outcome : "") + '"><span class="ca-occ-at">' + esc(rcTimeWords(s.at)) + "</span>" +
          '<span class="ca-occ-label">' + esc(rcStepLabel(S, s)) + '</span><span class="ca-occ-words">' + esc(s.words) + "</span></li>";
      }).join("") + "</ol>") +
      (o.can_mark_done ? '<div class="c-actions"><button type="button" class="c-btn ghost sm" data-do="rcdone" data-date="' + esc(o.date) +
        '" data-act data-method="recurring.mark_done">Mark this one done</button></div>' : "") +
      "</div>";
  }

  function rcPreview(ctx, S, btn) {
    var b = build(S);
    var box = $("ae-rc-info");
    if (b.problems.length) { showProblems(b.problems, "bad"); return Promise.resolve(null); }
    if (box) box.innerHTML = "";
    var claude = !!(b.agent.recurring && b.agent.recurring.info && b.agent.recurring.info.claude);
    var done = ctx.busy(box, claude ? "Writing it — Claude can take a minute or two…" : "Writing it…");
    return ctx.press(btn, function () {
      return ctx.rpc("recurring.preview_info", { agent: b.agent }, { quiet: true }).then(function (p) {
        done();
        p = p || {};
        if (!box) return;
        var day = p.day ? ctx.ui.day(p.day) : "today";
        var words = p.source === "claude" ? "Written by Claude, as it would go on " + day + ". Nothing was saved or sent."
          : "The plain summary, as it would go on " + day + (p.why ? " — Claude did not write it: " + text(p.why) + "." : ".");
        box.innerHTML = '<div class="ca-rc-prev"><p class="ca-rc-prevnote' + (p.source === "claude" ? " good" : "") + '">' + esc(words) + "</p>" +
          '<pre class="ca-rc-text">' + esc(p.text) + "</pre>" +
          ((p.notes || []).length ? '<p class="c-help">' + esc("Claude's notes: " + p.notes.join(" · ")) + "</p>" : "") +
          ((p.sources || []).length ? '<p class="c-help">' + esc("From: " + p.sources.join(", ")) + "</p>" : "") + "</div>";
      }, function (e) {
        done();
        if (e.code === "refused") { S.sticky = true; showProblems(splitProblems(e.message), "bad"); }
        else if (box) box.innerHTML = ctx.ui.failed(e, { retry: false, title: "Preview failed." });
      });
    }, "Writing…");
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
      splitProblems: splitProblems, rcTimeWords: rcTimeWords, rcStepLabel: function (s) { return rcStepLabel(S || {}, s); } };
  }
})();
