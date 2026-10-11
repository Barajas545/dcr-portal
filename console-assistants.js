/* DCR Agents web console — the Assistants tab (console-spec §6.1.10, §6.4).

   The desktop's Assistants tab, from any admin's phone or desk: every
   employee with a portal account and their personal assistant — on or off
   (one at a time, or for everyone with an account), their conversation
   (read only, and only while the office may read it — "Teach from this…"
   opens the Training Coach on them with the message in its box), their
   reminders, to-dos and events with "Add for them…", the office's notes
   about them (Training rules in the scope employee:<name>), the briefings
   ("Send tomorrow's briefing now"), the assistant's log, "Ask as this
   employee" (a private test: nothing reaches the employee) and the
   settings for every assistant.

   Everything runs on the DCR server computer through the shell's relay
   (ctx.rpc / ctx.act, agents-console.js): this page only draws what the
   server answers — its words are the desktop's own (assistant/views.py) —
   and every question before a change is the server's, shown by ctx.act.
   Every string from the server goes through ctx.esc; links are relative
   (#/…) and built from encodeURIComponent. Write controls carry data-act
   (greyed while nothing can be changed) and data-method (greyed when the
   server's DCR Agents does not have that yet). Nothing is kept between
   visits except the Coach draft handed to the Training tab
   (sessionStorage, this browser tab only). */
