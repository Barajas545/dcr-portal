/* One invoice, its paperwork, and the decision.

   Reached from the approvals list on the home screen. The question this screen
   answers is not "what is outstanding on this job" — the money panel already
   does that — but "should I authorise THIS, and does the paperwork say what the
   row says". So the document is on screen beside the numbers rather than a
   download somebody may or may not open. */
(function () {
  "use strict";
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var Q = new URLSearchParams(location.search);
  var PID = String(Q.get("project") || "").trim();
  var BID = String(Q.get("id") || "").trim();

  var state = { data: null, active: 0, objectUrls: [] };

  function money(v) {
    return "$" + (Number(v) || 0).toLocaleString("en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function day(v) {
    var s = String(v || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
    var d = new Date(s + "T12:00:00Z");
    return isNaN(d) ? s : d.toLocaleDateString("en-US",
      { month: "short", day: "numeric", year: "numeric" });
  }
  function kb(n) {
    n = Number(n) || 0;
    return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  }
  var todayKey = function () { return new Date().toISOString().slice(0, 10); };

  /* What the browser can put on screen without downloading anything.

     PDFs and ordinary web images only. A HEIC from an iPhone is a real photo of
     a real invoice, but no browser renders it inline, so it is offered as a
     download rather than shown as a broken frame. */
  function viewable(f) {
    var m = String(f.mimeType || "").toLowerCase();
    if (m === "application/pdf") return "pdf";
    if (m === "image/jpeg" || m === "image/png" || m === "image/gif" ||
        m === "image/webp" || m === "image/bmp") return "image";
    return "";
  }

  function row(k, v, cls) {
    if (v === "" || v === null || v === undefined) return "";
    return '<div><span class="k">' + esc(k) + '</span>' +
      '<span class="v' + (cls ? " " + cls : "") + '">' + v + "</span></div>";
  }

  function render() {
    var d = state.data;
    var b = d.bill, files = d.files || [], can = d.can || {};
    var waiting = !String(b.approvedDate || "").trim();
    var voided = b.expenseVoid === true;
    var late = b.expenseDueDate && String(b.expenseDueDate).slice(0, 10) < todayKey();

    var h = '<div class="bl-top"><div>' +
      "<h2>" + esc(b.expenseVendorCompany || b.expenseVendorName || "(no vendor)") +
      (b.expenseInvoiceNumber ? ' <span style="color:var(--text-muted);font-weight:400">#' +
        esc(b.expenseInvoiceNumber) + "</span>" : "") + " " +
      '<span class="bl-state ' + (voided ? "void" : waiting ? "wait" : "ok") + '">' +
        (voided ? "VOID" : waiting ? "AWAITING APPROVAL" : "APPROVED") + "</span></h2>" +
      '<p class="bl-sub">' + esc(d.project.label || "") +
        (d.project.address ? " · " + esc(d.project.address) : "") + "</p></div>" +
      '<div class="bl-amt"><div class="v">' + money(b.expenseAmount) + "</div>" +
      '<div class="n">' + (Number(b.paidAmount) > 0
        ? money(b.paidAmount) + " paid · " + money(b.owedAmount) + " still to pay"
        : "nothing paid yet") + "</div></div></div>";

    h += '<div class="bl-grid">';

    // ── the paperwork ────────────────────────────────────────────────────
    h += '<div class="bl-view"><div class="bl-card"><h3>The paperwork</h3>';
    if (!files.length) {
      h += '<div class="bl-stage"><div class="msg">' +
        "No document is attached to this invoice.<br>It cannot be approved until one is." +
        "</div></div>";
    } else {
      h += '<div class="bl-tabs">' + files.map(function (f, i) {
        return '<button data-f="' + i + '" aria-pressed="' + (i === state.active) + '" title="' +
          esc(f.name) + '">' + (f.primary ? "&#128206; " : "") + esc(f.name) + "</button>";
      }).join("") + "</div>";
      h += '<div class="bl-stage" id="blStage"><div class="msg">Opening…</div></div>';
      h += '<div class="bl-viewbar" id="blViewBar"></div>';
    }
    h += "</div></div>";

    // ── the facts and the decision ───────────────────────────────────────
    h += '<div class="bl-side">';

    h += '<div class="bl-card"><h3>The invoice</h3><div class="bl-rows">' +
      row("Vendor", esc(b.expenseVendorCompany || b.expenseVendorName || "—")) +
      row("Their invoice #", esc(b.expenseInvoiceNumber || "—")) +
      row("Kind", esc(b.expenseKind || "—")) +
      row("Amount", money(b.expenseAmount)) +
      row("Invoice date", esc(day(b.expenseInvoiceDate) || "—")) +
      row("Due", esc(day(b.expenseDueDate) || "—") + (late && waiting ? " · OVERDUE" : ""),
          late && waiting ? "late" : "") +
      row("Logged by", esc([b.loggedByName, day(b.loggedDate)].filter(Boolean).join(" · ") || "—")) +
      "</div></div>";

    if (b.expenseDescription) {
      h += '<div class="bl-card"><h3>What it is for</h3>' +
        '<div class="bl-desc">' + esc(b.expenseDescription) + "</div></div>";
    }

    h += '<div class="bl-card"><h3>' + (waiting ? "Approve for payment" : "Approval") + "</h3>";
    if (voided) {
      h += '<div class="bl-why">This bill was voided. Un-void it before approving.</div>';
    } else if (!waiting) {
      h += '<div class="bl-ok"><b>Approved</b> by ' + esc(b.approvedByName || "—") +
        (b.approvedDate ? " on " + esc(day(b.approvedDate)) : "") +
        (Number(b.approvedAmount) > 0 ? "<br>Authorised at <b>" + money(b.approvedAmount) + "</b>" : "") +
        (b.approvedNote ? "<br>" + esc(b.approvedNote) : "") + "</div>";
    } else if (!can.approve) {
      h += '<div class="bl-why">Only a manager or admin with approve authority can sign this off.</div>';
    } else if (!files.length) {
      /* The server refuses without paperwork anyway; saying so here stops the
         reviewer pressing a button that was always going to say no. */
      h += '<div class="bl-why">Attach the invoice first — an approved payment needs the ' +
        "paperwork behind it.</div>";
    } else {
      h += '<input class="bl-note" id="blNote" type="text" placeholder="Note (optional)">' +
        '<button class="bl-approve" id="blGo">&#10003; Approve ' + money(b.expenseAmount) +
        " for payment</button>";
    }
    h += '<div class="bl-msg" id="blMsg"></div>';

    // the way onward the reviewer asked for
    h += '<a class="bl-secondary" href="pm.html?id=' + encodeURIComponent(PID) + '">' +
      "Open this project in the progress chart &rarr;</a>";
    h += '<a class="bl-secondary" href="dashboard.html">Back to the approvals list</a>';
    h += "</div>";

    h += "</div></div>";
    el("blRoot").innerHTML = h;

    if (files.length) {
      document.querySelectorAll("[data-f]").forEach(function (btn) {
        btn.onclick = function () { show(Number(btn.getAttribute("data-f"))); };
      });
      show(state.active);
    }
    var go = el("blGo");
    if (go) go.onclick = approve;
  }

  /* Put a file on screen.

     The bytes are fetched rather than handed to the frame as a URL: SharePoint
     serves these with a Content-Disposition that makes a browser download a PDF
     instead of rendering it, and the pre-authed link is a credential that has no
     business sitting in an iframe's src where it lands in history. A blob is
     same-origin, renders inline, and dies with the page. */
  async function show(i) {
    var files = state.data.files;
    var f = files[i];
    if (!f) return;
    state.active = i;
    document.querySelectorAll("[data-f]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(Number(b.getAttribute("data-f")) === i));
    });
    var stage = el("blStage"), bar = el("blViewBar");
    var kind = viewable(f);
    bar.innerHTML = esc(f.name) + " · " + esc(kb(f.size)) +
      ' · <a href="#" id="blDl">Download</a>' +
      (f.webUrl ? ' · <a href="' + esc(f.webUrl) + '" target="_blank" rel="noopener">Open in SharePoint &#8599;</a>' : "");
    var dl = el("blDl");
    if (dl) dl.onclick = function (e) { e.preventDefault(); window.open(f.url, "_blank", "noopener"); };

    if (!kind) {
      stage.innerHTML = '<div class="msg"><b>' + esc(f.name) + "</b><br>" +
        "This kind of file cannot be shown in the browser. Download it to look at it.</div>";
      return;
    }

    stage.innerHTML = '<div class="msg">Opening ' + esc(f.name) + "…</div>";
    var url;
    try {
      var r = await fetch(f.url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      var blob = await r.blob();
      // A PDF served as octet-stream is still a PDF; the frame needs the type.
      if (kind === "pdf" && blob.type !== "application/pdf") {
        blob = new Blob([blob], { type: "application/pdf" });
      }
      url = URL.createObjectURL(blob);
      state.objectUrls.push(url);
    } catch (e) {
      stage.innerHTML = '<div class="msg" style="color:var(--err)">Could not open that file here. ' +
        "Use Download or Open in SharePoint.</div>";
      return;
    }
    stage.innerHTML = kind === "pdf"
      ? '<iframe title="' + esc(f.name) + '" src="' + url + '#view=FitH"></iframe>'
      : '<img alt="' + esc(f.name) + '" src="' + url + '">';
  }

  async function approve() {
    var b = state.data.bill;
    var go = el("blGo"), msg = el("blMsg");
    var note = (el("blNote") || {}).value || "";
    var sure = await DCR.confirm(
      "Approve " + money(b.expenseAmount) + " to " +
      (b.expenseVendorCompany || b.expenseVendorName || "this vendor") + " for payment? " +
      "Your name and today's date are recorded against the bill.",
      { title: "Approve for payment", okText: "Approve" });
    if (!sure) return;

    go.disabled = true;
    msg.textContent = "Approving…";
    msg.className = "bl-msg";
    try {
      var r = await DCR.api("/api/portal?action=project", { method: "POST",
        body: { op: "billApprove", itemId: b.id, note: note } });
      if (r && r.alreadyApproved) {
        msg.textContent = "It was already approved by " + (r.approvedByName || "somebody else") + ".";
      }
      await load();
    } catch (e) {
      msg.textContent = e.message || "That could not be approved.";
      msg.className = "bl-msg err";
      go.disabled = false;
    }
  }

  async function load() {
    // A reload replaces every frame, so the old blobs are dead weight.
    state.objectUrls.splice(0).forEach(function (u) { URL.revokeObjectURL(u); });
    try {
      state.data = await DCR.api("/api/portal?action=project&part=bill&id=" +
        encodeURIComponent(PID) + "&bill=" + encodeURIComponent(BID));
      render();
    } catch (e) {
      el("blRoot").innerHTML = '<div class="bl-card" style="color:var(--err)">' +
        esc(e.message || "Could not load that invoice.") +
        '</div><a class="bl-secondary" href="dashboard.html" style="max-width:320px">' +
        "Back to the approvals list</a>";
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };
    if (!PID || !BID) {
      el("blRoot").innerHTML = '<div class="bl-card">No invoice was named. ' +
        '<a href="dashboard.html">Back to the approvals list</a>.</div>';
      return;
    }
    load();
  });
})();
