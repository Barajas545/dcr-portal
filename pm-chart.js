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
  function money(n, compact) {
    if (n == null || !isFinite(n)) return "";
    if (compact) {
      var a = Math.abs(n);
      if (a >= 1000000) return "$" + (Math.round(n / 100000) / 10) + "M";
      if (a >= 10000) return "$" + Math.round(n / 1000) + "k";
      if (a >= 1000) return "$" + (Math.round(n / 100) / 10) + "k";
      return "$" + Math.round(n);
    }
    return "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
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
          if (selfOnly && !awardedRows.length) return { s: "skipped", chip: "" };
          var b1 = st("B1");
          if (b1.s !== "done") return { s: "notStarted", chip: "" };
          if (hidden) return invDated ? { s: "done", chip: "invoiced" } : { s: "inProgress", chip: "" };
          if (awarded > 0 && inv >= 0.999 * awarded) return { s: "done", chip: money(inv, true) };
          if (inv > 0) return { s: "attention", chip: money(inv, true) + " of " + money(awarded, true) };
          return { s: "inProgress", chip: "no invoice" };
        }
        if (node === "B3") {
          if (selfOnly && !awardedRows.length) return { s: "skipped", chip: "" };
          if (hidden) return paidDated ? { s: "done", chip: "paid" } : ((invDated) ? { s: "inProgress", chip: "" } : { s: "notStarted", chip: "" });
          if (inv > 0 && paid >= 0.999 * inv) return { s: "done", chip: money(paid, true) };
          if (paid > 0) return { s: "attention", chip: money(paid, true) + " of " + money(inv, true) };
          if (inv > 0) return { s: "inProgress", chip: "unpaid" };
          return { s: "notStarted", chip: "" };
        }
        return { s: "notStarted", chip: "" };
      }

      var nodes = { A1: st("A1"), A2: st("A2"), B1: st("B1"), B2: st("B2"), B3: st("B3") };
      var flag = it.flag || null;
      if (flag && flag.state === "complete") {
        ["A1", "A2", "B1", "B2", "B3"].forEach(function (k) {
          if (nodes[k].s !== "skipped") nodes[k] = { s: "done", chip: nodes[k].chip };
        });
      }
      // lane %
      var pctA = (it.priced || nodes.A1.s === "skipped") ? 100
        : nodes.A1.s === "done" ? 60
        : requests.length ? 30 : 0;
      if (it.priced) pctA = 100;
      var pctB = 0;
      if (awardedRows.length || selfOnly) {
        pctB = 33;
        if (!hidden && awarded > 0) {
          pctB = 33 + Math.min(1, inv / awarded) * 33;
          if (inv > 0) pctB = 66 * Math.min(1, inv / awarded) / 2 + 33; // linear 33→66 by inv
          pctB = 33 + 33 * Math.min(1, awarded ? inv / awarded : 0);
          if (inv > 0) pctB += 34 * Math.min(1, paid / inv);
        } else if (hidden) {
          pctB = paidDated ? 100 : invDated ? 66 : 33;
        }
      }
      if (flag && flag.state === "complete") { pctA = 100; pctB = 100; }
      var attention = (!flag || flag.state !== "complete") &&
        (overdue || nodes.B2.s === "attention" || nodes.B3.s === "attention" ||
          (flag && flag.state === "blocked"));

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
        takeoff: it.takeoff || null,
        awarded: awarded, invoiced: inv, paid: paid,
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
      unlinkedQuotes: unlinkedQuotes, unassignedCosts: unassignedCosts, unassignedRows: unassignedRows,
      statusDates: statusDates,
      attentionCount: lanes.filter(function (l) { return l.attention; }).length,
    };
  }

  /* ── layout ──────────────────────────────────────────────────────────── */
  function layout(model, opts) {
    opts = opts || {};
    var compact = !!opts.compact;
    var LANE_H = compact ? 25 : 36, NODE_H = compact ? 20 : 26, NODE_W = compact ? 68 : 104;
    var GAP = compact ? 18 : 26, MS_R = compact ? 15 : 17;
    var lanes = opts.lanes || model.lanes;
    var n = lanes.length;
    var expA = model.regions.expandedA, expB = model.regions.expandedB;
    var spanA = expA ? 2 * NODE_W + GAP : 170;
    var spanB = expB ? 3 * NODE_W + 2 * GAP : 170;
    var x = {};
    x.M1 = 40; x.M2 = 150; x.M3 = 260;
    x.Astart = x.M3 + 46;
    x.M4 = x.Astart + spanA + 56;
    x.M5 = x.M4 + 110; x.M6 = x.M5 + 110;
    x.Bstart = x.M6 + 46;
    x.M7 = x.Bstart + spanB + 56;
    var W = x.M7 + 70;
    var cy = 54, y0 = 150;
    var showLanes = (expA || expB) && n > 0;
    var H = showLanes ? y0 + n * LANE_H + 40 : y0 + 40;
    function laneY(i) { return y0 + i * LANE_H + LANE_H / 2; }
    return { x: x, W: W, H: H, cy: cy, y0: y0, laneY: laneY, LANE_H: LANE_H,
      NODE_H: NODE_H, NODE_W: NODE_W, GAP: GAP, MS_R: MS_R, compact: compact,
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
      for (var i = 0; i < n; i++) {
        var y = L.laneY(i);
        s.push('<line x1="' + anchorX + '" y1="' + y + '" x2="' + startX + '" y2="' + y +
          '" stroke="' + col + '" stroke-width="1.2"/>');
        var lastNode = region === "A" ? startX + 2 * L.NODE_W + L.GAP : startX + 3 * L.NODE_W + 2 * L.GAP;
        s.push('<line x1="' + (lastNode - L.GAP) + '" y1="' + y + '" x2="' + conv + '" y2="' + y +
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
      var w = 170, h = 30, y = cy - h / 2;
      s.push('<g' + attr("band:" + region) + '><rect x="' + startX + '" y="' + y + '" width="' + w +
        '" height="' + h + '" rx="9" fill="var(--surface)" stroke="' +
        (pct >= 100 ? "var(--ok)" : "var(--acc)") + '" stroke-width="1.5"/>');
      s.push('<text x="' + (startX + w / 2) + '" y="' + (cy - 2) + '" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--text)">' +
        esc((region === "A" ? "Bidding" : "Execution") + " · " + pct + "%") + "</text>");
      s.push('<text x="' + (startX + w / 2) + '" y="' + (cy + 10) + '" text-anchor="middle" font-size="9.5" fill="var(--text-muted)">' +
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
        s.push('<text x="' + mx + '" y="' + (cy + 5) + '" text-anchor="middle" font-size="14" font-weight="800" fill="var(--ok)">✓</text>');
      } else {
        s.push('<text x="' + mx + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="11" font-weight="700" fill="' +
          (m.current ? "var(--acc)" : "var(--text-muted)") + '">' + m.n + "</text>");
      }
      s.push('<text x="' + mx + '" y="84" text-anchor="middle" font-size="11" font-weight="700" fill="' +
        (m.done || m.current ? "var(--text)" : "var(--text-muted)") + '">' + esc(m.label) + "</text>");
      if (m.date) s.push('<text x="' + mx + '" y="97" text-anchor="middle" font-size="10" fill="var(--text-muted)">' + esc(m.date) + "</text>");
      if (m.n === 5 && m.current && model.statusDates["Sent"]) {
        var d = daysAgo(model.statusDates["Sent"]);
        if (d != null) hintChip = '<text x="' + mx + '" y="110" text-anchor="middle" font-size="9.5" fill="var(--gold)">Sent ' + d + "d ago</text>";
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
      var B_LABELS = { B1: "Awarded", B2: "Invoiced", B3: "Paid" };

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
            s.push('<text x="' + (nx + L.NODE_W / 2) + '" y="' + (y + 4) + '" text-anchor="middle" font-size="9.5" fill="var(--text)">' +
              glyph + " " + esc(stt.chip || lbl) + "</text>");
          } else {
            s.push('<text x="' + (nx + 8) + '" y="' + (y - 1) + '" font-size="9.5" font-weight="700" fill="var(--text-muted)">' +
              glyph + " " + esc(lbl) + "</text>");
            s.push('<text x="' + (nx + 8) + '" y="' + (y + 9) + '" font-size="9.5" fill="var(--text)" style="font-variant-numeric:tabular-nums">' +
              esc(stt.chip || "") + "</text>");
          }
          s.push("</g>");
        }
        if (expA) { node(x.Astart, "A1"); node(x.Astart + L.NODE_W + L.GAP, "A2"); }
        if (expB) { node(x.Bstart, "B1"); node(x.Bstart + L.NODE_W + L.GAP, "B2"); node(x.Bstart + 2 * (L.NODE_W + L.GAP), "B3"); }
      });
    }

    s.push("</svg>");
    return s.join("");
  }

  window.PMChart = {
    derive: derive, layout: layout, svg: svg,
    money: money, fmtDay: fmtDay, daysAgo: daysAgo, esc: esc,
    STAGE_COLORS: STAGE_COLORS, SEP: SEP,
  };
})();
