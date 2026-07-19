/* DCR portal — printable Estimate (web port of GeneralProjectTasks-Printout-EstimateView;
   the "Hide prices" toggle doubles as the ForWorksite copy). Frontend-only:
   data via action=project (record + part=estimate). */

(function () {
  var qs = new URLSearchParams(location.search);
  var PID = qs.get("id");
  var CO = DCR.companyInfo;
  var LOGO = CO.logo;

  // Letterhead company block from config.js — empty fields are hidden.
  function coBlock() {
    var lines = [];
    lines.push("<b>" + DCR.esc(CO.legalName || CO.name) + "</b>");
    if (CO.address) lines.push(DCR.esc(CO.address));
    var pf = [CO.phone ? "Ph " + CO.phone : "", CO.fax ? "Fax " + CO.fax : ""].filter(Boolean).join(" · ");
    if (pf) lines.push(DCR.esc(pf));
    if (CO.license) lines.push(DCR.esc(CO.license));
    if (CO.website) lines.push(DCR.esc(CO.website));
    if (CO.email) lines.push(DCR.esc(CO.email));
    return lines.join("<br>");
  }
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

    // Sections per estimate name → groups → (server-sorted by sorting number).
    var secs = [], secIdx = {};
    rows.forEach(function (r) {
      var sn = r.taskEstimateName || "";
      if (!(sn in secIdx)) { secIdx[sn] = secs.length; secs.push({ name: sn, groups: [], gIdx: {} }); }
      var s = secs[secIdx[sn]];
      var g = r.taskGroupingName || "General";
      if (!(g in s.gIdx)) { s.gIdx[g] = s.groups.length; s.groups.push({ name: g, rows: [] }); }
      s.groups[s.gIdx[g]].rows.push(r);
    });
    var showSecHead = secs.length > 1 || (secs.length === 1 && secs[0].name);
    var grand = 0;
    var bodyHtml = secs.map(function (s) {
      var st = 0;
      var groupsHtml = s.groups.map(function (gr) {
        var gt = 0;
        var lines = gr.rows.map(function (r) {
          gt += r.TaskGrandTotalMaterialAndLabor;
          return "<tr><td>" + lineDesc(r) + '</td><td class="amt">' + money(r.TaskGrandTotalMaterialAndLabor) + "</td></tr>";
        }).join("");
        st += gt;
        return '<tbody class="group-block"><tr class="grp"><td colspan="2">' + esc(gr.name) + "</td></tr>" + lines +
          '<tr class="sub"><td>Subtotal — ' + esc(gr.name) + '</td><td class="amt">' + money(gt) + "</td></tr></tbody>";
      }).join("");
      grand += st;
      var head = showSecHead
        ? '<tbody><tr class="grp" style="background:#e3e3e3;font-size:13.5px"><td colspan="2">' + esc(s.name || "Estimate") + "</td></tr></tbody>"
        : "";
      var foot = showSecHead && secs.length > 1
        ? '<tbody><tr class="sub"><td>Estimate total — ' + esc(s.name || "Estimate") + '</td><td class="amt">' + money(st) + "</td></tr></tbody>"
        : "";
      return head + groupsHtml + foot;
    }).join("");

    el("rpSheet").innerHTML =
      '<div class="lh"><img src="' + LOGO + '" alt="' + esc(CO.name) + '" />' +
      '<div class="co">' + coBlock() + "</div></div>" +
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
      '<div class="sig"><div>Client signature / date</div><div>' + esc(CO.name) + ' / date</div></div>' +
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
      var proj = results[0].project;
      var allRows = results[1].rows || [];
      // Estimate picker: print one named estimate (e.g. a change order) or all.
      var names = [];
      allRows.forEach(function (r) {
        var n = r.taskEstimateName || "";
        if (names.indexOf(n) === -1) names.push(n);
      });
      var sel = el("rpEstSel");
      if (names.length > 1) {
        sel.style.display = "";
        sel.innerHTML = '<option value="*">All estimates</option>' + names.map(function (n) {
          return '<option value="' + esc(n) + '">' + esc(n || "(no name)") + "</option>";
        }).join("");
        sel.onchange = function () {
          var v = sel.value;
          render(proj, v === "*" ? allRows : allRows.filter(function (r) { return (r.taskEstimateName || "") === v; }));
        };
      }
      render(proj, allRows);
    } catch (e) {
      el("rpSheet").innerHTML = '<div class="rp-loading">' + esc(e.message || "Could not load estimate.") + "</div>";
    }
  });
})();
