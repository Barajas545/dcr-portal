/* DCR Agents web console — the Training tab (console-spec §6.1.11, §6.4).

   The desktop's Training tab, from any admin's phone or desk: everything
   that can be taught (the whole company, reading replies, each agent, the
   personal assistants and each person on People) and, for the one picked,
   its rules (add, change, turn off, delete), what every agent knows about a
   person (language, time away, no-contact days, notes), the reply examples,
   the messages Claude wrote for an agent, the recent lessons, and the
   Coach: a chat that proposes each lesson as a card — a setting shows
   before → after — which you apply or dismiss. Export saves the training
   as a file from this browser; import reads a file here and asks twice.

   Everything runs on the DCR server computer through the shell's relay
   (ctx.rpc / ctx.act, agents-console.js). A Coach card is applied by the
   Coach's answer and the card's place in it (chat_id, n): the server looks
   the proposal up itself, the page never sends it. The words are the
   desktop's own (training/views.py); every question before a change is the
   server's, shown by ctx.act. Every string from the server goes through
   ctx.esc; links are relative (#/…) and built from encodeURIComponent. Write
   controls carry data-act and data-method (the shell greys them while
   nothing can be changed, or when the server's build lacks the method).
   The Coach box keeps its draft per scope in sessionStorage (this browser
   tab only) — the Assistants tab's "Teach from this…" puts a message there. */
