/* DCR Agents web console — the Timesheets and Tasks tabs (console-spec
   §6.1.4, §6.1.5 and §6.4).

   Both tabs are views over the DCR server computer's own code: the grid,
   the task board, the follow-up's choices, words, preview and problems all
   come from the PC (hours.py, taskboard.py, followup.py — the desktop tabs'
   code), through ctx.rpc. This file decides nothing about who may be
   reminded or how: it draws what came back, keeps what the admin selected,
   and sends the selection back for the PC to check again.

   Timesheets: last week above this week, one row per person, a cell per
   day with the hours and the address under them (the desktop tab's grid).
   Tap empty days — or a name, for all of that person's missing days that
   week — and the chips over the grid show exactly who would be reminded
   about which day. "Remind about the selected day(s)" asks the PC's own
   question (timesheets.remind counts again and leaves out anything filed
   meanwhile), then shows one line per person and reloads. A filed day
   opens what was filed.

   Tasks: every open task with no update, grouped by the person it is
   assigned to (the desktop's board), with a follow-up by hand: pick tasks
   (or a person's whole list), then the follow-up page shows who it goes
   to, one choice per way of sending with its address or the reason it
   cannot be used now, an optional note from the office and a preview of
   the first message — asked again of the PC on every choice and, 600 ms
   after the last key, on every note. Send asks the PC's question and shows
   one line per task.

   The shell's vocabulary (agents-console.css: c-head, c-btn, c-card,
   c-chip…) with a few classes of its own for the grid and the board.
   Everything from the server goes through ctx.esc; links are https: or
   this site's own; write buttons carry data-act (greyed while the DCR
   server is offline or in Standby) and data-method (greyed when the
   server's build does not know the method). */
