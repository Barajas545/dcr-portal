/* The accountant's home screen.

   The books live in QuickBooks Online. This screen's only job is to make the
   handover reliable: what is ready to enter, what is already in, and what is
   stuck and on whom — so nothing is entered twice and nothing is missed.

   Every decision is the server's. This selects rows and shows what came back. */
(function () {
  "use strict";
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var state = { d: null, picked: {} };

  function money(v) {
    return "$" + (Number(v) || 0).toLocaleString("en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function day(v) {
    var s = String(v || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
    var d = new Date(s + "T12:00:00Z");
    return isNaN(d) ? s : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  function lateText(n) {
    if (n === null || n === undefined || n <= 0) return "";
    return n === 1 ? "1 day late" : n + " days late";
  }

  function cards(t) {
    var c = [
      ["Ready to enter", money(t.readyAmount),
        t.readyCount + (t.readyCount === 1 ? " bill" : " bills"), t.readyCount ? "go" : ""],
      ["Overdue among them", money(t.overdueAmount),
        t.overdueCount + " past due", t.overdueCount ? "late" : ""],
      ["Waiting on approval", money(t.waitingAmount),
        t.waitingCount + " not yours to action", t.waitingCount ? "wait" : ""],
      ["Money in to enter", money(t.arReadyAmount),
        t.arReadyCount + (t.arReadyCount === 1 ? " invoice" : " invoices"), ""],
    ];
    el("acCards").innerHTML = c.map(function (x) {
      return '<div class="ac-card' + (x[3] ? " " + x[3] : "") + '">' +
        '<div class="k">' + esc(x[0]) + "</div>" +
        '<div class="v">' + esc(x[1]) + "</div>" +
        '<div class="n">' + esc(x[2]) + "</div></div>";
    }).join("");
  }

  function billRow(b, opts) {
    opts = opts || {};
    var late = lateText(b.lateBy);
    return "<tr>" +
      (opts.pick
        ? '<td><input type="checkbox" data-pick="' + esc(b.id) + '"' +
          (state.picked[b.id] ? " checked" : "") + "></td>"
        : "") +
      "<td>" +
        '<span class="who">' + esc(b.expenseVendorCompany || b.expenseVendorName || "(no vendor)") + "</span>" +
        (b.expenseInvoiceNumber ? ' <span class="meta">#' + esc(b.expenseInvoiceNumber) + "</span>" : "") +
        '<div class="meta">' + esc(b.projectLabel || "(no job)") +
          (b.expenseDueDate ? " · due " + esc(day(b.expenseDueDate)) : "") + "</div>" +
        (late ? '<span class="late">' + esc(late) + "</span>" : "") +
        (opts.reason && b.reason ? '<div class="reason">' + esc(b.reason) + "</div>" : "") +
        (opts.entered
          ? '<div class="meta">entered ' + esc(day(b.qboEnteredDate)) +
            (b.qboEnteredBy ? " by " + esc(b.qboEnteredBy) : "") +
            (b.qboRef ? " · " + esc(b.qboRef) : "") + "</div>"
          : "") +
      "</td>" +
      '<td class="num">' + money(b.expenseAmount) + "</td>" +
      '<td class="num"><a href="bill.html?id=' + encodeURIComponent(b.id) +
        "&project=" + encodeURIComponent(b.projectID) + '">Open &rarr;</a></td>' +
      (opts.entered
        ? '<td class="num"><a href="#" data-undo="' + esc(b.id) + '">Undo</a></td>'
        : "") +
      "</tr>";
  }

  function table(rows, head, render) {
    return '<table class="ac-t"><thead><tr>' +
      head.map(function (h) {
        return '<th' + (h[1] ? ' class="num"' : "") + ">" + esc(h[0]) + "</th>";
      }).join("") + "</tr></thead><tbody>" +
      rows.map(render).join("") + "</tbody></table>";
  }

  function render() {
    var d = state.d, can = d.can || {};
    cards(d.totals);
    var h = "";

    // ── ready to enter ───────────────────────────────────────────────────
    h += '<div class="ac-sec"><header><h3>Ready to enter in QuickBooks</h3>' +
      '<span class="hint">Approved, with the paperwork behind it.</span>' +
      '<span class="grow"></span>' +
      '<a class="ac-b" id="acCsv">&#8615; Export CSV</a></header>';
    if (!d.ready.length) {
      h += '<div class="ac-none">Nothing waiting to be entered. The books are up to date.</div>';
    } else {
      h += table(d.ready, [["", 0], ["Bill", 0], ["Amount", 1], ["", 1]],
        function (b) { return billRow(b, { pick: true }); });
      if (can.mark) {
        h += '<header style="margin-top:12px">' +
          '<button class="ac-b" id="acAll">Select all</button>' +
          '<input class="ac-ref" id="acRef" placeholder="QuickBooks ref (optional)">' +
          '<button class="ac-b go" id="acMark" disabled>&#10003; Mark entered</button>' +
          '<span class="hint" id="acCount"></span></header>';
      }
      h += '<div class="ac-note"><b>Before you import:</b> QuickBooks Online only imports ' +
        "bills from a spreadsheet on Advanced (Spreadsheet Sync) or through a third-party " +
        "importer — Essentials and Plus have no native bill import, so on those plans this " +
        "file is for keying from, not uploading. Either way, vendor names must already match " +
        "QuickBooks exactly or the import creates duplicates. " +
        "The <b>Portal Bill ID</b> column is how you match a row back here afterwards.</div>";
      h += '<div class="ac-msg" id="acMsg"></div>';
    }
    h += "</div>";

    // ── money in ─────────────────────────────────────────────────────────
    h += '<div class="ac-sec"><header><h3>Money in — invoices we sent</h3>' +
      '<span class="hint">Sent to the client and not yet in the books.</span>' +
      '<span class="grow"></span>' +
      '<a class="ac-b" id="acCsvInv">&#8615; Export CSV</a></header>';
    h += d.ar.ready.length
      ? table(d.ar.ready, [["Invoice", 0], ["Amount", 1], ["Status", 1]], function (iv) {
          return "<tr><td><span class=\"who\">" +
            esc(iv.invoiceClientName || iv.invoiceNumber || "Invoice") + "</span>" +
            (iv.invoiceNumber ? ' <span class="meta">#' + esc(iv.invoiceNumber) + "</span>" : "") +
            '<div class="meta">' + esc(iv.projectLabel || "") +
              (iv.invoiceSentDate ? " · sent " + esc(day(iv.invoiceSentDate)) : "") + "</div></td>" +
            '<td class="num">' + money(iv.invoiceAmount) + "</td>" +
            '<td class="num">' + (iv.invoicePaid ? "Paid" : "Unpaid") + "</td></tr>";
        })
      : '<div class="ac-none">Nothing to enter on the money-in side.</div>';
    h += '<div class="ac-note">QuickBooks Online does import invoices from CSV natively ' +
      "(Settings &rarr; Import data &rarr; Invoices). Customers must exist there first.</div></div>";

    // ── not yours to action ──────────────────────────────────────────────
    if (d.waiting.length || d.blocked.length) {
      h += '<div class="ac-sec"><header><h3>Not ready — and who it is on</h3>' +
        '<span class="hint">Nothing here is yours to action; it is here so you are not ' +
        "waiting on it blind.</span></header>";
      var stuck = d.waiting.map(function (b) { return { ...b, reason: "Waiting for a manager or admin to approve it." }; })
        .concat(d.blocked);
      h += table(stuck, [["Bill", 0], ["Amount", 1], ["", 1]],
        function (b) { return billRow(b, { reason: true }); });
      h += "</div>";
    }

    // ── already entered ──────────────────────────────────────────────────
    h += '<div class="ac-sec"><header><h3>Already entered</h3>' +
      '<span class="hint">' + d.entered.length + " on the books. Undo if you marked one by " +
      "mistake.</span></header>";
    h += d.entered.length
      ? table(d.entered.slice(0, 40), [["Bill", 0], ["Amount", 1], ["", 1], ["", 1]],
          function (b) { return billRow(b, { entered: true }); })
      : '<div class="ac-none">Nothing marked as entered yet.</div>';
    h += "</div>";

    el("acBody").innerHTML = h;
    wire();
  }

  function wire() {
    var box = el("acBody");
    box.querySelectorAll("[data-pick]").forEach(function (cb) {
      cb.onchange = function () {
        var id = cb.getAttribute("data-pick");
        if (cb.checked) state.picked[id] = true; else delete state.picked[id];
        syncPick();
      };
    });
    var all = el("acAll");
    if (all) all.onclick = function () {
      var want = Object.keys(state.picked).length < state.d.ready.length;
      state.picked = {};
      if (want) state.d.ready.forEach(function (b) { state.picked[b.id] = true; });
      box.querySelectorAll("[data-pick]").forEach(function (cb) {
        cb.checked = !!state.picked[cb.getAttribute("data-pick")];
      });
      syncPick();
    };
    var mark = el("acMark");
    if (mark) mark.onclick = doMark;
    box.querySelectorAll("[data-undo]").forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); doUnmark(a.getAttribute("data-undo")); };
    });
    var csv = el("acCsv");
    if (csv) csv.onclick = function (e) { e.preventDefault(); download("bills"); };
    var csvI = el("acCsvInv");
    if (csvI) csvI.onclick = function (e) { e.preventDefault(); download("invoices"); };
    syncPick();
  }

  function syncPick() {
    var n = Object.keys(state.picked).length;
    var mark = el("acMark"), count = el("acCount");
    if (mark) mark.disabled = n === 0;
    if (count) {
      var amt = state.d.ready
        .filter(function (b) { return state.picked[b.id]; })
        .reduce(function (t, b) { return t + (Number(b.expenseAmount) || 0); }, 0);
      count.textContent = n ? n + " selected · " + money(amt) : "";
    }
  }

  /* The export goes through the API with the bearer token, so it cannot be a
     plain link — the file is fetched and handed to the browser as a blob. */
  async function download(which) {
    try {
      var r = await fetch(DCR.API_BASE + "/api/portal?action=accounting&csv=" + which, {
        headers: { Authorization: "Bearer " + DCR.getToken() },
      });
      if (!r.ok) throw new Error("Could not build that export.");
      var text = await r.text();
      // The handler answers JSON when it cannot stream; unwrap either shape.
      if (text.charAt(0) === "{") {
        try { text = JSON.parse(text).csv || text; } catch (e) { /* it was CSV after all */ }
      }
      var url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
      var a = document.createElement("a");
      a.href = url;
      a.download = "dcr-" + which + "-" + state.d.today + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (e) { DCR.alert(e.message || "Could not export that."); }
  }

  async function doMark() {
    var ids = Object.keys(state.picked);
    if (!ids.length) return;
    var amt = state.d.ready.filter(function (b) { return state.picked[b.id]; })
      .reduce(function (t, b) { return t + (Number(b.expenseAmount) || 0); }, 0);
    var sure = await DCR.confirm(
      "Mark " + ids.length + (ids.length === 1 ? " bill" : " bills") + " (" + money(amt) +
      ") as entered in QuickBooks? This records that you have keyed them — it does not " +
      "send anything to Intuit.", { title: "Mark entered", okText: "Mark entered" });
    if (!sure) return;

    var mark = el("acMark"), msg = el("acMsg");
    mark.disabled = true;
    msg.textContent = "Recording…"; msg.className = "ac-msg";
    try {
      var r = await DCR.api("/api/portal?action=accounting", { method: "POST",
        body: { op: "mark", ids: ids, ref: (el("acRef") || {}).value || "" } });
      state.picked = {};
      await load();
      /* A partial result is reported in full. Silently marking eight of ten is
         how two of them get entered twice. */
      if (r.refused && r.refused.length) {
        DCR.alert(r.refused.map(function (x) { return "Bill " + x.id + ": " + x.reason; }).join("\n"),
          { title: (r.marked || []).length + " marked, " + r.refused.length + " not" });
      }
    } catch (e) {
      msg.textContent = e.message || "Could not record that."; msg.className = "ac-msg err";
      mark.disabled = false;
    }
  }

  async function doUnmark(id) {
    var sure = await DCR.confirm("Put this bill back on the ready list?",
      { title: "Undo", okText: "Undo" });
    if (!sure) return;
    try {
      await DCR.api("/api/portal?action=accounting", { method: "POST",
        body: { op: "unmark", ids: [id] } });
      await load();
    } catch (e) { DCR.alert(e.message || "Could not undo that."); }
  }

  async function load() {
    try {
      state.d = await DCR.api("/api/portal?action=accounting");
      render();
    } catch (e) {
      el("acBody").innerHTML = '<div class="ac-sec" style="color:var(--err)">' +
        esc(e.message || "Could not open the books.") + "</div>";
      el("acCards").innerHTML = "";
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };
    var name = (profile.displayName || profile.email || "").split(" ")[0].split("@")[0];
    el("acGreeting").textContent = name ? "— " + name : "";
    load();
  });
})();
