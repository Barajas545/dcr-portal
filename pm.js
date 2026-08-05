/* PM progress chart page. One fetch (action=pm) renders everything; every
   write refetches. The derivation/geometry lives in pm-chart.js so the
   printable report shares it. */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var C = window.PMChart;
  var PID = new URLSearchParams(location.search).get("id");
  var state = {
    payload: null, model: null, profile: null,
    filter: "", estFilter: "*", attnOnly: false, density: null, // null = auto
    drawerKey: null, fetchedAt: 0,
  };
  var PREF_KEY = "dcr_pm_prefs";

  function prefs() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {}; } catch (e) { return {}; }
  }
  function projPrefs() { return (prefs()[PID] || {}); }
  function setPref(k, v) {
    var all = prefs();
    all[PID] = all[PID] || {};
    all[PID][k] = v;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(all)); } catch (e) {}
  }

  /* ── data ── */
  async function load() {
    var d = await DCR.api("/api/portal?action=pm&id=" + encodeURIComponent(PID));
    state.payload = d;
    state.fetchedAt = Date.now();
    try { localStorage.setItem("dcr_pm_last", JSON.stringify({ id: PID, name: d.project.projectName, num: d.project.internalIDNumber })); } catch (e) {}
    rederive();
  }
  function rederive() {
    var pp = projPrefs();
    state.model = C.derive(state.payload, { expandedA: pp.expandedA, expandedB: pp.expandedB });
    render();
  }

  /* ── picker view (no ?id=) ── */
  async function renderPicker() {
    var root = el("pmRoot");
    root.innerHTML = '<div class="pm-empty">Loading projects…</div>';
    var d = await DCR.api("/api/portal?action=board");
    var projects = d.projects || [];
    var last = null;
    try { last = JSON.parse(localStorage.getItem("dcr_pm_last") || "null"); } catch (e) {}
    var order = ["Recived", "Estimating", "Sent", "Follow", "Aproved", "In Progress", "On Hold", "Completed"];
    var byStatus = {};
    projects.forEach(function (p) {
      var s = p.estimateStatus || "(none)";
      (byStatus[s] = byStatus[s] || []).push(p);
    });
    var html = '<div class="pm-head"><span class="pm-title">📊 Progress Chart</span>' +
      '<span class="pm-sub">Pick a project — every stage, item and dollar on one chart.</span></div>' +
      '<div class="pm-bar"><input type="search" id="pkSearch" placeholder="Search projects…"></div>' +
      (last ? '<div class="pm-banner">Resume: <a href="pm.html?id=' + esc(last.id) + '"><b>' +
        esc((last.num ? last.num + " — " : "") + (last.name || "")) + "</b></a></div>" : "");
    order.concat(Object.keys(byStatus).filter(function (s) { return order.indexOf(s) === -1; }))
      .forEach(function (s) {
        var list = byStatus[s];
        if (!list || !list.length) return;
        html += '<div class="pm-h">' + esc(s) + " · " + list.length + "</div>" +
          '<div class="pm-cards">' + list.map(function (p) {
            return '<a class="pm-card pk-card" style="text-decoration:none;color:inherit" data-nm="' +
              esc(((p.internalIDNumber || "") + " " + (p.projectName || "") + " " + (p.projectAddress || "") + " " + (p.projectClientName || "")).toLowerCase()) +
              '" href="pm.html?id=' + esc(p.id) + '"><div class="k">' + esc(p.internalIDNumber || p.id) +
              '</div><div class="v" style="font-size:13px">' + esc(p.projectName || "(unnamed)") + "</div>" +
              '<div class="pm-sub">' + esc(p.projectAddress || "") + "</div></a>";
          }).join("") + "</div>";
      });
    root.innerHTML = html;
    el("pkSearch").addEventListener("input", function () {
      var q = this.value.trim().toLowerCase();
      root.querySelectorAll(".pk-card").forEach(function (c) {
        c.style.display = !q || c.dataset.nm.indexOf(q) !== -1 ? "" : "none";
      });
    });
  }

  /* ── main render ── */
  function visibleLanes() {
    var m = state.model;
    var q = state.filter.trim().toLowerCase();
    return m.lanes.filter(function (l) {
      if (state.estFilter !== "*" && l.estimateName !== state.estFilter) return false;
      if (state.attnOnly && !l.attention) return false;
      if (!q) return true;
      var hay = (l.groupingName + " " + l.estimateName + " " +
        (l.laborNames || []).join(" ") + " " + (l.materialNames || []).join(" ") + " " +
        l.assignees.map(function (a) { return a.name + " " + a.email; }).join(" ") + " " +
        l.quotes.map(function (x) { return (x.vendorName || "") + " " + (x.vendorCompany || ""); }).join(" ")).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  /* Vendor directory for the quote form. The Contacts table is small (~200
     rows), so it's fetched once per page load and filtered in the browser
     rather than re-queried on every keystroke. NOTE: the data endpoint
     answers with `value` — reading `items`/`rows` silently yields nothing. */
  var contactsCache = null;
  function contactsBook() {
    if (contactsCache) return contactsCache;
    contactsCache = DCR.api("/api/portal?action=data&list=contacts&top=999")
      .then(function (res) {
        return (res.value || []).map(function (c) {
          c._pre = [c.contactName, c.contactCompany, c.contactTrade]
            .map(function (v) { return String(v || "").trim().toLowerCase(); })
            .filter(Boolean);
          c._hay = [c.contactName, c.contactCompany, c.contactTrade, c.contactNickName,
            c.contactEMail, c.contactPhone].join(" ").toLowerCase();
          return c;
        });
      })
      .catch(function (e) { contactsCache = null; throw e; });  // let the next keystroke retry
    return contactsCache;
  }

  function todayISO() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /* The chart is never scaled: text stays at portal size and a bigger screen
     simply shows more of it at once. Only the browser's own zoom changes it. */
  document.addEventListener("fullscreenchange", function () {
    var b = el("pmFs");
    if (b) b.textContent = document.fullscreenElement ? "✕ Exit full screen" : "⛶ Full screen";
  });

  /* ── extras: money spent that no estimate item accounts for ────────────
     The concrete pump nobody priced. These rows carry no estimate-item link,
     so they never roll into a lane — which is exactly why they need somewhere
     visible to live, instead of quietly widening the gap between estimated
     and actual. */
  function extrasPanel() {
    var p = state.payload, m = state.model;
    if (!p.expenses || m.pricesHidden) return "";
    var rows = m.unassignedRows || [];
    var total = m.unassignedCosts || 0;
    var open = projPrefs().extrasOpen || false;
    return '<div class="pm-tk" data-open="' + (open ? "1" : "0") + '" id="pmExtras">' +
      '<div class="tk-hd" id="pmExAdd">💸 Not in the estimate — ' + rows.length +
        (rows.length ? " · " + C.money(total) : "") + " <span>" + (open ? "▾" : "▸") + "</span>" +
      '<span style="flex:1"></span>' +
      '<a class="pm-sub" id="pmExLink" href="project.html?id=' + esc(PID) + '&tab=expenses">Open the Expenses tab →</a></div>' +
      (open
        ? '<div style="padding:2px 14px 12px">' +
          '<div class="pm-sub" style="margin-bottom:6px">Costs with no estimate item behind them — ' +
          "the extras that eat the margin if nobody writes them down.</div>" +
          '<div id="pmExList">' + costRowsHtml(rows, state.payload.can.estimate, false) + "</div>" +
          (state.payload.can.estimate
            ? '<div style="margin-top:8px"><button class="btn btn-ghost btn-sm" id="exAdd">＋ Add an unplanned cost</button></div>' +
              costFormHtml("ex", false)
            : "") +
          "</div>"
        : "") + "</div>";
  }

  function wireExtras() {
    var hd = el("pmExAdd");
    if (!hd) return;
    hd.onclick = function (e) {
      if (e.target && e.target.id === "pmExLink") return;
      setPref("extrasOpen", el("pmExtras").dataset.open !== "1");
      render();
    };
    var add = el("exAdd");
    if (add) {
      add.onclick = function () {
        var f = el("exForm");
        f.style.display = f.style.display === "none" ? "" : "none";
        if (f.style.display === "") el("exDesc").focus();
      };
      el("exCancel").onclick = function () { el("exForm").style.display = "none"; el("exMsg").textContent = ""; };
      el("exSave").onclick = function () { saveCost("ex", null, function () { render(); }); };
    }
    var root = el("pmRoot");
    root.querySelectorAll("#pmExList .expDel").forEach(function (b) {
      b.onclick = function () { deleteCost(b.dataset.e).then(function () { render(); }); };
    });
  }

  /* ── project tasks panel (the Access Tasks tab, per employee) ── */
  function tasksPanel() {
    var p = state.payload;
    if (!p.tasks || !p.tasks.length) return "";
    var pend = p.tasks.filter(function (t) { return !t.complete; });
    var open = projPrefs().tasksOpen !== undefined ? projPrefs().tasksOpen : pend.length > 0;
    var body = "";
    if (open) {
      var byEmp = {};
      p.tasks.forEach(function (t) {
        var k = t.assignedPerson || "(unassigned)";
        (byEmp[k] = byEmp[k] || []).push(t);
      });
      body = '<div class="tk-body">' + Object.keys(byEmp).sort().map(function (emp) {
        var rows = byEmp[emp].map(function (t) {
          var urgent = !t.complete && /urgent/i.test(t.priority || "");
          return '<div class="tk-row' + (t.complete ? " done" : "") + '">' +
            '<span class="tk-ic">' + (t.complete ? "✓" : urgent ? "⚑" : "◌") + "</span>" +
            '<div class="tk-b"><div><b>' + esc(t.name || t.category || "Task") + "</b>" +
            (urgent ? ' <span class="tk-urg">URGENT</span>' : "") +
            (t.category && t.category !== t.name ? ' <span class="pm-sub">· ' + esc(t.category) + "</span>" : "") +
            ' <span class="pm-sub">' +
              esc(t.complete
                ? "done" + (t.dateCompleted ? " " + C.fmtDay(t.dateCompleted) : "")
                : (t.dateRequested ? "requested " + C.fmtDay(t.dateRequested) : "")) + "</span></div>" +
            (t.description ? '<div class="tk-d">' + esc(t.description) + "</div>" : "") +
            (t.complete && t.completedWork ? '<div class="tk-w">' + esc(t.completedWork) + "</div>" : "") +
            "</div></div>";
        }).join("");
        return '<div class="tk-grp"><div class="tk-emp">' + esc(emp) + "</div>" + rows + "</div>";
      }).join("") + "</div>";
    }
    return '<div class="pm-tk" id="pmTasksPanel" data-open="' + (open ? "1" : "0") + '"><div class="tk-hd" id="pmTkHd">📋 Project tasks — ' +
      pend.length + " pending · " + (p.tasks.length - pend.length) + " done <span>" + (open ? "▾" : "▸") + "</span>" +
      '<span style="flex:1"></span>' +
      '<a class="pm-sub" id="pmTkLink" href="project.html?id=' + esc(PID) + '&tab=tasks">Open the Tasks tab →</a></div>' +
      body + "</div>";
  }

  // Collapse/expand swaps only this panel — a full render() would reset the
  // chart's horizontal scroll and restart the milestone pulse for nothing.
  function wireTasks() {
    var hd = el("pmTkHd");
    if (!hd) return;
    hd.onclick = function (e) {
      if (e.target && e.target.id === "pmTkLink") return;
      // by id, not by class: the extras panel shares .pm-tk and renders first,
      // so a class lookup would swap the wrong panel out
      var panel = el("pmTasksPanel");
      setPref("tasksOpen", panel.dataset.open !== "1");
      var holder = document.createElement("div");
      holder.innerHTML = tasksPanel();
      if (panel && holder.firstChild) {
        panel.parentNode.replaceChild(holder.firstChild, panel);
        wireTasks();
      } else { render(); }
    };
  }

  function render() {
    var m = state.model, p = state.payload, root = el("pmRoot");
    var proj = m.project;
    var lanes = visibleLanes();
    var compact = state.density !== null ? state.density === "compact" : lanes.length > 18;
    var L = C.layout(m, { compact: compact, lanes: lanes });
    var estNames = [];
    m.lanes.forEach(function (l) { if (estNames.indexOf(l.estimateName) === -1) estNames.push(l.estimateName); });

    var segW = [4, 6, 25, 5, 10, 45, 5];
    var segVals = [
      m.milestones[0].done ? 100 : 0, m.milestones[1].done ? 100 : 0, m.regions.pctA,
      m.milestones[3].done ? 100 : 0, m.milestones[4].done ? 100 : 0, m.regions.pctB,
      m.milestones[6].done ? 100 : 0,
    ];
    var curSeg = m.pulseAt === "M2" ? 1 : m.pulseAt === "bandA" ? 2 : m.pulseAt === "M4" ? 3 :
      m.pulseAt === "M5" ? 4 : m.pulseAt === "bandB" ? 5 : m.pulseAt === "M7" ? 6 : -1;
    var strip = '<div class="pm-progress" title="Completion of tracked facts — not schedule">' +
      segW.map(function (w, i) {
        var bg = segVals[i] >= 100 ? "var(--ok)" : i === curSeg ? "var(--acc)" : "var(--surface-2)";
        var op = segVals[i] >= 100 || i === curSeg ? "1" : "0.9";
        return '<span style="flex:' + w + ';background:' + bg + ";opacity:" + op + '"></span>';
      }).join("") + "</div>";

    var money = "";
    if (!m.pricesHidden && p.items) {
      var est = 0, com = 0, inv = 0, paid = 0;
      m.lanes.forEach(function (l) { est += l.estTotal || 0; com += l.awarded || 0; inv += l.invoiced || 0; paid += l.paid || 0; });
      var cards = [["Estimate", est], ["Committed to subs", com], ["Sub invoices", inv], ["Paid to subs", paid]];
      if (p.payments) {
        var billed = 0, collected = 0;
        p.payments.forEach(function (x) { billed += x.paymentInvoiceAmount; if (x.paymentPAID) collected += x.paymentInvoiceAmount; });
        cards.push(["Billed to client", billed], ["Collected", collected]);
      }
      money = '<div class="pm-cards">' + cards.map(function (c) {
        return '<div class="pm-card"><div class="k">' + esc(c[0]) + '</div><div class="v">' + C.money(c[1]) + "</div></div>";
      }).join("") + "</div>";
    }

    var holdBar = m.onHold ? '<div class="pm-hold">⏸ ON HOLD — the chart shows history; resume the project from the popover on any milestone.</div>' : "";
    var setupBar = "";
    if (!m.quotesReady) {
      setupBar = p.can.setup
        ? '<div class="pm-banner">Quote tracking isn\'t set up yet. <button class="btn btn-sm" id="pmSetup">Enable quote tracking</button><span class="pm-msg" id="pmSetupMsg"></span></div>'
        : '<div class="pm-banner">Quote tracking isn\'t enabled yet — ask an admin to open this page and enable it.</div>';
    }

    var bandTitles = "";
    if (true) {
      var x = L.x;
      var pd = function (which) { return m.pulseAt === which ? '<span class="pdot"></span>' : ""; };
      bandTitles =
        '<div class="pm-bandtitle" data-band="A" style="left:' + (x.Astart) + 'px">' + pd("bandA") +
          "BIDDING <span class='pct'>" + m.regions.pctA + "% · " + esc(m.regions.humanA) + "</span> " +
          (m.regions.expandedA ? "▾" : "▸") + "</div>" +
        '<div class="pm-bandtitle" data-band="B" style="left:' + (x.Bstart) + 'px">' + pd("bandB") +
          "EXECUTION <span class='pct'>" + m.regions.pctB + "% · " + esc(m.regions.humanB) + "</span> " +
          (m.regions.expandedB ? "▾" : "▸") + "</div>";
    }

    var chart = m.lanes.length || m.known
      ? '<div class="pm-scroll"><div class="pm-stage">' +
        '<div class="pm-svgwrap">' + bandTitles + C.svg(m, L, { interactive: true }) + "</div>" +
        "</div></div>"
      : "";
    var empty = !m.lanes.length
      ? '<div class="pm-empty">No estimate items yet — add items on the <a href="project.html?id=' + esc(PID) +
        '">Estimate tab</a> and each becomes a track here.</div>'
      : "";

    root.innerHTML =
      '<div class="pm-head">' +
        '<span class="pm-title">' + esc((proj.internalIDNumber ? proj.internalIDNumber + " — " : "") + (proj.projectName || "Project")) + "</span>" +
        '<span class="pm-pill" style="background:' + (m.statusColor || "var(--surface-2)") + (m.statusColor ? "" : ";color:var(--text)") + '">' +
          esc(m.status || "no status") + "</span>" +
        '<span class="pm-sub">' + esc([proj.projectAddress, proj.projectCity, proj.projectClientName].filter(Boolean).join(" · ")) + "</span>" +
        '<span class="sp"></span>' +
        '<b style="font-size:15px">Overall ' + m.overall + "%</b>" +
        '<button class="btn btn-ghost btn-sm" id="pmRefresh" title="Refresh">↻</button>' +
        '<a class="btn btn-ghost btn-sm" href="report-pm.html?id=' + esc(PID) + '">🖨 Print report</a>' +
        '<a class="btn btn-ghost btn-sm" href="project.html?id=' + esc(PID) + '">Open project →</a>' +
      "</div>" +
      strip + money + holdBar + setupBar +
      '<div class="pm-bar">' +
        '<input type="search" id="pmSearch" placeholder="Find item, assignee, vendor…" value="' + esc(state.filter) + '">' +
        (estNames.length > 1
          ? '<select id="pmEst"><option value="*">All estimates</option>' + estNames.map(function (nm) {
              return '<option' + (state.estFilter === nm ? " selected" : "") + ' value="' + esc(nm) + '">' + esc(nm || "(no name)") + "</option>";
            }).join("") + "</select>"
          : "") +
        '<span class="pm-count">' + lanes.length +
          (lanes.length === m.lanes.length ? "" : " of " + m.lanes.length) + " items</span>" +
        '<button class="pm-chip' + (state.attnOnly ? " on" : "") + '" id="pmAttn">⚠ Needs attention (' + m.attentionCount + ")</button>" +
        '<button class="pm-chip" id="pmDensity">' + (compact ? "Comfortable view" : "Compact view") + "</button>" +
        '<button class="pm-chip" id="pmFs" title="Use the whole monitor">' +
          (document.fullscreenElement ? "✕ Exit full screen" : "⛶ Full screen") + "</button>" +
        '<span class="pm-legend">✓ Done · ● In progress · ⚠ Waiting · ◌ Not started</span>' +
      "</div>" +
      chart + extrasPanel() + tasksPanel() + empty;

    wire(compact);
  }

  function wire(compact) {
    el("pmRefresh").onclick = function () { load().catch(showErr); };
    el("pmSearch").addEventListener("input", function () { state.filter = this.value; render(); });
    var est = el("pmEst");
    if (est) est.onchange = function () { state.estFilter = this.value; render(); };
    el("pmAttn").onclick = function () { state.attnOnly = !state.attnOnly; render(); };
    el("pmDensity").onclick = function () { state.density = compact ? "comfortable" : "compact"; render(); };
    el("pmFs").onclick = function () {
      if (document.fullscreenElement) { document.exitFullscreen(); }
      else if (document.documentElement.requestFullscreen) { document.documentElement.requestFullscreen(); }
    };
    wireTasks();
    wireExtras();
    var setup = el("pmSetup");
    if (setup) setup.onclick = async function () {
      setup.disabled = true;
      try {
        await DCR.api("/api/portal?action=pm", { method: "POST", body: { op: "setup" } });
        await load();
      } catch (e) { el("pmSetupMsg").textContent = e.message || "Setup failed"; setup.disabled = false; }
    };
    var root = el("pmRoot");
    root.querySelectorAll("[data-band]").forEach(function (b) {
      b.onclick = function () {
        var which = b.dataset.band;
        var cur = which === "A" ? state.model.regions.expandedA : state.model.regions.expandedB;
        setPref(which === "A" ? "expandedA" : "expandedB", !cur);
        rederive();
      };
    });
    // delegated SVG interactions
    var stage = root.querySelector(".pm-svgwrap");
    if (stage && !stage._wired) {
      stage._wired = true;
      var act = function (e) {
        var g = e.target.closest ? e.target.closest("[data-pm]") : null;
        if (!g) return;
        var sel = g.getAttribute("data-pm");
        if (sel.indexOf("lane:") === 0) {
          var parts = sel.split(":");
          openDrawer(parts.slice(1, -1).join(":"));
        } else if (sel.indexOf("ms:") === 0) {
          openPopover(g, Number(sel.slice(3)));
        } else if (sel.indexOf("band:") === 0) {
          var which = sel.slice(5);
          setPref(which === "A" ? "expandedA" : "expandedB",
            !(which === "A" ? state.model.regions.expandedA : state.model.regions.expandedB));
          rederive();
        }
      };
      stage.addEventListener("click", act);
      stage.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(e); }
      });
    }
  }

  /* ── milestone popover ── */
  var NEXT_STATUS = { "Recived": "Estimating", "Estimating": "Sent", "Sent": "Aproved",
    "Follow": "Aproved", "Aproved": "In Progress", "In Progress": "Completed" };
  function openPopover(anchor, n) {
    var m = state.model, pop = el("pmPop");
    var ms = m.milestones[n - 1];
    var can = state.payload.can.status;
    var next = NEXT_STATUS[m.status];
    var hold = m.onHold;
    pop.innerHTML =
      "<b>" + esc(ms.label) + "</b>" +
      '<div class="pm-sub" style="margin:4px 0 8px">' +
        (ms.date ? ms.date + " · from the project log" : ms.done ? "Done" : ms.current ? "Current stage" : "Not reached yet") + "</div>" +
      (can
        ? (hold
            ? '<button class="btn btn-sm" id="ppResume">▶ Resume project</button>'
            : (next ? '<button class="btn btn-sm" id="ppAdvance">Advance to ' + esc(next) + " →</button> " : "") +
              '<button class="btn btn-ghost btn-sm" id="ppHold">⏸ Put on hold</button>') +
          '<div class="pm-msg" id="ppMsg"></div>'
        : "");
    pop.classList.add("open");
    var r = anchor.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - 260) + "px";
    pop.style.top = (r.bottom + 8) + "px";
    var close = function (e) {
      if (e && pop.contains(e.target)) return;
      pop.classList.remove("open");
      document.removeEventListener("pointerdown", close, true);
    };
    setTimeout(function () { document.addEventListener("pointerdown", close, true); }, 30);
    async function setStatus(st, label) {
      var msgEl = el("ppMsg");
      if (!confirm(label + "?")) return;
      try {
        await DCR.api("/api/portal?action=board", { method: "POST", body: { op: "status", projectId: PID, newStatus: st } });
        pop.classList.remove("open");
        await load();
      } catch (e) { if (msgEl) msgEl.textContent = e.message || "Could not change the stage"; }
    }
    var adv = el("ppAdvance"), hd = el("ppHold"), rs = el("ppResume");
    if (adv) adv.onclick = function () { setStatus(next, "Move the project to " + next); };
    if (hd) hd.onclick = function () { setStatus("On Hold", "Put this project on hold"); };
    if (rs) rs.onclick = function () { setStatus("In Progress", "Resume this project (In Progress)"); };
  }

  /* ── costs, invoices and tasks ─────────────────────────────────────────
     A cost is one ProjectExpenseAnalisis row. Linking it to an estimate item
     means stamping the item's estimate row id into ExpenseOriginalEstimateNumber
     (plus the grouping name), which is exactly how the Access expense screen
     has always joined them — so anything added here shows up there too, and
     several rows per item is the normal case, not a special one.
     Leave the link off and the cost is an extra that nobody estimated. */
  var COST_KINDS = [
    { k: "materials", label: "Material / supplier" },
    { k: "contractors", label: "Subcontractor" },
    { k: "invoice", label: "Invoice received" },
  ];
  function costTotal(e) { return (e.materials || 0) + (e.contractors || 0) + (e.invoice || 0); }
  function costKindOf(e) {
    if (e.invoice) return "Invoice";
    if (e.contractors) return "Subcontractor";
    if (e.materials) return "Material";
    return "";
  }
  function todayInput() { return todayISO(); }

  function costFormHtml(idp, forItem) {
    return '<div class="pm-form" id="' + idp + 'Form" style="display:none">' +
      '<div style="display:flex;gap:8px">' +
        '<div style="flex:1"><label>Date</label><input type="date" id="' + idp + 'Date" value="' + todayInput() + '"></div>' +
        '<div style="flex:1"><label>Kind</label><select id="' + idp + 'Kind">' +
          COST_KINDS.map(function (c) { return '<option value="' + c.k + '">' + esc(c.label) + "</option>"; }).join("") +
        "</select></div>" +
      "</div>" +
      '<label>What was it for</label><input id="' + idp + 'Desc" placeholder="e.g. concrete pump rental">' +
      '<label>Amount</label><input id="' + idp + 'Amt" type="number" inputmode="decimal" step="0.01">' +
      (forItem ? "" : '<label>Which part of the job (optional)</label><input id="' + idp + 'Grp" placeholder="e.g. Concrete">') +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button class="btn btn-sm" id="' + idp + 'Save">＋ Add cost</button>' +
      '<button class="btn btn-ghost btn-sm" id="' + idp + 'Cancel">Cancel</button></div>' +
      '<div class="pm-msg" id="' + idp + 'Msg"></div></div>';
  }

  function costRowsHtml(rows, canEdit, hidden) {
    if (!rows.length) return '<div class="pm-sub">Nothing recorded yet.</div>';
    return rows.map(function (e) {
      return '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;' +
        'font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)">' +
        "<span>" + esc(String(e.expenseDate || "").slice(0, 10)) + " · " +
        esc(e.description || e.gropingName || "cost") +
        (costKindOf(e) ? ' <span class="pm-sub">' + esc(costKindOf(e)) + "</span>" : "") + "</span>" +
        "<span style='white-space:nowrap'><b>" + (hidden ? "" : C.money(costTotal(e))) + "</b>" +
        (canEdit ? ' <button class="btn btn-ghost btn-sm expDel" data-e="' + esc(e.id) +
          '" title="Remove this cost" style="padding:0 6px">🗑</button>' : "") + "</span></div>";
    }).join("");
  }

  // One place that writes a cost row, used by the item drawer and the
  // extras panel — the only difference is whether the item link is stamped.
  async function saveCost(idp, link, onDone) {
    var amt = Number((el(idp + "Amt") || {}).value);
    var desc = String((el(idp + "Desc") || {}).value || "").trim();
    var m = el(idp + "Msg");
    if (!(amt > 0)) { if (m) m.textContent = "Enter an amount."; return; }
    if (!desc) { if (m) m.textContent = "Say what the cost was for."; return; }
    var kind = (el(idp + "Kind") || {}).value || "materials";
    var d = (el(idp + "Date") || {}).value || todayISO();
    var fields = { description: desc, expenseDate: new Date(d + "T12:00:00Z").toISOString() };
    fields[kind] = amt;
    if (link && link.rowId) fields.expenseOriginalEstimateNumber = String(link.rowId);
    if (link && link.grouping) fields.gropingName = link.grouping;
    else {
      var g = String((el(idp + "Grp") || {}).value || "").trim();
      if (g) fields.gropingName = g;
    }
    if (m) m.textContent = "Saving…";
    try {
      await DCR.api("/api/portal?action=project", { method: "POST",
        body: { op: "expAdd", projectId: PID, fields: fields } });
      await load();
      if (onDone) onDone();
    } catch (e) { if (m) m.textContent = e.message || "Could not save that cost."; }
  }

  async function deleteCost(id) {
    if (!confirm("Remove this cost?")) return;
    try {
      await DCR.api("/api/portal?action=project", { method: "POST", body: { op: "expDelete", itemId: id } });
      await load();
    } catch (e) { alert(e.message || "Could not remove it."); }
  }

  // Tasks belonging to one estimate item: linked by the estimate row id we
  // stamp into the sub-category when the task is raised here.
  function tasksForLane(l) {
    var ids = {};
    (l.rowIds || []).forEach(function (r) { ids[String(r)] = 1; });
    return (state.payload.tasks || []).filter(function (t) { return t.subCategory && ids[t.subCategory]; });
  }
  function itemTasksHtml(rows) {
    if (!rows.length) return '<div class="pm-sub">No tasks for this item.</div>';
    return rows.map(function (t) {
      return '<div style="display:flex;gap:8px;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)' +
        (t.complete ? ";opacity:.65" : "") + '">' +
        "<span>" + (t.complete ? "✓" : /urgent/i.test(t.priority) ? "⚑" : "◌") + "</span>" +
        "<span style='flex:1;min-width:0'><b>" + esc(t.name || "Task") + "</b>" +
        (t.assignedPerson ? ' <span class="pm-sub">· ' + esc(t.assignedPerson) + "</span>" : "") +
        (t.description ? '<div class="pm-sub">' + esc(t.description) + "</div>" : "") +
        (t.complete && t.completedWork ? '<div style="color:var(--ok)">' + esc(t.completedWork) + "</div>" : "") +
        "</span></div>";
    }).join("");
  }

  /* ── item drawer ── */
  function laneOf(key) {
    for (var i = 0; i < state.model.lanes.length; i++) if (state.model.lanes[i].key === key) return state.model.lanes[i];
    return null;
  }
  function openDrawer(key) {
    state.drawerKey = key;
    history.replaceState(null, "", "pm.html?id=" + encodeURIComponent(PID) + "&item=" + encodeURIComponent(key));
    renderDrawer();
    el("pmOvl").classList.add("open");
    el("pmDrawer").classList.add("open");
  }
  function closeDrawer() {
    state.drawerKey = null;
    history.replaceState(null, "", "pm.html?id=" + encodeURIComponent(PID));
    el("pmOvl").classList.remove("open");
    el("pmDrawer").classList.remove("open");
  }

  function renderDrawer() {
    var l = laneOf(state.drawerKey);
    var d = el("pmDrawer");
    if (!l) { d.innerHTML = ""; return; }
    var p = state.payload, m = state.model;
    var can = p.can;
    var hidden = m.pricesHidden;

    var costs = 0, costRows = [];
    (p.expenses || []).forEach(function (e) {
      if (l.rowIds.indexOf(String(e.expenseOriginalEstimateNumber)) !== -1) {
        costs += e.materials + e.contractors + e.invoice;
        costRows.push(e);
      }
    });
    var itemTasks = tasksForLane(l);

    var lbn = l.laborNames || [], mtn = l.materialNames || [];
    var scopeSec = "";
    if (lbn.length || mtn.length) {
      var li = function (arr) {
        return arr.slice(0, 20).map(function (s) {
          return '<div style="padding:2px 0;font-size:12px">• ' + esc(s) + "</div>";
        }).join("") + (arr.length > 20 ? '<div class="pm-sub">+' + (arr.length - 20) + " more</div>" : "");
      };
      scopeSec = '<div class="pm-h">Scope</div>' +
        '<div style="display:flex;gap:16px;flex-wrap:wrap">' +
        (lbn.length ? '<div style="flex:1;min-width:150px"><div class="pm-sub" style="font-weight:700">Labor</div>' + li(lbn) + "</div>" : "") +
        (mtn.length ? '<div style="flex:1;min-width:150px"><div class="pm-sub" style="font-weight:700">Materials</div>' + li(mtn) + "</div>" : "") +
        "</div>";
    }

    var moneyRow = hidden ? "" :
      '<div class="pm-h">Money</div><div class="pm-money">' +
      [["Estimate", l.estTotal], ["Awarded", l.awarded], ["Invoiced", l.invoiced], ["Paid", l.paid], ["Costs recorded", costs]]
        .map(function (c) {
          return '<div class="pm-card"><div class="k">' + esc(c[0]) + '</div><div class="v" style="font-size:13.5px">' + C.money(c[1] || 0) + "</div></div>";
        }).join("") + "</div>";

    var tkRow = "";
    if (l.takeoff && l.takeoff.lines) {
      tkRow = '<div class="pm-h">Material takeoff</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px">' +
        '<span>📐 ' + l.takeoff.lines + " line" + (l.takeoff.lines === 1 ? "" : "s") +
        (l.takeoff.names && l.takeoff.names.length ? ' <span class="pm-sub">· ' + esc(l.takeoff.names.join(", ")) + "</span>" : "") + "</span>" +
        "<b>" + (hidden || !l.takeoff.total ? "" : C.money(l.takeoff.total)) + "</b></div>" +
        '<a class="pm-sub" href="project.html?id=' + esc(PID) + '&tab=takeoffs">Open the Takeoffs tab →</a>';
    }

    var filesSec = '<div class="pm-h">Item documents <span id="pmFCount"></span></div>' +
      '<div id="pmFiles" class="pm-sub">Loading…</div>' +
      '<div style="margin-top:6px"><input type="file" id="pmFileIn" multiple style="display:none">' +
      '<button class="btn btn-ghost btn-sm" id="pmFileAdd">＋ Add document</button> ' +
      '<span class="pm-msg" id="pmFileMsg"></span></div>';

    var qRows = l.quotes.map(function (q) {
      var amt = hidden ? "" : (q.quoteAmount != null && q.quoteAmount !== "" ? C.money(Number(q.quoteAmount)) : "—");
      var awarded = q.quoteStatus === "Awarded";
      var menu = can.quotes
        ? '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">' +
          (q.quoteStatus === "Requested"
            ? '<button class="btn btn-ghost btn-sm qtRecv" data-q="' + esc(q.id) + '" style="padding:2px 8px">✓ Mark received…</button>' +
              (q.vendorEmail ? '<button class="btn btn-ghost btn-sm qtChase" data-q="' + esc(q.id) + '" style="padding:2px 8px">✉ Follow up</button>' : "")
            : "") +
          (q.quoteStatus === "Received"
            ? '<button class="btn btn-ghost btn-sm qtAward" data-q="' + esc(q.id) + '" style="padding:2px 8px">🏆 Award</button>' : "") +
          '<button class="btn btn-ghost btn-sm qtDel" data-q="' + esc(q.id) + '" style="padding:2px 8px">🗑</button>' +
          "</div>"
        : "";
      var invStrip = awarded && can.quotes
        ? '<div style="display:flex;gap:6px;margin-top:5px;align-items:center;font-size:11.5px" class="qtInvRow" data-q="' + esc(q.id) + '">' +
          '<input type="number" placeholder="Invoice $" class="qtInv" style="width:86px;padding:4px 6px" value="' + (hidden ? "" : (q.invoiceAmount || "")) + '">' +
          '<input type="number" placeholder="Paid $" class="qtPaid" style="width:86px;padding:4px 6px" value="' + (hidden ? "" : (q.paidAmount || "")) + '">' +
          '<button class="btn btn-ghost btn-sm qtInvSave" style="padding:2px 8px">Save</button></div>'
        : "";
      return '<tr><td><b>' + esc(q.vendorCompany || q.vendorName || "(vendor)") + "</b>" +
        (q.vendorTrade ? ' <span class="pm-sub">' + esc(q.vendorTrade) + "</span>" : "") +
        (q._ambiguous ? ' <span class="pm-sub" title="Matched by grouping name only">≈</span>' : "") +
        '<div class="pm-sub">' + esc([q.quoteRequestDate ? "req " + q.quoteRequestDate : "",
          q.quoteReceivedDate ? "rec " + q.quoteReceivedDate : ""].filter(Boolean).join(" · ")) + "</div>" +
        (q.documentUrl && /^https:\/\//i.test(q.documentUrl) ? '<a href="' + esc(q.documentUrl) + '" target="_blank" rel="noopener noreferrer">📎 quote doc</a>' : "") +
        menu + invStrip + "</td>" +
        '<td style="text-align:right;white-space:nowrap">' + amt +
        '<div><span class="pm-st ' + esc(q.quoteStatus || "Requested") + '">' + esc(q.quoteStatus || "Requested") + "</span></div></td></tr>";
    }).join("");

    var addForm = can.quotes
      ? '<div class="pm-h">Request a quote</div><div class="pm-form">' +
        '<div class="pm-sugg"><label>Vendor (from Contacts)</label>' +
        '<input id="qtVendor" autocomplete="off" placeholder="Type a vendor name…"><div class="list" id="qtVList"></div></div>' +
        '<div style="display:flex;gap:8px"><div style="flex:1"><label>Company</label><input id="qtCompany"></div>' +
        '<div style="flex:1"><label>Trade</label><input id="qtTrade"></div></div>' +
        '<div style="display:flex;gap:8px"><div style="flex:1"><label>Email</label><input id="qtEmail" type="email"></div>' +
        '<div style="flex:1"><label>Phone</label><input id="qtPhone"></div></div>' +
        (hidden ? "" : '<label>Quoted amount (if already known)</label><input id="qtAmt" type="number" inputmode="decimal">') +
        '<label>Notes</label><textarea id="qtNotes" rows="2"></textarea>' +
        '<label>Quote document URL (optional)</label><input id="qtDoc" placeholder="https://…">' +
        '<label style="display:flex;align-items:center;gap:6px;margin-top:10px"><input type="checkbox" id="qtMail" checked style="width:auto"> Compose the request email now</label>' +
        '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
        '<button class="btn btn-sm" id="qtSave">＋ Add quote request</button>' +
        '<button class="btn btn-ghost btn-sm" id="qtAwardNow" title="Skip the bidding steps — record this vendor as the one doing the work">🏆 Award to this vendor</button>' +
        '<button class="btn btn-ghost btn-sm" id="qtSelf">We self-perform this</button></div>' +
        '<div class="pm-msg" id="qtMsg"></div></div>'
      : "";

    var flagRow = can.status
      ? '<div class="pm-h">Item flag</div><div style="display:flex;gap:6px;flex-wrap:wrap">' +
        (l.flag && l.flag.state === "important"
          ? '<button class="btn btn-ghost btn-sm" id="fgClear3">Clear ⚑ important</button>'
          : '<button class="btn btn-ghost btn-sm" id="fgImp">⚑ Mark important…</button>') +
        (l.flag && l.flag.state === "blocked"
          ? '<button class="btn btn-ghost btn-sm" id="fgClear">Clear BLOCKED</button>'
          : '<button class="btn btn-ghost btn-sm" id="fgBlock">⛔ Mark blocked…</button>') +
        (l.flag && l.flag.state === "complete"
          ? '<button class="btn btn-ghost btn-sm" id="fgClear2">Un-mark complete</button>'
          : '<button class="btn btn-ghost btn-sm" id="fgDone">✓ Mark item complete</button>') +
        "</div>" +
        (l.flag ? '<div class="pm-sub" style="margin-top:4px' +
          (l.flag.due && l.flag.due < todayISO() ? ";color:var(--err);font-weight:700" : "") + '">' +
          esc((l.flag.note ? l.flag.note + " — " : "") + (l.flag.by || "") + " " + (l.flag.at || "") +
            (l.flag.due ? " · due " + l.flag.due + (l.flag.due < todayISO() ? " · OVERDUE" : "") : "")) + "</div>" : "")
      : "";

    var noteBox = can.log
      ? '<div class="pm-h">Quick note (goes to the project log)</div>' +
        '<div style="display:flex;gap:6px"><input id="pmNote" placeholder="e.g. rebar inspection passed" style="flex:1;padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text)">' +
        '<button class="btn btn-sm" id="pmNoteSave">Add</button></div><div class="pm-msg" id="pmNoteMsg"></div>'
      : "";

    d.innerHTML =
      '<div class="dh" style="border-left:4px solid var(--gc' + (l.colorSlot || 0) + ')"><div style="flex:1;min-width:0">' +
        '<div style="font-size:16px;font-weight:800">' + esc(l.groupingName) + "</div>" +
        '<div class="pm-sub">' + esc(l.estimateName || "") +
          (l.assignees.length ? " · " + esc(l.assignees.map(function (a) { return a.name || a.email; }).join(", ")) : " · unassigned") + "</div>" +
        '<a class="pm-sub" href="project.html?id=' + esc(PID) + '">Edit items / assignment in the Estimate tab →</a>' +
      "</div>" +
      '<button class="btn btn-ghost btn-sm" id="pmCopyLink" title="Copy link to this item">🔗</button>' +
      '<button class="btn btn-ghost btn-sm" id="pmDrawerX">✕</button></div>' +
      '<div class="db">' +
      scopeSec + moneyRow +
      '<div class="pm-h">Quotes' + (l.quotes.length ? " · " + l.quotes.length : "") + "</div>" +
      (state.model.quotesReady
        ? (qRows ? '<table class="pm-qt">' + qRows + "</table>" : '<div class="pm-sub">No quote requests yet.</div>')
        : '<div class="pm-sub">Quote tracking isn\'t enabled yet.</div>') +
      addForm +
      // Costs and invoices against this item — as many as it takes.
      '<div class="pm-h">Costs &amp; invoices' + (costRows.length ? " · " + costRows.length : "") +
        (hidden || !costRows.length ? "" : ' <span class="pm-sub">' + C.money(costs) + " total</span>") + "</div>" +
      '<div id="pmCostList">' + costRowsHtml(costRows, can.estimate, hidden) + "</div>" +
      (can.estimate
        ? '<div style="margin-top:6px"><button class="btn btn-ghost btn-sm" id="icAdd">＋ Add a cost or invoice</button></div>' +
          costFormHtml("ic", true)
        : "") +
      (costRows.length ? '<a class="pm-sub" href="project.html?id=' + esc(PID) + '&tab=expenses">Open the Expenses tab →</a>' : "") +

      // Tasks raised against this item.
      '<div class="pm-h">Tasks' + (itemTasks.length ? " · " + itemTasks.length : "") + "</div>" +
      '<div id="pmItemTasks">' + itemTasksHtml(itemTasks) + "</div>" +
      (can.status
        ? '<div style="margin-top:6px"><button class="btn btn-ghost btn-sm" id="itAdd">＋ Add a task</button></div>' +
          '<div class="pm-form" id="itForm" style="display:none">' +
          '<label>Task</label><input id="itName" placeholder="e.g. order the pump for Friday">' +
          '<label>Details</label><textarea id="itDesc" rows="2"></textarea>' +
          '<div style="display:flex;gap:8px"><div style="flex:1"><label>Who</label><input id="itWho" value="' +
            esc((l.assignees[0] && (l.assignees[0].name || l.assignees[0].email)) || "") + '"></div>' +
          '<div style="flex:1"><label>Priority</label><select id="itPri"><option value="">Normal</option><option>Urgent</option></select></div></div>' +
          '<div style="display:flex;gap:8px;margin-top:10px">' +
          '<button class="btn btn-sm" id="itSave">＋ Add task</button>' +
          '<button class="btn btn-ghost btn-sm" id="itCancel">Cancel</button></div>' +
          '<div class="pm-msg" id="itMsg"></div></div>'
        : "") +

      tkRow + filesSec + flagRow + noteBox +
      "</div>";

    el("pmDrawerX").onclick = closeDrawer;
    el("pmCopyLink").onclick = function () {
      var url = location.origin + location.pathname + "?id=" + encodeURIComponent(PID) + "&item=" + encodeURIComponent(l.key);
      if (navigator.clipboard) navigator.clipboard.writeText(url).catch(function () {});
      this.textContent = "✓";
    };
    wireDrawer(l);
    loadTaskFiles(l);
  }

  /* ── per-item documents (Project Documents/TaskDocuments/<row id>) ── */
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }
  async function loadTaskFiles(l) {
    var box = el("pmFiles"), cnt = el("pmFCount");
    if (!box) return;
    try {
      var r = await DCR.api("/api/portal?action=drive&taskDocs=" + encodeURIComponent(PID) +
        "&task=" + encodeURIComponent(l.rowIds.slice(0, 12).join(",")));
      if (state.drawerKey !== l.key || !el("pmFiles")) return;
      var fs = r.files || [];
      if (cnt) cnt.textContent = fs.length ? "· " + fs.length : "";
      if (!fs.length) { el("pmFiles").textContent = "No documents for this item yet."; return; }
      el("pmFiles").innerHTML = fs.map(function (f) {
        return '<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px solid var(--border);font-size:12px;align-items:center">' +
          '<a href="' + esc(f.webUrl || "#") + '" target="_blank" rel="noopener noreferrer" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📄 ' + esc(f.name) + "</a>" +
          '<span class="pm-sub" style="white-space:nowrap">' + fmtSize(f.size) + "</span></div>";
      }).join("");
    } catch (e) {
      if (el("pmFiles")) el("pmFiles").textContent = "Documents unavailable — " + (e.message || "no project folder yet.");
      if (cnt) cnt.textContent = "";
    }
  }

  function wireDrawer(l) {
    var d = el("pmDrawer");
    var msg = function (t) { var e = el("qtMsg"); if (e) e.textContent = t || ""; };

    async function write(body, msgEl) {
      try {
        await DCR.api("/api/portal?action=pm", { method: "POST", body: body });
        await load();
        renderDrawer();
      } catch (e) {
        var m2 = el(msgEl || "qtMsg");
        if (m2) m2.textContent = e.message || "Save failed";
        else alert(e.message || "Save failed");
      }
    }

    d.querySelectorAll(".qtRecv").forEach(function (b) {
      b.onclick = function () {
        var amt = state.model.pricesHidden ? null : prompt("Quoted amount ($):");
        if (amt === null && !state.model.pricesHidden) return;
        var f = { quoteStatus: "Received" };
        if (amt && Number(amt) > 0) f.quoteAmount = Number(amt);
        write({ op: "qtUpdate", itemId: b.dataset.q, fields: f });
      };
    });
    d.querySelectorAll(".qtAward").forEach(function (b) {
      b.onclick = function () {
        if (!confirm("Award this item to the vendor? Other quotes stay recorded.")) return;
        write({ op: "qtUpdate", itemId: b.dataset.q, fields: { quoteStatus: "Awarded" } });
      };
    });
    d.querySelectorAll(".qtDel").forEach(function (b) {
      b.onclick = function () {
        if (!confirm("Delete this quote row?")) return;
        write({ op: "qtDelete", itemId: b.dataset.q });
      };
    });
    d.querySelectorAll(".qtChase").forEach(function (b) {
      b.onclick = function () {
        var q = l.quotes.filter(function (x) { return String(x.id) === String(b.dataset.q); })[0];
        if (!q) return;
        var subj = "Follow-up: quote request — " + (state.model.project.internalIDNumber || "") + " " +
          (state.model.project.projectName || "") + " — " + l.groupingName;
        location.href = "mailto:" + encodeURIComponent(q.vendorEmail) + "?subject=" + encodeURIComponent(subj);
        var notes = (q.quoteNotes ? q.quoteNotes + "\n" : "") + "Follow-up sent " + new Date().toISOString().slice(0, 10);
        write({ op: "qtUpdate", itemId: b.dataset.q, fields: { quoteNotes: notes } });
      };
    });
    d.querySelectorAll(".qtInvRow").forEach(function (row) {
      row.querySelector(".qtInvSave").onclick = function () {
        var f = {};
        var inv = row.querySelector(".qtInv").value, paid = row.querySelector(".qtPaid").value;
        if (inv !== "") f.invoiceAmount = Number(inv);
        if (paid !== "") f.paidAmount = Number(paid);
        if (!Object.keys(f).length) return;
        write({ op: "qtUpdate", itemId: row.dataset.q, fields: f });
      };
    });

    // vendor typeahead over contacts
    var vend = el("qtVendor");
    var picked = { id: "" };
    if (vend) {
      var t = null;
      vend.addEventListener("input", function () {
        picked.id = "";
        clearTimeout(t);
        var q = vend.value.trim();
        if (q.length < 2) { el("qtVList").classList.remove("on"); return; }
        t = setTimeout(async function () {
          var list = el("qtVList");
          if (!list) return;
          var all;
          try {
            all = await contactsBook();
          } catch (e) {
            list.innerHTML = '<div class="none">Couldn\'t reach Contacts — type the vendor in by hand.</div>';
            list.classList.add("on");
            return;
          }
          var ql = q.toLowerCase();
          // prefix hits first (typing "dcr" should surface DCR Framing, not a
          // company that merely mentions it), then anywhere-matches
          var pre = [], any = [];
          for (var i = 0; i < all.length && pre.length + any.length < 60; i++) {
            var c = all[i];
            if (c._hay.indexOf(ql) === -1) continue;
            var starts = false;
            for (var j = 0; j < c._pre.length; j++) {
              if (c._pre[j].indexOf(ql) === 0) { starts = true; break; }
            }
            (starts ? pre : any).push(c);
          }
          var rows = pre.concat(any).slice(0, 8);
          if (!rows.length) {
            list.innerHTML = '<div class="none">No contact matches “' + esc(q) +
              '” — type the vendor in by hand, or add them in Contacts.</div>';
            list.classList.add("on");
            return;
          }
          list.innerHTML = rows.map(function (c) {
            return '<div data-c="' + esc(c.id) + '"><b>' + esc(c.contactName || c.contactCompany || "?") + "</b>" +
              ' <span class="pm-sub">' + esc([c.contactCompany, c.contactTrade, c.contactPhone].filter(Boolean).join(" · ")) + "</span></div>";
          }).join("");
          list.classList.add("on");
          list.querySelectorAll("[data-c]").forEach(function (it) {
            it.onclick = function () {
              var c = rows.filter(function (x) { return String(x.id) === it.dataset.c; })[0];
              if (!c) return;
              picked.id = String(c.id);
              vend.value = c.contactName || c.contactCompany || "";
              el("qtCompany").value = c.contactCompany || "";
              el("qtTrade").value = c.contactTrade || "";
              el("qtEmail").value = c.contactEMail || "";
              el("qtPhone").value = c.contactPhone || "";
              list.classList.remove("on");
            };
          });
        }, 180);
      });
    }

    function collectFields(status) {
      var f = {
        taskEstimateName: l.estimateName, taskGroupingName: l.groupingName,
        taskItemID: Number(l.rowIds[0]) || undefined,
        vendorName: (el("qtVendor") || {}).value || "",
        vendorCompany: (el("qtCompany") || {}).value || "",
        vendorTrade: (el("qtTrade") || {}).value || "",
        vendorEmail: (el("qtEmail") || {}).value || "",
        vendorPhone: (el("qtPhone") || {}).value || "",
        vendorContactID: picked.id,
        quoteNotes: (el("qtNotes") || {}).value || "",
        documentUrl: (el("qtDoc") || {}).value || "",
      };
      if (status) f.quoteStatus = status;
      var amtEl = el("qtAmt");
      if (amtEl && amtEl.value !== "" && Number(amtEl.value) > 0) f.quoteAmount = Number(amtEl.value);
      return f;
    }
    var save = el("qtSave");
    if (save) save.onclick = async function () {
      var f = collectFields();
      if (!f.vendorName && !f.vendorCompany) { msg("Give the vendor a name or a company."); return; }
      save.disabled = true;
      msg("Saving…");
      try {
        await DCR.api("/api/portal?action=pm", { method: "POST", body: { op: "qtAdd", projectId: PID, fields: f } });
        // Refresh FIRST. Opening the mail client used to happen before this, and
        // navigating the window to a mailto: could stop the refresh from ever
        // running — leaving a saved quote looking like nothing had happened.
        await load();
        renderDrawer();
        if ((el("qtMail") || {}).checked && f.vendorEmail) {
          var pj = state.model.project;
          var subj = "Quote request — " + (pj.internalIDNumber || "") + " " + (pj.projectName || "") + " — " + l.groupingName;
          var body = "Hello " + (f.vendorName || "") + ",\n\nPlease quote the following scope for " +
            (pj.projectAddress || "our project") + ":\n\n" +
            l.scopeNames.slice(0, 20).map(function (s) { return "• " + s; }).join("\n").slice(0, 500) +
            (pj.projectPlansURL ? "\n\nPLANS: " + pj.projectPlansURL : "") +
            "\n\nThank you,\n" + ((state.profile || {}).displayName || "");
          // an anchor, not location.href: this must never take the app window with it
          var a = document.createElement("a");
          a.href = "mailto:" + encodeURIComponent(f.vendorEmail) +
            "?subject=" + encodeURIComponent(subj) + "&body=" + encodeURIComponent(body);
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { a.remove(); }, 0);
        }
      } catch (e) { msg(e.message || "Save failed"); save.disabled = false; }
    };
    // The rest of the app saves by itself now, so a form that needs a press has
    // to say so — otherwise a filled-in vendor looks saved when it isn't.
    ["qtVendor", "qtCompany", "qtEmail", "qtPhone", "qtAmt", "qtNotes", "qtDoc", "qtTrade"].forEach(function (id) {
      var f2 = el(id);
      if (!f2) return;
      f2.addEventListener("input", function () {
        var v = el("qtVendor"), c = el("qtCompany");
        if ((v && v.value.trim()) || (c && c.value.trim())) {
          msg("Not saved yet — press ＋ Add quote request");
        }
      });
    });
    // "pick vendor" on the chart means exactly this: you already know who is
    // doing the work, so record it in one press instead of walking the
    // request → received → award path that exists for competitive bidding.
    var awardNow = el("qtAwardNow");
    if (awardNow) awardNow.onclick = function () {
      var f = collectFields("Awarded");
      if (!f.vendorName && !f.vendorCompany) { msg("Give the vendor a name or a company."); return; }
      var who = f.vendorCompany || f.vendorName;
      if (!confirm("Award this item to " + who + "?" +
        (f.quoteAmount ? "\n\n" + C.money(f.quoteAmount) : "\n\nNo amount entered — Committed to subs stays $0 until you add one."))) return;
      awardNow.disabled = true;
      msg("Saving…");
      write({ op: "qtAdd", projectId: PID, fields: f });
    };
    var self = el("qtSelf");
    if (self) self.onclick = function () {
      var f = collectFields("Self");
      if (!f.vendorName && !f.vendorCompany) f.vendorName = "DCR crew";
      msg("Saving…");
      write({ op: "qtAdd", projectId: PID, fields: f });
    };

    // per-item document upload — chunked PUT straight to SharePoint, same as
    // the project Files tab; files land beside the ones Access already made.
    var fAdd = el("pmFileAdd"), fIn = el("pmFileIn");
    if (fAdd && fIn) {
      var fMsg = function (t) { var e2 = el("pmFileMsg"); if (e2) e2.textContent = t || ""; };
      fAdd.onclick = function () { fIn.click(); };
      fIn.onchange = async function () {
        var files = Array.prototype.slice.call(fIn.files || []);
        fIn.value = "";
        fAdd.disabled = true;
        try {
          for (var i = 0; i < files.length; i++) {
            var file = files[i];
            if (!file.size) { fMsg("Skipped " + file.name + " (empty file)"); continue; }
            fMsg("Uploading " + file.name + "…");
            var s = await DCR.api("/api/portal?action=drive", { method: "POST",
              body: { op: "uploadSession", projectId: PID, target: "taskDocs",
                taskId: l.rowIds[0], name: file.name, mimeType: file.type } });
            var CHUNK = 320 * 1024 * 24, pos = 0, total = file.size;
            while (pos < total) {
              var end = Math.min(pos + CHUNK, total);
              await new Promise(function (resolve, reject) {
                var x = new XMLHttpRequest();
                x.open("PUT", s.uploadUrl);
                x.setRequestHeader("Content-Range", "bytes " + pos + "-" + (end - 1) + "/" + total);
                x.onload = function () {
                  if (x.status === 200 || x.status === 201 || x.status === 202) resolve();
                  else reject(new Error("Upload failed (" + x.status + ")"));
                };
                x.onerror = function () { reject(new Error("Upload failed — check your connection.")); };
                x.send(file.slice(pos, end));
              });
              pos = end;
            }
          }
          fMsg("✓ Saved");
          setTimeout(function () { fMsg(""); }, 3000);
          loadTaskFiles(l);
        } catch (e) { fMsg(e.message || "Upload failed"); }
        fAdd.disabled = false;
      };
    }

    // costs & invoices for this item
    var icAdd = el("icAdd");
    if (icAdd) {
      icAdd.onclick = function () {
        var f = el("icForm");
        f.style.display = f.style.display === "none" ? "" : "none";
        if (f.style.display === "") el("icDesc").focus();
      };
      el("icCancel").onclick = function () { el("icForm").style.display = "none"; el("icMsg").textContent = ""; };
      el("icSave").onclick = function () {
        saveCost("ic", { rowId: l.rowIds[0], grouping: l.groupingName }, function () { renderDrawer(); });
      };
    }
    d.querySelectorAll(".expDel").forEach(function (b) {
      b.onclick = function () { deleteCost(b.dataset.e).then(function () { renderDrawer(); }); };
    });

    // tasks for this item
    var itAdd = el("itAdd");
    if (itAdd) {
      itAdd.onclick = function () {
        var f = el("itForm");
        f.style.display = f.style.display === "none" ? "" : "none";
        if (f.style.display === "") el("itName").focus();
      };
      el("itCancel").onclick = function () { el("itForm").style.display = "none"; el("itMsg").textContent = ""; };
      el("itSave").onclick = async function () {
        var name = String(el("itName").value || "").trim();
        var m2 = el("itMsg");
        if (!name) { m2.textContent = "Give the task a name."; return; }
        m2.textContent = "Saving…";
        try {
          await DCR.api("/api/portal?action=project", { method: "POST", body: {
            op: "taskAdd", projectId: PID, taskName: name,
            description: String(el("itDesc").value || "").trim(),
            category: l.groupingName,               // reads as a heading in Access
            subCategory: String(l.rowIds[0] || ""), // the machine link back to the item
            assignedPerson: String(el("itWho").value || "").trim(),
            assignedEmail: (l.assignees[0] && l.assignees[0].email) || "",
            priority: el("itPri").value || "",
          } });
          await load();
          renderDrawer();
        } catch (e2) { m2.textContent = e2.message || "Could not add that task."; }
      };
    }

    var fg = function (state2, note) {
      write({ op: "flag", projectId: PID, itemKey: l.key, state: state2, note: note || "" }, "pmNoteMsg");
    };
    var b3 = el("fgImp"), c3 = el("fgClear3");
    if (b3) b3.onclick = function () {
      var note = prompt("What needs to happen? (e.g. invoice due, inspection, order materials)");
      if (note === null) return;
      // re-ask only the date, so a typo never costs the note they just typed
      var due = "", ask = "Due date (YYYY-MM-DD), or leave blank:";
      for (;;) {
        var v = prompt(ask, due);
        if (v === null) return;
        due = v.trim();
        if (!due || /^\d{4}-\d{2}-\d{2}$/.test(due)) break;
        ask = 'Use the format YYYY-MM-DD (e.g. ' + todayISO() + "), or leave blank:";
      }
      write({ op: "flag", projectId: PID, itemKey: l.key, state: "important", note: note, due: due }, "pmNoteMsg");
    };
    if (c3) c3.onclick = function () { fg(null); };
    var b1 = el("fgBlock"), b2 = el("fgDone"), c1 = el("fgClear"), c2 = el("fgClear2");
    if (b1) b1.onclick = function () {
      var note = prompt("What is it blocked on?");
      if (note === null) return;
      fg("blocked", note);
    };
    if (b2) b2.onclick = function () { if (confirm("Mark this whole item complete?")) fg("complete"); };
    if (c1) c1.onclick = function () { fg(null); };
    if (c2) c2.onclick = function () { fg(null); };

    var noteSave = el("pmNoteSave");
    if (noteSave) noteSave.onclick = async function () {
      var v = (el("pmNote") || {}).value.trim();
      if (!v) return;
      noteSave.disabled = true;
      try {
        await DCR.api("/api/portal?action=board", { method: "POST",
          body: { op: "log", projectId: PID, text: "[" + l.groupingName + "] " + v } });
        el("pmNote").value = "";
        noteSave.disabled = false;
        el("pmNoteMsg").textContent = "✓ Added to the project log";
      } catch (e) { el("pmNoteMsg").textContent = e.message || "Could not add the note"; noteSave.disabled = false; }
    };
  }

  function showErr(e) {
    el("pmRoot").innerHTML = '<div class="pm-empty">⚠ ' + esc(e.message || "Could not load") +
      '<div style="margin-top:10px"><button class="btn btn-sm" id="pmRetry">Retry</button></div></div>';
    el("pmRetry").onclick = function () { boot(); };
  }

  async function boot() {
    if (!PID) { renderPicker().catch(showErr); return; }
    try {
      await load();
      var item = new URLSearchParams(location.search).get("item");
      if (item && laneOf(item)) openDrawer(item);
    } catch (e) { showErr(e); }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    state.profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (state.profile.displayName || state.profile.email) + " · " + state.profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };
    el("pmOvl").onclick = closeDrawer;
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && el("pmDrawer").classList.contains("open")) closeDrawer();
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && PID && state.fetchedAt && Date.now() - state.fetchedAt > 600000) load().catch(function () {});
    });
    boot();
  });
})();