(function () {
  "use strict";

  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var UPDATE = "Update DCR Agents on the server computer to use this";
  var TS_RELOAD_MS = 60 * 1000;        // the desktop tab's RELOAD_SECONDS: a re-entry this soon draws from memory
  var TK_RELOAD_MS = 5 * 60 * 1000;    // the Tasks tab's: tasks change slowly and the board asks the portal
  var PAIRS_MAX = 60;                  // timesheets.remind takes at most this many (person, day) pairs
  var IDS_MAX = 100;                   // tasks.followup takes at most this many task ids
  var NOTE_MAX = 200;                  // the office's note (engine.NOTE_MAX)
  var NOTE_WAIT_MS = 600;              // the preview is asked again this long after the last key

  /* ── small helpers ───────────────────────────────────────────────────── */

  function plural(n, one, many) { n = Number(n) || 0; return n + " " + (n === 1 ? one : (many || one + "s")); }

  /* 8 → "8h", 7.5 → "7.5h", 0 → "" (the desktop's _hours_text). */
  function hoursText(n) {
    n = Number(n) || 0;
    return n ? String(Math.round(n * 100) / 100) + "h" : "";
  }

  /* "2026-09-21" → "Mon Sep 21", the words the PC's reminder lines use (hours.day_word). */
  function dayWord(day) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
    if (!m) return String(day || "");
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
    return WEEKDAYS[d.getUTCDay()] + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
  }

  function errWords(e) { return (e && e.message) || "Something went wrong."; }

  /* A link the page may draw: https:, or a page of this very site (the
     feed spells My Tasks out in full, http on a test server); anything
     else — javascript:, data:, another site over plain http — is dropped. */
  function safeHref(u) {
    u = String(u || "").trim();
    if (!u) return "";
    try {
      var here = (typeof location !== "undefined" && location && location.href) ? location.href : "https://invalid.invalid/";
      var url = new URL(u, here);
      if (url.protocol === "https:") return url.href;
      if (typeof location !== "undefined" && location && url.origin === location.origin && /^https?:$/.test(url.protocol)) return url.href;
    } catch (e) { /* not a link */ }
    return "";
  }

  /* The shell greys a control whose method this server's build does not know. */
  function m(method) { return ' data-method="' + method + '"'; }
  function canAct(ctx) { return !ctx.canAct || ctx.canAct(); }
  function find(root, id) { return root && root.querySelector ? root.querySelector("#" + id) : null; }
  function setHtml(root, id, html) { var n = find(root, id); if (n) n.innerHTML = html; return n; }
  /* When no "Tasks with no update" agent exists (the PC's taskboard.NO_AGENT_SHORT). */
  var NO_AGENT = "no \u201cTasks with no update\u201d agent yet \u2014 add one on the Agents tab";
  var TS_DRY = "Dry run: a reminder from here is only recorded in Activity \u2014 nothing is sent.";
  function setText(root, id, text, cls) {
    var n = find(root, id);
    if (!n) return;
    if (cls !== undefined) n.className = cls;
    n.textContent = text || "";
  }
  function emptyHtml(ctx, words) {
    return ctx.ui && ctx.ui.empty ? ctx.ui.empty(words) : '<div class="c-empty">' + ctx.esc(words) + "</div>";
  }
  function failedHtml(ctx, e) {
    return ctx.ui && ctx.ui.failed ? ctx.ui.failed(e) : '<div class="c-error"><span>' + ctx.esc(errWords(e)) + "</span></div>";
  }

  /* The working line while a call is out: the shell's (seconds counting). */
  function working(ctx, node, text) {
    if (!node) return function () {};
    if (ctx.busy) {
      try { return ctx.busy(node, text) || function () {}; } catch (e) { /* fall through */ }
    }
    node.innerHTML = '<div class="c-busy">' + ctx.esc(text) + "</div>";
    return function () {};
  }

  function activeId() {
    try { return (typeof document !== "undefined" && document.activeElement && document.activeElement.id) || ""; }
    catch (e) { return ""; }
  }
  function focusId(root, id) {
    if (!id) return;
    var n = find(root, id);
    if (n && n.focus) { try { n.focus(); } catch (e) { /* not focusable */ } }
  }

  function resultsHtml(ctx, lines) {
    if (!lines.length) return "";
    return '<div class="c-card flat cw-results" role="status"><h3>What happened</h3><ul>' +
      lines.map(function (l) { return "<li>" + ctx.esc(l) + "</li>"; }).join("") + "</ul></div>";
  }

  /* ── this module's own look, over the shell's tokens (.c-app) ────────── */

  var CSS = [
    ".cw-bar{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center;margin:-4px 0 10px}",
    ".cw-bad{color:var(--bad)!important;font-weight:600}",
    ".cw-results ul{margin:0;padding-left:18px;font-size:14px}.cw-results li{overflow-wrap:anywhere;margin:2px 0}",
    /* the selection: who would be reminded */
    ".cw-picks{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13.5px}",
    ".cw-pick{display:inline-flex;align-items:center;padding:0 0 0 10px;border-radius:16px;background:var(--tint);color:var(--acc-text);",
    "font-weight:700;font-size:13px;min-height:34px}",
    ".cw-pick button{min-width:38px;min-height:34px;border:0;background:none;color:inherit;font-size:17px;line-height:1;border-radius:16px}",
    ".cw-pick button:focus-visible{outline:2px solid var(--acc);outline-offset:-2px}",
    /* the timesheet grid */
    ".cw-week{margin:0 0 16px}",
    ".cw-week h3{margin:0 0 6px;font-size:15.5px;font-weight:800}",
    ".cw-gridwrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:12px;background:var(--surface)}",
    ".cw-grid{border-collapse:separate;border-spacing:0;width:100%;min-width:780px;table-layout:fixed}",
    ".cw-grid th,.cw-grid td{padding:0;border-bottom:1px solid var(--border);text-align:center;white-space:normal;max-width:none;",
    "overflow:visible;text-overflow:clip;vertical-align:middle}",
    ".cw-grid tbody tr:last-child th,.cw-grid tbody tr:last-child td{border-bottom:0}",
    ".cw-grid tbody tr:hover{background:transparent}",
    ".cw-grid thead th{position:static;background:var(--surface-2);color:var(--text-muted);font-size:12.5px;font-weight:700;padding:8px 2px}",
    ".cw-grid thead th.today{color:var(--acc-text)}",
    ".cw-grid .cw-name{position:sticky;left:0;z-index:1;width:150px;text-align:left;background:var(--surface);border-right:1px solid var(--border)}",
    ".cw-grid thead .cw-name{background:var(--surface-2);padding-left:12px}",
    ".cw-grid .cw-tot{width:60px;font-weight:800;font-size:14px;font-variant-numeric:tabular-nums}",
    ".cw-pname{display:block;width:100%;min-height:50px;padding:6px 10px;border:0;background:none;color:var(--text);text-align:left;",
    "font-weight:700;font-size:14px;line-height:1.25;overflow-wrap:anywhere}",
    ".cw-pname.dim{color:var(--text-muted);font-weight:500}",
    ".cw-pname:focus-visible,.cw-cbtn:focus-visible{outline:2px solid var(--acc);outline-offset:-3px;border-radius:6px}",
    ".cw-cell.wkend{background:var(--surface-2)}",
    ".cw-cell.today{background:var(--tint)}",
    ".cw-cbtn{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;min-height:50px;padding:4px 3px;",
    "border:0;background:none;color:var(--text);font-size:14px;line-height:1.2}",
    ".cw-top{font-weight:800;font-variant-numeric:tabular-nums}",
    ".cw-bot{font-size:11.5px;color:var(--text-muted);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".cw-cell.leave .cw-top{color:var(--warn)}",
    ".cw-dot{color:var(--text-muted);font-size:17px}",
    ".cw-cell.ahead .cw-dot{opacity:.4}",
    ".cw-cbtn.sel{background:var(--tint-2);box-shadow:inset 0 0 0 2px var(--acc);border-radius:6px}",
    ".cw-cbtn.sel .cw-dot{color:var(--acc-text);font-weight:800}",
    /* the task board */
    ".cw-group{margin:0 0 14px}",
    ".cw-gh{display:flex;flex-wrap:wrap;align-items:center;gap:0 6px;margin:0 0 4px}",
    ".cw-gcheck,.cw-tcheck{display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;margin:0;cursor:pointer}",
    ".cw-gcheck input,.cw-tcheck input{width:20px;height:20px;margin:0;accent-color:var(--acc)}",
    /* the boxes and the radios follow the theme (white squares on a dark page otherwise) */
    ":root[data-theme=\"dark\"] .cw input{color-scheme:dark}",
    "@media (prefers-color-scheme: dark){:root:not([data-theme=\"light\"]) .cw input{color-scheme:dark}}",
    ".cw input,.cw select{font-family:inherit}",
    ".cw-gname{min-height:44px;padding:4px 2px;border:0;background:none;color:var(--good);font-weight:800;font-size:16px;text-align:left}",
    ".cw-group.unreach .cw-gname{color:var(--bad)}",
    ".cw-gname::before{content:'\\25BE';display:inline-block;width:16px;color:var(--text-muted);font-size:13px}",
    ".cw-gname[aria-expanded=\"false\"]::before{content:'\\25B8'}",
    ".cw-gsuf{flex:1 1 220px;color:var(--text-muted);font-size:13.5px;min-width:0}",
    ".cw-gname:focus-visible,.cw-tbody:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px}",
    ".cw-tasks{list-style:none;margin:0;padding:0}",
    ".cw-task{display:flex;align-items:stretch;margin:0 0 8px;background:var(--surface);border:1px solid var(--border);border-radius:12px}",
    ".cw-task.nagged{background:var(--warn-bg)}",
    ".cw-task.sel{border-color:var(--acc);box-shadow:0 0 0 2px var(--tint-2)}",
    ".cw-tbody{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;padding:9px 12px 9px 0;border:0;background:none;",
    "color:var(--text);text-align:left;font-size:14px;line-height:1.35}",
    ".cw-tname{font-weight:700;font-size:15px;color:var(--acc-text);overflow-wrap:anywhere}",
    ".cw-tname.red{color:var(--bad)}",
    ".cw-tmeta,.cw-tproj{color:var(--text-muted);font-size:13.5px;overflow-wrap:anywhere}",
    ".cw-days{font-weight:700;color:var(--text)}.cw-days.stale{color:var(--bad)}",
    ".cw-tnote{color:var(--text-muted);font-size:13px;font-style:italic;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;",
    "-webkit-box-orient:vertical;overflow-wrap:anywhere}",
    ".cw-tbody .c-chip{align-self:flex-start;margin-top:2px;white-space:normal}",
    /* a task's page and the follow-up page */
    ".cw-page{max-width:780px}",
    ".cw-back{margin:-4px 0 6px}",
    ".cw-notes{max-height:340px;overflow:auto;margin:0;font-size:14px}",
    ".cw-to{font-weight:800;font-size:15.5px;overflow-wrap:anywhere}",
    ".cw-about{font-size:14px;margin-top:2px;overflow-wrap:anywhere}",
    ".cw-sum{font-size:14px;color:var(--text-muted);margin:6px 0 0;overflow-wrap:anywhere}",
    ".cw-radio{display:flex;align-items:flex-start;gap:10px;min-height:44px;margin:0;padding:9px 0;font-weight:500;font-size:14px;",
    "line-height:1.35;cursor:pointer;border-bottom:1px solid var(--border)}",
    ".cw-radio:last-child{border-bottom:0}",
    ".cw-radio input{width:20px;height:20px;margin:0;flex:none;accent-color:var(--acc)}",
    ".cw-radio span{overflow-wrap:anywhere}",
    ".cw-radio.off{color:var(--text-muted);cursor:default}",
    ".cw-noterow{display:flex;gap:8px;align-items:center}",
    ".cw-noterow input{flex:1 1 auto;min-height:44px;font-size:16px}",
    ".cw-count{font-size:12.5px;color:var(--text-muted);white-space:nowrap;font-variant-numeric:tabular-nums}",
    ".cw-plabel{font-size:13.5px;font-weight:800;margin:0 0 6px;overflow-wrap:anywhere}",
    ".cw-plabel .c-muted{font-weight:500}",
    ".cw-ptext{margin:0;padding:10px 12px;border-radius:10px;background:var(--surface-2);font:inherit;font-size:14px;",
    "white-space:pre-wrap;overflow-wrap:anywhere;min-height:5.5em}",
    ".cw-probs,.cw-warns{margin:8px 0 0;padding-left:18px;font-size:13.5px}",
    ".cw-probs{color:var(--bad);font-weight:600}.cw-warns{color:var(--text-muted)}",
    ".cw-probs li,.cw-warns li{overflow-wrap:anywhere}",
    ".cw-msg{min-height:20px;margin:8px 0 0;font-size:14px;overflow-wrap:anywhere;color:var(--text-muted)}",
    "@media (max-width:640px){.cw-grid{min-width:670px}.cw-grid .cw-name{width:112px}.cw-pname{font-size:13px;padding:6px 8px}",
    ".cw-bot{font-size:11px}}",
  ].join("\n");

  function style() {
    try {
      if (typeof document === "undefined" || !document.head || document.getElementById("cwStyle")) return;
      var s = document.createElement("style");
      s.id = "cwStyle";
      s.textContent = CSS;
      document.head.appendChild(s);
    } catch (e) { /* the page still works unstyled */ }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Timesheets
     ════════════════════════════════════════════════════════════════════════ */

  var TS = {
    grid: null,            // the last timesheets.grid answer
    loadedAt: 0,
    results: [],           // what the last Remind produced, kept across the reload after it
    selected: [],          // [{name, day}] in the order they were tapped
    gen: 0,                // bumped on every render and leave: an answer for an old view is dropped
  };

  function pairKey(name, day) { return String(name).toLowerCase().replace(/\s+/g, " ").trim() + "|" + day; }
  function isSelected(name, day) {
    var k = pairKey(name, day);
    return TS.selected.some(function (p) { return pairKey(p.name, p.day) === k; });
  }
  function filed(cell) { return !!(cell && (cell.filed || Number(cell.hours) > 0)); }

  /* The cells the admin may tap to remind about: nothing filed, and not a
     day still ahead (the PC checks the same again — hours.remindable). */
  function remindable(g, wi, ci, cell) {
    var w = g.weeks[wi];
    var d = (w && w.days[ci]) || {};
    return !filed(cell) && !d.ahead;
  }

  /* After a reload, a selected day that has been filed meanwhile (or has
     left the grid) is dropped from the selection. */
  function keepSelectable(g) {
    var ok = {};
    (g.weeks || []).forEach(function (w, wi) {
      (w.rows || []).forEach(function (r) {
        (r.cells || []).forEach(function (c, ci) { if (remindable(g, wi, ci, c)) ok[pairKey(r.name, c.day)] = true; });
      });
    });
    TS.selected = TS.selected.filter(function (p) { return ok[pairKey(p.name, p.day)]; });
  }

  function cellWords(c) {
    if (!c.top && !c.bottom) return "nothing filed";
    return c.top && c.bottom ? c.top + " · " + c.bottom : (c.top || c.bottom);
  }

  function tsCell(ctx, g, wi, ri, ci) {
    var esc = ctx.esc;
    var w = g.weeks[wi];
    var row = w.rows[ri];
    var c = row.cells[ci] || {};
    var d = w.days[ci] || {};
    var cls = ["cw-cell"];
    if (d.weekend) cls.push("wkend");
    if (c.day === g.today) cls.push("today");
    var at = ' id="cwTs_' + wi + "_" + ri + "_" + ci + '" data-cw="ts-cell" data-w="' + wi + '" data-r="' + ri + '" data-c="' + ci + '"';
    var who = row.name + " — " + dayWord(c.day) + ": ";
    if (filed(c)) {
      cls.push("filed");
      if (c.leave) cls.push("leave");
      return '<td class="' + cls.join(" ") + '"><button type="button" class="cw-cbtn"' + at + ' title="' + esc(who + cellWords(c)) + '">' +
        '<span class="cw-top">' + esc(c.top || hoursText(c.hours) || c.leave) + "</span>" +
        (c.bottom ? '<span class="cw-bot">' + esc(c.bottom) + "</span>" : "") + "</button></td>";
    }
    if (d.ahead) {
      cls.push("ahead");
      return '<td class="' + cls.join(" ") + '"><span class="cw-dot" title="' + esc(who + "still ahead — nobody could have filed it yet") +
        '">·</span></td>';
    }
    var on = isSelected(row.name, c.day);
    return '<td class="' + cls.join(" ") + '"><button type="button" class="cw-cbtn' + (on ? " sel" : "") + '"' + at +
      ' aria-pressed="' + (on ? "true" : "false") + '" title="' + esc(who + "nothing filed — tap to remind") + '">' +
      '<span class="cw-dot">' + (on ? "✓" : "·") + "</span></button></td>";
  }

  function tsWeek(ctx, g, wi) {
    var esc = ctx.esc;
    var w = g.weeks[wi];
    var head = '<tr><th scope="col" class="cw-name">Employee</th>' + (w.days || []).map(function (d) {
      var cls = ((d.weekend ? "wkend " : "") + (d.day === g.today ? "today" : "")).trim();
      return '<th scope="col"' + (cls ? ' class="' + cls + '"' : "") + (d.day === g.today ? ' title="today"' : "") + ">" + esc(d.header) + "</th>";
    }).join("") + '<th scope="col" class="cw-tot">Total</th></tr>';
    var body = (w.rows || []).map(function (r, ri) {
      return '<tr><th scope="row" class="cw-name"><button type="button" class="cw-pname' + (Number(r.total) ? "" : " dim") +
        '" id="cwTsP_' + wi + "_" + ri + '" data-cw="ts-person" data-w="' + wi + '" data-r="' + ri + '" title="' +
        esc("Select every missing weekday of " + r.name + " in this week") + '">' + esc(r.name) + "</button></th>" +
        (r.cells || []).map(function (_c, ci) { return tsCell(ctx, g, wi, ri, ci); }).join("") +
        '<td class="cw-tot">' + esc(hoursText(r.total)) + "</td></tr>";
    }).join("");
    return '<section class="cw-week"><h3>' + esc(w.label) + "</h3>" +
      ((w.rows || []).length
        ? '<div class="cw-gridwrap" id="cwTsWrap' + wi + '"><table class="cw-grid"><thead>' + head + "</thead><tbody>" + body + "</tbody></table></div>"
        : emptyHtml(ctx, "Nobody to show for this week.")) + "</section>";
  }

  function tsPicksHtml(ctx) {
    var esc = ctx.esc;
    if (!TS.selected.length) {
      return '<span class="c-muted">Tap empty day cells — or a name, for every missing weekday of that person that week — then press Remind.</span>';
    }
    var people = {}, days = {};
    TS.selected.forEach(function (p) { people[p.name.toLowerCase()] = true; days[p.day] = true; });
    return '<span class="c-muted">Would remind ' + esc(plural(Object.keys(people).length, "person", "people")) + " about " +
      esc(plural(Object.keys(days).length, "day")) + ":</span>" +
      TS.selected.map(function (p, i) {
        return '<span class="cw-pick">' + esc(p.name + " · " + dayWord(p.day)) +
          '<button type="button" data-cw="ts-unsel" data-i="' + i + '" aria-label="' + esc("Leave out " + p.name + " · " + dayWord(p.day)) +
          '" title="Leave this one out">×</button></span>';
      }).join("") +
      '<button type="button" class="c-btn link" data-cw="ts-clear">Clear the selection</button>';
  }

  function tsDraw(root, ctx) {
    setHtml(root, "cwTsPicks", tsPicksHtml(ctx));
    setHtml(root, "cwTsResults", resultsHtml(ctx, TS.results));
    var g = TS.grid;
    if (!g) return;
    /* where each week's grid was scrolled to (null: drawn for the first time) */
    var keep = [0, 1].map(function (i) { var n = find(root, "cwTsWrap" + i); return n ? n.scrollLeft : null; });
    var focus = activeId();
    setHtml(root, "cwTsGrid", (g.weeks || []).length
      ? g.weeks.map(function (_w, wi) { return tsWeek(ctx, g, wi); }).join("")
      : emptyHtml(ctx, "No weeks to show."));
    keep.forEach(function (x, i) {
      var n = find(root, "cwTsWrap" + i);
      if (!n) return;
      if (x === null) startOnMonday(n, g.weeks[i], g.today);
      else if (x) n.scrollLeft = x;
    });
    if (/^cwTs/.test(focus)) focusId(root, focus);
  }

  /* On a phone the grid is wider than the screen: it opens on the week's
     first weekday (the weekend is a swipe to the left), not on Saturday —
     unless today is that weekend, which stays in sight. */
  function startOnMonday(wrap, week, today) {
    try {
      if (!wrap.querySelectorAll || !(wrap.scrollWidth > wrap.clientWidth)) return;
      var days = (week && week.days) || [];
      var i = days.findIndex(function (d) { return !d.weekend; });
      var t = days.findIndex(function (d) { return d.day === today; });
      if (t >= 0 && t < i) i = t;
      if (i <= 0) return;
      var ths = wrap.querySelectorAll("thead th");
      if (ths.length > i + 1) wrap.scrollLeft = Math.max(0, ths[i + 1].offsetLeft - ths[0].offsetWidth);
    } catch (e) { /* stays where it is */ }
  }

  function tsDryBanner(root, ctx, g) {
    setHtml(root, "cwTsDry", g && g.dry ? '<div class="c-banner info" id="cwTsDryLine"><span>' + ctx.esc(TS_DRY) + "</span></div>" : "");
  }

  function tsCountsLine(g) {
    var rows = Number(g.rows_count) || 0;
    return rows + " timesheet row" + (rows === 1 ? "" : "s") + " · " + plural(Number(g.people_count) || 0, "person", "people") +
      " · select empty day cells and press Remind";
  }

  function tsLoad(root, ctx, force) {
    var gen = TS.gen;
    if (!force && TS.grid && Date.now() - TS.loadedAt < TS_RELOAD_MS) {
      tsDraw(root, ctx);
      setText(root, "cwTsSub", tsCountsLine(TS.grid), "c-sub");
      tsDryBanner(root, ctx, TS.grid);
      return Promise.resolve();
    }
    var done = working(ctx, find(root, "cwTsBusy"), "Loading the timesheets from the portal…");
    tsDraw(root, ctx);
    return ctx.rpc("timesheets.grid", {}, { text: "Loading the timesheets…", quiet: true }).then(function (g) {
      done();
      if (gen !== TS.gen) return;
      TS.grid = g || { weeks: [] };
      TS.loadedAt = Date.now();
      keepSelectable(TS.grid);
      tsDraw(root, ctx);
      setText(root, "cwTsSub", tsCountsLine(TS.grid), "c-sub");
      tsDryBanner(root, ctx, TS.grid);
    }, function (e) {
      done();
      if (gen !== TS.gen) return;
      if (TS.grid) setText(root, "cwTsSub", "Could not load timesheets: " + errWords(e), "c-sub cw-bad");
      else setHtml(root, "cwTsGrid", failedHtml(ctx, e));
    });
  }

  function tsToggle(name, day) {
    var k = pairKey(name, day);
    var i = TS.selected.findIndex(function (p) { return pairKey(p.name, p.day) === k; });
    if (i >= 0) TS.selected.splice(i, 1);
    else TS.selected.push({ name: name, day: day });
  }

  /* A name: every missing weekday of that person in that week (a weekend
     day is picked on its own), or none of them when all are already picked. */
  function tsPerson(wi, ri) {
    var g = TS.grid;
    var row = g && g.weeks[wi] && g.weeks[wi].rows[ri];
    if (!row) return;
    var days = [];
    row.cells.forEach(function (c, ci) {
      var d = g.weeks[wi].days[ci] || {};
      if (!d.weekend && remindable(g, wi, ci, c)) days.push(c.day);
    });
    if (!days.length) return;
    var all = days.every(function (d) { return isSelected(row.name, d); });
    days.forEach(function (d) {
      var on = isSelected(row.name, d);
      if (all ? on : !on) tsToggle(row.name, d);
    });
  }

  /* A filed day: every entry of it (the desktop's double-click dialog). */
  function tsShowCell(ctx, row, c) {
    var lines = (c.entries || []).map(function (e) {
      var head = [hoursText(e.hours) || e.leave, e.leave && Number(e.hours) ? e.leave : "", e.project, e.address].filter(Boolean).join(" · ");
      return head + (e.work ? "\n" + e.work : "");
    });
    if (ctx.modal) {
      ctx.modal({ title: row.name + " — " + dayWord(c.day), message: lines.length ? lines.join("\n\n") : cellWords(c),
        okText: "Close", cancel: false, fields: [] });
    }
  }

  function tsRemind(root, ctx, btn) {
    if (!canAct(ctx)) return Promise.resolve();
    if (!TS.selected.length) {
      TS.results = ["Select one or more empty day cells first."];
      tsDraw(root, ctx);
      return Promise.resolve();
    }
    if (TS.selected.length > PAIRS_MAX) {
      TS.results = ["Select at most " + PAIRS_MAX + " days at a time."];
      tsDraw(root, ctx);
      return Promise.resolve();
    }
    var gen = TS.gen;
    var pairs = TS.selected.map(function (p) { return { name: p.name, day: p.day }; });
    var call = function () {
      return ctx.act("timesheets.remind", { pairs: pairs }, { text: "Reminding…", quiet: true }).then(function (data) {
        if (gen !== TS.gen || !data) return;          // a view left behind, or the admin said no
        TS.results = (data.lines || []).slice();
        if (!TS.results.length) TS.results = ["Nothing was sent." + (data.left_out || "")];
        TS.selected = [];
        tsDraw(root, ctx);
        return tsLoad(root, ctx, true);
      }, function (e) {
        if (gen !== TS.gen) return;
        TS.results = [errWords(e)];
        tsDraw(root, ctx);
      });
    };
    return ctx.press ? ctx.press(btn, call, "Reminding…") : call();
  }

  function renderTimesheets(el, ctx) {
    style();
    TS.gen++;
    el.innerHTML =
      '<div class="cw">' +
        '<div class="c-head"><div><h2>Timesheets</h2><p class="c-sub" id="cwTsSub">Who has filed hours this week and last.</p></div>' +
          '<div class="c-actions">' +
            '<button type="button" class="c-btn ghost sm" data-cw="ts-refresh"' + m("timesheets.grid") + ">Refresh</button>" +
            '<button type="button" class="c-btn sm" id="cwTsRemind" data-cw="ts-remind" data-act' + m("timesheets.remind") +
              ">Remind about the selected day(s)</button>" +
          "</div></div>" +
        '<div id="cwTsDry"></div>' +
        '<div class="c-card flat"><div class="cw-picks" id="cwTsPicks" aria-live="polite"></div></div>' +
        '<div id="cwTsResults"></div><div id="cwTsBusy"></div>' +
        '<div id="cwTsGrid"></div>' +
      "</div>";
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-cw]") : null;
      if (!t || t.disabled) return;
      var act = t.getAttribute("data-cw");
      if (act === "ts-refresh") { TS.results = []; tsLoad(el, ctx, true); }
      else if (act === "ts-remind") tsRemind(el, ctx, t);
      else if (act === "ts-clear") { TS.selected = []; tsDraw(el, ctx); }
      else if (act === "ts-unsel") { TS.selected.splice(Number(t.getAttribute("data-i")), 1); tsDraw(el, ctx); }
      else if (act === "ts-person") { tsPerson(Number(t.getAttribute("data-w")), Number(t.getAttribute("data-r"))); tsDraw(el, ctx); }
      else if (act === "ts-cell") {
        var wi = Number(t.getAttribute("data-w")), ri = Number(t.getAttribute("data-r")), ci = Number(t.getAttribute("data-c"));
        var g = TS.grid;
        var row = g && g.weeks[wi] && g.weeks[wi].rows[ri];
        var c = row && row.cells[ci];
        if (!c) return;
        if (filed(c)) { tsShowCell(ctx, row, c); return; }
        if (!remindable(g, wi, ci, c)) return;
        tsToggle(row.name, c.day);
        tsDraw(el, ctx);
      }
    });
    if (ctx.has && !ctx.has("timesheets.grid")) {
      setHtml(el, "cwTsGrid", emptyHtml(ctx, UPDATE + "."));
      return Promise.resolve();
    }
    return tsLoad(el, ctx, false);
  }

  /* ════════════════════════════════════════════════════════════════════════
     Tasks
     ════════════════════════════════════════════════════════════════════════ */

  var TK = {
    board: null,           // the last tasks.board answer
    boardAll: false,       // whether that answer was for "Show every open task"
    all: false,            // the checkbox
    loadedAt: 0,
    results: [],           // what the last send produced, kept across the reload after it
    selected: {},          // task_id → true
    collapsed: {},         // group key → true when folded shut
    fu: null,              // the follow-up being written: {ids, fresh, channel, note, data, seq}
    noteTimer: null,
    gen: 0,
  };

  function tkGroups() { return (TK.board && TK.board.groups) || []; }
  function tkTask(id) {
    var out = null;
    tkGroups().forEach(function (g) { (g.tasks || []).forEach(function (t) { if (String(t.task_id) === String(id)) out = t; }); });
    return out;
  }
  function tkSelectedIds() {
    var ids = [];
    tkGroups().forEach(function (g) {
      (g.tasks || []).forEach(function (t) {
        var id = String(t.task_id);
        if (TK.selected[id] && ids.indexOf(id) < 0) ids.push(id);
      });
    });
    return ids;
  }
  function gKey(g, gi) { return String(g.key || g.person || g.label || gi); }

  function tkTaskHtml(ctx, t) {
    var esc = ctx.esc;
    var id = String(t.task_id);
    var on = !!TK.selected[id];
    var reminders = t.reminders || [];
    var meta = ['<span class="cw-days' + (t.stale ? " stale" : "") + '">' + esc(plural(t.days_since, "day")) + " silent</span>"];
    if (t.last_update_text) meta.push("last update " + esc(t.last_update_text));
    if (t.reminders_short) meta.push("reminded " + esc(t.reminders_short));
    if (t.priority) meta.push(esc(t.priority));
    var where = [[t.project, t.city].filter(Boolean).join(" · "), t.requested_text ? "requested " + t.requested_text : ""].filter(Boolean).join(" · ");
    return '<li class="cw-task' + (t.nagged ? " nagged" : "") + (on ? " sel" : "") + '">' +
      '<label class="cw-tcheck" title="Select this task"><input type="checkbox" id="cwTkC' + esc(id) + '" data-cw="tk-sel" data-id="' + esc(id) + '"' +
        (on ? " checked" : "") + ' aria-label="' + esc("Select " + t.name) + '"></label>' +
      '<button type="button" class="cw-tbody" data-cw="tk-open" data-id="' + esc(id) + '"' +
        (reminders.length ? ' title="' + esc(reminders.join("\n")) + '"' : "") + ">" +
        '<span class="cw-tname' + (reminders.length >= 2 ? " red" : "") + '">' + esc(t.name) + "</span>" +
        '<span class="cw-tmeta">' + meta.join(" · ") + "</span>" +
        (where ? '<span class="cw-tproj">' + esc(where) + "</span>" : "") +
        (t.last_note ? '<span class="cw-tnote">' + esc(t.last_note) + "</span>" : "") +
        (t.why_not ? '<span class="c-chip warn">' + esc(t.why_not) + "</span>" : "") +
      "</button></li>";
  }

  function tkBoardHtml(ctx) {
    var esc = ctx.esc;
    var b = TK.board;
    if (!b) return "";
    var groups = b.groups || [];
    if (!groups.length) return emptyHtml(ctx, TK.boardAll ? "No open tasks." : "No open task is waiting for an update.");
    var noLender = !b.lender;
    return groups.map(function (g, gi) {
      var tasks = g.tasks || [];
      var key = gKey(g, gi);
      var who = g.label || g.person;
      var folded = !!TK.collapsed[key];
      var allOn = tasks.length > 0 && tasks.every(function (t) { return TK.selected[String(t.task_id)]; });
      var sendable = tasks.filter(function (t) { return !t.why_not; }).length;
      var n = sendable || tasks.length;          // none sendable: the count of the rows, and the reason in the title
      var left = tasks.length - sendable;
      var why = noLender ? NO_AGENT : (!sendable ? (tasks[0] && tasks[0].why_not) || "nothing to send about" : "");
      var tip = why || ("Send a follow-up about every task of " + who + (left ? " (" + plural(left, "other") + " can't be sent to)" : ""));
      return '<section class="cw-group' + (g.kind && g.kind !== "person" ? " unreach" : "") + '">' +
        '<div class="cw-gh">' +
          (tasks.length ? '<label class="cw-gcheck" title="Select every task of this person"><input type="checkbox" id="cwTkG' + gi +
            '" data-cw="tk-gsel" data-g="' + gi + '"' + (allOn ? " checked" : "") + ' aria-label="' + esc("Select every task of " + who) + '"></label>' : "") +
          '<button type="button" class="cw-gname" data-cw="tk-fold" data-g="' + gi + '" aria-expanded="' + (folded ? "false" : "true") + '">' +
            esc(who) + "</button>" +
          '<span class="cw-gsuf">' + esc(String(g.suffix || "").replace(/^\s*—\s*/, "")) + "</span>" +
          (tasks.length ? '<button type="button" class="c-btn link" data-cw="tk-gsend" data-g="' + gi + '" data-act' + (why ? " disabled" : "") +
            ' title="' + esc(tip) + '"' + m("tasks.followup") + ">" +
            esc(n === 1 ? "Send a follow-up about its 1 task…" : "Send a follow-up about all " + n + " tasks…") + "</button>" : "") +
        "</div>" +
        '<ul class="cw-tasks"' + (folded ? " hidden" : "") + ">" + tasks.map(function (t) { return tkTaskHtml(ctx, t); }).join("") + "</ul>" +
      "</section>";
    }).join("");
  }

  function tkStatus(root, text, bad) { setText(root, "cwTkSub", text, "c-sub" + (bad ? " cw-bad" : "")); }

  function tkDraw(root, ctx) {
    var b = TK.board;
    var focus = activeId();
    setHtml(root, "cwTkResults", resultsHtml(ctx, TK.results));
    if (b) {
      setHtml(root, "cwTkBoard", tkBoardHtml(ctx));
      setText(root, "cwTkDays", "no update for more than " + plural(b.stale_days, "day"));
      var lab = find(root, "cwTkDays");
      if (lab && b.threshold_words) lab.setAttribute("title", b.threshold_words);
      tkStatus(root, (b.status && b.status.text) || "", !!(b.status && b.status.bad));
    }
    var send = find(root, "cwTkSend");
    if (send) {
      var k = tkSelectedIds().length;
      send.textContent = "Send a follow-up about the selected task(s)…" + (k ? " (" + k + ")" : "");
      if (b && !b.lender) {
        send.disabled = true;
        send.setAttribute("title", (b.status && b.status.text) || NO_AGENT);
      }
    }
    if (/^cwTk/.test(focus)) focusId(root, focus);
  }

  function tkLoad(root, ctx, force) {
    var gen = TK.gen;
    if (!force && TK.board && TK.boardAll === TK.all && Date.now() - TK.loadedAt < TK_RELOAD_MS) {
      tkDraw(root, ctx);
      return Promise.resolve();
    }
    var done = working(ctx, find(root, "cwTkBusy"), "Loading the open tasks from the portal…");
    tkDraw(root, ctx);
    var all = TK.all;
    return ctx.rpc("tasks.board", { all: all }, { text: "Loading the tasks…", quiet: true }).then(function (b) {
      done();
      if (gen !== TK.gen) return;
      TK.board = b || { groups: [] };
      TK.boardAll = all;
      TK.loadedAt = Date.now();
      var keep = {};
      tkGroups().forEach(function (g) { (g.tasks || []).forEach(function (t) { if (TK.selected[String(t.task_id)]) keep[String(t.task_id)] = true; }); });
      TK.selected = keep;
      tkDraw(root, ctx);
    }, function (e) {
      done();
      if (gen !== TK.gen) return;
      if (TK.board && TK.board.generated) {
        tkDraw(root, ctx);
        tkStatus(root, "showing the list from " + TK.board.generated + " — the portal did not answer: " + errWords(e), true);
      } else {
        setHtml(root, "cwTkBoard", failedHtml(ctx, e));
        tkStatus(root, "the portal did not answer: " + errWords(e), true);
      }
    });
  }

  function fuArgs(fu) {
    return { task_ids: fu.ids.slice(), include_fresh: !!fu.fresh, channel: fu.channel || "", note: fu.note || "" };
  }

  /* Opens the follow-up page for these tasks. The PC is asked first, from
     the board, so a refusal ("Select one or more tasks first.", the cap, no
     lending agent) is said where the admin pressed. */
  function tkStartFollowUp(root, ctx, ids, fresh, btn) {
    if (!canAct(ctx)) return Promise.resolve();
    var say = function (w) { TK.results = [w]; tkDraw(root, ctx); };
    if (!ids.length) { say("Select one or more tasks first."); return Promise.resolve(); }
    if (ids.length > IDS_MAX) { say("Select at most " + IDS_MAX + " tasks at a time."); return Promise.resolve(); }
    var gen = TK.gen;
    var fu = { ids: ids, fresh: !!fresh, channel: "", note: "", data: null, seq: 0 };
    var call = function () {
      return ctx.rpc("tasks.followup", fuArgs(fu), { text: "Preparing the follow-up…", quiet: true }).then(function (data) {
        if (gen !== TK.gen) return;
        fu.data = data || {};
        TK.fu = fu;
        ctx.go("tasks/followup?ids=" + encodeURIComponent(ids.join(",")) + "&fresh=" + (fresh ? "1" : "0"));
      }, function (e) {
        if (gen !== TK.gen) return;
        say(errWords(e));
      });
    };
    return ctx.press && btn ? ctx.press(btn, call, "Asking the DCR server…") : call();
  }

  function renderBoard(el, ctx) {
    el.innerHTML =
      '<div class="cw">' +
        '<div class="c-head"><div><h2>Tasks</h2><p class="c-sub" id="cwTkSub">Every open task with no update, by the person it is assigned to.</p></div>' +
          '<div class="c-actions">' +
            '<button type="button" class="c-btn ghost sm" data-cw="tk-refresh"' + m("tasks.board") + ">Refresh</button>" +
            '<button type="button" class="c-btn sm" id="cwTkSend" data-cw="tk-send" data-act' + m("tasks.followup") +
              ">Send a follow-up about the selected task(s)…</button>" +
            '<a class="c-btn ghost sm" href="tasks-map.html" target="_blank" rel="noopener">Open the tasks map</a>' +
          "</div></div>" +
        '<div class="cw-bar">' +
          '<label class="c-check"><input type="checkbox" id="cwTkAll" data-cw="tk-all"' + (TK.all ? " checked" : "") +
            "> Show every open task, not only the ones with no update</label>" +
          '<span class="c-muted c-small" id="cwTkDays"></span>' +
        "</div>" +
        '<div id="cwTkResults"></div><div id="cwTkBusy"></div>' +
        '<div id="cwTkBoard"></div>' +
      "</div>";
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-cw]") : null;
      if (!t || t.disabled) return;
      var act = t.getAttribute("data-cw");
      if (act === "tk-refresh") { TK.results = []; tkLoad(el, ctx, true); }
      else if (act === "tk-send") tkStartFollowUp(el, ctx, tkSelectedIds(), false, t);
      else if (act === "tk-gsend") {
        var g = tkGroups()[Number(t.getAttribute("data-g"))];
        if (g) tkStartFollowUp(el, ctx, (g.tasks || []).map(function (x) { return String(x.task_id); }), true, t);
      } else if (act === "tk-fold") {
        var gi = Number(t.getAttribute("data-g"));
        var key = gKey(tkGroups()[gi] || {}, gi);
        if (TK.collapsed[key]) delete TK.collapsed[key]; else TK.collapsed[key] = true;
        tkDraw(el, ctx);
      } else if (act === "tk-open") ctx.go("tasks/task/" + encodeURIComponent(t.getAttribute("data-id")));
    });
    el.addEventListener("change", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var act = t.getAttribute("data-cw");
      if (act === "tk-all") {
        TK.all = !!t.checked;
        tkLoad(el, ctx, true);
      } else if (act === "tk-sel") {
        var id = String(t.getAttribute("data-id"));
        if (t.checked) TK.selected[id] = true; else delete TK.selected[id];
        tkDraw(el, ctx);
      } else if (act === "tk-gsel") {
        var g = tkGroups()[Number(t.getAttribute("data-g"))];
        ((g && g.tasks) || []).forEach(function (x) {
          if (t.checked) TK.selected[String(x.task_id)] = true; else delete TK.selected[String(x.task_id)];
        });
        tkDraw(el, ctx);
      }
    });
    if (ctx.has && !ctx.has("tasks.board")) {
      setHtml(el, "cwTkBoard", emptyHtml(ctx, UPDATE + "."));
      return Promise.resolve();
    }
    return tkLoad(el, ctx, false);
  }

  /* ── one task (the desktop's detail dialog) ──────────────────────────── */

  function renderTask(el, ctx, id) {
    var esc = ctx.esc;
    var gen = TK.gen;
    var t = tkTask(id);
    el.innerHTML =
      '<div class="cw cw-page">' +
        '<button type="button" class="c-btn link cw-back" data-cw="tk-back">← All tasks</button>' +
        '<div class="c-head"><div><h2 id="cwTdTitle">' + esc(t ? t.name : "Task " + id) + '</h2><p class="c-sub" id="cwTdWho">' +
          esc(t ? t.person : "") + "</p></div></div>" +
        '<div id="cwTdBody"></div>' +
      "</div>";
    var data = null;
    el.addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest("[data-cw]") : null;
      if (!b || b.disabled) return;
      var act = b.getAttribute("data-cw");
      if (act === "tk-back") ctx.go("tasks");
      else if (act === "tk-reload") { TK.loadedAt = 0; ctx.go("tasks"); }
      else if (act === "td-send" && data && data.can_follow_up) tkStartFollowUp(el, ctx, [String(id)], true, b);
      else if (act === "td-copy" && data) {
        var link = safeHref(data.link);
        var said = function (w) { setText(el, "cwTdMsg", w); };
        try {
          navigator.clipboard.writeText(link).then(function () { said("Copied the task's link: " + link); },
            function () { said("Could not copy — the link is " + link); });
        } catch (err) { said("Could not copy — the link is " + link); }
      }
    });
    var done = working(ctx, find(el, "cwTdBody"), "Loading the task…");
    return ctx.rpc("tasks.task", { task_id: String(id) }, { quiet: true }).then(function (d) {
      done();
      if (gen !== TK.gen) return;
      data = d || {};
      if (data.name) setText(el, "cwTdTitle", data.name);
      if (data.person) setText(el, "cwTdWho", data.person);
      var link = safeHref(data.link);
      var why = data.can_follow_up ? "" : (data.why_not || "no follow-up can go about this task");
      var rows = (data.rows || []).map(function (r) { return [r.label, r.text]; });
      setHtml(el, "cwTdBody",
        '<div class="c-card">' + (ctx.ui && ctx.ui.kv ? ctx.ui.kv(rows) : rows.map(function (r) { return esc(r[0] + ": " + r[1]); }).join("<br>")) + "</div>" +
        '<div class="c-card"><h3>Completed Work (the notes, newest last)</h3><div class="c-pre cw-notes">' + esc(data.notes || "No notes yet.") + "</div></div>" +
        '<div class="c-actions">' +
          '<button type="button" class="c-btn" data-cw="td-send" data-act' + (why ? ' disabled title="' + esc(why) + '"' : "") + m("tasks.followup") + ">" +
            esc("Send a follow-up…" + (why ? " (" + why + ")" : "")) + "</button>" +
          (link ? '<a class="c-btn ghost" href="' + esc(link) + '" target="_blank" rel="noopener">Open this task in the portal</a>' +
            '<button type="button" class="c-btn ghost" data-cw="td-copy">Copy the task\'s link</button>' : "") +
        "</div>" +
        '<p class="cw-msg" id="cwTdMsg" role="status"></p>');
    }, function (e) {
      done();
      if (gen !== TK.gen) return;
      setHtml(el, "cwTdBody", failedHtml(ctx, e) +
        (e && e.code === "not_found" ? '<div class="c-actions"><button type="button" class="c-btn" data-cw="tk-reload">Reload the board</button></div>' : ""));
    });
  }

  /* ── the follow-up (the desktop's follow-up dialog) ──────────────────── */

  function fuPreviewHtml(ctx, d, pending) {
    var esc = ctx.esc;
    var p = d.preview || {};
    return '<div class="cw-plabel">' + esc(p.label || "Preview") + (pending ? ' <span class="c-muted">— updating…</span>' : "") + "</div>" +
      '<div class="cw-ptext">' + esc(p.text || "") + "</div>" +
      ((d.problems || []).length ? '<ul class="cw-probs">' + d.problems.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" : "") +
      ((d.warnings || []).length ? '<ul class="cw-warns">' + d.warnings.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" : "");
  }

  function fuRadiosHtml(ctx, fu) {
    var esc = ctx.esc;
    return ((fu.data && fu.data.radios) || []).map(function (r) {
      var kind = String(r.kind || "");
      var on = kind === (fu.channel || "");
      return '<label class="cw-radio' + (r.enabled ? "" : " off") + '"><input type="radio" name="cwFuCh" value="' + esc(kind) + '" data-cw="fu-ch"' +
        (on ? " checked" : "") + (r.enabled ? "" : " disabled") + "><span>" + esc(r.text) + "</span></label>";
    }).join("");
  }

  function fuDrawPreview(root, ctx, fu, pending) {
    var d = fu.data || {};
    setHtml(root, "cwFuPreview", fuPreviewHtml(ctx, d, pending));
    var send = find(root, "cwFuSend");
    if (send && !send.getAttribute("aria-busy")) {
      send.disabled = !d.can_send || !!(ctx.has && !ctx.has("tasks.followup_send"));
      send.textContent = d.send_label || "Send";
    }
  }

  function fuRefresh(root, ctx) {
    var fu = TK.fu;
    if (!fu) return Promise.resolve();
    if (TK.noteTimer) { clearTimeout(TK.noteTimer); TK.noteTimer = null; }
    var seq = ++fu.seq;
    var gen = TK.gen;
    fuDrawPreview(root, ctx, fu, true);
    return ctx.rpc("tasks.followup", fuArgs(fu), { quiet: true }).then(function (d) {
      if (gen !== TK.gen || TK.fu !== fu || seq !== fu.seq) return;
      fu.data = d || fu.data;
      fuDrawPreview(root, ctx, fu, false);
      setText(root, "cwFuMsg", "", "cw-msg");
    }, function (e) {
      if (gen !== TK.gen || TK.fu !== fu || seq !== fu.seq) return;
      fuDrawPreview(root, ctx, fu, false);
      var send = find(root, "cwFuSend");
      if (send) send.disabled = true;
      setText(root, "cwFuMsg", errWords(e), "cw-msg cw-bad");
    });
  }

  function fuSend(root, ctx, btn) {
    var fu = TK.fu;
    if (!fu || !canAct(ctx)) return Promise.resolve();
    var gen = TK.gen;
    /* the last keys typed are in what is checked (the desktop's _send) */
    var first = TK.noteTimer ? fuRefresh(root, ctx) : Promise.resolve();
    return first.then(function () {
      if (gen !== TK.gen || TK.fu !== fu || !fu.data || !fu.data.can_send) return;
      var n = fu.ids.length;
      var words = n > 1 ? "Sending " + n + " follow-ups — this can take a few minutes…" : "Sending the follow-up…";
      var call = function () {
        return ctx.act("tasks.followup_send", fuArgs(fu), { text: words, quiet: true }).then(function (data) {
          if (gen !== TK.gen || TK.fu !== fu || !data) return;
          TK.results = (data.lines || []).slice();
          if (!TK.results.length) TK.results = ["Nothing was sent."];
          TK.selected = {};
          TK.fu = null;
          TK.loadedAt = 0;       // the board is read again, with the lines kept over it
          ctx.go("tasks");
        }, function (e) {
          if (gen !== TK.gen || TK.fu !== fu) return;
          setText(root, "cwFuMsg", errWords(e), "cw-msg cw-bad");
        });
      };
      return ctx.press && btn ? ctx.press(btn, call, n > 1 ? "Sending " + n + "…" : "Sending…") : call();
    }).then(function () {
      if (gen === TK.gen && TK.fu === fu) fuDrawPreview(root, ctx, fu, false);
    });
  }

  function renderFollowUp(el, ctx) {
    var esc = ctx.esc;
    var q = (ctx.route && ctx.route.query) || {};
    var ids = String(q.ids || "").split(",").map(function (x) { return x.trim(); }).filter(function (x) { return /^\d{1,10}$/.test(x); });
    var fresh = String(q.fresh || "") === "1";
    var fu = TK.fu;
    if (!fu || fu.ids.join(",") !== ids.join(",") || !!fu.fresh !== fresh) {
      fu = TK.fu = ids.length ? { ids: ids, fresh: fresh, channel: "", note: "", data: null, seq: 0 } : null;
    }
    el.innerHTML = '<div class="cw cw-page"><button type="button" class="c-btn link cw-back" data-cw="tk-back">← Back to the tasks</button>' +
      '<div id="cwFuBody"></div></div>';
    var gen = TK.gen;

    function draw() {
      var d = fu.data || {};
      var dry = !!(TK.board && TK.board.dry) || /^Dry run/.test(String(d.summary || ""));
      setHtml(el, "cwFuBody",
        '<div class="c-head"><div><h2>' + esc(d.title || "Follow up") + "</h2></div></div>" +
        '<div class="c-card">' +
          '<div class="cw-to">' + esc(d.to || "") + "</div>" +
          (d.about ? '<div class="cw-about">' + esc(d.about) + "</div>" : "") +
          (d.summary ? '<p class="cw-sum' + (dry ? " cw-bad" : "") + '">' + esc(d.summary) + "</p>" : "") +
          (d.account_note ? '<p class="cw-sum">' + esc(d.account_note) + "</p>" : "") +
        "</div>" +
        '<div class="c-card"><h3>Send by</h3><div role="radiogroup" aria-label="Send by">' + fuRadiosHtml(ctx, fu) + "</div></div>" +
        '<div class="c-card">' +
          '<label class="c-label" for="cwFuNote">Note from the office (optional):</label>' +
          '<div class="cw-noterow"><input type="text" id="cwFuNote" data-cw="fu-note" maxlength="' + NOTE_MAX + '" autocomplete="off" ' +
            'placeholder="Add a note from the office (optional)" value="' + esc(fu.note) + '">' +
            '<span class="cw-count" id="cwFuCount">' + fu.note.length + " / " + NOTE_MAX + "</span></div>" +
        "</div>" +
        '<div class="c-card" id="cwFuPreview" aria-live="polite"></div>' +
        ((d.skipped || []).length ? '<div class="c-card flat"><h3>Left out</h3><ul class="cw-warns">' +
          d.skipped.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul></div>" : "") +
        '<div class="c-actions">' +
          '<button type="button" class="c-btn" id="cwFuSend" data-cw="fu-send" data-act' + m("tasks.followup_send") + ">" + esc(d.send_label || "Send") + "</button>" +
          '<button type="button" class="c-btn ghost" data-cw="tk-back">Cancel</button>' +
        "</div>" +
        '<p class="cw-msg" id="cwFuMsg" role="status"></p>');
      fuDrawPreview(el, ctx, fu, false);
    }

    el.addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest("[data-cw]") : null;
      if (!b || b.disabled) return;
      var act = b.getAttribute("data-cw");
      if (act === "tk-back") { TK.fu = null; ctx.go("tasks"); }
      else if (act === "fu-send") fuSend(el, ctx, b);
    });
    el.addEventListener("change", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || t.getAttribute("data-cw") !== "fu-ch" || !TK.fu) return;
      TK.fu.channel = String(t.value || "");
      fuRefresh(el, ctx);
    });
    el.addEventListener("input", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || t.getAttribute("data-cw") !== "fu-note" || !TK.fu) return;
      var v = String(t.value || "").slice(0, NOTE_MAX);
      TK.fu.note = v;
      setText(el, "cwFuCount", v.length + " / " + NOTE_MAX);
      if (TK.noteTimer) clearTimeout(TK.noteTimer);
      TK.noteTimer = setTimeout(function () { TK.noteTimer = null; fuRefresh(el, ctx); }, NOTE_WAIT_MS);
    });
    /* Enter in the note never sends: a half-typed note would go out by
       whatever route Automatic picked before the preview was read. */
    el.addEventListener("keydown", function (e) {
      var t = e.target;
      if (e.key === "Enter" && t && t.getAttribute && t.getAttribute("data-cw") === "fu-note") e.preventDefault();
    });

    if (!fu) {
      setHtml(el, "cwFuBody", emptyHtml(ctx, "Select one or more tasks first."));
      return Promise.resolve();
    }
    if (fu.data) { draw(); return Promise.resolve(); }
    var done = working(ctx, find(el, "cwFuBody"), "Preparing the follow-up…");
    return ctx.rpc("tasks.followup", fuArgs(fu), { quiet: true }).then(function (d) {
      done();
      if (gen !== TK.gen || TK.fu !== fu) return;
      fu.data = d || {};
      draw();
    }, function (e) {
      done();
      if (gen !== TK.gen) return;
      setHtml(el, "cwFuBody", failedHtml(ctx, e) +
        '<div class="c-actions"><button type="button" class="c-btn ghost" data-cw="tk-back">Back to the tasks</button></div>');
    });
  }

  function renderTasks(el, ctx) {
    style();
    TK.gen++;
    if (TK.noteTimer) { clearTimeout(TK.noteTimer); TK.noteTimer = null; }
    var parts = (ctx.route && ctx.route.parts) || [];
    if (parts[0] === "task" && /^\d{1,10}$/.test(String(parts[1] || ""))) return renderTask(el, ctx, String(parts[1]));
    if (parts[0] === "followup") return renderFollowUp(el, ctx);
    TK.fu = null;
    return renderBoard(el, ctx);
  }

  function leaveTasks() {
    TK.gen++;
    if (TK.noteTimer) { clearTimeout(TK.noteTimer); TK.noteTimer = null; }
  }

  /* ── registration ────────────────────────────────────────────────────── */

  window.DCRConsoleWork = { dayWord: dayWord, hoursText: hoursText, safeHref: safeHref, _ts: TS, _tk: TK };
  if (window.DCRConsole && typeof window.DCRConsole.register === "function") {
    window.DCRConsole.register({ id: "timesheets", title: "Timesheets", order: 30, render: renderTimesheets, leave: function () { TS.gen++; } });
    window.DCRConsole.register({ id: "tasks", title: "Tasks", order: 40, render: renderTasks, leave: leaveTasks });
  }
})();
