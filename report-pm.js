/* Printable project status report — same data, same PMChart engine, paper
   layout: letterhead + compact chart + item table with totals. */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var C = window.PMChart;
  var PID = new URLSearchParams(location.search).get("id");
  var hideMoney = false;
  var payload = null;

  function money(n) { return hideMoney ? "" : C.money(n || 0); }

  function render() {
    var m = C.derive(payload, { expandedA: true, expandedB: true });
    var proj = m.project;
    var co = DCR.companyInfo || {};
    var L = C.layout(m, { compact: true });
    var lanes = m.lanes;

    var rows = lanes.map(function (l) {
      var awardedTo = [];
      l.quotes.forEach(function (q) {
        if (q.quoteStatus === "Awarded") awardedTo.push(q.vendorCompany || q.vendorName || "");
        if (q.quoteStatus === "Self") awardedTo.push("Self-performed");
      });
      var st = l.flag && l.flag.state === "blocked" ? "BLOCKED — " + (l.flag.note || "")
        : l.flag && l.flag.state === "complete" ? "Complete"
        : l.pctB >= 100 ? "Paid" : l.invoiced > 0 ? "Invoicing" : l.awarded > 0 ? "In progress"
        : l.requests ? "Bidding" : l.priced ? "Priced" : "Not started";
      return '<tr><td><span class="gdot" style="background:var(--gc' + (l.colorSlot || 0) + ')"></span>' + esc(l.groupingName) +
        (l.estimateName ? ' <span style="color:var(--text-muted)">· ' + esc(l.estimateName) + "</span>" : "") + "</td>" +
        "<td>" + esc(l.assignees.map(function (a) { return a.name || a.email; }).join(", ") || "—") + "</td>" +
        '<td class="num">' + l.quotes.filter(function (q) { return q.quoteStatus !== "Self"; }).length + "</td>" +
        "<td>" + esc(awardedTo.join(", ") || "—") + "</td>" +
        '<td class="num">' + money(l.estTotal) + "</td>" +
        '<td class="num">' + money(l.awarded) + "</td>" +
        '<td class="num">' + money(l.invoiced) + "</td>" +
        '<td class="num">' + money(l.paid) + "</td>" +
        "<td>" + esc(st) + "</td></tr>";
    }).join("");
    var tot = { est: 0, aw: 0, inv: 0, paid: 0 };
    lanes.forEach(function (l) { tot.est += l.estTotal || 0; tot.aw += l.awarded || 0; tot.inv += l.invoiced || 0; tot.paid += l.paid || 0; });

    el("rpSheet").innerHTML =
      '<div class="lh">' +
        (co.logo ? '<img src="' + esc(co.logo) + '" alt="">' : "") +
        '<div class="co">' + esc(co.legalName || co.name || "DCR") +
          (co.address ? "<br>" + esc(co.address) : "") +
          (co.phone ? "<br>" + esc(co.phone) : "") + (co.license ? " · Lic. " + esc(co.license) : "") + "</div>" +
        '<div class="sp"></div>' +
        '<div class="ttl"><b>PROJECT STATUS</b><br><span style="font-size:12.5px">' +
          esc((proj.internalIDNumber || "") + " — " + (proj.projectName || "")) + "</span><br>" +
          '<span style="font-size:11px;color:var(--text-muted)">' + new Date().toLocaleDateString() + "</span></div>" +
      "</div>" +
      '<div class="meta">' + esc([proj.projectAddress, proj.projectCity, proj.projectClientName].filter(Boolean).join(" · ")) +
        " · Stage: <b>" + esc(m.status || "—") + "</b> · Overall <b>" + m.overall + "%</b>" +
        (hideMoney ? " · prices hidden" : "") + "</div>" +
      '<div class="chartwrap">' + C.svg(m, L, { interactive: false }) + "</div>" +
      "<h2>Estimated items — " + lanes.length + "</h2>" +
      "<table><thead><tr><th>Item</th><th>Assigned</th><th class=\"num\">Quotes</th><th>Awarded to</th>" +
      '<th class="num">Estimate</th><th class="num">Awarded</th><th class="num">Invoiced</th><th class="num">Paid</th><th>Status</th></tr></thead>' +
      "<tbody>" + rows +
      '<tr class="tot"><td colspan="4">Totals</td><td class="num">' + money(tot.est) + '</td><td class="num">' + money(tot.aw) +
      '</td><td class="num">' + money(tot.inv) + '</td><td class="num">' + money(tot.paid) + "</td><td></td></tr>" +
      "</tbody></table>";
  }

  document.addEventListener("DOMContentLoaded", async function () {
    await DCR.requireAuth();
    if (!PID) { el("rpSheet").textContent = "Missing ?id="; return; }
    el("rpBack").href = "pm.html?id=" + encodeURIComponent(PID);
    el("rpPrint").onclick = function () { window.print(); };
    el("rpHideMoney").onchange = function () { hideMoney = this.checked; render(); };
    try {
      payload = await DCR.api("/api/portal?action=pm&id=" + encodeURIComponent(PID));
      if (payload.pricesHidden) { hideMoney = true; el("rpHideMoney").checked = true; el("rpHideMoney").disabled = true; }
      render();
    } catch (e) {
      el("rpSheet").textContent = e.message || "Could not load.";
    }
  });
})();
