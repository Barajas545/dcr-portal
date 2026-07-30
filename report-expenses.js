/* DCR portal — printable project Expense Report (web port of
   ProjectExpenseAnalisisPrint). Frontend-only: action=project record + part=expenses.

   Prints the same view the Expenses tab shows: the tab's Print link passes its
   filter on the query string (group/range/from/to/q/sort/dir, plus the already
   resolved pa/pb window so a relative period can't shift on the way here), and
   ALL of the filter semantics live in expense-filter.js — never re-implement
   them here or the sheet will stop matching the screen. Opened without those
   params (a bookmark) it prints everything, as it always did. */

(function () {
  var qs = new URLSearchParams(location.search);
  var PID = qs.get("id");
  var CO = DCR.companyInfo;
  var LOGO = CO.logo;
  var F = null;   // the filter — resolved inside DOMContentLoaded, never at parse time

  function coBlock() {
    var lines = ["<b>" + DCR.esc(CO.legalName || CO.name) + "</b>"];
    if (CO.address) lines.push(DCR.esc(CO.address));
    var pf = [CO.phone ? "Ph " + CO.phone : "", CO.fax ? "Fax " + CO.fax : ""].filter(Boolean).join(" · ");
    if (pf) lines.push(DCR.esc(pf));
    if (CO.license) lines.push(DCR.esc(CO.license));
    if (CO.website) lines.push(DCR.esc(CO.website));
    return lines.join("<br>");
  }

  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  function money(n){ return DCR.exp.money(n); }
  function num(v){ return DCR.exp.num(v); }
  function fmtDate(v){ return DCR.exp.fmtDay(v); }
  function today(){ return new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"}); }
  function backHref(){ return DCR.exp.hrefWith("project.html", { id: PID, tab: "expenses" }, F || DCR.exp.defaults()); }

  function render(p, rows, allCount) {
    document.title = "DCR Expenses — " + (p.internalIDNumber || "") + " " + (p.projectName || "");

    var filtered = DCR.exp.isActive(F);
    var bodyHtml = DCR.exp.group(rows).map(function (b) {
      var t = DCR.exp.totals(b.rows);
      var lines = b.rows.map(function (r) {
        return '<tr><td class="dt">' + fmtDate(r.expenseDate) + "</td><td>" + DCR.exp.escML(DCR.exp.descOf(r)) +
          (r.remarks ? "<br><span style='font-size:10px;color:#555'>" + DCR.exp.escML(r.remarks) + "</span>" : "") + "</td>" +
          '<td class="amt">' + (num(r.estimate) ? money(r.estimate) : "") + "</td>" +
          '<td class="amt">' + (num(r.invoice) ? money(r.invoice) : "") + "</td>" +
          '<td class="amt">' + (num(r.materials) ? money(r.materials) : "") + "</td>" +
          '<td class="amt">' + (num(r.contractors) ? money(r.contractors) : "") + "</td></tr>";
      }).join("");
      return '<tbody class="group-block"><tr class="grp"><td colspan="6">' + esc(b.name) + "</td></tr>" + lines +
        '<tr class="sub"><td colspan="2">Subtotal — ' + esc(b.name) + "</td>" +
        '<td class="amt">' + money(t.est) + '</td><td class="amt">' + money(t.inv) + "</td>" +
        '<td class="amt">' + money(t.mat) + '</td><td class="amt">' + money(t.con) + "</td></tr></tbody>";
    }).join("");
    // one pass over the printed rows, not a fold of the subtotals, so this
    // matches the tab's total to the cent
    var grand = DCR.exp.totals(rows);

    el("rpSheet").innerHTML =
      '<div class="lh"><img src="' + LOGO + '" alt="' + esc(CO.name) + '" />' +
      '<div style="font-size:9.5px;color:#333;line-height:1.5;text-align:center">' + coBlock() + "</div>" +
      "<h1>EXPENSE REPORT</h1></div>" +
      '<div class="who"><div>Project: <b>' + esc((p.internalIDNumber || "") + " — " + (p.projectName || "")) + "</b><br>" +
        esc([p.projectAddress, p.projectCity].filter(Boolean).join(", ")) + "</div>" +
      "<div style='text-align:right'>Client: <b>" + esc(p.projectClientName || "—") + "</b><br>Date: " + today() + "</div></div>" +
      (filtered ? '<div class="filt"><b>Filtered:</b> ' + esc(DCR.exp.label(F)) +
        "<br>Showing " + rows.length + " of " + allCount + " expense records</div>" : "") +
      '<table class="ex"><thead><tr><th>Date</th><th>Description</th><th class="amt">Estimate</th>' +
        '<th class="amt">Invoice</th><th class="amt">Materials</th><th class="amt">Contractors</th></tr></thead>' +
        bodyHtml +
        '<tbody><tr class="grand"><td colspan="2">' + (filtered ? "FILTERED TOTAL" : "GRAND TOTAL") + "</td>" +
        '<td class="amt">' + money(grand.est) + '</td><td class="amt">' + money(grand.inv) + "</td>" +
        '<td class="amt">' + money(grand.mat) + '</td><td class="amt">' + money(grand.con) + "</td></tr></tbody></table>" +
      '<div class="foot">Generated ' + today() + " · " + esc(CO.name) + " · " + rows.length +
        (rows.length !== allCount ? " of " + allCount : "") + " expense records</div>";
  }

  document.addEventListener("DOMContentLoaded", async function () {
    await DCR.requireAuth();
    if (!DCR.exp) {
      el("rpSheet").innerHTML = '<div class="rp-loading">Report helper failed to load — please refresh.</div>';
      return;
    }
    if (!PID) { el("rpSheet").innerHTML = '<div class="rp-loading">No project selected.</div>'; return; }
    // The filter comes from the query string ONLY — a bookmarked link must never
    // inherit some other tab's saved filter and quietly print a subset.
    F = DCR.exp.fromQuery(qs) || DCR.exp.defaults();
    // Set Back before the fetch: the no-rows, no-match and error paths return
    // early, and every one of them should still lead back to the same view.
    el("rpBack").href = backHref();
    try {
      var results = await Promise.all([
        DCR.api("/api/portal?action=project&id=" + encodeURIComponent(PID)),
        DCR.api("/api/portal?action=project&id=" + encodeURIComponent(PID) + "&part=expenses"),
      ]);
      var allRows = results[1].rows || [];
      if (!allRows.length) {
        el("rpSheet").innerHTML = '<div class="rp-loading">This project has no expense records.</div>';
        return;
      }
      var rows = DCR.exp.sort(DCR.exp.filter(allRows, F), F);
      if (!rows.length) {
        el("rpSheet").innerHTML = '<div class="rp-loading">No expense records match these filters.' +
          '<div style="margin-top:8px;font-size:12px">' + esc(DCR.exp.label(F)) + "</div></div>";
        return;
      }
      render(results[0].project, rows, allRows.length);
    } catch (e) {
      el("rpSheet").innerHTML = '<div class="rp-loading">' + esc(e.message || "Could not load expenses.") + "</div>";
    }
  });
})();
