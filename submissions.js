/* The review queue for what subcontractors send through the public form.

   Accepting is the moment an outside claim becomes an inside record: an invoice
   becomes a bill that then goes through the ordinary approval gate, a change
   order becomes a commitment the job is measured against. The server decides
   both; this screen only ever asks. */
(function () {
  "use strict";
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var state = { tab: "Pending", rows: [], counts: {}, quotes: {} };

  function money(v) {
    return "$" + (Number(v) || 0).toLocaleString("en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  /* The commitments on one project, so an invoice can be filed against the
     quote it bills. Fetched per project only when a card needs it — the queue
     is usually two or three jobs, not forty. */
  async function quotesFor(projectId) {
    if (state.quotes[projectId]) return state.quotes[projectId];
    try {
      var d = await DCR.api("/api/portal?action=pm&id=" + encodeURIComponent(projectId));
      state.quotes[projectId] = (d.quotes || []).filter(function (q) {
        return q.quoteStatus === "Awarded" || q.quoteKind === "Change order";
      });
    } catch (e) { state.quotes[projectId] = []; }
    return state.quotes[projectId];
  }

  function card(r) {
    var pending = r.state === "Pending";
    var isCo = r.kind === "Change order";
    var h = '<div class="sb-card' + (pending ? " pending" : "") + '" data-id="' + esc(r.id) + '">';

    h += '<div class="sb-top"><div>' +
      '<span class="sb-who">' + esc(r.vendorCompany || "(no company)") + "</span>" +
      '<span class="sb-kind ' + (isCo ? "co" : "inv") + '">' +
        (isCo ? "CHANGE ORDER" : "INVOICE") + "</span>" +
      '<div class="sb-meta">' + esc(r.projectLabel || "(no project)") +
        (r.invoiceNumber ? " · #" + esc(r.invoiceNumber) : "") +
        (r.dueDate ? " · due " + esc(r.dueDate) : "") +
        " · " + esc(r.reference) + "</div>" +
      '<div class="sb-meta">' + esc(r.contactName) +
        (r.contactEmail ? ' &lt;<a href="mailto:' + esc(r.contactEmail) + '">' +
          esc(r.contactEmail) + "</a>&gt;" : "") +
        (r.contactPhone ? " · " + esc(r.contactPhone) : "") +
        (r.created ? " · sent " + esc(when(r.created)) : "") + "</div>" +
      "</div>" +
      '<div class="sb-amt">' + money(r.amount) + "</div></div>";

    if (r.description) h += '<div class="sb-desc">' + esc(r.description) + "</div>";

    h += '<div class="sb-files">';
    h += r.documentItemId
      ? '<a href="#" data-doc="' + esc(r.documentItemId) + '">&#128206; ' +
        esc(r.documentName || "the document") + "</a>"
      : '<span class="sb-nodoc">No document attached</span>';
    h += '<span class="sb-nodoc" style="color:var(--text-muted);border-color:var(--border);font-weight:400">' +
      "Signed by " + esc(r.signatureName || "—") +
      (r.signedAt ? " on " + esc(when(r.signedAt)) : "") +
      (r.submittedFrom ? " from " + esc(r.submittedFrom) : "") + "</span>";
    if (r.signatureItemId) {
      h += '<a href="#" data-doc="' + esc(r.signatureItemId) + '">&#9997; view signature</a>';
    }
    h += "</div>";

    /* If the email never went out, say so here. Somebody reading this queue is
       the only person who can act on that, and a silent failure would mean the
       submission sat unnoticed until the sub rang up. */
    if (pending && r.notifyState && !/^sent to /.test(r.notifyState)) {
      h += '<div class="sb-warn">&#9888; Nobody was emailed about this: ' +
        esc(r.notifyState) + "</div>";
    }

    if (pending) {
      h += '<div class="sb-acts">';
      if (!isCo) {
        h += '<select data-q="' + esc(r.id) + '"><option value="">Loading quotes…</option></select>';
      }
      h += '<input type="text" data-note="' + esc(r.id) + '" placeholder="Note (optional)">' +
        '<button class="btn-accept" data-accept="' + esc(r.id) + '">&#10003; ' +
          (isCo ? "Accept as a change order" : "Accept as a bill") + "</button>" +
        '<button class="btn-reject" data-reject="' + esc(r.id) + '">Reject</button>' +
        "</div>";
      h += '<div class="sb-msg" data-msg="' + esc(r.id) + '"></div>';
    } else {
      h += '<div class="sb-done">' + esc(r.state) +
        (r.reviewedBy ? " by " + esc(r.reviewedBy) : "") +
        (r.reviewedAt ? " on " + esc(when(r.reviewedAt)) : "") +
        (r.reviewNote ? " — " + esc(r.reviewNote) : "") +
        (r.linkedExpenseId ? " · record " + esc(r.linkedExpenseId) : "") + "</div>";
    }
    return h + "</div>";
  }

  function render() {
    var box = el("sbList");
    if (!state.rows.length) {
      box.innerHTML = '<div class="sb-empty">' +
        (state.tab === "Pending"
          ? "Nothing waiting. Anything a subcontractor sends through the form lands here."
          : "Nothing here.") + "</div>";
      return;
    }
    box.innerHTML = state.rows.map(card).join("");

    box.querySelectorAll("[data-doc]").forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); openDoc(a.getAttribute("data-doc")); };
    });
    box.querySelectorAll("[data-accept]").forEach(function (b) {
      b.onclick = function () { act(b.getAttribute("data-accept"), "accept"); };
    });
    box.querySelectorAll("[data-reject]").forEach(function (b) {
      b.onclick = function () { act(b.getAttribute("data-reject"), "reject"); };
    });
    // fill the commitment pickers, one project at a time
    box.querySelectorAll("[data-q]").forEach(async function (sel) {
      var row = state.rows.find(function (r) { return String(r.id) === sel.getAttribute("data-q"); });
      if (!row) return;
      var qs = await quotesFor(row.projectID);
      sel.innerHTML = '<option value="">— not against a quote —</option>' +
        qs.map(function (q) {
          return '<option value="' + esc(q.id) + '">' +
            esc((q.quoteKind === "Change order" ? "CO · " : "Quote · ") +
                (q.vendorCompany || q.vendorName || "vendor") +
                (Number(q.quoteAmount) > 0 ? " · " + money(q.quoteAmount) : "")) + "</option>";
        }).join("");
    });
  }

  /* The document opens through the same pre-authed link the rest of the portal
     uses, so the bytes never pass through the API. */
  async function openDoc(id) {
    try {
      var info = await DCR.api("/api/portal?action=drive&fileInfo=" + encodeURIComponent(id));
      window.open(info.downloadUrl || info.webUrl, "_blank", "noopener");
    } catch (e) { DCR.alert(e.message || "Could not open that document."); }
  }

  async function act(id, op) {
    var msg = document.querySelector('[data-msg="' + id + '"]');
    var row = state.rows.find(function (r) { return String(r.id) === String(id); });
    if (!row) return;

    if (op === "reject") {
      var sure = await DCR.confirm(
        "Reject this " + row.kind.toLowerCase() + " from " + row.vendorCompany + "? " +
        "They are not told automatically — you will need to reply to them.",
        { title: "Reject submission", danger: true, okText: "Reject" });
      if (!sure) return;
    }

    var sel = document.querySelector('[data-q="' + id + '"]');
    var note = document.querySelector('[data-note="' + id + '"]');
    document.querySelectorAll('[data-accept="' + id + '"],[data-reject="' + id + '"]')
      .forEach(function (b) { b.disabled = true; });
    if (msg) { msg.textContent = op === "accept" ? "Filing it…" : "Rejecting…"; msg.className = "sb-msg"; }

    try {
      await DCR.api("/api/portal?action=submissions", { method: "POST", body: {
        op: op, itemId: id,
        quoteID: sel ? sel.value : "",
        note: note ? note.value : "",
      } });
      await load();
    } catch (e) {
      if (msg) { msg.textContent = e.message || "That did not work."; msg.className = "sb-msg err"; }
      document.querySelectorAll('[data-accept="' + id + '"],[data-reject="' + id + '"]')
        .forEach(function (b) { b.disabled = false; });
    }
  }

  async function load() {
    try {
      var d = await DCR.api("/api/portal?action=submissions&state=" + encodeURIComponent(state.tab));
      state.rows = d.submissions || [];
      state.counts = d.counts || {};
      el("sbCount").textContent = (state.counts.pending || 0) + " waiting";
      render();
    } catch (e) {
      el("sbList").innerHTML = '<div class="sb-empty" style="color:var(--err)">' +
        esc(e.message || "Could not load submissions.") + "</div>";
    }
  }

  function tab(name) {
    state.tab = name;
    ["Pending", "Accepted", "Rejected"].forEach(function (t) {
      el("sbTab" + t).setAttribute("aria-pressed", String(t === name));
    });
    el("sbList").innerHTML = '<div class="sb-empty">Loading…</div>';
    load();
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };
    el("sbTabPending").onclick = function () { tab("Pending"); };
    el("sbTabAccepted").onclick = function () { tab("Accepted"); };
    el("sbTabRejected").onclick = function () { tab("Rejected"); };
    el("sbRefresh").onclick = load;
    load();
  });
})();