(function () {
  "use strict";
  if (!window.DCRConsole || typeof window.DCRConsole.register !== "function") return;

  var TAB = "assistants";
  var VIEWS = [["conversation", "Conversation"], ["items", "Reminders & events"], ["notes", "Office notes"],
    ["briefings", "Briefings"], ["log", "Log"], ["ask", "Ask as (private test)"]];
  var FILTERS = [["all", "Everyone with an account"], ["on", "Assistants on"], ["off", "Assistants off"]];
  /* The Training tab's Coach box keeps its draft here, per scope
     (console-training.js reads the same key). */
  var DRAFT_PREFIX = "dcr.console.training.draft.v1:";
  var OLD_MS = 60000;            // a list or a page older than this is asked for again on the next visit
  var NOTE_MAX = 500;            // a note is a Training rule: one line, at most 500 characters
  var KINDS = [["event", "Event", "On their calendar, with a reminder before it."],
    ["reminder", "Reminder", "A push to their phone at the time — once."],
    ["todo", "To-do", "On their list until they tick it — no push."]];
  var PLACEHOLDERS = { event: "e.g. Truss delivery at A068 — be on site", reminder: "e.g. Call the lumber yard about Friday",
    todo: "e.g. Sign the new safety sheet" };
  var REMIND = [[0, "At the start"], [15, "15 minutes before"], [30, "30 minutes before"], [60, "1 hour before"],
    [120, "2 hours before"], [240, "4 hours before"], [1440, "A day before"]];
  /* The server's tones, in the shell's chip and banner words. */
  var TONES = { green: "good", amber: "warn", red: "bad", grey: "", blue: "info", purple: "purple" };

  /* Module state. The shell gives render() a fresh, empty element each
     time the route enters the tab; the answers below outlive it so moving
     between employees and pages does not ask the server again each time.
     `gen` goes up on every render and leave: an answer that arrives for a
     page no longer on screen is not drawn. */
  var S = {
    ctx: null, el: null, gen: 0,
    list: null, listAt: 0, filter: "all",
    emp: null, empAt: 0,
    settings: null,
    asks: {},                    // folded name → the private test's turns, this page only (like the desktop dialog)
    itemOpen: false, kind: "event",
    name: "", view: "",
  };

  /* ── small helpers ──────────────────────────────────────────────────── */

  function esc(v) { return S.ctx && S.ctx.esc ? S.ctx.esc(v) : window.DCR.esc(v); }
  function fold(v) { return String(v == null ? "" : v).toLowerCase().replace(/\s+/g, " ").trim(); }
  function $(id) { return document.getElementById(id); }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function enc(v) { return encodeURIComponent(String(v == null ? "" : v)); }
  function href(name, view) { return "#/" + TAB + (name ? "/" + enc(name) : "") + (view ? "?view=" + enc(view) : ""); }
  function decodePart(p) {
    var s = String(p == null ? "" : p);
    if (!/%[0-9A-Fa-f]{2}/.test(s)) return s;
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }
  function toneOf(t) { return Object.prototype.hasOwnProperty.call(TONES, t) ? TONES[t] : ""; }
  function chip(text, t) { return text ? '<span class="c-chip' + (toneOf(t) ? " " + toneOf(t) : "") + '">' + esc(text) + "</span>" : ""; }
  function pair(v) { return Array.isArray(v) ? v : ["", "grey"]; }
  /* The shell greys a control whose method this server's build lacks. */
  function need(method) { return ' data-method="' + esc(method) + '"'; }
  function when(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return "";
    var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return days[d.getDay()] + " " + months[d.getMonth()] + " " + d.getDate() + " " +
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function first(r) { return (r && (r.first || String(r.name || "").split(" ")[0])) || ""; }
  function errText(e) { return (e && e.message) || "Something went wrong on the way to the DCR server."; }
  function storage() { try { return window.sessionStorage || null; } catch (e) { return null; } }
  function draftGet(scope) { var s = storage(); try { return (s && s.getItem(DRAFT_PREFIX + scope)) || ""; } catch (e) { return ""; } }
  function draftSet(scope, text) { var s = storage(); try { if (s) s.setItem(DRAFT_PREFIX + scope, text); } catch (e) { /* private window */ } }
  function bad(words) { return /^could not|paused/i.test(String(words || "")); }

  /* A request for this page, quiet: the page says what went wrong itself. */
  function ask(method, args, opts) {
    var o = opts || {};
    o.quiet = true;
    return S.ctx.rpc(method, args || {}, o);
  }
  /* A change that may need the server's question first (C / C?); the shell
     toasts a refusal. */
  function act(method, args, opts) { return S.ctx.act(method, args || {}, opts || {}); }
  /* A button that is working ("Working…", greyed) until fn settles. */
  function press(btn, fn, words) {
    if (S.ctx.press && btn) return S.ctx.press(btn, fn, words);
    return Promise.resolve().then(fn);
  }
  function live(g) { return g === S.gen; }
  function toast(text, isBad) { if (S.ctx && S.ctx.toast) S.ctx.toast(text, { bad: !!isBad }); }
  /* The sentence under the header (the desktop's note line). Off this page
     it goes to a toast so it is not lost. */
  function say(text, isBad, g) {
    var n = $("casSay");
    if (n && (g === undefined || live(g))) {
      n.textContent = text || "";
      n.className = "cas-say" + (isBad ? " bad" : "");
    } else if (text) {
      toast(text, isBad);
    }
  }
  function lock(input, on) { if (input && "disabled" in input) input.disabled = !!on; }
  function failed(e, retry) {
    if (S.ctx.ui && S.ctx.ui.failed) return S.ctx.ui.failed(e);
    return '<div class="c-error" role="alert"><b>That did not work.</b><span>' + esc(errText(e)) + '</span><div class="c-actions">' +
      '<button type="button" class="c-btn ghost sm" data-cas="' + esc(retry) + '">Try again</button></div></div>';
  }

  /* ── styles: the shell's vocabulary (agents-console.css) plus this tab's
     own layout — the list beside the page, the chat, items and notes ──── */

  var CSS = [
    ".cas{--cas-purple:#6a48b5;--cas-purple-bg:rgba(107,75,184,.13);--cas-mine:#2f80d8;}",
    "@media (prefers-color-scheme: dark){:root:not([data-theme=\"light\"]) .cas{--cas-purple:#c3aef5;--cas-purple-bg:rgba(160,130,240,.17);--cas-mine:#2a6fb8;}}",
    ":root[data-theme=\"dark\"] .cas{--cas-purple:#c3aef5;--cas-purple-bg:rgba(160,130,240,.17);--cas-mine:#2a6fb8;}",
    ".cas .c-chip.purple{background:var(--cas-purple-bg);color:var(--cas-purple);}",
    ".cas .c-field > label.c-check{display:inline-flex;align-items:center;gap:9px;margin:0 0 4px;}",
    ".cas input[type=checkbox],.cas input[type=radio]{width:22px;height:22px;padding:0;margin:0;accent-color:var(--acc);flex:none;}",
    ".cas-grid{display:grid;gap:16px;grid-template-columns:minmax(0,1fr);align-items:start;}",
    "@media (min-width:900px){.cas-grid{grid-template-columns:300px minmax(0,1fr);}.cas-back{display:none;}",
    ".cas-side{position:sticky;top:8px;max-height:calc(100vh - 16px);overflow:auto;padding:1px 3px 2px 1px;}}",
    "@media (max-width:899px){.cas-grid.has-detail .cas-side{display:none;}.cas-grid:not(.has-detail) .cas-main{display:none;}}",
    ".cas-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px;}",
    ".cas-filter{display:block;margin:4px 0 10px;}.cas-filter select{min-height:44px;font-size:16px;}",
    ".cas-list{list-style:none;margin:0;padding:0;}",
    ".cas-row{display:block;min-height:44px;padding:9px 12px;margin:0 0 6px;border:1px solid var(--border);border-radius:12px;",
    "background:var(--surface);color:var(--text);text-decoration:none;}",
    ".cas-row:hover{border-color:var(--acc);}.cas-row:focus-visible{outline:2px solid var(--acc);outline-offset:2px;}",
    ".cas-row.sel{border-color:var(--acc);box-shadow:0 0 0 2px var(--tint-2);}",
    ".cas-row-top{display:flex;align-items:center;justify-content:space-between;gap:8px;}",
    ".cas-row b{overflow-wrap:anywhere;}.cas-row .sub{display:block;font-size:13px;color:var(--text-muted);overflow-wrap:anywhere;}",
    ".cas-row.settings{background:var(--surface-2);}",
    ".cas-wide{width:100%;margin-top:6px;}",
    ".cas-back{margin:0 0 4px;}.cas-back a{display:inline-flex;align-items:center;min-height:44px;font-weight:700;text-decoration:none;color:var(--acc-text);}",
    ".cas-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;}",
    ".cas-head h2{margin:0;font-size:21px;line-height:1.25;overflow-wrap:anywhere;}",
    ".cas .c-actions{margin:10px 0 0;}",
    ".cas-refresh{margin-left:auto;}",
    "@media (max-width:640px){.cas-acts{display:grid;grid-template-columns:1fr 1fr;}.cas-acts > .c-btn{width:100%;}}",
    ".cas .c-banner{margin:10px 0 0;}",
    ".cas-say{margin:10px 0 0;font-size:14px;font-weight:700;color:var(--good);overflow-wrap:anywhere;}.cas-say:empty{display:none;}",
    ".cas-say.bad{color:var(--bad);}",
    ".cas-tabs{display:flex;gap:2px;overflow-x:auto;overflow-y:hidden;margin:12px 0;border-bottom:1px solid var(--border);scrollbar-width:thin;}",
    ".cas-tab{display:inline-flex;align-items:center;min-height:44px;padding:8px 12px;white-space:nowrap;color:var(--text-muted);",
    "text-decoration:none;font-weight:700;font-size:14px;border-bottom:3px solid transparent;margin-bottom:-1px;}",
    ".cas-tab:hover{color:var(--text);}.cas-tab[aria-current=page]{color:var(--text);border-bottom-color:var(--acc);}",
    ".cas-note{margin:8px 0;color:var(--text-muted);font-size:13.5px;overflow-wrap:anywhere;}",
    ".cas-chat{list-style:none;margin:0;padding:4px 2px;display:flex;flex-direction:column;gap:12px;max-height:64vh;overflow:auto;}",
    ".cas-msg{display:flex;flex-direction:column;max-width:88%;align-self:flex-start;}",
    ".cas-msg.user{align-self:flex-end;align-items:flex-end;}",
    ".cas-meta{font-size:12px;font-weight:700;color:var(--text-muted);margin:0 4px 2px;}",
    ".cas-bubble{padding:9px 12px;border-radius:14px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;",
    "background:var(--surface);border:1px solid var(--border);border-bottom-left-radius:4px;}",
    ".cas-msg.user .cas-bubble{background:var(--cas-mine);color:#fff;border-color:transparent;border-bottom-left-radius:14px;border-bottom-right-radius:4px;}",
    ".cas-msg.office .cas-bubble{border-left:4px solid var(--warn);}",
    ".cas-msg > .cas-teach{align-self:flex-start;min-height:30px;padding:2px 4px;font-size:12.5px;font-weight:600;}",
    ".cas-msg.user > .cas-teach{align-self:flex-end;}",
    "@media (max-width:640px){.cas-chat{max-height:none;overflow:visible;}}",
    "@media (pointer: coarse), (max-width:640px){.cas-msg > .cas-teach{min-height:44px;}}",
    ".cas-cards{list-style:none;margin:4px 0 0;padding:0;font-size:13px;color:var(--text-muted);}",
    ".cas-cards li{padding:4px 10px;margin-top:3px;border-radius:9px;background:var(--surface-2);overflow-wrap:anywhere;}",
    ".cas-items,.cas-notes{list-style:none;margin:0;padding:0;}",
    ".cas-item{padding:10px 12px;margin:0 0 8px;border:1px solid var(--border);border-radius:12px;background:var(--surface);}",
    ".cas-item.done .cas-itext{color:var(--text-muted);text-decoration:line-through;}",
    ".cas-item-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;}",
    ".cas-itext{font-weight:700;overflow-wrap:anywhere;}",
    ".cas-imeta,.cas-iloc{font-size:13px;color:var(--text-muted);overflow-wrap:anywhere;white-space:pre-wrap;margin-top:2px;}",
    ".cas-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0;}",
    ".cas-bar .grow{flex:1 1 220px;margin:0;}",
    ".cas .c-card h3{margin:0 0 4px;}",
    ".cas-kinds{display:flex;flex-wrap:wrap;gap:4px 18px;margin:6px 0 0;padding:0;border:0;}",
    ".cas-two{display:grid;gap:0 12px;grid-template-columns:minmax(0,1fr);}@media (min-width:560px){.cas-two{grid-template-columns:1fr 1fr;}}",
    ".cas-err{margin:4px 0 0;color:var(--bad);font-weight:700;font-size:14px;overflow-wrap:anywhere;}.cas-err:empty{display:none;}",
    ".cas-ft{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;margin-top:12px;}",
    ".cas-ft .grow{flex:1 1 180px;color:var(--text-muted);font-size:13px;}",
    ".cas-noterow{display:flex;gap:10px;align-items:flex-start;padding:8px 12px;margin:0 0 8px;border:1px solid var(--border);",
    "border-radius:12px;background:var(--surface);}",
    ".cas-noterow.off .cas-ntext{color:var(--text-muted);}",
    ".cas-on{display:flex;align-items:center;justify-content:center;min-width:36px;min-height:44px;margin:0;cursor:pointer;}",
    ".cas-nbody{flex:1 1 auto;min-width:0;padding-top:10px;}.cas-ntext{overflow-wrap:anywhere;}",
    ".cas-ntools{display:flex;gap:2px 12px;flex-wrap:wrap;font-size:12.5px;color:var(--text-muted);align-items:center;}",
    ".cas-pair{display:inline-flex;gap:12px;white-space:nowrap;}",
    ".cas-brief{margin:0 0 8px;border:1px solid var(--border);border-radius:12px;background:var(--surface);}",
    ".cas-brief summary{cursor:pointer;padding:10px 12px;min-height:44px;font-weight:700;overflow-wrap:anywhere;}",
    ".cas-brief summary .c-muted{font-weight:400;font-size:13px;}",
    ".cas-brief pre{margin:0;padding:10px 12px 12px;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:14px;border-top:1px solid var(--border);}",
    ".cas-extra{margin:4px 0 0;padding-left:18px;font-size:13px;color:var(--text-muted);}",
    ".cas-test .cas-msg{max-width:100%;}",
    ".cas .c-field input[type=datetime-local]{min-height:44px;font-size:16px;color-scheme:light dark;}",
  ].join("\n");

  function ensureStyle() {
    if (!document.getElementById || document.getElementById("casStyle")) return;
    if (!document.createElement || !document.head) return;
    var st = document.createElement("style");
    st.id = "casStyle";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ── the tab ───────────────────────────────────────────────────────── */

  function render(el, ctx) {
    S.gen += 1;
    S.ctx = ctx;
    S.el = el;
    var route = ctx.route || {};
    var parts = route.parts || [];
    var q = route.query || {};
    var name = parts.length ? decodePart(parts[0]) : "";
    if (fold(name) !== fold(S.name)) S.itemOpen = false;
    S.name = name;
    S.view = String(q.view || "");
    if (S.name && !VIEWS.some(function (v) { return v[0] === S.view; })) S.view = "conversation";
    if (!S.name && S.view !== "settings") S.view = "";
    if (S.view !== "items") S.itemOpen = false;
    ensureStyle();
    var detail = !!S.name || S.view === "settings";
    el.innerHTML = '<div class="cas" id="casRoot"><div class="cas-grid' + (detail ? " has-detail" : "") + '">' +
      '<aside class="cas-side" id="casSide" aria-label="Employees">' + skeleton() + "</aside>" +
      '<section class="cas-main" id="casMain">' + (detail ? skeleton() : pickHint()) + "</section></div></div>";
    el.addEventListener("click", onClick);
    el.addEventListener("change", onChange);
    el.addEventListener("submit", onSubmit);
    if (ctx.guard) ctx.guard(unsaved);
    var g = S.gen;
    var jobs = [loadList(g, false)];
    if (S.name) jobs.push(loadEmployee(g, false));
    else if (S.view === "settings") jobs.push(loadSettings(g));
    return Promise.all(jobs).then(function () {});
  }

  function leave() { S.gen += 1; }

  /* What leaving would lose: an "Add for them" with words typed in it. */
  function unsaved() {
    var t = $("casItText");
    return S.itemOpen && t && String(t.value || "").trim() ? "The item for " + first(S.emp && S.emp.row) + " has not been added yet." : "";
  }

  function skeleton() { return '<div class="c-skel"></div><div class="c-skel"></div><div class="c-skel"></div>'; }
  function pickHint() {
    return '<div class="c-empty">Pick an employee to see their assistant — the conversation, their reminders and events, ' +
      "the office's notes and the briefings — or “Settings for every assistant”.</div>";
  }
  function trimmedNote(d) {
    var t = d && Array.isArray(d.trimmed) ? d.trimmed : [];
    if (!t.length) return "";
    var seen = [];
    t.forEach(function (x) { if (seen.indexOf(x) < 0) seen.push(x); });
    return '<p class="cas-note">To keep this page small the DCR server left out the oldest of: ' + esc(seen.join(", ")) + ".</p>";
  }

  /* ── the list on the left ──────────────────────────────────────────── */

  function loadList(g, force) {
    if (S.list && !force && Date.now() - S.listAt < OLD_MS) { drawSide(); return Promise.resolve(); }
    var had = S.list;
    if (had && !force) drawSide();
    return ask("assistants.list", {}).then(function (d) {
      var changed = !had || JSON.stringify(had) !== JSON.stringify(d);
      S.list = d;
      S.listAt = Date.now();
      if (live(g) && (force || changed || !$("casSide") || !$("casFilter"))) drawSide();
    }, function (e) {
      if (!live(g)) return;
      var side = $("casSide");
      if (side && !S.list) side.innerHTML = failed(e, "reload-list");
    });
  }

  function rowsShown() {
    var rows = (S.list && S.list.rows) || [];
    if (S.filter === "on") return rows.filter(function (r) { return r.on; });
    if (S.filter === "off") return rows.filter(function (r) { return !r.on; });
    return rows;
  }

  function drawSide() {
    var side = $("casSide");
    if (!side || !S.list) return;
    var d = S.list;
    var counts = d.counts || { on: 0, waiting: 0 };
    var ai = d.ai || {};
    var agent = pair(d.agent_words), poll = pair(d.poll_words);
    var rows = rowsShown();
    var sel = fold(S.name);
    side.innerHTML = '<div class="cas-chips">' +
      chip(plural(counts.on || 0, "assistant") + " on", counts.on ? "green" : "grey") +
      chip((counts.waiting || 0) + " waiting for an answer", counts.waiting ? "amber" : "grey") + "</div>" +
      '<div class="cas-chips">' + chip((ai.ok ? "● " : "") + (ai.words || ""), ai.ok ? "green" : "amber") +
      chip(agent[0], agent[1]) + chip(poll[0], poll[1]) + (d.dry_run ? chip("Dry run", "blue") : "") + "</div>" +
      '<label class="cas-filter"><span class="c-sr">Show</span><select id="casFilter" data-cas="filter" aria-label="Show">' +
      FILTERS.map(function (f) {
        return '<option value="' + f[0] + '"' + (S.filter === f[0] ? " selected" : "") + ">" + esc(f[1]) + "</option>";
      }).join("") + "</select></label>" +
      '<ul class="cas-list">' +
      '<li><a class="cas-row settings' + (S.view === "settings" && !S.name ? " sel" : "") + '" href="' + esc(href("", "settings")) + '">' +
      '<b>Settings for every assistant</b><span class="sub">Briefing times · model · checks · limits · privacy</span></a></li>' +
      rows.map(function (r) {
        var c = pair(r.chip);
        var on = fold(r.name) === sel;
        return '<li><a class="cas-row' + (on ? " sel" : "") + '" href="' + esc(href(r.name)) + '"' + (on ? ' aria-current="page"' : "") +
          '><span class="cas-row-top"><b>' + esc(r.name) + "</b>" + chip(c[0], c[1]) + '</span><span class="sub">' + esc(r.subtitle) +
          "</span></a></li>";
      }).join("") +
      (rows.length ? "" : '<li class="c-empty">' + (S.filter === "all"
        ? "Nobody here — employees with a portal account show up once People has been read from the portal."
        : "Nobody here — try “Everyone with an account”.") + "</li>") +
      "</ul>" +
      '<button type="button" class="c-btn ghost cas-wide" data-cas="all-on" data-act' + need("assistants.set_on") +
      (d.can_turn_on_all ? "" : " disabled") +
      ' title="Every active employee with a portal account whose assistant is off">Turn on for everyone with an account</button>';
  }

  /* ── one employee ──────────────────────────────────────────────────── */

  /* A page more than a minute old is drawn at once from what is here and
     asked for again; it is drawn a second time only if the answer changed
     (always after a change of ours, `force`). */
  function loadEmployee(g, force) {
    var same = S.emp && fold(S.emp.row && S.emp.row.name) === fold(S.name);
    if (same && !force && Date.now() - S.empAt < OLD_MS) { drawMain(); return Promise.resolve(); }
    if (same && !force) drawMain();
    var name = S.name;
    return ask("assistants.employee", { name: name }).then(function (d) {
      if (fold(name) !== fold(S.name)) return;
      var changed = !same || JSON.stringify(S.emp) !== JSON.stringify(d);
      S.emp = d;
      S.empAt = Date.now();
      if (live(g) && (force || changed)) drawMain();
    }, function (e) {
      if (!live(g)) return;
      var main = $("casMain");
      if (main) main.innerHTML = backLink() + failed(e, "reload-emp");
    });
  }

  function backLink() { return '<div class="cas-back"><a href="' + esc(href("")) + '">‹ All assistants</a></div>'; }

  /* What was typed on the page (the private test's box, "Add for them"),
     kept across a redraw. */
  var TYPED = ["casAskText", "casItText", "casItAt", "casItHasEnd", "casItEnd", "casItRemind", "casItHasDue", "casItDue", "casItLoc", "casItNotes"];
  function typed() {
    var out = {};
    TYPED.forEach(function (id) { var n = $(id); if (n) out[id] = { value: n.value, checked: !!n.checked }; });
    return out;
  }
  function retype(saved) {
    Object.keys(saved).forEach(function (id) {
      var n = $(id);
      if (!n) return;
      n.value = saved[id].value;
      if (n.type === "checkbox") {
        n.checked = saved[id].checked;
        var dep = $(id === "casItHasEnd" ? "casItEnd" : id === "casItHasDue" ? "casItDue" : "");
        if (dep) dep.disabled = !n.checked;
      }
    });
  }

  function drawMain() {
    var main = $("casMain");
    var d = S.emp;
    if (!main || !d) return;
    var saved = typed();
    var r = d.row || {};
    var c = pair(r.chip);
    var can = d.can || {};
    var fn = first(r);
    var nt = d.notice && d.notice.text ? '<div class="c-banner ' + (toneOf(d.notice.tone) || "info") + '"><span>' + esc(d.notice.text) + "</span></div>" : "";
    main.innerHTML = backLink() +
      '<div class="cas-head"><h2 id="casTitle">' + esc(r.name) + "</h2>" + chip(c[0], c[1]) +
      '<button type="button" class="c-btn ghost sm cas-refresh" data-cas="reload-emp">Refresh</button></div>' +
      '<p class="c-sub">' + esc(d.subtitle) + "</p>" + nt +
      '<div class="c-actions cas-acts">' +
      '<a class="c-btn ghost sm" href="' + esc(href(r.name, "ask")) + '" title="A test chat with their assistant: nothing is written to their chat and nothing is sent">Ask as this employee…</a>' +
      '<button type="button" class="c-btn ghost sm" data-cas="briefing" data-kind="evening" data-act' + need("assistants.briefing.send") +
      (can.briefing ? "" : " disabled") + ">Send tomorrow's briefing now</button>" +
      '<button type="button" class="c-btn ghost sm" data-cas="briefing" data-kind="weekly" data-act' + need("assistants.briefing.send") +
      (can.briefing ? "" : " disabled") + ">Send next week's briefing now</button>" +
      '<button type="button" class="c-btn sm' + (r.on ? " ghost danger" : "") + '" data-cas="toggle" data-act' + need("assistants.set_on") +
      (can.toggle ? "" : " disabled") + ">" + (r.on ? "Turn off" : "Turn on") + "</button></div>" +
      '<p class="cas-say" id="casSay" aria-live="polite"></p>' +
      '<nav class="cas-tabs" aria-label="' + esc(fn) + '\'s assistant">' + VIEWS.map(function (v) {
        return '<a class="cas-tab" href="' + esc(href(r.name, v[0])) + '"' + (S.view === v[0] ? ' aria-current="page"' : "") + ">" + esc(v[1]) + "</a>";
      }).join("") + "</nav>" +
      '<div id="casView">' + viewHtml(d) + "</div>" + trimmedNote(d);
    retype(saved);
    if (S.view === "conversation") {
      var chat = $("casChat");
      if (chat && "scrollTop" in chat) chat.scrollTop = chat.scrollHeight || 0;
    }
  }

  function viewHtml(d) {
    switch (S.view) {
      case "items": return itemsHtml(d);
      case "notes": return notesHtml(d);
      case "briefings": return briefingsHtml(d);
      case "log": return logHtml(d);
      case "ask": return askHtml(d);
      default: return conversationHtml(d);
    }
  }

  /* The conversation: read only. */
  function conversationHtml(d) {
    var fn = first(d.row);
    if (d.conversation === null || d.conversation === undefined) return '<div class="c-empty">' + esc(d.hidden || "") + "</div>";
    if (!d.conversation.length) return '<div class="c-empty">' + esc(d.empty || "No messages yet.") + "</div>";
    var teach = !!d.notes_scope;
    return '<p class="cas-note">Read-only. “Teach from this…” under a message opens the Coach in Training on ' + esc(fn) +
      " with the message in its box — say what the assistant should have said or known.</p>" +
      '<ol class="cas-chat" id="casChat">' + d.conversation.map(function (m, i) {
        var role = /^(user|assistant|office)$/.test(m.role) ? m.role : "assistant";
        var cards = (m.cards_words || []).map(function (w) { return "<li>" + esc(w) + "</li>"; }).join("");
        return '<li class="cas-msg ' + role + '"><div class="cas-meta">' + esc(m.meta) + "</div>" +
          '<div class="cas-bubble">' + esc(m.text) + "</div>" + (cards ? '<ul class="cas-cards">' + cards + "</ul>" : "") +
          (teach ? '<button type="button" class="c-btn link cas-teach" data-cas="teach" data-i="' + i + '"' + need("training.coach.ask") +
            ">Teach from this…</button>" : "") + "</li>";
      }).join("") + "</ol>";
  }

  /* Reminders, to-dos and events, and "Add for them…". */
  function itemsHtml(d) {
    var fn = first(d.row);
    var items = d.items || [];
    var list = items.length ? '<ul class="cas-items">' + items.map(function (it) {
      var st = pair(it.status);
      var meta = [it.kind_words, it.when, it.by_words ? "added by " + it.by_words : ""].filter(Boolean).join(" · ");
      var loc = [it.location, it.notes].filter(Boolean).join("\n");
      return '<li class="cas-item' + (it.done ? " done" : "") + '"><div class="cas-item-top"><span class="cas-itext">' + esc(it.text) +
        "</span>" + chip(st[0], st[1]) + '</div><div class="cas-imeta">' + esc(meta) + "</div>" +
        (loc ? '<div class="cas-iloc">' + esc(loc) + "</div>" : "") + "</li>";
    }).join("") + "</ul>" : '<div class="c-empty">No reminders, to-dos or events yet.</div>';
    var can = (d.can || {}).add;
    return list + '<div class="cas-bar"><p class="grow cas-note">' + esc(d.items_note) + "</p>" +
      (S.itemOpen ? "" : '<button type="button" class="c-btn" data-cas="item-open" data-act' + need("assistants.item.add") +
        (can ? "" : ' disabled title="Turn ' + esc(fn) + '\'s assistant on first"') + ">Add for them…</button>") + "</div>" +
      (S.itemOpen ? itemForm(fn) : "");
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function localStamp(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); }

  function itemForm(fn) {
    var start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(7, 0, 0, 0);
    var end = new Date(start.getTime() + 3600000);
    var at = localStamp(start), to = localStamp(end), day = at.slice(0, 10);
    var k = S.kind || "event";
    var timed = k === "event" || k === "reminder";
    var kind = KINDS.filter(function (x) { return x[0] === k; })[0] || KINDS[0];
    return '<form class="c-card" id="casItemForm" novalidate><h3>Add for ' + esc(fn) + "</h3>" +
      '<p class="cas-note">It shows on ' + esc(fn) + "'s My Assistant page and reminds them like their own — except that an office " +
      "item waits for the quiet hours to end.</p>" +
      '<fieldset class="cas-kinds" aria-label="Kind">' + KINDS.map(function (x) {
        return '<label class="c-check" title="' + esc(x[2]) + '"><input type="radio" name="casKind" value="' + x[0] + '" data-cas="kind"' +
          (x[0] === k ? " checked" : "") + " /> " + esc(x[1]) + "</label>";
      }).join("") + "</fieldset>" +
      '<p class="c-help" id="casKindTip">' + esc(kind[2]) + "</p>" +
      '<div class="c-field"><label class="c-label" for="casItText">What</label>' +
      '<input type="text" id="casItText" maxlength="200" autocomplete="off" placeholder="' + esc(PLACEHOLDERS[k]) + '" /></div>' +
      '<div class="cas-two"><div class="c-field" id="casItTimed"' + (timed ? "" : " hidden") + '><label class="c-label" for="casItAt" id="casItAtLabel">' +
      (k === "event" ? "Starts" : "When") + '</label><input type="datetime-local" id="casItAt" value="' + at + '" /></div>' +
      '<div class="c-field" id="casItEndRow"' + (k === "event" ? "" : " hidden") + '><label class="c-check"><input type="checkbox" id="casItHasEnd" data-cas="has-end" /> Ends</label>' +
      '<input type="datetime-local" id="casItEnd" value="' + to + '" disabled aria-label="Ends" /></div></div>' +
      '<div class="c-field" id="casItRemindRow"' + (k === "event" ? "" : " hidden") + '><label class="c-label" for="casItRemind">Remind them</label><select id="casItRemind">' +
      REMIND.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === 30 ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") +
      "</select></div>" +
      '<div class="c-field" id="casItDueRow"' + (k === "todo" ? "" : " hidden") + '><label class="c-check"><input type="checkbox" id="casItHasDue" data-cas="has-due" /> Due</label>' +
      '<input type="date" id="casItDue" value="' + day + '" disabled aria-label="Due day" /></div>' +
      '<div class="c-field"><label class="c-label" for="casItLoc">Where</label><input type="text" id="casItLoc" maxlength="120" autocomplete="off" placeholder="e.g. A068 — 1234 El Camino Real" /></div>' +
      '<div class="c-field"><label class="c-label" for="casItNotes">Notes</label><textarea id="casItNotes" rows="3" maxlength="500" placeholder="Anything they should know (optional)"></textarea></div>' +
      '<p class="cas-err" id="casItErr" role="alert"></p>' +
      '<div class="cas-ft"><button type="button" class="c-btn ghost" data-cas="item-cancel">Cancel</button>' +
      '<button type="submit" class="c-btn" id="casItSave" data-act' + need("assistants.item.add") + ">Add for " + esc(fn) + "</button></div></form>";
  }

  function kindChanged(kind) {
    S.kind = kind;
    var timed = kind === "event" || kind === "reminder";
    var set = function (id, hidden) { var n = $(id); if (n) n.hidden = hidden; };
    set("casItTimed", !timed);
    set("casItEndRow", kind !== "event");
    set("casItRemindRow", kind !== "event");
    set("casItDueRow", kind !== "todo");
    var lab = $("casItAtLabel");
    if (lab) lab.textContent = kind === "event" ? "Starts" : "When";
    var t = $("casItText");
    if (t) t.setAttribute("placeholder", PLACEHOLDERS[kind] || "");
    var tip = $("casKindTip");
    var k = KINDS.filter(function (x) { return x[0] === kind; })[0];
    if (tip && k) tip.textContent = k[2];
  }

  /* The item as AssistantAgent.check_office_item takes it (the desktop's
     OfficeItemDialog.answer). */
  function itemValue() {
    var kind = S.kind || "event";
    var val = function (id) { var n = $(id); return n ? String(n.value || "").trim() : ""; };
    var on = function (id) { var n = $(id); return !!(n && n.checked); };
    var item = { kind: kind, text: val("casItText").replace(/\s+/g, " "), location: val("casItLoc").replace(/\s+/g, " "), notes: val("casItNotes") };
    if (kind === "event" || kind === "reminder") item.at = val("casItAt").slice(0, 16);
    if (kind === "event") {
      item.end = on("casItHasEnd") ? val("casItEnd").slice(0, 16) : "";
      var r = val("casItRemind");
      item.remind = r === "" ? 30 : Math.max(0, Math.min(1440, parseInt(r, 10) || 0));
    }
    if (kind === "todo") item.due = on("casItHasDue") ? val("casItDue").slice(0, 10) : "";
    return item;
  }

  function addItem(btn) {
    var d = S.emp;
    if (!d) return Promise.resolve();
    var r = d.row || {};
    var fn = first(r);
    var item = itemValue();
    var err = $("casItErr");
    var show = function (t) { if (err) err.textContent = t || ""; };
    if (!item.text) { show("Say what it is."); return Promise.resolve(); }
    if ((item.kind === "event" || item.kind === "reminder") && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(item.at)) {
      show("Give the day and time."); return Promise.resolve();
    }
    show("");
    var g = S.gen, name = r.name;
    /* The server checks it first, as the desktop's dialog does before it
       closes, so a typo is fixed here rather than lost. */
    return press(btn, function () {
      return ask("assistants.item.check", { name: name, item: item }, { text: "Checking it…" }).then(function () {
        return ask("assistants.item.add", { name: name, item: item }, { text: "Adding it to " + fn + "'s list…" });
      });
    }, "Adding…").then(function (res) {
      S.itemOpen = false;
      S.listAt = 0;                    // the list's "open items" count changed
      if (live(g)) return loadEmployee(g, true).then(function () { say(res.words, res.ok === false, g); });
      toast(res.words, res.ok === false);
    }, function (e) {
      if (live(g)) show(errText(e));
      else toast(errText(e), true);
    });
  }

  /* The office's notes: Training rules in employee:<name>. */
  function notesHtml(d) {
    var fn = first(d.row);
    var notes = d.notes || [];
    var list = notes.length ? '<ul class="cas-notes">' + notes.map(function (n) {
      return '<li class="cas-noterow' + (n.active ? "" : " off") + '"><label class="cas-on" title="Untick to keep the note but stop the assistant from using it">' +
        '<input type="checkbox" data-cas="note-on" data-id="' + esc(n.id) + '" data-act' + need("training.rule.update") + (n.active ? " checked" : "") +
        ' aria-label="The assistant uses this note" /></label><div class="cas-nbody"><div class="cas-ntext">' + esc(n.text) + "</div>" +
        '<div class="cas-ntools"><span>' + esc(when(n.created_at)) + "</span>" +
        '<span class="cas-pair"><button type="button" class="c-btn link" data-cas="note-edit" data-id="' + esc(n.id) + '" data-act' + need("training.rule.update") + ">Edit</button>" +
        '<button type="button" class="c-btn link" data-cas="note-del" data-id="' + esc(n.id) + '" data-act' + need("training.rule.delete") + ">Delete</button></span>" +
        "</div></div></li>";
    }).join("") + "</ul>" : '<div class="c-empty">No notes about ' + esc(fn) + " yet.</div>";
    return '<p class="cas-note">' + esc(d.facts_words) + "</p>" +
      '<p class="cas-note">The assistant uses these notes to help and to word things, and is told never to quote or reveal them — but the ' +
      "employee chats with it, so write nothing you would mind them reading.</p>" + list +
      '<div class="cas-bar"><button type="button" class="c-btn" data-cas="note-add" data-act' + need("training.rule.add") + ">+ Add a note</button>" +
      (d.notes_scope ? '<a class="c-btn ghost" href="#/training/' + esc(enc(d.notes_scope)) + '" title="The Training tab on this employee: the Coach, ' +
        'their language, days away and no-contact days">Open in Training</a>' : "") + "</div>";
  }

  function noteById(id) {
    return ((S.emp && S.emp.notes) || []).filter(function (n) { return String(n.id) === String(id); })[0] || null;
  }

  /* The note dialog (the desktop's NoteDialog words). A refusal opens it
     again with what was typed and the server's reason. */
  function noteDialog(fn, isNew, text, problem) {
    return Promise.resolve(S.ctx.modal({
      title: isNew ? "A note about " + fn : "Edit the note about " + fn,
      message: (problem ? problem + "\n\n" : "") + fn + "'s assistant reads the office's notes with every answer and briefing. Keep " +
        "them about work: their role, the job they run, how they like answers. No phone numbers, pay or anything private.",
      okText: "Save the note",
      fields: [{ name: "text", type: "textarea", rows: 4, value: text || "",
        placeholder: "e.g. Foreman at A068 — give him the crew's open tasks there first" }],
      validate: function (v) {
        var t = String(v.text || "").replace(/\s+/g, " ").trim();
        if (!t) return "Write the note first.";
        if (t.length > NOTE_MAX) return "Keep it under " + NOTE_MAX + " characters (" + t.length + " now).";
        return "";
      },
    })).then(function (v) { return v ? String(v.text || "").replace(/\s+/g, " ").trim() : null; });
  }

  function editNote(id, problem, typed) {
    var d = S.emp;
    if (!d) return Promise.resolve();
    var fn = first(d.row);
    var note = id ? noteById(id) : null;
    if (id && !note) return Promise.resolve();
    var g = S.gen;
    return noteDialog(fn, !note, typed !== undefined ? typed : note ? note.text : "", problem).then(function (text) {
      if (!text || (note && text === note.text)) return null;
      var call = note
        ? ask("training.rule.update", { id: note.id, text: text }, { text: "Saving the note…" })
        : ask("training.rule.add", { scope: d.notes_scope, text: text, category: "facts" }, { text: "Adding the note…" });
      return call.then(function (res) {
        var words = note ? res.words : (res.words === "That rule is already here." ? "That note is already here."
          : fn + "'s assistant reads that from the next answer on.");
        if (live(g)) return loadEmployee(g, true).then(function () { say(words, false, g); });
        toast(words);
      }, function (e) {
        if (e && (e.code === "refused" || e.code === "bad_args") && live(g)) return editNote(id, errText(e), text);
        if (live(g)) say(errText(e), true, g); else toast(errText(e), true);
      });
    });
  }

  function toggleNote(input) {
    var id = input.getAttribute("data-id");
    var on = !!input.checked;
    var g = S.gen;
    lock(input, true);
    return ask("training.rule.update", { id: Number(id), active: on }, { text: on ? "Turning the note on…" : "Turning the note off…" }).then(function () {
      lock(input, false);
      var n = noteById(id);
      if (n) n.active = on;
      var row = input.closest ? input.closest(".cas-noterow") : null;
      if (row && row.classList) row.classList.toggle("off", !on);
      say(on ? "The assistant uses that note again." : "Kept, but the assistant no longer uses that note.", false, g);
    }, function (e) {
      lock(input, false);
      input.checked = !on;
      say(errText(e), true, g);
    });
  }

  function deleteNote(id, btn) {
    var note = noteById(id);
    if (!note) return Promise.resolve();
    var g = S.gen;
    return press(btn, function () {
      return act("training.rule.delete", { id: note.id }, { text: "Deleting the note…" });
    }).then(function (res) {
      if (!res) return;
      if (live(g)) return loadEmployee(g, true).then(function () { say("Note deleted.", false, g); });
      toast("Note deleted.");
    }, function () { /* the shell said why */ });
  }

  /* The briefings, newest first: tap one to read it as it went (or will go). */
  function briefingsHtml(d) {
    var b = d.briefings || [];
    if (!b.length) return '<div class="c-empty">No briefing prepared yet.</div>';
    return b.map(function (x, i) {
      var meta = [x.kind_words, "written by " + String(x.by_words || "").toLowerCase(), x.made_words ? "prepared " + x.made_words : ""]
        .filter(Boolean).join(" · ");
      return '<details class="cas-brief"' + (i === 0 ? " open" : "") + "><summary>" + esc(x.about) + ' <span class="c-muted">— ' + esc(meta) +
        "</span></summary><pre>" + esc(x.text) + "</pre></details>";
    }).join("");
  }

  /* What the assistant did for them lately, and today's use. */
  function logHtml(d) {
    var rows = d.log || [];
    var cols = [
      { key: "when", label: "When", cls: "c-nowrap" },
      { key: "kind_words", label: "What" },
      { key: "detail", label: "Detail" },
      { key: "tokens", label: "Tokens", cls: "c-num", render: function (x) { return x.tokens ? esc(Number(x.tokens).toLocaleString("en-US")) : ""; } },
      { key: "seconds", label: "Seconds", cls: "c-num", render: function (x) { return x.seconds === null || x.seconds === undefined ? "" : esc(x.seconds); } },
    ];
    var table = S.ctx.ui && S.ctx.ui.table ? S.ctx.ui.table({ cols: cols, rows: rows, empty: "Nothing in the log yet." })
      : (rows.length ? '<table class="c-table"><tbody>' + rows.map(function (x) {
        return "<tr>" + cols.map(function (c) { return '<td data-label="' + esc(c.label) + '">' + (c.render ? c.render(x) : esc(x[c.key])) + "</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody></table>" : '<div class="c-empty">Nothing in the log yet.</div>');
    return table + '<p class="cas-note">' + esc(d.usage_words) + "</p>";
  }

  /* "Ask as this employee": a private test. The questions and answers live
     on this page only, like the desktop's dialog. */
  function askHtml(d) {
    var r = d.row || {};
    var fn = first(r);
    var turns = S.asks[fold(r.name)] || [];
    var ai = d.ai || {};
    var reads = r.office_reads !== false && !(S.list && S.list.office_reads === false);
    var pending = turns.length && turns[turns.length - 1].pending;
    return '<div class="c-card flat"><h3>Ask what ' + esc(fn) + " might ask</h3>" +
      '<p class="cas-note">A test: the answer comes from ' + esc(fn) + "'s assistant with " + esc(fn) + "'s tasks, hours and reminders, " +
      "but nothing is written to " + esc(fn) + "'s chat, nothing is sent to " + esc(fn) + ", and what it would create or change is only " +
      "listed here. Each question uses Claude like a real one.</p>" +
      (reads ? "" : '<p class="cas-note">' + esc(fn) + "'s conversations are private (the office does not read them), so this test runs " +
        "without " + esc(fn) + "'s chat and without the notes the assistant keeps for " + esc(fn) + ".</p>") +
      '<ol class="cas-chat cas-test" id="casAskChat">' + (turns.length ? turns.map(function (t) {
        return '<li class="cas-msg ' + (t.mine ? "user" : "assistant") + '"><div class="cas-meta">' + esc(t.who) + "</div>" +
          '<div class="cas-bubble">' + esc(t.text) + "</div>" +
          (t.extra && t.extra.length ? '<ul class="cas-extra">' + t.extra.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" : "") +
          "</li>";
      }).join("") : '<li class="cas-note">(Nothing asked yet.)</li>') + "</ol>" +
      '<form id="casAskForm"><div class="c-field"><label class="c-label" for="casAskText">Their question</label>' +
      '<textarea id="casAskText" rows="3" maxlength="2000" placeholder="e.g. What do I have tomorrow?  ·  Remind me at 3 pm to call the lumber yard  ·  How is A068 going?"></textarea></div>' +
      '<div class="cas-ft"><span class="grow" id="casAskNote">' + (ai.ok ? "" : esc("The assistant needs Claude for this (" + (ai.words || "") + ").")) + "</span>" +
      '<button type="submit" class="c-btn" id="casAskBtn"' + need("assistants.ask_as") + (ai.ok && !pending ? "" : " disabled") + ">Ask as " + esc(fn) +
      "</button></div></form></div>";
  }

  function askAs() {
    var d = S.emp;
    if (!d) return Promise.resolve();
    var r = d.row || {};
    var fn = first(r);
    var box = $("casAskText");
    var text = box ? String(box.value || "").trim() : "";
    var note = $("casAskNote");
    if (!text) { if (note) note.textContent = "Type a question first."; return Promise.resolve(); }
    var key = fold(r.name);
    var turns = S.asks[key] = S.asks[key] || [];
    if (turns.length && turns[turns.length - 1].pending) return Promise.resolve();
    turns.push({ who: fn + " (test)", text: text, mine: true, pending: true });
    if (box) box.value = "";
    redrawAsk();
    var g = S.gen;
    var words = fn + "'s assistant is thinking… (up to a minute)";
    var work = $("casAskNote");
    var done = S.ctx.busy && work ? S.ctx.busy(work, words) : null;
    var finish = function (turn) {
      if (typeof done === "function") done();
      turns.forEach(function (t) { t.pending = false; });
      turns.push(turn);
      if (live(g) && S.view === "ask" && fold(S.name) === key) redrawAsk();
    };
    return ask("assistants.ask_as", { name: r.name, text: text }, { text: words }).then(function (res) {
      res = res || {};
      /* The item ops say what it would do; an item card would only repeat them. */
      var cards = res.cards || [], cw = res.cards_words || [];
      var shown = cards.length === cw.length ? cw.filter(function (_w, i) { return !(cards[i] && cards[i].type === "item"); }) : cw;
      finish({ who: res.ok ? "Assistant" : "No answer", text: res.text || "", extra: (res.items_words || []).concat(shown) });
    }, function (e) {
      finish({ who: "No answer", text: errText(e), extra: [] });
    });
  }

  function redrawAsk() {
    var v = $("casView");
    if (v && S.emp && S.view === "ask") {
      v.innerHTML = askHtml(S.emp);
      var chat = $("casAskChat");
      if (chat && "scrollTop" in chat) chat.scrollTop = chat.scrollHeight || 0;
    }
  }

  /* "Teach from this…": the Training tab on this employee, with the message
     in the Coach's box (the desktop puts it on the clipboard and in the box
     when the box is empty — the same words, assistant/views.teach_text). */
  function teachText(m, fn) {
    var who = m.role === "user" ? (fn || "the employee") : "the assistant";
    var words = String(m.text || "").split(/\s+/).filter(Boolean).join(" ");
    if (words.length > 600) words = words.slice(0, 599) + "…";
    return "In " + (fn || "their") + "'s chat, " + who + " wrote: «" + words + "» — ";
  }

  function teach(i) {
    var d = S.emp;
    var m = d && d.conversation ? d.conversation[i] : null;
    if (!m || !d.notes_scope) return;
    var fn = first(d.row);
    var text = teachText(m, fn);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {});
    } catch (e) { /* no clipboard here */ }
    if (!draftGet(d.notes_scope).trim()) {
      draftSet(d.notes_scope, text);
      toast("Training is open on " + fn + " with the message in the Coach's box: say what the assistant should have said or known, then send it to the coach.");
    } else {
      toast("Training is open on " + fn + ", and the message is on the clipboard: paste it to the Coach and say what the assistant should have said or known.");
    }
    S.ctx.go("training/" + enc(d.notes_scope) + "?view=coach");
  }

  /* ── turning assistants on and off, briefings ─────────────────────── */

  function setOn(names, on, btn) {
    var g = S.gen;
    var who = names.length === 1 ? names[0] : names.length + " people";
    return press(btn, function () {
      return act("assistants.set_on", { names: names, on: on }, { text: "Turning " + (on ? "on" : "off") + " the assistant for " + who + "…" });
    }).then(function (res) {
      if (!res) return;
      S.listAt = 0;
      var isBad = (res.sentences || []).some(bad);
      var jobs = [loadList(g, true)];
      if (S.name) jobs.push(loadEmployee(g, true));
      return Promise.all(jobs).then(function () { say(res.words, isBad, g); });
    }, function () { /* the shell said why */ });
  }

  function sendBriefing(kind, btn) {
    var d = S.emp;
    if (!d) return Promise.resolve();
    var fn = first(d.row);
    var g = S.gen;
    return press(btn, function () {
      return act("assistants.briefing.send", { name: d.row.name, kind: kind },
        { text: "Writing " + fn + "'s briefing and sending it… (Claude can take a minute)" });
    }, "Claude is working…").then(function (res) {
      if (!res) return;
      if (live(g)) return loadEmployee(g, true).then(function () { say(res.words, bad(String(res.words).replace(/^[^:]*: /, "")), g); });
      toast(res.words);
    }, function () { /* the shell said why */ });
  }

  /* ── settings for every assistant (settings section "assistant") ──── */

  function loadSettings(g) {
    return ask("settings.get", {}).then(function (d) {
      S.settings = (d && d.sections && d.sections.assistant) || null;
      if (live(g)) drawSettings();
    }, function (e) {
      if (!live(g)) return;
      var main = $("casMain");
      if (main) main.innerHTML = backLink() + failed(e, "reload-settings");
    });
  }

  function fieldId(key) { return "casSet_" + String(key).replace(/[^a-z0-9_]/gi, "_"); }

  function fieldHtml(f, v) {
    var id = fieldId(f.key);
    var help = f.help ? '<p class="c-help">' + esc(f.help) + "</p>" : "";
    if (f.type === "bool") {
      return '<div class="c-field"><label class="c-check" for="' + id + '"><input type="checkbox" id="' + id + '"' + (v ? " checked" : "") +
        " /> " + esc(f.label) + "</label>" + help + "</div>";
    }
    var input;
    if (f.type === "enum" && Array.isArray(f.choices)) {
      input = '<select id="' + id + '">' + f.choices.map(function (c) {
        return '<option value="' + esc(c.key) + '"' + (String(c.key) === String(v) ? " selected" : "") + ">" + esc(c.label) + "</option>";
      }).join("") + "</select>";
    } else if (f.type === "int") {
      input = '<input type="number" inputmode="numeric" id="' + id + '" value="' + esc(v) + '"' +
        (f.lo !== undefined ? ' min="' + esc(f.lo) + '"' : "") + (f.hi !== undefined ? ' max="' + esc(f.hi) + '"' : "") + " />";
    } else if (f.type === "briefing" || f.type === "hhmm") {
      input = '<input type="time" id="' + id + '" value="' + esc(String(v || "").slice(0, 5)) + '"' +
        (f.type === "briefing" ? ' min="12:00" max="20:45"' : "") + " />";
      if (f.type === "briefing") help = '<p class="c-help">Between 12:00 pm and 8:45 pm.</p>' + help;
    } else {
      input = '<input type="text" id="' + id + '" value="' + esc(v) + '"' + (f.max ? ' maxlength="' + esc(f.max) + '"' : "") + " />";
    }
    return '<div class="c-field"><label class="c-label" for="' + id + '">' + esc(f.label) + "</label>" + input + help + "</div>";
  }

  function drawSettings() {
    var main = $("casMain");
    var s = S.settings;
    if (!main) return;
    if (!s) { main.innerHTML = backLink() + '<div class="c-empty">The DCR server sent no assistant settings.</div>'; return; }
    var fields = s.fields || [];
    main.innerHTML = backLink() + '<div class="cas-head"><h2>Settings for every assistant</h2></div>' +
      '<p class="c-sub">Briefing times · model · checks · limits · privacy — on the DCR server computer, for every employee.</p>' +
      '<p class="cas-say" id="casSay" aria-live="polite"></p>' +
      '<form class="c-card" id="casSetForm" novalidate>' + fields.map(function (f) { return fieldHtml(f, (s.values || {})[f.key]); }).join("") +
      '<p class="cas-err" id="casSetErr" role="alert"></p>' +
      '<div class="cas-ft"><button type="button" class="c-btn ghost" data-cas="reload-settings">Reload</button>' +
      '<button type="submit" class="c-btn" data-act' + need("settings.save") + ">Save the assistant settings</button></div></form>";
  }

  function settingsValues() {
    var s = S.settings || {};
    var out = {};
    (s.fields || []).forEach(function (f) {
      var n = $(fieldId(f.key));
      if (!n) return;
      var v;
      if (f.type === "bool") v = !!n.checked;
      else if (f.type === "int") v = String(n.value).trim() === "" ? NaN : Number(n.value);
      else v = String(n.value || "").trim();
      out[f.key] = v;
    });
    return out;
  }

  function saveSettings(btn) {
    var s = S.settings;
    if (!s) return Promise.resolve();
    var now = settingsValues();
    var changed = {};
    var err = $("casSetErr");
    var problem = "";
    (s.fields || []).forEach(function (f) {
      var v = now[f.key];
      if (v === undefined) return;
      if (f.type === "int" && (!isFinite(v) || Math.floor(v) !== v)) problem = problem || f.label + " must be a whole number.";
      if (JSON.stringify(v) !== JSON.stringify((s.values || {})[f.key])) changed[f.key] = v;
    });
    if (err) err.textContent = problem;
    if (problem) return Promise.resolve();
    if (!Object.keys(changed).length) { say("Nothing changed.", false); return Promise.resolve(); }
    var g = S.gen;
    return press(btn, function () {
      return ask("settings.save", { section: "assistant", values: changed, rev: s.rev || "" }, { text: "Saving the assistant settings…" });
    }, "Saving…").then(function (res) {
      var reads = changed["assistant.office_reads"];
      var effects = res.effects || [];
      S.listAt = 0;
      return loadSettings(g).then(function () {
        say(res.words, false, g);
        /* Whether the office reads the chats changed: the desktop offers to
           tell the assistants that are on now, so each page says it. */
        if (effects.indexOf("offer_tell_pages") >= 0 && reads !== undefined) {
          return act("assistants.tell_pages", { reads: !!reads }, { text: "Updating the employees' pages…", quiet: true }).then(function (r2) {
            if (r2) say(res.words + " " + r2.words, false, g);
          }, function (e) { if (e && e.code === "refused") say(res.words + " " + errText(e), false, g); });
        }
      });
    }, function (e) {
      if (!live(g)) { toast(errText(e), true); return; }
      if (err) err.textContent = errText(e);
    });
  }

  /* ── events (one listener of each kind on the tab's element) ──────── */

  function target(e, attr) {
    var t = e && e.target;
    return t && t.closest ? t.closest("[" + attr + "]") : null;
  }

  function onClick(e) {
    var t = target(e, "data-cas");
    if (!t || t.disabled) return;
    var what = t.getAttribute("data-cas");
    var g = S.gen;
    switch (what) {
      case "reload-list": S.listAt = 0; loadList(g, true); break;
      case "reload-emp": loadEmployee(g, true); break;
      case "reload-settings": loadSettings(g); break;
      case "all-on": {
        var names = ((S.list && S.list.rows) || []).filter(function (r) { return r.has_account && !r.on; })
          .map(function (r) { return r.name; }).slice(0, 60);
        if (!names.length) { toast("Everyone with a portal account already has their assistant on."); break; }
        setOn(names, true, t);
        break;
      }
      case "toggle": if (S.emp) setOn([S.emp.row.name], !S.emp.row.on, t); break;
      case "briefing": sendBriefing(t.getAttribute("data-kind") === "weekly" ? "weekly" : "evening", t); break;
      case "teach": teach(Number(t.getAttribute("data-i"))); break;
      case "item-open": {
        S.itemOpen = true;
        S.kind = "event";
        var v = $("casView");
        if (v && S.emp) v.innerHTML = itemsHtml(S.emp);
        var box = $("casItText");
        if (box && box.focus) box.focus();
        break;
      }
      case "item-cancel": {
        S.itemOpen = false;
        var v2 = $("casView");
        if (v2 && S.emp) v2.innerHTML = itemsHtml(S.emp);
        break;
      }
      case "note-add": editNote(null); break;
      case "note-edit": editNote(t.getAttribute("data-id")); break;
      case "note-del": deleteNote(t.getAttribute("data-id"), t); break;
      default: break;
    }
  }

  function onChange(e) {
    var t = target(e, "data-cas");
    if (!t) return;
    var what = t.getAttribute("data-cas");
    if (what === "filter") { S.filter = String(t.value || "all"); drawSide(); }
    else if (what === "kind") kindChanged(String(t.value || "event"));
    else if (what === "has-end") { var end = $("casItEnd"); if (end) end.disabled = !t.checked; }
    else if (what === "has-due") { var due = $("casItDue"); if (due) due.disabled = !t.checked; }
    else if (what === "note-on") toggleNote(t);
  }

  function onSubmit(e) {
    var f = e && e.target;
    var id = f && (f.id || (f.getAttribute && f.getAttribute("id")));
    if (!id) return;
    if (e.preventDefault) e.preventDefault();
    var btn = f.querySelector ? f.querySelector("[type=submit]") : null;
    if (id === "casItemForm") addItem(btn || $("casItSave"));
    else if (id === "casAskForm") askAs();
    else if (id === "casSetForm") saveSettings(btn);
  }

  window.DCRConsole.register({ id: TAB, title: "Assistants", order: 60, render: render, leave: leave });

  /* For the page tests (lib/console-assistants-page.test.mjs). */
  if (window.__DCR_CONSOLE_TEST__) window.DCRConsoleAssistants = { state: S, teachText: teachText, itemValue: itemValue };
})();
