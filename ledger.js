/* The accountant's expense ledger.

   One table. The three summaries the owner asked for are group-by folds over
   these same rows, so the header total and the rows underneath it are the same
   arithmetic — the server computes both from one function.

   Receipts arrive in a SECOND request, after the table has painted, because a
   folder walk takes seconds and the money must not wait on the paperwork. */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var state = { d: null, receipts: null, receiptNote: "", busy: false, picked: {} };

  function money(v) {
    return "$" + (Number(v) || 0).toLocaleString("en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function day(v) {
    var s = String(v || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
    var d = new Date(s + "T12:00:00Z");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
  }
  function q() {
    return {
      period: state.d ? state.d.period : "30",
      group: el("lgGroup").value || "none",
      q: el("lgQ").value.trim(),
      zero: el("lgZero").checked ? "1" : "",
    };
  }

  // ── the controls ────────────────────────────────────────────────────────
  function chips(d) {
    el("lgPeriods").innerHTML = d.periods.map(function (p) {
      var n = d.counts[p.id];
      return '<button class="lg-chip" data-period="' + esc(p.id) + '" aria-pressed="' +
        (d.period === p.id ? "true" : "false") + '"><b>' + esc(p.label) + "</b>" +
        '<span class="n">' + (n === undefined ? "" : n) + "</span></button>";
    }).join("");
    if (!el("lgGroup").options.length) {
      el("lgGroup").innerHTML = (d.dimensions || [
        { id: "none", label: "No grouping" }, { id: "project", label: "By project" },
        { id: "employee", label: "By employee" }, { id: "card", label: "By card / payment" },
        { id: "month", label: "By month" },
      ]).map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.label) + "</option>"; }).join("");
      el("lgGroup").value = d.group || "none";
    }
  }

  /* Everything the screen is NOT showing, with its exact count. A hidden row on
     a money screen is a wrong number. */
  function scope(d) {
    var x = d.excluded, bits = [];
    bits.push("<b>" + d.totals.count + "</b> record" + (d.totals.count === 1 ? "" : "s") +
      " · <b>" + money(d.totals.cost) + "</b>" +
      (d.span ? " · " + day(d.span.from) + " – " + day(d.span.to) : ""));
    var hid = [];
    if (x.outsidePeriod) hid.push(x.outsidePeriod + " outside this period");
    if (x.noCost) hid.push(x.noCost + " with no cost recorded");
    if (hid.length) bits.push("Not shown: " + hid.join(", ") + ".");
    if (x.undated) {
      bits.push('<span class="warn">' + x.undated + " record" + (x.undated === 1 ? " has" : "s have") +
        " no date, so no period can include " + (x.undated === 1 ? "it" : "them") +
        " — use All records.</span>");
    }
    if (d.q && d.totals.count === 0 && d.matchesAllTime) {
      bits.push('<span class="warn">Nothing here for “' + esc(d.q) + '”, but ' + d.matchesAllTime +
        " in all records — <a href=\"#\" id=\"lgAll\">search all dates</a>.</span>");
    }
    el("lgScope").innerHTML = bits.join("<br>");
    var a = el("lgAll");
    if (a) a.onclick = function (e) { e.preventDefault(); load({ period: "all" }); };
  }

  /* Recounted on the client once the index lands.

     The server counts receipts before any folder has been read, so every named
     receipt is "named" and none is "missing" — correct at that moment and a
     false all-clear a second later. The tile said "119 on file" while the table
     underneath it showed 33 of them missing. Whatever the rows show, the tile
     shows. */
  function receiptCounts(d) {
    if (!state.receipts) {
      return { checked: false, onFile: 0, missing: 0,
               named: d.rows.filter(function (r) { return r.expenseReceiptFileName; }).length };
    }
    var on = 0, miss = 0;
    d.rows.forEach(function (r) {
      if (!r.expenseReceiptFileName) return;
      if (state.receipts[String(r.expenseReceiptFileName).toLowerCase()]) on++; else miss++;
    });
    return { checked: true, onFile: on, missing: miss, named: on + miss };
  }

  function totals(d) {
    var t = d.totals;
    var rc = receiptCounts(d);
    var cards = [
      ["Cost this period", money(t.cost), t.count + " records", ""],
      ["Materials", money(t.materials), "", ""],
      ["Labour", money(t.labor), "", ""],
      ["Subcontractors", money(t.contractors), "", ""],
      /* Shown because she will look for it, dashed and grey because adding it to
         a spend figure is the classic way this data gets misread. */
      ["Billed out", money(t.invoicedOut), "revenue, not a cost", "muted"],
      ["Receipts",
        rc.checked ? rc.onFile + " on file" : rc.named + " named",
        rc.checked
          ? (rc.missing ? rc.missing + " named but NOT found" : "all " + rc.named + " found")
          : "not checked yet",
        rc.checked && rc.missing ? "warn" : (rc.checked ? "" : "muted")],
      ["Paid-with tagged", t.tagged + " of " + t.count,
        t.tagged === 0 ? "nothing tagged yet" : "", t.tagged === 0 ? "muted" : ""],
      ["Reconciled", t.reconciled + " of " + t.count, "", ""],
    ];
    el("lgTotals").innerHTML = cards.map(function (c) {
      return '<div class="lg-t' + (c[3] ? " " + c[3] : "") + '"><div class="k">' + esc(c[0]) +
        '</div><div class="v">' + esc(c[1]) + "</div>" +
        (c[2] ? '<div class="n">' + esc(c[2]) + "</div>" : "") + "</div>";
    }).join("");
  }

  // ── receipts ────────────────────────────────────────────────────────────
  function receiptCell(r) {
    var name = r.expenseReceiptFileName || "";
    if (!name) return '<span class="lg-r none" title="No receipt was ever attached">–</span>';
    if (!state.receipts) {
      return '<span class="lg-r named" title="' + esc(name) + '\nNot checked yet">&#128206;</span>';
    }
    var id = state.receipts[name.toLowerCase()];
    if (id) {
      return '<a class="lg-r on" href="#" data-file="' + esc(id) + '" title="' + esc(name) + '">&#128206;</a>';
    }
    /* Named but not found is NOT the same as no receipt: one means nobody
       attached paperwork, the other means it was attached and cannot be found. */
    return '<span class="lg-r missing" title="' + esc(name) +
      '\nThis receipt is named on the record but was not found in the job folder">&#9888;</span>';
  }

  async function loadReceipts(rows) {
    var ids = [];
    rows.forEach(function (r) {
      var p = String(r.projectID || "").trim();
      if (p && r.expenseReceiptFileName && ids.indexOf(p) === -1) ids.push(p);
    });
    if (!ids.length) return;
    try {
      var got = await DCR.api("/api/portal?action=ledger&receipts=" + encodeURIComponent(ids.join(",")));
      state.receipts = got.index || {};
      state.receiptNote = got.note || "";
    } catch (e) {
      state.receipts = null;
      state.receiptNote = "Could not check the job folders, so receipts are unverified.";
    }
    render();
  }

  // ── the table ───────────────────────────────────────────────────────────
  function row(r, can) {
    /* An inference that can never become a fact is just a permanent asterisk.
       Confirm writes the real LaborExpenseEmployeeName, so the guess drains
       into the recorded column one row at a time and the dotted labels
       disappear as she works. */
    var who = r.employeeName
      ? esc(r.employeeName) + ' <span class="lg-tag ' + (r.employeeSource === "recorded" ? "rec" : "inf") +
        '">' + (r.employeeSource === "recorded" ? "recorded" : "inferred") + "</span>" +
        (r.employeeSource === "inferred" && can.tag
          ? ' <a href="#" class="lg-conf" data-confirm="' + esc(r.id) + '" data-name="' +
            esc(r.employeeName) + '" title="Record this properly against ' + esc(r.employeeName) +
            '">confirm</a>'
          : "")
      : "";
    var desc = r.description || r.laborExpenseDescription || r.materialExpenseDescription || r.remarks || "";
    return '<tr' + (r.cost ? "" : ' class="zero"') + '>' +
      (can.tag
        ? '<td style="text-align:center"><input type="checkbox" data-pick="' + esc(r.id) + '"' +
          (state.picked[r.id] ? " checked" : "") + "></td>"
        : "") +
      '<td class="dt">' + esc(day(r.expenseDate) || "no date") + "</td>" +
      '<td class="proj">' + esc(r.projectLabel || r.projectID || "") + "</td>" +
      '<td class="desc">' + esc(desc) + "</td>" +
      '<td class="num">' + (Number(r.materials) ? money(r.materials) : "") + "</td>" +
      '<td class="num">' + (Number(r.contractors) ? money(r.contractors) : "") + "</td>" +
      '<td class="num">' + (Number(r.laborExpense) ? money(r.laborExpense) : "") + "</td>" +
      '<td class="num cost">' + (r.cost ? money(r.cost) : "—") + "</td>" +
      '<td class="num out">' + (Number(r.invoice) ? money(r.invoice) : "") + "</td>" +
      "<td>" + (can.tag ? cardSelect(r) : esc(cardName(r))) + "</td>" +
      "<td>" + who + "</td>" +
      '<td style="text-align:center">' + receiptCell(r) + "</td>" +
      '<td style="text-align:center">' +
        (can.tag
          ? '<input type="checkbox" data-rec="' + esc(r.id) + '"' + (r.reconciledDate ? " checked" : "") +
            ' title="' + (r.reconciledDate ? esc("Reconciled " + day(r.reconciledDate) + " by " + (r.reconciledBy || "")) : "Mark reconciled") + '">'
          : (r.reconciledDate ? "&#10003;" : "")) +
      "</td></tr>";
  }

  function cardName(r) {
    var c = (state.d.cards || []).filter(function (x) { return x.id === (r.cardId || "untagged"); })[0];
    return c ? c.label : (r.cardId || "Not tagged yet");
  }
  function cardSelect(r) {
    var cur = r.cardId || "untagged";
    return '<select class="lg-card' + (cur === "untagged" ? " untagged" : "") + '" data-card="' + esc(r.id) + '">' +
      (state.d.cards || []).map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (c.id === cur ? " selected" : "") + ">" +
          esc(c.label) + "</option>";
      }).join("") + "</select>";
  }

  var HEAD = ["Date", "Project", "Description", "Materials", "Subs", "Labour", "Cost",
              "Billed out", "Paid with", "Employee", "Receipt", "Rec."];
  var NUMS = { 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 };

  function head0(can) {
    return "<thead><tr>" + (can.tag ? '<th style="width:26px"></th>' : "") +
      HEAD.map(function (h, i) {
        return "<th" + (NUMS[i] ? ' class="num"' : "") + ">" + esc(h) + "</th>";
      }).join("") + "</tr></thead>";
  }
  function span(can) { return HEAD.length + (can.tag ? 1 : 0); }

  function render() {
    var d = state.d, can = d.can || {};
    chips(d);
    scope(d);
    totals(d);

    var head = head0(can);

    var body = "";
    if (!d.rows.length) {
      el("lgBody").innerHTML = '<div class="lg-none">' +
        (d.q ? "Nothing matches that in this period." : "No expenses recorded in this period.") +
        "</div>";
    } else if (d.groups) {
      body = d.groups.map(function (g) {
        return '<tr class="lg-grp' + (g.pinned ? " pin" : "") + '"><td colspan="' + span(can) + '">' +
          '<span class="lbl">' + esc(g.label) + "</span>" +
          '<span class="sub">' + money(g.cost) + " · " + g.count + " record" + (g.count === 1 ? "" : "s") +
          (g.withReceipt ? " · " + g.withReceipt + " with a receipt" : "") +
          (g.reconciled ? " · " + g.reconciled + " reconciled" : "") +
          (g.source === "inferred" ? " · inferred from the description" : "") +
          "</span></td></tr>" +
          g.rows.map(function (r) { return row(r, can); }).join("");
      }).join("");
      el("lgBody").innerHTML = '<table class="lg-t2">' + head + "<tbody>" + body + "</tbody></table>";
    } else {
      body = d.rows.map(function (r) { return row(r, can); }).join("");
      el("lgBody").innerHTML = '<table class="lg-t2">' + head + "<tbody>" + body + "</tbody></table>";
    }

    // hours, beside the money and never mixed into it
    var h = d.hours || { rows: [] };
    el("lgHours").innerHTML = h.rows.length
      ? h.rows.map(function (x) {
          return '<div class="lg-hrow"><span>' + esc(x.name) + "</span><b>" + x.hours + " h</b></div>";
        }).join("") +
        '<div class="lg-hrow" style="border:0"><span><b>Total</b></span><b>' +
        h.rows.reduce(function (n, x) { return n + x.hours; }, 0).toFixed(2) + " h</b></div>"
      : '<div class="lg-cant">No timesheet hours in this period.</div>';

    /* Said once, plainly, rather than leaving her to discover each absence by
       looking for it and finding nothing. */
    var cant = [
      "Employee spend. Nobody's purchases are recorded against them — the names on labour rows are read from the description, which is why they say <b>inferred</b>.",
      "Labour cost from hours. There is no pay rate stored anywhere in the database, so hours stay hours.",
      "Card spend, until purchases are tagged. Set “Paid with” on a row and this screen starts answering it.",
      "Sales tax, mileage and depreciation — none of it is recorded in this database.",
      "Anything from QuickBooks. Nothing here talks to Intuit; the Books tab is where the handover lives.",
    ];
    if (state.receiptNote) cant.unshift('<span style="color:var(--gold)">' + esc(state.receiptNote) + "</span>");
    el("lgCant").innerHTML = cant.map(function (c) { return "<li>" + c + "</li>"; }).join("");

    el("lgSpan").textContent = d.span ? day(d.span.from) + " – " + day(d.span.to) : "no dated records";
    bulk();
    wire();
  }

  /* Tagging 177 rows one at a time is how a dimension stays empty forever, so
     the card tag is also a bulk action. The server already accepts up to 200
     ids in one call; this is the only reason it does. */
  function bulk() {
    var n = Object.keys(state.picked).length;
    var bar = el("lgBulk");
    if (!bar) return;
    bar.hidden = n === 0;
    if (!n) return;
    var cost = (state.d.rows || []).filter(function (r) { return state.picked[r.id]; })
      .reduce(function (t, r) { return t + (Number(r.cost) || 0); }, 0);
    el("lgBulkN").textContent = n + " row" + (n === 1 ? "" : "s") + " selected · " + money(cost);
    if (!el("lgBulkCard").options.length) {
      el("lgBulkCard").innerHTML = '<option value="">Set “Paid with”…</option>' +
        (state.d.cards || []).map(function (c) {
          return '<option value="' + esc(c.id) + '">' + esc(c.label) + "</option>";
        }).join("");
    }
  }

  // ── actions ─────────────────────────────────────────────────────────────
  function wire() {
    document.querySelectorAll("[data-period]").forEach(function (b) {
      b.onclick = function () { load({ period: b.getAttribute("data-period") }); };
    });
    document.querySelectorAll("[data-card]").forEach(function (s) {
      s.onchange = function () { write({ op: "card", ids: [s.getAttribute("data-card")], cardId: s.value }); };
    });
    document.querySelectorAll("[data-rec]").forEach(function (c) {
      c.onchange = function () {
        write({ op: c.checked ? "reconcile" : "unreconcile", ids: [c.getAttribute("data-rec")] });
      };
    });
    document.querySelectorAll("[data-file]").forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); openFile(a.getAttribute("data-file")); };
    });
    document.querySelectorAll("[data-pick]").forEach(function (c) {
      c.onchange = function () {
        var id = c.getAttribute("data-pick");
        if (c.checked) state.picked[id] = true; else delete state.picked[id];
        bulk();
      };
    });
    document.querySelectorAll("[data-confirm]").forEach(function (a) {
      a.onclick = async function (e) {
        e.preventDefault();
        var name = a.getAttribute("data-name");
        if (!(await DCR.confirm("Record this row against " + name +
            "? It stops being a guess and becomes the stored employee.",
            { okText: "Record it" }))) return;
        write({ op: "employee", ids: [a.getAttribute("data-confirm")], employeeName: name });
      };
    });
  }

  /* Resolved on click, never up front: a pre-authed download URL is a
     credential that expires in about an hour, and 124 of them held in a page is
     124 credentials. */
  async function openFile(id) {
    try {
      var info = await DCR.api("/api/portal?action=drive&fileInfo=" + encodeURIComponent(id));
      if (info && info.downloadUrl) window.open(info.downloadUrl, "_blank", "noopener");
      else if (info && info.webViewLink) window.open(info.webViewLink, "_blank", "noopener");
      else DCR.alert("That file could not be opened.");
    } catch (e) { DCR.alert(e.message || "That file could not be opened."); }
  }

  async function write(body) {
    if (state.busy) return;
    state.busy = true;
    try {
      var r = await DCR.api("/api/portal?action=ledger", { method: "POST", body: body });
      state.picked = {};
      await load({});
      if (r && r.refused && r.refused.length) {
        DCR.alert(r.refused.length + " row" + (r.refused.length === 1 ? "" : "s") +
          " could not be changed: " + r.refused.map(function (x) { return x.reason; })[0]);
      }
    } catch (e) {
      DCR.alert(e.message || "Could not save that.");
      await load({});
    }
    state.busy = false;
  }

  async function load(over) {
    var p = q();
    Object.keys(over || {}).forEach(function (k) { p[k] = over[k]; });
    var qs = Object.keys(p).filter(function (k) { return p[k]; })
      .map(function (k) { return k + "=" + encodeURIComponent(p[k]); }).join("&");
    try {
      state.d = await DCR.api("/api/portal?action=ledger" + (qs ? "&" + qs : ""));
      render();
      /* Second request, once the money is on screen. A slow or throttled Graph
         must cost the paperclip column, not the numbers. */
      if (!state.receipts) loadReceipts(state.d.rows);
    } catch (e) {
      el("lgBody").innerHTML = '<div class="lg-none" style="color:var(--err)">' +
        esc(e.message || "Could not open the expense ledger.") + "</div>";
      el("lgTotals").innerHTML = "";
    }
  }

  var timer = null;
  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };

    /* Selection is cleared on every reload, so a tag can never land on rows she
       scrolled away from two filters ago. */
    el("lgBulkClear").onclick = function () { state.picked = {}; render(); };
    el("lgBulkApply").onclick = function () {
      var card = el("lgBulkCard").value;
      var ids = Object.keys(state.picked);
      if (!card || !ids.length) return;
      write({ op: "card", ids: ids, cardId: card });
    };
    el("lgBulkRec").onclick = function () {
      var ids = Object.keys(state.picked);
      if (ids.length) write({ op: "reconcile", ids: ids });
    };

    el("lgGroup").onchange = function () { load({}); };
    el("lgZero").onchange = function () { load({}); };
    el("lgQ").oninput = function () {
      clearTimeout(timer);
      timer = setTimeout(function () { load({}); }, 280);
    };
    el("lgCsv").onclick = async function (e) {
      e.preventDefault();
      var p = q(); p.csv = "1";
      var qs = Object.keys(p).filter(function (k) { return p[k]; })
        .map(function (k) { return k + "=" + encodeURIComponent(p[k]); }).join("&");
      try {
        /* The endpoint needs the bearer token, so this cannot be a plain link. */
        var res = await fetch(DCR.API_BASE + "/api/portal?action=ledger&" + qs, {
          headers: { Authorization: "Bearer " + DCR.getToken() },
        });
        if (!res.ok) throw new Error("Export failed (" + res.status + ")");
        var txt = await res.text();
        if (txt.charAt(0) === "{") { try { txt = JSON.parse(txt).csv || txt; } catch (x) {} }
        var url = URL.createObjectURL(new Blob([txt], { type: "text/csv;charset=utf-8" }));
        var a = document.createElement("a");
        a.href = url;
        a.download = "dcr-expenses-" + new Date().toISOString().slice(0, 10) + ".csv";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      } catch (err) { DCR.alert(err.message || "Could not export that."); }
    };

    await load({});
  });
})();
