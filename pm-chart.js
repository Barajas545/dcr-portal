/* PM progress chart engine — pure functions, no fetch, no DOM events.
   window.PMChart = { derive(payload, prefs), layout(model, opts), svg(model, layout, opts) }
   Shared by pm.html (live) and report-pm.html (print), so every rule about
   what a node MEANS lives here and nowhere else.

   The shape: a milestone spine for the workflow the office runs
     Plans received → Setup → Estimating → Estimate sent → Follow-up
       → Accepted → Complete
   with the estimated items fanning out in parallel twice — once while quotes
   come in (region A: Quotes → Priced), once while the work runs
   (region B: Awarded → Invoiced → Paid). PERT-style network, not a schedule:
   the percentages are completion of tracked facts, not dates. */
(function () {
  "use strict";

  var SEP = "¦"; // ¦ — the item key separator the backend uses

  /* ── status → milestone index (literal SharePoint values; typos load-bearing) ── */
  var STATUS_IDX = {
    "to do": 2, "not started": 2, "recived": 2,
    "estimating": 3,
    "sent": 4,
    "follow": 5,
    "aproved": 6, "active": 6, "in progress": 6,
    "completed": 7, "closed": 7,
  };
  var MS_DEFS = [
    { n: 1, label: "Plans received" },
    { n: 2, label: "Setup" },
    { n: 3, label: "Estimating" },       // region A hangs here
    { n: 4, label: "Estimate sent" },
    { n: 5, label: "Follow-up" },
    { n: 6, label: "Accepted" },         // region B hangs here
    { n: 7, label: "Complete" },
  ];
  var STAGE_COLORS = {
    "Recived": "#2f80d8", "Estimating": "#d6a13a", "Sent": "#8e6fd8",
    "Aproved": "#2fa679", "In Progress": "#1f6fc8", "Completed": "#6b7c6f", "On Hold": "#d9614f",
  };

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // Two forms, deliberately. `compact` is for the chart chips, where a node is
  // ~130px wide and "$12k" is all that fits. Everywhere a figure is read as
  // money — the tiles, the quote rows, the printed report — it is exact to the
  // cent, because $12,147.50 rounded to $12,148 is a number nobody can
  // reconcile against an invoice.
  function money(n, compact) {
    if (n == null || !isFinite(n)) return "";
    if (compact) {
      var a = Math.abs(n);
      if (a >= 1000000) return "$" + (Math.round(n / 100000) / 10) + "M";
      if (a >= 10000) return "$" + Math.round(n / 1000) + "k";
      if (a >= 1000) return "$" + (Math.round(n / 100) / 10) + "k";
      return "$" + Math.round(n);
    }
    return "$" + Number(n).toLocaleString("en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Stable group-identity color slot (0..7). The 8 hues live in CSS as
  // --gc0..--gc7 (per-theme steps of a CVD-validated categorical palette);
  // the group NAME is always printed beside the color — never color alone.
  function groupSlot(name) {
    var s = String(name || ""), h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 8;
  }

  // Deterministic avatar tint for a person (identity, not status).
  function avatarColor(name) {
    var h = 0, s = String(name || "");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return "hsl(" + (h % 360) + ",45%,45%)";
  }
  function todayISO() {
    var d = new Date(), p = function (v) { return String(v).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  // SVG has no text-overflow, so clip by an estimated advance width.
  function clip(str, maxPx, fontPx) {
    var s = String(str == null ? "" : str);
    var max = Math.max(3, Math.floor(maxPx / (fontPx * 0.55)));
    return s.length > max ? s.slice(0, max - 1).replace(/[\s·]+$/, "") + "…" : s;
  }

  function daysAgo(iso) {
    if (!iso) return null;
    var t = Date.parse(iso);
    if (!isFinite(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }
  function fmtDay(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (!isFinite(d)) return "";
    return (d.getMonth() + 1) + "/" + d.getDate() + "/" + String(d.getFullYear()).slice(2);
  }

  /* ── derive ──────────────────────────────────────────────────────────── */
  function derive(payload, prefs) {
    prefs = prefs || {};
    var p = payload.project || {};
    var status = String(p.estimateStatus || "").trim();
    var idx = STATUS_IDX[status.toLowerCase()];
    var onHold = status.toLowerCase() === "on hold";
    var known = idx !== undefined;

    // milestone dates from "Status changed: X → Y" log lines (latest per target)
    var statusDates = {};
    (payload.logs || []).forEach(function (l) {
      var m = /Status changed:\s*(.+?)\s*(?:→|->)\s*(.+)$/.exec(String(l.logDescription || ""));
      if (!m) return;
      var target = m[2].trim();
      if (!statusDates[target] || String(l.logDate) > String(statusDates[target])) {
        statusDates[target] = l.logDate;
      }
    });
    function reached(st) { return !!statusDates[st]; }
    var effIdx = known ? idx : 0;

    var msDates = {
      1: p.projectDate, 2: statusDates["Recived"], 3: statusDates["Estimating"],
      4: statusDates["Sent"], 5: statusDates["Follow"], 6: statusDates["Aproved"],
      7: statusDates["Completed"] || p.projectCompletedDate,
    };
    var milestones = MS_DEFS.map(function (d) {
      var done =
        d.n === 1 ? true :
        d.n === 7 ? effIdx >= 7 :
        (effIdx > d.n || (!known && reached({2:"Recived",3:"Estimating",4:"Sent",5:"Follow",6:"Aproved"}[d.n])));
      // "Sent" reached historically also completes M4 even if status skipped it
      if (!done && d.n <= 6 && known && effIdx === d.n && d.n < 3) done = false;
      return { n: d.n, label: d.label, done: done,
        current: known && !onHold && effIdx === d.n && d.n !== 3 && d.n !== 6,
        date: msDates[d.n] ? fmtDay(msDates[d.n]) : "" };
    });

    // ── lanes ──
    var items = payload.items || [];
    var quotes = payload.quotes; // may be null
    var bills = payload.bills;   // accounts payable; null when prices are hidden
    var hidden = !!payload.pricesHidden;
    var laneByKey = {}, laneOrder = [];
    items.forEach(function (it) { laneByKey[it.key] = null; laneOrder.push(it.key); });

    // quote → lane matching per spec §4.2
    var matched = {}; // laneKey -> quotes[]
    var unlinkedQuotes = [];
    items.forEach(function (it) { matched[it.key] = []; });
    (quotes || []).forEach(function (q) {
      var tid = q.taskItemID != null && q.taskItemID !== "" ? String(q.taskItemID) : "";
      if (tid) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].rowIds.indexOf(tid) !== -1) { matched[items[i].key].push(q); return; }
        }
      }
      var est = String(q.taskEstimateName || ""), grp = String(q.taskGroupingName || "");
      var exact = items.filter(function (it) { return it.estimateName === est && it.groupingName === grp; });
      if (exact.length) { matched[exact[0].key].push(q); return; }
      var byGrp = items.filter(function (it) { return it.groupingName === grp; });
      if (byGrp.length) {
        q._ambiguous = byGrp.length > 1;
        matched[byGrp[0].key].push(q);
        return;
      }
      unlinkedQuotes.push(q);
    });

    /* Bills we received land in a lane by the same three-step match as quotes:
       the task row id, then the exact estimate+group pair, then the group name
       alone. Anything matching nothing is money owed on this project that is not
       attached to a scope item — kept and surfaced, never dropped. */
    var billsBy = {}, unlinkedBills = [];
    items.forEach(function (it) { billsBy[it.key] = []; });
    (bills || []).forEach(function (b) {
      var tid = b.taskItemID != null && b.taskItemID !== "" ? String(b.taskItemID) : "";
      if (tid) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].rowIds.indexOf(tid) !== -1) { billsBy[items[i].key].push(b); return; }
        }
      }
      var est = String(b.taskEstimateName || ""), grp = String(b.taskGroupingName || "");
      var exact = items.filter(function (it) { return it.estimateName === est && it.groupingName === grp; });
      if (exact.length) { billsBy[exact[0].key].push(b); return; }
      var byGrp = items.filter(function (it) { return it.groupingName === grp; });
      if (byGrp.length) { b._ambiguous = byGrp.length > 1; billsBy[byGrp[0].key].push(b); return; }
      unlinkedBills.push(b);
    });

    function received(q) { return !!(q.quoteReceivedDate || Number(q.quoteAmount) > 0); }

    var lanes = items.map(function (it) {
      var qs = matched[it.key] || [];
      var requests = qs.filter(function (q) { return q.quoteStatus !== "Self"; });
      var hasSelf = qs.some(function (q) { return q.quoteStatus === "Self"; });
      var awardedRows = qs.filter(function (q) { return q.quoteStatus === "Awarded"; });
      var selfOnly = hasSelf && !awardedRows.length;
      var nReceived = requests.filter(received).length;
      var overdue = requests.some(function (q) {
        if (received(q) || q.quoteStatus === "Declined") return false;
        var d = daysAgo(q.quoteRequestDate);
        return d != null && d > 14;
      });
      var awarded = 0, inv = 0, paid = 0, awardedNames = [];
      awardedRows.forEach(function (q) {
        awarded += Number(q.quoteAmount) || 0;
        inv += Number(q.invoiceAmount) || 0;
        paid += Number(q.paidAmount) || 0;
        var nm = String(q.vendorCompany || q.vendorName || "").split(/\s+/)[0];
        if (nm) awardedNames.push(nm);
      });
      var invDated = awardedRows.some(function (q) { return q.invoiceDate; });
      var paidDated = awardedRows.some(function (q) { return q.paidDate; });

      /* Money out for this scope item, from the bills actually received.
         `billed` is what was invoiced to us, `approvedAmt` the part somebody
         authorized, `paidOut` what has left. Bills are the real record; the
         amounts typed on an awarded quote are the older, coarser one, used only
         when this lane has no bills at all. */
      var laneBills = billsBy[it.key] || [];
      var billed = 0, approvedAmt = 0, paidOut = 0, waiting = 0, owed = 0, overdueBill = false;
      var todayStr = todayISO();
      laneBills.forEach(function (b) {
        var amt = Number(b.expenseAmount) || 0;
        billed += amt;
        paidOut += Number(b.paidAmount) || 0;
        if (String(b.approvedDate || "").trim()) {
          approvedAmt += amt;
          owed += Number(b.owedAmount) || 0;
        } else {
          waiting += 1;
        }
        if (b.expenseDueDate && String(b.expenseDueDate) < todayStr && (Number(b.owedAmount) || 0) > 0) {
          overdueBill = true;
        }
      });
      var hasBills = laneBills.length > 0;

      function st(node) {
        // A1 quotes in
        if (node === "A1") {
          if (quotes === null) return { s: "na", chip: "—" };
          if (!requests.length) {
            if (hasSelf || it.priced) return { s: "skipped", chip: hasSelf ? "Self" : "" };
            return { s: "notStarted", chip: "no quotes" };
          }
          if (nReceived >= requests.length) return { s: "done", chip: requests.length + " in" };
          if (overdue) return { s: "attention", chip: nReceived + " of " + requests.length + " in" };
          return { s: "inProgress", chip: nReceived + " of " + requests.length + " in" };
        }
        if (node === "A2") {
          if (it.priced) return { s: "done", chip: hidden ? "priced" : money(it.estTotal || it.quotedPrice, true) };
          var a1 = st("A1");
          if (a1.s === "done" || a1.s === "skipped") return { s: "inProgress", chip: "price it" };
          return { s: "notStarted", chip: "" };
        }
        if (node === "B1") {
          if (awardedRows.length) {
            return { s: "done", chip: (hidden ? "" : money(awarded, true) + " ") +
              (awardedNames[0] || "") + (awardedRows.length > 1 ? " ×" + awardedRows.length : "") };
          }
          if (selfOnly) return { s: "done", chip: "Self" };
          if (effIdx >= 6) return { s: "inProgress", chip: "pick vendor" };
          return { s: "notStarted", chip: "" };
        }
        if (node === "B2") {
          if (selfOnly && !awardedRows.length && !hasBills) return { s: "skipped", chip: "" };
          var b1 = st("B1");
          if (b1.s !== "done" && !hasBills) return { s: "notStarted", chip: "" };
          if (hidden) return (hasBills || invDated) ? { s: "done", chip: "billed" } : { s: "inProgress", chip: "" };
          // A bill we were actually sent beats an amount typed on a quote.
          if (hasBills) {
            var blabel = money(billed, true) + (laneBills.length > 1 ? " ×" + laneBills.length : "");
            if (awarded > 0 && billed > 1.001 * awarded) return { s: "attention", chip: blabel + " over" };
            return { s: "done", chip: blabel };
          }
          if (awarded > 0 && inv >= 0.999 * awarded) return { s: "done", chip: money(inv, true) };
          // With no agreed amount there is nothing to measure against, so an
          // invoice is unverified — not an overrun. Saying "$1.5k of $0" reads
          // as a blown budget when it only means the award has no price yet.
          if (inv > 0 && !(awarded > 0)) return { s: "inProgress", chip: money(inv, true) + " · unset" };
          if (inv > 0) return { s: "attention", chip: money(inv, true) + " of " + money(awarded, true) };
          return { s: "inProgress", chip: "no invoice" };
        }
        /* B3 — authorized to pay. The whole point of the approval: at a
           glance, is money sitting here that nobody has signed off? */
        if (node === "B3") {
          if (!hasBills) {
            if (selfOnly && !awardedRows.length) return { s: "skipped", chip: "" };
            return { s: "notStarted", chip: "" };
          }
          if (waiting) return { s: "attention", chip: waiting + " waiting" };
          if (hidden) return { s: "done", chip: "approved" };
          return { s: "done", chip: money(approvedAmt, true) };
        }
        if (node === "B4") {
          if (!hasBills) {
            if (selfOnly && !awardedRows.length) return { s: "skipped", chip: "" };
            // no bills on this lane: fall back to the older quote-based amounts
            if (hidden) return paidDated ? { s: "done", chip: "paid" } : { s: "notStarted", chip: "" };
            if (inv > 0 && paid >= 0.999 * inv) return { s: "done", chip: money(paid, true) };
            if (paid > 0) return { s: "attention", chip: money(paid, true) + " of " + money(inv, true) };
            if (inv > 0) return { s: "inProgress", chip: "unpaid" };
            return { s: "notStarted", chip: "" };
          }
          if (hidden) return owed > 0 ? { s: "inProgress", chip: "" } : { s: "done", chip: "paid" };
          if (approvedAmt > 0 && paidOut >= 0.999 * approvedAmt) return { s: "done", chip: money(paidOut, true) };
          if (overdueBill) return { s: "attention", chip: money(owed, true) + " overdue" };
          if (owed > 0) return { s: "inProgress", chip: money(owed, true) + " due" };
          return { s: "notStarted", chip: "" };
        }
        return { s: "notStarted", chip: "" };
      }

      var nodes = { A1: st("A1"), A2: st("A2"), B1: st("B1"), B2: st("B2"), B3: st("B3"), B4: st("B4") };
      var flag = it.flag || null;
      if (flag && flag.state === "complete") {
        ["A1", "A2", "B1", "B2", "B3", "B4"].forEach(function (k) {
          if (nodes[k].s !== "skipped") nodes[k] = { s: "done", chip: nodes[k].chip };
        });
      }
      // lane %
      var pctA = (it.priced || nodes.A1.s === "skipped") ? 100
        : nodes.A1.s === "done" ? 60
        : requests.length ? 30 : 0;
      if (it.priced) pctA = 100;
      /* Execution progress in four equal steps: awarded, billed, approved,
         paid. (The three-step version assigned pctB three times in a row and
         only the last one counted — the first two were dead code.) */
      var pctB = 0;
      if (awardedRows.length || selfOnly || hasBills) {
        pctB = 25;
        if (hidden) {
          pctB = hasBills ? (owed > 0 ? (waiting ? 50 : 75) : 100)
               : paidDated ? 100 : invDated ? 75 : 25;
        } else if (hasBills) {
          pctB = 25;
          pctB += 25 * Math.min(1, awarded > 0 ? billed / awarded : 1);
          if (billed > 0) pctB += 25 * Math.min(1, approvedAmt / billed);
          if (approvedAmt > 0) pctB += 25 * Math.min(1, paidOut / approvedAmt);
        } else if (awarded > 0) {
          pctB += 25 * Math.min(1, inv / awarded);
          if (inv > 0) pctB += 50 * Math.min(1, paid / inv);
        }
      }
      if (flag && flag.state === "complete") { pctA = 100; pctB = 100; }
      var attention = (!flag || flag.state !== "complete") &&
        (overdue || nodes.B2.s === "attention" || nodes.B3.s === "attention" ||
          nodes.B4.s === "attention" ||
          (flag && (flag.state === "blocked" || flag.state === "important")));

      var assignees = it.assignees || [];
      var initials = "";
      if (assignees.length) {
        var words = String(assignees[0].name || assignees[0].email || "").trim().split(/[\s@]+/);
        initials = (words[0] ? words[0][0] : "") + (words[1] ? words[1][0] : "");
        initials = initials.toUpperCase();
      }

      return {
        key: it.key, estimateName: it.estimateName, groupingName: it.groupingName,
        rowIds: it.rowIds, assignees: assignees, initials: initials,
        estTotal: it.estTotal, quotedPrice: it.quotedPrice, priced: it.priced,
        scopeNames: it.scopeNames || [], quotes: qs, requests: requests.length,
        laborNames: it.laborNames || [], materialNames: it.materialNames || [],
        colorSlot: groupSlot(it.groupingName),
        takeoff: it.takeoff || null,
        awarded: awarded, invoiced: inv, paid: paid,
        // money out, from the bills we were actually sent
        bills: laneBills, billed: billed, approvedAmt: approvedAmt,
        paidOut: paidOut, owed: owed, waiting: waiting, overdueBill: overdueBill,
        nodes: nodes, pctA: pctA, pctB: Math.round(pctB), flag: flag, attention: attention,
      };
    });

    // region roll-up
    var n = lanes.length;
    var pctA = n ? Math.round(lanes.reduce(function (s, l) { return s + l.pctA; }, 0) / n) : (effIdx >= 4 ? 100 : 0);
    var pctB;
    if (!n) pctB = effIdx >= 7 ? 100 : 0;
    else if (!hidden) {
      var wTot = 0, wSum = 0;
      lanes.forEach(function (l) { var w = l.estTotal || 0; wTot += w; wSum += w * l.pctB; });
      pctB = wTot > 0 ? Math.round(wSum / wTot)
        : Math.round(lanes.reduce(function (s, l) { return s + l.pctB; }, 0) / n);
    } else {
      pctB = Math.round(lanes.reduce(function (s, l) { return s + l.pctB; }, 0) / n);
    }

    var msDone = {};
    milestones.forEach(function (m) { msDone[m.n] = m.done ? 100 : 0; });
    var overall = Math.round(
      (msDone[1] * 4 + msDone[2] * 6 + pctA * 25 + msDone[4] * 5 + msDone[5] * 10 + pctB * 45 + msDone[7] * 5) / 100
    );

    // expansion defaults by phase; user prefs win
    var expandedA = prefs.expandedA !== undefined ? prefs.expandedA : effIdx <= 4 && effIdx >= 2;
    var expandedB = prefs.expandedB !== undefined ? prefs.expandedB : effIdx >= 6 && effIdx < 7;
    if (!known) { expandedA = prefs.expandedA !== undefined ? prefs.expandedA : true; expandedB = prefs.expandedB !== undefined ? prefs.expandedB : false; }

    var pulseAt = null;
    if (known && !onHold) {
      if (!milestones[1].done) pulseAt = "M2";
      else if (pctA < 100 && effIdx === 3) pulseAt = "bandA";
      else if (!milestones[3].done) pulseAt = effIdx === 3 ? "bandA" : "M4";
      else if (effIdx === 4 || effIdx === 5) pulseAt = "M5";
      else if (effIdx === 6) pulseAt = "bandB";
      else if (!milestones[6].done) pulseAt = "M7";
    }

    // unassigned costs: expense rows whose GPT link matches no lane
    var allRowIds = {};
    items.forEach(function (it) { it.rowIds.forEach(function (r) { allRowIds[r] = 1; }); });
    var unassignedCosts = 0, unassignedRows = [];
    (payload.expenses || []).forEach(function (e) {
      if (!allRowIds[String(e.expenseOriginalEstimateNumber)]) {
        unassignedCosts += (e.materials || 0) + (e.contractors || 0) + (e.invoice || 0);
        unassignedRows.push(e);
      }
    });

    return {
      project: p, status: status, statusColor: STAGE_COLORS[status] || null,
      onHold: onHold, known: known, idx: effIdx,
      milestones: milestones, lanes: lanes,
      regions: {
        pctA: pctA, pctB: pctB, expandedA: expandedA, expandedB: expandedB,
        humanA: n ? lanes.filter(function (l) { return l.pctA >= 100; }).length + " of " + n + " items priced" : "no items",
        humanB: hidden || !n
          ? (n ? lanes.filter(function (l) { return l.pctB >= 100; }).length + " of " + n + " items done" : "no items")
          : money(lanes.reduce(function (s, l) { return s + l.paid; }, 0), true) + " of " +
            money(lanes.reduce(function (s, l) { return s + (l.awarded || 0); }, 0), true) + " paid to subs",
      },
      overall: overall, pulseAt: pulseAt,
      quotesReady: !!payload.quotesReady, pricesHidden: hidden,
      unlinkedQuotes: unlinkedQuotes, unlinkedBills: unlinkedBills,
      invoices: payload.invoices || null, bills: bills,
      unassignedCosts: unassignedCosts, unassignedRows: unassignedRows,
      statusDates: statusDates,
      attentionCount: lanes.filter(function (l) { return l.attention; }).length,
    };
  }

  /* ── layout ──────────────────────────────────────────────────────────────
     Each expanded region carries its own item-identity column (color, who it's
     assigned to, the group name, the labor/material scope, flags), so the item
     is legible right where its nodes are — no separate rail to trace back to. */
  function layout(model, opts) {
    opts = opts || {};
    var compact = !!opts.compact;
    // Text is portal-normal size (13/12px) and never scaled: a bigger screen
    // means more of the chart is visible at once, not larger type. Every box is
    // sized around that text rather than the other way round.
    var LANE_H = compact ? 44 : 62, NODE_H = compact ? 30 : 40, NODE_W = compact ? 112 : 132;
    var GAP = compact ? 16 : 22, MS_R = compact ? 16 : 18;
    // The print report opts out (labels:false): its chart is scaled down to fit
    // the page and the item table below carries the same facts at full size.
    var withLabels = opts.labels !== false;
    var LABEL_W = withLabels ? (compact ? 330 : 380) : 0;
    var LEAD = withLabels ? LABEL_W + GAP : 0;
    var lanes = opts.lanes || model.lanes;
    var n = lanes.length;
    var expA = model.regions.expandedA, expB = model.regions.expandedB;
    var spanA = expA ? LEAD + 2 * NODE_W + GAP : 210;
    var spanB = expB ? LEAD + 4 * NODE_W + 3 * GAP : 210;
    var x = {};
    x.M1 = 40; x.M2 = 150; x.M3 = 260;
    x.Astart = x.M3 + 46;
    x.M4 = x.Astart + spanA + 56;
    x.M5 = x.M4 + 110; x.M6 = x.M5 + 110;
    x.Bstart = x.M6 + 46;
    x.M7 = x.Bstart + spanB + 56;
    var W = x.M7 + 70;
    // node columns, computed once so the combs and the nodes can never disagree
    var nodeX = { A: [], B: [] };
    var ax = x.Astart + LEAD, bx = x.Bstart + LEAD;
    nodeX.A = [ax, ax + NODE_W + GAP];
    nodeX.B = [bx, bx + NODE_W + GAP, bx + 2 * (NODE_W + GAP), bx + 3 * (NODE_W + GAP)];
    var cy = 58, y0 = 168;   // room for the milestone label + date at body size
    var showLanes = (expA || expB) && n > 0;
    var H = showLanes ? y0 + n * LANE_H + 40 : y0 + 40;
    function laneY(i) { return y0 + i * LANE_H + LANE_H / 2; }
    return { x: x, W: W, H: H, cy: cy, y0: y0, laneY: laneY, LANE_H: LANE_H,
      NODE_H: NODE_H, NODE_W: NODE_W, GAP: GAP, MS_R: MS_R, compact: compact,
      LABEL_W: LABEL_W, nodeX: nodeX,
      showLanes: showLanes, lanes: lanes };
  }

  /* ── svg ─────────────────────────────────────────────────────────────── */
  function svg(model, L, opts) {
    opts = opts || {};
    var s = [];
    var x = L.x, cy = L.cy, MS = L.MS_R;
    var lanes = L.lanes, n = lanes.length;
    var expA = model.regions.expandedA, expB = model.regions.expandedB;
    var interactive = opts.interactive !== false;

    function attr(sel) { return interactive ? ' role="button" tabindex="0" data-pm="' + esc(sel) + '" style="cursor:pointer"' : ""; }

    s.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + L.W + '" height="' + L.H +
      '" viewBox="0 0 ' + L.W + " " + L.H + '" role="img" aria-label="Project progress network" font-family="system-ui,Segoe UI,Arial">');

    // region tints
    if (L.showLanes || true) {
      s.push('<rect x="' + (x.Astart - 10) + '" y="10" width="' + (x.M4 - x.Astart - 36) +
        '" height="' + (L.H - 20) + '" rx="10" fill="var(--tint)" opacity="' + (expA ? ".35" : ".18") + '"/>');
      s.push('<rect x="' + (x.Bstart - 10) + '" y="10" width="' + (x.M7 - x.Bstart - 36) +
        '" height="' + (L.H - 20) + '" rx="10" fill="rgba(47,166,121,.09)"' + (expB ? "" : ' opacity=".5"') + "/>");
    }

    // spine segments
    var msX = [x.M1, x.M2, x.M3, x.M4, x.M5, x.M6, x.M7];
    for (var i = 0; i < 6; i++) {
      var a = msX[i], b = msX[i + 1];
      var mA = model.milestones[i], mB = model.milestones[i + 1];
      var col, dash = "";
      if (mB.done) col = "var(--ok)";
      else if (mB.current || mA.done) { col = mA.done && (mB.current || model.pulseAt) ? "var(--acc)" : "var(--border)"; if (!mB.current && !mA.done) dash = ' stroke-dasharray="4 4"'; }
      else { col = "var(--border)"; dash = ' stroke-dasharray="4 4"'; }
      if (!mB.done && !mB.current && !(mA.done && i < 6)) dash = ' stroke-dasharray="4 4"';
      s.push('<line x1="' + (a + MS) + '" y1="' + cy + '" x2="' + (b - MS) + '" y2="' + cy +
        '" stroke="' + col + '" stroke-width="2.5"' + dash + "/>");
    }

    // region trunks + lane stubs (comb edges, right angles only)
    function comb(anchorX, startX, endX, region, pct) {
      if (!L.showLanes || !(region === "A" ? expA : expB) || !n) return;
      var col = pct >= 100 ? "var(--ok)" : (model.pulseAt === "band" + region ? "var(--acc)" : "var(--border)");
      var lastY = L.laneY(n - 1);
      // diverge trunk down from the anchor milestone
      s.push('<path d="M ' + anchorX + " " + (cy + MS) + " L " + anchorX + " " + lastY +
        '" fill="none" stroke="' + col + '" stroke-width="1.5"/>');
      // converge trunk up to the next milestone
      var conv = endX;
      s.push('<path d="M ' + conv + " " + lastY + " L " + conv + " " + (cy + MS) +
        '" fill="none" stroke="' + col + '" stroke-width="1.5"/>');
      s.push('<path d="M ' + (conv - 4) + " " + (cy + MS + 8) + " L " + conv + " " + (cy + MS) +
        " L " + (conv + 4) + " " + (cy + MS + 8) + '" fill="none" stroke="' + col + '" stroke-width="1.5"/>');
      var cols = L.nodeX[region];
      var lastRight = cols[cols.length - 1] + L.NODE_W;
      for (var i = 0; i < n; i++) {
        var y = L.laneY(i);
        s.push('<line x1="' + anchorX + '" y1="' + y + '" x2="' + startX + '" y2="' + y +
          '" stroke="' + col + '" stroke-width="1.2"/>');
        s.push('<line x1="' + lastRight + '" y1="' + y + '" x2="' + conv + '" y2="' + y +
          '" stroke="' + col + '" stroke-width="1.2"/>');
      }
    }
    comb(x.M3, x.Astart, x.M4, "A", model.regions.pctA);
    comb(x.M6, x.Bstart, x.M7, "B", model.regions.pctB);

    // lane pass-through when both expanded
    if (L.showLanes && expA && expB) {
      for (var pi = 0; pi < n; pi++) {
        var py = L.laneY(pi);
        s.push('<line x1="' + x.M4 + '" y1="' + py + '" x2="' + x.M6 + '" y2="' + py +
          '" stroke="var(--border)" stroke-width="1" stroke-dasharray="2 4"/>');
      }
    }

    // collapsed region aggregate nodes
    function aggregate(startX, region, pct, human) {
      if ((region === "A" ? expA : expB) || !true) return;
      var w = 210, h = 38, y = cy - h / 2;
      s.push('<g' + attr("band:" + region) + '><rect x="' + startX + '" y="' + y + '" width="' + w +
        '" height="' + h + '" rx="10" fill="var(--surface)" stroke="' +
        (pct >= 100 ? "var(--ok)" : "var(--acc)") + '" stroke-width="1.5"/>');
      s.push('<text x="' + (startX + w / 2) + '" y="' + (cy - 3) + '" text-anchor="middle" font-size="13" font-weight="700" fill="var(--text)">' +
        esc((region === "A" ? "Bidding" : "Execution") + " · " + pct + "%") + "</text>");
      s.push('<text x="' + (startX + w / 2) + '" y="' + (cy + 12) + '" text-anchor="middle" font-size="12" fill="var(--text-muted)">' +
        esc(human) + " ▾</text></g>");
    }
    aggregate(x.Astart, "A", model.regions.pctA, model.regions.humanA);
    aggregate(x.Bstart, "B", model.regions.pctB, model.regions.humanB);

    // milestones
    var hintChip = "";
    model.milestones.forEach(function (m, i) {
      var mx = msX[i];
      var ring = m.done ? "var(--ok)" : m.current ? "var(--acc)" : "var(--border)";
      var rw = m.done ? 2.5 : m.current ? 3 : 1.5;
      s.push('<g' + attr("ms:" + m.n) + ">");
      if ((model.pulseAt === "M" + m.n)) {
        s.push('<circle cx="' + mx + '" cy="' + cy + '" r="' + MS + '" fill="none" stroke="var(--acc)" stroke-width="2" class="pm-pulse"/>');
      }
      s.push('<circle cx="' + mx + '" cy="' + cy + '" r="' + MS + '" fill="var(--surface)" stroke="' + ring + '" stroke-width="' + rw + '"/>');
      if (m.done) {
        s.push('<text x="' + mx + '" y="' + (cy + 6) + '" text-anchor="middle" font-size="17" font-weight="800" fill="var(--ok)">✓</text>');
      } else {
        s.push('<text x="' + mx + '" y="' + (cy + 5) + '" text-anchor="middle" font-size="13" font-weight="700" fill="' +
          (m.current ? "var(--acc)" : "var(--text-muted)") + '">' + m.n + "</text>");
      }
      s.push('<text x="' + mx + '" y="88" text-anchor="middle" font-size="13" font-weight="700" fill="' +
        (m.done || m.current ? "var(--text)" : "var(--text-muted)") + '">' + esc(m.label) + "</text>");
      if (m.date) s.push('<text x="' + mx + '" y="104" text-anchor="middle" font-size="12" fill="var(--text-muted)">' + esc(m.date) + "</text>");
      if (m.n === 5 && m.current && model.statusDates["Sent"]) {
        var d = daysAgo(model.statusDates["Sent"]);
        if (d != null) hintChip = '<text x="' + mx + '" y="120" text-anchor="middle" font-size="12" fill="var(--gold)">Sent ' + d + "d ago</text>";
      }
      s.push("</g>");
    });
    if (hintChip) s.push(hintChip);

    // lane nodes
    if (L.showLanes) {
      var GLYPH = { done: "✓", inProgress: "●", attention: "⚠", notStarted: "◌", skipped: "·", na: "—" };
      var STROKE = { done: "var(--ok)", inProgress: "var(--acc)", attention: "var(--gold)", notStarted: "var(--border)", skipped: "var(--border)", na: "var(--border)" };
      var FILL = { done: "rgba(47,166,121,.10)", inProgress: "var(--tint)", attention: "rgba(214,161,58,.14)", notStarted: "transparent", skipped: "transparent", na: "transparent" };
      var A_LABELS = { A1: "Quotes", A2: "Priced" };
      var B_LABELS = { B1: "Awarded", B2: "Billed to us", B3: "Approved", B4: "Paid" };

      // Item identity, drawn at the head of each region's lane: the color slot,
      // who it's assigned to, the group name, its labor/material scope and any
      // flag — everything the old left rail carried, beside the nodes instead.
      function laneLabel(lx, y, l) {
        var h = L.LANE_H - 6, top = y - h / 2;
        var nameF = 13, subF = 12;                       // portal body sizes
        var textX = lx + 38, textW = L.LABEL_W - 46;
        var who = l.assignees.map(function (a) { return a.name || a.email; }).join(", ");
        var scope = (l.laborNames || []).concat(l.materialNames || []).join(" · ");
        var overdue = l.flag && l.flag.due && l.flag.due < todayISO();
        var full = l.groupingName + (l.estimateName ? " — " + l.estimateName : "") +
          "\n" + (who ? "Assigned: " + who : "Unassigned") + (scope ? "\n" + scope : "") +
          (l.flag ? "\n" + l.flag.state.toUpperCase() + (l.flag.note ? ": " + l.flag.note : "") +
            (l.flag.due ? " (due " + l.flag.due + (overdue ? ", OVERDUE" : "") + ")" : "") : "");

        s.push('<g' + attr("lane:" + l.key + ":label") + "><title>" + esc(full) + "</title>");
        s.push('<rect x="' + lx + '" y="' + top + '" width="' + L.LABEL_W + '" height="' + h +
          '" rx="8" fill="var(--surface-2)" stroke="var(--border)" stroke-width="1"/>');
        // group-identity color slot (the name always sits beside it)
        s.push('<rect x="' + lx + '" y="' + top + '" width="5" height="' + h +
          '" rx="2.5" fill="var(--gc' + (l.colorSlot || 0) + ')"/>');
        // assignee avatar
        var avY = top + h / 2, avR = 13;
        if (l.initials) {
          s.push('<circle cx="' + (lx + 22) + '" cy="' + avY + '" r="' + avR + '" fill="' +
            avatarColor(l.assignees[0].name || l.assignees[0].email) + '"/>');
          s.push('<text x="' + (lx + 22) + '" y="' + (avY + 4) + '" text-anchor="middle" font-size="11" font-weight="800" fill="#fff">' +
            esc(l.initials) + "</text>");
        } else {
          s.push('<circle cx="' + (lx + 22) + '" cy="' + avY + '" r="' + avR + '" fill="none" stroke="var(--border)" stroke-width="1.5" stroke-dasharray="3 2"/>');
          s.push('<text x="' + (lx + 22) + '" y="' + (avY + 4) + '" text-anchor="middle" font-size="11.5" fill="var(--text-muted)">?</text>');
        }
        // flag / attention badge, right-aligned on the first line
        var badgeW = 0, bx2 = lx + L.LABEL_W - 8;
        function badge(txt, bg, fg) {
          var w = txt.length * 6.2 + 12;
          badgeW = w + 8;
          s.push('<rect x="' + (bx2 - w) + '" y="' + (top + 6) + '" width="' + w + '" height="17" rx="8.5" fill="' + bg + '"/>');
          s.push('<text x="' + (bx2 - w / 2) + '" y="' + (top + 18) + '" text-anchor="middle" font-size="10.5" font-weight="800" fill="' + fg + '">' +
            esc(txt) + "</text>");
        }
        if (l.flag && l.flag.state === "blocked") badge("BLOCKED", "var(--err)", "#fff");
        else if (l.flag && l.flag.state === "complete") badge("DONE", "var(--ok)", "#fff");
        else if (l.flag && l.flag.state === "important") badge(overdue ? "⚑ OVERDUE" : "⚑ " + (l.flag.due || "IMPORTANT"), overdue ? "var(--err)" : "var(--gold)", "#fff");
        else if (l.attention) badge("⚠", "var(--gold)", "#fff");

        // Comfortable stacks name / assignee / scope; compact keeps the same
        // type size and drops to two lines instead of shrinking the text.
        s.push('<text x="' + textX + '" y="' + (top + 18) + '" font-size="' + nameF +
          '" font-weight="700" fill="var(--text)">' + esc(clip(l.groupingName, textW - badgeW, nameF)) + "</text>");
        if (L.compact) {
          s.push('<text x="' + textX + '" y="' + (top + 34) + '" font-size="' + subF +
            '" fill="var(--text-muted)">' +
            esc(clip((who ? "👤 " + who : "unassigned") + (scope ? "  ·  " + scope : ""), textW, subF)) + "</text>");
        } else {
          s.push('<text x="' + textX + '" y="' + (top + 36) + '" font-size="' + subF +
            '" fill="' + (who ? "var(--text-muted)" : "var(--border)") + '">' +
            esc(clip((who ? "👤 " + who : "unassigned"), textW, subF)) + "</text>");
          if (scope) {
            s.push('<text x="' + textX + '" y="' + (top + 51) + '" font-size="' + subF +
              '" fill="var(--text-muted)" opacity=".8">' + esc(clip(scope, textW, subF)) + "</text>");
          }
        }
        s.push("</g>");
      }

      lanes.forEach(function (l, i) {
        var y = L.laneY(i);
        function node(nx, kind) {
          var stt = l.nodes[kind], st = stt.s;
          if (st === "skipped") {
            s.push('<circle cx="' + (nx + L.NODE_W / 2) + '" cy="' + y + '" r="4" fill="var(--border)"/>');
            return;
          }
          var dash = st === "notStarted" ? ' stroke-dasharray="4 3"' : "";
          s.push('<g' + attr("lane:" + l.key + ":" + kind) + ">");
          s.push('<rect x="' + nx + '" y="' + (y - L.NODE_H / 2) + '" width="' + L.NODE_W + '" height="' + L.NODE_H +
            '" rx="7" fill="' + FILL[st] + '" stroke="' + STROKE[st] + '" stroke-width="1.5"' + dash + "/>");
          var lbl = (A_LABELS[kind] || B_LABELS[kind]);
          var glyph = GLYPH[st] || "";
          if (L.compact) {
            s.push('<text x="' + (nx + L.NODE_W / 2) + '" y="' + (y + 4.5) + '" text-anchor="middle" font-size="12" fill="var(--text)">' +
              glyph + " " + esc(clip(stt.chip || lbl, L.NODE_W - 18, 12)) + "</text>");
          } else {
            s.push('<text x="' + (nx + 10) + '" y="' + (y - 3) + '" font-size="12" font-weight="700" fill="var(--text-muted)">' +
              glyph + " " + esc(lbl) + "</text>");
            s.push('<text x="' + (nx + 10) + '" y="' + (y + 13) + '" font-size="12.5" fill="var(--text)" style="font-variant-numeric:tabular-nums">' +
              esc(clip(stt.chip || "", L.NODE_W - 18, 12.5)) + "</text>");
          }
          s.push("</g>");
        }
        if (expA) { if (L.LABEL_W) laneLabel(x.Astart, y, l); node(L.nodeX.A[0], "A1"); node(L.nodeX.A[1], "A2"); }
        if (expB) {
          if (L.LABEL_W) laneLabel(x.Bstart, y, l);
          node(L.nodeX.B[0], "B1"); node(L.nodeX.B[1], "B2");
          node(L.nodeX.B[2], "B3"); node(L.nodeX.B[3], "B4");
        }
      });
    }

    s.push("</svg>");
    return s.join("");
  }

  window.PMChart = {
    derive: derive, layout: layout, svg: svg,
    money: money, fmtDay: fmtDay, daysAgo: daysAgo, esc: esc, groupSlot: groupSlot,
    STAGE_COLORS: STAGE_COLORS, SEP: SEP,
  };
})();
