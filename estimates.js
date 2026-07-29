/* DCR portal — Sales Estimates hub.
   Saved estimates (SalesEstimates list) + the reference-project comps library
   (SalesReferenceProjects list) behind action=sales. Trade wizards launch from
   the trade cards (deck live; others coming). */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var state = { estimates: [], refs: [], editingRef: null, isAdmin: false, refGallery: null };

  function money(n) {
    if (n === null || n === undefined || n === "" || !isFinite(Number(n))) return "—";
    return "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  function fmtDate(v) {
    if (!v) return "";
    var d = new Date(v);
    return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  /* ── saved estimates ── */
  function renderEstimates() {
    var q = (el("seSearch").value || "").trim().toLowerCase();
    var rows = state.estimates.filter(function (e2) {
      if (!q) return true;
      return [e2.clientName, e2.siteAddress, e2.city, e2.estStatus, e2.trade, e2.projectType, e2.estimateRef]
        .join(" ").toLowerCase().indexOf(q) !== -1;
    });
    if (!rows.length) {
      el("seList").innerHTML = '<div class="se-empty">' +
        (state.estimates.length ? "No estimates match your search." :
          "No estimates saved yet — start one with a trade card above.") + "</div>";
      return;
    }
    el("seList").innerHTML =
      '<div style="overflow-x:auto"><table class="se-tbl"><thead><tr>' +
      "<th>Client / address</th><th>Trade</th><th>Type</th><th class='num'>SF</th>" +
      "<th class='num'>Benchmark</th><th class='num'>Range</th><th>Status</th><th>Updated</th><th></th>" +
      "</tr></thead><tbody>" +
      rows.map(function (e2) {
        var range = (e2.rangeLowTotal || e2.rangeHighTotal)
          ? money(e2.rangeLowTotal) + (e2.rangeHighTotal && e2.rangeHighTotal !== e2.rangeLowTotal ? " – " + money(e2.rangeHighTotal) : "")
          : "—";
        return '<tr class="row" data-id="' + esc(e2.id) + '">' +
          "<td><b>" + (e2.clientName ? esc(e2.clientName) : '<span style="color:var(--text-muted);font-weight:400">(untitled draft)</span>') + "</b><br><span style='font-size:11.5px;color:var(--text-muted)'>" +
          esc([e2.siteAddress, e2.city].filter(Boolean).join(", ")) + "</span></td>" +
          "<td>" + esc(e2.trade || "") + "</td><td>" + esc(e2.projectType || "") + "</td>" +
          "<td class='num'>" + (e2.primaryAreaSF || "") + "</td>" +
          "<td class='num'>" + money(e2.benchmarkTotal) + "</td>" +
          "<td class='num'>" + range + "</td>" +
          "<td><span class='se-status st-" + esc(e2.estStatus || "draft") + "'>" + esc(e2.estStatus || "draft") + "</span></td>" +
          "<td style='white-space:nowrap'>" + fmtDate(e2.lastModified) + "</td>" +
          "<td><button class='btn btn-ghost btn-sm delEst' data-id='" + esc(e2.id) + "' title='Delete'>🗑</button></td></tr>";
      }).join("") + "</tbody></table></div>";

    el("seList").querySelectorAll("tr.row").forEach(function (tr) {
      tr.onclick = function (ev) {
        if (ev.target.closest(".delEst")) return;
        location.href = "estimate-deck.html?id=" + encodeURIComponent(tr.dataset.id);
      };
    });
    el("seList").querySelectorAll(".delEst").forEach(function (b) {
      b.onclick = async function (ev) {
        ev.stopPropagation();
        if (!confirm("Delete this estimate? This cannot be undone.")) return;
        try {
          await DCR.api("/api/portal?action=sales&part=estimates&id=" + encodeURIComponent(b.dataset.id), { method: "DELETE" });
          state.estimates = state.estimates.filter(function (x) { return x.id !== b.dataset.id; });
          renderEstimates();
        } catch (e2) { alert(e2.message || "Delete failed."); }
      };
    });
  }

  /* ── reference projects ── */
  function renderRefs() {
    if (!state.refs.length) {
      el("refList").innerHTML = '<div class="se-empty">No past projects in the comps library yet.</div>';
      return;
    }
    el("refList").innerHTML =
      '<div style="overflow-x:auto"><table class="se-tbl"><thead><tr>' +
      "<th>Project</th><th>Type</th><th class='num'>SF</th><th class='num'>Rail LF</th>" +
      "<th class='num'>Price</th><th class='num'>$/SF</th><th>Active</th>" +
      "</tr></thead><tbody>" +
      state.refs.map(function (r) {
        var g = DCRGallery.parse(r);
        var thumb = g.length
          ? '<span style="width:44px;height:44px;border-radius:8px;overflow:hidden;background:var(--surface-2);flex-shrink:0;display:inline-flex">' +
            '<img style="display:none;width:100%;height:100%;object-fit:cover" data-refpic="' + esc(r.id) + '" alt=""></span>'
          : "";
        return '<tr class="row" data-id="' + esc(r.id) + '"><td><div style="display:flex;gap:10px;align-items:center">' + thumb + "<div><b>" + esc(r.projectName || r.projectRef) + "</b>" +
          (r.isSample ? ' <span class="se-badge-sample">sample</span>' : "") +
          (g.length ? ' <span style="font-size:10.5px;color:var(--text-muted)">📷 ' + g.length + "</span>" : "") +
          "<br><span style='font-size:11.5px;color:var(--text-muted)'>" +
          esc([r.projectRef, r.city, r.completedDate].filter(Boolean).join(" · ")) + "</span></div></div></td>" +
          "<td>" + esc(r.projectType || "") + "</td>" +
          "<td class='num'>" + (r.primaryAreaSF || 0) + "</td>" +
          "<td class='num'>" + (r.railingLF || 0) + "</td>" +
          "<td class='num'>" + money(r.referencePrice) + "</td>" +
          "<td class='num'>" + (isFinite(Number(r.costPerPrimaryUnit)) && r.costPerPrimaryUnit !== null ? "$" + Number(r.costPerPrimaryUnit).toFixed(2) : "—") + "</td>" +
          "<td>" + (r.activeAsReference === false ? "No" : "Yes") + "</td></tr>";
      }).join("") + "</tbody></table></div>";

    el("refList").querySelectorAll("tr.row").forEach(function (tr) {
      tr.onclick = function () {
        var r = state.refs.find(function (x) { return x.id === tr.dataset.id; });
        if (r) openRefModal(r);
      };
    });
    // hydrate cover thumbnails
    state.refs.forEach(function (r) {
      var img = el("refList").querySelector('img[data-refpic="' + CSS.escape(r.id) + '"]');
      if (!img) return;
      img.onload = function () { img.style.display = ""; };
      DCRGallery.srcInto(img, DCRGallery.parse(r)[0]);
    });
  }

  function openRefModal(r) {
    state.editingRef = r || null;
    el("refTitle").textContent = r ? "Edit past project" : "Add past project";
    el("refMsg").textContent = "";
    el("r_ref").value = r ? r.projectRef || "" : "";
    el("r_name").value = r ? r.projectName || "" : "";
    el("r_city").value = r ? r.city || "" : "";
    el("r_type").value = r && r.projectType ? r.projectType : "new-deck";
    el("r_cx").value = r && r.complexity ? r.complexity : "standard";
    el("r_done").value = r ? r.completedDate || "" : "";
    el("r_sf").value = r ? r.primaryAreaSF ?? "" : "";
    el("r_frame").value = r ? r.secondaryAreaSF ?? "" : "";
    el("r_rail").value = r ? r.railingLF ?? "" : "";
    el("r_stairs").value = r ? r.stairs ?? "" : "";
    el("r_price").value = r ? r.referencePrice ?? "" : "";
    el("r_hours").value = r ? r.totalManHours ?? "" : "";
    el("r_mfr").value = r ? r.deckingManufacturer || "" : "";
    el("r_line").value = r ? r.productLine || "" : "";
    el("r_notes").value = r ? r.notes || "" : "";
    el("r_active").value = r && r.activeAsReference === false ? "false" : "true";
    el("refDelete").style.display = r ? "" : "none";
    updateCps();
    if (state.refGallery) state.refGallery.destroy();
    state.refGallery = DCRGallery.mount(el("refGallery"), {
      initial: DCRGallery.parse(r),
      getPathParts: function () {
        var ref = el("r_ref").value.trim() || "New";
        var name = el("r_name").value.trim();
        return ["Reference Projects", (ref + (name ? " - " + name : "")).slice(0, 80)];
      },
    });
    el("refModal").classList.add("open");
  }
  function closeRefModal() {
    el("refModal").classList.remove("open");
    if (state.refGallery) { state.refGallery.destroy(); state.refGallery = null; }
  }
  function updateCps() {
    var sf = Number(el("r_sf").value), price = Number(el("r_price").value);
    el("r_cps").value = sf > 0 && price > 0 ? "$" + (price / sf).toFixed(2) : "";
  }

  async function saveRef() {
    var sf = Number(el("r_sf").value) || 0, price = Number(el("r_price").value) || 0;
    var fields = {
      projectRef: el("r_ref").value.trim() || ("DCR-DECK-" + Date.now()),
      projectName: el("r_name").value.trim(),
      trade: "deck", refStatus: "completed", stateCode: "CA",
      city: el("r_city").value.trim(),
      projectType: el("r_type").value, complexity: el("r_cx").value,
      completedDate: el("r_done").value,
      primaryAreaSF: sf, secondaryAreaSF: Number(el("r_frame").value) || 0,
      railingLF: Number(el("r_rail").value) || 0, stairs: Number(el("r_stairs").value) || 0,
      referencePrice: price, totalManHours: Number(el("r_hours").value) || 0,
      costPerPrimaryUnit: sf > 0 && price > 0 ? Math.round((price / sf) * 100) / 100 : "",
      deckingManufacturer: el("r_mfr").value.trim(), productLine: el("r_line").value.trim(),
      notes: el("r_notes").value,
      activeAsReference: el("r_active").value === "true",
      isSample: state.editingRef ? state.editingRef.isSample === true : false,
      picturesJson: JSON.stringify(state.refGallery ? state.refGallery.get() : []),
    };
    if (!fields.projectName) { el("refMsg").textContent = "Project name is required."; return; }
    if (!(sf > 0)) { el("refMsg").textContent = "Decking area is required."; return; }
    if (!(price > 0)) { el("refMsg").textContent = "Final price is required — it drives the cost history."; return; }
    if (state.refGallery && state.refGallery.uploading()) {
      el("refMsg").textContent = "Still uploading photos — one moment…";
      return;
    }
    el("refSave").disabled = true;
    el("refMsg").textContent = "Saving…";
    try {
      await DCR.api("/api/portal?action=sales&part=refs", {
        method: "POST",
        body: state.editingRef ? { id: state.editingRef.id, fields: fields } : { fields: fields },
      });
      closeRefModal();
      await loadRefs();
    } catch (e2) { el("refMsg").textContent = e2.message || "Save failed."; }
    el("refSave").disabled = false;
  }

  async function loadRefs() {
    try {
      var d = await DCR.api("/api/portal?action=sales&part=refs&trade=deck&all=1");
      state.refs = d.refs || [];
      renderRefs();
      return true;
    } catch (e2) {
      el("refList").innerHTML = '<div class="se-empty">' + esc(e2.message || "Could not load.") + "</div>";
      return e2.status !== 503;
    }
  }
  async function loadEstimates() {
    try {
      var d = await DCR.api("/api/portal?action=sales&part=estimates");
      state.estimates = d.estimates || [];
      renderEstimates();
      return true;
    } catch (e2) {
      el("seList").innerHTML = '<div class="se-empty">' + esc(e2.message || "Could not load.") + "</div>";
      return e2.status !== 503;
    }
  }

  async function runSetup() {
    var btn = el("seSetupBtn"), msg = el("seSetupMsg");
    btn.disabled = true;
    msg.textContent = "Creating lists in SharePoint… this can take a minute.";
    try {
      var r = await DCR.api("/api/portal?action=sales&part=setup", { method: "POST", body: {} });
      msg.textContent = "✓ Done. Lists ready" + (r.seeded ? " — " + r.seeded + " sample projects added." : ".");
      el("seSetup").style.display = "none";
      await Promise.all([loadEstimates(), loadRefs()]);
    } catch (e2) {
      msg.textContent = e2.message || "Setup failed.";
      btn.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };
    state.isAdmin = profile.role === "Admin";

    el("seSearch").oninput = renderEstimates;
    el("seReload").onclick = loadEstimates;
    el("seNew").onclick = function () { location.href = "estimate-deck.html?new=1"; };
    el("refAdd").onclick = function () { openRefModal(null); };
    el("refCancel").onclick = closeRefModal;
    el("refModal").onclick = function (e2) { if (e2.target === el("refModal")) closeRefModal(); };
    el("refSave").onclick = saveRef;
    el("r_sf").oninput = updateCps;
    el("r_price").oninput = updateCps;
    el("refDelete").onclick = async function () {
      if (!state.editingRef) return;
      if (!confirm("Delete this reference project?")) return;
      try {
        await DCR.api("/api/portal?action=sales&part=refs&id=" + encodeURIComponent(state.editingRef.id), { method: "DELETE" });
        closeRefModal();
        await loadRefs();
      } catch (e2) { el("refMsg").textContent = e2.message || "Delete failed."; }
    };

    var ok = await Promise.all([loadEstimates(), loadRefs()]);
    // 503 = lists missing → offer setup to admins
    if ((ok[0] === false || ok[1] === false) && state.isAdmin) {
      el("seSetup").style.display = "";
      el("seSetupBtn").onclick = runSetup;
    }
  });
})();
