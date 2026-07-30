/* DCR portal — single source of truth for Expenses filtering.

   project.js (the Expenses tab) and report-expenses.js (the printed sheet) BOTH
   call into this file. Never re-implement the period bounds, the group key, the
   description fallback chain, matching, sorting, grouping or the totals anywhere
   else — the moment they exist twice the screen and the paper drift apart, and
   the printed total stops matching the total the estimator just read.

   Plain ES5, no build step. Loaded after common.js, before the page script. */

(function () {
  var DCR = (window.DCR = window.DCR || {});

  var PERIODS = [
    ["all", "All dates"], ["thisMonth", "This month"], ["lastMonth", "Last month"],
    ["last30", "Last 30 days"], ["last90", "Last 90 days"], ["thisQuarter", "This quarter"],
    ["thisYear", "This year"], ["lastYear", "Last year"], ["custom", "Custom range…"],
  ];
  var SORT_LABELS = { date: "Date", desc: "Description", est: "Estimate",
    inv: "Invoice", mat: "Materials", con: "Contractors" };
  // Written to / read from the query string. pa/pb are the RESOLVED bounds and
  // ride along on the Print link only (see printQuery).
  var KEYS = ["group", "range", "from", "to", "q", "sort", "dir"];
  var PKEYS = KEYS.concat(["pa", "pb"]);
  var STORE = "dcrExpFilter";
  var QMAX = 200;

  function defaults() {
    return { group: "*", range: "all", from: "", to: "", q: "", sort: "date", dir: -1, pa: "", pb: "" };
  }

  /* ── scalars (kept identical to the project page's own helpers) ── */
  function num(v) {
    if (typeof v === "number") return v;
    var n = parseFloat(String(v == null ? "" : v).replace(/[$,]/g, ""));
    return isFinite(n) ? n : 0;
  }
  function money(n) {
    return "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // SharePoint stores these as calendar dates but hands them back as UTC instants
  // ("2026-07-05T00:00:00Z"); reading that with new Date() in Pacific time lands
  // on Jul 4. Take the Y-M-D exactly as written.
  function toDate(v) {
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (!v) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    var d = new Date(v);
    return isNaN(d) ? null : d;
  }
  function fmtDay(v) {
    var d = toDate(v);
    return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
  }
  function ymd(d) {  // local YYYY-MM-DD — toISOString() is UTC and would slip a day
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function isISO(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")); }
  function endOfDay(d) { var e = new Date(d); e.setHours(23, 59, 59, 999); return e; }

  // Notes pasted from Word/email carry markup — read it as plain text with its
  // line breaks intact, never as live HTML.
  function stripML(v) {
    return String(v == null ? "" : v)
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/\s*(div|p|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<\/?[a-z][^>]*>/gi, "");
  }
  function escML(v) { return DCR.esc(stripML(v)).split(/\r\n|\r|\n/).join("<br>"); }

  /* ── row accessors: the misspelled SharePoint field lives in ONE place ── */
  function groupOf(r) { return r.gropingName || "(no group)"; }
  function descOf(r) {
    return r.description || r.laborExpenseDescription || r.materialExpenseDescription ||
      r.estimateDescription || "";
  }

  /* ── the filter object ────────────────────────────────────────────────
     norm() is the only trust boundary for anything arriving from a URL or
     from sessionStorage. It CLAMPS values; it never rewrites the user's
     intent (notably: an empty custom range stays "custom", so clearing a
     date box does not snap the dropdown back to "All dates"). */
  function norm(src) {
    var f = defaults();
    if (!src || typeof src !== "object") return f;
    if (src.group != null) f.group = String(src.group);
    if (src.q != null) f.q = String(src.q).slice(0, QMAX);
    for (var i = 0; i < PERIODS.length; i++) if (PERIODS[i][0] === src.range) f.range = src.range;
    if (SORT_LABELS[src.sort]) f.sort = src.sort;
    f.dir = Number(src.dir) > 0 ? 1 : -1;
    if (isISO(src.from)) f.from = String(src.from);
    if (isISO(src.to)) f.to = String(src.to);
    if (isISO(src.pa)) f.pa = String(src.pa);
    if (isISO(src.pb)) f.pb = String(src.pb);
    return f;
  }

  // Resolved [a,b] window, or null when no date filtering applies.
  function period(f) {
    var key = f.range;
    // A print link carries the window the screen had already resolved, so a
    // relative period ("This month", "Last 30 days") cannot re-resolve to a
    // different range on the report page.
    if (key !== "all" && isISO(f.pa) && isISO(f.pb)) return { a: toDate(f.pa), b: endOfDay(toDate(f.pb)) };
    if (!key || key === "all") return null;
    var now = new Date(), y = now.getFullYear(), m = now.getMonth();
    function d(yy, mm, dd) { return new Date(yy, mm, dd); }
    if (key === "thisMonth") return { a: d(y, m, 1), b: endOfDay(d(y, m + 1, 0)) };
    if (key === "lastMonth") return { a: d(y, m - 1, 1), b: endOfDay(d(y, m, 0)) };
    if (key === "last30") return { a: d(y, m, now.getDate() - 29), b: endOfDay(now) };
    if (key === "last90") return { a: d(y, m, now.getDate() - 89), b: endOfDay(now) };
    if (key === "thisQuarter") { var q = Math.floor(m / 3) * 3; return { a: d(y, q, 1), b: endOfDay(d(y, q + 3, 0)) }; }
    if (key === "thisYear") return { a: d(y, 0, 1), b: endOfDay(d(y, 11, 31)) };
    if (key === "lastYear") return { a: d(y - 1, 0, 1), b: endOfDay(d(y - 1, 11, 31)) };
    if (key === "custom") {
      var a = f.from ? toDate(f.from) : null, b = f.to ? endOfDay(toDate(f.to)) : null;
      if (!a && !b) return null;
      return { a: a || new Date(1900, 0, 1), b: b || new Date(2999, 11, 31) };
    }
    return null;
  }

  function filter(rows, f) {
    var per = period(f), q = (f.q || "").trim().toLowerCase();
    return (rows || []).filter(function (r) {
      if (f.group !== "*" && groupOf(r) !== f.group) return false;
      if (per) {
        var dt = toDate(r.expenseDate);
        if (!dt || dt < per.a || dt > per.b) return false;
      }
      if (q) {
        // filter(Boolean) first: joining absent fields would put the literal
        // "undefined" in the haystack and make a search for "und" match everything.
        var hay = [r.description, r.remarks, r.laborExpenseDescription,
          r.materialExpenseDescription, r.estimateDescription, r.gropingName]
          .filter(Boolean).join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function sort(rows, f) {
    var dir = Number(f.dir) > 0 ? 1 : -1;
    var val = {
      date: function (r) { var d = toDate(r.expenseDate); return d ? d.getTime() : 0; },
      desc: function (r) { return descOf(r).toLowerCase(); },
      est: function (r) { return num(r.estimate); }, inv: function (r) { return num(r.invoice); },
      mat: function (r) { return num(r.materials); }, con: function (r) { return num(r.contractors); },
    }[SORT_LABELS[f.sort] ? f.sort : "date"];
    return (rows || []).slice().sort(function (a, b) {
      var A = val(a), B = val(b);
      return (A < B ? -1 : A > B ? 1 : 0) * dir;
    });
  }

  // Buckets by group, preserving the order it was handed (so the rows stay
  // globally sorted). Object.create(null) is load-bearing: with a plain object
  // a group literally named "__proto__" silently loses its rows and one named
  // "constructor" throws.
  function group(rows) {
    var m = Object.create(null), order = [];
    (rows || []).forEach(function (r) {
      var g = groupOf(r);
      if (!m[g]) { m[g] = []; order.push(g); }
      m[g].push(r);
    });
    order.sort();
    return order.map(function (g) { return { name: g, rows: m[g] }; });
  }

  function totals(rows) {
    var t = { est: 0, inv: 0, mat: 0, con: 0 };
    (rows || []).forEach(function (r) {
      t.est += num(r.estimate); t.inv += num(r.invoice);
      t.mat += num(r.materials); t.con += num(r.contractors);
    });
    return t;
  }

  /* ── describing the filter in plain words (printed on the sheet) ──
     The period phrase is derived from period(f), never from f.range, so the
     sheet can never claim a date window it did not actually apply. */
  function isActive(f) {
    return f.group !== "*" || !!period(f) || !!(f.q || "").trim();
  }
  function periodName(key) {
    for (var i = 0; i < PERIODS.length; i++) if (PERIODS[i][0] === key) return PERIODS[i][1];
    return "All dates";
  }
  function label(f) {
    var parts = [], per = period(f);
    parts.push(f.group === "*" ? "All groups" : "Group: " + f.group);
    if (!per) parts.push("All dates");
    else if (f.range === "custom") {
      parts.push(f.from && f.to ? "Custom range " + fmtDay(f.from) + " – " + fmtDay(f.to)
        : f.from ? "From " + fmtDay(f.from) : "Through " + fmtDay(f.to));
    } else {
      parts.push(periodName(f.range).replace(/…$/, "") + " (" + fmtDay(per.a) + " – " + fmtDay(per.b) + ")");
    }
    if ((f.q || "").trim()) parts.push('Search: "' + f.q.trim() + '"');
    var asc = Number(f.dir) > 0;
    var order = f.sort === "date" ? (asc ? "oldest first" : "newest first") : (asc ? "ascending" : "descending");
    parts.push("Sorted by " + SORT_LABELS[f.sort] + ", " + order);
    return parts.join(" · ");
  }

  /* ── URL: one writer (searchParams), one reader (get) ──
     Hand-rolling a second encoder is how "R&D / Misc" ends up encoded two
     different ways, so everything funnels through applyToUrl. */
  function setPairs(u, f, pinned) {
    PKEYS.forEach(function (k) { u.searchParams.delete(k); });
    if (f.group !== "*") u.searchParams.set("group", f.group);
    if (f.range !== "all") u.searchParams.set("range", f.range);
    if (f.from) u.searchParams.set("from", f.from);
    if (f.to) u.searchParams.set("to", f.to);
    if ((f.q || "").trim()) u.searchParams.set("q", f.q.trim());
    if (f.sort !== "date") u.searchParams.set("sort", f.sort);
    if (Number(f.dir) > 0) u.searchParams.set("dir", "1");
    if (pinned) {
      var per = period(f);
      if (per && f.range !== "all") {
        u.searchParams.set("pa", ymd(per.a));
        u.searchParams.set("pb", ymd(per.b));
      }
    }
    return u;
  }
  function applyToUrl(u, f) { return setPairs(u, f, false); }
  function hrefWith(path, extra, f, pinned) {
    var u = new URL(path, location.href);
    Object.keys(extra || {}).forEach(function (k) { u.searchParams.set(k, extra[k]); });
    setPairs(u, f, !!pinned);
    return u.pathname.replace(/^.*\//, "") + u.search;
  }
  function fromQuery(qs) {
    var any = false;
    PKEYS.forEach(function (k) { if (qs.get(k) != null) any = true; });
    if (!any) return null;
    var src = {};
    PKEYS.forEach(function (k) { src[k] = qs.get(k); });
    return norm(src);
  }

  /* ── per-tab memory, so leaving the page and coming back is not a reset ── */
  function save(pid, f) {
    try { sessionStorage.setItem(STORE, JSON.stringify({ v: 1, pid: String(pid), f: f })); } catch (e) {}
  }
  function load(pid) {
    try {
      var s = JSON.parse(sessionStorage.getItem(STORE) || "null");
      if (!s || s.v !== 1 || String(s.pid) !== String(pid)) return null;
      return norm(s.f);
    } catch (e) { return null; }
  }

  DCR.exp = {
    PERIODS: PERIODS, SORT_LABELS: SORT_LABELS, KEYS: KEYS, PKEYS: PKEYS,
    defaults: defaults, norm: norm,
    num: num, money: money, toDate: toDate, fmtDay: fmtDay, ymd: ymd, isISO: isISO,
    stripML: stripML, escML: escML, groupOf: groupOf, descOf: descOf,
    period: period, filter: filter, sort: sort, group: group, totals: totals,
    isActive: isActive, label: label,
    applyToUrl: applyToUrl, hrefWith: hrefWith, fromQuery: fromQuery,
    save: save, load: load,
  };
})();
