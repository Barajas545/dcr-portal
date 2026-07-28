/* DCR portal — Deck Estimate wizard.
   Port of the DCR Sales Hub prototype (reference/dcr-sales-hub) onto the portal:
   comps live in the SalesReferenceProjects SharePoint list, estimates save to
   SalesEstimates (action=sales), materials come from deck-materials.json.

   Flow: 1 Project info → 2 Similar projects (scored comps, pick a reference)
         → 3 Materials → 4 Review → 5 Preliminary estimate (save / print).

   The scoring + estimate math is ported verbatim from the prototype's
   ProjectMatcher and EstimateEngine (see reference/dcr-sales-hub/docs).
   Pricing honesty rule preserved: material pricing is never fabricated —
   totals come only from completed-project cost history. */

(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var qs = new URLSearchParams(location.search);
  var EDIT_ID = qs.get("id") || null;      // reopen a saved estimate
  var DRAFT_KEY = "dcrDeckEstDraft";

  var PROJECT_TYPES = [
    { id: "new-deck", t: "New deck", d: "Built from the ground up — framing area matches decking." },
    { id: "resurface", t: "Resurface", d: "Existing framing kept; new deck boards only." },
    { id: "deck-expansion", t: "Expansion", d: "Existing deck enlarged — enter only the NEW framing area." },
    { id: "partial-rebuild", t: "Partial rebuild", d: "Some framing replaced — enter the replaced area." },
  ];
  var COMPLEXITY = [
    { id: "standard", t: "Standard", d: "Rectangular layout, easy access, single level." },
    { id: "moderate", t: "Moderate", d: "Some angles, slope, or elevated sections." },
    { id: "complex", t: "Complex", d: "Multi-level, hillside, difficult access, custom features." },
  ];
  var TERRAIN = ["flat", "slope", "hillside"];
  var ACCESS = ["easy", "moderate", "difficult"];

  var state = {
    step: 1,
    estimateId: null,          // SharePoint item id when saved
    estimateRef: "",           // EST-xxxx
    version: 0,
    estStatus: "draft",
    project: { clientName: "", clientPhone: "", clientEmail: "", address: "", city: "",
      projectType: "", deckingArea: "", framingArea: "", railing: "", stairs: "",
      complexity: "", terrain: "", access: "", notes: "" },
    refs: null,                // loaded comps
    ranked: null,
    referenceId: null,         // projectRef of chosen comp
    catalog: null,             // materials
    sel: { primary: null, alternative: null },
    output: null,
  };

  /* ══ matcher (ported: type 20 + decking 25 + framing 20 + railing 10 + stairs 10 + complexity 15) ══ */
  function simScore(cur, ref, max) {
    var c = Number(cur) || 0, r = Number(ref) || 0;
    if (c === 0 && r === 0) return max;
    return Math.max(0, max * (1 - Math.abs(c - r) / Math.max(c, r, 1)));
  }
  function matchScore(p, ref) {
    var s = (p.projectType === ref.projectType ? 20 : 0) +
      simScore(p.deckingArea, ref.primaryAreaSF, 25) +
      simScore(p.framingArea, ref.secondaryAreaSF, 20) +
      simScore(p.railing, ref.railingLF, 10) +
      simScore(p.stairs, ref.stairs, 10) +
      (p.complexity === ref.complexity ? 15 : 5);
    return Math.round(Math.min(100, s));
  }
  function rankRefs(p, refs) {
    return refs
      .filter(function (r) { return r.activeAsReference !== false; })
      .map(function (r) { var c = Object.assign({}, r); c.match = matchScore(p, r); return c; })
      .sort(function (a, b) { return b.match - a.match; });
  }

  /* ══ estimate engine (ported: benchmark + comparable range + source rows) ══ */
  var MIN_MATCH = 60, MAX_COMPS = 3;

  function eligibility(r, projectType) {
    var reasons = [];
    if (String(r.refStatus || "") !== "completed") reasons.push("not a completed project");
    if (r.activeAsReference === false) reasons.push("not active as a reference");
    if (r.projectType !== projectType) reasons.push("project type " + (r.projectType || "unknown") + " does not match " + projectType);
    if (!isFinite(Number(r.costPerPrimaryUnit)) || Number(r.costPerPrimaryUnit) <= 0) reasons.push("no usable historical cost per SF");
    if (!isFinite(Number(r.match)) || Number(r.match) < MIN_MATCH) reasons.push("similarity " + r.match + "% is below " + MIN_MATCH + "%");
    return { eligible: reasons.length === 0, reasons: reasons };
  }

  function buildBenchmark(area, projectType, ranked, refId) {
    if (!refId) return { present: false, note: "No historical reference was selected. Selecting one adds a benchmark for this scope." };
    var sel = (ranked || []).find(function (r) { return r.projectRef === refId; });
    if (!sel) return { present: false, note: "The selected reference could not be resolved from the comps library." };
    var cps = Number(sel.costPerPrimaryUnit);
    var elig = eligibility(sel, projectType);
    return {
      present: true, projectRef: sel.projectRef, projectName: sel.projectName,
      projectType: sel.projectType, refAreaSF: sel.primaryAreaSF, currentAreaSF: area,
      match: isFinite(Number(sel.match)) ? Number(sel.match) : null,
      costPerSF: isFinite(cps) ? cps : null,
      total: isFinite(cps) && area > 0 ? Math.round(area * cps) : null,
      isSample: sel.isSample === true,
      eligibleForRange: elig.eligible, exclusionReasons: elig.reasons,
    };
  }

  function buildRange(area, projectType, ranked) {
    var eligible = (ranked || []).filter(function (r) { return eligibility(r, projectType).eligible; }).slice(0, MAX_COMPS);
    var members = eligible.map(function (r) {
      return { projectRef: r.projectRef, projectName: r.projectName, projectType: r.projectType,
        refAreaSF: r.primaryAreaSF, match: Number(r.match), costPerSF: Number(r.costPerPrimaryUnit),
        isSample: r.isSample === true };
    });
    if (!members.length) {
      return { st: "none", areaSF: area, members: [],
        note: "No comparable range is available: no completed projects of the same type score at least " + MIN_MATCH + "% similarity." };
    }
    var costs = members.map(function (m) { return m.costPerSF; });
    var lo = Math.min.apply(null, costs), hi = Math.max.apply(null, costs);
    if (members.length === 1) {
      return { st: "single", areaSF: area, members: members, loCps: lo, hiCps: lo,
        loTotal: Math.round(area * lo), hiTotal: Math.round(area * lo),
        note: "Based on one eligible comparable project." };
    }
    return { st: "range", areaSF: area, members: members, loCps: lo, hiCps: hi,
      loTotal: Math.round(area * lo), hiTotal: Math.round(area * hi),
      loRef: members.find(function (m) { return m.costPerSF === lo; }).projectRef,
      hiRef: members.find(function (m) { return m.costPerSF === hi; }).projectRef,
      note: "Range across " + members.length + " eligible comparable projects of the same type." };
  }

  function buildRows(benchmark, range) {
    var rows = range.members.map(function (m) {
      return Object.assign({}, m, {
        total: Math.round(range.areaSF * m.costPerSF),
        isAnchor: benchmark.present && m.projectRef === benchmark.projectRef,
        inRange: true,
      });
    });
    if (benchmark.present && !rows.some(function (r) { return r.isAnchor; })) {
      rows.unshift({ projectRef: benchmark.projectRef, projectName: benchmark.projectName,
        projectType: benchmark.projectType, refAreaSF: benchmark.refAreaSF, match: benchmark.match,
        costPerSF: benchmark.costPerSF, total: benchmark.total, isAnchor: true, inRange: false,
        isSample: benchmark.isSample });
    }
    return rows;
  }

  function buildAssumptions(p, snapshot, benchmark, range, anySample) {
    var a = [];
    a.push("Quantities are approximate and provided by the sales conversation; they are not field measurements.");
    if (p.projectType === "new-deck") a.push("New deck: framing area assumed equal to decking area unless entered otherwise.");
    if (p.projectType === "resurface") a.push("Resurface: existing framing is retained and assumed structurally sound (0 SF new framing).");
    if (snapshot) {
      a.push("Material selection is recorded for scope only (" + snapshot.primary.officialName +
        (snapshot.primary.colorName ? " — " + snapshot.primary.colorName : "") + ").");
      a.push("Material pricing is pending approved price records; no draft or research price was used in any calculation.");
    } else {
      a.push("No material selection was confirmed for this estimate version.");
    }
    if (benchmark && benchmark.present) {
      a.push("The Selected Reference Benchmark applies " + benchmark.projectName +
        "'s historical cost per decking SF to the current decking area. It is historical context, not a price for this project.");
      if (!benchmark.eligibleForRange) {
        a.push(benchmark.projectName + " is excluded from the Comparable Project Range: " + benchmark.exclusionReasons.join("; ") + ".");
      }
    } else {
      a.push("No historical reference was selected, so no Selected Reference Benchmark is shown.");
    }
    if (range) {
      if (range.st === "none") a.push(range.note);
      if (range.st === "single") a.push("The comparable value is based on one eligible comparable project, so no range is shown.");
      if (range.st === "range") a.push("The Comparable Project Range reflects completed DCR projects of the same type, not a price for this project.");
    }
    if (anySample) a.push("One or more participating reference projects are SAMPLE data seeded with the app — replace them with real completed projects for production use.");
    a.push("This preliminary estimate requires review by a DCR estimator before it is shared with the client.");
    return a;
  }

  function buildOutput() {
    var p = state.project;
    var area = Number(p.deckingArea) || 0;
    var benchmark = buildBenchmark(area, p.projectType, state.ranked, state.referenceId);
    var range = buildRange(area, p.projectType, state.ranked);
    if (benchmark.present) {
      benchmark.inRange = range.members.some(function (m) { return m.projectRef === benchmark.projectRef; });
    }
    var rows = buildRows(benchmark, range);
    var anySample = rows.some(function (r) { return r.isSample; });
    var snapshot = buildSnapshot();
    return {
      generatedAt: new Date().toISOString(),
      scope: Object.assign({}, p),
      selectionSnapshot: snapshot,
      benchmark: benchmark,
      range: range,
      sourceRows: rows,
      anySample: anySample,
      materialCost: { amount: null, status: "pending_admin_pricing",
        note: "Material pricing is deferred until approved price records exist — it is not estimated from research data." },
      assumptions: buildAssumptions(p, snapshot, benchmark, range, anySample),
    };
  }

  /* ══ materials ══ */
  function products() { return (state.catalog && state.catalog.products) || []; }
  function findProduct(id) { return products().find(function (x) { return x.materialId === id; }) || null; }

  function buildSnapshot() {
    var sel = state.sel;
    if (!sel.primary) return null;
    var p = findProduct(sel.primary.materialId);
    if (!p) return null;
    var color = (p.colors || []).find(function (c) { return c.colorId === sel.primary.colorId; }) || (p.colors || [])[0] || null;
    var profile = (p.profiles || []).find(function (x) { return x.profileId === sel.primary.profileId; }) || (p.profiles || [])[0] || null;
    var alt = null;
    if (sel.alternative) {
      var ap = findProduct(sel.alternative.materialId);
      if (ap) {
        var ac = (ap.colors || []).find(function (c) { return c.colorId === sel.alternative.colorId; }) || (ap.colors || [])[0] || null;
        alt = { materialId: ap.materialId, brandName: ap.brandName, officialName: ap.officialName,
          marketTier: ap.marketTier, colorName: ac ? ac.name : "" };
      }
    }
    return {
      primary: { materialId: p.materialId, brandName: p.brandName, officialName: p.officialName,
        marketTier: p.marketTier, colorId: color ? color.colorId : null, colorName: color ? color.name : "",
        profileId: profile ? profile.profileId : null,
        profileType: profile ? profile.profileType : "", nominalDimensions: profile ? profile.nominalDimensions : "" },
      alternative: alt,
      pricingStatus: "pending_admin_pricing",
    };
  }

  /* ══ helpers ══ */
  function money(n) {
    if (!isFinite(Number(n))) return "—";
    return "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  function matchClass(m) { return m >= 75 ? "hi" : m >= 50 ? "md" : "lo"; }
  function saveDraftLocal() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        estimateId: state.estimateId, estimateRef: state.estimateRef, version: state.version,
        estStatus: state.estStatus, project: state.project, referenceId: state.referenceId, sel: state.sel,
      }));
    } catch (e) {}
  }
  function clearDraftLocal() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }

  async function loadRefs() {
    if (state.refs) return state.refs;
    var d = await DCR.api("/api/portal?action=sales&part=refs&trade=deck");
    state.refs = d.refs || [];
    return state.refs;
  }
  async function loadCatalog() {
    if (state.catalog) return state.catalog;
    // SharePoint Materials Library first (live-managed, with photos); the
    // shipped deck-materials.json is the resilience fallback.
    try {
      var d = await DCR.api("/api/portal?action=sales&part=materials&trade=deck");
      var rows = d.materials || [];
      var prodRows = rows.filter(function (r2) { return r2.itemKind === "product" && r2.itemStatus !== "retired"; });
      if (prodRows.length) {
        state.catalog = {
          source: "sharepoint",
          products: prodRows.map(function (pr) {
            var det = {};
            try { det = JSON.parse(pr.detailsJson || "{}"); } catch (e) {}
            var colors = rows
              .filter(function (c) { return c.itemKind === "color" && c.materialId === pr.materialId && c.itemStatus !== "retired"; })
              .map(function (c) {
                return { colorId: c.itemId, name: c.itemName, status: c.itemStatus,
                  manufacturerUrl: c.manufacturerUrl, pictureUrl: c.pictureUrl, pictureItemId: c.pictureItemId };
              });
            return {
              materialId: pr.materialId, brandName: pr.brandName, officialName: pr.itemName,
              status: pr.itemStatus, marketTier: pr.marketTier,
              shortDescription: pr.description, warrantySummary: pr.warrantySummary,
              selectable: pr.selectable !== false && pr.itemStatus === "active",
              pictureUrl: pr.pictureUrl, pictureItemId: pr.pictureItemId,
              colors: colors,
              profiles: det.profiles || [],
            };
          }),
        };
        return state.catalog;
      }
    } catch (e) { /* fall through to the static file */ }
    var r = await fetch("deck-materials.json");
    var raw = await r.json();
    (raw.products || []).forEach(function (p) { p.selectable = p.status === "active"; });
    state.catalog = raw;
    return state.catalog;
  }

  // Post-render picture hydration: uploaded photos need an authenticated blob
  // fetch; pasted URLs load directly. Images stay hidden until they load.
  function hydratePics(scope) {
    scope.querySelectorAll("img[data-pic-item], img[data-pic-url]").forEach(function (img) {
      img.onload = function () {
        img.style.display = "";
        var ph = img.parentElement && img.parentElement.querySelector(".picph");
        if (ph) ph.style.display = "none";
      };
      var itemId = img.getAttribute("data-pic-item"), url = img.getAttribute("data-pic-url");
      if (itemId) {
        DCR.blobUrl("/api/portal?action=sales&part=image&id=" + encodeURIComponent(itemId))
          .then(function (u) { img.src = u; })
          .catch(function () { if (url) img.src = url; });
      } else if (url) img.src = url;
    });
  }
  function picAttrs(o) {
    if (o && o.pictureItemId) return ' data-pic-item="' + esc(o.pictureItemId) + '"' + (o.pictureUrl ? ' data-pic-url="' + esc(o.pictureUrl) + '"' : "");
    if (o && o.pictureUrl) return ' data-pic-url="' + esc(o.pictureUrl) + '"';
    return "";
  }

  /* ══ step navigation ══ */
  function paintSteps() {
    document.querySelectorAll(".ed-step").forEach(function (s) {
      var n = Number(s.dataset.step);
      s.classList.toggle("on", n === state.step);
      s.classList.toggle("done", n < state.step);
      s.onclick = n < state.step ? function () { go(n); } : null;
    });
  }

  async function go(step) {
    state.step = step;
    paintSteps();
    saveDraftLocal();
    window.scrollTo(0, 0);
    if (step === 1) renderStep1();
    if (step === 2) await renderStep2();
    if (step === 3) await renderStep3();
    if (step === 4) await renderStep4();
    if (step === 5) await renderStep5();
  }

  /* ══ STEP 1 — project info ══ */
  function pickCards(list, selected, cls) {
    return '<div class="ed-pick">' + list.map(function (c) {
      return '<div class="ed-pick-card ' + cls + (selected === c.id ? " on" : "") + '" data-id="' + c.id + '">' +
        '<div class="t">' + esc(c.t) + '</div><div class="d">' + esc(c.d) + "</div></div>";
    }).join("") + "</div>";
  }

  function renderStep1() {
    var p = state.project;
    el("edApp").innerHTML =
      '<div class="ed-card"><h2>🏗️ Project information</h2>' +
      '<p class="ed-sub">Describe the deck project. Fields marked * are required.</p>' +
      '<div class="ed-grid">' +
      '<div><label class="req">Client name</label><input id="f_client" value="' + esc(p.clientName) + '"></div>' +
      '<div><label class="req">Project address</label><input id="f_addr" value="' + esc(p.address) + '"></div>' +
      '<div><label>Client phone</label><input id="f_phone" type="tel" value="' + esc(p.clientPhone) + '"></div>' +
      '<div><label>Client email</label><input id="f_email" type="email" value="' + esc(p.clientEmail) + '"></div>' +
      '<div><label>City</label><input id="f_city" value="' + esc(p.city) + '"></div>' +
      '<div></div>' +
      '<div class="full"><label class="req">Project type</label>' + pickCards(PROJECT_TYPES, p.projectType, "pt") + "</div>" +
      '<div><label class="req">Decking surface area (SF)</label><input id="f_deck" type="number" min="0" value="' + esc(p.deckingArea) + '"></div>' +
      '<div><label>New framing area (SF)</label><input id="f_frame" type="number" min="0" value="' + esc(p.framingArea) + '">' +
      '<div style="font-size:11px;color:var(--text-muted);margin-top:3px" id="frameHelp"></div></div>' +
      '<div><label>Railing (LF)</label><input id="f_rail" type="number" min="0" value="' + esc(p.railing) + '"></div>' +
      '<div><label>Stairs (count)</label><input id="f_stairs" type="number" min="0" value="' + esc(p.stairs) + '"></div>' +
      '<div class="full"><label class="req">Complexity</label>' + pickCards(COMPLEXITY, p.complexity, "cx") + "</div>" +
      '<div><label>Terrain</label><select id="f_terrain"><option value="">—</option>' +
        TERRAIN.map(function (t) { return "<option" + (p.terrain === t ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select></div>" +
      '<div><label>Site access</label><select id="f_access"><option value="">—</option>' +
        ACCESS.map(function (t) { return "<option" + (p.access === t ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select></div>" +
      '<div class="full"><label>Notes</label><textarea id="f_notes" rows="2">' + esc(p.notes) + "</textarea></div>" +
      "</div>" +
      '<div class="ed-msg" id="s1msg" style="color:var(--err)"></div>' +
      '<div class="ed-nav"><span></span><button class="btn" id="s1next">Find similar projects →</button></div>' +
      "</div>";

    function applyTypeRules(type) {
      var fr = el("f_frame"), help = el("frameHelp");
      if (type === "new-deck") { fr.disabled = false; fr.value = el("f_deck").value || ""; help.textContent = "New deck: framing area normally matches decking area."; }
      if (type === "resurface") { fr.value = 0; fr.disabled = true; help.textContent = "Resurface: existing framing is retained."; }
      if (type === "deck-expansion") { fr.disabled = false; help.textContent = "Enter only the area requiring new framing."; }
      if (type === "partial-rebuild") { fr.disabled = false; help.textContent = "Enter the approximate area requiring replacement framing."; }
    }
    if (p.projectType) applyTypeRules(p.projectType);

    document.querySelectorAll(".ed-pick-card.pt").forEach(function (c) {
      c.onclick = function () {
        document.querySelectorAll(".ed-pick-card.pt").forEach(function (x) { x.classList.remove("on"); });
        c.classList.add("on");
        state.project.projectType = c.dataset.id;
        applyTypeRules(c.dataset.id);
      };
    });
    document.querySelectorAll(".ed-pick-card.cx").forEach(function (c) {
      c.onclick = function () {
        document.querySelectorAll(".ed-pick-card.cx").forEach(function (x) { x.classList.remove("on"); });
        c.classList.add("on");
        state.project.complexity = c.dataset.id;
      };
    });
    el("f_deck").addEventListener("input", function () {
      if (state.project.projectType === "new-deck") el("f_frame").value = this.value;
    });

    el("s1next").onclick = function () {
      var p2 = state.project;
      p2.clientName = el("f_client").value.trim();
      p2.clientPhone = el("f_phone").value.trim();
      p2.clientEmail = el("f_email").value.trim();
      p2.address = el("f_addr").value.trim();
      p2.city = el("f_city").value.trim();
      p2.deckingArea = Number(el("f_deck").value);
      p2.framingArea = Number(el("f_frame").value);
      p2.railing = Number(el("f_rail").value) || 0;
      p2.stairs = Number(el("f_stairs").value) || 0;
      p2.terrain = el("f_terrain").value;
      p2.access = el("f_access").value;
      p2.notes = el("f_notes").value;
      var msg = el("s1msg");
      if (!p2.clientName) return (msg.textContent = "Please enter the client name.");
      if (!p2.address) return (msg.textContent = "Please enter the project address.");
      if (!p2.projectType) return (msg.textContent = "Please select the project type.");
      if (!p2.deckingArea || p2.deckingArea <= 0) return (msg.textContent = "Please enter a valid decking surface area.");
      if (!isFinite(p2.framingArea) || p2.framingArea < 0) return (msg.textContent = "Please enter a valid framing area.");
      if (!p2.complexity) return (msg.textContent = "Please select the project complexity.");
      state.ranked = null; // scope changed — re-rank
      go(2);
    };
  }

  /* ══ STEP 2 — similar projects ══ */
  async function renderStep2() {
    el("edApp").innerHTML = '<div class="ed-card"><h2>🔎 Analyzing similar projects…</h2><p class="ed-sub">Comparing your scope with completed DCR projects.</p></div>';
    try {
      var refs = await loadRefs();
      state.ranked = rankRefs(state.project, refs);
    } catch (e) {
      el("edApp").innerHTML = '<div class="ed-card"><h2>Similar projects</h2><p class="ed-sub" style="color:var(--err)">' + esc(e.message || "Could not load the comps library.") + "</p>" +
        '<div class="ed-nav"><button class="btn btn-ghost" id="s2back">← Back</button><span></span></div></div>';
      el("s2back").onclick = function () { go(1); };
      return;
    }
    var cards = state.ranked.map(function (r) {
      var selCls = state.referenceId === r.projectRef ? " sel" : "";
      return '<div class="ed-match' + selCls + '" data-ref="' + esc(r.projectRef) + '">' +
        '<div class="hd"><span class="nm">' + esc(r.projectName) + (r.isSample ? ' <span class="ed-badge sample">sample</span>' : "") + "</span>" +
        '<span class="ed-badge ' + matchClass(r.match) + '">' + r.match + "% match</span></div>" +
        '<div class="ed-facts">' +
        "<span>Type: <b>" + esc(r.projectType || "—") + "</b></span>" +
        "<span>Decking: <b>" + (r.primaryAreaSF || 0) + " SF</b></span>" +
        "<span>Railing: <b>" + (r.railingLF || 0) + " LF</b></span>" +
        "<span>Stairs: <b>" + (r.stairs || 0) + "</b></span>" +
        "<span>Complexity: <b>" + esc(r.complexity || "—") + "</b></span>" +
        (r.city ? "<span>📍 <b>" + esc(r.city) + "</b></span>" : "") +
        "</div>" +
        '<div class="ed-facts"><span>Final price: <b>' + money(r.referencePrice) + "</b></span>" +
        "<span>Cost/SF: <b>" + (isFinite(Number(r.costPerPrimaryUnit)) ? "$" + Number(r.costPerPrimaryUnit).toFixed(2) : "—") + "</b></span>" +
        (r.productLine ? "<span>" + esc(r.deckingManufacturer || "") + " <b>" + esc(r.productLine) + "</b></span>" : "") +
        "</div>" +
        '<div style="margin-top:10px"><button class="btn btn-sm ' + (state.referenceId === r.projectRef ? "" : "btn-ghost") + ' pickRef" data-ref="' + esc(r.projectRef) + '">' +
        (state.referenceId === r.projectRef ? "✓ Reference selected" : "Use as reference →") + "</button></div></div>";
    }).join("");

    el("edApp").innerHTML =
      '<div class="ed-card"><h2>📊 Similar completed projects</h2>' +
      '<p class="ed-sub">Ranked by similarity to your scope. Pick the best historical reference — it anchors the benchmark on the estimate.</p>' +
      (cards || '<p class="ed-sub">No reference projects in the library yet. You can continue without one, or add past projects from the Estimates page.</p>') +
      '<div class="ed-msg" id="s2msg" style="color:var(--text-muted)">' +
      (state.referenceId ? "Reference: " + esc(state.referenceId) : "No reference selected (optional but recommended).") + "</div>" +
      '<div class="ed-nav"><button class="btn btn-ghost" id="s2back">← Project</button>' +
      '<button class="btn" id="s2next">Choose materials →</button></div></div>';

    document.querySelectorAll(".pickRef").forEach(function (b) {
      b.onclick = function () {
        state.referenceId = b.dataset.ref === state.referenceId ? null : b.dataset.ref;
        renderStep2();
      };
    });
    el("s2back").onclick = function () { go(1); };
    el("s2next").onclick = function () { go(3); };
  }

  /* ══ STEP 3 — materials ══ */
  async function renderStep3() {
    el("edApp").innerHTML = '<div class="ed-card">Loading material catalog…</div>';
    try { await loadCatalog(); } catch (e) {
      el("edApp").innerHTML = '<div class="ed-card"><p style="color:var(--err)">Could not load the material catalog.</p></div>';
      return;
    }
    var cards = products().map(function (pr) {
      var selectable = pr.selectable !== undefined ? pr.selectable !== false : pr.status === "active";
      var isPrimary = state.sel.primary && state.sel.primary.materialId === pr.materialId;
      var isAlt = state.sel.alternative && state.sel.alternative.materialId === pr.materialId;
      var cls = "ed-mat" + (isPrimary ? " sel" : "") + (isAlt ? " alt" : "") + (selectable ? "" : " dis");
      var thumb = (pr.pictureItemId || pr.pictureUrl)
        ? '<span style="width:46px;height:46px;border-radius:9px;overflow:hidden;flex-shrink:0;background:var(--surface-2);display:inline-flex">' +
          '<img style="display:none;width:100%;height:100%;object-fit:cover"' + picAttrs(pr) + ' alt=""></span>'
        : "";
      var colorChips = "", profChips = "";
      if (isPrimary) {
        colorChips = '<div class="ed-chips">' + (pr.colors || []).map(function (c) {
          var on = state.sel.primary.colorId === c.colorId;
          var sw = (c.pictureItemId || c.pictureUrl)
            ? '<img style="display:none;width:18px;height:18px;border-radius:4px;object-fit:cover;vertical-align:-4px;margin-right:5px"' + picAttrs(c) + ' alt="">'
            : "";
          return '<span class="ed-chip' + (on ? " on" : "") + '" data-color="' + esc(c.colorId) + '">' + sw + esc(c.name) + "</span>";
        }).join("") + "</div>";
        profChips = '<div class="ed-chips">' + (pr.profiles || []).map(function (f) {
          var on = state.sel.primary.profileId === f.profileId;
          return '<span class="ed-chip' + (on ? " on" : "") + '" data-profile="' + esc(f.profileId) + '">' +
            esc((f.profileType || "").replace(/_/g, " ") + " · " + (f.nominalDimensions || "")) + "</span>";
        }).join("") + "</div>";
      }
      return '<div class="' + cls + '" data-mat="' + esc(pr.materialId) + '" data-selectable="' + selectable + '">' +
        '<div class="hd"><div style="display:flex;gap:10px;align-items:center;min-width:0">' + thumb + '<div><b>' + esc(pr.brandName) + " " + esc(pr.officialName.replace(pr.brandName, "").trim() || pr.officialName) + "</b>" +
        '<div style="font-size:12px;color:var(--text-muted);margin-top:2px">' + esc(pr.shortDescription || "") + "</div></div></div>" +
        '<div style="display:flex;gap:6px;align-items:center"><span class="ed-tier">' + esc(pr.marketTier || "") + "</span>" +
        (selectable
          ? '<button class="btn btn-sm btn-ghost altBtn" data-mat="' + esc(pr.materialId) + '">' + (isAlt ? "✓ Alternative" : "+ Alt") + "</button>"
          : '<span class="ed-badge sample">pending approval</span>') +
        "</div></div>" +
        (isPrimary ? '<div style="font-size:11.5px;font-weight:700;margin-top:8px">Color</div>' + colorChips +
          '<div style="font-size:11.5px;font-weight:700;margin-top:8px">Profile</div>' + profChips : "") +
        "</div>";
    }).join("");

    el("edApp").innerHTML =
      '<div class="ed-card"><h2>🪵 Decking material</h2>' +
      '<p class="ed-sub">Pick the primary decking line (tap a card), then its color and profile. Optionally mark a second line as the client\'s alternative. ' +
      'Identity data is manufacturer-verified; <b>pricing stays pending</b> until approved price records exist.</p>' +
      cards +
      '<div class="ed-msg" id="s3msg" style="color:var(--err)"></div>' +
      '<div class="ed-nav"><button class="btn btn-ghost" id="s3back">← Similar projects</button>' +
      '<button class="btn" id="s3next">Review →</button></div></div>';

    hydratePics(el("edApp"));

    document.querySelectorAll(".ed-mat").forEach(function (card) {
      card.querySelector(".hd").onclick = function (ev) {
        if (ev.target.closest(".altBtn")) return;
        if (card.dataset.selectable !== "true") return;
        var id = card.dataset.mat;
        if (state.sel.primary && state.sel.primary.materialId === id) return;
        var pr = findProduct(id);
        state.sel.primary = { materialId: id,
          colorId: (pr.colors && pr.colors[0]) ? pr.colors[0].colorId : null,
          profileId: (pr.profiles && pr.profiles[0]) ? pr.profiles[0].profileId : null };
        if (state.sel.alternative && state.sel.alternative.materialId === id) state.sel.alternative = null;
        renderStep3();
      };
    });
    document.querySelectorAll(".altBtn").forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var id = b.dataset.mat;
        if (state.sel.alternative && state.sel.alternative.materialId === id) {
          state.sel.alternative = null;
        } else {
          if (state.sel.primary && state.sel.primary.materialId === id) return;
          var pr = findProduct(id);
          state.sel.alternative = { materialId: id, colorId: (pr.colors && pr.colors[0]) ? pr.colors[0].colorId : null };
        }
        renderStep3();
      };
    });
    document.querySelectorAll("[data-color]").forEach(function (chip) {
      chip.onclick = function () { state.sel.primary.colorId = chip.dataset.color; renderStep3(); };
    });
    document.querySelectorAll("[data-profile]").forEach(function (chip) {
      chip.onclick = function () { state.sel.primary.profileId = chip.dataset.profile; renderStep3(); };
    });
    el("s3back").onclick = function () { go(2); };
    el("s3next").onclick = function () {
      if (!state.sel.primary) { el("s3msg").textContent = "Please select a primary material (or go back if you only need the comparison)."; return; }
      go(4);
    };
  }

  /* ══ STEP 4 — review ══ */
  async function renderStep4() {
    await loadCatalog();
    var p = state.project;
    var snap = buildSnapshot();
    var ref = state.referenceId && state.ranked ? state.ranked.find(function (r) { return r.projectRef === state.referenceId; }) : null;
    function kv(k, v) { return '<div class="ed-kv"><span>' + k + '</span><span class="v">' + v + "</span></div>"; }
    el("edApp").innerHTML =
      '<div class="ed-card"><h2>🧾 Review before generating</h2>' +
      '<p class="ed-sub">Confirm the scope, the reference, and the material selection.</p>' +
      '<h3 style="margin:8px 0 2px;font-size:14px">Project</h3>' +
      kv("Client", esc(p.clientName) + (p.clientPhone ? " · " + esc(p.clientPhone) : "")) +
      kv("Address", esc([p.address, p.city].filter(Boolean).join(", "))) +
      kv("Type / complexity", esc(p.projectType) + " · " + esc(p.complexity)) +
      kv("Decking / framing", (p.deckingArea || 0) + " SF / " + (p.framingArea || 0) + " SF") +
      kv("Railing / stairs", (p.railing || 0) + " LF / " + (p.stairs || 0)) +
      (p.terrain || p.access ? kv("Site", esc([p.terrain, p.access].filter(Boolean).join(" · "))) : "") +
      '<h3 style="margin:16px 0 2px;font-size:14px">Historical reference</h3>' +
      (ref ? kv(esc(ref.projectName), ref.match + "% match · " + money(ref.referencePrice) + " · $" + Number(ref.costPerPrimaryUnit || 0).toFixed(2) + "/SF")
           : '<p class="ed-sub">None selected — the estimate will show comparables only.</p>') +
      '<h3 style="margin:16px 0 2px;font-size:14px">Materials</h3>' +
      (snap ? kv("Primary", esc(snap.primary.officialName) + " · " + esc(snap.primary.colorName) +
          (snap.primary.nominalDimensions ? " · " + esc(snap.primary.nominalDimensions) : "")) +
          (snap.alternative ? kv("Alternative", esc(snap.alternative.officialName) + " · " + esc(snap.alternative.colorName)) : "")
        : '<p class="ed-sub">No material selected.</p>') +
      '<div class="ed-warn">Material <b>pricing</b> is not included yet — totals below come only from completed-project cost history.</div>' +
      '<div class="ed-nav"><button class="btn btn-ghost" id="s4back">← Materials</button>' +
      '<button class="btn" id="s4next">Generate preliminary estimate →</button></div></div>';
    el("s4back").onclick = function () { go(3); };
    el("s4next").onclick = function () { go(5); };
  }

  /* ══ STEP 5 — preliminary estimate ══ */
  async function renderStep5() {
    await loadRefs(); await loadCatalog();
    if (!state.ranked) state.ranked = rankRefs(state.project, state.refs);
    state.version = (state.version || 0) + 1;
    state.output = buildOutput();
    var o = state.output, p = state.project;
    if (!state.estimateRef) state.estimateRef = "EST-" + Date.now();

    var bench = o.benchmark, range = o.range;
    var benchHtml = bench.present
      ? '<div class="ed-kv"><span>Reference</span><span class="v">' + esc(bench.projectName) + " (" + (bench.match != null ? bench.match + "%" : "—") + ")</span></div>" +
        '<div class="ed-kv"><span>Historical cost/SF × your ' + bench.currentAreaSF + ' SF</span><span class="v">$' +
          (bench.costPerSF != null ? bench.costPerSF.toFixed(2) : "—") + " × " + bench.currentAreaSF + "</span></div>" +
        '<div class="ed-kv"><span><b>Benchmark total</b></span><span class="v ed-total">' + money(bench.total) + "</span></div>" +
        (!bench.eligibleForRange ? '<div class="ed-warn">Excluded from the comparable range: ' + esc(bench.exclusionReasons.join("; ")) + ".</div>" : "")
      : '<p class="ed-sub">' + esc(bench.note) + "</p>";

    var rangeHtml;
    if (range.st === "none") rangeHtml = '<div class="ed-warn">' + esc(range.note) + "</div>";
    else if (range.st === "single") rangeHtml =
      '<div class="ed-kv"><span>Single comparable value</span><span class="v ed-total">' + money(range.loTotal) + "</span></div>" +
      '<p class="ed-sub">' + esc(range.note) + "</p>";
    else rangeHtml =
      '<div class="ed-kv"><span>Comparable range for ' + range.areaSF + " SF</span>" +
      '<span class="v ed-total">' + money(range.loTotal) + " – " + money(range.hiTotal) + "</span></div>" +
      '<div class="ed-kv"><span>Cost per SF range</span><span class="v">$' + range.loCps.toFixed(2) + " – $" + range.hiCps.toFixed(2) + "</span></div>" +
      '<p class="ed-sub">' + esc(range.note) + "</p>";

    var rowsHtml = o.sourceRows.map(function (r) {
      return "<tr><td>" + esc(r.projectName) +
        (r.isAnchor ? ' <span class="ed-badge hi" style="font-size:10px">reference</span>' : "") +
        (!r.inRange ? ' <span class="ed-badge lo" style="font-size:10px">outside range</span>' : "") +
        (r.isSample ? ' <span class="ed-badge sample" style="font-size:10px">sample</span>' : "") +
        "</td><td>" + esc(r.projectType) + '</td><td class="num">' + (r.refAreaSF || 0) + '</td><td class="num">' +
        (r.match != null ? r.match + "%" : "—") + '</td><td class="num">$' + Number(r.costPerSF || 0).toFixed(2) +
        '</td><td class="num"><b>' + money(r.total) + "</b></td></tr>";
    }).join("");

    var snap = o.selectionSnapshot;
    el("edApp").innerHTML =
      '<div class="ed-card"><h2>💵 Preliminary estimate <span style="font-size:12px;color:var(--text-muted)">' +
      esc(state.estimateRef) + " · v" + state.version + "</span></h2>" +
      '<p class="ed-sub">' + esc(p.clientName) + " — " + esc([p.address, p.city].filter(Boolean).join(", ")) + " · " +
      esc(p.projectType) + " · " + (p.deckingArea || 0) + " SF</p>" +
      '<h3 style="margin:6px 0 4px;font-size:15px">1 · Selected reference benchmark</h3>' + benchHtml +
      '<h3 style="margin:18px 0 4px;font-size:15px">2 · Comparable project range</h3>' + rangeHtml +
      (o.sourceRows.length
        ? '<div style="overflow-x:auto"><table class="ed-tbl"><thead><tr><th>Project</th><th>Type</th><th class="num">SF</th><th class="num">Match</th><th class="num">$/SF</th><th class="num">At your SF</th></tr></thead><tbody>' +
          rowsHtml + "</tbody></table></div>"
        : "") +
      '<h3 style="margin:18px 0 4px;font-size:15px">3 · Materials</h3>' +
      (snap
        ? '<div class="ed-kv"><span>Primary</span><span class="v">' + esc(snap.primary.officialName) + " · " + esc(snap.primary.colorName) + "</span></div>" +
          (snap.alternative ? '<div class="ed-kv"><span>Alternative</span><span class="v">' + esc(snap.alternative.officialName) + " · " + esc(snap.alternative.colorName) + "</span></div>" : "") +
          '<div class="ed-note">Material cost: <b>pending</b> — ' + esc(o.materialCost.note) + "</div>"
        : '<p class="ed-sub">No material selection recorded.</p>') +
      '<h3 style="margin:18px 0 4px;font-size:15px">Assumptions & notes</h3>' +
      '<ul class="ed-assump">' + o.assumptions.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("") + "</ul>" +
      '<div class="ed-warn no-print"><b>Internal preliminary reference.</b> Review by a DCR estimator is required before any number is shared with the client.</div>' +
      '<div class="ed-nav no-print"><button class="btn btn-ghost" id="s5back">← Review</button>' +
      '<span style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<select id="s5status" class="btn-ghost" style="width:auto;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text)">' +
      ["draft", "preliminary", "reviewed", "sent", "won", "lost"].map(function (s) {
        return "<option" + (state.estStatus === s ? " selected" : "") + ">" + s + "</option>";
      }).join("") + "</select>" +
      '<button class="btn btn-ghost" id="s5print">🖨️ Print</button>' +
      '<button class="btn" id="s5save">💾 Save estimate</button></span></div>' +
      '<div class="ed-msg" id="s5msg"></div></div>';

    el("s5back").onclick = function () { go(4); };
    el("s5print").onclick = function () { window.print(); };
    el("s5save").onclick = saveEstimate;
  }

  async function saveEstimate() {
    var msg = el("s5msg"), btn = el("s5save");
    btn.disabled = true; msg.style.color = "var(--text-muted)"; msg.textContent = "Saving…";
    state.estStatus = el("s5status").value;
    var p = state.project, o = state.output;
    var fields = {
      estimateRef: state.estimateRef, trade: "deck", estStatus: state.estStatus, version: state.version,
      clientName: p.clientName, clientPhone: p.clientPhone, clientEmail: p.clientEmail,
      siteAddress: p.address, city: p.city, projectType: p.projectType, complexity: p.complexity,
      primaryAreaSF: p.deckingArea, secondaryAreaSF: p.framingArea, railingLF: p.railing, stairs: p.stairs,
      scopeJson: JSON.stringify(p),
      selectionJson: JSON.stringify({ sel: state.sel, snapshot: o.selectionSnapshot }),
      outputJson: JSON.stringify(o),
      referenceProjectId: state.referenceId || "",
      benchmarkTotal: o.benchmark.present && o.benchmark.total != null ? o.benchmark.total : "",
      rangeLowTotal: o.range.st !== "none" ? o.range.loTotal : "",
      rangeHighTotal: o.range.st !== "none" ? o.range.hiTotal : "",
      notes: p.notes || "",
    };
    try {
      var res = await DCR.api("/api/portal?action=sales&part=estimates", {
        method: state.estimateId ? "PATCH" : "POST",
        body: state.estimateId ? { id: state.estimateId, fields: fields } : { fields: fields },
      });
      state.estimateId = res.estimate.id;
      clearDraftLocal();
      msg.style.color = "var(--ok)";
      msg.textContent = "✓ Saved to SharePoint (" + state.estimateRef + " v" + state.version + "). Find it any time on the Estimates page.";
      btn.disabled = false;
    } catch (e) {
      btn.disabled = false; msg.style.color = "var(--err)";
      msg.textContent = e.message || "Save failed.";
    }
  }

  /* ══ reopen a saved estimate ══ */
  async function loadSaved(id) {
    var d = await DCR.api("/api/portal?action=sales&part=estimates&id=" + encodeURIComponent(id));
    var est = d.estimate;
    state.estimateId = est.id;
    state.estimateRef = est.estimateRef || "";
    state.version = Number(est.version) || 0;
    state.estStatus = est.estStatus || "draft";
    try { state.project = Object.assign(state.project, JSON.parse(est.scopeJson || "{}")); } catch (e) {}
    try {
      var selWrap = JSON.parse(est.selectionJson || "{}");
      if (selWrap.sel) state.sel = selWrap.sel;
    } catch (e) {}
    state.referenceId = est.referenceProjectId || null;
  }

  /* ══ init ══ */
  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };
    // print letterhead
    var CO = DCR.companyInfo;
    el("phLogo").src = CO.logo;
    el("phCo").innerHTML = "<b>" + esc(CO.legalName || CO.name) + "</b><br>" +
      [CO.address, [CO.phone, CO.license].filter(Boolean).join(" · ")].filter(Boolean).map(esc).join("<br>");

    if (EDIT_ID) {
      try { await loadSaved(EDIT_ID); } catch (e) { /* start fresh on failure */ }
    } else {
      try {
        var draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
        if (draft && draft.project && draft.project.clientName) {
          state.project = Object.assign(state.project, draft.project);
          state.referenceId = draft.referenceId || null;
          state.sel = draft.sel || state.sel;
          state.estimateId = draft.estimateId || null;
          state.estimateRef = draft.estimateRef || "";
          state.version = draft.version || 0;
          state.estStatus = draft.estStatus || "draft";
        }
      } catch (e) {}
    }
    go(1);
  });

  // Expose the pure logic for verification/tests (same pattern as timesheet-pdf).
  window.DeckEstimate = {
    matchScore: matchScore, rankRefs: rankRefs, eligibility: eligibility,
    buildBenchmark: buildBenchmark, buildRange: buildRange, buildRows: buildRows,
    state: state,
  };
})();
