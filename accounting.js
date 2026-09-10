/* The accountant's home screen.

   The books live in QuickBooks Online. This screen's only job is to make the
   handover reliable: what is ready to enter, what is already in, and what is
   stuck and on whom — so nothing is entered twice and nothing is missed.

   Every decision is the server's. This selects rows and shows what came back. */
(function () {
  "use strict";
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var state = { d: null, picked: {}, openCheck: null, detail: null, tell: {} };

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

  /* ── checks ──────────────────────────────────────────────────────────────

     Above QuickBooks on purpose. Both sections are about somebody waiting on
     money; entering a bill in the books is about a keystroke. */
  function checksToWrite(c, can) {
    var h = '<div class="ac-sec"><header><h3>Checks to write</h3>' +
      '<span class="hint">Approved for payment. Write the check, then tell them it is ready ' +
      'to collect.</span><span class="grow"></span>' +
      '<span class="hint">' + (c.totals.toWriteCount || 0) + " waiting · " +
        money(c.totals.toWriteAmount) + "</span></header>";

    if (!c.toWrite.length) {
      h += '<div class="ac-none">Nothing to pay. Every approved bill has a check against it.</div></div>';
      return h;
    }
    if (!can.pay) {
      h += '<div class="ac-note">These are approved and waiting for a check, but your account ' +
        "cannot record payments. Ask an admin for the payments permission.</div>";
    }
    h += '<table class="ac-t"><thead><tr><th>Pay to</th><th class="num">Amount</th>' +
      '<th class="num"></th></tr></thead><tbody>';
    c.toWrite.forEach(function (b) {
      var open = String(state.openCheck) === String(b.id);
      h += '<tr class="ck-row" data-open="' + esc(b.id) + '">' +
        '<td><div class="ck-payee">' + esc(b.payee || "(no payee on file)") + "</div>" +
        '<div class="ck-for">' + esc(b.memo || b.projectLabel || "") +
          (b.partial ? '<span class="ck-part">part paid</span>' : "") + "</div></td>" +
        '<td class="num"><b>' + money(b.owed) + "</b>" +
          (b.partial ? '<div class="ck-for">of ' + money(b.approvedFor) + "</div>" : "") + "</td>" +
        '<td class="num">' + (open ? "Close" : "Write check &rarr;") + "</td></tr>";
      if (open) h += '<tr><td colspan="3">' + checkPanel(b, can) + "</td></tr>";
    });
    h += "</tbody></table></div>";
    return h;
  }

  /* The panel: what to write on the check, and everything it is written against. */
  function checkPanel(b, can) {
    var d = state.detail;
    if (!d || String(d.bill.id) !== String(b.id)) {
      return '<div class="ck-panel"><div class="ac-none">Loading the paperwork…</div></div>';
    }
    var c = d.check;
    var h = '<div class="ck-panel">';
    if (!c.canWrite) return h + '<div class="ac-note">' + esc(c.reason) + "</div></div>";

    h += '<div class="ck-grid">' +
      '<div class="ck-f"><label>Make the check out to</label>' +
        '<input id="ckPayee" class="big" value="' + esc(c.payee) + '" maxlength="120">' +
        (c.payeeNote
          ? '<div class="sub warn">' + esc(c.payeeNote) + "</div>"
          : (c.payeePerson && c.payeePerson !== c.payee
              ? '<div class="sub">Their invoice was sent by ' + esc(c.payeePerson) + ".</div>"
              : "")) +
      "</div>" +
      '<div class="ck-f"><label>Amount</label>' +
        '<input id="ckAmount" class="big" inputmode="decimal" value="' + esc(c.max.toFixed(2)) + '">' +
        '<div class="sub">' + (c.alreadyPaid > 0
          ? money(c.alreadyPaid) + " already paid of " + money(c.approvedFor) + " approved."
          : "Approved for " + money(c.approvedFor) + ".") + "</div>" +
      "</div>" +
      '<div class="ck-f"><label>Check number</label>' +
        '<input id="ckNumber" placeholder="e.g. 2041" maxlength="40">' +
        '<div class="sub">So it can be found again.</div>' +
      "</div></div>" +
      '<div class="ck-f" style="margin-bottom:14px"><label>Memo — what the payment is for</label>' +
        '<input id="ckMemo" value="' + esc(c.memo) + '" maxlength="' + esc(c.memoMax) + '"></div>';

    h += '<div class="ck-docs"><h4>What you are paying against</h4>';
    if (d.commitment) {
      h += '<div class="ck-commit' + (d.commitment.sure ? "" : " guess") + '">' +
        "<b>" + esc(d.commitment.kind) + "</b> — " + esc(d.commitment.vendor) +
        (d.commitment.amount ? " · " + money(d.commitment.amount) : "") +
        (d.commitment.status ? " · " + esc(d.commitment.status) : "") +
        '<div class="ck-for">' + esc(d.commitment.note) + "</div></div>";
    }
    if (d.submission) {
      h += '<div class="ck-doc"><span class="nm">Signed submission ' +
        esc(d.submission.reference) + '</span><span class="tag">signed by ' +
        esc(d.submission.signedBy || d.submission.contactName) + "</span></div>";
    }
    (d.documents.files || []).forEach(function (f) {
      var tag = f.label || (f.match === "loose" ? "found by name — may be another bill's" : "");
      h += '<div class="ck-doc"><span class="nm">' + esc(f.name) + "</span>" +
        (tag ? '<span class="tag' + (f.match === "loose" ? " guess" : "") + '">' + esc(tag) + "</span>" : "") +
        "</div>";
    });
    (d.documents.links || []).forEach(function (l) {
      h += '<div class="ck-doc"><a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' +
        esc(l.label) + '</a><span class="tag">' + esc(l.why) + "</span></div>";
    });
    if (!(d.documents.files || []).length) {
      h += '<div class="ck-none-note">No files are attached to this bill.</div>';
    }
    (d.documents.notes || []).forEach(function (n) {
      h += '<div class="ck-none-note">' + esc(n) + "</div>";
    });
    h += '<div style="margin-top:10px"><a class="ac-b" href="bill.html?id=' +
      encodeURIComponent(d.bill.id) + "&project=" + encodeURIComponent(d.bill.projectID) +
      '">Open the paperwork &rarr;</a></div></div>';

    if (d.written && d.written.length) {
      h += '<div class="ck-docs"><h4>Checks already written</h4>';
      d.written.forEach(function (w) {
        h += '<div class="ck-doc"><span class="nm">#' + esc(w.checkNumber) + " · " +
          money(w.amount) + '</span><span class="tag">' + esc(day(w.writtenDate)) +
          (w.toldDate ? " · told " + esc(w.toldHow) + " " + esc(day(w.toldDate)) : " · not told yet") +
          "</span></div>";
      });
      h += "</div>";
    }

    h += '<div class="ck-acts">' +
      (can.pay ? '<button class="btn-accept" id="ckWrite">&#10003; Record the check</button>' : "") +
      '<button class="ac-b" id="ckClose">Close</button>' +
      '<span class="ac-msg" id="ckMsg"></span></div>';
    return h + "</div>";
  }

  /* ── telling them it is ready ─────────────────────────────────────────── */
  function checksToTell(c, can) {
    var h = '<div class="ac-sec"><header><h3>Written — tell them it is ready</h3>' +
      '<span class="hint">The check exists. Nobody has told the subcontractor to come and ' +
      "collect it.</span></header>";
    if (!c.toTell.length) {
      return h + '<div class="ac-none">Everyone with a check waiting has been told.</div></div>';
    }
    c.toTell.forEach(function (t) {
      var k = state.tell[t.paymentId] || {};
      h += '<div class="ck-tell">' +
        '<div class="top"><div><span class="ck-payee">' + esc(t.payee || "(no payee)") + "</span>" +
          '<div class="ck-for">Check #' + esc(t.checkNumber) + " · written " +
          esc(day(t.writtenDate)) + "</div></div>" +
        '<div class="ck-payee">' + money(t.amount) + "</div></div>";

      if (!k.loaded) {
        h += '<div class="ck-acts"><button class="ac-b" data-load="' + esc(t.paymentId) +
          '" data-bill="' + esc(t.billId) + '">How do I reach them?</button></div></div>';
        return;
      }
      var w = k.contact || {};
      if (!w.email && !w.phone) {
        h += '<div class="ck-how none">No email or phone on file for them.</div>' +
          '<div class="ck-none-note">The check is written and waiting. Add a contact on the ' +
          "project, or tell them next time they call.</div>";
      } else {
        h += '<div class="ck-how ' +
          (w.source === "submission" ? "certain" : (w.needsConfirming ? "guess" : "")) + '">' +
          esc(w.why || "") + "</div>" +
          '<div class="ck-none-note">' +
            (w.email ? "Email: " + esc(w.email) : "") +
            (w.email && w.phone ? " · " : "") +
            (w.phone ? "Phone: " + esc(w.phone) : "") + "</div>";
      }
      h += '<div class="ck-msg-box">' + esc((k.message && k.message.body) || "") + "</div>" +
        '<div class="ck-acts">';
      if (w.email) {
        h += '<a class="btn-accept" data-mail="' + esc(t.paymentId) + '" href="#">Open the email</a>';
      }
      if (w.phone) {
        h += '<a class="ac-b" href="tel:' + esc(String(w.phone).replace(/[^0-9+]/g, "")) +
          '">Call ' + esc(w.phone) + "</a>";
      }
      h += '<button class="ac-b" data-copy="' + esc(t.paymentId) + '">Copy the message</button>';
      if (can.pay) {
        if (w.email) {
          h += '<button class="ac-b go" data-told="' + esc(t.paymentId) +
            '" data-how="email">&#10003; Told by email</button>';
        }
        if (w.phone) {
          h += '<button class="ac-b go" data-told="' + esc(t.paymentId) +
            '" data-how="phone">&#10003; Told by phone</button>';
        }
        h += '<button class="ac-b go" data-told="' + esc(t.paymentId) +
          '" data-how="in person">&#10003; Told in person</button>';
      }
      h += '<span class="ac-msg" id="tellMsg' + esc(t.paymentId) + '"></span></div>' +
        '<div class="ck-none-note" style="margin-top:6px">The portal cannot send email itself — ' +
        "this opens the message in your own email, already written. Press Send there, then mark " +
        "it here.</div></div>";
    });
    return h + "</div>";
  }

  function render() {
    var d = state.d, can = d.can || {};
    cards(d.totals);
    var h = "";

    if (d.checks) {
      h += checksToWrite(d.checks, can);
      h += checksToTell(d.checks, can);
    }

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
    wireChecks();
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


  /* ── check actions ────────────────────────────────────────────────────── */

  function wireChecks() {
    var box = el("acBody");

    box.querySelectorAll("[data-open]").forEach(function (tr) {
      tr.onclick = async function () {
        var id = tr.getAttribute("data-open");
        if (String(state.openCheck) === String(id)) {
          state.openCheck = null; state.detail = null; return render();
        }
        state.openCheck = id; state.detail = null; render();
        try {
          state.detail = await DCR.api("/api/portal?action=accounting&bill=" + encodeURIComponent(id));
        } catch (e) {
          state.openCheck = null;
          render();
          return DCR.alert(e.message || "Could not open that bill.");
        }
        render();
      };
    });

    var close = el("ckClose");
    if (close) close.onclick = function (e) {
      e.stopPropagation();
      state.openCheck = null; state.detail = null; render();
    };

    var write = el("ckWrite");
    if (write) write.onclick = function (e) { e.stopPropagation(); doWriteCheck(); };

    /* The panel lives inside the row, and the row toggles itself shut on click.
       Without this every keystroke in the amount box would close the panel. */
    box.querySelectorAll(".ck-panel").forEach(function (p) {
      p.onclick = function (e) { e.stopPropagation(); };
    });

    box.querySelectorAll("[data-load]").forEach(function (btn) {
      btn.onclick = async function () {
        var pid = btn.getAttribute("data-load");
        var bid = btn.getAttribute("data-bill");
        btn.disabled = true;
        btn.textContent = "Looking…";
        try {
          var d = await DCR.api("/api/portal?action=accounting&bill=" + encodeURIComponent(bid));
          /* THIS check's message, not the bill's. A bill can carry more than one
             check, and the amount on a pickup notice is a statement about the
             one piece of paper waiting in the drawer. */
          var mine = (d.written || []).filter(function (w) { return String(w.id) === String(pid); })[0];
          if (!mine) {
            btn.disabled = false;
            btn.textContent = "How do I reach them?";
            return DCR.alert("That check is no longer on this bill. Refresh the page.");
          }
          state.tell[pid] = { loaded: true, contact: d.contact, message: mine.message };
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "How do I reach them?";
          return DCR.alert(e.message || "Could not look them up.");
        }
        render();
      };
    });

    box.querySelectorAll("[data-mail]").forEach(function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        var k = state.tell[a.getAttribute("data-mail")] || {};
        if (!k.contact || !k.contact.email) return;
        /* A detached anchor rather than assigning location.href: on some
           browsers that assignment counts as a navigation and tears the page
           down, which would lose the "Told them" button before it is pressed. */
        var link = document.createElement("a");
        link.href = "mailto:" + encodeURIComponent(k.contact.email) +
          "?subject=" + encodeURIComponent(k.message.subject) +
          "&body=" + encodeURIComponent(k.message.body);
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
      };
    });

    box.querySelectorAll("[data-copy]").forEach(function (btn) {
      btn.onclick = async function () {
        var k = state.tell[btn.getAttribute("data-copy")] || {};
        try {
          await navigator.clipboard.writeText((k.message && k.message.body) || "");
          btn.textContent = "Copied";
          setTimeout(function () { btn.textContent = "Copy the message"; }, 1500);
        } catch (e) {
          /* The clipboard is refused outside a secure context. Saying so beats
             a button that silently does nothing. */
          DCR.alert("Could not copy it. Select the message above and copy it by hand.");
        }
      };
    });

    /* How they were told is recorded, not assumed — it is the difference between
       a record and a guess when somebody rings up next month asking where their
       check went. One button per way, so it stays one click. */
    box.querySelectorAll("[data-told]").forEach(function (btn) {
      btn.onclick = async function () {
        var pid = btn.getAttribute("data-told");
        var how = btn.getAttribute("data-how");
        btn.disabled = true;
        try {
          await DCR.api("/api/portal?action=accounting", {
            method: "POST", body: { op: "told", paymentId: pid, how: how },
          });
        } catch (e) {
          btn.disabled = false;
          return DCR.alert(e.message || "Could not record that.");
        }
        delete state.tell[pid];
        await load();
      };
    });
  }

  async function doWriteCheck() {
    var msg = el("ckMsg");
    var d = state.detail;
    if (!d) return;
    var payee = (el("ckPayee").value || "").trim();
    /* Strip only what people actually type around a figure — a dollar sign,
       thousands commas, spaces. Anything else is refused rather than cleaned
       away: stripping a minus sign turns "-100" into a hundred-dollar check,
       and "1e5" into fifteen. On a number somebody signs, a refusal the
       accountant retypes beats a silent reinterpretation. */
    var typed = (el("ckAmount").value || "").trim();
    var cleaned = typed.replace(/[$,\s]/g, "");
    var amount = /^\d+(\.\d{1,2})?$/.test(cleaned) ? Number(cleaned) : NaN;
    var number = (el("ckNumber").value || "").trim();
    var memo = (el("ckMemo").value || "").trim();

    var bad = !number ? "Enter the check number."
      : !isFinite(amount) ? "That is not an amount. Type it like 4500.00."
      : !(amount > 0) ? "Enter the amount."
      : amount > d.check.max + 0.005
        ? "That is more than the " + money(d.check.max) + " still authorised on this bill."
        : "";
    if (bad) { msg.textContent = bad; msg.className = "ac-msg err"; return; }

    var sure = await DCR.confirm(
      "Record check #" + number + " for " + money(amount) + " to " +
      (payee || d.check.payee) + "?",
      { okText: "Record it" });
    if (!sure) return;

    el("ckWrite").disabled = true;
    msg.className = "ac-msg";
    msg.textContent = "Recording…";
    try {
      await DCR.api("/api/portal?action=accounting", {
        method: "POST",
        body: { op: "check", billId: d.bill.id, amount: amount,
                checkNumber: number, payee: payee, memo: memo },
      });
    } catch (e) {
      var b = el("ckWrite");
      if (b) b.disabled = false;
      msg.textContent = e.message || "Could not record it.";
      msg.className = "ac-msg err";
      return;
    }
    state.openCheck = null;
    state.detail = null;
    await load();
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