(function () {
  "use strict";
  if (!window.DCRConsole || typeof window.DCRConsole.register !== "function") return;

  var TAB = "training";
  var DRAFT_PREFIX = "dcr.console.training.draft.v1:";
  var COMPANY = "company";
  var OLD_MS = 60000;
  var RULE_MAX = 500, SAID_MAX = 1000, MEANT_MAX = 500, COACH_MAX = 4000, ARGS_MAX = 20000;
  var WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var LANGUAGES = [["", "Not set"], ["en", "English"], ["es", "Spanish (Español)"]];
  var TONES = { green: "good", amber: "warn", red: "bad", grey: "", blue: "info", purple: "purple" };
  var TOO_BIG = "That file is too large for the web — import it on the DCR server computer (Training → Import…).";

  var S = {
    ctx: null, el: null, gen: 0,
    tree: null, treeAt: 0, q: "", searchTimer: null,
    scope: "", routeScope: "", view: "knows",
    page: null, pageAt: 0,
    pending: {},                 // scope → the words the Coach is answering now
    wsel: null,                  // the "Messages Claude wrote" version on screen
    facts: null,                 // what the facts form loaded (to tell what changed)
  };

  /* ── small helpers ──────────────────────────────────────────────────── */

  function esc(v) { return S.ctx && S.ctx.esc ? S.ctx.esc(v) : window.DCR.esc(v); }
  function $(id) { return document.getElementById(id); }
  function enc(v) { return encodeURIComponent(String(v == null ? "" : v)); }
  function href(scope, view) { return "#/" + TAB + (scope ? "/" + enc(scope) : "") + (view ? "?view=" + enc(view) : ""); }
  function decodePart(p) {
    var s = String(p == null ? "" : p);
    if (!/%[0-9A-Fa-f]{2}/.test(s)) return s;
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }
  function parts(scope) {
    var s = String(scope || ""), i = s.indexOf(":");
    return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
  }
  function toneOf(t) { return Object.prototype.hasOwnProperty.call(TONES, t) ? TONES[t] : ""; }
  function chip(text, t, title) {
    return text ? '<span class="c-chip' + (toneOf(t) ? " " + toneOf(t) : "") + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" +
      esc(text) + "</span>" : "";
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
  function line(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function need(method) { return ' data-method="' + esc(method) + '"'; }
  function when(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return "";
    var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return days[d.getDay()] + " " + months[d.getMonth()] + " " + d.getDate() + " " +
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function errText(e) { return (e && e.message) || "Something went wrong on the way to the DCR server."; }
  function storage() { try { return window.sessionStorage || null; } catch (e) { return null; } }
  function draftGet(scope) { var s = storage(); try { return (s && s.getItem(DRAFT_PREFIX + scope)) || ""; } catch (e) { return ""; } }
  function draftSet(scope, text) {
    var s = storage();
    try { if (s) { if (text) s.setItem(DRAFT_PREFIX + scope, text); else s.removeItem(DRAFT_PREFIX + scope); } } catch (e) { /* private window */ }
  }
  function ask(method, args, opts) { var o = opts || {}; o.quiet = true; return S.ctx.rpc(method, args || {}, o); }
  function act(method, args, opts) { return S.ctx.act(method, args || {}, opts || {}); }
  function press(btn, fn, words) {
    if (S.ctx.press && btn) return S.ctx.press(btn, fn, words);
    return Promise.resolve().then(fn);
  }
  function live(g) { return g === S.gen; }
  function toast(text, isBad) { if (S.ctx && S.ctx.toast) S.ctx.toast(text, { bad: !!isBad }); }
  function say(text, isBad, g) {
    var n = $("ctSay");
    if (n && (g === undefined || live(g))) { n.textContent = text || ""; n.className = "ct-say" + (isBad ? " bad" : ""); }
    else if (text) toast(text, isBad);
  }
  function lock(input, on) { if (input && "disabled" in input) input.disabled = !!on; }
  function wide() {
    try { return !!(window.matchMedia && window.matchMedia("(min-width: 1000px)").matches); } catch (e) { return false; }
  }
  function failed(e, retry) {
    if (S.ctx.ui && S.ctx.ui.failed) return S.ctx.ui.failed(e);
    return '<div class="c-error" role="alert"><b>That did not work.</b><span>' + esc(errText(e)) + '</span><div class="c-actions">' +
      '<button type="button" class="c-btn ghost sm" data-ct="' + esc(retry) + '">Try again</button></div></div>';
  }
  /* A message as the "Messages Claude wrote" page shows it (template_words). */
  function templateWords(subject, body, sms) {
    return [subject ? "Subject: " + subject : "", body || "", sms ? "Short text: " + sms : ""].filter(Boolean).join("\n\n");
  }

  /* ── styles: the shell's vocabulary plus this tab's layout ─────────── */

  var CSS = [
    ".ct{--ct-purple:#6a48b5;--ct-purple-bg:rgba(107,75,184,.13);--ct-mine:#2f80d8;}",
    "@media (prefers-color-scheme: dark){:root:not([data-theme=\"light\"]) .ct{--ct-purple:#c3aef5;--ct-purple-bg:rgba(160,130,240,.17);--ct-mine:#2a6fb8;}}",
    ":root[data-theme=\"dark\"] .ct{--ct-purple:#c3aef5;--ct-purple-bg:rgba(160,130,240,.17);--ct-mine:#2a6fb8;}",
    ".ct .c-chip.purple{background:var(--ct-purple-bg);color:var(--ct-purple);}",
    ".ct .c-field > label.c-check{display:inline-flex;align-items:center;gap:9px;margin:0 0 4px;}",
    ".ct input[type=checkbox]{width:22px;height:22px;padding:0;margin:0;accent-color:var(--acc);flex:none;}",
    ".ct-top{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:0 0 12px;}",
    ".ct-top .grow{flex:1 1 auto;}",
    /* on a phone the bar is for the list; a scope's page starts with the scope */
    "@media (max-width:999px){.ct.scoped .ct-top{display:none;}}",
    "@media (max-width:640px){.ct .ct-convo{max-height:none;overflow:visible;}}",
    "@media (max-width:640px){.ct-top .grow{display:none;}.ct-top .c-check{flex:1 1 100%;}.ct-top .c-btn{flex:1 1 0;}}",
    ".ct-grid{display:grid;gap:16px;grid-template-columns:minmax(0,1fr);align-items:start;}",
    "@media (min-width:1000px){.ct-grid{grid-template-columns:270px minmax(0,1fr);}.ct-back{display:none;}",
    ".ct-side{position:sticky;top:8px;max-height:calc(100vh - 16px);overflow:auto;padding:1px 3px 2px 1px;}}",
    "@media (max-width:999px){.ct-grid.has-scope .ct-side{display:none;}.ct-grid:not(.has-scope) .ct-main{display:none;}}",
    ".ct-search input{min-height:44px;font-size:16px;margin:0 0 6px;}",
    ".ct-tree,.ct-tree ul{list-style:none;margin:0;padding:0;}.ct-tree ul{margin:0 0 4px;}",
    ".ct-ghead{display:flex;align-items:baseline;gap:6px;margin:14px 0 4px 2px;font-size:12px;font-weight:800;text-transform:uppercase;",
    "letter-spacing:.06em;color:var(--text-muted);}",
    ".ct-node{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 6px;min-height:44px;padding:9px 10px;margin:0 0 3px;border-radius:10px;",
    "border:1px solid transparent;color:var(--text);text-decoration:none;font-size:14px;}",
    ".ct-node:hover{background:var(--surface);border-color:var(--border);}.ct-node:focus-visible{outline:2px solid var(--acc);outline-offset:1px;}",
    ".ct-node.sel{background:var(--surface);border-color:var(--acc);box-shadow:0 0 0 2px var(--tint-2);}",
    ".ct-node.dim .ct-nname{color:var(--text-muted);}",
    ".ct-nname{font-weight:700;overflow-wrap:anywhere;}.ct-nsuf{font-size:12.5px;color:var(--text-muted);overflow-wrap:anywhere;}",
    ".ct-back{margin:0 0 4px;}.ct-back a{display:inline-flex;align-items:center;min-height:44px;font-weight:700;text-decoration:none;color:var(--acc-text);}",
    ".ct-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;}",
    ".ct-head h2{margin:0 4px 0 0;font-size:21px;line-height:1.25;overflow-wrap:anywhere;}",
    ".ct-head .grow{flex:1 1 auto;}",
    ".ct-say{margin:8px 0 0;font-size:14px;font-weight:700;color:var(--good);overflow-wrap:anywhere;}.ct-say:empty{display:none;}.ct-say.bad{color:var(--bad);}",
    ".ct-tabs{display:flex;gap:2px;overflow-x:auto;overflow-y:hidden;margin:12px 0;border-bottom:1px solid var(--border);scrollbar-width:thin;}",
    ".ct-tab{display:inline-flex;align-items:center;min-height:44px;padding:8px 12px;white-space:nowrap;color:var(--text-muted);",
    "text-decoration:none;font-weight:700;font-size:14px;border-bottom:3px solid transparent;margin-bottom:-1px;}",
    ".ct-tab:hover{color:var(--text);}.ct-tab[aria-current=page]{color:var(--text);border-bottom-color:var(--acc);}",
    ".ct-body{display:grid;gap:16px;grid-template-columns:minmax(0,1fr);align-items:start;}",
    "@media (max-width:1099px){.ct-body[data-view=coach] .ct-left{display:none;}.ct-body:not([data-view=coach]) .ct-coach{display:none;}}",
    "@media (min-width:1100px){.ct-body{grid-template-columns:minmax(0,1fr) minmax(0,1fr);}.ct-tab.coach{display:none;}",
    ".ct-coach{position:sticky;top:8px;}}",
    ".ct-note{margin:4px 0 10px;color:var(--text-muted);font-size:13.5px;overflow-wrap:anywhere;}",
    ".ct h3{margin:14px 0 2px;font-size:16px;font-weight:800;}.ct .ct-left > h3:first-child,.ct .c-card > h3:first-child{margin-top:0;}",
    ".ct-away{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;}",
    ".ct-away input[type=date]{width:auto;flex:1 1 150px;max-width:200px;min-height:44px;font-size:16px;color-scheme:light dark;}",
    ".ct-thru{display:inline-flex;align-items:center;gap:8px;flex:1 1 220px;max-width:290px;}",
    ".ct-days{display:flex;flex-wrap:wrap;gap:2px 14px;}",
    ".ct-ft{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;margin-top:10px;}",
    ".ct-ft .grow{flex:1 1 180px;color:var(--text-muted);font-size:13px;}",
    ".ct-err{margin:6px 0 0;color:var(--bad);font-weight:700;font-size:14px;}.ct-err:empty{display:none;}",
    ".ct-list{list-style:none;margin:0;padding:0;}",
    ".ct-rule{display:flex;gap:10px;align-items:flex-start;padding:4px 12px 6px;margin:0 0 8px;border:1px solid var(--border);border-radius:12px;background:var(--surface);}",
    ".ct-rule.off .ct-rtext{color:var(--text-muted);}",
    ".ct-on{display:flex;align-items:center;justify-content:center;min-width:36px;min-height:44px;margin:0;cursor:pointer;}",
    ".ct-rbody{flex:1 1 auto;min-width:0;padding-top:9px;}.ct-rtext{overflow-wrap:anywhere;}",
    ".ct-rmeta{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;margin-top:3px;font-size:12.5px;color:var(--text-muted);}",
    ".ct-pair{display:inline-flex;gap:12px;white-space:nowrap;}",
    ".ct-bar{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0;align-items:center;}",
    ".ct-ex{padding:10px 12px 4px;margin:0 0 8px;border:1px solid var(--border);border-radius:12px;background:var(--surface);overflow-wrap:anywhere;}",
    ".ct-ex .lbl{display:block;font-size:12px;font-weight:700;color:var(--text-muted);}.ct-ex .lbl.gap{margin-top:4px;}",
    ".ct-wrows{list-style:none;margin:0 0 10px;padding:0;}",
    ".ct-wrow{display:flex;flex-wrap:wrap;gap:2px 10px;align-items:baseline;width:100%;text-align:left;min-height:44px;padding:8px 12px;margin:0 0 6px;",
    "border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--text);font-size:14px;cursor:pointer;}",
    ".ct-wrow.sel{border-color:var(--acc);box-shadow:0 0 0 2px var(--tint-2);}",
    ".ct-wrow b{flex:1 1 200px;overflow-wrap:anywhere;}.ct-wrow .c-muted{font-size:12.5px;}",
    /* side by side while the page has the width to itself; stacked beside the Coach */
    ".ct-wdetail{display:grid;gap:10px;grid-template-columns:minmax(0,1fr);}",
    "@media (min-width:700px) and (max-width:1099px){.ct-wdetail{grid-template-columns:1fr 1fr;}}",
    ".ct-wdetail h4{margin:0 0 4px;font-size:13px;}",
    ".ct-pre{margin:0;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13.5px;",
    "background:var(--surface);border:1px solid var(--border);border-radius:12px;min-height:60px;}",
    ".ct-lesson{padding:8px 12px;margin:0 0 6px;border:1px solid var(--border);border-radius:12px;background:var(--surface);overflow-wrap:anywhere;}",
    ".ct-lesson .top{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;}.ct-lesson .top .c-muted{font-size:12.5px;}",
    ".ct-lesson .detail{font-size:13.5px;color:var(--text-muted);margin-top:2px;white-space:pre-wrap;}",
    ".ct-coach{padding:12px 14px 14px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);}",
    ".ct-convo{display:flex;flex-direction:column;gap:10px;max-height:62vh;overflow:auto;padding:2px;margin:8px 0;}",
    ".ct-turn{display:flex;flex-direction:column;max-width:92%;align-self:flex-start;}.ct-turn.mine{align-self:flex-end;align-items:flex-end;}",
    ".ct-meta{font-size:12px;font-weight:700;color:var(--text-muted);margin:0 4px 2px;}",
    ".ct-bubble{padding:9px 12px;border-radius:14px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;",
    "background:var(--surface);border:1px solid var(--border);border-bottom-left-radius:4px;}",
    ".ct-turn.mine .ct-bubble{background:var(--ct-mine);color:#fff;border-color:transparent;border-bottom-left-radius:14px;border-bottom-right-radius:4px;}",
    ".ct-turn.thinking .ct-bubble{color:var(--text-muted);font-style:italic;}",
    ".ct-card{align-self:stretch;margin:0 0 0 14px;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--surface);}",
    ".ct-card.done{opacity:.86;}",
    ".ct-chead{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;}.ct-chead b{flex:1 1 140px;overflow-wrap:anywhere;font-size:14px;}",
    ".ct-cbody{margin-top:6px;font-size:14px;overflow-wrap:anywhere;white-space:pre-wrap;}",
    ".ct-diff{margin-top:5px;padding:5px 9px;border-radius:8px;font-size:13.5px;overflow-wrap:anywhere;white-space:pre-wrap;}",
    ".ct-diff.before{background:var(--bad-bg);}.ct-diff.after{background:var(--good-bg);}",
    ".ct-diff b{font-size:12px;margin-right:6px;}",
    ".ct-cextra{margin-top:5px;font-size:12.5px;color:var(--text-muted);overflow-wrap:anywhere;}",
    ".ct-csaid{margin-top:5px;font-size:13px;color:var(--good);overflow-wrap:anywhere;}",
    ".ct-cprob{margin-top:5px;font-size:13px;color:var(--text-muted);overflow-wrap:anywhere;}.ct-cprob.bad{color:var(--bad);}",
    ".ct-cft{display:flex;justify-content:flex-end;gap:8px;margin-top:8px;}",
    ".ct-coach textarea{min-height:84px;font-size:16px;font-family:inherit;line-height:1.45;resize:vertical;}",
  ].join("\n");

  function ensureStyle() {
    if (!document.getElementById || document.getElementById("ctStyle")) return;
    if (!document.createElement || !document.head) return;
    var st = document.createElement("style");
    st.id = "ctStyle";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ── the tab ───────────────────────────────────────────────────────── */

  function render(el, ctx) {
    S.gen += 1;
    S.ctx = ctx;
    S.el = el;
    var route = ctx.route || {};
    var p = route.parts || [];
    var q = route.query || {};
    S.routeScope = p.length ? decodePart(p[0]) : "";
    S.scope = S.routeScope || (wide() ? COMPANY : "");
    S.view = /^(knows|examples|wording|lessons|coach)$/.test(String(q.view || "")) ? String(q.view) : "knows";
    if (!S.page || S.page.scope !== S.scope) { S.wsel = null; S.facts = null; }
    ensureStyle();
    el.innerHTML = '<div class="ct' + (S.routeScope ? " scoped" : "") + '" id="ctRoot">' +
      '<div class="ct-top" id="ctTop"></div>' +
      '<div class="ct-grid' + (S.routeScope ? " has-scope" : "") + '">' +
      '<aside class="ct-side" aria-label="Everything that can be taught">' +
      '<div class="ct-search"><label for="ctSearch" class="c-sr">Find a person</label>' +
      '<input type="search" id="ctSearch" maxlength="60" autocomplete="off" placeholder="Find a person…" value="' + esc(S.q) + '" /></div>' +
      '<div id="ctTree"><div class="c-skel"></div><div class="c-skel"></div><div class="c-skel"></div></div></aside>' +
      '<section class="ct-main" id="ctMain">' + (S.scope ? '<div class="c-skel"></div><div class="c-skel"></div>' : "") + "</section></div>" +
      '<input type="file" id="ctImportFile" accept="application/json,.json" hidden data-ct="import-file" /></div>';
    el.addEventListener("click", onClick);
    el.addEventListener("change", onChange);
    el.addEventListener("input", onInput);
    el.addEventListener("submit", onSubmit);
    el.addEventListener("keydown", onKey);
    if (ctx.guard) ctx.guard(unsaved);
    var g = S.gen;
    var jobs = [loadTree(g, false)];
    if (S.scope) jobs.push(loadScope(g, false));
    return Promise.all(jobs).then(function () {});
  }

  function leave() {
    S.gen += 1;
    if (S.searchTimer) { clearTimeout(S.searchTimer); S.searchTimer = null; }
  }

  /* What leaving would lose: a person's facts changed but not saved. (The
     Coach box keeps its own draft.) */
  function unsaved() {
    var d = S.page;
    if (!d || !d.facts || !$("ctFacts")) return "";
    return Object.keys(factsChanges()).length ? "What the agents know about " + personName(d) + " has changes that are not saved." : "";
  }

  /* ── the top bar and the left list ─────────────────────────────────── */

  function loadTree(g, force) {
    if (S.tree && !force && Date.now() - S.treeAt < OLD_MS) { drawTop(); drawTree(); return Promise.resolve(); }
    var had = S.tree;
    if (had) { drawTop(); drawTree(); }
    var q = S.q;
    return ask("training.tree", q ? { q: q } : {}).then(function (d) {
      if (q !== S.q) return;
      var changed = !had || JSON.stringify(had) !== JSON.stringify(d);
      S.tree = d;
      S.treeAt = Date.now();
      if (live(g) && changed) { drawTop(); drawTree(); }
    }, function (e) {
      if (!live(g)) return;
      var t = $("ctTree");
      if (t && !S.tree) t.innerHTML = failed(e, "reload-tree");
    });
  }

  function drawTop() {
    var top = $("ctTop");
    var d = S.tree;
    if (!top || !d) return;
    var coach = d.coach || {};
    top.innerHTML = chip((coach.ok ? "● " : "") + (coach.words || ""), coach.ok ? "green" : "amber", "Settings → Claude AI on the DCR server computer") +
      '<span class="grow"></span>' +
      '<label class="c-check" title="Claude rewrites the words of the agents that have it turned on, using the training">' +
      '<input type="checkbox" id="ctSmart" data-ct="smart" data-act' + need("training.smart") + (d.smart_on ? " checked" : "") +
      " /> Smart wording on the DCR server</label>" +
      '<button type="button" class="c-btn ghost sm" data-ct="export"' + need("training.export") + ">Export…</button>" +
      '<button type="button" class="c-btn ghost sm" data-ct="import" data-act' + need("training.import") + ">Import…</button>";
  }

  function nodeHtml(n) {
    if (n.header) {
      return '<li><div class="ct-ghead"><span>' + esc(n.name) + '</span><span class="ct-nsuf">' + esc(line(n.suffix)) + "</span></div>" +
        "<ul>" + (n.children || []).map(nodeHtml).join("") + "</ul></li>";
    }
    var sel = n.scope === S.scope;
    var suffix = line(String(n.suffix || "").replace(/^\s*·\s*/, ""));
    return '<li><a class="ct-node' + (sel ? " sel" : "") + (n.dim ? " dim" : "") + '" href="' + esc(href(n.scope)) + '"' +
      (n.tip ? ' title="' + esc(n.tip) + '"' : "") + (sel ? ' aria-current="page"' : "") + '><span class="ct-nname">' + esc(n.name) +
      "</span>" + (suffix ? '<span class="ct-nsuf">' + esc(suffix) + "</span>" : "") + "</a></li>";
  }

  function drawTree() {
    var t = $("ctTree");
    if (!t || !S.tree) return;
    t.innerHTML = '<ul class="ct-tree">' + (S.tree.nodes || []).map(nodeHtml).join("") + "</ul>";
  }

  /* ── one scope ─────────────────────────────────────────────────────── */

  function loadScope(g, force) {
    var scope = S.scope;
    var same = S.page && S.page.scope === scope;
    if (same && !force && Date.now() - S.pageAt < OLD_MS) { drawMain(); return Promise.resolve(); }
    if (same && !force) drawMain();
    return ask("training.scope", { scope: scope }).then(function (d) {
      if (scope !== S.scope) return;
      if (!S.page || S.page.scope !== d.scope) { S.wsel = null; S.facts = null; }
      /* drawn again only when the answer changed (always after a change of ours) */
      var changed = !same || JSON.stringify(S.page) !== JSON.stringify(d);
      S.page = d;
      S.pageAt = Date.now();
      /* An employee's scope comes back in People's spelling. */
      if (d.scope && d.scope !== S.scope) S.scope = d.scope;
      if (live(g) && (force || changed)) { drawMain(); drawTree(); }
    }, function (e) {
      if (!live(g)) return;
      var m = $("ctMain");
      if (m) m.innerHTML = backLink() + failed(e, "reload-scope");
    });
  }

  function backLink() { return '<div class="ct-back"><a href="' + esc(href("")) + '">‹ Everything that can be taught</a></div>'; }

  function headLink(d) {
    var words = (d.describe || {}).head_button;
    if (!words) return "";
    var pr = parts(d.scope), to;
    if (pr[0] === "agent") to = "#/agents/edit/" + enc(pr[1]);
    else if (pr[0] === "employee") to = "#/assistants/" + enc(pr[1]);
    else to = "#/assistants";
    /* A link here, not a dialog as on the desktop: no trailing "…". */
    return '<a class="c-btn ghost sm" href="' + esc(to) + '">' + esc(String(words).replace(/…$/, "")) + "</a>";
  }

  function tabsFor(d) {
    var tabs = [["knows", "What it knows"]];
    if (d.examples !== null && d.examples !== undefined) tabs.push(["examples", "Examples"]);
    if (d.wording !== null && d.wording !== undefined) tabs.push(["wording", "Messages Claude wrote"]);
    tabs.push(["lessons", "Recent lessons"], ["coach", "Coach"]);
    return tabs;
  }

  function drawMain() {
    var m = $("ctMain");
    var d = S.page;
    if (!m || !d) return;
    var desc = d.describe || {};
    var head = backLink() + '<div class="ct-head"><h2>' + esc(desc.title) + "</h2>" +
      (d.chips || []).map(function (c) { return chip(c.text, c.tone, c.tip); }).join("") + '<span class="grow"></span>' + headLink(d) +
      '<button type="button" class="c-btn ghost sm" data-ct="reload-scope">Refresh</button></div>' +
      (desc.subtitle ? '<p class="c-sub">' + esc(desc.subtitle) + "</p>" : "") +
      '<p class="ct-say" id="ctSay" aria-live="polite"></p>';
    if (d.photo) {
      m.innerHTML = head + '<div class="c-card"><h3>Taught in Photo & Video → Playbook & Coach</h3>' +
        '<p class="ct-note">The Photo & Video agent keeps its own Playbook — how jobs are shot, what the photographer should never do — and ' +
        "its own Coach, on the Photo & Video tab. Every plan it writes follows the Playbook. The company rules here apply to it too, and " +
        "the rules under its agent on the left shape the reminders' words when smart wording is on.</p>" +
        "<p>" + esc(d.photo_count) + "</p>" +
        '<a class="c-btn" href="#/photo/playbook">Open Photo & Video → Playbook & Coach</a></div>';
      return;
    }
    var tabs = tabsFor(d);
    if (!tabs.some(function (t) { return t[0] === S.view; })) S.view = "knows";
    var left = S.view === "coach" ? "knows" : S.view;
    /* what was changed here in a person's facts and not saved yet stays,
       over the newer answer (only those fields: the rest is the server's) */
    var keep = $("ctFacts") && S.facts && Object.keys(factsChanges()).length ? factsChanges() : null;
    m.innerHTML = head +
      '<nav class="ct-tabs" aria-label="' + esc(desc.title) + '">' + tabs.map(function (t) {
        return '<a class="ct-tab' + (t[0] === "coach" ? " coach" : "") + '" href="' + esc(href(d.scope, t[0])) + '"' +
          (S.view === t[0] ? ' aria-current="page"' : "") + ">" + esc(t[1]) + "</a>";
      }).join("") + "</nav>" +
      '<div class="ct-body" data-view="' + esc(S.view) + '"><div class="ct-left" id="ctLeft">' + leftHtml(d, left) + "</div>" +
      '<div class="ct-coach" id="ctCoach">' + coachHtml(d) + "</div></div>" + trimmedNote(d);
    if (left === "knows" && d.facts) {
      fillFacts(d);
      if (keep) {
        var mine = {};
        Object.keys(S.facts).forEach(function (k) { mine[k] = Object.prototype.hasOwnProperty.call(keep, k) ? keep[k] : S.facts[k]; });
        putFacts(mine);
        factsEnable();
      }
    }
    scrollConvo();
  }

  function trimmedNote(d) {
    var t = d && Array.isArray(d.trimmed) ? d.trimmed : [];
    if (!t.length) return "";
    var seen = [];
    t.forEach(function (x) { if (seen.indexOf(x) < 0) seen.push(x); });
    return '<p class="ct-note">To keep this page small the DCR server left out the oldest of: ' + esc(seen.join(", ")) + ".</p>";
  }

  function leftHtml(d, view) {
    if (view === "examples") return examplesHtml(d);
    if (view === "wording") return wordingHtml(d);
    if (view === "lessons") return lessonsHtml(d);
    return knowsHtml(d);
  }

  /* "What it knows": a person's facts, then the rules. */
  function knowsHtml(d) {
    var rules = d.rules || [];
    var list = rules.length ? '<ul class="ct-list">' + rules.map(function (r) {
      return '<li class="ct-rule' + (r.active ? "" : " off") + '"><label class="ct-on" title="Untick a rule to keep it without the agents following it">' +
        '<input type="checkbox" data-ct="rule-on" data-id="' + esc(r.id) + '" data-act' + need("training.rule.update") + (r.active ? " checked" : "") +
        ' aria-label="The agents follow this rule" /></label><div class="ct-rbody"><div class="ct-rtext">' + esc(r.text) + "</div>" +
        '<div class="ct-rmeta">' + chip(r.category_words, "grey") + (r.source_words ? "<span>from " + esc(r.source_words) + "</span>" : "") +
        (r.added_words ? "<span>" + esc(r.added_words) + "</span>" : "") +
        '<span class="ct-pair"><button type="button" class="c-btn link" data-ct="rule-edit" data-id="' + esc(r.id) + '" data-act' + need("training.rule.update") + ">Edit</button>" +
        '<button type="button" class="c-btn link" data-ct="rule-del" data-id="' + esc(r.id) + '" data-act' + need("training.rule.delete") + ">Delete</button></span>" +
        "</div></div></li>";
    }).join("") + "</ul>" : '<div class="c-empty">No rules yet — add one, or tell the coach.</div>';
    return (d.facts ? factsHtml(d) : "") +
      "<h3>" + esc(d.rules_title || "Rules") + "</h3>" + '<p class="ct-note">' + esc(d.rules_hint) + "</p>" + list +
      '<div class="ct-bar"><button type="button" class="c-btn" data-ct="rule-add" data-act' + need("training.rule.add") + ">+ Add a rule</button></div>";
  }

  function personName(d) { return parts(d.scope)[1]; }

  function factsHtml(d) {
    var name = personName(d);
    return '<form class="c-card" id="ctFacts" novalidate><h3>What every agent knows about ' + esc(name) + "</h3>" +
      '<div class="c-field"><label class="c-label" for="ctLang">Language</label><select id="ctLang" data-ct-f="1" ' +
      'title="The language Claude writes this person\'s messages in (agents with smart wording on) and their assistant answers in">' +
      LANGUAGES.map(function (l) { return '<option value="' + l[0] + '">' + esc(l[1]) + "</option>"; }).join("") + "</select></div>" +
      '<div class="c-field"><span class="c-label">Away</span><div class="ct-away"><label class="c-check" ' +
      'title="Vacation, an injury: no agent contacts them while they are away"><input type="checkbox" id="ctAway" data-ct-f="1" /> from</label>' +
      '<input type="date" id="ctAwayFrom" data-ct-f="1" aria-label="First day away" />' +
      '<span class="ct-thru"><span class="c-muted">through</span><input type="date" id="ctAwayTo" data-ct-f="1" aria-label="Last day away" /></span></div>' +
      '<label class="c-check"><input type="checkbox" id="ctOpenEnd" data-ct-f="1" /> no return date yet</label></div>' +
      '<div class="c-field"><span class="c-label">No contact on</span><div class="c-days">' + WEEKDAYS.map(function (w, i) {
        return '<label><input type="checkbox" id="ctDay' + i + '" data-ct-f="1" /> ' + w + "</label>";
      }).join("") + "</div></div>" +
      '<div class="c-field"><label class="c-label" for="ctNotes">Notes</label><textarea id="ctNotes" rows="3" maxlength="1000" data-ct-f="1" ' +
      'placeholder="e.g. works nights; prefers WhatsApp; foreman at A068 — no phone numbers, addresses or money"></textarea>' +
      '<p class="c-help">Claude reads these when it words this person\'s messages, and their personal assistant reads them too. The ' +
      "assistant is told never to repeat them, but the person chats with it: write nothing you would mind them reading.</p></div>" +
      '<p class="ct-err" id="ctFactsErr" role="alert"></p>' +
      '<div class="ct-ft"><span class="grow" id="ctFactsStatus">' + esc((d.facts || {}).status) + "</span>" +
      '<button type="button" class="c-btn ghost" id="ctFactsRevert" data-ct="facts-revert" disabled>Revert</button>' +
      '<button type="submit" class="c-btn" id="ctFactsSave" data-act' + need("training.facts.save") + " disabled>Save</button></div></form>";
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function day(v) { var s = String(v || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; }

  /* The facts as stored, in the form's terms (FactsBox.load / values). */
  function loadedFacts(f) {
    return { language: String(f.language || ""), away_from: day(f.away_from), away_to: day(f.away_to),
      quiet_days: (f.quiet_days || []).map(Number).filter(function (n) { return n >= 0 && n <= 6; })
        .filter(function (n, i, a) { return a.indexOf(n) === i; }).sort(), notes: String(f.notes || "").trim() };
  }

  function fillFacts(d) {
    var f = loadedFacts(d.facts || {});
    S.facts = f;
    putFacts(f);
    factsEnable();
  }

  /* The form showing these facts (the FactsBox.load rules). */
  function putFacts(f) {
    var set = function (id, prop, v) { var n = $(id); if (n) n[prop] = v; };
    set("ctLang", "value", f.language);
    var start = f.away_from, end = f.away_to;
    set("ctAway", "checked", !!(start || end));
    set("ctAwayFrom", "value", start || today());
    set("ctAwayTo", "value", end || start || today());
    set("ctOpenEnd", "checked", !!(start && !end));
    for (var i = 0; i < 7; i++) set("ctDay" + i, "checked", f.quiet_days.indexOf(i) >= 0);
    set("ctNotes", "value", f.notes);
  }

  function factsValues() {
    var on = function (id) { var n = $(id); return !!(n && n.checked); };
    var val = function (id) { var n = $(id); return n ? String(n.value || "") : ""; };
    var away = on("ctAway");
    var quiet = [];
    for (var i = 0; i < 7; i++) if (on("ctDay" + i)) quiet.push(i);
    return { language: val("ctLang"), away_from: away ? day(val("ctAwayFrom")) : "", away_to: away && !on("ctOpenEnd") ? day(val("ctAwayTo")) : "",
      quiet_days: quiet, notes: val("ctNotes").trim() };
  }

  function factsChanges() {
    var now = factsValues(), out = {};
    if (!S.facts) return out;
    Object.keys(now).forEach(function (k) { if (JSON.stringify(now[k]) !== JSON.stringify(S.facts[k])) out[k] = now[k]; });
    return out;
  }

  function factsEnable() {
    var on = function (id) { var n = $(id); return !!(n && n.checked); };
    var away = on("ctAway"), open = on("ctOpenEnd");
    var set = function (id, v) { var n = $(id); if (n) n.disabled = v; };
    set("ctAwayFrom", !away);
    set("ctOpenEnd", !away);
    set("ctAwayTo", !away || open);
    var dirty = Object.keys(factsChanges()).length > 0;
    set("ctFactsRevert", !dirty);
    var save = $("ctFactsSave");
    if (save && !save.getAttribute("data-c-nom") && !save.getAttribute("data-c-off")) save.disabled = !dirty;
  }

  function saveFacts(btn) {
    var d = S.page;
    if (!d || !d.facts) return Promise.resolve();
    var changes = factsChanges();
    var err = $("ctFactsErr");
    if (!Object.keys(changes).length) return Promise.resolve();
    var v = factsValues();
    var problem = "";
    if ($("ctAway") && $("ctAway").checked && !v.away_from) problem = "Pick the first day away.";
    else if (v.away_to && v.away_from && v.away_to < v.away_from) problem = "The last day away is before the first.";
    if (err) err.textContent = problem;
    if (problem) return Promise.resolve();
    var args = { name: personName(d) };
    Object.keys(changes).forEach(function (k) { args[k] = changes[k]; });
    var g = S.gen;
    return press(btn, function () {
      return ask("training.facts.save", args, { text: "Saving what the agents know…" });
    }, "Saving…").then(function (res) {
      S.facts = null;
      S.treeAt = 0;
      return loadScope(g, true).then(function () { say(res.words, false, g); if (live(g)) loadTree(g, true); });
    }, function (e) {
      if (live(g) && err) err.textContent = errText(e); else toast(errText(e), true);
    });
  }

  function ruleById(id) { return ((S.page && S.page.rules) || []).filter(function (r) { return String(r.id) === String(id); })[0] || null; }

  /* The rule dialog (TrainRuleDialog's words); a refusal opens it again
     with what was typed and the server's reason. */
  function editRule(id, problem, typed) {
    var d = S.page;
    if (!d) return Promise.resolve();
    var rule = id ? ruleById(id) : null;
    if (id && !rule) return Promise.resolve();
    var base = typed || (rule ? { text: rule.text, category: rule.category } : { text: "", category: "other" });
    var cats = d.categories || ["other"];
    var g = S.gen;
    return Promise.resolve(S.ctx.modal({
      title: rule ? "Change the rule" : "Add a rule",
      message: (problem ? problem + "\n\n" : "") + (d.rule_hint || ""),
      okText: rule ? "Save" : "Add the rule",
      fields: [{ name: "text", type: "textarea", rows: 3, value: base.text },
        { name: "category", type: "select", label: "Kind", value: base.category || "other",
          options: cats.map(function (c) { return { value: c, label: cap(c) }; }) }],
      validate: function (v) {
        var t = line(v.text);
        if (!t) return "Write the rule first.";
        if (t.length > RULE_MAX) return "Keep it under " + RULE_MAX + " characters (" + t.length + " now).";
        return "";
      },
    })).then(function (v) {
      if (!v) return null;
      var text = line(v.text), category = String(v.category || "other");
      if (rule && text === rule.text && category === rule.category) return null;
      var args = rule ? { id: rule.id } : { scope: d.scope, text: text, category: category };
      if (rule) { if (text !== rule.text) args.text = text; if (category !== rule.category) args.category = category; }
      return ask(rule ? "training.rule.update" : "training.rule.add", args, { text: rule ? "Saving the rule…" : "Adding the rule…" }).then(function (res) {
        S.treeAt = 0;
        return loadScope(g, true).then(function () { say(res.words, false, g); if (live(g)) loadTree(g, true); });
      }, function (e) {
        if (e && (e.code === "refused" || e.code === "bad_args") && live(g)) return editRule(id, errText(e), { text: text, category: category });
        say(errText(e), true, g);
      });
    });
  }

  function toggleRule(input) {
    var id = input.getAttribute("data-id");
    var on = !!input.checked;
    var g = S.gen;
    lock(input, true);
    return ask("training.rule.update", { id: Number(id), active: on }, { text: on ? "Turning the rule on…" : "Turning the rule off…" }).then(function () {
      lock(input, false);
      var r = ruleById(id);
      if (r) r.active = on;
      var row = input.closest ? input.closest(".ct-rule") : null;
      if (row && row.classList) row.classList.toggle("off", !on);
      S.treeAt = 0;
      say(on ? "The agents follow that rule again." : "Kept, but the agents no longer follow that rule.", false, g);
    }, function (e) {
      lock(input, false);
      input.checked = !on;
      say(errText(e), true, g);
    });
  }

  function deleteRule(id, btn) {
    var rule = ruleById(id);
    if (!rule) return Promise.resolve();
    var g = S.gen;
    return press(btn, function () { return act("training.rule.delete", { id: rule.id }, { text: "Deleting the rule…" }); }).then(function (res) {
      if (!res) return;
      S.treeAt = 0;
      return loadScope(g, true).then(function () { say(res.words, false, g); if (live(g)) loadTree(g, true); });
    }, function () { /* the shell said why */ });
  }

  /* Reply examples: "When someone writes … it means …". */
  function examplesHtml(d) {
    var ex = d.examples || [];
    var list = ex.length ? '<ul class="ct-list">' + ex.map(function (x) {
      return '<li class="ct-ex"><span class="lbl">Someone wrote</span>«' + esc(x.input) + '»<span class="lbl gap">It means</span>' +
        esc(x.meaning) + '<div class="ct-rmeta">' + (x.source_words ? "<span>from " + esc(x.source_words) + "</span>" : "") +
        (x.added_words ? "<span>" + esc(x.added_words) + "</span>" : "") +
        '<button type="button" class="c-btn link" data-ct="ex-del" data-id="' + esc(x.id) + '" data-act' + need("training.example.delete") + ">Delete</button></div></li>";
    }).join("") + "</ul>" : '<div class="c-empty">No examples yet.</div>';
    return '<p class="ct-note">' + esc(d.examples_hint) + "</p>" + list +
      '<div class="ct-bar"><button type="button" class="c-btn" data-ct="ex-add" data-act' + need("training.example.add") + ">+ Add an example</button></div>";
  }

  function addExample(problem, typed) {
    var d = S.page;
    if (!d) return Promise.resolve();
    var base = typed || { said: "", meant: "" };
    var g = S.gen;
    return Promise.resolve(S.ctx.modal({
      title: "Add a reply example",
      message: (problem ? problem + "\n\n" : "") + "Claude reads the crew's replies with these examples in mind (Settings → Claude AI). " +
        "Trim the words to the part that matters.",
      okText: "Add the example",
      fields: [{ name: "said", type: "textarea", rows: 3, label: "Someone wrote", value: base.said },
        { name: "meant", type: "text", label: "It means", value: base.meant, placeholder: "e.g. 8 hours on job A081 today, framing" }],
      validate: function (v) {
        var s = line(v.said), m = line(v.meant);
        if (!s || !m) return "Fill in both: what someone wrote and what it means.";
        if (s.length > SAID_MAX) return "Keep what they wrote under " + SAID_MAX + " characters.";
        if (m.length > MEANT_MAX) return "Keep what it means under " + MEANT_MAX + " characters.";
        return "";
      },
    })).then(function (v) {
      if (!v) return null;
      var said = line(v.said), meant = line(v.meant);
      return ask("training.example.add", { scope: d.scope, said: said, meant: meant }, { text: "Adding the example…" }).then(function (res) {
        return loadScope(g, true).then(function () { say(res.words, false, g); });
      }, function (e) {
        if (e && (e.code === "refused" || e.code === "bad_args") && live(g)) return addExample(errText(e), { said: said, meant: meant });
        say(errText(e), true, g);
      });
    });
  }

  function deleteExample(id, btn) {
    var g = S.gen;
    return press(btn, function () { return act("training.example.delete", { id: Number(id) }, { text: "Deleting the example…" }); }).then(function (res) {
      if (!res) return;
      return loadScope(g, true).then(function () { say(res.words, false, g); });
    }, function () {});
  }

  /* The messages Claude wrote for an agent. */
  function wordingHtml(d) {
    var w = d.wording || {};
    var rows = w.rows || [];
    if (S.wsel === null && rows.length) S.wsel = rows[0].id;
    var sel = rows.filter(function (r) { return r.id === S.wsel; })[0] || null;
    var t = w.template || {};
    var list = rows.length ? '<ul class="ct-wrows">' + rows.map(function (r) {
      return '<li><button type="button" class="ct-wrow' + (r === sel ? " sel" : "") + '" data-ct="w-pick" data-id="' + esc(r.id) + '"' +
        ' aria-pressed="' + (r === sel ? "true" : "false") + '"><b>' + esc(r.subject || "(no subject)") + "</b>" +
        '<span class="c-muted">' + esc([r.language_words, r.person ? "for " + r.person : "", plural(Number(r.uses) || 0, "use"), when(r.at)]
          .filter(Boolean).join(" · ")) + "</span></button></li>";
    }).join("") + "</ul>" : '<div class="c-empty">Claude has not written anything for this agent yet.</div>';
    return '<p class="ct-note">' + esc(w.status) + "</p>" + list +
      (sel ? '<div class="ct-wdetail"><div><h4>The agent\'s own words</h4><pre class="ct-pre">' + esc(templateWords(t.subject, t.body, t.sms)) +
        '</pre></div><div><h4>Claude\'s version</h4><pre class="ct-pre">' + esc(templateWords(sel.subject, sel.body, sel.sms)) + "</pre></div></div>" : "") +
      '<div class="ct-bar">' +
      '<button type="button" class="c-btn ghost" data-ct="w-forget" data-act' + need("training.wording.forget") +
      ' title="Claude writes this one afresh the next time it is needed"' + (sel ? "" : " disabled") + ">Forget this version</button>" +
      '<button type="button" class="c-btn ghost" data-ct="w-forget-all" data-act' + need("training.wording.forget") + (rows.length ? "" : " disabled") +
      ">Forget them all</button>" +
      '<button type="button" class="c-btn ghost" data-ct="w-retry" data-act' + need("training.wording.retry") +
      ' title="After Claude\'s answer was refused by the checks, the agent waits 30 minutes before asking again; this lets the next message ask at once">' +
      "Ask Claude again now</button></div>";
  }

  function forgetWording(all, btn) {
    var d = S.page;
    if (!d) return Promise.resolve();
    var g = S.gen;
    return press(btn, function () {
      return act("training.wording.forget", { agent_id: parts(d.scope)[1], id: all ? null : S.wsel }, { text: "Forgetting…" });
    }).then(function (res) {
      if (!res) return;
      S.wsel = null;
      return loadScope(g, true).then(function () { say(res.words, false, g); });
    }, function () {});
  }

  function retryWording(btn) {
    var g = S.gen;
    return press(btn, function () { return ask("training.wording.retry", {}, { text: "Asking Claude again…" }); }).then(function (res) {
      say(res.words, false, g);
    }, function (e) { say(errText(e), true, g); });
  }

  /* What was taught lately, newest first. */
  function lessonsHtml(d) {
    var rows = d.lessons || [];
    var company = d.scope === COMPANY;
    var list = rows.length ? '<ul class="ct-list">' + rows.map(function (x) {
      return '<li class="ct-lesson"><div class="top"><b>' + esc(x.action_words) + '</b><span class="c-muted">' + esc(x.when) +
        (company && x.scope_words ? " · " + esc(x.scope_words) : "") + "</span></div>" +
        (x.detail ? '<div class="detail">' + esc(x.detail) + "</div>" : "") + "</li>";
    }).join("") + "</ul>" : '<div class="c-empty">Nothing taught here yet.</div>';
    return '<p class="ct-note">' + esc(d.lessons_hint) + "</p>" + list;
  }

  /* ── the Coach ─────────────────────────────────────────────────────── */

  function coachHtml(d) {
    var c = d.coach || {};
    var pending = S.pending[d.scope];
    var draft = draftGet(d.scope);
    return '<h3>Coach — teach it in your own words</h3><div class="ct-convo" id="ctConvo">' + convoHtml(d) + "</div>" +
      (c.ok ? "" : '<p class="ct-note">' + esc(c.note || c.words) + "</p>") +
      '<form id="ctCoachForm"><label for="ctCoachText" class="c-sr">Your message to the coach</label>' +
      '<textarea id="ctCoachText" rows="3" maxlength="' + COACH_MAX + '" placeholder="' + esc((d.describe || {}).example || "") + '"' +
      (c.ok ? "" : " disabled") + (pending ? " readonly" : "") + ">" + esc(pending || draft) + "</textarea>" +
      '<div class="ct-ft"><span class="grow">Ctrl+Enter sends</span><button type="submit" class="c-btn" id="ctSend" data-act' + need("training.coach.ask") +
      (c.ok && !pending ? "" : " disabled") + ">Send to the coach</button></div></form>";
  }

  function convoHtml(d) {
    var c = d.coach || {};
    var history = c.history || [];
    var pending = S.pending[d.scope];
    var out = [];
    if (!history.length && !pending) out.push('<p class="ct-note">' + esc(d.intro) + "</p>");
    var last = -1;
    history.forEach(function (t, i) { if (t.role === "assistant") last = i; });
    history.forEach(function (t, i) {
      var mine = t.role !== "assistant";
      var text = t.content || "";
      if (!mine && !String(text).trim()) text = (t.actions || []).length ? "(proposals below)" : "(no answer)";
      out.push('<div class="ct-turn' + (mine ? " mine" : "") + '"><div class="ct-meta">' + (mine ? "You" : "Coach") +
        (t.when ? " · " + esc(t.when) : "") + '</div><div class="ct-bubble">' + esc(text) + "</div></div>");
      if (!mine) (t.actions || []).forEach(function (a) { out.push(cardHtml(t, a, i === last)); });
    });
    if (pending) {
      out.push('<div class="ct-turn mine"><div class="ct-meta">You · now</div><div class="ct-bubble">' + esc(pending) + "</div></div>");
      out.push('<div class="ct-turn thinking"><div class="ct-meta">Coach</div><div class="ct-bubble">Thinking… this can take a minute.</div></div>');
    }
    return out.join("");
  }

  /* One proposed lesson (the desktop's ActionCard). */
  function cardHtml(turn, a, current) {
    var p = a.preview || {};
    var problems = (p.problems || []).filter(Boolean).map(String);
    var before = String(p.before || ""), after = String(p.after || "");
    var body;
    if ((a.type === "person_fact" || a.type === "agent_setting") && (before || after)) {
      body = (before ? '<div class="ct-diff before"><b>Before</b>' + esc(before) + "</div>" : "") +
        (after ? '<div class="ct-diff after"><b>After</b>' + esc(after) + "</div>" : "");
    } else {
      body = '<div class="ct-cbody">' + esc(a.summary || after) + "</div>";
    }
    var extra = [];
    if (a.category_words) extra.push("Kind: " + a.category_words);
    if (a.why) extra.push("Why: " + a.why);
    var foot = "";
    if (a.handled === "applied" && a.said) foot = '<div class="ct-csaid">' + esc(a.said) + "</div>";
    else if (!a.handled && problems.length) foot = '<div class="ct-cprob' + (a.already ? "" : " bad") + '">' + esc(problems.join("; ")) + "</div>";
    var buttons = "";
    if (!a.handled && (p.ok || current)) {
      buttons = '<div class="ct-cft"><button type="button" class="c-btn ghost sm" data-ct="dismiss" data-chat="' + esc(turn.id) +
        '" data-n="' + esc(a.n) + '" data-act' + need("training.coach.dismiss") + ' title="Leave it out — nothing changes; the lessons log notes it">Dismiss</button>' +
        '<button type="button" class="c-btn sm" data-ct="apply" data-chat="' + esc(turn.id) + '" data-n="' + esc(a.n) + '" data-act' + need("training.coach.apply") +
        (p.ok ? ' title="Make the change now — it is checked again first"' : ' disabled title="This one can\'t be applied as it stands"') + ">Apply</button></div>";
    }
    return '<div class="ct-card' + (a.handled ? " done" : "") + '"><div class="ct-chead">' + chip(a.kind_words, a.tone) +
      (a.where ? "<b>" + esc(a.where) + "</b>" : '<span class="grow"></span>') + chip(a.state, a.handled === "applied" ? "green" : "grey") + "</div>" + body +
      (extra.length ? '<div class="ct-cextra">' + esc(extra.join("   ·   ")) + "</div>" : "") + foot + buttons + "</div>";
  }

  function scrollConvo() {
    var c = $("ctConvo");
    if (c && "scrollTop" in c) c.scrollTop = c.scrollHeight || 0;
  }

  function redrawCoach() {
    var c = $("ctCoach");
    if (c && S.page) { c.innerHTML = coachHtml(S.page); scrollConvo(); }
  }

  function askCoach() {
    var d = S.page;
    if (!d || d.photo) return Promise.resolve();
    var box = $("ctCoachText");
    var words = box ? String(box.value || "").trim() : "";
    var scope = d.scope;
    if (!words || S.pending[scope] || !(d.coach || {}).ok) return Promise.resolve();
    if (words.length > COACH_MAX) { say("Keep it under " + COACH_MAX + " characters.", true); return Promise.resolve(); }
    draftSet(scope, words);
    S.pending[scope] = words;
    redrawCoach();
    var g = S.gen;
    return ask("training.coach.ask", { scope: scope, words: words }, { text: "The coach is thinking… this can take a minute." }).then(function (res) {
      delete S.pending[scope];
      draftSet(scope, "");
      if (S.page && S.page.scope === scope) {
        var coach = S.page.coach = S.page.coach || {};
        var hist = coach.history = coach.history || [];
        hist.push({ role: "user", content: words, when: "now" });
        hist.push({ id: res.chat_id, role: "assistant", content: res.reply || "", when: "now", actions: res.actions || [] });
      }
      if (live(g) && S.page && S.page.scope === scope) { redrawCoach(); say(res.words, false, g); }
      else toast(res.words);
    }, function (e) {
      delete S.pending[scope];
      if (live(g) && S.page && S.page.scope === scope) { redrawCoach(); say(errText(e), true, g); }
      else toast(errText(e), true);
    });
  }

  function cardAction(kind, btn) {
    var d = S.page;
    if (!d) return Promise.resolve();
    var chat = Number(btn.getAttribute("data-chat")), n = Number(btn.getAttribute("data-n"));
    var g = S.gen;
    return press(btn, function () {
      return ask(kind === "apply" ? "training.coach.apply" : "training.coach.dismiss", { scope: d.scope, chat_id: chat, n: n },
        { text: kind === "apply" ? "Applying it…" : "Dismissing it…" });
    }).then(function (res) {
      S.treeAt = 0;
      return loadScope(g, true).then(function () {
        say((res && res.words) || "Done.", false, g);
        if (live(g) && kind === "apply") loadTree(g, true);
      });
    }, function (e) { say(errText(e), true, g); });
  }

  /* ── the switch, export and import ────────────────────────────────── */

  function smartToggled(input) {
    var want = !!input.checked;
    var g = S.gen;
    return act("training.smart", { on: want }, { text: want ? "Turning smart wording on…" : "Turning smart wording off…" }).then(function (res) {
      if (!res) { input.checked = !want; return; }
      if (S.tree) S.tree.smart_on = !!res.on;
      input.checked = !!res.on;
      if ($("ctSay") && live(g)) say(res.words, false, g); else toast(res.words);
    }, function () { input.checked = !want; });
  }

  function exportTraining(btn) {
    var g = S.gen;
    return press(btn, function () { return ask("training.export", {}, { text: "Gathering the training…" }); }).then(function (res) {
      var name = String(res.file_name || "dcr-agents-training.json").replace(/[^A-Za-z0-9._-]/g, "") || "dcr-agents-training.json";
      var blob = new Blob([JSON.stringify(res.data, null, 1)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      if (a.remove) a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      var c = res.counts || {};
      var words = "Saved " + plural(c.rules || 0, "rule") + ", " + plural(c.examples || 0, "example") + " and what the agents know about " +
        plural(c.people || 0, "person", "people") + " to " + name + ".";
      if ($("ctSay") && live(g)) say(words, false, g); else toast(words);
    }, function (e) {
      if ($("ctSay") && live(g)) say(errText(e), true, g); else toast(errText(e), true);
    });
  }

  function readFile(file) {
    if (file && typeof file.text === "function") return file.text();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || "")); };
      r.onerror = function () { reject(new Error("That file could not be read.")); };
      r.readAsText(file);
    });
  }

  function importChosen(input) {
    var file = input.files && input.files[0];
    if (!file) return Promise.resolve();
    var g = S.gen;
    var tell = function (t, isBad) { if ($("ctSay") && live(g)) say(t, isBad, g); else toast(t, isBad); };
    if (file.size && file.size > ARGS_MAX * 4) { input.value = ""; tell(TOO_BIG, true); return Promise.resolve(); }
    return readFile(file).then(function (text) {
      input.value = "";
      var data;
      try { data = JSON.parse(String(text).replace(/^﻿/, "")); } catch (e) { tell("That file is not a training export (it is not JSON).", true); return; }
      if (!data || typeof data !== "object" || Array.isArray(data)) { tell("That file is not a training export.", true); return; }
      /* The portal and the DCR server both refuse more than this at once. */
      if (JSON.stringify({ data: data }).length > ARGS_MAX) { tell(TOO_BIG, true); return; }
      return act("training.import", { data: data }, { text: "Importing the training…" }).then(function (res) {
        if (!res) return;
        S.treeAt = 0;
        var jobs = [loadTree(g, true)];
        if (S.scope) jobs.push(loadScope(g, true));
        return Promise.all(jobs).then(function () { tell(res.words, false); });
      }, function () {});
    }, function (e) { input.value = ""; tell(errText(e), true); });
  }

  /* ── events ────────────────────────────────────────────────────────── */

  function target(e, attr) { var t = e && e.target; return t && t.closest ? t.closest("[" + attr + "]") : null; }

  function onClick(e) {
    var t = target(e, "data-ct");
    if (!t || t.disabled) return;
    var what = t.getAttribute("data-ct");
    var g = S.gen;
    switch (what) {
      case "reload-tree": loadTree(g, true); break;
      case "reload-scope": loadScope(g, true); break;
      case "export": exportTraining(t); break;
      case "import": { var f = $("ctImportFile"); if (f && f.click) f.click(); break; }
      case "rule-add": editRule(null); break;
      case "rule-edit": editRule(t.getAttribute("data-id")); break;
      case "rule-del": deleteRule(t.getAttribute("data-id"), t); break;
      case "ex-add": addExample(); break;
      case "ex-del": deleteExample(t.getAttribute("data-id"), t); break;
      case "w-pick": {
        S.wsel = Number(t.getAttribute("data-id"));
        var left = $("ctLeft");
        if (left && S.page) left.innerHTML = wordingHtml(S.page);
        break;
      }
      case "w-forget": forgetWording(false, t); break;
      case "w-forget-all": forgetWording(true, t); break;
      case "w-retry": retryWording(t); break;
      case "apply": cardAction("apply", t); break;
      case "dismiss": cardAction("dismiss", t); break;
      case "facts-revert": {
        if (S.page) fillFacts(S.page);
        var er = $("ctFactsErr");
        if (er) er.textContent = "";
        break;
      }
      default: break;
    }
  }

  function onChange(e) {
    var t = e && e.target;
    if (!t || !t.getAttribute) return;
    var what = t.getAttribute("data-ct");
    if (what === "rule-on") toggleRule(t);
    else if (what === "smart") smartToggled(t);
    else if (what === "import-file") importChosen(t);
    else if (t.getAttribute("data-ct-f")) factsEnable();
  }

  function onInput(e) {
    var t = e && e.target;
    if (!t) return;
    var id = t.id || (t.getAttribute && t.getAttribute("id"));
    if (id === "ctSearch") {
      if (S.searchTimer) clearTimeout(S.searchTimer);
      var g = S.gen;
      S.searchTimer = setTimeout(function () {
        S.searchTimer = null;
        var q = String(t.value || "").trim().slice(0, 60);
        if (q === S.q) return;
        S.q = q;
        if (live(g)) loadTree(g, true);
      }, 600);
    } else if (id === "ctCoachText" && S.page && !S.pending[S.page.scope]) {
      draftSet(S.page.scope, String(t.value || ""));
    } else if (t.getAttribute && t.getAttribute("data-ct-f")) {
      factsEnable();
    }
  }

  function onSubmit(e) {
    var f = e && e.target;
    var id = f && (f.id || (f.getAttribute && f.getAttribute("id")));
    if (!id) return;
    if (e.preventDefault) e.preventDefault();
    var btn = f.querySelector ? f.querySelector("[type=submit]") : null;
    if (id === "ctCoachForm") askCoach();
    else if (id === "ctFacts") saveFacts(btn || $("ctFactsSave"));
  }

  function onKey(e) {
    var t = e && e.target;
    if (!t || (t.id || (t.getAttribute && t.getAttribute("id"))) !== "ctCoachText") return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      if (e.preventDefault) e.preventDefault();
      askCoach();
    }
  }

  window.DCRConsole.register({ id: TAB, title: "Training", order: 70, render: render, leave: leave });

  /* For the page tests (lib/console-training-page.test.mjs). */
  if (window.__DCR_CONSOLE_TEST__) {
    window.DCRConsoleTraining = { state: S, templateWords: templateWords, factsValues: factsValues, factsChanges: factsChanges };
  }
})();
