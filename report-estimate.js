/* DCR portal — printable Estimate (web port of GeneralProjectTasks-Printout-EstimateView;
   the "Hide prices" toggle doubles as the ForWorksite copy). Frontend-only:
   data via action=project (record + part=estimate). */

(function () {
  var qs = new URLSearchParams(location.search);
  var PID = qs.get("id");
  var LOGO = "https://images.squarespace-cdn.com/content/62d99cb9f61a1a1ab61df5b3/b0c22d61-35f1-4aa4-bde5-17d8999f66c6/logo+black.png?content-type=image%2Fpng";
  var DEFAULT_TERMS = "Estimate valid for 30 days. Prices include labor and materials as listed. " +
    "Any changes to the scope of work may affect the final price. A signed copy of this estimate " +
    "is required to schedule work.";

  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  function money(n){ return "$" + (Number(n)||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function num(v){ var n=parseFloat(String(v??"").replace(/[$,]/g,"")); return isFinite(n)?n:0; }
  function today(){ return new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"}); }

  function lineDesc(r, hideDetail) {
    var parts = [];
    if (r.taskLaborName) {
      var d = esc(r.taskLaborName);
      var bits = [];
      if (num(r.taskLaborNumberOfGuys)) bits.push(r.taskLaborNumberOfGuys + " guys × " + (r.taskLaborDaysToComplete||0) + " days @ " + money(r.taskLaborPricePerHour) + "/hr");
      if (num(r.taskLaborPrice)) bits.push((r.taskLaborQty||1) + " × " + money(r.taskLaborPrice));
      if (bits.length) d += ' <span class="lineb labor-detail">(' + bits.join("; ") + ")</span>";
      parts.push(d);
    }
    if (r.taskMaterialName) {
      var m = esc(r.taskMaterialName);
      if (num(r.taskMaterialQty)) m += ' <span class="lineb">(' + r.taskMaterialQty + " × " + money(r.taskMaterialUnitPrice) + ")</span>";
      parts.push(m);
    }
    if (r.taskEstimateNotes) parts.push('<span class="lineb">' + esc(r.taskEstimateNotes) + "</span>");
    return parts.join("<br>") || "—";
  }

  function render(p, rows) {
    document.title = "DCR Estimate — " + (p.internalIDNumber || "") + " " + (p.projectName || "");
    el("rpBack").href = "project.html?id=" + encodeURIComponent(PID) + "&tab=estimate";

    var groups = {};
    rows.forEach(function (r) { var g = r.taskGroupingName || "General"; (groups[g] = groups[g] || []).push(r); });
    var grand = 0;
    var bodyHtml = Object.keys(groups).map(function (g) {
      var gt = 0;
      var lines = groups[g].map(function (r) {
        gt += r.TaskGrandTotalMaterialAndLabor;
        return "<tr><td>" + lineDesc(r) + '</td><td class="amt">' + money(r.TaskGrandTotalMaterialAndLabor) + "</td></tr>";
      }).join("");
      grand += gt;
      return '<tbody class="group-block"><tr class="grp"><td colspan="2">' + esc(g) + "</td></tr>" + lines +
        '<tr class="sub"><td>Subtotal — ' + esc(g) + '</td><td class="amt">' + money(gt) + "</td></tr></tbody>";
    }).join("");

    el("rpSheet").innerHTML =
      '<div class="lh"><img src="' + LOGO + '" alt="DCR Framing" />' +
      '<div class="co"><b>DCR Framing</b><br>www.dcrframing.com<br>cristobal@dcrframing.com</div></div>' +
      '<div class="rp-title"><h1>ESTIMATE</h1><div class="meta">' +
        "Project #: <b>" + esc(p.internalIDNumber || "—") + "</b><br>Date: " + today() + "</div></div>" +
      '<div class="blocks">' +
        '<div class="blk"><h4>Prepared for</h4><div><b>' + esc(p.projectClientName || "—") + "</b>" +
          (p.projectPhoneNumber ? "<br>" + esc(p.projectPhoneNumber) : "") +
          (p.projectEmailAddress ? "<br>" + esc(p.projectEmailAddress) : "") + "</div></div>" +
        '<div class="blk"><h4>Project</h4><div><b>' + esc(p.projectName || "—") + "</b>" +
          (p.projectAddress ? "<br>" + esc(p.projectAddress) : "") +
          (p.projectCity ? "<br>" + esc(p.projectCity) : "") + "</div></div></div>" +
      '<table class="est"><thead><tr><th>Description of work</th><th class="amt">Amount</th></tr></thead>' +
        bodyHtml +
        '<tbody><tr class="grand"><td>GRAND TOTAL</td><td class="amt">' + money(grand) + "</td></tr></tbody></table>" +
      '<div class="terms" contenteditable="true" spellcheck="false"><h4>Terms &amp; Notes</h4>' +
        esc(p.estimateTerms || p.estimateWording || DEFAULT_TERMS).replace(/\n/g, "<br>") + "</div>" +
      '<div class="sig"><div>Client signature / date</div><div>DCR Framing / date</div></div>' +
      '<div class="foot">Generated ' + today() + " · " + esc(p.internalIDNumber || "") + " — " + esc(p.projectName || "") + "</div>";
  }

  document.addEventListener("DOMContentLoaded", async function () {
    await DCR.requireAuth();
    if (!PID) { el("rpSheet").innerHTML = '<div class="rp-loading">No project selected.</div>'; return; }
    el("rpNoPrices").onchange = function () { el("rpSheet").classList.toggle("noprices", this.checked); };
    el("rpNoDetail").onchange = function () { el("rpSheet").classList.toggle("nodetail", this.checked); };
    try {
      var results = await Promise.all([
        DCR.api("/api/portal?action=project&id=" + encodeURIComponent(PID)),
        DCR.api("/api/portal?action=project&id=" + encodeURIComponent(PID) + "&part=estimate"),
      ]);
      render(results[0].project, results[1].rows || []);
    } catch (e) {
      el("rpSheet").innerHTML = '<div class="rp-loading">' + esc(e.message || "Could not load estimate.") + "</div>";
    }
  });
})();
