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
  /* ── the money band ────────────────────────────────────────────────────
     Two columns, one per direction of travel. Left is what the client owes us;
     right is what we owe everybody else. The question a project manager asks on
     a Friday — "what have we billed, and what do I have to pay?" — should be
     answerable without opening anything.

     Actions sit on the rows rather than behind a menu: approving a bill is the
     single most common thing done here, and it should be one deliberate click,
     never two casual ones. */
  var MONEY_KINDS = ["Subcontractor", "Material supplier", "Equipment", "Other"];

  function invState(iv) {
    if (iv.invoicePaid) return { cls: "ok", text: "Paid" + (iv.invoicePaidDate ? " " + C.fmtDay(iv.invoicePaidDate) : "") };
    if (iv.invoiceSent) {
      var over = iv.invoiceDueDate && String(iv.invoiceDueDate) < todayISO();
      return { cls: over ? "bad" : "due",
        text: over ? "Overdue since " + C.fmtDay(iv.invoiceDueDate)
                   : "Sent" + (iv.invoiceSentDate ? " " + C.fmtDay(iv.invoiceSentDate) : "") };
    }
    return { cls: "draft", text: "Not sent yet" };
  }

  function billState(b) {
    var owed = Number(b.owedAmount) || 0;
    if (!String(b.approvedDate || "").trim()) return { cls: "wait", text: "Waiting for approval" };
    if (owed <= 0) return { cls: "ok", text: "Paid" };
    if (b.expenseDueDate && String(b.expenseDueDate) < todayISO()) {
      return { cls: "bad", text: "Overdue since " + C.fmtDay(b.expenseDueDate) };
    }
    return { cls: "due", text: b.expenseDueDate ? "Due " + C.fmtDay(b.expenseDueDate) : "Approved" };
  }

  function moneyPanel() {
    var p = state.payload || {};
    if (p.pricesHidden || (!p.invoices && !p.bills)) return "";
    var invs = p.invoices || [], bills = p.bills || [], can = p.can || {};

    var inRows = invs.length
      ? invs.map(function (iv) {
          var st = invState(iv);
          return '<div class="mn-row" data-inv="' + esc(iv.id) + '" tabindex="0">' +
            '<span class="mn-dot ' + st.cls + '"></span>' +
            '<span class="mn-main"><b>' + esc(iv.invoiceNumber ? "#" + iv.invoiceNumber : (iv.title || "Invoice")) + "</b>" +
              '<span class="mn-sub">' + esc(iv.invoiceClientName || "") + "</span></span>" +
            '<span class="mn-amt">' + C.money(iv.invoiceAmount) + "</span>" +
            '<span class="mn-st ' + st.cls + '">' + esc(st.text) + "</span></div>";
        }).join("")
      : '<div class="mn-none">Nothing invoiced to the client yet.</div>';

    var outRows = bills.length
      ? bills.map(function (b) {
          var st = billState(b);
          var who = b.expenseVendorCompany || b.expenseVendorName || "(no vendor)";
          var approved = !!String(b.approvedDate || "").trim();
          var hasDoc = !!String(b.documentItemId || "").trim();
          var owed = Number(b.owedAmount) || 0;
          var acts = "";
          if (hasDoc) acts += '<button class="mn-b" data-doc="' + esc(b.documentItemId) + '" title="Open the invoice">📄</button>';
          else if (can.bills) acts += '<button class="mn-b warn" data-attach="' + esc(b.id) + '" title="No document attached — add one">📎</button>';
          if (can.approve && !approved) {
            acts += '<button class="mn-b go" data-approve="' + esc(b.id) + '"' +
              (hasDoc ? "" : ' disabled title="Attach the invoice before approving"') + ">Approve</button>";
          }
          if (can.pay && approved && owed > 0) acts += '<button class="mn-b go" data-pay="' + esc(b.id) + '">Pay</button>';
          return '<div class="mn-row" data-bill="' + esc(b.id) + '">' +
            '<span class="mn-dot ' + st.cls + '"></span>' +
            '<span class="mn-main"><b>' + esc(who) + "</b>" +
              '<span class="mn-sub">' + esc([b.expenseInvoiceNumber ? "#" + b.expenseInvoiceNumber : "",
                b.expenseKind, b.expenseDescription].filter(Boolean).join(" · ")) + "</span></span>" +
            '<span class="mn-amt">' + C.money(b.expenseAmount) +
              ((Number(b.paidAmount) || 0) > 0 && owed > 0
                ? '<span class="mn-sub">' + C.money(b.paidAmount) + " paid</span>" : "") + "</span>" +
            '<span class="mn-st ' + st.cls + '">' + esc(st.text) +
              (approved ? '<span class="mn-by">' + esc(b.approvedByName || "?") + "</span>" : "") + "</span>" +
            '<span class="mn-acts">' + acts + "</span></div>";
        }).join("")
      : '<div class="mn-none">No bills recorded yet.</div>';

    var sum = function (rows, fn) { return rows.reduce(function (t, r) { return t + (Number(fn(r)) || 0); }, 0); };
    var inSent = sum(invs, function (i) { return i.invoiceSent ? i.invoiceAmount : 0; });
    var inPaid = sum(invs, function (i) { return i.invoicePaid ? i.invoiceAmount : 0; });
    var outAll = sum(bills, function (b) { return b.expenseAmount; });
    var outWait = sum(bills, function (b) { return String(b.approvedDate || "").trim() ? 0 : b.expenseAmount; });
    var outOwed = sum(bills, function (b) { return String(b.approvedDate || "").trim() ? b.owedAmount : 0; });

    return '<div class="pm-money-band">' +
      '<section class="mn-col">' +
        "<header><h3>Money in <span>invoices we sent the client</span></h3>" +
        (can.invoices ? '<button class="btn btn-sm" id="mnAddInv">+ Invoice</button>' : "") + "</header>" +
        '<div class="mn-list">' + inRows + "</div>" +
        "<footer><span>Invoiced <b>" + C.money(inSent) + "</b></span>" +
          "<span>Collected <b>" + C.money(inPaid) + "</b></span>" +
          '<span class="mn-gap">Outstanding <b>' + C.money(inSent - inPaid) + "</b></span></footer>" +
      "</section>" +
      '<section class="mn-col">' +
        "<header><h3>Money out <span>bills from subs &amp; suppliers</span></h3>" +
        (can.bills ? '<button class="btn btn-sm" id="mnAddBill">+ Bill</button>' : "") + "</header>" +
        '<div class="mn-list">' + outRows + "</div>" +
        "<footer><span>Billed to us <b>" + C.money(outAll) + "</b></span>" +
          '<span class="' + (outWait > 0 ? "warn" : "") + '">Awaiting approval <b>' + C.money(outWait) + "</b></span>" +
          '<span class="mn-gap ' + (outOwed > 0 ? "warn" : "") + '">Still to pay <b>' + C.money(outOwed) + "</b></span></footer>" +
      "</section></div>";
  }

  /* ── money actions ──────────────────────────────────────────────────────
     None of these are auto-saved. DCR.live is for typing into a field that
     already exists; creating, approving and paying are decisions. */
  function mnPost(op, body) {
    return DCR.api("/api/portal?action=project", { method: "POST", body: Object.assign({ op: op }, body) });
  }
  function billById(id) {
    var found = null;
    ((state.payload || {}).bills || []).forEach(function (b) { if (String(b.id) === String(id)) found = b; });
    return found;
  }
  var YESNO = [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }];

  async function mnAddInvoice() {
    var v = await DCR.modal({
      title: "Invoice the client", okText: "Create",
      fields: [
        { name: "invoiceNumber", label: "Invoice number" },
        { name: "invoiceAmount", label: "Amount", type: "number", step: "0.01" },
        { name: "invoiceClientName", label: "Client",
          value: (state.payload.project || {}).projectClientName || "" },
        { name: "invoiceDueDate", label: "Due date", type: "date" },
        { name: "sent", label: "Already sent to the client?", type: "select", options: YESNO, value: "yes" },
      ],
      validate: function (x) { return Number(x.invoiceAmount) > 0 ? null : "Put in the invoice amount."; },
    });
    if (!v) return;
    var fields = {
      title: v.invoiceNumber ? "Invoice " + v.invoiceNumber : "Invoice",
      invoiceNumber: v.invoiceNumber, invoiceAmount: Number(v.invoiceAmount),
      invoiceClientName: v.invoiceClientName, invoiceDueDate: v.invoiceDueDate,
      invoiceSent: v.sent === "yes",
    };
    // a dateTime column rejects "" outright, so only send a date we have
    if (v.sent === "yes") fields.invoiceSentDate = todayISO() + "T12:00:00Z";
    try { await mnPost("invAdd", { projectId: PID, fields: fields }); }
    catch (e) { return DCR.alert(e.message || "Could not create that invoice."); }
    load();
  }

  async function mnEditInvoice(id) {
    var iv = null;
    ((state.payload || {}).invoices || []).forEach(function (x) { if (String(x.id) === String(id)) iv = x; });
    if (!iv || !(state.payload.can || {}).invoices) return;
    var v = await DCR.modal({
      title: "Invoice " + (iv.invoiceNumber ? "#" + iv.invoiceNumber : ""), okText: "Save",
      fields: [
        { name: "invoiceAmount", label: "Amount", type: "number", step: "0.01", value: String(iv.invoiceAmount || "") },
        { name: "sent", label: "Sent to the client", type: "select", options: YESNO, value: iv.invoiceSent ? "yes" : "no" },
        { name: "paid", label: "Client has paid it", type: "select", options: YESNO, value: iv.invoicePaid ? "yes" : "no" },
        { name: "paidDate", label: "Date paid", type: "date", value: String(iv.invoicePaidDate || "").slice(0, 10) },
        { name: "invoiceDueDate", label: "Due date", type: "date", value: iv.invoiceDueDate || "" },
      ],
    });
    if (!v) return;
    var fields = {
      invoiceAmount: Number(v.invoiceAmount) || 0,
      invoiceSent: v.sent === "yes", invoicePaid: v.paid === "yes",
      invoiceDueDate: v.invoiceDueDate,
    };
    if (v.sent === "yes" && !iv.invoiceSentDate) fields.invoiceSentDate = todayISO() + "T12:00:00Z";
    if (v.paid === "yes") fields.invoicePaidDate = (v.paidDate || todayISO()) + "T12:00:00Z";
    try { await mnPost("invUpdate", { itemId: iv.id, fields: fields }); }
    catch (e) { return DCR.alert(e.message || "Could not save that invoice."); }
    load();
  }

  async function mnAddBill() {
    var v = await DCR.modal({
      title: "Log a bill we received", okText: "Save",
      fields: [
        { name: "who", label: "Who sent it" },
        { name: "kind", label: "Kind", type: "select", options: MONEY_KINDS, value: "Subcontractor" },
        { name: "num", label: "Their invoice number" },
        { name: "amount", label: "Amount", type: "number", step: "0.01" },
        { name: "invDate", label: "Invoice date", type: "date", value: todayISO() },
        { name: "dueDate", label: "Due date", type: "date" },
        { name: "what", label: "What it is for", type: "textarea", rows: 2 },
      ],
      validate: function (x) {
        if (!String(x.who || "").trim()) return "Say who sent the bill.";
        if (!(Number(x.amount) > 0)) return "Put in the amount.";
        return null;
      },
    });
    if (!v) return;
    var r;
    try {
      r = await mnPost("bilAdd", { projectId: PID, fields: {
        title: v.who + (v.num ? " " + v.num : ""),
        expenseVendorCompany: v.who, expenseKind: v.kind, expenseInvoiceNumber: v.num,
        expenseAmount: Number(v.amount), expenseInvoiceDate: v.invDate,
        expenseDueDate: v.dueDate, expenseDescription: v.what,
      } });
    } catch (e) { return DCR.alert(e.message || "Could not save that bill."); }
    await load();
    // straight on to the paperwork: it cannot be approved without it
    if (r && r.id) mnAttach(String(r.id));
  }

  /* The scan or photo of the bill goes through the same queue the site photos
     use, so a receipt photographed in a truck with no signal is already safe,
     and the row is wired to the file when it finally lands. */
  function mnAttach(billId) {
    var inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*,application/pdf";
    inp.style.display = "none";
    document.body.appendChild(inp);
    inp.onchange = async function () {
      var f = inp.files && inp.files[0];
      inp.remove();
      if (!f) return;
      var stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(/:/g, ".");
      var ext = (/\.([A-Za-z0-9]{2,5})$/.exec(f.name || "") || [0, "pdf"])[1].toLowerCase();
      try {
        await DCR.uploadQueue.add({
          pid: PID, target: "receipts", mime: f.type || "", blob: f,
          name: "BILL " + stamp + " " + billId + "." + ext,
          tag: "bill:" + billId,
          // wires DocumentItemId onto the bill once the bytes land — declarative,
          // so it still happens if the tab is closed mid-upload
          after: { action: "project", op: "bilUpdate", itemId: String(billId),
                   field: "documentItemId", nameField: "documentName" },
        });
      } catch (e) { return DCR.alert(e.message || "Could not take that file."); }
      await DCR.alert("Saved on this device and uploading now. Once it lands you can approve the bill.",
        { title: "Document attached" });
      setTimeout(load, 2500);
    };
    inp.click();
  }

  async function mnApprove(id) {
    var b = billById(id);
    if (!b) return;
    var v = await DCR.modal({
      title: "Approve " + C.money(b.expenseAmount) + "?",
      message: "This authorizes " + (b.expenseVendorCompany || "this vendor") +
        " to be paid. Your name and today's date are recorded against the bill.",
      okText: "Approve for payment",
      fields: [{ name: "note", label: "Note (optional)" }],
    });
    if (!v) return;
    try {
      var r = await mnPost("billApprove", { itemId: id, note: v.note });
      if (r && r.alreadyApproved) {
        await DCR.alert("Already approved by " + (r.approvedByName || "someone") +
          " on " + (r.approvedDate || "an earlier date") + ".", { title: "Already approved" });
      }
    } catch (e) {
      return DCR.alert(e.message || "Could not approve that bill.", { title: "Not approved" });
    }
    load();
  }

  async function mnPay(id) {
    var b = billById(id);
    if (!b) return;
    var owed = Number(b.owedAmount) || 0;
    var v = await DCR.modal({
      title: "Record a payment",
      message: "Still owed on this bill: " + C.money(owed),
      okText: "Record it",
      fields: [
        { name: "amount", label: "Amount paid", type: "number", step: "0.01", value: String(owed || "") },
        { name: "how", label: "How", type: "select", value: "Check",
          options: ["Check", "Card", "ACH / transfer", "Cash", "Other"] },
        { name: "ref", label: "Check / reference number" },
        { name: "notes", label: "Notes" },
      ],
      validate: function (x) {
        var n = Number(x.amount);
        if (!(n > 0)) return "Put in the amount paid.";
        if (n > owed + 0.005) return "That is more than the " + C.money(owed) + " still owed on this bill.";
        return null;
      },
    });
    if (!v) return;
    try {
      await mnPost("payAdd", { projectId: PID, fields: {
        paymentName: (b.expenseVendorCompany || "Payment") + (b.expenseInvoiceNumber ? " " + b.expenseInvoiceNumber : ""),
        expenseID: Number(id), projectID: Number(PID),
        paymentExpenseAmount: Number(v.amount), paymentMethod: v.how,
        paymentReference: v.ref, paymentPaidNotes: v.notes, paymentPAID: true,
      } });
    } catch (e) {
      return DCR.alert(e.message || "Could not record that payment.", { title: "Not recorded" });
    }
    load();
  }

  async function mnViewDoc(itemId) {
    try {
      var d = await DCR.api("/api/portal?action=drive&fileInfo=" + encodeURIComponent(itemId));
      // a pre-authed URL, so a big scan opens without going through the API
      var url = d && (d.downloadUrl || d.webUrl);
      if (url) window.open(url, "_blank", "noopener");
      else await DCR.alert("That document could not be opened.");
    } catch (e) { await DCR.alert(e.message || "That document could not be opened."); }
  }

  function wireMoney() {
    var a = el("mnAddInv"); if (a) a.onclick = mnAddInvoice;
    var b = el("mnAddBill"); if (b) b.onclick = mnAddBill;
    document.querySelectorAll("[data-doc]").forEach(function (n) {
      n.onclick = function (e) { e.stopPropagation(); mnViewDoc(n.getAttribute("data-doc")); };
    });
    document.querySelectorAll("[data-attach]").forEach(function (n) {
      n.onclick = function (e) { e.stopPropagation(); mnAttach(n.getAttribute("data-attach")); };
    });
    document.querySelectorAll("[data-approve]").forEach(function (n) {
      n.onclick = function (e) { e.stopPropagation(); mnApprove(n.getAttribute("data-approve")); };
    });
    document.querySelectorAll("[data-pay]").forEach(function (n) {
      n.onclick = function (e) { e.stopPropagation(); mnPay(n.getAttribute("data-pay")); };
    });
    document.querySelectorAll("[data-inv]").forEach(function (n) {
      n.onclick = function () { mnEditInvoice(n.getAttribute("data-inv")); };
    });
  }

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
      var cards = [["Estimate", est], ["Committed to subs", com]];
      /* Money in: what we invoiced the client and what they have paid.
         Invoices is the record; Payments used to double as both and is now the
         disbursement log, so it is deliberately not summed here. */
      if (p.invoices) {
        var billedOut = 0, collected = 0;
        p.invoices.forEach(function (iv) {
          var amt = Number(iv.invoiceAmount) || 0;
          if (iv.invoiceSent) billedOut += amt;
          if (iv.invoicePaid) collected += amt;
        });
        cards.push(["Billed to client", billedOut], ["Collected", collected]);
      }
      /* Money out. "Awaiting approval" and "Due to pay" are the two numbers a
         project manager actually acts on, so they get their own tiles. */
      if (p.bills) {
        var billedIn = 0, waitAmt = 0, waitN = 0, dueAmt = 0, overdueAmt = 0;
        var today = new Date().toISOString().slice(0, 10);
        p.bills.forEach(function (b) {
          var amt = Number(b.expenseAmount) || 0;
          billedIn += amt;
          if (!String(b.approvedDate || "").trim()) { waitAmt += amt; waitN += 1; return; }
          var owe = Number(b.owedAmount) || 0;
          dueAmt += owe;
          if (owe > 0 && b.expenseDueDate && String(b.expenseDueDate) < today) overdueAmt += owe;
        });
        cards.push(["Billed to us", billedIn]);
        cards.push(["Awaiting approval", waitAmt, waitN ? waitN + (waitN === 1 ? " bill" : " bills") : "", waitN ? "warn" : ""]);
        cards.push(["Due to pay", dueAmt, overdueAmt > 0 ? C.money(overdueAmt) + " overdue" : "", overdueAmt > 0 ? "bad" : ""]);
      } else {
        cards.push(["Sub invoices", inv], ["Paid to subs", paid]);
      }
      money = '<div class="pm-cards">' + cards.map(function (c) {
        return '<div class="pm-card' + (c[3] ? " " + c[3] : "") + '"><div class="k">' + esc(c[0]) + "</div>" +
          '<div class="v">' + C.money(c[1]) + "</div>" +
          (c[2] ? '<div class="n">' + esc(c[2]) + "</div>" : "") + "</div>";
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
        '<span class="pm-legend">\u2713 Done \u00b7 \u25cf In progress \u00b7 \u26a0 Waiting \u00b7 \u25cc Not started</span>' +
      "</div>" +
      /* Two channels, said out loud: the glyph is how a tile is GOING, the bar
         down its left edge is WHAT IT IS. A reader should not have to infer
         that a quote and an invoice are different kinds of thing. */
      '<div class="pm-bar pm-kindbar">' +
        '<span class="pm-legend">Tiles:</span>' +
        (C.A_NODES || []).concat(C.B_NODES || []).reduce(function (acc, d) {
          if (acc.seen[d.kind]) return acc;
          acc.seen[d.kind] = 1;
          acc.html += '<span class="pm-kind"><i style="background:' + C.KIND_COLOR[d.kind] + '"></i>' +
            esc(d.kind === "quote" ? "Quote requests" : d.kind === "price" ? "Our price"
              : d.kind === "award" ? "Awarded" : d.kind === "cost" ? "Money out \u00b7 subs & bills"
              : "Money in \u00b7 client") + "</span>";
          return acc;
        }, { seen: {}, html: "" }).html +
      "</div>" +
      chart + moneyPanel() + extrasPanel() + tasksPanel() + empty;

    wire(compact);
    wireMoney();
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
          openDrawer(parts.slice(1, -1).join(":"), parts[parts.length - 1]);
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
      if (!(await DCR.confirm(label + "?", { title: "Change the project stage" }))) return;
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
    if (!(await DCR.confirm("Remove this cost?", { title: "Remove cost", danger: true, okText: "Remove" }))) return;
    try {
      await DCR.api("/api/portal?action=project", { method: "POST", body: { op: "expDelete", itemId: id } });
      await load();
    } catch (e) { DCR.alert(e.message || "Could not remove it.", { title: "Couldn't remove it" }); }
  }

  /* ── who this item is already assigned to ──────────────────────────────
     TaskAssignedPerson is a multi-line blob the Access form builds by stacking
     the contact's name, company and phone; TaskAssignedEmail holds the address.
     Pull it apart so the quote form starts filled in with the person the item
     is already assigned to, instead of making someone retype what we know. */
  var RE_EMAIL = /[^\s,;<>()]+@[^\s,;<>()]+\.[a-z]{2,}/i;
  // must swallow the opening paren of "(805) 674-1383", or it is left behind
  // and reads as part of the name
  var RE_PHONE = /(\+?\d{0,2}[\s.\-]*\(?\d{3}\)?[\s.\-]*\d{3}[\s.\-]*\d{4})/;
  function assigneeSeed(l) {
    var a = (l.assignees || [])[0];
    if (!a) return null;
    var raw = String(a.name || "");
    var seed = { name: "", company: "", trade: "", email: String(a.email || "").trim(), phone: "" };
    var lines = raw.split(/[\r\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var leftovers = [];
    lines.forEach(function (line) {
      var em = line.match(RE_EMAIL), ph = line.match(RE_PHONE);
      var rest = line;
      if (em) { if (!seed.email) seed.email = em[0]; rest = rest.replace(em[0], " "); }
      if (ph) { if (!seed.phone) seed.phone = ph[0].trim(); rest = rest.replace(ph[0], " "); }
      rest = rest.replace(/\s{2,}/g, " ").trim();
      if (rest) leftovers.push(rest);
    });
    seed.name = leftovers.shift() || "";
    seed.company = leftovers.join(" ").trim();
    return seed.name || seed.email || seed.phone ? seed : null;
  }

  // Fill the blanks the blob can't answer (company, trade, a proper email) from
  // the Contacts record, matching on email first — the one reliable key —
  // then on the name. Never overwrites something already on screen.
  async function enrichVendorFromContacts(seed) {
    var setIfBlank = function (id, v) {
      var n = el(id);
      if (n && !n.value && v) n.value = v;
    };
    var all;
    try { all = await contactsBook(); } catch (e) { return null; }
    var email = (seed.email || "").toLowerCase();
    var name = (seed.name || "").toLowerCase();
    var hit = null;
    if (email) {
      hit = all.filter(function (c) { return String(c.contactEMail || "").toLowerCase() === email; })[0] || null;
    }
    if (!hit && name.length > 3) {
      hit = all.filter(function (c) { return String(c.contactName || "").toLowerCase() === name; })[0] ||
        all.filter(function (c) { return String(c.contactName || "").toLowerCase().indexOf(name) !== -1; })[0] || null;
    }
    if (!hit) return null;
    setIfBlank("qtCompany", hit.contactCompany);
    setIfBlank("qtTrade", hit.contactTrade);
    setIfBlank("qtEmail", hit.contactEMail);
    setIfBlank("qtPhone", hit.contactPhone);
    return hit;
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

  // A money field just saved. Repaint the chart straight away — that is
  // outside the drawer, so nothing the user is typing into moves. The drawer's
  // own totals wait until they have finished tabbing through the row, because
  // re-rendering it mid-edit would pull the field out from under them.
  function moneySaved(row, qid, fields) {
    var q = (state.payload.quotes || []).filter(function (x) { return String(x.id) === String(qid); })[0];
    if (q) for (var k in fields) q[k] = fields[k];
    rederive();
    if (!row.contains(document.activeElement)) { renderDrawer(); return; }
    if (row._deferred) return;
    row._deferred = true;
    row.addEventListener("focusout", function once(e) {
      if (row.contains(e.relatedTarget)) return;   // moved to the next money field
      row.removeEventListener("focusout", once);
      renderDrawer();
    });
  }

  /* ── item drawer ── */
  function laneOf(key) {
    for (var i = 0; i < state.model.lanes.length; i++) if (state.model.lanes[i].key === key) return state.model.lanes[i];
    return null;
  }
  /* A tile is a view of one part of an item, so clicking it should land on
     that part. Without this every tile opened the same drawer at the same
     scroll position and the reader had to find the section themselves. */
  var KIND_SECTION = { quote: "quotes", price: "fin", award: "quotes", cost: "costs", income: "costs" };

  function openDrawer(key, nodeKey) {
    var def = nodeKey && C.NODE_DEFS ? C.NODE_DEFS[nodeKey] : null;
    if (def && KIND_SECTION[def.kind]) secSet(KIND_SECTION[def.kind], true);
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

  /* ── drawer sections ───────────────────────────────────────────────────
     The drawer carries everything about one item, which is a lot to scroll
     past when you came for one number. Each block folds, and every body is
     rendered whether open or not — toggling is a class, never a re-render, so
     a half-typed amount or an in-flight save is never thrown away.
     Open/closed is remembered per section across items and visits. */
  var SEC_KEY = "dcr_pm_secs";
  function secOpen(key, dflt) {
    try {
      var all = JSON.parse(localStorage.getItem(SEC_KEY) || "{}");
      return all[key] === undefined ? dflt : !!all[key];
    } catch (e) { return dflt; }
  }
  function secSet(key, open) {
    try {
      var all = JSON.parse(localStorage.getItem(SEC_KEY) || "{}");
      all[key] = !!open;
      localStorage.setItem(SEC_KEY, JSON.stringify(all));
    } catch (e) {}
  }
  function section(key, title, count, body, dflt) {
    if (!body) return "";
    var open = secOpen(key, dflt);
    return '<section class="pm-sec' + (open ? " open" : "") + '" data-sec="' + esc(key) + '">' +
      '<button type="button" class="pm-sec-hd"><span class="cav">▾</span>' + esc(title) +
      ' <span class="n" id="secN-' + esc(key) + '">' + esc(String(count || "")) + "</span></button>" +
      '<div class="pm-sec-bd">' + body + "</div></section>";
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
      scopeSec =
        '<div style="display:flex;gap:16px;flex-wrap:wrap">' +
        (lbn.length ? '<div style="flex:1;min-width:150px"><div class="pm-sub" style="font-weight:700">Labor</div>' + li(lbn) + "</div>" : "") +
        (mtn.length ? '<div style="flex:1;min-width:150px"><div class="pm-sub" style="font-weight:700">Materials</div>' + li(mtn) + "</div>" : "") +
        "</div>";
    }

    // start the quote form from whoever the item is already assigned to
    var seed = assigneeSeed(l) || { name: "", company: "", trade: "", email: "", phone: "" };

    var moneyRow = hidden ? "" :
      '<div class="pm-money">' +
      [["Estimate", l.estTotal], ["Awarded", l.awarded], ["Invoiced", l.invoiced], ["Paid", l.paid], ["Costs recorded", costs]]
        .map(function (c) {
          return '<div class="pm-card"><div class="k">' + esc(c[0]) + '</div><div class="v" style="font-size:13.5px">' + C.money(c[1] || 0) + "</div></div>";
        }).join("") + "</div>";

    var tkRow = "";
    if (l.takeoff && l.takeoff.lines) {
      tkRow = '<div class="pm-h" style="margin-top:12px">Material takeoff</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px">' +
        '<span>📐 ' + l.takeoff.lines + " line" + (l.takeoff.lines === 1 ? "" : "s") +
        (l.takeoff.names && l.takeoff.names.length ? ' <span class="pm-sub">· ' + esc(l.takeoff.names.join(", ")) + "</span>" : "") + "</span>" +
        "<b>" + (hidden || !l.takeoff.total ? "" : C.money(l.takeoff.total)) + "</b></div>" +
        '<a class="pm-sub" href="project.html?id=' + esc(PID) + '&tab=takeoffs">Open the Takeoffs tab →</a>';
    }

    var filesSec = '<div id="pmFiles" class="pm-sub">Loading…</div>' +
      '<div style="margin-top:6px"><input type="file" id="pmFileIn" multiple style="display:none">' +
      '<button class="btn btn-ghost btn-sm" id="pmFileAdd">＋ Add document</button> ' +
      '<span class="pm-msg" id="pmFileMsg"></span></div>';

    var qRows = l.quotes.map(function (q) {
      var amt = hidden ? "" : (q.quoteAmount != null && q.quoteAmount !== "" ? C.money(Number(q.quoteAmount)) : "—");
      var awarded = q.quoteStatus === "Awarded";
      /* A status this screen does not know means the row came from somewhere
         else - hand-entered, or carrying a value from the PROJECT vocabulary
         ("Sent") rather than the quote one. Treating it as "not Requested"
         hid every action and left the quote unreachable: no follow-up, no
         marking it received, no awarding it, only delete. An unknown status
         is an OPEN quote, so it gets the same buttons a requested one does. */
      // An array, not an object: a status of "constructor" would look known.
      var known = ["Requested", "Received", "Declined", "Awarded", "Self"];
      var stRaw = q.quoteStatus || "Requested";
      var stOdd = known.indexOf(stRaw) < 0;
      var openQ = stRaw === "Requested" || stOdd;
      var menu = can.quotes
        ? '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">' +
          (openQ
            ? '<button class="btn btn-ghost btn-sm qtRecv" data-q="' + esc(q.id) + '" style="padding:2px 8px">✓ Mark received…</button>' +
              (q.vendorEmail ? '<button class="btn btn-ghost btn-sm qtChase" data-q="' + esc(q.id) + '" style="padding:2px 8px">✉ Follow up</button>' : "")
            : "") +
          (q.quoteStatus === "Received"
            ? '<button class="btn btn-ghost btn-sm qtAward" data-q="' + esc(q.id) + '" style="padding:2px 8px">🏆 Award</button>' : "") +
          '<button class="btn btn-ghost btn-sm qtDel" data-q="' + esc(q.id) + '" style="padding:2px 8px">🗑</button>' +
          "</div>"
        : "";
      // The agreed amount has to be editable here. It is the figure every other
      // number is measured against — Committed to subs, and whether an invoice
      // is over or under — and awarding without one is easy to do.
      // Labels above the boxes, not placeholders inside them: a placeholder
      // disappears the moment a figure is typed, which leaves three unlabelled
      // amounts sitting next to each other.
      var qf = function (cls, label, val, tip) {
        var id = "qf" + cls + q.id;
        return '<div class="qtF"><label for="' + id + '">' + esc(label) + "</label>" +
          '<input id="' + id + '" type="number" step="0.01" class="' + cls + '" value="' +
          (hidden ? "" : (val || "")) + '"' + (tip ? ' title="' + esc(tip) + '"' : "") + "></div>";
      };
      var money3 = awarded && can.quotes
        ? '<div class="qtInvRow" data-q="' + esc(q.id) + '">' +
          qf("qtAmt2", "Awarded $", q.quoteAmount, "What you agreed to pay this vendor") +
          qf("qtInv", "Invoiced $", q.invoiceAmount, "What they have billed you so far") +
          qf("qtPaid", "Paid $", q.paidAmount, "What you have paid them so far") +
          '<span class="dcr-live qtLive"></span>' +
          (!hidden && !(Number(q.quoteAmount) > 0)
            ? '<div style="flex-basis:100%;color:var(--gold)" class="qtNoAmt">No agreed amount yet — enter it so invoices can be checked against it.</div>' : "") +
          "</div>"
        : "";
      var invStrip = money3;
      return '<tr><td><b>' + esc(q.vendorCompany || q.vendorName || "(vendor)") + "</b>" +
        (q.vendorTrade ? ' <span class="pm-sub">' + esc(q.vendorTrade) + "</span>" : "") +
        (q._ambiguous ? ' <span class="pm-sub" title="Matched by grouping name only">≈</span>' : "") +
        '<div class="pm-sub">' + esc([q.quoteRequestDate ? "req " + q.quoteRequestDate : "",
          q.quoteFollowUpDate
            ? "chased " + q.quoteFollowUpDate + (Number(q.quoteFollowUpCount) > 1 ? " ×" + q.quoteFollowUpCount : "")
            : "",
          q.quoteReceivedDate ? "rec " + q.quoteReceivedDate : ""].filter(Boolean).join(" · ")) + "</div>" +
        (q.documentUrl && /^https:\/\//i.test(q.documentUrl) ? '<a href="' + esc(q.documentUrl) + '" target="_blank" rel="noopener noreferrer">📎 quote doc</a>' : "") +
        menu + invStrip + "</td>" +
        '<td style="text-align:right;white-space:nowrap">' + amt +
        '<div><span class="pm-st ' + esc(stOdd ? "Requested" : stRaw) + '"' +
          (stOdd ? ' title="' + esc(stRaw) + ' is not a quote status — treated as still open. Mark received or award it to correct the record."' : "") +
          '>' + esc(stRaw) + (stOdd ? " ?" : "") + "</span></div></td></tr>";
    }).join("");

    var addForm = can.quotes
      ? '<div class="pm-h" style="margin-top:12px">Request a quote</div><div class="pm-form">' +
        '<div class="pm-sugg"><label>Vendor (from Contacts)</label>' +
        '<input id="qtVendor" autocomplete="off" placeholder="Type a vendor name…" value="' +
          esc(seed.name) + '"><div class="list" id="qtVList"></div></div>' +
        '<div style="display:flex;gap:8px"><div style="flex:1"><label>Company</label><input id="qtCompany" value="' + esc(seed.company) + '"></div>' +
        '<div style="flex:1"><label>Trade</label><input id="qtTrade" value="' + esc(seed.trade) + '"></div></div>' +
        '<div style="display:flex;gap:8px"><div style="flex:1"><label>Email</label><input id="qtEmail" type="email" value="' + esc(seed.email) + '"></div>' +
        '<div style="flex:1"><label>Phone</label><input id="qtPhone" value="' + esc(seed.phone) + '"></div></div>' +
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

      section("fin", "Financial overview", "", moneyRow, true) +

      section("scope", "Scope", "", scopeSec + tkRow, false) +

      section("quotes", "Quotes", l.quotes.length || "",
        (state.model.quotesReady
          ? (qRows ? '<table class="pm-qt">' + qRows + "</table>" : '<div class="pm-sub">No quote requests yet.</div>')
          : '<div class="pm-sub">Quote tracking isn\'t enabled yet.</div>') + addForm,
        true) +

      // Costs and invoices against this item — as many as it takes.
      section("costs", "Invoices, payments & expenses",
        (costRows.length ? costRows.length + (hidden ? "" : " · " + C.money(costs)) : ""),
        '<div id="pmCostList">' + costRowsHtml(costRows, can.estimate, hidden) + "</div>" +
        (can.estimate
          ? '<div style="margin-top:6px"><button class="btn btn-ghost btn-sm" id="icAdd">＋ Add a cost or invoice</button></div>' +
            costFormHtml("ic", true)
          : "") +
        (costRows.length ? '<a class="pm-sub" href="project.html?id=' + esc(PID) + '&tab=expenses">Open the Expenses tab →</a>' : ""),
        costRows.length > 0) +

      // Tasks raised against this item.
      section("tasks", "Tasks", itemTasks.length || "",
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
          : ""),
        itemTasks.length > 0) +

      section("docs", "Documents", "", filesSec, false) +

      section("flag", "Flags & notes", "", flagRow + noteBox, false) +

      "</div>";

    // Folding is a class flip, never a re-render — anything mid-edit survives.
    d.querySelectorAll(".pm-sec-hd").forEach(function (h) {
      h.onclick = function () {
        var sec = h.parentNode;
        sec.classList.toggle("open");
        secSet(sec.dataset.sec, sec.classList.contains("open"));
      };
    });

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
    var box = el("pmFiles"), cnt = el("secN-docs");
    if (!box) return;
    try {
      var r = await DCR.api("/api/portal?action=drive&taskDocs=" + encodeURIComponent(PID) +
        "&task=" + encodeURIComponent(l.rowIds.slice(0, 12).join(",")));
      if (state.drawerKey !== l.key || !el("pmFiles")) return;
      var fs = r.files || [];
      if (cnt) cnt.textContent = fs.length ? String(fs.length) : "";
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

    /* Reports whether the write actually landed. It swallows the error to put
       a message on screen, which means `await write(...)` returns normally on
       failure - so a caller that goes on to do something consequential has to
       check. Callers that only needed the save can keep ignoring it. */
    async function write(body, msgEl) {
      try {
        await DCR.api("/api/portal?action=pm", { method: "POST", body: body });
        await load();
        renderDrawer();
        return true;
      } catch (e) {
        var m2 = el(msgEl || "qtMsg");
        if (m2) m2.textContent = e.message || "Save failed";
        else DCR.alert(e.message || "Save failed", { title: "Couldn't save" });
        return false;
      }
    }

    d.querySelectorAll(".qtRecv").forEach(function (b) {
      b.onclick = async function () {
        var amt = state.model.pricesHidden ? null
          : await DCR.ask("What did they quote?", { title: "Mark quote received", type: "number", label: "Quoted amount ($)" });
        if (amt === null && !state.model.pricesHidden) return;
        var f = { quoteStatus: "Received" };
        if (amt && Number(amt) > 0) f.quoteAmount = Number(amt);
        write({ op: "qtUpdate", itemId: b.dataset.q, fields: f });
      };
    });
    d.querySelectorAll(".qtAward").forEach(function (b) {
      b.onclick = async function () {
        if (!(await DCR.confirm("Other quotes stay recorded for comparison.", { title: "Award this item to the vendor?", okText: "Award" }))) return;
        write({ op: "qtUpdate", itemId: b.dataset.q, fields: { quoteStatus: "Awarded" } });
      };
    });
    d.querySelectorAll(".qtDel").forEach(function (b) {
      b.onclick = async function () {
        if (!(await DCR.confirm("Delete this quote row?", { title: "Delete quote", danger: true, okText: "Delete" }))) return;
        write({ op: "qtDelete", itemId: b.dataset.q });
      };
    });
    d.querySelectorAll(".qtChase").forEach(function (b) {
      b.onclick = async function () {
        var q = l.quotes.filter(function (x) { return String(x.id) === String(b.dataset.q); })[0];
        if (!q) return;
        /* Record the chase FIRST, then open the mail client.

           This used to append "Follow-up sent <date>" to the free-text notes,
           which nothing could read — so the chart went on warning that the
           quote was 61 days old however many times you had chased it. It now
           writes a real date, and the overdue clock restarts from there.

           It also used to navigate the window to mailto: BEFORE saving.
           Navigating can stop a pending write from ever running — the same
           trap qtAdd was fixed for — which would leave a follow-up looking
           logged when it was not. */
        b.disabled = true;
        var recorded;
        try { recorded = await write({ op: "qtFollowUp", itemId: b.dataset.q }); }
        finally { b.disabled = false; }
        /* And do not open the mail client unless it did land. write() reports
           failure by returning false rather than throwing, so without this the
           draft opens anyway: the chase gets sent, nothing records it, and the
           warning this button exists to clear stays up. Worse than not sending,
           because it looks done. */
        if (!recorded) return;
        var subj = "Follow-up: quote request — " + (state.model.project.internalIDNumber || "") + " " +
          (state.model.project.projectName || "") + " — " + l.groupingName;
        var mail = document.createElement("a");
        mail.href = "mailto:" + encodeURIComponent(q.vendorEmail) + "?subject=" + encodeURIComponent(subj);
        mail.style.display = "none";
        document.body.appendChild(mail);
        mail.click();
        mail.remove();
      };
    });
    // Money on an awarded row saves itself, like the rest of the app. On blur,
    // never per keystroke: "1" is a real number on the way to "12147.50", and
    // these figures drive Committed to subs and the over/under checks.
    d.querySelectorAll(".qtInvRow").forEach(function (row) {
      var qid = row.dataset.q;
      var q0 = l.quotes.filter(function (x) { return String(x.id) === String(qid); })[0] || {};
      var num = function (v) { return v === "" || v == null ? 0 : Number(v); };
      var saver = DCR.live.record({
        key: "quote:" + qid,
        status: row.querySelector(".qtLive"),
        write: function (fields) {
          return DCR.api("/api/portal?action=pm", { method: "POST",
            body: { op: "qtUpdate", itemId: qid, fields: fields } });
        },
        validate: function (f, v) { return v === null || isFinite(v); },
        onSaved: function (fields) { moneySaved(row, qid, fields); },
      });
      saver.baseline({ quoteAmount: num(q0.quoteAmount), invoiceAmount: num(q0.invoiceAmount), paidAmount: num(q0.paidAmount) });
      [[".qtAmt2", "quoteAmount"], [".qtInv", "invoiceAmount"], [".qtPaid", "paidAmount"]].forEach(function (p) {
        var inp = row.querySelector(p[0]);
        if (!inp) return;
        inp.addEventListener("input", function () { saver.set(p[1], num(inp.value)); });
        inp.addEventListener("blur", function () { saver.set(p[1], num(inp.value)); saver.flush(); });
      });
    });

    // vendor typeahead over contacts
    var vend = el("qtVendor");
    var picked = { id: "" };
    // The assignee blob gives us a name, and usually a phone and email. Company
    // and trade only live in Contacts, so look the person up and fill the gaps.
    if (vend) {
      var seed0 = assigneeSeed(l);
      if (seed0) {
        enrichVendorFromContacts(seed0).then(function (hit) {
          if (hit && !picked.id) picked.id = String(hit.id);
        });
      }
    }
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
    if (awardNow) awardNow.onclick = async function () {
      var f = collectFields("Awarded");
      if (!f.vendorName && !f.vendorCompany) { msg("Give the vendor a name or a company."); return; }
      var who = f.vendorCompany || f.vendorName;
      if (!(await DCR.confirm(
        f.quoteAmount ? C.money(f.quoteAmount) + " agreed."
          : "No amount entered — Committed to subs stays $0, and any invoice will read as unmeasured until you add one.",
        { title: "Award this item to " + who + "?", okText: "Award" }))) return;
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
    // note and due date in ONE dialog — the old flow asked twice, and a typo in
    // the second prompt threw away what you had already typed in the first
    if (b3) b3.onclick = async function () {
      var r = await DCR.modal({
        title: "⚑ Mark important",
        message: "It shows on the chart, and turns red once the date passes.",
        okText: "Flag it",
        fields: [
          { name: "note", label: "What needs to happen?", placeholder: "e.g. invoice due, inspection, order materials" },
          { name: "due", label: "Due date (optional)", type: "date" },
        ],
        validate: function (v) {
          if (!String(v.note || "").trim()) return "Say what needs to happen.";
          return "";
        },
      });
      if (!r) return;
      write({ op: "flag", projectId: PID, itemKey: l.key, state: "important",
        note: r.note.trim(), due: r.due || "" }, "pmNoteMsg");
    };
    if (c3) c3.onclick = function () { fg(null); };
    var b1 = el("fgBlock"), b2 = el("fgDone"), c1 = el("fgClear"), c2 = el("fgClear2");
    if (b1) b1.onclick = async function () {
      var note = await DCR.ask("What is it blocked on?", {
        title: "⛔ Mark blocked", okText: "Mark blocked", danger: true,
        placeholder: "e.g. waiting on the permit",
        validate: function (v) { return String(v.v || "").trim() ? "" : "Say what it is waiting on."; },
      });
      if (note === null) return;
      fg("blocked", note.trim());
    };
    if (b2) b2.onclick = async function () {
      if (await DCR.confirm("Every stage of this item will read as done.", { title: "Mark this whole item complete?", okText: "Mark complete" })) fg("complete");
    };
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
