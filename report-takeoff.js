/* DCR portal — printable Material List for one takeoff.

   A web port of the Access "Material List" report, and it keeps that report's
   column order: Item first, Purpose last. That is deliberately the reverse of
   the on-screen grid — on screen you scan by purpose to find the row you want
   to edit; on paper this goes to a yard or a crew who read down the materials
   and use the purpose as the note beside it.

   What it does NOT re-derive is the order the groups come out in. That is the
   owner's dragged layout, saved on the takeoff header, and it lives in
   takeoff-order.js so the sheet and the grid cannot drift apart.

   Frontend-only: action=project record + part=takeoffs, same as the grid. */
(function () {
  var qs = new URLSearchParams(location.search);
  var PID = qs.get("id");
  var TKID = qs.get("tk");                  // which takeoff; omitted = the first
  var CO = DCR.companyInfo;
  var LOGO = CO.logo;
  var TKO = DCR.tko;

  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var gkey = function (v) { return TKO.gkey(v); };

  function coBlock() {
    var lines = ["<b>" + esc(CO.legalName || CO.name) + "</b>"];
    if (CO.address) lines.push(esc(CO.address));
    var pf = [CO.phone ? "Ph " + CO.phone : "", CO.fax ? "Fax " + CO.fax : ""].filter(Boolean).join(" · ");
    if (pf) lines.push(esc(pf));
    if (CO.license) lines.push(esc(CO.license));
    return lines.join("<br>");
  }
  // the Access footer reads "Wednesday, August 12 - 2026   ( 8:41 PM )"
  function stampDate(d) {
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) + " - " + d.getFullYear();
  }
  function stampTime(d) {
    return "( " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) + " )";
  }
  function qtyDisp(v) {
    // blank, not 0 — a component header is not an instruction to order none
    return v == null || v === "" || Number(v) === 0 ? "" : String(v);
  }

  /* The grid paints a rail on EVERY row including top-level ones, which is what
     makes its k=0 column a continuous line. On paper a vertical beside every
     single item is noise, so top-level rows here paint nothing — and that means
     the ancestor loop must start at 1. Starting at 0 drew a full-height line in
     the k=0 column of each component with nothing above or below to anchor it:
     a second, floating rule beside the real connector on every assembly. */
  function railsHtml(n) {
    var out = "";
    for (var j = 1; j < n.depth; j++) {
      if (n.cont[j]) out += '<i class="ml-rl" style="--k:' + j + '"></i>';
    }
    if (n.depth) {
      out += '<i class="ml-rl own' + (n.last ? " last" : "") + '" style="--k:' + n.depth + '"></i>';
    }
    return out;
  }

  function render(p, header, rows) {
    var name = header.takeoffName || "(unnamed takeoff)";
    document.title = "DCR Material List — " + (p.internalIDNumber || "") + " " + name;

    function tableHead() {
      return '<table class="ml"><thead><tr>' +
        '<th class="c-ln">L#:</th><th class="c-qty">Qty.:</th><th class="c-un"></th>' +
        '<th class="c-it">Item:</th><th class="c-pu">Purpose:</th></tr></thead><tbody>';
    }

    var nodes = TKO.tree(rows, header);
    var SEP = TKO.SEP;
    // A component is printed under whatever band its PARENT opened, and its own
    // group fields are often blank — so the colour follows the band on the page,
    // not the row's fields, or an assembly's parts would change colour mid-tree.
    var gcolor = TKO.colorer();
    var curGC = null;
    // Built, not written as a literal: an invisible control byte in source reads
    // as an empty string in every diff and review tool, and "" is exactly what
    // gkey() returns for a blank Level — so the two look identical on the page
    // while behaving completely differently.
    var FORCE = String.fromCharCode(1);
    var out = [], open = false, ln = 0;
    var prev = [FORCE, FORCE, FORCE];
    function closeTable() { if (open) { out.push("</tbody></table>"); open = false; } }
    function openTable() { if (!open) { out.push(tableHead()); open = true; } }
    function band(cls, text) {
      closeTable();
      out.push('<div class="ml-band ' + cls + '">' + esc(text) + "</div>");
    }

    nodes.forEach(function (n) {
      var r = n.row;
      var keys = [gkey(r.itemLocation), gkey(r.itemCategory), gkey(r.itemSubCategory)];
      // A component belongs to its parent's group, so only a TOP-LEVEL row may
      // open a new band — otherwise a child whose own group fields are blank
      // would tear its assembly out of the group it is printed under.
      if (!n.depth) {
        for (var d = 0; d < 3; d++) {
          if (keys[d] === prev[d] && keys.slice(0, d).join(SEP) === prev.slice(0, d).join(SEP)) continue;
          // Same rule the grid uses (takeoff.js): a blank Category/Sub draws no
          // band of its own UNLESS something deeper is set, and a blank Level
          // always draws one. Swallowing a blank band instead printed those rows
          // under the PREVIOUS heading — and since a blank Level sorts last, that
          // heading is always the wrong one, on a sheet a lumber yard reads.
          if (d > 0 && keys[d] === "") {
            var deeper = false;
            for (var q = d + 1; q < 3; q++) if (keys[q] !== "") deeper = true;
            if (!deeper) { prev[d] = keys[d]; continue; }
          }
          band(["ml-lvl", "ml-cat", "ml-sub"][d], keys[d] === "" ? "(none)" : keys[d]);
          for (var k = d; k < 3; k++) prev[k] = FORCE;
        }
        prev = keys;
        curGC = gcolor(keys);
      }
      openTable();
      ln++;
      out.push(
        '<tr><td class="c-ln">' + ln + "</td>" +
        '<td class="c-qty">' + esc(qtyDisp(r.itemQty)) + "</td>" +
        '<td class="c-un">' + esc(r.itemType || "") + "</td>" +
        '<td class="c-it">' + esc(r.itemName || "") + "</td>" +
        // the tree lives here: the purpose is what states the relationship
        '<td class="c-pu"' + (curGC == null ? "" : ' style="--gc:var(--tg' + curGC + ')"') + ">" +
          railsHtml(n) +
          '<span style="display:inline-block;padding-left:' + (n.depth ? n.depth * 13 + 12 : 0) + 'px">' +
          esc(r.itemPurpose || "") + "</span></td></tr>");
    });
    closeTable();
    var table = out.join("");
    var now = new Date();

    el("rpSheet").innerHTML =
      '<div class="ml-top"><div class="ml-topl">' +
        '<div class="ml-h1">Material List</div>' +
        '<div class="ml-meta"><b>Project:</b> ' +
          esc("#" + (p.internalIDNumber || "") + (p.projectName ? " - " + p.projectName : "")) + "<br>" +
          "<b>Address:</b> " + esc([p.projectAddress, p.projectCity].filter(Boolean).join(" - ") || "—") +
        "</div></div>" +
        '<div class="ml-logo"><div class="ml-co">' + coBlock() + "</div>" +
        '<img src="' + LOGO + '" alt="' + esc(CO.name) + '" /></div>' +
      "</div>" +
      '<div class="ml-tkl">Takeoff Name:</div>' +
      '<div class="ml-band ml-tk">' + esc("#" + (p.internalIDNumber || "") + " - " + name) + "</div>" +
      (nodes.length ? table + "</tbody></table>"
        : '<div class="ml-none">This takeoff has no items yet.</div>') +
      '<div class="foot"><span>' + esc(stampDate(now)) + "  " + esc(stampTime(now)) + "</span>" +
        "<span>" + nodes.length + " line" + (nodes.length === 1 ? "" : "s") + " · " + esc(CO.name) + "</span></div>";
  }

  document.addEventListener("DOMContentLoaded", async function () {
    await DCR.requireAuth();
    if (!TKO) { el("rpSheet").innerHTML = '<div class="rp-loading">Ordering helper failed to load — please refresh.</div>'; return; }
    if (!PID) { el("rpSheet").innerHTML = '<div class="rp-loading">No project selected.</div>'; return; }
    el("rpBack").href = "project.html?id=" + encodeURIComponent(PID) + "&tab=takeoffs";
    try {
      var res = await Promise.all([
        DCR.api("/api/portal?action=project&id=" + encodeURIComponent(PID)),
        DCR.api("/api/portal?action=project&id=" + encodeURIComponent(PID) + "&part=takeoffs"),
      ]);
      var heads = res[1].takeoffs || [];
      var header = TKID ? heads.find(function (h) { return String(h.id) === String(TKID); }) : heads[0];
      if (!header) {
        el("rpSheet").innerHTML = '<div class="rp-loading">That takeoff no longer exists.</div>';
        return;
      }
      var want = String(header.id);
      var rows = (res[1].rows || []).filter(function (r) {
        return String(r.takeoffID == null ? "" : r.takeoffID) === want;
      });
      render(res[0].project, header, rows);
    } catch (e) {
      el("rpSheet").innerHTML = '<div class="rp-loading">' + esc(e.message || "Could not load the takeoff.") + "</div>";
    }
  });
})();
