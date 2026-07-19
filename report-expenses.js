/* DCR portal — printable project Expense Report (web port of
   ProjectExpenseAnalisisPrint). Frontend-only: action=project record + part=expenses. */

(function () {
  var qs = new URLSearchParams(location.search);
  var PID = qs.get("id");
  var LOGO = "https://images.squarespace-cdn.com/content/62d99cb9f61a1a1ab61df5b3/b0c22d61-35f1-4aa4-bde5-17d8999f66c6/logo+black.png?content-type=image%2Fpng";

  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  function money(n){ return "$" + (Number(n)||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function num(v){ var n=parseFloat(String(v??"").replace(/[$,]/g,"")); return isFinite(n)?n:0; }
  function fmtDate(v){ if(!v)return ""; var d=new Date(v); return isNaN(d)?"":d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); }
  function today(){ return new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"}); }

  function render(p, rows) {
    document.title = "DCR Expenses — " + (p.internalIDNumber || "") + " " + (p.projectName || "");
    el("rpBack").href = "project.html?id=" + encodeURIComponent(PID) + "&tab=expenses";

    var groups = {};
    rows.forEach(function (r) { var g = r.gropingName || "(no group)"; (groups[g] = groups[g] || []).push(r); });
    var grand = { est: 0, inv: 0, mat: 0, con: 0 };

    var bodyHtml = Object.keys(groups).map(function (g) {
      var t = { est: 0, inv: 0, mat: 0, con: 0 };
      var lines = groups[g].map(function (r) {
        var desc = r.description || r.laborExpenseDescription || r.materialExpenseDescription || r.estimateDescription || "";
        t.est += num(r.estimate); t.inv += num(r.invoice); t.mat += num(r.materials); t.con += num(r.contractors);
        return "<tr><td style='width:80px'>" + fmtDate(r.expenseDate) + "</td><td>" + esc(desc) +
          (r.remarks ? "<br><span style='font-size:10px;color:#555'>" + esc(r.remarks) + "</span>" : "") + "</td>" +
          '<td class="amt">' + (num(r.estimate) ? money(r.estimate) : "") + "</td>" +
          '<td class="amt">' + (num(r.invoice) ? money(r.invoice) : "") + "</td>" +
          '<td class="amt">' + (num(r.materials) ? money(r.materials) : "") + "</td>" +
          '<td class="amt">' + (num(r.contractors) ? money(r.contractors) : "") + "</td></tr>";
      }).join("");
      Object.keys(t).forEach(function (k) { grand[k] += t[k]; });
      return '<tbody class="group-block"><tr class="grp"><td colspan="6">' + esc(g) + "</td></tr>" + lines +
        '<tr class="sub"><td colspan="2">Subtotal — ' + esc(g) + "</td>" +
        '<td class="amt">' + money(t.est) + '</td><td class="amt">' + money(t.inv) + "</td>" +
        '<td class="amt">' + money(t.mat) + '</td><td class="amt">' + money(t.con) + "</td></tr></tbody>";
    }).join("");

    el("rpSheet").innerHTML =
      '<div class="lh"><img src="' + LOGO + '" alt="DCR Framing" /><h1>EXPENSE REPORT</h1></div>' +
      '<div class="who"><div>Project: <b>' + esc((p.internalIDNumber || "") + " — " + (p.projectName || "")) + "</b><br>" +
        esc([p.projectAddress, p.projectCity].filter(Boolean).join(", ")) + "</div>" +
      "<div style='text-align:right'>Client: <b>" + esc(p.projectClientName || "—") + "</b><br>Date: " + today() + "</div></div>" +
      '<table class="ex"><thead><tr><th>Date</th><th>Description</th><th class="amt">Estimate</th>' +
        '<th class="amt">Invoice</th><th class="amt">Materials</th><th class="amt">Contractors</th></tr></thead>' +
        bodyHtml +
        '<tbody><tr class="grand"><td colspan="2">GRAND TOTAL</td>' +
        '<td class="amt">' + money(grand.est) + '</td><td class="amt">' + money(grand.inv) + "</td>" +
        '<td class="amt">' + money(grand.mat) + '</td><td class="amt">' + money(grand.con) + "</td></tr></tbody></table>" +
      '<div class="foot">Generated ' + today() + " · DCR Framing · " + rows.length + " expense records</div>";
  }

  document.addEventListener("DOMContentLoaded", async function () {
    await DCR.requireAuth();
    if (!PID) { el("rpSheet").innerHTML = '<div class="rp-loading">No project selected.</div>'; return; }
    try {
      var results = await Promise.all([
        DCR.api("/api/portal?action=project&id=" + encodeURIComponent(PID)),
        DCR.api("/api/portal?action=project&id=" + encodeURIComponent(PID) + "&part=expenses"),
      ]);
      var rows = results[1].rows || [];
      if (!rows.length) {
        el("rpSheet").innerHTML = '<div class="rp-loading">This project has no expense records.</div>';
        return;
      }
      render(results[0].project, rows);
    } catch (e) {
      el("rpSheet").innerHTML = '<div class="rp-loading">' + esc(e.message || "Could not load expenses.") + "</div>";
    }
  });
})();
